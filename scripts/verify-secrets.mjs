// Never prints secret values. Checks tracked/staged filenames and production browser assets.
import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const files = execFileSync("git", ["ls-files", "--cached"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
assert(
  files.every(
    (f) =>
      !/(^|\/)(\.env(?!\.example$)|node_modules|\.next|\.vercel)(\/|$|\.)/.test(
        f,
      ),
  ),
  "Forbidden generated or secret file staged",
);
const keys = [
  "GEMINI_API_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VERCEL_TOKEN",
];
const secrets = keys
  .map((k) => process.env[k])
  .filter((v) => v && v.length >= 12);
const assets = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = dir + "/" + entry.name;
    if (entry.isDirectory()) await walk(path);
    else assets.push(path);
  }
}
await walk(".next/static");
for (const path of [...files, ...assets]) {
  const body = await readFile(path);
  assert(
    secrets.every((secret) => !body.includes(Buffer.from(secret))),
    "Credential material found in committed source or browser assets",
  );
}
console.log(
  `PASS: ${files.length} staged/tracked files and ${assets.length} browser assets contain none of the configured server secrets; secret/generated paths excluded.`,
);
