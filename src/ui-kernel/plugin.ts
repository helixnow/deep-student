/**
 * UI 插件的定义（`UiPlugin`、`defineUiPlugin`）与内核依赖的现有注册表接口（`UiAdapters`）。对外经 kernel.ts 导出。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { UiPluginOrigin } from './slots';
import type { UiPluginMeta } from './meta';
import type { UiPlatformInfo } from './services/platform';
import type { UiNavigator } from './services/navigation';
import type { UiStorageBackend } from './services/storage';
import type { UiI18nAdapter } from './services/i18n';
import type { UiAdapterRegistry, UiRegistrySource } from './registries';
import type { LegacyRegistries } from './legacy-adapters';
import type { UiEventTransport } from './services/events';

// ------------------------------------------------------------------ 插件定义

export interface UiPluginInstallOptions<C = void> {
  /** Installer-owned provenance; omitted installations are community code. */
  origin?: UiPluginOrigin;
  config?: C;
}

/**
 * 撤销一次登记（`contribute`、`commands.register`、`workbench.registerApp`、`chat.register*` 等的返回值）。
 * 幂等；插件卸载时会自动撤销，之后再调用无效果。
 */
export type UiDisposer = () => void;

/** 贡献者身份：插件 id 与安装来源。 */
export interface UiPluginOwner {
  id: string;
  origin: UiPluginOrigin;
}

export interface UiPlugin<C = void> {
  name: string;
  meta: UiPluginMeta;
  /** 官方 UI 插件的安装顺序（不改变 slot 内各条目的 order）。 */
  order?: number;
  /** 必须就绪的服务（Cordis inject）；内核服务 `ui` 总是可用，无需声明。 */
  inject?: readonly string[];
  apply(ctx: Context, config: C): void | Promise<void>;
}

/** 零逻辑的定义辅助：`export default defineUiPlugin({ meta: { id }, apply(ctx) { … } })`。 */
export function defineUiPlugin<C = void>(plugin: Omit<UiPlugin<C>, 'name'> & { name?: string }): UiPlugin<C> {
  return { name: plugin.name ?? plugin.meta.id, ...plugin } as UiPlugin<C>;
}

// ------------------------------------------------------------------ 现有注册表的适配接口

type UiCommandLike = { id: string } & Record<string, unknown>;
type UiWorkbenchAppLike = { typeId: string } & Record<string, unknown>;

/**
 * 现有应用注册表的最小接口；register 返回撤销函数。
 * `subscribe` / `list` / `get` 为 v2 可选能力，由 `kernel.registries` 暴露给消费方订阅（见 registries.ts）。
 */
export interface UiAdapters {
  commands?: { register(command: UiCommandLike): () => void } & UiRegistrySource<UiCommandLike>;
  /** 对话 block / 事件处理器 / 模式：`owner` 是登记者插件（注册表据此记账，卸载时只撤销这一层）。 */
  chatBlocks?: { register(type: string, renderer: unknown, owner?: UiPluginOwner): () => void } & UiRegistrySource<unknown>;
  chatEvents?: { register(type: string, handler: unknown, owner?: UiPluginOwner): () => void } & UiRegistrySource<unknown>;
  chatModes?: { register(name: string, mode: unknown, owner?: UiPluginOwner): () => void } & UiRegistrySource<unknown>;
  workbenchApps?: { register(def: UiWorkbenchAppLike): () => void } & UiRegistrySource<UiWorkbenchAppLike>;
  /** `addBundle` 是 v1 接口；`languages` / `onLanguageChanged` / `isReservedNamespace` 为 v2 可选能力。 */
  i18n?: UiI18nAdapter;
  /** 前端到 Host 的 invoke（生产中为 @tauri-apps/api 的 invoke，经兼容桥到 Host）。 */
  invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Host → UI 的推送事件（`ctx.ui.host.on`）。生产实现为 `@tauri-apps/api/event` 的 `listen`；
   * 浏览器、演示壳与沙箱可省略或注入内存实现。
   */
  // RUST-FIX(RF-W17-host-event-own-prefix): 事件传输只是 ctx.ui.host.on 的底层能力，命名空间由内核强制
  events?: UiEventTransport;
  /** 外壳提供的平台信息；缺省为桌面实现（`createDesktopPlatform()`）。 */
  platform?: UiPlatformInfo;
  /** 窗口的默认导航实现（框架插件可经 `ctx.ui.navigation.provide` 覆盖）。 */
  navigate?: UiNavigator;
  /** 插件私有持久化的后端；缺省为 `window.localStorage`（不可用时为内存实现）。 */
  storage?: UiStorageBackend;
  /**
   * 应用现有的三个注册表；给出时由内核按统一语义适配为 `commands` / `chatBlocks` / `workbenchApps`
   * （冲突即报错、身份校验的撤销、可订阅，见 legacy-adapters.ts）。显式给出的同名适配器优先。
   */
  legacyRegistries?: LegacyRegistries;
}

/** `ctx.ui.platform`：当前平台的快照与订阅（订阅随插件卸载撤销）。 */
export interface UiPlatformHandle extends UiPlatformInfo {
  has(capability: string): boolean;
  subscribe(listener: () => void): () => void;
}

/** 适配器背后的旧注册表的可订阅视图。 */
export interface UiKernelRegistries {
  readonly commands: UiAdapterRegistry<UiCommandLike>;
  readonly chatBlocks: UiAdapterRegistry<unknown>;
  readonly chatEvents: UiAdapterRegistry<unknown>;
  readonly chatModes: UiAdapterRegistry<unknown>;
  readonly workbenchApps: UiAdapterRegistry<UiWorkbenchAppLike>;
}

/** `ctx.ui.host.<服务>.<方法>(...args)`：调用 Host 插件在 meta.remote 中开放的服务方法（FRONTEND.md §5）。 */
export type RemoteHost = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> & {
  on<T = unknown>(event: string, handler: (payload: T) => void): UiDisposer;
};
