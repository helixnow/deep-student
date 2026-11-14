/** Summarize the WP081 lines from a jobs log and optional native I/O TSV.
 * node .../migration-profile-summary.mjs LOG [IO_LOG] [COMPARE_LOG]
 * Nested metrics overlap; never sum runAll + verification + SQLite + I/O.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(file, 'utf8').split('\n')
  .filter(line => line.startsWith('WP081 ')).map(line => JSON.parse(line.slice(6)));
const rows = read(process.argv[2]);
const result = rows.find(row => row.kind === 'comparison');
assert(result, 'missing completed comparison');
const io = process.argv[3] && process.argv[3] !== '-'
  ? fs.readFileSync(process.argv[3], 'utf8').trim().split('\n').map(line => {
    const [pid, tid, op, start, ms, returned, file] = line.split('\t');
    return { pid, tid, op, start: Number(start), ms: Number(ms), returned: Number(returned), file };
  }) : [];
const summarizeIo = (start, end) => {
  const groups = {};
  for (const row of io.filter(row => row.start >= start && row.start < end)) {
    const group = groups[row.op] ??= { count: 0, ms: 0, errors: 0 };
    group.count++; group.ms += row.ms; group.errors += row.returned < 0 ? 1 : 0;
  }
  return groups;
};
if (io.length) assert(io.some(row => ['fsync', 'fdatasync'].includes(row.op)), 'no measured sync calls');
const summary = { runtime: { node: result.runtime.node, electron: result.runtime.electron }, seed: result.seed,
  ms: result.ms, phases: result.phases.map(({ name, ms, report }) => ({ name, ms, report })), tasks: [] };
for (const task of rows.filter(row => row.kind === 'task')) {
  const online = rows.find(row => row.kind === 'workerOnline' && row.workerThreadId === task.threadId);
  const isCold = task === rows.find(row => row.kind === 'task' && row.threadId === task.threadId);
  summary.tasks.push({ dir: task.dir, ms: task.ms, cpu: task.cpu,
    ...(isCold && online ? { coldWorkerToPreloadMs: task.preloadStart - online.start,
      preloadToTaskMs: task.start - task.preloadStart, loader: task.load } : {}),
    constructorAndTaskOverheadMs: task.ms - task.metrics['coordinator.runAll'].ms,
    metrics: task.metrics, topSql: task.sql,
    nativeIo: summarizeIo(task.start, task.start + task.ms),
    databases: task.spans.filter(span => span.name === 'migrateDatabase').map(span => ({
      id: span.detail, ms: span.ms,
      stages: task.spans.filter(child => child !== span && child.start >= span.start && child.start + child.ms <= span.start + span.ms),
      nativeIo: summarizeIo(span.start, span.start + span.ms),
    })),
  });
}
if (process.argv[4]) {
  const previous = read(process.argv[4]).find(row => row.kind === 'comparison');
  assert(previous, 'missing comparison baseline');
  assert.equal(result.seed, previous.seed);
  assert.deepEqual(result.databases, previous.databases, 'schema/history/checksums/fingerprint/PRAGMAs differ');
  const normalizeLogs = record => record.logs.map(({ level, message }) => ({ level,
    message: message.replaceAll(record.root, '<root>')
      .replace(/总耗时: \d+ms/g, '总耗时: <duration>ms')
      // Free space and the timestamp/PID in a newly created snapshot are runtime
      // observations, not fixed seed data. Keep required space, level and order.
      .replace(/^(磁盘空间预检查通过 available_mb=)\d+( required_mb=\d+)$/, '$1<available>$2')
      .replace(/^(\[MigrationCoordinator\] 已完成迁移前核心库备份: <root>\/slotC\/migration_core_backups\/)startup_\d{8}T\d{6}\.\d{3}Z_\d+$/, '$1<snapshot-id>') }));
  assert.deepEqual(normalizeLogs(result), normalizeLogs(previous), 'business log sequence differs');
  const report = record => record.phases.filter(phase => phase.report).map(phase => ({
    ...phase.report, threadId: 0, totalDurationMs: 0,
    databases: phase.report.databases.map(database => ({ ...database, durationMs: 0 })),
  }));
  assert.deepEqual(report(result), report(previous), 'migration report differs');
  summary.equivalentTo = process.argv[4];
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
