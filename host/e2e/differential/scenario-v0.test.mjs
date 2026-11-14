import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executeScenario, parseJsonPath, prepareScenarioRun, resolveReferences, validateScenario } from '../../../scripts/electron-migration/record/scenario-v0.mjs';
import { parseExact, stringifyExact } from '../../../scripts/electron-migration/record/json.mjs';
import { snapshot } from '../../../scripts/electron-migration/record/database.mjs';
import { startHarnessServer } from '../../../scripts/electron-migration/record/tauri-harness-server.mjs';

const scenario = steps => ({ id: 'recorder-probe-not-A', seed: 'empty', steps,
  capture: { events: true, db: ['*'] }, normalize: [] });

async function readTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.map(async entry => [entry.name,
    entry.isDirectory() ? await readTree(join(directory, entry.name)) : await readFile(join(directory, entry.name))])));
}

test('v0 references retain exact numbers, null, arrays and shared return/event/FK IDs', async () => {
  const root = await mkdtemp('/tmp/opencode/x7-v0-');
  const filename = join(root, 'probe.db');
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));');
    const events = [];
    const input = scenario([
      { cmd: 'fixture.insert', args: {} },
      { cmd: 'fixture.link', args: { id: '${0.id}', duplicate: '${0.id}', optional: '${0.optional}', fraction: '${0.fraction}' } },
      { cmd: 'fixture.error', args: {}, expect: 'error' },
    ]);
    const recording = await executeScenario(input, {
      async invoke(command, raw) {
        if (command === 'fixture.insert') {
          db.exec('INSERT INTO parent VALUES(9007199254740993)');
          events.push({ payloadRaw: '{"id":9007199254740993}' });
          return { kind: 'result', raw: '{"id":9007199254740993,"optional":null,"fraction":1.00000000000000001}' };
        }
        if (command === 'fixture.link') {
          assert.equal(raw, '{"id":9007199254740993,"duplicate":9007199254740993,"optional":null,"fraction":1.00000000000000001}');
          db.prepare('INSERT INTO child VALUES(?)').run(parseExact(raw).id);
          return { kind: 'result', raw: '[9007199254740993,null]' };
        }
        return { kind: 'error', raw: '{"message":"original error","details":null}' };
      },
      async capture(request) {
        assert.deepEqual(request, { events: true, db: ['*'] });
        return { events: structuredClone(events), databases: { 'probe.db': snapshot(filename) } };
      },
    });
    const after = recording.after.databases['probe.db'];
    assert.equal(after.tables.parent.rows[0].id, 9007199254740993n);
    assert.equal(after.tables.child.rows[0].parent_id, 9007199254740993n);
    assert.equal(after.tables.child.storageClasses[0].parent_id, 'integer');
    assert.equal(parseExact(recording.after.events[0].payloadRaw).id, after.tables.parent.rows[0].id);
    assert.equal(recording.calls[2].outcome.raw, '{"message":"original error","details":null}');
    assert.equal(recording.comparison, 'not-run');
    assert.equal(stringifyExact(resolveReferences('${0.items.1}', [{ kind: 'result', raw: '{"items":[0,null]}' }])), 'null');
  } finally { db.close(); await rm(root, { recursive: true }); }
});

test('v0 rejects missing/failed/future references and propagates transport/capture failures', async () => {
  assert.throws(() => resolveReferences('${0.id}', []), /prior successful/);
  assert.throws(() => resolveReferences('${0.id}', [{ kind: 'error', raw: '{}' }]), /prior successful/);
  assert.throws(() => resolveReferences('${0.id}', [{ kind: 'result', raw: '{}' }]), /missing reference/);
  assert.throws(() => resolveReferences('prefix-${0.id}', []), /prior successful/);
  // Embedded references (X5/X1 semantics): strings as-is, exact numbers by source text.
  const prior = [{ kind: 'result', raw: '{"path":"/a b","n":9007199254740993,"f":1.50,"o":{}}' }];
  assert.equal(resolveReferences('${0.path}/sub-${0.n}-${0.f}.zip', prior), '/a b/sub-9007199254740993-1.50.zip');
  assert.throws(() => resolveReferences('x${0.o}', prior), /not a string or number/);
  assert.throws(() => resolveReferences('x${nope}', prior), /invalid reference/);
  assert.equal(resolveReferences('${llm.baseUrl}/v1', [], { llm: { baseUrl: 'http://127.0.0.1:47110/s' } }), 'http://127.0.0.1:47110/s/v1');
  // MCP (README G3 接线): `-` in key segments; a whole-value binding is its JSON value.
  const mcp = { mcp: { 'disconnect-on-list': { command: '/usr/bin/node', args: ['/tmp/g3-mcp/stdio-server.mjs', '--script', 'disconnect-on-list'], env: {} },
    sse: { url: 'http://127.0.0.1:47130/sse', port: 47130 } } };
  const args = resolveReferences({ transport: { command: '${mcp.disconnect-on-list.command}', args: '${mcp.disconnect-on-list.args}', env: '${mcp.disconnect-on-list.env}' } }, [], mcp);
  assert.equal(stringifyExact(args), '{"transport":{"command":"/usr/bin/node","args":["/tmp/g3-mcp/stdio-server.mjs","--script","disconnect-on-list"],"env":{}}}');
  assert.equal(stringifyExact(resolveReferences('${mcp.sse.port}', [], mcp)), '47130');
  assert.equal(resolveReferences('${mcp.sse.url}?s=1', [], mcp), 'http://127.0.0.1:47130/sse?s=1');
  assert.throws(() => resolveReferences('x ${mcp.disconnect-on-list.args}', [], mcp), /embedded service binding is not a string/);
  assert.throws(() => resolveReferences('${mcp.sse.port}/x', [], mcp), /embedded service binding is not a string/);
  assert.throws(() => resolveReferences('${mcp.missing.args}', [], mcp), /unbound reference/);
  assert.throws(() => resolveReferences('${mcp.sse.url}', [], null), /unbound reference/);
  assert.throws(() => resolveReferences('${runner.dir}', [], mcp), /prior successful|invalid reference|unbound/);
  const input = scenario([{ cmd: 'fixture.read', args: null, expect: 'error' }]);
  await assert.rejects(executeScenario(input, { capture() { throw new Error('DB read failed'); } }), /DB read failed/);
  const capture = () => ({ events: [], databases: {} });
  await assert.rejects(executeScenario(input, { capture, invoke() { throw new Error('transport closed'); } }), /transport closed/);
  await assert.rejects(executeScenario(input, { capture, invoke: () => ({ kind: 'timeout', raw: 'null' }) }), /raw IPC outcome/);
  await assert.rejects(executeScenario(input, { capture: () => ({}) }), /missing captured events/);
  await assert.rejects(executeScenario(input, { capture: () => ({ events: [] }) }), /missing captured databases/);
});

test('v0 validates JSONPath explicitly and never silently masks unapproved fields', () => {
  assert.deepEqual(parseJsonPath('$.calls[*].result[0]["id.with.dot"]'), ['calls', '*', 'result', '0', 'id.with.dot']);
  for (const path of ['/calls/0', '$..id', '$[?(@.id)]', '$.a[', '$.a trailing']) assert.throws(() => parseJsonPath(path), /JSONPath/);
  const input = scenario([{ cmd: 'fixture.read', args: {} }]);
  assert.throws(() => validateScenario({ ...input, normalize: ['$.calls[*].id'] }), /C2 approval/);
  assert.throws(() => validateScenario({ ...input, normalize: ['/calls/0'] }), /JSONPath/);
  assert.throws(() => validateScenario({ ...input, capture: undefined }), /capture/);
});

test('self-driving harness HTTP carries raw IPC bytes without numeric reserialization', async () => {
  const server = await startHarnessServer(0);
  const post = async (path, body) => {
    const response = await fetch(server.url + path, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    await response.text();
  };
  try {
    const html = await (await fetch(server.url)).text();
    assert.match(html, /tauri-harness.mjs/);
    await post('/ready', { backend: 'transport-test-not-A' });
    assert.equal((await server.ready).backend, 'transport-test-not-A');
    const next = fetch(server.url + '/next').then(response => response.json());
    const outcome = server.invoke('get_app_version', '{}');
    assert.deepEqual(await next, { command: 'get_app_version', argsRaw: '{}' });
    const raw = '{"id":9007199254740993,"fraction":1.00000000000000001,"negativeZero":-0}';
    await post('/outcome', { kind: 'result', raw, wire: [{ responseRaw: raw }], events: [] });
    assert.equal((await outcome).raw, raw);
    assert.equal(server.evidence.wire[0].responseRaw, raw);
    const close = fetch(server.url + '/next').then(response => response.json());
    server.requestExit();
    assert.deepEqual(await close, { close: true });
    await post('/closing', { wire: server.evidence.wire, events: [] });
    assert.ok(server.evidence.closing);
  } finally { await server.close(); }
});

test('normal-main X3 empty seed copies and exact final-state API are consumable by X7', async () => {
  const { createSeed, resolveSeed, copySeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const { snapshotDirectory, compareDatabaseStates } = await import('../data-compat/__fixtures__/database-state.ts');
  const root = await mkdtemp('/tmp/opencode/x7-x3-seam-');
  try {
    const catalog = join(root, 'catalog');
    const seed = createSeed('empty', catalog);
    assert.deepEqual(resolveSeed('empty', catalog), seed);
    const one = copySeed('empty', catalog, join(root, 'one'));
    const two = copySeed('empty', catalog, join(root, 'two'));
    assert.notEqual(one.dataDir, two.dataDir);
    assert.deepEqual(compareDatabaseStates(snapshotDirectory(one.directory), snapshotDirectory(two.directory)), []);
    const db = new DatabaseSync(join(one.dataDir, 'recorder-only.db'));
    try { db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, n); INSERT INTO probe VALUES(9007199254740993, 1.0)'); }
    finally { db.close(); }
    const state = snapshotDirectory(one.directory);
    const row = state.databases['app-data/recorder-only.db'].tables.probe.rows[0].values;
    assert.deepEqual(row.id, { storageClass: 'integer', value: '9007199254740993' });
    assert.deepEqual(row.n, { storageClass: 'real', value: '3ff0000000000000' });
    assert.deepEqual(snapshotDirectory(seed.directory).databases, {});
    const diff = compareDatabaseStates(snapshotDirectory(two.directory), state);
    assert.equal(diff.length, 1);
    assert.equal(diff[0].kind, 'database');
    assert.equal(diff[0].db, 'app-data/recorder-only.db');
  } finally { await rm(root, { recursive: true }); }
});

test('v0 preparation gives two independent skill ZIP copies with same-copy HOME and app data', async () => {
  const { createSeed, resolveSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const { SKILL_ZIP_SEED_FILES } = await import('../data-compat/__fixtures__/skill-zip-seeds.ts');
  const root = await mkdtemp('/tmp/opencode/x7-v0-home-');
  try {
    const catalog = join(root, 'catalog');
    const source = createSeed('skill-zip-v0', catalog);
    const before = await readTree(source.directory);
    const input = { ...scenario([{ cmd: 'skill_import_zip', args: { zipPath: SKILL_ZIP_SEED_FILES[0].homePath } }]), seed: source.name };
    const inherited = { ...process.env, HOME: '/unused-parent-home', XDG_DATA_HOME: '/unused-parent-data' };
    const runs = await Promise.all(['one', 'two'].map(side => prepareScenarioRun(input, {
      catalog, directory: join(root, side), env: inherited,
    })));
    for (const run of runs) {
      assert.deepEqual(run.source, resolveSeed(input.seed, catalog));
      assert.equal(run.seed.provenance, 'synthetic-zip');
      assert.equal(run.env.HOME, join(run.seed.directory, 'home'));
      assert.equal(run.env.XDG_DATA_HOME, run.seed.dataDir);
      assert.equal(run.seed.dataDir, join(run.seed.directory, 'app-data'));
      assert.equal(run.seed.dataLocalDir, join(run.seed.directory, 'local-data'));
      for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
        assert.ok(run.env[key].startsWith(run.seed.directory + '/'));
        assert.ok((await stat(run.env[key])).isDirectory());
      }
      // The Host's compile cache (os.tmpdir() unless NODE_COMPILE_CACHE) stays out of the seed copy.
      assert.equal(run.env.NODE_COMPILE_CACHE, join(root, 'node-compile-cache'));
      assert.ok((await stat(run.env.NODE_COMPILE_CACHE)).isDirectory());
      // A real Node child consumes the prepared environment; no application/oracle runs.
      const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { homedir } from 'node:os';
        import { readFileSync } from 'node:fs';
        import { join } from 'node:path';
        const files = JSON.parse(process.argv[1]);
        console.log(JSON.stringify({ home: homedir(), data: process.env.XDG_DATA_HOME,
          bytes: files.map(file => readFileSync(join(homedir(), file.homePath.slice(2))).toString('hex')) }));
      `, JSON.stringify(SKILL_ZIP_SEED_FILES)], { env: run.env, encoding: 'utf8' }));
      assert.equal(child.home, run.env.HOME);
      assert.equal(child.data, run.seed.dataDir);
      for (const [index, file] of SKILL_ZIP_SEED_FILES.entries()) {
        assert.equal(child.bytes[index], (await readFile(join(source.directory, file.relativePath))).toString('hex'));
      }
    }
    assert.notEqual(runs[0].env.HOME, runs[1].env.HOME);
    assert.notEqual(runs[0].seed.dataDir, runs[1].seed.dataDir);
    const secondBefore = await readTree(runs[1].seed.directory);
    await writeFile(join(runs[0].seed.directory, SKILL_ZIP_SEED_FILES[0].relativePath), 'changed copy');
    await writeFile(join(runs[0].seed.dataDir, 'run-only.txt'), 'app write');
    await writeFile(join(runs[0].seed.dataLocalDir, 'run-only.txt'), 'local write');
    assert.deepEqual(await readTree(runs[1].seed.directory), secondBefore);
    assert.deepEqual(await readTree(source.directory), before);
    assert.equal(inherited.HOME, '/unused-parent-home');
    assert.equal(inherited.XDG_DATA_HOME, '/unused-parent-data');
  } finally { await rm(root, { recursive: true }); }
});

test('v0 preparation rejects unknown/uncreated seeds and every missing ZIP without repairing the source', async () => {
  const { createSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const { SKILL_ZIP_SEED_FILES } = await import('../data-compat/__fixtures__/skill-zip-seeds.ts');
  const root = await mkdtemp('/tmp/opencode/x7-v0-missing-');
  try {
    const catalog = join(root, 'catalog');
    const directory = join(root, 'run');
    const input = scenario([{ cmd: 'get_app_version', args: {} }]);
    await assert.rejects(prepareScenarioRun({ ...input, seed: 'unknown' }, { catalog, directory }), /Unknown scenario seed: unknown/);
    await assert.rejects(prepareScenarioRun(input, { catalog, directory }), /Seed has not been created/);
    await assert.rejects(stat(catalog), { code: 'ENOENT' });
    const source = createSeed('skill-zip-v0', catalog);
    for (const file of SKILL_ZIP_SEED_FILES) {
      const filename = join(source.directory, file.relativePath);
      const original = await readFile(filename);
      await rm(filename);
      const incomplete = await readTree(source.directory);
      await assert.rejects(prepareScenarioRun({ ...input, seed: source.name }, { catalog, directory }),
        error => error.code === 'ENOENT' && error.path === filename);
      assert.deepEqual(await readTree(source.directory), incomplete);
      await assert.rejects(stat(directory), { code: 'ENOENT' });
      await writeFile(filename, original);
    }
    const wrongType = join(source.directory, SKILL_ZIP_SEED_FILES[0].relativePath);
    await rm(wrongType);
    await mkdir(wrongType);
    await assert.rejects(prepareScenarioRun({ ...input, seed: source.name }, { catalog, directory }), /Seed input is not a file/);
  } finally { await rm(root, { recursive: true }); }
});

test('original empty/get_app_version input uses the shared preparation without mutating its seed', async () => {
  const { createSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const root = await mkdtemp('/tmp/opencode/x7-v0-empty-');
  try {
    const { scenarios: [input] } = parseExact(await readFile('fixtures/differential/wp043/get-app-version.v0.json', 'utf8'));
    assert.equal(input.seed, 'empty');
    assert.deepEqual(input.steps, [{ cmd: 'get_app_version', args: {} }]);
    const catalog = join(root, 'catalog');
    const source = createSeed(input.seed, catalog);
    const before = await readTree(source.directory);
    for (const side of ['one', 'two']) {
      const run = await prepareScenarioRun(input, { catalog, directory: join(root, side) });
      assert.equal(run.seed.provenance, 'empty');
      assert.equal(run.env.HOME, join(root, side, 'home'));
      assert.equal(run.env.XDG_DATA_HOME, join(root, side, 'app-data'));
      assert.deepEqual(await readdir(run.seed.dataDir), []);
      assert.deepEqual(await readdir(run.seed.dataLocalDir), []);
      assert.deepEqual(await readdir(run.env.HOME), []);
    }
    assert.deepEqual(await readTree(source.directory), before);
  } finally { await rm(root, { recursive: true }); }
});

test('NODE_COMPILE_CACHE: a shared directory outside every seed copy; never inside one', async () => {
  const { createSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const root = await mkdtemp('/tmp/opencode/x7-v0-cache-');
  try {
    const input = scenario([{ cmd: 'get_app_version', args: {} }]);
    const catalog = join(root, 'catalog');
    createSeed('empty', catalog);
    const shared = join(root, 'node-compile-cache');
    const runs = await Promise.all(['A1', 'B'].map(side => prepareScenarioRun(input, { catalog, directory: join(root, 'id', side, 'run'), compileCache: shared })));
    for (const run of runs) {
      assert.equal(run.env.NODE_COMPILE_CACHE, shared);
      assert.ok(!run.env.NODE_COMPILE_CACHE.startsWith(run.seed.directory + '/'));
    }
    // A real Node child with only this environment writes its cache there, not under TMPDIR.
    const env = runs[1].env;
    execFileSync(process.execPath, ['--input-type=module', '-e', 'import("node:module").then(m => { m.enableCompileCache(); m.flushCompileCache(); })'], { env });
    assert.deepEqual(await readdir(env.TMPDIR), []);
    await assert.rejects(prepareScenarioRun(input, { catalog, directory: join(root, 'inside'), compileCache: join(root, 'inside', 'tmp', 'cache') }),
      /NODE_COMPILE_CACHE .* is inside the seed copy/);
  } finally { await rm(root, { recursive: true }); }
});
