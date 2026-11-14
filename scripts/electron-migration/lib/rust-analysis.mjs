// Rust 源码静态分析（tree-sitter-rust，不编译）：测试、事件发送点、条目定义、use 与限定路径引用、
// 模块树与 `pub use` 重导出解析。scaffold / services-draft / ledger 共用。
import path from 'node:path';
import { rustParser } from './tree-sitter-rust.mjs';
import { laneOfFile, listRustFiles, loadInventoryRules, readRustSources } from './inventory-rules.mjs';

/** 与 inventory.mjs 相同的测试属性计数正则（8036 的来源）。 */
export const TEST_ATTR_RE = /#\[(tokio::)?test\b/g;

const COMMENT_TYPES = new Set(['line_comment', 'block_comment', 'doc_comment']);
const STRING_TYPES = new Set(['string_literal', 'raw_string_literal', 'char_literal', 'string_content']);
const ITEM_KINDS = {
  function_item: 'fn',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  type_item: 'type',
  const_item: 'const',
  static_item: 'static',
  union_item: 'union',
};
const EMIT_METHODS = new Set(['emit', 'emit_to', 'emit_filter', 'emit_str', 'emit_str_to']);
/** 后端监听前端事件（只认字符串字面量事件名，避免与其它 `listen` 方法混淆）。 */
const LISTEN_METHODS = new Set(['listen', 'listen_any', 'once', 'once_any']);

function lineOf(node) {
  return node.startPosition.row + 1;
}

function visibility(node) {
  for (const c of node.namedChildren) if (c.type === 'visibility_modifier') return c.text.replace(/\s+/g, '');
  return '';
}

/** `a::<T>::b` → ['a','b']；`<T as X>::y` → null。 */
export function pathSegments(text) {
  let t = text.replace(/\s+/g, '');
  if (t.startsWith('<')) return null;
  let out = '';
  let depth = 0;
  for (const ch of t) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (depth === 0) out += ch;
  }
  t = out.replace(/::::/g, '::');
  const segs = t.split('::').filter(Boolean);
  if (!segs.length || segs.some((s) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) return null;
  return segs;
}

function signatureOf(node, kind) {
  const body = node.childForFieldName('body');
  let text = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  if (!body && (kind === 'struct' || kind === 'enum' || kind === 'trait' || kind === 'union')) {
    const brace = text.indexOf('{');
    if (brace > 0) text = text.slice(0, brace);
  }
  text = text.replace(/\s+/g, ' ').trim().replace(/[;{]\s*$/, '').trim();
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

/** 展开 use 树：返回 [{ segs, alias, glob }]。 */
export function expandUse(node, prefix = []) {
  if (!node) return [];
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'self':
    case 'super':
    case 'metavariable': {
      const segs = [...prefix, node.text];
      return [{ segs, alias: node.text === 'self' ? prefix.at(-1) : node.text, glob: false }];
    }
    case 'scoped_identifier': {
      const segs = pathSegments(node.text);
      if (!segs) return [];
      const full = [...prefix, ...segs];
      if (full.at(-1) === 'self') return [{ segs: full.slice(0, -1), alias: full.at(-2), glob: false }];
      return [{ segs: full, alias: full.at(-1), glob: false }];
    }
    case 'use_as_clause': {
      const p = node.childForFieldName('path');
      const a = node.childForFieldName('alias');
      const segs = p ? pathSegments(p.text) : null;
      if (!segs) return [];
      const full = [...prefix, ...segs];
      return [{ segs: full.at(-1) === 'self' ? full.slice(0, -1) : full, alias: a?.text ?? full.at(-1), glob: false }];
    }
    case 'use_wildcard': {
      const inner = node.namedChildren[0];
      const segs = inner ? pathSegments(inner.text) : [];
      if (inner && !segs) return [];
      return [{ segs: [...prefix, ...(segs ?? [])], alias: '*', glob: true }];
    }
    case 'scoped_use_list': {
      const p = node.childForFieldName('path');
      const list = node.childForFieldName('list');
      const segs = p ? pathSegments(p.text) : [];
      if (p && !segs) return [];
      return expandUse(list, [...prefix, ...(segs ?? [])]);
    }
    case 'use_list':
      return node.namedChildren.flatMap((c) => expandUse(c, prefix));
    default:
      return [];
  }
}

function innermost(ranges, index) {
  let best = null;
  for (const r of ranges) if (index >= r.start && index < r.end && (!best || r.start >= best.start)) best = r;
  return best;
}

/** 测试属性所在节点的上下文分类。 */
function classifyTestOccurrence(tree, text, index, mods) {
  let node = tree.rootNode.descendantForIndex(index);
  for (let n = node; n; n = n.parent) {
    if (COMMENT_TYPES.has(n.type)) return { kind: 'comment' };
    if (STRING_TYPES.has(n.type)) return { kind: 'string' };
  }
  const attr = text.slice(index).match(/^#\[(tokio::)?test\b/);
  const flavor = attr?.[1] ? 'tokio::test' : 'test';
  let attrItem = null;
  let macro = null;
  for (let n = node; n; n = n.parent) {
    if (n.type === 'attribute_item' && !attrItem) attrItem = n;
    if (n.type === 'macro_invocation' && !macro) macro = n;
    if (n.type === 'macro_definition' && !macro) macro = n;
  }
  const inline = innermost(mods, index);
  const modPath = inline ? inline.path : [];
  if (attrItem && !macro) {
    let s = attrItem.nextNamedSibling;
    while (s && (s.type === 'attribute_item' || COMMENT_TYPES.has(s.type))) s = s.nextNamedSibling;
    if (s && s.type === 'function_item') {
      return { kind: flavor, name: s.childForFieldName('name')?.text, mods: modPath, line: lineOf(s) };
    }
  }
  // 宏体（proptest! / macro_rules! / 其它）内的测试：tree-sitter 不展开宏，按 token 取紧随的 fn 名。
  const rest = text.slice(index);
  const fm = /^#\[[^\]]*\]\s*(?:#\[[^\]]*\]\s*|\/\/[^\n]*\n\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  const macroName = macro
    ? (macro.type === 'macro_definition' ? `macro_rules!${macro.childForFieldName('name')?.text ?? ''}` : `${macro.childForFieldName('macro')?.text ?? '?'}!`)
    : null;
  return {
    kind: macroName ? `${flavor} in ${macroName}` : `${flavor} (unparsed)`,
    name: fm?.[1] ?? null,
    mods: modPath,
    line: text.slice(0, index + (fm ? fm[0].length : 0)).split('\n').length,
  };
}

function attrPathsBefore(node) {
  const out = [];
  for (let s = node.previousNamedSibling; s && (s.type === 'attribute_item' || COMMENT_TYPES.has(s.type)); s = s.previousNamedSibling) {
    if (s.type === 'attribute_item') out.push(s.text);
  }
  return out;
}

/** 单文件分析（与模块树无关的部分）。 */
export function analyzeFile(parser, rel, text, { refs = true } = {}) {
  const tree = parser.parse(text);
  try {
    const root = tree.rootNode;
    const mods = [];
    const modDecls = [];
    const defs = [];
    const uses = [];
    const emits = [];
    const listens = [];
    const strConsts = {};
    const scopedRefs = [];
    const testCode = [];

    const visitItems = (container, inline, inTest) => {
      for (const node of container.namedChildren) {
        const t = node.type;
        if (t === 'mod_item') {
          const name = node.childForFieldName('name')?.text;
          const body = node.childForFieldName('body');
          const attrs = attrPathsBefore(node);
          const isTest = inTest || attrs.some((a) => /cfg\(\s*test\s*\)/.test(a)) || name === 'tests';
          if (body) {
            const p = [...inline, name];
            mods.push({ start: node.startIndex, end: node.endIndex, path: p, test: isTest });
            if (isTest) testCode.push({ start: node.startIndex, end: node.endIndex });
            visitItems(body, p, isTest);
          } else {
            const pathAttr = attrs.map((a) => /#\[\s*path\s*=\s*"([^"]+)"/.exec(a)?.[1]).find(Boolean) ?? null;
            modDecls.push({ name, inline, pathAttr, test: isTest, line: lineOf(node) });
          }
        } else if (t === 'use_declaration') {
          const arg = node.childForFieldName('argument');
          for (const u of expandUse(arg)) uses.push({ ...u, inline, vis: visibility(node), line: lineOf(node), test: inTest });
        } else if (t === 'impl_item') {
          if (node.childForFieldName('trait')) continue;
          let ty = node.childForFieldName('type');
          if (ty?.type === 'generic_type') ty = ty.childForFieldName('type');
          const typeSegs = ty ? pathSegments(ty.text) : null;
          const body = node.childForFieldName('body');
          if (!typeSegs || !body) continue;
          for (const m of body.namedChildren) {
            if (m.type !== 'function_item') continue;
            defs.push({
              name: m.childForFieldName('name')?.text,
              kind: 'method',
              implType: typeSegs,
              inline,
              vis: visibility(m),
              line: lineOf(m),
              signature: signatureOf(m, 'fn'),
              test: inTest,
            });
          }
        } else if (ITEM_KINDS[t]) {
          const name = node.childForFieldName('name')?.text;
          if (!name) continue;
          const kind = ITEM_KINDS[t];
          defs.push({ name, kind, inline, vis: visibility(node), line: lineOf(node), signature: signatureOf(node, kind), test: inTest });
          if (kind === 'const' || kind === 'static') {
            const v = node.childForFieldName('value');
            if (v && v.type === 'string_literal' && !v.text.includes('\\')) strConsts[name] = v.text.slice(1, -1);
          }
        }
      }
    };
    visitItems(root, [], /^tests\//.test(rel) || /\/tests\//.test(rel));

    // 全树遍历：限定路径、emit 调用。
    const cursor = tree.walk();
    const visit = () => {
      const type = cursor.nodeType;
      if (type === 'use_declaration' || type === 'attribute_item' || COMMENT_TYPES.has(type) || STRING_TYPES.has(type)) return false;
      if (refs && (type === 'scoped_identifier' || type === 'scoped_type_identifier')) {
        const node = cursor.currentNode;
        const parent = node.parent;
        const isPathOfParent = parent && (parent.type === 'scoped_identifier' || parent.type === 'scoped_type_identifier') && parent.childForFieldName('path')?.startIndex === node.startIndex && parent.childForFieldName('path')?.endIndex === node.endIndex;
        if (!isPathOfParent) {
          const segs = pathSegments(node.text);
          if (segs && segs.length >= 2) scopedRefs.push({ segs, index: node.startIndex, line: lineOf(node) });
        }
        return false;
      }
      if (type === 'call_expression') {
        const node = cursor.currentNode;
        const fn = node.childForFieldName('function');
        if (fn?.type === 'field_expression') {
          const field = fn.childForFieldName('field')?.text;
          if (EMIT_METHODS.has(field)) {
            const args = node.childForFieldName('arguments')?.namedChildren ?? [];
            const nameArg = field === 'emit_to' || field === 'emit_str_to' ? args[1] : args[0];
            if (nameArg) emits.push({ method: field, arg: nameArg.text.replace(/\s+/g, ' '), argType: nameArg.type, index: node.startIndex, line: lineOf(node) });
          } else if (LISTEN_METHODS.has(field)) {
            const first = node.childForFieldName('arguments')?.namedChildren[0];
            if (first?.type === 'string_literal') listens.push({ method: field, name: first.text.slice(1, -1), index: node.startIndex, line: lineOf(node) });
          }
        }
      }
      return true;
    };
    const walkAll = () => {
      for (;;) {
        const descend = visit();
        if (descend && cursor.gotoFirstChild()) continue;
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) return;
        }
      }
    };
    walkAll();

    // 测试：按 inventory 的正则逐个出现位置分类，保证与 8036 一一对应。
    const tests = [];
    for (const m of text.matchAll(TEST_ATTR_RE)) {
      const c = classifyTestOccurrence(tree, text, m.index, mods);
      tests.push({ ...c, line: c.line ?? text.slice(0, m.index).split('\n').length, attrLine: text.slice(0, m.index).split('\n').length });
    }

    // 文件内被 use 导入的名字的使用位置（用于统计跨 lane 消费点）。
    const importedNames = new Set(uses.filter((u) => !u.glob && u.alias && u.alias !== '_').map((u) => u.alias));
    const identSites = {};
    if (refs && importedNames.size) {
      const c2 = tree.walk();
      const visit2 = () => {
        const type = c2.nodeType;
        if (type === 'use_declaration' || COMMENT_TYPES.has(type) || STRING_TYPES.has(type)) return false;
        if (type === 'scoped_identifier' || type === 'scoped_type_identifier') return false;
        if (type === 'identifier' || type === 'type_identifier') {
          const node = c2.currentNode;
          if (importedNames.has(node.text)) {
            (identSites[node.text] ??= []).push({ line: lineOf(node), index: node.startIndex });
          }
        }
        return true;
      };
      for (;;) {
        const descend = visit2();
        if (descend && c2.gotoFirstChild()) continue;
        let done = false;
        while (!c2.gotoNextSibling()) {
          if (!c2.gotoParent()) { done = true; break; }
        }
        if (done) break;
      }
    }

    return { rel, lines: text.split('\n').length, mods, modDecls, defs, uses, emits, listens, strConsts, scopedRefs, identSites, tests, testCode };
  } finally {
    tree.delete();
  }
}

// ------------------------------------------------------------------ 模块树

export function crateRootName(rel) {
  let m;
  if (rel === 'src/lib.rs') return 'deep_student_lib';
  if (rel === 'src/main.rs') return 'deep_student';
  if ((m = /^crates\/([^/]+)\/src\/lib\.rs$/.exec(rel))) return m[1].replace(/-/g, '_');
  if ((m = /^crates\/([^/]+)\/src\/main\.rs$/.exec(rel))) return `${m[1].replace(/-/g, '_')}_bin`;
  if ((m = /^crates\/([^/]+)\/(tests|examples|benches)\/([^/]+)\.rs$/.exec(rel))) return `${m[1].replace(/-/g, '_')}_${m[2]}_${m[3].replace(/-/g, '_')}`;
  if ((m = /^tests\/([^/]+)\.rs$/.exec(rel))) return `it_${m[1].replace(/-/g, '_')}`;
  return null;
}

/** 由 mod 声明从 crate 根展开，得到每个文件的模块路径。未被任何 mod 声明到达的文件按路径推断并标记。 */
export function buildModuleTree(analyses) {
  const byRel = new Map(analyses.map((a) => [a.rel, a]));
  const fileMod = new Map();
  const queue = [];
  for (const a of analyses) {
    const name = crateRootName(a.rel);
    if (name) {
      fileMod.set(a.rel, { path: [name], inferred: false, crate: name });
      queue.push(a.rel);
    }
  }
  while (queue.length) {
    const rel = queue.shift();
    const a = byRel.get(rel);
    const info = fileMod.get(rel);
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel, '.rs');
    const isModRs = ['mod', 'lib', 'main'].includes(base) || crateRootName(rel) !== null;
    const childDir = isModRs ? dir : `${dir}/${base}`;
    for (const d of a.modDecls) {
      let target = null;
      if (d.pathAttr) {
        const baseDir = d.inline.length ? `${childDir}/${d.inline.join('/')}` : dir;
        target = path.posix.normalize(`${baseDir}/${d.pathAttr}`);
      } else {
        const cd = d.inline.length ? `${childDir}/${d.inline.join('/')}` : childDir;
        target = [`${cd}/${d.name}.rs`, `${cd}/${d.name}/mod.rs`].find((p) => byRel.has(p)) ?? null;
      }
      if (!target || !byRel.has(target) || fileMod.has(target)) continue;
      fileMod.set(target, { path: [...info.path, ...d.inline, d.name], inferred: false, crate: info.crate, test: d.test || info.test });
      queue.push(target);
    }
  }
  for (const a of analyses) {
    if (fileMod.has(a.rel)) continue;
    const m = /^(crates\/[^/]+\/src|src)\/(.*)\.rs$/.exec(a.rel);
    if (m) {
      const crate = m[1] === 'src' ? 'deep_student_lib' : m[1].split('/')[1].replace(/-/g, '_');
      const segs = m[2].split('/').filter((s) => s !== 'mod');
      fileMod.set(a.rel, { path: [crate, ...segs.map((s) => s.replace(/-/g, '_'))], inferred: true, crate });
    } else {
      fileMod.set(a.rel, { path: [`file:${a.rel}`], inferred: true, crate: `file:${a.rel}` });
    }
  }
  return fileMod;
}

// ------------------------------------------------------------------ 名称解析

export class RustIndex {
  constructor(analyses, fileMod, laneOf) {
    this.analyses = analyses;
    this.fileMod = fileMod;
    this.laneOf = laneOf;
    this.modules = new Map();
    this.defs = new Map();
    this.crates = new Set();
    for (const a of analyses) {
      const fm = fileMod.get(a.rel);
      this.crates.add(fm.crate);
      this.mod(fm.path, a.rel, fm.inferred);
      for (const m of a.mods) this.mod([...fm.path, ...m.path], a.rel, fm.inferred);
    }
    for (const a of analyses) {
      const fm = fileMod.get(a.rel);
      for (const d of a.modDecls) this.mod([...fm.path, ...d.inline, d.name], null, fm.inferred);
      for (const u of a.uses) {
        const m = this.mod([...fm.path, ...u.inline], a.rel, fm.inferred);
        if (u.glob) m.globs.push({ segs: u.segs, vis: u.vis });
        else if (u.alias && u.alias !== '_') m.aliases.set(u.alias, { segs: u.segs, vis: u.vis });
      }
      for (const d of a.defs) {
        if (d.kind === 'method') continue;
        const modPath = [...fm.path, ...d.inline];
        const id = [...modPath, d.name].join('::');
        const m = this.mod(modPath, a.rel, fm.inferred);
        m.items.set(d.name, id);
        if (!this.defs.has(id)) this.defs.set(id, { id, ...d, file: a.rel, lane: laneOf(a.rel), inferred: fm.inferred });
      }
    }
    // 方法挂到其类型的定义路径下（类型按 impl 所在模块解析）。
    for (const a of analyses) {
      const fm = fileMod.get(a.rel);
      for (const d of a.defs) {
        if (d.kind !== 'method') continue;
        const modPath = [...fm.path, ...d.inline];
        const r = this.resolveFrom(modPath, d.implType, 0, true);
        const typeId = r?.def ?? [...modPath, ...d.implType].join('::');
        const id = `${typeId}::${d.name}`;
        if (!this.defs.has(id)) this.defs.set(id, { id, ...d, typeId, file: a.rel, lane: laneOf(a.rel), inferred: fm.inferred });
      }
    }
  }

  mod(segs, file, inferred) {
    const key = segs.join('::');
    let m = this.modules.get(key);
    if (!m) {
      m = { path: segs, items: new Map(), aliases: new Map(), globs: [], files: new Set(), inferred };
      this.modules.set(key, m);
      if (segs.length > 1) {
        const parent = this.mod(segs.slice(0, -1), null, inferred);
        (parent.children ??= new Set()).add(segs.at(-1));
      }
    }
    if (file) m.files.add(file);
    m.children ??= new Set();
    return m;
  }

  /** 把 use / 代码中的路径（相对模块 modPath）归一为绝对路径。外部 crate 返回 null。 */
  absolutize(modPath, segs, localScope = true) {
    const [first] = segs;
    if (first === 'crate') return [modPath[0], ...segs.slice(1)];
    if (first === 'self') return [...modPath, ...segs.slice(1)];
    if (first === 'super') {
      let base = modPath.slice();
      let i = 0;
      while (segs[i] === 'super') { base = base.slice(0, -1); i++; }
      return [...base, ...segs.slice(i)];
    }
    if (first === '$crate') return null;
    if (localScope) {
      const m = this.modules.get(modPath.join('::'));
      if (m && (m.children.has(first) || m.items.has(first) || m.aliases.has(first))) return [...modPath, ...segs];
    }
    if (this.crates.has(first)) return segs;
    return null;
  }

  resolveFrom(modPath, segs, depth = 0, localScope = true) {
    const abs = this.absolutize(modPath, segs, localScope);
    if (!abs) return null;
    return this.resolveAbs(abs, depth, modPath);
  }

  /** 绝对路径 → { def } | { module } | null。viaGlob 表示经过 glob 重导出（不确定）。 */
  resolveAbs(segs, depth = 0, fromMod = null) {
    if (depth > 12) return null;
    let cur = [segs[0]];
    if (!this.modules.has(segs[0])) return null;
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i];
      const key = cur.join('::');
      const m = this.modules.get(key);
      if (!m) return null;
      const inside = fromMod && fromMod.join('::').startsWith(key);
      if (m.children.has(seg) && this.modules.has(`${key}::${seg}`)) { cur = [...cur, seg]; continue; }
      if (m.items.has(seg)) {
        const id = m.items.get(seg);
        const rest = segs.slice(i + 1);
        if (!rest.length) return { def: id };
        if (this.defs.has(`${id}::${rest[0]}`)) return { def: `${id}::${rest[0]}` };
        return { def: id, member: rest.join('::') };
      }
      const alias = m.aliases.get(seg);
      if (alias && (inside || alias.vis.startsWith('pub'))) {
        const target = this.absolutize(cur, alias.segs, true);
        if (!target) return null;
        return this.resolveAbs([...target, ...segs.slice(i + 1)], depth + 1, fromMod);
      }
      for (const g of m.globs) {
        if (!(inside || g.vis.startsWith('pub'))) continue;
        const target = this.absolutize(cur, g.segs, true);
        if (!target) continue;
        const r = this.resolveAbs([...target, ...segs.slice(i)], depth + 1, fromMod);
        if (r) return { ...r, viaGlob: true };
      }
      return null;
    }
    return { module: cur.join('::') };
  }

  /** 在某文件某位置解析代码里的限定路径（考虑该处可见的 use）。 */
  resolveInFile(a, index, segs) {
    const fm = this.fileMod.get(a.rel);
    const inline = innermost(a.mods, index);
    const modPath = [...fm.path, ...(inline ? inline.path : [])];
    const m = this.modules.get(modPath.join('::'));
    const alias = m?.aliases.get(segs[0]);
    if (alias) {
      const target = this.absolutize(modPath, alias.segs, true);
      if (target) return this.resolveAbs([...target, ...segs.slice(1)], 0, modPath);
      return null;
    }
    const direct = this.resolveFrom(modPath, segs, 0, true);
    if (direct) return direct;
    for (const g of m?.globs ?? []) {
      const target = this.absolutize(modPath, g.segs, true);
      if (!target) continue;
      const r = this.resolveAbs([...target, ...segs], 0, modPath);
      if (r) return { ...r, viaGlob: true };
    }
    return null;
  }
}

// ------------------------------------------------------------------ 入口

/** 分析全部 Rust 文件。返回 { rules, files, analyses, fileMod, index, laneOf }。 */
export async function analyzeRepo({ refs = true, log = () => {} } = {}) {
  const rules = await loadInventoryRules();
  const parser = await rustParser();
  const files = listRustFiles();
  const texts = readRustSources(files);
  const analyses = [];
  let n = 0;
  for (const rel of files) {
    const text = texts.get(rel);
    analyses.push(analyzeFile(parser, rel, text, { refs }));
    if (++n % 200 === 0) log(`parsed ${n}/${files.length}`);
  }
  const laneOf = (rel) => laneOfFile(rules, rel);
  const fileMod = buildModuleTree(analyses);
  const index = refs ? new RustIndex(analyses, fileMod, laneOf) : null;
  return { rules, files, texts, analyses, fileMod, index, laneOf };
}

/** 测试 id：`<rust 文件>::<内联模块…>::<测试名>`。 */
export function testId(rel, t) {
  return [rel, ...(t.mods ?? []), t.name ?? `?@L${t.attrLine}`].join('::');
}

/** 每个测试属性出现位置一行，id 唯一（同名追加 `#n`）。 */
export function testRows(analyses, laneOf) {
  const rows = [];
  const seen = new Map();
  for (const a of analyses) {
    const lane = laneOf(a.rel);
    for (const t of a.tests) {
      let id = testId(a.rel, t);
      if (t.kind === 'comment' || t.kind === 'string') id = `${a.rel}::<${t.kind}@L${t.attrLine}>`;
      const k = seen.get(id) ?? 0;
      seen.set(id, k + 1);
      if (k) id = `${id}#${k + 1}`;
      rows.push({ id, lane, file: a.rel, line: t.line, attrLine: t.attrLine, kind: t.kind, name: t.name ?? null, real: t.kind !== 'comment' && t.kind !== 'string' });
    }
  }
  return rows;
}

/** 事件名解析：字符串字面量、同文件或全局唯一的 `&str` 常量；其余为动态名。 */
export function resolveEmitName(e, a, globalConsts) {
  let arg = e.arg.replace(/^&/, '').trim();
  const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(arg);
  if (lit) return { name: lit[1], dynamic: false };
  const id = /^(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Z][A-Z0-9_]*)$/.exec(arg);
  if (id) {
    if (a.strConsts[id[1]] !== undefined) return { name: a.strConsts[id[1]], dynamic: false, via: id[1] };
    const g = globalConsts.get(id[1]);
    if (g && g.size === 1) return { name: [...g][0], dynamic: false, via: id[1] };
  }
  const fmt = /format!\(\s*"((?:[^"\\]|\\.)*)"/.exec(arg);
  if (fmt) return { name: fmt[1], dynamic: true };
  return { name: arg, dynamic: true, expr: true };
}

export function globalStrConsts(analyses) {
  const m = new Map();
  for (const a of analyses) for (const [k, v] of Object.entries(a.strConsts)) (m.get(k) ?? m.set(k, new Set()).get(k)).add(v);
  return m;
}

export function inRanges(ranges, index) {
  return ranges.some((r) => index >= r.start && index < r.end);
}
