#!/usr/bin/env node
// `util/path.ts` 与 `crypto/sync.ts` 的调用方清单（W14）：插件生产代码里的 `node:path` 导入方与
// `createHash` 调用点，逐个给出替换方式。用法：node scripts/portability/platform-callers.mjs [--out <file.md>]
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { analyzeSource } from './lib/portability.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PLUGINS = path.join(ROOT, 'host/plugins');
/** `update(x)` 的实参名像用户数据（大小不受控）时，建议异步 `ctx.crypto`。 */
const DATA_NAMES = /^(bytes|data|content|pdfBytes|compressed|zipBytes|payload|buffer|chunk|fileBytes|blob|raw)$/i;

function* sourceFiles(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === '__tests__' || name === '__fixtures__' || name === 'equivalence') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

function pathImport(sf) {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!['node:path', 'path'].includes(statement.moduleSpecifier.text) || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
    return [`${clause?.name?.text ?? (bindings && ts.isNamespaceImport(bindings) ? `* as ${bindings.name.text}` : '?')}（整体导入）`];
  }
  return null;
}

function hashCalls(sf) {
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createHash') {
      const algorithm = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : '?';
      const updates = [];
      let parent = node.parent;
      while (parent && ts.isPropertyAccessExpression(parent) && ts.isCallExpression(parent.parent)) {
        if (parent.name.text === 'update' && parent.parent.arguments.length === 1) updates.push(parent.parent.arguments[0]);
        else if (parent.name.text === 'update') updates.push(undefined);
        parent = parent.parent.parent;
      }
      const chained = updates.length > 0;
      const dataLike = updates.some((arg) => arg && ts.isIdentifier(arg) && DATA_NAMES.test(arg.text));
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ algorithm, line, kind: !chained ? 'incremental' : dataLike ? 'data' : 'small' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const ADVICE = {
  small: '`sha256HexSync`（小输入）',
  data: '用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync`',
  incremental: '增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流）',
};

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const pathRows = [];
  const hashRows = [];
  for (const file of sourceFiles(PLUGINS)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = pathImport(sf);
    if (names !== null) {
      const others = [...new Set(analyzeSource(rel, text).findings.filter((f) => !f.typeOnly && !(f.rule === 'node-builtin' && f.module === 'path')).map((f) => f.specifier))];
      pathRows.push({ rel, names, others });
    }
    for (const call of hashCalls(sf)) hashRows.push({ rel, ...call });
  }
  const byLane = (rows) => [...rows].sort((a, b) => a.rel.localeCompare(b.rel));
  const freed = pathRows.filter((row) => row.others.length === 0);
  const sha = hashRows.filter((row) => row.algorithm === 'sha256');
  const lines = [
    '# `util/path.ts` 与 `crypto/sync.ts` 的调用方清单',
    '',
    '由 `node scripts/portability/platform-callers.mjs --out scripts/portability/PLATFORM-CALLERS.md` 生成（插件生产代码，不含测试与 `equivalence/`）。',
    '',
    '## `node:path` → `host/platform/util/path.ts`',
    '',
    '同名函数、语义与 `node:path` 一致，替换只改 import。`resolve` 在移动端需要绝对路径段（没有工作目录）。',
    `共 ${pathRows.length} 个文件；其中 ${freed.length} 个换掉后不再有任何 Node 依赖（“其余 Node 依赖”一栏为空）。`,
    '',
    '| 文件 | 用到的名字 | 其余 Node 依赖 |',
    '|---|---|---|',
    ...byLane(pathRows).map((row) => `| \`${row.rel.replace('host/plugins/', '')}\` | ${row.names.join(', ')} | ${row.others.map((s) => `\`${s}\``).join(' ')} |`),
    '',
    '## `createHash(\'sha256\')` → `host/platform/crypto/sync.ts` / `ctx.crypto`',
    '',
    '“输入”一栏按 `update()` 的实参名粗分（启发式，owner 以实际数据大小为准）。性能边界见 `crypto/sync.ts` 文件头：纯 JS 约 100–190 MB/s，1 MB ≈ 5 ms 阻塞。',
    `共 ${sha.length} 处 sha256；sha1 等其他算法 ${hashRows.length - sha.length} 处（\`digestSync('SHA-1', …)\`，WebSocket 握手这类仅桌面的保留）。`,
    '',
    '| 位置 | 算法 | 输入 | 替换 |',
    '|---|---|---|---|',
    ...byLane(hashRows).map((row) => `| \`${row.rel.replace('host/plugins/', '')}:${row.line}\` | ${row.algorithm} | ${row.kind} | ${row.algorithm === 'sha256' ? ADVICE[row.kind] : `\`digestSync('${row.algorithm.toUpperCase().replace('SHA', 'SHA-')}', …)\` / \`createHasherSync\``} |`),
    '',
  ];
  const output = lines.join('\n');
  if (outIndex >= 0) fs.writeFileSync(path.resolve(args[outIndex + 1]), output);
  else process.stdout.write(output);
}

main();
