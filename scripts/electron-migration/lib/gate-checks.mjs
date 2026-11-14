// 集成门禁检查列表（集成与 lane 自检共用，保证两边判定一致）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 自该时刻起，合入 main 的边界门禁使用 strict 模式（console.* 与 void-only catch 也拦截）。
const STRICT_FROM = Date.parse(process.env.DSTU_STRICT_FROM ?? '2026-11-03T17:00:00Z');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();

/** 门禁检查项（与串行集成相同）。base 为对比基线。 */
export function gateChecks(cwd, base, { quick = false, tests = false } = {}) {
  const diff = git(cwd, 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const touched = [...new Set(diff.map((f) => /^(host\/(?:plugins|platform|e2e)\/[^/]+|host\/kernel)\//.exec(f)?.[1]).filter(Boolean))];
  const testDirs = touched.map((d) => `${d}/`);
  const changedSrc = git(cwd, 'diff', '--name-only', '--diff-filter=AM', base, 'HEAD').split('\n')
    .filter((f) => /^(host|electron)\/.*\.(ts|tsx|mts|mjs|js)$/.test(f) && fs.existsSync(path.join(cwd, f)));
  const strictEnv = { DSTU_BOUNDARY_STRICT: Date.now() >= STRICT_FROM ? '1' : '' };
  const checks = [
    { name: 'typecheck', bin: 'npx', args: ['tsc', '-p', 'tsconfig.host.json', '--incremental', '--tsBuildInfoFile', '.integration.tsbuildinfo'] },
    { name: 'boundaries', bin: process.execPath, args: ['scripts/electron-migration/boundaries.mjs'], env: { DSTU_BOUNDARY_STRICT: '' } },
  ];
  const changedApp = diff.filter((f) => f.startsWith('src/'));
  if (changedApp.length) {
    try {
      execFileSync('npm', ['run', '-s', 'version:generate'], { cwd, stdio: 'ignore', timeout: 120_000 });
    } catch {
      // 版本文件生成失败会在类型检查中暴露
    }
    checks.push({ name: 'typecheck:app', bin: 'npx', args: ['tsc', '--noEmit', '-p', 'tsconfig.json', '--incremental', '--tsBuildInfoFile', '.integration-app.tsbuildinfo'] });
  }
  // 前端字面量 invoke 的命令名/参数键必须在契约里（基线之外的新增问题才拦截）；前端或契约变动时都要复查。
  if (diff.some((f) => f.startsWith('src/') || f.startsWith('contracts/ipc/') || f.startsWith('scripts/electron-migration/gate-checks/frontend-invoke'))) {
    checks.push({ name: 'frontend-invoke', bin: process.execPath, args: ['scripts/electron-migration/gate-checks/frontend-invoke.mjs', '--check'] });
  }
  // 前端监听的事件名必须有发射点（基线之外的新增缺口才拦截）；监听方或发射方变动时都要复查。
  if (diff.some((f) => /^(src|host|electron)\//.test(f) || f.startsWith('scripts/electron-migration/gate-checks/event-emit'))) {
    checks.push({ name: 'event-emit', bin: process.execPath, args: ['scripts/electron-migration/gate-checks/event-emit.mjs', '--check'] });
  }
  // 前端内置技能的工具必须有官方 profile 装配出的执行器（基线之外的新增缺口才拦截）。
  if (diff.some((f) => /^(src\/features\/chat\/skills|host\/(plugins|kernel|profiles|e2e\/coverage))\//.test(f))) {
    checks.push({ name: 'agent-tool-coverage', bin: 'npx', args: ['vitest', 'run', '-c', 'vitest.host.config.ts', 'host/e2e/coverage/'] });
  }
  // 插件 api.ts 值导入闭包里的运行时导入环（会 TDZ）只拦新增；闭包会走进 host/platform、host/kernel，任何 host/ 变动都要复查。
  if (diff.some((f) => f.startsWith('host/') || f.startsWith('scripts/electron-migration/gate-checks/import-cycles'))) {
    checks.push({ name: 'import-cycles', bin: process.execPath, args: ['scripts/electron-migration/gate-checks/import-cycles.mjs', '--check'] });
  }
  if (diff.some((f) => /^(host|src\/ui-plugins|examples\/plugins|contracts\/plugin-manifest)\//.test(f) || f === 'package.json' || f.startsWith('scripts/electron-migration/gate-checks/plugin-manifest'))) {
    checks.push({ name: 'plugin-manifest', bin: process.execPath, args: ['scripts/electron-migration/gate-checks/plugin-manifest.mjs', '--check'] });
  }
  // FE-A4 前端边界棘轮：插件直连 @tauri-apps、平台模块外 UA 嗅探、裸 CustomEvent 只拦新增。
  if (diff.some((f) => f.startsWith('src/') || f.startsWith('scripts/electron-migration/gate-checks/ui-boundaries'))) {
    checks.push({ name: 'ui-boundaries', bin: process.execPath, args: ['scripts/electron-migration/gate-checks/ui-boundaries.mjs', '--check'] });
  }
  // §8 D5 硬编码用户文案棘轮：前端没走 i18n 的中英文文案按 规则+文件 计数，只拦新增。
  if (diff.some((f) => f.startsWith('src/') || f.startsWith('scripts/electron-migration/gate-checks/hardcoded-copy'))) {
    checks.push({ name: 'hardcoded-copy', bin: process.execPath, args: ['scripts/electron-migration/gate-checks/hardcoded-copy.mjs', '--check'] });
  }
  // W14 可移植性扫描（`--check` 的 NEW 与移动端 profile 运行时闭包）：base 与 HEAD 各扫一遍，只拦本次新引入的。
  // 闭包会走进 host/platform、host/kernel，任何 host/ 变动都要复查。扫描器/profile 路径可配置；工作树里没有扫描器时跳过。
  const scanner = process.env.DSTU_PORTABILITY_SCANNER ?? 'scripts/portability/scan.mjs';
  const mobileProfile = process.env.DSTU_PORTABILITY_PROFILE ?? 'host/profiles/mobile.json';
  const scannerDir = `${path.posix.dirname(scanner)}/`;
  if (fs.existsSync(path.join(cwd, scanner)) && diff.some((f) => f.startsWith('host/') || f.startsWith(scannerDir) || f.startsWith('scripts/electron-migration/gate-checks/portability'))) {
    checks.push({ name: 'portability', bin: process.execPath, args: ['scripts/electron-migration/gate-checks/portability.mjs', '--base', base, '--scanner', scanner, '--profile', mobileProfile] });
  }
  if (quick) {
    // 合并后的整体复核也跑相关目录的测试：各自通过、合在一起互相弄坏测试，正是 main 变红的来源
    if (tests && touched.length) checks.push({ name: 'tests', bin: 'npx', args: ['vitest', 'run', '-c', 'vitest.host.config.ts', ...testDirs] });
    return checks;
  }
  if (changedSrc.length) checks.push({ name: 'boundaries-strict(changed)', bin: process.execPath, args: ['scripts/electron-migration/boundaries.mjs', ...changedSrc], env: strictEnv });
  if (touched.length) {
    const entries = touched.map((d) => `${d}/index.ts`).filter((f) => fs.existsSync(path.join(cwd, f)));
    if (entries.length) checks.push({ name: 'importable', bin: process.execPath, args: ['scripts/electron-migration/importable.mjs', ...entries] });
    checks.push({ name: 'tests', bin: 'npx', args: ['vitest', 'run', '-c', 'vitest.host.config.ts', ...testDirs] });
  }
  if (changedApp.length) {
    const appDirs = [...new Set(changedApp.map((f) => f.split('/').slice(0, 3).join('/')).filter((d) => fs.existsSync(path.join(cwd, d))))];
    if (appDirs.length) checks.push({ name: 'tests:app', bin: 'npx', args: ['vitest', 'run', '--config', 'vitest.config.ts', '--passWithNoTests', ...appDirs] });
    // vite 构建峰值超过 Node 默认 4GB 堆（2026-11-04 实测 OOM），两个构建同时跑还会互相挤内存：
    // 加大堆，并标记 serial——同一工作树内先后跑，且占用全局构建槽（多个并行集成工作树之间限流）。
    const heap = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() };
    checks.push({ name: 'build', bin: 'npx', args: ['vite', 'build', '--outDir', '.integration-dist', '--emptyOutDir'], env: heap, serial: true });
    checks.push({ name: 'build:demo', bin: 'npx', args: ['vite', 'build', '--config', 'vite.demo.config.ts', '--outDir', '.integration-dist-demo', '--emptyOutDir'], env: heap, serial: true });
  }
  return checks;
}

