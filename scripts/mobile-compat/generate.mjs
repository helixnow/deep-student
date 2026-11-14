#!/usr/bin/env node
/**
 * 生成移动端「已注册但不支持」命令表（`host/plugins/mobile-compat/commands.ts`）。
 *
 * 移动端 Host 只装配运行时闭包不含 Node 依赖的插件（`scripts/portability/scan.mjs --profile`）。
 * 桌面独占插件的命令在移动端没有任何注册者，kernel 对未注册命令的回复在 release 构建里是
 * `Command <name> not allowed by ACL`——用户看到的像权限故障。`dstu.mobile.compat` 为这些命令
 * 注册明确的 `UNSUPPORTED_ON_PLATFORM` 处理函数。
 *
 * 集合定义：
 *   stubs = (Rust `allow-application-commands` ∩ `contracts/ipc` 的命令) − 其它移动端插件的 `meta.commands`
 *
 * 用法：
 *   node scripts/mobile-compat/generate.mjs          重写 commands.ts
 *   node scripts/mobile-compat/generate.mjs --check  只比较，漂移时退出 1（CI / 单测用）
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = 'host/plugins/mobile-compat/commands.ts';
const PERMISSIONS = 'resources/app/permissions/application-commands.toml';
const IDENTIFIER = 'allow-application-commands';

/** `resources/app/permissions/*.toml` 中 `identifier` 的 `commands.allow`（与 kernel / mobile vite config 同一读法）。 */
export function rustAppCommands(root = SCRIPT_ROOT) {
  const file = join(root, PERMISSIONS);
  const text = readFileSync(file, 'utf8');
  const out = new Set();
  for (const block of text.split('[[permission]]').slice(1)) {
    if (block.match(/^identifier\s*=\s*"([^"]+)"/m)?.[1] !== IDENTIFIER) continue;
    const body = block.match(/commands\.allow\s*=\s*\[([^\]]*)\]/s)?.[1] ?? '';
    for (const match of body.matchAll(/"([^"\n]+)"/g)) out.add(match[1]);
  }
  return out;
}

/** `contracts/ipc/*.json` 的命令名（移动端 Worker 只带这些契约）。 */
export function contractCommands(root = SCRIPT_ROOT) {
  const dir = join(root, 'contracts/ipc');
  const out = new Set();
  for (const name of readdirSync(dir).filter(file => file.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    for (const command of parsed.commands ?? []) out.add(command.name);
  }
  return out;
}

/** 移动端 profile 中**除** `dstu.mobile.compat` 外所有插件声明的命令。 */
export async function declaredByMobilePlugins(root = SCRIPT_ROOT) {
  const profile = JSON.parse(readFileSync(join(root, 'host/profiles/mobile.json'), 'utf8'));
  const dir = join(root, 'host/profiles');
  const out = new Set();
  for (const entry of profile.plugins) {
    if (entry.id === 'dstu.mobile.compat') continue;
    const module = await import(pathToFileURL(join(dir, entry.module)).href);
    for (const name of module.default?.meta?.commands ?? []) out.add(name);
  }
  return out;
}

/** 需要 `dstu.mobile.compat` 占位的命令（排序）。 */
export async function compatCommands(root = SCRIPT_ROOT) {
  const allowed = rustAppCommands(root);
  const contracts = contractCommands(root);
  const declared = await declaredByMobilePlugins(root);
  return [...allowed]
    .filter(name => contracts.has(name) && !declared.has(name))
    .sort();
}

/** 渲染 `commands.ts` 原文。 */
export function render(commands) {
  const lines = commands.map(name => `  ${JSON.stringify(name)},`).join('\n');
  return `/**
 * 移动端「已注册但不支持」命令表——由 \`node scripts/mobile-compat/generate.mjs\` 生成，请勿手改。
 *
 * 集合 = (Rust \`allow-application-commands\` ∩ \`contracts/ipc\`) − 其它移动端插件的 \`meta.commands\`。
 * \`host/plugins/mobile-compat/tests/commands.test.ts\` 守护它与 profile / 契约 / Rust 允许表一致。
 */
export const COMPAT_COMMANDS = [
${lines}
] as const;
`;
}

async function main() {
  const check = process.argv.includes('--check');
  const commands = await compatCommands();
  const next = render(commands);
  const target = join(SCRIPT_ROOT, OUTPUT);
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== next) {
      process.stderr.write(`${OUTPUT} is out of date; run \`node scripts/mobile-compat/generate.mjs\`\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${OUTPUT} is up to date (${commands.length} commands)\n`);
    return;
  }
  writeFileSync(target, next);
  process.stdout.write(`${OUTPUT}: ${commands.length} commands\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
