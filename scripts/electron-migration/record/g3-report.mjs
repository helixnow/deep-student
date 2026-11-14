#!/usr/bin/env node
// G3 ledger report (board/G3-LEDGER.md). Scan -> judge -> summarize, machine-generated
// JSON + Markdown from the same object. Every input is hashed so C2 can recompute.
//   node scripts/electron-migration/record/g3-report.mjs [--runs DIR] [--blockers FILE]
//     [--excluded FILE] [--coverage LLVM_COV_EXPORT_SUMMARY.json] [--out DIR] [--jobs N] [--domain D,...]
// --domain adds a batch scope (pass/fail/not-run of the commands of those domains' suites,
// from those suites' runs only); the ledger totals always cover the whole run directory.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { COMPARE_SCHEMA, buildCompare, splitOf } from './g3-compare.mjs';
import { parseExact, readEvidence, stringifyExact } from './json.mjs';
import { validateScenario } from './scenario-v0.mjs';
import { APPROVALS, NORMALIZER, compareFiles, createRunManifest, verifyRunManifest } from './g3-manifest.mjs';
import { normalizerSha256 } from './g3-normalize.mjs';
import { attributionProblem, runProvenance } from './g3-provenance.mjs';
import { CATEGORIES, DEFAULT_KNOWN, RUST_FIX, RUST_FIX_LABEL, classifyCompare, clockOffsets, loadKnown, recordingDates } from './g3-classify.mjs';
import { domainOf } from './g3-inputs.mjs';
import { KINDS as RUST_FIX_KINDS, loadRustFixes } from './g3-rust-fixes.mjs';
import { scanRunnerErrors } from './g3-failures.mjs';

export const STATUSES = ['pass', 'fail', 'no-scenario', 'blocked', 'excluded'];
export const DENOMINATOR = { count: 768, sha256: '4f47fa0afb7d4797ff46ccc82db860eaf7109a5114dd4f7edd9ff6f50d7d718e' };
export const INVENTORY = 'scripts/electron-migration/frontend-audit/wave0-inventory.json';
export const DEFAULT_RUNS = 'fixtures/differential/g3/runs/full';
const SCAN_ROOTS = ['host', 'electron', 'fixtures'];
const SKIP_DIRS = new Set(['node_modules', '.tmp', '.git', 'target']);
// Generated outputs of this pipeline are evidence, not scenario input.
const GENERATED = /^fixtures\/differential\/(g3|g2|runs|a-runs|wp043\/(runs|builds|build-profiles[^/]*))\//;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const CATEGORY_IDS = Object.keys(CATEGORIES);
const knownCache = new Map();
/** The repository's known-difference registry (g3-classify.mjs); absent means none registered. */
export function knownDifferences(root) {
  if (!knownCache.has(root)) {
    const file = join(root, DEFAULT_KNOWN);
    knownCache.set(root, existsSync(file) ? { entries: loadKnown(file), source: { file: DEFAULT_KNOWN, sha256: sha256(readFileSync(file)) } }
      : { entries: [], source: null });
  }
  return knownCache.get(root);
}
const fixesCache = new Map();
/** The repository's rust-fixes/ registrations (g3-rust-fixes.mjs); invalid files are reported, never applied. */
export function rustFixes(root) {
  if (!fixesCache.has(root)) fixesCache.set(root, loadRustFixes(root));
  return fixesCache.get(root);
}
/** Product if any product difference, otherwise the most frequent other category. */
const dominant = counts => !CATEGORY_IDS.some(id => counts[id]) ? null : counts.product ? 'product'
  : CATEGORY_IDS.filter(id => id !== 'product').sort((a, b) => counts[b] - counts[a])[0];
const posix = path => path.split('\\').join('/');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function walk(root, directory, accept) {
  const out = [];
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return out;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = posix(join(directory, entry.name));
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) out.push(...walk(root, path, accept)); }
    else if (accept(path)) out.push(path);
  }
  return out.sort(byName);
}

/** 768 names: inventory rust-contract minus baseline.added (BASELINE.md §G3). */
export function denominator(root, expected = DENOMINATOR) {
  const bytes = readFileSync(join(root, INVENTORY));
  const inventory = JSON.parse(bytes.toString('utf8'));
  const added = new Set(inventory.baseline.added);
  const entries = new Map();
  for (const command of inventory.commands) {
    if (command.kind === 'rust-contract' && !added.has(command.name) && !entries.has(command.name)) entries.set(command.name, command);
  }
  const names = [...entries.keys()].sort(byName);
  const listSha256 = sha256(names.join('\n') + '\n');
  if (names.length !== inventory.baseline.flaggedApp || names.length !== expected.count || listSha256 !== expected.sha256) {
    throw new Error(`denominator drift: ${names.length} names, sha256 ${listSha256}; expected ${expected.count} / ${expected.sha256}`);
  }
  return { names, entries, inventory: { file: INVENTORY, sha256: sha256(bytes), commit: inventory.commit }, listSha256 };
}

/** Scenario suites: a top-level `scenarios` array of objects with `steps` arrays. */
export function scanScenarios(root) {
  const files = SCAN_ROOTS.flatMap(dir => walk(root, dir, path => path.endsWith('.json')
    && !GENERATED.test(path) && (path.startsWith('fixtures/') || /\/(equivalence|wave0)\//.test(path))));
  const suites = [], problems = [];
  for (const file of files) {
    const bytes = readFileSync(join(root, file));
    let json;
    try { json = JSON.parse(bytes.toString('utf8')); }
    catch (error) { problems.push({ kind: 'unparseable-json', file, message: error.message }); continue; }
    if (!Array.isArray(json?.scenarios)) continue;
    if (!json.scenarios.every(item => item && typeof item === 'object' && Array.isArray(item.steps))) {
      problems.push({ kind: 'not-a-v0-suite', file }); continue;
    }
    const track = /(^|\/)g3w-[^/]*\.json$/.test(file) ? 'g3w' : 'owner';
    const scenarios = json.scenarios.map(scenario => {
      let valid = true;
      try { validateScenario(scenario); }
      catch (error) { valid = false; problems.push({ kind: 'invalid-scenario', file, id: scenario.id ?? null, message: error.message }); }
      if (track === 'g3w' && !String(scenario.id).startsWith('g3w.')) problems.push({ kind: 'g3w-id-prefix', file, id: scenario.id ?? null });
      return { id: scenario.id, valid, steps: scenario.steps.map(step => ({ cmd: step?.cmd, expect: step?.expect })) };
    });
    suites.push({ file, sha256: sha256(bytes), track, scenarios });
  }
  return { suites, problems };
}

/** `<runs>/compare/<group>/<id>.compare.json` → `<runs>`. */
function runsDirOf(file) {
  let directory = dirname(file);
  while (basename(directory) !== 'compare' && dirname(directory) !== directory) directory = dirname(directory);
  return dirname(directory);
}

/**
 * One compare artifact, re-verified from raw traces; nothing in the artifact is believed.
 * Its traces must also be attributable: listed (by sha256) in admitted worker receipts of a
 * run whose RECORDING.json pins the B revision, Host receipt and A build receipt.
 */
export async function verifyCompare(root, file, bySuite, provenance = runProvenance(root, runsDirOf(file))) {
  const invalid = message => ({ run: null, problem: { kind: 'invalid-compare', file, message } });
  const { bytes, text } = readEvidence(join(root, file));
  let artifact;
  try { artifact = JSON.parse(text); } catch (error) { return invalid(error.message); }
  if (artifact?.schema !== COMPARE_SCHEMA || artifact.input !== 'same-input') return invalid('not a same-input g3-compare-v1 artifact');
  const normalizerHash = normalizerSha256(root);
  if (artifact.normalizer?.file !== NORMALIZER || artifact.normalizer?.sha256 !== normalizerHash) return invalid('normalizer sha256 mismatch (stale compare)');
  const suite = bySuite.get(artifact.scenario?.file);
  if (!suite) return invalid(`scenario file not in scanned corpus: ${artifact.scenario?.file}`);
  if (suite.sha256 !== artifact.scenario.sha256) return invalid('scenario file changed since this run (stale)');
  const evidence = { scenario: { file: suite.file, sha256: suite.sha256 } };
  // A2 (second independent A take) is evidence too when the artifact was normalized.
  for (const side of artifact.traces?.A2 ? ['A', 'B', 'A2'] : ['A', 'B']) {
    const trace = artifact.traces?.[side];
    if (!trace?.file || !existsSync(join(root, trace.file))) return invalid(`${side} trace missing`);
    const actual = sha256(readFileSync(join(root, trace.file)));
    if (actual !== trace.sha256) return invalid(`${side} trace sha256 mismatch`);
    evidence[side] = { file: trace.file, sha256: actual };
  }
  if (evidence.A2) {
    const approvals = artifact.approvals;
    if (!approvals?.file || !existsSync(join(root, approvals.file))) return invalid('normalization approvals file missing');
    const actual = sha256(readFileSync(join(root, approvals.file)));
    if (actual !== approvals.sha256) return invalid('normalization approvals sha256 mismatch');
    if (actual !== sha256(readFileSync(join(root, APPROVALS)))) return invalid('normalization approvals differ from sealed repository approvals');
    evidence.approvals = { file: approvals.file, sha256: actual };
  }
  const unattributed = attributionProblem(root, provenance, evidence);
  if (unattributed) return { run: null, problem: { kind: 'unattributable-recording', file, message: unattributed } };
  // N-014: the A window a split compare used must lie inside the admitted A take's worker window.
  const { split, aWindow, aScenarioFile } = splitOf(artifact);
  if (aWindow) {
    const outer = provenance.windows?.[resolve(root, evidence.A.file)];
    const from = Date.parse(outer?.startedAt ?? ''), to = Date.parse(outer?.endedAt ?? '');
    if (!(aWindow.from >= from && aWindow.to <= to)) return invalid('N-014 A recording window is not inside the A take\'s worker window');
  }
  let recomputed;
  try {
    recomputed = await buildCompare({ scenarioFile: join(root, suite.file), scenarioId: artifact.scenario.id,
      aTrace: join(root, evidence.A.file), bTrace: join(root, evidence.B.file),
      a2Trace: evidence.A2 ? join(root, evidence.A2.file) : null, approvalsFile: evidence.approvals?.file, root, split, aWindow, aScenarioFile });
  } catch (error) { return invalid(`recompute failed: ${error.message}`); }
  if (recomputed.equal !== artifact.equal || recomputed.differences.length !== artifact.differences?.length) {
    return invalid('recorded result differs from recomputation');
  }
  // N-003: the substitution list is part of the evidence and must be reproducible exactly.
  const recorded = parseExact(text);
  const listed = value => stringifyExact(value ?? null);
  if (listed(recomputed.normalization) !== listed(recorded.normalization) || listed(recomputed.excludedFiles) !== listed(recorded.excludedFiles)) {
    return invalid('recorded normalization list differs from recomputation');
  }
  evidence.compare = { file, sha256: sha256(bytes) };
  // Takes recorded on different days (A store vs later B): date values may shift by those days.
  const timeZone = provenance.recording?.environment?.TZ ?? 'UTC';
  const windows = Object.fromEntries(['A', 'A2', 'B'].map(side => [side, evidence[side] ? provenance.windows?.[resolve(root, evidence[side].file)] ?? null : null]));
  const clock = { timeZone, offsets: clockOffsets(windows, timeZone),
    dates: Object.fromEntries(Object.entries(windows).map(([side, window]) => [side, recordingDates(window, timeZone)])) };
  const classification = classifyCompare(recomputed, knownDifferences(root).entries, clock, rustFixes(root));
  // An approved rust-fixes/ hit is not an inconsistency: equality and per-command counts exclude it.
  const categories = {}, perCommand = {};
  const fixesOf = { exempt: new Map(), pending: new Map() };
  for (const command of recomputed.commands) {
    categories[command] = Object.fromEntries(CATEGORY_IDS.map(id => [id, 0]));
    perCommand[command] = { ...recomputed.perCommand[command], differences: 0, exempt: 0 };
    recomputed.differences.forEach((difference, index) => {
      if (difference.command !== command && difference.command !== null) return;
      const classified = classification.differences[index];
      if (classified.category === RUST_FIX) perCommand[command].exempt++;
      else { categories[command][classified.category]++; perCommand[command].differences++; }
    });
  }
  recomputed.differences.forEach((difference, index) => {
    const classified = classification.differences[index];
    const commands = difference.command === null ? recomputed.commands : [difference.command];
    for (const [list, fixes] of [[fixesOf.exempt, classified.rustFix ? [classified.rustFix] : []], [fixesOf.pending, classified.pending ?? []]]) {
      for (const fix of fixes) {
        const row = list.get(fix.id) ?? { id: fix.id, kind: fix.kind, differences: 0, commands: [] };
        row.differences++;
        row.commands = [...new Set([...row.commands, ...commands])].sort();
        list.set(fix.id, row);
      }
    }
  });
  return { run: { scenario: artifact.scenario.id, file: suite.file, equal: classification.counted === 0, rawEqual: recomputed.equal,
    normalized: recomputed.normalized, normalizationEntries: recomputed.normalization.length, perCommand, evidence,
    aStore: provenance.aSources?.[resolve(root, evidence.A.file)] ?? null,
    category: classification.summary, known: classification.knownIds, categories, clock,
    rustFixes: { exempt: [...fixesOf.exempt.values()], pending: [...fixesOf.pending.values()] } }, problem: null };
}

/** Compare artifacts produced by g3-compare.mjs; `jobs` > 1 verifies in worker threads (same result, file order). */
export async function scanRuns(root, runsDir, suites, jobs = 1, provenance = runProvenance(root, runsDir)) {
  const files = compareFiles(root, runsDir);
  const bySuite = new Map(suites.map(suite => [suite.file, { file: suite.file, sha256: suite.sha256 }]));
  let results;
  if (jobs <= 1 || files.length < 2) {
    results = [];
    for (const file of files) results.push(await verifyCompare(root, file, bySuite, provenance));
  } else {
    const { Worker } = await import('node:worker_threads');
    results = new Array(files.length);
    let next = 0;
    const worker = () => new Promise((done, fail) => {
      const thread = new Worker(new URL(import.meta.url), { workerData: { g3VerifyWorker: true, root, suites: [...bySuite.values()], provenance } });
      const feed = () => { if (next >= files.length) { thread.postMessage(null); return; } const index = next++; thread.postMessage({ index, file: files[index] }); };
      thread.on('message', ({ index, result }) => { results[index] = result; feed(); });
      thread.on('error', fail);
      thread.on('exit', code => (code === 0 ? done() : fail(new Error(`verify worker exited ${code}`))));
      feed();
    });
    await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  }
  const runs = [], problems = [];
  for (const { run, problem } of results) { if (run) runs.push(run); if (problem) problems.push(problem); }
  return { runs, problems };
}

function readRecords(root, file, label) {
  if (!file) return { records: [], source: null };
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) return { records: [], source: { file, sha256: null, missing: true } };
  const bytes = readFileSync(absolute);
  const json = JSON.parse(bytes.toString('utf8'));
  // Board files (g3-blockers/v1, g3-excluded/v1) wrap records in `items`.
  const records = Array.isArray(json) ? json : json?.[label] ?? json?.items;
  if (!Array.isArray(records)) throw new Error(`${file}: expected an array, {${label}: []} or {items: []}`);
  return { records, source: { file, sha256: sha256(bytes) } };
}

const nonempty = value => typeof value === 'string' && value.trim() !== '';

/** G3-LEDGER §2: blocked needs owner, unblock condition, reviewer and existing evidence. */
export function blockerDefect(record, root) {
  const missing = ['blocker', 'owner', 'condition', 'reviewer'].filter(key => !nonempty(record[key]));
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  if (!evidence.length) missing.push('evidence');
  for (const path of evidence) if (!nonempty(path) || !existsSync(resolve(root, path))) missing.push(`evidence:${path}`);
  return missing;
}

/** G3-LEDGER §2: excluded only for no-A-command / not-a-Rust-contract, approved by C2. */
export function exclusionDefect(record) {
  const missing = [];
  if (!['no-a-command', 'not-rust-contract'].includes(record.reason)) missing.push('reason');
  if (record.approvedBy !== 'C2-platform') missing.push('approvedBy');
  if (!nonempty(record.approval)) missing.push('approval');
  if (!nonempty(record.note)) missing.push('note');
  return missing;
}

export function coverageSummary(root, file) {
  if (!file) return { status: 'not-measured', lines: null, reason: 'no llvm-cov export summary supplied' };
  const bytes = readFileSync(resolve(root, file));
  const lines = JSON.parse(bytes.toString('utf8'))?.data?.[0]?.totals?.lines;
  if (!Number.isSafeInteger(lines?.count) || !Number.isSafeInteger(lines?.covered) || lines.count <= 0) {
    throw new Error(`${file}: not an llvm-cov export summary (data[0].totals.lines)`);
  }
  return { status: 'measured', source: { file, sha256: sha256(bytes) },
    lines: { covered: lines.covered, count: lines.count, percent: Number((lines.covered / lines.count * 100).toFixed(2)) } };
}

/** Batch view for --domain: commands of the domains' suites, judged on those suites' runs only. */
function batchScope(domains, suites, commands) {
  const rank = file => domains.indexOf(domainOf(file));
  const inScope = suites.map(suite => suite.file).filter(file => rank(file) >= 0)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const files = new Set(inScope);
  const rows = commands.filter(row => row.scenarios.files.some(file => files.has(file))).map(row => {
    const runs = row.runs.filter(run => files.has(run.file));
    return { command: row.command, status: !runs.length ? 'not-run' : runs.some(run => !run.equal) ? 'fail' : 'pass', runs: runs.length };
  });
  const totals = Object.fromEntries(['pass', 'fail', 'not-run'].map(status => [status, rows.filter(row => row.status === status).length]));
  return { domains, suites: inScope, commands: rows, totals };
}

export async function buildReport({ root = process.cwd(), runsDir = DEFAULT_RUNS, blockers, excluded, coverage, expected, jobs = 1, domains = [] } = {}) {
  root = resolve(root);
  const base = denominator(root, expected);
  const { suites, problems: scenarioProblems } = scanScenarios(root);
  const manifest = verifyRunManifest(root, runsDir, suites);
  const provenance = runProvenance(root, runsDir);
  const { runs, problems: runProblems } = await scanRuns(root, runsDir, suites, jobs, provenance);
  // Recheck after recomputation: an active batch changing inputs must not yield a sealed report.
  const after = verifyRunManifest(root, runsDir, suites);
  if (after.sha256 !== manifest.sha256) throw new Error('RUN-MANIFEST changed while report was recomputed');
  const blockerInput = readRecords(root, blockers, 'blockers');
  const excludedInput = readRecords(root, excluded, 'excluded');
  const fixes = rustFixes(root);
  const problems = [...scenarioProblems, ...runProblems,
    ...fixes.problems.map(problem => ({ kind: 'invalid-rust-fix', file: problem.file, message: `${problem.message} (not applied)` }))];
  const inDenominator = new Set(base.names);
  const index = (records, kind) => {
    const map = new Map();
    for (const record of records) {
      if (!inDenominator.has(record?.command)) problems.push({ kind: `${kind}-outside-denominator`, command: record?.command ?? null });
      else if (map.has(record.command)) problems.push({ kind: `${kind}-duplicate`, command: record.command });
      else map.set(record.command, record);
    }
    return map;
  };
  const blockerOf = index(blockerInput.records, 'blocker');
  const exclusionOf = index(excludedInput.records, 'excluded');

  const scenarioRefs = new Map(base.names.map(name => [name, []]));
  const outside = new Set();
  for (const suite of suites) {
    for (const scenario of suite.scenarios) {
      const steps = scenario.steps.filter(step => typeof step.cmd === 'string');
      for (const cmd of new Set(steps.map(step => step.cmd))) {
        if (!scenarioRefs.has(cmd)) { outside.add(cmd); continue; }
        scenarioRefs.get(cmd).push({ file: suite.file, sha256: suite.sha256, id: scenario.id, track: suite.track,
          valid: scenario.valid, errorSteps: steps.filter(step => step.cmd === cmd && step.expect === 'error').length });
      }
    }
  }
  const commands = base.names.map(name => {
    const entry = base.entries.get(name);
    const scenarios = scenarioRefs.get(name);
    const attributed = runs.filter(run => run.perCommand[name]).map(run => ({ scenario: run.scenario, file: run.file,
      equal: run.perCommand[name].differences === 0, differences: run.perCommand[name].differences, exempt: run.perCommand[name].exempt ?? 0,
      evidence: run.evidence, categories: run.categories?.[name] ?? null, known: run.known ?? [], clock: run.clock ?? null,
      rustFixes: { exempt: (run.rustFixes?.exempt ?? []).filter(fix => fix.commands.includes(name)).map(fix => fix.id),
        pending: (run.rustFixes?.pending ?? []).filter(fix => fix.commands.includes(name)).map(fix => fix.id) } }));
    const row = { command: name, owner: entry.owner?.lane ?? null, rust: entry.rust?.file ? `${entry.rust.file}:${entry.rust.line}` : null,
      scenarios: { count: scenarios.length, owner: scenarios.filter(s => s.track === 'owner').length,
        g3w: scenarios.filter(s => s.track === 'g3w').length, errorSteps: scenarios.reduce((n, s) => n + s.errorSteps, 0),
        files: [...new Set(scenarios.map(s => s.file))] },
      runs: attributed, status: 'no-scenario', note: null, blocker: null, exclusion: null, category: null,
      rustFixes: { exempt: [...new Set(attributed.flatMap(run => run.rustFixes.exempt))].sort(), exemptDifferences: attributed.reduce((n, run) => n + run.exempt, 0),
        pending: [...new Set(attributed.flatMap(run => run.rustFixes.pending))].sort() } };
    const exclusion = exclusionOf.get(name);
    const blocker = blockerOf.get(name);
    if (exclusion && !exclusionDefect(exclusion).length) {
      row.status = 'excluded'; row.exclusion = exclusion;
    } else if (attributed.some(run => !run.equal)) {
      row.status = 'fail';
      const counts = Object.fromEntries(CATEGORY_IDS.map(id => [id, attributed.reduce((n, run) => n + (run.categories?.[id] ?? 0), 0)]));
      row.category = { summary: dominant(counts), counts, known: [...new Set(attributed.flatMap(run => run.known))].sort() };
    } else if (attributed.length) {
      row.status = 'pass';
      const unrun = scenarios.filter(s => !attributed.some(run => run.scenario === s.id && run.file === s.file)).length;
      if (unrun) row.note = `${unrun} scenario(s) not yet run`;
    } else if (blocker && !blockerDefect(blocker, root).length) {
      row.status = 'blocked'; row.blocker = blocker;
    } else {
      const reasons = [];
      if (exclusion) reasons.push(`exclusion incomplete: ${exclusionDefect(exclusion).join(',')}`);
      if (blocker) reasons.push(`blocker without evidence: ${blockerDefect(blocker, root).join(',')}`);
      reasons.push(scenarios.length ? 'scenario exists, A/B not run' : 'no scenario');
      row.note = reasons.join('; ');
    }
    return row;
  });

  const totals = Object.fromEntries(STATUSES.map(status => [status, commands.filter(row => row.status === status).length]));
  const failCategories = Object.fromEntries(CATEGORY_IDS.map(id => [id, {
    commands: commands.filter(row => row.category?.summary === id).length,
    differences: commands.reduce((n, row) => n + (row.category?.counts[id] ?? 0), 0) }]));
  const sum = STATUSES.reduce((n, status) => n + totals[status], 0);
  if (sum !== base.names.length) throw new Error(`status sum ${sum} != denominator ${base.names.length}`);
  const fixTally = list => {
    const byId = new Map();
    for (const run of runs) for (const fix of run.rustFixes[list]) {
      const row = byId.get(fix.id) ?? { id: fix.id, kind: fix.kind, differences: 0, scenarios: 0, commands: [] };
      row.differences += fix.differences;
      row.scenarios++;
      row.commands = [...new Set([...row.commands, ...fix.commands])].sort();
      byId.set(fix.id, row);
    }
    return [...byId.values()].sort((a, b) => RUST_FIX_KINDS.indexOf(a.kind) - RUST_FIX_KINDS.indexOf(b.kind) || byName(a.id, b.id));
  };
  return {
    schema: 'g3-report-v1', rules: 'board/G3-LEDGER.md',
    head: gitHead(root),
    denominator: { count: base.names.length, sha256: base.listSha256, inventory: base.inventory },
    totals, sum, failCategories, passRate: { pass: totals.pass, of: base.names.length, percent: Number((totals.pass / base.names.length * 100).toFixed(2)) },
    withScenario: commands.filter(row => row.scenarios.count).length,
    coverage: coverageSummary(root, coverage),
    recording: { ...(provenance.recording ?? { file: null }), defects: provenance.defects, workerReceipts: provenance.workerReceipts, aRefs: provenance.aRefs,
      ...(provenance.recording?.aStores ? { aStores: provenance.recording.aStores.map(store => ({ ...store,
        scenarios: runs.filter(run => run.aStore === store.sha256).map(run => `${run.file}#${run.scenario}`).sort() })) } : {}) },
    clock: { timeZone: provenance.recording?.environment?.TZ ?? 'UTC', shiftedRuns: runs.filter(run => run.clock.offsets.length).length,
      offsets: [...new Set(runs.flatMap(run => run.clock.offsets))].sort((a, b) => a - b),
      clockSkewRuns: runs.filter(run => run.known?.includes('clock-skew')).length },
    runnerErrors: (({ counts, signatures, infrastructure }) => ({ counts, signatures, infrastructure: infrastructure.length }))(scanRunnerErrors(resolve(root, runsDir))),
    ...(domains.length ? { scope: batchScope(domains, suites, commands) } : {}),
    rustFixes: { source: fixes.source, applied: fixes.entries.map(entry => ({ id: entry.id, kind: entry.kind, status: entry.status })),
      exempt: fixTally('exempt'), pending: fixTally('pending') },
    inputs: {
      manifest,
      scenarioFiles: suites.map(({ file, sha256: hash, track, scenarios }) => ({ file, sha256: hash, track, scenarios: scenarios.length })),
      runs: runs.map(run => run.evidence.compare), blockers: blockerInput.source, excluded: excludedInput.source,
      known: knownDifferences(root).source, rustFixes: fixes.source,
    },
    commandsOutsideDenominator: [...outside].sort(byName),
    problems, commands,
  };
}

function gitHead(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

function recordingLine(recording) {
  if (recording.defects.length) {
    return `录制回执：不完整（${recording.defects.join('、')}），本目录的 compare 一律不计入 pass/fail；B 端提交、Host 回执、A 构建回执须由 g3-batch 录制时写入。`;
  }
  const stores = recording.aSource === 'a-store'
    ? `A/A2 取自 A 预录目录 ${recording.aStores.length} 个（${recording.aStores.map(store => `\`${store.dir}\` A-STORE.json sha256 \`${store.sha256}\`，提供 ${store.scenarios?.length ?? 0} 个场景的 A`).join('；')}；逐场景来源见 g3-report.json recording.aStores[].scenarios），`
      + `经 ${recording.aRefs?.count ?? 0} 份引用逐份按 sha256 校验 store 回执，且 store 的 A 构建回执、环境、场景输入指纹须与本录制一致；` : '';
  return `录制回执：\`${recording.file}\`（sha256 \`${recording.sha256}\`）；B 端提交 \`${recording.bHead}\`（工作树干净），`
    + `Host 回执 sha256 \`${recording.hostReceiptSha256}\`，A 构建回执 sha256 \`${recording.aBuildReceiptSha256}\`（binary \`${recording.aBinarySha256}\`）；`
    + `${stores}worker 回执 ${recording.workerReceipts.count} 份。只计入 worker 回执列出的 trace。`;
}

function clockLine(clock) {
  if (!clock?.shiftedRuns) return null;
  return `录制日期：${clock.shiftedRuns} 个 compare 的 B 与 A/A2 不在同一天（${clock.timeZone}，B−A 天数 ${clock.offsets.join('、')}）；`
    + `其中 ${clock.clockSkewRuns} 个含仅按录制日期平移的差异（归类“环境差异 clock-skew”，仍计 fail）。日期以外的时间相关差异（剩余天数等）无法自动识别，需同日重录 A 复核。`;
}

function runnerErrorLine(runnerErrors) {
  if (!runnerErrors) return null;
  const sides = kind => Object.entries(runnerErrors.counts).filter(([, counts]) => counts[kind]).map(([side, counts]) => `${side}=${counts[kind]}`).join(' ');
  if (!sides('infrastructure') && !sides('scenario')) return null;
  return `Runner 错误：基础设施失败（EAGAIN、线程/进程创建被拒）${sides('infrastructure') || '0'}`
    + `${Object.keys(runnerErrors.signatures).length ? `（签名 ${Object.entries(runnerErrors.signatures).map(([id, n]) => `${id}×${n}`).join('、')}）` : ''}，`
    + `不是场景结果，用 --retry-infra-errors 重录；场景 runner 错误 ${sides('scenario') || '0'}。两类都不进 compare，相关命令按“未跑”计。`;
}

const FIX_KIND_LABELS = { 'rust-bug': 'Rust 缺陷修复', deliberate: '产品决策' };
function rustFixLines(fixes) {
  if (!fixes?.source.files.length) return [];
  const lines = ['## Rust 修复登记（rust-fixes/）', '',
    `登记目录 \`${fixes.source.dir}\`：${fixes.source.files.length} 个文件（合并 sha256 \`${fixes.source.sha256}\`），生效 ${fixes.applied.length} 条，格式不符的见“问题”且不生效。`
    + `approved 登记命中的差异归“${RUST_FIX_LABEL}”，不计不一致；proposed 登记命中的差异列为待审，照常计入 fail。`
    + '选择器须覆盖一条差异的全部差异位置才算命中。', ''];
  for (const kind of RUST_FIX_KINDS) {
    const exempt = fixes.exempt.filter(fix => fix.kind === kind), pending = fixes.pending.filter(fix => fix.kind === kind);
    lines.push(`### ${kind}（${FIX_KIND_LABELS[kind]}）：豁免 ${exempt.length} 条登记 / 待审 ${pending.length} 条登记`, '');
    if (!exempt.length && !pending.length) continue;
    lines.push('| kind | 登记 | 状态 | 差异条数 | compare 数 | 命令 |', '|---|---|---|---:|---:|---|');
    for (const [label, list] of [['豁免（approved）', exempt], ['待审（proposed，仍计 fail）', pending]]) {
      for (const fix of list) lines.push(`| ${kind} | ${cell(fix.id)} | ${label} | ${fix.differences} | ${fix.scenarios} | ${cell(fix.commands.join(', '))} |`);
    }
    lines.push('');
  }
  return lines;
}

function scopeLines(scope) {
  if (!scope) return [];
  const lines = [`## 本批范围（${scope.domains.join('、')}）`, '',
    `套件 ${scope.suites.length} 个；命令 ${scope.commands.length} 个：pass ${scope.totals.pass}，fail ${scope.totals.fail}，未跑 ${scope.totals['not-run']}。只看本批套件的 compare；上方台账总数覆盖整个录制目录。`, '',
    '| 命令 | 状态 | compare 数 |', '|---|---|---:|'];
  for (const row of scope.commands) lines.push(`| ${cell(row.command)} | ${row.status} | ${row.runs} |`);
  return [...lines, ''];
}

export function renderMarkdown(report) {
  const t = report.totals;
  const coverage = report.coverage.status === 'measured'
    ? `${report.coverage.lines.percent}%（${report.coverage.lines.covered}/${report.coverage.lines.count} 行，${report.coverage.source.file} sha256 ${report.coverage.source.sha256}）`
    : `未测量（${report.coverage.reason}）`;
  const lines = [
    '# G3 报告（机器生成，勿手改）', '',
    `规则：${report.rules}；HEAD \`${report.head}\`；分母 ${report.denominator.count}（sha256 \`${report.denominator.sha256}\`，inventory \`${report.denominator.inventory.sha256}\`）。`, '',
    '| pass | fail | no-scenario | blocked | excluded | 合计 |', '|---:|---:|---:|---:|---:|---:|',
    `| ${t.pass} | ${t.fail} | ${t['no-scenario']} | ${t.blocked} | ${t.excluded} | ${report.sum} |`, '',
    `通过率：**${report.passRate.pass}/${report.passRate.of} = ${report.passRate.percent}%**。`,
    `有场景文件的命令：${report.withScenario}（仅信息，不作分母）。`,
    `Rust 行覆盖率（instrument-coverage 实测）：${coverage}。`,
    `扫描场景文件 ${report.inputs.scenarioFiles.length} 个，有效 compare 产物 ${report.inputs.runs.length} 个，问题 ${report.problems.length} 条。`, '',
    `输入封存：\`${report.inputs.manifest.file}\`（sha256 \`${report.inputs.manifest.sha256}\`）；A/A2/B 为 compare 引用计数，不是 progress 计数。`,
    recordingLine(report.recording), ...(clockLine(report.clock) ? [clockLine(report.clock)] : []),
    ...(runnerErrorLine(report.runnerErrors) ? [runnerErrorLine(report.runnerErrors)] : []), '',
    ...scopeLines(report.scope), ...rustFixLines(report.rustFixes),
  ];
  if (report.failCategories) {
    lines.push('## fail 归类', '', '归类只说明差异来源，不改变 fail。命令归类：有任一真实产品差异即为真实产品差异，否则取条数最多的一类。'
      + `登记表：\`${report.inputs.known?.file ?? '（无）'}\`${report.inputs.known ? `（sha256 \`${report.inputs.known.sha256}\`）` : ''}。`, '',
    '| 归类 | 命令数 | 差异条数 |', '|---|---:|---:|');
    for (const [id, label] of Object.entries(CATEGORIES)) lines.push(`| ${label} | ${report.failCategories[id].commands} | ${report.failCategories[id].differences} |`);
    lines.push('');
  }
  if (report.problems.length) {
    lines.push('## 问题', '', '| kind | file/command | detail |', '|---|---|---|');
    for (const p of report.problems) lines.push(`| ${cell(p.kind)} | ${cell(p.file ?? p.command)} | ${cell(p.message ?? p.id ?? '')} |`);
    lines.push('');
  }
  lines.push('## 逐命令', '', '| 命令 | owner | 状态 | 场景(owner/g3w) | 证据（scenario / A / B / compare，sha256） | 备注 |', '|---|---|---|---|---|---|');
  for (const row of report.commands) {
    const evidence = row.runs.map(run => ['scenario', 'A', 'B', 'compare']
      .map(key => `${run.evidence[key].file}@${run.evidence[key].sha256.slice(0, 12)}`).join(' / ')).join('<br>');
    const category = row.category?.summary ? `归类：${CATEGORIES[row.category.summary]}（${CATEGORY_IDS.filter(id => row.category.counts[id])
      .map(id => `${CATEGORIES[id]} ${row.category.counts[id]}`).join('，')}${row.category.known.length ? `；${row.category.known.join(',')}` : ''}）` : null;
    const fixes = [row.rustFixes?.exempt.length ? `${RUST_FIX_LABEL} ${row.rustFixes.exemptDifferences}（${row.rustFixes.exempt.join(',')}）` : null,
      row.rustFixes?.pending.length ? `待审 ${row.rustFixes.pending.join(',')}` : null];
    const note = row.blocker ? `blocker owner=${row.blocker.owner}; 解除=${row.blocker.condition}; 复核=${row.blocker.reviewer}`
      : row.exclusion ? `excluded ${row.exclusion.reason}; ${row.exclusion.approval}` : [category, ...fixes, row.note].filter(Boolean).join('; ');
    lines.push(`| ${cell(row.command)} | ${cell(row.owner)} | ${row.status} | ${row.scenarios.owner}/${row.scenarios.g3w} | ${cell(evidence)} | ${cell(note)} |`);
  }
  return lines.join('\n') + '\n';
}

/** The default record files live on the shared board beside G3-LEDGER.md. */
function boardFile(root, name) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    return join(resolve(common, '..'), '.oc-runs/board/g3', name);
  } catch { return undefined; }
}

const { isMainThread, parentPort, workerData } = await import('node:worker_threads');
if (!isMainThread && workerData?.g3VerifyWorker) {
  const bySuite = new Map(workerData.suites.map(suite => [suite.file, suite]));
  parentPort.on('message', async job => {
    if (job === null) { parentPort.close(); return; }
    parentPort.postMessage({ index: job.index, result: await verifyCompare(workerData.root, job.file, bySuite, workerData.provenance) });
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    runs: { type: 'string', default: DEFAULT_RUNS }, blockers: { type: 'string' }, excluded: { type: 'string' },
    coverage: { type: 'string' }, out: { type: 'string', default: 'fixtures/differential/g3' }, jobs: { type: 'string', default: '1' },
    'write-manifest': { type: 'boolean' }, domain: { type: 'string', multiple: true },
  } });
  const root = process.cwd();
  if (values['write-manifest']) {
    const { suites } = scanScenarios(root);
    const manifest = createRunManifest(root, values.runs, suites);
    const file = join(values.runs, 'RUN-MANIFEST.json');
    // Deliberately separate from report generation: never silently reseal stale inputs.
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ file, sides: manifest.sides, compares: manifest.compares.length }));
  } else {
  const domains = [...new Set((values.domain ?? []).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))];
  const report = await buildReport({ root, runsDir: values.runs, coverage: values.coverage, jobs: Number(values.jobs), domains,
    blockers: values.blockers ?? boardFile(root, 'blockers.json'), excluded: values.excluded ?? boardFile(root, 'excluded.json') });
  mkdirSync(values.out, { recursive: true });
  const json = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(join(values.out, 'g3-report.json'), json);
  writeFileSync(join(values.out, 'g3-report.md'), renderMarkdown(report));
  console.log(JSON.stringify({ out: posix(relative(root, resolve(values.out))), totals: report.totals, sum: report.sum,
    passRate: report.passRate, withScenario: report.withScenario, coverage: report.coverage.status,
    problems: report.problems.length, jsonSha256: sha256(json) }));
  }
}
