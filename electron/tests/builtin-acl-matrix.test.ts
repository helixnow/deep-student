/**
 * `electron/shell/W23-PROGRESS.md` 的 ACL 对照表：每个内置插件命令在各窗口是否放行，以及 Tauri 2.11.5 桌面正式版与
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
const PROGRESS = join(ROOT, 'electron', 'shell', 'W23-PROGRESS.md');
const RUST_FIXES = join(ROOT, 'host', 'e2e', 'differential', 'rust-fixes');
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

interface Row {
  plugin: string;
  commands: string[];
  cells: string[];
  tauri: string;
  electron: string;
  note: string;
}

interface ScopeRow {
  plugin: string;
  commands: string[];
  diff: ScopeDiff;
  note: string;
}

/** `<!-- name:begin -->` 与 `<!-- name:end -->` 之间表格的数据行（去掉表头与分隔行）。 */
function readBlock(name: string, width: number): string[][] {
  const text = readFileSync(PROGRESS, 'utf8');
  const begin = text.indexOf(`<!-- ${name}:begin -->`);
  const end = text.indexOf(`<!-- ${name}:end -->`);
  if (begin < 0 || end < begin) throw new Error(`W23-PROGRESS.md has no ${name} block`);
  const rows: string[][] = [];
  for (const line of text.slice(begin, end).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
    if (cells[0] === '插件' || /^:?-+:?$/.test(cells[0] ?? '')) continue;
    if (cells.length !== width) throw new Error(`malformed ${name} row: ${line}`);
    rows.push(cells);
  }
  return rows;
}

const quoted = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

function readTable(): Row[] {
  return readBlock('builtin-acl-matrix', COLUMNS.length + 5).map(([plugin = '', commands = '', ...rest]) => {
    const note = rest.pop() ?? '';
    const electron = rest.pop() ?? '';
    const tauri = rest.pop() ?? '';
    return { plugin, commands: quoted(commands), cells: rest, tauri, electron, note };
  });
}

function readScopeTable(): ScopeRow[] {
  return readBlock('builtin-acl-scopes', 9).map(([plugin = '', commands = '', sameAllow = '', sameDeny = '', eAllow = '', tDeny = '', eDeny = '', tAllow = '', note = '']) => ({
    plugin,
    commands: quoted(commands),
    diff: {
      sameAllow: Number(sameAllow),
      sameDeny: Number(sameDeny),
      electronOnlyAllow: quoted(eAllow).sort(),
      tauriOnlyDeny: quoted(tDeny).sort(),
      electronOnlyDeny: quoted(eDeny).sort(),
      tauriOnlyAllow: quoted(tAllow).sort(),
    },
    note,
  }));
}

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

// ------------------------------------------------------------ Tauri 正式版桌面构建编译的命令

function findSources(): Map<string, string> | null {
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
  if (!existsSync(registry)) return null;
  const indexes = readdirSync(registry).map((name) => join(registry, name));
  const out = new Map<string, string>();
  for (const crate of TAURI_ACL_CRATES) {
    const dir = indexes.map((index) => join(index, crate)).find((candidate) => existsSync(candidate));
    if (dir === undefined) return null;
    out.set(crate, dir);
  }
  return out;
}

interface CfgEnv { os: string; debug: boolean }

/** `cfg(...)` 谓词求值；原桌面构建没有打开任何出现在 handler 列表里的 feature。 */
function evalCfg(expr: string, env: CfgEnv): boolean {
  let pos = 0;
  const skip = () => { while (/\s/.test(expr[pos] ?? '')) pos += 1; };
  const parse = (): boolean => {
    skip();
    const name = /^[A-Za-z_]\w*/.exec(expr.slice(pos))?.[0];
    if (name === undefined) throw new Error(`bad cfg: ${expr}`);
    pos += name.length;
    skip();
    if (expr[pos] === '(') {
      pos += 1;
      const args: boolean[] = [];
      for (skip(); expr[pos] !== ')'; skip()) {
        args.push(parse());
        skip();
        if (expr[pos] === ',') pos += 1;
      }
      pos += 1;
      if (name === 'all') return args.every(Boolean);
      if (name === 'any') return args.some(Boolean);
      if (name === 'not') return !args[0];
      throw new Error(`bad cfg: ${expr}`);
    }
    if (expr[pos] === '=') {
      const value = /^=\s*"([^"]*)"/.exec(expr.slice(pos));
      if (value === null) throw new Error(`bad cfg: ${expr}`);
      pos += value[0].length;
      if (name === 'target_os') return value[1] === env.os;
      if (name === 'feature') return false;
      throw new Error(`bad cfg: ${expr}`);
    }
    if (name === 'desktop') return true;
    if (name === 'mobile') return false;
    if (name === 'debug_assertions') return env.debug;
    throw new Error(`bad cfg: ${expr}`);
  };
  return parse();
}

/** 各插件 `generate_handler!` 中、在给定构建里编译进来的命令名。 */
function compiledCommands(sources: Map<string, string>, key: string, env: CfgEnv): Set<string> {
  const crate = key.startsWith('core:')
    ? TAURI_ACL_CRATES.find((name) => /^tauri-\d/.test(name))
    : TAURI_ACL_CRATES.find((name) => name.startsWith(`tauri-plugin-${key}-`));
  const dir = crate === undefined ? undefined : sources.get(crate);
  if (dir === undefined) throw new Error(`no crate source for ${key}`);
  const file = key.startsWith('core:') ? join(dir, 'src', pluginOf(key), 'plugin.rs') : join(dir, 'src', 'lib.rs');
  const blocks = [...readFileSync(file, 'utf8').matchAll(/generate_handler!\[([\s\S]*?)\]\s*\)/g)];
  if (blocks.length !== 1) throw new Error(`${file}: expected exactly one generate_handler! block`);
  const body = (blocks[0]?.[1] ?? '').replace(/\/\/.*$/gm, '').replace(/#!\[[^\]]*\]/g, '');
  const out = new Set<string>();
  let enabled = true;
  for (const token of body.matchAll(/#\[cfg\((.*?)\)\]|([A-Za-z_][\w:]*)/gs)) {
    if (token[1] !== undefined) enabled &&= evalCfg(token[1], env);
    else {
      if (enabled) out.add((token[2] ?? '').split('::').pop() ?? '');
      enabled = true;
    }
  }
  return out;
}

function tauriImplementation(sources: Map<string, string>, command: string): TauriValue {
  const [plugin, name] = split(command);
  const key = manifestKey(plugin);
  if (TAURI_ACL_MANIFESTS[key] === undefined) return '无';
  const os = { linux: 'linux', darwin: 'macos', win32: 'windows' } as const;
  const release = PLATFORMS.filter((platform) => compiledCommands(sources, key, { os: os[platform], debug: false }).has(name));
  if (release.length === PLATFORMS.length) return TAURI_ALWAYS_ERR.has(command) ? '报错' : '有';
  if (release.length === 0) {
    const debug = PLATFORMS.filter((platform) => compiledCommands(sources, key, { os: os[platform], debug: true }).has(name));
    return debug.length === PLATFORMS.length ? 'debug' : '无';
  }
  if (release.length === 1 && release[0] === 'darwin') return 'macOS';
  if (release.length === 1 && release[0] === 'win32') return 'Windows';
  throw new Error(`${command} is compiled only on ${release.join(', ')}; add a value for it`);
}

// ------------------------------------------------------------ tests

describe('electron/shell/W23-PROGRESS.md ACL table (built-in plugin command × window)', () => {
  const rows = readTable();
  const byCommand = new Map<string, Row>();
  for (const row of rows) for (const name of row.commands) byCommand.set(`plugin:${row.plugin}|${name}`, row);

  it('lists every built-in plugin command exactly once, with values from the legend', () => {
    const listed = rows.flatMap((row) => row.commands.map((name) => `plugin:${row.plugin}|${name}`));
    expect(listed.filter((command, index) => listed.indexOf(command) !== index)).toEqual([]);
    expect([...listed].sort()).toEqual(allCommands());
    for (const row of rows) {
      expect(row.commands.length, `${row.plugin} row without commands`).toBeGreaterThan(0);
      expect(row.cells.every((value) => value === '✓' || value === '·'), `${row.plugin} ${row.commands.join(',')}`).toBe(true);
      expect(TAURI_VALUES as readonly string[]).toContain(row.tauri);
      expect(ELECTRON_VALUES as readonly string[]).toContain(row.electron);
    }
  });

  it('mirrors the plugins electron/main.ts registers', () => {
    const main = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8');
    const names = [...main.matchAll(/runtime\.registerPlugin\('([^']+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(Object.keys(REGISTERED).sort());
  });

  it.each(PLATFORMS)('window columns equal both the Electron BuiltinAcl and an independent Tauri resolution on %s', (platform) => {
    const acl = BuiltinAcl.fromDirectory(CAPABILITIES, platform);
    const capabilities = loadCapabilities();
    const mismatches: string[] = [];
    for (const command of allCommands()) {
      const row = byCommand.get(command);
      COLUMNS.forEach((column, index) => {
        const electron = cell((caller) => acl.authorize(command, caller) !== null, column, command);
        const tauri = cell((caller) => tauriAllows(capabilities, command, caller, platform), column, command);
        if (electron !== tauri) mismatches.push(`${command} ${column.name}: Electron ${electron}, Tauri ${tauri}`);
        if (row?.cells[index] !== electron) mismatches.push(`${command} ${column.name}: table ${row?.cells[index] ?? '-'}, actual ${electron}`);
      });
    }
    expect(mismatches).toEqual([]);
  });

  it('the Electron column matches the handlers main registers', () => {
    const mismatches = allCommands()
      .filter((command) => byCommand.get(command)?.electron !== electronImplementation(command))
      .map((command) => `${command}: table ${byCommand.get(command)?.electron ?? '-'}, actual ${electronImplementation(command)}`);
    expect(mismatches).toEqual([]);
  });

  it('debug-only Electron commands answer like a Tauri release build in a packaged build', async () => {
    for (const command of DEBUG_ONLY) {
      const [plugin, name] = split(command);
      const handler = REGISTERED[plugin]?.[name];
      const ctx = { runtime: { debug: false } as unknown as ShellRuntime, windowLabel: 'main', webviewLabel: 'main' } satisfies CommandContext;
      const error = await Promise.resolve().then(() => handler?.({ command: name, json: {}, raw: null, headers: {} }, ctx)).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ShellCommandError);
      expect((error as ShellCommandError).value).toBe(`Command ${name} not found`);
    }
  });

  it('rows whose command is allowed somewhere but usable on one side only cite an RF or a handoff', () => {
    const usable = { tauri: new Set(['有', 'debug', 'macOS', 'Windows']), electron: new Set(['有', 'debug']) };
    const uncited = rows
      .filter((row) => row.cells.includes('✓'))
      .filter((row) => row.tauri !== row.electron && (usable.tauri.has(row.tauri) || usable.electron.has(row.electron)))
      .filter((row) => !cites(row.note, { handoff: true }))
      .map((row) => `${row.plugin} ${row.commands.join(', ')}`);
    expect(uncited).toEqual([]);
  });

  const sources = findSources();
  it.skipIf(sources === null)('the Tauri column matches what the locked crates compile for a release desktop build', () => {
    // 对照表按原桌面构建的 cfg 求值：tauri 没有 devtools 特性、没有 image 依赖（image-ico/png 关闭），fs 没有 watch（notify）。
    const mismatches = allCommands()
      .filter((command) => byCommand.get(command)?.tauri !== tauriImplementation(sources as Map<string, string>, command))
      .map((command) => `${command}: table ${byCommand.get(command)?.tauri ?? '-'}, actual ${tauriImplementation(sources as Map<string, string>, command)}`);
    expect(mismatches).toEqual([]);
    const image = readFileSync(join(sources?.get(TAURI_ACL_CRATES.find((name) => /^tauri-\d/.test(name)) ?? '') ?? '', 'src', 'image', 'plugin.rs'), 'utf8');
    for (const command of TAURI_ALWAYS_ERR) {
      const stub = new RegExp(`#\\[cfg\\(not\\(any\\(feature = "image-ico", feature = "image-png"\\)\\)\\)\\]\\s*#\\[command\\(root = "crate"\\)\\]\\s*fn ${split(command)[1]}\\(\\)`);
      expect(stub.test(image), command).toBe(true);
    }
  });
});

describe('electron/shell/W23-PROGRESS.md scope table (main window, scoped plugins)', () => {
  const scopeRows = readScopeTable();

  it.each(PLATFORMS)('lists every main command with a scope, and its difference from an independent Tauri resolution, on %s', (platform) => {
    const acl = BuiltinAcl.fromDirectory(CAPABILITIES, platform);
    const capabilities = loadCapabilities();
    const actual = new Map<string, ScopeDiff>();
    for (const column of COLUMNS) {
      for (const caller of column.callers) {
        for (const command of allCommands()) {
          if (acl.authorize(command, caller) === null) continue;
          const scope = acl.scopeFor(command, caller);
          const electron = { allow: texts(scope.allow), deny: texts(scope.deny) };
          const tauri = tauriScope(capabilities, command, caller, platform);
          const empty = electron.allow.length + electron.deny.length + tauri.allow.length + tauri.deny.length === 0;
          if (column.name !== 'main') expect(empty, `${command} has a scope on ${column.name}; extend the scope table`).toBe(true);
          else if (!empty) actual.set(command, scopeDiff(electron, tauri));
        }
      }
    }
    const listed = new Map<string, ScopeDiff>(scopeRows.flatMap((row) => row.commands.map((name) => [`plugin:${row.plugin}|${name}`, row.diff] as const)));
    expect([...listed.keys()].sort()).toEqual([...actual.keys()].sort());
    const mismatches = [...actual]
      .filter(([command, diff]) => JSON.stringify(listed.get(command)) !== JSON.stringify(diff))
      .map(([command, diff]) => `${command}: table ${JSON.stringify(listed.get(command))}, actual ${JSON.stringify(diff)}`);
    expect(mismatches).toEqual([]);
  });

  it('every scope difference from Tauri cites a registered RF', () => {
    const uncited = scopeRows
      .filter(({ diff }) => diff.electronOnlyAllow.length + diff.tauriOnlyDeny.length + diff.electronOnlyDeny.length + diff.tauriOnlyAllow.length > 0)
      .filter((row) => !cites(row.note, { handoff: false }))
      .map((row) => `${row.plugin} ${row.commands.join(', ')}`);
    expect(uncited).toEqual([]);
  });
});

/** 说明里引用的 RF 必须已登记；`handoff` 为真时写明“交接”也算。 */
function cites(note: string, options: { handoff: boolean }): boolean {
  const rfs = [...note.matchAll(/RF-W\d+-[a-z0-9-]+/g)].map((m) => m[0]);
  for (const rf of rfs) expect(existsSync(join(RUST_FIXES, `${rf}.json`)), `${rf} is not registered`).toBe(true);
  return rfs.length > 0 || (options.handoff && note.includes('交接'));
}
