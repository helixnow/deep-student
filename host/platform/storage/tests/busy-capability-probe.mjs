// Runtime inventory for WP-008. Run through jobs under Node and Electron.
import BetterSqlite3 from 'better-sqlite3';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = new BetterSqlite3(':memory:');
try {
  // boundary-allow console-log: standalone diagnostic CLI output, not a Host logger; never imported by production code.
  console.log(JSON.stringify({
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null, napi: process.versions.napi },
    packageVersion: require('better-sqlite3/package.json').version,
    packagePath: require.resolve('better-sqlite3'),
    sqliteVersion: db.prepare('SELECT sqlite_version()').pluck().get(),
    methods: Object.getOwnPropertyNames(Object.getPrototypeOf(db)).sort(),
    busyHandler: typeof db.busyHandler,
    setBusyHandler: typeof db.setBusyHandler,
    interrupt: typeof db.interrupt,
    busyTimeoutMs: db.pragma('busy_timeout', { simple: true }),
  }, null, 2));
} finally {
  db.close();
}
