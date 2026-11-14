/** Direct real F3 C/D runner. --seed DIR builds the active input once in a separate
 * process; DIR runs C(empty) then D(online clone of that same input), cold worker.
 * Optional --import ./migration-profile-hooks.mjs adds phase measurements.
 * All invocations/compilation must go through jobs. This is not the L21 5s oracle.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMigrationWorker } from '../node.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { setStorageLogger } from '../logging.ts';

const now = () => Number(process.hrtime.bigint()) / 1e6;
const seedOnly = process.argv[2] === '--seed';
const seed = path.resolve(process.argv[seedOnly ? 3 : 2]);
const files = ['databases/vfs.db', 'llm_usage.db', 'chat_v2.db', 'mistakes.db'];
if (seedOnly) {
  assert(!fs.existsSync(seed), 'seed must be a new directory');
  fs.mkdirSync(seed, { recursive: true });
  const worker = createMigrationWorker({ baseDir: seed });
  try { assert.equal((await worker.runAll({ appDataDir: seed })).success, true); }
  finally { await worker.close(); }
} else {
  for (const file of files) assert(fs.existsSync(path.join(seed, file)), `missing seed ${file}`);
  const root = fs.mkdtempSync('/tmp/opencode/WP081-cd-');
  const worker = createMigrationWorker({ baseDir: root });
  const logs = [];
  setStorageLogger(target => Object.fromEntries([
    ['target', target], ...['info', 'warn', 'error', 'debug', 'trace'].map(level =>
      [level, message => logs.push({ level, message })]),
  ]));
  const evidence = { kind: 'comparison', root, seed, runtime: process.versions, phases: [], logs };
  const before = now();
  try {
    for (const slot of ['slotC', 'slotD']) {
      const dir = path.join(root, slot);
      fs.mkdirSync(dir);
      if (slot === 'slotD') {
        const start = now();
        // Same source and SQLite online backup API as the production Slot D.
        for (const file of ['chat_v2.db', 'mistakes.db', 'llm_usage.db', 'databases/vfs.db']) {
          const source = new Connection(path.join(seed, file), { label: 'profile-source', profile: PROFILES.plain, mustExist: true });
          try { await source.backupTo(path.join(dir, file)); }
          finally { source.close(); }
        }
        evidence.phases.push({ name: 'clone', start, ms: now() - start });
      }
      const start = now();
      const report = await worker.runAll({ appDataDir: dir, auditDbPath: null });
      evidence.phases.push({ name: slot, start, ms: now() - start, report });
      assert.equal(report.success, true, report.error ?? '');
      assert.deepEqual(report.databases.map(db => db.id), ['vfs', 'llm_usage', 'chat_v2', 'mistakes']);
      assert.deepEqual(report.databases.map(db => db.appliedCount), slot === 'slotC' ? [71, 8, 29, 23] : [0, 0, 0, 0]);
    }
    evidence.ms = now() - before;
    // Deterministic database evidence is collected OUTSIDE the measured C/D span.
    // Timestamps/durations naturally differ; history names/checksums, canonical
    // schema and scope hashes remain comparable.
    evidence.databases = {};
    for (const slot of ['slotC', 'slotD']) for (const file of files) {
      const conn = new Connection(path.join(root, slot, file), { label: 'profile-result', profile: { readonly: true }, mustExist: true });
      try {
        evidence.databases[`${slot}/${file}`] = {
          history: conn.all('SELECT version, name, checksum FROM refinery_schema_history ORDER BY version'),
          schema: conn.all("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"),
          fingerprints: conn.all('SELECT database_id,schema_version,fingerprint,canonical_schema FROM __governance_schema_fingerprints ORDER BY database_id,schema_version'),
          integrity: conn.pragmaValue('integrity_check'),
          journal: conn.pragmaValue('journal_mode'), synchronous: conn.pragmaValue('synchronous'),
        };
        assert.equal(evidence.databases[`${slot}/${file}`].integrity, 'ok');
      } finally { conn.close(); }
    }
    process.stdout.write(`WP081 ${JSON.stringify(evidence)}\n`);
  } finally {
    await worker.close();
    setStorageLogger(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
