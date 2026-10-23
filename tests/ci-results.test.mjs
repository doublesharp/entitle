import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { validateCiResults } from "../scripts/deployment/check-ci-results.mjs";

const jobs = [
  "changes",
  "server-checks",
  "server-tests",
  "frontend",
  "server-build",
  "server-image",
  "web-runtime",
];
const base = () => ({
  ...Object.fromEntries(jobs.map((name) => [name, { result: "success" }])),
  changes: { result: "success", outputs: { server: "true", runtime: "true" } },
});
const pr = () => {
  const results = base();
  for (const name of ["server-build", "server-image", "web-runtime"])
    results[name].result = "skipped";
  return results;
};

test("successful trusted runs and credential-free PRs pass", () => {
  for (const event of ["push", "workflow_dispatch"])
    assert.doesNotThrow(() => validateCiResults(base(), event));
  assert.doesNotThrow(() => validateCiResults(pr(), "pull_request"));
});

test("every failed, cancelled, missing or unknown required job fails closed, including the shard matrix", () => {
  for (const event of ["push", "pull_request", "workflow_dispatch"]) {
    for (const name of jobs) {
      for (const result of ["failure", "cancelled", undefined, "unknown"]) {
        const results = event === "pull_request" ? pr() : base();
        results[name].result = result;
        assert.throws(
          () => validateCiResults(results, event),
          new RegExp(name),
        );
      }
    }
  }
});

test("affected checks and all test shards cannot skip", () => {
  for (const name of ["server-checks", "server-tests"]) {
    for (const server of ["true", undefined, "FALSE"]) {
      const results = base();
      results.changes.outputs.server = server;
      results[name].result = "skipped";
      assert.throws(() => validateCiResults(results, "push"), new RegExp(name));
    }
  }
});

test("cached server checks and matrix can skip while trusted image jobs must succeed", () => {
  for (const event of ["push", "workflow_dispatch", "pull_request"]) {
    const results = event === "pull_request" ? pr() : base();
    results.changes.outputs.server = "false";
    for (const name of ["server-checks", "server-tests"])
      results[name].result = "skipped";
    assert.doesNotThrow(() => validateCiResults(results, event));
    if (event !== "pull_request") {
      for (const name of ["server-build", "server-image", "web-runtime"]) {
        const skipped = structuredClone(results);
        skipped[name].result = "skipped";
        assert.throws(
          () => validateCiResults(skipped, event),
          new RegExp(name),
        );
      }
    }
  }
});

test("unconditional jobs cannot skip and unsupported events fail closed", () => {
  for (const name of ["changes", "frontend"]) {
    const results = base();
    results[name].result = "skipped";
    assert.throws(
      () => validateCiResults(results, "pull_request"),
      new RegExp(name),
    );
  }
  assert.throws(() => validateCiResults(null, "push"));
  assert.throws(() => validateCiResults(base(), "workflow_run"));
});

test("CLI returns nonzero for a failed shard matrix and never prints environment secrets", () => {
  const results = base();
  results["server-tests"].result = "failure";
  const run = spawnSync(
    process.execPath,
    ["scripts/deployment/check-ci-results.mjs"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CI_RESULTS: JSON.stringify(results),
        CI_EVENT_NAME: "push",
        REGISTRY_TOKEN: "do-not-print-token",
      },
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /server-tests/);
  assert.doesNotMatch(run.stdout + run.stderr, /do-not-print-token/);
});
