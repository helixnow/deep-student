/**
 * 移动端入口：同步本地文件端口由 `host/platform/files/mobile-local-runtime.ts` 提供
 * （内存树 + OPFS 后台水合 + 异步回写）。会话/消息/分组等 SQLite 能力与桌面一致；
 * AGENTS.md 发现仍无 `node:os`，但附件暂存、JSONL 导出等走 OPFS 路径可用。
 *
 * 移动端没有 `dstu.agent-workspace`：本入口由 `src/plugin.ts` 按平台补上 VFS 兜底
 * `agentVfsResolver` 与 `agentApproval`，所以 retry / edit-and-resend / continue 与
 * 中高风险工具审批在移动端同样注册并可执行。
 */
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { createChatPlugin } from './src/plugin.ts';

export type { ChatPluginOptions } from './src/plugin.ts';

export default createChatPlugin({ platforms: ['mobile'], localFs: ctx => mobileLocalRuntime(ctx).chat });
