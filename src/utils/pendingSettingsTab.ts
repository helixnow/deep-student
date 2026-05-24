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
    __dsPendingSettingsRoute?: PendingSettingsRoute;
  }
}

let pendingTabTimer: ReturnType<typeof setTimeout> | null = null;

export interface PendingSettingsRoute {
  tab: string;
  dataGovernanceTab?: string;
}

const armPendingRouteExpiry = (): void => {
  if (pendingTabTimer) clearTimeout(pendingTabTimer);

  pendingTabTimer = setTimeout(() => {
    delete window.__dsPendingSettingsTab;
    delete window.__dsPendingSettingsRoute;
    pendingTabTimer = null;
  }, 10000);
  (pendingTabTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
};

export function setPendingSettingsTab(tab: string): void {
  if (typeof tab !== 'string') return;
  const trimmed = tab.trim();
  if (!trimmed) return;

  window.__dsPendingSettingsTab = trimmed;
  window.__dsPendingSettingsRoute = { tab: trimmed };

  // Auto-expire after 10 seconds
  armPendingRouteExpiry();
}

export function setPendingSettingsRoute(route: PendingSettingsRoute): void {
  if (!route || typeof route.tab !== 'string') return;
  const tab = route.tab.trim();
  if (!tab) return;

  const dataGovernanceTab = typeof route.dataGovernanceTab === 'string'
    ? route.dataGovernanceTab.trim()
    : '';

  window.__dsPendingSettingsTab = tab;
  window.__dsPendingSettingsRoute = dataGovernanceTab
    ? { tab, dataGovernanceTab }
    : { tab };

  armPendingRouteExpiry();
}

export function consumePendingSettingsRoute(): PendingSettingsRoute | null {
  const route = window.__dsPendingSettingsRoute;
  const tab = route?.tab ?? window.__dsPendingSettingsTab;
  delete window.__dsPendingSettingsTab;
  delete window.__dsPendingSettingsRoute;

  // Clear the expiry timer since the value has been consumed
  if (pendingTabTimer) {
    clearTimeout(pendingTabTimer);
    pendingTabTimer = null;
  }

  if (typeof tab !== 'string' || !tab.trim()) return null;

  const dataGovernanceTab = typeof route?.dataGovernanceTab === 'string'
    ? route.dataGovernanceTab.trim()
    : '';

  return dataGovernanceTab
    ? { tab: tab.trim(), dataGovernanceTab }
    : { tab: tab.trim() };
}

export function consumePendingSettingsTab(): string | null {
  return consumePendingSettingsRoute()?.tab ?? null;
}

export function openArchivedSessionsSettings(): void {
  const route: PendingSettingsRoute = {
    tab: 'data-governance',
    dataGovernanceTab: 'archive',
  };

  setPendingSettingsRoute(route);
  window.dispatchEvent(new CustomEvent('navigate-to-tab', {
    detail: { tabName: 'settings' },
  }));
  window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', {
    detail: route,
  }));
}
