import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writesIn } from './single-writer.mjs';
import { sqlTables } from './sql.mjs';
import { run } from './single-writer.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('write SQL: constants, templates, SqlExecutor calls, qualified/quoted names and UPSERT', () => {
  const text = 'db.run(`INSERT OR IGNORE INTO "notes" VALUES (${id}) ON CONFLICT DO UPDATE SET x=1`);\n' +
    'conn.prepare("UPDATE main.notes SET x=?"); conn.exec("DELETE FROM [notes]; REPLACE INTO notes VALUES(1); UPSERT INTO notes VALUES(2)");';
  assert.deepEqual(writesIn('host/plugins/a/repository/a.ts', text).map(x => x.table), Array(5).fill('notes'));
});
test('comments, SQL values, reads, dynamic table names and TypeScript comments are not writes', () => {
  assert.deepEqual(sqlTables("SELECT 'DELETE FROM notes'; -- UPDATE notes SET x=1\n/* INSERT INTO notes */"), []);
  assert.deepEqual(writesIn('a.ts', '// db.run("DELETE FROM notes")\ndb.run(`UPDATE ${table} SET x=1`);'), []);
});
test('schema excludes create indexes and handles virtual tables', () => {
  assert.deepEqual(sqlTables('CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(x); CREATE INDEX idx ON notes(x)', true).map(x => x.table), ['notes']);
});
test('APKG namespace is exact: exported collection notes exempt, same table elsewhere in anki still foreign', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-writer-ns-'));
  try {
    fs.mkdirSync(path.join(root, 'host/plugins/anki/repository'), { recursive: true });
    fs.writeFileSync(path.join(root, 'host/plugins/anki/repository/apkg-export.ts'), 'db.run("INSERT INTO notes (id) VALUES (1)")');
    fs.writeFileSync(path.join(root, 'host/plugins/anki/repository/other.ts'), 'db.run("INSERT INTO notes (id) VALUES (1)")');
    const foreign = run({ root, changed: null }).findings.filter(f => f.rule === 'foreign-table-write');
    assert.deepEqual(foreign.map(f => [f.file, f.owner, f.context]), [['host/plugins/anki/repository/other.ts', 'notes', 'executed']]);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('registry covers all 118 C2-ruled names: no ambiguous left, every ruling has schema, evidence kept', () => {
  const reg = JSON.parse(fs.readFileSync(new URL('./table-owners.json', import.meta.url), 'utf8'));
  const rulings = JSON.parse(fs.readFileSync(new URL('./owner-rulings.json', import.meta.url), 'utf8'));
  const names = [...rulings.rulings.flatMap(r => r.tables), ...rulings.unknownOutsideNamespace, ...rulings.notProduction.tables];
  assert.equal(new Set(names).size, names.length, 'no duplicate ruling');
  assert.equal(names.length - 5, 118, '118 C2 names + 5 V2-OWNER-QBANK');
  assert.deepEqual(reg.ambiguous, []);
  assert.deepEqual(reg.rulingsWithoutSchema, []);
  for (const t of names) assert.ok(reg.tables[t].decision, t);
  assert.equal(reg.tables.__file_deletion_journal.owner, 'notes');
  assert.equal(reg.tables.sessions.owner, null);
  assert.equal(reg.tables.items.owner, null);
});
test('plugin-scoped namespaces: browser owns its short names only inside browser; elsewhere unknown; not-production names unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-writer-pns-'));
  try {
    const files = {
      'host/plugins/browser/repository/a.ts': 'db.run("INSERT INTO sessions (id) VALUES (1)"); db.run("UPDATE settings SET v=1")',
      'host/plugins/chat/repository/a.ts': 'db.run("INSERT INTO sessions (id) VALUES (1)"); db.run("INSERT INTO items (id) VALUES (1)")',
      'host/plugins/agent-workspace/repository/a.ts': 'db.run("INSERT INTO __file_deletion_journal (id) VALUES (1)"); db.run("INSERT INTO message (id) VALUES (1)")',
    };
    for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
    const r = run({ root, changed: null });
    assert.deepEqual(r.findings.filter(f => f.rule === 'foreign-table-write').map(f => [f.plugin, f.table, f.owner, f.severity ?? 'error']),
      [['agent-workspace', '__file_deletion_journal', 'notes', 'error']]);
    assert.deepEqual(r.unknown.map(w => [w.plugin, w.table]).sort(), [['chat', 'items'], ['chat', 'sessions']]);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('registry keeps explicit V2-OWNER-QBANK rulings; questions tables stay vfs-repos', () => {
  const reg = JSON.parse(fs.readFileSync(new URL('./table-owners.json', import.meta.url), 'utf8'));
  for (const t of ['qbank_sources', 'qbank_materials', 'qbank_groups', 'qbank_group_materials', 'qbank_practice_attempts']) {
    assert.equal(reg.tables[t].owner, 'qbank', t);
    assert.match(reg.tables[t].decision, /V2-OWNER-QBANK/);
  }
  for (const t of ['questions', 'question_history']) if (reg.tables[t]) assert.equal(reg.tables[t].owner, 'vfs-repos', t);
});
test('blocking tier: only ruled owner + executed; derived owner and sql-text are report-only; qbank ruling applied', () => {
  const reg = JSON.parse(fs.readFileSync(new URL('./table-owners.json', import.meta.url), 'utf8'));
  const derived = Object.entries(reg.tables).find(([t, e]) => e.owner && e.owner !== 'sync' && !e.decision && /^[a-z_]+$/.test(t))[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-writer-tier-'));
  try {
    const files = {
      'host/plugins/sync/repository/a.ts': `db.run("UPDATE notes SET x=1"); const S = "UPDATE notes SET y=1"; db.run("DELETE FROM ${derived}");`,
      'host/plugins/qbank/repository/a.ts': 'db.run("INSERT INTO qbank_materials (id) VALUES (1)")',
      'host/plugins/vfs/repository/a.ts': 'db.run("INSERT INTO qbank_materials (id) VALUES (1)")',
    };
    for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
    const r = run({ root, changed: null });
    const foreign = r.findings.filter(f => f.rule === 'foreign-table-write').map(f => [f.plugin, f.table, f.context, f.severity ?? 'error']);
    assert.deepEqual(foreign.sort(), [
      ['sync', derived, 'executed', 'info'],
      ['sync', 'notes', 'executed', 'error'],
      ['sync', 'notes', 'sql-text', 'info'],
      ['vfs', 'qbank_materials', 'executed', 'error'],
    ].sort());
    assert.deepEqual(r.tiers, { blocking: 2, reportOnly: 2 });
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('executed vs sql-text context', () => {
  assert.deepEqual(writesIn('a.ts', 'const SQL = "DELETE FROM notes"; db.run("DELETE FROM notes");').map(w => w.context), ['sql-text', 'executed']);
});
test('foreign writes block, WithConn delegation passes, changed scope excludes other writers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-writer-'));
  try {
    for (const [plugin, text] of [['notes', 'db.run("UPDATE notes SET x=1")'], ['sync', 'owner.updateWithConn(conn, value); db.run("UPDATE notes SET x=1")']]) {
      fs.mkdirSync(path.join(root, `host/plugins/${plugin}/repository`), { recursive: true });
      fs.writeFileSync(path.join(root, `host/plugins/${plugin}/repository/a.ts`), text);
    }
    const r = run({ root, changed: ['host/plugins/sync/repository/a.ts'] });
    assert.equal(r.findings.filter(f => f.rule === 'foreign-table-write').length, 1);
    assert.equal(r.findings.find(f => f.rule === 'foreign-table-write').owner, 'notes');
    assert.equal(run({ root, changed: [] }).findings.length, 0);
  } finally { fs.rmSync(root, { recursive: true }); }
});
