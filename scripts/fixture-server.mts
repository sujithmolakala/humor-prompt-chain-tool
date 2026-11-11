// Test-only HTTP Supabase adapter backed by disposable PostgreSQL (PGlite).
// Never imported into production. All authentication and provider values are fixtures.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  runtimeFixture,
  runtimeAdmin,
  runtimeUser,
  runtimeChains,
  adminSave,
} from "../tests/helpers/prompt-hardening";
import { fixtureSession } from "../tests/auth-session";
import sharp from "sharp";
const { db } = await runtimeFixture();
for (const f of [
  "202611030001_chain_tool.sql",
  "202611030002_chain_duplication.sql",
  "202611050001_execution_recovery.sql",
])
  await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
await adminSave(db, "edit_step", {
  id: (
    await db.query<{ id: string }>(
      "select id from prompt_chain_steps where chain_id=$1",
      [runtimeChains[0]],
    )
  ).rows[0].id,
  chain_id: runtimeChains[0],
  template: "Describe the original image",
  role: "image_analysis",
  model_id: null,
});
await adminSave(db, "create_step", {
  chain_id: runtimeChains[0],
  template: "Generate an original funny observation from {{previous}}",
  role: "ideation",
  model_id: null,
});
await adminSave(db, "create_step", {
  chain_id: runtimeChains[0],
  template: "Generate five captions from {{previous}}",
  role: "caption_generation",
  model_id: null,
});
const pixels = await sharp({
  create: { width: 160, height: 100, channels: 3, background: "#4d897b" },
})
  .webp()
  .toBuffer();
const blobs = new Map<string, Buffer>();
let calls = 0,
  mode = "success",
  imageReceived = false;
let queue = Promise.resolve();
const server = createServer((req, res) => {
  queue = queue
    .then(async () => {
      const url = new URL(req.url || "/", "http://localhost:4319");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const raw = Buffer.concat(chunks);
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/health") {
        send(200, { ready: true });
        return;
      }
      if (url.pathname === "/__test/image") {
        res.writeHead(200, { "Content-Type": "image/webp" });
        res.end(pixels);
        return;
      }
      if (url.pathname === "/__test/generation") {
        if (req.method === "POST") {
          mode = JSON.parse(raw.toString() || "{}").mode || "success";
          calls = 0;
          imageReceived = false;
        }
        send(200, { calls, imageReceived });
        return;
      }
      if (url.pathname === "/__test/gemini") {
        calls++;
        const body = JSON.parse(raw.toString());
        const image = body.contents?.[0]?.parts?.[1]?.inlineData;
        imageReceived =
          image?.mimeType === "image/webp" &&
          Buffer.from(image?.data || "", "base64").length > 0;
        if (mode === "failure") {
          send(429, { error: "Fixture rate limit" });
          return;
        }
        const final = body.contents[0].parts[0].text.includes(
          "5 distinct concise caption strings",
        );
        const output = final
          ? {
              captions: [
                "Office hours for my emotional support coffee.",
                "This meeting could have been a nap.",
                "The group project has entered its abstract era.",
                "My budget took the express train downtown.",
                "A standing ovation for sitting this one out.",
              ],
            }
          : {
              observations: ["A green rectangle in the original image"],
              ideas: ["The shape looks like an overworked campus noticeboard"],
            };
        send(200, {
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: JSON.stringify(output) }] },
            },
          ],
        });
        return;
      }
      let id = "";
      try {
        id = JSON.parse(
          Buffer.from(
            req.headers.authorization?.replace(/^Bearer /, "").split(".")[1] ||
              "",
            "base64url",
          ).toString(),
        ).sub;
      } catch {}
      if (![runtimeAdmin, runtimeUser].includes(id)) id = "";
      if (url.pathname === "/auth/v1/user") {
        send(
          id ? 200 : 401,
          id ? fixtureSession(id).user : { code: "bad_jwt" },
        );
        return;
      }
      if (url.pathname === "/auth/v1/logout") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const fn = url.pathname.split("/").at(-1)!;
        if (
          ![
            "admin_identity",
            "hs_admin_state",
            "hs_admin_save",
            "hs_admin_telemetry",
            "pct_recovery_ready",
            "pct_resume",
            "pct_stop",
            "pct_start",
            "pct_progress",
            "pct_history",
            "pct_duplicate",
          ].includes(fn)
        ) {
          send(404, { code: "PGRST202" });
          return;
        }
        const body = JSON.parse(raw.toString() || "{}"),
          keys = Object.keys(body);
        if (keys.some((k) => !/^[a-z_]+$/.test(k))) {
          send(400, {});
          return;
        }
        await db.exec("set role authenticated");
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
          id,
        ]);
        try {
          const r = await db.query<{ data: unknown }>(
            `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) data`,
            keys.map((k) => body[k]),
          );
          send(200, r.rows[0].data);
        } catch (e) {
          const error = e as { code: string; message: string };
          send(error.code === "42501" ? 403 : 400, {
            code: error.code,
            message: error.message,
          });
        } finally {
          await db.exec("reset role");
        }
        return;
      }
      if (url.pathname.startsWith("/storage/v1/object/")) {
        const path = decodeURIComponent(
          url.pathname
            .replace("/storage/v1/object/", "")
            .replace(/^authenticated\//, ""),
        );
        const [bucket, ...parts] = path.split("/");
        const name = parts.join("/");
        await db.exec("set role authenticated");
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
          id,
        ]);
        try {
          if (req.method === "POST") {
            await db.query(
              "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)",
              [bucket, name, id],
            );
            blobs.set(path, raw);
            send(200, { Key: path });
          } else {
            const visible = await db.query(
              "select id from storage.objects where bucket_id=$1 and name=$2",
              [bucket, name],
            );
            const data = blobs.get(path);
            if (!visible.rows.length || !data) {
              send(404, {});
            } else {
              res.writeHead(200, { "Content-Type": "image/webp" });
              res.end(data);
            }
          }
        } catch {
          send(403, { message: "Storage denied" });
        } finally {
          await db.exec("reset role");
        }
        return;
      }
      send(404, { error: "Fixture endpoint unavailable" });
    })
    .catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
});
server.listen(4319, "localhost", () =>
  process.stdout.write("Disposable test backend ready\n"),
);
for (const event of ["SIGTERM", "SIGINT"])
  process.on(event, () =>
    server.close(() => void db.close().then(() => process.exit(0))),
  );
