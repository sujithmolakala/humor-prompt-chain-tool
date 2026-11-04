import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weightedSelection,
  executeChain,
  validateSnapshot,
  threeCaptions,
  type ExecutionSnapshot,
} from "../lib/chain-execution";
const step = (position: number) => ({
  id: `step-${position}`,
  position,
  role: "auto",
  template: "Use the attached image",
  model_id: "catalog-model",
  model: "gemini-3.1-flash-lite",
  provider: "google-ai",
  temperature: 1,
  max_tokens: 2048,
});
const captions = [
  "The cat has scheduled a meeting with gravity.",
  "Office chair, executive nap.",
  "My manager requested more purrformance.",
];
test("weighted selection is per batch, rejects invalid configurations and never selects disabled/zero chains", () => {
  const rows = [
    { name: "A", enabled: true, allocation: 70 },
    { name: "B", enabled: true, allocation: 30 },
    { name: "C", enabled: false, allocation: 100 },
    { name: "D", enabled: true, allocation: 0 },
  ];
  const counts = { A: 0, B: 0 };
  for (let t = 0; t < 10000; t++)
    counts[weightedSelection(rows, t).name as "A" | "B"]++;
  assert.deepEqual(counts, { A: 7000, B: 3000 });
  for (const weights of [[100], [50, 30, 20], [40, 30, 20, 10]])
    assert.doesNotThrow(() =>
      weightedSelection(
        weights.map((allocation) => ({ allocation, enabled: true })),
        9999,
      ),
    );
  for (const weights of [[], [99], [101], [-1, 101], [20, 20, 20, 20, 20]])
    assert.throws(() =>
      weightedSelection(
        weights.map((allocation) => ({ allocation, enabled: true })),
        0,
      ),
    );
});
test("sequential execution preserves 1-based positions and original candidate-first steps, propagates structured output, validates final captions", async () => {
  const snapshot: ExecutionSnapshot = {
    chain_id: "chain",
    name: "Creative Humor",
    steps: [
      step(1),
      { ...step(3), template: "Refine {{previous}}; avoid {{avoid}}" },
    ],
  };
  const order: number[] = [];
  const result = await executeChain(
    snapshot,
    [],
    async (s, index, prompt, final, validate) => {
      order.push(s.position);
      if (index === 1) {
        assert.match(prompt, /scheduled a meeting/);
        assert.equal(final, true);
      }
      return validate({ captions });
    },
  );
  assert.deepEqual(order, [1, 3]);
  assert.deepEqual(result.captions, captions);
  assert.equal(result.model, "gemini-3.1-flash-lite");
  await assert.rejects(executeChain(snapshot, [], async () => ({ ideas: [] })));
  await assert.rejects(
    executeChain(snapshot, [], async () => {
      throw Error("provider failure");
    }),
    /provider failure/,
  );
  for (const value of [
    { captions: [] },
    { captions: ["x", "x", "y"] },
    { captions: ["", "two", "three"] },
    { captions: ["x".repeat(281), "two", "three"] },
  ])
    assert.throws(() => threeCaptions(value));
  assert.throws(() => threeCaptions({ captions }, captions));
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      steps: [{ ...step(1), template: "{{previous}}" }],
    }),
  );
  assert.throws(() =>
    validateSnapshot({ ...snapshot, steps: [step(1), step(1)] }),
  );
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      steps: [{ ...step(1), model: "unknown" }],
    }),
  );
  for (const count of [1, 3, 4]) {
    const output = await executeChain(
      {
        ...snapshot,
        steps: Array.from({ length: count }, (_, i) => step(i + 1)),
      },
      [],
      async (_s, _i, _p, final, validate) =>
        validate(
          final ? { captions } : { observations: ["cat on office chair"] },
        ),
    );
    assert.equal(output.captions.length, 3);
  }
});
