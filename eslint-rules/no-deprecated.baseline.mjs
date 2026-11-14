#!/usr/bin/env node
/**
 * `@typescript-eslint/no-deprecated` 的棘轮（插件生态 v1 P0）：host / electron 代码不得新增对 `@deprecated`
 * 接口的使用。kernel 的不兼容变更先给旧接口标 `@deprecated` 保留一个发布周期（host/kernel/API.md
 * 「稳定接口与弃用」），本脚本报出仍在使用的位置；现存用法按文件冻结在 no-deprecated.baseline.json。
 *
 * 需要类型信息（tsconfig.host.json 的完整程序），耗时数分钟、内存占用大，请经 bin/heavy 运行：
 *   bin/heavy node eslint-rules/no-deprecated.baseline.mjs                    # 与基线比较；有新增时退出 1
 *   bin/heavy node eslint-rules/no-deprecated.baseline.mjs --json             # 机器可读：{ files, total }
 *   bin/heavy node eslint-rules/no-deprecated.baseline.mjs --update           # 收紧基线；任何文件计数上涨即拒绝
 *   bin/heavy node eslint-rules/no-deprecated.baseline.mjs --update --allow-increase
 *   bin/heavy node eslint-rules/no-deprecated.baseline.mjs host/kernel        # 只检查给出的目录 / 文件
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = path.join(REPO_ROOT, 'eslint-rules', 'no-deprecated.baseline.json');
export const LINTED = ['host/**/*.ts', 'electron/**/*.ts'];
export const IGNORED = ['**/tests/**', '**/*.test.ts', '**/__fixtures__/**', '**/node_modules/**', 'host/e2e/**'];
const RULE = '@typescript-eslint/no-deprecated';

/** 只启用本规则的类型化 ESLint（不读 eslint.config.js）。 */
export function deprecatedLinter({ cwd = REPO_ROOT } = {}) {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: IGNORED },
      {
        files: ['**/*.ts'],
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        languageOptions: {
          parser: tseslint.parser,
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { project: ['./tsconfig.host.json'], tsconfigRootDir: cwd },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: { [RULE]: 'error' },
      },
    ],
  });
}

/** 运行规则。结果：文件（相对仓库根）→ `行号: 消息`。 */
export async function lintDeprecated({ patterns = LINTED, cwd = REPO_ROOT } = {}) {
  const results = await deprecatedLinter({ cwd }).lintFiles(patterns);
  const files = {};
  const fatal = [];
  for (const result of results) {
    const rel = path.relative(cwd, result.filePath).split(path.sep).join('/');
    for (const message of result.messages) {
      if (message.fatal) fatal.push(`${rel}:${message.line} ${message.message}`);
      else if (message.ruleId === RULE) (files[rel] ??= []).push(`${message.line}: ${message.message}`);
    }
  }
  return { files, fatal };
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

/** 与基线比较：`over` 是计数超过基线的文件，`stale` 是计数低于基线（可收紧）的文件。 */
export function compareWithBaseline(files, baseline) {
  const over = Object.entries(files)
    .filter(([file, uses]) => uses.length > (baseline[file] ?? 0))
    .map(([file, uses]) => ({ file, count: uses.length, baseline: baseline[file] ?? 0, uses }));
  const stale = Object.entries(baseline)
    .filter(([file, count]) => (files[file]?.length ?? 0) < count)
    .map(([file, count]) => ({ file, count: files[file]?.length ?? 0, baseline: count }));
  return { over, stale };
}

async function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const targets = argv.filter((arg) => !arg.startsWith('--'));
  const patterns = targets.length ? targets.map((target) => (target.endsWith('.ts') ? target : `${target.replace(/\/$/, '')}/**/*.ts`)) : LINTED;
  const { files, fatal } = await lintDeprecated({ patterns });
  if (fatal.length) {
    process.stderr.write(`no-deprecated: files the parser could not handle:\n${fatal.join('\n')}\n`);
    return 2;
  }
  const total = Object.values(files).reduce((sum, uses) => sum + uses.length, 0);
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ files: sorted(files), total }, null, 2)}\n`);
    return 0;
  }
  const baseline = readBaseline();
  if (flags.has('--update')) {
    if (targets.length) throw new Error('--update needs a full run (no path arguments)');
    const { over } = compareWithBaseline(files, baseline);
    if (over.length && !flags.has('--allow-increase')) {
      process.stderr.write(`no-deprecated: refusing to raise the baseline:\n${over.map(({ file, count, baseline: was }) => `  ${file}: ${was} → ${count}`).join('\n')}\n`);
      return 1;
    }
    const counts = sorted(Object.fromEntries(Object.entries(files).map(([file, uses]) => [file, uses.length])));
    writeFileSync(BASELINE_PATH, `${JSON.stringify({
      $comment: 'Existing uses of @deprecated APIs in host/ and electron/ (per file). Only shrink it: bin/heavy node eslint-rules/no-deprecated.baseline.mjs --update',
      files: counts,
    }, null, 2)}\n`);
    process.stdout.write(`no-deprecated: baseline written (${total} use(s) in ${Object.keys(counts).length} file(s))\n`);
    return 0;
  }
  const scoped = targets.length ? Object.fromEntries(Object.entries(baseline).filter(([file]) => patterns.some((pattern) => path.matchesGlob(file, pattern)))) : baseline;
  const { over, stale } = compareWithBaseline(files, scoped);
  for (const { file, count, baseline: was, uses } of over) process.stdout.write(`NEW  ${file}: ${count} (baseline ${was})\n${uses.map((use) => `       ${use}`).join('\n')}\n`);
  for (const { file, count, baseline: was } of stale) process.stdout.write(`TIGHTEN ${file}: ${count} (baseline ${was})\n`);
  process.stdout.write(`no-deprecated: ${total} use(s) in ${Object.keys(files).length} file(s); ${over.length} file(s) over the baseline, ${stale.length} below\n`);
  return over.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 2;
  });
}
