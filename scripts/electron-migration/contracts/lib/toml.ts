// Cargo.toml 所需的 TOML 子集解析：[table] / [a.'b'.c] 头、key = value、点分 key、
// 字符串（基本/字面量）、整数、布尔、数组（可跨行）、内联表。不支持的语法抛错，不静默跳过。

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [k: string]: TomlValue }

class P {
  i = 0;
  readonly s: string;
  constructor(s: string) { this.s = s; }
  err(msg: string): never {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`TOML 解析失败（第 ${line} 行）：${msg}`);
  }
  ws(nl: boolean): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || (nl && c === '\n')) this.i++;
      else if (c === '#') { while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++; }
      else return;
    }
  }
  key(): string {
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.str();
    const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
    if (!m) this.err('期望 key');
    this.i += m[0].length;
    return m[0];
  }
  dottedKey(): string[] {
    const ks = [this.key()];
    for (;;) {
      this.ws(false);
      if (this.s[this.i] !== '.') return ks;
      this.i++;
      this.ws(false);
      ks.push(this.key());
    }
  }
  str(): string {
    const q = this.s[this.i]!;
    if (this.s.startsWith(q.repeat(3), this.i)) {
      const end = this.s.indexOf(q.repeat(3), this.i + 3);
      if (end < 0) this.err('未闭合的多行字符串');
      let body = this.s.slice(this.i + 3, end);
      this.i = end + 3;
      if (body.startsWith('\n')) body = body.slice(1);
      return q === '"' ? this.unesc(body) : body;
    }
    let j = this.i + 1;
    while (j < this.s.length && this.s[j] !== q) {
      if (this.s[j] === '\n') this.err('字符串内换行');
      j += q === '"' && this.s[j] === '\\' ? 2 : 1;
    }
    const body = this.s.slice(this.i + 1, j);
    this.i = j + 1;
    return q === '"' ? this.unesc(body) : body;
  }
  unesc(b: string): string {
    return b.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
      if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
      return ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e;
    });
  }
  value(): TomlValue {
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.str();
    if (c === '[') {
      this.i++;
      const arr: TomlValue[] = [];
      for (;;) {
        this.ws(true);
        if (this.s[this.i] === ']') { this.i++; return arr; }
        arr.push(this.value());
        this.ws(true);
        if (this.s[this.i] === ',') { this.i++; continue; }
        if (this.s[this.i] === ']') { this.i++; return arr; }
        this.err('数组语法');
      }
    }
    if (c === '{') {
      this.i++;
      const t: TomlTable = {};
      for (;;) {
        this.ws(false);
        if (this.s[this.i] === '}') { this.i++; return t; }
        const ks = this.dottedKey();
        this.ws(false);
        if (this.s[this.i] !== '=') this.err('内联表期望 =');
        this.i++;
        this.ws(false);
        setPath(t, ks, this.value(), this);
        this.ws(false);
        if (this.s[this.i] === ',') { this.i++; continue; }
        if (this.s[this.i] === '}') { this.i++; return t; }
        this.err('内联表语法');
      }
    }
    const m = /^(true|false|[+-]?[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)/.exec(this.s.slice(this.i));
    if (!m) this.err('不支持的值');
    this.i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    return Number(m[0].replace(/_/g, ''));
  }
}

function setPath(root: TomlTable, ks: string[], v: TomlValue, p: P): void {
  let t = root;
  for (const k of ks.slice(0, -1)) {
    const n = t[k];
    if (n === undefined) t = (t[k] = {}) as TomlTable;
    else if (typeof n === 'object' && !Array.isArray(n)) t = n;
    else p.err(`key ${k} 不是表`);
  }
  t[ks[ks.length - 1]!] = v;
}

export function parseToml(src: string): TomlTable {
  const p = new P(src);
  const root: TomlTable = {};
  let cur = root;
  for (;;) {
    p.ws(true);
    if (p.i >= src.length) return root;
    if (src[p.i] === '[') {
      const arr = src[p.i + 1] === '[';
      p.i += arr ? 2 : 1;
      p.ws(false);
      const ks = p.dottedKey();
      p.ws(false);
      if (!src.startsWith(arr ? ']]' : ']', p.i)) p.err('表头语法');
      p.i += arr ? 2 : 1;
      let t = root;
      for (const [idx, k] of ks.entries()) {
        const last = idx === ks.length - 1;
        if (last && arr) {
          const a = (t[k] ??= []) as TomlValue[];
          const nt: TomlTable = {};
          a.push(nt);
          t = nt;
        } else {
          let n = t[k];
          if (Array.isArray(n)) n = n[n.length - 1];
          if (n === undefined) { n = {}; t[k] = n; }
          t = n as TomlTable;
        }
      }
      cur = t;
      continue;
    }
    const ks = p.dottedKey();
    p.ws(false);
    if (src[p.i] !== '=') p.err('期望 =');
    p.i++;
    p.ws(false);
    setPath(cur, ks, p.value(), p);
  }
}
