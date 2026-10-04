/**
 * systemFileOpener — 「用系统/其他应用打开文件」「在文件夹中显示」的跨平台唯一入口。
 *
 * 为什么不能直接用 @tauri-apps/plugin-opener：
 * - Android：opener 2.5.x 的 `openPath` 把裸字符串发给 Kotlin（期望 `{url}`）→
 *   必然失败；`revealItemInDir` 在 Android/iOS 直接返回 UnsupportedPlatform。
 * - 移动端没有"文件管理器中定位"的概念——"在文件夹中显示"在 Android 上的
 *   合理语义是"用其他应用打开这个文件"。
 *
 * 平台行为：
 * - 桌面：openPath / revealItemInDir（opener 插件，行为不变）。
 * - Android：后端 `open_file_externally`（复制到 cache/shared → FileProvider →
 *   ACTION_VIEW；无应用可打开时自动回退系统分享面板；mode=share 直接分享）。
 * - iOS：暂无原生实现，抛出 {@link EXTERNAL_OPEN_UNSUPPORTED} 错误。
 *
 * 业务代码禁止再直接 import opener 的 openPath / revealItemInDir 处理本地文件。
 */

import { invoke } from '@tauri-apps/api/core';
import { isAndroid, isMobilePlatform } from '@/utils/platform';

export const EXTERNAL_OPEN_UNSUPPORTED = 'EXTERNAL_OPEN_UNSUPPORTED_ON_THIS_PLATFORM';

/** Android 实际执行的动作：直接打开 / 回退为分享面板 */
export type ExternalOpenAction = 'view' | 'share' | 'reveal' | 'open';

/** 是否能"在文件夹中显示"（系统文件管理器定位）——仅桌面端 */
export function canRevealInFolder(): boolean {
  return !isMobilePlatform();
}

/** 是否能把文件交给系统/其他应用（桌面 opener、Android Intent；iOS 暂不支持） */
export function canOpenFilesExternally(): boolean {
  return !isMobilePlatform() || isAndroid();
}

async function androidOpen(path: string, mode: 'view' | 'share'): Promise<ExternalOpenAction> {
  const action = await invoke<string>('open_file_externally', { path, mode });
  return action === 'share' ? 'share' : 'view';
}

/** 用系统默认应用打开文件（Android：选择其他应用打开） */
export async function openFileExternally(path: string): Promise<ExternalOpenAction> {
  if (isAndroid()) return androidOpen(path, 'view');
  if (isMobilePlatform()) throw new Error(EXTERNAL_OPEN_UNSUPPORTED);
  const { openPath } = await import('@tauri-apps/plugin-opener');
  await openPath(path);
  return 'open';
}

/**
 * 桌面：在文件管理器中定位文件；Android：用其他应用打开该文件
 * （移动端唯一有意义的等价动作）。仅用于**文件**，目录请先用 {@link canRevealInFolder} 判定。
 */
export async function revealFileOrOpen(path: string): Promise<ExternalOpenAction> {
  if (isAndroid()) return androidOpen(path, 'view');
  if (isMobilePlatform()) throw new Error(EXTERNAL_OPEN_UNSUPPORTED);
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
  return 'reveal';
}

/** Android：系统分享面板；桌面：在文件管理器中定位（由用户自行发送） */
export async function shareFileExternally(path: string): Promise<ExternalOpenAction> {
  if (isAndroid()) return androidOpen(path, 'share');
  if (isMobilePlatform()) throw new Error(EXTERNAL_OPEN_UNSUPPORTED);
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
  return 'reveal';
}
