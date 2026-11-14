/** Native window sizing regression: no Host, no page, no process relaunch or exit hooks. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { AgentNavigationGuard } from '../../shell/browser-agent-guard.ts';
import { BrowserContentSurface } from '../../shell/browser-surface.ts';
import type { ShellPlatform } from '../../shell/tauri-config.ts';
import { decodeWindowConfig } from '../../shell/window-config.ts';
import { WindowManager } from '../../shell/windows.ts';

const userData = process.env.DS_ELECTRON_USER_DATA!;
app.setPath('userData', userData);
void app.whenReady().then(async () => {
  const manager = new WindowManager({
    platform: process.platform as ShellPlatform,
    debug: false,
    preloadPath: '',
    resolveUrl: () => 'about:blank',
    emit: () => undefined,
    hasJsListener: () => false,
    lifecycle: () => undefined,
    webviewGone: () => undefined,
    log: () => undefined,
  });
  const framed = manager.create({ ...decodeWindowConfig({ width: 600, height: 400, minWidth: 500, minHeight: 300 }), label: 'framed', visible: false }).browserWindow;
  const initial = framed.getContentSize();
  const outer = framed.getSize();
  framed.setContentSize(100, 100);
  const clamped = framed.getContentSize();
  const overlayWindow = manager.create({ ...decodeWindowConfig({ width: 600, height: 400, titleBarStyle: 'Overlay' }), label: 'overlay', visible: false }).browserWindow;
  const overlay = { content: overlayWindow.getContentSize(), outer: overlayWindow.getSize() };

  const surface = new BrowserContentSurface({
    platform: 'linux',
    preloadPath: '',
    getMainWindow: () => null,
    registerWebview: () => undefined,
    unregisterWebview: () => undefined,
    appWindowExists: () => false,
    agentGuard: new AgentNavigationGuard({ lookup: async () => [] }),
    log: () => undefined,
  });
  await surface.createContentWindow({
    url: 'about:blank',
    title: 'detached-content-size',
    width: 640,
    height: 480,
    focused: false,
    profileDir: join(userData, 'browser-profile'),
    initializationScript: '',
  });
  const detached = BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'detached-content-size');
  writeFileSync(process.env.CONTENT_SIZE_REPORT!, JSON.stringify({ initial, outer, clamped, overlay, detached: detached?.getContentSize() ?? null }));
  await surface.destroyContentWindow();
  framed.destroy();
  overlayWindow.destroy();
  app.exit(0);
}).catch((error: unknown) => {
  writeFileSync(process.env.CONTENT_SIZE_REPORT!, JSON.stringify({ error: String(error) }));
  app.exit(1);
});
