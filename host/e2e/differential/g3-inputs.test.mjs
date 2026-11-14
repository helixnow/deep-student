// Scenario inputs that must be identical when A/A2 (A store) and B are recorded at different
// times from different trees (g3-inputs/v2): scenario definition, provider script, seed content,
// the code the A process runs for the scenario (declaration slice), served files, event list,
// A launch, runtime and the pinned environment. Each component is compared separately so a
// mismatch names what changed; edits that only B, compare or report run change nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A_ENTRY, DEFAULT_ENVIRONMENT, INPUTS_SCHEMA, SEED_MODULE, SERVICE_MODULES, aUnit, digestSeedFiles, domainOf, eventsDigest, inputDifference, pinnedEnvironment,
  scenarioDifference, scenarioEntries, scenarioInputs, seedDigests, seedDirectoryDigest, suiteUses, workerEnvironment } from '../../../scripts/electron-migration/record/g3-inputs.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(REPO, 'package.json'));
// boundary-allow native-import: 种子摘要用例只改临时目录里新建的种子副本 vfs.db，核对时钟掩码与内容变化；不写业务或用户数据库。
const Database = require('better-sqlite3');
const ts = require('typescript');
const HEX = /^[0-9a-f]{64}$/;
const RECORD = 'scripts/electron-migration/record';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmp = t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const dir = mkdtempSync('/tmp/opencode/w13-inputs-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const repoRead = path => { try { return readFileSync(join(REPO, path)); } catch { return null; } };
const text = path => repoRead(path).toString('utf8');

test('inputs: every generated seed digests identically across builds; only cells equal to the build clock are masked', async () => {
  const { SEED_NAMES } = await import(join(REPO, SEED_MODULE));
  const first = await seedDigests(REPO, SEED_NAMES);
  await sleep(1_100);
  const second = await seedDigests(REPO, SEED_NAMES);
  assert.deepEqual(second, first);
  for (const name of SEED_NAMES) assert.match(first[name].sha256, HEX, name);
  assert.deepEqual(first.empty.clockCells, {});
  assert.ok(first['historical-wp013-v1'].clockCells['app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db|__change_log.changed_at'] > 0);
  assert.ok(first['l15-review-cas-tombstone-w0'].clockCells['app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db|vfs_indexing_config.updated_at'] > 0);

  // The corpus names seeds the generator does not (yet) build; both sides fail those scenarios
  // the same way, so the fingerprint records the refusal instead of aborting the batch.
  const unknown = await seedDigests(REPO, ['empty', 'w13-no-such-seed']);
  assert.deepEqual(unknown['w13-no-such-seed'], { sha256: null, unavailable: 'Unknown scenario seed: w13-no-such-seed' });
  assert.deepEqual(unknown.empty, first.empty);
});

test('inputs: a seed digest changes with any non-clock cell or file; a clock cell moved inside the build window does not', async t => {
  const { createSeed } = await import(join(REPO, SEED_MODULE));
  const catalog = tmp(t);
  const from = Date.now();
  const seed = createSeed('historical-wp013-v1', catalog);
  const window = { from, to: Date.now() };
  const base = await seedDirectoryDigest(REPO, seed.directory, window);
  const vfs = join(seed.directory, 'app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db');
  const edit = sql => { const db = new Database(vfs); try { db.exec(sql); } finally { db.close(); } };
  const sqliteTime = new Date(window.from).toISOString().replace('T', ' ').slice(0, 19);
  edit(`UPDATE __change_log SET changed_at = '${sqliteTime}' WHERE rowid = (SELECT min(rowid) FROM __change_log)`);
  assert.equal((await seedDirectoryDigest(REPO, seed.directory, window)).sha256, base.sha256, 'clock cell inside the window stays masked');
  edit(`UPDATE __change_log SET changed_at = '2001-01-01 00:00:00' WHERE rowid = (SELECT min(rowid) FROM __change_log)`);
  assert.notEqual((await seedDirectoryDigest(REPO, seed.directory, window)).sha256, base.sha256, 'a time outside the build window is content');
  edit(`UPDATE __change_log SET changed_at = '${sqliteTime}' WHERE rowid = (SELECT min(rowid) FROM __change_log)`);
  edit(`UPDATE __change_log SET table_name = table_name || '_x' WHERE rowid = (SELECT min(rowid) FROM __change_log)`);
  assert.notEqual((await seedDirectoryDigest(REPO, seed.directory, window)).sha256, base.sha256, 'a non-clock cell is content');
  edit(`UPDATE __change_log SET table_name = substr(table_name, 1, length(table_name) - 2) WHERE rowid = (SELECT min(rowid) FROM __change_log)`);
  assert.equal((await seedDirectoryDigest(REPO, seed.directory, window)).sha256, base.sha256);
  writeFileSync(join(seed.directory, 'app-data/extra.txt'), 'x');
  const withFile = await seedDirectoryDigest(REPO, seed.directory, window);
  assert.notEqual(withFile.sha256, base.sha256, 'a non-database file is content');
  rmSync(join(seed.directory, 'app-data/extra.txt'));
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('mkfifo', [join(seed.directory, 'app-data/pipe')]).status, 0);
  const withFifo = await seedDirectoryDigest(REPO, seed.directory, window);
  assert.notEqual(withFifo.sha256, base.sha256, 'a FIFO is named (never read)');
  rmSync(join(seed.directory, 'app-data/pipe'));
  // W21 (9eda3c17) made the X3 snapshot record links in a seed by their text, as backup README §4.5 asks,
  // so the digest names a link without following it.
  symlinkSync('extra.txt', join(seed.directory, 'app-data/near'));
  const withLink = await seedDirectoryDigest(REPO, seed.directory, window);
  assert.notEqual(withLink.sha256, base.sha256, 'a symlink is named (never followed)');
  rmSync(join(seed.directory, 'app-data/near'));
  assert.equal((await seedDirectoryDigest(REPO, seed.directory, window)).sha256, base.sha256);
});

test('inputs: seed files digest links by their text, never followed, so a target outside the seed is not read', t => {
  const root = tmp(t), seed = join(root, 'seed');
  mkdirSync(join(seed, 'd'), { recursive: true });
  writeFileSync(join(root, 'outside.txt'), 'one');
  writeFileSync(join(seed, 'd/inside.txt'), 'in');
  writeFileSync(join(seed, 'd/x.db'), 'snapshotted elsewhere');
  const digest = () => digestSeedFiles(createHash('sha256'), seed, new Set(['d/x.db'])).digest('hex');
  const plain = digest();
  writeFileSync(join(seed, 'd/x.db'), 'changed');
  assert.equal(digest(), plain, 'databases are left to the snapshot');
  symlinkSync(join(root, 'outside.txt'), join(seed, 'd/escape'));
  symlinkSync('inside.txt', join(seed, 'd/near'));
  const linked = digest();
  assert.notEqual(linked, plain, 'links are named');
  writeFileSync(join(root, 'outside.txt'), 'two');
  writeFileSync(join(seed, 'd/inside.txt'), 'in');
  assert.equal(digest(), linked, 'a target is not read');
  rmSync(join(seed, 'd/near'));
  symlinkSync('inside.tx', join(seed, 'd/near'));
  assert.notEqual(digest(), linked, 'the link text is content');
});

test('inputs: service use, domains and the pinned worker environment', () => {
  const steps = value => [{ cmd: 'c', args: { v: value } }];
  assert.deepEqual(suiteUses({ scenarios: [{ id: 'a', seed: 'empty', llm: 'script', steps: steps('x') }] }), { seeds: ['empty'], services: ['llm'] });
  assert.deepEqual(suiteUses({ scenarios: [{ id: 'a', seed: 'skill-zip-v0', steps: steps('${provider.url}') }] }), { seeds: ['skill-zip-v0'], services: ['llm'] });
  assert.deepEqual(suiteUses({ scenarios: [{ id: 'a', seed: 'empty', steps: steps('${cloud.webdav.endpoint}') },
    { id: 'b', seed: 'historical-wp013-v1', steps: steps('${mock.webdav.username}') }] }), { seeds: ['empty', 'historical-wp013-v1'], services: ['cloud'] });
  assert.deepEqual(suiteUses({ scenarios: [{ id: 'a', seed: 'empty', steps: steps('pre ${llm.baseUrl}/v1') }] }).services, ['llm']);
  assert.deepEqual(suiteUses({ scenarios: [{ id: 'a', seed: 'empty', steps: steps('${mcp.disconnect-on-list.args}') },
    { id: 'b', seed: 'empty', steps: steps('${mcp.url}/mcp/success') }] }).services, ['mcp']);

  assert.equal(domainOf('host/plugins/chat/equivalence/chat.json'), 'chat');
  assert.equal(domainOf('host/plugins/vfs-handlers/equivalence/wave0/x.json'), 'vfs-handlers');
  assert.equal(domainOf('host/platform/equivalence/settings.json'), 'platform');
  assert.equal(domainOf('host/kernel/equivalence/plugins.json'), 'kernel');
  assert.equal(domainOf('host/e2e/streaming/wave0/streaming.scenarios.json'), 'e2e');
  assert.equal(domainOf('electron/equivalence/shell.json'), 'electron');
  assert.equal(domainOf('fixtures/differential/wp043/get-app-version.v0.json'), 'fixtures');

  assert.deepEqual(DEFAULT_ENVIRONMENT, { TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  assert.deepEqual(pinnedEnvironment({}), DEFAULT_ENVIRONMENT);
  assert.deepEqual(pinnedEnvironment({ tz: 'Asia/Shanghai', locale: 'en_US.UTF-8' }), { TZ: 'Asia/Shanghai', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
  const env = workerEnvironment(DEFAULT_ENVIRONMENT, { PATH: '/bin', TZ: 'Europe/Berlin', LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' });
  assert.deepEqual(env, { PATH: '/bin', TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, 'LANGUAGE would override message locale under a non-C locale');
});

// A small corpus over the real recorder tree: in-memory edits of real files show which A takes each edit invalidates.
const scenario = (id, extra = {}) => ({ id, seed: 'empty', steps: [{ cmd: 'get_app_version' }], capture: { events: false, db: [] }, normalize: [], ...extra });
const SUITES = {
  'host/plugins/w13/equivalence/plain.json': [scenario('plain'), scenario('events', { capture: { events: true, db: [] } }),
    scenario('fixture', { steps: [{ cmd: 'read', args: { path: 'fixtures/w13/doc.md' } }] })],
  'host/plugins/w13/equivalence/llm.json': [scenario('llm', { steps: [{ cmd: 'chat', args: { url: '${llm.baseUrl}' } }] }),
    scenario('llm-b', { llm: 'script-b', steps: [{ cmd: 'chat', args: { url: '${llm.baseUrl}' } }] })],
  'host/plugins/w13/equivalence/cloud.json': [scenario('cloud', { steps: [{ cmd: 'sync', args: { url: '${cloud.webdav.endpoint}' } }] })],
  'host/plugins/w13/equivalence/mcp.json': [scenario('mcp', { steps: [{ cmd: 'mcp_stdio_start', args: { command: '${mcp.success.command}' } }] }), scenario('mcp-mate')],
};
const IDS = Object.values(SUITES).flat().map(item => item.id);
const CORPUS = {
  ...Object.fromEntries(Object.entries(SUITES).map(([file, scenarios]) => [file, JSON.stringify({ scenarios })])),
  'host/plugins/w13/equivalence/llm.provider.json': JSON.stringify({ llm: [{ text: 'A' }], 'script-b': [{ text: 'B' }] }),
  'fixtures/w13/doc.md': 'one',
};
const LAUNCH = { mcp: { port: 47130, logDir: '/tmp/g3-mcp', node: '/usr/bin/node', nodeVersion: 'v24.1.0' } };
const ISOLATION = { wrapper: ['unshare'], init: 'init' };
const overlay = changes => path => {
  const all = { ...CORPUS, ...changes };
  return Object.hasOwn(all, path) ? (all[path] === null ? null : Buffer.from(all[path])) : repoRead(path);
};
const entries = (changes = {}, { seeds = { empty: { sha256: 'e' } }, events = 'ev', launch = LAUNCH, node = 'v24.1.0', isolation = ISOLATION } = {}) => {
  const inputs = scenarioEntries({ schema: INPUTS_SCHEMA, ...scenarioInputs({ read: overlay(changes), files: Object.keys(SUITES), environment: { TZ: 'UTC' }, seeds,
    events, launch, isolation, node }) });
  return Object.fromEntries(Object.values(inputs).flatMap(items => Object.entries(items)));
};
const BASE = entries();
const stale = after => Object.fromEntries(IDS.map(id => [id, scenarioDifference(BASE[id], after[id])]).filter(([, reasons]) => reasons));
const every = (reasons, ids = IDS) => Object.fromEntries(ids.map(id => [id, reasons]));

/** `file` with a behaviour change inside its top-level declaration `name` only (a statement at the start of its body, an element of its array or a property of its object). */
function mutate(file, name) {
  const source = ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  for (const statement of source.statements) {
    const names = ts.isVariableStatement(statement) ? statement.declarationList.declarations.map(item => item.name.getText(source)) : [statement.name?.getText(source)];
    if (!names.includes(name)) continue;
    let at = null, insert = null;
    const find = node => {
      if (at !== null) return;
      if (ts.isBlock(node)) { at = node.getStart(source) + 1; insert = " void 'w13';"; return; }
      if (ts.isArrayLiteralExpression(node)) { at = node.getStart(source) + 1; insert = "'w13', "; return; }
      if (ts.isObjectLiteralExpression(node)) { at = node.getStart(source) + 1; insert = " w13: 'w13',"; return; }
      ts.forEachChild(node, find);
    };
    find(statement);
    assert.ok(at !== null, `${file} ${name} has a body or array`);
    return { [file]: text(file).slice(0, at) + insert + text(file).slice(at) };
  }
  return assert.fail(`${file} has no top-level ${name}`);
}
const appended = (file, code) => ({ [file]: `${text(file)}\n${code}\n` });

test('A fingerprint v2: the corpus maps each scenario to the code unit of the services its process starts', () => {
  assert.deepEqual(Object.fromEntries(IDS.map(id => [id, BASE[id].unit])), { plain: 'a', events: 'a', fixture: 'a', llm: 'a+llm', 'llm-b': 'a+llm', cloud: 'a+cloud',
    mcp: 'a+mcp', 'mcp-mate': 'a+mcp' }, 'an MCP suite runs mcpBindingKinds for every scenario of its shards');
  for (const id of IDS) assert.equal(scenarioDifference(BASE[id], entries()[id]), null, `${id} is deterministic`);
  const base = aUnit(repoRead, []);
  const files = Object.keys(base.code);
  for (const file of Object.values(SERVICE_MODULES)) assert.ok(!files.includes(file), `${file} only where its service runs`);
  for (const file of [A_ENTRY, `${RECORD}/scenario-v0.mjs`, `${RECORD}/g3-wait.mjs`, `${RECORD}/g3-startup.mjs`, `${RECORD}/g3-quiet.mjs`, `${RECORD}/g3-services.mjs`,
    `${RECORD}/json.mjs`, `${RECORD}/supervise.mjs`, `${RECORD}/g3-harness-server.mjs`, 'host/e2e/data-compat/__fixtures__/database-state.ts',
    'host/e2e/data-compat/__fixtures__/seed-files.ts', SEED_MODULE]) {
    assert.ok(files.includes(file), `${file} is on the A path`);
  }
  for (const file of files) assert.ok(!/^host\/(?:kernel|platform)\/|^host\/plugins\/(?!mcp\/equivalence\/|sync-providers\/(?:equivalence|tests)\/)/.test(file), `${file} is not product code`);
  for (const file of ['g3-run-b.mjs', 'g3-compare.mjs', 'g3-normalize.mjs', 'g3-normalize-values.mjs', 'g3-normalize-clock.mjs', 'g3-report.mjs', 'g3-batch.mjs', 'g3-provenance.mjs', 'g3-inputs.mjs', 'g3-slice.mjs', 'g3-worker.mjs', 'g3-supervise.mjs']) {
    assert.ok(!files.includes(`${RECORD}/${file}`), `${file} is not on the A path`);
  }
  assert.deepEqual(Object.keys(base.resources), [`${RECORD}/g3-harness.mjs`]);
  assert.deepEqual(Object.keys(base.packages), ['better-sqlite3']);
  const mcp = aUnit(repoRead, ['mcp']);
  assert.deepEqual(Object.keys(mcp.resources), ['host/plugins/mcp/equivalence/__fixtures__/oauth-browser.ts', 'host/plugins/mcp/equivalence/protocol.ts', 'host/plugins/mcp/equivalence/stdio-server.ts', `${RECORD}/g3-harness.mjs`]);
  assert.deepEqual(Object.keys(mcp.programs['host/plugins/mcp/equivalence/stdio-server.ts']), ['host/plugins/mcp/equivalence/protocol.ts', 'host/plugins/mcp/equivalence/stdio-server.ts']);
});

test('A fingerprint v2: edits that only B, compare, report or the batch run invalidate no A take', () => {
  const cases = {
    'B runner': appended(`${RECORD}/g3-run-b.mjs`, "export const w13Probe = () => 'w13';"),
    'B runner main': mutate(`${RECORD}/g3-run-b.mjs`, 'runScenarioB'),
    comparator: appended(`${RECORD}/g3-compare.mjs`, "globalThis.w13Probe = 'w13';"),
    normalizer: appended(`${RECORD}/g3-normalize.mjs`, "globalThis.w13Probe = 'w13';"),
    report: appended(`${RECORD}/g3-report.mjs`, "globalThis.w13Probe = 'w13';"),
    provenance: appended(`${RECORD}/g3-provenance.mjs`, "globalThis.w13Probe = 'w13';"),
    'batch (not the A command)': appended(`${RECORD}/g3-batch.mjs`, "globalThis.w13Probe = 'w13';"),
    'json compare helpers': { ...mutate(`${RECORD}/json.mjs`, 'firstDifference'), ...mutate(`${RECORD}/json.mjs`, 'normalize') },
    'X3 DB comparison': mutate('host/e2e/data-compat/__fixtures__/database-state.ts', 'compareDatabaseStates'),
    'seed builder (seed content is the input)': mutate(SEED_MODULE, 'createSeed'),
    'seed list (membership is the seed digest)': mutate(SEED_MODULE, 'SEED_NAMES'),
    'B-only binding lookup': mutate(`${RECORD}/g3-services.mjs`, 'lookupBinding'),
    'MCP launch description (g3-inputs only)': mutate(`${RECORD}/g3-services.mjs`, 'mcpLaunch'),
  };
  for (const [label, changes] of Object.entries(cases)) assert.deepEqual(stale(entries(changes)), {}, label);
});

test('A fingerprint v2: edits on the A path invalidate exactly the scenarios whose process runs them, naming the file', () => {
  const code = file => [`code:${file}`];
  const LLM = ['llm', 'llm-b'], MCP = ['mcp', 'mcp-mate'];
  const cases = [
    ['wait loop', mutate(`${RECORD}/g3-wait.mjs`, 'waitForEvent'), every(code(`${RECORD}/g3-wait.mjs`))],
    ['scenario executor', mutate(`${RECORD}/scenario-v0.mjs`, 'executeScenario'), every(code(`${RECORD}/scenario-v0.mjs`))],
    ['evidence writer', mutate(`${RECORD}/json.mjs`, 'evidenceBytes'), every(code(`${RECORD}/json.mjs`))],
    ['a new module effect', appended(`${RECORD}/g3-quiet.mjs`, "globalThis.w13Probe = 'w13';"), every(code(`${RECORD}/g3-quiet.mjs`))],
    ['DB snapshot', mutate('host/e2e/data-compat/__fixtures__/database-state.ts', 'snapshotDatabase'), every(code('host/e2e/data-compat/__fixtures__/database-state.ts'))],
    ['seed copy', mutate(SEED_MODULE, 'copySeed'), every(code(SEED_MODULE))],
    // W21 (9eda3c17): copySeed delegates link/FIFO-preserving copies to this A-path module.
    ['seed tree copy', mutate('host/e2e/data-compat/__fixtures__/seed-files.ts', 'copySeedTree'), every(code('host/e2e/data-compat/__fixtures__/seed-files.ts'))],
    ['service start', mutate(`${RECORD}/g3-services.mjs`, 'startScenarioServices'), every(code(`${RECORD}/g3-services.mjs`))],
    ['event list builder', mutate(A_ENTRY, 'frontendEvents'), every(code(A_ENTRY))],
    ['harness page (served by URL)', appended(`${RECORD}/g3-harness.mjs`, '// w13'), every([`resource:${RECORD}/g3-harness.mjs`])],
    ['LLM service', mutate(SERVICE_MODULES.llm, 'startLlmService'), every(code(SERVICE_MODULES.llm), LLM)],
    ['cloud service', mutate(SERVICE_MODULES.cloud, 'startCloudService'), every(code(SERVICE_MODULES.cloud), ['cloud'])],
    ['MCP service', mutate(SERVICE_MODULES.mcp, 'startMcpService'), every(code(SERVICE_MODULES.mcp), MCP)],
    ['MCP stdio server (copied and spawned)', mutate('host/plugins/mcp/equivalence/stdio-server.ts', 'main'),
      every(['resource:host/plugins/mcp/equivalence/stdio-server.ts', 'program:host/plugins/mcp/equivalence/stdio-server.ts:host/plugins/mcp/equivalence/stdio-server.ts'], MCP)],
  ];
  for (const [label, changes, expected] of cases) assert.deepEqual(stale(entries(changes)), expected, label);

  const lock = JSON.parse(text('package-lock.json'));
  lock.packages['node_modules/better-sqlite3'].version = '0.0.0-w13';
  assert.deepEqual(stale(entries({ 'package-lock.json': JSON.stringify(lock) })), every(['package:better-sqlite3']), 'the X3 snapshot reads through better-sqlite3');
  const batch = text(`${RECORD}/g3-batch.mjs`).replace(`'${A_ENTRY}',`, `'${A_ENTRY}', '--w13',`);
  assert.deepEqual(stale(entries({ [`${RECORD}/g3-batch.mjs`]: batch })), every(['launch:a']), 'the A worker command line');
  assert.deepEqual(stale(entries({}, { isolation: { ...ISOLATION, init: 'other' } })), every(['launch:a']), 'the namespace init');
  assert.deepEqual(stale(entries({}, { node: 'v26.5.0' })), every(['runtime:node']));
  assert.deepEqual(stale(entries({}, { events: 'ev2' })), { events: ['events'] }, 'only a scenario that captures events subscribes to the list');
  assert.deepEqual(stale(entries({}, { events: 'unavailable:ENOENT' })), every(['events']), 'no A take runs when the list cannot be built');
});

test('A fingerprint v2: only the scenario whose definition, LLM script entry, seed, named fixture or MCP launch changed differs, with that reason', () => {
  assert.deepEqual(Object.keys(BASE.fixture.files), ['fixtures/w13/doc.md']);
  assert.equal(BASE.plain.llm, null, 'plain does not use the llm service');
  const sidecar = JSON.parse(CORPUS['host/plugins/w13/equivalence/llm.provider.json']);
  assert.deepEqual(stale(entries({ 'host/plugins/w13/equivalence/llm.provider.json': JSON.stringify({ ...sidecar, llm: [{ text: 'A2' }] }) })), { llm: ['llm'] });
  const plain = SUITES['host/plugins/w13/equivalence/plain.json'];
  assert.deepEqual(stale(entries({ 'host/plugins/w13/equivalence/plain.json': JSON.stringify({ scenarios: [{ ...plain[0], normalize: ['x'] }, ...plain.slice(1)] }) })),
    { plain: ['scenario'] }, 'other scenarios of a changed suite keep their inputs');
  assert.deepEqual(stale(entries({ 'fixtures/w13/doc.md': 'two' })), { fixture: ['file:fixtures/w13/doc.md'] });
  assert.deepEqual(stale(entries({}, { seeds: { empty: { sha256: 'e2' } } })), every(['seed']));
  assert.deepEqual(stale(entries({}, { launch: { mcp: { ...LAUNCH.mcp, node: '/opt/node-26/bin/node' } } })), { mcp: ['launch:mcp'] });
  assert.deepEqual(stale(entries({}, { launch: null })), { mcp: ['launch:mcp'] }, 'a store from before MCP wiring has no launch values');
  const cloud = SUITES['host/plugins/w13/equivalence/cloud.json'];
  assert.deepEqual(stale(entries({ 'host/plugins/w13/equivalence/cloud.json': JSON.stringify({ scenarios: [{ ...cloud[0], steps: [{ cmd: 'sync' }] }] }) })),
    { cloud: ['scenario', 'services', `code:${SERVICE_MODULES.cloud}`, 'code:host/plugins/sync-providers/tests/fake_dav.ts', 'code:host/plugins/sync-providers/tests/fake_s3.ts'] },
    'a scenario that stops using a service runs other code');
  assert.deepEqual(scenarioDifference(BASE.plain, undefined), ['not-in-tree']);
  assert.deepEqual(scenarioDifference(undefined, BASE.plain), ['not-in-store']);
  assert.deepEqual(scenarioDifference({ scenario: 'x', closures: {}, digest: 'v1' }, BASE.plain), ['schema'], 'a v1 entry is never the same input');
});

test('A fingerprint v2: the event list is computed by the tree\'s own frontendEvents; an unbuildable list is named', t => {
  const root = tmp(t);
  mkdirSync(join(root, 'contracts/ipc'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'contracts/ipc/a.json'), JSON.stringify({ events: [{ name: 'note_saved' }] }));
  writeFileSync(join(root, 'src/a.ts'), "listen('chat_v2_session_${id}', handler); once(\"ready\", f);");
  writeFileSync(join(root, 'src/a.test.ts'), "listen('test_only', f);");
  const base = eventsDigest(repoRead, root);
  assert.match(base, HEX);
  writeFileSync(join(root, 'src/a.test.ts'), "listen('test_only_2', f);");
  assert.equal(eventsDigest(repoRead, root), base, 'test files are not subscribed to');
  writeFileSync(join(root, 'src/b.tsx'), "listen('other', f);");
  assert.notEqual(eventsDigest(repoRead, root), base);
  rmSync(join(root, 'src'), { recursive: true });
  assert.equal(eventsDigest(repoRead, root), 'unavailable:ENOENT');
  assert.equal(eventsDigest(path => (path === A_ENTRY ? Buffer.from('export const x = 1;') : repoRead(path)), root), 'unavailable:no frontendEvents');
});

test('suite-level fallback: v1 fingerprints keep their reasons; a schema change is never the same input', () => {
  const v1 = suites => ({ schema: 'g3-inputs/v1', suites });
  const entry = { sha256: 's', provider: null, seeds: { empty: 'e' }, closures: { recorder: 'r' }, environment: { TZ: 'UTC' }, digest: 'd1' };
  assert.equal(inputDifference(v1({ f: entry }), v1({ f: entry }), 'f'), null);
  assert.deepEqual(inputDifference(v1({ f: entry }), v1({ f: { ...entry, closures: { recorder: 'r2' }, digest: 'd2' } }), 'f'), ['closure:recorder']);
  assert.deepEqual(inputDifference(v1({ f: entry }), { schema: INPUTS_SCHEMA, suites: { f: { sha256: 's', provider: null, scenarios: 'x', digest: 'd3' } } }, 'f'), ['schema']);
  assert.deepEqual(inputDifference(v1({}), v1({ f: entry }), 'f'), ['not-in-store']);
});
