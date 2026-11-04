// Disposable native PostgreSQL; local Unix socket only, never hosted credentials.
import { mkdtemp, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "pct-postgres-"));
const data = join(root, "data"),
  socket = join(root, "socket");
await mkdir(socket);
const port = "55439";
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PGHOST: socket,
  PGPORT: port,
  PGUSER: "postgres",
  PGDATABASE: "postgres",
};
delete env.PGHOSTADDR;
env.PGPASSFILE = join(root, "no-password-file");
env.PGCONNECT_TIMEOUT = "5";
delete env.PGPASSWORD;
delete env.PGSERVICE;
delete env.PGSERVICEFILE;
function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { env, input, encoding: "utf8" });
  if (r.status !== 0) throw Error(`${cmd} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const sql = (input: string) =>
  run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-At"], input);
let started = false;
try {
  run("initdb", [
    "-D",
    data,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--locale=C",
    "--encoding=UTF8",
  ]);
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    join(root, "postgres.log"),
    "-o",
    `-h '' -k ${socket} -p ${port}`,
    "start",
  ]);
  started = true;
  sql(await readFile("tests/fixture.sql", "utf8"));
  for (const f of (await readdir("tests/fixtures/rating-app")).sort())
    sql(await readFile("tests/fixtures/rating-app/" + f, "utf8"));
  for (const f of (await readdir("supabase/migrations")).sort())
    sql(await readFile("supabase/migrations/" + f, "utf8"));
  const actor = "11111111-1111-4111-8111-111111111111";
  sql(
    `insert into auth.users(id) values('${actor}');insert into profiles(id,is_superadmin) values('${actor}',true);insert into prompt_chains(name) values('Native ordering');`,
  );
  const chain = sql(
    "select id from prompt_chains where name='Native ordering'",
  );
  sql(
    `insert into prompt_chain_steps(chain_id,position,prompt_template) values('${chain}',1,'First'),('${chain}',2,'Second'),('${chain}',3,'Third');`,
  );
  const ids = sql(
    `select id from prompt_chain_steps where chain_id='${chain}' order by position`,
  ).split("\n");
  const rev = sql("select revision from hs_runtime_settings");
  const reorder = `set role authenticated;select set_config('request.jwt.claim.sub','${actor}',false);select hs_admin_save('reorder','${JSON.stringify({ chain_id: chain, order: [ids[0], ids[2], ids[1]] })}'::jsonb,${rev});`;
  const hold = spawn("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-At"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let readyResolve: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  let output = "";
  hold.stdout.on("data", (d) => {
    output += d.toString();
    if (output.includes("locked")) readyResolve();
  });
  hold.stdin.end(
    `begin;select revision from hs_runtime_settings where id for update;select 'locked';select pg_sleep(1);${reorder}commit;`,
  );
  await ready;
  const competing = spawn("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-At"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let error = "";
  competing.stderr.on("data", (d) => (error += d.toString()));
  competing.stdin.end(reorder);
  const code = await new Promise<number | null>((r) =>
    competing.on("close", r),
  );
  assert.notEqual(code, 0);
  assert.match(error, /Configuration changed/);
  const authoritative = sql(
    `select id from prompt_chain_steps where chain_id='${chain}' order by position`,
  ).split("\n");
  assert.deepEqual(authoritative, [ids[0], ids[2], ids[1]]);
  assert.equal(
    sql(
      `select count(distinct position)=3 and count(distinct id)=3 from prompt_chain_steps where chain_id='${chain}'`,
    ),
    "t",
  );
  console.log(
    "PASS: native independent-connection ordering lock, stale revision rejection, and persisted identities/positions.",
  );
} finally {
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "stop"]);
  console.log("Disposable cluster logs:", root);
}
