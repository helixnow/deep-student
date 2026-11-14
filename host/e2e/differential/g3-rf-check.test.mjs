// rust-fixes selector check: every registration's G3 selectors against the corpus, A's event channels
// and A's schema — a selector that can never exempt a difference, or one wider than a field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aSchema, BROAD, checkRustFixSelectors, eventReachable, formatReport, PROBLEMS, selectorFindings } from '../../../scripts/electron-migration/record/g3-rf-check.mjs';
import { RUST_FIXES_DIR } from '../../../scripts/electron-migration/record/g3-rust-fixes.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CONTEXT = {
  scenarios: [
    { file: 'a.json', id: 'notes.create.ok', commands: ['note_create', 'note_get'], events: true, db: true },
    { file: 'a.json', id: 'notes.create.no_capture', commands: ['note_create'], events: false, db: false },
    { file: 'b.json', id: 'storage.llm_usage.summary', commands: ['llm_usage_session_summary'], events: false, db: true },
  ],
  events: { names: ['note:created', 'chat_v2://settings_changed'], patterns: ['chat_v2_event_{}', 'session_{}_stream'] },
  schema: new Map([['notes', new Set(['id', 'title', 'meta_json'])], ['llm_usage_logs', new Set(['id', 'caller_id'])]]),
};
const kinds = selector => selectorFindings(selector, CONTEXT).findings.map(finding => finding.kind);

test('selector findings: what can never cover a difference is a problem; field-wide selectors are not', () => {
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'ipc', command: 'note_create', jsonPath: '$.title' }), []);
  assert.deepEqual(selectorFindings({ scenario: 'notes.*', surface: 'ipc', command: 'note_create', jsonPath: '$.title' }, CONTEXT).reach,
    { scenarios: 2, steps: 2, commands: ['note_create'] });
  assert.deepEqual(kinds({ scenario: 'llm_usage.*', surface: 'ipc', command: 'llm_usage_session_summary', jsonPath: '$.x' }), ['no-scenario'], 'ids are matched whole');
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'ipc', command: 'note_delete', jsonPath: '$.x' }), ['no-command']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'ipc', command: 'note_*' }), ['whole-outcome', 'name-wildcard']);
  assert.deepEqual(kinds({ scenario: '*', surface: 'ipc', command: 'note_get', jsonPath: '$.id' }), ['any-scenario']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'ipc', command: '*' }), ['selector'], 'selectorProblem first, nothing else');

  assert.deepEqual(kinds({ scenario: 'notes.create.ok', surface: 'event', event: 'note:created', jsonPath: '$.payload.id' }), []);
  assert.deepEqual(kinds({ scenario: 'notes.create.ok', surface: 'event', event: 'chat_v2_event_*', jsonPath: '$.payload.error' }), ['name-wildcard']);
  assert.deepEqual(kinds({ scenario: 'notes.create.no_capture', surface: 'event', event: 'note:created', jsonPath: '$.payload.id' }), ['no-capture']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'event', event: 'note:deleted', jsonPath: '$.payload.id' }), ['no-event']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'event', event: 'note:created', jsonPath: '$.error' }), ['event-path']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'event', event: 'note:created' }), ['whole-event']);

  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'db', table: 'notes', column: 'meta_json', jsonPath: '$.a' }), []);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'db', table: 'notes', column: 'subject' }), ['no-column']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'db', table: 'pending', column: 'subject' }), ['no-table']);
  assert.deepEqual(kinds({ scenario: 'notes.create.no_capture', surface: 'db', table: 'notes', column: 'title' }), ['no-capture']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'db', table: 'note*', column: 't*' }), ['name-wildcard', 'name-wildcard']);

  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'fs', path: 'app-data/*/slots/*/databases/vfs.db' }), []);
  assert.deepEqual(kinds({ scenario: '*', surface: 'fs', path: '.master_key' }), ['fs-path', 'fs-name', 'any-scenario']);
  assert.deepEqual(kinds({ scenario: 'notes.*', surface: 'fs', path: 'app-data/*/slots/slotA/.secure' }), ['fs-name']);
});

test('event channels: a selector reaches a listened name or an instance of a dynamic pattern', () => {
  const events = CONTEXT.events;
  assert.equal(eventReachable('note:created', events), true);
  assert.equal(eventReachable('chat_v2://*', events), true);
  assert.equal(eventReachable('chat_v2_event_*', events), true);
  assert.equal(eventReachable('chat_v2_event_sess_*', events), true);
  assert.equal(eventReachable('session_*_stream', events), true);
  assert.equal(eventReachable('session_*_done', events), false);
  assert.equal(eventReachable('chat_v2_events', events), false);
});

test('A schema: CREATE [VIRTUAL] TABLE columns and ALTER TABLE ADD COLUMN, from SQL and Rust source', t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/w13-rf-schema-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'resources/app/migrations/vfs'), { recursive: true });
  mkdirSync(join(root, 'src-tauri/src/db'), { recursive: true });
  writeFileSync(join(root, 'resources/app/migrations/vfs/V1__init.sql'), [
    'CREATE TABLE IF NOT EXISTS "notes" (',
    '  id TEXT PRIMARY KEY, -- the id, (with a comma)',
    '  title TEXT NOT NULL DEFAULT \'(untitled, x)\',',
    '  meta_json TEXT CHECK (json_valid(meta_json)),',
    '  CONSTRAINT notes_title UNIQUE (title),',
    '  PRIMARY KEY (id), FOREIGN KEY (id) REFERENCES other(id)',
    ');',
    'CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tokenize = \'unicode61\');',
    'ALTER TABLE notes ADD COLUMN archived INTEGER;',
  ].join('\n'));
  writeFileSync(join(root, 'src-tauri/src/db/schema.rs'), 'conn.execute("CREATE TABLE IF NOT EXISTS main.audit (id INTEGER, at TEXT)", [])?;\n'
    + 'conn.execute_batch(r#"ALTER TABLE audit ADD at_ms INTEGER"#)?;\nconn.execute(&format!("CREATE TABLE {} (x)", name), [])?;\n');
  const schema = aSchema(root);
  assert.deepEqual(Object.fromEntries([...schema].map(([table, columns]) => [table, [...columns].sort()])), {
    notes: ['archived', 'id', 'meta_json', 'title'], notes_fts: ['body', 'title'], audit: ['at', 'at_ms', 'id'] });
});

test('registrations: entry-level problems are listed once; selector problems per selector; the report names lane and status', async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/w13-rf-entries-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, RUST_FIXES_DIR);
  mkdirSync(dir, { recursive: true });
  const entry = (id, selectors, extra = {}) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, kind: 'rust-bug', status: 'proposed',
    g3: { affects: selectors.length > 0, selectors }, ...extra }));
  entry('RF-W07-dead', [{ scenario: 'llm_usage.*', surface: 'ipc', command: 'llm_usage_session_summary', jsonPath: '$.x' },
    { scenario: '*', surface: 'fs', path: '.master_key' }]);
  entry('RF-W02-fine', [{ scenario: 'notes.*', surface: 'ipc', command: 'note_get', jsonPath: '$.title' }]);
  entry('RF-W03-none', []);
  entry('RF-W04-bad', [{ scenario: 'notes.*', surface: 'ipc', command: 'note_get', jsonPath: 'title' }]);
  entry('RF-W05-unapproved', [], { status: 'approved' });
  writeFileSync(join(dir, 'RF-W06-broken.json'), '{');
  const result = await checkRustFixSelectors(root, CONTEXT);
  assert.equal(result.registrations, 6);
  assert.equal(result.selectors, 4);
  assert.deepEqual(result.problems, { entry: 2, selector: 1, 'no-scenario': 1, 'fs-path': 1 });
  assert.deepEqual(result.broad, { 'any-scenario': 1, 'fs-name': 1 });
  assert.deepEqual(result.problemRegistrations, ['RF-W04-bad', 'RF-W05-unapproved', `${RUST_FIXES_DIR}/RF-W06-broken.json`, 'RF-W07-dead']);
  const bad = result.listed.find(item => item.id === 'RF-W04-bad');
  assert.deepEqual([bad.problems, bad.selectors[0].findings.map(finding => finding.kind)], [[], ['selector']], 'the selector problem is not repeated as an entry problem');
  assert.equal(result.listed.find(item => item.id === 'RF-W05-unapproved').problems[0].detail, 'approved without approvedBy/approvedAt');
  const report = formatReport(result);
  assert.match(report, /^RF-W07-dead \(W07, proposed\)$/m);
  assert.match(report, /^ {4}! no-scenario: scenario "llm_usage\.\*" matches no scenario of the corpus$/m);
  assert.match(report, /^ {4}~ any-scenario: every scenario of the corpus$/m);
  assert.doesNotMatch(report, /RF-W02-fine|RF-W03-none/);
});

test('this tree: every registration and selector is checked with the corpus, frontendEvents and A schema it records against', async () => {
  const files = readdirSync(join(REPO, RUST_FIXES_DIR)).filter(name => /^RF-.*\.json$/.test(name));
  const result = await checkRustFixSelectors(REPO);
  assert.equal(result.registrations, files.length);
  const findings = result.listed.flatMap(item => [...item.problems, ...item.selectors.flatMap(selector => selector.findings)]);
  assert.ok(findings.every(finding => PROBLEMS.includes(finding.kind) || BROAD.includes(finding.kind)), JSON.stringify(findings));
  const schema = aSchema(REPO);
  for (const table of ['chat_v2_blocks', 'chat_v2_sessions', 'vfs_index_units']) assert.ok(schema.has(table), `A creates ${table}`);
  assert.ok(schema.get('vfs_index_units').has('text_content'));
});
