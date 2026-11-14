// Static Rust scan: Serialize types (field order, serde attrs, risky field types) and SQL writes
// whose bound value is produced by serde_json. Heuristic; every result carries a confidence.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRustParser } from '../../electron-migration/contracts/lib/ts.ts';
import { applyToField } from '../../electron-migration/contracts/lib/case.ts';
import { parseSqlWrite } from './sql.mjs';

export const RUST_ROOTS = ['src-tauri/src', 'src-tauri/crates'];

export function rustFiles(root) {
  return execFileSync('git', ['ls-files', ...RUST_ROOTS], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.rs') && !f.includes('/dstu-differential/') && !/\/tests?\//.test(f) && !f.endsWith('_tests.rs') && !f.endsWith('/tests.rs'));
}

const precedingAttrs = (node) => {
  const attrs = [];
  let prev = node.previousNamedSibling;
  while (prev && ['attribute_item', 'line_comment', 'block_comment'].includes(prev.type)) {
    if (prev.type === 'attribute_item') attrs.unshift(prev.text);
    prev = prev.previousNamedSibling;
  }
  return attrs;
};

const serdeArgs = (attrs) => attrs.filter((a) => /^#\[serde\(/.test(a)).map((a) => a.slice(8, -2)).join(', ');
const attrValue = (serde, key) => new RegExp(String.raw`\b${key}\s*=\s*"([^"]*)"`).exec(serde)?.[1];
const hasFlag = (serde, key) => new RegExp(String.raw`(?:^|[,\s(])${key}(?:\s*[,)]|\s*$)`).test(serde);
const isTestCfg = (attrs) => attrs.some((a) => /#\[(?:cfg\((?:all\()?test\b|(?:tokio::)?test\b)/.test(a));
const inTestCode = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (['function_item', 'mod_item', 'impl_item'].includes(n.type) && isTestCfg(precedingAttrs(n))) return true;
  }
  return false;
};

/** @returns {{types: Map<string, object[]>, files: number}} */
export async function scanRustTypes(root, files = rustFiles(root), read = (f) => fs.readFileSync(path.join(root, f), "utf8")) {
  const parser = await loadRustParser();
  const types = new Map();
  for (const file of files) {
    const source = read(file);
    if (!source.includes('Serialize')) continue;
    const crate = /src-tauri\/crates\/([^/]+)/.exec(file)?.[1] ?? 'app';
    const tree = parser.parse(source);
    try {
      for (const node of tree.rootNode.descendantsOfType(['struct_item', 'enum_item'])) {
        const attrs = precedingAttrs(node);
        if (!attrs.some((a) => /derive\([^)]*\bSerialize\b/.test(a)) || isTestCfg(attrs) || inTestCode(node)) continue;
        const serde = serdeArgs(attrs);
        const decl = {
          name: node.childForFieldName('name').text, kind: node.type === 'struct_item' ? 'struct' : 'enum', crate,
          file, line: node.startPosition.row + 1,
          renameAll: attrValue(serde, 'rename_all') ?? null,
          tag: attrValue(serde, 'tag') ?? null, content: attrValue(serde, 'content') ?? null,
          untagged: hasFlag(serde, 'untagged'), transparent: hasFlag(serde, 'transparent'),
          fields: [], variants: [],
        };
        const body = node.childForFieldName('body');
        if (decl.kind === 'struct' && body?.type === 'field_declaration_list') {
          for (const f of body.namedChildren.filter((c) => c.type === 'field_declaration')) {
            const fa = serdeArgs(precedingAttrs(f));
            if (hasFlag(fa, 'skip') || hasFlag(fa, 'skip_serializing')) continue;
            const name = f.childForFieldName('name').text.replace(/^r#/, '');
            decl.fields.push({
              name, wire: attrValue(fa, 'rename') ?? applyToField(decl.renameAll, name),
              type: f.childForFieldName('type').text.replace(/\s+/g, ' '), line: f.startPosition.row + 1,
              skipIf: attrValue(fa, 'skip_serializing_if') ?? null, flatten: hasFlag(fa, 'flatten'),
              with: attrValue(fa, 'with') ?? attrValue(fa, 'serialize_with') ?? null,
            });
          }
        } else if (decl.kind === 'struct' && body?.type === 'ordered_field_declaration_list') {
          decl.tuple = body.namedChildren.filter((c) => c.type !== 'attribute_item').map((c) => c.text);
        } else if (decl.kind === 'enum' && body) {
          for (const v of body.namedChildren.filter((c) => c.type === 'enum_variant')) {
            decl.variants.push({ name: v.childForFieldName('name').text, payload: v.childForFieldName('body')?.text ?? null });
          }
        }
        const list = types.get(decl.name) ?? [];
        list.push(decl);
        types.set(decl.name, list);
      }
    } finally {
      tree.delete();
    }
  }
  return { types, files: files.length };
}

const WORD = /[A-Za-z_]\w*/g;
const CHRONO = /\b(?:DateTime|NaiveDateTime|NaiveDate|NaiveTime)\b/;
const BIG_INT = /\b(?:u64|i64|usize|isize|u128|i128)\b/;

/**
 * Risky serde features reachable from `typeName`, with example wire paths.
 * Keys: f64, f32, option-null, option-omit, skip-default, hashmap, btreemap, value, bigint, chrono, enum-repr, struct.
 */
export function typeFeatures(types, typeName, { crate } = {}, depth = 0, seen = new Set(), prefix = '') {
  const out = new Map();
  const add = (k, p) => { const l = out.get(k) ?? []; if (l.length < 6) l.push(p || '$'); out.set(k, l); };
  const merge = (other) => { for (const [k, ps] of other) for (const p of ps) add(k, p); };
  const decls = types.get(typeName) ?? [];
  const decl = decls.find((d) => d.crate === crate) ?? decls[0];
  if (!decl || seen.has(decl) || depth > 8) return out;
  seen.add(decl);
  const typeText = (t, at) => {
    if (/\bf64\b/.test(t)) add('f64', at);
    if (/\bf32\b/.test(t)) add('f32', at);
    if (BIG_INT.test(t)) add('bigint', at);
    if (/\b(?:HashMap|HashSet)\b/.test(t)) add('hashmap', at);
    if (/\bBTreeMap\b/.test(t)) add('btreemap', at);
    if (/\bValue\b/.test(t) || /serde_json::Map\b/.test(t)) add('value', at);
    if (CHRONO.test(t)) add('chrono', at);
    for (const w of t.match(WORD) ?? []) {
      if (w !== typeName && types.has(w)) {
        const sub = typeFeatures(types, w, { crate: decl.crate }, depth + 1, seen, at);
        merge(sub);
      }
    }
  };
  if (decl.kind === 'struct') {
    add('struct', prefix || '$');
    for (const f of decl.fields) {
      const at = f.flatten ? prefix : `${prefix}.${f.wire}`;
      if (/^Option\s*</.test(f.type)) add(f.skipIf && /is_none/.test(f.skipIf) ? 'option-omit' : 'option-null', at);
      else if (f.skipIf) add('skip-default', at);
      if (f.with) add('serde-with', at);
      typeText(f.type, /^(?:Option\s*<\s*)?(?:Vec|HashSet|BTreeSet)\s*</.test(f.type) ? `${at}[]` : at);
    }
    for (const t of decl.tuple ?? []) typeText(t, prefix);
  } else {
    if (decl.tag || decl.untagged || decl.content) add('enum-repr', prefix || '$');
    for (const v of decl.variants) if (v.payload) typeText(v.payload, `${prefix}.${v.name}`);
  }
  return out;
}

// ---------------- SQL writes ----------------

const unescapeRust = (lit) => {
  const raw = /^r(#*)"([\s\S]*)"\1$/.exec(lit);
  if (raw) return raw[2];
  const m = /^b?"([\s\S]*)"$/.exec(lit);
  if (!m) return undefined;
  return m[1].replace(/\\\r?\n\s*/g, '').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
};

/** Splits `a, b(c, d), [e]` at top-level commas. */
export function splitArgs(text) {
  const parts = [];
  let depth = 0, start = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"') quote = c;
    else if ('([{<'.includes(c) && !(c === '<' && text[i + 1] === '=')) depth += c === '<' ? 0 : 1;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const enclosing = (node, types) => {
  for (let n = node.parent; n; n = n.parent) if (types.includes(n.type)) return n;
  return null;
};

/** Params expression for the SQL literal (or the variable holding it). */
function paramsFor(lit, fn) {
  const holder = (() => {
    const decl = enclosing(lit, ['let_declaration', 'const_item', 'static_item']);
    const pat = decl?.childForFieldName('pattern') ?? decl?.childForFieldName('name');
    return pat?.type === 'identifier' ? pat.text : null;
  })();
  const calls = [];
  const directCall = enclosing(lit, ['call_expression']);
  if (directCall) calls.push({ call: directCall, needle: lit });
  if (holder && fn) {
    for (const id of fn.descendantsOfType('identifier')) {
      if (id.text === holder && id.startIndex > lit.endIndex) {
        const call = enclosing(id, ['call_expression']);
        if (call) calls.push({ call, needle: id });
      }
    }
  }
  for (const { call, needle } of calls) {
    const args = call.childForFieldName('arguments');
    if (!args) continue;
    const list = args.namedChildren;
    const idx = list.findIndex((a) => a.startIndex <= needle.startIndex && a.endIndex >= needle.endIndex);
    if (idx < 0) continue;
    const callee = call.childForFieldName('function')?.text ?? '';
    if (/\b(?:prepare|prepare_cached)$/.test(callee)) {
      const stmtDecl = enclosing(call, ['let_declaration']);
      const stmt = stmtDecl?.childForFieldName('pattern')?.text.replace(/^mut\s+/, '');
      if (!stmt || !fn) continue;
      for (const c of fn.descendantsOfType('call_expression')) {
        const f = c.childForFieldName('function')?.text ?? '';
        if (c.startIndex > call.endIndex && new RegExp(`^${stmt}\\.(?:execute|insert|query_row|query_map|query)$`).test(f)) {
          const a = c.childForFieldName('arguments')?.namedChildren[0];
          if (a) return { node: a, callLine: c.startPosition.row + 1 };
        }
      }
      continue;
    }
    if (list[idx + 1]) return { node: list[idx + 1], callLine: call.startPosition.row + 1 };
  }
  return undefined;
}

function paramElements(node) {
  if (!node) return undefined;
  let text = node.text.trim().replace(/^&/, '');
  const mac = /^(?:rusqlite::)?(named_params|params)!\s*[[({]([\s\S]*)[\])}]$/.exec(text);
  if (mac) {
    const parts = splitArgs(mac[2]);
    if (mac[1] === 'named_params') {
      return { named: Object.fromEntries(parts.map((p) => /^"[:@$]?(\w+)"\s*:\s*([\s\S]+)$/.exec(p)).filter(Boolean).map((m) => [m[1], m[2]])) };
    }
    return { positional: parts };
  }
  if (/^\[[\s\S]*\]$/.test(text) || /^\([\s\S]*\)$/.test(text)) return { positional: splitArgs(text.slice(1, -1)).map((p) => p.replace(/\s+as\s+&dyn\s+[\w:]+$/, '')) };
  return undefined;
}

/** `serde_json::to_string(&x)` etc. with balanced parentheses: `{kind, arg}`. */
function serializeCall(text) {
  const m = /serde_json::to_(string_pretty|string|vec|value)\s*\(/.exec(text);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  const start = i;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  if (depth !== 0) return null;
  return [m[0], m[1], text.slice(start, i - 1).trim().replace(/^&\s*/, '')];
}
const SERIALIZE_CALL = { exec: serializeCall };

/** Follows `ident` → `let ident = …` up to 3 levels inside the function text before `before`. */
export function resolveJsonSource(expr, fnText, depth = 0) {
  const e = expr.trim().replace(/^&\s*/, '').replace(/(?:\.(?:as_deref|as_str|as_ref|clone)\(\)|\?)+$/, '');
  const ser = SERIALIZE_CALL.exec(e);
  if (ser) return { how: ser[1] === 'string_pretty' ? 'to_string_pretty' : `to_${ser[1]}`, value: ser[2].replace(/\.as_ref\(\)$/, '') };
  if (/\bjson!\s*[({[]/.test(e)) return { how: 'json!', value: null };
  if (/^[a-z_]\w*\.to_string\(\)$/.test(e)) {
    const v = e.slice(0, -'.to_string()'.length);
    const def = letInit(fnText, v);
    if (def && /\bjson!|serde_json::(?:Value|Map|json)|to_value\(/.test(def.init + (def.type ?? ''))) return { how: 'Value::to_string', value: v, valueType: def.type ?? 'serde_json::Value' };
  }
  if (depth < 3 && /^[a-z_]\w*$/.test(e)) {
    const def = letInit(fnText, e);
    if (def) {
      const inner = resolveJsonSource(def.init, fnText, depth + 1);
      if (inner) return inner;
      const mapped = SERIALIZE_CALL.exec(def.init);
      if (mapped) return { how: 'to_string', value: mapped[2] };
    }
  }
  const nested = SERIALIZE_CALL.exec(e.replace(/^Some\(|\)$/g, ''));
  if (nested) return { how: 'to_string', value: nested[2] };
  return undefined;
}

function letInit(fnText, name) {
  const re = new RegExp(String.raw`\blet\s+(?:mut\s+)?${name}\s*(?::\s*([^=;]+?))?\s*=\s*([\s\S]*?);\s*(?:\n|$)`, 'g');
  let m, last;
  while ((m = re.exec(fnText))) last = m;
  return last ? { type: last[1]?.trim(), init: last[2] } : undefined;
}

/** Best-effort static type text of the serialized expression (containers kept). */
export function resolveValueType(value, fnText, types) {
  if (!value) return undefined;
  const v = value.trim().replace(/^&\s*/, '').replace(/^\*/, '').replace(/\.(?:clone|as_ref)\(\)$/, '');
  const strip = (t) => t.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '').replace(/\s+/g, ' ').trim();
  const ctor = /^([A-Z]\w*)\s*(?:\{|::)/.exec(v);
  if (ctor) return ctor[1];
  const ident = /^[a-z_]\w*$/.test(v) ? v : undefined;
  if (ident) {
    const param = paramType(fnText, ident);
    const def = letInit(fnText, ident);
    if (def?.type) return strip(def.type);
    if (def) {
      const turbofish = /from_str::<\s*([\w:<>, ]+)\s*>/.exec(def.init) ?? /^([A-Z]\w*)\s*(?:\{|::)/.exec(def.init.trim());
      if (turbofish) return strip(turbofish[1]);
      const field = /^&?\s*([a-z_]\w*)\.([a-z_]\w*)\s*(?:\.clone\(\))?$/.exec(def.init.trim());
      if (field) return fieldType(field[1], field[2], fnText, types, strip);
    }
    if (param) return strip(param);
    return undefined;
  }
  const field = /^([a-z_]\w*)\.([a-z_]\w*)$/.exec(v);
  if (field) return fieldType(field[1], field[2], fnText, types, strip);
  return undefined;
}

/** `name: Type` in a signature or closure, read up to the top-level `,` / `)` / `|` / `=`. */
function paramType(fnText, name) {
  const m = new RegExp(String.raw`(?:[(,|]\s*|\blet\s+(?:mut\s+)?)${name}\s*:\s*`).exec(fnText);
  if (!m) return undefined;
  let depth = 0, i = m.index + m[0].length;
  const start = i;
  for (; i < fnText.length; i++) {
    const c = fnText[i];
    if (c === '<' || c === '(' || c === '[') depth++;
    else if ((c === '>' && fnText[i - 1] !== '-') || c === ')' || c === ']') { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ',' || c === '|' || c === '=' || c === ';' || c === '{')) break;
  }
  const text = fnText.slice(start, i).trim();
  return text || undefined;
}

function fieldType(owner, field, fnText, types, strip) {
  const ownerType = resolveValueType(owner, fnText, types);
  const decl = types.get(namedType(types, ownerType) ?? '')?.[0];
  const f = decl?.fields.find((x) => x.name === field);
  return f ? strip(f.type) : undefined;
}

const WRAPPERS = new Set(['Option', 'Vec', 'Box', 'Arc', 'Rc', 'mut', 'dyn', 'impl', 'crate', 'super', 'self', 'std', 'collections', 'serde_json', 'String', 'str']);
/** The innermost known Serialize type named in a type text, else its last path segment. */
export function namedType(types, text) {
  if (!text) return undefined;
  const ids = (text.match(WORD) ?? []).filter((w) => !WRAPPERS.has(w));
  return [...ids].reverse().find((w) => types.has(w)) ?? ids[ids.length - 1];
}

/** Features of a type text (`HashMap<String, Rule>`, `Vec<f64>`, `ProcessingProgress`). */
export function typeTextFeatures(types, text, crate) {
  if (!text) return new Map();
  const wrapper = `__Root${text.length}`;
  const scratch = new Map(types);
  scratch.set(wrapper, [{ name: wrapper, kind: 'struct', crate, fields: [{ name: '', wire: '', type: text, flatten: true, skipIf: null, with: null }], variants: [] }]);
  const out = typeFeatures(scratch, wrapper, { crate });
  const struct = out.get('struct')?.filter((p) => p !== '$');
  if (struct?.length) out.set('struct', struct); else out.delete('struct');
  if (types.has(namedType(types, text)) && types.get(namedType(types, text))[0].kind === 'struct') out.set('struct', ['$', ...(struct ?? [])]);
  return out;
}

/** fn name → distinct return type texts (Result/Option-unwrapped; `Self` resolved from `impl X`). */
export function returnTypeIndex(root, files, read = (f) => fs.readFileSync(path.join(root, f), "utf8")) {
  const index = new Map();
  for (const file of files) {
    const source = read(file);
    const impls = [...source.matchAll(/^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Z]\w*)/gm)].map((m) => ({ at: m.index, name: m[1] }));
    for (const m of source.matchAll(/\bfn\s+(\w+)\s*(?:<[^>{]*>)?\s*\(([^)]*)\)\s*->\s*([^{;]+?)\s*(?:where\b|\{)/g)) {
      let ret = m[3].trim().replace(/^(?:anyhow::|std::result::|crate::\w+::)?Result\s*<\s*([\s\S]+?)(?:,[^,<>]+)?\s*>$/, '$1').trim();
      if (/\bSelf\b/.test(ret)) {
        const owner = impls.filter((x) => x.at < m.index).pop()?.name;
        if (!owner) continue;
        ret = ret.replace(/\bSelf\b/g, owner);
      }
      const set = index.get(m[1]) ?? new Set();
      set.add(ret.replace(/\s+/g, ' '));
      index.set(m[1], set);
    }
  }
  return index;
}

const callReturn = (value, fnIndex) => {
  const m = /(?:^|\.|::)(\w+)\s*\([^()]*\)$/.exec(value ?? '');
  const set = m ? fnIndex.get(m[1]) : undefined;
  return set?.size === 1 ? [...set][0] : undefined;
};

/** SQL writes whose parameter comes from serde_json. */
export async function scanRustWrites(root, types, files = rustFiles(root), read = (f) => fs.readFileSync(path.join(root, f), "utf8")) {
  const parser = await loadRustParser();
  const fnIndex = returnTypeIndex(root, files, read);
  const writes = [];
  for (const file of files) {
    const source = read(file);
    if (!/\b(?:INSERT|UPDATE|REPLACE)\b/i.test(source)) continue;
    const crate = /src-tauri\/crates\/([^/]+)/.exec(file)?.[1] ?? 'app';
    const tree = parser.parse(source);
    try {
      for (const lit of tree.rootNode.descendantsOfType(['string_literal', 'raw_string_literal'])) {
        const sql = unescapeRust(lit.text);
        if (!sql || !/^\s*(?:INSERT|REPLACE|UPDATE)\b/i.test(sql)) continue;
        const parsed = parseSqlWrite(sql);
        if (!parsed || /[{}]/.test(parsed.table)) continue;
        const fn = enclosing(lit, ['function_item']);
        if (inTestCode(lit)) continue;
        const fnText = fn?.text ?? '';
        const params = paramElements(paramsFor(lit, fn)?.node);
        for (const col of parsed.columns) {
          let expr;
          if (col.param?.index !== undefined) expr = params?.positional?.[col.param.index - 1];
          else if (col.param?.name !== undefined) expr = params?.named?.[col.param.name];
          const literalJson = !col.param && /^'[[{]/.test(col.expr) && !/^'(?:\{\}|\[\])'$/.test(col.expr) ? col.expr : undefined;
          const source = expr ? resolveJsonSource(expr, fnText) : undefined;
          if (!source && !literalJson) {
            if (/_json$|^(?:metadata|config|data|payload|progress|settings|value)$/.test(col.column) && expr && /json|serde/i.test(expr)) {
              writes.push({ file, line: lit.startPosition.row + 1, crate, table: parsed.table, column: col.column, expr, how: 'unresolved', valueType: null, confidence: 'low' });
            }
            continue;
          }
          const typeText = source?.valueType ?? resolveValueType(source?.value, fnText, types) ?? callReturn(source?.value, fnIndex);
          const known = typeText && types.has(namedType(types, typeText)) ? namedType(types, typeText) : null;
          writes.push({
            file, line: lit.startPosition.row + 1, crate, table: parsed.table, column: col.column,
            fn: fn?.childForFieldName('name')?.text ?? null,
            expr: expr ?? literalJson, how: literalJson ? 'sql-literal' : source.how, value: source?.value ?? null,
            valueType: known, valueTypeText: typeText ?? null,
            confidence: known || /\bValue\b/.test(typeText ?? '') || source?.how === 'json!' ? 'high' : source ? 'medium' : 'low',
          });
        }
      }
    } finally {
      tree.delete();
    }
  }
  return writes;
}
