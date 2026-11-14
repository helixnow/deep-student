#!/usr/bin/env node
// Managed G3 recording run (replaces the one-off ops/ser38/g3-night.py): preflight, one
// supervised g3-batch over a frozen tree, optional coverage, a fresh manifest seal and the
// report, then a terminal receipt (SUPERVISOR-RESULT.json, written atomically and kept
// current while running). Safe to rerun with the same intent on the same --out: admitted
// shards are reused, rejected ones rerun, an existing seal is kept aside, not overwritten.
//   node scripts/electron-migration/record/g3-supervise.mjs --tree DIR --b-commit SHA \
//     --a-receipt FILE [--a-receipt-sha256 SHA] --out DIR [--phase smoke|full] [--file SUITE ...]
//     [--sides A,B,A2] [--workers-a N] [--workers-b N] [--workers-a2 N] [--workers-compare N]
//     [--shard-size K] [--shard-timeout-min M] [--compare-timeout-min M] [--total-timeout-min M]
//     [--deadline-min M] [--kill-grace-s S] [--coverage] [--no-report] [--report-jobs N]
//     [--verify-binary] [--dry-run] [--retry-errors] [--retry-errors-before ISO] [--retry-infra-errors]
// The retry flags go to g3-batch unchanged (operational, not identity: a rerun on the same --out
// may add them). Infrastructure runner errors (g3-failures.mjs: EAGAIN, thread creation) make
// the run incomplete; scenario runner errors are findings and stay in the report.
// Decoupled modes (g3-batch --mode):
//   --mode a-store --commit SHA --a-receipt FILE --out STORE [--domain D,...] [--file SUITE ...] [--scenario ID ...]
//     [--top-up-from B_OUT/a-store-coverage.json | g3-a-stale.json]  (a top-up store: only the stale-a/missing scenarios listed there)
//     A/A2 only; no B commit. Verdict covers store provenance (A-STORE.json) and coverage; no report.
//   --mode b-only --b-commit SHA --a-store STORE --a-store-sha256 HEX [...] --out DIR [--domain D,...]
//     B only, all workers on B; preflight checks each pinned store; report (with --domain scope).
//     Suites or scenarios without matching A/A2 make the run incomplete and are named.
//   [--tz ZONE] [--locale LOCALE] pin the worker environment (default UTC, C.UTF-8); part of identity.
// Exit: 0 complete · 2 preflight failed · 3 incomplete (rejected shards, compare errors,
// deferred shards, A/A2 unavailable) · 4 failed (batch crash/timeout, provenance or report failure) · 143/130 stopped.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { processRecord, startSupervised } from './supervise.mjs';
import { A_STORE_FILE, A_STORE_SCHEMA, recordingDefects, storeDefects, storeReceipts } from './g3-provenance.mjs';
import { pinnedEnvironment } from './g3-inputs.mjs';
import { loadApprovals } from './g3-normalize.mjs';
import { scanRunnerErrors } from './g3-failures.mjs';

const APPROVALS = 'fixtures/differential/g3/normalize-approvals.json';

export const SUPERVISOR_SCHEMA = 'g3-supervisor/v1';
export const RESULT_SCHEMA = 'g3-supervisor-result/v1';
export const EXIT = { complete: 0, 'preflight-failed': 2, incomplete: 3, failed: 4 };
const PHASES = {
  combined: {
    smoke: { workers: { a: 1, b: 1, a2: 1, compare: 1 }, shardTimeoutMin: 20, totalTimeoutMin: 90 },
    full: { workers: { a: 2, b: 2, a2: 2, compare: 1 }, shardTimeoutMin: 30, totalTimeoutMin: 420 },
  },
  'a-store': {
    smoke: { workers: { a: 1, b: null, a2: 1, compare: null }, shardTimeoutMin: 20, totalTimeoutMin: 90 },
    full: { workers: { a: 3, b: null, a2: 3, compare: null }, shardTimeoutMin: 30, totalTimeoutMin: 840 },
  },
  'b-only': {
    smoke: { workers: { a: null, b: 2, a2: null, compare: 1 }, shardTimeoutMin: 20, totalTimeoutMin: 90 },
    full: { workers: { a: null, b: 6, a2: null, compare: 2 }, shardTimeoutMin: 30, totalTimeoutMin: 480 },
  },
};
// mount: the worker's private MCP directory (g3-worker.mjs NAMESPACE_INIT).
const TOOLS = ['nice', 'unshare', 'bash', 'xvfb-run', 'dbus-run-session', 'ip', 'mount'];
// B (Host under Node) needs no X server or session bus.
const B_TOOLS = ['nice', 'unshare', 'bash', 'ip', 'mount'];
const BATCH = 'scripts/electron-migration/record/g3-batch.mjs';
const REPORT = 'scripts/electron-migration/record/g3-report.mjs';
const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const atomicJson = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n'); renameSync(`${file}.tmp`, file); };

export function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string', default: 'combined' }, commit: { type: 'string' },
    'a-store': { type: 'string', multiple: true }, 'a-store-sha256': { type: 'string', multiple: true },
    domain: { type: 'string', multiple: true }, tz: { type: 'string' }, locale: { type: 'string' },
    tree: { type: 'string' }, 'b-commit': { type: 'string' }, 'a-receipt': { type: 'string' }, 'a-receipt-sha256': { type: 'string' },
    out: { type: 'string' }, phase: { type: 'string', default: 'full' }, file: { type: 'string', multiple: true },
    scenario: { type: 'string', multiple: true }, 'top-up-from': { type: 'string' },
    sides: { type: 'string' }, 'workers-a': { type: 'string' }, 'workers-b': { type: 'string' }, 'workers-a2': { type: 'string' },
    'workers-compare': { type: 'string' }, 'shard-size': { type: 'string', default: '10' }, 'shard-timeout-min': { type: 'string' },
    'compare-timeout-min': { type: 'string', default: '15' }, 'total-timeout-min': { type: 'string' }, 'deadline-min': { type: 'string' },
    'kill-grace-s': { type: 'string', default: '30' }, coverage: { type: 'boolean' }, 'no-report': { type: 'boolean' },
    'report-jobs': { type: 'string', default: '4' }, 'verify-binary': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'retry-errors': { type: 'boolean' }, 'retry-errors-before': { type: 'string' }, 'retry-infra-errors': { type: 'boolean' } } });
  const mode = values.mode;
  if (!PHASES[mode]) throw new Error('--mode is combined, a-store or b-only');
  const required = { combined: ['tree', 'b-commit', 'a-receipt', 'out'], 'a-store': ['tree', 'commit', 'a-receipt', 'out'], 'b-only': ['tree', 'b-commit', 'a-store', 'out'] }[mode];
  const missing = required.filter(key => !values[key]);
  if (missing.length) throw new Error(`required: ${missing.map(key => `--${key}`).join(' ')}`);
  const refused = { combined: ['commit', 'a-store', 'a-store-sha256', 'domain', 'scenario', 'top-up-from'], 'a-store': ['b-commit', 'a-store', 'a-store-sha256'],
    'b-only': ['commit', 'a-receipt', 'a-receipt-sha256', 'coverage', 'verify-binary', 'scenario', 'top-up-from'] }[mode].filter(key => values[key] !== undefined);
  if (refused.length) throw new Error(`--mode ${mode} does not take ${refused.map(key => `--${key}`).join(' ')}`);
  if (mode === 'b-only' && (values['a-store-sha256'] ?? []).length !== values['a-store'].length) throw new Error('every --a-store needs its --a-store-sha256 (same order)');
  const phase = PHASES[mode][values.phase];
  if (!phase) throw new Error('--phase is smoke or full');
  const commit = mode === 'a-store' ? values.commit : values['b-commit'];
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--${mode === 'a-store' ? 'commit' : 'b-commit'} must be a full 40-hex commit`);
  // Combined runs keep --file as recording intent; the decoupled modes select operationally.
  if (mode === 'combined' && values.phase === 'smoke' && !values.file?.length) throw new Error('--phase smoke needs at least one --file');
  if (mode === 'combined' && values.phase === 'full' && values.file?.length) throw new Error('--phase full records the whole corpus; use --phase smoke for --file subsets');
  const number = (key, fallback) => {
    if (fallback === null && values[key] === undefined) return null;
    const value = values[key] === undefined ? fallback : Number(values[key]);
    if (!(value > 0)) throw new Error(`--${key} must be positive`);
    return value;
  };
  const tree = resolve(values.tree);
  const sides = values.sides ?? { combined: 'A,B,A2', 'a-store': 'A,A2', 'b-only': 'B' }[mode];
  // --top-up-from: the stale-a and missing scenarios a b-only run listed in its a-store-coverage.json,
  // or g3-a-stale --json listed for this commit (--to it, or its clean working tree).
  let topUp = [];
  if (values['top-up-from']) {
    if (values.file || values.scenario) throw new Error('--top-up-from selects the scenarios itself; drop --file/--scenario');
    const coverage = JSON.parse(readFileSync(values['top-up-from'], 'utf8'));
    if (!['g3-a-store-coverage/v2', 'g3-a-stale/v1'].includes(coverage.schema)) throw new Error(`--top-up-from needs a g3-a-store-coverage/v2 or g3-a-stale/v1 file, got ${coverage.schema}`);
    const to = coverage.to ?? {};
    const ofCommit = to.kind === 'commit' ? to.commit === values.commit : to.kind === 'worktree' && to.head === values.commit && to.dirty?.length === 0;
    if (coverage.schema === 'g3-a-stale/v1' && !ofCommit) {
      throw new Error(`--top-up-from: that g3-a-stale report is not of the clean working tree at ${values.commit} nor --to it (to: ${JSON.stringify(coverage.to)})`);
    }
    topUp = coverage.topUpScenarios ?? [];
    if (!topUp.length) throw new Error('--top-up-from: nothing to top up');
  }
  const files = [...new Set([...(values.file ?? []), ...topUp.map(item => item.file)])].sort();
  const scenarios = [...new Set([...(values.scenario ?? []), ...topUp.map(item => item.id)])].sort();
  const domains = [...new Set((values.domain ?? []).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))];
  const environment = pinnedEnvironment({ tz: values.tz, locale: values.locale });
  let retryBefore = null;
  if (values['retry-errors-before'] !== undefined) {
    const at = Date.parse(values['retry-errors-before']);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(values['retry-errors-before']) || Number.isNaN(at)) throw new Error('--retry-errors-before needs an ISO 8601 time (e.g. 2026-11-07T09:55:00+08:00)');
    retryBefore = new Date(at).toISOString();
  }
  const identity = mode === 'combined'
    ? { tree, bCommit: commit, aReceipt: resolve(values['a-receipt']), phase: values.phase, files, sides, shardSize: number('shard-size') }
    : mode === 'a-store'
      ? { mode, tree, commit, aReceipt: resolve(values['a-receipt']), phase: values.phase, sides, shardSize: number('shard-size'), environment }
      : { mode, tree, bCommit: commit, phase: values.phase, sides, shardSize: number('shard-size'), environment };
  return {
    mode, identity,
    ops: { workers: { a: number('workers-a', phase.workers.a), b: number('workers-b', phase.workers.b), a2: number('workers-a2', phase.workers.a2),
      compare: number('workers-compare', phase.workers.compare) },
    shardTimeoutMin: number('shard-timeout-min', phase.shardTimeoutMin), compareTimeoutMin: number('compare-timeout-min'),
    totalTimeoutMin: number('total-timeout-min', phase.totalTimeoutMin), deadlineMin: values['deadline-min'] ? number('deadline-min') : null,
    killGraceS: number('kill-grace-s'), coverage: Boolean(values.coverage), report: mode !== 'a-store' && !values['no-report'], reportJobs: number('report-jobs'),
    verifyBinary: Boolean(values['verify-binary']),
    retry: { errors: Boolean(values['retry-errors']), before: retryBefore, infrastructure: Boolean(values['retry-infra-errors']) },
    ...(mode === 'combined' ? {} : { files, domains }),
    ...(scenarios.length ? { scenarios } : {}),
    ...(mode === 'b-only' ? { aStores: values['a-store'].map((dir, index) => ({ dir: resolve(dir), sha256: values['a-store-sha256'][index] })) } : {}),
    ...(values.tz || values.locale ? { tz: values.tz ?? null, locale: values.locale ?? null } : {}) },
    aReceiptSha256: values['a-receipt-sha256'] ?? null, out: resolve(values.out), dryRun: Boolean(values['dry-run']),
  };
}

async function digestFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

/** Every precondition, each with a verdict and detail; nothing is written. */
export async function preflight({ mode = 'combined', identity, ops, aReceiptSha256, out }) {
  const checks = [];
  const check = (name, ok, detail = null) => { checks.push({ name, ok: Boolean(ok), detail }); return ok; };
  const uid = process.getuid?.() ?? null;
  // Root-run git leaves root-owned files in dsdev repositories (00:57 smoke failure, W11 1.2).
  check('not-root', uid !== 0, { uid });
  const treeOk = check('tree', existsSync(identity.tree) && statSync(identity.tree).isDirectory(), identity.tree);
  if (treeOk) {
    const git = spawnSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: identity.tree, encoding: 'utf8' });
    if (check('git-readable', git.status === 0, git.status === 0 ? null : git.stderr.trim().slice(0, 800))) {
      const head = git.stdout.trim();
      if (mode === 'a-store') check('commit', head === identity.commit, { head, expected: identity.commit });
      else check('b-commit', head === identity.bCommit, { head, expected: identity.bCommit });
      const dirty = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd: identity.tree, encoding: 'utf8' }).trim();
      check('clean-tree', !dirty, dirty ? dirty.split('\n').slice(0, 20) : null);
    }
    for (const file of identity.files ?? ops.files ?? []) check(`suite:${file}`, existsSync(join(identity.tree, file)), file);
    for (const file of [BATCH, REPORT]) check(`runner:${file}`, existsSync(join(identity.tree, file)), file);
    // A frozen older tree (e.g. the A-store batch's ATREE) runs its own g3-batch, which may predate a flag.
    const batchSource = existsSync(join(identity.tree, BATCH)) ? readFileSync(join(identity.tree, BATCH), 'utf8') : '';
    for (const flag of retryFlags(ops)) {
      if (flag.startsWith('--')) check(`batch-option:${flag}`, batchSource.includes(`'${flag.slice(2)}'`), { batch: BATCH, note: 'this tree\'s g3-batch does not take it' });
    }
    // The comparator reads the tree's own approvals; its sha256 goes into every compare artifact.
    let approvals = null;
    try { approvals = loadApprovals(join(identity.tree, APPROVALS)); } catch (error) { check('approvals', false, { file: APPROVALS, error: String(error.message) }); }
    if (approvals) check('approvals', true, { file: APPROVALS, sha256: approvals.sha256, approved: [...approvals.approved] });
  }
  if (mode === 'b-only') storeChecks(check, ops.aStores, identity.environment);
  let receipt = null;
  if (mode !== 'b-only') {
    try { receipt = JSON.parse(readFileSync(identity.aReceipt, 'utf8')); } catch (error) { check('a-receipt', false, String(error.message)); }
  }
  if (receipt) {
    const sha = sha256File(identity.aReceipt);
    check('a-receipt', receipt.schema === 'wp043-tauri-build' && receipt.code === 0 && /^[0-9a-f]{64}$/.test(receipt.binarySha256 ?? ''),
      { schema: receipt.schema, code: receipt.code, job: receipt.job, binarySha256: receipt.binarySha256, sha256: sha });
    if (aReceiptSha256) check('a-receipt-sha256', sha === aReceiptSha256, { actual: sha, expected: aReceiptSha256 });
    const binaryOk = check('a-binary', receipt.binary && existsSync(receipt.binary), receipt.binary ?? null);
    if (binaryOk && ops.verifyBinary) {
      const actual = await digestFile(receipt.binary);
      check('a-binary-sha256', actual === receipt.binarySha256, { actual, expected: receipt.binarySha256 });
    }
  }
  for (const tool of mode === 'b-only' ? B_TOOLS : TOOLS) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    check(`tool:${tool}`, found.status === 0, found.stdout.trim() || null);
  }
  // The output directory is new, or it is this run's (same intent): never someone else's.
  // A directory holding only the receipt of a refused (preflight-failed) start counts as new.
  if (existsSync(out)) {
    const marker = join(out, 'SUPERVISOR.json');
    if (existsSync(marker)) {
      const previous = JSON.parse(readFileSync(marker, 'utf8')).identity;
      const changed = [...new Set([...Object.keys(identity), ...Object.keys(previous ?? {})])]
        .filter(key => JSON.stringify(previous?.[key]) !== JSON.stringify(identity[key]));
      check('out', !changed.length, changed.length ? { changed, note: 'different intent; use a new --out' } : { rerun: true });
    } else {
      check('out', readdirSync(out).every(name => refusedReceipt(join(out, name))),
        { note: 'existing directory without SUPERVISOR.json must be empty (or hold only refused-start receipts)' });
    }
  } else check('out', true, { create: true });
  return { ok: checks.every(item => item.ok), checks };
}

function refusedReceipt(file) {
  if (!/^SUPERVISOR-RESULT(\.preflight-failed-\d+)?\.json$/.test(file.split('/').at(-1))) return false;
  try { return JSON.parse(readFileSync(file, 'utf8')).verdict === 'preflight-failed'; } catch { return false; }
}

/** b-only: every A store is the pinned one, provenance-complete, from one A build and this run's environment. */
function storeChecks(check, stores, environment) {
  const usable = [];
  for (const { dir, sha256 } of stores) {
    const file = join(dir, A_STORE_FILE);
    let identity = null;
    try { identity = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { check(`a-store:${dir}`, false, String(error.message)); continue; }
    if (!check(`a-store:${dir}`, identity.schema === A_STORE_SCHEMA, { schema: identity.schema, recorder: identity.recorder?.head ?? null })) continue;
    const actual = sha256File(file);
    if (!check(`a-store-sha256:${dir}`, actual === sha256, { actual, expected: sha256 })) continue;
    const { defects } = storeDefects(dir);
    if (check(`a-store-defects:${dir}`, !defects.length, defects.length ? defects : null)) usable.push(identity);
  }
  if (usable.length !== stores.length) return;
  const builds = [...new Set(usable.map(identity => identity.a?.buildReceipt?.sha256))];
  check('a-store-build', builds.length === 1, { buildReceipts: builds });
  const environments = usable.map(identity => JSON.stringify(identity.environment));
  check('a-store-environment', environments.every(value => value === JSON.stringify(environment)),
    { stores: [...new Set(environments)].map(value => JSON.parse(value)), run: environment, note: 'pass the stores\' --tz/--locale' });
}

function acquireLock(out) {
  const file = join(out, 'supervisor.lock');
  const body = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, body);
      closeSync(fd);
      return { file, release: () => rmSync(file, { force: true }) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = JSON.parse(readFileSync(file, 'utf8'));
      let alive = holder.host === hostname();
      if (alive) { try { process.kill(holder.pid, 0); } catch (probe) { alive = probe.code === 'EPERM'; } }
      if (alive) throw new Error(`another supervisor holds ${file}: ${JSON.stringify(holder)}`);
      renameSync(file, `${file}.stale-${Date.now()}`);
    }
  }
  throw new Error(`could not take ${file}`);
}

const retryFlags = ops => [...(ops.retry?.errors ? ['--retry-errors'] : []), ...(ops.retry?.before ? ['--retry-errors-before', ops.retry.before] : []),
  ...(ops.retry?.infrastructure ? ['--retry-infra-errors'] : [])];

function batchArgs({ mode = 'combined', identity, ops, out }) {
  const workers = Object.entries({ a: 'workers-a', b: 'workers-b', a2: 'workers-a2', compare: 'workers-compare' })
    .filter(([side]) => ops.workers[side] !== null).flatMap(([side, flag]) => [`--${flag}`, String(ops.workers[side])]);
  const source = mode === 'combined' ? [identity.aReceipt]
    : mode === 'a-store' ? [identity.aReceipt, '--mode', 'a-store']
      : ['--mode', 'b-only', ...ops.aStores.flatMap(store => ['--a-store', store.dir, '--a-store-sha256', store.sha256])];
  return [BATCH, ...source, '--out', out, '--sides', identity.sides, '--shard-size', String(identity.shardSize), ...workers,
    '--shard-timeout-min', String(ops.shardTimeoutMin), '--compare-timeout-min', String(ops.compareTimeoutMin), '--kill-grace-s', String(ops.killGraceS),
    ...(ops.deadlineMin ? ['--deadline-min', String(ops.deadlineMin)] : []), ...(identity.files ?? ops.files).flatMap(file => ['--file', file]),
    ...(ops.domains?.length ? ['--domain', ops.domains.join(',')] : []), ...(ops.scenarios ?? []).flatMap(id => ['--scenario', id]),
    ...(identity.environment ? ['--tz', identity.environment.TZ, '--locale', identity.environment.LC_ALL]
      : [...(ops.tz ? ['--tz', ops.tz] : []), ...(ops.locale ? ['--locale', ops.locale] : [])]), ...retryFlags(ops)];
}

/** A store state after a batch: provenance defects and how many corpus scenarios have admitted A / A2 traces. */
export async function storeState(tree, store) {
  const { identity, sha256, defects } = storeDefects(store);
  if (!identity) return { defects, coverage: null };
  const { scanScenarios } = await import('./g3-report.mjs');
  const { suites } = scanScenarios(tree);
  const valid = new Set(suites.flatMap(suite => suite.scenarios.filter(item => item.valid).map(item => `${suite.file}\n${item.id}`)));
  const recorded = { A: new Set(), A2: new Set() };
  for (const { side, receipt } of storeReceipts(store, sha256)) {
    for (const trace of receipt.traces ?? []) if (valid.has(`${receipt.scenarioFile}\n${trace.id}`)) recorded[side].add(`${receipt.scenarioFile}\n${trace.id}`);
  }
  return { defects, coverage: { suites: Object.keys(identity.inputs?.suites ?? {}).length, scenarios: valid.size, A: recorded.A.size, A2: recorded.A2.size } };
}

export async function supervise(options) {
  const { mode = 'combined', identity, ops, out } = options;
  const checked = await preflight(options);
  if (options.dryRun) return { exitCode: checked.ok ? 0 : EXIT['preflight-failed'], result: { preflight: checked, batch: [process.execPath, ...batchArgs(options)] } };
  const failed = checked.checks.filter(item => !item.ok).map(item => `${item.name}: ${JSON.stringify(item.detail)}`);
  const refused = reasons => ({ exitCode: EXIT['preflight-failed'], result: { verdict: 'preflight-failed', reasons, preflight: checked } });
  // Another run's directory (or a foreign one) is never written to, not even a failure receipt.
  if (!checked.checks.find(item => item.name === 'out').ok) return refused(failed);
  mkdirSync(out, { recursive: true });
  let lock;
  try { lock = acquireLock(out); } catch (error) { return refused([error.message]); }
  const startedAt = new Date().toISOString();
  const result = { schema: RESULT_SCHEMA, identity, ops, startedAt, endedAt: null, preflight: checked, phases: {}, verdict: 'running', reasons: [], exitCode: null };
  const save = () => atomicJson(join(out, 'SUPERVISOR-RESULT.json'), result);
  const finish = (verdict, exitCode = EXIT[verdict]) => {
    Object.assign(result, { verdict, exitCode, endedAt: new Date().toISOString() });
    save();
    return { exitCode, result };
  };
  let current = null, stopped = null;
  const onSignal = signal => { stopped ??= signal; current?.stop(`supervisor ${signal}`); };
  const handlers = { SIGTERM: () => onSignal('SIGTERM'), SIGINT: () => onSignal('SIGINT') };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    if (!checked.ok) { result.reasons = failed; return finish('preflight-failed'); }
    if (!existsSync(join(out, 'SUPERVISOR.json'))) {
      if (existsSync(join(out, 'SUPERVISOR-RESULT.json'))) renameSync(join(out, 'SUPERVISOR-RESULT.json'), join(out, `SUPERVISOR-RESULT.preflight-failed-${Date.now()}.json`));
      atomicJson(join(out, 'SUPERVISOR.json'), { schema: SUPERVISOR_SCHEMA, identity, createdAt: startedAt });
    }
    appendFileSync(join(out, 'supervisor-runs.jsonl'), JSON.stringify({ at: startedAt, pid: process.pid, host: hostname(), ops }) + '\n');
    save();
    const step = async (name, command, args, limits) => {
      if (stopped) return null;
      current = startSupervised(command, args, { cwd: identity.tree, label: name, logFile: join(out, `supervisor-${name}.log`), ...limits });
      const record = processRecord(await current.done);
      current = null;
      result.phases[name] = { process: record };
      save();
      return record;
    };
    const batch = await step('batch', process.execPath, batchArgs(options), { captureStdout: false,
      timeoutMs: ops.totalTimeoutMin * 60_000, killGraceMs: (2 * ops.killGraceS + 60) * 1000, closeGraceMs: 30_000 });
    const batchResultFile = join(out, 'batch-result.json');
    const batchResult = existsSync(batchResultFile) ? JSON.parse(readFileSync(batchResultFile, 'utf8')) : null;
    result.phases.batch.result = batchResult;
    if (stopped || batch.outcome === 'stopped') return finish('stopped', stopped === 'SIGINT' ? 130 : 143);
    const reasons = [];
    let verdict = 'complete';
    const fail = reason => { reasons.push(reason); verdict = 'failed'; };
    const incomplete = reason => { reasons.push(reason); if (verdict === 'complete') verdict = 'incomplete'; };
    if (batch.outcome === 'timeout') fail(`batch exceeded --total-timeout-min ${ops.totalTimeoutMin}`);
    else if (batch.outcome !== 'exited' || ![0, 3].includes(batch.code) || !batchResult) fail(`batch ${batch.outcome} code=${batch.code} signal=${batch.signal}${batchResult ? '' : ', no batch-result.json'}`);
    if (batchResult) {
      const rejected = Object.entries(batchResult.rejectedShards ?? {}).filter(([, count]) => count > 0);
      if (rejected.length) incomplete(`rejected shards: ${rejected.map(([side, count]) => `${side}=${count}`).join(' ')} (see receipts/)`);
      if (batchResult.compareErrors) incomplete(`compare errors: ${batchResult.compareErrors}`);
      if (batchResult.deferredShards) incomplete(`deferred by --deadline-min: ${batchResult.deferredShards} shard(s)`);
      const gaps = batchResult.aStore;
      const staleA = gaps?.staleA ?? 0, missingA = gaps?.missingA ?? 0;
      if (gaps && (gaps.suites.stale || gaps.suites.missing || gaps.awaitingA || staleA || missingA)) {
        incomplete(`A/A2 unavailable: ${staleA} stale-a scenario(s), ${missingA} missing, ${gaps.awaitingA} awaiting A`
          + ` (${gaps.suites.stale} stale suite(s), ${gaps.suites.missing} missing; see a-store-coverage.json: topUpScenarios need an A top-up store from this tree, awaitingA needs the store finished)`);
      }
    }
    // Read from the shard directories, so a frozen tree's older g3-batch is classified the same way.
    const failures = scanRunnerErrors(out, identity.sides.split(','));
    result.phases.failures = { counts: failures.counts, signatures: failures.signatures, infrastructure: failures.infrastructure.slice(0, 50) };
    const bySide = kind => Object.entries(failures.counts).filter(([, counts]) => counts[kind]).map(([side, counts]) => `${side}=${counts[kind]}`).join(' ');
    if (bySide('infrastructure')) {
      incomplete(`infrastructure runner errors (EAGAIN / thread creation, ${Object.keys(failures.signatures).join(',')}): ${bySide('infrastructure')}`
        + ` — not scenario results; rerun the same command with --retry-infra-errors${bySide('scenario') ? `; scenario runner errors ${bySide('scenario')} are findings` : ''}`);
    }
    if (mode === 'a-store') {
      result.phases.store = await storeState(identity.tree, out);
      if (result.phases.store.defects.length) fail(`A store provenance incomplete: ${result.phases.store.defects.join(',')}`);
      // A-side profraw live in the store; b-only reports take its coverage-summary.json via --coverage.
      if (ops.coverage && !stopped) await coverage(out, identity, step, result, fail);
      if (stopped) return finish('stopped', stopped === 'SIGINT' ? 130 : 143);
      result.reasons = reasons;
      return finish(verdict);
    }
    const { defects } = recordingDefects(identity.tree, out);
    result.phases.provenance = { defects };
    if (defects.length) fail(`recording provenance incomplete: ${defects.join(',')}`);
    if (ops.coverage && !stopped) await coverage(out, identity, step, result, fail);
    if (ops.report && !stopped && batchResult) {
      const manifest = join(out, 'RUN-MANIFEST.json');
      if (existsSync(manifest)) {
        const aside = join(out, `RUN-MANIFEST.superseded-${Date.now()}.json`);
        renameSync(manifest, aside);
        result.phases.supersededManifest = aside;
      }
      const sealed = await step('manifest', process.execPath, [REPORT, '--runs', out, '--write-manifest'], { timeoutMs: 30 * 60_000 });
      if (sealed && !sealed.ok) fail(`manifest ${sealed.outcome} code=${sealed.code}`);
      if (sealed?.ok) {
        const coverageFile = join(out, 'coverage-summary.json');
        const report = await step('report', process.execPath, [REPORT, '--runs', out, '--out', join(out, 'report'), '--jobs', String(ops.reportJobs),
          ...(result.phases.coverage?.ok ? ['--coverage', coverageFile] : []), ...(ops.domains?.length ? ['--domain', ops.domains.join(',')] : [])],
        { timeoutMs: 120 * 60_000 });
        if (report && !report.ok) fail(`report ${report.outcome} code=${report.code}; see supervisor-report.log`);
        if (report?.ok) {
          try { result.phases.report.summary = JSON.parse(readFileSync(join(out, 'supervisor-report.log'), 'utf8').trim().split('\n').at(-1)); }
          catch { fail('report summary line unreadable; see supervisor-report.log'); }
        }
      }
    }
    if (stopped) return finish('stopped', stopped === 'SIGINT' ? 130 : 143);
    result.reasons = reasons;
    return finish(verdict);
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    lock.release();
  }
}

/** llvm-profdata merge of every profraw, then an llvm-cov export summary for g3-report --coverage. */
async function coverage(out, identity, step, result, fail) {
  const profiles = [];
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path); else if (entry.name.endsWith('.profraw')) profiles.push(path);
  } };
  if (existsSync(join(out, 'profiles'))) walk(join(out, 'profiles'));
  if (!profiles.length) { result.phases.coverage = { ok: false, skipped: 'no profraw under profiles/' }; return; }
  const profdata = join(out, 'coverage.profdata');
  const merged = await step('coverage-merge', 'llvm-profdata', ['merge', '-sparse', ...profiles, '-o', profdata], { timeoutMs: 60 * 60_000 });
  if (!merged?.ok) { fail(`llvm-profdata merge ${merged?.outcome} code=${merged?.code}`); return; }
  const binary = JSON.parse(readFileSync(identity.aReceipt, 'utf8')).binary;
  const summary = join(out, 'coverage-summary.json');
  rmSync(summary, { force: true });
  const exported = await step('coverage-export', 'llvm-cov', ['export', '-summary-only', binary, `-instr-profile=${profdata}`],
    { timeoutMs: 60 * 60_000, captureStdout: false, logFile: null, onStdout: chunk => appendFileSync(summary, chunk) });
  result.phases.coverage = { ok: Boolean(exported?.ok), profiles: profiles.length, summary };
  if (!exported?.ok) fail(`llvm-cov export ${exported?.outcome} code=${exported?.code}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseOptions(process.argv.slice(2));
  const { exitCode, result } = await supervise(options);
  process.stdout.write(JSON.stringify(options.dryRun ? result : { verdict: result.verdict, exitCode, reasons: result.reasons,
    result: join(options.out, 'SUPERVISOR-RESULT.json') }) + '\n');
  process.exitCode = exitCode;
}
