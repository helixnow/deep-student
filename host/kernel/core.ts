/**
 * 内核可移植入口（W14）：插件编写接口中**只含类型、常量与零逻辑函数**的部分——
 * `definePlugin`、`CommandError`、命令/事件/外壳/协议类型、`PluginMeta`（含 `platforms`）与 Cordis 上下文增强。
 * 运行时只加载 `error-model.ts` → `json.ts`，不触达任何 Node 模块，桌面与移动端共用。
 * `api.ts` 重导出本文件的全部内容，现有插件不用改导入。
 */
import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';
import type { ConfigSchemaProjection } from './config-schema.ts';
import type { EventTarget, WindowLifecycle, WindowRef } from './protocol.ts';

// Older mobile WebView engines (e.g., Android System WebView / Chromium < 123)
// lack ES2025 `JSON.rawJSON` and `JSON.isRawJSON`. Polyfill them with a WeakSet
// brand and a non-enumerable `toJSON` so `JSON.stringify` emits JSON numbers.
{
  const gJson = JSON as typeof JSON & {
    rawJSON?(text: string): Readonly<{ rawJSON: string }>;
    isRawJSON?(value: unknown): value is Readonly<{ rawJSON: string }>;
  };
  if (typeof gJson.rawJSON !== 'function' || typeof gJson.isRawJSON !== 'function') {
    const brand = new WeakSet<object>();
    gJson.rawJSON = (text: string): Readonly<{ rawJSON: string }> => {
      const str = String(text);
      const atom = Object.create(null) as { rawJSON: string };
      Object.defineProperty(atom, 'rawJSON', { value: str, enumerable: true, writable: false, configurable: false });
      Object.defineProperty(atom, 'toJSON', {
        value: () => {
          const n = Number(str);
          return Number.isFinite(n) ? n : str;
        },
        enumerable: false,
        writable: false,
        configurable: false,
      });
      Object.freeze(atom);
      brand.add(atom);
      return atom;
    };
    gJson.isRawJSON = (value: unknown): value is Readonly<{ rawJSON: string }> =>
      typeof value === 'object' && value !== null && brand.has(value);
  }
}

// Older mobile WebView engines (Android System WebView / Chromium < 116) also lack
// `AbortSignal.any`. HTTP timeouts and plugin aborts compose signals with it, so the
// missing API would turn every timed request into a TypeError.
{
  if (typeof AbortSignal !== 'undefined') {
    const gAbort = AbortSignal as typeof AbortSignal & {
      any?(signals: Iterable<AbortSignal>): AbortSignal;
    };
    if (typeof gAbort.any !== 'function') {
      gAbort.any = (signals: Iterable<AbortSignal>): AbortSignal => {
        const controller = new AbortController();
        const list = [...signals];
        for (const signal of list) {
          if (signal.aborted) {
            controller.abort(signal.reason);
            return controller.signal;
          }
        }
        const onAbort = (event: Event): void => {
          for (const signal of list) signal.removeEventListener('abort', onAbort);
          controller.abort((event.target as AbortSignal | null)?.reason);
        };
        for (const signal of list) signal.addEventListener('abort', onAbort, { once: true });
        return controller.signal;
      };
    }
    if (typeof (gAbort as typeof AbortSignal & { timeout?: unknown }).timeout !== 'function') {
      // `AbortSignal.timeout` 与 `any` 同一批进入 Chromium（< 103 没有），HTTP 超时依赖它。
      (gAbort as typeof AbortSignal & { timeout(ms: number): AbortSignal }).timeout = (ms: number): AbortSignal => {
        if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`AbortSignal.timeout: invalid timeout ${ms}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
        // 让进程/测试不因长超时保持存活（浏览器里 setTimeout 返回 number）。
        (timer as unknown as { unref?: () => void }).unref?.();
        return controller.signal;
      };
    }
  }
}

/** @stable */
export type { Context } from '@deepseek-ai/cordis';
/** @stable */
export { CommandError, errorDisplay } from './error-model.ts';
/** @stable */
export type { EventTarget, WindowRef } from './protocol.ts';
export type { ShellErrorData, WindowLifecycle } from './protocol.ts';
export type { JsonSchema } from './contract.ts';
/** Typed IPC integers are numbers within JS's safe range, bigint outside it. */
export type IpcInteger = number | bigint;
/** Shape of `CallContext.exactPayload()`: numbers that a JS number would not spell back use F4 native atoms;
 * serialize with JSON.stringify, do not spread/structuredClone atoms. Command Value args are plain JSON. */
export type IpcJsonValue = null | boolean | string | number | import('../platform/util/portable.ts').JsonRawNumber
  | IpcJsonValue[] | { [key: string]: IpcJsonValue };

/** F2 forwards this FrontendEvent; L17 subscribes with ctx.backendEvents.listen. */
export const GLOBAL_SHORTCUT_TRIGGERED = 'global-shortcut://triggered';

// ------------------------------------------------------------------ 命令

/**
 * 一次 invoke 的调用上下文，替代 Rust 命令中注入的 Window / AppHandle 等参数。
 * @stable
 */
export interface CallContext {
  /** 发起调用的窗口（对应注入的 `Window` / `WebviewWindow`）。 */
  readonly source: WindowRef;
  /** 调用方放弃等待时中止（见 protocol.ts `InvokeAbandon` 的语义限制）。 */
  readonly signal: AbortSignal;
  /** invoke 的唯一 id，用于日志关联。 */
  readonly invokeId: string;
  /**
   * （增补，可选）前端传入的原始 invoke 载荷，未经筛选。仅供注入了 `tauri::ipc::Request`
   * 的命令读取原始 body；普通命令只读 `args`。JSON 载荷里的数字一律是普通 number（与 `JSON.parse` 相同，
   * 见 host/platform/API.md「数字表示」）。
   */
  readonly payload?: unknown;
  /**
   * （增补，可选）显式取精确载荷：JSON 载荷中安全整数以外的数字 token 保留为 `JSON.rawJSON` 原子（含 `1.0`、`1e400`），
   * 首次调用时计算。原子不能 `structuredClone` / `postMessage` / `Number()`，只在需要 serde 式 token 语义时用，
   * 用完立即序列化或转换。字节载荷与 `payload` 相同。
   */
  readonly exactPayload?: () => unknown;
  /**
   * （增补，可选）main 转发的原始请求头。仅在调用方提供时存在；
   * 对应 Rust `tauri::ipc::Request::headers()`。
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 命令处理函数。`args` 已经过契约校验，键名为前端传入的键名（默认 camelCase）。
 * - 返回值 = Rust `Ok(T)` 的序列化值；返回 `undefined` 时按 `null` 发送。
 * - 要让前端 Promise 以指定值 reject（对应 Rust `Err(E)`），抛出 `CommandError`（定义在 `error-model.ts`）。
 * @stable
 */
export type CommandHandler<A = Record<string, unknown>, R = unknown> = (
  args: A,
  call: CallContext,
) => R | Promise<R>;

/** @stable */
export interface CommandRegistry {
  /**
   * 注册 Tauri 命令。名称必须存在于 contracts/ipc 中，且同名只能注册一次。
   * 注册随调用方插件卸载而撤销。
   */
  register<A = Record<string, unknown>, R = unknown>(name: string, handler: CommandHandler<A, R>): void;
  has(name: string): boolean;
}

// ------------------------------------------------------------------ 事件

/** @stable */
export interface BackendEvents {
  /** 对应 Rust `app.emit(event, payload)`，目标为全部监听者。 */
  emit(event: string, payload: unknown): void;
  /** 对应 Rust `emit_to` / `emit_filter`。 */
  emitTo(target: EventTarget, event: string, payload: unknown): void;
  /** 对应 Rust `app.listen(event, ...)`：订阅前端 `emit` 发来的事件。随插件卸载撤销。 */
  listen(event: string, handler: (payload: unknown, source: WindowRef) => void): void;
  /**
   * 对应 Rust `Window::listen(event, ...)`（src/window/mod.rs:2353）：以 `EventTarget::Window { label }`
   * 订阅该窗口的事件。
   *
   * 投递按 Tauri target 规则判定，与发出者 `source` 无关：后端 `emit` 广播（target Any）会送达窗口
   * 监听者；`emitTo({ kind: 'Window', label })` 只送达目标窗口；其他窗口的同名事件不会误投。
   * 返回的注销函数可重复调用（幂等），监听同时随插件卸载撤销。
   */
  listenWindow(window: WindowRef, event: string, receive: (payload: unknown) => void): () => void;
}

// ------------------------------------------------------------------ 应用与外壳

/** @stable */
export interface AppInfo {
  /** 与 Tauri `app_data_dir()` 相同的目录。 */
  readonly dataDir: string;
  readonly version: string;
  readonly platform: 'darwin' | 'win32' | 'linux';
  /** 对应 `cfg!(debug_assertions)`。 */
  readonly debug: boolean;
}

/** 只能在 Electron main 进程完成的操作（窗口、原生对话框等），由 F2 实现。 */
export interface ShellBridge {
  request<R = unknown>(op: string, args?: unknown): Promise<R>;
}

// ------------------------------------------------------------------ 自定义协议

/** @stable */
export interface ProtocolRequestInfo {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/** @stable */
export interface ProtocolReply {
  status: number;
  headers: Record<string, string>;
  /** 一次性响应体，或按顺序产出的分块（大文件、Range）。 */
  body: Uint8Array | AsyncIterable<Uint8Array>;
}

/** @stable */
export interface ProtocolRegistry {
  /** 注册自定义协议（如 `pdfstream`），对应 Rust `register_uri_scheme_protocol`。随插件卸载撤销。 */
  register(scheme: string, handler: (req: ProtocolRequestInfo) => ProtocolReply | Promise<ProtocolReply>): void;
}

// ------------------------------------------------------------------ 插件定义

/**
 * 插件可装配的平台（profile）；定义在 `platforms.ts`，前端 UI 内核共用同一常量。
 * @stable
 */
export { PLUGIN_PLATFORMS } from './platforms.ts';
/** @stable */
export type { PluginPlatform } from './platforms.ts';
import type { PluginPlatform } from './platforms.ts';

/** @stable */
export interface PluginMeta {
  // RUST-FIX(RF-P1-plugin-display): Optional display metadata shared by builtin inventory.
  displayName?: string;
  displayNameKey?: string;
  descriptionKey?: string;
  icon?: string;
  author?: string;
  description?: string;
  category?: string;
  homepage?: string;
  /** 全局唯一，如 `dstu.qbank`。用户插件可用同 id 覆盖官方插件。 */
  id: string;
  /** 所属 lane（官方插件），如 `L14-qbank`。 */
  lane?: string;
  /** 本插件注册的 Tauri 命令名，kernel 据此校验覆盖完整性。 */
  commands?: readonly string[];
  /** 本插件提供的服务名（`ctx` 上的属性名）。 */
  provides?: readonly string[];
  /** UI 半模块路径，相对插件模块文件（`docs/plugins/FRONTEND.md` §3）。 */
  ui?: string;
  /** 服务名 → 允许 UI 经 `plugin:host|call` 调用的方法名（§5）。 */
  remote?: Record<string, readonly string[]>;
  /** UI 引导清单里的版本号（用户/社区插件由自己的 package.json 提供）。 */
  version?: string;
  /**
   * 可装配的平台；缺省 `['desktop']`。可移植插件（运行时闭包不触达 Node 专有模块）声明
   * `['desktop', 'mobile']`，只能在移动端运行的实现声明 `['mobile']`。校验见 `host/profiles/platforms.ts`。
   */
  platforms?: readonly PluginPlatform[];
}

/** 插件私有 Host→UI 事件；event 必须带本插件 pluginEventName 派生的前缀。 */
// RUST-FIX(RF-W01-ui-events-emitter): Rust 没有社区插件事件 API（src-tauri/src/plugins/events.rs 只有固定三个 Host 事件）。
export interface UiEvents {
  emit(event: string, payload: unknown): void;
}

/** UI 引导清单条目；`file` 是 UI 半模块的绝对路径。 */
export interface UiManifestEntry {
  id: string;
  file: string;
  version?: string;
}

/** 清单变化事件（启动、插件装卸、profile 回退）。 */
export const UI_MANIFEST_EVENT = 'host://ui-manifest';

/** 内核自有命令：返回 UI 引导清单。 */
export const UI_MANIFEST_COMMAND = 'plugin:ui|manifest';
export const UI_READY_COMMAND = 'plugin:ui|ready';

/** 内核自有命令：UI 调用插件 `meta.remote` 放行的服务方法。 */
export const HOST_CALL_COMMAND = 'plugin:host|call';

/** 内核自有命令：返回本次 profile 装载中未安装的插件（`DegradedPlugin[]`）。 */
export const HOST_STATUS_COMMAND = 'plugin:host|status';

// ------------------------------------------------------------------ 插件管理命令（P1-1/P1-3，W35 消费）
// 全部只在内核注册，只接受主窗口**本地**页（`WindowRef.origin` 缺省）的调用；参数与返回都是纯 JSON。

/** 已装/已声明插件清单（唯一入口，含运行态、降级原因、平台、权限与同意状态）。 */
export const PLUGIN_MANAGER_LIST_COMMAND = 'plugin:manager|list';
export const PLUGIN_MANAGER_UPDATE_IMPACT_COMMAND = 'plugin:manager|update-impact';

export interface PluginUpdateImpact {
  /** Enabled plugins whose manifest rejects the target app version. */
  incompatible: string[];
  /** Enabled plugins whose manifest could not be inspected without loading code. */
  unchecked: string[];
}
/** 一个插件的配置 schema 投影 + 当前生效值 + profile 修订号。 */
export const PLUGIN_MANAGER_CONFIG_COMMAND = 'plugin:manager|config';
/** 按修订号保存配置（CAS；写入用户 profile 并热更新已运行插件）。 */
export const PLUGIN_MANAGER_CONFIG_SAVE_COMMAND = 'plugin:manager|config|save';
/** 按修订号启用/停用一个插件（停用即卸载；启用走同意检查后热装载）。 */
export const PLUGIN_MANAGER_SET_ENABLED_COMMAND = 'plugin:manager|set-enabled';
/** 按修订号卸载一个插件（卸载运行态、移除 profile 条目；有 W34 包存储时同时移除指针）。 */
export const PLUGIN_MANAGER_UNINSTALL_COMMAND = 'plugin:manager|uninstall';
/** 确认社区插件的 ID/版本/权限并写入同意账本（K3）；成功后调用方重新启用/装载。 */
export const PLUGIN_MANAGER_CONSENT_COMMAND = 'plugin:manager|consent';
/** 离线 ZIP 安装；磁盘安装后保持停用，用户确认同意后显式启用。 */
export const PLUGIN_MANAGER_INSTALL_COMMAND = 'plugin:manager|install';
export const PLUGIN_MANAGER_SET_TRUST_COMMAND = 'plugin:manager|set-trust';

export interface PluginManagerInstallResult {
  id: string;
  version: string;
  enabled: false;
  revision: string;
  consentRequired: { code: 'CONSENT_REQUIRED'; id: string; version: string; permissions: readonly string[] };
  rollback: 'not-needed';
}

/** 由 profile 推算的启用状态（`enabled` 仅表示 profile 允许装载，不表示正在运行）。 */
export type PluginManagerState = 'running' | 'degraded' | 'disabled' | 'not-installed';

/** `plugin:manager|list` 的一条记录。 */
export interface PluginManagerEntry {
  trust: 'full' | 'restricted';
  source: 'builtin' | 'workshop' | 'package';
  displayName?: string;
  displayNameKey?: string;
  descriptionKey?: string;
  icon?: string;
  author?: string;
  description?: string;
  category?: string;
  homepage?: string;
  id: string;
  origin: HostPluginOrigin;
  platforms: readonly PluginPlatform[];
  version?: string;
  /** profile 层允许装载（`false` 即用户层有 `disabled: true`）。 */
  enabled: boolean;
  state: PluginManagerState;
  /** 降级原因（`parseDegradedReason` 可解析错误码），仅 `degraded` 时给出。 */
  reason?: string;
  /** 社区清单声明的权限（`service:<name>`）；官方插件为空数组。 */
  permissions: readonly string[];
  /** 插件声明的服务（`meta.provides`）。 */
  services: readonly string[];
  /** 有 `Config`（Schemastery）可配置。 */
  hasConfig: boolean;
  /** 社区插件的同意状态（K3）；官方插件没有此字段。 */
  consent?: {
    matched: boolean;
    code: 'CONSENT_REQUIRED' | null;
    reason: 'missing' | 'version' | 'permissions' | null;
    grantedPermissions: readonly string[];
  };
}

/** `plugin:manager|list` 的返回值。 */
export interface PluginManagerInventory {
  safeMode: boolean;
  /** 用户 profile 修订号（写操作的 CAS 期望值）；`null` 表示本会话不允许写 profile。 */
  revision: string | null;
  plugins: PluginManagerEntry[];
}

/** `plugin:manager|config` 的返回值。 */
export interface PluginManagerConfigView {
  id: string;
  /** 用户 profile 修订号（保存时回传）。 */
  revision: string | null;
  /** 当前生效配置（已补默认值、纯 JSON）。 */
  values: unknown;
  /** Schemastery 投影；插件没有 `Config` 时为 `null`。 */
  schema: ConfigSchemaProjection | null;
}

/** `plugin:manager|consent` 的返回值（写入后的账本记录摘要）。 */
export interface PluginManagerConsentView {
  trust?: 'full' | 'restricted';
  source?: 'workshop' | 'package';
  id: string;
  version: string;
  permissions: readonly string[];
  permissionsDigest: string;
}


/** profile 装载后仍有插件未安装时广播的事件。 */
export const PLUGINS_DEGRADED_EVENT = 'host://plugins-degraded';

/**
 * 未安装的插件及原因（缺服务、apply 失败或依赖级联）。
 * @stable
 */
export interface DegradedPlugin {
  id: string;
  reason: string;
}

// ------------------------------------------------------------------ UI 清单 v2（FE-A3）

/**
 * `plugin:ui|manifest` 带参数 `{ version: 2 }` 时返回 {@link UiManifestV2}；不带参数仍返回 v1 的
 * `UiManifestEntry[]`（外壳 `ds-plugin://` 与旧前端依赖 v1 形状）。
 */
export const UI_MANIFEST_VERSION = 2;

/**
 * v2 清单变化事件，载荷为 {@link UiManifestV2}。只在本 Host 收到过一次 v2 清单请求之后发出：
 * 没有 v2 消费者的连接（外壳、测试宿主）看到的事件序列与 v1 完全相同。
 */
export const UI_MANIFEST_V2_EVENT = 'host://ui-manifest-v2';

/**
 * 插件来源：模块位于应用内（`host/`、`electron/`，或进程内直接安装）为 `builtin`，否则为 `community`。
 * @stable
 */
export type HostPluginOrigin = 'builtin' | 'community';

/** v2 清单中的一个已安装插件。 */
export interface UiManifestV2Plugin {
  id: string;
  origin: HostPluginOrigin;
  /** `meta.platforms`，缺省按 `['desktop']` 补齐。 */
  platforms: readonly PluginPlatform[];
  version?: string;
  /** 社区插件 UI 半模块的绝对路径（与 v1 的 `file` 相同）；官方插件的 UI 半打包在前端，没有此字段。 */
  file?: string;
}

/** UI 清单 v2：全部已安装插件（安装顺序）与本次 profile 装载中未安装的插件（同 `plugin:host|status`）。 */
export interface UiManifestV2 {
  version: typeof UI_MANIFEST_VERSION;
  plugins: UiManifestV2Plugin[];
  degraded: DegradedPlugin[];
  /** 本次 Host 会话是否处于安全模式（W06 `--safe-mode`）：仅官方插件，社区 UI 不得装载。 */
  safeMode: boolean;
}

/** @stable */
export interface HostPlugin<C = void> {
  name: string;
  meta: PluginMeta;
  /** Cordis 注入：插件启动前必须就绪的服务名（Cordis 4 中每一项都是必需的）。 */
  inject?: readonly string[];
  /**
   * 配置 schema（Schemastery）。kernel 在 `apply` 之前按它校验 profile 配置并补齐默认值，
   * 失败或 schema 含凭据字段时降级该插件（`CONFIG_INVALID` / `CONFIG_CREDENTIAL`）；Cordis 对 `fiber.update` 同样校验。
   */
  Config?: Schema<any, C>;
  apply(ctx: Context, config: C): void | Promise<void>;
}

/**
 * 零逻辑的类型辅助：`export default definePlugin({ ... })`。
 * @stable
 */
export function definePlugin<C = void>(plugin: Omit<HostPlugin<C>, 'name'> & { name?: string }): HostPlugin<C> {
  return { name: plugin.name ?? plugin.meta.id, ...plugin } as HostPlugin<C>;
}

/** `host/exiting` 的参数：`shutdown` = 外壳要求退出（serve 的 shutdown 消息、SIGTERM）；`dispose` = 直接 `runtime.dispose()`（SDK、测试宿主）。 */
export interface HostExiting {
  readonly reason: 'shutdown' | 'dispose';
}

// ------------------------------------------------------------------ ctx 增强

declare module '@deepseek-ai/cordis' {
  /** （增补）kernel 派发的 Cordis 事件。用 `ctx.on(name, listener)` 订阅，随插件卸载撤销。 */
  interface Events {
    /**
     * main 转发的窗口生命周期（protocol.ts `WindowLifecycle`），对应 Rust 的 WindowEvent 监听；
     * `page-load-started` 对应 `on_page_load` 的 `PageLoadEvent::Started`，按 `ref.webview` 识别开始加载的页面。
     */
    'host/window'(ref: WindowRef, state: WindowLifecycle['state']): void;
    /**
     * Host 开始关停，每个 runtime 只发一次，早于任何插件 dispose 与命令中止；对应 Rust `RunEvent::ExitRequested`。
     * 同步派发，监听器的返回值不被等待：在这里做取消（abort、置位），不要做耗时清理（放进 `ctx.effect` 的 disposer）。
     */
    'host/exiting'(info: HostExiting): void;
  }

  interface Context {
    /** F1：命令注册表。 */
    commands: CommandRegistry;
    /** F1：后端事件。 */
    backendEvents: BackendEvents;
    /** 只允许发送所属插件命名空间内的 UI 事件（同进程防误用，不是物理隔离）。 */
    uiEvents: UiEvents;
    /** F1：握手时由外壳提供的应用信息。 */
    app: AppInfo;
    /** F1/F2：main 进程代办通道。 */
    shell: ShellBridge;
    /** F1：自定义协议注册表。 */
    protocols: ProtocolRegistry;
  }
}
