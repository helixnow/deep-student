// Residual-difference categories for the G3 report. A category explains a difference; it never
// turns a fail into a pass. Unmatched differences are product differences.
//   product          真实产品差异: default; anything not proven to be one of the others
//   a-defect         A 端缺陷: the Rust reference itself fails (registered error text on the A side)
//   environment      环境差异: registered recorder/driver/host limitations, or (`clock-skew`) a date
//                    value shifted by exactly the days between the A/A2 and the B recording
//   nondeterministic 已知非确定性: A1 != A2 at the same place and no approved rule covers it, or a
//                    registered race; the A side is not reproducible there
// Exempt, outside the four: `rust-fix` — covered by an approved rust-fixes/ registration
// (kind rust-bug or deliberate). Not an inconsistency. A proposed registration's hit keeps its
// category and is listed as pending (待审).
import { readFileSync } from 'node:fs';
import { rustFixHits, stripApprovedRustFixRows } from './g3-rust-fixes.mjs';

export const KNOWN_SCHEMA = 'g3-known-differences/v1';
export const DEFAULT_KNOWN = 'fixtures/differential/g3/known-differences.json';
export const CATEGORIES = {
  product: '真实产品差异', 'a-defect': 'A 端缺陷', environment: '环境差异', nondeterministic: '已知非确定性',
};
const CATEGORY_IDS = Object.keys(CATEGORIES);
export const RUST_FIX = 'rust-fix';
export const RUST_FIX_LABEL = 'Rust 修复豁免';

export function loadKnown(file = DEFAULT_KNOWN) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json?.schema !== KNOWN_SCHEMA || !Array.isArray(json.entries)) throw new Error(`${file}: schema must be ${KNOWN_SCHEMA} with entries[]`);
  for (const entry of json.entries) {
    if (!CATEGORY_IDS.includes(entry.category) || entry.category === 'product') throw new Error(`${file}: ${entry.id} has category ${entry.category}`);
    if (!entry.id || !entry.owner || !entry.evidence || !entry.match || typeof entry.match !== 'object') throw new Error(`${file}: ${entry.id ?? '?'} needs id, owner, evidence, match`);
  }
  return json.entries;
}

const matchesText = (pattern, text) => typeof text === 'string' && text.includes(pattern);
const inList = (list, value) => !list || list.includes(value);
const prefixed = (prefixes, value) => !prefixes || prefixes.some(prefix => String(value ?? '').startsWith(prefix));

/** Error texts carried by a difference (g3-compare `expectation.raw`, `outcome-kind.rawA/rawB`). */
function errorTexts(difference) {
  const texts = { A: [], B: [] };
  if (difference.kind === 'expectation' && difference.actual === 'error') texts[difference.side].push(difference.raw);
  if (difference.kind === 'outcome-kind') {
    if (difference.a === 'error') texts.A.push(difference.rawA);
    if (difference.b === 'error') texts.B.push(difference.rawB);
  }
  return texts;
}

/** Steps where a registered A-side error occurred: the entry then covers that step and everything after it. */
function triggerSteps(artifact, entry) {
  const steps = [];
  for (const difference of artifact.differences) {
    const texts = errorTexts(difference);
    const side = entry.match.side ?? 'A';
    if (entry.match.errorIncludes && texts[side].some(text => matchesText(entry.match.errorIncludes, text))) steps.push(difference.step);
  }
  return steps.filter(step => step !== null);
}

const sampleTables = difference => (difference.sample ?? []).map(sample => sample.table ?? null);

function entryCovers(entry, artifact, difference, trigger) {
  const m = entry.match;
  if (!prefixed(m.scenarioPrefix, artifact.scenario?.id)) return false;
  if (m.scenarios && !m.scenarios.includes(artifact.scenario?.id)) return false;
  if (!inList(m.commands, difference.command)) return false;
  if (!inList(m.kinds, difference.kind)) return false;
  if (m.tables) {
    const tables = sampleTables(difference);
    if (!['database', 'final-database'].includes(difference.kind) || !tables.length || !tables.every(table => m.tables.includes(table))) return false;
  }
  if (m.errorIncludes) {
    if (trigger === null) return false;
    // from-step: the failing A step and every later capture (after/final have step null).
    return difference.step === null || difference.step >= trigger;
  }
  if (m.where && !m.where.some(where => String(difference.where ?? '').startsWith(where))) return false;
  return true;
}

/** Places where A1 and A2 already differ and no approved rule applied (normalizationSkipped). */
function unstablePlaces(artifact) {
  const tables = new Set(), columns = new Set(), json = new Set();
  for (const item of artifact.normalizationSkipped ?? []) {
    if (item.db && item.table && !item.column) tables.add(`${item.db}\u0000${item.table}`);
    else if (item.db && item.table) columns.add(`${item.db}\u0000${item.table}\u0000${item.column}`);
    else if (item.site) json.add(`${item.site}\u0000${item.pointer}`);
  }
  return { tables, columns, json };
}

function sampleUnstable(sample, places) {
  if (places.tables.has(`${sample.db}\u0000${sample.table}`)) return true;
  return sample.column !== null && sample.column !== undefined && places.columns.has(`${sample.db}\u0000${sample.table}\u0000${sample.column}`);
}

function differenceUnstable(difference, places) {
  if (['database', 'final-database'].includes(difference.kind)) {
    // Every listed sample must be at an A1 != A2 place, and the sample list must be complete.
    const sample = difference.sample ?? [];
    return sample.length > 0 && sample.length === difference.count && sample.every(item => sampleUnstable(item, places));
  }
  if (difference.kind === 'outcome' && difference.step !== null) {
    const path = difference.difference?.path;
    return typeof path === 'string'
      && (places.json.has(`s${difference.step}:result\u0000${path}`) || places.json.has(`s${difference.step}:error\u0000${path}`));
  }
  return false;
}

const DAY_MS = 86_400_000;
/** Calendar dates (YYYY-MM-DD in `timeZone`) a worker process window {startedAt, endedAt} touched. */
export function recordingDates(window, timeZone) {
  if (!window?.startedAt || !window?.endedAt) return [];
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const first = format.format(new Date(window.startedAt)), last = format.format(new Date(window.endedAt));
  const dates = [first];
  for (let day = Date.parse(first) + DAY_MS; day <= Date.parse(last); day += DAY_MS) dates.push(new Date(day).toISOString().slice(0, 10));
  return dates;
}

/** B − A/A2 recording date offsets in days; empty when B shares a date with A or A2, or a window is unknown. */
export function clockOffsets(windows, timeZone) {
  const b = recordingDates(windows.B, timeZone);
  const a = [...new Set([...recordingDates(windows.A, timeZone), ...recordingDates(windows.A2, timeZone)])];
  if (!b.length || !a.length || b.some(date => a.includes(date))) return [];
  const offsets = new Set();
  for (const dateB of b) for (const dateA of a) offsets.add((Date.parse(dateB) - Date.parse(dateA)) / DAY_MS);
  return [...offsets].sort((x, y) => x - y);
}

const DATED = /^(\d{4}-\d{2}-\d{2})([\s\S]*)$/;
/** A (expected/before) and B (actual/after) are the same text except a date moved by one of `offsets` days. */
function shifted(a, b, offsets) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = DATED.exec(a), right = DATED.exec(b);
  if (!left || !right || left[2] !== right[2] || Number.isNaN(Date.parse(left[1])) || Number.isNaN(Date.parse(right[1]))) return false;
  return offsets.includes((Date.parse(right[1]) - Date.parse(left[1])) / DAY_MS);
}

function differenceShifted(difference, offsets) {
  if (!offsets?.length) return false;
  if (['outcome', 'events', 'args'].includes(difference.kind)) return shifted(difference.difference?.expected, difference.difference?.actual, offsets);
  if (['database', 'final-database'].includes(difference.kind)) {
    const sample = difference.sample ?? [];
    return sample.length > 0 && sample.length === difference.count && sample.every(item => item.kind === 'value'
      && item.before?.storageClass === 'text' && item.after?.storageClass === 'text' && shifted(item.before.value, item.after.value, offsets));
  }
  return false;
}

/**
 * Category of every difference of one compare artifact, plus the artifact's summary category:
 * product if any difference is a product difference, otherwise the most frequent other category.
 * `clock.offsets` (clockOffsets of the compare's takes) enables the clock-skew rule.
 * `fixes` (loadRustFixes): approved hits are exempt (`rust-fix`, not counted); summary is
 * `rust-fix` only when every difference is exempt.
 */
export function classifyCompare(artifact, known = [], clock = null, fixes = null) {
  const places = unstablePlaces(artifact);
  const triggers = new Map(known.filter(entry => entry.match.errorIncludes).map(entry => {
    const steps = triggerSteps(artifact, entry);
    return [entry.id, steps.length ? Math.min(...steps) : null];
  }));
  const original = difference => {
    for (const entry of known) {
      if (entryCovers(entry, artifact, difference, triggers.get(entry.id) ?? null)) return { category: entry.category, known: entry.id };
    }
    if (differenceUnstable(difference, places)) return { category: 'nondeterministic', known: 'A1≠A2' };
    if (differenceShifted(difference, clock?.offsets)) return { category: 'environment', known: 'clock-skew' };
    return { category: 'product', known: null };
  };
  const differences = artifact.differences.map(difference => {
    const hits = rustFixHits(fixes, difference, artifact.scenario?.id);
    if (hits.approved) return { category: RUST_FIX, known: hits.approved.id, rustFix: { id: hits.approved.id, kind: hits.approved.kind } };
    const result = original(stripApprovedRustFixRows(fixes, difference, artifact.scenario?.id));
    return hits.proposed.length ? { ...result, pending: hits.proposed.map(entry => ({ id: entry.id, kind: entry.kind })) } : result;
  });
  const counts = Object.fromEntries(CATEGORY_IDS.map(id => [id, differences.filter(item => item.category === id).length]));
  const counted = CATEGORY_IDS.reduce((n, id) => n + counts[id], 0);
  const summary = !differences.length ? null : !counted ? RUST_FIX : counts.product ? 'product'
    : CATEGORY_IDS.filter(id => id !== 'product').sort((a, b) => counts[b] - counts[a])[0];
  const tally = select => {
    const byId = new Map();
    for (const item of differences) for (const fix of select(item)) {
      const row = byId.get(fix.id) ?? { id: fix.id, kind: fix.kind, differences: 0 };
      row.differences++;
      byId.set(fix.id, row);
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  return {
    summary, counts, counted, differences, knownIds: [...new Set(differences.map(item => item.known).filter(Boolean))].sort(),
    rustFixes: { exempt: tally(item => item.rustFix ? [item.rustFix] : []), pending: tally(item => item.pending ?? []) },
  };
}
