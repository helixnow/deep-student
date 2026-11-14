// Minimal SQLite write-statement parser: which bound parameter feeds which column.
// Parameter numbering follows SQLite: `?NNN` sets the index, bare `?` takes max-so-far + 1.

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const unquote = (s) => s.replace(/^["`[]|["`\]]$/g, '');

/** Splits on top-level commas (outside parens and quotes). */
function splitTop(text) {
  const parts = [];
  let depth = 0, start = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** Index of the `)` closing the `(` at `open`. */
function closing(text, open) {
  let depth = 0, quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Top-level keyword position (outside parens/quotes), case-insensitive. */
function findTop(text, re, from = 0) {
  let depth = 0, quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth === 0 && /[A-Za-z]/.test(c) && (i === 0 || !/\w/.test(text[i - 1]))) {
      const m = re.exec(text.slice(i));
      if (m && m.index === 0) return i;
    }
  }
  return -1;
}

/** Assigns SQLite indexes to every parameter, in textual order (quotes skipped). */
function numberParams(sql) {
  const params = [];
  let max = 0, quote = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'") { quote = c; continue; }
    if (c === '?') {
      const m = /^\?(\d*)/.exec(sql.slice(i));
      const index = m[1] ? Number(m[1]) : max + 1;
      max = Math.max(max, index);
      params.push({ at: i, end: i + m[0].length, index });
      i += m[0].length - 1;
    } else if (/[:@$]/.test(c) && /[A-Za-z_]/.test(sql[i + 1] ?? '') && !/[\w:]/.test(sql[i - 1] ?? '')) {
      const m = /^[:@$]([A-Za-z_]\w*)/.exec(sql.slice(i));
      if (sql[i + 1] === '{') continue;
      params.push({ at: i, end: i + m[0].length, name: m[1] });
      i += m[0].length - 1;
    }
  }
  return params;
}

/**
 * @returns {{op:'insert'|'update', table:string, columns:{column:string, param?:{index?:number,name?:string}, expr:string}[]}|undefined}
 */
export function parseSqlWrite(sql) {
  if (typeof sql !== 'string') return undefined;
  const text = sql.replace(/--[^\n]*/g, ' ');
  const params = numberParams(text);
  const paramIn = (from, to) => {
    const inside = params.filter((p) => p.at >= from && p.end <= to);
    return inside.length === 1 ? { ...(inside[0].index !== undefined ? { index: inside[0].index } : { name: inside[0].name }) } : undefined;
  };
  const columns = [];
  const setClause = (start, end) => {
    let offset = start;
    for (const part of splitTop(text.slice(start, end))) {
      const at = text.indexOf(part, offset);
      offset = at + part.length;
      const m = new RegExp(`^(${IDENT})\\s*=\\s*([\\s\\S]*)$`).exec(part);
      if (!m) continue;
      const exprAt = at + part.length - m[2].length;
      columns.push({ column: unquote(m[1]), param: paramIn(exprAt, exprAt + m[2].length), expr: m[2].trim() });
    }
  };

  const ins = new RegExp(String.raw`^\s*(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+(?:${IDENT}\.)?(${IDENT})\s*\(`, 'i').exec(text);
  if (ins) {
    const open = ins.index + ins[0].length - 1;
    const close = closing(text, open);
    if (close < 0) return undefined;
    const names = splitTop(text.slice(open + 1, close)).map(unquote);
    const rest = close + 1;
    const values = findTop(text, /^VALUES\b/i, rest);
    let exprStart = -1, exprEnd = -1;
    if (values >= 0) {
      const tupleOpen = text.indexOf('(', values);
      const between = tupleOpen < 0 ? '' : text.slice(values + 6, tupleOpen);
      if (tupleOpen >= 0 && /^\s*$/.test(between)) { exprStart = tupleOpen + 1; exprEnd = closing(text, tupleOpen); }
    } else {
      const select = findTop(text, /^SELECT\b/i, rest);
      if (select >= 0) {
        exprStart = select + 6;
        const from = findTop(text, /^(?:FROM|WHERE|ON\s+CONFLICT|RETURNING)\b/i, exprStart);
        exprEnd = from < 0 ? text.length : from;
      }
    }
    const exprs = exprStart >= 0 && exprEnd > exprStart ? splitTop(text.slice(exprStart, exprEnd)) : [];
    let offset = exprStart;
    names.forEach((column, k) => {
      const expr = exprs[k];
      if (expr === undefined) { columns.push({ column, expr: '' }); return; }
      const at = text.indexOf(expr, offset);
      offset = at + expr.length;
      columns.push({ column, param: paramIn(at, at + expr.length), expr });
    });
    const upd = findTop(text, /^DO\s+UPDATE\s+SET\b/i, rest);
    if (upd >= 0) {
      const start = text.slice(upd).search(/SET\b/i) + upd + 3;
      const end = findTop(text, /^(?:WHERE|RETURNING|ON\s+CONFLICT)\b/i, start);
      const before = columns.length;
      setClause(start, end < 0 ? text.length : end);
      // `v = excluded.v` re-states an insert column; keep only parameter-bound SET entries.
      columns.splice(before, columns.length - before, ...columns.slice(before).filter((c) => c.param && !columns.slice(0, before).some((x) => x.column === c.column && x.param)));
    }
    return { op: 'insert', table: unquote(ins[1]), columns };
  }

  const up = new RegExp(String.raw`^\s*UPDATE(?:\s+OR\s+\w+)?\s+(?:${IDENT}\.)?(${IDENT})\s+SET\b`, 'i').exec(text);
  if (up) {
    const start = up.index + up[0].length;
    const end = findTop(text, /^(?:WHERE|RETURNING|FROM)\b/i, start);
    setClause(start, end < 0 ? text.length : end);
    return { op: 'update', table: unquote(up[1]), columns };
  }
  return undefined;
}
