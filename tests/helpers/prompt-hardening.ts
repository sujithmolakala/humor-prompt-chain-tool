import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
export const promptMigration =
  "supabase/migrations/202611010001_prompt_execution.sql";
export const runtimeAdmin = "11111111-1111-4111-8111-111111111111";
export const runtimeUser = "22222222-2222-4222-8222-222222222222";
export const runtimeChains = [1, 2, 3, 4].map(
  (n) => "44444444-4444-4444-8444-" + String(n).padStart(12, "0"),
);
export async function legacyPromptDatabase() {
  const db = new PGlite();
  await db.exec(await readFile("tests/fixture.sql", "utf8"));
  for (const f of (await readdir("tests/fixtures/rating-app")).sort())
    await db.exec(await readFile("tests/fixtures/rating-app/" + f, "utf8"));
  for (const f of (await readdir("supabase/migrations")).sort())
    if (f < "202611010001")
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
  return db;
}
export async function service<T = unknown>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  await db.exec("set role service_role");
  try {
    return (await db.query<{ data: T }>(sql, args)).rows[0]?.data;
  } finally {
    await db.exec("reset role");
  }
}
export async function adminSave(
  db: PGlite,
  operation: string,
  payload: unknown,
) {
  const rev = (
    await db.query<{ revision: number }>(
      "select revision from hs_runtime_settings",
    )
  ).rows[0].revision;
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    runtimeAdmin,
  ]);
  try {
    return (
      await db.query("select hs_admin_save($1,$2,$3)", [
        operation,
        payload,
        rev,
      ])
    ).rows;
  } finally {
    await db.exec("reset role");
  }
}
export async function runtimeFixture() {
  const db = await legacyPromptDatabase();
  await db.exec(await readFile(promptMigration, "utf8"));
  await db.query("insert into auth.users(id) values($1),($2)", [
    runtimeAdmin,
    runtimeUser,
  ]);
  await db.query(
    "insert into profiles(id,is_superadmin) values($1,true),($2,false)",
    [runtimeAdmin, runtimeUser],
  );
  const provider = (
    await db.query<{ id: string }>(
      "insert into llm_providers(identifier,name) values('google-ai','Google AI fixture') returning id",
    )
  ).rows[0].id;
  const model = (
    await db.query<{ id: string }>(
      "insert into llm_models(identifier,name,provider_id,max_tokens) values('gemini-3.1-flash-lite','Gemini fixture',$1,2048) returning id",
      [provider],
    )
  ).rows[0].id;
  await adminSave(db, "approve_model", { id: model });
  for (const id of runtimeChains) {
    await db.query("insert into prompt_chains(id,name) values($1,$2)", [
      id,
      "Chain " + id.slice(-1),
    ]);
    await db.query(
      "insert into prompt_chain_steps(chain_id,position,prompt_template) values($1,1,'Generate three captions')",
      [id],
    );
  }
  return { db, model, provider };
}
export async function saveWeights(db: PGlite, weights: number[]) {
  return adminSave(db, "mix", {
    allocations: weights.map((allocation, i) => ({
      chain_id: runtimeChains[i],
      allocation,
    })),
  });
}
export async function reserve(db: PGlite) {
  const token = randomUUID();
  const hash = createHash("sha256").update(token).digest("hex");
  const r = await service<{ dispatch: boolean; draft: { id: string } }>(
    db,
    "select caption_generation_reserve($1,$2,$3,12,24) data",
    [runtimeUser, hash, token],
  );
  if (!r.dispatch) throw Error("Fixture reservation rejected");
  return token;
}
export async function plan(db: PGlite, token: string, ticket = 0) {
  return service<{
    error?: string;
    snapshot: {
      chain_id: string;
      steps: {
        id: string;
        position: number;
        model: string;
        model_id: string;
        max_tokens: number;
      }[];
    };
  }>(db, "select hs_generation_plan($1,$2,$3) data", [
    runtimeUser,
    token,
    ticket,
  ]);
}
export async function quota(db: PGlite) {
  return (
    await db.query<{ used: number; dispatched: number }>(
      "select used,dispatched from caption_generation_days where user_id=$1",
      [runtimeUser],
    )
  ).rows[0];
}
