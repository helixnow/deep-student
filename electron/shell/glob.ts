/**
 * glob 0.3 `Pattern` 的逐算法移植（glob-0.3.3 `src/lib.rs` `Pattern::new` / `matches_from`），
 * 用于 Tauri 的 fs / asset 作用域匹配。Tauri 使用的匹配选项为
 * `require_literal_separator: true`，`require_literal_leading_dot` 在 Unix 默认 true、Windows 默认 false，
 * `case_sensitive: true`（tauri-2.11.5 `src/scope/fs.rs`）。
 */

type CharSpecifier = { kind: 'single'; c: string } | { kind: 'range'; lo: string; hi: string };
type Token =
  | { kind: 'char'; c: string }
  | { kind: 'any-char' }
  | { kind: 'any-seq' }
  | { kind: 'any-recursive' }
  | { kind: 'within'; specs: CharSpecifier[] }
  | { kind: 'except'; specs: CharSpecifier[] };

export interface MatchOptions {
  requireLiteralSeparator: boolean;
  requireLiteralLeadingDot: boolean;
  /** Windows 上分隔符为 `/` 与 `\`。 */
  windows: boolean;
}

export class GlobPatternError extends Error {
  readonly pos: number;
  constructor(pos: number, msg: string) {
    super(`Pattern syntax error near position ${pos}: ${msg}`);
    this.name = 'GlobPatternError';
    this.pos = pos;
  }
}

const MATCH = 0;
const SUB_NO_MATCH = 1;
const ENTIRE_NO_MATCH = 2;
type MatchResult = typeof MATCH | typeof SUB_NO_MATCH | typeof ENTIRE_NO_MATCH;

function isSep(c: string, windows: boolean): boolean {
  return c === '/' || (windows && c === '\\');
}

function parseSpecifiers(chars: string[]): CharSpecifier[] {
  const out: CharSpecifier[] = [];
  let i = 0;
  while (i < chars.length) {
    if (i + 3 <= chars.length && chars[i + 1] === '-') {
      out.push({ kind: 'range', lo: chars[i] as string, hi: chars[i + 2] as string });
      i += 3;
    } else {
      out.push({ kind: 'single', c: chars[i] as string });
      i += 1;
    }
  }
  return out;
}

function inSpecifiers(specs: CharSpecifier[], c: string): boolean {
  for (const spec of specs) {
    if (spec.kind === 'single') {
      if (spec.c === c) return true;
    } else if (spec.lo <= c && c <= spec.hi) {
      return true;
    }
  }
  return false;
}

export class GlobPattern {
  readonly original: string;
  private readonly tokens: Token[];
  private readonly windows: boolean;

  constructor(pattern: string, windows: boolean) {
    this.original = pattern;
    this.windows = windows;
    const chars = Array.from(pattern);
    const tokens: Token[] = [];
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i] as string;
      if (ch === '?') {
        tokens.push({ kind: 'any-char' });
        i += 1;
      } else if (ch === '*') {
        const old = i;
        while (i < chars.length && chars[i] === '*') i += 1;
        const count = i - old;
        if (count > 2) throw new GlobPatternError(old + 2, 'wildcards are either regular `*` or recursive `**`');
        if (count === 2) {
          if (i === 2 || isSep(chars[i - count - 1] as string, windows)) {
            if (i < chars.length && isSep(chars[i] as string, windows)) {
              i += 1;
            } else if (i !== chars.length) {
              throw new GlobPatternError(i, 'recursive wildcards must form a single path component');
            }
          } else {
            throw new GlobPatternError(old - 1, 'recursive wildcards must form a single path component');
          }
          const last = tokens[tokens.length - 1];
          if (!(tokens.length > 1 && last !== undefined && last.kind === 'any-recursive')) {
            tokens.push({ kind: 'any-recursive' });
          }
        } else {
          tokens.push({ kind: 'any-seq' });
        }
      } else if (ch === '[') {
        if (i + 4 <= chars.length && chars[i + 1] === '!') {
          const j = chars.slice(i + 3).indexOf(']');
          if (j >= 0) {
            tokens.push({ kind: 'except', specs: parseSpecifiers(chars.slice(i + 2, i + 3 + j)) });
            i += j + 4;
            continue;
          }
        } else if (i + 3 <= chars.length && chars[i + 1] !== '!') {
          const j = chars.slice(i + 2).indexOf(']');
          if (j >= 0) {
            tokens.push({ kind: 'within', specs: parseSpecifiers(chars.slice(i + 1, i + 2 + j)) });
            i += j + 3;
            continue;
          }
        }
        throw new GlobPatternError(i, 'invalid range pattern');
      } else {
        tokens.push({ kind: 'char', c: ch });
        i += 1;
      }
    }
    this.tokens = tokens;
  }

  /** glob `Pattern::escape`。 */
  static escape(s: string): string {
    let out = '';
    for (const c of s) out += c === '?' || c === '*' || c === '[' || c === ']' ? `[${c}]` : c;
    return out;
  }

  matches(str: string, options: MatchOptions): boolean {
    return this.matchesFrom(true, Array.from(str), 0, 0, options) === MATCH;
  }

  private matchesFrom(followsSepIn: boolean, file: string[], fi: number, ti: number, options: MatchOptions): MatchResult {
    let followsSep = followsSepIn;
    let pos = fi;
    for (let k = ti; k < this.tokens.length; k++) {
      const token = this.tokens[k] as Token;
      if (token.kind === 'any-seq' || token.kind === 'any-recursive') {
        const empty = this.matchesFrom(followsSep, file, pos, k + 1, options);
        if (empty !== SUB_NO_MATCH) return empty;
        while (pos < file.length) {
          const c = file[pos] as string;
          pos += 1;
          if (followsSep && options.requireLiteralLeadingDot && c === '.') return SUB_NO_MATCH;
          followsSep = isSep(c, this.windows);
          if (token.kind === 'any-recursive' && !followsSep) continue;
          if (token.kind === 'any-seq' && options.requireLiteralSeparator && followsSep) return SUB_NO_MATCH;
          const m = this.matchesFrom(followsSep, file, pos, k + 1, options);
          if (m !== SUB_NO_MATCH) return m;
        }
        // 与 Rust 实现一致：耗尽输入仍未匹配时落到循环之后的"输入是否耗尽"判断。
        continue;
      }
      if (pos >= file.length) return ENTIRE_NO_MATCH;
      const c = file[pos] as string;
      pos += 1;
      const sep = isSep(c, this.windows);
      let ok: boolean;
      if (
        (token.kind === 'any-char' || token.kind === 'within' || token.kind === 'except') &&
        ((options.requireLiteralSeparator && sep) || (followsSep && options.requireLiteralLeadingDot && c === '.'))
      ) {
        ok = false;
      } else if (token.kind === 'any-char') {
        ok = true;
      } else if (token.kind === 'within') {
        ok = inSpecifiers(token.specs, c);
      } else if (token.kind === 'except') {
        ok = !inSpecifiers(token.specs, c);
      } else if (token.kind === 'char') {
        ok = c === token.c || (this.windows && sep && isSep(token.c, true));
      } else {
        ok = false;
      }
      if (!ok) return SUB_NO_MATCH;
      followsSep = sep;
    }
    return pos >= file.length ? MATCH : SUB_NO_MATCH;
  }
}
