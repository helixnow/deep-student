/** WP-081 measurement-only preload. Every wrapper calls the original method once.
 * Inherited by real workers; no migration, PRAGMA, timeout or result is replaced.
 * Run via migration-profile.mjs. hrtime is CLOCK_MONOTONIC across these threads.
 */
import { registerHooks, syncBuiltinESMExports, createRequire } from 'node:module';
import { isMainThread, threadId } from 'node:worker_threads';
import fs from 'node:fs';

const now = () => Number(process.hrtime.bigint()) / 1e6;
const boot = now();
const key = Symbol.for('WP081.migration.profile');
const emit = value => process.stdout.write(`WP081 ${JSON.stringify({ threadId, ...value })}\n`);
let current;
const migrationNames = new Map();
const loads = { count: 0, ms: 0 };
function record(name, started, detail) {
  if (!current) return;
  const elapsed = now() - started;
  const metric = current.metrics[name] ??= { count: 0, ms: 0 };
  metric.count++;
  metric.ms += elapsed;
  if (name.startsWith('sqlite.') && detail) {
    const sql = current.sql ??= [];
    sql.push({ name, ms: elapsed, detail });
    sql.sort((a, b) => b.ms - a.ms);
    if (sql.length > 20) sql.pop();
    return;
  }
  if (detail) current.spans.push({ name, start: started, ms: elapsed, detail });
}
function wrap(proto, name, label = () => name, span = false) {
  const original = proto[name];
  proto[name] = function (...args) {
    const started = now();
    const metric = label.call(this, ...args);
    try { return Reflect.apply(original, this, args); }
    finally {
      const detail = span ? String(args[0])
        : name === 'exec' ? migrationNames.get(args[0]) : undefined;
      record(metric, started, detail);
    }
  };
}
globalThis[key] = {
  sync(original, name) {
    return function (...args) {
      const start = now();
      try { return Reflect.apply(original, this, args); }
      finally { record(name, start); }
    };
  },
  runner(proto) {
    const original = proto.run;
    proto.run = function (...args) {
      for (const migration of this.getMigrations()) migrationNames.set(migration.sql, migration.toString());
      const start = now();
      try { return Reflect.apply(original, this, args); }
      finally { record('refinery.run', start); }
    };
  },
  coordinator(proto) {
    const original = proto.runAll;
    proto.runAll = async function (...args) {
      const start = now();
      try { return await Reflect.apply(original, this, args); }
      finally { record('coordinator.runAll', start, this.appDataDir); }
    };
    for (const name of ['migrateDatabase', 'runRefineryMigrations', 'verifyMigrations', 'createRunner',
      'makeAlterColumnsSafe', 'repairRefineryChecksums']) wrap(proto, name, () => name, true);
  },
  connection(proto) {
    for (const name of ['exec', 'run', 'get', 'all', 'pluck', 'close']) {
      wrap(proto, name, function (sql) {
        const kind = this.path === ':memory:' ? 'memory' : 'disk';
        const statement = typeof sql === 'string' ? sql : sql?.sql ?? '';
        const operation = name === 'exec' && /^(COMMIT|BEGIN|ROLLBACK)\b/.test(statement)
          ? statement.split(' ')[0] : name;
        return `sqlite.${kind}.${operation}`;
      });
    }
  },
  tasks(tasks) {
    const original = tasks.migration_run_all;
    tasks.migration_run_all = async function (context) {
      const start = now();
      const cpu = process.threadCpuUsage();
      current = { kind: 'task', dir: context.payload.options.appDataDir, start,
        preloadStart: boot, load: { ...loads }, metrics: {}, spans: [] };
      try { return await Reflect.apply(original, this, [context]); }
      finally {
        current.ms = now() - start;
        current.cpu = process.threadCpuUsage(cpu);
        emit(current);
        current = undefined;
      }
    };
  },
};

// Measure actual synchronous Node filesystem calls, including SQL loading. Native
// SQLite fsync/pread/pwrite are measured separately by migration-profile-io.c.
for (const name of ['readFileSync', 'readdirSync', 'mkdirSync', 'statSync', 'statfsSync', 'existsSync', 'writeFileSync']) {
  const original = fs[name];
  fs[name] = function (...args) {
    const start = now();
    try { return Reflect.apply(original, this, args); }
    finally { record(`fs.${name}`, start); }
  };
}
if (isMainThread) {
  const threads = createRequire(import.meta.url)('node:worker_threads');
  const OriginalWorker = threads.Worker;
  threads.Worker = class extends OriginalWorker {
    constructor(...args) {
      const start = now();
      super(...args);
      this.once('online', () => emit({ kind: 'workerOnline', workerThreadId: this.threadId, start, ms: now() - start }));
    }
  };
}
syncBuiltinESMExports();

registerHooks({
  load(url, context, nextLoad) {
    const start = now();
    const result = nextLoad(url, context);
    loads.count++;
    loads.ms += now() - start;
    const targets = [
      ['/storage/migration/coordinator.ts', 'coordinator(MigrationCoordinator.prototype)'],
      ['/storage/connection.ts', 'connection(Connection.prototype)'],
      ['/storage/migration/refinery.ts', 'runner(Runner.prototype)'],
      ['/storage/migration/worker-tasks.ts', 'tasks(multiDatabaseWorkerTasks)'],
    ];
    if (url.endsWith('/storage/migration/fingerprint.ts')) {
      const names = ['buildMigrationScratch', 'computeSchemaFingerprintScope', 'computeSchemaFingerprint', 'verifySchemaFingerprint'];
      const additions = names.map(name => `${name} = globalThis[Symbol.for('WP081.migration.profile')].sync(${name}, '${name}');`).join('\n');
      return { ...result, source: `${result.source}\n${additions}\n` };
    }
    const target = targets.find(([suffix]) => url.endsWith(suffix));
    if (!target) return result;
    return { ...result, source: `${result.source}\n;globalThis[Symbol.for('WP081.migration.profile')].${target[1]};\n` };
  },
});
