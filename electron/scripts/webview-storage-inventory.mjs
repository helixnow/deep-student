#!/usr/bin/env node
/**
 * WP-045：只读盘点 src/ 中 Web Storage（localStorage/sessionStorage）与 IndexedDB 的使用点。
 * 每个文件单独解析（TypeScript AST，不建 Program）；键能静态确定时给出字面值，同文件 const / 对象常量
 * 属性会解析，模板字符串记为带 `*` 的模式，其余记为 unresolved 并保留表达式原文。
 *
 * 用法：node electron/scripts/webview-storage-inventory.mjs [输出 JSON 路径]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const repo = new URL('../..', import.meta.url).pathname;
const srcRoot = join(repo, 'src');
const out = process.argv[2];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path, files);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}
const isTest = (rel) => /(^|\/)(__tests__|tests?|testing|__mocks__)\//.test(rel) || /\.(test|spec)\.[jt]sx?$/.test(rel);

function constTable(sf) {
  const table = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      table.set(node.name.text, init);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return table;
}

function resolveKey(expr, table, depth = 0) {
  if (depth > 6) return null;
  while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { key: expr.text, kind: 'literal' };
  if (ts.isTemplateExpression(expr)) {
    let pattern = expr.head.text;
    for (const span of expr.templateSpans) {
      const inner = resolveKey(span.expression, table, depth + 1);
      pattern += (inner?.kind === 'literal' ? inner.key : '*') + span.literal.text;
    }
    return { key: pattern, kind: pattern.includes('*') ? 'pattern' : 'literal' };
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolveKey(expr.left, table, depth + 1);
    const r = resolveKey(expr.right, table, depth + 1);
    const key = `${l?.kind === 'literal' || l?.kind === 'pattern' ? l.key : '*'}${r?.kind === 'literal' || r?.kind === 'pattern' ? r.key : '*'}`;
    return { key, kind: key.includes('*') ? 'pattern' : 'literal' };
  }
  if (ts.isIdentifier(expr) && table.has(expr.text)) return resolveKey(table.get(expr.text), table, depth + 1);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && table.has(expr.expression.text)) {
    let obj = table.get(expr.expression.text);
    while (ts.isAsExpression(obj) || ts.isParenthesizedExpression(obj)) obj = obj.expression;
    if (ts.isObjectLiteralExpression(obj)) {
      for (const p of obj.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText() === expr.name.text) return resolveKey(p.initializer, table, depth + 1);
      }
    }
  }
  return null;
}

function inFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
  }
  return false;
}
function inTry(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTryStatement(p) && node.pos >= p.tryBlock.pos && node.end <= p.tryBlock.end) return true;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

const sites = [];
const persistNames = [];
const indexedDbSites = [];
const enumerations = [];
for (const file of walk(srcRoot)) {
  const rel = relative(repo, file);
  const text = readFileSync(file, 'utf8');
  if (!/localStorage|sessionStorage|indexedDB|persist\(/.test(text)) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const table = constTable(sf);
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression.getText(sf).replace(/^(window|globalThis|self)\./, '');
      const area = /(^|\.)localStorage$/.test(target) ? 'localStorage' : /(^|\.)sessionStorage$/.test(target) ? 'sessionStorage' : null;
      if (area && ['getItem', 'setItem', 'removeItem'].includes(method) && node.arguments.length > 0) {
        const resolved = resolveKey(node.arguments[0], table);
        sites.push({
          file: rel, line: line(node), area, op: method,
          key: resolved?.key ?? null, keyKind: resolved?.kind ?? 'unresolved',
          expr: resolved ? undefined : node.arguments[0].getText(sf).slice(0, 120),
          moduleLevel: !inFunction(node), guarded: inTry(node), test: isTest(rel),
        });
      } else if (area && (method === 'clear' || method === 'key')) {
        enumerations.push({ file: rel, line: line(node), area, op: method, test: isTest(rel) });
      }
      if (target === 'indexedDB' || target.endsWith('.indexedDB')) indexedDbSites.push({ file: rel, line: line(node), op: method, test: isTest(rel) });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'persist' && node.arguments.length >= 2) {
      const opts = node.arguments[1];
      if (ts.isObjectLiteralExpression(opts)) {
        const nameProp = opts.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'name');
        const storageProp = opts.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'storage');
        const versionProp = opts.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'version');
        persistNames.push({
          file: rel, line: line(node), key: nameProp ? resolveKey(nameProp.initializer, table)?.key ?? nameProp.initializer.getText(sf) : null,
          storage: storageProp ? storageProp.initializer.getText(sf).slice(0, 80) : 'default(localStorage)',
          version: versionProp ? versionProp.initializer.getText(sf) : null, test: isTest(rel),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const prod = sites.filter((s) => !s.test);
const keys = new Map();
for (const s of prod) {
  const id = `${s.area}\u0000${s.key ?? `?${s.file}:${s.line}`}`;
  const entry = keys.get(id) ?? { area: s.area, key: s.key, keyKind: s.keyKind, ops: new Set(), owners: new Set(), sites: [] };
  entry.ops.add(s.op);
  entry.owners.add(s.file.split('/').slice(1, 3).join('/'));
  entry.sites.push(`${s.file}:${s.line}${s.moduleLevel ? ' (module-level)' : ''}${s.guarded ? '' : ' (no try)'}`);
  if (!s.key) entry.expr = s.expr;
  keys.set(id, entry);
}
const keyList = [...keys.values()]
  .map((k) => ({ ...k, ops: [...k.ops].sort(), owners: [...k.owners].sort() }))
  .sort((a, b) => `${a.area}${a.key ?? '~'}`.localeCompare(`${b.area}${b.key ?? '~'}`));
const summary = {
  filesWithLocalStorage: new Set(sites.filter((s) => s.area === 'localStorage').map((s) => s.file)).size,
  prodFilesWithLocalStorage: new Set(prod.filter((s) => s.area === 'localStorage').map((s) => s.file)).size,
  prodSites: prod.length,
  prodLocalStorageKeys: keyList.filter((k) => k.area === 'localStorage' && k.keyKind === 'literal').length,
  prodLocalStoragePatterns: keyList.filter((k) => k.area === 'localStorage' && k.keyKind === 'pattern').length,
  prodLocalStorageUnresolvedSites: prod.filter((s) => s.area === 'localStorage' && s.keyKind === 'unresolved').length,
  prodSessionStorageSites: prod.filter((s) => s.area === 'sessionStorage').length,
  prodModuleLevelSites: prod.filter((s) => s.moduleLevel).length,
  prodUnguardedSites: prod.filter((s) => !s.guarded).length,
  prodIndexedDbSites: indexedDbSites.filter((s) => !s.test).length,
  zustandPersist: persistNames.filter((p) => !p.test).length,
};
const result = { generatedFrom: 'src/** (static AST, per file)', summary, keys: keyList, zustandPersist: persistNames, indexedDb: indexedDbSites, enumerations };
const json = `${JSON.stringify(result, null, 1)}\n`;
if (out) writeFileSync(out, json);
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
