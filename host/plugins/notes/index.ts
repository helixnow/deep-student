/**
 * 桌面入口：注入同步本地文件系统 / 附件删除队列 / 数据库 worker 线程池（`node:fs` + F3）与
 * ACR 前端委托桥（L07 `agent-skills`）。移动端入口见 `mobile.ts`。
 */
import type { LogService } from '../../platform/log/api.ts';
import { diagnosticTool } from '../../platform/log/agent-executor.ts';
import { recoverNotesExport } from './src/export-recovery.node.ts';
import { createNotesPlugin } from './src/plugin.ts';
import { nodeNotesLocalRuntime } from './src/local-runtime.node.ts';
import { nodeNotesAgentBridge } from './src/agent-bridge.node.ts';

export type { NotesPluginOptions } from './src/plugin.ts';

export default createNotesPlugin({
  platforms: ['desktop'],
  localRuntime: () => nodeNotesLocalRuntime,
  agentBridge: () => nodeNotesAgentBridge,
  exportRecoveryTool: (ctx, transfer) => diagnosticTool('notes_export_recover', 'medium', async (args, agent) => {
    const log = ctx.reflect.get('log', false) as LogService | undefined;
    if (!log) throw new Error('诊断服务不可用');
    return recoverNotesExport(transfer(), log, args, agent);
  }),
});
