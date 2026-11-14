#!/usr/bin/env node
// 业务插件可移植性扫描（W14）。统计 host/plugins/<插件>/ 对 Node 专有模块、原生模块、Node 专用包与
// Node 全局量的依赖，按插件给出迁移工作量估计，并可对照白名单基线只报告新增问题。
//
// 用法：
//   node scripts/portability/scan.mjs                       控制台摘要
//   node scripts/portability/scan.mjs --json out.json       写完整 JSON（`--json -` 输出到 stdout）
//   node scripts/portability/scan.mjs --report out.md       写可读报告
//   node scripts/portability/scan.mjs --check               对照基线，有新增问题时退出 1；同时检查移动端 profile
//                                                           （存在 host/profiles/mobile.json 时，`--no-profile` 跳过）
//   node scripts/portability/scan.mjs --write-baseline      用当前状态重写基线（只应在依赖减少后运行）
//   node scripts/portability/scan.mjs --mobile-readiness    每个插件入口的运行时闭包能否装进移动端，列出阻塞来源
//   node scripts/portability/scan.mjs --profile host/profiles/mobile.json
//                                                           profile 中每个模块的运行时闭包不得触达 Node
// 选项：--baseline <file>（默认 scripts/portability/baseline.json）、--plugins a,b、--include-tests、
//       --no-transitive、--no-profile、--root <仓库根>。
// 判定规则（仅桌面插件的豁免、profile 检查的范围）见 README.md。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOBILE_CORE, NODE_GLOBALS, NODE_MODULES, SYNC_CALL_WEIGHT, TYPE_ONLY_FACTOR, UNITS_PER_DAY,
  buildBaseline, checkProfileClosure, compareWithBaseline, mobileReadiness, scanPlugins,
} from './lib/portability.mjs';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = { transitive: true, includeTests: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--json') options.json = value();
    else if (arg === '--report') options.report = value();
    else if (arg === '--baseline') options.baseline = value();
    else if (arg === '--check') options.check = true;
    else if (arg === '--write-baseline') options.writeBaseline = true;
    else if (arg === '--profile') options.profile = value();
    else if (arg === '--plugins') options.plugins = value().split(',').map((name) => name.trim()).filter(Boolean);
    else if (arg === '--include-tests') options.includeTests = true;
    else if (arg === '--no-transitive') options.transitive = false;
    else if (arg === '--no-profile') options.noProfile = true;
    else if (arg === '--mobile-readiness') options.readiness = true;
    else if (arg === '--root') options.root = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function gitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function moduleLabel(key) {
  return key.replace(/^node-builtin(-type)?:/, (_, type) => (type ? 'type node:' : 'node:'))
    .replace(/^node-global(-type)?:/, (_, type) => (type ? 'type 全局 ' : '全局 '))
    .replace(/^native(-type)?:/, (_, type) => (type ? 'type 原生 ' : '原生 '))
    .replace(/^node-package(-type)?:/, (_, type) => (type ? 'type 包 ' : '包 '));
}

function replacementOf(key) {
  const [rule, module] = key.split(':');
  if (rule.startsWith('node-builtin')) return NODE_MODULES[module]?.replacement ?? '按需评估';
  if (rule.startsWith('node-global')) return NODE_GLOBALS[module]?.replacement ?? '';
  if (rule.startsWith('native')) return '平台服务或仅桌面';
  return 'ctx.http / 仅桌面';
}

function tierOf(key) {
  const [rule, module] = key.split(':');
  if (rule.startsWith('node-builtin')) return NODE_MODULES[module]?.tier ?? 'web-standard';
  if (rule.startsWith('node-global')) return NODE_GLOBALS[module]?.tier ?? 'web-standard';
  if (rule.startsWith('native')) return 'desktop-only';
  return /jsdom|chokidar/.test(module) ? 'desktop-only' : 'service';
}

const SUGGESTIONS = {
  migrate: '迁到平台服务',
  'split-or-desktop-only': '拆出桌面部分或声明仅桌面',
  'declared-desktop-only': '已声明仅桌面',
};

export function renderReport(scan, { head, comparison, baselinePath } = {}) {
  const s = scan.summary;
  const lines = [];
  lines.push('# 业务插件可移植性报告', '');
  lines.push(`生成：\`node scripts/portability/scan.mjs --report\`${head ? `，提交 \`${head}\`` : ''}。只统计生产代码（不含测试、夹具）。`, '');
  lines.push('## 总览', '');
  lines.push(`- 插件 ${s.plugins} 个，生产源文件 ${s.files} 个。`);
  lines.push(`- 不 import 任何 Node 专有模块 / 原生模块 / Node 专用包的文件：${s.cleanFiles}（${s.cleanPercent}%）。`);
  lines.push(`- 运行时可移植的文件（另外也不在值位置使用 \`Buffer\`、\`process\` 等 Node 全局量；\`import type\` 不计）：${s.runtimePortableFiles}（${s.runtimePortablePercent}%）。`);
  lines.push(`- 有 Node 依赖的文件里的同步调用（\`*Sync(\`）：${s.syncCalls} 处。`);
  lines.push(`- 估算总工作量：${s.effort.units} 单位 ≈ ${s.effort.days} 人日（1 单位 ≈ 15 分钟，含测试；1 人日 = ${UNITS_PER_DAY} 单位）。`);
  lines.push('');
  lines.push(`估算口径：每个文件对每种依赖计一次权重（如 \`node:fs\` 3、\`node:crypto\` 1、\`node:path\` 0.5、\`child_process\` 5），`
    + `类型依赖乘 ${TYPE_ONLY_FACTOR}，有运行时依赖的文件每个 \`*Sync(\` 调用另加 ${SYNC_CALL_WEIGHT}（同步改异步会沿调用链扩散）。`
    + '权重见 `scripts/portability/lib/portability.mjs`，只用于排序与粗估。', '');

  lines.push('## 依赖分布（按文件数）', '');
  lines.push('| 依赖 | 文件数 | 类别 | 替代方案 |', '|---|---:|---|---|');
  for (const [key, count] of Object.entries(s.byModule)) {
    lines.push(`| ${moduleLabel(key)} | ${count} | ${tierOf(key)} | ${replacementOf(key)} |`);
  }
  lines.push('', '类别：`service` = 改走平台服务；`desktop-only` = 移动端无等价物（声明仅桌面或下沉到桌面平台服务）；`web-standard` = 用标准 Web API 或纯函数替代。', '');

  lines.push('## 按插件排序的迁移工作量', '');
  lines.push('| # | 插件 | 学习伴侣 | 声明平台 | 文件 | 无 Node import | 运行时可移植 | 主要依赖（文件数） | 同步调用 | 工作量（单位 / 人日） | 建议 |');
  lines.push('|---:|---|:---:|---|---:|---:|---:|---|---:|---:|---|');
  scan.plugins.forEach((plugin, index) => {
    const top = Object.entries(plugin.modules).filter(([key]) => !key.includes('-type:')).sort(([, a], [, b]) => b - a).slice(0, 4)
      .map(([key, count]) => `${moduleLabel(key)} ${count}`).join('、') || '—';
    const pct = (count) => (plugin.files === 0 ? '—' : `${Math.round((count / plugin.files) * 100)}%`);
    lines.push(`| ${index + 1} | ${plugin.name} | ${plugin.mobileCore ? '✓' : ''} | ${plugin.declaredPlatforms ? plugin.declaredPlatforms.join(', ') : '（缺省 desktop）'} | ${plugin.files} | ${pct(plugin.cleanFiles)} | ${pct(plugin.runtimePortableFiles)} | ${top} | ${plugin.syncCalls} | ${plugin.effort.units} / ${plugin.effort.days} | ${SUGGESTIONS[plugin.suggestion]} |`);
  });
  lines.push('');

  const core = scan.plugins.filter((plugin) => plugin.mobileCore);
  if (core.length > 0) {
    const units = core.reduce((sum, plugin) => sum + plugin.effort.units, 0);
    lines.push(`学习伴侣范围（${MOBILE_CORE.join('、')}）合计约 ${Math.round(units * 100) / 100} 单位 ≈ ${Math.round((units / UNITS_PER_DAY) * 100) / 100} 人日。`, '');
  }

  const candidates = scan.plugins.filter((plugin) => plugin.desktopOnlySignals.length > 0);
  if (candidates.length > 0) {
    lines.push('## 仅桌面候选（含移动端无等价物的依赖）', '');
    for (const plugin of candidates) lines.push(`- **${plugin.name}**：${plugin.desktopOnlySignals.map(moduleLabel).join('、')}`);
    lines.push('');
  }

  const gatewayUse = new Map();
  for (const plugin of scan.plugins) {
    for (const gateway of plugin.gateways) {
      const entry = gatewayUse.get(gateway.file) ?? { plugins: [], modules: gateway.modules };
      entry.plugins.push(plugin.name);
      gatewayUse.set(gateway.file, entry);
    }
  }
  if (gatewayUse.size > 0) {
    lines.push('## 传递依赖：插件外的哪些模块把 Node 带进来', '');
    lines.push('插件以值导入（非 `import type`）引用的插件外文件，其运行时闭包里含 Node 专有依赖。即使插件本身干净，经由这些入口仍会在移动端加载失败。', '');
    lines.push('| 插件外模块 | 引用它的插件数 | 闭包内的 Node 依赖 |', '|---|---:|---|');
    const rows = [...gatewayUse.entries()].sort(([, a], [, b]) => b.plugins.length - a.plugins.length).slice(0, 25);
    for (const [file, entry] of rows) {
      lines.push(`| \`${file}\` | ${entry.plugins.length} | ${entry.modules.map(moduleLabel).join('、')} |`);
    }
    lines.push('');
  }

  if (comparison) {
    lines.push(`## 与基线比较（\`${baselinePath}\`）`, '');
    lines.push(`新增 ${comparison.added.length} 条，已消除 ${comparison.resolved.length} 条。`, '');
    for (const entry of comparison.added) lines.push(`- 新增 \`${entry.file}:${entry.line}\` ${moduleLabel(entry.key)} → ${entry.replacement}`);
    if (comparison.resolved.length > 0) lines.push('', '已消除的条目可运行 `node scripts/portability/scan.mjs --write-baseline` 收紧基线。');
    lines.push('');
  }
  return lines.join('\n');
}

function printSummary(scan) {
  const s = scan.summary;
  process.stdout.write(`portability: ${s.plugins} plugins, ${s.files} production files; `
    + `${s.cleanFiles} (${s.cleanPercent}%) without Node-specific imports, `
    + `${s.runtimePortableFiles} (${s.runtimePortablePercent}%) runtime-portable; effort ≈ ${s.effort.days} person-days\n`);
  for (const plugin of scan.plugins) {
    process.stdout.write(`  ${plugin.name.padEnd(20)} files=${String(plugin.files).padStart(4)} clean=${String(plugin.cleanFiles).padStart(4)} `
      + `effort=${String(plugin.effort.units).padStart(7)} (${plugin.effort.days}d) ${plugin.suggestion}\n`);
  }
}

/** profile 中每个模块的运行时闭包不得触达 Node 专有依赖；返回是否全部通过。 */
function checkProfile(root, profile) {
  const results = checkProfileClosure(root, profile);
  let failed = 0;
  for (const result of results) {
    if (result.violations.length === 0) {
      process.stdout.write(`ok   ${result.id} (${result.module})\n`);
      continue;
    }
    failed += 1;
    process.stdout.write(`FAIL ${result.id} (${result.module})\n`);
    for (const violation of result.violations) process.stdout.write(`       ${violation.file}:${violation.line} ${moduleLabel(violation.key)}\n`);
  }
  process.stdout.write(`profile ${profile}: ${results.length} module(s), ${failed} reach Node-specific dependencies at runtime\n`);
  return failed === 0;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const root = path.resolve(options.root ?? SCRIPT_ROOT);

  if (options.profile) {
    if (!checkProfile(root, options.profile)) process.exitCode = 1;
    return;
  }
  if (options.readiness) {
    const results = mobileReadiness(root, options);
    if (options.json) {
      const payload = `${JSON.stringify(results, null, 2)}\n`;
      if (options.json === '-') process.stdout.write(payload);
      else fs.writeFileSync(path.resolve(root, options.json), payload);
      return;
    }
    for (const result of results) {
      const platforms = result.declaredPlatforms ? result.declaredPlatforms.join(',') : '（缺省 desktop）';
      process.stdout.write(`${result.ready ? 'ready  ' : 'blocked'} ${result.name.padEnd(22)} platforms=${platforms} own=${result.own.length} gateways=${result.gateways.length}\n`);
      for (const gateway of result.gateways) {
        process.stdout.write(`          via ${gateway.file} → ${gateway.reaches.length} file(s): ${gateway.reaches.slice(0, 3).join(', ')}${gateway.reaches.length > 3 ? ' …' : ''}\n`);
      }
    }
    return;
  }

  const scan = scanPlugins(root, options);
  const baselinePath = options.baseline ?? path.join('scripts', 'portability', 'baseline.json');
  const baselineAbs = path.resolve(root, baselinePath);
  const previous = fs.existsSync(baselineAbs) ? JSON.parse(fs.readFileSync(baselineAbs, 'utf8')) : undefined;
  let comparison;
  if (options.check) {
    if (!previous) throw new Error(`baseline ${baselinePath} not found; run with --write-baseline first`);
    comparison = compareWithBaseline(scan, previous);
  }
  if (options.writeBaseline) {
    fs.mkdirSync(path.dirname(baselineAbs), { recursive: true });
    fs.writeFileSync(baselineAbs, `${JSON.stringify(buildBaseline(scan, previous), null, 2)}\n`);
  }
  const head = gitHead(root);
  if (options.json) {
    const payload = `${JSON.stringify({ head, summary: scan.summary, plugins: scan.plugins, files: scan.files, ...(comparison ? { comparison } : {}) }, null, 2)}\n`;
    if (options.json === '-') process.stdout.write(payload);
    else fs.writeFileSync(path.resolve(root, options.json), payload);
  }
  if (options.report) fs.writeFileSync(path.resolve(root, options.report), `${renderReport(scan, { head, comparison, baselinePath })}\n`);
  if (options.json !== '-') printSummary(scan);
  if (comparison) {
    for (const entry of comparison.added) {
      const shared = entry.sharedWith ? ` （仅桌面插件的共享面：经 ${entry.sharedWith} 在运行时可达，不豁免）` : '';
      process.stdout.write(`NEW ${entry.file}:${entry.line} ${moduleLabel(entry.key)} → ${entry.replacement}${shared}\n`);
    }
    process.stdout.write(`baseline ${baselinePath}: ${comparison.added.length} new, ${comparison.resolved.length} resolved\n`);
    if (comparison.added.length > 0) process.exitCode = 1;
    const mobileProfile = path.join('host', 'profiles', 'mobile.json');
    if (!options.noProfile && fs.existsSync(path.resolve(root, mobileProfile)) && !checkProfile(root, mobileProfile)) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
