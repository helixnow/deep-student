/** Native constructor regression: no Host, user data, process relaunch or exit hooks. */
import { writeFileSync } from 'node:fs';
import { app } from 'electron';
import { decodeWindowConfig } from '../../shell/window-config.ts';
import { WindowManager } from '../../shell/windows.ts';

app.setPath('userData', process.env.DS_ELECTRON_USER_DATA!);
void app.whenReady().then(() => {
  const manager = new WindowManager({
    platform: 'linux',
    debug: false,
    preloadPath: '',
    resolveUrl: () => 'about:blank',
    emit: () => undefined,
    hasJsListener: () => false,
    lifecycle: () => undefined,
    webviewGone: () => undefined,
    log: () => undefined,
  });
  const create = (label: string, options: Record<string, unknown>) => manager.create({ ...decodeWindowConfig(options), label, visible: false });
  const disabled = create('disabled', { focusable: false });
  const defaulted = create('defaulted', {});
  writeFileSync(process.env.FOCUSABLE_REPORT!, JSON.stringify({
    disabled: disabled.browserWindow.isFocusable(),
    defaulted: defaulted.browserWindow.isFocusable(),
  }));
  app.exit(0);
}).catch((error: unknown) => {
  writeFileSync(process.env.FOCUSABLE_REPORT!, JSON.stringify({ error: String(error) }));
  app.exit(1);
});
