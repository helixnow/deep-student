/**
 * 渲染进程的 UI 插件内核（docs/plugins/FRONTEND.md）。
 *
 * 与 Host 端同一框架（Cordis）：UI 插件是 `apply(ctx)`，贡献物（视图、导航项、设置分区、命令、block 渲染器……）
 * 都登记为当前插件 fiber 的副作用，插件卸载、被同 id 覆盖或安装失败时自动撤销。
 *
 * 内核本身不依赖任何业务模块；现有的应用注册表（命令面板、对话 block、工作台应用、i18n）通过 `UiAdapters`
 * 注入（见 bootstrap.ts），测试可以传入内存实现。
 *
 * 插件定义与适配接口在 plugin.ts，`ctx.ui`（UiService）在 ui-service.ts；这里是内核本身（安装、跳过、卸载、Host 对账）
 * 和对外的统一导出。
 */
import { Context } from '@deepseek-ai/cordis';
import { SlotStore, type UiPluginOrigin } from './slots';
import { currentUiBuild, normalizeUiPluginMeta, pluginNamespace, requiredHostPlugins, UiPluginDependencyError, UiPluginMetaError, type NormalizedUiPluginMeta, type UiBuildKind, type UiPlatformKind } from './meta';
import { UiPluginScope } from './scope';
import { UiPlatformService } from './services/platform';
import { UiNavigationService } from './services/navigation';
import { UiStorageService } from './services/storage';
import { UiI18nService } from './services/i18n';
import { UiErrorBudget, type UiErrorBudgetOptions } from './services/errors';
import { UiAdapterRegistry } from './registries';
import { createLegacyRegistryAdapters } from './legacy-adapters';
import { UiHostStatusService, type HostAvailability } from './services/host-status';
import { AnchorRegistry } from './services/anchors';
import { ExcerptDndHub } from './services/excerpt-dnd';
import type { UiAdapters, UiKernelRegistries, UiPlugin, UiPluginInstallOptions, UiPluginOwner } from './plugin';
import { UiService } from './ui-service';
export type { UiPluginOrigin } from './slots';
export type { LazyContributionPoint } from './lazy';
export type { UiChatBlock, UiChatEventHandler, UiChatMode, UiCommand, UiWorkbenchApp } from './contracts/registries';
export type { LegacyRegistries } from './legacy-adapters';
export type { UiRegistryKind, UiRegistrySource } from './registries';
export type { UiDisabledPlugin, UiErrorBudgetOptions, UiErrorPhase, UiPluginErrorReport } from './services/errors';
export type { UiI18nAdapter, UiTranslate, UiTranslateOptions } from './services/i18n';
export type { PluginStore, PluginStoreInit, PluginStoreOptions } from './services/store';
export type { PluginStorage, PluginStorageCell, UiStorageBackend } from './services/storage';
export type { UiNavigationRequest, UiNavigator } from './services/navigation';
export type { SlotMap, SlotName, SlotValue } from './slot-map';
export type { UiPluginMeta, NormalizedUiPluginMeta, UiPlatformKind, UiBuildKind } from './meta';
export type { UiPlatformInfo } from './services/platform';
export type { HostAvailability, HostDegradedPlugin, HostPluginInventory, HostPluginState, UiDegradedCode, UiDegradedInfo, UiHostStatusHandle } from './services/host-status';
export type { HostEventSubscriptionOptions, UiEventTransport } from './services/events';
export type {
  AnchorEdgesAdapter,
  AnchorEdgesChangedDetail,
  AnchorMatchQuality,
  AnchorRevealContext,
  AnchorRevealHandler,
  AnchorRevealOptions,
  AnchorRevealOutcome,
  AnchorRevealResult,
  OpenAnchorAdapter,
  UiAnchorsHandle,
} from './services/anchors';
export type { ExcerptDropTargetOptions, UiExcerptDndHandle } from './services/excerpt-dnd';
export { defineUiPlugin } from './plugin';
export type { RemoteHost, UiAdapters, UiDisposer, UiKernelRegistries, UiPlatformHandle, UiPlugin, UiPluginInstallOptions, UiPluginOwner } from './plugin';
export { BUILTIN_SLOTS, UiService } from './ui-service';
export type { UiContextMenuItemV1 } from './ui-service';

/**
 * 社区插件文案的严格模式（插件生态 v1：命名空间由插件 id 派生）。打开时 API v1 社区插件用 `addBundle`
 * 写非派生命名空间也直接报错，与 API v2 相同；关闭时放行，并告警一次（迁移期的行为）。
 * `UiKernelOptions.strictCommunityNamespaces` 可逐个内核覆盖。
 */
// RUST-FIX(RF-W17-community-i18n-strict): 迁移期为 false，API v1 社区插件写非派生命名空间只告警，并可借此认领通用命名空间
export const STRICT_COMMUNITY_NAMESPACES = true;

// ------------------------------------------------------------------ 内核

export interface InstalledUiPlugin {
  id: string;
  origin: UiPluginOrigin;
  plugin: UiPlugin<any>;
  fiber: { dispose(): unknown; ctx?: Context };
  meta: NormalizedUiPluginMeta;
  /** 当前一次 apply 的作用域；fiber 失效后为 undefined。 */
  scope?: UiPluginScope;
  /** 安装参数（Host 状态变化时按原参数重装）。 */
  options?: UiPluginInstallOptions<any>;
  /** 安装时所需 Host 插件的可用性（不配对的插件为 available）。 */
  availability?: HostAvailability;
}

/** `kernel.pairing()` 的条目：配对 Host 的 UI 插件与插件内配对半的对账结果。 */
export interface UiHostPairing {
  /** UI 插件 id；配对半为其 meta.id。 */
  id: string;
  kind: 'plugin' | 'half';
  /** 配对半所在的 UI 插件。 */
  parent?: string;
  hosts: string[];
  availability: HostAvailability;
  /** 是否已装配（缺失时为 false）。 */
  active: boolean;
}

interface PairedHalf {
  id: string;
  parent: string;
  hosts: string[];
  availability?: HostAvailability;
  fiber?: { dispose(): unknown };
}

/** 生产构建中卸载核心插件（`meta.core`），或用社区插件替换它。 */
export class UiCorePluginError extends Error {
  constructor(readonly pluginId: string, readonly action: 'unload' | 'replace') {
    super(action === 'unload'
      ? `"${pluginId}" is a core UI plugin and cannot be unloaded in production`
      : `"${pluginId}" is a core UI plugin and cannot be replaced by a community plugin in production`);
    this.name = 'UiCorePluginError';
  }
}

/** `kernel.plugins()` 的条目：供 FE-A3 对账与插件管理页使用。 */
export interface UiInstalledPluginInfo {
  id: string;
  origin: UiPluginOrigin;
  meta: NormalizedUiPluginMeta;
  /** 需要在线的 Host 插件（配对的 Host 半 + requiresHost）。 */
  hostPlugins: string[];
}

/**
 * `kernel.skipped()` 的条目：`platform` 为平台不符，`build` 为生产构建中的 `devOnly` 插件，
 * `requires` 为 `meta.requires` 里尚未安装的依赖全都被跳过（`requires` 列出这些依赖）。
 */
export type UiSkippedPlugin =
  | { id: string; reason: 'platform'; platform: UiPlatformKind; platforms: readonly UiPlatformKind[] }
  | { id: string; reason: 'build'; build: UiBuildKind }
  | { id: string; reason: 'requires'; requires: readonly string[] };

export interface UiKernelOptions {
  errorBudget?: UiErrorBudgetOptions;
  /** 缺省取 Vite 的 `import.meta.env.DEV`；决定 `meta.devOnly` 插件是否安装。 */
  build?: UiBuildKind;
  /** 缺省为 `STRICT_COMMUNITY_NAMESPACES`。 */
  strictCommunityNamespaces?: boolean;
  /** 跨插件锚点打开新面板后等待揭示处理器挂载的超时毫秒数（默认 1500ms）。 */
  pendingRevealTimeoutMs?: number;
}

const KERNEL_OWNER: UiPluginOwner = Object.freeze({ id: 'ui-kernel', origin: 'community' });

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class UiKernel {
  readonly root: Context;
  readonly slots = new SlotStore();
  readonly platform: UiPlatformService;
  readonly navigation: UiNavigationService;
  readonly storage: UiStorageService;
  readonly i18n: UiI18nService;
  /** 渲染错误与插件自报错误的计数；社区插件耗尽预算即自动卸载。 */
  readonly errors: UiErrorBudget;
  /** 命令、对话 block、工作台应用注册表的可订阅视图（FE-B 接入用）。 */
  readonly registries: UiKernelRegistries;
  /** Host 插件状态（FE-A3）：由 `community.ts` 的 Host 同步写入，清单到达前全部为 unknown。 */
  readonly hostStatus = new UiHostStatusService();
  /** 跨插件语义锚点路由与反向链接图服务。 */
  readonly anchors: AnchorRegistry;
  /** 跨插件子资源摘录拖拽与自动摘录总线。 */
  readonly dnd: ExcerptDndHub;
  /** 构建类型：生产构建跳过 `meta.devOnly` 插件。 */
  readonly build: UiBuildKind;
  /** 社区插件文案严格模式（见 `STRICT_COMMUNITY_NAMESPACES`）。 */
  readonly strictCommunityNamespaces: boolean;
  private readonly installed = new Map<string, InstalledUiPlugin>();
  private readonly skippedPlugins = new Map<string, UiSkippedPlugin>();
  /** 被跳过插件在 `meta.slots` 里列出的槽位 → 该插件 id。 */
  private readonly skippedSlots = new Map<string, string>();
  /** 已告警过的“贡献者 + 槽位”（开发构建每对只告警一次）。 */
  private readonly droppedContributions = new Set<string>();
  /** 因所需 Host 插件缺失而撤下的插件（Host 插件回来时按原参数重装）。 */
  private readonly withheld = new Map<string, { plugin: UiPlugin<any>; options: UiPluginInstallOptions<any>; hosts: string[] }>();
  private readonly halves = new Map<string, PairedHalf>();
  private readonly fiberOwner = new WeakMap<object, UiPluginScope>();
  /** 配对半的 fiber → 该半的 id（`ctx.ui.host` 的 caller）。 */
  private readonly halfFiber = new WeakMap<object, string>();
  private pending: Promise<void> = Promise.resolve();

  constructor(input: UiAdapters = {}, options: UiKernelOptions = {}) {
    const { legacyRegistries, ...explicit } = input;
    const adapters: UiAdapters = legacyRegistries ? { ...createLegacyRegistryAdapters(legacyRegistries), ...stripUndefined(explicit) } : explicit;
    this.root = new Context();
    this.build = options.build ?? currentUiBuild();
    this.strictCommunityNamespaces = options.strictCommunityNamespaces ?? STRICT_COMMUNITY_NAMESPACES;
    this.errors = new UiErrorBudget(options.errorBudget ?? {}, (id) => {
      void this.unload(id).catch((error) => console.error(`[ui-plugins] failed to unload "${id}" after exhausting its error budget`, error));
    });
    this.platform = new UiPlatformService(adapters.platform);
    this.navigation = new UiNavigationService((view) => !!this.slots.get('views', view), adapters.navigate);
    this.storage = new UiStorageService(adapters.storage);
    this.i18n = new UiI18nService(adapters.i18n);
    this.registries = Object.freeze({
      commands: new UiAdapterRegistry('commands', adapters.commands),
      chatBlocks: new UiAdapterRegistry('chatBlocks', adapters.chatBlocks),
      chatEvents: new UiAdapterRegistry('chatEvents', adapters.chatEvents),
      chatModes: new UiAdapterRegistry('chatModes', adapters.chatModes),
      workbenchApps: new UiAdapterRegistry('workbenchApps', adapters.workbenchApps),
    });
    this.anchors = new AnchorRegistry({
      openAnchor: adapters.openAnchor,
      anchorEdges: adapters.anchorEdges,
      pendingRevealTimeoutMs: options.pendingRevealTimeoutMs,
    });
    this.dnd = new ExcerptDndHub();
    // Service 构造时即以 'ui' 注册到根 context。
    new UiService(this.root, {
      slots: this.slots,
      adapters,
      platform: this.platform,
      navigation: this.navigation,
      storage: this.storage,
      i18n: this.i18n,
      errors: this.errors,
      registries: this.registries,
      hostStatus: this.hostStatus,
      anchors: this.anchors,
      dnd: this.dnd,
      strictCommunityNamespaces: this.strictCommunityNamespaces,
      ownerOf: (ctx) => this.scopeOf(ctx) ?? KERNEL_OWNER,
      scopeOf: (ctx) => this.scopeOf(ctx),
      callerOf: (ctx) => this.nearest(ctx, (fiber) => this.halfFiber.get(fiber) ?? this.fiberOwner.get(fiber)?.id),
      pair: (ctx, half) => this.pairHalf(ctx, half),
      skippedSlotOwner: (slot) => this.skippedSlots.get(slot),
      dropContribution: (contributor, slot, owner) => this.dropContribution(contributor, slot, owner),
    });
    this.hostStatus.subscribe(() => this.enqueue(() => this.reconcileHosts(), 'host reconciliation'));
  }

  /**
   * 安装 UI 插件；同 id 已安装时先卸载旧的（同 id 覆盖）。apply 失败时撤销其全部贡献并抛出原错误。
   * meta 不合法或缺少 `requires` 依赖时直接拒绝；`platforms` 不含当前平台、生产构建中的 `devOnly` 插件、
   * 以及缺少的依赖全都是被跳过插件的插件，跳过并返回 false（见 `skipped()`）；所需 Host 插件已知缺失时暂不安装并返回 false（Host 插件回来后自动安装，见 `pairing()`）。
   */
  async install<C>(plugin: UiPlugin<C>, options: UiPluginInstallOptions<C> = {}): Promise<boolean> {
    if (!plugin?.meta?.id || typeof plugin.apply !== 'function') throw new TypeError('install: expected a UI plugin created by defineUiPlugin');
    const meta = normalizeUiPluginMeta(plugin.meta);
    const id = meta.id;
    const origin = options.origin ?? 'community';
    if (meta.core && origin !== 'builtin') throw new UiPluginMetaError(`${id}: meta.core is reserved for official plugins`);
    if (origin !== 'builtin' && meta.namespace !== pluginNamespace(id)) {
      throw new UiPluginMetaError(`${id}: meta.i18n.namespace must be "${pluginNamespace(id)}" (namespaces are derived from the plugin id)`);
    }
    if (origin !== 'builtin' && this.isProtectedCore(id)) throw new UiCorePluginError(id, 'replace');
    if (meta.platforms && !meta.platforms.includes(this.platform.kind)) {
      if (this.installed.has(id)) await this.release(id);
      this.skip(meta, { id, reason: 'platform', platform: this.platform.kind, platforms: meta.platforms });
      return false;
    }
    if (meta.devOnly && this.build !== 'development') {
      if (this.installed.has(id)) await this.release(id);
      this.skip(meta, { id, reason: 'build', build: this.build });
      return false;
    }
    const missing = meta.requires.filter((dep) => !this.installed.has(dep));
    if (missing.length && missing.every((dep) => this.skippedPlugins.has(dep))) {
      if (this.installed.has(id)) await this.release(id);
      this.skip(meta, { id, reason: 'requires', requires: missing });
      return false;
    }
    if (missing.length) throw new UiPluginDependencyError(id, missing);
    this.unskip(id);
    const hosts = requiredHostPlugins(meta);
    const availability = this.hostStatus.availability(hosts);
    if (availability === 'missing') {
      if (this.installed.has(id)) await this.release(id);
      this.withheld.set(id, { plugin, options, hosts });
      return false;
    }
    if (this.installed.has(id)) await this.release(id);
    this.withheld.delete(id);
    let failure: unknown;
    const entry: InstalledUiPlugin = { id, origin, plugin, meta, fiber: undefined as never, options, availability };
    const wrapped = {
      name: plugin.name,
      inject: plugin.inject ? [...plugin.inject] : undefined,
      apply: async (ctx: Context, cfg: C) => {
        const scope = new UiPluginScope(meta, origin);
        this.fiberOwner.set(ctx.fiber, scope);
        entry.scope = scope;
        ctx.effect(() => () => {
          if (entry.scope === scope) entry.scope = undefined;
          scope.dispose();
        }, 'ui.scope');
        try {
          await plugin.apply(ctx, cfg);
        } catch (e) {
          failure = e;
          throw e;
        }
      },
    };
    const fiber = this.root.plugin(wrapped as any, options.config as any);
    entry.fiber = fiber as any;
    this.installed.set(id, entry);
    try {
      await fiber;
    } catch (e) {
      failure ??= e;
    }
    if (failure) {
      this.errors.report({ pluginId: id, origin: entry.origin, phase: 'report', slot: 'plugin.apply', error: failure });
      await this.release(id);
      throw failure;
    }
    this.errors.reset(id);
    return true;
  }

  /**
   * 卸载插件。生产构建中的核心插件（`meta.core`）拒绝卸载并抛出 `UiCorePluginError`；内核自身的拆除（`dispose`）、
   * Host 对账与官方插件的重装不受限制。
   */
  async unload(id: string): Promise<boolean> {
    if (this.isProtectedCore(id)) throw new UiCorePluginError(id, 'unload');
    return this.release(id);
  }

  /** 生产构建中已安装的核心插件。 */
  isProtectedCore(id: string): boolean {
    return this.build === 'production' && !!this.installed.get(id)?.meta.core;
  }

  private skip(meta: NormalizedUiPluginMeta, record: UiSkippedPlugin): void {
    this.unskip(meta.id);
    this.skippedPlugins.set(meta.id, record);
    for (const slot of meta.slots ?? []) if (!this.skippedSlots.has(slot)) this.skippedSlots.set(slot, meta.id);
  }

  private unskip(id: string): void {
    this.skippedPlugins.delete(id);
    for (const [slot, owner] of this.skippedSlots) if (owner === id) this.skippedSlots.delete(slot);
  }

  private dropContribution(contributor: string, slot: string, owner: string): void {
    if (this.build !== 'development') return;
    const key = `${contributor}\u0000${slot}`;
    if (this.droppedContributions.has(key)) return;
    this.droppedContributions.add(key);
    console.warn(`[ui-plugins] ${contributor}: contribution to slot "${slot}" skipped; the slot belongs to "${owner}", which is not installed in this build`);
  }

  private async release(id: string): Promise<boolean> {
    this.withheld.delete(id);
    const entry = this.installed.get(id);
    if (!entry) return false;
    this.installed.delete(id);
    await entry.fiber.dispose();
    return true;
  }

  list(): string[] {
    return [...this.installed.keys()].sort();
  }

  /** 已安装插件的规范化 meta 与所需 Host 插件（按 id 排序）。 */
  plugins(): UiInstalledPluginInfo[] {
    return [...this.installed.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, origin, meta }) => ({ id, origin, meta, hostPlugins: requiredHostPlugins(meta) }));
  }

  /** 因平台不符、仅限开发构建或所需 UI 插件被跳过而跳过的插件（按 id 排序）。 */
  skipped(): UiSkippedPlugin[] {
    return [...this.skippedPlugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 与 Host 配对的 UI 插件与配对半的对账结果（按 id、所在插件排序）。 */
  pairing(): UiHostPairing[] {
    const rows: UiHostPairing[] = [];
    for (const entry of this.installed.values()) {
      const hosts = requiredHostPlugins(entry.meta);
      if (hosts.length) rows.push({ id: entry.id, kind: 'plugin', hosts, availability: entry.availability ?? 'available', active: true });
    }
    for (const [id, { hosts }] of this.withheld) rows.push({ id, kind: 'plugin', hosts: [...hosts], availability: 'missing', active: false });
    for (const half of this.halves.values()) {
      rows.push({ id: half.id, kind: 'half', parent: half.parent, hosts: [...half.hosts], availability: half.availability ?? 'available', active: !!half.fiber });
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id) || (a.parent ?? '').localeCompare(b.parent ?? ''));
  }

  /** 等待 Host 状态变化引起的装卸全部完成。 */
  async settled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.pending;
      await current;
    } while (current !== this.pending);
  }

  /** 插件当前的作用域（SlotOutlet / hooks 据此把渲染中的组件关联回插件）。 */
  scope(id: string): UiPluginScope | undefined {
    return this.installed.get(id)?.scope;
  }

  /** 根 context 上的 UI 服务（官方界面与测试使用；插件请用 apply 中的 ctx.ui）。 */
  ui(): UiService {
    return this.root.ui;
  }

  async dispose(): Promise<void> {
    for (const id of [...this.installed.keys()].reverse()) await this.release(id);
    this.anchors.dispose();
    this.dnd.dispose();
  }

  private enqueue(task: () => Promise<void>, label: string): void {
    this.pending = this.pending.then(task).catch((error) => console.error(`[ui-plugins] ${label} failed`, error));
  }

  /** Host 状态变化：所需 Host 插件缺失的撤下，可用 ⇄ 降级的按原参数重装，回来的装回。 */
  private async reconcileHosts(): Promise<void> {
    for (const entry of [...this.installed.values()]) {
      const hosts = requiredHostPlugins(entry.meta);
      if (!hosts.length || this.installed.get(entry.id) !== entry) continue;
      if (this.hostStatus.availability(hosts) === entry.availability) continue;
      await this.install(entry.plugin, entry.options ?? { origin: entry.origin }).catch((error) => {
        console.error(`[ui-plugins] failed to reinstall "${entry.id}" after a host status change`, error);
      });
    }
    for (const [id, held] of [...this.withheld]) {
      if (this.withheld.get(id) !== held || this.hostStatus.availability(held.hosts) === 'missing') continue;
      await this.install(held.plugin, held.options).catch((error) => {
        console.error(`[ui-plugins] failed to install "${id}" after its host plugins came back`, error);
      });
    }
  }

  private async pairHalf(ctx: Context, half: UiPlugin): Promise<void> {
    if (!half?.meta?.id || typeof half.apply !== 'function') throw new TypeError('ctx.ui.pair: expected a UI plugin created by defineUiPlugin');
    const meta = normalizeUiPluginMeta(half.meta);
    const parent = this.scopeOf(ctx);
    if (!parent) throw new Error('ctx.ui.pair is only available inside a UI plugin');
    parent.assertActive('pair');
    const hosts = requiredHostPlugins(meta);
    if (!hosts.length) throw new Error(`ctx.ui.pair: "${meta.id}" must declare meta.host or meta.requiresHost`);
    const key = `${parent.id}\u0000${meta.id}`;
    if (this.halves.has(key)) throw new Error(`ctx.ui.pair: "${meta.id}" is already paired in "${parent.id}"`);
    const record: PairedHalf = { id: meta.id, parent: parent.id, hosts };
    this.halves.set(key, record);
    const sync = async () => {
      if (this.halves.get(key) !== record) return;
      const availability = this.hostStatus.availability(hosts);
      if (availability === record.availability) return;
      const previous = record.fiber;
      record.fiber = undefined;
      record.availability = availability;
      await previous?.dispose();
      if (availability === 'missing') return;
      let failure: unknown;
      const fiber = ctx.plugin({
        name: `${parent.id}/${meta.id}`,
        apply: async (child: Context) => {
          this.halfFiber.set(child.fiber, meta.id);
          try {
            await half.apply(child, undefined);
          } catch (error) {
            failure = error;
            throw error;
          }
        },
      } as any);
      record.fiber = fiber as any;
      try {
        await fiber;
      } catch (error) {
        failure ??= error;
      }
      if (failure) {
        record.fiber = undefined;
        await (fiber as any).dispose();
        throw failure;
      }
    };
    ctx.effect(() => {
      const off = this.hostStatus.subscribe(() => this.enqueue(sync, `pairing "${meta.id}" in "${parent.id}"`));
      return () => {
        off();
        if (this.halves.get(key) === record) this.halves.delete(key);
      };
    }, `ui.pair(${meta.id})`);
    await sync();
  }

  private scopeOf(ctx: Context): UiPluginScope | undefined {
    return this.nearest(ctx, (fiber) => this.fiberOwner.get(fiber));
  }

  /** 从 ctx 的 fiber 向上（不含根）找第一个 `pick` 有结果的 fiber。 */
  private nearest<T>(ctx: Context, pick: (fiber: object) => T | undefined): T | undefined {
    let fiber: any = ctx.fiber;
    while (fiber) {
      const found = pick(fiber);
      if (found !== undefined) return found;
      fiber = fiber.parent?.fiber ?? fiber.parent;
      if (fiber === ctx.root?.fiber) break;
    }
    return undefined;
  }
}
