/**
 * 测试入口：由真实 `electron/main.ts` 启动窗口、协议与安全策略，只把安全策略的 openExternal 出口与
 * process restart/exit hooks 换成记录；另记录窗口创建与主框架导航，供 web-security-host.test.ts 断言。
 */
import { appendFileSync } from 'node:fs';
import { app } from 'electron';
import { start } from '../../main.ts';

const eventsPath = process.env.SECURITY_EVENTS as string;
const record = (entry: Record<string, unknown>) => appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`);

app.on('browser-window-created', () => record({ kind: 'window-created' }));
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-navigate', (_navigation, url) => record({ kind: 'did-navigate', url }));
});

void app.whenReady().then(() => start({
  processHooks: {
    restart: () => record({ kind: 'restart' }),
    exit: (code: number) => record({ kind: 'exit', code }),
  },
  openExternal: async (url: string) => record({ kind: 'open-external', url }),
})).catch((error: unknown) => {
  record({ kind: 'fatal', error: error instanceof Error ? error.message : String(error) });
  app.exit(1);
});
