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
import type { PGlite } from "@electric-sql/pglite";
async function actor<T>(
  db: PGlite,
  id: string | null,
  sql: string,
  args: unknown[] = [],
) {
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    id || "",
  ]);
  try {
    return (await db.query<{ data: T }>(sql, args)).rows[0]?.data;
  } finally {
    await db.exec("reset role");
  }
}
test("real SQL: authorization, CRUD, atomic reorder, stale revision, duplication, history attribution, idempotency, failures and private images", async () => {
  const { db } = await runtimeFixture();
  try {
    for (const file of [
      "202611030001_chain_tool.sql",
      "202611030002_chain_duplication.sql",
    ])
      await db.exec(await readFile("supabase/migrations/" + file, "utf8"));
    // Verify there is no ordinary-user or anonymous access even with legacy permissive policies.
    for (const id of [null, runtimeUser]) {
      await assert.rejects(actor(db, id, "select pct_history() data"));
      await assert.rejects(actor(db, id, "select hs_admin_state() data"));
      await assert.rejects(
        actor(db, id, "select pct_start($1,$2,'x','x') data", [
          randomUUID(),
          runtimeChains[0],
        ]),
      );
      await assert.rejects(actor(db, id, "select * from pct_runs"));
      const count = await actor<number>(
        db,
        id,
        "select count(*)::int data from storage.objects where bucket_id='prompt-chain-inputs'",
      );
      assert.equal(count, 0);
    }
    const admin = <T>(sql: string, args: unknown[] = []) =>
      actor<T>(db, runtimeAdmin, sql, args);
    const rev = async () =>
      Number(
        (
          await db.query<{ revision: number }>(
            "select revision from hs_runtime_settings",
          )
        ).rows[0].revision,
      );
    await adminSave(db, "create_chain", {
      name: "Tool CRUD",
      description: "Original",
    });
    const target = (
      await db.query<{ id: string }>(
        "select id from prompt_chains where name='Tool CRUD'",
      )
    ).rows[0].id;
    await adminSave(db, "edit_chain", {
      id: target,
      name: "Updated",
      description: "Edited",
    });
    for (const template of [
      "Observe image",
      "Draft a joke",
      "Generate captions",
    ])
      await adminSave(db, "create_step", {
        chain_id: target,
        template,
        model_id: null,
        role: "auto",
      });
    const ids = (
      await db.query<{ id: string }>(
        "select id from prompt_chain_steps where chain_id=$1 order by position",
        [target],
      )
    ).rows.map((r) => r.id);
    await adminSave(db, "edit_step", {
      id: ids[0],
      chain_id: target,
      template: "Accurate description",
      model_id: null,
      role: "image_analysis",
    });
    const oldRev = await rev();
    await adminSave(db, "reorder", {
      chain_id: target,
      order: [ids[0], ids[2], ids[1]],
    });
    const persisted = (
      await admin<{
        chains: { id: string; steps: { id: string; position: number }[] }[];
      }>("select hs_admin_state() data")
    ).chains.find((c) => c.id === target)!.steps;
    assert.deepEqual(
      persisted.map((s) => s.id),
      [ids[0], ids[2], ids[1]],
    );
    assert.deepEqual(
      persisted.map((s) => s.position),
      [1, 2, 3],
    );
    await assert.rejects(
      admin("select hs_admin_save($1,$2,$3) data", [
        "reorder",
        { chain_id: target, order: ids },
        oldRev,
      ]),
      /Configuration changed/,
    );
    await assert.rejects(
      adminSave(db, "reorder", {
        chain_id: target,
        order: [ids[0], ids[0], ids[1]],
      }),
    );
    assert.deepEqual(
      (
        await db.query<{ id: string }>(
          "select id from prompt_chain_steps where chain_id=$1 order by position",
          [target],
        )
      ).rows.map((s) => s.id),
      [ids[0], ids[2], ids[1]],
    );
    await admin("select pct_duplicate($1,$2,$3) data", [
      target,
      ids[0],
      await rev(),
    ]);
    await assert.rejects(
      admin("select pct_duplicate($1,$2,$3) data", [
        target,
        ids[0],
        await rev(),
      ]),
      /Maximum four/,
    );
    const last = (
      await db.query<{ id: string }>(
        "select id from prompt_chain_steps where chain_id=$1 order by position desc limit 1",
        [target],
      )
    ).rows[0].id;
    await adminSave(db, "delete_step", { chain_id: target, id: last });
    await admin("select pct_duplicate($1,null,$2) data", [target, await rev()]);
    const copied = (
      await db.query<{ id: string }>(
        "select id from prompt_chains where name='Updated (copy)'",
      )
    ).rows[0].id;
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from prompt_chain_steps where chain_id=$1",
          [copied],
        )
      ).rows[0].n,
      3,
    );
    await adminSave(db, "delete_chain", { id: copied });
    // Every tool run is pinned to an explicitly selected chain; no weighted reassignment.
    const token = randomUUID(),
      hash = "a".repeat(64),
      path = `${runtimeAdmin}/${token}-${hash}.webp`;
    await admin(
      "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3) returning id data",
      ["prompt-chain-inputs", path, runtimeAdmin],
    );
    await assert.rejects(
      actor(
        db,
        runtimeUser,
        "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3) returning id data",
        ["prompt-chain-inputs", `${runtimeUser}/bad.webp`, runtimeUser],
      ),
    );
    assert.equal(
      await actor(
        db,
        runtimeUser,
        "select count(*)::int data from storage.objects where bucket_id='prompt-chain-inputs'",
      ),
      0,
    );
    const start = () =>
      admin<{
        dispatch: boolean;
        snapshot: { chain_id: string; name: string };
      }>("select pct_start($1,$2,$3,$4) data", [token, target, path, hash]);
    const run = await start();
    assert.equal(run.dispatch, true);
    assert.equal(run.snapshot.chain_id, target);
    assert.equal((await start()).dispatch, false);
    await assert.rejects(
      admin("select pct_progress($1,1,$2) data", [
        token,
        { ideas: ["out of order"] },
      ]),
      /Invalid step order/,
    );
    await assert.rejects(
      admin("select pct_progress($1,0,null,'completed') data", [token]),
      /Invalid completion/,
    );
    for (let i = 0; i < 3; i++) {
      await admin("select pct_progress($1,$2) data", [token, i]);
      await admin("select pct_progress($1,$2,$3) data", [
        token,
        i,
        i === 2
          ? { captions: ["a", "b", "c", "d", "e"] }
          : { ideas: ["observed context"] },
      ]);
    }
    await admin("select pct_progress($1,0,null,'completed') data", [token]);
    await assert.rejects(adminSave(db, "delete_chain", { id: target }));
    await assert.rejects(
      adminSave(db, "delete_step", { id: ids[0], chain_id: target }),
    );
    await adminSave(db, "edit_chain", {
      id: target,
      name: "Renamed later",
      description: "new",
    });
    const history = await admin<{
      total: number;
      runs: {
        snapshot: { name: string };
        status: string;
        outputs: unknown[];
      }[];
    }>("select pct_history($1) data", [target]);
    assert.equal(history.total, 1);
    assert.equal(history.runs[0].snapshot.name, "Updated");
    assert.equal(history.runs[0].status, "completed");
    assert.equal(history.runs[0].outputs.length, 3);
    assert.equal(
      (
        await admin<{ total: number }>("select pct_history($1) data", [
          runtimeChains[0],
        ])
      ).total,
      0,
    );
    assert.equal(
      await admin(
        "update storage.objects set name='changed' where bucket_id='prompt-chain-inputs' returning id data",
      ),
      undefined,
    );
    // Failed run persists independently of successful records.
    const failed = randomUUID(),
      failedPath = `${runtimeAdmin}/${failed}-${hash}.webp`;
    await admin(
      "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3) returning id data",
      ["prompt-chain-inputs", failedPath, runtimeAdmin],
    );
    await admin("select pct_start($1,$2,$3,$4) data", [
      failed,
      target,
      failedPath,
      hash,
    ]);
    await admin("select pct_progress($1,0,null,'failed') data", [failed]);
    const stats = await admin<{
      stats: { completed: number; failed: number; total: number };
    }>("select pct_history() data");
    assert.deepEqual(stats.stats, {
      completed: 1,
      failed: 1,
      total: 2,
      uncertain: 0,
    });
  } finally {
    await db.close();
  }
});
