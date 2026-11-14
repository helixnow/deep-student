/**
 * `save_webview_settings` / `load_webview_settings`（src-tauri/src/commands.rs:7476-7545）。
 *
 * 文件位于 `FileManager::get_writable_app_data_dir()/webview_settings.json`；数据空间启用后
 * 该目录是活动槽（`ctx.storage.locations.activeDir`），未启用时是 `app.dataDir`。
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommandError } from '../host/kernel/api.ts';
import { formatIoError } from './shell/errors.ts';
import type { ShellPlatform } from './shell/tauri-config.ts';

export const WEBVIEW_SETTINGS_FILE = 'webview_settings.json';

export interface WebviewSettingsDeps {
  dataDir(): Promise<string>;
  platform: ShellPlatform;
}

const fileSystem = (message: string) => new CommandError({ error_type: 'FileSystem', message, details: null });
const validation = (message: string) => new CommandError({ error_type: 'Validation', message, details: null });

export async function saveWebviewSettings(
  settings: unknown,
  deps: WebviewSettingsDeps,
): Promise<{ success: true; path: string; size: number }> {
  let content: string;
  try {
    // serde_json::to_string_pretty：2 空格缩进、UTF-8 字节数计入 size。
    content = JSON.stringify(settings, null, 2);
  } catch (error) {
    throw validation(`序列化 WebView 设置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const path = join(await deps.dataDir(), WEBVIEW_SETTINGS_FILE);
  try {
    await writeFile(path, content, 'utf8');
  } catch (error) {
    throw fileSystem(`写入 WebView 设置文件失败: ${formatIoError(error, deps.platform)}`);
  }
  return { success: true, path, size: Buffer.byteLength(content, 'utf8') };
}

export async function loadWebviewSettings(
  deps: WebviewSettingsDeps,
): Promise<{ exists: false; settings: null } | { exists: true; settings: unknown }> {
  const path = join(await deps.dataDir(), WEBVIEW_SETTINGS_FILE);
  // Rust `Path::exists()`：metadata 失败（包括权限错误）一律按不存在处理。
  try {
    await stat(path);
  } catch {
    return { exists: false, settings: null };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw fileSystem(`读取 WebView 设置文件失败: ${formatIoError(error, deps.platform)}`);
  }
  let content: string;
  try {
    // fs::read_to_string rejects invalid UTF-8 (io::Error::INVALID_UTF8) and keeps a BOM.
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fileSystem('读取 WebView 设置文件失败: stream did not contain valid UTF-8');
  }
  try {
    return { exists: true, settings: JSON.parse(content) as unknown };
  } catch (error) {
    throw validation(`解析 WebView 设置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
