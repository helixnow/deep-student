/**
 * 插件管理视图（W35）的数据契约。
 *
 * 这里只有类型：真正的 Host/内核命令接线在 {@link PluginManagerAdapter}，由 W01 在命令名、
 * 参数与结果发布后实现。UI 侧不出现任何命令字符串、不直接 invoke，也不猜 Host 的返回形状——
 * W01 的实现只需把宿主返回映射成这些领域类型。
 */

/** 插件来源：随应用发布的官方（builtin）插件，或用户安装的社区插件。 */
export type PluginOrigin = 'builtin' | 'community';

/** 当前运行平台（与 `plugin:ui|manifest` v2 / Host `meta.platforms` 同一取值）。 */
export type PluginPlatform = 'desktop' | 'mobile';

/**
 * Host 侧真实运行状态。`unknown` 表示 Host 尚未报告（例如清单未到），不能当成“正在运行”。
 * UI 必须把 `enabled`（profile/已启用）与 `runtime`（运行中）分开显示。
 */
export type PluginRuntimeState = 'running' | 'stopped' | 'error' | 'unknown';

/** Host 报告的降级项（`plugin:host|status` / `UiManifestV2.degraded`）：`reason` 形如 `<CODE>: <detail>`。 */
export interface PluginDegradedState {
  readonly reason: string;
}

/** 同意账本对该插件的要求（W32）；Host 能报告时展示“需要同意”标记。 */
export type PluginConsentState = 'granted' | 'required' | 'unknown';

/** 列表中的一条已安装插件。 */
export interface ManagedPlugin {
  readonly id: string;
  readonly displayName?: string;
  readonly displayNameKey?: string;
  readonly descriptionKey?: string;
  readonly icon?: string;
  readonly author?: string;
  readonly category?: string;
  readonly homepage?: string;
  readonly trust?: 'full' | 'restricted';
  readonly source?: 'builtin' | 'workshop' | 'package';
  readonly permissions?: readonly string[];
  readonly version: string;
  readonly origin: PluginOrigin;
  /** 插件声明的平台（空数组表示未声明，视为全平台）。 */
  readonly platforms: readonly PluginPlatform[];
  /** Host profile / 安装锁里的已启用标志——不代表 UI 或 Host 运行时已经启动。 */
  readonly enabled: boolean;
  /** Host 实际运行状态（W01 `plugin:host|status` 的真实状态，不是 enabled 推断）。 */
  readonly runtime: PluginRuntimeState;
  /** 运行状态的补充说明（错误信息、加载阶段等），可直接展示。 */
  readonly runtimeDetail?: string;
  /** 降级原因；有值时列表与状态行都显示结构化原因。 */
  readonly degraded?: PluginDegradedState;
  /** 同意账本状态；`required` 时在行内提示需要同意。 */
  readonly consent?: PluginConsentState;
  /** Host 是否有可编辑的 Config schema；缺省视为未知（仍尝试读取）。 */
  readonly configurable?: boolean;
  /** 插件自带的一句话说明（可选）。 */
  readonly description?: string;
}

/** `list()` 的返回值：一次完整的已安装清单 + 当前平台。 */
export interface PluginManagerSnapshot {
  readonly safeMode?: boolean;
  readonly platform: PluginPlatform;
  readonly plugins: readonly ManagedPlugin[];
}

/** 同意请求的精确主体：ID、版本、权限列表必须与弹窗展示一致（W32 CONSENT_REQUIRED）。 */
export interface PluginConsentSubject {
  readonly id: string;
  readonly version: string;
  /** 原始权限串，例如 `service:__svc_my_plugin`；UI 原样逐条展示。 */
  readonly permissions: readonly string[];
}

/** 单次插件操作的失败。`CONSENT_REQUIRED` 携带必须展示的同意主体。 */
export type PluginOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'CONSENT_REQUIRED'; readonly consent: PluginConsentSubject }
  | { readonly ok: false; readonly code: string; readonly detail?: string };

/** 可序列化的 Schemastery Config 投影（W01 负责把插件 `Config` 投影成这个形状）。 */
export interface PluginConfigSchemaMeta {
  readonly description?: string;
  readonly default?: unknown;
  /** Schemastery `required(true)`；缺省按可选处理，避免 UI 自行猜测必填。 */
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** 字符串校验（Schemastery `pattern`），无效时只在非空值上校验。 */
  readonly pattern?: string;
}

/**
 * 一个 Config schema 节点。只覆盖管理页能安全编辑的可序列化子集：
 * boolean / string / number / 常量联合（enum）/ 顶层 object；其余节点由调用方报为不支持。
 */
export type PluginConfigSchemaNode =
  | { readonly type: 'object'; readonly dict: Readonly<Record<string, PluginConfigSchemaNode>>; readonly meta?: PluginConfigSchemaMeta }
  | { readonly type: 'boolean'; readonly meta?: PluginConfigSchemaMeta }
  | { readonly type: 'string'; readonly meta?: PluginConfigSchemaMeta }
  | { readonly type: 'number'; readonly meta?: PluginConfigSchemaMeta }
  | { readonly type: 'union'; readonly list: readonly PluginConfigSchemaNode[]; readonly meta?: PluginConfigSchemaMeta }
  | { readonly type: 'const'; readonly value: string | number | boolean; readonly meta?: PluginConfigSchemaMeta };

/** `readConfig()`：schema、当前值与修订号（保存时原样带回）。 */
export interface PluginConfigState {
  readonly schema: PluginConfigSchemaNode | null;
  readonly values: Readonly<Record<string, unknown>>;
  readonly revision: PluginConfigRevision;
}

/** Host profile CAS token is opaque text; numeric revisions remain valid for injected legacy adapters. */
export type PluginConfigRevision = string | number;

/** 保存失败：`REVISION_CONFLICT` 表示另一窗口已更新配置，需重新加载后再改。 */
export type PluginConfigSaveResult =
  | { readonly ok: true; readonly values: Readonly<Record<string, unknown>>; readonly revision: PluginConfigRevision }
  | {
      readonly ok: false;
      readonly code: string;
      readonly detail?: string;
      /** 宿主校验失败的逐字段信息（可选）；字段名与 schema 顶层 key 一致。 */
      readonly issues?: readonly PluginConfigFieldIssue[];
    };

/** 表单无法渲染 / 无法保存的字段（`union` 含对象、`dict`、`list` 等）。 */
export interface PluginConfigFieldIssue {
  /** 顶层字段名；整表问题使用 `$`。 */
  readonly field: string;
  readonly message: string;
}

/** 离线 `.dsplugin` 安装结果：磁盘已安装 ≠ 已同意 ≠ 正在运行（W34/W01 契约）。 */
export type PluginPackageResult =
  | {
      readonly status: 'installed';
      readonly id: string;
      readonly version: string;
      /** 升级前的版本；全新安装为 null。 */
      readonly previousVersion: string | null;
      /** 安装后的启用标志（升级保留、全新安装默认停用）。 */
      readonly enabled: boolean;
      /** Exact screened subject returned by the install command, never derived from the ZIP by UI. */
      readonly consentRequired?: PluginConsentSubject;
    }
  | {
      readonly status: 'rolled-back';
      readonly id?: string;
      readonly version?: string;
      readonly previousVersion: string | null;
      readonly reason: string;
    }
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly detail: string;
      readonly rollback: 'restored' | 'unchanged' | 'failed';
    };

/**
 * Host 适配器（W01 实现）。每个方法对应一个用户意图，命令名、参数与返回值映射都留在实现里；
 * UI 不点名任何命令，因此命令 SHA 发布后只需替换这个对象的实现。
 *
 * 约定：只有成功时才 resolve `{ ok: true }`；任何失败都返回结果对象或 reject，UI 都不做乐观更新。
 */
export interface PluginManagerAdapter {
  /** 官方 + 社区已安装插件清单（含真实运行状态、平台与降级原因）。 */
  list(): Promise<PluginManagerSnapshot>;
  /** 启用/停用：启用前 Host 必须完成同意与安装校验。 */
  setEnabled(id: string, enabled: boolean): Promise<PluginOperationResult>;
  /** P1: exact screened subject, confirmed by the user; does not re-enable the plugin. */
  setTrust?(subject: PluginConsentSubject, trust: 'full' | 'restricted'): Promise<PluginOperationResult>;
  /** 卸载社区插件：Host 先停止运行时再返回成功。 */
  uninstall(id: string): Promise<PluginOperationResult>;
  /** 写同意账本（W32）；成功后调用方负责 `reload()`。 */
  grantConsent(subject: PluginConsentSubject): Promise<PluginOperationResult>;
  /** 授权/安装后的整窗重载；失败应 reject，UI 保留“已授权但未生效”的提示。 */
  reload(): Promise<void>;
  /** 读取插件的 Config schema 与带修订号的当前值。 */
  readConfig(id: string): Promise<PluginConfigState>;
  /** 带修订号保存；修订号冲突返回 `REVISION_CONFLICT`，不得静默覆盖。 */
  saveConfig(id: string, values: Readonly<Record<string, unknown>>, revision: PluginConfigRevision): Promise<PluginConfigSaveResult>;
  /** 选择并安装离线 `.dsplugin`（文件选择、ZIP 事务与回滚由 Host/W34 负责）。 */
  importPackage(): Promise<PluginPackageResult | null>;
  /** Host 推送清单变化时的重新拉取信号（可选）。 */
  subscribe?(listener: () => void): () => void;
}
