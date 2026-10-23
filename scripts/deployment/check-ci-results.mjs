/** Stable branch-protection gate for independently conditional CI jobs. */
export function validateCiResults(results, event) {
  if (!['push', 'pull_request', 'workflow_dispatch'].includes(event)) {
    throw new Error('Unsupported CI event');
  }
  for (const name of ['changes', 'server-checks', 'frontend', 'server-image', 'web-runtime']) {
    const result = results?.[name]?.result;
    const cachedServer = name === 'server-checks' && results?.changes?.outputs?.server === 'false';
    const prImage = event === 'pull_request' && ['server-image', 'web-runtime'].includes(name);
    if (result !== 'success' && !(result === 'skipped' && (cachedServer || prImage))) {
      throw new Error(`Required CI job did not succeed: ${name}`);
    }
  }
}
if (import.meta.main) {
  try {
    validateCiResults(JSON.parse(process.env.CI_RESULTS ?? 'null'), process.env.CI_EVENT_NAME);
    process.stdout.write('All required CI jobs succeeded.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
