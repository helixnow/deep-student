// Classifies G3 A (Rust) / B (host) differences into serde representation classes.
//
// DB text columns are compared byte-level (number spelling and key order are visible);
// IPC outcome/events/args differences come from the G3 comparator, which compares numbers by
// value and ignores key order (host/e2e/data-compat/__fixtures__/database-state.ts), so only
// None/omit, numeric precision and string format are observable there.

export const SERDE_TAGS = [
  'f64-integer', 'f32-precision', 'float-spelling', 'u64-precision',
  'none-null-vs-omit', 'skip-default', 'key-order', 'time-format',
];
/** Non-serde outcomes kept for completeness. */
export const OTHER_TAGS = ['field-set', 'type', 'value'];

// ---- loose JSON parser: raw number text, ordered entries, unquoted `<x@...>` placeholders ----

/**
 * @typedef {{t:'obj',entries:[string,Node][]}|{t:'arr',items:Node[]}|{t:'num',raw:string}|
 *   {t:'str',v:string}|{t:'bool',v:boolean}|{t:'null'}|{t:'ph',raw:string}} Node
 */

/** @returns {Node|undefined} */
export function parseLoose(text) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  const fail = () => { throw new SyntaxError(`at ${i}`); };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const entries = []; ws();
      if (text[i] === '}') { i++; return { t: 'obj', entries }; }
      for (;;) {
        ws(); if (text[i] !== '"') fail();
        const key = string(); ws(); if (text[i++] !== ':') fail();
        entries.push([key, value()]); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === '}') return { t: 'obj', entries };
        fail();
      }
    }
    if (c === '[') {
      i++; const items = []; ws();
      if (text[i] === ']') { i++; return { t: 'arr', items }; }
      for (;;) {
        items.push(value()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === ']') return { t: 'arr', items };
        fail();
      }
    }
    if (c === '"') return { t: 'str', v: string() };
    if (c === '<') {
      const end = text.indexOf('>', i);
      if (end < 0) fail();
      const raw = text.slice(i, end + 1); i = end + 1;
      return { t: 'ph', raw };
    }
    for (const [word, node] of [['true', { t: 'bool', v: true }], ['false', { t: 'bool', v: false }], ['null', { t: 'null' }]]) {
      if (text.startsWith(word, i)) { i += word.length; return node; }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail();
    i += m[0].length;
    return { t: 'num', raw: m[0] };
  };
  const string = () => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail();
    i++;
    return JSON.parse(text.slice(start, i));
  };
  try {
    const node = value(); ws();
    return i === text.length ? node : undefined;
  } catch {
    return undefined;
  }
}

/** JS value (already parsed, comparator evidence) → Node. Numbers keep their JS spelling. */
export function fromJs(v) {
  if (v === null || v === undefined) return { t: 'null' };
  if (Array.isArray(v)) return { t: 'arr', items: v.map(fromJs) };
  switch (typeof v) {
    case 'number': return { t: 'num', raw: String(v), js: true };
    case 'string': return { t: 'str', v };
    case 'boolean': return { t: 'bool', v };
    case 'object': return { t: 'obj', entries: Object.entries(v).map(([k, x]) => [k, fromJs(x)]) };
    default: return { t: 'str', v: String(v) };
  }
}

// ---- comparison ----

const INTEGRAL = /^-?\d+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const isEmptyDefault = (n) =>
  (n.t === 'arr' && n.items.length === 0) || (n.t === 'obj' && n.entries.length === 0) ||
  (n.t === 'str' && n.v === '') || (n.t === 'bool' && !n.v) || (n.t === 'num' && Number(n.raw) === 0);

const instant = (s) => {
  if (!RFC3339.test(s)) return undefined;
  const ns = s.match(/\.(\d+)/)?.[1] ?? '';
  const ms = Date.parse(s.replace(' ', 'T').replace(/\.\d+/, ''));
  return Number.isNaN(ms) ? undefined : `${ms}.${ns.padEnd(9, '0')}`;
};

function compareNumbers(a, b, path, out) {
  if (a.raw === b.raw) return;
  const x = Number(a.raw), y = Number(b.raw);
  if (x === y) {
    if (INTEGRAL.test(a.raw) && INTEGRAL.test(b.raw)) {
      if (BigInt(a.raw) !== BigInt(b.raw)) out.push({ tag: 'u64-precision', path, a: a.raw, b: b.raw });
      return;
    }
    if (a.js || b.js) return;
    if (Number.isInteger(x) && (INTEGRAL.test(a.raw) || INTEGRAL.test(b.raw))) {
      out.push({ tag: 'f64-integer', path, a: a.raw, b: b.raw, direction: INTEGRAL.test(a.raw) ? 'rust-int' : 'rust-float' });
    } else {
      out.push({ tag: 'float-spelling', path, a: a.raw, b: b.raw });
    }
    return;
  }
  if (Math.fround(x) === Math.fround(y) && !(Number.isInteger(x) && Number.isInteger(y))) {
    out.push({ tag: 'f32-precision', path, a: a.raw, b: b.raw, direction: a.raw.length <= b.raw.length ? 'rust-f32' : 'host-f32' });
    return;
  }
  out.push({ tag: 'value', path, a: a.raw, b: b.raw });
}

function compare(a, b, path, out) {
  if (a.t !== b.t) {
    out.push({ tag: a.t === 'ph' || b.t === 'ph' ? 'value' : 'type', path, a: a.t, b: b.t });
    return;
  }
  switch (a.t) {
    case 'num': return compareNumbers(a, b, path, out);
    case 'str': {
      if (a.v === b.v) return;
      const ia = instant(a.v), ib = instant(b.v);
      out.push({ tag: ia !== undefined && ia === ib ? 'time-format' : 'value', path, a: a.v.slice(0, 80), b: b.v.slice(0, 80) });
      return;
    }
    case 'bool': if (a.v !== b.v) out.push({ tag: 'value', path }); return;
    case 'ph': if (a.raw !== b.raw) out.push({ tag: 'value', path, a: a.raw, b: b.raw }); return;
    case 'null': return;
    case 'arr': {
      const n = Math.max(a.items.length, b.items.length);
      if (a.items.length !== b.items.length) out.push({ tag: 'value', path: `${path}.length`, a: a.items.length, b: b.items.length });
      for (let k = 0; k < Math.min(a.items.length, b.items.length) && k < n; k++) compare(a.items[k], b.items[k], `${path}[${k}]`, out);
      return;
    }
    case 'obj': {
      const am = new Map(a.entries), bm = new Map(b.entries);
      for (const [k, av] of a.entries) {
        const sub = `${path}.${k}`;
        if (bm.has(k)) compare(av, bm.get(k), sub, out);
        else out.push(missing(av, 'rust-null', sub));
      }
      for (const [k, bv] of b.entries) if (!am.has(k)) out.push(missing(bv, 'rust-omit', `${path}.${k}`));
      const common = (entries, other) => entries.map(([k]) => k).filter((k) => other.has(k));
      const ak = common(a.entries, bm), bk = common(b.entries, am);
      if (ak.some((k, idx) => bk[idx] !== k)) out.push({ tag: 'key-order', path, a: ak.slice(0, 12), b: bk.slice(0, 12) });
      return;
    }
  }
}

/** `present` exists on one side only; direction names the side that omits it in Rust terms. */
function missing(present, direction, path) {
  if (present.t === 'null') return { tag: 'none-null-vs-omit', path, direction };
  if (isEmptyDefault(present)) return { tag: 'skip-default', path, direction };
  return { tag: 'field-set', path, direction };
}

const summarize = (findings) => ({ findings, tags: [...new Set(findings.map((f) => f.tag))].sort() });

/** DB text column pair. Only JSON objects/arrays count as JSON columns; otherwise undefined. */
export function classifyJsonText(aText, bText) {
  if (typeof aText !== 'string' || typeof bText !== 'string') return undefined;
  const a = parseLoose(aText), b = parseLoose(bText);
  if (!a || !b || !['obj', 'arr'].includes(a.t) || !['obj', 'arr'].includes(b.t)) return undefined;
  const out = [];
  compare(a, b, '$', out);
  return summarize(out);
}

/** G3 comparator difference `{path, expected (A), actual (B), missing?}`. */
export function classifyOutcome(d) {
  const path = `$${String(d.path ?? '').replace(/\//g, '.')}`;
  if (d.missing === 'expected') return summarize([missing(fromJs(d.actual), 'rust-omit', path)]);
  if (d.missing === 'actual') return summarize([missing(fromJs(d.expected), 'rust-null', path)]);
  const out = [];
  compare(fromJs(d.expected), fromJs(d.actual), path, out);
  return summarize(out);
}
