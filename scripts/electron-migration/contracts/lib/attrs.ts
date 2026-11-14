// Rust 属性（`#[...]` 内文本）的最小 token 化与 Meta 解析，语义对应 syn 的 `Meta`：
// `path`、`path = lit`、`path(list, ...)`。serde/tauri/cfg 属性都只用这三种形态。

export type Tok =
  | { t: 'ident'; v: string }
  | { t: 'str'; v: string }
  | { t: 'lit'; v: string }
  | { t: 'punct'; v: string }
  | { t: 'group'; open: string; toks: Tok[] };

export type Meta =
  | { kind: 'path'; path: string }
  | { kind: 'nv'; path: string; value: Tok[] }
  | { kind: 'list'; path: string; toks: Tok[] };

function unescapeRustString(body: string): string {
  return body.replace(/\\(u\{([0-9a-fA-F_]+)\}|x([0-9a-fA-F]{2})|n|r|t|0|\\|'|"|\n\s*)/g, (m, _a, u, x) => {
    if (u) return String.fromCodePoint(parseInt(u.replace(/_/g, ''), 16));
    if (x) return String.fromCharCode(parseInt(x, 16));
    switch (m[1]) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case '0': return '\0';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      default: return ''; // 行尾续行
    }
  });
}

/** 解析 Rust 字符串字面量文本（含 r"..", r#".."#, b"..."），返回内容；不是字符串返回 null。 */
export function rustStringValue(text: string): string | null {
  const raw = /^b?r(#*)"([\s\S]*)"\1$/.exec(text);
  if (raw) return raw[2]!;
  const norm = /^b?"([\s\S]*)"$/.exec(text);
  if (norm) return unescapeRustString(norm[1]!);
  return null;
}

export function tokenize(src: string): Tok[] {
  let i = 0;
  const stack: { open: string; toks: Tok[] }[] = [{ open: '', toks: [] }];
  const push = (t: Tok): void => { stack[stack.length - 1]!.toks.push(t); };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    const rawm = /^b?r(#*)"/.exec(src.slice(i, i + 40));
    if (rawm) {
      const hashes = rawm[1]!;
      const start = i + rawm[0].length;
      const end = src.indexOf('"' + hashes, start);
      const stop = end < 0 ? src.length : end + 1 + hashes.length;
      push({ t: 'str', v: src.slice(start, end < 0 ? src.length : end) });
      i = stop;
      continue;
    }
    if (c === '"' || (c === 'b' && src[i + 1] === '"')) {
      let j = c === 'b' ? i + 2 : i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      push({ t: 'str', v: unescapeRustString(src.slice(c === 'b' ? i + 2 : i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const m = /^'(\\.[^']*|[^\\'])'/u.exec(src.slice(i));
      if (m) { push({ t: 'lit', v: m[0] }); i += m[0].length; continue; }
      const lt = /^'[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      push({ t: 'lit', v: lt ? lt[0] : "'" });
      i += lt ? lt[0].length : 1;
      continue;
    }
    const id = /^(r#)?[\p{XID_Start}_][\p{XID_Continue}]*/u.exec(src.slice(i));
    if (id) { push({ t: 'ident', v: id[0].replace(/^r#/, '') }); i += id[0].length; continue; }
    const num = /^[0-9][0-9A-Za-z_.]*/.exec(src.slice(i));
    if (num) { push({ t: 'lit', v: num[0] }); i += num[0].length; continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push({ open: c, toks: [] }); i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      const g = stack.pop()!;
      if (!stack.length) { stack.push(g); i++; continue; }
      push({ t: 'group', open: g.open, toks: g.toks });
      i++;
      continue;
    }
    if (c === ':' && src[i + 1] === ':') { push({ t: 'punct', v: '::' }); i += 2; continue; }
    push({ t: 'punct', v: c });
    i++;
  }
  while (stack.length > 1) {
    const g = stack.pop()!;
    stack[stack.length - 1]!.toks.push({ t: 'group', open: g.open, toks: g.toks });
  }
  return stack[0]!.toks;
}

export function splitCommas(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if (t.t === 'punct' && t.v === ',') { out.push(cur); cur = []; } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 把一段 token 解析为 Meta（`a::b`、`a = x`、`a(...)`）。无法解析返回 null。 */
export function parseMeta(toks: Tok[]): Meta | null {
  let i = 0;
  const segs: string[] = [];
  if (toks[i]?.t === 'punct' && (toks[i] as { v: string }).v === '::') i++;
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.t !== 'ident') break;
    segs.push(t.v);
    i++;
    const n = toks[i];
    if (n && n.t === 'punct' && n.v === '::') { i++; continue; }
    break;
  }
  if (!segs.length) return null;
  const path = segs.join('::');
  if (i === toks.length) return { kind: 'path', path };
  const t = toks[i]!;
  if (t.t === 'punct' && t.v === '=') return { kind: 'nv', path, value: toks.slice(i + 1) };
  if (t.t === 'group' && t.open === '(' && i === toks.length - 1) return { kind: 'list', path, toks: t.toks };
  return null;
}

export function parseMetaList(toks: Tok[]): (Meta | null)[] {
  return splitCommas(toks).map(parseMeta);
}

/** 属性项文本 `#[...]` / `#![...]` → Meta。 */
export function parseAttributeText(text: string): Meta | null {
  const m = /^#!?\[([\s\S]*)\]$/.exec(text.trim());
  if (!m) return null;
  return parseMeta(tokenize(m[1]!));
}

/** nv 的值为单个字符串字面量时返回其内容。 */
export function metaStr(m: Meta): string | null {
  if (m.kind !== 'nv' || m.value.length !== 1) return null;
  const v = m.value[0]!;
  return v.t === 'str' ? v.v : null;
}

export function toksText(toks: Tok[]): string {
  return toks.map((t) => {
    switch (t.t) {
      case 'str': return JSON.stringify(t.v);
      case 'group': {
        const close = t.open === '(' ? ')' : t.open === '[' ? ']' : '}';
        return t.open + toksText(t.toks) + close;
      }
      default: return t.v;
    }
  }).join(' ').replace(/ :: /g, '::').replace(/ ,/g, ',');
}
