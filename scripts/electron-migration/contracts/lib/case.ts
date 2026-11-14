// 命名转换：Tauri 参数键（heck 0.5）与 serde rename_all 规则（serde_derive 1.0.228）。
//
// - heck：`~/.cargo/registry/src/*/heck-0.5.0/src/lib.rs` 的 `transform`/`lowercase`/`capitalize`，
//   `lower_camel.rs`、`snake.rs`。tauri-macros 2.6.3 依赖 heck 0.5（Cargo.lock 中 tauri-macros →
//   "heck 0.5.0"），在 `src/command/wrapper.rs` 的 `parse_arg` 里对参数名调用
//   `to_lower_camel_case()`（默认）或 `to_snake_case()`（`rename_all = "snake_case"`）。
// - serde：`serde_derive-1.0.228/src/internals/case.rs` 的 `apply_to_variant` / `apply_to_field`。

const isLower = (c: string): boolean => /\p{Lowercase}/u.test(c);
const isUpper = (c: string): boolean => /\p{Uppercase}/u.test(c);
const isAlnum = (c: string): boolean => /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u.test(c);

/** heck::transform 的逐字移植：按 Unicode 字母数字切分，再按大小写边界切词。 */
function heckWords(s: string): string[] {
  const out: string[] = [];
  const chars = [...s];
  const words: string[][] = [];
  let cur: string[] = [];
  for (const c of chars) {
    if (!isAlnum(c)) { words.push(cur); cur = []; } else cur.push(c);
  }
  words.push(cur);
  for (const word of words) {
    let init = 0;
    let mode: 'b' | 'l' | 'u' = 'b';
    for (let i = 0; i < word.length; i++) {
      const c = word[i]!;
      if (i + 1 < word.length) {
        const next = word[i + 1]!;
        const nextMode: 'b' | 'l' | 'u' = isLower(c) ? 'l' : isUpper(c) ? 'u' : mode;
        if (nextMode === 'l' && isUpper(next)) {
          out.push(word.slice(init, i + 1).join(''));
          init = i + 1;
          mode = 'b';
        } else if (mode === 'u' && isUpper(c) && isLower(next)) {
          out.push(word.slice(init, i).join(''));
          init = i;
          mode = 'b';
        } else {
          mode = nextMode;
        }
      } else {
        out.push(word.slice(init).join(''));
        break;
      }
    }
  }
  return out;
}

/** heck::lowercase：末尾 'Σ' 变 'ς'，其余 char::to_lowercase。 */
function heckLower(s: string): string {
  const cs = [...s];
  return cs.map((c, i) => (c === 'Σ' && i === cs.length - 1 ? 'ς' : c.toLowerCase())).join('');
}

function heckCapitalize(s: string): string {
  const cs = [...s];
  if (!cs.length) return '';
  return cs[0]!.toUpperCase() + heckLower(cs.slice(1).join(''));
}

export function heckLowerCamel(s: string): string {
  return heckWords(s).map((w, i) => (i === 0 ? heckLower(w) : heckCapitalize(w))).join('');
}

export function heckSnake(s: string): string {
  return heckWords(s).map(heckLower).join('_');
}

export type SerdeRenameRule =
  | 'lowercase' | 'UPPERCASE' | 'PascalCase' | 'camelCase' | 'snake_case'
  | 'SCREAMING_SNAKE_CASE' | 'kebab-case' | 'SCREAMING-KEBAB-CASE';

export const SERDE_RULES: readonly SerdeRenameRule[] = [
  'lowercase', 'UPPERCASE', 'PascalCase', 'camelCase', 'snake_case',
  'SCREAMING_SNAKE_CASE', 'kebab-case', 'SCREAMING-KEBAB-CASE',
];

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** serde_derive case.rs `RenameRule::apply_to_variant`。 */
export function applyToVariant(rule: SerdeRenameRule | null, v: string): string {
  switch (rule) {
    case null: case 'PascalCase': return v;
    case 'lowercase': return asciiLower(v);
    case 'UPPERCASE': return asciiUpper(v);
    case 'camelCase': return asciiLower(v.slice(0, 1)) + v.slice(1);
    case 'snake_case': {
      let s = '';
      let i = 0;
      for (const ch of v) {
        if (i > 0 && isUpper(ch)) s += '_';
        s += asciiLower(ch);
        i += ch.length;
      }
      return s;
    }
    case 'SCREAMING_SNAKE_CASE': return asciiUpper(applyToVariant('snake_case', v));
    case 'kebab-case': return applyToVariant('snake_case', v).replace(/_/g, '-');
    case 'SCREAMING-KEBAB-CASE': return applyToVariant('SCREAMING_SNAKE_CASE', v).replace(/_/g, '-');
  }
}

/** serde_derive case.rs `RenameRule::apply_to_field`。 */
export function applyToField(rule: SerdeRenameRule | null, f: string): string {
  switch (rule) {
    case null: case 'lowercase': case 'snake_case': return f;
    case 'UPPERCASE': return asciiUpper(f);
    case 'PascalCase': {
      let s = '';
      let cap = true;
      for (const ch of f) {
        if (ch === '_') cap = true;
        else if (cap) { s += asciiUpper(ch); cap = false; } else s += ch;
      }
      return s;
    }
    case 'camelCase': {
      const p = applyToField('PascalCase', f);
      return asciiLower(p.slice(0, 1)) + p.slice(1);
    }
    case 'SCREAMING_SNAKE_CASE': return asciiUpper(f);
    case 'kebab-case': return f.replace(/_/g, '-');
    case 'SCREAMING-KEBAB-CASE': return applyToField('SCREAMING_SNAKE_CASE', f).replace(/_/g, '-');
  }
}
