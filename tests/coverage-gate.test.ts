import test from "node:test";
import assert from "node:assert/strict";
import {
  coverageFailures,
  type CoverageSummary,
} from "../scripts/coverage-gate.ts";
const covered = {
  coveredLinePercent: 100,
  coveredBranchPercent: 100,
  coveredFunctionPercent: 100,
};
const summary = (patch: Partial<typeof covered> = {}): CoverageSummary => ({
  files: [{ path: "/app/critical.ts", ...covered, ...patch }],
  totals: covered,
});
test("coverage gates every file and every metric instead of accepting a high aggregate", () => {
  for (const metric of Object.keys(covered)) {
    const failures = coverageFailures(summary({ [metric]: 99.99 }), [
      "/app/critical.ts",
    ]);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!, new RegExp(metric));
  }
  assert.deepEqual(
    coverageFailures(
      summary({
        coveredLinePercent: 100,
        coveredBranchPercent: 100,
        coveredFunctionPercent: 100,
      }),
      ["/app/critical.ts"],
    ),
    [],
  );
});
test("missing or duplicate files and invalid totals cannot produce a passing coverage result", () => {
  assert.match(
    coverageFailures(summary(), ["/app/new-file.ts"])[0]!,
    /found 0/,
  );
  const duplicated = summary();
  duplicated.files.push(duplicated.files[0]!);
  assert.match(
    coverageFailures(duplicated, ["/app/critical.ts"])[0]!,
    /found 2/,
  );
  const invalid = summary();
  invalid.totals = { ...covered, coveredBranchPercent: NaN };
  assert.match(coverageFailures(invalid, ["/app/critical.ts"])[0]!, /invalid/);
  assert.match(coverageFailures(summary(), [])[0]!, /No application/);
});
