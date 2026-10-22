export interface FileCoverage {
  path: string;
  coveredLinePercent: number;
  coveredBranchPercent: number;
  coveredFunctionPercent: number;
}
export interface CoverageSummary {
  files: FileCoverage[];
  totals: Omit<FileCoverage, "path">;
}
export function coverageFailures(
  summary: CoverageSummary,
  expectedFiles: string[],
  minimum = 100,
): string[] {
  const failures: string[] = [];
  const metrics = [
    "coveredLinePercent",
    "coveredBranchPercent",
    "coveredFunctionPercent",
  ] as const;
  const validate = (name: string, coverage: Omit<FileCoverage, "path">) => {
    for (const metric of metrics) {
      const value = coverage[metric];
      if (!Number.isFinite(value) || value < minimum || value > 100)
        failures.push(
          `${name}: ${metric} ${value} is below ${minimum}% or invalid`,
        );
    }
  };
  if (!expectedFiles.length)
    failures.push("No application source files were found.");
  for (const path of expectedFiles) {
    const matches = summary.files.filter((file) => file.path === path);
    if (matches.length !== 1) {
      failures.push(
        `${path}: expected exactly one coverage entry, found ${matches.length}`,
      );
      continue;
    }
    validate(path, matches[0]!);
  }
  validate("all files", summary.totals);
  return failures;
}
