// G3 normalization approved by C2 (board/g3/normalize-approvals.json, N-001…N-005).
// Raw traces are never modified: this builds normalized copies for the comparator and an
// explicit list of every substitution. A location is volatile only where the two independent
// A takes (A1, A2) of the same scenario differ; a B-only difference is never normalized.
//
// N-003/N-005: every side has its own token -> placeholder table shared by args, returns,
// events and DB cells. Strings are split into id-shaped tokens (UUID, timestamp, long digit or
// hex runs); only tokens that differ between A1 and A2 are replaced, so the surrounding text is
// still compared. A placeholder is named after the place where its value first appears, so the
// two sides get equal names only when their references have the same structure.
// N-001: listed (db, table, column) -> `<ts>` (null/storageClass kept). N-002: audit rows
// compared as a multiset without id/timestamp/duration_ms. N-004: the WebKit HSTS file only.
// N-010: `__change_log` record ids are named by first appearance of (table_name, operation,
// record_id) in `id` order, and `changed_at` (datetime('now'), 1 s) only has to keep its format
// and never go backwards along that order. N-011: "<prefix>_<nanoid>" ids without a digit, when
// both takes drew the same prefix and length. N-012: rows tied after masking are named after
// the rows that reference them, not by the sort position of their own random key.
// N-013 is the recorder's quiet wait before each capture (g3-quiet.mjs), not a projection.
// N-014 (split recording only: `split.windows`, disjoint): at locations where A1 == A2, a clock
// reading inside its own side's recording window becomes its format shape; shared locations
// must keep their order (strict inversions at the coarser precision are differences); g3-normalize-clock.mjs.
// N-015: `get_app_version` keeps its version, the build number and commit are masked.
// N-016: the ciphertext and nonce of an AEAD envelope {"ciphertext","nonce","version"} (any JSON
// escaping depth) are tokens; their placeholders carry the base64 length. N-017: rows of a table
// whose primary key is the same in both A takes name their placeholders after that key, not
// after their sort rank among the other rows.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstDifference, parseExact, stringifyExact } from './json.mjs';
import { MISSING, getAt, isNumber, kindOf, leaves, numberSource, setAt, tableKey } from './g3-normalize-values.mjs';
import { clockInversions, clockOrderDifferences, iso, projectClock, stableJsonSites } from './g3-normalize-clock.mjs';

export const APPROVALS_SCHEMA = 'g3-normalize-approvals/v1';
export const RULE_IDS = ['N-001', 'N-002', 'N-003', 'N-004', 'N-005', 'N-006', 'N-007', 'N-010', 'N-011', 'N-012', 'N-013', 'N-014', 'N-015', 'N-016', 'N-017'];
export const TS = '<ts>';
const CHANGE_LOG = '__change_log';
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const HSTS = 'app-data/com.deepstudent.differential/hsts-storage.sqlite';
const AUDIT = { db: 'databases/audit.db', table: '__audit_log', ignored: ['id', 'timestamp', 'duration_ms'] };
const ID_LIKE = /^[A-Za-z0-9_\-.:+]+$/;
// Rust/Host ids built as "<prefix>_<nanoid>" (nanoid alphabet includes '-' and '_'),
// e.g. res_-UF_FFMtAa or fi_XsBZOjsPrF, may contain no digit at all; length alone
// cannot distinguish them from semantic tokens, so match the generated prefixes.
const ID_PREFIXES = 'as|att|card|copy|csv|emb|essay|essay_session|exam|exam_delete|fi|file|fld|ijob|img|me|mm|mv|n|note|pd|q|qgm|qh|res|rh|rp';
const PREFIXED_ID = new RegExp('^(?:' + ID_PREFIXES + ')_[A-Za-z0-9_-]{8,}$');
const EMBEDDED_ID_CANDIDATE = /(?<![A-Za-z0-9_-])[a-z][a-z0-9]{0,15}_[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const MIN_LITERAL = 6;
const SHAPES = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|(?<![0-9A-Za-z])\d{10,}(?![0-9A-Za-z])|(?<![0-9A-Za-z])[0-9a-f]{16,}(?![0-9A-Za-z])/g;
// N-016: exactly these keys in this order; \1 is the backslash run before every quote at this nesting depth.
const B64 = '[A-Za-z0-9+/]+={0,2}';
const AEAD = new RegExp(`\\{(\\\\*)"ciphertext\\1":\\1"(${B64})\\1",\\1"nonce\\1":\\1"(${B64})\\1",\\1"version\\1":\\d+\\}`, 'gd');

/** N-006: DDL text that differs only in whitespace between tokens (indentation). Whitespace
 * inside single-quoted SQL literals is preserved; doubling \'\' is SQLite\'s escape. */
export function foldSql(sql) {
  let out = '', quoted = false;
  for (let index = 0; index < sql.length; index++) {
    const ch = sql[index];
    if (ch === "'") {
      out += ch;
      if (quoted && sql[index + 1] === "'") { out += "'"; index++; continue; }
      quoted = !quoted;
      continue;
    }
    if (!quoted && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (!out.endsWith(' ')) out += ' ';
      continue;
    }
    out += ch;
  }
  return out.trim();
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const slotRelative = db => db.replace(/^app-data\/[^/]+\/slots\/[^/]+\//, '');

export function loadApprovals(file) {
  return parseApprovals(readFileSync(file), file);
}

export function parseApprovals(bytes, file) {
  const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (json?.schema !== APPROVALS_SCHEMA) throw new Error(`${file}: schema must be ${APPROVALS_SCHEMA}`);
  const rules = new Map((json.rules ?? []).map(rule => [rule.id, rule]));
  const approved = new Set(RULE_IDS.filter(id => /^approved/.test(rules.get(id)?.decision ?? '')));
  return { file, sha256: sha256(bytes), approved, n001: new Set(rules.get('N-001')?.columns ?? []),
    // Same-second collision: both A takes can land on one wall-clock second, so A1==A2 even
    // though the column is a known volatile timestamp. Only active after C2 approves N-001's extension.
    n001SameTake: rules.get('N-001')?.sameTakeCollision === 'approved' };
}

/**
 * The normalizer's modules: this file and its relative imports (g3-normalize-split.test checks the list
 * against the import closure). A compare records `normalizerSha256` of them; an edit to any makes it stale.
 */
export const NORMALIZER_FILES = ['g3-normalize.mjs', 'g3-normalize-values.mjs', 'g3-normalize-clock.mjs', 'json.mjs']
  .map(name => `scripts/electron-migration/record/${name}`);
export function normalizerSha256(root) {
  const hash = createHash('sha256');
  for (const file of NORMALIZER_FILES) hash.update(`${file}\0${sha256(readFileSync(join(root, file)))}\n`);
  return hash.digest('hex');
}

// ---- tokens and templates ----
/** Even indexes literal, odd indexes tokens; with `aead` (N-016), `segments.aead` holds the indexes of envelope bodies. */
function tokenize(text, aead = false) {
  const sealed = aead ? [...text.matchAll(AEAD)].flatMap(match => match.indices.slice(2).map(([start, end]) => ({ start, end, aead: true }))) : [];
  const ranges = [...sealed];
  for (const match of text.matchAll(SHAPES)) {
    const start = match.index, end = start + match[0].length;
    if (!sealed.some(body => start < body.end && body.start < end)) ranges.push({ start, end, aead: false });
  }
  ranges.sort((x, y) => x.start - y.start);
  const segments = [];
  let last = 0;
  for (const { start, end, aead: body } of ranges) {
    segments.push(text.slice(last, start), text.slice(start, end));
    if (body) (segments.aead ??= new Set()).add(segments.length - 1);
    last = end;
  }
  segments.push(text.slice(last));
  return segments;
}
/** N-016 placeholder: the name also fixes the base64 length (plaintext length + tag, nonce size). */
const sealedName = (segments, index, name) => (segments.aead?.has(index) ? `${name.slice(0, -1)}~b64*${segments[index].length}>` : name);
const tokenKey = token => /^\d+$/.test(token) ? `n:${token}` : `s:${token}`;
const isShape = token => { const t = tokenize(token); return t.length === 3 && t[0] === '' && t[2] === ''; };
/** Random ids / timestamps only: a status word or a small count is never placeholder-mapped. */
export const randomLike = text => isShape(text) || PREFIXED_ID.test(text) || (ID_LIKE.test(text) && ((text.length >= 8 && /\d/.test(text)) || text.length >= 16));
const randomNumber = source => /^-?\d{10,}$/.test(source);

const GENERATED = /^([a-z][a-z0-9]{0,15})_([A-Za-z0-9_-]{8,})$/;
/** N-011: "<prefix>_*<length>" of a nanoid-shaped id, or null. Single-case words (with or
 * without underscores) are not draws: a nanoid suffix has a digit, a '-', or both cases. */
export function generatedShape(text) {
  const match = typeof text === 'string' ? GENERATED.exec(text) : null;
  if (!match) return null;
  const suffix = match[2];
  return /[0-9-]/.test(suffix) || (/[a-z]/.test(suffix) && /[A-Z]/.test(suffix)) ? `${match[1]}_*${suffix.length}` : null;
}

/** How A1 and A2 strings differ: by id-shaped tokens, else one id-like middle between a common prefix/suffix. */
export function stringTemplate(a1, a2, { aead = false } = {}) {
  const t1 = tokenize(a1, aead), t2 = tokenize(a2, aead);
  if (t1.length === t2.length && t1.every((segment, index) => index % 2 === 1 || segment === t2[index])) {
    const positions = t1.flatMap((segment, index) => index % 2 === 1 && segment !== t2[index] ? [index] : []);
    if (positions.length) return { mode: 'shape', segments: t1.length, positions, ...(t1.aead ? { aead: true } : {}) };
  }
  const alnum = ch => /[A-Za-z0-9]/.test(ch);
  let p = 0;
  while (p < a1.length && p < a2.length && a1[p] === a2[p]) p++;
  while (p > 0 && alnum(a1[p - 1])) p--;
  let q = 0;
  while (q < a1.length - p && q < a2.length - p && a1[a1.length - 1 - q] === a2[a2.length - 1 - q]) q++;
  while (q > 0 && alnum(a1[a1.length - q])) q--;
  const template = { mode: 'diff', prefix: a1.slice(0, p), suffix: a1.slice(a1.length - q) };
  return fitTemplate(a1, template) && fitTemplate(a2, template) ? template : null;
}

function fitTemplate(text, template) {
  if (template.mode === 'shape') {
    const segments = tokenize(text, template.aead === true);
    return segments.length === template.segments ? { segments, positions: template.positions } : null;
  }
  const { prefix, suffix } = template;
  if (text.length < prefix.length + suffix.length || !text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  const middle = text.slice(prefix.length, text.length - suffix.length);
  return ID_LIKE.test(middle) ? { segments: [prefix, middle, suffix], positions: [1] } : null;
}

const ID_PREFIX_HEAD = new RegExp('^(?:' + ID_PREFIXES + ')_$');
/** Prefix head is the last path segment, so an id inside "/exam_<nanoid>" matches too. */
const prefixHead = prefix => prefix.slice(Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf(':')) + 1);
const fitTokenRandomLike = (fit, index, n011 = false) => fit.segments.aead?.has(index) || (index === 1 && fit.segments.length === 3
  && ((ID_PREFIX_HEAD.test(prefixHead(fit.segments[0])) && /^[A-Za-z0-9_-]{8,}$/.test(fit.segments[1]))
    || (n011 && fit.segments[2] === '' && generatedShape(prefixHead(fit.segments[0]) + fit.segments[1]) !== null))
  ? true
  : randomLike(fit.segments[index]));
const embeddedId = (text, n011) => {
  for (const [token] of text.matchAll(EMBEDDED_ID_CANDIDATE)) {
    if (!wholeText(text, token) && (PREFIXED_ID.test(token) || (n011 && generatedShape(token) !== null))) return true;
  }
  return false;
};
const wholeText = (text, token) => text.length === token.length;

/** One side's value -> placeholder table (a bijection: each key gets one fresh, unique name). */
class Bijection {
  constructor() { this.byKey = new Map(); this.names = new Set(); this.literals = []; this.sorted = null; }
  peek(key) { return this.byKey.get(key); }
  get(key, placeholder) {
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    // Names that are not unique by construction (N-010 sequence names) must never alias two values.
    if (this.names.has(placeholder)) {
      let n = 1;
      while (this.names.has(`${placeholder.slice(0, -1)}!${n}>`)) n++;
      placeholder = `${placeholder.slice(0, -1)}!${n}>`;
    }
    this.names.add(placeholder);
    this.byKey.set(key, placeholder);
    const text = key.slice(2);
    if (key.startsWith('s:') && text.length >= MIN_LITERAL && !isShape(text)) { this.literals.push([text, placeholder]); this.sorted = null; }
    return placeholder;
  }
  /** Known non-shape random strings (from JSON diffs) inside DB text, longest first. */
  replaceLiterals(text) {
    this.sorted ??= [...this.literals].sort((a, b) => b[0].length - a[0].length);
    for (const [literal, placeholder] of this.sorted) if (text.includes(literal)) text = text.replaceAll(literal, placeholder);
    return text;
  }
  list() { return [...this.byKey].map(([value, placeholder]) => ({ value, placeholder })); }
}

// ---- trace walk: fixed order before -> each step (args, outcome, events, capture) -> after -> final ----
function splitWindows(lists, side) {
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

function walkTrace(trace, scenario, label, side, visit) {
  const steps = scenario.steps.length;
  const lists = [trace.before?.events, ...trace.calls.map(call => call.capture?.events), trace.after?.events];
  const windows = scenario.capture.events ? splitWindows(lists, side) : null;
  const events = [];
  const window = index => {
    if (!windows) return lists[index];
    const step = index === 0 ? -1 : Math.min(index - 1, steps);
    const counts = new Map();
    for (const event of windows[index]) {
      const name = label(event.event, step);
      if (name === null) { events.push(event); continue; }
      const ordinal = counts.get(name) ?? 0;
      counts.set(name, ordinal + 1);
      const payloadRaw = visit.json(`w${index}:${name}#${ordinal}`, event.payloadRaw);
      events.push(payloadRaw === event.payloadRaw ? event : { ...event, payloadRaw });
    }
    return [...events];
  };
  let unit = 0;
  const db = state => { const index = unit++; return state === undefined || !scenario.capture.db.length ? state : visit.db(index, state); };
  const out = { eventScope: trace.eventScope };
  out.before = { events: window(0), databases: db(trace.before?.databases) };
  out.calls = trace.calls.map((call, index) => ({
    command: call.command,
    argsRaw: visit.json(`s${index}:args`, call.argsRaw),
    outcome: { kind: call.outcome.kind, raw: visit.json(`s${index}:${call.outcome.kind}`, call.outcome.raw) },
    capture: { events: window(index + 1), databases: db(call.capture?.databases) },
  }));
  out.after = { events: window(steps + 1), databases: db(trace.after?.databases) };
  if (trace.finalDatabases !== undefined) out.finalDatabases = db(trace.finalDatabases);
  return out;
}

const cellKey = cell => `${cell.storageClass}\u0001${cell.value}`;

const DURATION_POINTER = /\/(durationMs|duration_ms|elapsedMs|elapsed_ms|executionTimeMs|execution_time_ms|latencyMs|latency_ms)$/;
const volatileNumber = (pointer, source) => randomNumber(source) || (DURATION_POINTER.test(pointer) && /^\d+$/.test(source));

/** Volatile JSON leaves and DB columns: where A1 and A2 differ (type-compatible). */
function detect(a1, a2, scenario, labels, approvals) {
  const collect = (trace, label, side) => {
    const sites = new Map(), units = [];
    walkTrace(trace, scenario, label, side, {
      json: (site, raw) => { sites.set(site, leaves(parseExact(raw))); return raw; },
      db: (index, state) => { units[index] = state; return state; },
    });
    return { sites, units };
  };
  const one = collect(a1, labels.A1, 'A1'), two = collect(a2, labels.A2, 'A2');
  const json = new Map(), skipped = [];
  const aead = approvals.approved.has('N-016');
  const ruleOf = site => (/^s\d+:args$/.test(site) ? 'N-005' : 'N-003');
  for (const [site, first] of one.sites) {
    const second = two.sites.get(site);
    if (!second || !approvals.approved.has(ruleOf(site))) continue;
    for (const [pointer, v1] of first) {
      if (!second.has(pointer)) continue;
      const v2 = second.get(pointer), k1 = kindOf(v1), k2 = kindOf(v2);
      const same = k1 === k2 && (k1 === 'n' ? numberSource(v1) === numberSource(v2) : Object.is(v1, v2));
      if (same) continue;
      if (k1 !== k2 || !['s', 'n'].includes(k1)) { skipped.push({ site, pointer, reason: 'A1/A2 differ in JSON type or not a string/number', A1: v1, A2: v2 }); continue; }
      if (k1 === 'n' && !(volatileNumber(pointer, numberSource(v1)) && volatileNumber(pointer, numberSource(v2)))) { skipped.push({ site, pointer, reason: 'A1/A2 numbers differ but are not 10+ digit ids/epochs', A1: v1, A2: v2 }); continue; }
      let template = k1 === 's' ? stringTemplate(v1, v2, { aead }) : null;
      let fits = template && [v1, v2].every(v => { const fit = fitTemplate(v, template); return fit && fit.positions.every(i => fitTokenRandomLike(fit, i)); });
      if (k1 === 's' && !fits && approvals.approved.has('N-011') && generatedShape(v1) !== null && generatedShape(v1) === generatedShape(v2)) {
        template = { mode: 'generated', shape: generatedShape(v1) };
        fits = true;
      }
      if (k1 === 's' && !fits) { skipped.push({ site, pointer, reason: 'A1/A2 difference is not a random id/timestamp token', A1: v1, A2: v2 }); continue; }
      if (!json.has(site)) json.set(site, []);
      json.get(site).push({ site, pointer, kind: k1, template, rule: ruleOf(site), A1: v1, A2: v2 });
    }
  }
  const columns = new Map(), distinct = new Map();
  const rowCount = new Set();
  // N-014: columns seen in both takes, and those whose values differ between them in some capture.
  const seenColumns = new Set(), differing = new Set();
  for (const [index, s1] of one.units.entries()) {
    const s2 = two.units[index];
    if (!s1 || !s2) continue;
    for (const db of Object.keys(s1.databases)) {
      const d1 = s1.databases[db], d2 = s2.databases[db];
      if (!d2 || db === HSTS) continue;
      for (const table of Object.keys(d1.tables)) {
        const t1 = d1.tables[table], t2 = d2.tables[table];
        if (!t2) continue;
        for (const { name: column } of t1.columns) seenColumns.add(`${tableKey(db, table)}\u0000${column}`);
        if (t1.rows.length !== t2.rows.length) {
          rowCount.add(`${db}\u0000${table}`);
          for (const { name: column } of t1.columns) differing.add(`${tableKey(db, table)}\u0000${column}`);
          continue;
        }
        const audit = slotRelative(db) === AUDIT.db && table === AUDIT.table;
        for (const { name: column } of t1.columns) {
          const m1 = t1.rows.map(row => cellKey(row.values[column])).sort(), m2 = t2.rows.map(row => cellKey(row.values[column])).sort();
          if (!m1.every((value, i) => value === m2[i])) differing.add(`${tableKey(db, table)}\u0000${column}`);
          if (audit && approvals.approved.has('N-002') && AUDIT.ignored.includes(column)) { differing.add(`${tableKey(db, table)}\u0000${column}`); continue; }
          const rule = approvals.n001.has(`${slotRelative(db)}/${table}/${column}`) ? 'N-001'
            : table === CHANGE_LOG && column === 'changed_at' && approvals.approved.has('N-010') ? 'N-010' : 'N-005';
          if (!approvals.approved.has(rule)) continue;
          if (m1.every((value, i) => value === m2[i]) && !(rule === 'N-001' && approvals.n001SameTake)) continue;
          const s2 = new Set(m2), s1 = new Set(m1);
          const only1 = m1.filter(v => !s2.has(v)).map(v => v.split('\u0001')), only2 = m2.filter(v => !s1.has(v)).map(v => v.split('\u0001'));
          const changed = [...only1, ...only2];
          // N-011: a shape counts only when both takes drew values of it in this column.
          const shapes = list => new Set(list.flatMap(([storageClass, value]) => storageClass === 'text' && generatedShape(value) ? [generatedShape(value)] : []));
          const shapes2 = shapes(only2);
          const generated = approvals.approved.has('N-011') ? new Set([...shapes(only1)].filter(shape => shapes2.has(shape))) : new Set();
          if (rule === 'N-005' && !changed.every(([storageClass, value]) => storageClass === 'integer' ? randomNumber(value)
            : storageClass === 'text' && (randomLike(value) || tokenize(value, aead).length > 1 || embeddedId(value, approvals.approved.has('N-011')) || generated.has(generatedShape(value))))) {
            skipped.push({ db, table, column, reason: 'A1/A2 values differ but not as random ids/timestamps', sample: changed.slice(0, 4) });
            continue;
          }
          if (rule === 'N-010' && !changed.every(([storageClass, value]) => storageClass === 'text' && SQLITE_DATETIME.test(value))) {
            skipped.push({ db, table, column, reason: 'A1/A2 changed_at differ but not as datetime(\'now\') text', sample: changed.slice(0, 4) });
            continue;
          }
          const key = tableKey(db, table);
          if (!columns.has(key)) columns.set(key, new Map());
          columns.get(key).set(column, rule);
          const entry = distinct.get(`${key}\u0000${column}`) ?? { A1: new Set(), A2: new Set(), stable: new Set(), stableTokens: new Set(), generated: new Set() };
          for (const shape of generated) entry.generated.add(shape);
          for (const value of m1) entry.A1.add(value);
          for (const value of m2) entry.A2.add(value);
          // Present identically in both takes (seeded ids, fixed text): never substituted.
          for (const value of m1) if (s2.has(value)) entry.stable.add(value);
          const tokens = list => new Set(list.flatMap(v => tokenize(v.split('\u0001')[1] ?? '', aead).filter((_, i) => i % 2)));
          const t2s = tokens(m2);
          for (const token of tokens(m1)) if (t2s.has(token)) entry.stableTokens.add(token);
          distinct.set(`${key}\u0000${column}`, entry);
        }
      }
    }
  }
  for (const key of rowCount) {
    const [db, table] = key.split('\u0000');
    skipped.push({ db, table, reason: 'A1/A2 row counts differ; table not normalized' });
  }
  const volatileColumn = id => { const [db, table, column] = id.split('\u0000'); return Boolean(columns.get(tableKey(db, table))?.has(column)); };
  const stableColumns = new Set([...seenColumns].filter(id => !differing.has(id) && !volatileColumn(id)));
  return { json, columns, distinct, skipped, stableColumns };
}

function rebuildKeys(table) {
  const names = table.columns.map(column => column.name).filter(name => table.rows[0] === undefined || Object.hasOwn(table.rows[0].values, name));
  const order = [...table.primaryKey, ...names.filter(name => !table.primaryKey.includes(name))];
  const rank = { null: 0, integer: 1, real: 2, text: 3, blob: 4 };
  const sortKey = row => order.map(name => row.values[name]);
  const rows = [...table.rows].sort((x, y) => {
    const a = sortKey(x), b = sortKey(y);
    for (let i = 0; i < a.length; i++) {
      if (a[i].storageClass !== b[i].storageClass) return rank[a[i].storageClass] - rank[b[i].storageClass];
      if (a[i].value !== b[i].value) return String(a[i].value) < String(b[i].value) ? -1 : 1;
    }
    return 0;
  });
  let last = '', occurrence = 0;
  return { ...table, rows: rows.map(({ values }, index) => {
    const primary = JSON.stringify(table.primaryKey.map(name => [values[name].storageClass, values[name].value]));
    occurrence = primary === last ? occurrence + 1 : 0;
    last = primary;
    const key = table.primaryKey.length
      ? { kind: 'primary', values: Object.fromEntries(table.primaryKey.map(name => [name, values[name]])), occurrence }
      : { kind: 'ordinal', index };
    return { key, values };
  }) };
}

/** N-010: `__change_log` rows in `id` order, or null when id/table_name/operation are not stable. */
function changeLogSequence(table, volatile) {
  const names = new Set(table.columns.map(column => column.name));
  if (table.primaryKey.length !== 1 || table.primaryKey[0] !== 'id') return null;
  if (!['table_name', 'operation', 'record_id'].every(column => names.has(column))) return null;
  if (['id', 'table_name', 'operation'].some(column => volatile?.has(column))) return null;
  if (!table.rows.every(row => row.values.id.storageClass === 'integer'
    && row.values.table_name.storageClass === 'text' && row.values.operation.storageClass === 'text')) return null;
  return table.rows.map((row, index) => ({ row, index }))
    .sort((x, y) => { const a = BigInt(x.row.values.id.value), b = BigInt(y.row.values.id.value); return a < b ? -1 : a > b ? 1 : 0; });
}

/** N-017: per row "col='text',col=int" of a primary key that is stable across A1/A2, or null (no key, null or repeated keys). */
function stableKeys(table, stable) {
  if (!table.primaryKey.length || !table.primaryKey.every(stable)) return null;
  const keys = table.rows.map(row => {
    const parts = table.primaryKey.map(column => {
      const cell = row.values[column];
      if (!cell || cell.storageClass === 'null') return null;
      return `${column}=${cell.storageClass === 'text' ? `'${cell.value.replaceAll("'", "''")}'` : cell.value}`;
    });
    return parts.includes(null) ? null : parts.join(',');
  });
  return keys.includes(null) || new Set(keys).size !== keys.length ? null : keys;
}

/** N-010 second tolerance: every changed_at is datetime('now') text and never goes backwards in id order. */
function changeLogTimes(sequence, volatile) {
  if (volatile?.get('changed_at') !== 'N-010') return false;
  let last = '';
  for (const { row } of sequence) {
    const at = row.values.changed_at;
    if (at?.storageClass !== 'text' || !SQLITE_DATETIME.test(at.value) || at.value < last) return false;
    last = at.value;
  }
  return true;
}

function normalizeSide(trace, scenario, label, side, found, approvals, runRoot = null) {
  const bijection = new Bijection();
  const jsonRecords = new Map(), dbRecords = new Map(), schemaRecords = new Map(), sealedRecords = new Map(), keyedRecords = new Map();
  let hsts = false, audit = false;
  const aead = approvals.approved.has('N-016');
  const sealed = (where, segment, placeholder) => {
    const id = JSON.stringify(where);
    const entry = sealedRecords.get(id) ?? { rule: 'N-016', side, ...where, replaced: 0, samples: [] };
    entry.replaced++;
    if (entry.samples.length < 3) entry.samples.push({ value: segment, placeholder });
    sealedRecords.set(id, entry);
  };
  const json = (site, raw) => {
    const entries = found.json.get(site);
    if (!entries) return raw;
    let value = parseExact(raw), changed = false;
    for (const entry of entries) {
      const leaf = getAt(value, entry.pointer);
      let next = null;
      if (leaf !== MISSING && entry.kind === 'n' && isNumber(leaf) && volatileNumber(entry.pointer, numberSource(leaf))) {
        next = bijection.get(tokenKey(numberSource(leaf)), `<n@${site}${entry.pointer}>`);
      } else if (leaf !== MISSING && entry.kind === 's' && typeof leaf === 'string' && entry.template.mode === 'generated') {
        if (generatedShape(leaf) === entry.template.shape) next = bijection.get(tokenKey(leaf), `<@${site}${entry.pointer}#1>`);
      } else if (leaf !== MISSING && entry.kind === 's' && typeof leaf === 'string') {
        const fit = fitTemplate(leaf, entry.template);
        const n011 = approvals.approved.has('N-011');
        if (fit && fit.positions.every(index => fitTokenRandomLike(fit, index, n011))) next = fit.segments.map((segment, index) => {
          if (!fit.positions.includes(index)) return segment;
          const placeholder = bijection.get(tokenKey(segment), sealedName(fit.segments, index, `<@${site}${entry.pointer}#${index}>`));
          if (fit.segments.aead?.has(index)) sealed({ site, pointer: entry.pointer }, segment, placeholder);
          return placeholder;
        }).join('');
      }
      jsonRecords.set(`${site}\u0000${entry.pointer}`, { value: leaf === MISSING ? null : leaf, missing: leaf === MISSING, normalized: next });
      if (next !== null) { value = setAt(value, entry.pointer, next); changed = true; }
    }
    return changed ? stringifyExact(value) : raw;
  };
  const cell = (current, rule, place, assign, seen, where = null) => {
    if (current.storageClass === 'null') return current;
    if (rule === 'N-001') return { storageClass: current.storageClass, value: TS };
    if (rule === 'N-010') return current; // projected per snapshot in changeLogTimes
    if (seen.stable.has(cellKey(current))) return current;
    const pick = (key, placeholder) => assign ? bijection.get(key, placeholder) : bijection.peek(key) ?? '?';
    if (current.storageClass === 'integer') {
      return randomNumber(current.value) ? { storageClass: 'integer', value: pick(tokenKey(current.value), `<i@${place}>`) } : current;
    }
    if (current.storageClass !== 'text') return current;
    const segments = tokenize(current.value, aead);
    let value;
    const whole = randomLike(current.value) || seen.generated?.has(generatedShape(current.value));
    if (segments.length === 1 && whole && bijection.replaceLiterals(current.value) === current.value) {
      value = pick(tokenKey(current.value), `<@${place}>`);
    } else {
      value = segments.map((segment, index) => {
        if (index % 2 === 0) return bijection.replaceLiterals(segment);
        if (seen.stableTokens.has(segment)) return segment;
        const placeholder = pick(tokenKey(segment), sealedName(segments, index, `<@${place}.${index}>`));
        if (assign && segments.aead?.has(index)) sealed(where, segment, placeholder);
        return placeholder;
      }).join('');
    }
    return value === current.value ? current : { storageClass: 'text', value };
  };
  const record = (recordKey, current, next) => {
    if (!dbRecords.has(recordKey)) dbRecords.set(recordKey, new Map());
    dbRecords.get(recordKey).set(cellKey(current), next);
  };
  const db = (unit, state) => {
    const databases = {};
    // N-012: tied rows wait until every other row of this capture has named its values.
    const deferred = [], finish = [];
    for (const name of Object.keys(state.databases).sort()) {
      if (name === HSTS && approvals.approved.has('N-004')) { hsts = true; continue; }
      const database = state.databases[name];
      const relative = slotRelative(name);
      const tables = {};
      for (const tableName of Object.keys(database.tables).sort()) {
        const table = database.tables[tableName];
        const volatile = found.columns.get(tableKey(name, tableName));
        const isAudit = approvals.approved.has('N-002') && relative === AUDIT.db && tableName === AUDIT.table;
        if (!volatile && !isAudit) { tables[tableName] = table; continue; }
        if (isAudit) audit = true;
        const names = table.columns.map(column => column.name).sort();
        const kept = names.filter(column => !(isAudit && AUDIT.ignored.includes(column)));
        const seenOf = column => found.distinct.get(tableKey(name, tableName) + `\u0000${column}`);
        const maskedKey = row => JSON.stringify(kept.map(column => {
          const rule = volatile?.get(column);
          return rule ? cell(row.values[column], rule, '', false, seenOf(column)) : row.values[column];
        }));
        const out = new Array(table.rows.length);
        const assign = (row, index, place) => {
          out[index] = Object.fromEntries(kept.map(column => {
            const rule = volatile?.get(column);
            if (!rule) return [column, row.values[column]];
            const next = cell(row.values[column], rule, place(column, row), true, seenOf(column), { db: name, table: tableName, column });
            record(tableKey(name, tableName) + `\u0000${column}`, row.values[column], next);
            return [column, next];
          }));
        };
        const sequence = tableName === CHANGE_LOG && approvals.approved.has('N-010') ? changeLogSequence(table, volatile) : null;
        const keys = !sequence && !isAudit && approvals.approved.has('N-017') ? stableKeys(table, column => found.stableColumns?.has(`${tableKey(name, tableName)}\u0000${column}`)) : null;
        if (sequence) {
          // N-010: sequence order, names from (table_name, operation, record_id) first appearance.
          const triples = new Map();
          for (const { row, index } of sequence) {
            const triple = JSON.stringify(['table_name', 'operation', 'record_id'].map(column => cellKey(row.values[column])));
            if (!triples.has(triple)) triples.set(triple, triples.size);
            const ordinal = triples.get(triple);
            assign(row, index, (column, current) => column === 'record_id'
              ? `${relative}/${tableName}/record_id@${current.values.table_name.value}:${current.values.operation.value}#${ordinal}`
              : `u${unit}:${relative}/${tableName}/${column}#${ordinal}`);
          }
          if (changeLogTimes(sequence, volatile)) {
            for (const { row, index } of sequence) {
              out[index].changed_at = { storageClass: 'text', value: TS };
              record(tableKey(name, tableName) + '\u0000changed_at', row.values.changed_at, out[index].changed_at);
            }
          }
        } else if (keys) {
          // N-017: rows in key order, names from the key (another row on one side shifts nothing).
          keyedRecords.set(tableKey(name, tableName), { rule: 'N-017', side, db: name, table: tableName, primaryKey: table.primaryKey });
          const order = keys.map((key, index) => ({ key, index })).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
          for (const { key, index } of order) assign(table.rows[index], index, column => `u${unit}:${relative}/${tableName}[${key}]/${column}`);
        } else {
          // Deterministic row order for first-seen names: unknown volatile values are masked.
          const masked = table.rows.map((row, index) => ({ row, index, key: maskedKey(row) }))
            .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.index - y.index));
          const counts = new Map();
          for (const { key } of masked) counts.set(key, (counts.get(key) ?? 0) + 1);
          const ties = [];
          for (const [rank, { row, index, key }] of masked.entries()) {
            if (approvals.approved.has('N-012') && counts.get(key) > 1 && key.includes('?')) ties.push({ row, index });
            else assign(row, index, column => `u${unit}:${relative}/${tableName}/${column}#${rank}`);
          }
          if (ties.length) deferred.push({ ties, maskedKey, assign, place: (column, rank) => `u${unit}:${relative}/${tableName}/${column}#t${rank}` });
        }
        finish.push(() => {
          const rows = table.rows.map((row, index) => ({ key: row.key, values: out[index] }));
          tables[tableName] = rebuildKeys({ ...table, primaryKey: isAudit ? [] : table.primaryKey, rows });
        });
      }
      let schema = database.schema, schemaChanges = 0;
      const schemaSamples = [];
      if (approvals.approved.has('N-006') && Array.isArray(database.schema)) {
        schema = database.schema.map(entry => {
          if (!entry || typeof entry.sql !== 'string') return entry;
          const next = foldSql(entry.sql);
          if (next === entry.sql) return entry;
          schemaChanges++;
          if (schemaSamples.length < 3) schemaSamples.push({ type: entry.type, name: entry.name, before: entry.sql, after: next });
          return { ...entry, sql: next };
        });
        if (schemaChanges) {
          const current = schemaRecords.get(relative);
          if (!current) schemaRecords.set(relative, { rule: 'N-006', side, db: relative, snapshots: 1, changedMax: schemaChanges, samples: schemaSamples });
          else {
            current.snapshots++;
            current.changedMax = Math.max(current.changedMax, schemaChanges);
            if (current.samples.length < 3) current.samples.push(...schemaSamples.slice(0, 3 - current.samples.length));
          }
        }
      }
      databases[name] = { ...database, schema, tables };
    }
    for (const { ties, maskedKey, assign, place } of deferred) {
      const order = ties.map(tie => ({ ...tie, key: maskedKey(tie.row) }))
        .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.index - y.index));
      for (const [rank, { row, index }] of order.entries()) assign(row, index, column => place(column, rank));
    }
    for (const done of finish) done();
    return { ...state, databases };
  };
  let normalized = walkTrace(trace, scenario, label, side, { json, db });
  let runRootRecord = null;
  if (approvals.approved.has('N-007') && typeof runRoot === 'string' && runRoot.length) {
    let replaced = 0;
    const samples = [];
    // Clone only the containers whose subtree changed; raw JSON numbers and BigInt stay identical.
    const mask = value => {
      if (typeof value === 'string') {
        if (!value.includes(runRoot)) return value;
        replaced++;
        if (samples.length < 3) samples.push(value.length > 240 ? value.slice(0, 240) + '…' : value);
        return value.split(runRoot).join('<run>');
      }
      if (Array.isArray(value)) {
        let changed = false;
        const next = value.map(item => { const mapped = mask(item); if (mapped !== item) changed = true; return mapped; });
        return changed ? next : value;
      }
      if (value !== null && typeof value === 'object' && !JSON.isRawJSON(value)) {
        let changed = false;
        const next = {};
        for (const [key, item] of Object.entries(value)) { const mapped = mask(item); if (mapped !== item) changed = true; next[key] = mapped; }
        return changed ? next : value;
      }
      return value;
    };
    normalized = mask(normalized);
    if (replaced) runRootRecord = { rule: 'N-007', side, runRoot, replaced, samples };
  }
  return { normalized, jsonRecords, dbRecords, schemaRecords: [...schemaRecords.values()], runRootRecord, hsts, audit, tokens: bijection.list(),
    sealedRecords: [...sealedRecords.values()], keyedRecords: [...keyedRecords.values()] };
}

// ---- N-015: get_app_version build number and commit ----
const APP_VERSION = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?) \(Build \d+, [0-9a-f]{7,40}\)$/;
function maskAppVersion(trace, side, entries) {
  return { ...trace, calls: trace.calls.map(call => {
    if (call.command !== 'get_app_version' || call.outcome.kind !== 'result' || typeof call.outcome.raw !== 'string') return call;
    const value = parseExact(call.outcome.raw);
    if (typeof value !== 'string' || !APP_VERSION.test(value)) return call;
    const normalized = value.replace(APP_VERSION, '$1 (Build <build>, <commit>)');
    entries.push({ rule: 'N-015', side, command: 'get_app_version', value, normalized });
    return { ...call, outcome: { ...call.outcome, raw: stringifyExact(normalized) } };
  }) };
}

/**
 * sides: { A1: {trace, exact}, A2: {trace, exact} | null, B: {trace, exact} }; labels: per side
 * `(eventName, step) -> label | null` built from A1's event scope. Returns normalized A/B traces
 * (same shape compareTraces reads) and the substitution list required by N-003/N-005.
 */
export function normalizeTraces({ scenario, sides, labels, approvals, runRoots = {}, split = null }) {
  const merge = side => ({ ...side.exact, finalDatabases: side.trace.finalDatabases,
    before: { ...side.exact.before, databases: side.trace.before?.databases },
    after: { ...side.exact.after, databases: side.trace.after?.databases },
    calls: side.exact.calls.map((call, index) => ({ ...call, capture: { ...call.capture, databases: side.trace.calls[index].capture?.databases } })) });
  const traces = { A1: merge(sides.A1), B: merge(sides.B), A2: sides.A2 ? merge(sides.A2) : null };
  const rules = approvals ?? { approved: new Set(), n001: new Set(), n001SameTake: false };
  const found = traces.A2 ? detect(traces.A1, traces.A2, scenario, labels, rules)
    : { json: new Map(), columns: new Map(), distinct: new Map(), skipped: [] };
  const a = normalizeSide(traces.A1, scenario, labels.A1, 'A', found, rules, runRoots.A1 ?? null);
  const b = normalizeSide(traces.B, scenario, labels.B, 'B', found, rules, runRoots.B ?? null);
  const entries = [];
  for (const list of found.json.values()) for (const item of list) {
    const key = `${item.site}\u0000${item.pointer}`, left = a.jsonRecords.get(key), right = b.jsonRecords.get(key);
    entries.push({ rule: item.rule, site: item.site, pointer: item.pointer, mode: item.kind === 'n' ? 'number' : item.template.mode,
      A1: item.A1, A2: item.A2, A: left?.value ?? null, B: right?.value ?? null,
      placeholderA: left?.normalized ?? null, placeholderB: right?.normalized ?? null,
      ...(right?.missing ? { missingB: true } : {}), ...(left?.missing ? { missingA: true } : {}) });
  }
  const values = set => [...set].map(key => { const [storageClass, value] = key.split('\u0001'); return { storageClass, value }; });
  const mapped = records => records ? [...records].map(([key, next]) => ({ ...values([key])[0], normalized: next })) : [];
  for (const [key, columns] of found.columns) for (const [column, rule] of columns) {
    const [db, table] = key.split('\u0000'), id = `${key}\u0000${column}`, seen = found.distinct.get(id);
    entries.push({ rule, db, slotPath: slotRelative(db), table, column, A1: values(seen.A1), A2: values(seen.A2),
      ...(seen.generated.size ? { generated: [...seen.generated].sort(), extendedBy: 'N-011' } : {}),
      A: mapped(a.dbRecords.get(id)), B: mapped(b.dbRecords.get(id)) });
  }
  for (const record of [a, b]) for (const entry of record.schemaRecords) entries.push(entry);
  for (const record of [a, b]) for (const entry of [...record.keyedRecords, ...record.sealedRecords]) entries.push(entry);
  for (const record of [a, b]) if (record.runRootRecord) entries.push(record.runRootRecord);
  if (a.audit || b.audit) entries.push({ rule: 'N-002', db: AUDIT.db, table: AUDIT.table, multiset: true, ignored: AUDIT.ignored });
  const excludedFiles = [];
  const hstsSides = [['A', a.hsts], ['B', b.hsts]].filter(([, present]) => present).map(([side]) => side);
  if (hstsSides.length) excludedFiles.push({ file: HSTS, rule: 'N-004', sides: hstsSides });
  let A = a.normalized, B = b.normalized, order = [];
  const skipped = [...found.skipped];
  if (rules.approved.has('N-015')) { A = maskAppVersion(A, 'A', entries); B = maskAppVersion(B, 'B', entries); }
  if (split && rules.approved.has('N-014')) {
    const { A: wa, B: wb } = split.windows ?? {};
    const reason = !traces.A2 ? 'no A2 take: A-stable locations unknown'
      : !wa || !wb ? `no recording window for ${!wa ? 'A' : 'B'}`
      : !(wa.to < wb.from || wb.to < wa.from) ? 'A and B recording windows overlap' : null;
    if (reason) skipped.push({ rule: 'N-014', reason });
    else {
      const stable = { stableColumns: found.stableColumns, stableJson: stableJsonSites(traces.A1, traces.A2) };
      const pa = projectClock(A, wa, stable), pb = projectClock(B, wb, stable);
      A = pa.trace; B = pb.trace;
      const { shared, inversions } = clockInversions(pa.readings, pb.readings);
      order = clockOrderDifferences(scenario, inversions);
      for (const [side, projected, window] of [['A', pa, wa], ['B', pb, wb]]) {
        entries.push({ rule: 'N-014', side, window: { from: iso(window.from), to: iso(window.to) }, replaced: projected.replaced,
          locations: projected.readings.size, samples: projected.samples });
      }
      entries.push({ rule: 'N-014', order: { shared, inversions: inversions.length } });
    }
  }
  return { A, B, entries, skipped, excludedFiles, order, tokens: { A: a.tokens, B: b.tokens } };
}
