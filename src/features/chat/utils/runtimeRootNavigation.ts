/**
 * Runtime root 拦截 → 授权设置跳转辅助
 *
 * 当本地文件/Shell 工具因为 runtime root 未授权、路径逃逸等原因被拦截时，
 * 前端可以直接把用户带到 Settings > MCP 工具 > 工具权限（运行时目录）区域，
 * 而不是让用户自己在设置里找入口。
 */

import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

/** 判断一条工具错误信息是否是 runtime root / 本地运行时授权类拦截。 */
export function isRuntimeRootBlockedError(error: string | undefined | null): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes('runtime root') ||
    normalized.includes('authorized roots') ||
    normalized.includes('escapes the selected') ||
    normalized.includes('escapes the artifacts root') ||
    normalized.includes('parent directory traversal') ||
    normalized.includes('path must be relative') ||
    normalized.includes('allow_network=true') ||
    normalized.includes('skill package roots')
  );
}

/** 打开 Settings > MCP 工具（工具权限 + 运行时目录管理所在 tab）。 */
export function openToolPermissionSettings(): void {
  setPendingSettingsRoute({ tab: 'mcp' });
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });
  dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'mcp' });
}
