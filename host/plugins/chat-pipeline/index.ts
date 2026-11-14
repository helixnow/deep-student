/**
 * 桌面入口：注入 `node:fs` 同步文件端口（产物校验、检索页图片、主库 settings 探测）与
 * `agent-workspace` 的本地 shell 审批绑定实现。移动端入口见 `mobile.ts`。
 */
import { createChatPipelinePlugin } from './src/plugin.ts';
import { nodeChatPipelineLocalFs } from './src/local-fs.node.ts';
import { nodeChatPipelineApprovalRuntime } from './src/approval-runtime.node.ts';

export type { ChatPipelinePluginOptions } from './src/plugin.ts';

export default createChatPipelinePlugin({
  platforms: ['desktop'],
  localFs: () => nodeChatPipelineLocalFs,
  approvalRuntime: () => nodeChatPipelineApprovalRuntime,
});
