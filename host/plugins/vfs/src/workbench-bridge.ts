/**
 * 工作台 ACR 桥端口（`mindmap_edit_nodes` 的前端委托路径）。
 *
 * 导图窗口打开且 feature flag + 设置双重开关启用时，`mindmap_edit_nodes` 通过前端桥实时应用操作；
 * 桥协议实现留在 L07（`agent-skills`，含 Node `crypto` / `Buffer`）。桌面入口 `index.ts` 注入真实实现，
 * 移动端没有前端窗口，缺省端口把双重开关视为关闭，`mindmap_edit_nodes` 走后端数据面。
 */
import type {
  AcrBridgeCallContext,
  AcrBridgeResponse,
  WorkbenchGateEnvironment,
} from '../../agent-skills/api.ts';

export type { AcrBridgeCallContext, AcrBridgeResponse, WorkbenchGateEnvironment };

export interface WorkbenchBridge {
  readonly probeTimeoutMs: number;
  applyOpsTimeoutMs(opsLen: number, pacing?: string | null): number;
  uncertainApplyReceipt(entityIds: string[], opLabels: string[], error: string): Record<string, unknown>;
  isValidApplyReceipt(value: unknown): boolean;
  isBridgeCancelled(error: string): boolean;
  isWorkbenchAgentDelegationEnabled(env: WorkbenchGateEnvironment | null | undefined): boolean;
  acrBridgeCall(
    ctx: AcrBridgeCallContext,
    command: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<AcrBridgeResponse>;
}

const unavailable = (operation: string): never => { throw new Error(`workbench bridge unavailable: ${operation}`); };

/** 缺省端口：没有前端窗口，双重开关视为关闭。 */
export const unavailableWorkbenchBridge: WorkbenchBridge = {
  // 与 `PROBE_TIMEOUT_MS` 一致；开关关闭时不会使用。
  probeTimeoutMs: 3_000,
  applyOpsTimeoutMs: (opsLen) => unavailable(`apply_ops timeout for ${opsLen} ops`),
  uncertainApplyReceipt: () => unavailable('uncertain receipt'),
  isValidApplyReceipt: () => false,
  isBridgeCancelled: () => false,
  isWorkbenchAgentDelegationEnabled: () => false,
  acrBridgeCall: () => Promise.reject(new Error('workbench bridge unavailable: acrBridgeCall')),
};

let active: WorkbenchBridge = unavailableWorkbenchBridge;

/** 入口注入平台实现；`null` 恢复缺省（没有前端桥）。 */
export function setWorkbenchBridge(bridge: WorkbenchBridge | null): void {
  active = bridge ?? unavailableWorkbenchBridge;
}

/** 稳定门面。 */
export const workbench: WorkbenchBridge = {
  get probeTimeoutMs() { return active.probeTimeoutMs; },
  applyOpsTimeoutMs: (opsLen, pacing) => active.applyOpsTimeoutMs(opsLen, pacing),
  uncertainApplyReceipt: (entityIds, opLabels, error) => active.uncertainApplyReceipt(entityIds, opLabels, error),
  isValidApplyReceipt: (value) => active.isValidApplyReceipt(value),
  isBridgeCancelled: (error) => active.isBridgeCancelled(error),
  isWorkbenchAgentDelegationEnabled: (env) => active.isWorkbenchAgentDelegationEnabled(env),
  acrBridgeCall: (ctx, command, args, timeoutMs) => active.acrBridgeCall(ctx, command, args, timeoutMs),
};
