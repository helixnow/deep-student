/**
 * 桌面入口：注入 `node:fs` / `node:fs/promises` 本地运行时端口（blobs、导出临时 ZIP、思维导图导入、
 * 附件暂存、静态资源协议），以及前端工作台 ACR 桥（`mindmap_edit_nodes` 的实时应用路径）。
 * 移动端入口见 `mobile.ts`。
 */
import {
  PROBE_TIMEOUT_MS,
  acrBridgeCall,
  applyOpsTimeoutMs,
  isBridgeCancelled,
  isWorkbenchAgentDelegationEnabled,
  isValidApplyReceipt,
  uncertainApplyReceipt,
} from '../agent-skills/api.ts';
import { createVfsPlugin } from './src/plugin.ts';
import { nodeLocalRuntime } from './src/local-runtime.node.ts';

export type { VfsPluginOptions } from './src/plugin.ts';

export default createVfsPlugin({
  platforms: ['desktop'],
  localRuntime: () => nodeLocalRuntime,
  workbenchBridge: () => ({
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    acrBridgeCall,
    applyOpsTimeoutMs,
    isBridgeCancelled,
    isValidApplyReceipt,
    isWorkbenchAgentDelegationEnabled,
    uncertainApplyReceipt,
  }),
});
