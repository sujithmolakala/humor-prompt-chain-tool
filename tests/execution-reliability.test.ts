import { test } from "node:test";
import assert from "node:assert/strict";
import { runExecution } from "../lib/execution-runner";
import { generate, ProviderResponseError } from "../lib/provider";
import { AppError } from "../lib/security";
import type { ExecutionSnapshot } from "../lib/chain-execution";
const snapshot: ExecutionSnapshot = {
  chain_id: "fixture",
  name: "Campus Humor fixture",
  steps: Array.from({ length: 4 }, (_, i) => ({
    id: `step-${i}`,
    position: i + 1,
    role: "auto",
    template: i ? "Use {{previous}}" : "Describe image",
    model_id: "model-fixture",
    model: "gemini-fixture",
    provider: "google-ai",
    temperature: 1,
    max_tokens: 2048,
  })),
};
const captions = {
  captions: [
    "First joke",
    "Second joke",
    "Third joke",
    "Fourth joke",
    "Fifth joke",
  ],
};

test("known completed output rejection is failed, while transport/journal uncertainty stays protected", async () => {
  const originalLog = console.info,
    originalWarn = console.warn,
    originalError = console.error;
  const logs: string[] = [];
  console.info =
    console.warn =
    console.error =
      (entry: string) => logs.push(entry);
  try {
    for (const mode of [
      "success",
      "contract",
      "transport",
      "timeout",
      "provider",
      "journal",
      "terminal",
      "deadline",
    ] as const) {
      const events: Record<string, unknown>[] = [];
      const entries: {
        step_index: number;
        result?: unknown;
        outcome?: string;
      }[] = [];
      let calls = 0;
      const controller = new AbortController();
      if (mode === "deadline") controller.abort();
      await runExecution({
        token: `fixture-${mode}`,
        snapshot,
        signal: controller.signal,
        emit: (event) => events.push(event),
        generate: async (_step, prompt) => {
          const i = calls++;
          if (mode === "transport")
            throw new TypeError("private-network-details");
          if (mode === "timeout")
            throw new DOMException("private-timeout-details", "TimeoutError");
          if (mode === "provider")
            throw new ProviderResponseError(
              "Provider rate limit reached.",
              429,
            );
          if (mode === "contract")
            return { description: "private-model-content" };
          if (i > 0) assert.match(prompt, /fixture-output/);
          return i === 3 ? captions : { observations: [`fixture-output-${i}`] };
        },
        progress: async (entry) => {
          entries.push(entry);
          if (mode === "journal" && entry.result)
            throw new AppError("private-database-details", 503);
          if (mode === "terminal" && entry.outcome)
            throw new AppError("private-database-details", 503);
        },
      });
      if (mode === "success") {
        assert.equal(calls, 4);
        assert.equal(entries.filter((e) => e.result).length, 4);
        assert.equal(events.at(-1)?.type, "finished");
      } else {
        assert.equal(
          calls,
          mode === "deadline" ? 0 : mode === "terminal" ? 4 : 1,
        );
        assert.equal(events.at(-1)?.type, "error");
        assert.equal(
          events.at(-1)?.outcome,
          ["contract", "provider", "deadline"].includes(mode)
            ? "failed"
            : "uncertain",
        );
        if (mode === "contract") {
          assert.equal(entries.filter((e) => e.result).length, 0);
          assert.match(String(events.at(-1)?.error), /Step 1.*output contract/);
        }
        assert.equal(
          entries.filter((e) => e.outcome).length,
          mode === "terminal" ? 2 : 1,
          "no automatic journal retries",
        );
      }
    }
    assert.doesNotMatch(
      logs.join("\n"),
      /private-|fixture-output|Describe image/,
    );
    const rejected = logs
      .map((line) => JSON.parse(line))
      .find(
        (log) =>
          log.runId === "fixture-contract" && log.event === "execution_stopped",
      );
    assert.equal(rejected.phase, "validation");
    assert.equal(rejected.reason, "output_contract_rejected");
    assert.equal(rejected.step, 1);
    assert.equal(typeof rejected.elapsedMs, "number");
  } finally {
    console.info = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test("Gemini is a single non-streaming request; malformed complete bodies differ from interrupted body reads", async () => {
  const nativeFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = async (url, init) => {
      calls++;
      assert.match(String(url), /\/gemini-fixture:generateContent$/);
      assert.equal(init?.method, "POST");
      assert.ok(init?.signal);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(body.generationConfig.maxOutputTokens, 2048);
      assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/webp");
      return new Response("{malformed", { status: 200 });
    };
    await assert.rejects(
      generate(
        snapshot.steps[0],
        "fixture",
        Buffer.from("image"),
        "fixture-key",
      ),
      ProviderResponseError,
    );
    assert.equal(calls, 1);
    global.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("connection lost"));
          },
        }),
      );
    await assert.rejects(
      generate(
        snapshot.steps[0],
        "fixture",
        Buffer.from("image"),
        "fixture-key",
      ),
      (error) =>
        error instanceof TypeError && !(error instanceof ProviderResponseError),
    );
    global.fetch = async () =>
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { thought: true, text: "private thinking" },
                { text: JSON.stringify({ observations: ["valid"] }) },
              ],
            },
          },
        ],
      });
    assert.deepEqual(
      await generate(
        snapshot.steps[0],
        "fixture",
        Buffer.from("image"),
        "fixture-key",
      ),
      { observations: ["valid"] },
    );
  } finally {
    global.fetch = nativeFetch;
  }
});

test("real journal keeps rejected output failed and lost save acknowledgement uncertain; request tokens never redispatch", async () => {
  const { runtimeFixture, runtimeAdmin, runtimeChains, adminSave } =
    await import("./helpers/prompt-hardening");
  const { readFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { db } = await runtimeFixture();
  const actor = async <T>(sql: string, args: unknown[] = []) => {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      runtimeAdmin,
    ]);
    try {
      return (await db.query<{ data: T }>(sql, args)).rows[0]?.data;
    } finally {
      await db.exec("reset role");
    }
  };
  try {
    await db.exec(
      await readFile("supabase/migrations/202611030001_chain_tool.sql", "utf8"),
    );
    for (let i = 0; i < 3; i++)
      await adminSave(db, "create_step", {
        chain_id: runtimeChains[0],
        template: "Generate captions",
        model_id: null,
        role: "auto",
      });
    for (const mode of ["contract", "acknowledgement"] as const) {
      const token = randomUUID(),
        hash = "a".repeat(64),
        path = `${runtimeAdmin}/${token}-${hash}.webp`;
      await actor(
        "insert into storage.objects(bucket_id,name,owner_id) values('prompt-chain-inputs',$1,$2)",
        [path, runtimeAdmin],
      );
      const reserve = () =>
        actor<{ dispatch: boolean; snapshot: ExecutionSnapshot }>(
          "select pct_start($1,$2,$3,$4) data",
          [token, runtimeChains[0], path, hash],
        );
      const reservation = await reserve();
      assert.equal(reservation.dispatch, true);
      let calls = 0;
      await runExecution({
        token,
        snapshot: reservation.snapshot,
        signal: new AbortController().signal,
        emit: () => {},
        generate: async () => {
          calls++;
          return mode === "contract"
            ? { unexpected: "response" }
            : { observations: ["valid response"] };
        },
        progress: async (entry) => {
          await actor("select pct_progress($1,$2,$3,$4) data", [
            token,
            entry.step_index,
            entry.result ?? null,
            entry.outcome ?? null,
          ]);
          if (mode === "acknowledgement" && entry.result)
            throw new AppError(
              "Acknowledgement lost after committed output",
              503,
            );
        },
      });
      const run = (
        await db.query<{ status: string; outputs: unknown[] }>(
          "select status,outputs from pct_runs where id=$1",
          [token],
        )
      ).rows[0];
      assert.equal(run.status, mode === "contract" ? "failed" : "uncertain");
      assert.equal(run.outputs.length, mode === "contract" ? 0 : 1);
      assert.equal((await reserve()).dispatch, false);
      assert.equal(
        calls,
        1,
        "no later step and no automatic retry of the reserved billable request",
      );
    }
  } finally {
    await db.close();
  }
});
