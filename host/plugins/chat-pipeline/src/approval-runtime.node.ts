/**
 * chat-pipeline 审批端口的桌面实现（`agent-workspace` 的 runtime root / env 计划绑定）。
 *
 * 只由桌面入口 `host/plugins/chat-pipeline/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import { resolveLocalShellApprovalArguments } from '../../agent-workspace/api.ts';
import type {
  ChatPipelineApprovalRuntime,
} from './approval-runtime.ts';

export const nodeChatPipelineApprovalRuntime: ChatPipelineApprovalRuntime = {
  resolveLocalShellApprovalArguments,
};
