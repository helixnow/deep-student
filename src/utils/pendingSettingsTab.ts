/**
 * Settings 内部 Tab 的“延迟导航”缓冲区。
 *
 * 背景：
 * - App 视图切换到 Settings 之后，Settings 组件才会挂载并开始监听 `SETTINGS_NAVIGATE_TAB` 事件。
 * - 若在 Settings 挂载前发出事件，会产生竞态导致“跳转丢失”。
 *
 * 方案：
 * - 写入一个短生命周期的 window 变量作为缓冲
 * - Settings 挂载时消费该值并跳转
 */
declare global {
  interface Window {
    __dsPendingSettingsTab?: string;
  }
}

let pendingTabTimer: ReturnType<typeof setTimeout> | null = null;

export function setPendingSettingsTab(tab: string): void {
  if (typeof tab !== 'string') return;
  const trimmed = tab.trim();
  if (!trimmed) return;

  // Clear previous timer
  if (pendingTabTimer) clearTimeout(pendingTabTimer);

  window.__dsPendingSettingsTab = trimmed;

  // Auto-expire after 10 seconds
  pendingTabTimer = setTimeout(() => {
    delete window.__dsPendingSettingsTab;
    pendingTabTimer = null;
  }, 10000);
}

export function consumePendingSettingsTab(): string | null {
  const tab = window.__dsPendingSettingsTab;
  delete window.__dsPendingSettingsTab;

  // Clear the expiry timer since the value has been consumed
  if (pendingTabTimer) {
    clearTimeout(pendingTabTimer);
    pendingTabTimer = null;
  }

  return typeof tab === 'string' && tab.trim() ? tab.trim() : null;
}

