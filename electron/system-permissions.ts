import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { formatIoError } from './shell/errors.ts';

type Target = 'notifications' | 'microphone';
type Platform = 'macos-legacy' | 'macos-modern' | 'windows';
export function parsePermissionTarget(value: unknown): Target {
  if (value === 'notifications' || value === 'microphone') return value;
  throw new TypeError('unknown permission target');
}
export function macosSettingsPlatform(major: number | null): Platform { return major !== null && major < 13 ? 'macos-legacy' : 'macos-modern'; }
export function parseMacosMajorVersion(raw: Uint8Array): number | null {
  if (!isUtf8(raw)) return null;
  const first = Buffer.from(raw).toString('utf8').trim().split('.')[0] ?? '';
  if (!/^\+?\d+$/.test(first)) return null;
  const value = Number(first);
  return value <= 0xffff_ffff ? value : null;
}
export function settingsUri(platform: Platform, target: Target): string {
  if (platform === 'windows') return target === 'notifications' ? 'ms-settings:notifications' : 'ms-settings:privacy-microphone';
  if (platform === 'macos-legacy') return target === 'notifications' ? 'x-apple.systempreferences:com.apple.preference.notifications' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  return target === 'notifications' ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension' : 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone';
}
export async function openSystemPermissionSettings(permission: Target, platform: string, warn: (message: string) => void): Promise<void> {
  const io = (e: unknown) => formatIoError(e, platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux');
  if (platform === 'darwin') {
    let major: number | null = null;
    try { major = parseMacosMajorVersion((await promisify(execFile)('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'buffer' })).stdout); }
    catch (e) { warn(`[permissions] sw_vers: ${e instanceof Error ? e.message : String(e)}`); }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/open', [settingsUri(macosSettingsPlatform(major), permission)], { stdio: 'inherit' });
      child.once('error', (e) => reject(`Failed to launch macOS System Settings: ${io(e)}`));
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(`macOS System Settings launcher exited with status ${code === null ? `signal: ${signal}` : `exit status: ${code}`}`));
    });
  } else if (platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [settingsUri('windows', permission)], { stdio: 'inherit' });
      child.once('spawn', resolve);
      child.once('error', (e) => reject(`Failed to launch Windows Settings: ${io(e)}`));
    });
  } else throw 'This desktop environment does not provide a portable permission-settings shortcut';
}
