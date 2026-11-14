/**
 * notes ACR 前端委托桥端口的桌面实现（L07 `agent-skills/api.ts`）。
 *
 * 只由桌面入口 `host/plugins/notes/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件——
 * 那份实现的运行时闭包依赖 `node:crypto`。
 */
import {
  PROBE_TIMEOUT_MS, acrBridgeCall, applyOpsTimeoutMs, isBridgeCancelled,
  isWorkbenchAgentDelegationEnabled, isValidApplyReceipt, uncertainApplyReceipt,
} from '../../agent-skills/api.ts';
import type { NotesAgentBridge } from './agent-bridge.ts';

export const nodeNotesAgentBridge: NotesAgentBridge = {
  probeTimeoutMs: PROBE_TIMEOUT_MS,
  applyOpsTimeoutMs: (opsLen, pacing) => applyOpsTimeoutMs(opsLen, pacing),
  acrBridgeCall: (ctx, command, args, timeoutMs) => acrBridgeCall(ctx, command, args, timeoutMs),
  isBridgeCancelled: (error) => isBridgeCancelled(error),
  isWorkbenchAgentDelegationEnabled: (env) => isWorkbenchAgentDelegationEnabled(env),
  isValidApplyReceipt: (value) => isValidApplyReceipt(value),
  uncertainApplyReceipt: (entityIds, opLabels, error) => uncertainApplyReceipt(entityIds, opLabels, error),
};
