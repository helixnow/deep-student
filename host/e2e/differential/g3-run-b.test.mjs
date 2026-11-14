import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseExact, stringifyExact } from '../../../scripts/electron-migration/record/json.mjs';
import { buildCompare } from '../../../scripts/electron-migration/record/g3-compare.mjs';
import { IDENTIFIER, runScenarioB, unsupported } from '../../../scripts/electron-migration/record/g3-run-b.mjs';

const CORPUS = 'host/plugins/qbank/equivalence/questions-crud.json';
const STREAMING = 'host/e2e/streaming/wave0/streaming.scenarios.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function prepare() {
  const root = await mkdtemp('/tmp/opencode/x7-g3b-');
  const { createSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const catalog = join(root, 'catalog');
  createSeed('empty', catalog);
  return { root, catalog };
}

test('B runner: real desktop-profile Host records a qbank corpus scenario; self-compare is equal (not A/B parity)', async () => {
  const { root, catalog } = await prepare();
  const suite = parseExact(await readFile(CORPUS, 'utf8'));
  const scenario = suite.scenarios.find(item => item.id === 'qbank.create.sparse_defaults');
  assert.equal(unsupported(scenario), null);
  const directory = join(root, scenario.id, 'B');
  await mkdir(directory, { recursive: true });
  const trace = await runScenarioB(scenario, { scenarioFile: CORPUS, catalog, directory: join(directory, 'run') });

  assert.equal(trace.schema, 'wave0-v0-observation');
  assert.equal(trace.side, 'B');
  assert.equal(trace.inputSha256, sha(await readFile(CORPUS)));
  assert.deepEqual(trace.eventScope, { kind: 'all' });
  assert.deepEqual(trace.hostExit, { code: 0, signal: null });
  assert.equal(trace.host.profile, 'host/profiles/desktop.json');
  assert.ok(trace.host.appDataDir.endsWith(`/app-data/${IDENTIFIER}`));
  // G3-STARTUP on the real Host: settles after the 6 s maintenance, the setup command is
  // registered, and nothing periodic reaches the scenario's windows.
  assert.equal(trace.startup.rule, 'G3-STARTUP/v1');
  assert.equal(trace.startup.settle.settled, true, JSON.stringify(trace.startup.settle));
  assert.ok(trace.startup.settle.sinceReadyMs >= 8_000);
  assert.equal(trace.startup.setup.command, 'vfs_set_indexing_config');
  assert.equal(trace.startup.setup.outcome.kind, 'result', trace.startup.setup.outcome.raw);
  assert.equal(trace.startup.quiet.settled, true);
  assert.ok(Array.isArray(trace.startup.events));
  assert.deepEqual(trace.before.events, [], 'no Host event between the boundary and the before capture');
  // The Host's compile cache is beside the seed copy, not in its TMPDIR.
  assert.equal(existsSync(join(directory, 'node-compile-cache')), true);
  assert.equal(existsSync(join(directory, 'run', 'tmp', 'node-compile-cache')), false);
  assert.equal(trace.calls.length, scenario.steps.length);
  for (const [index, call] of trace.calls.entries()) {
    assert.equal(call.command, scenario.steps[index].cmd);
    assert.equal(call.outcome.kind, 'result', call.outcome.raw);
    assert.equal(call.capture.databases.version, 0);
    assert.ok(Object.keys(call.capture.databases.databases).some(name => name.startsWith(`app-data/${IDENTIFIER}/`)));
  }
  // The created question is readable by id on the same Host.
  const created = JSON.parse(trace.calls[1].outcome.raw);
  assert.equal(JSON.parse(trace.calls[2].outcome.raw).id, created.id);

  const file = join(directory, 'trace.json');
  await writeFile(file, stringifyExact(trace, 2) + '\n');
  const artifact = await buildCompare({ scenarioFile: CORPUS, scenarioId: scenario.id, aTrace: file, bTrace: file, root: process.cwd() });
  assert.equal(artifact.equal, true, JSON.stringify(artifact.differences).slice(0, 2000));
});

test('B runner CLI: unknown step fields are reported unsupported without a trace; unknown command is a recorded error', async () => {
  const { root } = await prepare();
  const rawFile = join(root, 'raw-body.json');
  await writeFile(rawFile, JSON.stringify({ domain: 'x7-test', commands: ['get_app_version'], scenarios: [{
    id: 'x7.raw-body', seed: 'empty', capture: { events: true, db: ['*'] }, normalize: [],
    steps: [{ cmd: 'get_app_version', rawBody: 'AAEC' }] }] }));
  const raw = parseExact(await readFile(rawFile, 'utf8')).scenarios[0];
  assert.match(unsupported(raw), /rawBody/);
  assert.equal(unsupported(parseExact(await readFile(STREAMING, 'utf8')).scenarios[0]), null);
  const out = join(root, 'raw');
  execFileSync(process.execPath, ['scripts/electron-migration/record/g3-run-b.mjs', rawFile, out]);
  const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].status, 'unsupported');
  assert.equal(existsSync(join(out, raw.id)), false);

  const unknownFile = join(root, 'unknown.json');
  await writeFile(unknownFile, JSON.stringify({ domain: 'x7-test', commands: ['x7_no_such_command'], scenarios: [{
    id: 'x7.unknown-command', seed: 'empty', capture: { events: true, db: ['*'] }, normalize: [],
    steps: [{ cmd: 'x7_no_such_command', args: { value: 1 }, expect: 'error' }] }] }));
  const unknownOut = join(root, 'unknown');
  execFileSync(process.execPath, ['scripts/electron-migration/record/g3-run-b.mjs', unknownFile, unknownOut]);
  const unknown = JSON.parse(await readFile(join(unknownOut, 'summary.json'), 'utf8'));
  assert.equal(unknown.runs[0].status, 'recorded', unknown.runs[0].reason);
  const trace = parseExact(await readFile(unknown.runs[0].trace, 'utf8'));
  assert.equal(trace.calls[0].outcome.kind, 'error');
  assert.match(trace.calls[0].outcome.raw, /x7_no_such_command/);
});
