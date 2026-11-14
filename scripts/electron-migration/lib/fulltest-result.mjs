// A green assertion summary cannot hide a crashed runner or incomplete shard.
export function fulltestVerdict(shards, expected, stable) {
  const missing = shards.filter(s => !s.report || !Array.isArray(s.report.testResults)).map(s => s.i);
  const rawFailures = shards.filter(s => s.code !== 0).map(s => ({ shard: s.i, code: s.code }));
  const failed = shards.reduce((n, s) => n + (s.report?.numFailedTests ?? 0) + (s.report?.numFailedTestSuites ?? 0), 0);
  const complete = shards.length === expected && missing.length === 0 && shards.every(s => {
    const r = s.report;
    return Number.isInteger(r.numTotalTests) && r.numTotalTests > 0 &&
      r.numPassedTests + r.numFailedTests + (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0) === r.numTotalTests;
  });
  return { complete, stable, missing, rawFailures, ok: stable && complete && rawFailures.length === 0 && failed === 0 && shards.every(s => s.report.success === true) };
}
