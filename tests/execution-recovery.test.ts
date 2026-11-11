import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  runtimeFixture,
  runtimeAdmin,
  runtimeUser,
  runtimeChains,
  adminSave,
} from "./helpers/prompt-hardening";
import { runExecution } from "../lib/execution-runner";
import type { Run } from "../lib/tool-data";
import { AppError } from "../lib/security";
const final = {
  captions: ["One joke", "Two joke", "Three joke", "Four joke", "Five joke"],
};
const intermediate = (i: number) => ({
  observations: [`Saved observation ${i}`],
});

test("real SQL recovery: atomic final output, lost acknowledgements, interrupted Step 4, and safe resume without duplicate dispatch", async () => {
  const { db } = await runtimeFixture();
  const actor = async <T>(
    sql: string,
    args: unknown[] = [],
    uid: string | null = runtimeAdmin,
  ) => {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      uid ?? "",
    ]);
    try {
      return (await db.query<{ data: T }>(sql, args)).rows[0]?.data;
    } finally {
      await db.exec("reset role");
    }
  };
  const saved = async (token: string) =>
    (await db.query<Run>("select * from pct_runs where id=$1", [token]))
      .rows[0];
  const progress = (
    token: string,
    i: number,
    result: unknown = null,
    outcome: string | null = null,
  ) =>
    actor("select pct_progress($1,$2,$3,$4) data", [token, i, result, outcome]);
  const reserve = async (chain: string) => {
    const token = randomUUID(),
      hash = "a".repeat(64),
      path = `${runtimeAdmin}/${token}-${hash}.webp`;
    await actor(
      "insert into storage.objects(bucket_id,name,owner_id) values('prompt-chain-inputs',$1,$2)",
      [path, runtimeAdmin],
    );
    const start = () =>
      actor<{ dispatch: boolean; snapshot: Run["snapshot"] }>(
        "select pct_start($1,$2,$3,$4) data",
        [token, chain, path, hash],
      );
    assert.equal((await start()).dispatch, true);
    return { token, start };
  };
  const resume = (token: string, uid: string | null = runtimeAdmin) =>
    actor<{ dispatch: boolean; run: Run }>(
      "select pct_resume($1) data",
      [token],
      uid,
    );
  try {
    for (const file of [
      "202611030001_chain_tool.sql",
      "202611030002_chain_duplication.sql",
      "202611050001_execution_recovery.sql",
    ])
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    assert.equal(await actor("select pct_recovery_ready() data"), true);
    for (let chain = 0; chain < 4; chain++)
      for (let i = 0; i < chain; i++)
        await adminSave(db, "create_step", {
          chain_id: runtimeChains[chain],
          template: "Use {{previous}}",
          model_id: null,
          role: "auto",
        });
    for (const mode of [
      "one",
      "two",
      "three",
      "four",
      "save_ack",
      "finalize_ack",
      "save_down_0",
      "save_down_1",
      "save_down_2",
      "save_down_3",
      "transport_0",
      "transport_1",
      "transport_2",
      "transport_3",
    ] as const) {
      const chainIndex = ["one", "two", "three", "four"].includes(mode)
        ? ["one", "two", "three", "four"].indexOf(mode)
        : 3;
      const interruptedStep = Number(mode.split("_").at(-1));
      const { token, start } = await reserve(runtimeChains[chainIndex]);
      const run = await saved(token),
        events: Record<string, unknown>[] = [];
      let calls = 0,
        lost = false;
      await runExecution({
        token,
        snapshot: run.snapshot,
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        load: () => saved(token),
        generate: async (step) => {
          calls++;
          if (mode.startsWith("transport_") && calls === interruptedStep + 1)
            throw new TypeError("fixture connection interrupted");
          return step.position === run.snapshot.steps.length
            ? final
            : intermediate(calls);
        },
        progress: async (entry) => {
          if (
            mode.startsWith("save_down_") &&
            entry.result &&
            entry.step_index === interruptedStep
          )
            throw new AppError("fixture DB unavailable", 503);
          if (entry.outcome && entry.outcome !== "completed")
            await actor("select pct_stop($1,$2,$3,$4) data", [
              token,
              entry.step_index,
              entry.outcome,
              entry.reason,
            ]);
          else
            await progress(
              token,
              entry.step_index,
              entry.result ?? null,
              entry.outcome ?? null,
            );
          if (
            !lost &&
            ((mode === "save_ack" && entry.result && entry.step_index === 3) ||
              (mode === "finalize_ack" && entry.outcome === "completed"))
          ) {
            lost = true;
            throw new AppError("fixture ack lost", 503);
          }
        },
      });
      const after = await saved(token);
      assert.equal(
        calls,
        Number.isFinite(interruptedStep) ? interruptedStep + 1 : chainIndex + 1,
      );
      assert.equal((await start()).dispatch, false);
      if (mode.startsWith("save_down_") || mode.startsWith("transport_")) {
        assert.equal(after.status, "uncertain");
        assert.equal(after.outputs.length, interruptedStep);
        assert.match(after.error!, new RegExp(`Step ${interruptedStep + 1}:`));
        assert.equal(events.at(-1)?.type, "error");
        await assert.rejects(resume(token), /started step/);
      } else {
        assert.equal(after.status, "completed");
        assert.equal(after.outputs.length, chainIndex + 1);
        assert.deepEqual(after.outputs.at(-1), final);
        assert.equal(events.at(-1)?.type, "finished");
        const recovered = await resume(token);
        assert.equal(recovered.dispatch, false);
        assert.equal(recovered.run.status, "completed");
      }
    }
    const { token } = await reserve(runtimeChains[3]);
    for (let i = 0; i < 3; i++) {
      await progress(token, i);
      await progress(token, i, intermediate(i));
    }
    await actor(
      "select pct_stop($1,3,'failed','deadline_before_dispatch') data",
      [token],
    );
    const before = await saved(token);
    for (const uid of [runtimeUser, null])
      await assert.rejects(
        resume(token, uid),
        /Superadmin|Authentication required/,
      );
    await db.query("update profiles set is_superadmin=true where id=$1", [
      runtimeUser,
    ]);
    await assert.rejects(resume(token, runtimeUser), /Execution missing/);
    await db.query("update profiles set is_superadmin=false where id=$1", [
      runtimeUser,
    ]);
    await adminSave(db, "edit_step", {
      chain_id: runtimeChains[3],
      id: before.snapshot.steps[3].id,
      template: "Changed later instructions",
      model_id: null,
      role: "auto",
    });
    const lease = await resume(token);
    assert.equal(lease.dispatch, true);
    assert.deepEqual(lease.run.snapshot, before.snapshot);
    await assert.rejects(resume(token), /started step/);
    let calls = 0;
    await runExecution({
      token,
      snapshot: lease.run.snapshot,
      savedOutputs: lease.run.outputs,
      signal: new AbortController().signal,
      emit: () => {},
      load: () => saved(token),
      generate: async (step, prompt) => {
        calls++;
        assert.equal(step.position, 4);
        assert.match(prompt, /Saved observation 2/);
        return final;
      },
      progress: (entry) =>
        progress(
          token,
          entry.step_index,
          entry.result ?? null,
          entry.outcome ?? null,
        ),
    });
    assert.equal(calls, 1);
    const after = await saved(token);
    assert.equal(after.status, "completed");
    assert.deepEqual(after.outputs.slice(0, 3), before.outputs);
    await assert.rejects(
      progress(token, 3, { captions: ["different"] }),
      /Checkpoint conflict/,
    );
    // A legacy all-outputs-saved run needs only finalization, never another model call.
    await db.query(
      "update pct_runs set status='uncertain',error='legacy finalization lost' where id=$1",
      [token],
    );
    assert.equal((await resume(token)).dispatch, false);
    assert.equal((await saved(token)).status, "completed");
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});
