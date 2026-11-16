import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appUserModelId, installAppUserModelId } from '../shell/app-user-model-id.ts';

const require = createRequire(import.meta.url);
const builder = require('../electron-builder.config.cjs') as { appId: string };
const root = join(import.meta.dirname, '../..');
const tauri = JSON.parse(readFileSync(join(root, 'resources/app/tauri.conf.json'), 'utf8')) as { identifier: string };

describe('Windows AppUserModelID (G16: reminders must show as Deep Student notifications)', () => {
  it('packaged Windows builds use the installer appId; the runtime identifier is the same value', () => {
    expect(tauri.identifier).toBe(builder.appId);
    expect(appUserModelId('win32', true, tauri.identifier, 'C:/x/Deep Student.exe')).toBe('com.deepstudent.app');
  });

  it('dev runs use the executable path (Electron guidance) and other platforms set nothing', () => {
    expect(appUserModelId('win32', false, tauri.identifier, 'C:/dev/electron.exe')).toBe('C:/dev/electron.exe');
    expect(appUserModelId('darwin', true, tauri.identifier, '/x')).toBeNull();
    expect(appUserModelId('linux', true, tauri.identifier, '/x')).toBeNull();
  });

  it('installs the id on the app object only on Windows', () => {
    const calls: string[] = [];
    const app = { isPackaged: true, setAppUserModelId: (id: string) => { calls.push(id); } };
    expect(installAppUserModelId(app, 'win32', tauri.identifier, 'x')).toBe('com.deepstudent.app');
    expect(installAppUserModelId(app, 'darwin', tauri.identifier, 'x')).toBeNull();
    expect(calls).toEqual(['com.deepstudent.app']);
  });

  it('main sets it at startup with the configured identifier, before the app is ready', () => {
    const main = readFileSync(join(root, 'electron/main.ts'), 'utf8');
    const call = main.indexOf('installAppUserModelId(app, platform, config.identifier, process.execPath)');
    expect(call).toBeGreaterThan(0);
    const ready = main.indexOf('whenReady');
    if (ready >= 0) expect(call).toBeLessThan(ready);
    expect(call).toBeLessThan(main.indexOf('const directEntry'));
  });
});
