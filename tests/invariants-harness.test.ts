import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { allCompleted } from "./helpers/invariants.ts";

test("invariant harness drains sibling operations before a failure can reset the next sample", async () => {
  const failure = Error("first concurrent operation failed");
  const release = Promise.withResolvers<void>();
  let finished = false,
    wrote = false;
  const pending = allCompleted([
    Promise.reject(failure),
    release.promise.then(() => {
      wrote = true;
    }),
  ]);
  const observed = pending.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    await setImmediate();
    assert.equal(
      finished,
      false,
      "the sample must wait for all database writers",
    );
    assert.equal(wrote, false);
  } finally {
    release.resolve();
    await observed;
  }
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(wrote, true);
  assert.deepEqual(
    await allCompleted([Promise.resolve(1), Promise.resolve(2)]),
    [1, 2],
  );
});
