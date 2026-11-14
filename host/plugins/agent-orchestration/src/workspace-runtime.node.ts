/**
 * agent-orchestration runtime-root 端口的桌面实现（`agent-workspace` 的同步 runtime roots）。
 *
 * 只由桌面入口 `host/plugins/agent-orchestration/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import {
  customProfileSource, redactPathForDisplay, removeSessionFileIrreversible, resolveGroupPreferredRuntimeRoot,
  resolveStagedFileInTempRoot, revalidateRuntimeRoot, runtimeRootById, runtimeRootsForSession, sessionRoot,
  skillPackageRuntimeRoot,
} from '../../agent-workspace/api.ts';
import type { AgentOrchestrationWorkspaceRuntime } from './workspace-runtime.ts';

export const nodeAgentOrchestrationWorkspaceRuntime: AgentOrchestrationWorkspaceRuntime = {
  sessionRoot, skillPackageRuntimeRoot, runtimeRootById, runtimeRootsForSession, revalidateRuntimeRoot,
  removeSessionFileIrreversible, resolveStagedFileInTempRoot, redactPathForDisplay, resolveGroupPreferredRuntimeRoot,
  customProfileSource,
};
