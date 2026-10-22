import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { coverageFailures, type CoverageSummary } from "./coverage-gate.ts";

const root = process.cwd();
const scratch = "/Volumes/Scratch/double-entitle-wp";
await access("/Volumes/Scratch");
const output = resolve(
  process.env.COVERAGE_DIR ?? `${scratch}/reports/coverage`,
);
const temporary = resolve(
  process.env.COVERAGE_TMP_DIR ?? `${scratch}/tmp/coverage`,
);
if (!output.startsWith("/Volumes/Scratch/"))
  throw Error("COVERAGE_DIR must be on /Volumes/Scratch");
if (!temporary.startsWith("/Volumes/Scratch/"))
  throw Error("COVERAGE_TMP_DIR must be on /Volumes/Scratch");
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    )
      result.push(path);
  }
  return result;
}
const expected = [
  ...(await sourceFiles(resolve(root, "src"))),
  ...(await sourceFiles(resolve(root, "web"))),
];
const tests = [
  ...(await readdir("tests"))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `tests/${file}`),
  ...(await readdir("web"))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `web/${file}`),
].sort();
const json = join(output, "summary.json"),
  report = join(output, "coverage.txt");
const result = spawnSync(
  process.execPath,
  [
    "--experimental-test-coverage",
    "--test-coverage-include=src/**/*.ts",
    "--test-coverage-include=web/**/*.ts",
    "--test-coverage-exclude=**/*.test.ts",
    "--test-coverage-exclude=**/*.d.ts",
    "--test-coverage-include-all",
    "--test-coverage-lines=100",
    "--test-coverage-branches=100",
    "--test-coverage-functions=100",
    "--test-reporter=spec",
    "--test-reporter=spec",
    "--test-reporter=./scripts/coverage-reporter.mjs",
    "--test-reporter-destination=stdout",
    `--test-reporter-destination=${report}`,
    `--test-reporter-destination=${json}`,
    "--test",
    "--test-concurrency=1",
    ...tests,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: temporary, NODE_ENV: "test" },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const summary = JSON.parse(await readFile(json, "utf8")) as CoverageSummary;
const failures = coverageFailures(summary, expected);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Coverage gate passed: ${expected.length} application modules each meet 100% lines, branches and functions. Report: ${report}`,
);
