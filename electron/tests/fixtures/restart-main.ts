/**
 * 测试入口：只替换最终不可逆的 restart/exit hooks，其余仍由真实 `electron/main.ts`
 * 启动真实 Host 协议、窗口与 shell-request 路由。
 */
import { appendFileSync } from 'node:fs';
import { app } from 'electron';
import { start } from '../../main.ts';

const hooksReport = process.env.RESTART_HOOKS_REPORT;
const record = (entry: Record<string, unknown>) => {
  if (hooksReport !== undefined) appendFileSync(hooksReport, `${JSON.stringify(entry)}\n`);
};

void app.whenReady().then(() => start({
  // 测试里 Host 是故意早退的：不弹原生恢复对话框，按“保留配置并停止恢复”作答。
  startupRecoveryPrompt: async () => ({ response: 0 }),
  processHooks: {
    restart: () => record({ hook: 'restart' }),
    exit: (code: number) => record({ hook: 'exit', code }),
  },
})).catch((error: unknown) => {
  record({ hook: 'fatal', error: error instanceof Error ? error.message : String(error) });
  app.exit(1);
});
