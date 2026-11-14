/**
 * chat runtime-root 端口的桌面实现（`agent-workspace` 的同步 runtime root 解析）。
 *
 * 只由桌面入口 `host/plugins/chat/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import {
  artifactRoot, cleanupSessionRuntimeRoots, listCustomAgentFiles, tempRoot, type CustomAgentFileInfo,
  type RuntimeRoot,
} from '../../agent-workspace/api.ts';
import type { ChatWorkspaceLogger, ChatWorkspaceRuntime, SessionRootKind } from './runtime-roots.ts';

function sessionRoot(dataDir: string, sessionId: string, kind: SessionRootKind, create: boolean): RuntimeRoot {
  return kind === 'artifact' ? artifactRoot(dataDir, sessionId, create) : tempRoot(dataDir, sessionId, create);
}

export const nodeChatWorkspaceRuntime: ChatWorkspaceRuntime = {
  sessionRoot,
  cleanupSessionRuntimeRoots,
  listCustomAgentFiles: (dir: string, logger?: ChatWorkspaceLogger): CustomAgentFileInfo[] =>
    listCustomAgentFiles(dir, logger),
};
