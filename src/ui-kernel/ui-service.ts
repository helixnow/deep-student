/**
 * `ctx.ui`：插件在 `apply` 里拿到的内核服务（`UiService`）与 v1 领域快捷方式的适配。UiKernel 构造它并传入运行时；
 * 对外经 kernel.ts 导出。
 */
import type { ComponentType } from 'react';
import { Service, type Context } from '@deepseek-ai/cordis';
import { SlotError, type SlotContribution, type SlotDefinition, type SlotStore, type UiPluginOrigin } from './slots';
import type { OpenSlotName, SlotMap, SlotName } from './slot-map';
import { pluginNamespace, type NormalizedUiPluginMeta } from './meta';
import { UiPluginDisposedError, type UiPluginScope } from './scope';
import type { UiPlatformService } from './services/platform';
import type { UiNavigationService, UiNavigator } from './services/navigation';
import type { PluginStorage, UiStorageService } from './services/storage';
import { createScopedStore, type PluginStore, type PluginStoreInit, type PluginStoreOptions } from './services/store';
import { useScopedTranslator, type UiI18nService, type UiTranslate, type UiTranslateOptions } from './services/i18n';
import type { UiErrorBudget } from './services/errors';
import type { UiAdapterRegistry, UiRegistryKind } from './registries';
import type { ChatToolResultContribution, ChatToolResultProps } from './contracts/chat';
import type { SettingsSectionRegistration } from './contracts/settings';
import type { UiChatBlock, UiChatEventHandler, UiChatMode, UiCommand, UiWorkbenchApp } from './contracts/registries';
import type { UiHostStatusHandle, UiHostStatusService } from './services/host-status';
import type { LazyContributionPoint } from './lazy';
import { scopeResourceMenuRow } from './resource-menu';
import type { RemoteHost, UiAdapters, UiDisposer, UiKernelRegistries, UiPlatformHandle, UiPlugin, UiPluginOwner } from './plugin';
import { subscribeHostEvent } from './services/events';
import type {
  AnchorEdgeSourceKind,
  AnchorEdgeUpsertInput,
  ExcerptDragInput,
  ExcerptDragPayload,
  SemanticAnchor,
  SemanticAnchorKind,
} from './contracts/interop';
import type {
  AnchorEdgesAdapter,
  AnchorEdgesChangedDetail,
  AnchorRegistry,
  AnchorRevealHandler,
  AnchorRevealOptions,
  AnchorRevealResult,
  OpenAnchorAdapter,
  UiAnchorsHandle,
} from './services/anchors';
import type { ExcerptDndHub, ExcerptDropTargetOptions, UiExcerptDndHandle } from './services/excerpt-dnd';

declare module './plugin' {
  interface UiAdapters {
    /** Opens a closed resource pane (splitting when `splitIfClosed` is true) for cross-plugin anchor reveal. */
    openAnchor?: OpenAnchorAdapter;
    /** Optional persistence adapter for `vfs_anchor_edges` SQLite backlink graph. */
    anchorEdges?: AnchorEdgesAdapter;
  }
}

/** UiService 依赖的内核运行时（由 UiKernel 构造并持有）。 */
export interface UiRuntime {
  readonly slots: SlotStore;
  readonly adapters: UiAdapters;
  readonly platform: UiPlatformService;
  readonly navigation: UiNavigationService;
  readonly storage: UiStorageService;
  readonly i18n: UiI18nService;
  readonly errors: UiErrorBudget;
  readonly registries: UiKernelRegistries;
  readonly hostStatus: UiHostStatusService;
  readonly anchors: AnchorRegistry;
  readonly dnd: ExcerptDndHub;
  readonly strictCommunityNamespaces: boolean;
  ownerOf(ctx: Context): UiPluginOwner;
  scopeOf(ctx: Context): UiPluginScope | undefined;
  /** 发起 Host 调用的 UI 半：配对半内是该半的 id，否则是所属插件的 id；根 context 为 undefined。 */
  callerOf(ctx: Context): string | undefined;
  pair(ctx: Context, half: UiPlugin): Promise<void>;
  /** The skipped plugin whose `meta.slots` lists `slot`, if any. */
  skippedSlotOwner(slot: string): string | undefined;
  /** A contribution dropped because its slot belongs to a skipped plugin (development builds warn once per contributor and slot). */
  dropContribution(contributor: string, slot: string, owner: string): void;
}

/** v1 的 `registerToolResult(name, Component)` 传裸组件：按整块替换处理。 */
function toToolResultContribution(view: ChatToolResultContribution | ComponentType<ChatToolResultProps>): ChatToolResultContribution {
  return typeof view === 'object' && view !== null && 'placement' in view
    ? view
    : { placement: 'block', component: view as ComponentType<ChatToolResultProps> };
}

/** v1 `ctx.ui.contextMenu.register` 的条目。`resourceTypes` 取资源类型、`'folder'` 或通配 `'*'`。 */
export interface UiContextMenuItemV1 {
  id: string;
  resourceTypes: readonly string[];
  /** 不含 ":" 时按插件命名空间解析。 */
  labelKey: string;
  order?: number;
  run: (resource: unknown) => unknown;
}

/**
 * `ContentMenuContext`（contracts/content.ts）中 v1 适配用到的部分。不直接引用该类型：
 * 它会把学习中心的组件类型拉进内核的类型图。
 */
interface MenuContextV1 {
  scope: string;
  resourceItem?: { type: unknown } | null;
  target?: { type: string; item?: { itemType: string }; folder?: { folder: unknown } };
  /** 笔记树（`NotesTreeMenuContext.item`）。 */
  item?: { kind: string };
  closeMenu(): void;
}

/** 菜单目标在 v1 语义下的类型与交给 `run` 的对象：资源、文件夹内条目、文件夹；笔记树的条目按 `kind`。 */
function contextMenuSubject(c: MenuContextV1): { type: string; value: unknown } | undefined {
  if (c.scope === 'notes-tree') return c.item ? { type: c.item.kind, value: c.item } : undefined;
  const { target } = c;
  if (!target) return undefined;
  if (c.scope === 'resource') {
    if (c.resourceItem) return { type: String(c.resourceItem.type), value: c.resourceItem };
    if (target.type === 'folderItem' && target.item) return { type: target.item.itemType, value: target.item };
  }
  if (c.scope === 'folder' && target.type === 'folder' && target.folder) return { type: 'folder', value: target.folder.folder };
  return undefined;
}

const legacyNamespaceWarnings = new Set<string>();

/** API v1 社区插件写非派生命名空间（非严格模式）：仍放行，每个插件与命名空间告警一次。 */
function warnLegacyNamespace(pluginId: string, ns: string): void {
  const key = `${pluginId}\u0000${ns}`;
  if (legacyNamespaceWarnings.has(key)) return;
  legacyNamespaceWarnings.add(key);
  console.warn(`[ui-plugins] ${pluginId}: ctx.ui.i18n.addBundle into "${ns}" is deprecated; namespaces are derived from the plugin id ("${pluginNamespace(pluginId)}"). API v2 plugins are rejected.`);
}

/** v1 条目适配为官方菜单读取的 `ContentMenuContribution` 形状（先关菜单再执行，与官方条目一致）。 */
function toContentMenuContribution(item: UiContextMenuItemV1, namespace: string | undefined, onError: (error: unknown) => void) {
  const types = new Set(item.resourceTypes);
  const subject = (c: MenuContextV1) => {
    const found = contextMenuSubject(c);
    return found && (types.has('*') || types.has(found.type)) ? found : undefined;
  };
  return {
    id: item.id,
    order: item.order ?? 0,
    labelKey: namespace && !item.labelKey.includes(':') ? `${namespace}:${item.labelKey}` : item.labelKey,
    visible: (c: MenuContextV1) => !!subject(c),
    run: (c: MenuContextV1) => {
      const found = subject(c);
      c.closeMenu();
      if (!found) return;
      try {
        void Promise.resolve(item.run(found.value)).catch(onError);
      } catch (error) {
        onError(error);
      }
    },
  };
}

/** 官方声明的 slot。新增扩展点只需在此声明（或由插件 `ctx.ui.declareSlot`）。 */
export const BUILTIN_SLOTS: readonly SlotDefinition[] = [
  { name: 'views', cardinality: 'keyed', description: '顶层视图：key = 视图 id' },
  { name: 'nav', cardinality: 'list', description: '侧栏导航项' },
  { name: 'settings.sections', cardinality: 'keyed', description: '设置分区：key = 分区 id' },
  { name: 'chat.toolResults', cardinality: 'keyed', description: 'AI 工具结果卡片：key = 工具名' },
  { name: 'markdown.codeBlocks', cardinality: 'keyed', description: 'Markdown 代码块语言渲染器：key = 语言名' },
  { name: 'resource.contextMenu', cardinality: 'list', description: '资源右键菜单项' },
];

/**
 * `ctx.ui`。新增的服务一律经 getter（或普通方法）暴露：经 `ctx.ui` 访问时 `this` 是 Cordis 追踪代理，
 * `this.ctx` 才是调用方插件的 context；类字段箭头函数与 `#private` 字段拿到的是原始实例或会在代理上抛错。
 */
export class UiService extends Service {
  readonly slots: SlotStore;
  private readonly _adapters: UiAdapters;
  private readonly _runtime: UiRuntime;

  constructor(ctx: Context, runtime: UiRuntime) {
    super(ctx, 'ui');
    this.slots = runtime.slots;
    this._adapters = runtime.adapters;
    this._runtime = runtime;
    for (const def of BUILTIN_SLOTS) runtime.slots.declare(def);
  }

  private _ownerOf(ctx: Context): UiPluginOwner {
    return this._runtime.ownerOf(ctx);
  }

  /** 调用方插件的作用域；从根 context（官方界面、测试）调用时为 undefined。 */
  private _scope(): UiPluginScope | undefined {
    return this._runtime.scopeOf(this.ctx);
  }

  /** 插件私有服务要求调用方是一个仍在运行的插件。 */
  private _pluginScope(service: string): UiPluginScope {
    const scope = this._scope();
    if (!scope) throw new Error(`ctx.ui.${service} is only available inside a UI plugin`);
    scope.assertActive(service);
    return scope;
  }

  /** 当前平台（与 Host `meta.platforms` 同一取值）。 */
  get platform(): UiPlatformHandle {
    const service = this._runtime.platform;
    const scope = this._scope();
    const { kind, os, arch, capabilities } = service.current;
    return {
      kind,
      os,
      arch,
      capabilities,
      has: (capability: string) => service.has(capability),
      subscribe: (listener: () => void) => {
        const off = service.subscribe(listener);
        return scope ? scope.track(off) : off;
      },
    };
  }

  /** `ctx.ui.navigate(viewId, params?)`：跳到 `views` 槽位中已登记的视图；调用方卸载后失效。 */
  get navigate(): (view: string, params?: Readonly<Record<string, unknown>>) => void {
    const navigation = this._runtime.navigation;
    const scope = this._scope();
    const source = this._ownerOf(this.ctx).id;
    return (view, params) => {
      scope?.assertActive('navigate');
      navigation.navigate(source, view, params);
    };
  }

  /** 调用方插件的身份与规范化 meta（根 context 为 undefined）。 */
  get plugin(): { id: string; origin: UiPluginOrigin; meta: NormalizedUiPluginMeta } | undefined {
    const scope = this._scope();
    return scope && { id: scope.id, origin: scope.origin, meta: scope.meta };
  }

  /** Host 插件状态（FE-A3）：清单到达前为 `unknown`（按在线处理）；订阅随插件卸载撤销。 */
  get hostStatus(): UiHostStatusHandle {
    const service = this._runtime.hostStatus;
    const scope = this._scope();
    return {
      get known() {
        return service.known;
      },
      get safeMode() {
        return service.safeMode;
      },
      state: (hostId: string) => service.state(hostId),
      reason: (hostId: string) => service.reason(hostId),
      degraded: (hostId: string) => service.degraded(hostId),
      consentRequired: (hostId: string) => service.consentRequired(hostId),
      availability: (hostIds: readonly string[]) => service.availability(hostIds),
      subscribe: (listener: () => void) => {
        const off = service.subscribe(listener);
        return scope ? scope.track(off) : off;
      },
    };
  }

  /**
   * 在调用方插件内装配一个与 Host 插件配对的 UI 半（`half.meta.host` / `requiresHost` 必填）。
   * 贡献仍记在调用方名下；Host 半缺失时撤下这一半，可用 ⇄ 降级切换时重新 apply（apply 内用
   * `ctx.ui.hostStatus` 判断）。随调用方卸载撤销。
   */
  pair(half: UiPlugin): Promise<void> {
    return this._runtime.pair(this.ctx, half);
  }

  /** 插件自报错误（例如后台同步失败），计入该插件的错误预算。 */
  reportError(error: unknown, info: { slot?: string; entryId?: string } = {}): void {
    const scope = this._pluginScope('reportError');
    this._runtime.errors.report({ pluginId: scope.id, origin: scope.origin, phase: 'report', error, ...info });
  }

  /** Official recovery UI may observe circuit breakers, never change their budget. */
  onPluginDisabled(handler: (id: string, errors: string[]) => void): UiDisposer {
    if (this._scope()?.origin !== 'builtin') throw new Error('Only builtin UI may observe plugin recovery');
    const seen = new Set<string>();
    const inspect = () => {
      for (const item of this._runtime.errors.disabled()) {
        if (seen.has(item.pluginId)) continue;
        seen.add(item.pluginId);
        handler(item.pluginId, this._runtime.errors.list(item.pluginId).map(report => `${report.phase}: ${report.message}`));
      }
    };
    const unsubscribe = this._runtime.errors.subscribe(inspect);
    inspect();
    return unsubscribe;
  }

  /** 插件私有持久化：键加 `ds:plugin:<id>:` 前缀；订阅与句柄随插件卸载撤销，数据保留。 */
  get storage(): PluginStorage {
    return this._runtime.storage.open(this._pluginScope('storage'));
  }

  /** 插件状态（zustand vanilla store）：归插件所有，卸载即重置并断开订阅；`persist` 经 `ctx.ui.storage` 持久化。 */
  get createStore(): <T>(init: PluginStoreInit<T>, options?: PluginStoreOptions<T>) => PluginStore<T> {
    const scope = this._pluginScope('createStore');
    const storage = this._runtime.storage;
    return <T>(init: PluginStoreInit<T>, options?: PluginStoreOptions<T>) => {
      scope.assertActive('createStore');
      return createScopedStore(scope, init, options, () => storage.open(scope));
    };
  }

  /** 导航接口：查询可达性；框架插件提供导航实现（随其卸载撤销）。 */
  get navigation() {
    const navigation = this._runtime.navigation;
    const navigate = this.navigate;
    return {
      navigate,
      canNavigate: (view: string) => navigation.canNavigate(view),
      provide: (navigator: UiNavigator): UiDisposer => {
        const owner = this._ownerOf(this.ctx).id;
        return this._revocable('ui.navigation.provide', () => navigation.provide(owner, navigator));
      },
    };
  }

  /** 声明新的扩展点（插件也可以为自己的子界面开放 slot）。写了 `meta.slots` 的插件只能声明其中列出的槽位。 */
  declareSlot(def: SlotDefinition): void {
    const meta = this._scope()?.meta;
    if (meta?.slots && !meta.slots.includes(def.name)) {
      throw new SlotError(`${meta.id}: slot "${def.name}" is not listed in meta.slots; list every slot the plugin declares`);
    }
    this.slots.declare(def);
  }

  /**
   * 向 slot 贡献；随调用方插件卸载撤销，也可用返回的句柄提前撤销。已登记在 SlotMap 的槽位在编译期检查值的形状；
   * 未登记的槽位（或显式给出泛型）按 v1 语义接受任意值。槽位未声明、但列在某个被跳过插件的 `meta.slots` 里时，
   * 贡献被丢弃（返回空句柄），不报错。
   */
  contribute<K extends SlotName>(slot: K, contribution: SlotContribution<SlotMap[K]>): UiDisposer;
  contribute<T = unknown, S extends string = string>(slot: OpenSlotName<S>, contribution: SlotContribution<T>): UiDisposer;
  contribute(slot: string, contribution: SlotContribution<unknown>): UiDisposer {
    const { id, origin } = this._ownerOf(this.ctx);
    const skippedOwner = this.slots.definition(slot) ? undefined : this._runtime.skippedSlotOwner(slot);
    if (skippedOwner) {
      this._runtime.dropContribution(id, slot, skippedOwner);
      return () => {};
    }
    const value = slot === 'resource.contextMenu' ? scopeResourceMenuRow(contribution.value) : contribution.value;
    const entry = value === contribution.value ? contribution : { ...contribution, value };
    return this._revocable(`ui.contribute(${slot}:${contribution.id})`, () => this.slots.contribute(slot, id, entry, origin));
  }

  /** v1 领域快捷方式的入口：参数形状沿用 v1 的宽松声明，不参与 SlotMap 检查。 */
  private _contributeLoose(slot: string, contribution: SlotContribution<unknown>): UiDisposer {
    return this.contribute(slot as OpenSlotName<string>, contribution);
  }

  /**
   * 接上懒加载 chunk 的贡献点（`createLazyContributionPoint`）：已宣告的值立即交给 `register`，之后宣告的同步交付；
   * 随调用方插件卸载断开，也可用返回的句柄提前断开（已登记的贡献由 `register` 内的 `ctx.ui.*` 各自撤销）。
   * 单个值登记失败只拒绝该值，并计入调用方插件的错误预算。
   */
  attach<T>(point: LazyContributionPoint<T>, register: (value: T) => void): UiDisposer {
    const scope = this._scope();
    const errors = this._runtime.errors;
    const onError = (error: unknown) => {
      if (scope) errors.report({ pluginId: scope.id, origin: scope.origin, phase: 'report', error, slot: `lazy:${point.name}` });
      else console.error(`[ui-plugins] ${point.name}: contribution rejected`, error);
    };
    return this._revocable(`ui.attach(${point.name})`, () => point.attach(register, onError));
  }

  /** 把一次登记记为调用方 fiber 的副作用，并返回能单独撤销它的句柄。 */
  private _revocable(label: string, register: () => () => void): UiDisposer {
    const dispose = this.ctx.effect(register, label);
    return () => {
      const pending: unknown = dispose();
      if (pending instanceof Promise) pending.catch((error) => console.error(`[ui-plugins] failed to revoke ${label}`, error));
    };
  }

  // ---- 领域快捷方式（对应 FRONTEND.md §4 的扩展点）

  get views() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    return {
    register: (view: { id: string; titleKey: string; icon?: unknown; component: unknown; keepAlive?: boolean }): UiDisposer =>
      this._contributeLoose('views', { id: view.id, key: view.id, value: view }),
    };
  }

  get nav() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    return {
    register: (item: { id: string; viewId: string; labelKey: string; icon?: unknown; order?: number; badge?: unknown }): UiDisposer =>
      this._contributeLoose('nav', { id: item.id, order: item.order, value: item }),
    };
  }

  get settings() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    return {
    register: (section: SettingsSectionRegistration): UiDisposer =>
      this._contributeLoose('settings.sections', { id: section.id, key: section.id, order: section.order, value: section }),
    };
  }

  get markdown() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    return {
    registerCodeBlock: (language: string, renderer: unknown): UiDisposer =>
      this._contributeLoose('markdown.codeBlocks', { id: `codeblock:${language}`, key: language, value: renderer }),
    };
  }

  get chat() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    const owner = this._ownerOf(this.ctx);
    return {
    /** v1 接受裸组件（按整块替换处理）；v2 传 `ChatToolResultContribution`。key 为工具名，`builtin-` 前缀可省略。 */
    registerToolResult: (toolName: string, view: ChatToolResultContribution | ComponentType<ChatToolResultProps>): UiDisposer =>
      this.contribute('chat.toolResults', { id: `tool:${toolName}`, key: toolName, value: toToolResultContribution(view) }),
    registerBlock: (type: string, renderer: UiChatBlock): UiDisposer =>
      this._viaAdapter('chatBlocks', `chat.block(${type})`, (a) => a.register(type, renderer, owner)),
    registerEvent: (type: string, handler: UiChatEventHandler): UiDisposer =>
      this._viaAdapter('chatEvents', `chat.event(${type})`, (a) => a.register(type, handler, owner)),
    registerMode: (name: string, mode: UiChatMode): UiDisposer =>
      this._viaAdapter('chatModes', `chat.mode(${name})`, (a) => a.register(name, mode, owner)),
    };
  }

  get commands() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    return {
    /** id 与已登记的命令冲突时抛错（不会覆盖）。返回的句柄只撤销这一条。 */
    register: (command: UiCommand): UiDisposer =>
      this._viaAdapter('commands', `command(${command.id})`, (a) => a.register(command as UiCommand & Record<string, unknown>)),
    };
  }

  get workbench() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    return {
    /** typeId 冲突时抛错。返回的句柄只撤销这一个应用。 */
    registerApp: (def: UiWorkbenchApp): UiDisposer =>
      this._viaAdapter('workbenchApps', `app(${def.typeId})`, (a) => a.register(def as UiWorkbenchApp & Record<string, unknown>)),
    };
  }

  /**
   * 跨插件语义锚点路由与反向链接图（Cross-Plugin Interop Protocol v1）。
   * 经原型 getter 暴露，使 Cordis 追踪代理将处理器与订阅登记在调用方插件 fiber 上，卸载自动撤销。
   */
  get anchors(): UiAnchorsHandle {
    const anchors = this._runtime.anchors;
    const scope = this._scope();
    return {
      registerAnchorRevealHandler: <K extends SemanticAnchorKind>(
        kind: K,
        handler: AnchorRevealHandler<K>,
      ): UiDisposer => {
        scope?.assertActive('anchors.registerAnchorRevealHandler');
        return this._revocable(`ui.anchors.handler(${kind})`, () =>
          anchors.registerAnchorRevealHandler(kind, handler),
        );
      },
      reveal: (target: SemanticAnchor | string, options?: AnchorRevealOptions): Promise<AnchorRevealResult> => {
        scope?.assertActive('anchors.reveal');
        return anchors.reveal(target, options);
      },
      upsertAnchorEdges: (edges: readonly AnchorEdgeUpsertInput[]) => {
        scope?.assertActive('anchors.upsertAnchorEdges');
        return anchors.upsertAnchorEdges(edges);
      },
      pruneAnchorEdgesBySource: (params: {
        sourceKind: AnchorEdgeSourceKind | string;
        sourceResourceId: string;
        keepEdgeIds?: readonly string[];
      }) => {
        scope?.assertActive('anchors.pruneAnchorEdgesBySource');
        return anchors.pruneAnchorEdgesBySource(params);
      },
      queryAnchorEdgesByTarget: (params: {
        targetResourceIds: readonly string[];
        targetKind?: SemanticAnchorKind | string;
      }) => {
        scope?.assertActive('anchors.queryAnchorEdgesByTarget');
        return anchors.queryAnchorEdgesByTarget(params);
      },
      subscribeAnchorEdgesChanged: (listener: (detail: AnchorEdgesChangedDetail) => void): UiDisposer => {
        scope?.assertActive('anchors.subscribeAnchorEdgesChanged');
        return this._revocable('ui.anchors.edgesChanged', () =>
          anchors.subscribeAnchorEdgesChanged(listener),
        );
      },
    };
  }

  /**
   * 跨插件子资源摘录拖拽与「划选即入图」总线（Cross-Plugin Interop Protocol v1）。
   * 经原型 getter 暴露，使落点监听与自动摘录订阅随调用方插件卸载自动清理。
   */
  get dnd(): UiExcerptDndHandle {
    const dnd = this._runtime.dnd;
    const scope = this._scope();
    return {
      startExcerptDrag: (
        event: Pick<DragEvent, 'dataTransfer'>,
        input: ExcerptDragInput,
      ): ExcerptDragPayload | null => {
        scope?.assertActive('dnd.startExcerptDrag');
        return dnd.startExcerptDrag(event, input);
      },
      hasExcerptMime: (event: Pick<DragEvent, 'dataTransfer'> | null | undefined): boolean =>
        dnd.hasExcerptMime(event),
      readExcerptDrag: (
        event: Pick<DragEvent, 'dataTransfer'> | null | undefined,
      ): ExcerptDragPayload | null => dnd.readExcerptDrag(event),
      registerExcerptDropTarget: (
        element: HTMLElement,
        onDrop: (payload: ExcerptDragPayload, event: DragEvent) => void,
        options?: ExcerptDropTargetOptions,
      ): UiDisposer => {
        scope?.assertActive('dnd.registerExcerptDropTarget');
        return this._revocable('ui.dnd.dropTarget', () =>
          dnd.registerExcerptDropTarget(element, onDrop, options),
        );
      },
      emitAutoExcerpt: (input: ExcerptDragInput): ExcerptDragPayload | null => {
        scope?.assertActive('dnd.emitAutoExcerpt');
        return dnd.emitAutoExcerpt(input);
      },
      subscribeAutoExcerpt: (listener: (payload: ExcerptDragPayload) => void): UiDisposer => {
        scope?.assertActive('dnd.subscribeAutoExcerpt');
        return this._revocable('ui.dnd.autoExcerpt', () => dnd.subscribeAutoExcerpt(listener));
      },
    };
  }

  get i18n() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    const service = this._runtime.i18n;
    const scope = this._scope();
    return {
      /**
       * v1：写入指定命名空间。社区插件只能写本插件 id 派生的命名空间（`ctx.ui.i18n.namespace`）；
       * 关掉严格模式的内核里，API v1 的社区插件仍可写未被认领的非官方命名空间（写入即认领），并收到弃用告警。
       */
      addBundle: (lng: string, ns: string, resources: Record<string, unknown>) => {
        const adapter = this._adapters.i18n;
        if (!adapter) throw new Error('ctx.ui: i18n adapter is not available in this window');
        scope?.assertActive('i18n');
        if (scope && scope.origin !== 'builtin' && ns !== scope.namespace) {
          if (scope.meta.apiVersion >= 2 || this._runtime.strictCommunityNamespaces) {
            throw new Error(`ctx.ui.i18n.addBundle: namespace "${ns}" is not derived from plugin id "${scope.id}"; use "${scope.namespace}" or ctx.ui.i18n.addBundles`);
          }
          warnLegacyNamespace(scope.id, ns);
        }
        if (service.claim(scope, ns, 'ctx.ui.i18n.addBundle')) service.store(ns, lng, resources);
        this.ctx.effect(() => adapter.addBundle(lng, ns, resources), `ui.i18n(${lng}/${ns})`);
      },
      /** 本插件的命名空间（根 context 为 undefined）。 */
      namespace: scope?.namespace,
      /** v2：按语言登记本插件命名空间的文案，返回绑定该命名空间的 `t`。 */
      addBundles: (bundles: Record<string, Record<string, unknown>>): UiTranslate => {
        const owner = this._pluginScope('i18n.addBundles');
        const ns = owner.namespace;
        const owned = service.claim(owner, ns, 'ctx.ui.i18n.addBundles');
        const adapter = this._adapters.i18n;
        for (const [lng, resources] of Object.entries(bundles)) {
          if (owned) service.store(ns, lng, resources);
          if (adapter) this.ctx.effect(() => adapter.addBundle(lng, ns, resources), `ui.i18n(${lng}/${ns})`);
        }
        return service.translator(owner);
      },
      /** 绑定本插件命名空间的翻译；不会回落到其他命名空间。 */
      t: (key: string, options?: UiTranslateOptions): string => (scope ? service.translator(scope)(key, options) : key),
      /** React hook：在插件组件内调用，语言变化时重渲染。 */
      useT: (): UiTranslate => {
        if (!scope) throw new Error('ctx.ui.i18n.useT is only available inside a UI plugin');
        return useScopedTranslator(service, scope);
      },
    };
  }

  get contextMenu() {
    // 经 getter 取 this（箭头函数沿用 getter 的 this）：通过 ctx.ui 访问时 this 是 Cordis 追踪代理，
    // 贡献才会记到调用方插件名下。不要改成类字段箭头函数——那样 this 是原始实例，贡献会记到内核名下。
    const scope = this._scope();
    const errors = this._runtime.errors;
    return {
    register: (item: UiContextMenuItemV1): UiDisposer =>
      this._contributeLoose('resource.contextMenu', {
        id: item.id,
        order: item.order,
        value: toContentMenuContribution(item, scope?.namespace, (error) => {
          if (scope) errors.report({ pluginId: scope.id, origin: scope.origin, phase: 'report', error, slot: 'resource.contextMenu', entryId: item.id });
          else console.error(`[ui-plugins] context menu item "${item.id}" failed`, error);
        }),
      }),
    };
  }

  /**
   * Host 远程服务代理。参数与返回值必须可 JSON 序列化；只能调用对方 meta.remote 中列出的方法（由 Host 校验）。
   * 每次调用带上发起调用的 UI 半的 id（`caller`，SEC-E06）：Host 只放行该 id 的 Host 插件自己提供的服务，
   * 所以只能在插件内（含配对半）调用，插件卸载后调用直接拒绝。
   *
   * `ctx.ui.host.on(event, handler)`（FE-C4/W27）订阅本插件命名空间下的事件，见 {@link hostOn}。
   */
  get host(): RemoteHost {
    const invoke = this._adapters.invoke;
    const scope = this._scope();
    const caller = this._runtime.callerOf(this.ctx);
    const on = this.hostOn;
    return new Proxy({} as RemoteHost, {
      get: (_t, service) => {
        if (typeof service !== 'string') return undefined;
        // 不是 Host 服务：本插件命名空间下的事件订阅。服务名由插件 id 派生，不会叫 "on"。
        if (service === 'on') return on;
        return new Proxy({}, {
          get: (_m, method) => (...args: unknown[]) => {
            if (!scope || !caller) return Promise.reject(new Error('ctx.ui.host is only available inside a UI plugin: each call carries the calling plugin id'));
            if (!scope.active) return Promise.reject(new UiPluginDisposedError(scope.id, 'host'));
            if (!invoke) return Promise.reject(new Error('ctx.ui.host: invoke adapter is not available in this window'));
            return invoke('plugin:host|call', { caller, service: String(service), method: String(method), args });
          },
        });
      },
    });
  }

  /**
   * `ctx.ui.host.on(event, handler)`：订阅 **本插件** 命名空间下 Host 推送的事件，返回同步生效的退订函数。
   * - `event` 是完整名（`example/word-of-day:changed`）或本地名（`changed`）；外来/近似前缀、非法字符在注册前抛错。
   * - handler 收到 payload；其异常与传输失败计入本插件错误预算，不传回传输层。
   * - 订阅登记在调用方 fiber 上：插件卸载、被覆盖或 apply 失败时自动退订（含尚未 resolve 的注册）。
   */
  get hostOn(): <T = unknown>(event: string, handler: (payload: T) => void) => UiDisposer {
    // RUST-FIX(RF-W17-host-event-own-prefix): 订阅登记在调用方 fiber 上，事件名限定在本插件命名空间
    return <T = unknown>(event: string, handler: (payload: T) => void): UiDisposer => {
      const scope = this._pluginScope('host.on');
      const errors = this._runtime.errors;
      return this._revocable(`ui.host.on(${event})`, () => subscribeHostEvent(
        this._adapters.events,
        {
          pluginId: scope.id,
          isActive: () => scope.active,
          report: (error) => errors.report({ pluginId: scope.id, origin: scope.origin, phase: 'report', error, slot: `host.on:${event}` }),
        },
        event,
        handler as (payload: unknown) => void,
      ));
    };
  }

  private _viaAdapter<K extends UiRegistryKind>(kind: K, label: string, fn: (adapter: NonNullable<UiAdapters[K]>) => () => void): UiDisposer {
    const adapter = this._adapters[kind];
    if (!adapter) throw new Error(`ctx.ui: ${String(kind)} adapter is not available in this window`);
    const registry = this._runtime.registries[kind] as UiAdapterRegistry<unknown>;
    return this._revocable(`ui.${label}`, () => registry.track(() => fn(adapter as NonNullable<UiAdapters[K]>)));
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ui: UiService;
  }
}
