import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdminAccess } from "../lib/auth";
import { AppError } from "../lib/security";
import { chainStatusAllocations, setChainActive } from "../lib/chain-status";
import { getState } from "../lib/tool-data";
import {
  runtimeFixture,
  runtimeAdmin,
  runtimeUser,
  runtimeChains,
  adminSave,
} from "./helpers/prompt-hardening";

test("chain switches persist via checked SQL, preserve valid allocations and reject authorization/revision conflicts", async () => {
  const { db } = await runtimeFixture();
  let queue: Promise<unknown> = Promise.resolve();
  const access = (uid: string | null) =>
    ({
      client: {
        rpc: (name: string, args: Record<string, unknown> = {}) => {
          const request = queue.then(async () => {
            assert.ok(["hs_admin_state", "hs_admin_save"].includes(name));
            await db.exec("begin; set local role authenticated");
            try {
              await db.query(
                "select set_config('request.jwt.claim.sub',$1,true)",
                [uid ?? ""],
              );
              const keys = Object.keys(args);
              const data = (
                await db.query<{ data: unknown }>(
                  `select ${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(",")}) data`,
                  keys.map((key) => args[key]),
                )
              ).rows[0].data;
              await db.exec("commit");
              return { data, error: null };
            } catch (error) {
              await db.exec("rollback");
              return {
                data: null,
                error: { code: (error as { code: string }).code },
              };
            }
          });
          queue = request.catch(() => {});
          return request;
        },
      },
    }) as unknown as AdminAccess;
  const admin = access(runtimeAdmin);
  const revision = async () =>
    Number((await getState(admin)).settings.revision);
  const status = async (id: string) =>
    (await getState(admin)).chains.find((c) => c.id === id)!.enabled;
  const statusError = (code: number) => (e: unknown) =>
    e instanceof AppError && e.status === code;
  try {
    let state = await setChainActive(
      admin,
      runtimeChains[0],
      true,
      await revision(),
    );
    assert.equal(
      state.chains.find((c) => c.id === runtimeChains[0])!.enabled,
      true,
    );
    assert.equal(
      await status(runtimeChains[0]),
      true,
      "fresh database state persists activation",
    );
    state = await setChainActive(
      admin,
      runtimeChains[1],
      true,
      await revision(),
    );
    assert.deepEqual(
      state.chains.filter((c) => c.enabled).map((c) => Number(c.allocation)),
      [50, 50],
    );
    state = await setChainActive(
      admin,
      runtimeChains[0],
      false,
      await revision(),
    );
    assert.equal(await status(runtimeChains[0]), false);
    assert.equal(
      Number(state.chains.find((c) => c.id === runtimeChains[1])!.allocation),
      100,
    );
    await assert.rejects(
      setChainActive(admin, runtimeChains[1], false, await revision()),
      /at least one usable active chain/,
    );
    assert.equal(await status(runtimeChains[1]), true);
    for (const uid of [runtimeUser, null]) {
      await assert.rejects(
        setChainActive(access(uid), runtimeChains[0], true, await revision()),
        statusError(403),
      );
      assert.equal(await status(runtimeChains[0]), false);
    }
    const stale = await revision();
    await adminSave(db, "edit_chain", {
      id: runtimeChains[0],
      name: "Edited elsewhere",
      description: "",
    });
    await assert.rejects(
      setChainActive(admin, runtimeChains[0], true, stale),
      statusError(409),
    );
    const concurrentRevision = await revision();
    const attempts = await Promise.allSettled([
      setChainActive(admin, runtimeChains[0], true, concurrentRevision),
      setChainActive(admin, runtimeChains[2], true, concurrentRevision),
    ]);
    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
    const failed = attempts.find(
      (a) => a.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(statusError(409)(failed.reason));
    for (const id of runtimeChains)
      if (!(await status(id)))
        await setChainActive(admin, id, true, await revision());
    state = await getState(admin);
    const allocations = state.chains
      .filter((c) => c.enabled)
      .map((c) => Number(c.allocation));
    assert.equal(
      Math.round(allocations.reduce((sum, n) => sum + n, 0) * 100),
      10000,
    );
    assert.ok(
      allocations.every((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8),
    );
    const extra = (
      await db.query<{ id: string }>(
        "insert into prompt_chains(name) values('Fifth workflow') returning id",
      )
    ).rows[0].id;
    await assert.rejects(
      setChainActive(admin, extra, true, await revision()),
      /at least one workflow step/,
    );
    await db.query(
      "insert into prompt_chain_steps(chain_id,position,prompt_template) values($1,1,'Generate captions')",
      [extra],
    );
    await assert.rejects(
      setChainActive(admin, extra, true, await revision()),
      /Only four/,
    );
    assert.equal(await status(extra), false);
    const before = await getState(admin);
    // Invalid model/role snapshots are still rejected atomically by the existing RPC.
    await setChainActive(
      admin,
      runtimeChains[3],
      false,
      Number(before.settings.revision),
    );
    await adminSave(db, "edit_step", {
      chain_id: extra,
      id: (
        await db.query<{ id: string }>(
          "select id from prompt_chain_steps where chain_id=$1",
          [extra],
        )
      ).rows[0].id,
      template: "Analyze",
      model_id: null,
      role: "image_analysis",
    });
    await assert.rejects(
      setChainActive(admin, extra, true, await revision()),
      statusError(400),
    );
    assert.equal(await status(extra), false);
    const mix = (await getState(admin)).chains.filter((c) => c.enabled);
    assert.equal(mix.length, 3);
    assert.equal(
      Math.round(mix.reduce((n, c) => n + Number(c.allocation), 0) * 100),
      10000,
    );
  } finally {
    await db.close();
  }
});

test("allocation rounding preserves relative weights and assigns an equal share to a newly active chain", () => {
  const base = {
    settings: { revision: 1, default_model: "fixture", enforce_mix: true },
    models: [],
    chains: [
      {
        id: "a",
        name: "A",
        description: "",
        enabled: true,
        allocation: 75,
        updated_at: "",
        steps: [{}],
      },
      {
        id: "b",
        name: "B",
        description: "",
        enabled: true,
        allocation: 25,
        updated_at: "",
        steps: [{}],
      },
      {
        id: "c",
        name: "C",
        description: "",
        enabled: false,
        allocation: 0,
        updated_at: "",
        steps: [{}],
      },
    ],
  } as unknown as Parameters<typeof chainStatusAllocations>[0];
  assert.deepEqual(chainStatusAllocations(base, "c", true), [
    { chain_id: "a", allocation: 50 },
    { chain_id: "b", allocation: 16.67 },
    { chain_id: "c", allocation: 33.33 },
  ]);
  assert.deepEqual(chainStatusAllocations(base, "b", false), [
    { chain_id: "a", allocation: 100 },
  ]);
});
