// `${seed.*}`: values a seed supplies for its run copy (a-produced-seeds.ts seedBindings), resolved
// like service bindings, checked up front (serviceGap, corpus check), fingerprinted per scenario
// that reads them, and compared through N-007 (their paths lie under each take's run root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copyNormalizer } from './__fixtures__/normalizer.mjs';
import { fileURLToPath } from 'node:url';
import { executeScenario, prepareScenarioRun, resolveReferences, usesSeed, validateScenario } from '../../../scripts/electron-migration/record/scenario-v0.mjs';
import { seedBindingKinds, serviceGap } from '../../../scripts/electron-migration/record/g3-services.mjs';
import { DEFAULT_ENVIRONMENT, scenarioDifference, scenarioInputs, seedDigests } from '../../../scripts/electron-migration/record/g3-inputs.mjs';
import { checkCorpus } from '../../../scripts/electron-migration/record/g3-corpus-check.mjs';
import { buildCompare } from '../../../scripts/electron-migration/record/g3-compare.mjs';
import { stringifyExact } from '../../../scripts/electron-migration/record/json.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const scenario = (id, steps, extra = {}) => ({ id, seed: 'zip', steps, capture: { events: false, db: [] }, normalize: [], ...extra });
const BINDINGS = { file: { portableZip: '/run/files/portable.zip', sealedZip: '/run/files/sealed.zip' }, secret: { sealedZipPassword: 'pw' }, list: ['a', 1] };
const tempRoot = (t, prefix) => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync(`/tmp/opencode/${prefix}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('${seed.*} resolves from the run\'s seed bindings like a service binding: whole values keep their JSON type, embedded ones must be strings', async () => {
  const bindings = { llm: { baseUrl: 'http://llm' }, seed: BINDINGS };
  assert.equal(resolveReferences('${seed.file.portableZip}', [], bindings), '/run/files/portable.zip');
  assert.equal(resolveReferences('zip=${seed.file.sealedZip};pw=${seed.secret.sealedZipPassword}', [], bindings), 'zip=/run/files/sealed.zip;pw=pw');
  assert.equal(stringifyExact(resolveReferences('${seed.list}', [], bindings)), '["a",1]');
  assert.throws(() => resolveReferences('x ${seed.list}', [], bindings), /embedded service binding is not a string: \$\{seed\.list\}/);
  assert.throws(() => resolveReferences('${seed.file.missing}', [], bindings), /unbound reference: \$\{seed\.file\.missing\}/);
  assert.throws(() => resolveReferences('${seed.file.portableZip}', [], { llm: { baseUrl: 'u' } }), /unbound reference/);
  assert.throws(() => resolveReferences('${seed}', [], bindings), /invalid reference|reference is not a prior/);
  assert.equal(usesSeed(scenario('s', [{ cmd: 'a', waitAfter: { channel: 'c', payload: { path: '${seed.file.portableZip}' } } }])), true);
  assert.equal(usesSeed(scenario('s', [{ cmd: 'a', args: { note: 'seed.file' } }])), false);
  validateScenario(scenario('s', [{ cmd: 'a', args: { path: '${seed.file.portableZip}', pw: 'p=${seed.secret.sealedZipPassword}' } }]));

  const steps = [{ cmd: 'data_governance_import_zip', args: { path: '${seed.file.portableZip}', password: '${seed.secret.sealedZipPassword}', url: '${llm.baseUrl}' } }];
  const invoked = [];
  const trace = await executeScenario(scenario('s', steps), {
    bindings,
    eventCount: () => 0,
    async invoke(command, argsRaw) { invoked.push(argsRaw); return { kind: 'result', raw: 'null' }; },
    wait: async () => null,
    capture: async () => ({}),
  });
  assert.deepEqual(invoked, ['{"path":"/run/files/portable.zip","password":"pw","url":"http://llm"}']);
  assert.deepEqual(trace.calls.map(call => call.argsRaw), invoked);
});

test('prepareScenarioRun binds ${seed.*} for its own copy, only for scenarios that read them, and refuses a seed that supplies none', async t => {
  const { createSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const root = tempRoot(t, 'w13-seed-run-');
  const catalog = join(root, 'catalog');
  createSeed('empty', catalog);
  const calls = [];
  const seedBindings = (name, directory) => { calls.push([name, directory]); return { file: { zip: join(directory, 'files', 'z.zip') } }; };
  const reads = scenario('s', [{ cmd: 'a', args: { path: '${seed.file.zip}' } }], { seed: 'empty' });
  const runs = [];
  for (const side of ['A', 'B']) runs.push(await prepareScenarioRun(reads, { catalog, directory: join(root, side, 'run'), seedBindings }));
  for (const [index, side] of ['A', 'B'].entries()) {
    assert.equal(runs[index].seed.directory, join(root, side, 'run'), 'the seed copy is the take\'s run root (N-007)');
    assert.deepEqual(runs[index].bindings, { seed: { file: { zip: join(root, side, 'run', 'files', 'z.zip') } } });
  }
  assert.deepEqual(calls, [['empty', join(root, 'A', 'run')], ['empty', join(root, 'B', 'run')]]);
  const plain = await prepareScenarioRun(scenario('p', [{ cmd: 'a' }], { seed: 'empty' }), { catalog, directory: join(root, 'P', 'run'), seedBindings });
  assert.equal(plain.bindings, null);
  assert.equal(calls.length, 2, 'a scenario without ${seed.*} does not ask for them');
  await assert.rejects(prepareScenarioRun(reads, { catalog, directory: join(root, 'N', 'run'), seedBindings: () => null }),
    /seed empty provides no \$\{seed\.…\} bindings/);
});

test('serviceGap: ${seed.*} needs the scenario\'s seed to supply that key; other namespaces are checked as before', async () => {
  const kinds = await seedBindingKinds('zip', async (name, directory) => (name === 'zip' ? { ...BINDINGS, file: { ...BINDINGS.file, at: join(directory, 'x') } } : null));
  assert.deepEqual(kinds, { 'seed.file.portableZip': 'string', 'seed.file.sealedZip': 'string', 'seed.file.at': 'string',
    'seed.secret.sealedZipPassword': 'string', 'seed.list': 'array' });
  assert.equal(await seedBindingKinds('other', async () => null), null);
  const reads = scenario('s', [{ cmd: 'a', args: { a: '${seed.file.portableZip}', b: 'pw ${seed.secret.sealedZipPassword}', c: '${llm.baseUrl}' } }]);
  assert.equal(serviceGap(reads, { seed: kinds }), null);
  assert.equal(serviceGap(reads), 'seed zip provides no ${seed.…} bindings (a-produced-seeds.ts seedBindings)');
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a', args: { a: '${seed.file.nope}', b: '${seed.file.sealedZip}' } }]), { seed: kinds }),
    'binding ${seed.file.nope} is not provided by seed zip');
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a', args: { a: '${seed.file.sealedZip}', b: '${fixture.x}' } }]), { seed: kinds }),
    'binding namespace ${fixture.…} is not provided by g3-services.mjs');
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a', args: { a: '${mcp.nope}' } }]), { mcp: { 'mcp.url': 'string' }, seed: kinds }),
    'binding ${mcp.nope} is not provided by the MCP service');
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a' }]), { seed: null }), null);
  // This tree: the A-produced historical ZIPs supply their bindings only once a-produced/PROVENANCE.json lists them.
  const provenance = existsSync(join(REPO, 'host/e2e/data-compat/__fixtures__/a-produced/PROVENANCE.json'));
  const real = await seedBindingKinds('l21-historical-zip-v1');
  assert.deepEqual(real, provenance ? { 'seed.file.portableZip': 'string', 'seed.file.sealedZip': 'string', 'seed.secret.sealedZipPassword': 'string' } : null);
  assert.equal(await seedBindingKinds('empty'), null);
});

test('corpus check: ${seed.*} must be a key the scenario\'s seed supplies', async t => {
  const root = tempRoot(t, 'w13-corpus-seed-');
  const dir = join(root, 'host/plugins/x/equivalence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.json'), JSON.stringify({ scenarios: [
    scenario('s.ok', [{ cmd: 'a', args: { p: '${seed.file.portableZip}', q: 'pw=${seed.secret.sealedZipPassword}', l: '${seed.list}' } }]),
    scenario('s.unknown-key', [{ cmd: 'a', args: { p: '${seed.file.nope}' } }]),
    scenario('s.no-bindings', [{ cmd: 'a', args: { p: '${seed.file.portableZip}' } }], { seed: 'empty' }),
    scenario('s.embedded-array', [{ cmd: 'a', args: { p: 'x ${seed.list}' } }]),
  ] }));
  const registry = { seeds: ['empty', 'zip'], llmScripts: [], embeddingModels: [], cloudSeeds: [], rustCommands: new Set(['a']),
    seedBindings: { zip: await seedBindingKinds('zip', async () => BINDINGS), empty: null } };
  const result = await checkCorpus(root, registry);
  assert.deepEqual(result.findings.map(item => [item.kind, item.id, item.detail]), [
    ['bad-reference', 's.unknown-key', '${seed.file.nope}'],
    ['bad-reference', 's.no-bindings', '${seed.file.portableZip}: seed empty provides no ${seed.…} bindings'],
    ['bad-reference', 's.embedded-array', '${seed.list} (array) embedded in "x ${seed.list}"'],
  ]);
  assert.equal(result.blockedScenarios, 3);
});

/** A tree whose seed generator, snapshotter and seedBindings are stubs (seedDigests imports them from `root`). */
function stubTree(root, password) {
  const fixtures = join(root, 'host/e2e/data-compat/__fixtures__');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'scenario-seeds.ts'), [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'export function createSeed(name, catalog) {',
    "  if (name === 'refused') throw new Error(`no seed ${name} in ${catalog}`);",
    '  const directory = join(catalog, name);',
    '  mkdirSync(directory, { recursive: true });',
    "  writeFileSync(join(directory, 'content.txt'), name);",
    '  return { name, directory };',
    '}', ''].join('\n'));
  writeFileSync(join(fixtures, 'database-state.ts'), 'export const snapshotDirectory = () => ({ databases: {} });\nexport const enumerateDatabases = () => [];\n');
  if (password !== undefined) {
    writeFileSync(join(fixtures, 'a-produced-seeds.ts'), [
      "import { join } from 'node:path';",
      'export function seedBindings(name, directory) {',
      `  return name === 'zip' ? { file: { zip: join(directory, 'files', 'z.zip') }, secret: { password: ${JSON.stringify(password)} } } : null;`,
      '}', ''].join('\n'));
  }
  return root;
}

test('fingerprint: a seed\'s ${seed.*} values are an input of the scenarios that read them, and of no other', async t => {
  const base = tempRoot(t, 'w13-seed-digest-');
  const digests = {};
  for (const [name, password] of [['p1', 'one'], ['p2', 'two'], ['none', undefined]]) {
    digests[name] = await seedDigests(stubTree(join(base, name), password), ['zip', 'plain', 'refused']);
  }
  const expected = sha256(stringifyExact({ file: { zip: join('<seed>', 'files', 'z.zip') }, secret: { password: 'one' } }));
  assert.equal(digests.p1.zip.bindings, expected);
  assert.notEqual(digests.p2.zip.bindings, expected, 'the values themselves are the input');
  assert.equal(digests.p2.zip.sha256, digests.p1.zip.sha256, 'the seed content is unchanged');
  assert.deepEqual(Object.keys(digests.p1.plain), ['sha256', 'clockCells'], 'a seed without values has no bindings digest');
  assert.deepEqual(digests.p1.refused, { sha256: null, unavailable: `no seed refused in <catalog>` });
  assert.deepEqual(digests.none, { ...digests.p1, zip: { sha256: digests.p1.zip.sha256, clockCells: {} } }, 'a tree without the module (an older commit) has none');

  const file = 'host/plugins/x/equivalence/seed-refs.json';
  const suite = { scenarios: [scenario('s.reads', [{ cmd: 'a', args: { p: '${seed.file.zip}' } }]), scenario('s.plain', [{ cmd: 'a', args: { p: 'files/z.zip' } }])] };
  const read = path => {
    if (path === file) return Buffer.from(JSON.stringify(suite));
    try { return readFileSync(join(REPO, path)); } catch { return null; }
  };
  const inputs = seeds => scenarioInputs({ read, files: [file], environment: DEFAULT_ENVIRONMENT, seeds, strict: false }).scenarios[file];
  const [one, two, without] = [digests.p1, digests.p2, { zip: { sha256: digests.p1.zip.sha256 } }].map(inputs);
  assert.equal(one['s.reads'].seedBindings, expected);
  assert.equal(without['s.reads'].seedBindings, null, 'reading values the seed does not supply is recorded too (the runners refuse it)');
  assert.deepEqual(scenarioDifference(one['s.reads'], two['s.reads']), ['seedBindings']);
  assert.deepEqual(scenarioDifference(one['s.reads'], without['s.reads']), ['seedBindings']);
  assert.equal('seedBindings' in one['s.plain'], false);
  assert.equal(one['s.plain'].digest, two['s.plain'].digest);
  assert.equal(one['s.plain'].digest, without['s.plain'].digest, 'an existing scenario\'s digest does not depend on any seed\'s values');
});

const COMPARE_SUITE = { scenarios: [{ id: 'zip.import', seed: 'l21-historical-zip-v1', capture: { events: false, db: [] }, normalize: [],
  steps: [{ cmd: 'data_governance_import_zip', args: { path: '${seed.file.portableZip}', password: '${seed.secret.sealedZipPassword}' } }] }] };
const COMPARE_TEXT = JSON.stringify(COMPARE_SUITE);

/** A take of COMPARE_SUITE at `<root>/<take>/trace.json`, its seed copy (and run root) at `<root>/<take>/run`. */
function writeTake(root, take, { file = 'portable.zip', password = 'pw', side = take === 'B' ? 'B' : 'A' } = {}) {
  const run = join(root, take, 'run');
  const path = join(run, 'files', file);
  const empty = { version: 0, databases: {} };
  const trace = { schema: 'wave0-v0-observation', side, scenario: 'zip.import', inputSha256: sha256(COMPARE_TEXT), eventScope: { kind: 'all' },
    before: { events: [], databases: empty },
    calls: [{ command: 'data_governance_import_zip', argsRaw: JSON.stringify({ path, password }),
      outcome: { kind: 'result', raw: JSON.stringify({ imported: path, entries: 3 }) }, capture: { events: [], databases: empty } }],
    after: { events: [], databases: empty }, finalDatabases: empty };
  const traceFile = join(root, take, 'trace.json');
  mkdirSync(dirname(traceFile), { recursive: true });
  writeFileSync(traceFile, JSON.stringify(trace));
  return traceFile;
}

test('compare: ${seed.file.*} paths of each take lie under its own run root and compare equal through N-007; anything else stays a difference', async t => {
  const root = tempRoot(t, 'w13-seed-compare-');
  copyNormalizer(root);
  writeFileSync(join(root, 'suite.json'), COMPARE_TEXT);
  const approvals = rules => {
    const file = join(root, `approvals-${rules.join('-') || 'none'}.json`);
    writeFileSync(file, JSON.stringify({ schema: 'g3-normalize-approvals/v1', rules: rules.map(id => ({ id, decision: 'approved' })) }));
    return file;
  };
  let n = 0;
  const compare = async ({ b = {}, rules = ['N-007'] } = {}) => {
    const dir = join(root, String(n++));
    return buildCompare({ scenarioFile: join(root, 'suite.json'), scenarioId: 'zip.import', root, approvalsFile: approvals(rules),
      aTrace: writeTake(dir, 'A'), a2Trace: writeTake(dir, 'A2'), bTrace: writeTake(dir, 'B', b) });
  };
  const same = await compare();
  assert.deepEqual(same.differences, []);
  assert.equal(same.equal, true);
  const masked = same.normalization.filter(entry => entry.rule === 'N-007');
  assert.deepEqual(masked.map(entry => [entry.side, entry.replaced]), [['A', 2], ['B', 2]], 'the argument and the result path on each side');
  assert.ok(masked.every(entry => entry.runRoot.endsWith(`/${entry.side}/run`)));

  const otherFile = await compare({ b: { file: 'sealed.zip' } });
  assert.equal(otherFile.equal, false);
  assert.deepEqual(otherFile.differences.map(item => [item.kind, item.step]), [['args', 0], ['outcome', 0]]);
  const otherPassword = await compare({ b: { password: 'other' } });
  assert.deepEqual(otherPassword.differences.map(item => [item.kind, item.step]), [['args', 0]]);
  const unmasked = await compare({ rules: [] });
  assert.equal(unmasked.equal, false, 'without N-007 the run roots differ');
});
