import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('macOS titlebar overlay contract', () => {
  const config = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src-tauri/tauri.macos.conf.json'), 'utf-8'),
  );
  const mainWindow = config.app.windows[0];

  it('keeps native traffic lights while letting the webview own the titlebar surface', () => {
    expect(mainWindow.decorations).toBe(true);
    expect(mainWindow.titleBarStyle).toBe('Overlay');
    expect(mainWindow.hiddenTitle).toBe(true);
  });
});
