/**
 * W17 `ui-runtime` 已发布的状态读模型（`a3fb11ef`，见 interfaces/ui-runtime.md §1.3）。
 *
 * 管理页经这个**结构类型**消费 `ctx.ui.hostStatus` / `kernel.hostStatus`：W17 的 `UiHostStatusHandle`
 * 成员与这里一一对应，宿主直接传真实 handle 即可，不需要在 W35 复制内核实现或重写解析。
 * 结构化降级原因由 W17 的 `parseHostDegradedReason` 产出（Host 错误码同源 + `CONSENT_REQUIRED`），
 * 因此这里不再二次解析，避免两套规则漂移。
 */
import type { PluginLoadCode } from '../../../host/kernel/plugin-load-error.ts';

/** 与 W17 `UiDegradedCode` 相同的取值：Host 装载/安装错误码 + 同意。 */
export const CONSENT_REQUIRED_CODE = 'CONSENT_REQUIRED';
export type PluginUiDegradedCode = PluginLoadCode | typeof CONSENT_REQUIRED_CODE;

/** 与 W17 `UiDegradedInfo` 相同的形状。 */
export interface PluginUiDegradedInfo {
  readonly code?: PluginUiDegradedCode;
  /** 去掉 `<CODE>: ` 前缀后的说明。 */
  readonly detail: string;
  /** W32 K3：该插件在等同意，界面给确认入口而不是“坏插件”。 */
  readonly consentRequired: boolean;
}

/** 与 W17 `HostPluginState` 相同。 */
export type PluginUiHostState = 'unknown' | 'online' | 'degraded' | 'missing';

/** 与 W17 `HostAvailability` 相同。 */
export type PluginUiAvailability = 'available' | 'degraded' | 'missing';

/**
 * `ctx.ui.hostStatus` 的结构类型（W17 `UiHostStatusHandle`）。
 * 只读查询 + 订阅；`subscribe` 由调用方（设置分区）负责退订。
 */
export interface PluginUiHostStatus {
  readonly known: boolean;
  readonly safeMode: boolean;
  state(hostId: string): PluginUiHostState;
  reason(hostId: string): string | undefined;
  degraded(hostId: string): PluginUiDegradedInfo | undefined;
  consentRequired(hostId: string): boolean;
  availability(hostIds: readonly string[]): PluginUiAvailability;
  subscribe(listener: () => void): () => void;
}

/** 单个插件在管理页里的 UI 侧状态投影。 */
export interface PluginUiStatusSnapshot {
  readonly known: boolean;
  readonly safeMode: boolean;
  readonly hostState: PluginUiHostState;
  readonly degraded?: PluginUiDegradedInfo;
  readonly consentRequired: boolean;
}

/** 拿一个插件的 UI 侧状态；没有传入 handle（例如旧壳/演示）时返回 undefined，回落到 Host 快照。 */
export function pluginUiStatus(
  status: PluginUiHostStatus | null | undefined,
  hostId: string,
): PluginUiStatusSnapshot | undefined {
  if (!status) return undefined;
  const degraded = status.degraded(hostId);
  return {
    known: status.known,
    safeMode: status.safeMode,
    hostState: status.state(hostId),
    degraded,
    consentRequired: degraded?.consentRequired === true || status.consentRequired(hostId),
  };
}
