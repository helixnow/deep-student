// Host scan: SQL write calls → bound column expression → where its JSON text is produced.
// Syntax-only (TypeScript parser, no checker): follows locals, `a ?? b`, conditionals,
// helper return values and function parameters back to call sites (depth-limited).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { parseSqlWrite } from './sql.mjs';

const SQL_METHODS = new Set(['run', 'get', 'all', 'one', 'pluck', 'iterate', 'execute', 'query', 'values']);
/** Writers that already produce Rust-compatible text. */
const SAFE_WRITERS = new Set(['toRustJson', 'stringifyJsonValue', 'serializeJsonValue', 'stringifyRustJson']);

export function hostFiles(root) {
  return execFileSync('git', ['ls-files', 'host'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(?:ts|mts)$/.test(f) && !f.endsWith('.d.ts'))
    .filter((f) => !/(?:^|\/)(?:tests?|__tests__|__fixtures__|e2e|equivalence|fixtures)\//.test(f) && !/\.test\.ts$/.test(f))
    .filter((f) => !f.startsWith('host/platform/serde-compat/'));
}

export const pluginOf = (file) => {
  const m = /^host\/(plugins|platform)\/([^/]+)/.exec(file);
  return m ? (m[1] === 'plugins' ? m[2] : `platform/${m[2]}`) : file.split('/').slice(0, 2).join('/');
};

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

const fnName = (node) => {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
  return undefined;
};
const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const enclosingFn = (n) => { for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p; return undefined; };
const calleeName = (call) => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
};
const unwrap = (e) => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e;
};

export function loadHost(root, files = hostFiles(root), read = (f) => fs.readFileSync(path.join(root, f), "utf8")) {
  const sources = new Map();
  const fns = new Map();      // name → [{file, sf, node}]
  const calls = new Map();    // callee name → [{file, sf, node}]
  const consts = new Map();   // name → [{file, sf, init}]
  for (const file of files) {
    const text = read(file);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sources.set(file, sf);
    const visit = (node) => {
      if (isFn(node)) {
        const name = fnName(node);
        if (name) (fns.get(name) ?? fns.set(name, []).get(name)).push({ file, sf, node });
      }
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name) (calls.get(name) ?? calls.set(name, []).get(name)).push({ file, sf, node });
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !enclosingFn(node)) {
        (consts.get(node.name.text) ?? consts.set(node.name.text, []).get(node.name.text)).push({ file, sf, init: node.initializer });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { root, files, sources, fns, calls, consts };
}

/** Text of an SQL-ish expression (literal, template with `${}` kept, const, defineQuery). */
function sqlText(expr, ctx, file, depth = 0) {
  const e = unwrap(expr);
  if (!e || depth > 3) return undefined;
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.getText().slice(1, -1);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = sqlText(e.left, ctx, file, depth + 1), r = sqlText(e.right, ctx, file, depth + 1);
    return l !== undefined || r !== undefined ? `${l ?? '${…}'}${r ?? '${…}'}` : undefined;
  }
  if (ts.isCallExpression(e) && calleeName(e) === 'defineQuery' && e.arguments[0]) return sqlText(e.arguments[0], ctx, file, depth + 1);
  if (ts.isCallExpression(e) && /^(?:sql|dedent|trim)$/.test(calleeName(e) ?? '') && e.arguments[0]) return sqlText(e.arguments[0], ctx, file, depth + 1);
  if (ts.isIdentifier(e)) {
    const local = localInit(e, e.text);
    if (local) return sqlText(local, ctx, file, depth + 1);
    const c = (ctx.consts.get(e.text) ?? []).find((x) => x.file === file) ?? (ctx.consts.get(e.text) ?? [])[0];
    if (c) return sqlText(c.init, ctx, c.file, depth + 1);
  }
  if (ts.isPropertyAccessExpression(e) && /^(?:sql|text|source)$/.test(e.name.text)) return sqlText(e.expression, ctx, file, depth + 1);
  return undefined;
}

/** Initializer of the nearest `const|let name = …` visible from `at` (same function chain). */
function localInit(at, name) {
  for (let scope = enclosingFn(at); scope; scope = enclosingFn(scope)) {
    let found;
    const visit = (n) => {
      if (found) return;
      if (n !== scope && isFn(n)) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && n.getStart() < at.getStart()) found = n.initializer;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(scope, visit);
    if (found) return found;
  }
  return undefined;
}

const parsesAsJson = (text) => { try { JSON.parse(text); return true; } catch { return false; } };

function paramIndex(fn, name) {
  return fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
}
function destructuredParam(fn, name) {
  for (const [i, p] of fn.parameters.entries()) {
    if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        const local = el.name.getText();
        const key = el.propertyName?.getText() ?? local;
        if (local === name) return { index: i, key };
      }
    }
  }
  return undefined;
}

/**
 * Where the value of `expr` (bound to an SQL column) is produced.
 * @returns {{writer:string, file:string, line:number, arg?:ts.Node, sf:ts.SourceFile, via:string[]}[]}
 */
export function jsonSources(expr, ctx, file, sf, depth = 0, via = [], seen = new Set()) {
  const e = unwrap(expr);
  if (!e || depth > 6 || seen.has(e)) return [];
  seen.add(e);
  const here = (writer, arg) => [{ writer, file, sf, line: lineOf(sf, e), arg, via }];
  if (ts.isCallExpression(e)) {
    const name = calleeName(e);
    const full = e.expression.getText(sf);
    if (full === 'JSON.stringify') return here(e.arguments.length > 2 ? 'JSON.stringify(pretty)' : 'JSON.stringify', e.arguments[0]);
    if (name && SAFE_WRITERS.has(name)) return here(`safe:${name}`, e.arguments[0]);
    if (name === 'String' || name === 'jsonParam' || name === 'sqlParam' || name === 'toSqlParam') return jsonSources(e.arguments[0], ctx, file, sf, depth + 1, via, seen);
    if (name && /^(?:stringify|serialize|encode|to)\w*Json\w*$|Json(?:Text|String)$|^json\w*(?:Text|String)$/i.test(name) && !(ctx.fns.get(name)?.length)) return here(`helper:${name}`, e.arguments[0]);
    const defs = name ? ctx.fns.get(name) ?? [] : [];
    if (defs.length > 0 && defs.length <= 3) {
      const out = [];
      for (const d of defs) {
        const rets = [];
        if (!ts.isBlock(d.node.body ?? ts.factory.createBlock([]))) rets.push(d.node.body);
        else d.node.body.forEachChild(function walk(n) { if (isFn(n)) return; if (ts.isReturnStatement(n) && n.expression) rets.push(n.expression); n.forEachChild(walk); });
        for (const r of rets) out.push(...jsonSources(r, ctx, d.file, d.sf, depth + 1, [...via, `${name}()@${d.file}:${lineOf(d.sf, d.node)}`], seen));
      }
      if (out.length) return out;
    }
    return [];
  }
  if (ts.isConditionalExpression(e)) return [...jsonSources(e.whenTrue, ctx, file, sf, depth + 1, via, seen), ...jsonSources(e.whenFalse, ctx, file, sf, depth + 1, via, seen)];
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) {
    return [...jsonSources(e.left, ctx, file, sf, depth + 1, via, seen), ...jsonSources(e.right, ctx, file, sf, depth + 1, via, seen)];
  }
  if (ts.isStringLiteralLike(e) && /^\s*[[{]/.test(e.text) && e.text.length > 2 && parsesAsJson(e.text)) return here('literal');
  if (ts.isTemplateExpression(e) && /^`\s*\{\s*"/.test(e.getText(sf))) return here('template');
  if (ts.isIdentifier(e)) {
    const init = localInit(e, e.text);
    if (init) return jsonSources(init, ctx, file, sf, depth + 1, via, seen);
    const fn = enclosingFn(e);
    if (fn) {
      const idx = paramIndex(fn, e.text);
      const destr = idx < 0 ? destructuredParam(fn, e.text) : undefined;
      const name = fnName(fn);
      // Call sites are matched by name only: follow parameters of uniquely named functions.
      if ((idx >= 0 || destr) && name && (ctx.fns.get(name) ?? []).length === 1) {
        const out = [];
        for (const c of (ctx.calls.get(name) ?? []).slice(0, 40)) {
          const arg = c.node.arguments[idx >= 0 ? idx : destr.index];
          if (!arg) continue;
          let target = arg;
          if (destr) {
            const obj = unwrap(arg);
            const prop = ts.isObjectLiteralExpression(obj) ? obj.properties.find((p) => p.name?.getText(c.sf) === destr.key) : undefined;
            if (!prop) continue;
            target = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
            if (!target) continue;
          }
          out.push(...jsonSources(target, ctx, c.file, c.sf, depth + 1, [...via, `${name}(…)@${c.file}:${lineOf(c.sf, c.node)}`], seen));
        }
        return out;
      }
    }
    return [];
  }
  if (ts.isPropertyAccessExpression(e)) {
    const owner = unwrap(e.expression);
    if (ts.isIdentifier(owner)) {
      const init = unwrap(localInit(owner, owner.text));
      if (init && ts.isObjectLiteralExpression(init)) {
        const prop = init.properties.find((p) => p.name?.getText(sf) === e.name.text);
        if (prop && ts.isPropertyAssignment(prop)) return jsonSources(prop.initializer, ctx, file, sf, depth + 1, via, seen);
      }
    }
    return [];
  }
  return [];
}

/** Ordered keys of an object-literal argument (`…` marks a spread). */
export function literalKeys(arg, sf) {
  const e = unwrap(arg);
  if (!e || !ts.isObjectLiteralExpression(e)) return undefined;
  return e.properties.map((p) => {
    if (ts.isSpreadAssignment(p)) return '...';
    const key = p.name ? p.name.getText(sf).replace(/^['"]|['"]$/g, '') : '?';
    let value = ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : key;
    if (value.length > 60) value = `${value.slice(0, 57)}...`;
    return { key, value };
  });
}

const HASH_CALLEE = /(?:^|\.)(?:createHash|update|digest|sha\d+\w*|\w*[Hh]ash(?:Hex|Json|Text)?|blake3\w*|fnv\w*)$/;

/** `JSON.stringify` results fed into a hash/digest (fingerprints, idempotency keys): invisible to G3. */
export function scanHashInputs(ctx) {
  const out = [];
  for (const [file, sf] of ctx.sources) {
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(sf) === 'JSON.stringify') {
        let hit;
        for (let p = node.parent, depth = 0; p && depth < 5 && !hit; p = p.parent, depth++) {
          if (ts.isCallExpression(p) && HASH_CALLEE.test(p.expression.getText(sf).replace(/\s+/g, ''))) hit = p;
          if (isFn(p) || ts.isBlock(p)) break;
        }
        if (!hit && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          const name = node.parent.name.text;
          const scope = enclosingFn(node);
          scope?.forEachChild(function walk(n) {
            if (hit) return;
            if (ts.isCallExpression(n) && HASH_CALLEE.test(n.expression.getText(sf).replace(/\s+/g, '')) && n.arguments.some((a) => unwrap(a).getText(sf) === name)) hit = n;
            n.forEachChild(walk);
          });
        }
        if (hit) {
          const fn = enclosingFn(node);
          out.push({
            plugin: pluginOf(file), file, line: lineOf(sf, node), fn: fn ? fnName(fn) ?? null : null,
            arg: node.arguments[0]?.getText(sf).replace(/\s+/g, ' ').slice(0, 80) ?? null,
            hash: hit.expression.getText(sf).replace(/\s+/g, '').slice(0, 40),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** All SQL write sites with per-column JSON sources. */
export function scanHostWrites(ctx) {
  const out = [];
  for (const [file, sf] of ctx.sources) {
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SQL_METHODS.has(node.expression.name.text)) {
        let sqlArg = node.arguments[0];
        let params = node.arguments.slice(1);
        const recv = unwrap(node.expression.expression);
        if (ts.isCallExpression(recv) && /^(?:prepare|prepareCached|statement)$/.test(calleeName(recv) ?? '')) { sqlArg = recv.arguments[0]; params = [...node.arguments]; }
        const sql = sqlArg ? sqlText(sqlArg, ctx, file) : undefined;
        const parsed = sql ? parseSqlWrite(sql) : undefined;
        if (parsed && !/\$\{/.test(parsed.table)) {
          let positional, named;
          const first = params[0] && unwrap(params[0]);
          const resolvedFirst = first && ts.isIdentifier(first) ? unwrap(localInit(first, first.text)) ?? first : first;
          if (resolvedFirst && ts.isArrayLiteralExpression(resolvedFirst)) positional = resolvedFirst.elements;
          else if (resolvedFirst && ts.isObjectLiteralExpression(resolvedFirst)) {
            named = new Map(resolvedFirst.properties.filter((p) => p.name).map((p) => [p.name.getText(sf).replace(/^['"]?[$:@]?|['"]$/g, ''), ts.isPropertyAssignment(p) ? p.initializer : p.name]));
          } else if (params.length > 1) positional = params;
          for (const col of parsed.columns) {
            if (!col.param) continue;
            let expr;
            if (col.param.index !== undefined) expr = positional?.[col.param.index - 1];
            else expr = named?.get(col.param.name);
            if (!expr || ts.isSpreadElement(expr)) continue;
            const sources = jsonSources(expr, ctx, file, sf);
            out.push({
              plugin: pluginOf(file), table: parsed.table, column: col.column, file, line: lineOf(sf, node),
              expr: expr.getText(sf).slice(0, 80),
              sources: sources.map((s) => ({
                writer: s.writer, file: s.file, line: s.line, via: s.via,
                arg: s.arg ? s.arg.getText(s.sf).replace(/\s+/g, ' ').slice(0, 100) : null,
                keys: s.arg ? literalKeys(s.arg, s.sf) : undefined,
                atoms: s.arg ? /\b(?:f64Atom|f32Atom|rawJSON|toRustValue)\b/.test(s.arg.getText(s.sf)) : false,
              })),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
