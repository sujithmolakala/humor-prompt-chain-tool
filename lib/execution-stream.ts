import "server-only";
import { after } from "next/server";
import type { AdminAccess } from "./auth";
import type { ExecutionSnapshot, StructuredOutput } from "./chain-execution";
import { runExecution } from "./execution-runner";
import { generate } from "./provider";
import { rpc, getHistory } from "./tool-data";
import { privateHeaders } from "./security";
import { executionDeadline, EXECUTION_BUDGET_MS } from "./execution-deadline";
import { executionTrace } from "./execution-diagnostics";
type Options = {
  requestSignal?: AbortSignal;
  trace?: ReturnType<typeof executionTrace>;
  defer?: (work: () => Promise<void>) => void;
};

// Exported independently of Supabase so disconnects and lifecycle pinning can
// be tested with deterministic, non-billable work.
export function executionResponse(
  run: (
    emit: (event: Record<string, unknown>) => void,
    signal: AbortSignal,
    remaining: () => number,
  ) => Promise<void>,
  options: Options = {},
) {
  const trace = options.trace ?? executionTrace(),
    budget = executionDeadline(
      Math.min(EXECUTION_BUDGET_MS, trace.remainingMs()),
    );
  let settle!: () => void;
  const work = new Promise<void>((resolve) => {
    settle = resolve;
  });
  // Register before any provider work. Next/Vercel tracks this same promise even
  // when the progress connection is cancelled. This is bounded work, not a retry.
  try {
    (options.defer ?? after)(() => work);
  } catch (error) {
    budget.dispose();
    throw error;
  }
  let disconnected = false,
    finished = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const disconnect = (source: string) => {
    if (finished || disconnected) return;
    disconnected = true;
    clearInterval(heartbeat);
    trace.event("client_disconnected", { source, executionCancelled: false });
  };
  const onRequestAbort = () => disconnect("request_signal");
  options.requestSignal?.addEventListener("abort", onRequestAbort, {
    once: true,
  });
  if (options.requestSignal?.aborted) onRequestAbort();
  return new Response(
    new ReadableStream({
      start(controller) {
        const emit = (event: Record<string, unknown>) => {
          if (disconnected) return;
          try {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(event) + "\n"),
            );
          } catch {
            disconnect("stream_closed");
          }
        };
        if (!disconnected) {
          heartbeat = setInterval(() => emit({ type: "heartbeat" }), 5000);
          heartbeat.unref?.();
        }
        void (async () => {
          try {
            await run(emit, budget.signal, budget.remainingMs);
          } catch {
            trace.event("unhandled_execution", {
              requestOutcome: "unconfirmed",
            });
            if (!disconnected)
              controller.error(
                new Error("Execution interrupted; inspect saved history."),
              );
          } finally {
            finished = true;
            clearInterval(heartbeat);
            budget.dispose();
            options.requestSignal?.removeEventListener("abort", onRequestAbort);
            try {
              controller.close();
            } catch {
              /* connection already closed */
            }
            trace.event("invocation_settled", {
              clientDisconnected: disconnected,
              executionDeadlineExpired: budget.signal.aborted,
            });
            settle();
          }
        })();
      },
      cancel() {
        disconnect("stream_cancel");
      },
    }),
    {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/x-ndjson",
        "X-Accel-Buffering": "no",
      },
    },
  );
}

export function executionStream(
  access: AdminAccess,
  token: string,
  snapshot: ExecutionSnapshot,
  image: Buffer,
  key: string,
  savedOutputs: StructuredOutput[] = [],
  options: Options = {},
) {
  const trace = options.trace ?? executionTrace();
  trace.identify(token);
  return executionResponse(
    (emit, deadline, remainingMs) =>
      runExecution({
        token,
        snapshot,
        signal: deadline,
        savedOutputs,
        emit,
        remainingMs,
        invocationId: trace.invocationId,
        generate: (step, prompt, diagnostic) =>
          generate(step, prompt, image, key, deadline, diagnostic),
        load: async () => {
          const run = (await getHistory(access, { run_token: token })).runs[0];
          if (!run) throw new Error("Journal missing");
          return { ...run, actorMatches: run.actor === access.identity.id };
        },
        progress: (entry) =>
          entry.outcome && entry.outcome !== "completed"
            ? rpc(access, "pct_stop", {
                token,
                step_index: entry.step_index,
                outcome: entry.outcome,
                reason: entry.reason,
              })
            : rpc(access, "pct_progress", {
                token,
                step_index: entry.step_index,
                result: entry.result ?? null,
                outcome: entry.outcome ?? null,
              }),
      }),
    { ...options, trace },
  );
}
