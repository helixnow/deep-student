import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { createTestHost } from '../../host/kernel/testing.ts';
import { buildInfo } from '../build-info.ts';
import plugin from '../index.ts';

it('get_app_data_dir returns the resolved application data directory', async () => {
  const dataDir = '/tmp/dstu-f2-app-data';
  const host = await createTestHost({ plugins: [plugin], app: { platform: 'darwin', dataDir } });
  try {
    await expect(host.invoke('get_app_data_dir')).resolves.toBe(dataDir);
  } finally { await host.dispose(); }
});

it('desktop cfg branches retain original Android rejection values and no-op', async () => {
  const host = await createTestHost({ plugins: [plugin], app: { platform: 'linux' } });
  try {
    await expect(host.invoke('install_apk', { path: 'a.apk' })).rejects.toEqual({ error_type: 'Unknown', message: 'install_apk is only supported on Android', details: null });
    await expect(host.invoke('open_file_externally', { path: 'a.pdf' })).rejects.toEqual({ error_type: 'Validation', message: 'open_file_externally is only supported on Android', details: null });
    await expect(host.invoke('open_file_externally', { path: 'a.pdf', mode: 'reveal' })).rejects.toEqual({ error_type: 'Validation', message: '不支持的打开方式: reveal', details: null });
    await expect(host.invoke('set_android_immersive_mode', { enabled: true })).resolves.toBe(null);
    await expect(host.invoke('open_system_permission_settings', { permission: 'notifications' })).rejects.toBe('This desktop environment does not provide a portable permission-settings shortcut');
  } finally { await host.dispose(); }
});

it('Windows power remains unsupported; window appearance commands follow the non-macOS no-op branch', async () => {
  const host = await createTestHost({ plugins: [plugin], app: { platform: 'win32' } });
  try {
    await expect(host.invoke('set_sidebar_vibrancy', { enabled: true })).resolves.toBe(false);
    await expect(host.invoke('set_window_appearance', { dark: true })).resolves.toBeNull();
    await expect(host.invoke('sync_titlebar_sidebar_material', { enabled: true, width: 360 })).resolves.toBeNull();
    await expect(host.invoke('set_prevent_sleep', { enabled: true })).resolves.toBe(false);
    await expect(host.invoke('get_prevent_sleep')).resolves.toBe(false);
    await expect(host.invoke('updater_install_supported')).resolves.toBe(true);
  } finally { await host.dispose(); }
});

it('version uses build metadata while macOS vibrancy calls main with the calling window', async () => {
  const info = buildInfo(resolve(import.meta.dirname, '../..'), packageJson.version);
  const host = await createTestHost({ plugins: [plugin], app: { platform: 'darwin' }, shell: (op, args) => op === 'app.fullVersion' ? '0.11.0 (Build 14642, abcdef12)' : (args as { enabled: boolean }).enabled });
  try {
    // commands.rs:500-507 reads build constants, never an AppHandle/Shell response.
    await expect(host.invoke('get_app_version')).resolves.toBe(`${info.version} (Build ${info.buildNumber}, ${info.gitHash})`);
    expect(host.shellRequests).toEqual([]);
    await expect(host.invoke('set_sidebar_vibrancy', { enabled: false })).resolves.toBe(false);
    expect(host.shellRequests.at(-1)).toMatchObject({ op: 'window.setVibrancy', args: { enabled: false, __window: 'main' } });
  } finally { await host.dispose(); }
});

it('macOS window appearance and titlebar material are delegated to main with the calling window', async () => {
  const host = await createTestHost({ plugins: [plugin], app: { platform: 'darwin' }, shell: () => null });
  try {
    await expect(host.invoke('set_window_appearance', { dark: true })).resolves.toBeNull();
    expect(host.shellRequests.at(-1)).toMatchObject({ op: 'window.setAppearance', args: { dark: true, __window: 'main' } });
    await expect(host.invoke('sync_titlebar_sidebar_material', { enabled: true, width: 360 })).resolves.toBeNull();
    expect(host.shellRequests.at(-1)).toMatchObject({ op: 'window.syncTitlebarSidebarMaterial', args: { enabled: true, width: 360, __window: 'main' } });
  } finally { await host.dispose(); }
});
