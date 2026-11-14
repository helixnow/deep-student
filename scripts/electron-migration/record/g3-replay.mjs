#!/usr/bin/env node
// Read-only replay of existing G3 compare artifacts with the current normalizer and the given
// approvals: recomputes each compare from its recorded A1/A2/B traces in memory and prints
// statistics only. Nothing is written; traces and artifacts are never modified.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { buildCompare, splitOf } from './g3-compare.mjs';
import { compareFiles } from './g3-manifest.mjs';
import { readEvidence } from './json.mjs';
import { generatedShape, parseApprovals } from './g3-normalize.mjs';
import { CATEGORIES, classifyCompare } from './g3-classify.mjs';
import { KINDS, RUST_FIXES_DIR, loadRustFixes } from './g3-rust-fixes.mjs';

const where = difference => `${difference.kind}${difference.sample ? ':' + [...new Set(difference.sample.map(s => `${s.table}.${s.column ?? '<row>'}`))].sort().join(',') : ''}`;

// Spot check of an eliminated difference: equal once every placeholder (and every generated-id
// literal, the N-011 case) is masked means only placeholder naming differed, not content.
const PLACEHOLDER = /<[a-z]?@[^<>]*>/g;
const maskNames = value => JSON.stringify(value ?? null, (key, item) => typeof item === 'bigint' ? item.toString()
  : typeof item === 'string' ? (generatedShape(item) ? '<P>' : item.replace(PLACEHOLDER, '<P>')) : item);
export function spotCheck(difference) {
  const pairs = difference.sample ? difference.sample.map(sample => [sample.before, sample.after, sample])
    : difference.difference ? [[difference.difference.expected, difference.difference.actual, difference.difference]] : [];
  if (!pairs.length) return { kind: 'other', example: difference };
  // A missing/extra row is placeholder-only when the same row (masked) exists on the other side.
  const rows = difference.sample?.filter(sample => sample.kind === 'row') ?? [];
  const masked = rows.map(sample => maskNames(sample.before ?? sample.after));
  const paired = rows.every(sample => masked.filter(item => item === maskNames(sample.before ?? sample.after)).length % 2 === 0);
  const other = pairs.find(([a, b, sample]) => sample.kind === 'row' ? !paired : maskNames(a) !== maskNames(b));
  return other ? { kind: 'other', example: other[2] } : { kind: 'placeholder-only' };
}

/** One recorded artifact vs. its recomputation; `rules` is a parseApprovals result, `fixes` a loadRustFixes result. */
export async function replayCompare(root, file, rules, known = [], detail = false, fixes = null) {
  const artifact = JSON.parse(readEvidence(join(root, file)).text);
  if (!artifact.traces?.A2) return { file, scenario: artifact.scenario?.id, skipped: 'not normalized (no A2)' };
  const next = await buildCompare({ scenarioFile: join(root, artifact.scenario.file), scenarioId: artifact.scenario.id,
    aTrace: join(root, artifact.traces.A.file), bTrace: join(root, artifact.traces.B.file), a2Trace: join(root, artifact.traces.A2.file), root, rules,
    ...splitOf(artifact) });
  return { file, scenario: artifact.scenario.id, before: { equal: artifact.equal, differences: artifact.differences.length, where: artifact.differences.map(where) },
    after: { equal: next.equal, differences: next.differences.length, where: next.differences.map(where) },
    classification: classifyCompare(next, known, null, fixes), rules: [...new Set(next.normalization.map(entry => entry.extendedBy ?? entry.rule))].sort(),
    ...(!artifact.equal && next.equal ? { spot: artifact.differences.map(spotCheck) } : {}),
    ...(detail ? { differences: next.differences, skippedNormalization: next.normalizationSkipped } : {}) };
}

/** Aggregate counters plus a few samples; output stays small enough for a slow link. */
export function summarize(results, samples = 6) {
  const done = results.filter(result => !result.skipped && !result.error);
  const count = predicate => done.filter(predicate).length;
  const tally = list => Object.entries(list.reduce((map, key) => ({ ...map, [key]: (map[key] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  const eliminated = done.filter(result => !result.before.equal && result.after.equal);
  const regressed = done.filter(result => result.before.equal && !result.after.equal);
  const residual = done.filter(result => !result.after.equal);
  return {
    artifacts: results.length, replayed: done.length, skipped: results.filter(result => result.skipped).length,
    errors: results.filter(result => result.error).map(result => ({ file: result.file, error: result.error.slice(0, 200) })).slice(0, 5),
    unequal: { before: count(result => !result.before.equal), after: count(result => !result.after.equal) },
    eliminated: eliminated.length, regressed: regressed.length,
    regressedSample: regressed.slice(0, samples).map(result => ({ scenario: result.scenario, after: result.after.where.slice(0, 4) })),
    eliminatedSample: eliminated.filter((_, index) => index % Math.max(1, Math.floor(eliminated.length / samples)) === 0).slice(0, samples)
      .map(result => ({ scenario: result.scenario, before: [...new Set(result.before.where)].slice(0, 4), rules: result.rules })),
    spot: tally(eliminated.flatMap(result => result.spot.map(item => item.kind))),
    spotOther: eliminated.flatMap(result => result.spot.filter(item => item.kind === 'other').map(item => ({ scenario: result.scenario,
      example: JSON.stringify(item.example).slice(0, 300) }))).slice(0, samples),
    columnCompares: (() => {
      const columns = list => new Set(list.flatMap(item => item.split(':')[1]?.split(',') ?? []));
      const counts = {};
      for (const result of done) {
        for (const column of columns(result.before.where)) (counts[column] ??= [0, 0])[0]++;
        for (const column of columns(result.after.where)) (counts[column] ??= [0, 0])[1]++;
      }
      return Object.entries(counts).sort((a, b) => (b[1][0] - b[1][1]) - (a[1][0] - a[1][1])).slice(0, 15);
    })(),
    eliminatedBeforeWhere: tally(eliminated.flatMap(result => [...new Set(result.before.where)])).slice(0, 12),
    residualCategories: tally(residual.map(result => result.classification.summary)),
    residualDifferenceCategories: Object.fromEntries(Object.keys(CATEGORIES).map(id => [id, residual.reduce((n, result) => n + result.classification.counts[id], 0)])),
    residualKnown: tally(residual.flatMap(result => result.classification.knownIds)),
    residualWhere: tally(residual.flatMap(result => [...new Set(result.after.where)])).slice(0, 25),
    // rust-fixes/: approved hits are exempt (not counted); proposed hits stay counted as pending. By kind.
    rustFixes: {
      unequalCounted: count(result => result.classification.counted > 0),
      exemptOnly: count(result => !result.after.equal && result.classification.counted === 0),
      ...Object.fromEntries(['exempt', 'pending'].map(list => [list, Object.fromEntries(KINDS.map(kind => {
        const byId = {};
        for (const result of residual) for (const fix of result.classification.rustFixes[list].filter(item => item.kind === kind)) {
          byId[fix.id] ??= { id: fix.id, differences: 0, artifacts: 0, scenarios: [] };
          byId[fix.id].differences += fix.differences;
          byId[fix.id].artifacts++;
          if (byId[fix.id].scenarios.length < samples) byId[fix.id].scenarios.push(result.scenario);
        }
        return [kind, Object.values(byId).sort((a, b) => a.id.localeCompare(b.id))];
      }))])),
    },
  };
}

export async function replayRuns({ root, runsDir, rules, known = [], shard = 0, shards = 1, filter = null, detail = false, fixes = null }) {
  const files = compareFiles(root, runsDir).filter((file, index) => index % shards === shard && (!filter || file.includes(filter)));
  const results = [];
  for (const file of files) {
    try { results.push(await replayCompare(root, file, rules, known, detail, fixes)); }
    catch (error) { results.push({ file, error: String(error?.message ?? error) }); }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() }, runs: { type: 'string', default: 'fixtures/differential/g3/runs/full' },
    approvals: { type: 'string', default: 'fixtures/differential/g3/normalize-approvals.json' }, known: { type: 'string' },
    shard: { type: 'string', default: '0' }, shards: { type: 'string', default: '1' }, filter: { type: 'string' },
    'rust-fixes': { type: 'string', default: RUST_FIXES_DIR } } });
  const { loadKnown } = await import('./g3-classify.mjs');
  const rules = parseApprovals(readFileSync(values.approvals), values.approvals);
  const fixes = loadRustFixes(values.root, values['rust-fixes']);
  const results = await replayRuns({ root: values.root, runsDir: values.runs, rules, known: values.known ? loadKnown(values.known) : [],
    shard: Number(values.shard), shards: Number(values.shards), filter: values.filter ?? null, fixes });
  const summary = summarize(results);
  summary.rustFixes = { source: fixes.source, applied: fixes.entries.map(entry => `${entry.id} ${entry.kind} ${entry.status}`), problems: fixes.problems, ...summary.rustFixes };
  console.log(JSON.stringify(summary));
}
