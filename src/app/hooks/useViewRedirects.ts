import { useEffect } from 'react';
import type { CurrentView } from '@/types/navigation';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import {
  isWorkbenchHostEnabled,
  launchWorkbenchApp,
  subscribeWorkbenchHost,
} from '@/shared/workbenchHost';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { useIsUILabEnabled } from '@/utils/uiLabToggle';
import type { SetCurrentView } from '../navigation/viewRouting';

const RECOVERY_RECEIPT_ROUTE = {
  tab: 'data-governance' as const,
  dataGovernanceTab: 'recovery',
};

/**
 * App 壳层：基于 currentView 的启动 / 守卫跳转——待处理的恢复回执打开 设置 → 数据治理 → 恢复，
 * UI Lab 关闭时把 ui-lab 视图退回 chat-v2。从 App.tsx 原样搬出；返回 uiLabEnabled。
 */
export function useViewRedirects(
  currentView: CurrentView,
  setCurrentView: SetCurrentView,
  workbenchActive = false,
) {
  useEffect(() => {
    let shouldOpenRecoveryReceipt = false;
    try {
      shouldOpenRecoveryReceipt =
        localStorage.getItem('deep-student.pending-recovery-receipt') === '1';
      if (shouldOpenRecoveryReceipt) {
        localStorage.removeItem('deep-student.pending-recovery-receipt');
      }
    } catch {
      return;
    }

    if (!shouldOpenRecoveryReceipt) return;
    setPendingSettingsRoute(RECOVERY_RECEIPT_ROUTE);

    if (!workbenchActive) {
      setCurrentView('settings');
      return;
    }

    const openRecoveryInWorkbench = () => {
      launchWorkbenchApp({ typeId: 'settings', reason: 'api' });
      dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, RECOVERY_RECEIPT_ROUTE);
    };

    if (isWorkbenchHostEnabled()) {
      openRecoveryInWorkbench();
      return;
    }

    let delivered = false;
    const unsubscribe = subscribeWorkbenchHost(() => {
      if (delivered || !isWorkbenchHostEnabled()) return;
      delivered = true;
      unsubscribe();
      openRecoveryInWorkbench();
    });
    return () => {
      unsubscribe();
    };
  }, [setCurrentView, workbenchActive]);

  const uiLabEnabled = useIsUILabEnabled();

  useEffect(() => {
    if (currentView === 'ui-lab' && !uiLabEnabled) {
      setCurrentView('chat-v2');
    }
  }, [currentView, uiLabEnabled, setCurrentView]);

  return { uiLabEnabled };
}
