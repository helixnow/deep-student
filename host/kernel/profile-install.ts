/**
 * Profile 的安装半（可移植）：按插件隔离安装已导入的条目、拓扑排序、核心服务检查与降级记录。
 * 解析 profile 文件、导入模块与清单筛查在桌面入口 profile.ts；没有文件系统的宿主（移动端 Web Worker）
 * 直接用 {@link loadImportedProfile}。
 */
import type { DegradedPlugin, HostPlugin, PluginPlatform } from './api.ts';
import type { PluginManifest } from './manifest.ts';
import { PluginLoadError, parseDegradedReason } from './plugin-load-error.ts';
import type { HostRuntime, InstalledPlugin, PluginInstall } from './runtime.ts';

export interface ProfileInstallOptions {
  /**
   * 装载结束后要求平台核心服务（{@link CORE_SERVICES}）全部可用；缺失视为平台未就绪，
   * 抛 {@link ProfileError}（HostFatal）。官方 profile 与用户 profile 的启动分支启用；
   * 显式 `--profile` 与测试夹具保持关闭（它们通常只提供业务插件）。
   */
  requireCoreServices?: boolean;
  /**
   * 当前平台。给出时，平台不在官方插件 `meta.platforms`（缺省 `['desktop']`）或社区插件清单
   * `platforms` 内的条目不装载，降级原因 `UNSUPPORTED_ON_PLATFORM`。`loadStartupProfile` 缺省为 `desktop`。
   */
  platform?: PluginPlatform;
  /**
   * 社区条目的装载前门（K3 同意，W32 账本）：在清单检查之后、**导入之前**调用；
   * 返回非 null 即拒绝该条目（原因加上 `CONSENT_REQUIRED: ` 前缀），社区代码不执行。
   * 账本读取失败也必须返回原因（fail closed）。
   */
  communityGate?: (manifest: PluginManifest) => string | null | { trust: 'full' | 'restricted' } | Promise<string | null | { trust: 'full' | 'restricted' }>;
}

/** 导入前或导入后、安装前就被拒绝的条目（清单 / 平台 / requires / 服务冲突）。 */
export interface RejectedEntry extends DegradedPlugin {
  /** 已导入时的插件：其命令登记为维护占位，提供的服务按 inactive 级联。 */
  plugin?: HostPlugin<any>;
}

/**
 * 平台核心服务：缺任一即视为 HostFatal（`storage`/`paths`/`log` 不可用）。
 * 其他服务缺失只让依赖它的插件 inactive（见 {@link installProfile}）。
 */
export const CORE_SERVICES = ['storage', 'paths', 'log'] as const;

/** 一次 profile 装载的结果：实际安装的插件与未安装的插件（degraded）。 */
export interface ProfileLoadResult {
  installed: InstalledPlugin[];
  degraded: DegradedPlugin[];
}

export class ProfileError extends Error {
  override name = 'ProfileError';
}

/** 安装前拒绝的条目（原因取错误消息，即 `CODE: detail`）。 */
export const rejection = (id: string, error: unknown, plugin?: HostPlugin<any>): RejectedEntry => ({
  id,
  reason: error instanceof Error ? error.message : String(error),
  ...(plugin ? { plugin } : {}),
});

/** 官方插件 `meta.platforms`（缺省 `['desktop']`）不含 `platform` 时的拒绝原因；支持时 `null`。 */
export function platformProblem(plugin: HostPlugin<any>, platform: PluginPlatform | undefined): PluginLoadError | null {
  const platforms = plugin.meta.platforms ?? ['desktop'];
  if (platform === undefined || platforms.includes(platform)) return null;
  return new PluginLoadError('UNSUPPORTED_ON_PLATFORM', plugin.meta.id, `plugin "${plugin.meta.id}" supports ${platforms.join(', ')}, not ${platform}`);
}

/**
 * 安装宿主已静态导入的插件条目（没有文件系统 profile 的宿主，如移动端 Web Worker）。
 * 与 profile.ts 的 `loadProfile` 共用安装隔离、核心服务检查与 UI 清单推送，只是跳过解析与动态导入。
 */
export function loadImportedProfile(runtime: HostRuntime, installs: readonly PluginInstall[], options: ProfileInstallOptions = {}): Promise<ProfileLoadResult> {
  const rejected: RejectedEntry[] = [];
  const supported = installs.filter(({ plugin }) => {
    const problem = platformProblem(plugin, options.platform);
    if (problem) rejected.push(rejection(plugin.meta.id, problem, plugin));
    return problem === null;
  });
  return finishProfile(runtime, supported, options, rejected);
}

/** 安装已导入的条目，并按需检查平台核心服务。 */
export async function finishProfile(runtime: HostRuntime, installs: readonly PluginInstall[], options: ProfileInstallOptions, rejected: readonly RejectedEntry[] = []): Promise<ProfileLoadResult> {
  const result = await installProfile(runtime, installs, rejected);
  runtime.startup.mark('plugins installed');
  if (options.requireCoreServices) assertCoreServices(runtime);
  // profile 装载完成（启动 / 回退）后推送 UI 引导清单；逐插件安装不走 install()，需在这里统一通知。
  runtime.emitUiManifest();
  return result;
}

function assertCoreServices(runtime: HostRuntime): void {
  const missing = CORE_SERVICES.filter(name => runtime.ctx.get(name) === undefined);
  if (missing.length) throw new ProfileError(`platform core services unavailable: ${missing.map(name => `"${name}"`).join(', ')}`);
}

/**
 * 按插件隔离安装（`docs/plugins/SDK.md` §6）：先做拓扑排序，再逐个安装。
 *
 * - `inject` 的服务在运行时不存在的条目**不安装**，记为 inactive（原因 `missing service "X"`）；
 *   它声明的服务因此不可用，依赖这些服务的后续条目同样 inactive（级联，原因注明 inactive 的提供方）。
 * - `apply` / 启动校验失败只撤销该插件自身（`HostRuntime.installIsolated`），其余条目继续。
 * - 结束后把全部未安装条目交给 `HostRuntime.recordDegraded`：逐条 warn、非空时广播 `host://plugins-degraded`；
 *   它们声明的命令登记为维护占位（`CommandService._setPlaceholders`），启动维护态下返回 MAINTENANCE 错误。
 *
 * 重复提供服务与依赖环是 profile 结构错误，在安装任何插件之前抛出。
 * `rejected` 是安装前已被拒绝的条目（profile.ts `prepareProfile`、{@link loadImportedProfile} 的平台检查）：排在降级列表最前，其服务同样按 inactive 级联。
 */
export async function installProfile(runtime: HostRuntime, installs: readonly PluginInstall[], rejected: readonly RejectedEntry[] = []): Promise<ProfileLoadResult> {
  const ordered = orderForProfile(installs);
  const installed: InstalledPlugin[] = [];
  const degraded: DegradedPlugin[] = rejected.map(({ id, reason }) => ({ id, reason }));
  /** 服务 → 本 profile 中未能装载的声明提供方（用于级联原因）。 */
  const unavailable = new Map<string, string>();
  for (const { id, plugin } of rejected) for (const name of plugin?.meta.provides ?? []) if (!unavailable.has(name)) unavailable.set(name, id);

  for (const entry of ordered) {
    const id = entry.plugin.meta.id;
    const missing = dependenciesOf(entry).filter(name => !runtime.hasDependency(entry, name));
    if (missing.length) {
      // RUST-FIX(RF-W01-degraded-error-codes): 保留原 detail，补可供 UI 解析的稳定错误码。
      degraded.push({ id, reason: 'SERVICE_MISSING: ' + missing.map(name => {
        const provider = unavailable.get(name);
        return provider === undefined ? `missing service "${name}"` : `missing service "${name}" (provided by inactive plugin "${provider}")`;
      }).join(', ') });
      for (const name of entry.plugin.meta.provides ?? []) unavailable.set(name, id);
      continue;
    }
    const result = await runtime.installIsolated(entry);
    if (result.ok) {
      installed.push(result.value);
      continue;
    }
    degraded.push({ id, reason: parseDegradedReason(result.reason).code ? result.reason : `APPLY_FAILED: ${result.reason}` });
    for (const name of entry.plugin.meta.provides ?? []) unavailable.set(name, id);
  }

  const degradedIds = new Set(degraded.map(plugin => plugin.id));
  runtime.commands._setPlaceholders([
    ...rejected.flatMap(({ id, plugin }) => (plugin ? [{ id, commands: plugin.meta.commands ?? [] }] : [])),
    ...ordered
      .filter(entry => degradedIds.has(entry.plugin.meta.id))
      .map(entry => ({ id: entry.plugin.meta.id, commands: entry.plugin.meta.commands ?? [] })),
  ]);
  runtime.recordDegraded(degraded);
  return { installed, degraded };
}

function dependenciesOf(entry: PluginInstall): readonly string[] {
  return Array.isArray(entry.plugin.inject) ? entry.plugin.inject : Object.keys(entry.plugin.inject ?? {});
}

/**
 * 稳定拓扑排序：本 profile 内提供服务的条目排在消费者之前，独立条目保持 profile 顺序。
 *
 * 与旧版 `orderByDependencies` 的差别：运行时缺失的服务**不再**让排序失败（该条目稍后由
 * {@link installProfile} 标为 inactive），但重复提供服务与依赖环仍是 profile 结构错误。
 */
export function orderForProfile(entries: readonly PluginInstall[]): PluginInstall[] {
  const providers = new Map<string, string>();
  for (const { plugin } of entries) for (const service of plugin.meta.provides ?? []) {
    const existing = providers.get(service);
    if (existing !== undefined) throw new ProfileError(`service "${service}" provided by both "${existing}" and "${plugin.meta.id}"`);
    providers.set(service, plugin.meta.id);
  }
  const remaining = [...entries], ordered: PluginInstall[] = [];
  const ready = new Set<string>();
  while (remaining.length) {
    // 只等待本 profile 内有人提供的服务；无人提供的服务在安装阶段判定为 inactive。
    const index = remaining.findIndex(entry => dependenciesOf(entry).every(name => ready.has(name) || !providers.has(name)));
    if (index < 0) throw new ProfileError(`plugin dependency cycle: ${remaining.map(e => e.plugin.meta.id).join(', ')}`);
    const entry = remaining.splice(index, 1)[0]!;
    ordered.push(entry);
    for (const name of entry.plugin.meta.provides ?? []) ready.add(name);
  }
  return ordered;
}
