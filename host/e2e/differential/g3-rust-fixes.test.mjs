// Rust-fix registrations (WAVE2-BRIEF §7, host/e2e/differential/rust-fixes/RF-*.json): an
// approved entry's selectors exempt exactly the G3 differences they cover (category rust-fix,
// not an inconsistency); a proposed entry's hits stay differences and are listed as pending.
// A selector exempts a difference only when every differing place of it is inside the selector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCompare } from '../../../scripts/electron-migration/record/g3-classify.mjs';
import { RUST_FIXES_DIR, differingPaths, entryCovers, entryProblem, loadRustFixes, rustFixHits, selectorCovers, selectorProblem } from '../../../scripts/electron-migration/record/g3-rust-fixes.mjs';

const entry = (id, status, selectors, kind = 'rust-bug') => ({ id, kind, status, title: id, ...(status === 'approved' ? { approvedBy: 'main', approvedAt: '2026-11-07T08:30:00+08:00' } : {}),
  rust: { file: 'src-tauri/src/x.rs', line: 1, behavior: 'wrong' }, fix: { files: ['host/plugins/x/x.ts'], behavior: 'right' }, evidence: 'e',
  g3: { affects: true, selectors }, tests: [{ file: 'host/plugins/x/x.test.ts', name: `${id}: guarded` }] });
const value = (table, column, before, after) => ({ kind: 'value', db: 'app-data/slots/slotA/databases/chat_v2.db', table, key: null, column,
  before: { storageClass: 'text', value: before }, after: { storageClass: 'text', value: after } });
const database = (samples, count = samples.length) => ({ step: 0, command: 'chat_send', kind: 'database', where: 'after step 0', count, sample: samples });
const outcome = (command, expected, actual) => {
  const paths = differingPaths(expected, actual);
  return { step: 0, command, kind: 'outcome', difference: { path: paths.paths[0], expected, actual }, ...paths };
};
const events = (names, expected, actual) => {
  const paths = differingPaths(expected, actual);
  return { step: 0, command: 'chat_send', kind: 'events', where: 'after step 0', difference: { path: paths.paths[0] }, ...paths, eventNames: names };
};
const artifact = (id, differences) => ({ scenario: { id }, differences, normalizationSkipped: [] });
const META = { scenario: 'chat.stream.*', surface: 'db', table: 'chat_v2_messages', column: 'meta_json', jsonPath: '$.loaded_skill_ids' };

test('rust-fix: differing paths are listed completely, with a completeness flag', () => {
  assert.deepEqual(differingPaths({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] }, d: true }), { paths: ['/b/c/1', '/d'], pathsComplete: true });
  assert.deepEqual(differingPaths([1], [1]), { paths: [], pathsComplete: true });
  assert.deepEqual(differingPaths('x', 'y'), { paths: [''], pathsComplete: true });
  const wide = differingPaths(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])), {});
  assert.equal(wide.pathsComplete, false);
  assert.equal(wide.paths.length, 64);
});

test('rust-fix: selector coverage per surface — hits, misses, and a column selector never covers another column of the same table', () => {
  const skills = (ids, extra = {}) => JSON.stringify({ loaded_skill_ids: ids, model: 'm', ...extra });
  const hit = database([value('chat_v2_messages', 'meta_json', skills(['a']), skills(['a', 'b']))]);
  assert.equal(selectorCovers(META, hit, 'chat.stream.basic'), true);
  assert.equal(selectorCovers(META, hit, 'notes.basic'), false, 'scenario glob');
  // Negative: same table, other column — counted.
  assert.equal(selectorCovers(META, database([value('chat_v2_messages', 'content', 'x', 'y')]), 'chat.stream.basic'), false);
  assert.equal(selectorCovers({ ...META, jsonPath: undefined }, database([value('chat_v2_messages', 'content', 'x', 'y')]), 'chat.stream.basic'), false);
  // Mixed sample: one covered cell, one other column — the whole difference stays counted.
  assert.equal(selectorCovers(META, database([value('chat_v2_messages', 'meta_json', skills(['a']), skills(['b'])), value('chat_v2_messages', 'role', 'u', 'a')]), 'chat.stream.basic'), false);
  // Inside the column but outside the jsonPath — counted.
  assert.equal(selectorCovers(META, database([value('chat_v2_messages', 'meta_json', skills(['a']), skills(['a'], { model: 'n' }))]), 'chat.stream.basic'), false);
  assert.equal(selectorCovers(META, database([value('chat_v2_messages', 'meta_json', skills(['a']), skills(['b'], { model: 'n' }))]), 'chat.stream.basic'), false);
  // Truncated sample: unseen differences may be elsewhere — counted.
  assert.equal(selectorCovers(META, database([value('chat_v2_messages', 'meta_json', skills(['a']), skills(['b']))], 40), 'chat.stream.basic'), false);
  // A whole-row difference is not a column difference.
  assert.equal(selectorCovers({ ...META, jsonPath: undefined }, database([{ kind: 'row', db: 'x.db', table: 'chat_v2_messages', key: null, column: null, before: null, after: {} }]), 'chat.stream.basic'), false);
  assert.equal(selectorCovers({ ...META, jsonPath: undefined }, { ...hit, kind: 'final-database', where: undefined }, 'chat.stream.basic'), true);

  const ipc = { scenario: '*', surface: 'ipc', command: 'skills_list', jsonPath: '$.items[0].path' };
  assert.equal(selectorCovers(ipc, outcome('skills_list', { items: [{ path: '/a', n: 1 }] }, { items: [{ path: '/b', n: 1 }] }), 's'), true);
  assert.equal(selectorCovers(ipc, outcome('skills_list', { items: [{ path: '/a', n: 1 }] }, { items: [{ path: '/b', n: 2 }] }), 's'), false, 'second path outside');
  assert.equal(selectorCovers(ipc, outcome('skills_get', { items: [{ path: '/a' }] }, { items: [{ path: '/b' }] }), 's'), false, 'other command');
  assert.equal(selectorCovers({ scenario: 's', surface: 'ipc', command: 'skills_list' }, { step: 0, command: 'skills_list', kind: 'outcome-kind', a: 'error', b: 'result' }, 's'), true);
  assert.equal(selectorCovers(ipc, { ...outcome('skills_list', { a: 1 }, { a: 2 }), pathsComplete: false, paths: ['/items/0/path'] }, 's'), false, 'incomplete path list');
  assert.equal(selectorCovers({ scenario: 's', surface: 'ipc', command: 'skills_list' }, { step: 0, command: 'skills_list', kind: 'args', difference: { path: '/x' } }, 's'), false, 'arguments are input, not behavior');

  // Event jsonPath is relative to the recorded event {event, payload}.
  const event = { scenario: 'chat.*', surface: 'event', event: 'chat_v2_event_*', jsonPath: '$.payload.usage' };
  const names = [{ index: 1, A: 'chat_v2_event_s1', B: 'chat_v2_event_s1' }];
  assert.equal(selectorCovers(event, events(names, [{}, { payload: { usage: 1, text: 'x' } }], [{}, { payload: { usage: 2, text: 'x' } }]), 'chat.a'), true);
  assert.equal(selectorCovers(event, events(names, [{}, { payload: { usage: 1, text: 'x' } }], [{}, { payload: { usage: 2, text: 'y' } }]), 'chat.a'), false);
  assert.equal(selectorCovers(event, events([{ index: 1, A: 'other', B: 'other' }], [{}, { payload: { usage: 1 } }], [{}, { payload: { usage: 2 } }]), 'chat.a'), false, 'other event');
  assert.equal(selectorCovers(event, { step: 0, command: 'c', kind: 'events', difference: { path: '/1/payload/usage' } }, 'chat.a'), false, 'no path list: old artifact');

  const fs = { scenario: '*', surface: 'fs', path: 'app-data/slots/*/databases/skills.db' };
  const created = { kind: 'database', db: 'app-data/slots/slotA/databases/skills.db', table: null, key: null, column: null, before: null, after: {} };
  assert.equal(selectorCovers(fs, database([created]), 's'), true);
  assert.equal(selectorCovers(fs, database([{ ...created, db: 'app-data/slots/slotA/databases/vfs.db' }]), 's'), false);
});

test('rust-fix: the selectors of one entry cover a difference together; selectors of different entries never combine; globs on table/column/command', () => {
  const unit = (column, before, after) => ({ ...value('vfs_index_units', column, before, after), db: 'app-data/slots/slotA/databases/vfs.db' });
  const columns = ['text_content', 'content_hash', 'text_state'];
  const row = database(columns.map(column => unit(column, 'a', 'b')));
  const perColumn = columns.map(column => ({ scenario: 'qbank.*', surface: 'db', table: 'vfs_index_units', column }));
  assert.equal(selectorCovers(perColumn[0], row, 'qbank.x'), false, 'one column alone does not cover the row');
  assert.deepEqual(rustFixHits({ entries: [entry('RF-W04-units', 'approved', perColumn)] }, row, 'qbank.x').approved?.id, 'RF-W04-units');
  assert.equal(rustFixHits({ entries: [entry('RF-W04-a', 'approved', perColumn.slice(0, 2)), entry('RF-W04-b', 'approved', perColumn.slice(2))] }, row, 'qbank.x').approved,
    null, 'two entries never add up to one exemption');
  assert.equal(rustFixHits({ entries: [entry('RF-W04-units', 'approved', perColumn.slice(0, 2))] }, row, 'qbank.x').approved, null, 'third column uncovered');
  assert.equal(selectorCovers({ scenario: 'qbank.*', surface: 'db', table: 'vfs_index_*', column: 'text_*' }, database([unit('text_content', 'a', 'b'), unit('text_state', 'a', 'b')]), 'qbank.x'), true);
  assert.equal(selectorCovers({ scenario: 'qbank.*', surface: 'db', table: 'vfs_index_*', column: 'text_*' }, row, 'qbank.x'), false, 'content_hash outside the glob');
  // Two jsonPath selectors on one column mask together.
  const meta = (a, b) => JSON.stringify({ a, b, c: 1 });
  const both = database([value('chat_v2_messages', 'meta_json', meta(1, 1), meta(2, 2))]);
  const on = jsonPath => ({ scenario: 'chat.*', surface: 'db', table: 'chat_v2_messages', column: 'meta_json', jsonPath });
  assert.equal(selectorCovers(on('$.a'), both, 'chat.x'), false);
  assert.equal(entryCovers([on('$.a'), on('$.b')], both, 'chat.x'), true);
  // ipc: command glob; paths split across two selectors of one entry.
  const result = outcome('skills_list', { items: [{ path: '/a', n: 1 }] }, { items: [{ path: '/b', n: 2 }] });
  const ipc = jsonPath => ({ scenario: 's', surface: 'ipc', command: 'skills_*', jsonPath });
  assert.equal(entryCovers([ipc('$.items[0].path'), ipc('$.items[0].n')], result, 's'), true);
  assert.equal(entryCovers([ipc('$.items[0].path'), { ...ipc('$.items[0].n'), scenario: 'other' }], result, 's'), false, 'scenario applies per selector');
});

test('rust-fix: approved hits are exempt (category rust-fix, with id and kind); proposed hits stay counted and are listed as pending', () => {
  const skills = ids => JSON.stringify({ loaded_skill_ids: ids });
  const covered = database([value('chat_v2_messages', 'meta_json', skills(['a']), skills(['a', 'b']))]);
  const other = database([value('chat_v2_messages', 'content', 'x', 'y')]);
  const approved = { entries: [entry('RF-W02-loaded-skill-ids-truncation', 'approved', [META])] };
  const proposed = { entries: [entry('RF-W02-loaded-skill-ids-truncation', 'proposed', [META])] };
  const deliberate = { entries: [entry('RF-W05-structured-conflict', 'approved', [META], 'deliberate')] };

  let result = classifyCompare(artifact('chat.stream.basic', [covered]), [], null, approved);
  assert.deepEqual(result.differences[0], { category: 'rust-fix', known: 'RF-W02-loaded-skill-ids-truncation', rustFix: { id: 'RF-W02-loaded-skill-ids-truncation', kind: 'rust-bug' } });
  assert.equal(result.summary, 'rust-fix');
  assert.equal(result.counted, 0, 'not an inconsistency');
  assert.deepEqual(result.rustFixes, { exempt: [{ id: 'RF-W02-loaded-skill-ids-truncation', kind: 'rust-bug', differences: 1 }], pending: [] });

  result = classifyCompare(artifact('chat.stream.basic', [covered, other]), [], null, approved);
  assert.deepEqual(result.differences.map(item => item.category), ['rust-fix', 'product']);
  assert.equal(result.summary, 'product');
  assert.equal(result.counted, 1, 'the other column is still counted');

  result = classifyCompare(artifact('chat.stream.basic', [covered]), [], null, proposed);
  assert.deepEqual(result.differences[0], { category: 'product', known: null, pending: [{ id: 'RF-W02-loaded-skill-ids-truncation', kind: 'rust-bug' }] });
  assert.equal(result.counted, 1);
  assert.deepEqual(result.rustFixes, { exempt: [], pending: [{ id: 'RF-W02-loaded-skill-ids-truncation', kind: 'rust-bug', differences: 1 }] });

  result = classifyCompare(artifact('chat.stream.basic', [covered]), [], null, deliberate);
  assert.deepEqual(result.differences[0].rustFix, { id: 'RF-W05-structured-conflict', kind: 'deliberate' }, 'deliberate follows the same rule');
  assert.equal(result.counted, 0);

  result = classifyCompare(artifact('notes.basic', [covered]), [], null, approved);
  assert.equal(result.differences[0].category, 'product', 'no hit: original rules');
  assert.equal(classifyCompare(artifact('chat.stream.basic', [covered])).differences[0].category, 'product', 'no registrations: original rules');
});

test('rust-fix: loader reads RF-*.json, applies only well-formed entries and names the rest', t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/w13-rf-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, RUST_FIXES_DIR);
  mkdirSync(dir, { recursive: true });
  const put = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  put('RF-W02-good.json', entry('RF-W02-good', 'approved', [META]));
  put('RF-W02-pending.json', entry('RF-W02-pending', 'proposed', [{ scenario: 'qbank.*', surface: 'ipc', command: 'qbank_list' }]));
  put('RF-W03-no-effect.json', { ...entry('RF-W03-no-effect', 'approved', []), g3: { affects: false, selectors: [] } });
  put('RF-W02-table-only.json', entry('RF-W02-table-only', 'approved', [{ scenario: 'chat.x', surface: 'db', table: 'chat_v2_messages' }]));
  // Width rules follow the gate schema: scenario * needs precision only on db (jsonPath or a non-wildcard column).
  put('RF-W02-wild-ipc.json', entry('RF-W02-wild-ipc', 'approved', [{ scenario: '*', surface: 'ipc', command: 'skills_list' }]));
  put('RF-W02-wild-db.json', entry('RF-W02-wild-db', 'approved', [{ scenario: '*', surface: 'db', table: 'chat_v2_messages', column: 'meta_*' }]));
  put('RF-W02-star-command.json', entry('RF-W02-star-command', 'approved', [{ scenario: 's', surface: 'ipc', command: '**' }]));
  put('RF-W02-mixed-fields.json', entry('RF-W02-mixed-fields', 'approved', [{ scenario: 's', surface: 'ipc', command: 'x', table: 't' }]));
  put('RF-W02-bad-path.json', entry('RF-W02-bad-path', 'approved', [{ scenario: 's', surface: 'ipc', command: 'x', jsonPath: '$..items[*]' }]));
  put('RF-W02-unsigned.json', { ...entry('RF-W02-unsigned', 'approved', [META]), approvedBy: undefined });
  put('RF-W02-wrong-name.json', entry('RF-W02-other', 'approved', [META]));
  put('RF-W02-kind.json', { ...entry('RF-W02-kind', 'approved', [META]), kind: 'preference' });
  put('RF-W02-broken.json', '{');
  put('README.md', 'not a registration');
  const loaded = loadRustFixes(root);
  assert.deepEqual(loaded.entries.map(item => [item.id, item.status]).sort(),
    [['RF-W02-good', 'approved'], ['RF-W02-pending', 'proposed'], ['RF-W02-wild-ipc', 'approved'], ['RF-W03-no-effect', 'approved']]);
  assert.deepEqual(loaded.problems.map(item => item.file.split('/').at(-1)).sort(),
    ['RF-W02-bad-path.json', 'RF-W02-broken.json', 'RF-W02-kind.json', 'RF-W02-mixed-fields.json', 'RF-W02-star-command.json',
      'RF-W02-table-only.json', 'RF-W02-unsigned.json', 'RF-W02-wild-db.json', 'RF-W02-wrong-name.json']);
  for (const problem of loaded.problems) assert.ok(problem.message.length > 0);
  assert.equal(loaded.source.dir, RUST_FIXES_DIR);
  assert.equal(loaded.source.files.length, 14 - 1, 'every RF-*.json is hashed, applied or not');
  assert.match(loaded.source.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(loadRustFixes(join(root, 'absent')).entries, []);
});

test('rust-fix: the report exempts approved hits (command passes, listed by kind with id), lists proposed hits as pending (still fail), and ignores misses', { timeout: 180_000 }, async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/w13-rf-report-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { makeSplitRepo } = await import('./__fixtures__/g3-batch-repo.mjs');
  const { spawnSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  // `.rf`: the fake B answers with an extra `fixed` field; A and A2 do not.
  const repo = await makeSplitRepo(root, { 'host/plugins/chat/equivalence/chat.json': ['chat.stream.rf'] });
  const out = join(root, 'out');
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env: repo.env, encoding: 'utf8' });
  const recorded = run('scripts/electron-migration/record/g3-batch.mjs', [repo.receipt, '--out', out, '--shard-size', '1', '--kill-grace-s', '1']);
  // An unequal compare is a result, not a compare error (g3-compare exits 1 for it).
  const stats = JSON.parse(readFileSync(join(out, 'batch-result.json'), 'utf8'));
  assert.deepEqual([stats.compared, stats.equal, stats.unequal, stats.compareErrors], [1, 0, 1, 0]);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const report = () => {
    rmSync(join(out, 'RUN-MANIFEST.json'), { force: true });
    for (const args of [['--write-manifest'], ['--out', join(out, 'report')]]) {
      const done = run('scripts/electron-migration/record/g3-report.mjs', ['--runs', out, ...args]);
      assert.equal(done.status, 0, done.stdout + done.stderr);
    }
    return { json: JSON.parse(readFileSync(join(out, 'report', 'g3-report.json'), 'utf8')), md: readFileSync(join(out, 'report', 'g3-report.md'), 'utf8') };
  };
  const row = built => built.json.commands.find(item => item.command === 'get_app_version');
  assert.equal(row(report()).status, 'fail', 'B differs without a registration');

  const dir = join(root, RUST_FIXES_DIR);
  mkdirSync(dir, { recursive: true });
  const selector = { scenario: 'chat.stream.*', surface: 'ipc', command: 'get_app_version', jsonPath: '$.fixed' };
  const write = (status, kind = 'rust-bug', chosen = selector) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'RF-W13-fixed-field.json'), JSON.stringify(entry('RF-W13-fixed-field', status, [chosen], kind)));
  };

  write('approved');
  let built = report();
  assert.equal(row(built).status, 'pass');
  assert.deepEqual(built.json.rustFixes.exempt, [{ id: 'RF-W13-fixed-field', kind: 'rust-bug', differences: 1, scenarios: 1, commands: ['get_app_version'] }]);
  assert.deepEqual(built.json.rustFixes.pending, []);
  assert.equal(built.json.rustFixes.source.files.length, 1);
  assert.match(built.md, /## Rust 修复登记（rust-fixes\/）/);
  assert.match(built.md, /rust-bug.*RF-W13-fixed-field/);

  write('approved', 'deliberate');
  built = report();
  assert.equal(row(built).status, 'pass');
  assert.equal(built.json.rustFixes.exempt[0].kind, 'deliberate');
  assert.match(built.md, /deliberate.*RF-W13-fixed-field/);

  write('proposed');
  built = report();
  assert.equal(row(built).status, 'fail', 'pending review: still a difference');
  assert.deepEqual(built.json.rustFixes.pending, [{ id: 'RF-W13-fixed-field', kind: 'rust-bug', differences: 1, scenarios: 1, commands: ['get_app_version'] }]);
  assert.match(built.md, /待审/);

  write('approved', 'rust-bug', { ...selector, jsonPath: '$.other' });
  built = report();
  assert.equal(row(built).status, 'fail', 'selector misses');
  assert.deepEqual([built.json.rustFixes.exempt, built.json.rustFixes.pending], [[], []]);
});

test('rust-fix: exported selectorProblem / entryProblem (the report\'s validity rules, reusable by the gate) — a scenario * ipc selector without jsonPath is valid; only scenario * db needs a narrowing', () => {
  assert.equal(selectorProblem({ scenario: '*', surface: 'ipc', command: 'test_web_search_connectivity' }), null);
  assert.equal(selectorProblem({ scenario: '*', surface: 'db', table: 't', column: '*' }), 'scenario * db selector needs a jsonPath or a column without wildcard (too broad)');
  assert.equal(selectorProblem({ scenario: '*', surface: 'db', table: 't', column: 'c' }), null);
  assert.match(selectorProblem({ scenario: 's', surface: 'ipc', command: '*' }), /must not be only a wildcard/);
  assert.match(selectorProblem({ scenario: 's', surface: 'ipc', command: 'c', jsonPath: 'not a path' }), /not a field path G3 can evaluate/);
  const fix = entry('RF-W05-web-search-connectivity-unregistered', 'approved', [{ scenario: '*', surface: 'ipc', command: 'test_web_search_connectivity' }]);
  assert.equal(entryProblem(fix, `${fix.id}.json`), null);
  assert.match(entryProblem(fix, 'other.json'), /does not match the file name/);
});
