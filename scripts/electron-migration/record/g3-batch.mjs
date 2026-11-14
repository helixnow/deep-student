#!/usr/bin/env node
// G3 full-corpus driver: every valid scenario in the scanned corpus runs once on A (real
// Tauri, one process per scenario) and once on B (real Host), then one compare per scenario.
// Each worker runs in its own user+network+PID namespace (g3-worker.mjs NAMESPACE) so the
// compiled devUrl port 1422 and the fixed X5 LLM port 47110 never collide between workers,
// and nothing a worker started survives it.
//   node scripts/electron-migration/record/g3-batch.mjs BUILD_RECEIPT [--out DIR] [--workers-a N]
//     [--workers-b N] [--workers-compare N] [--shard-size K] [--file SUITE ...] [--domain D,...]
//     [--shard-timeout-min M] [--compare-timeout-min M] [--tz ZONE] [--locale LOCALE]
// Modes (--mode):
//   combined  (default) A, A2 and B into one directory, RECORDING.json g3-recording/v2.
//   a-store   A/A2 only, no B commit: A-STORE.json (recorder commit + runtime receipt, A build
//             receipt, environment, per-suite input fingerprint, g3-inputs.mjs). Reusable by
//             any number of b-only runs whose scenario inputs match.
//   b-only    B only, no BUILD_RECEIPT: --a-store DIR --a-store-sha256 HEX (repeatable, later
//             stores win per scenario). RECORDING.json g3-recording/v3 pins this B commit, the
//             Host receipt, the stores' A build receipt, environment and input fingerprint;
//             each store receipt used is pinned under a-refs/. Suites whose inputs differ
//             from every store are neither recorded nor compared (a-store-coverage.json).
// The worker cap (6) counts only the sides this invocation records. --domain picks plugin
// domains in priority order: only their shards are recorded; already recorded shards of
// other domains are still compared.
// Resumable: a shard whose summary was admitted (clean worker exit, see acceptSummary) is not
// rerun; a partial or rejected shard directory is renamed aside. Every worker leaves
// receipts/<side>/<shard>.json. Exit 0: every started shard admitted and every compare ran;
// 3: some shard was rejected or some compare failed; 143/130: stopped by SIGTERM/SIGINT.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scanScenarios } from './g3-report.mjs';
import { admission, resources } from '../lib/resource-budget.mjs';
import { NAMESPACE as NS, NAMESPACE_INIT, acceptSummary, reusable, runWorker, writeWorkerReceipt } from './g3-worker.mjs';
import { A_STORE_FILE, HOST_RECEIPT_FILE, RECORDER_RECEIPT_FILE, RECORDING_FILE, aBuildEvidence, aStoreIdentity, gitState, hostReceipt,
  recordingIdentity, storeDefects, storeReceipts, writeARef } from './g3-provenance.mjs';
import { firstDifference } from './json.mjs';
import { normalizerSha256 as normalizerHash } from './g3-normalize.mjs';
import { INPUTS_SCHEMA, domainOf, inputDifference, inputFingerprint, pinnedEnvironment, scenarioDifference, scenarioEntries, storeScenarioInputs, storeSuiteFile,
  workerEnvironment } from './g3-inputs.mjs';
import { classifySummary, emptyClasses, tally } from './g3-failures.mjs';

// Compare artifacts are reusable only when their traces AND the rules that produced them match.
const normalizerSha256 = normalizerHash('.');
const approvalsSha256 = createHash('sha256').update(readFileSync('fixtures/differential/g3/normalize-approvals.json')).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  out: { type: 'string', default: 'fixtures/differential/g3/runs/full' },
  mode: { type: 'string', default: 'combined' },
  'a-store': { type: 'string', multiple: true }, 'a-store-sha256': { type: 'string', multiple: true },
  domain: { type: 'string', multiple: true }, tz: { type: 'string' }, locale: { type: 'string' },
  'workers-a': { type: 'string', default: '2' }, 'workers-b': { type: 'string', default: '2' },
  'workers-compare': { type: 'string', default: '1' }, 'shard-size': { type: 'string', default: '10' },
  file: { type: 'string', multiple: true }, scenario: { type: 'string', multiple: true }, 'retry-errors': { type: 'boolean' },
  // A2: second independent A take (normalization evidence, N-001/N-003/N-005); compare needs A1, A2 and B.
  // Default per mode: combined A,B,A2; a-store A,A2; b-only B.
  sides: { type: 'string' }, 'workers-a2': { type: 'string', default: '2' },
  // Job queue kills a job after 30 min: stop starting shards after this many minutes, drain, exit 0.
  'deadline-min': { type: 'string' }, 'record-only': { type: 'boolean' },
  // Compare already recorded shards only (safe next to a recording pass on the same --out).
  'compare-only': { type: 'boolean' },
  // Rerun runner-error shards whose summary predates this time: one retry per failure across chained jobs.
  'retry-errors-before': { type: 'string' },
  // Rerun shards with an infrastructure runner error (g3-failures.mjs: EAGAIN, thread creation).
  'retry-infra-errors': { type: 'boolean' },
  // Wall-clock limit per worker process (default max(20, 3 × shard size) minutes) and per compare.
  'shard-timeout-min': { type: 'string' }, 'compare-timeout-min': { type: 'string', default: '15' },
  'kill-grace-s': { type: 'string', default: '30' } } });
const RETRY_BEFORE = values['retry-errors-before'] ? Date.parse(values['retry-errors-before']) : null;
if (RETRY_BEFORE !== null && Number.isNaN(RETRY_BEFORE)) throw new Error('--retry-errors-before needs an ISO time');
const DEADLINE = values['deadline-min'] ? Date.now() + Number(values['deadline-min']) * 60_000 : Infinity;
const DEFERRED = Symbol('deferred');
const MODE = values.mode;
if (!['combined', 'a-store', 'b-only'].includes(MODE)) throw new Error(`unknown --mode ${MODE} (combined, a-store, b-only)`);
const SIDES = new Set((values.sides ?? { combined: 'A,B,A2', 'a-store': 'A,A2', 'b-only': 'B' }[MODE]).split(','));
for (const side of SIDES) if (!['A', 'B', 'A2'].includes(side)) throw new Error(`unknown side ${side}`);
if (MODE === 'a-store' && SIDES.has('B')) throw new Error('a-store records only A/A2 (--sides A,A2); record B with --mode b-only');
if (MODE === 'b-only' && (SIDES.size !== 1 || !SIDES.has('B'))) throw new Error('b-only records only B (--sides B); A/A2 come from --a-store');
const [receipt] = positionals;
if (MODE === 'b-only') {
  if (positionals.length) throw new Error('b-only takes the A build receipt from the A store; pass no BUILD_RECEIPT');
  if (!values['a-store']?.length) throw new Error('b-only needs --a-store DIR --a-store-sha256 HEX');
  if ((values['a-store-sha256'] ?? []).length !== values['a-store'].length) throw new Error('every --a-store needs its --a-store-sha256 (same order)');
} else {
  if (!receipt || positionals.length !== 1) throw new Error(`usage: g3-batch.mjs BUILD_RECEIPT${MODE === 'combined' ? '' : ` --mode ${MODE}`} [options]`);
  if (values['a-store'] || values['a-store-sha256']) throw new Error('--a-store is for --mode b-only');
}
if (MODE === 'a-store' && values['compare-only']) throw new Error('a-store has nothing to compare');
const OUT = values.out;
const WORKER_OPTION = { A: 'workers-a', B: 'workers-b', A2: 'workers-a2' };
const workerCounts = [...SIDES].map(side => Number(values[WORKER_OPTION[side]]));
if (workerCounts.some(n => !Number.isInteger(n) || n < 1)) throw new Error('recording budget: worker counts are positive integers');
if (workerCounts.reduce((a, b) => a + b, 0) > 6) throw new Error(`recording budget: at most 6 workers across the recorded sides (${[...SIDES].join(',')})`);
const SIZE = Number(values['shard-size']);
const minutes = (value, fallback) => {
  const number = value === undefined ? fallback : Number(value);
  if (!(number > 0)) throw new Error(`invalid minutes: ${value}`);
  return number * 60_000;
};
const LIMITS = { timeoutMs: minutes(values['shard-timeout-min'], Math.max(20, 3 * SIZE)),
  killGraceMs: Number(values['kill-grace-s']) * 1000, closeGraceMs: Number(values['kill-grace-s']) * 1000 };
const COMPARE_LIMITS = { ...LIMITS, timeoutMs: minutes(values['compare-timeout-min']) };

// Workers (and seed fingerprints computed here) run under one pinned time zone and locale;
// LANGUAGE would override LC_ALL for messages.
const ENVIRONMENT = pinnedEnvironment({ tz: values.tz, locale: values.locale });
try { new Intl.DateTimeFormat('en-US', { timeZone: ENVIRONMENT.TZ }); } catch { throw new Error(`--tz ${ENVIRONMENT.TZ} is not an IANA time zone`); }
Object.assign(process.env, ENVIRONMENT);
delete process.env.LANGUAGE;
const CHILD_ENV = workerEnvironment(ENVIRONMENT);

const { suites } = scanScenarios('.');
const DOMAINS = [...new Set((values.domain ?? []).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))];
const knownDomains = new Set(suites.map(suite => domainOf(suite.file)));
for (const domain of DOMAINS) if (!knownDomains.has(domain)) throw new Error(`unknown domain: ${domain} (known: ${[...knownDomains].sort().join(', ')})`);
// --scenario: record only these ids (diagnostic takes); each must exist in a selected suite.
const ONLY = values.scenario ? new Set(values.scenario) : null;
if (ONLY) {
  const found = new Set(suites.filter(suite => !values.file || values.file.includes(suite.file))
    .flatMap(suite => suite.scenarios.filter(item => item.valid && ONLY.has(item.id)).map(item => item.id)));
  const absent = [...ONLY].filter(id => !found.has(id));
  if (absent.length) throw new Error(`--scenario not found as a valid scenario${values.file ? ' in --file' : ''}: ${absent.join(', ')}`);
}
const git = gitState(process.cwd());
const { head } = git;
if (!git.clean) throw new Error('freeze and commit the recording tree first');

// b-only: every A store must be the one pinned by sha256, without provenance defects, recorded
// under this run's environment and from one A build.
const STORES = MODE !== 'b-only' ? [] : values['a-store'].map((given, index) => {
  const dir = resolve(given), file = join(dir, A_STORE_FILE), pinned = values['a-store-sha256'][index];
  if (!existsSync(file)) throw new Error(`A store ${dir} has no ${A_STORE_FILE}`);
  const actual = sha256(readFileSync(file));
  if (actual !== pinned) throw new Error(`A store ${file} sha256 ${actual}, expected ${pinned}`);
  const { identity, defects } = storeDefects(dir);
  if (defects.length) throw new Error(`A store ${dir} provenance defects: ${defects.join(',')}`);
  if (JSON.stringify(identity.environment) !== JSON.stringify(ENVIRONMENT)) {
    throw new Error(`A store ${dir} was recorded under ${JSON.stringify(identity.environment)}, this run pins ${JSON.stringify(ENVIRONMENT)}; pass the store's --tz/--locale`);
  }
  return { dir, sha256: actual, identity };
});
if (new Set(STORES.map(store => store.identity.a.buildReceipt.sha256)).size > 1) throw new Error('A stores come from different A build receipts; one b-only run compares against one A build');
const INPUTS = MODE === 'combined' ? null : await inputFingerprint(process.cwd(), suites.map(suite => suite.file), ENVIRONMENT);

mkdirSync(OUT, { recursive: true });
const PASS = values['compare-only'] ? '-compare' : SIDES.has('A') || SIDES.has('B') ? '' : `-${[...SIDES].join('-')}`;
const log = line => { const text = `${new Date().toISOString()} ${line}`; appendFileSync(join(OUT, `batch${PASS}.log`), text + '\n'); process.stdout.write(text + '\n'); };

const fileSha = new Map(suites.map(suite => [suite.file, sha256(readFileSync(suite.file))]));
// Identity (RECORDING.json, or A-STORE.json for an A store) with the runtime receipt it pins.
// Operational flags (workers, timeouts, sides, --file, --domain, extra A stores) may differ
// between invocations on one output directory; the identity may not.
const isolation = { wrapper: NS.slice(0, NS.indexOf('-c')), init: NAMESPACE_INIT };
const runtimeText = JSON.stringify(hostReceipt(process.cwd()), null, 2) + '\n';
const runtime = { sha256: sha256(runtimeText) };
const identityFile = join(OUT, MODE === 'a-store' ? A_STORE_FILE : RECORDING_FILE);
const runtimeFile = join(OUT, MODE === 'a-store' ? RECORDER_RECEIPT_FILE : HOST_RECEIPT_FILE);
const identity = MODE === 'a-store'
  ? aStoreIdentity({ root: process.cwd(), git, recorder: runtime, aBuild: aBuildEvidence(receipt), environment: ENVIRONMENT, inputs: INPUTS, isolation })
  : recordingIdentity({ root: process.cwd(), git, host: runtime, aBuild: aBuildEvidence(MODE === 'b-only' ? STORES[0].identity.a.buildReceipt.file : receipt),
    normalizerSha256, approvalsSha256, corpus: Object.fromEntries(fileSha), isolation, environment: ENVIRONMENT, inputs: INPUTS });
const identityText = JSON.stringify(identity, null, 2) + '\n';
if (existsSync(identityFile) && readFileSync(identityFile, 'utf8') !== identityText) {
  const changed = firstDifference(JSON.parse(readFileSync(identityFile, 'utf8')), JSON.parse(identityText));
  throw new Error(`${MODE === 'a-store' ? 'A store' : 'recording'} inputs changed; use a new output directory (first change at ${changed?.path || '/'})`);
}
if (existsSync(runtimeFile) && readFileSync(runtimeFile, 'utf8') !== runtimeText) throw new Error(`${runtimeFile} differs from this runtime; use a new output directory`);
if (!existsSync(runtimeFile)) writeFileSync(runtimeFile, runtimeText, { flag: 'wx' });
if (!existsSync(identityFile)) writeFileSync(identityFile, identityText, { flag: 'wx' });
appendFileSync(join(OUT, 'invocations.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, node: process.execPath, cli: process.argv.slice(2) }) + '\n');
const key = file => file.replace(/\.json$/, '').replaceAll('/', '__');
const scenarioKey = (file, id) => `${file}\n${id}`;

// b-only, per scenario: the last store (in --a-store order) holding an admitted A and A2 take
// recorded from the same scenario inputs as this tree. Takes only from other inputs are
// stale-a (not compared, need a top-up); none at all is awaitingA (a store with the same inputs
// is still recording it) or missing.
const aTake = new Map(); // scenarioKey → { store, A: { receipt entry, trace }, A2: … }
const coverage = {};
if (MODE === 'b-only') {
  for (const store of STORES) {
    store.receipts = storeReceipts(store.dir, store.sha256);
    store.scenarios = storeScenarioInputs(process.cwd(), store.identity, store.dir);
  }
  const current = scenarioEntries(INPUTS);
  // Same inputs for one scenario; a store whose recording commit is unreadable falls back to its suite fingerprint.
  const sameInputs = (store, file, id) => (store.scenarios
    ? scenarioDifference(store.scenarios[file]?.[id], current[file]?.[id])
    : inputDifference(store.identity.inputs, INPUTS, file));
  for (const suite of suites) {
    const valid = suite.scenarios.filter(item => item.valid).map(item => item.id);
    const takes = STORES.map(store => {
      const byId = new Map(), covered = new Map();
      for (const entry of store.receipts.filter(item => item.receipt.scenarioFile === suite.file)) {
        for (const id of entry.receipt.ids ?? []) covered.set(id, (covered.get(id) ?? new Set()).add(entry.side));
        for (const trace of entry.receipt.traces ?? []) byId.set(trace.id, { ...byId.get(trace.id), [entry.side]: { entry, trace } });
      }
      return { store, byId, covered };
    });
    const staleA = [], missing = [], sources = {};
    let awaitingA = 0;
    for (const id of valid) {
      const held = takes.filter(({ byId, covered }) => byId.get(id)?.A && byId.get(id)?.A2 && covered.get(id)?.has('A') && covered.get(id)?.has('A2'));
      const usable = held.findLast(({ store }) => sameInputs(store, suite.file, id) === null);
      if (usable) {
        aTake.set(scenarioKey(suite.file, id), { store: usable.store, ...usable.byId.get(id) });
        sources[id] = usable.store.sha256.slice(0, 12);
      } else if (held.length) {
        const latest = held.at(-1).store;
        staleA.push({ id, store: latest.sha256.slice(0, 12), reasons: sameInputs(latest, suite.file, id) });
      } else if (STORES.some(store => sameInputs(store, suite.file, id) === null)) awaitingA++;
      else missing.push(id);
    }
    const available = Object.keys(sources).length;
    coverage[suite.file] = {
      status: available === valid.length ? 'matched' : available ? 'partial' : staleA.length ? 'stale' : awaitingA ? 'awaiting' : 'missing',
      reasons: [...new Set(staleA.flatMap(item => item.reasons))].sort(),
      stores: [...new Set(Object.values(sources))].map(prefix => STORES.find(store => store.sha256.startsWith(prefix))).map(store => ({ dir: store.dir, sha256: store.sha256 })),
      scenarios: valid.length, available, awaitingA, staleA, missing, sources };
  }
  const coverageFile = join(OUT, 'a-store-coverage.json');
  const files = Object.keys(coverage).sort();
  writeFileSync(`${coverageFile}.tmp`, JSON.stringify({ schema: 'g3-a-store-coverage/v2', head,
    stores: STORES.map(store => ({ dir: store.dir, sha256: store.sha256, inputsSchema: store.identity.inputs.schema ?? null,
      scenarioInputs: store.identity.inputs.schema === INPUTS_SCHEMA && store.identity.inputs.scenarios ? 'recorded'
        : store.scenarios ? 'recomputed-from-recorder-head' : 'suite-fingerprint-only' })),
    suites: coverage,
    topUp: files.filter(file => coverage[file].staleA.length || coverage[file].missing.length),
    topUpScenarios: files.flatMap(file => [...coverage[file].staleA.map(item => item.id), ...coverage[file].missing].sort().map(id => ({ file, id }))),
    staleA: files.flatMap(file => coverage[file].staleA.map(item => ({ file, ...item }))),
    awaitingA: files.filter(file => coverage[file].awaitingA > 0) }, null, 2) + '\n');
  renameSync(`${coverageFile}.tmp`, coverageFile);
}

// --domain: only shards of the named domains are recorded, in the given order; recorded
// shards of other domains are still compared (combined/b-only), never re-recorded.
const rank = file => (DOMAINS.length ? DOMAINS.indexOf(domainOf(file)) : 0);
const shards = [];
for (const suite of suites) {
  if (values.file && !values.file.includes(suite.file)) continue;
  if (MODE === 'b-only' && !coverage[suite.file].available && !coverage[suite.file].awaitingA) continue;
  const selected = rank(suite.file) >= 0;
  if (MODE === 'a-store' && !selected) continue;
  const ids = suite.scenarios.filter(item => item.valid && (!ONLY || ONLY.has(item.id))).map(item => item.id);
  // A --scenario shard holds other ids than the suite's regular shard: it gets its own key, so a
  // later full run into the same --out never reuses it as the regular shard.
  const only = ONLY ? `only-${sha256(ids.join('\n')).slice(0, 12)}-` : '';
  for (let index = 0; index * SIZE < ids.length; index++) {
    const shardIds = ids.slice(index * SIZE, (index + 1) * SIZE);
    // b-only: B is not recorded for a shard none of whose scenarios has its A/A2 yet.
    const waiting = MODE === 'b-only' && !shardIds.some(id => aTake.has(scenarioKey(suite.file, id)));
    shards.push({ file: suite.file, index, ids: shardIds, key: `${key(suite.file)}/${only}${String(index).padStart(3, '0')}`, selected, waiting,
      compareOnly: Boolean(values['compare-only']) || !selected || waiting });
  }
}
// Selected domains first, in their order; within them the first shard of every suite first,
// so every command with a scenario is reached early.
const order = shard => (shard.selected ? rank(shard.file) : DOMAINS.length);
shards.sort((a, b) => order(a) - order(b) || a.index - b.index || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
const selectedShards = shards.filter(shard => shard.selected);
const selection = { domains: DOMAINS, suites: [...new Set(selectedShards.map(shard => shard.file))], shards: selectedShards.length };
log(`mode ${MODE}, shards ${shards.length} (selected ${selection.shards}), scenarios ${shards.reduce((n, s) => n + s.ids.length, 0)}, suites ${new Set(shards.map(s => s.file)).size}`);

const stats = { a2Done: 0, aDone: 0, bDone: 0, compared: 0, equal: 0, unequal: 0, compareErrors: 0, runnerErrors: { A: 0, B: 0, A2: 0 },
  runnerErrorClasses: { A: emptyClasses(), B: emptyClasses(), A2: emptyClasses() }, infrastructureSignatures: {}, unsupported: { A: 0, B: 0, A2: 0 },
  rejectedShards: { A: 0, B: 0, A2: 0 }, workerOutcomes: {} };
if (MODE === 'b-only') {
  const scope = Object.keys(coverage).filter(file => (!values.file || values.file.includes(file)) && rank(file) >= 0);
  const count = status => scope.filter(file => coverage[file].status === status).length;
  stats.aStore = { stores: STORES.map(store => ({ dir: store.dir, sha256: store.sha256 })),
    suites: { matched: count('matched'), partial: count('partial'), stale: count('stale'), missing: count('missing'), awaiting: count('awaiting') },
    staleA: scope.reduce((n, file) => n + coverage[file].staleA.length, 0), missingA: scope.reduce((n, file) => n + coverage[file].missing.length, 0),
    awaitingA: scope.reduce((n, file) => n + coverage[file].awaitingA, 0), waitingShards: selectedShards.filter(shard => shard.waiting).length };
}
const PROGRESS = `progress${PASS}.json`;
const writeProgress = () => writeFileSync(join(OUT, PROGRESS), JSON.stringify({ at: new Date().toISOString(), head, mode: MODE, shards: shards.length, ...stats }, null, 2) + '\n');
const startedAt = new Date().toISOString();
const writeResult = (exitCode, stopped = null) => {
  const file = join(OUT, `batch-result${PASS}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ schema: 'g3-batch-result/v1', mode: MODE, head, startedAt, endedAt: new Date().toISOString(),
    exitCode, stopped, environment: ENVIRONMENT, limits: LIMITS, compareLimits: COMPARE_LIMITS, selection, shards: shards.length, ...stats }, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
};

// Live worker handles and in-flight shard tasks: a stop waits for every worker to be gone
// (SIGTERM, then SIGKILL to its namespace) and for its receipt, never just exits.
const children = new Set();
const inflight = new Set();
let stopping = null;
const shutdown = async signal => {
  if (stopping) return;
  stopping = signal;
  log(`${signal}: stopping ${children.size} worker(s)`);
  await Promise.allSettled([...children].map(handle => handle.stop(`batch ${signal}`)));
  await Promise.allSettled([...inflight]);
  writeProgress();
  const code = signal === 'SIGINT' ? 130 : 143;
  writeResult(code, signal);
  log(`stopped by ${signal} ${JSON.stringify(stats)}`);
  process.exit(code);
};
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

const run = (command, args, logFile, limits = LIMITS, label = command) => runWorker(command, args, { logFile, children, label, env: CHILD_ENV, ...limits });
const track = promise => { inflight.add(promise); const forget = () => inflight.delete(promise); promise.then(forget, forget); return promise; };

// The budget probe reads /proc and the dsdev slice; only Linux recording hosts have them.
const admitted = () => {
  try { return admission(resources()).ok; } catch (error) { if (process.platform === 'linux') throw error; return true; }
};

function pool(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (stopping) { for (const { resolveTask } of queue.splice(0)) resolveTask(DEFERRED); return; }
    if (active >= size || !queue.length) return;
    if (Date.now() < DEADLINE && !admitted()) { setTimeout(next, 15000); return; }
    active++;
    const { task, resolveTask } = queue.shift();
    track(task()).then(resolveTask, resolveTask).finally(() => { active--; next(); });
  };
  return task => new Promise(resolveTask => { queue.push({ task, resolveTask }); next(); });
}

const sideRun = async (side, shard, worker) => {
  const directory = join(OUT, side, shard.key);
  const summary = join(directory, 'summary.json');
  if (existsSync(summary)) {
    const done = JSON.parse(readFileSync(summary, 'utf8'));
    // A shard is reused only for the same scenario bytes; --retry-errors reruns shards whose
    // runner errors may be fixed by a runner change (each such rerun is logged, once per pass).
    const stale = done.inputSha256 !== fileSha.get(shard.file);
    // Only summaries admitted after a clean worker exit are evidence (older ones lack `worker`).
    const unadmitted = !reusable(done);
    if (shard.compareOnly) return stale || unadmitted ? null : done;
    const errored = done.runs.some(item => item.status === 'runner-error');
    const infrastructure = errored && values['retry-infra-errors'] && classifySummary(directory, done).some(item => item.class === 'infrastructure');
    const retry = errored && (values['retry-errors'] || infrastructure || (RETRY_BEFORE !== null && statSync(summary).mtimeMs < RETRY_BEFORE));
    if (!stale && !retry && !unadmitted) return done;
    log(`${side} ${shard.key} rerun: ${stale ? 'scenario file changed' : unadmitted ? 'summary was not admitted from a clean worker exit'
      : infrastructure ? 'infrastructure runner-error retry' : 'runner-error retry'}`);
    renameSync(directory, `${directory}.superseded-${Date.now()}`);
  } else if (shard.compareOnly) return null;
  else if (existsSync(directory)) renameSync(directory, `${directory}.partial-${Date.now()}`);
  const logFile = join(OUT, 'logs', side, `${shard.key.replaceAll('/', '__')}.log`);
  const selection = shard.ids.flatMap(id => ['--scenario', id]);
  const args = side === 'A' || side === 'A2'
    ? [...NS, 'xvfb-run', '-a', 'dbus-run-session', '--', process.execPath, 'scripts/electron-migration/record/g3-run-a.mjs', shard.file, receipt, directory,
      ...selection, '--take', side === 'A' ? 'A1' : 'A2', '--gzip', '--compact', '--profile-pool', join(OUT, 'profiles', `${side === 'A' ? 'w' : 'a2w'}${worker}`)]
    : [...NS, process.execPath, 'scripts/electron-migration/record/g3-run-b.mjs', shard.file, directory, ...selection, '--gzip', '--compact'];
  const result = await run(args[0], args.slice(1), logFile, LIMITS, `${side} ${shard.key}`);
  stats.workerOutcomes[result.outcome] = (stats.workerOutcomes[result.outcome] ?? 0) + 1;
  const recording = { file: resolve(identityFile), sha256: sha256(readFileSync(identityFile)) };
  const recorded = acceptSummary(summary, result, { sourceRevision: head, recordingReceipt: recording.file });
  if (recorded) writeFileSync(summary, JSON.stringify(recorded, null, 2));
  // A rejected shard keeps its files for diagnosis but can never be reused or compared.
  const rejectedTo = !recorded && existsSync(directory) ? `${directory}.rejected-${Date.now()}` : null;
  if (rejectedTo) renameSync(directory, rejectedTo);
  const { file: receiptFile } = writeWorkerReceipt(OUT, { side, shard, recording, result, logFile, summaryFile: summary, admitted: recorded, rejectedTo });
  if (!recorded) {
    stats.rejectedShards[side]++;
    log(`${side} ${shard.key} rejected: ${result.outcome} code=${result.code} signal=${result.signal} stdio=${result.stdio}`
      + `${existsSync(rejectedTo ? join(rejectedTo, 'summary.json') : summary) ? '' : ' (no summary)'}; receipt ${receiptFile}; log ${logFile}`);
    return null;
  }
  return recorded;
};

const compares = pool(Number(values['workers-compare']));
const COMPARING = MODE === 'b-only' || (SIDES.has('A') && SIDES.has('B'));
const NEEDS_A2 = MODE === 'b-only' || SIDES.has('A2');
/** N-014 window of a stored A take whose trace predates `recording`: its worker's start (seed build) to its app's exit. */
function storeWindow(take) {
  const from = take.entry.receipt?.process?.startedAt;
  const appProcess = join(dirname(take.trace.file), 'run', 'app-process.json');
  let to = null;
  try { to = JSON.parse(readFileSync(appProcess, 'utf8')).endedAt ?? null; } catch { /* fall back to the worker's end */ }
  to ??= take.entry.receipt?.process?.endedAt;
  return from && to ? ['--a-window', `${from}/${to}`] : [];
}

/** The suite file a stored A take ran, when it differs from this tree's (only other scenarios of it changed). */
function storeSuite(store, file) {
  const stored = store.identity.inputs?.suites?.[file]?.sha256;
  if (!stored || stored === fileSha.get(file)) return [];
  const target = join(OUT, 'a-inputs', `${stored}.json`);
  if (!existsSync(target)) {
    const bytes = storeSuiteFile(process.cwd(), store.identity, file);
    // Unreadable: g3-compare then refuses the A input, and the compare is counted as an error.
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== stored) return [];
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, bytes);
    renameSync(`${target}.tmp`, target);
  }
  return ['--a-scenario-file', target];
}

const compareShard = async (shard, a, b, a2) => {
  const byId = summary => new Map((summary?.runs ?? []).filter(item => item.status === 'recorded').map(item => [item.id, item.trace]));
  const bTraces = byId(b);
  let aTraces = byId(a), a2Traces = byId(a2);
  if (MODE === 'b-only') {
    const takes = shard.ids.map(id => [id, aTake.get(scenarioKey(shard.file, id))]).filter(([, take]) => take);
    aTraces = new Map(takes.map(([id, take]) => [id, take.A.trace.file]));
    a2Traces = new Map(takes.map(([id, take]) => [id, take.A2.trace.file]));
  }
  for (const [side, summary] of [['A', a], ['B', b], ['A2', a2]]) {
    for (const item of summary?.runs ?? []) {
      if (item.status === 'runner-error') stats.runnerErrors[side]++;
      if (item.status === 'unsupported') stats.unsupported[side]++;
    }
    if (summary) tally(classifySummary(join(OUT, side, shard.key), summary), stats.runnerErrorClasses[side], stats.infrastructureSignatures);
  }
  if (!COMPARING || values['record-only']) { writeProgress(); return; }
  await Promise.all(shard.ids.filter(id => aTraces.has(id) && bTraces.has(id) && (!NEEDS_A2 || a2Traces.has(id))).map(id => compares(async () => {
    if (Date.now() > DEADLINE) { stats.deferredCompares = (stats.deferredCompares ?? 0) + 1; return; }
    if (MODE === 'b-only') {
      const take = aTake.get(scenarioKey(shard.file, id));
      for (const side of ['A', 'A2']) {
        writeARef(OUT, { side, storeDir: take.store.dir, storeSha256: take.store.sha256, receiptFile: take[side].entry.file,
          receiptSha256: take[side].entry.sha256, receipt: take[side].entry.receipt });
      }
    }
    // A concurrent recording pass may have superseded this shard since its summary was read.
    if (![aTraces, bTraces, a2Traces].every(map => !map.has(id) || existsSync(map.get(id)))) { stats.staleCompares = (stats.staleCompares ?? 0) + 1; return; }
    const output = join(OUT, 'compare', key(shard.file), `${id}.compare.json.gz`);
    let current = null;
    if (existsSync(output)) {
      try { current = JSON.parse(execFileSync('gzip', ['-dc', output], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] })); }
      catch { renameSync(output, `${output}.broken-${Date.now()}`); log(`compare ${output} unreadable (killed mid-write?); recomputing`); }
    }
    if (current) {
      const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
      if (current.normalizer?.sha256 === normalizerSha256 && (current.approvals?.sha256 ?? null) === approvalsSha256
        && current.traces.A.sha256 === hash(aTraces.get(id)) && current.traces.B.sha256 === hash(bTraces.get(id))
        && (current.traces.A2?.sha256 ?? null) === (a2Traces.has(id) ? hash(a2Traces.get(id)) : null)) {
        stats.compared++; if (current.equal) stats.equal++; else stats.unequal++; return;
      }
      renameSync(output, `${output}.superseded-${Date.now()}`);
    }
    const take = MODE === 'b-only' ? aTake.get(scenarioKey(shard.file, id)) : null;
    const split = take ? ['--split-recording', ...storeWindow(take.A), ...storeSuite(take.store, shard.file)] : [];
    const compared = await run('nice', ['-n', '10', process.execPath, 'scripts/electron-migration/record/g3-compare.mjs', shard.file, id,
      aTraces.get(id), bTraces.get(id), output, ...(a2Traces.has(id) ? ['--a2', a2Traces.get(id)] : []), ...split], join(OUT, 'logs', 'compare', `${key(shard.file)}.log`),
    COMPARE_LIMITS, `compare ${id}`);
    const line = compared.stdout.trim().split('\n').at(-1);
    let result = null;
    // g3-compare exits 1 for an unequal (written) artifact; anything else non-zero is an error.
    const finished = compared.ok || (compared.outcome === 'exited' && compared.code === 1 && compared.stdio === 'closed');
    try { result = finished ? JSON.parse(line) : null; } catch { /* compare threw; its error is in the log */ }
    if (result && !compared.ok && result.equal !== false) result = null;
    if (!result) { stats.compareErrors++; log(`compare error ${shard.file} ${id}: ${compared.outcome} code=${compared.code} signal=${compared.signal}`); return; }
    stats.compared++;
    if (result.equal) stats.equal++; else stats.unequal++;
  })));
  writeProgress();
};

const aPool = pool(Number(values['workers-a'])), bPool = pool(Number(values['workers-b'])), a2Pool = pool(Number(values['workers-a2']));
let aWorker = 0, bWorker = 0, a2Worker = 0;
const timer = setInterval(writeProgress, 30_000);
let deferred = 0;
// Mean shard duration per side: a shard that would not finish before the deadline is not started.
const durations = { A: [], B: [], A2: [] };
const expected = side => (durations[side].length ? durations[side].reduce((x, y) => x + y) / durations[side].length : 0);
const timed = (side, worker, counter) => async () => {
  if (Date.now() + expected(side) > DEADLINE) return DEFERRED;
  const started = Date.now();
  const result = await sideRun(side, ...worker());
  if (Date.now() - started > 5_000) durations[side].push(Date.now() - started); // reused shards are instant
  stats[counter]++;
  return result;
};
await Promise.all(shards.map(async shard => {
  const skip = Promise.resolve(null);
  const [a, b, a2] = await Promise.all([
    SIDES.has('A') ? aPool(timed('A', () => [shard, aWorker++ % Number(values['workers-a'])], 'aDone')) : skip,
    SIDES.has('B') ? bPool(timed('B', () => [shard, bWorker++ % Number(values['workers-b'])], 'bDone')) : skip,
    SIDES.has('A2') ? a2Pool(timed('A2', () => [shard, a2Worker++ % Number(values['workers-a2'])], 'a2Done')) : skip,
  ]);
  if ([a, b, a2].includes(DEFERRED)) { deferred++; return; }
  await compareShard(shard, a, b, a2);
  log(`shard ${shard.key} A2 ${a2?.runs?.filter(r => r.status === 'recorded').length ?? '-'} A ${a?.runs?.filter(r => r.status === 'recorded').length ?? 'x'}/${shard.ids.length} B ${b?.runs?.filter(r => r.status === 'recorded').length ?? 'x'}/${shard.ids.length}`);
}));
clearInterval(timer);
if (stopping) await new Promise(() => {}); // shutdown() owns the exit
stats.deferredShards = deferred;
writeProgress();
const rejected = Object.values(stats.rejectedShards).reduce((n, count) => n + count, 0);
const exitCode = rejected || stats.compareErrors ? 3 : 0;
writeResult(exitCode);
log(`${deferred ? 'deadline' : 'done'} exit ${exitCode} ${JSON.stringify(stats)}`);
process.exitCode = exitCode;
