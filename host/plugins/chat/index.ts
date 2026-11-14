/**
 * 桌面入口：注入 `node:fs` / `node:os` 同步文件端口（AGENTS.md 发现、人设文件、附件暂存/解包、
 * JSONL 导出写盘）与 `agent-workspace` 的同步 runtime-root 端口。移动端入口见 `mobile.ts`。
 */
import { createChatPlugin } from './src/plugin.ts';
import { nodeChatLocalFs } from './src/local-fs.node.ts';
import { nodeChatWorkspaceRuntime } from './src/runtime-roots.node.ts';

export type { ChatPluginOptions } from './src/plugin.ts';

export default createChatPlugin({
  platforms: ['desktop'], localFs: () => nodeChatLocalFs, workspaceRuntime: () => nodeChatWorkspaceRuntime,
});
