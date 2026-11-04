import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeChain,
  validateSnapshot,
  type ExecutionSnapshot,
} from "../lib/chain-execution";
import { providerKey, generate } from "../lib/provider";
import { validateImage } from "../lib/images";
import { resolveTheme, validTheme } from "../lib/theme";
import { moveStep } from "../lib/order";
const step = {
  id: "step",
  position: 1,
  role: "auto",
  template: "Describe this image",
  model_id: "database-id",
  model: "gemini-fixture",
  provider: "google-ai",
  temperature: 1,
  max_tokens: 2048,
};
test("five-caption execution is sequential, propagates previous output, preserves selected chain and stops on failure", async () => {
  const snapshot: ExecutionSnapshot = {
    chain_id: "selected",
    name: "Selected chain",
    steps: [
      step,
      { ...step, id: "two", position: 2, template: "Use {{previous}}" },
      { ...step, id: "three", position: 3, template: "Caption {{previous}}" },
    ],
  };
  let calls = 0;
  const output = await executeChain(
    snapshot,
    [],
    async (s, i, p, _f, validate) => {
      assert.equal(i, calls++);
      if (i === 1) assert.match(p, /original visual detail/);
      if (i === 2) assert.match(p, /humorous observation/);
      return validate(
        i === 0
          ? { observations: ["original visual detail"] }
          : i === 1
            ? { ideas: ["humorous observation"] }
            : {
                captions: [
                  "One joke",
                  "Two joke",
                  "Three joke",
                  "Four joke",
                  "Five joke",
                ],
              },
      );
    },
    5,
  );
  assert.equal(calls, 3);
  assert.equal(output.captions.length, 5);
  assert.equal(snapshot.chain_id, "selected");
  calls = 0;
  await assert.rejects(
    executeChain(
      snapshot,
      [],
      async () => {
        calls++;
        throw Error("provider failed");
      },
      5,
    ),
  );
  assert.equal(calls, 1);
  for (const steps of [
    [],
    [step, { ...step, position: 1 }],
    [{ ...step, template: "{{unknown}}" }],
  ])
    assert.throws(() => validateSnapshot({ ...snapshot, steps }));
});
test("missing credentials are actionable, malformed images are rejected and provider errors expose no body", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  assert.throws(providerKey, /GEMINI_API_KEY/);
  if (saved) process.env.GEMINI_API_KEY = saved;
  await assert.rejects(
    validateImage(new File(["invalid bytes"], "x.png", { type: "image/png" })),
    /valid/,
  );
  await assert.rejects(validateImage(null), /3 MB/);
  const native = global.fetch;
  global.fetch = async () =>
    new Response("sensitive provider error", { status: 429 });
  try {
    await assert.rejects(
      generate(step, "prompt", Buffer.from("image"), "fixture-key"),
      (e) =>
        e instanceof Error &&
        /rate limit/.test(e.message) &&
        !e.message.includes("sensitive"),
    );
  } finally {
    global.fetch = native;
  }
});
test("reordering preserves all identities and theme resolution honors system preference", () => {
  assert.deepEqual(moveStep(["a", "b", "c"], 2, 1), ["a", "c", "b"]);
  assert.throws(() => moveStep(["a", "a"], 0, 1));
  assert.throws(() => moveStep(["a"], 0, 1));
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(validTheme("bad"), "system");
});
