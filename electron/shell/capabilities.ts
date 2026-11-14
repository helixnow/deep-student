/**
 * 内置插件（main 内实现的 Tauri 插件）的 ACL：按 `resources/app/capabilities/*.json` 与插件权限清单
 * （`plugins/tauri-acl-manifest.ts`）解析出每个命令允许的 window/webview/来源与作用域。
 *
 * 解析逐段对应 tauri-utils 2.9.3 `acl/resolved.rs`（`Resolved::resolve`、`with_resolved_permissions`、
 * `get_permissions`），判定与报错对应 tauri 2.11.5 `ipc/authority.rs`（`resolve_access`、
 * `resolve_access_message`）。应用命令（不带 `插件:` 前缀的权限）归 Host kernel 的 `CapabilityAcl`。
 *
 * 与 Tauri 的有意差异（RUST-FIX(RF-W23-fs-read-write-scope-split)）：Tauri 把权限集中“只有 scope、没有 commands”
 * 的成员（如 `fs:allow-desktop-read-recursive` = `read-all` + `scope-desktop-recursive`）的 allow 放进插件全局作用域，
 * 对该插件所有命令、所有窗口生效，于是“桌面只读”在 Rust 版本里也能写。这里把这类 allow 绑定到同一次展开中
 * 同插件带命令成员的命令作用域；deny 仍进全局作用域，单独授予的 scope 权限（如 `fs:scope`）仍是全局的。
 */
import type { Capability, CapabilityPlatform } from '../../host/kernel/api.ts';
import type { WindowRef } from '../../host/kernel/protocol.ts';
import { readCapabilityDir } from './capability-file.ts';
import { GlobPattern } from './glob.ts';
import { TAURI_ACL_MANIFESTS, type ManifestPermission, type PluginAclManifest } from './plugins/tauri-acl-manifest.ts';
import { ELECTRON_USER_DATA_VARIABLE } from './scope.ts';
import type { ShellPlatform } from './tauri-config.ts';

/**
 * capability 条目上的 `app` 字段（tauri-plugin-opener `scope_entry::Application`）：
 * 缺省只允许不指定程序；`true` 允许任意程序（含不指定）；字符串只允许该程序。
 */
export type OpenerApplication = boolean | string | null;

export interface OpenerPathEntry {
  path: string;
  app: OpenerApplication;
}

export interface OpenerUrlEntry {
  url: string;
  app: OpenerApplication;
}

/** 各插件在全部 capability 中出现过的作用域条目之并（插件构造时的上界；逐次调用再按 ACL 收窄）。 */
export interface DerivedScopes {
  fsAllow: string[];
  fsDeny: string[];
  openerPathAllow: OpenerPathEntry[];
  openerUrlAllow: OpenerUrlEntry[];
  httpAllow: string[];
  httpDeny: string[];
}

/** 一次调用可用的作用域条目（Tauri `CommandScope` ∪ `GlobalScope`），条目是 capability 层不透明的 JSON 值。 */
export interface ScopeEntries {
  readonly allow: readonly unknown[];
  readonly deny: readonly unknown[];
}

/**
 * Electron 补上的作用域：tauri-plugin-fs 2.4.5 `deny-webview-data.toml` 把 deny 写成顶层 `[[scope.deny]]`，
 * 不属于任何权限，Rust 版本里 `fs:default` 的 `deny-default` 因此没有作用域。外壳按该文件的本意（fs 插件读不到
 * WebView 数据与配置）生效，目标换成 Electron 下 WebView 数据实际所在的位置。两条权限在清单里都不限平台，这里也一样。
 * - `deny-webview-data-linux`：Tauri 指的是 WebKitGTK 的数据目录 `$APPLOCALDATA`。Electron 在各平台都把 WebView 数据
 *   放在 userData（`$ELECTRON_USERDATA`，main 默认 `<appData>/<identifier>.electron`），不在 `$APPLOCALDATA`；而 macOS/Linux
 *   上 `$APPLOCALDATA` 就是 `$APPDATA`，整体 deny 会挡掉 default.json 授予的 AppData 读写（壁纸库、PDF 资源缓存）。
 * - `deny-webview-data-windows`：保留 `$APPLOCALDATA/EBWebView/**`。它是 Tauri 版 WebView2 的用户数据目录，迁移后仍留在
 *   磁盘上（cookie、localStorage、IndexedDB），且与授予的目录不重叠；另加 userData。
 * 两条都另加 Agent 浏览器（browser-content）的会话目录 `$APPDATA/slots/<slot>/browser-profiles`（Host browser 插件
 * `defaultProfileDir`，`session.fromPath`）：用户在内置浏览器里登录网站的 cookie 在这里，它落在授予的 `$APPDATA/**` 之内。
 */
// RUST-FIX(RF-W23-fs-deny-browser-profiles): Rust 版 `$APPDATA/**` 授权覆盖内置浏览器的会话目录（cookie），deny-default 也不生效。
const BROWSER_PROFILES_DENY = [{ path: '$APPDATA/slots/*/browser-profiles' }, { path: '$APPDATA/slots/*/browser-profiles/**' }];

const ELECTRON_PERMISSION_SCOPES: Readonly<Record<string, Readonly<Record<string, ManifestPermission>>>> = {
  fs: {
    // RUST-FIX(RF-W23-fs-deny-webview-data-user-data): Rust 的 deny-default 没有作用域，WebView 数据不受保护；这里 deny 的是 Electron 的 userData。
    'deny-webview-data-linux': { scopeDeny: [{ path: `${ELECTRON_USER_DATA_VARIABLE}/**` }, ...BROWSER_PROFILES_DENY] },
    'deny-webview-data-windows': { scopeDeny: [{ path: '$APPLOCALDATA/EBWebView/**' }, { path: `${ELECTRON_USER_DATA_VARIABLE}/**` }, ...BROWSER_PROFILES_DENY] },
  },
};

/**
 * 不来自任何 capability、外壳始终加上的插件全局作用域。Host 启动时以完整 Node 权限加载
 * `$APPDATA/plugins/user.profile.json` 及其引用的模块（`host/kernel/profile.ts` `loadStartupProfile`），插件数据也在
 * `$APPDATA/plugins/<id>`（`host/kernel/plugin-id.ts`）；default.json 的 `fs:allow-appdata-write-recursive` 会让页面脚本
 * 写进这里，等于把页面脚本升级为下次启动时的 Node 代码执行。插件的安装与数据读写只走 Host。
 *
 * 今后的插件管理器（docs/plugins/FRONTEND.md 规划的下载、解压、启用）必须由 Host 命令完成安装：页面经 `plugin:fs`
 * 写 `$APPDATA/plugins` 会因这条 deny 得到 forbidden path，capability 授权、对话框与拖放加入的运行时作用域都不能重新打开它。
 * 不要为插件管理页放宽或绕过这条 deny；安装需要的用户同意也应在 Host 一侧完成（reviews/ELECTRON-SHELL-SECURITY.md SEC-E06）。
 */
const ELECTRON_GLOBAL_SCOPES: Readonly<Record<string, ScopeEntries>> = {
  // RUST-FIX(RF-W23-fs-deny-host-plugin-dir): Rust 版没有从 AppData 加载代码的插件目录；Electron 的 Host 有，fs 插件不得触及。
  fs: { allow: [], deny: [{ path: '$APPDATA/plugins' }, { path: '$APPDATA/plugins/**' }] },
};

/**
 * fs 插件在所有平台上都生效的受保护 deny：Host 插件目录、Agent 浏览器会话、WebView 数据（两条 deny-webview-data 的并集）。
 * 由上面两张表推出，asset 协议的作用域经 {@link withProtectedDeny} 加上同一份，两处不会漂移。
 */
export const PROTECTED_FS_DENY: readonly string[] = [
  ...new Set(
    [...ELECTRON_GLOBAL_SCOPES.fs!.deny, ...Object.values(ELECTRON_PERMISSION_SCOPES.fs!).flatMap((permission) => permission.scopeDeny ?? [])].map(
      (entry) => (entry as { path: string }).path,
    ),
  ),
];

/** 在作用域条目的 deny 后补上 {@link PROTECTED_FS_DENY}；不改 allow，也不改 `fsScopeFromPatterns` 的默认行为（opener 等不受影响）。 */
// RUST-FIX(RF-W23-asset-scope-protected-deny): Rust 版 asset 作用域 `$APPDATA/**`、`$APPLOCALDATA/**` 没有 deny，页面可经 asset: 读内置浏览器 cookie 与 WebView 数据。
export function withProtectedDeny(deny: readonly string[]): string[] {
  return [...deny, ...PROTECTED_FS_DENY.filter((pattern) => !deny.includes(pattern))];
}

interface ManifestIndex {
  readonly key: string;
  readonly source: PluginAclManifest;
  readonly permissions: ReadonlyMap<string, ManifestPermission>;
  readonly sets: ReadonlyMap<string, readonly string[]>;
  readonly defaults: readonly string[] | null;
}

interface TraversedPermission {
  readonly key: string;
  readonly name: string;
  readonly permission: ManifestPermission;
}

interface ResolvedCommand {
  readonly capability: string;
  /** 被遍历到的权限名（`referenced_by.permission`，不带插件前缀）。 */
  readonly permission: string;
  readonly windows: readonly string[];
  readonly webviews: readonly string[];
  /** `local` 或 remote URL 模式。 */
  readonly origin: string;
  readonly scope: ScopeEntries | null;
}

interface MutableScope {
  allow: unknown[];
  deny: unknown[];
}

function indexManifest(key: string, source: PluginAclManifest): ManifestIndex {
  const permissions = new Map<string, ManifestPermission>();
  for (const command of source.commands) {
    const slug = command.replaceAll('_', '-');
    permissions.set(`allow-${slug}`, { allow: [command] });
    permissions.set(`deny-${slug}`, { deny: [command] });
  }
  for (const [id, permission] of Object.entries(source.permissions)) permissions.set(id, permission);
  for (const [id, extra] of Object.entries(ELECTRON_PERMISSION_SCOPES[key] ?? {})) {
    const base = permissions.get(id);
    if (base === undefined) throw new Error(`Electron scope supplement for unknown permission ${key}:${id}`);
    permissions.set(id, { ...base, ...extra });
  }
  return { key, source, permissions, sets: new Map(Object.entries(source.sets)), defaults: source.default };
}

function hasCommands(permission: ManifestPermission): boolean {
  return (permission.allow?.length ?? 0) > 0 || (permission.deny?.length ?? 0) > 0;
}

/** Tauri capability / permission `platforms` 的取值。 */
function platformName(platform: ShellPlatform): CapabilityPlatform {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'windows' : 'linux';
}

/** `plugin:<name>|<cmd>` 的插件名映射到清单键：核心插件是 `core:<name>`。 */
function manifestKeyOf(plugin: string, manifests: ReadonlyMap<string, ManifestIndex>): string | null {
  if (manifests.has(`core:${plugin}`)) return `core:${plugin}`;
  return manifests.has(plugin) && plugin !== 'core' ? plugin : null;
}

/** 清单键 + 命令 → ACL 命令键（`resolved.rs`：去掉 `core:` 前缀）。 */
function commandKey(key: string, command: string): string {
  return `plugin:${key.startsWith('core:') ? key.slice('core:'.length) : key}|${command}`;
}

function splitPluginCommand(cmd: string): { plugin: string; command: string } {
  const tokens = cmd.slice('plugin:'.length).split('|');
  return { plugin: tokens[0] ?? '', command: tokens[1] ?? '' };
}

// ---------------------------------------------------------------- window/webview 标签与 remote URL 匹配（同 kernel acl.ts）

const LABEL_GLOBS = new Map<string, GlobPattern | null>();
const LABEL_MATCH = { requireLiteralSeparator: false, requireLiteralLeadingDot: false, windows: false };

/** `glob::Pattern::matches`（`MatchOptions::new()`）；无效模式在 Tauri 构建期就会失败，这里按不匹配处理。 */
function labelMatches(pattern: string, label: string): boolean {
  let compiled = LABEL_GLOBS.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = new GlobPattern(pattern, false);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      compiled = null;
    }
    LABEL_GLOBS.set(pattern, compiled);
  }
  return compiled !== null && compiled.matches(label, LABEL_MATCH);
}

interface UrlPatternLike {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  test(input: string): boolean;
}
type UrlPatternConstructor = new (input: string | Record<string, string>) => UrlPatternLike;
const REMOTE_PATTERNS = new Map<string, UrlPatternLike | null>();

/** `RemoteUrlPattern`（tauri-utils 2.9.3 acl/mod.rs）：空 search/hash 与空或 `/` 的 pathname 视为 `*`。 */
function remoteMatches(pattern: string, url: string): boolean {
  let compiled = REMOTE_PATTERNS.get(pattern);
  if (compiled === undefined) {
    const Ctor = (globalThis as { URLPattern?: UrlPatternConstructor }).URLPattern;
    try {
      if (Ctor === undefined) throw new Error('URLPattern is unavailable');
      const parsed = new Ctor(pattern);
      compiled = new Ctor({
        protocol: parsed.protocol,
        username: parsed.username,
        password: parsed.password,
        hostname: parsed.hostname,
        port: parsed.port,
        pathname: parsed.pathname === '' || parsed.pathname === '/' ? '*' : parsed.pathname,
        search: parsed.search === '' ? '*' : parsed.search,
        hash: parsed.hash === '' ? '*' : parsed.hash,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      compiled = null;
    }
    REMOTE_PATTERNS.set(pattern, compiled);
  }
  if (compiled === null) return false;
  try {
    return compiled.test(url);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function references(resolved: readonly ResolvedCommand[]): string {
  return resolved.map((r) => `capability: ${r.capability}, permission: ${r.permission}`).join(' || ');
}

function allowedOn(resolved: readonly ResolvedCommand[]): string {
  if (resolved.length === 0) return 'command not allowed on any window/webview/URL context';
  const entries = resolved.map((r) => {
    const windows = r.windows.map((w) => `"${w}"`).join(', ');
    const webviews = r.webviews.map((w) => `"${w}"`).join(', ');
    return `[${windows ? `windows: ${windows}, ` : ''}${webviews ? `webviews: ${webviews}, ` : ''}URL: ${r.origin}]`;
  });
  return `allowed on: ${entries.join(', ')}`;
}

// ---------------------------------------------------------------- ACL

export class BuiltinAcl {
  private readonly manifests: ReadonlyMap<string, ManifestIndex>;
  private readonly allowed = new Map<string, ResolvedCommand[]>();
  private readonly denied = new Map<string, ResolvedCommand[]>();
  private readonly global = new Map<string, MutableScope>();
  /** 每个清单键在全部 capability 中出现过的作用域条目（按解析顺序），供 `deriveScopes`。 */
  private readonly everyScope = new Map<string, MutableScope>();

  constructor(capabilities: readonly Capability[], platform: ShellPlatform, manifests: Readonly<Record<string, PluginAclManifest>> = TAURI_ACL_MANIFESTS) {
    this.manifests = new Map(Object.entries(manifests).map(([key, manifest]) => [key, indexManifest(key, manifest)]));
    for (const [key, scope] of Object.entries(ELECTRON_GLOBAL_SCOPES)) {
      if (!this.manifests.has(key)) continue;
      for (const table of [this.global, this.everyScope]) {
        const entries = this.scopeOf(table, key);
        entries.allow.push(...scope.allow);
        entries.deny.push(...scope.deny);
      }
    }
    const target = platformName(platform);
    const ordered = [...capabilities].sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0));
    for (const capability of ordered) {
      if (capability.platforms && !capability.platforms.includes(target)) continue;
      for (const entry of capability.permissions) this.resolveEntry(capability, entry, target);
    }
  }

  static fromDirectory(capabilitiesDir: string, platform: ShellPlatform): BuiltinAcl {
    return new BuiltinAcl(readCapabilityDir(capabilitiesDir), platform);
  }

  private scopeOf(table: Map<string, MutableScope>, key: string): MutableScope {
    let scope = table.get(key);
    if (scope === undefined) {
      scope = { allow: [], deny: [] };
      table.set(key, scope);
    }
    return scope;
  }

  private resolveEntry(capability: Capability, entry: Capability['permissions'][number], target: CapabilityPlatform): void {
    const id = typeof entry === 'string' ? entry : entry.identifier;
    // 应用权限（无前缀）由 Host kernel 的 CapabilityAcl 解析。
    if (!id.includes(':')) return;
    const extended = typeof entry === 'string' ? null : entry;
    const traversed = this.traverse(id).filter((t) => t.permission.platforms === undefined || t.permission.platforms.includes(target));
    const resolvedScope = (t: TraversedPermission) => {
      const allow = extended?.allow != null || t.permission.scopeAllow !== undefined ? [...(extended?.allow ?? []), ...(t.permission.scopeAllow ?? [])] : null;
      const deny = extended?.deny != null || t.permission.scopeDeny !== undefined ? [...(extended?.deny ?? []), ...(t.permission.scopeDeny ?? [])] : null;
      return { allow, deny };
    };
    // RF-W23-fs-read-write-scope-split：同插件带命令成员存在时，只有 scope 的成员的 allow 绑定到这些命令。
    const bound = new Map<string, unknown[]>();
    for (const t of traversed) {
      if (!hasCommands(t.permission) || bound.has(t.key)) continue;
      bound.set(t.key, traversed.filter((m) => m.key === t.key && !hasCommands(m.permission)).flatMap((m) => resolvedScope(m).allow ?? []));
    }
    const contexts = [...(capability.local ? ['local'] : []), ...(capability.remote?.urls ?? [])];
    const windows = [...capability.windows].sort();
    const webviews = [...capability.webviews].sort();
    for (const t of traversed) {
      const { allow, deny } = resolvedScope(t);
      const every = this.scopeOf(this.everyScope, t.key);
      every.allow.push(...(allow ?? []));
      every.deny.push(...(deny ?? []));
      if (!hasCommands(t.permission)) {
        const global = this.scopeOf(this.global, t.key);
        global.deny.push(...(deny ?? []));
        if (!bound.has(t.key)) global.allow.push(...(allow ?? []));
        continue;
      }
      const extra = bound.get(t.key) ?? [];
      const commandAllow = allow === null && extra.length === 0 ? null : [...(allow ?? []), ...extra];
      const scope = commandAllow !== null || deny !== null ? { allow: commandAllow ?? [], deny: deny ?? [] } : null;
      for (const [table, commands] of [[this.allowed, t.permission.allow ?? []], [this.denied, t.permission.deny ?? []]] as const) {
        for (const command of commands) {
          const keyed = commandKey(t.key, command);
          const list = table.get(keyed) ?? [];
          for (const origin of contexts) list.push({ capability: capability.identifier, permission: t.name, windows, webviews, origin, scope });
          table.set(keyed, list);
        }
      }
    }
  }

  /** `get_permissions`：把权限标识展开成被遍历到的权限（集合递归展开，跨插件成员按其前缀解析）。 */
  private traverse(id: string): TraversedPermission[] {
    const colon = id.lastIndexOf(':');
    const key = id.slice(0, colon);
    const name = id.slice(colon + 1);
    const manifest = this.manifests.get(key);
    if (manifest === undefined) throw new Error(`unknown plugin manifest \`${key}\` (permission \`${id}\`)`);
    if (name === 'default') return manifest.defaults === null ? [] : this.expandSet(manifest, manifest.defaults, `${key}:default`);
    const set = manifest.sets.get(name);
    if (set !== undefined) return this.expandSet(manifest, set, id);
    const permission = manifest.permissions.get(name);
    if (permission === undefined) throw new Error(`unknown permission \`${name}\` for plugin \`${key}\``);
    return [{ key, name, permission }];
  }

  private expandSet(manifest: ManifestIndex, members: readonly string[], setId: string): TraversedPermission[] {
    const out: TraversedPermission[] = [];
    for (const member of members) {
      const colon = member.lastIndexOf(':');
      const prefixed = colon > 0 ? this.manifests.get(member.slice(0, colon)) : undefined;
      const owner = prefixed ?? manifest;
      const name = prefixed ? member.slice(colon + 1) : member;
      if (name === 'default') {
        if (owner.defaults !== null) out.push(...this.expandSet(owner, owner.defaults, `${owner.key}:default`));
        continue;
      }
      const permission = owner.permissions.get(name);
      if (permission !== undefined) {
        out.push({ key: owner.key, name, permission });
        continue;
      }
      const nested = owner.sets.get(name);
      if (nested === undefined) throw new Error(`permission \`${name}\` not found in set \`${setId}\``);
      out.push(...this.expandSet(owner, nested, `${owner.key}:${name}`));
    }
    return out;
  }

  private matching(cmd: string, source: WindowRef): ResolvedCommand[] {
    const origin = source.origin;
    return (this.allowed.get(cmd) ?? []).filter((r) => {
      const originOk = r.origin === 'local' ? origin === undefined : origin !== undefined && remoteMatches(r.origin, origin);
      return originOk && (r.webviews.some((w) => labelMatches(w, source.webview)) || r.windows.some((w) => labelMatches(w, source.window)));
    });
  }

  private combinedScope(cmd: string, resolved: readonly ResolvedCommand[]): ScopeEntries {
    const key = manifestKeyOf(splitPluginCommand(cmd).plugin, this.manifests);
    const global = key === null ? undefined : this.global.get(key);
    const allow = [...(global?.allow ?? [])];
    const deny = [...(global?.deny ?? [])];
    for (const r of resolved) {
      if (r.scope === null) continue;
      allow.push(...r.scope.allow);
      deny.push(...r.scope.deny);
    }
    return { allow, deny };
  }

  /**
   * `resolve_access`：允许时返回本次调用的作用域（命令作用域 ∪ 插件全局作用域），拒绝时返回 null。
   * 与 Tauri 一致：命令只要有任一 deny 条目就拒绝（authority.rs 对 `Option<bool>` 调 `is_some()`）。
   */
  authorize(cmd: string, source: WindowRef): ScopeEntries | null {
    if (this.denied.has(cmd)) return null;
    const resolved = this.matching(cmd, source);
    return resolved.length === 0 ? null : this.combinedScope(cmd, resolved);
  }

  /** 不做授权判定，只给出该调用方对 `cmd` 可用的作用域（Host 代办的外壳操作、同插件其他命令的作用域）。 */
  scopeFor(cmd: string, source: WindowRef): ScopeEntries {
    return this.combinedScope(cmd, this.matching(cmd, source));
  }

  /** `resolve_access_message`（debug）与 release 版的 `Command {cmd} not allowed by ACL`。 */
  denial(cmd: string, source: WindowRef, debug: boolean): string {
    if (!debug) return `Command ${cmd} not allowed by ACL`;
    const { plugin, command } = splitPluginCommand(cmd);
    const pretty = `${plugin}.${command}`;
    const origin = source.origin ?? 'local';
    const denied = this.denied.get(cmd);
    if (denied !== undefined) return `${pretty} explicitly denied on origin ${origin}\n\nreferenced by: ${references(denied)}`;
    const allowed = this.allowed.get(cmd);
    if (allowed !== undefined) {
      return `${pretty} not allowed on window "${source.window}", webview "${source.webview}", URL: ${origin}\n\n${allowedOn(allowed)}\n\nreferenced by: ${references(allowed)}`;
    }
    const key = manifestKeyOf(plugin, this.manifests);
    if (key === null) return `${pretty} not allowed. Plugin not found`;
    const associated = this.permissionsAllowing(this.manifests.get(key) as ManifestIndex, command);
    return associated.length === 0
      ? `${pretty} not allowed. Command not found`
      : `${pretty} not allowed. Permissions associated with this command: ${associated.map((p) => `${key}:${p}`).join(', ')}`;
  }

  /** `has_permissions_allowing_command` 的列举：默认集记为 `default`，集合与权限按名称排序。 */
  private permissionsAllowing(manifest: ManifestIndex, command: string): string[] {
    const viaSet = (members: readonly string[], seen: Set<string>): boolean => members.some((member) => {
      if (member === 'default') return manifest.defaults !== null && !seen.has('default') && viaSet(manifest.defaults, new Set([...seen, 'default']));
      const set = manifest.sets.get(member);
      if (set !== undefined) return !seen.has(member) && viaSet(set, new Set([...seen, member]));
      return manifest.permissions.get(member)?.allow?.includes(command) === true;
    });
    const out: string[] = [];
    if (manifest.defaults !== null && viaSet(manifest.defaults, new Set(['default']))) out.push('default');
    for (const [id, members] of manifest.sets) if (viaSet(members, new Set([id]))) out.push(id);
    for (const [id, permission] of manifest.permissions) if (permission.allow?.includes(command)) out.push(id);
    return out.sort();
  }

  /** 已注册的内置插件命令是否在清单中有归属（至少一个权限允许它）。 */
  hasOwner(plugin: string, command: string): boolean {
    const key = manifestKeyOf(plugin, this.manifests);
    return key !== null && this.permissionsAllowing(this.manifests.get(key) as ManifestIndex, command).length > 0;
  }

  /** 某插件在全部 capability 中出现过的作用域条目（含全局与命令作用域）。 */
  everyScopeOf(plugin: string): ScopeEntries {
    const key = manifestKeyOf(plugin, this.manifests);
    const scope = key === null ? undefined : this.everyScope.get(key);
    return { allow: [...(scope?.allow ?? [])], deny: [...(scope?.deny ?? [])] };
  }

  /** 某调用方（window/webview/来源）被授予的全部内置插件命令，供报告与测试列出各窗口的命令集。 */
  grantedCommands(source: WindowRef): string[] {
    return [...this.allowed.keys()].filter((cmd) => this.authorize(cmd, source) !== null).sort();
  }
}

// ---------------------------------------------------------------- 作用域条目

/** capability 条目的 `app` 字段（无值 / 其他类型都按缺省处理）。 */
function openerApplication(entry: Record<string, unknown>): OpenerApplication {
  return typeof entry.app === 'boolean' || typeof entry.app === 'string' ? entry.app : null;
}

/** Plugin scope entries are opaque `serde_json::Value`s at the capability layer. */
function scopeField(entry: unknown, key: string): { value: string; entry: Record<string, unknown> } | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const value = record[key];
  return typeof value === 'string' && value !== '' ? { value, entry: record } : null;
}

/** fs / http 的作用域条目是 untagged：字符串本身，或 `{ path }` / `{ url }` 对象。 */
export function scopeString(entry: unknown, key: 'path' | 'url'): string | null {
  if (typeof entry === 'string') return entry === '' ? null : entry;
  return scopeField(entry, key)?.value ?? null;
}

export function openerPathEntries(entries: readonly unknown[]): OpenerPathEntry[] {
  const out: OpenerPathEntry[] = [];
  for (const raw of entries) {
    const field = scopeField(raw, 'path');
    if (field) pushUnique(out, { path: field.value, app: openerApplication(field.entry) }, (a, b) => a.path === b.path && a.app === b.app);
  }
  return out;
}

export function openerUrlEntries(entries: readonly unknown[]): OpenerUrlEntry[] {
  const out: OpenerUrlEntry[] = [];
  for (const raw of entries) {
    const field = scopeField(raw, 'url');
    if (field) pushUnique(out, { url: field.value, app: openerApplication(field.entry) }, (a, b) => a.url === b.url && a.app === b.app);
  }
  return out;
}

function pushUnique<T>(out: T[], value: T, same: (a: T, b: T) => boolean): void {
  if (!out.some((existing) => same(existing, value))) out.push(value);
}

function strings(entries: readonly unknown[], key: 'path' | 'url'): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const value = scopeString(entry, key);
    if (value !== null && !out.includes(value)) out.push(value);
  }
  return out;
}

export function scopesFromAcl(acl: BuiltinAcl): DerivedScopes {
  const fs = acl.everyScopeOf('fs');
  const opener = acl.everyScopeOf('opener');
  const http = acl.everyScopeOf('http');
  return {
    fsAllow: strings(fs.allow, 'path'),
    fsDeny: strings(fs.deny, 'path'),
    openerPathAllow: openerPathEntries(opener.allow),
    openerUrlAllow: openerUrlEntries(opener.allow),
    httpAllow: strings(http.allow, 'url'),
    httpDeny: strings(http.deny, 'url'),
  };
}

export function deriveScopes(capabilitiesDir: string, platform: ShellPlatform): DerivedScopes {
  return scopesFromAcl(BuiltinAcl.fromDirectory(capabilitiesDir, platform));
}

/**
 * `Application::matches`（tauri-plugin-opener 2.5.3 `scope.rs`）：缺省只匹配未指定程序，
 * 布尔值直接作为结果，字符串要求程序名完全相同。
 */
export function openerApplicationMatches(app: OpenerApplication, withApp: string | null): boolean {
  if (app === null) return withApp === null;
  if (typeof app === 'boolean') return app;
  return app === withApp;
}

/** `plugin:opener|open_url` 的作用域判定：URL 可解析，且某个条目的 `url` 模式与 `app` 约束同时匹配。 */
export function openerUrlAllowed(entries: readonly OpenerUrlEntry[], url: string, withApp: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  return entries.some((entry) => urlPatternMatches(entry.url, parsed) && openerApplicationMatches(entry.app, withApp));
}

/**
 * URLPattern 子集匹配（tauri-plugin-http / opener 的 `url` scope 条目，如 `https://*\/*`、`http://127.0.0.1:*\/*`、
 * `mailto:*`）：协议、主机、端口、路径各段中的 `*` 匹配任意字符串。
 */
export function urlPatternMatches(pattern: string, url: URL): boolean {
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const m = /^([a-z][a-z0-9+.-]*):(\/\/)?(.*)$/i.exec(pattern);
  if (!m) return false;
  const protocol = (m[1] as string).toLowerCase();
  if (`${protocol}:` !== url.protocol) return false;
  const rest = m[3] as string;
  if (m[2] === undefined) return new RegExp(`^${esc(rest)}$`).test(url.href.slice(url.protocol.length));
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '*' : rest.slice(slash);
  const colon = authority.lastIndexOf(':');
  const host = colon < 0 ? authority : authority.slice(0, colon);
  const port = colon < 0 ? '' : authority.slice(colon + 1);
  if (!new RegExp(`^${esc(host)}$`, 'i').test(url.hostname)) return false;
  if (port === '') {
    if (url.port !== '') return false;
  } else if (!new RegExp(`^${esc(port)}$`).test(url.port)) {
    return false;
  }
  return new RegExp(`^${esc(path)}$`).test(url.pathname);
}
