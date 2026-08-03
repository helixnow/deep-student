/**
 * DevTools 统一开关（应用自有命令封装）。
 *
 * 通过应用自有命令 `toggle_devtools` 调用 Tauri 的公开 Rust API
 * （WebviewWindow::open_devtools / close_devtools / is_devtools_open），
 * 而不是直接调用内部命令 `plugin:webview|internal_toggle_devtools`——
 * internal 前缀命令无兼容性承诺，升级 Tauri 可能改名/改行为。
 *
 * 命令仅在 debug 构建或启用 `devtools` feature 时注册（见
 * src-tauri/src/debug_commands.rs 的 #[cfg] 门控）：
 * - 命令存在   -> 返回切换后的打开状态（true = 已打开）
 * - 命令不存在 -> invoke 抛 "command not found"，返回 null，调用方降级提示
 *
 * 统一入口：App.tsx（Cmd+Alt+I/Ctrl+Shift+I）、命令面板 F12、
 * 调试面板 DevTools 按钮、DevMobileRecoveryFab 均使用本函数。
 */
import { invoke } from '@tauri-apps/api/core';

export async function toggleDevtools(): Promise<boolean | null> {
  try {
    return await invoke<boolean>('toggle_devtools');
  } catch (error) {
    console.warn('[devtools] toggle failed（当前构建未启用 devtools？）:', error);
    return null;
  }
}
