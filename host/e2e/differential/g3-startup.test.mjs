import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyNormalizer } from './__fixtures__/normalizer.mjs';
import { tmpdir } from 'node:os';
import { SETUP, STARTUP, STARTUP_RULE, runStartup, settleStartup } from '../../../scripts/electron-migration/record/g3-startup.mjs';
import { QUIET } from '../../../scripts/electron-migration/record/g3-quiet.mjs';
import { buildCompare, recorderDifferences } from '../../../scripts/electron-migration/record/g3-compare.mjs';

/** Virtual clock: sleep advances time and runs scheduled side effects. */
function clock(effects = [], start = 0) {
  let now = start;
  return {
    now: () => now,
    sleep: async ms => { now += ms; for (const effect of effects) if (!effect.done && now >= effect.at) { effect.done = true; effect.run(); } },
  };
}
const event = (name, payload = null) => ({ event: name, payloadRaw: JSON.stringify(payload) });

test('settle waits at least settleMs after ready even when nothing moves', async () => {
  const c = clock([], 1_000);
  const result = await settleStartup({ events: () => [], fingerprint: () => 'same', readyAt: 1_000, now: c.now, sleep: c.sleep });
  assert.equal(result.settled, true);
  assert.ok(result.sinceReadyMs >= STARTUP.settleMs + STARTUP.windowMs, `${result.sinceReadyMs}`);
  assert.ok(result.sinceReadyMs < STARTUP.settleMs + STARTUP.windowMs + 2 * STARTUP.pollMs);
});

test('settle covers the 6 s Lance maintenance and anything it triggers after the minimum (A and B alike)', async () => {
  let db = 0;
  const events = [];
  // Maintenance writes at 6 s; a slow store creation finishes at 8.4 s; a late event at 8.9 s.
  const c = clock([{ at: 6_000, run: () => db++ }, { at: 8_400, run: () => db++ }, { at: 8_900, run: () => events.push(event('lance-optimized')) }]);
  const result = await settleStartup({ events: () => events, fingerprint: () => String(db), readyAt: 0, now: c.now, sleep: c.sleep });
  assert.equal(result.settled, true);
  assert.ok(result.sinceReadyMs >= 8_900 + STARTUP.windowMs, `${result.sinceReadyMs}`);
});

test('settle is bounded and says so when startup never goes still', async () => {
  let db = 0;
  const c = clock();
  const result = await settleStartup({ events: () => [], fingerprint: () => String(db++), readyAt: 0, now: c.now, sleep: c.sleep });
  assert.equal(result.settled, false);
  assert.ok(result.sinceReadyMs >= STARTUP.maxMs && result.sinceReadyMs < STARTUP.maxMs + STARTUP.pollMs * 2);
});

test('runStartup: events before the boundary are startup evidence; setup runs after settle; an error outcome is recorded, not thrown', async () => {
  const events = [event('data-governance-migration-status', { phase: 'done' })];
  const calls = [];
  const c = clock([{ at: 6_000, run: () => events.push(event('backup-job-progress', { status: 'idle' })) }]);
  const startup = await runStartup({ events: () => events, fingerprint: () => 'same', readyAt: 0, now: c.now, sleep: c.sleep,
    invoke: async (command, argsRaw) => {
      calls.push({ command, argsRaw, at: c.now() });
      events.push(event('setup-echo'));
      // Recovery mode: the vfs commands are not registered yet.
      return { kind: 'error', raw: '{"code":"COMMAND_NOT_FOUND","message":"vfs_set_indexing_config"}' };
    } });
  assert.deepEqual(calls.map(call => [call.command, call.argsRaw]), [[SETUP.command, SETUP.argsRaw]]);
  assert.ok(calls[0].at >= STARTUP.settleMs + STARTUP.windowMs, 'setup runs after the settle window, as on A before');
  assert.equal(startup.boundary, 3);
  assert.equal(startup.record.rule, STARTUP_RULE);
  assert.deepEqual(startup.record.events.map(item => item.event), ['data-governance-migration-status', 'backup-job-progress', 'setup-echo']);
  assert.equal(startup.record.setup.outcome.kind, 'error');
  assert.equal(startup.record.quiet.rule, 'N-013');
  assert.equal(startup.record.quiet.settled, true);
  events.push(event('scenario-event'));
  assert.deepEqual(events.slice(startup.boundary).map(item => item.event), ['scenario-event']);
  assert.equal(startup.record.events.length, 3, 'the record is a copy at the boundary');
});

test('runStartup: a transport failure of the setup is a recorder failure', async () => {
  const c = clock();
  await assert.rejects(runStartup({ events: () => [], fingerprint: () => 'x', readyAt: 0, now: c.now, sleep: c.sleep,
    limits: { ...STARTUP, settleMs: 0 }, quiet: QUIET, invoke: async () => ({ kind: 'timeout' }) }), /missing raw IPC outcome/);
});

test('both recorders run the same startup barrier and slice every capture list at its boundary', async () => {
  for (const file of ['g3-run-a.mjs', 'g3-run-b.mjs']) {
    const source = await readFile(new URL(`../../../scripts/electron-migration/record/${file}`, import.meta.url), 'utf8');
    assert.match(source, /import \{ runStartup \} from '\.\/g3-startup\.mjs'/, file);
    assert.match(source, /const startup = await runStartup\(/, file);
    assert.match(source, /const scenarioEvents = \(\) => [a-z.()]+\.slice\(startup\.boundary\)/, file);
    assert.match(source, /eventCount: \(\) => scenarioEvents\(\)\.length/, file);
    assert.match(source, /waitForEvent\(spec, scenarioEvents, [^)]*\{ since \}\)/, file);
    assert.match(source, /quiesce\(\{ events: scenarioEvents,/, file);
    assert.match(source, /events: (?:structuredClone\()?scenarioEvents\(\)/, file);
    assert.match(source, /startup: (?:structuredClone\()?startup\.record/, file);
    // No side-specific sleeps or setup of its own.
    assert.doesNotMatch(source, /setTimeout\(resolve, 8000\)/, file);
    assert.doesNotMatch(source, /'vfs_set_indexing_config'/, file);
  }
  const a = await readFile(new URL('../../../scripts/electron-migration/record/g3-run-a.mjs', import.meta.url), 'utf8');
  // A subscribes before the settle starts, like B's fork-time stream.
  assert.ok(a.indexOf('await listen(events.names, -1, null)') < a.indexOf('await runStartup('));
});

const SUITE = { scenarios: [{ id: 'startup.probe', seed: 'empty', capture: { events: false, db: [] }, normalize: [], steps: [{ cmd: 'get_app_version', args: {} }] }] };
const SUITE_TEXT = JSON.stringify(SUITE);
const trace = (side, { startup = null, after = {} } = {}) => ({ schema: 'wave0-v0-observation', side, scenario: 'startup.probe',
  inputSha256: createHash('sha256').update(SUITE_TEXT).digest('hex'), eventScope: { kind: 'all' },
  ...(startup ? { startup } : {}), before: { events: [] },
  calls: [{ command: 'get_app_version', argsRaw: '{}', outcome: { kind: 'result', raw: '"0.11.0"' }, capture: { events: [] } }],
  after: { events: [], ...after } });
const startupRecord = (kind, raw = 'null', rule = STARTUP_RULE) => ({ rule, settle: { settled: true }, setup: { command: SETUP.command, argsRaw: SETUP.argsRaw, outcome: { kind, raw } },
  quiet: { rule: 'N-013', settled: true }, events: [] });

test('compare: takes recorded under different startup protocols are refused; setup outcome and service idleness are compared raw', async t => {
  const root = await mkdtemp(join(tmpdir(), 'w13-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'suite.json'), SUITE_TEXT);
  copyNormalizer(root);
  let n = 0;
  const compare = async (a, b, a2 = null) => {
    const write = async (name, value) => { const file = join(root, `${n++}.${name}.json`); await writeFile(file, JSON.stringify(value)); return file; };
    return buildCompare({ scenarioFile: join(root, 'suite.json'), scenarioId: 'startup.probe', root, aTrace: await write('A', a), bTrace: await write('B', b),
      ...(a2 ? { a2Trace: await write('A2', a2) } : {}) });
  };
  // Old A store (no startup record) against a new B: different windows, no artifact.
  await assert.rejects(compare(trace('A'), trace('B', { startup: startupRecord('result') })), /startup protocol differs between takes \(A=none, B=G3-STARTUP\/v1\)/);
  await assert.rejects(compare(trace('A', { startup: startupRecord('result', 'null', 'G3-STARTUP/v0') }), trace('B', { startup: startupRecord('result') })), /startup protocol differs/);
  // Legacy pairs (neither side has a record) still recompute.
  assert.equal((await compare(trace('A'), trace('B'))).equal, true);

  const same = await compare(trace('A', { startup: startupRecord('result') }), trace('B', { startup: startupRecord('result') }));
  assert.equal(same.equal, true, JSON.stringify(same.differences));
  assert.deepEqual(same.startup.B, { rule: STARTUP_RULE, settled: true, setup: 'result', events: 0 });

  // Recovery mode on one side only: the setup command is missing there.
  const recovery = await compare(trace('A', { startup: startupRecord('result') }), trace('B', { startup: startupRecord('error', '{"code":"COMMAND_NOT_FOUND"}') }));
  assert.equal(recovery.equal, false);
  assert.deepEqual(recovery.differences.map(item => [item.kind, item.setupCommand, item.a, item.b]), [['startup-setup', SETUP.command, 'result', 'error']]);
  const raw = recorderDifferences(trace('A', { startup: startupRecord('result', '{"interval":86400}') }), trace('B', { startup: startupRecord('result', '{"interval":5}') }));
  assert.deepEqual(raw.map(item => item.kind), ['startup-setup']);

  // MCP: a stdio child still alive at the after capture on one side only is a difference.
  const idle = { mcp: { phase: 'after', idle: true, open: 0, liveStdio: 0, waitedMs: 5 } };
  const busy = { mcp: { phase: 'after', idle: false, open: 0, liveStdio: 1, waitedMs: 15_000 } };
  const services = await compare(trace('A', { startup: startupRecord('result'), after: { services: busy } }), trace('B', { startup: startupRecord('result'), after: { services: idle } }));
  assert.deepEqual(services.differences.map(item => [item.kind, item.a?.liveStdio, item.b?.liveStdio]), [['service-idle', 1, 0]]);
  const missing = recorderDifferences(trace('A', { after: { services: idle } }), trace('B'));
  assert.deepEqual(missing.map(item => [item.kind, item.missing]), [['service-idle', 'B']]);
  assert.deepEqual(recorderDifferences(trace('A', { after: { services: idle } }), trace('B', { after: { services: { mcp: { ...idle.mcp, waitedMs: 900 } } } })), [],
    'how long the wait took is not behaviour');
});
