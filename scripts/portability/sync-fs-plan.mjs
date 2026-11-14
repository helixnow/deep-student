#!/usr/bin/env node
// 同步 fs 调用方清单与迁移方案（W14）：逐个调用点找出所在函数及其是否 async，按文件给出迁到异步
// `ctx.files` 的做法。用法：node scripts/portability/sync-fs-plan.mjs [--out <file.md>]
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { MOBILE_CORE, declaredPlatforms } from './lib/portability.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PLUGINS = path.join(ROOT, 'host/plugins');

/** 同步 fs 函数 → 异步 `ctx.files` 的对应做法。 */
const TARGET = {
  existsSync: '`exists`',
  accessSync: '`exists` / `stat`',
  statSync: '`stat`',
  lstatSync: '`stat({ followSymlinks: false })`',
  fstatSync: '`stat`（按路径）；只要本句柄写入后的大小用 `openFile` 句柄的 `size`',
  readFileSync: '`readBytes` / `readText`',
  writeFileSync: '`writeBytes` / `writeText`；需要原子替换用 `writeAtomic`',
  appendFileSync: '`append`',
  mkdirSync: '`mkdir`',
  mkdtempSync: '`mkdir` + `ctx.crypto.randomUUID()` 命名',
  readdirSync: '`readDir`',
  opendirSync: '`readDir`',
  rmSync: '`rm`',
  rmdirSync: '`rm`',
  unlinkSync: '`rm`',
  renameSync: '`rename`',
  copyFileSync: '`copyFile`',
  cpSync: '`copyFile` 逐个 / `walk`',
  realpathSync: '交给 `ctx.files` 的作用域校验（根目录限定并处理符号链接）；只做比较时用 `files/path.ts` 的 `isWithin`',
  openSync: '顺序读写用 `openRead` / `openWrite` 流；按偏移读写用 `openFile` 定位句柄',
  readSync: '`openRead` 流；按偏移读用 `openFile` 句柄的 `read(position, length)`',
  writeSync: '`openWrite` 流；按偏移写用 `openFile` 句柄的 `write(data, position)`',
  closeSync: '随流关闭 / `openFile` 句柄的 `close()`',
  fsyncSync: '`writeAtomic`（内部 fsync）/ `openFile` 句柄的 `sync()`',
  ftruncateSync: '`openFile` 句柄的 `truncate(size)`',
  truncateSync: '`writeBytes` 重写',
  chmodSync: '仅桌面',
  linkSync: '仅桌面',
  symlinkSync: '仅桌面',
  readlinkSync: '仅桌面',
  utimesSync: '仅桌面',
};
const SYNC = new Set(Object.keys(TARGET));

function* sourceFiles(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === '__tests__' || name === '__fixtures__' || name === 'equivalence') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

/** 文件里从 `node:fs` / `fs` 导入的本地名（默认、命名空间、具名）。 */
function fsBindings(sf) {
  const namespaces = new Set();
  const named = new Map();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!['node:fs', 'fs'].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) named.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return { namespaces, named };
}

function functionName(fn) {
  if (ts.isConstructorDeclaration(fn)) return 'constructor';
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name))) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  if ((ts.isPropertyAssignment(fn.parent) || ts.isPropertyDeclaration(fn.parent)) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
}

/** 调用点所在的函数：`async` 取最内层函数；名字取最近的具名函数（匿名回调记作“X 内的回调”）。 */
function enclosingFunction(node, sf) {
  let inner = null;
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current) || ts.isFunctionTypeNode(current)) continue;
    inner ??= current;
    const name = functionName(current);
    if (name === undefined) continue;
    const line = sf.getLineAndCharacterOfPosition(current.getStart(sf)).line + 1;
    const async = Boolean(ts.getCombinedModifierFlags(inner) & ts.ModifierFlags.Async);
    return { name: inner === current ? name : `${name} 内的回调`, line, async };
  }
  if (inner === null) return null;
  const line = sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1;
  return { name: '<匿名函数>', line, async: Boolean(ts.getCombinedModifierFlags(inner) & ts.ModifierFlags.Async) };
}

function analyze(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { namespaces, named } = fsBindings(sf);
  if (namespaces.size === 0 && named.size === 0) return null;
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let fn;
      if (ts.isIdentifier(callee) && named.has(callee.text)) fn = named.get(callee.text);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)) fn = callee.name.text;
      if (fn && SYNC.has(fn)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        calls.push({ fn, line, scope: enclosingFunction(node, sf) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls.length === 0 ? null : { rel, plugin: rel.split('/')[2], calls };
}

function pluginPlatforms(plugin) {
  const index = ['index.ts', 'index.tsx'].map((name) => path.join(PLUGINS, plugin, name)).find((file) => fs.existsSync(file));
  return index ? declaredPlatforms(fs.readFileSync(index, 'utf8')) : null;
}

function plan(entry) {
  const inSync = entry.calls.filter((call) => call.scope && !call.scope.async);
  const atModule = entry.calls.filter((call) => call.scope === null);
  const functions = [...new Map(inSync.map((call) => [`${call.scope.name}:${call.scope.line}`, call.scope])).values()];
  let kind;
  if (atModule.length > 0) kind = 'module';
  else if (functions.length > 0) kind = 'helper';
  else kind = 'await';
  return { kind, functions, atModule };
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const entries = [...sourceFiles(PLUGINS)].map(analyze).filter(Boolean).sort((a, b) => a.rel.localeCompare(b.rel));
  const byPlugin = new Map();
  for (const entry of entries) byPlugin.set(entry.plugin, [...(byPlugin.get(entry.plugin) ?? []), entry]);
  const fnCount = new Map();
  for (const entry of entries) for (const call of entry.calls) fnCount.set(call.fn, (fnCount.get(call.fn) ?? 0) + 1);
  const totals = { await: 0, helper: 0, module: 0 };
  const lines = [];
  for (const [plugin, list] of [...byPlugin].sort((a, b) => a[0].localeCompare(b[0]))) {
    const platforms = pluginPlatforms(plugin);
    const core = MOBILE_CORE.includes(plugin);
    const disposition = platforms && !platforms.includes('mobile') && platforms.includes('desktop') && platforms.length === 1 && !core
      ? '已声明仅桌面：保留 `node:fs`'
      : core ? '移动端核心：必须迁到 `ctx.files`' : '非核心：迁到 `ctx.files`，或声明 `platforms: [\'desktop\']` 后保留';
    lines.push(`\n### ${plugin}（${list.length} 个文件；${disposition}）\n`);
    lines.push('| 文件 | 调用 | 方案 |');
    lines.push('|---|---|---|');
    for (const entry of list) {
      const p = plan(entry);
      totals[p.kind] += 1;
      const fns = [...new Set(entry.calls.map((call) => call.fn))].map((fn) => `\`${fn}\`×${entry.calls.filter((call) => call.fn === fn).length}`).join(' ');
      let how;
      if (p.kind === 'await') how = '全部在 async 函数里：逐个换成 `await ctx.files.*`';
      else if (p.kind === 'helper') how = `同步函数 ${p.functions.map((f) => `\`${f.name}\`(L${f.line})`).join('、')} 改为 async，调用方加 \`await\``;
      else how = `模块加载期调用（L${p.atModule.map((call) => call.line).join(',')}）：移到插件 \`apply\` / 首次使用时异步初始化`;
      lines.push(`| \`${entry.rel.replace('host/plugins/', '')}\` | ${fns} | ${how} |`);
    }
  }
  const header = [
    '# 同步 fs 调用方与迁移方案',
    '',
    `由 \`node scripts/portability/sync-fs-plan.mjs --out scripts/portability/SYNC-FS-PLAN.md\` 生成；只统计 \`host/plugins\` 生产代码里对 \`node:fs\` 同步函数的调用（不含测试与 \`equivalence/\`）。`,
    '',
    '## 结论：不提供同步 `ctx.files`',
    '',
    '- 移动端的文件后端（OPFS、Capacitor Filesystem）目录操作只有异步接口：OPFS 的同步访问句柄只能在已打开的单个文件上读写，`exists` / `mkdir` / `readDir` / `rm` / `rename` 都必须 `await`；Capacitor 插件只在主线程、只有 Promise 接口。同步接口在移动端只能靠预读缓存伪造，会和实际文件状态不一致。',
    '- 桌面上同步 I/O 阻塞 Host 所在线程，所有插件的请求都会排队。',
    '- 异步 `ctx.files` 两端都有实现：桌面 `host/platform/files/index.ts`，移动端 `host/platform/files/opfs.ts`（`mobile.json` 已装配，与桌面跑同一套一致性用例，含真实浏览器 Worker）。迁到 `ctx.files` 的调用点在移动端可以直接运行。',
    `- 迁到异步的工作量主要在调用链上：${totals.helper} 个文件的调用点在同步函数里，要把这些函数改成 async 并沿调用方加 \`await\`；只有 ${totals.await} 个文件可以直接替换。已声明仅桌面的插件（如 backup）保留 \`node:fs\`，不在迁移范围。`,
    '',
    '## 对应关系',
    '',
    '| 同步函数 | 调用点数 | 异步 `ctx.files` 做法 |',
    '|---|---|---|',
    ...[...fnCount].sort((a, b) => b[1] - a[1]).map(([fn, count]) => `| \`${fn}\` | ${count} | ${TARGET[fn]} |`),
    '',
    '## 汇总',
    '',
    `- 文件 ${entries.length} 个，调用点 ${entries.reduce((sum, entry) => sum + entry.calls.length, 0)} 个。`,
    `- 全部在 async 函数里（直接换 \`await\`）：${totals.await} 个文件；需要把同步 helper 改成 async：${totals.helper} 个；有模块加载期调用：${totals.module} 个。`,
    '',
    '## 逐文件方案',
  ];
  const output = `${[...header, ...lines].join('\n')}\n`;
  if (outIndex >= 0) fs.writeFileSync(path.resolve(args[outIndex + 1]), output);
  else process.stdout.write(output);
}

main();
