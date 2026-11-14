/**
 * notes 的 ACR 前端委托桥端口（L07 `agent-skills` 的 workbench bridge）。
 *
 * 画布工具把笔记写入委托给前端编辑器时需要 L07 的桥实现（`acrBridgeCall` 等），那份实现经由
 * `agent-skills/api.ts` 的运行时闭包依赖 `node:crypto`，移动端装不进去。因此这一层用端口隔离：
 * 桌面入口 `host/plugins/notes/index.ts` 注入 L07 的实现（`agent-bridge.node.ts`），移动端入口
 * （`mobile.ts`）不注入——缺省端口把委托闸门判为关闭，画布工具改走后端数据面（`null` 分支），
 * 与用户在桌面上关闭 ACR 委托时的行为一致；万一有人绕过闸门直接调用桥，则抛“不可用”。
 */
import type {
  AcrBridgeCallContext, AcrBridgeResponse, BridgeEventBus, WorkbenchGateEnvironment,
} from '../../agent-skills/api.ts';

export interface NotesAgentBridge {
  /** `probe` 命令的固定超时（L07 `PROBE_TIMEOUT_MS`）。 */
  readonly probeTimeoutMs: number;
  applyOpsTimeoutMs(opsLen: number, pacing?: string | null): number;
  acrBridgeCall(
    ctx: AcrBridgeCallContext,
    command: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<AcrBridgeResponse>;
  isBridgeCancelled(error: string): boolean;
  isWorkbenchAgentDelegationEnabled(env: WorkbenchGateEnvironment | null | undefined): boolean;
  isValidApplyReceipt(value: unknown): boolean;
  uncertainApplyReceipt(entityIds: string[], opLabels: string[], error: string): Record<string, unknown>;
}

export class AgentBridgeUnavailableError extends Error {
  constructor(operation: string) {
    super(`agent bridge unavailable: ${operation}`);
    this.name = 'AgentBridgeUnavailableError';
  }
}

/** 缺省端口：没有 ACR 前端委托（移动端 / 未注入）；闸门关闭，画布工具走后端数据面。 */
const UNAVAILABLE: NotesAgentBridge = {
  probeTimeoutMs: 3_000,
  applyOpsTimeoutMs: () => { throw new AgentBridgeUnavailableError('applyOpsTimeoutMs'); },
  acrBridgeCall: async () => { throw new AgentBridgeUnavailableError('acrBridgeCall'); },
  isBridgeCancelled: () => false,
  isWorkbenchAgentDelegationEnabled: () => false,
  isValidApplyReceipt: () => false,
  uncertainApplyReceipt: () => { throw new AgentBridgeUnavailableError('uncertainApplyReceipt'); },
};

let active: NotesAgentBridge = UNAVAILABLE;

/** 入口注入 L07 实现；`null` 恢复缺省（无前端委托）。 */
export function setNotesAgentBridge(bridge: NotesAgentBridge | null): void {
  active = bridge ?? UNAVAILABLE;
}

/** 当前端口；画布工具的前端委托全部经它。 */
export function notesAgentBridge(): NotesAgentBridge {
  return active;
}

export type { AcrBridgeCallContext, BridgeEventBus, WorkbenchGateEnvironment };
