/**
 * 真实 Electron 下 browser-content 的页面完成与标题事件：生产 `forwardBrowserContentEvents` 装在一个窗口上，
 * 依次跑场景，把每个场景收到的事件以 `RESULT <json>` 打到 stdout。
 */
import { app, BrowserWindow } from 'electron';
import { forwardBrowserContentEvents } from '../../shell/browser-content-events.ts';

const base = process.env.EVENTS_ORIGIN!;
const refused = process.env.EVENTS_REFUSED!;

async function run(): Promise<unknown> {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const contents = window.webContents;
  const events: unknown[] = [];
  forwardBrowserContentEvents(contents, (event, payload) => events.push([event, payload]));
  const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
  const scenario = async (action: () => Promise<unknown>) => {
    events.length = 0;
    await action().catch(() => undefined);
    await settle();
    return [...events];
  };

  const results: Record<string, unknown> = {};
  results.titled = await scenario(() => contents.loadURL(`${base}/titled`));
  results.scriptTitle = await scenario(() => contents.executeJavaScript(`document.title = 'Changed by script'; 0`));
  results.spa = await scenario(() => contents.executeJavaScript(`history.pushState({}, '', '/spa-route'); document.title = 'SPA route'; 0`));
  results.untitled = await scenario(() => contents.loadURL(`${base}/untitled`));
  results.linkClick = await scenario(async () => {
    await contents.loadURL(`${base}/link`);
    events.length = 0;
    await contents.executeJavaScript(`document.getElementById('next').click(); 0`);
  });
  results.failed = await scenario(() => contents.loadURL(refused));
  results.afterFailure = await scenario(() => contents.loadURL(`${base}/titled`));
  return results;
}

void app.whenReady().then(run).then((results) => {
  process.stdout.write(`RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}, (error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
