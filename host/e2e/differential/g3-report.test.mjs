import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executeScenario } from '../../../scripts/electron-migration/record/scenario-v0.mjs';
import { stringifyExact } from '../../../scripts/electron-migration/record/json.mjs';
import { buildCompare, compareTraces } from '../../../scripts/electron-migration/record/g3-compare.mjs';
import { buildReport, renderMarkdown, scanScenarios, STATUSES, verifyCompare } from '../../../scripts/electron-migration/record/g3-report.mjs';
import { APPROVALS, BATCH, createRunManifest } from '../../../scripts/electron-migration/record/g3-manifest.mjs';
import { NORMALIZER_FILES } from '../../../scripts/electron-migration/record/g3-normalize.mjs';
import { sealRecording } from './__fixtures__/provenance.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const scenario = (id, steps, db = ['*']) => ({ id, seed: 'empty', steps, capture: { events: true, db }, normalize: [] });
const NAMES = ['cmd_blocked', 'cmd_blocked_bad', 'cmd_db', 'cmd_diff', 'cmd_err', 'cmd_excl_bad', 'cmd_excluded',
  'cmd_noargs', 'cmd_none', 'cmd_ok', 'cmd_stale', 'cmd_tamper', 'cmd_unexp', 'cmd_unrun'];

async function fixtureRoot() {
  const root = await mkdtemp('/tmp/opencode/x7-g3-');
  await mkdir(join(root, 'scripts/electron-migration/frontend-audit'), { recursive: true });
  const commands = [...NAMES, 'cmd_added'].map(name => ({ name, kind: 'rust-contract', owner: { lane: 'L-demo' }, rust: { file: 'demo.rs', line: 1 } }));
  commands.push({ name: 'plugin_only', kind: 'plugin-or-platform' });
  await writeFile(join(root, 'scripts/electron-migration/frontend-audit/wave0-inventory.json'), JSON.stringify({
    commit: 'synthetic', baseline: { flaggedApp: NAMES.length, added: ['cmd_added'] }, commands }));
  await mkdir(join(root, 'electron'), { recursive: true });
  for (const file of [APPROVALS, BATCH, ...NORMALIZER_FILES]) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), await readFile(file));
  }
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
  return root;
}

// One real side: every step runs through executeScenario, writing a real SQLite file
// under this side's directory and capturing it with X3 snapshotDirectory.
async function record(root, suiteFile, item, side, behave = {}) {
  const { snapshotDirectory } = await import('../data-compat/__fixtures__/database-state.ts');
  const directory = join(root, 'fixtures/differential/g3/runs', item.id, side);
  await mkdir(join(directory, 'app-data'), { recursive: true });
  const db = new DatabaseSync(join(directory, 'app-data/app.db'));
  db.exec('CREATE TABLE IF NOT EXISTS item(id INTEGER PRIMARY KEY, value TEXT)');
  const events = [];
  try {
    const trace = await executeScenario(item, {
      async invoke(command, raw) {
        const override = behave[command];
        if (override) return override({ db, events, raw });
        if (command === 'cmd_err') return { kind: 'error', raw: '"not found"' };
        if (command === 'cmd_unexp') return { kind: 'error', raw: '"boom"' };
        db.prepare('INSERT INTO item(value) VALUES(?)').run(command);
        events.push({ event: `${command}:done`, payloadRaw: raw });
        return { kind: 'result', raw: `{"command":"${command}","id":9007199254740993}` };
      },
      capture: () => ({ events: structuredClone(events), databases: snapshotDirectory(directory) }),
    });
    trace.inputSha256 = sha(await readFile(join(root, suiteFile)));
    trace.eventScope = { kind: 'all' }; // this synthetic side records every event it emits
    const file = join(directory, 'trace.json');
    await writeFile(file, stringifyExact(trace, 2));
    return file;
  } finally { db.close(); }
}

async function compare(root, suiteFile, item, a, b) {
  const artifact = await buildCompare({ scenarioFile: join(root, suiteFile), scenarioId: item.id, aTrace: a, bTrace: b, root });
  await mkdir(join(root, 'fixtures/differential/g3/runs/compare', item.id), { recursive: true });
  await writeFile(join(root, 'fixtures/differential/g3/runs/compare', item.id, `${item.id}.compare.json`), stringifyExact(artifact, 2));
  return artifact;
}

test('G3 report: five statuses from real A/B traces, evidence hashes, error expectation and recomputation', async () => {
  const root = await fixtureRoot();
  try {
    const owner = 'host/plugins/demo/equivalence/demo.json';
    const writer = 'host/plugins/demo/equivalence/g3w-demo.json';
    const stale = 'host/plugins/demo/equivalence/stale.json';
    const items = {
      ok: scenario('demo.ok', [{ cmd: 'cmd_ok', args: {} }, { cmd: 'cmd_ok', args: { id: '${0.id}' } }]),
      noargs: scenario('demo.noargs', [{ cmd: 'cmd_noargs' }]),
      diff: scenario('demo.diff', [{ cmd: 'cmd_diff', args: {} }]),
      unexp: scenario('demo.unexpected', [{ cmd: 'cmd_unexp', args: {} }]),
      db: scenario('demo.db', [{ cmd: 'cmd_db', args: {} }]),
      tamper: scenario('demo.tamper', [{ cmd: 'cmd_tamper', args: {} }]),
      unrun: scenario('demo.unrun', [{ cmd: 'cmd_unrun', args: {} }, { cmd: 'outside_denominator', args: {} }]),
      blocked: scenario('demo.blocked', [{ cmd: 'cmd_blocked', args: {} }]),
    };
    const err = scenario('g3w.demo.err', [{ cmd: 'cmd_err', args: { id: 'missing' }, expect: 'error' }]);
    const staleItem = scenario('demo.stale', [{ cmd: 'cmd_stale', args: {} }]);
    await mkdir(join(root, 'host/plugins/demo/equivalence'), { recursive: true });
    await writeFile(join(root, owner), JSON.stringify({ domain: 'demo', commands: [], scenarios: Object.values(items) }, null, 2));
    await writeFile(join(root, writer), JSON.stringify({ domain: 'demo', commands: ['cmd_err'],
      scenarios: [err, scenario('bad-prefix', [{ cmd: 'cmd_err', args: {}, expect: 'error' }])] }, null, 2));
    await writeFile(join(root, stale), JSON.stringify({ domain: 'demo', commands: [], scenarios: [staleItem] }));
    await writeFile(join(root, 'host/plugins/demo/equivalence/sidecar.json'), JSON.stringify({ scenarios: { x: { steps: [] } } }));

    const pair = async (file, item, behaveB) => compare(root, file, item,
      await record(root, file, item, 'A'), await record(root, file, item, 'B', behaveB));
    const ok = await pair(owner, items.ok);
    assert.equal(ok.equal, true);
    assert.deepEqual(ok.perCommand, { cmd_ok: { steps: 2, differences: 0 } });
    assert.equal((await pair(owner, items.noargs)).equal, true);
    const diff = await pair(owner, items.diff, { cmd_diff: ({ db, events, raw }) => {
      db.prepare('INSERT INTO item(value) VALUES(?)').run('cmd_diff');
      events.push({ event: 'cmd_diff:done', payloadRaw: raw });
      return { kind: 'result', raw: '{"command":"cmd_diff","id":9007199254740994}' };
    } });
    assert.deepEqual(diff.differences.map(d => d.kind), ['outcome']);
    assert.equal(diff.differences[0].difference.path, '/id');
    const unexpected = await pair(owner, items.unexp);
    assert.deepEqual(unexpected.differences.map(d => [d.kind, d.side]), [['expectation', 'A'], ['expectation', 'B']]);
    const dbDiff = await pair(owner, items.db, { cmd_db: ({ db, events, raw }) => {
      db.prepare('INSERT INTO item(value) VALUES(?)').run('different');
      events.push({ event: 'cmd_db:done', payloadRaw: raw });
      return { kind: 'result', raw: '{"command":"cmd_db","id":9007199254740993}' };
    } });
    assert.deepEqual([...new Set(dbDiff.differences.map(d => d.kind))], ['database']);
    assert.equal(dbDiff.differences[0].sample[0].column, 'value');
    assert.equal((await pair(writer, err)).equal, true);
    assert.equal((await pair(owner, items.tamper)).equal, true);
    await writeFile(join(root, 'fixtures/differential/g3/runs/demo.tamper/B/trace.json'), '{}');
    assert.equal((await pair(stale, staleItem)).equal, true);
    await writeFile(join(root, stale), JSON.stringify({ domain: 'demo', commands: [], scenarios: [staleItem] }, null, 1));

    // Compare refuses evidence that is not same-input or not complete.
    const a = join(root, 'fixtures/differential/g3/runs/demo.ok/A/trace.json');
    const wrong = JSON.parse(await readFile(a, 'utf8'));
    await writeFile(join(root, 'wrong-input.json'), JSON.stringify({ ...wrong, inputSha256: 'x' }));
    await assert.rejects(buildCompare({ scenarioFile: join(root, owner), scenarioId: 'demo.ok', aTrace: a, bTrace: join(root, 'wrong-input.json'), root }), /different input/);
    await writeFile(join(root, 'short.json'), JSON.stringify({ ...wrong, calls: wrong.calls.slice(0, 1) }));
    await assert.rejects(buildCompare({ scenarioFile: join(root, owner), scenarioId: 'demo.ok', aTrace: a, bTrace: join(root, 'short.json'), root }), /incomplete: 1\/2/);

    await mkdir(join(root, 'board'), { recursive: true });
    await writeFile(join(root, 'board/blocker-evidence.md'), 'evidence');
    // Board format (g3-blockers/v1): records under `items`, each with a `blocker` description.
    await writeFile(join(root, 'board/blockers.json'), JSON.stringify({ schema: 'g3-blockers/v1', items: [
      { command: 'cmd_blocked', blocker: 'provider fixture missing', owner: 'L-demo', condition: 'provider ready', reviewer: 'C2-platform', evidence: ['board/blocker-evidence.md'] },
      { command: 'cmd_blocked_bad', owner: 'L-demo', condition: 'x', evidence: ['board/missing.md'] },
      { command: 'cmd_ok', blocker: 'x', owner: 'L-demo', condition: 'x', reviewer: 'C2', evidence: ['board/blocker-evidence.md'] },
    ] }));
    await writeFile(join(root, 'board/excluded.json'), JSON.stringify([
      { command: 'cmd_excluded', reason: 'no-a-command', approvedBy: 'C2-platform', approval: 'D-demo', note: 'A has no handler' },
      { command: 'cmd_excl_bad', reason: 'no-a-command', approvedBy: 'X7-differential', approval: 'self', note: 'not allowed' },
    ]));
    const expected = { count: NAMES.length, sha256: sha(NAMES.join('\n') + '\n') };
    const runsDir = 'fixtures/differential/g3/runs';
    sealRecording(root, runsDir);
    await writeFile(join(root, runsDir, 'RUN-MANIFEST.json'), JSON.stringify(createRunManifest(root, runsDir, scanScenarios(root).suites)));
    const report = await buildReport({ root, runsDir, blockers: 'board/blockers.json', excluded: 'board/excluded.json', expected });
    const status = Object.fromEntries(report.commands.map(row => [row.command, row.status]));
    assert.deepEqual(status, {
      cmd_blocked: 'blocked', cmd_blocked_bad: 'no-scenario', cmd_db: 'fail', cmd_diff: 'fail', cmd_err: 'pass',
      cmd_excl_bad: 'no-scenario', cmd_excluded: 'excluded', cmd_noargs: 'pass', cmd_none: 'no-scenario', cmd_ok: 'pass',
      cmd_stale: 'no-scenario', cmd_tamper: 'no-scenario', cmd_unexp: 'fail', cmd_unrun: 'no-scenario',
    });
    assert.deepEqual(report.totals, { pass: 3, fail: 3, 'no-scenario': 6, blocked: 1, excluded: 1 });
    assert.equal(report.sum, NAMES.length);
    assert.deepEqual(report.passRate, { pass: 3, of: NAMES.length, percent: 21.43 });
    // No known-difference registry in this tree: every fail is a product difference, status unchanged.
    assert.equal(report.inputs.known, null);
    assert.deepEqual(Object.fromEntries(Object.entries(report.failCategories).map(([id, value]) => [id, value.commands])),
      { product: 3, 'a-defect': 0, environment: 0, nondeterministic: 0 });
    assert.equal(report.commands.find(item => item.command === 'cmd_diff').category.summary, 'product');
    assert.equal(report.commands.find(item => item.command === 'cmd_ok').category, null);
    assert.match(renderMarkdown(report), /## fail 归类[^]*\| 真实产品差异 \| 3 \|/);
    assert.deepEqual(report.commandsOutsideDenominator, ['outside_denominator']);
    assert.equal(report.coverage.status, 'not-measured');

    const row = name => report.commands.find(item => item.command === name);
    const okRun = row('cmd_ok').runs[0];
    for (const key of ['scenario', 'A', 'B', 'compare']) {
      assert.equal(okRun.evidence[key].sha256, sha(await readFile(join(root, okRun.evidence[key].file))));
    }
    assert.equal(okRun.evidence.compare.file, 'fixtures/differential/g3/runs/compare/demo.ok/demo.ok.compare.json');
    assert.deepEqual(row('cmd_err').scenarios, { count: 2, owner: 0, g3w: 2, errorSteps: 2, files: [writer] });
    assert.equal(row('cmd_err').note, '1 scenario(s) not yet run');
    assert.match(row('cmd_blocked_bad').note, /blocker without evidence: blocker,reviewer,evidence:board\/missing\.md/);
    assert.match(row('cmd_excl_bad').note, /exclusion incomplete: approvedBy/);
    assert.equal(row('cmd_unrun').note, 'scenario exists, A/B not run');
    assert.equal(row('cmd_none').note, 'no scenario');
    const problems = report.problems.map(p => `${p.kind}:${p.file ?? p.command}:${p.id ?? p.message ?? ''}`);
    assert.ok(problems.includes(`g3w-id-prefix:${writer}:bad-prefix`));
    assert.ok(problems.some(p => p.startsWith('invalid-compare:fixtures/differential/g3/runs/compare/demo.tamper/') && p.includes('B trace sha256 mismatch')));
    assert.ok(problems.some(p => p.startsWith('invalid-compare:fixtures/differential/g3/runs/compare/demo.stale/') && p.includes('stale')));
    assert.equal(report.problems.filter(p => p.kind === 'not-a-v0-suite').length, 0);

    const markdown = renderMarkdown(report);
    assert.match(markdown, /\| 3 \| 3 \| 6 \| 1 \| 1 \| 14 \|/);
    assert.equal(markdown.split('\n').filter(line => /^\| cmd_/.test(line)).length, NAMES.length);
    assert.match(markdown, /\| cmd_ok \| L-demo \| pass \| 1\/0 \| host\/plugins\/demo\/equivalence\/demo\.json@[0-9a-f]{12} \//);

    const bySuite = new Map(scanScenarios(root).suites.map(suite => [suite.file, suite]));
    const compareFile = okRun.evidence.compare.file;
    const staleNormalizer = { ...ok, normalizer: { ...ok.normalizer, sha256: 'old' } };
    await writeFile(join(root, compareFile), stringifyExact(staleNormalizer));
    assert.match((await verifyCompare(root, compareFile, bySuite)).problem.message, /normalizer sha256 mismatch/);
    // The hash covers every normalizer module: an edit to the N-014 module alone makes the same compare stale.
    await writeFile(join(root, compareFile), stringifyExact(ok));
    assert.equal((await verifyCompare(root, compareFile, bySuite)).problem, null);
    const clockModule = join(root, 'scripts/electron-migration/record/g3-normalize-clock.mjs'), clockText = await readFile(clockModule);
    await writeFile(clockModule, `${clockText}\n// edited\n`);
    assert.match((await verifyCompare(root, compareFile, bySuite)).problem.message, /normalizer sha256 mismatch/);
    await writeFile(clockModule, clockText);
    await writeFile(join(root, compareFile), stringifyExact(staleNormalizer));
    // Neither a changed compare nor a missing manifest may silently yield a report.
    await assert.rejects(buildReport({ root, runsDir, expected }), /RUN-MANIFEST mismatch: compares/);
    await rm(join(root, runsDir, 'RUN-MANIFEST.json'));
    await assert.rejects(buildReport({ root, runsDir, expected }), /ENOENT/);

    await assert.rejects(buildReport({ root, expected: { count: NAMES.length, sha256: 'drift' } }), /denominator drift/);
  } finally { await rm(root, { recursive: true }); }
});

test('G3 report CLI on this repository: 768 denominator, five statuses sum, Markdown equals JSON', async () => {
  const out = await mkdtemp('/tmp/opencode/x7-g3-repo-');
  try {
    const empty = join(out, 'no-runs');
    await mkdir(join(empty, 'compare'), { recursive: true });
    execFileSync(process.execPath, ['scripts/electron-migration/record/g3-report.mjs', '--runs', empty, '--write-manifest']);
    const summary = JSON.parse(execFileSync(process.execPath, ['scripts/electron-migration/record/g3-report.mjs',
      '--runs', empty, '--blockers', join(out, 'none.json'), '--excluded', join(out, 'none.json'), '--out', out], { encoding: 'utf8' }));
    const report = JSON.parse(await readFile(join(out, 'g3-report.json'), 'utf8'));
    assert.equal(report.denominator.count, 768);
    assert.equal(report.denominator.sha256, '4f47fa0afb7d4797ff46ccc82db860eaf7109a5114dd4f7edd9ff6f50d7d718e');
    assert.equal(STATUSES.reduce((n, s) => n + report.totals[s], 0), 768);
    assert.equal(report.commands.length, 768);
    assert.deepEqual(summary.totals, report.totals);
    // No run artifacts were given, so nothing may pass or fail.
    assert.equal(report.totals.pass + report.totals.fail, 0);
    assert.ok(report.withScenario > 0);
    assert.equal(report.problems.filter(p => p.kind === 'invalid-scenario').length, 0);
    const markdown = await readFile(join(out, 'g3-report.md'), 'utf8');
    assert.equal(markdown, renderMarkdown(report));
    const t = report.totals;
    assert.ok(markdown.includes(`| ${t.pass} | ${t.fail} | ${t['no-scenario']} | ${t.blocked} | ${t.excluded} | 768 |`));
  } finally { await rm(out, { recursive: true }); }
});

test('G3 compare event scope: named A scope is rebuilt from B ids; unscoped and late channels are out of scope, not equal', () => {
  const item = scenario('scope', [{ cmd: 'create' }, { cmd: 'send', args: { sessionId: '${0.id}' } }], []);
  const ev = (event, payload) => ({ event, payloadRaw: JSON.stringify(payload) });
  const trace = (id, events, eventScope) => {
    const [boot, create, send] = events;
    return { schema: 'wave0-v0-observation', scenario: 'scope', eventScope,
      before: { events: boot },
      calls: [
        { command: 'create', argsRaw: '{}', outcome: { kind: 'result', raw: JSON.stringify({ id }) }, capture: { events: [...boot, ...create] } },
        { command: 'send', argsRaw: JSON.stringify({ sessionId: id }), outcome: { kind: 'result', raw: 'null' }, capture: { events: [...boot, ...create, ...send] } },
      ],
      after: { events: [...boot, ...create, ...send] } };
  };
  const named = { kind: 'named', since: { 'app-ready': -1, chat_s_A: 1 },
    derived: { chat_s_A: { pattern: 'chat_{}', step: 1, field: 'args', pointer: '/sessionId' } } };
  // B also emits on its id channel during create (A could not listen yet) and on an unknown channel.
  const a = trace('s_A', [[ev('app-ready', 1)], [], [ev('chat_s_A', { seq: 0 })]], named);
  const b = trace('s_B', [[ev('app-ready', 1)], [ev('chat_s_B', { early: true })], [ev('chat_s_B', { seq: 0 }), ev('internal_s_B', 1)]], { kind: 'all' });
  const outOfScope = [];
  const differences = compareTraces(item, a, b, a, b, outOfScope);
  assert.deepEqual(differences.map(d => [d.step, d.kind]), [[0, 'outcome'], [1, 'args']]);
  assert.deepEqual(outOfScope.map(o => `${o.side}:${o.event}`), ['B:chat_s_B', 'B:internal_s_B']);
  // A payload difference on the rebuilt channel is a real events difference.
  const changed = trace('s_B', [[ev('app-ready', 1)], [], [ev('chat_s_B', { seq: 1 })]], { kind: 'all' });
  assert.ok(compareTraces(item, a, changed).some(d => d.kind === 'events' && d.step === 1));
  // Missing eventScope is a runner defect, never a silent full compare.
  assert.throws(() => compareTraces(item, { ...a, eventScope: undefined }, b), /eventScope/);
});
