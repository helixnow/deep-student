import { useEffect } from 'react';
import type { CurrentView } from '@/types/navigation';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { useIsUILabEnabled } from '@/utils/uiLabToggle';
import type { SetCurrentView } from '../navigation/viewRouting';

/**
 * App 壳层：基于 currentView 的启动 / 守卫跳转——待处理的恢复回执打开 设置 → 数据治理 → 恢复，
 * UI Lab 关闭时把 ui-lab 视图退回 chat-v2。从 App.tsx 原样搬出；返回 uiLabEnabled。
 */
export function useViewRedirects(currentView: CurrentView, setCurrentView: SetCurrentView) {
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
    setPendingSettingsRoute({
      tab: 'data-governance',
      dataGovernanceTab: 'recovery',
    });
    setCurrentView('settings');
  }, [setCurrentView]);

  const uiLabEnabled = useIsUILabEnabled();

  useEffect(() => {
    if (currentView === 'ui-lab' && !uiLabEnabled) {
      setCurrentView('chat-v2');
    }
  }, [currentView, uiLabEnabled, setCurrentView]);

  return { uiLabEnabled };
}
