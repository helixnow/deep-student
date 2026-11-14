/**
 * 桌面入口：注入同步本地端口——`node:fs` / `node:os` 运行时（人设文件、旧库迁移、调度器身份）
 * 与 `agent-workspace` 的 runtime root / skill package 根解析。移动端入口见 `mobile.ts`。
 */
import { createAgentOrchestrationPlugin } from './src/plugin.ts';
import { nodeLocalNodeRuntime } from './src/local-node-runtime.node.ts';
import { nodeAgentOrchestrationWorkspaceRuntime } from './src/workspace-runtime.node.ts';

export type { AgentOrchestrationPluginOptions } from './src/plugin.ts';

export default createAgentOrchestrationPlugin({
  platforms: ['desktop'],
  localNodeRuntime: () => nodeLocalNodeRuntime,
  workspaceRuntime: () => nodeAgentOrchestrationWorkspaceRuntime,
});
