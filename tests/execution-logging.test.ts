import { test } from "node:test";
import assert from "node:assert/strict";
import { executionLogProbe } from "../lib/execution-log-probe";
import { EXECUTION_DIAGNOSTICS_VERSION } from "../lib/execution-diagnostics";
import { runExecution } from "../lib/execution-runner";
import type {
  ExecutionSnapshot,
  StructuredOutput,
} from "../lib/chain-execution";
import { AppError } from "../lib/security";
const snapshot: ExecutionSnapshot = {
  chain_id: "fixture",
  name: "private chain",
  steps: Array.from({ length: 4 }, (_, i) => ({
    id: `step-${i}`,
    position: i + 1,
    role: "auto",
    template: i ? "private prompt {{previous}}" : "private prompt",
    model_id: "fixture",
    model: "gemini-3.1-flash-lite",
    provider: "google-ai",
    temperature: 1,
    max_tokens: 2048,
  })),
};
const final = {
  captions: [
    "First joke",
    "Second joke",
    "Third joke",
    "Fourth joke",
    "Fifth joke",
  ],
};
function capture() {
  const native = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const logs: { level: string; data: Record<string, unknown>; text: string }[] =
    [];
  for (const level of ["info", "warn", "error"] as const)
    console[level] = (value) =>
      logs.push({
        level,
        data: JSON.parse(String(value)),
        text: String(value),
      });
  return { logs, restore: () => Object.assign(console, native) };
}

test("production logging probe emits versioned server stdout, is private/uncached and cannot dispatch Gemini", async () => {
  const captured = capture(),
    nativeFetch = global.fetch,
    previous = process.env.VERCEL_ENV;
  let fetches = 0,
    authorized = 0;
  process.env.VERCEL_ENV = "production";
  global.fetch = async () => {
    fetches++;
    throw Error(
      "No provider or journal request is allowed in this probe fixture",
    );
  };
  try {
    const response = await executionLogProbe(async () => {
      authorized++;
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.operation, "logging_probe");
    assert.equal(body.billableDispatch, false);
    assert.equal(body.environment, "production");
    assert.equal(body.diagnosticsVersion, EXECUTION_DIAGNOSTICS_VERSION);
    assert.equal(
      response.headers.get("X-HSS-Diagnostic-Id"),
      body.invocationId,
    );
    assert.match(response.headers.get("Cache-Control")!, /private.*no-store/);
    assert.equal(authorized, 1);
    assert.equal(fetches, 0);
    assert.ok(
      captured.logs.some(
        (log) =>
          log.data.stage === "logging_probe_confirmed" && log.level === "info",
      ),
    );
    assert.ok(
      captured.logs.every(
        (log) =>
          log.data.service === "humor-study-studio" &&
          log.data.diagnosticsVersion === EXECUTION_DIAGNOSTICS_VERSION,
      ),
    );
    const denied = await executionLogProbe(async () => {
      throw new AppError("Superadmin access required.", 403);
    });
    assert.equal(denied.status, 403);
    assert.equal(fetches, 0);
    assert.ok(
      captured.logs.some(
        (log) =>
          log.data.stage === "logging_probe_rejected" && log.level === "warn",
      ),
    );
  } finally {
    captured.restore();
    global.fetch = nativeFetch;
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
});

test("four-step logs prove each transition follows its acknowledged checkpoint and include completion captions count", async () => {
  const captured = capture();
  let calls = 0;
  const saved: StructuredOutput[] = [];
  try {
    await runExecution({
      token: "fixture-run",
      snapshot,
      signal: new AbortController().signal,
      emit: () => {},
      generate: async () =>
        ++calls === 4 ? final : { observations: ["private output"] },
      progress: async (entry) => {
        if (entry.result) saved.push(entry.result);
      },
    });
    const events = captured.logs.map((log) => log.data);
    assert.equal(calls, 4);
    assert.equal(saved.length, 4);
    assert.equal(events[0].event, "execution_start");
    for (let i = 1; i <= 4; i++) {
      const step = events.filter((log) => log.step === i);
      assert.equal(
        step.filter((log) => log.event === "execution_step_start").length,
        1,
      );
      assert.equal(
        step.filter(
          (log) => log.event === "execution_provider_response_received",
        ).length,
        1,
      );
      assert.equal(
        step.filter((log) => log.event === "execution_output_saved").length,
        1,
      );
      if (i < 4) {
        const checkpoint = events.findIndex(
          (log) => log.event === "execution_output_saved" && log.step === i,
        );
        const transition = events.findIndex(
          (log) =>
            log.event === "execution_step_transition_ready" && log.step === i,
        );
        const nextDispatch = events.findIndex(
          (log) =>
            log.event === "execution_provider_dispatch" && log.step === i + 1,
        );
        assert.ok(checkpoint < transition && transition < nextDispatch);
      }
    }
    assert.equal(events.at(-1)?.event, "execution_completed");
    assert.equal(events.at(-1)?.captionCount, 5);
    assert.ok(
      events.every(
        (log) =>
          log.runId === "fixture-run" && typeof log.elapsedMs === "number",
      ),
    );
    assert.ok(captured.logs.length < 100);
    assert.doesNotMatch(
      captured.logs.map((log) => log.text).join("\n"),
      /private/,
    );
  } finally {
    captured.restore();
  }
});

test("checkpoint interruption is logged at error severity with safe category and retains the completed prefix", async () => {
  const captured = capture();
  let calls = 0;
  const saved: StructuredOutput[] = [];
  try {
    await runExecution({
      token: "fixture-stopped",
      snapshot,
      signal: new AbortController().signal,
      emit: () => {},
      generate: async () => {
        calls++;
        return { observations: ["private output"] };
      },
      progress: async (entry) => {
        if (entry.result && entry.step_index === 1)
          throw Object.assign(new AppError("private database failure", 503), {
            databaseCode: "57014",
          });
        if (entry.result) saved.push(entry.result);
      },
    });
    assert.equal(calls, 2);
    assert.equal(saved.length, 1);
    const stopped = captured.logs.find(
      (log) => log.data.event === "execution_stopped",
    )!;
    assert.equal(stopped.level, "error");
    assert.equal(stopped.data.step, 2);
    assert.equal(stopped.data.reason, "journal_write_unconfirmed");
    assert.equal(stopped.data.databaseCode, "57014");
    assert.equal(stopped.data.confirmedOutputs, 1);
    assert.doesNotMatch(
      captured.logs.map((log) => log.text).join("\n"),
      /private/,
    );
  } finally {
    captured.restore();
  }
});

test("unavailable logging never turns a successful execution into an error or repeats work", async () => {
  const captured = capture();
  console.info =
    console.warn =
    console.error =
      () => {
        throw Error("logging unavailable");
      };
  let calls = 0;
  const events: Record<string, unknown>[] = [];
  try {
    await runExecution({
      token: "fixture-logger-down",
      snapshot,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      generate: async () =>
        ++calls === 4 ? final : { observations: ["observation"] },
      progress: async () => {},
    });
    assert.equal(calls, 4);
    assert.equal(events.at(-1)?.type, "finished");
  } finally {
    captured.restore();
  }
});
