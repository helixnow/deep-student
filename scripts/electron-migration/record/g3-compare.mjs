#!/usr/bin/env node
// G3 compare artifact: one v0 scenario, one A trace, one B trace (plus an optional second
// independent A take, A2) -> one immutable compare file. Raw evidence is never modified.
// Without A2 nothing is normalized. With A2, only the C2-approved rules N-001…N-005
// (g3-normalize.mjs) apply, and every substitution is listed in `normalization`.
// Incomplete evidence throws instead of producing an artifact, so a missing side can
// never become an equal result.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { evidenceBytes, firstDifference, parseExact, readEvidence, stringifyExact } from './json.mjs';
import { validateScenario } from './scenario-v0.mjs';
import { loadApprovals, normalizeTraces, normalizerSha256 } from './g3-normalize.mjs';
import { differingPaths } from './g3-rust-fixes.mjs';
import { startupProtocol } from './g3-startup.mjs';

// Cache key for g3-batch: any normalizer edit invalidates previously computed compares.
export const NORMALIZER_FILE = 'scripts/electron-migration/record/g3-normalize.mjs';

export const COMPARE_SCHEMA = 'g3-compare-v1';
export const TRACE_SCHEMA = 'wave0-v0-observation';
const SAMPLE_LIMIT = 50;
// Repository snapshot of board/g3/normalize-approvals.json (C2); its sha256 is in every artifact.
export const DEFAULT_APPROVALS = 'fixtures/differential/g3/normalize-approvals.json';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function directoryState(value, where) {
  if (!value || typeof value !== 'object' || Number(value.version) !== 0 || !value.databases
    || typeof value.databases !== 'object' || Array.isArray(value.databases)) {
    throw new Error(`${where}: database capture is not an X3 DirectoryState {version:0,databases}`);
  }
  return value;
}

function readTrace(file, scenario, side) {
  const { bytes, text } = readEvidence(file);
  // X3 DirectoryState is lossless plain JSON (integers are strings), so database
  // captures use JSON.parse.
  const trace = JSON.parse(text);
  if (trace?.schema !== TRACE_SCHEMA) throw new Error(`${side} trace schema must be ${TRACE_SCHEMA}: ${file}`);
  if (trace.scenario !== scenario.id) throw new Error(`${side} trace is for ${trace.scenario}, not ${scenario.id}`);
  if (typeof trace.inputSha256 !== 'string') throw new Error(`${side} trace lacks inputSha256 of its scenario file`);
  if (!Array.isArray(trace.calls) || trace.calls.length !== scenario.steps.length) {
    throw new Error(`${side} trace is incomplete: ${trace.calls?.length ?? 0}/${scenario.steps.length} steps`);
  }
  for (const [index, call] of trace.calls.entries()) {
    if (call?.command !== scenario.steps[index].cmd) throw new Error(`${side} step ${index} ran ${call?.command}, scenario has ${scenario.steps[index].cmd}`);
    if (!['result', 'error'].includes(call.outcome?.kind) || typeof call.outcome.raw !== 'string') throw new Error(`${side} step ${index} lacks raw outcome`);
  }
  // Exact-number fields (args, outcomes, event payloads) are raw strings parsed with parseExact
  // where compared; the rest is X3 string cells and small step indices, so one parse serves both.
  return { bytes, trace, exact: trace };
}

/** N-014 window {from, to} (ms) of a trace that records it: worker start (seed build) to the end of the take. */
export function recordingWindow(trace) {
  const recording = trace?.recording;
  const from = Date.parse(recording?.workerStartedAt ?? recording?.startedAt ?? ''), to = Date.parse(recording?.endedAt ?? '');
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
}

/** "FROM/TO" (ISO 8601) -> {from, to} ms. */
const iso = window => ({ from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() });
/** buildCompare options that recompute an artifact exactly as it was made (N-014 windows included). */
export function splitOf(artifact) {
  const recorded = artifact?.splitRecording;
  if (!recorded) return { split: false, aWindow: null, aScenarioFile: null };
  return { split: true, aWindow: recorded.A ? { from: Date.parse(recorded.A.from), to: Date.parse(recorded.A.to) } : null,
    aScenarioFile: recorded.aScenarioFile?.file ?? null };
}
export function parseWindow(text) {
  const [from, to] = String(text).split('/').map(part => Date.parse(part));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error(`--a-window must be FROM/TO in ISO 8601: ${text}`);
  return { from, to };
}

/**
 * Event scope (required on both traces):
 * - `{kind:'all'}`: every backend event was recorded (B: the Host's full outbound stream).
 * - `{kind:'named', since:{name: step}}`: only those names were subscribed, each from step
 *   `since` on (-1 = before step 0). A frontend can only hear what it listened to.
 * Events are compared per window (before, each step, after) and only for names in scope on
 * both sides in that window; everything else is reported as out of scope, never as equal.
 */
function pointerValue(value, pointer) {
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * Labeler for events seen by `target` under `owner`'s scope: returns the channel label, or
 * null when out of scope. A dynamic name `owner` derived from an id (eventScope.derived:
 * pattern + step + args|result + JSON pointer) is rebuilt from `target`'s own value at the
 * same place, so the two sides' channels are matched by derivation, not by id text.
 */
function scopeLabeler(owner, target, ownerSide) {
  const scope = owner.eventScope;
  if (scope?.kind === 'all') return name => name;
  if (scope?.kind !== 'named' || !scope.since || typeof scope.since !== 'object') {
    throw new Error(`${ownerSide} trace lacks eventScope {kind:'all'} or {kind:'named',since}`);
  }
  const derived = scope.derived ?? {};
  const rebuilt = new Map();
  for (const [name, from] of Object.entries(scope.since)) {
    const how = derived[name];
    if (!how) { rebuilt.set(name, { label: name, from }); continue; }
    const call = target.calls[how.step];
    const source = how.field === 'args' ? call?.argsRaw : call?.outcome?.kind === 'result' ? call.outcome.raw : undefined;
    const id = source === undefined ? undefined : pointerValue(parseExact(source), how.pointer);
    if (typeof id !== 'string') continue;
    rebuilt.set(how.pattern.replaceAll('{}', id), { label: `${how.pattern}@${how.step}.${how.field}${how.pointer}`, from });
  }
  return (name, step) => {
    const entry = rebuilt.get(name);
    return entry && entry.from <= step ? entry.label : null;
  };
}

function eventWindows(exact, side) {
  const lists = [exact.before?.events, ...exact.calls.map(call => call.capture?.events), exact.after?.events];
  const windows = [];
  let previous = [];
  for (const [index, list] of lists.entries()) {
    if (!Array.isArray(list)) throw new Error(`${side} capture ${index} lacks events`);
    if (firstDifference(previous, list.slice(0, previous.length))) throw new Error(`${side} capture ${index} events are not cumulative`);
    windows.push(list.slice(previous.length));
    previous = list;
  }
  return windows;
}

function projectEvent(event, label) {
  return { event: label, payload: parseExact(event.payloadRaw) };
}

// Error texts are what tells an A-side defect (e.g. a missing table) from a product difference.
const excerpt = raw => (raw.length > 400 ? raw.slice(0, 400) + '…' : raw);

/** Pure comparison of two complete traces; `aExact`/`bExact` are exact-number parses for events. */
export function compareTraces(scenario, a, b, aExact = a, bExact = b, outOfScope = [], labelSource = { A: aExact, B: bExact }) {
  validateScenario(scenario);
  const differences = [];
  const add = (step, kind, detail) => differences.push({ step, command: step === null ? null : scenario.steps[step].cmd, kind, ...detail });
  let compareEvents = null;
  if (scenario.capture.events) {
    // Labels come from the raw traces: derived channel names use the real ids, payloads may be normalized.
    const traces = labelSource;
    // labelers[side][owner]: label of an event recorded by `side` under `owner`'s scope.
    const labelers = Object.fromEntries(['A', 'B'].map(side => [side,
      Object.fromEntries(['A', 'B'].map(owner => [owner, scopeLabeler(traces[owner], traces[side], owner)]))]));
    const windows = { A: eventWindows(aExact, 'A'), B: eventWindows(bExact, 'B') };
    const last = scenario.steps.length;
    compareEvents = (window, index, where) => {
      const step = window === 0 ? -1 : Math.min(window - 1, last);
      const kept = {};
      for (const side of ['A', 'B']) {
        kept[side] = [];
        for (const event of windows[side][window]) {
          const byA = labelers[side].A(event.event, step), byB = labelers[side].B(event.event, step);
          // A named scope's label wins over an `all` scope's raw name.
          if (byA !== null && byB !== null) kept[side].push(projectEvent(event, a.eventScope.kind === 'named' ? byA : byB));
          else outOfScope.push({ where, side, event: event.event });
        }
      }
      const difference = firstDifference(kept.A, kept.B);
      if (difference) {
        const paths = differingPaths(kept.A, kept.B);
        const indices = [...new Set(paths.paths.map(path => Number(path.split('/')[1])))];
        const eventNames = indices.map(i => ({ index: i, A: kept.A[i]?.event ?? null, B: kept.B[i]?.event ?? null }));
        add(index, 'events', { where, difference, ...paths, eventNames });
      }
    };
  }
  const capture = (index, window, where, left, right) => {
    compareEvents?.(window, index, where);
    if (scenario.capture.db.length) {
      const sides = [directoryState(left?.databases, `A ${where}`), directoryState(right?.databases, `B ${where}`)];
      const rows = compareDatabaseStates(...sides);
      if (rows.length) add(index, 'database', { where, count: rows.length, sample: rows.slice(0, SAMPLE_LIMIT) });
    }
  };
  capture(null, 0, 'before', a.before, b.before);
  for (const [index, step] of scenario.steps.entries()) {
    const left = a.calls[index], right = b.calls[index];
    const wanted = step.expect === 'error' ? 'error' : 'result';
    for (const [side, call] of [['A', left], ['B', right]]) {
      if (call.outcome.kind !== wanted) add(index, 'expectation', { side, expected: wanted, actual: call.outcome.kind, raw: excerpt(call.outcome.raw) });
    }
    const args = firstDifference(parseExact(left.argsRaw), parseExact(right.argsRaw));
    if (args) add(index, 'args', { difference: args });
    if (left.outcome.kind !== right.outcome.kind) add(index, 'outcome-kind', { a: left.outcome.kind, b: right.outcome.kind, rawA: excerpt(left.outcome.raw), rawB: excerpt(right.outcome.raw) });
    else {
      const [expected, actual] = [parseExact(left.outcome.raw), parseExact(right.outcome.raw)];
      const outcome = firstDifference(expected, actual);
      if (outcome) add(index, 'outcome', { difference: outcome, ...differingPaths(expected, actual) });
    }
    capture(index, index + 1, `after step ${index}`, left.capture, right.capture);
  }
  capture(null, scenario.steps.length + 1, 'after', a.after, b.after);
  if (scenario.capture.db.length) {
    if ((a.finalDatabases === undefined) !== (b.finalDatabases === undefined)) {
      add(null, 'final-database', { missing: a.finalDatabases === undefined ? 'A' : 'B' });
    } else if (a.finalDatabases !== undefined) {
      const rows = compareDatabaseStates(directoryState(a.finalDatabases, 'A final'), directoryState(b.finalDatabases, 'B final'));
      if (rows.length) add(null, 'final-database', { count: rows.length, sample: rows.slice(0, SAMPLE_LIMIT) });
    }
  }
  return differences;
}

/**
 * What the recorders did around the scenario, compared on the raw traces (no rule applies):
 * the G3-STARTUP setup command's outcome (e.g. not registered in recovery mode on one side)
 * and, at the after capture, whether the scenario's external services went idle (MCP: the
 * Rust app keeps a stdio child or request open that the Host closed, or the reverse).
 */
export function recorderDifferences(a, b) {
  const differences = [];
  const setupA = a.startup?.setup?.outcome, setupB = b.startup?.setup?.outcome;
  if (setupA && setupB) {
    const setupCommand = a.startup.setup.command;
    if (setupA.kind !== setupB.kind) {
      differences.push({ step: null, command: null, kind: 'startup-setup', setupCommand, a: setupA.kind, b: setupB.kind, rawA: excerpt(setupA.raw), rawB: excerpt(setupB.raw) });
    } else {
      const difference = firstDifference(parseExact(setupA.raw), parseExact(setupB.raw));
      if (difference) differences.push({ step: null, command: null, kind: 'startup-setup', setupCommand, difference });
    }
  }
  const idle = trace => trace.after?.services?.mcp ?? null;
  const [idleA, idleB] = [idle(a), idle(b)];
  if ((idleA === null) !== (idleB === null)) differences.push({ step: null, command: null, kind: 'service-idle', service: 'mcp', missing: idleA === null ? 'A' : 'B' });
  else if (idleA && (idleA.idle !== idleB.idle || idleA.open !== idleB.open || idleA.liveStdio !== idleB.liveStdio)) {
    differences.push({ step: null, command: null, kind: 'service-idle', service: 'mcp',
      a: { idle: idleA.idle, open: idleA.open, liveStdio: idleA.liveStdio }, b: { idle: idleB.idle, open: idleB.open, liveStdio: idleB.liveStdio } });
  }
  return differences;
}

let compareDatabaseStates;

/** Build the artifact. Paths are recorded relative to `root` so C2 can recompute from the same tree. */
/** `rules` (a loadApprovals result) replaces `approvalsFile` for read-only replays of existing runs. */
export async function buildCompare({ scenarioFile, scenarioId, aTrace, bTrace, a2Trace = null, approvalsFile = DEFAULT_APPROVALS, root = process.cwd(), rules: given = null,
  split = false, aWindow = null, aScenarioFile = null }) {
  ({ compareDatabaseStates } = await import('../../../host/e2e/data-compat/__fixtures__/database-state.ts'));
  const scenarioBytes = readFileSync(scenarioFile);
  const suite = parseExact(scenarioBytes.toString('utf8'));
  const matches = (suite?.scenarios ?? []).filter(item => item?.id === scenarioId);
  if (matches.length !== 1) throw new Error(`scenario ${scenarioId} occurs ${matches.length} times in ${scenarioFile}`);
  const scenario = validateScenario(matches[0]);
  const inputSha256 = sha256(scenarioBytes);
  const sides = { A: readTrace(aTrace, scenario, 'A'), B: readTrace(bTrace, scenario, 'B'), ...(a2Trace ? { A2: readTrace(a2Trace, scenario, 'A2') } : {}) };
  // Split recording: A/A2 may come from an older suite file (another scenario of it changed) only
  // if that file is given, hashes to the A input and holds this scenario byte for byte.
  let aSuite = null;
  if (aScenarioFile) {
    if (!split) throw new Error('aScenarioFile applies only to split recording');
    const bytes = readFileSync(resolve(root, aScenarioFile));
    const others = (parseExact(bytes.toString('utf8'))?.scenarios ?? []).filter(item => item?.id === scenarioId);
    if (others.length !== 1 || stringifyExact(others[0]) !== stringifyExact(matches[0])) {
      throw new Error(`scenario ${scenarioId} differs between ${aScenarioFile} and ${scenarioFile} (stale-a)`);
    }
    aSuite = { file: relative(root, resolve(root, aScenarioFile)).split('\\').join('/'), sha256: sha256(bytes) };
  }
  for (const [side, { trace }] of Object.entries(sides)) {
    if (trace.inputSha256 === inputSha256 || (side !== 'B' && aSuite && trace.inputSha256 === aSuite.sha256)) continue;
    throw new Error(`${side} trace ran a different input (${trace.inputSha256}), scenario file is ${inputSha256}`);
  }
  if (sides.A2 && sides.A2.trace.side !== undefined && sides.A2.trace.side === sides.B.trace.side) throw new Error('A2 trace is a B trace');
  // Takes recorded under different startup protocols observed different windows (G3-STARTUP).
  const protocols = Object.entries(sides).map(([side, { trace }]) => `${side}=${startupProtocol(trace) ?? 'none'}`);
  if (new Set(protocols.map(item => item.split('=')[1])).size !== 1) {
    throw new Error(`startup protocol differs between takes (${protocols.join(', ')}); re-record the older side with the current recorder`);
  }
  const rel = file => relative(root, resolve(file)).split('\\').join('/');
  const outOfScope = [];
  let differences, normalization = [], normalizationSkipped = [], excludedFiles = [], approvals = null, windows = null;
  const labelSource = { A: sides.A.exact, B: sides.B.exact };
  if (sides.A2) {
    const rules = given ?? loadApprovals(resolve(root, approvalsFile));
    approvals = { file: given ? given.file : rel(resolve(root, approvalsFile)), sha256: rules.sha256, approved: [...rules.approved] };
    const event = owner => target => scopeLabeler(owner, target, 'A');
    const labels = scenario.capture.events
      ? Object.fromEntries(['A1', 'A2', 'B'].map(side => [side, event(sides.A.exact)(sides[side === 'A1' ? 'A' : side].exact)]))
      : { A1: () => null, A2: () => null, B: () => null };
    // B under its own scope too, so the event site keys only cover events compareTraces keeps.
    if (scenario.capture.events) {
      const both = (side, key) => { const byA = labels[key], byB = scopeLabeler(sides.B.exact, sides[side].exact, 'B');
        return (name, step) => byA(name, step) !== null && byB(name, step) !== null ? byA(name, step) : null; };
      labels.A1 = both('A', 'A1'); labels.A2 = both('A2', 'A2'); labels.B = both('B', 'B');
    }
    const runRoot = file => resolve(dirname(resolve(file)), 'run');
    windows = split ? { A: recordingWindow(sides.A.trace) ?? aWindow, B: recordingWindow(sides.B.trace) } : null;
    const result = normalizeTraces({ scenario, sides: { A1: sides.A, A2: sides.A2, B: sides.B }, labels, approvals: rules,
      runRoots: { A1: runRoot(aTrace), A2: runRoot(a2Trace), B: runRoot(bTrace) }, split: windows ? { windows } : null });
    differences = [...compareTraces(scenario, result.A, result.B, result.A, result.B, outOfScope, labelSource), ...result.order];
    ({ entries: normalization, skipped: normalizationSkipped, excludedFiles } = result);
  } else {
    differences = compareTraces(scenario, sides.A.trace, sides.B.trace, sides.A.exact, sides.B.exact, outOfScope);
  }
  differences.push(...recorderDifferences(sides.A.trace, sides.B.trace));
  const commands = [...new Set(scenario.steps.map(step => step.cmd))].sort();
  const perCommand = Object.fromEntries(commands.map(command => [command, {
    steps: scenario.steps.filter(step => step.cmd === command).length,
    differences: differences.filter(item => item.command === command || item.command === null).length,
  }]));
  return {
    schema: COMPARE_SCHEMA, input: 'same-input',
    normalizer: { file: NORMALIZER_FILE, sha256: normalizerSha256(root) },
    scenario: { file: rel(scenarioFile), sha256: inputSha256, id: scenario.id },
    traces: { A: { file: rel(aTrace), sha256: sha256(sides.A.bytes) }, B: { file: rel(bTrace), sha256: sha256(sides.B.bytes) },
      ...(sides.A2 ? { A2: { file: rel(a2Trace), sha256: sha256(sides.A2.bytes) } } : {}) },
    normalized: Boolean(sides.A2), approvals,
    ...(split ? { splitRecording: { A: windows?.A ? iso(windows.A) : null, B: windows?.B ? iso(windows.B) : null, ...(aSuite ? { aScenarioFile: aSuite } : {}) } } : {}),
    normalization, normalizationSkipped, excludedFiles,
    ...(sides.A.trace.startup ? { startup: Object.fromEntries(Object.entries(sides).map(([side, { trace }]) => [side, {
      rule: trace.startup.rule, settled: trace.startup.settle?.settled ?? null, setup: trace.startup.setup?.outcome?.kind ?? null,
      events: trace.startup.events?.length ?? null }])) } : {}),
    commands, perCommand, equal: differences.length === 0, differences,
    eventsOutOfScope: { count: outOfScope.length, sample: outOfScope.slice(0, SAMPLE_LIMIT) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { a2: { type: 'string' }, approvals: { type: 'string' },
    'split-recording': { type: 'boolean' }, 'a-window': { type: 'string' }, 'a-scenario-file': { type: 'string' } } });
  const [scenarioFile, scenarioId, aTrace, bTrace, output] = positionals;
  if (!output) throw new Error('usage: g3-compare.mjs SCENARIO_FILE SCENARIO_ID A_TRACE B_TRACE NEW_OUTPUT.compare.json [--a2 A2_TRACE] [--approvals FILE] [--split-recording [--a-window FROM/TO] [--a-scenario-file FILE]]');
  if (!/\.compare\.json(\.gz)?$/.test(output)) throw new Error('compare output must end with .compare.json[.gz]');
  if (values['a-window'] && !values['split-recording']) throw new Error('--a-window applies only with --split-recording');
  const artifact = await buildCompare({ scenarioFile, scenarioId, aTrace, bTrace, a2Trace: values.a2 ?? null, approvalsFile: values.approvals ?? DEFAULT_APPROVALS,
    split: Boolean(values['split-recording']), aWindow: values['a-window'] ? parseWindow(values['a-window']) : null,
    aScenarioFile: values['a-scenario-file'] ?? null });
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, evidenceBytes(output, stringifyExact(artifact, 2) + '\n'), { flag: 'wx' }); // never overwrite evidence
  console.log(JSON.stringify({ output, equal: artifact.equal, differences: artifact.differences.length }));
  process.exitCode = artifact.equal ? 0 : 1;
}
