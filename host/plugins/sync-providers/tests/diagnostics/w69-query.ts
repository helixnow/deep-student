/** Read-only query-cost diagnostic for the L20 owner; not a migrated test/implementation. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createStorageService } from '../../../../platform/storage/service.ts';

const root = await mkdtemp('/tmp/opencode/l23-w69-query-');
const storage = createStorageService({ baseDir: root, dataLocalDir: root });
const db = storage.openFile(':memory:', { profile: 'plain', label: 'W69-query-diagnostic' });
const queries = [
  ['current', `SELECT changed_at FROM __change_log
    WHERE table_name=?1 AND record_id=?2 AND upper(operation)='DELETE'
    ORDER BY id DESC LIMIT 1`],
  ['record-first', `SELECT changed_at FROM __change_log
    WHERE record_id=?2 AND table_name=?1 AND upper(operation)='DELETE'
    ORDER BY id DESC LIMIT 1`],
  ['operation-first', `SELECT changed_at FROM __change_log
    WHERE upper(operation)='DELETE' AND record_id=?2 AND table_name=?1
    ORDER BY id DESC LIMIT 1`],
] as const;

try {
  db.exec(`CREATE TABLE __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL,
    record_id TEXT NOT NULL, operation TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
  )`);
  db.transaction(tx => {
    for (let index = 0; index < 10_000; index++) {
      tx.run('INSERT INTO __change_log(table_name, record_id, operation) VALUES (?1,?2,?3)',
        ['test_items', `t${String(index).padStart(5, '0')}`, 'INSERT']);
    }
  });
  for (const [label, sql] of queries) {
    const started = performance.now();
    for (let index = 0; index < 2000; index++) {
      const result = db.get(sql, ['test_items', `t${10000 + index}`]);
      if (result !== undefined) throw new Error(`${label}: unexpected DELETE result`);
    }
    process.stdout.write(JSON.stringify({ label, rows: 10_000, queries: 2000,
      elapsedMs: performance.now() - started, plan: db.all(`EXPLAIN QUERY PLAN ${sql}`, ['test_items', 't10000']) }) + '\n');
  }

  // Check the ordered result with mixed case, other tables/records and multiple DELETEs.
  for (const [table, record, operation, stamp] of [
    ['test_items', 'target', 'DELETE', 'first'],
    ['test_items', 'target', 'delete', 'second'],
    ['test_items', 'target', 'DeLeTe', 'latest'],
    ['other', 'target', 'DELETE', 'wrong-table'],
    ['test_items', 'other', 'DELETE', 'wrong-record'],
    ['test_items', 'target', 'UPDATE', 'wrong-operation'],
  ]) {
    db.run('INSERT INTO __change_log(table_name, record_id, operation, changed_at) VALUES (?1,?2,?3,?4)',
      [table!, record!, operation!, stamp!]);
  }
  for (const [label, sql] of queries) {
    const row = db.get<{ changed_at: string }>(sql, ['test_items', 'target']);
    if (row?.changed_at !== 'latest') throw new Error(`${label}: changed ordered DELETE result`);
  }
  process.stdout.write('ordered-result-check: passed\n');
} finally {
  storage.close(db);
  storage.dispose();
  await rm(root, { recursive: true, force: true });
}
