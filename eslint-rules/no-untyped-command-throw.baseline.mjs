#!/usr/bin/env node
/**
 * `ds-host/no-untyped-command-throw` 的统计与基线维护（规则说明见 no-untyped-command-throw.js）。
 *
 * 用法（仓库根目录）：
 *   node eslint-rules/no-untyped-command-throw.baseline.mjs            # 按插件汇总现存违规，并与基线比较
 *   node eslint-rules/no-untyped-command-throw.baseline.mjs --json     # 机器可读：{ files, byOwner, total }
 *   node eslint-rules/no-untyped-command-throw.baseline.mjs --update   # 收紧基线与无守卫名单；任何上涨即拒绝
 *   node eslint-rules/no-untyped-command-throw.baseline.mjs --update --allow-increase
 *   node eslint-rules/no-untyped-command-throw.baseline.mjs --inventory  # 按归属列出错误出口与动态守卫（工作单，Markdown 表）
 *
 * host 测试 `host/kernel/tests/command-error-lint.test.ts` 用同一入口 {@link lintCommandThrows} 守护棘轮，
 * 并用 {@link commandErrorInventory} + `command-error-settle.json` 守护“有 bare 处理函数的归属要有动态守卫”。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import rule, { BASELINE_PATH, REPO_ROOT, inventoryRule } from './no-untyped-command-throw.js';

export const LINTED = ['host/**/*.ts', 'electron/**/*.ts'];
export const IGNORED = ['**/tests/**', '**/*.test.ts', '**/__fixtures__/**', '**/node_modules/**', 'host/e2e/**'];

/** 只启用本规则的 ESLint（不读 eslint.config.js，避免前端规则与 host 文件互相干扰）。 */
export function commandThrowLinter({ baseline = true, cwd = REPO_ROOT } = {}) {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: IGNORED },
      {
        files: ['**/*.ts'],
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { 'ds-host': { rules: { 'no-untyped-command-throw': rule } } },
        rules: { 'ds-host/no-untyped-command-throw': ['error', { baseline }] },
      },
    ],
  });
}

/** 运行规则；`baseline: false` 时返回全部违规。结果：文件（相对仓库根）→ 违规行号。 */
export async function lintCommandThrows({ baseline = true, patterns = LINTED, cwd = REPO_ROOT } = {}) {
  const results = await commandThrowLinter({ baseline, cwd }).lintFiles(patterns);
  const files = {};
  const fatal = [];
  for (const result of results) {
    const rel = path.relative(cwd, result.filePath).split(path.sep).join('/');
    for (const message of result.messages) {
      if (message.fatal) fatal.push(`${rel}:${message.line} ${message.message}`);
      else if (message.ruleId === 'ds-host/no-untyped-command-throw') (files[rel] ??= []).push(message.line);
    }
  }
  return { files, fatal };
}

/** 文件归属：`host/plugins/<name>`、`host/platform/<name>`、`host/kernel`、`electron`。 */
export function ownerOf(file) {
  const parts = file.split('/');
  if (parts[0] === 'host' && (parts[1] === 'plugins' || parts[1] === 'platform')) return `${parts[0]}/${parts[1]}/${parts[2]}`;
  if (parts[0] === 'host') return `host/${parts[1]}`;
  return parts[0];
}

export function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function sorted(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * 动态守卫登记（host/kernel/API.md §2.3.1）：`guards` 是归属 → 守卫测试文件（手工维护），`unguarded` 是
 * 有 bare 处理函数却没有守卫的归属（`--update` 生成，只减不增）。
 */
export const SETTLE_GUARDS_PATH = path.join(REPO_ROOT, 'eslint-rules', 'command-error-settle.json');

export function readSettleGuards(file = SETTLE_GUARDS_PATH) {
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  return { guards: ledger.guards ?? {}, unguarded: ledger.unguarded ?? [] };
}

/** 有 bare 处理函数、且 `guards` 里没有动态守卫的归属（排序）。 */
export function unguardedOwners(owners, guards) {
  return Object.entries(owners).filter(([owner, row]) => row.bare > 0 && !guards[owner]).map(([owner]) => owner).sort();
}

const IMPORT_SPECIFIER = /(?:import|export)\s[^'"]*?from\s+'([^']+)'|import\s*\(\s*'([^']+)'\s*\)/g;

/**
 * 守卫文件是否像一个动态守卫：存在、名为 `command-error-settle*.test.ts`、导入了 `owner` 下的非测试模块，
 * 并从 kernel/testing.ts 取 `unsettledCommandErrors`（或旧写法 `HandlerPanic`）。返回问题描述，没问题为 null。
 */
export function settleGuardProblem(owner, file, cwd = REPO_ROOT) {
  const full = path.join(cwd, file);
  if (!existsSync(full)) return `${owner}: guard ${file} does not exist`;
  if (!/^command-error-settle[\w.-]*\.test\.ts$/.test(path.basename(file))) return `${owner}: guard ${file} must be named command-error-settle*.test.ts`;
  const source = readFileSync(full, 'utf8');
  const ownerDir = path.join(cwd, owner) + path.sep;
  let importsOwner = false;
  let usesKernelGuard = false;
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const spec = match[1] ?? match[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(full), spec);
    const rel = path.relative(cwd, target).split(path.sep).join('/');
    if (target.startsWith(ownerDir) && !/(^|\/)(tests|__fixtures__)\//.test(rel) && !/\.test\.ts$/.test(rel)) importsOwner = true;
    if (rel === 'host/kernel/testing.ts' && /\b(unsettledCommandErrors|HandlerPanic)\b/.test(match[0])) usesKernelGuard = true;
  }
  if (!importsOwner) return `${owner}: guard ${file} does not import any module of ${owner}`;
  if (!usesKernelGuard) return `${owner}: guard ${file} does not use unsettledCommandErrors from host/kernel/testing.ts`;
  return null;
}

/**
 * 工作单：按归属统计命令处理函数的错误出口（classified / imported / bare）和源码里未分类 throw 的总数。
 * bare 是静态启发式：处理函数调用的跨文件服务即使内部已 catch 并分类也会算进来，所以它只是候选，
 * 不是棘轮；有动态守卫（`command-error-settle.json`）的归属以守卫结果为准。
 */
export async function commandErrorInventory({ cwd = REPO_ROOT } = {}) {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: IGNORED },
      {
        files: ['**/*.ts'],
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { 'ds-host': { rules: { inventory: inventoryRule } } },
        rules: { 'ds-host/inventory': 'warn' },
      },
    ],
  });
  const owners = {};
  for (const result of await eslint.lintFiles(LINTED)) {
    const owner = ownerOf(path.relative(cwd, result.filePath).split(path.sep).join('/'));
    for (const message of result.messages) {
      if (message.ruleId !== 'ds-host/inventory') continue;
      const row = (owners[owner] ??= { handlers: 0, classified: 0, imported: 0, bare: 0, bareThrows: 0 });
      if (message.messageId === 'bareThrow') row.bareThrows += 1;
      else { row.handlers += 1; row[message.message] += 1; }
    }
  }
  return owners;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--inventory')) {
    const owners = await commandErrorInventory();
    const { guards } = readSettleGuards();
    const open = (owner, row) => (guards[owner] ? 0 : row.bare);
    const rows = Object.entries(owners).filter(([, row]) => row.handlers > 0)
      .sort((a, b) => open(b[0], b[1]) - open(a[0], a[1]) || b[1].bare - a[1].bare || b[1].handlers - a[1].handlers);
    process.stdout.write('| 归属 | 命令处理函数 | classified | imported | bare（静态） | 动态守卫 | 源码未分类 throw |\n|---|---:|---:|---:|---:|---|---:|\n');
    for (const [owner, r] of rows) {
      process.stdout.write(`| \`${owner}\` | ${r.handlers} | ${r.classified} | ${r.imported} | ${r.bare} | ${guards[owner] ? `\`${guards[owner]}\`` : r.bare > 0 ? '**缺**' : '—'} | ${r.bareThrows} |\n`);
    }
    process.stdout.write('\nbare 是静态启发式（调用的跨文件服务内部已分类也会算进来）；有动态守卫的归属以守卫结果为准，没有的按 bare 降序排在前面。\n');
    return;
  }
  const { files, fatal } = await lintCommandThrows({ baseline: false });
  if (fatal.length) {
    process.stderr.write(`ESLint could not parse:\n${fatal.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const counts = sorted(Object.fromEntries(Object.entries(files).map(([file, lines]) => [file, lines.length])));
  const byOwner = {};
  for (const [file, count] of Object.entries(counts)) byOwner[ownerOf(file)] = (byOwner[ownerOf(file)] ?? 0) + count;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const baseline = readBaseline();
  const increases = Object.entries(counts).filter(([file, count]) => count > (baseline[file] ?? 0));

  if (args.has('--update')) {
    const ledger = JSON.parse(readFileSync(SETTLE_GUARDS_PATH, 'utf8'));
    const unguarded = unguardedOwners(await commandErrorInventory(), ledger.guards ?? {});
    const newlyUnguarded = unguarded.filter(owner => !(ledger.unguarded ?? []).includes(owner));
    if ((increases.length || newlyUnguarded.length) && !args.has('--allow-increase')) {
      const lines = [
        ...increases.map(([f, n]) => `  ${f}: ${baseline[f] ?? 0} -> ${n}`),
        ...newlyUnguarded.map(owner => `  ${owner}: bare command handlers without a dynamic guard (add one to command-error-settle.json)`),
      ];
      process.stderr.write(`refusing to raise the baseline:\n${lines.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify({
      $comment: 'Generated by node eslint-rules/no-untyped-command-throw.baseline.mjs --update; counts only go down.',
      total,
      files: counts,
    }, null, 2)}\n`);
    writeFileSync(SETTLE_GUARDS_PATH, `${JSON.stringify({ ...ledger, unguarded }, null, 2)}\n`);
    process.stdout.write(`baseline written: ${total} violations in ${Object.keys(counts).length} files; ${unguarded.length} owners without a dynamic guard\n`);
    return;
  }
  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify({ total, byOwner: sorted(byOwner), files: counts }, null, 2)}\n`);
    return;
  }
  for (const [owner, count] of Object.entries(byOwner).sort((a, b) => b[1] - a[1])) process.stdout.write(`${String(count).padStart(5)}  ${owner}\n`);
  process.stdout.write(`${String(total).padStart(5)}  total\n`);
  if (increases.length) {
    process.stdout.write(`\nabove baseline:\n${increases.map(([f, n]) => `  ${f}: ${baseline[f] ?? 0} -> ${n}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
