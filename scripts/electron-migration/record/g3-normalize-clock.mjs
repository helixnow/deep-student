// G3 normalization N-014 (g3-normalize.mjs normalizeTraces): clock readings when A/A2 and B were
// recorded at different times. Split recording only, disjoint windows: at locations where A1 == A2,
// text timestamps and 10/13-digit epochs inside a side's recording window become shape placeholders,
// and pairs of shared locations ordered one way on A and the other way on B are reported.
import { parseExact, stringifyExact } from './json.mjs';
import { isNumber, kindOf, leaves, numberSource, setAt, tableKey } from './g3-normalize-values.mjs';

const CLOCK = /(?<![0-9])(\d{4})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?(?![0-9])/g;
const EPOCH = /^(?:\d{10}|\d{13})$/;

/** A clock token -> { ms, unit (1000 = second, 1 = millisecond), shape } or null. TZ is pinned to UTC. */
function clockReading(match) {
  const [, y, mo, d, sep, h, mi, s, frac, zone] = match;
  const offset = !zone || zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) * 60_000;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, frac ? Number(frac.slice(1, 4).padEnd(3, '0')) : 0) - offset;
  if (Number.isNaN(ms)) return null;
  return { ms, unit: frac ? 1 : 1000, shape: `<tw:YYYY-MM-DD${sep}hh:mm:ss${frac ? '.' + 'f'.repeat(frac.length - 1) : ''}${zone ?? ''}>` };
}
const epochReading = digits => EPOCH.test(digits)
  ? (digits.length === 13 ? { ms: Number(digits), unit: 1, shape: '<tw:epoch-ms>' } : { ms: Number(digits) * 1000, unit: 1000, shape: '<tw:epoch-s>' }) : null;
/** [from, to] widened to whole seconds (SQLite datetime('now') truncates). */
const inside = (window, ms) => ms >= Math.floor(window.from / 1000) * 1000 - 1000 && ms <= window.to + 1000;

/** Fixed-order sites of a merged trace: JSON by step/event name+ordinal, DB cells by row key; `step` for attribution. */
function clockWalk(trace, { json, db }) {
  const events = (list, step) => {
    if (!Array.isArray(list)) return list;
    const counts = new Map();
    return list.map(event => {
      const ordinal = counts.get(event.event) ?? 0;
      counts.set(event.event, ordinal + 1);
      const payloadRaw = json(`e:${event.event}#${ordinal}`, event.payloadRaw, step);
      return payloadRaw === event.payloadRaw ? event : { ...event, payloadRaw };
    });
  };
  const state = (value, step) => (value === undefined ? value : db(value, step));
  const out = { ...trace };
  out.before = { ...trace.before, events: events(trace.before?.events, -1), databases: state(trace.before?.databases, -1) };
  out.calls = trace.calls.map((call, index) => ({ ...call,
    argsRaw: json(`s${index}:args`, call.argsRaw, index),
    outcome: { ...call.outcome, raw: json(`s${index}:${call.outcome.kind}`, call.outcome.raw, index) },
    capture: { ...call.capture, events: events(call.capture?.events, index), databases: state(call.capture?.databases, index) } }));
  out.after = { ...trace.after, events: events(trace.after?.events, null), databases: state(trace.after?.databases, null) };
  if (trace.finalDatabases !== undefined) out.finalDatabases = state(trace.finalDatabases, null);
  return out;
}

/** JSON leaf locations where A1 and A2 hold the same value (never touched by N-003/N-005). */
export function stableJsonSites(a1, a2) {
  const collect = trace => {
    const out = new Map();
    clockWalk(trace, { json: (site, raw) => {
      if (typeof raw !== 'string') return raw;
      for (const [pointer, value] of leaves(parseExact(raw))) out.set(`${site}${pointer}`, value);
      return raw;
    }, db: value => value });
    return out;
  };
  const one = collect(a1), two = collect(a2), stable = new Set();
  for (const [key, v1] of one) {
    if (!two.has(key)) continue;
    const v2 = two.get(key), k1 = kindOf(v1);
    if (k1 === kindOf(v2) && (k1 === 'n' ? numberSource(v1) === numberSource(v2) : Object.is(v1, v2))) stable.add(key);
  }
  return stable;
}

/** Replaces in-window clock readings at A-stable locations with their shape; returns readings per location. */
export function projectClock(trace, window, { stableColumns, stableJson }) {
  const readings = new Map(), samples = [];
  let replaced = 0;
  const note = (location, reading, step, value) => {
    const list = readings.get(location) ?? [];
    if (!list.length || list.at(-1).ms !== reading.ms) list.push({ ms: reading.ms, unit: reading.unit, step });
    readings.set(location, list);
    replaced++;
    if (samples.length < 5) samples.push({ location, value, normalized: reading.shape });
  };
  const text = (value, location, step) => {
    let index = 0;
    return value.replace(CLOCK, (...match) => {
      const reading = clockReading(match), at = `${location}~${index++}`;
      if (!reading || !inside(window, reading.ms)) return match[0];
      note(at, reading, step, match[0]);
      return reading.shape;
    });
  };
  const json = (site, raw, step) => {
    if (typeof raw !== 'string') return raw;
    let value = parseExact(raw), changed = false;
    for (const [pointer, leaf] of leaves(value)) {
      const location = `${site}${pointer}`;
      if (!stableJson.has(location)) continue;
      let next = leaf;
      if (typeof leaf === 'string') next = text(leaf, location, step);
      else if (isNumber(leaf)) {
        const reading = epochReading(numberSource(leaf));
        if (reading && inside(window, reading.ms)) { note(`${location}~0`, reading, step, numberSource(leaf)); next = reading.shape; }
      }
      if (next !== leaf) { value = setAt(value, pointer, next); changed = true; }
    }
    return changed ? stringifyExact(value) : raw;
  };
  const db = (state, step) => {
    const databases = {};
    for (const [name, database] of Object.entries(state.databases)) {
      const tables = {};
      for (const [tableName, table] of Object.entries(database.tables)) {
        const columns = table.columns.map(column => column.name).filter(column => stableColumns.has(`${tableKey(name, tableName)}\u0000${column}`));
        if (!columns.length) { tables[tableName] = table; continue; }
        let touched = false;
        const rows = table.rows.map(row => {
          let values = row.values;
          for (const column of columns) {
            const cell = row.values[column], location = `d:${name}|${tableName}|${JSON.stringify(row.key)}|${column}`;
            let next = cell;
            if (cell?.storageClass === 'text') {
              const value = text(cell.value, location, step);
              if (value !== cell.value) next = { storageClass: 'text', value };
            } else if (cell?.storageClass === 'integer') {
              const reading = epochReading(String(cell.value));
              if (reading && inside(window, reading.ms)) { note(`${location}~0`, reading, step, String(cell.value)); next = { storageClass: 'integer', value: reading.shape }; }
            }
            if (next !== cell) { if (values === row.values) values = { ...row.values }; values[column] = next; }
          }
          if (values === row.values) return row;
          touched = true;
          return { ...row, values };
        });
        tables[tableName] = touched ? { ...table, rows } : table;
      }
      databases[name] = { ...database, tables };
    }
    return { ...state, databases };
  };
  return { trace: clockWalk(trace, { json, db }), readings, replaced, samples };
}

/** Pairs of shared locations whose readings are strictly ordered one way on A and the other way on B (at the coarser precision). */
export function clockInversions(a, b) {
  const items = [];
  for (const [location, list] of a) {
    const other = b.get(location);
    if (!other) continue;
    for (let i = 0; i < Math.min(list.length, other.length); i++) items.push({ location: `${location}#${i}`, A: list[i], B: other[i] });
  }
  const order = (x, y) => { const unit = Math.max(x.unit, y.unit), p = Math.floor(x.ms / unit), q = Math.floor(y.ms / unit); return p < q ? -1 : p > q ? 1 : 0; };
  const inversions = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (order(items[i].A, items[j].A) * order(items[i].B, items[j].B) < 0) inversions.push([items[i], items[j]]);
  }
  return { shared: items.length, inversions };
}

export const iso = ms => new Date(ms).toISOString();
/** N-014 as compare differences: one per step that holds the later location of an inverted pair (null: before/after/final). */
export function clockOrderDifferences(scenario, inversions) {
  const byStep = new Map();
  for (const [x, y] of inversions) {
    const steps = [x.A.step, y.A.step];
    const step = steps.includes(null) ? null : Math.max(...steps) < 0 ? null : Math.max(...steps);
    const list = byStep.get(step) ?? [];
    list.push({ first: x.location, second: y.location, A: [iso(x.A.ms), iso(y.A.ms)], B: [iso(x.B.ms), iso(y.B.ms)] });
    byStep.set(step, list);
  }
  return [...byStep].sort(([p], [q]) => (p ?? Infinity) - (q ?? Infinity)).map(([step, list]) => ({
    step, command: step === null ? null : scenario.steps[step].cmd, kind: 'timestamp-order', rule: 'N-014', count: list.length, sample: list.slice(0, 5) }));
}
