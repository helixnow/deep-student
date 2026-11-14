#!/usr/bin/env node
// Which A takes a change invalidates: the per-scenario A inputs (g3-inputs/v2) of every valid
// scenario at --to (default: this working tree) against those at --from, each stale one named
// with the components that differ (g3-inputs.mjs scenarioDifference). --from is a commit, or an
// A store directory (its recorded inputs, or for a store from before v2 the inputs recomputed at
// its recording commit, as g3-batch --mode b-only does). A stale scenario here is one b-only
// reports as stale-a against a store recorded at --from; none listed: every A take stays usable.
//   node scripts/electron-migration/record/g3-a-stale.mjs --from REV|A_STORE_DIR [--to REV]
//     [--file SUITE ...] [--domain D,...] [--tz ZONE] [--locale LOCALE] [--no-seeds] [--json]
// Both trees are fingerprinted with this checkout's g3-inputs.mjs, each in a child process of
// its own (the seed generator loads product code) under g3-batch's pinned environment (with an
// A store: the store's, unless --tz/--locale say otherwise). A commit is extracted (git archive)
// into a temporary directory with this checkout's node_modules linked in, removed afterwards.
// --no-seeds builds no seed: seed content is then not compared (the report says so).
// --json lists `topUpScenarios` (stale and missing); g3-supervise --mode a-store --top-up-from
// takes that file when it was made in the clean working tree of the commit being recorded.
// The node runtime and MCP launch components are this machine's: compare an A store on the
// host that runs b-only.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { domainOf, extractTree, inputDifference, inputFingerprint, pinnedEnvironment, scenarioDifference, scenarioEntries, storeScenarioInputs,
  workerEnvironment } from './g3-inputs.mjs';
import { A_STORE_FILE, storeDefects } from './g3-provenance.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPORT_MODULE = 'scripts/electron-migration/record/g3-report.mjs';
const { values } = parseArgs({ options: {
  from: { type: 'string' }, to: { type: 'string' }, file: { type: 'string', multiple: true }, domain: { type: 'string', multiple: true },
  tz: { type: 'string' }, locale: { type: 'string' }, 'no-seeds': { type: 'boolean' }, json: { type: 'boolean' },
  // Internal: print the fingerprint of the tree at this directory (one child per tree).
  'inputs-of': { type: 'string' } } });
const FILES = values.file ?? null;
const DOMAINS = [...new Set((values.domain ?? []).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))];
const selected = file => (!FILES || FILES.includes(file)) && (!DOMAINS.length || DOMAINS.includes(domainOf(file)));
const SEEDS = !values['no-seeds'];

if (values['inputs-of']) {
  // The tree's own scanner decides its corpus and which scenarios are valid, as g3-batch there would.
  const root = resolve(values['inputs-of']);
  const environment = pinnedEnvironment({ tz: values.tz, locale: values.locale });
  const { scanScenarios } = await import(pathToFileURL(join(root, REPORT_MODULE)).href);
  const { suites } = scanScenarios(root);
  const chosen = suites.filter(suite => selected(suite.file));
  const inputs = await inputFingerprint(root, chosen.map(suite => suite.file), environment, undefined, { seeds: SEEDS });
  const text = JSON.stringify({ files: suites.map(suite => suite.file),
    suites: chosen.map(suite => ({ file: suite.file, valid: suite.scenarios.filter(item => item.valid).map(item => item.id) })), inputs });
  await new Promise(done => process.stdout.write(text, done));
  process.exit(0);
}

if (!values.from) throw new Error('usage: g3-a-stale.mjs --from REV|A_STORE_DIR [--to REV] [--file SUITE ...] [--domain D,...] [--tz ZONE] [--locale LOCALE] [--no-seeds] [--json]');
const ROOT = process.cwd();
const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitOf = rev => {
  try { return git('rev-parse', '--verify', '--quiet', `${rev}^{commit}`); } catch { throw new Error(`not a commit: ${rev}`); }
};
const storeDir = existsSync(join(resolve(values.from), A_STORE_FILE)) ? resolve(values.from) : null;
const store = storeDir ? { dir: storeDir, ...storeDefects(storeDir) } : null;
if (store && !store.identity) throw new Error(`A store ${storeDir}: ${store.defects.join(',')}`);
const ENVIRONMENT = pinnedEnvironment({ tz: values.tz ?? store?.identity.environment?.TZ, locale: values.locale ?? store?.identity.environment?.LANG });
try { new Intl.DateTimeFormat('en-US', { timeZone: ENVIRONMENT.TZ }); } catch { throw new Error(`--tz ${ENVIRONMENT.TZ} is not an IANA time zone`); }

const temporary = [];
const cleanup = () => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); };
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, () => { cleanup(); process.exit(code); });
const modules = existsSync(join(ROOT, 'node_modules')) ? realpathSync(join(ROOT, 'node_modules')) : null;
const treeOf = rev => {
  const commit = commitOf(rev);
  const dir = extractTree(ROOT, commit);
  temporary.push(dir);
  if (modules) symlinkSync(modules, join(dir, 'node_modules'));
  return { kind: 'commit', rev, commit, dir };
};
const head = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean);

const fingerprint = side => new Promise((done, fail) => {
  const args = [SELF, '--inputs-of', side.dir, '--tz', ENVIRONMENT.TZ, '--locale', ENVIRONMENT.LANG, ...(SEEDS ? [] : ['--no-seeds']),
    ...(FILES ?? []).flatMap(file => ['--file', file]), ...(DOMAINS.length ? ['--domain', DOMAINS.join(',')] : [])];
  const child = spawn(process.execPath, args, { cwd: side.dir, env: workerEnvironment(ENVIRONMENT), stdio: ['ignore', 'pipe', 'inherit'] });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.on('error', fail);
  child.on('close', (code, signal) => {
    if (code !== 0) { fail(new Error(`fingerprinting ${side.kind === 'commit' ? side.commit : side.dir} failed (${signal ?? `exit ${code}`})`)); return; }
    try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { fail(error); }
  });
});

let report;
try {
  const to = values.to ? treeOf(values.to) : { kind: 'worktree', commit: head, dir: ROOT, dirty };
  const from = store ? null : treeOf(values.from);
  const [toPrint, fromPrint] = await Promise.all([fingerprint(to), from ? fingerprint(from) : null]);
  for (const file of FILES ?? []) if (!toPrint.files.includes(file)) throw new Error(`--file ${file} is not a suite at ${to.kind === 'commit' ? to.commit : 'the working tree'}`);
  const known = new Set(toPrint.files.map(domainOf));
  for (const domain of DOMAINS) if (!known.has(domain)) throw new Error(`unknown domain: ${domain} (known: ${[...known].sort().join(', ')})`);

  const current = scenarioEntries(toPrint.inputs);
  const stored = store ? storeScenarioInputs(ROOT, store.identity, store.dir) : scenarioEntries(fromPrint.inputs);
  const difference = (file, id) => {
    const reasons = stored ? scenarioDifference(stored[file]?.[id], current[file]?.[id]) : inputDifference(store.identity.inputs, toPrint.inputs, file);
    // --no-seeds: this side built none, so a store's seed digests are not compared either.
    const kept = SEEDS ? reasons : reasons?.filter(reason => reason !== 'seed') ?? null;
    return kept?.length ? kept : null;
  };
  const stale = [], missing = [], counts = {};
  let scenarios = 0;
  for (const suite of toPrint.suites) {
    for (const id of suite.valid) {
      scenarios++;
      const reasons = difference(suite.file, id);
      if (!reasons) continue;
      if (reasons.includes('not-in-store')) { missing.push({ file: suite.file, id }); continue; }
      stale.push({ file: suite.file, id, reasons });
      for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  const valid = new Set(toPrint.suites.flatMap(suite => suite.valid.map(id => `${suite.file}\n${id}`)));
  const removed = Object.entries(stored ?? {}).filter(([file]) => selected(file))
    .flatMap(([file, entries]) => Object.keys(entries).filter(id => !valid.has(`${file}\n${id}`)).map(id => ({ file, id })));
  report = {
    schema: 'g3-a-stale/v1',
    from: store
      ? { kind: 'a-store', dir: store.dir, sha256: store.sha256, defects: store.defects, recorderHead: store.identity.recorder?.head ?? null,
        inputsSchema: store.identity.inputs?.schema ?? null,
        scenarioInputs: store.identity.inputs?.scenarios ? 'recorded' : stored ? 'recomputed-from-recorder-head' : 'suite-fingerprint-only' }
      : { kind: 'commit', rev: from.rev, commit: from.commit },
    to: to.kind === 'commit' ? { kind: 'commit', rev: to.rev, commit: to.commit } : { kind: 'worktree', head, dirty },
    environment: ENVIRONMENT, seeds: SEEDS, selection: { files: FILES, domains: DOMAINS },
    scenarios, unaffected: scenarios - stale.length - missing.length, stale, missing, reasons: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))), removed,
    // What an A top-up store recorded from --to needs (g3-supervise --top-up-from, from a clean working tree only).
    topUpScenarios: [...stale, ...missing].map(({ file, id }) => ({ file, id })).sort((a, b) => (a.file === b.file ? (a.id < b.id ? -1 : 1) : a.file < b.file ? -1 : 1)),
  };
} finally { cleanup(); }

if (values.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const { from, to } = report;
  const lines = [
    `from: ${from.kind === 'commit' ? `commit ${from.commit}` : `A store ${from.dir} (A-STORE.json ${from.sha256}; inputs ${from.inputsSchema ?? 'unversioned'}, ${from.scenarioInputs}`
      + `${from.recorderHead ? ` at ${from.recorderHead}` : ''})${from.defects.length ? `; provenance defects ${from.defects.join(',')}: b-only refuses this store` : ''}`}`,
    `to:   ${to.kind === 'commit' ? `commit ${to.commit}` : `working tree at ${to.head}${to.dirty.length ? ` with ${to.dirty.length} modified tracked file(s)` : ' (clean)'}`}`,
    `environment: ${Object.entries(report.environment).map(([key, value]) => `${key}=${value}`).join(' ')}; seeds ${report.seeds ? 'built and compared' : 'not built: seed content is not compared'}`
      + `${FILES || DOMAINS.length ? `; selection ${[...(FILES ?? []), ...DOMAINS].join(' ')}` : ''}`,
    `valid scenarios: ${report.scenarios}; A takes unaffected: ${report.unaffected}; stale: ${report.stale.length}; no A inputs at from: ${report.missing.length}; removed since: ${report.removed.length}`,
  ];
  if (report.stale.length) {
    lines.push('stale by reason:', ...Object.entries(report.reasons).sort(([, a], [, b]) => b - a).map(([reason, count]) => `  ${String(count).padStart(5)}  ${reason}`));
    lines.push('stale scenarios (suite, id, reasons):', ...report.stale.map(item => `  ${item.file}\t${item.id}\t${item.reasons.join(',')}`));
  }
  if (report.missing.length) lines.push('no A inputs at from (suite, id):', ...report.missing.map(item => `  ${item.file}\t${item.id}`));
  process.stdout.write(lines.join('\n') + '\n');
}
