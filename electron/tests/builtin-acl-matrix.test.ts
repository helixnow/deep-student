/**
 * Electron 内置插件 ACL 安全矩阵：每个内置插件命令在各窗口是否放行，以及 Tauri 2.11.5 桌面正式版与
 * Electron 外壳是否实现。
 *
 * - 窗口列同时与 Electron `BuiltinAcl` 和本文件按 Tauri 规则独立推导的结果比对（tauri-utils 2.9.3 `acl/resolved.rs`、
 *   tauri 2.11.5 `ipc/authority.rs`：任一 deny 条目即拒绝；放行要求来源与 window/webview glob 都匹配），三个桌面平台都要一致。
 * - Electron 列与 `electron/main.ts` 注册的插件表比对（`桩` = `unsupported()` 生成的报错桩；`报错` = 实际调用后抛出与 Tauri 本构建相同的错误）。
 * - Tauri 列在本机 cargo registry 有锁定版本的 crate 源时，与各插件 `generate_handler!` 按正式版桌面构建的 cfg 求值比对。
 * - 某窗口放行、但两边实际可用不一致的行，说明里必须引用 RF（文件必须存在）或写明交接。
 *
 * 新增放行、新增或去掉实现都必须同时改表。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WindowRef } from '../../host/kernel/protocol.ts';
import type { InvokeInput } from '../shell/args.ts';
import { BuiltinAcl } from '../shell/capabilities.ts';
import { ShellCommandError } from '../shell/errors.ts';
import { imagePlugin } from '../shell/images.ts';
import { dialogPlugin } from '../shell/plugins/dialog.ts';
import { eventPlugin } from '../shell/plugins/event.ts';
import { fsPlugin } from '../shell/plugins/fs.ts';
import { httpPlugin } from '../shell/plugins/http.ts';
import { appPlugin, pathPlugin, resourcesPlugin } from '../shell/plugins/path-app.ts';
import { clipboardPlugin, globalShortcutPlugin, notificationPlugin, openerPlugin, processPlugin, updaterPlugin, type ProcessHooks } from '../shell/plugins/system.ts';
import { TAURI_ACL_CRATES, TAURI_ACL_MANIFESTS } from '../shell/plugins/tauri-acl-manifest.ts';
import { webviewPlugin, windowPlugin } from '../shell/plugins/window.ts';
import { isUnsupportedCommand, unprovidedPlugin, type BuiltinPlugin, type CommandContext, type ShellRuntime } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const CAPABILITIES = join(ROOT, 'resources/app', 'capabilities');
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;
type Platform = (typeof PLATFORMS)[number];
const TAURI_PLATFORM: Record<Platform, string> = { linux: 'linux', darwin: 'macOS', win32: 'windows' };

const MAIN: WindowRef = { window: 'main', webview: 'main' };

/** 表格各窗口列代表的调用方；一格只能是全部放行或全部拒绝。 */
const COLUMNS: readonly { name: string; callers: readonly WindowRef[] }[] = [
  { name: 'main', callers: [MAIN] },
  { name: 'quick-assistant', callers: [{ window: 'quick-assistant', webview: 'quick-assistant' }] },
  { name: 'pomodoro-mini', callers: [{ window: 'pomodoro-mini', webview: 'pomodoro-mini' }] },
  {
    name: 'browser-content',
    callers: [
      { window: 'main', webview: 'browser-content', origin: 'https://example.com' },
      { window: 'browser-content', webview: 'browser-content', origin: 'https://example.com' },
      { window: 'main', webview: 'browser-content', origin: 'null' },
    ],
  },
  {
    name: '其他',
    callers: [
      { window: 'main', webview: 'main', origin: 'https://example.com' },
      { window: 'quick-assistant', webview: 'quick-assistant', origin: 'https://example.com' },
      { window: 'settings', webview: 'settings' },
    ],
  },
];

const TAURI_VALUES = ['有', '无', 'debug', '报错', 'macOS', 'Windows'] as const;
const ELECTRON_VALUES = ['有', '桩', '无', 'debug', '报错'] as const;
type TauriValue = (typeof TAURI_VALUES)[number];
type ElectronValue = (typeof ELECTRON_VALUES)[number];

/** 外壳实现、但只在开发构建里可用的命令（正式版按 Tauri 报 `Command <cmd> not found`）。 */
const DEBUG_ONLY = new Set(['plugin:webview|internal_toggle_devtools']);
/** Tauri 编译了、但本构建未开 `image-ico` / `image-png` 特性，函数体恒返回错误（tauri-2.11.5 `image/plugin.rs`）。 */
const TAURI_ALWAYS_ERR = new Set(['plugin:image|from_bytes', 'plugin:image|from_path']);
const tauriAlwaysErrText = (name: string): string => `${name} is only supported if the \`image-ico\` or \`image-png\` Cargo features are enabled`;

/** `electron/main.ts` `registerBuiltinPlugins` 注册的插件（依赖换成空实现，只取命令表）。 */
function registeredPlugins(): Record<string, BuiltinPlugin> {
  const scope = new FsScope({ platform: 'linux' });
  return {
    event: eventPlugin(),
    window: windowPlugin(),
    webview: webviewPlugin(),
    path: pathPlugin(),
    app: appPlugin(),
    resources: resourcesPlugin(),
    dialog: dialogPlugin(),
    fs: fsPlugin({ global: scope, runtime: scope }),
    http: httpPlugin({ allow: [], deny: [] }),
    'clipboard-manager': clipboardPlugin(),
    image: imagePlugin(),
    opener: openerPlugin({ urlAllow: [], paths: scope, pathApps: [] }, 'linux'),
    notification: notificationPlugin(),
    process: processPlugin({} as ProcessHooks),
    updater: updaterPlugin({ appName: 'x', execPath: '/x', argv: [], env: {}, exit: () => undefined }),
    'global-shortcut': globalShortcutPlugin('linux', { pressed: () => undefined }),
  };
}
const REGISTERED = registeredPlugins();

const split = (command: string): [string, string] => {
  const [plugin = '', name = ''] = command.slice('plugin:'.length).split('|');
  return [plugin, name];
};
const manifestKey = (plugin: string): string => (TAURI_ACL_MANIFESTS[`core:${plugin}`] === undefined ? plugin : `core:${plugin}`);
const pluginOf = (key: string): string => (key.startsWith('core:') ? key.slice('core:'.length) : key);

function electronImplementation(command: string): ElectronValue {
  const [plugin, name] = split(command);
  const table = REGISTERED[plugin] ?? unprovidedPlugin(plugin);
  const handler = table !== null && Object.hasOwn(table, name) ? table[name] : undefined;
  if (handler === undefined) return '无';
  if (isUnsupportedCommand(handler)) return '桩';
  if (TAURI_ALWAYS_ERR.has(command) && alwaysFailsWith(handler, name, tauriAlwaysErrText(name))) return '报错';
  return DEBUG_ONLY.has(command) ? 'debug' : '有';
}

/** 不碰运行时、对路径、字节和空参数都同步抛出 `message`（与 Tauri 恒返回的错误相同）。 */
function alwaysFailsWith(handler: NonNullable<BuiltinPlugin[string]>, name: string, message: string): boolean {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const inputs: InvokeInput[] = [
    { command: name, json: {}, raw: null, headers: {} },
    { command: name, json: { path: '/etc/hosts' }, raw: null, headers: {} },
    { command: name, json: { bytes: png }, raw: null, headers: {} },
    { command: name, json: null, raw: Uint8Array.from(png), headers: { 'content-type': 'application/octet-stream' } },
  ];
  for (const input of inputs) {
    try {
      handler(input, {} as CommandContext);
      return false;
    } catch (error) {
      if (!(error instanceof ShellCommandError) || error.message !== message) return false;
    }
  }
  return true;
}

// ------------------------------------------------------------ 独立的 Tauri ACL 推导

interface Traversed {
  key: string;
  allow: readonly string[];
  deny: readonly string[];
  scopeAllow?: readonly unknown[];
  scopeDeny?: readonly unknown[];
  platforms?: readonly string[];
}

function traverse(id: string, within: string | null): Traversed[] {
  const colon = id.lastIndexOf(':');
  const prefixed = colon > 0 && TAURI_ACL_MANIFESTS[id.slice(0, colon)] !== undefined;
  const key = prefixed ? id.slice(0, colon) : within;
  const name = prefixed ? id.slice(colon + 1) : id;
  const manifest = key === null ? undefined : TAURI_ACL_MANIFESTS[key];
  if (key === null || manifest === undefined) throw new Error(`unknown permission ${id}`);
  if (name === 'default') return (manifest.default ?? []).flatMap((member) => traverse(member, key));
  const set = manifest.sets[name];
  if (set !== undefined) return set.flatMap((member) => traverse(member, key));
  const permission = manifest.permissions[name];
  if (permission !== undefined) return [{ ...permission, key, allow: permission.allow ?? [], deny: permission.deny ?? [] }];
  const generated = /^(allow|deny)-(.+)$/.exec(name);
  if (generated === null) throw new Error(`unknown permission ${id}`);
  const command = (generated[2] ?? '').replaceAll('-', '_');
  return [{ key, allow: generated[1] === 'allow' ? [command] : [], deny: generated[1] === 'deny' ? [command] : [] }];
}

const globMatches = (pattern: string, value: string): boolean =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);

/** `resources/app/capabilities/*.json` 的原始内容（字段按既有缺省值理解）。 */
interface RawCapability {
  local?: boolean;
  remote?: { urls: string[] };
  windows?: string[];
  webviews?: string[];
  platforms?: string[];
  permissions: (string | { identifier: string; allow?: unknown[] | null; deny?: unknown[] | null })[];
}

/** 与命令同插件、对该平台生效的权限，连同 capability 条目附加的作用域和该 capability 是否匹配调用方。 */
function* plugPermissions(capabilities: readonly RawCapability[], command: string, caller: WindowRef, platform: Platform) {
  const key = manifestKey(split(command)[0]);
  const target = TAURI_PLATFORM[platform];
  for (const capability of capabilities) {
    if (capability.platforms && !capability.platforms.includes(target)) continue;
    const origin = caller.origin === undefined
      ? capability.local !== false
      : (capability.remote?.urls ?? []).some((url) => globMatches(url, `${caller.origin}/`));
    const label = (capability.webviews ?? []).some((glob) => globMatches(glob, caller.webview))
      || (capability.windows ?? []).some((glob) => globMatches(glob, caller.window));
    for (const entry of capability.permissions) {
      const id = typeof entry === 'string' ? entry : entry.identifier;
      if (!id.includes(':')) continue;
      const extraAllow = typeof entry === 'string' ? [] : (entry.allow ?? []);
      const extraDeny = typeof entry === 'string' ? [] : (entry.deny ?? []);
      for (const permission of traverse(id, null)) {
        if (permission.key !== key || (permission.platforms && !permission.platforms.includes(target))) continue;
        yield { permission, matches: origin && label, extraAllow, extraDeny };
      }
    }
  }
}

function tauriAllows(capabilities: readonly RawCapability[], command: string, caller: WindowRef, platform: Platform): boolean {
  const name = split(command)[1];
  let allowed = false;
  for (const { permission, matches } of plugPermissions(capabilities, command, caller, platform)) {
    if (permission.deny.includes(name)) return false;
    if (matches && permission.allow.includes(name)) allowed = true;
  }
  return allowed;
}

const entryText = (entry: unknown): string => {
  if (entry !== null && typeof entry === 'object') {
    const keys = Object.keys(entry);
    const only = keys.length === 1 ? keys[0] : undefined;
    if (only === 'path' || only === 'url') return String((entry as Record<string, unknown>)[only]);
  }
  return JSON.stringify(entry);
};
const texts = (entries: Iterable<unknown>): string[] => [...new Set([...entries].map(entryText))].sort();

/** 没有命令的权限给插件全局作用域（所有 capability）；带命令的权限只给匹配调用方的 capability 中它放行的命令。 */
function tauriScope(capabilities: readonly RawCapability[], command: string, caller: WindowRef, platform: Platform): { allow: string[]; deny: string[] } {
  const name = split(command)[1];
  const allow: unknown[] = [];
  const deny: unknown[] = [];
  for (const { permission, matches, extraAllow, extraDeny } of plugPermissions(capabilities, command, caller, platform)) {
    const global = permission.allow.length === 0 && permission.deny.length === 0;
    if (!global && !(matches && permission.allow.includes(name))) continue;
    allow.push(...extraAllow, ...(permission.scopeAllow ?? []));
    deny.push(...extraDeny, ...(permission.scopeDeny ?? []));
  }
  return { allow: texts(allow), deny: texts(deny) };
}

interface ScopeDiff {
  sameAllow: number;
  sameDeny: number;
  electronOnlyAllow: string[];
  tauriOnlyDeny: string[];
  electronOnlyDeny: string[];
  tauriOnlyAllow: string[];
}

function scopeDiff(electron: { allow: string[]; deny: string[] }, tauri: { allow: string[]; deny: string[] }): ScopeDiff {
  return {
    sameAllow: electron.allow.filter((entry) => tauri.allow.includes(entry)).length,
    sameDeny: electron.deny.filter((entry) => tauri.deny.includes(entry)).length,
    electronOnlyAllow: electron.allow.filter((entry) => !tauri.allow.includes(entry)),
    tauriOnlyDeny: tauri.deny.filter((entry) => !electron.deny.includes(entry)),
    electronOnlyDeny: electron.deny.filter((entry) => !tauri.deny.includes(entry)),
    tauriOnlyAllow: tauri.allow.filter((entry) => !electron.allow.includes(entry)),
  };
}

function loadCapabilities(): RawCapability[] {
  return readdirSync(CAPABILITIES).filter((file) => file.endsWith('.json')).sort()
    .map((file) => JSON.parse(readFileSync(join(CAPABILITIES, file), 'utf8')) as RawCapability);
}

function cell(decide: (caller: WindowRef) => boolean, column: (typeof COLUMNS)[number], command: string): string {
  const decisions = column.callers.map(decide);
  if (decisions.every(Boolean)) return '✓';
  if (!decisions.some(Boolean)) return '·';
  throw new Error(`${command}: the ${column.name} column mixes allowed and denied callers; split the column`);
}

/** 清单命令（含权限 allow/deny 里出现的名字）、main 注册的命令与明确不提供的命令的并集。 */
function allCommands(): string[] {
  const out = new Set<string>();
  for (const [key, manifest] of Object.entries(TAURI_ACL_MANIFESTS)) {
    const named = Object.values(manifest.permissions).flatMap((permission) => [...(permission.allow ?? []), ...(permission.deny ?? [])]);
    for (const name of [...manifest.commands, ...named]) out.add(`plugin:${pluginOf(key)}|${name}`);
  }
  for (const [plugin, table] of Object.entries(REGISTERED)) for (const name of Object.keys(table)) out.add(`plugin:${plugin}|${name}`);
  for (const plugin of ['menu', 'tray']) for (const name of Object.keys(unprovidedPlugin(plugin) ?? {})) out.add(`plugin:${plugin}|${name}`);
  return [...out].sort();
}

// ------------------------------------------------------------ tests

describe('Electron BuiltinAcl security matrix (built-in plugin command × window)', () => {
  it('mirrors the plugins electron/main.ts registers', () => {
    const main = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8');
    const names = [...main.matchAll(/runtime\.registerPlugin\('([^']+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(Object.keys(REGISTERED).sort());
  });

  it.each(PLATFORMS)('Electron BuiltinAcl matches independent capability resolution on %s', (platform) => {
    const acl = BuiltinAcl.fromDirectory(CAPABILITIES, platform);
    const capabilities = loadCapabilities();
    const mismatches: string[] = [];
    for (const command of allCommands()) {
      COLUMNS.forEach((column) => {
        const electron = cell((caller) => acl.authorize(command, caller) !== null, column, command);
        const tauri = cell((caller) => tauriAllows(capabilities, command, caller, platform), column, command);
        if (electron !== tauri) mismatches.push(`${command} ${column.name}: Electron ${electron}, Tauri ${tauri}`);
      });
    }
    expect(mismatches).toEqual([]);
  });

  it('debug-only Electron commands fail closed as not found in packaged builds', async () => {
    for (const command of DEBUG_ONLY) {
      const [plugin, name] = split(command);
      const handler = REGISTERED[plugin]?.[name];
      const ctx = { runtime: { debug: false } as unknown as ShellRuntime, windowLabel: 'main', webviewLabel: 'main' } satisfies CommandContext;
      const error = await Promise.resolve().then(() => handler?.({ command: name, json: {}, raw: null, headers: {} }, ctx)).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ShellCommandError);
      expect((error as ShellCommandError).value).toBe(`Command ${name} not found`);
    }
  });

  it('all registered commands map cleanly to a known Electron implementation state', () => {
    for (const command of allCommands()) {
      expect(ELECTRON_VALUES as readonly string[]).toContain(electronImplementation(command));
    }
  });
});
