import "server-only";
import {
  executeChain,
  validateSnapshot,
  validateIntermediate,
  threeCaptions,
  type ExecutionSnapshot,
  type ExecutionStep,
  type StructuredOutput,
} from "./chain-execution";
import {
  safeFailureDiagnostic,
  writeExecutionLog,
  type ExecutionLogLevel,
} from "./execution-diagnostics";
import { randomUUID } from "node:crypto";
import { ExecutionDeadlineError } from "./execution-deadline";
import { ProviderResponseError } from "./provider";

type Phase =
  | "preflight"
  | "before_step"
  | "journal_started"
  | "provider"
  | "validation"
  | "journal_output"
  | "journal_completed";
type Outcome = "failed" | "uncertain";
type Progress = {
  step_index: number;
  result?: StructuredOutput;
  outcome?: "completed" | Outcome;
  reason?: string;
};
export function validateSavedPrefix(
  snapshot: ExecutionSnapshot,
  outputs: StructuredOutput[],
) {
  validateSnapshot(snapshot);
  if (!Array.isArray(outputs) || outputs.length > snapshot.steps.length)
    throw new Error("Invalid saved prefix");
  outputs.forEach((output, i) => {
    if (i === snapshot.steps.length - 1) threeCaptions(output, [], 5);
    else validateIntermediate(output);
  });
}
export async function runExecution({
  token,
  snapshot,
  signal,
  generate,
  progress,
  emit,
  savedOutputs = [],
  load,
  remainingMs,
  invocationId = randomUUID(),
}: {
  invocationId?: string;
  remainingMs?: () => number;
  savedOutputs?: StructuredOutput[];
  load?: () => Promise<{
    status: string;
    outputs: StructuredOutput[];
    current_step?: number | null;
    last_dispatch_at?: string;
    actorMatches?: boolean;
  }>;
  token: string;
  snapshot: ExecutionSnapshot;
  signal: AbortSignal;
  generate: (
    step: ExecutionStep,
    prompt: string,
    diagnostic: (details: Record<string, unknown>) => void,
  ) => Promise<unknown>;
  progress: (entry: Progress) => Promise<unknown>;
  emit: (event: Record<string, unknown>) => void;
}) {
  const started = performance.now();
  let stepStarted = started;
  let confirmedOutputs = savedOutputs.length,
    claimAcknowledged = false;
  let phase: Phase = "preflight",
    index = -1;
  const readPhase = (): Phase => phase;
  const log = (
    event: string,
    details: Record<string, unknown> = {},
    level: ExecutionLogLevel = "info",
  ) => {
    writeExecutionLog(
      {
        event,
        runId: token,
        invocationId,
        phase,
        step: index + 1,
        elapsedMs: Math.round(performance.now() - started),
        stepElapsedMs:
          index >= 0 ? Math.round(performance.now() - stepStarted) : undefined,
        executionRemainingMs: remainingMs?.(),
        confirmedOutputs,
        claimAcknowledged,
        ...details,
      },
      level,
    );
  };
  try {
    validateSavedPrefix(snapshot, savedOutputs);
    log("execution_start", {
      totalSteps: snapshot.steps.length,
      reusedOutputs: savedOutputs.length,
    });
    emit({ type: "started", id: token, snapshot });
    const result = await executeChain(
      snapshot,
      [],
      async (step, i, prompt, _final, validate) => {
        index = i;
        stepStarted = performance.now();
        if (i < savedOutputs.length) {
          phase = "validation";
          const saved = validate(savedOutputs[i]);
          log("execution_step_reused", { requestOutcome: "not_dispatched" });
          emit({ type: "completed", index: i, output: saved, cached: true });
          return saved;
        }
        claimAcknowledged = false;
        phase = "before_step";
        signal.throwIfAborted();
        phase = "journal_started";
        log("execution_claim_started", { requestOutcome: "not_dispatched" });
        await progress({ step_index: i });
        claimAcknowledged = true;
        log("execution_claim_acknowledged", {
          requestOutcome: "not_dispatched",
          ownership: "actor_scoped_exclusive_checkpoint",
          claimExpiration: "none",
        });
        log("execution_step_start", {
          requestOutcome: "not_dispatched",
          totalSteps: snapshot.steps.length,
        });
        emit({ type: "running", index: i });
        phase = "provider";
        log("execution_provider_dispatch");
        const output = await generate(step, prompt, (details) =>
          log(
            "execution_provider_transport",
            details,
            details.providerEvent === "stopped" ? "warn" : "info",
          ),
        );
        log("execution_provider_response_received");
        phase = "validation";
        const accepted = validate(output);
        log("execution_output_validated", {
          outputFields: ["observations", "ideas", "captions"].filter((key) =>
            Object.hasOwn(accepted, key),
          ),
        });
        phase = "journal_output";
        log("execution_checkpoint_started", {
          attempt: 1,
          requestOutcome: "response_validated",
        });
        try {
          await progress({ step_index: i, result: accepted });
        } catch (checkpointError) {
          log(
            "execution_checkpoint_acknowledgement_lost",
            {
              ...safeFailureDiagnostic(checkpointError),
              attempt: 1,
              requestOutcome: "response_validated",
            },
            "warn",
          );
          // Retry only the identical idempotent database checkpoint, never Gemini.
          log("execution_checkpoint_started", {
            attempt: 2,
            requestOutcome: "response_validated",
          });
          await progress({ step_index: i, result: accepted });
        }
        confirmedOutputs = i + 1;
        log("execution_output_saved", {
          requestOutcome: "response_checkpointed",
        });
        emit({ type: "completed", index: i, output: accepted });
        if (i + 1 < snapshot.steps.length)
          log("execution_step_transition_ready", {
            fromStep: i + 1,
            toStep: i + 2,
            checkpointState: "acknowledged",
            previousOutputFields: ["observations", "ideas", "captions"].filter(
              (key) => Object.hasOwn(accepted, key),
            ),
          });
        // executeChain validates once more after invocation; classify that as
        // validation too, rather than as an ambiguous database/provider failure.
        phase = "validation";
        return accepted;
      },
      5,
    );
    phase = "journal_completed";
    await progress({ step_index: 0, outcome: "completed" });
    log("execution_completed", {
      status: "completed",
      totalSteps: snapshot.steps.length,
      captionCount: result.captions.length,
    });
    emit({ type: "finished", id: token, result });
  } catch (error) {
    // A response/acknowledgement can be lost after atomic completion committed.
    // Recover only validated saved outputs; never synthesize success from memory.
    if (load) {
      try {
        const saved = await load();
        log("execution_checkpoint_read", {
          checkpoint: {
            status: ["running", "completed", "failed", "uncertain"].includes(
              saved.status,
            )
              ? saved.status
              : "unknown",
            savedOutputs: saved.outputs.length,
            currentStep: saved.current_step,
            lastDispatchAt: saved.last_dispatch_at,
            actorMatches: saved.actorMatches,
          },
        });
        if (
          saved.status === "completed" &&
          saved.outputs.length === snapshot.steps.length
        ) {
          const result = await executeChain(
            snapshot,
            [],
            async (_step, i, _prompt, _final, validate) =>
              validate(saved.outputs[i]),
            5,
          );
          saved.outputs.forEach((output, i) =>
            emit({ type: "completed", index: i, output, cached: true }),
          );
          log("execution_completion_recovered");
          log("execution_completed", {
            status: "completed",
            recovered: true,
            totalSteps: snapshot.steps.length,
            captionCount: result.captions.length,
          });
          emit({ type: "finished", id: token, result });
          return;
        }
      } catch (checkpointError) {
        log(
          "execution_checkpoint_unreadable",
          {
            ...safeFailureDiagnostic(checkpointError),
            checkpointState: "unconfirmed",
          },
          "warn",
        );
      }
    }
    const failurePhase = readPhase();
    let outcome: Outcome =
      failurePhase === "provider"
        ? error instanceof ProviderResponseError
          ? "failed"
          : "uncertain"
        : failurePhase === "journal_output" ||
            failurePhase === "journal_completed"
          ? "uncertain"
          : "failed";
    const reason =
      failurePhase === "validation"
        ? "output_contract_rejected"
        : failurePhase === "provider"
          ? error instanceof ProviderResponseError
            ? "provider_response_rejected"
            : signal.aborted ||
                (error instanceof Error &&
                  ["AbortError", "TimeoutError"].includes(error.name))
              ? "provider_timeout_or_abort"
              : "provider_transport_unconfirmed"
          : failurePhase.startsWith("journal_")
            ? "journal_write_unconfirmed"
            : failurePhase === "before_step"
              ? "deadline_before_dispatch"
              : "execution_contract_rejected";
    log(
      "execution_stopped",
      {
        ...safeFailureDiagnostic(error),
        outcome,
        reason,
        abortSource: signal.aborted
          ? signal.reason instanceof ExecutionDeadlineError
            ? signal.reason.source
            : "caller_abort"
          : "none",
        ...(error instanceof ProviderResponseError
          ? { httpStatus: error.httpStatus, providerReason: error.reason }
          : {}),
      },
      "error",
    );
    let message =
      failurePhase === "validation"
        ? `Step ${index + 1} returned a response that does not match the workflow output contract. No later step was started. Check the step instructions before preparing a new billable run.`
        : error instanceof ProviderResponseError
          ? error.message
          : "Execution interrupted; outcome may be unknown. Inspect history before starting a new billable run.";
    try {
      await progress({ step_index: Math.max(index, 0), outcome, reason });
    } catch (checkpointError) {
      // The terminal update might have committed even when its acknowledgement
      // was lost. Do not overwrite/retry it or report a confirmed final status.
      outcome = "uncertain";
      message =
        "Execution status could not be confirmed in the journal. Inspect saved history; no request was retried.";
      log(
        "execution_terminal_write_unconfirmed",
        {
          outcome,
          ...safeFailureDiagnostic(checkpointError),
        },
        "error",
      );
    }
    emit({ type: "error", id: token, outcome, error: message });
  }
}
