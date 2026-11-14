/**
 * 生成官方 profile（`host/profiles/desktop.json` 与 `host/profiles/mobile.json`）。
 *
 * 顺序：固定首条 `../kernel/plugins.ts`（`dstu.plugins`），随后 `host/platform/<name>/index.ts` 中
 * **默认导出插件**的条目（`time`/`util`/`net-policy`/`errors` 这类纯模块没有默认导出，跳过），
 * 再是 `electron/index.ts`（`dstu.shell`，提供 `startupGate` 并注册 F2 命令），
 * 最后 `host/plugins/<name>/index.ts`；独立入口仅按下方明确列表发现。
 * W13 的 storageStartupSync 提供方占用固定 bootstrap 位置
 * （kernel之后、platform之前）；其余安装顺序由 loader 的拓扑排序决定。
 *
 * 按平台过滤（W14，`platforms.ts`）：只收录 `meta.platforms` 含目标平台的插件，缺省视为 `['desktop']`；
 * 生成移动端 profile 时，目录下有 `mobile.ts` 就用它代替 `index.ts`（同一服务的移动端实现），
 * 且它必须声明 `mobile`。
 *
 * 用法：
 * - `node host/profiles/generate.ts` 重新生成两个 profile；
 * - `node host/profiles/generate.ts --check` 只比较磁盘内容，不一致时退出 1（供集成门禁检测漂移）。
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative, dirname } from 'node:path';
import type { HostPlugin } from '../kernel/api.ts';
import { PLUGIN_PLATFORMS, supportsPlatform, type PluginPlatform } from './platforms.ts';

/** Kernel-owned plugins that live outside `host/plugins/` but are always part of the official profile. */
const KERNEL_PLUGINS = ['kernel/plugins.ts'] as const;
/**
 * Shell plugin `dstu.shell` (`electron/index.ts`). It provides `startupGate` and registers the
 * F2-owned application commands; the shell UI half stays in Electron main. The module must be
 * importable from the Host utility process, which the generator verifies by importing it like
 * every other profile entry.
 */
const SHELL_PLUGINS = ['../electron/index.ts'] as const;

/** Independently exported plugins not covered by the directory index scan. */
const STANDALONE_PLUGINS = [
  'platform/settings/backup-commands.ts',
  'plugins/sync/startup.ts',
] as const;

async function loadPlugin(path: string): Promise<HostPlugin | null> {
  const namespace = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (namespace.default === undefined) return null;
  const plugin = namespace.default as HostPlugin;
  if (!plugin?.meta?.id || typeof plugin.apply !== 'function') throw new Error(`${path} must default export definePlugin(...)`);
  return plugin;
}

export async function generateDesktopProfile(hostDir = fileURLToPath(new URL('../', import.meta.url))): Promise<string> {
  return generateProfile('desktop', hostDir);
}

export async function generateProfile(platform: PluginPlatform, hostDir = fileURLToPath(new URL('../', import.meta.url))): Promise<string> {
  const entries: { id: string; module: string }[] = [];
  let startupSyncId: string | undefined;
  const add = async (path: string, allowMissing = false): Promise<void> => {
    // 测试夹具没有 electron/ 目录；真实仓库中 shell 入口必须存在并由 --check 守护。
    if (allowMissing && !existsSync(path)) return;
    const plugin = await loadPlugin(path);
    if (plugin === null) {
      if (allowMissing) return;
      throw new Error(`${path} must default export definePlugin(...)`);
    }
    if (!supportsPlatform(plugin.meta, platform)) return;
    if (entries.some(e => e.id === plugin.meta.id)) throw new Error(`duplicate plugin id ${plugin.meta.id}`);
    if (plugin.meta.provides?.includes('storageStartupSync')) {
      if (startupSyncId !== undefined) throw new Error('multiple storageStartupSync bootstrap providers');
      const inject = Array.isArray(plugin.inject) ? plugin.inject : Object.keys(plugin.inject ?? {});
      if (inject.length !== 1 || inject[0] !== 'paths') {
        throw new Error(`${plugin.meta.id}: pre-storage bootstrap must inject only paths`);
      }
      startupSyncId = plugin.meta.id;
    }
    entries.push({ id: plugin.meta.id, module: relative(join(hostDir, 'profiles'), path).replaceAll('\\', '/') });
  };
  const addDirectory = async (group: 'platform' | 'plugins'): Promise<void> => {
    const root = join(hostDir, group);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      // 测试夹具可以没有平台目录；业务插件目录仍然必需。
      if (group === 'platform' && (error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    const dirs = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const files = await readdir(join(root, dir.name));
      // Only explicit standalone entries are discovered; placement still follows provides.
      for (const module of STANDALONE_PLUGINS) {
        if (module.startsWith(`${group}/${dir.name}/`)) await add(join(hostDir, module));
      }
      if (platform === 'mobile' && files.includes('mobile.ts')) {
        const variant = join(root, dir.name, 'mobile.ts');
        const plugin = await loadPlugin(variant);
        if (plugin === null || !supportsPlatform(plugin.meta, 'mobile')) {
          throw new Error(`${group}/${dir.name}/mobile.ts must declare meta.platforms including "mobile"`);
        }
        await add(variant);
        continue;
      }
      if (!files.includes('index.ts')) continue;
      await add(join(root, dir.name, 'index.ts'), group === 'platform');
    }
  };
  // Rust `run()` calls `register_extensions()` before business work, and the plugin manager is
  // always in Tauri state; the kernel entry therefore leads the profile.
  for (const module of KERNEL_PLUGINS) await add(join(hostDir, module));
  const kernelEntries = entries.length;
  // 平台服务插件先于业务插件进入清单；真正的顺序由 loader 按 inject 拓扑排序。
  await addDirectory('platform');
  // 外壳插件在 host 之外；测试夹具没有 electron/ 时跳过，真实仓库必须存在。
  for (const module of SHELL_PLUGINS) await add(join(hostDir, module), true);
  await addDirectory('plugins');
  if (startupSyncId !== undefined) {
    // Explicit W13 bootstrap position, independent of directory/id sorting. Storage needs
    // paths too, so once storage can be selected by the stable sorter, this earlier entry
    // is already selectable. No platform->business inject edge or late finalizer is added.
    const index = entries.findIndex(entry => entry.id === startupSyncId);
    const [bootstrap] = entries.splice(index, 1);
    entries.splice(kernelEntries, 0, bootstrap!);
  }
  return JSON.stringify({ $comment: 'Generated by node host/profiles/generate.ts; do not edit.', plugins: entries }, null, 2) + '\n';
}

const PROFILES_DIR = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  for (const platform of PLUGIN_PLATFORMS) {
    const file = join(PROFILES_DIR, `${platform}.json`);
    const generated = await generateProfile(platform);
    if (platform === 'desktop') {
      // 测试夹具允许没有 electron/，真实仓库的官方清单必须包含 F2 的 dstu.shell。
      const ids = (JSON.parse(generated) as { plugins: { id: string }[] }).plugins.map((plugin) => plugin.id);
      if (!ids.includes('dstu.shell')) throw new Error('official profile is missing dstu.shell (electron/index.ts)');
    }
    if (!check) {
      await writeFile(file, generated);
      continue;
    }
    let current: string;
    try {
      current = await readFile(file, 'utf8');
    } catch (error) {
      // 文件不存在 = 清单漂移（首次生成前应当由提交者运行本脚本）。
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      current = '';
    }
    if (current !== generated) {
      process.stderr.write(`host/profiles/${platform}.json is out of date; run \`node host/profiles/generate.ts\`\n`);
      process.exitCode = 1;
      continue;
    }
    process.stdout.write(`host/profiles/${platform}.json is up to date\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
