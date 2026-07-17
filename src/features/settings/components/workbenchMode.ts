/**
 * workbenchMode — 学习桌面（Workbench）总开关的轻量读写助手
 *
 * 供设置页以外的轻量入口（如 legacy 侧边栏快捷开关）复用同一事件契约
 * （与 WorkbenchSettingsSection 总开关一致，该文件不改动）：
 *
 * - 读：get_setting('desktop.workbenchMode')
 * - 写：save_setting →（关闭时联动 browser_close）→ workbenchBus.setEnabled(v) →
 *   CustomEvent 'workbench:mode-changed' { enabled }
 *
 * 刻意保持零 UI 依赖（仅 bus + invoke），避免把设置页组件链拖进侧边栏 bundle。
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';

export const WORKBENCH_MODE_SETTING_KEY = 'desktop.workbenchMode';

export async function readWorkbenchModeEnabled(): Promise<boolean> {
  try {
    const raw = await tauriInvoke<string | null>('get_setting', {
      key: WORKBENCH_MODE_SETTING_KEY,
    });
    return String(raw ?? '') === 'true';
  } catch {
    return false;
  }
}

async function closeBrowserForDisabledGate(): Promise<void> {
  try {
    await tauriInvoke('browser_close', {});
  } catch (error) {
    // 浏览器可能不可用或已关闭；持久化的闸值仍是准绳
    console.warn('[workbenchMode] browser gate cleanup failed:', getErrorMessage(error));
  }
}

/**
 * 持久化总开关并按契约广播；失败时通知并返回 false（调用方负责回滚乐观态）。
 */
export async function persistWorkbenchModeEnabled(enabled: boolean): Promise<boolean> {
  try {
    await tauriInvoke('save_setting', {
      key: WORKBENCH_MODE_SETTING_KEY,
      value: String(enabled),
    });
  } catch (error) {
    showGlobalNotification('error', getErrorMessage(error));
    return false;
  }
  if (!enabled) await closeBrowserForDisabledGate();
  workbenchBus.setEnabled(enabled);
  try {
    window.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled } }));
  } catch {
    // noop
  }
  return true;
}
