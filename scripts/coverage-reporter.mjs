// Node emits this summary after combining its test-worker coverage.
export default async function* coverageReporter(events) {
  for await (const event of events) {
    if (event.type === "test:coverage")
      yield JSON.stringify(event.data.summary, null, 2) + "\n";
  }
}
