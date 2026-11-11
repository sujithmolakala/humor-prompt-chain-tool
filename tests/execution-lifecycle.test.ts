import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../lib/provider";
import { executionDeadline } from "../lib/execution-deadline";
import { runExecution } from "../lib/execution-runner";
import { executionResponse } from "../lib/execution-stream";
import type { ExecutionSnapshot } from "../lib/chain-execution";
const snapshot: ExecutionSnapshot = {
  chain_id: "fixture",
  name: "Contextual Humor fixture",
  steps: Array.from({ length: 4 }, (_, i) => ({
    id: `step-${i}`,
    position: i + 1,
    role: "auto",
    template: "Fixture task",
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
const response = (output: unknown) =>
  Response.json({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify(output) }] },
      },
    ],
  });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function delayedResponse(
  ms: number,
  signal: AbortSignal,
  output: unknown,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(response(output));
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

test("reproduce the 20-second cutoff, then allow a valid slow response within the existing execution deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const native = global.fetch,
    diagnostics: Record<string, unknown>[] = [];
  let calls = 0;
  global.fetch = async (_url, init) => {
    calls++;
    return delayedResponse(25000, init!.signal!, {
      observations: ["private fixture response"],
    });
  };
  try {
    // This fallback is the same unconditional per-call policy the old execution path used.
    const oldPolicy = generate(
      snapshot.steps[0],
      "private prompt",
      Buffer.from("private image"),
      "private-key",
      undefined,
      (d) => diagnostics.push(d),
    );
    const rejected = assert.rejects(
      oldPolicy,
      (e) => e instanceof Error && e.name === "TimeoutError",
    );
    t.mock.timers.tick(20000);
    await rejected;
    assert.equal(calls, 1);
    assert.equal(
      diagnostics.at(-1)?.abortSource,
      "standalone_provider_deadline",
    );
    const budget = executionDeadline();
    try {
      const fixed = generate(
        snapshot.steps[0],
        "private prompt",
        Buffer.from("private image"),
        "private-key",
        budget.signal,
        (d) => diagnostics.push(d),
      );
      t.mock.timers.tick(21000);
      await flush();
      assert.equal(budget.signal.aborted, false);
      t.mock.timers.tick(4000);
      assert.deepEqual(await fixed, {
        observations: ["private fixture response"],
      });
      assert.equal(
        calls,
        2,
        "one request in each independent scenario; no retry",
      );
    } finally {
      budget.dispose();
    }
    assert.doesNotMatch(JSON.stringify(diagnostics), /private/);
  } finally {
    global.fetch = native;
    t.mock.timers.reset();
  }
});

test("a slow Gemini request at any step completes all four steps and streams final captions without a per-step cutoff", async (t) => {
  const native = global.fetch,
    originalLog = console.info;
  console.info = () => {};
  try {
    for (let slowStep = 0; slowStep < 4; slowStep++) {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      let calls = 0;
      global.fetch = async (_url, init) => {
        const i = calls++;
        return delayedResponse(
          i === slowStep ? 25000 : 1000,
          init!.signal!,
          i === 3 ? final : { observations: [`Observation ${i}`] },
        );
      };
      const deferred: (() => Promise<void>)[] = [],
        outputs: unknown[] = [];
      const result = executionResponse(
        (emit, signal, remainingMs) =>
          runExecution({
            token: `fixture-${slowStep}`,
            snapshot,
            signal,
            emit,
            remainingMs,
            generate: (step, prompt, diagnostic) =>
              generate(
                step,
                prompt,
                Buffer.from("fixture"),
                "fixture-key",
                signal,
                diagnostic,
              ),
            progress: async (entry) => {
              if (entry.result) outputs.push(entry.result);
            },
          }),
        { defer: (job) => deferred.push(job) },
      );
      const text = result.text();
      for (let i = 0; i < 30; i++) {
        t.mock.timers.tick(1000);
        await flush();
      }
      const events = (await text)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      await deferred[0]();
      assert.equal(calls, 4);
      assert.equal(outputs.length, 4);
      assert.equal(events.at(-1).type, "finished");
      assert.deepEqual(events.at(-1).result.captions, final.captions);
      t.mock.timers.reset();
    }
  } finally {
    global.fetch = native;
    console.info = originalLog;
    t.mock.timers.reset();
  }
});

test("the execution deadline still aborts a genuinely over-budget request and preserves prior checkpoints", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const native = global.fetch,
    originalLog = console.info;
  console.info = () => {};
  let calls = 0;
  const outputs: unknown[] = [],
    events: Record<string, unknown>[] = [],
    budget = executionDeadline();
  global.fetch = async (_url, init) => {
    const i = calls++;
    return delayedResponse(i === 1 ? 100000 : 1000, init!.signal!, {
      observations: ["Saved response"],
    });
  };
  try {
    const work = runExecution({
      token: "fixture-deadline",
      snapshot,
      signal: budget.signal,
      emit: (e) => events.push(e),
      generate: (step, prompt, diagnostic) =>
        generate(
          step,
          prompt,
          Buffer.from("fixture"),
          "fixture-key",
          budget.signal,
          diagnostic,
        ),
      progress: async (entry) => {
        if (entry.result) outputs.push(entry.result);
      },
    });
    for (let i = 0; i < 96; i++) {
      t.mock.timers.tick(1000);
      await flush();
    }
    await work;
    assert.equal(calls, 2);
    assert.equal(outputs.length, 1);
    assert.equal(events.at(-1)?.outcome, "uncertain");
  } finally {
    budget.dispose();
    global.fetch = native;
    console.info = originalLog;
    t.mock.timers.reset();
  }
});

test("client connection drops never own the worker lease or trigger redispatch; lifecycle tracks the same work", async () => {
  const originalLog = console.info,
    logs: string[] = [];
  console.info = (line) => logs.push(String(line));
  try {
    for (const mode of ["stream_cancel", "request_abort"] as const) {
      const deferred: (() => Promise<void>)[] = [];
      let release!: () => void,
        calls = 0,
        saved = false;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        request = new AbortController();
      const result = executionResponse(
        async (emit) => {
          emit({ type: "started" });
          calls++;
          await gate;
          saved = true;
          emit({ type: "finished", result: final });
        },
        { requestSignal: request.signal, defer: (job) => deferred.push(job) },
      );
      const reader = result.body!.getReader();
      await reader.read();
      if (mode === "stream_cancel")
        await reader.cancel("private client reason");
      else request.abort("private abort reason");
      assert.equal(saved, false);
      release();
      await deferred[0]();
      await deferred[0]();
      assert.equal(saved, true);
      assert.equal(calls, 1);
      assert.equal(deferred.length, 1);
    }
    assert.doesNotMatch(logs.join("\n"), /private/);
    assert.ok(
      logs.some((line) => JSON.parse(line).stage === "client_disconnected"),
    );
  } finally {
    console.info = originalLog;
  }
});

test("slow response bodies are consumed within the execution budget; body deadline expiry is diagnosed as unconfirmed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const native = global.fetch,
    diagnostics: Record<string, unknown>[] = [];
  global.fetch = async (_url, init) => {
    const body = JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: JSON.stringify({ observations: ["private content"] }) },
            ],
          },
        },
      ],
    });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(body.slice(10)));
            controller.close();
          }, 25000);
          init!.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              controller.error(init!.signal!.reason);
            },
            { once: true },
          );
        },
      }),
    );
  };
  try {
    const budget = executionDeadline();
    try {
      const complete = generate(
        snapshot.steps[0],
        "private prompt",
        Buffer.from("private image"),
        "private-key",
        budget.signal,
        (d) => diagnostics.push(d),
      );
      await flush();
      t.mock.timers.tick(25000);
      assert.deepEqual(await complete, { observations: ["private content"] });
      assert.ok(
        diagnostics.some(
          (d) =>
            d.providerEvent === "headers" &&
            d.requestOutcome === "headers_received",
        ),
      );
    } finally {
      budget.dispose();
    }
    const short = executionDeadline(1000);
    try {
      const incomplete = generate(
        snapshot.steps[0],
        "private prompt",
        Buffer.from("private image"),
        "private-key",
        short.signal,
        (d) => diagnostics.push(d),
      );
      const rejected = assert.rejects(
        incomplete,
        (e) => e instanceof Error && e.name === "TimeoutError",
      );
      await flush();
      t.mock.timers.tick(1000);
      await rejected;
      assert.equal(diagnostics.at(-1)?.providerStage, "body");
      assert.equal(diagnostics.at(-1)?.abortSource, "execution_deadline");
      assert.equal(diagnostics.at(-1)?.requestOutcome, "unconfirmed");
    } finally {
      short.dispose();
    }
    assert.doesNotMatch(JSON.stringify(diagnostics), /private/);
  } finally {
    global.fetch = native;
    t.mock.timers.reset();
  }
});
