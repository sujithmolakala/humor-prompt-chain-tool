import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import {
  runtimeFixture,
  runtimeAdmin,
  runtimeUser,
} from "./helpers/prompt-hardening";

async function probe(
  db: PGlite,
  role: string,
  uid: string | null,
  sql: string,
  args: unknown[] = [],
) {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      uid ?? "",
    ]);
    return { rows: (await db.query(sql, args)).rows, error: null };
  } catch (error) {
    return { rows: [], error: (error as { code: string }).code };
  } finally {
    await db.exec("rollback");
  }
}

test("pending migrations preserve existing Storage operations under real legacy fences", async () => {
  const { db } = await runtimeFixture();
  try {
    await db.exec(
      "insert into storage.buckets(id,name,public) values('avatars','avatars',true) on conflict do nothing",
    );
    for (const bucket of ["avatars", "caption-images"]) {
      for (const suffix of ["loose.webp", "saved.webp", "archived.webp"]) {
        await db.query(
          "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)",
          [bucket, `${runtimeUser}/${suffix}`, runtimeUser],
        );
      }
    }
    await db.query(
      "insert into captions(creator_id,image_path,user_prompt,generation_prompt,caption,model) values($1,$2,'test','test','test','fixture')",
      [runtimeUser, `${runtimeUser}/saved.webp`],
    );
    await db.query(
      "insert into caption_versions(caption_id,version_number,image_path,caption,model,user_prompt,generation_prompt,published_at,archived_at) select id,2,$1,'archived','fixture','test','test',now(),now() from captions where creator_id=$2",
      [`${runtimeUser}/archived.webp`, runtimeUser],
    );
    const policies = (
      await db.query(
        "select policyname,cmd,roles,qual,with_check from pg_policies where schemaname='storage' order by policyname",
      )
    ).rows;
    const cases: {
      name: string;
      role: string;
      uid: string | null;
      sql: string;
      args: unknown[];
    }[] = [];
    for (const bucket of ["avatars", "caption-images"])
      for (const [role, uid] of [
        ["anon", null],
        ["authenticated", runtimeUser],
        ["authenticated", runtimeAdmin],
      ] as const) {
        const prefix = `${bucket}/${role}/${uid}`;
        for (const suffix of ["loose.webp", "saved.webp", "archived.webp"]) {
          for (const op of ["select", "update", "delete"]) {
            const name = `${runtimeUser}/${suffix}`;
            const sql =
              op === "select"
                ? "select id from storage.objects where bucket_id=$1 and name=$2"
                : op === "update"
                  ? "update storage.objects set name=name where bucket_id=$1 and name=$2 returning name"
                  : "delete from storage.objects where bucket_id=$1 and name=$2 returning name";
            cases.push({
              name: `${prefix}/${suffix}/${op}`,
              role,
              uid,
              sql,
              args: [bucket, name],
            });
          }
        }
        for (const owner of [runtimeUser, runtimeAdmin])
          cases.push({
            name: `${prefix}/insert/${owner}`,
            role,
            uid,
            sql: "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3) returning name",
            args: [bucket, `${owner}/new.webp`, owner],
          });
      }
    const before = [];
    for (const c of cases)
      before.push(await probe(db, c.role, c.uid, c.sql, c.args));
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const [bucket, , , suffix, op] = c.name.split("/");
      const signedIn = c.role === "authenticated";
      const owner = c.uid === runtimeUser;
      if (suffix === "insert") {
        const expected = signedIn && c.uid === c.args[2];
        assert.equal(before[i].error, expected ? null : "42501", c.name);
        assert.equal(before[i].rows.length, expected ? 1 : 0, c.name);
      } else {
        const allowed =
          op === "select"
            ? bucket === "avatars" ||
              (signedIn && (owner || suffix === "saved.webp"))
            : op === "update"
              ? bucket === "avatars" && owner
              : owner && (bucket === "avatars" || suffix === "loose.webp");
        assert.equal(
          before[i].error,
          !signedIn && op === "delete" ? "42501" : null,
          c.name,
        );
        assert.equal(before[i].rows.length, allowed ? 1 : 0, c.name);
      }
    }
    for (const file of [
      "202611030001_chain_tool.sql",
      "202611030002_chain_duplication.sql",
    ])
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      assert.deepEqual(
        await probe(db, c.role, c.uid, c.sql, c.args),
        before[i],
        c.name,
      );
    }
    const after = (
      await db.query(
        "select policyname,cmd,roles,qual,with_check from pg_policies where schemaname='storage' and policyname not like 'pct_%' order by policyname",
      )
    ).rows;
    assert.deepEqual(after, policies);
    assert.equal(
      (
        await db.query<{ public: boolean }>(
          "select public from storage.buckets where id='prompt-chain-inputs'",
        )
      ).rows[0].public,
      false,
    );
    // Deliberately introduce an overbroad legacy grant: restrictive fences must still win.
    await db.exec(
      "create policy compatibility_broad on storage.objects for all to public using(true) with check(true)",
    );
    const path = `${runtimeAdmin}/private.webp`;
    await db.query(
      "insert into storage.objects(bucket_id,name,owner_id) values('prompt-chain-inputs',$1,$2)",
      [path, runtimeAdmin],
    );
    for (const [role, uid] of [
      ["anon", null],
      ["authenticated", runtimeUser],
      ["authenticated", runtimeAdmin],
    ] as const) {
      const read = await probe(
        db,
        role,
        uid,
        "select id from storage.objects where bucket_id='prompt-chain-inputs'",
      );
      assert.equal(read.error, null);
      assert.equal(read.rows.length, uid === runtimeAdmin ? 1 : 0);
      for (const op of [
        "update storage.objects set name=name",
        "delete from storage.objects",
      ]) {
        const result = await probe(
          db,
          role,
          uid,
          `${op} where bucket_id='prompt-chain-inputs' returning name`,
        );
        assert.equal(
          result.error,
          role === "anon" && op.startsWith("delete") ? "42501" : null,
        );
        assert.equal(result.rows.length, 0);
      }
      const write = await probe(
        db,
        role,
        uid,
        "insert into storage.objects(bucket_id,name,owner_id) values('prompt-chain-inputs',$1,$2) returning name",
        [`${uid}/new.webp`, uid],
      );
      assert.equal(write.error, uid === runtimeAdmin ? null : "42501");
    }
    const moved = await probe(
      db,
      "authenticated",
      runtimeUser,
      "update storage.objects set bucket_id='prompt-chain-inputs' where bucket_id='avatars' and name=$1 returning name",
      [`${runtimeUser}/loose.webp`],
    );
    assert.equal(moved.error, "42501");
    for (const [path, owner] of [
      [`${runtimeUser}/spoof.webp`, runtimeAdmin],
      [`${runtimeAdmin}/spoof.webp`, runtimeUser],
    ]) {
      assert.equal(
        (
          await probe(
            db,
            "authenticated",
            runtimeAdmin,
            "insert into storage.objects(bucket_id,name,owner_id) values('prompt-chain-inputs',$1,$2)",
            [path, owner],
          )
        ).error,
        "42501",
      );
    }
    await db.query("update profiles set is_superadmin=false where id=$1", [
      runtimeAdmin,
    ]);
    assert.equal(
      (
        await probe(
          db,
          "authenticated",
          runtimeAdmin,
          "select id from storage.objects where bucket_id='prompt-chain-inputs'",
        )
      ).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("both migrations install and duplicate chains/steps with new IDs, preserved settings and inactive mix", async () => {
  const { db, model } = await runtimeFixture();
  try {
    for (const file of [
      "202611030001_chain_tool.sql",
      "202611030002_chain_duplication.sql",
    ])
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    const target = (
      await db.query<{ id: string }>(
        "insert into prompt_chains(name,description) values('Compatibility copy','Preserve description') returning id",
      )
    ).rows[0].id;
    await db.query(
      "insert into prompt_chain_steps(chain_id,position,prompt_template,model_id,execution_role) values($1,1,'Describe image',$2,'image_analysis'),($1,2,'Generate captions',null,'caption_generation')",
      [target, model],
    );
    const steps = async (chain: string) =>
      (
        await db.query<{
          id: string;
          position: number;
          prompt_template: string;
          model_id: string | null;
          execution_role: string;
        }>(
          "select id,position,prompt_template,model_id,execution_role from prompt_chain_steps where chain_id=$1 order by position",
          [chain],
        )
      ).rows;
    const revision = async () =>
      Number(
        (
          await db.query<{ revision: string }>(
            "select revision from hs_runtime_settings",
          )
        ).rows[0].revision,
      );
    const duplicate = async (
      step: string | null,
      rev: number,
      uid = runtimeAdmin,
    ) => {
      await db.exec("begin");
      try {
        await db.exec("set local role authenticated");
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
          uid,
        ]);
        await db.query("select pct_duplicate($1,$2,$3)", [target, step, rev]);
        await db.exec("commit");
      } catch (e) {
        await db.exec("rollback");
        throw e;
      }
    };
    const original = await steps(target);
    const oldRevision = await revision();
    await duplicate(null, oldRevision);
    assert.ok((await revision()) > oldRevision);
    const copy = (
      await db.query<{ id: string; description: string }>(
        "select id,description from prompt_chains where name='Compatibility copy (copy)'",
      )
    ).rows[0];
    assert.notEqual(copy.id, target);
    assert.equal(copy.description, "Preserve description");
    const copied = await steps(copy.id);
    assert.deepEqual(
      copied.map((s) => [
        s.position,
        s.prompt_template,
        s.model_id,
        s.execution_role,
      ]),
      original.map((s) => [
        s.position,
        s.prompt_template,
        s.model_id,
        s.execution_role,
      ]),
    );
    assert.ok(copied.every((s) => !original.some((o) => o.id === s.id)));
    assert.deepEqual(
      (
        await db.query(
          "select enabled,allocation::int from prompt_chain_mix where chain_id=$1",
          [copy.id],
        )
      ).rows,
      [{ enabled: false, allocation: 0 }],
    );
    await assert.rejects(duplicate(null, oldRevision), /Configuration changed/);
    await assert.rejects(
      duplicate(null, await revision(), runtimeUser),
      /Superadmin/,
    );
    await duplicate(original[0].id, await revision());
    const appended = (await steps(target))[2];
    assert.equal(appended.position, 3);
    assert.equal(appended.model_id, model);
    assert.equal(appended.execution_role, "image_analysis");
    assert.equal(appended.prompt_template, original[0].prompt_template);
    assert.notEqual(appended.id, original[0].id);
    await duplicate(original[1].id, await revision());
    const full = await steps(target);
    assert.equal(full.length, 4);
    assert.equal(full[3].model_id, null);
    const rev = await revision();
    await assert.rejects(duplicate(original[0].id, rev), /Maximum four steps/);
    assert.equal(await revision(), rev);
    assert.deepEqual(await steps(target), full);
    // Historical source configuration never changes during chain duplication.
    assert.deepEqual(await steps(copy.id), copied);
  } finally {
    await db.close();
  }
});
