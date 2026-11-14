import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

app.setPath('userData', process.env.DS_ELECTRON_USER_DATA!);
void app.whenReady().then(async () => {
  // Optional baseline module allows a red/green comparison without changing production files.
  const { createAppLifecycle } = await import(process.env.SNAPSHOT_LIFECYCLE ?? '../../app-lifecycle.ts');
  const events: string[] = [];
  let payload: string | null = null;
  const report = () => writeFileSync(process.env.SNAPSHOT_REPORT!, JSON.stringify({ events, payload }));
  const lifecycle = createAppLifecycle({
    app, powerMonitor, platform: process.platform as 'darwin' | 'linux' | 'win32',
    invokeHost: async () => ({ automation: false, superAgent: false, quickAssistant: false, notificationsDisabled: true }),
    shutdownHost: async () => { events.push('shutdown'); report(); },
    killHost: () => { events.push('kill'); report(); },
    allWindows: () => BrowserWindow.getAllWindows(),
    log: (line: string) => { events.push(line); report(); },
  });
  lifecycle.install();
  ipcMain.handle('save_setting', async (_event, args) => {
    events.push('save-start');
    // A real IPC reply arriving asynchronously must precede shutdown.
    await new Promise((resolve) => setTimeout(resolve, 100));
    payload = args.value;
    events.push('save-done');
    report();
  });
  ipcMain.on('snapshot-ready', () => {
    events.push('user-quit');
    app.quit();
  });
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  lifecycle.windowCreated({ label: 'main', browserWindow: win, destroying: false });
  await win.loadURL('data:text/html,<html><body>snapshot quit regression</body></html>');
  await win.webContents.executeJavaScript(readFileSync(process.env.SNAPSHOT_RENDERER!, 'utf8'));
}).catch((error) => { console.error(error); app.exit(1); });
