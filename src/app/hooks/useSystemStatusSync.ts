import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import type { StartupComponentIssue } from '@/stores/systemStatusStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ★ debugLog 别名：与 App.tsx 相同，console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * App 壳层：启动时把后端维护模式 / 组件健康状态同步进 systemStatusStore，
 * 并在网络上下线时弹全局通知。从 App.tsx 原样搬出。
 */
export function useSystemStatusSync(t: TFunction) {
  // 🆕 任务3：应用启动时同步后端维护模式状态到前端 store
  useEffect(() => {
    const syncMaintenanceStatus = async () => {
      try {
        const status = await invoke<{
          is_in_maintenance_mode: boolean;
          blocked_components?: string[];
          component_health?: { components?: StartupComponentIssue[] } | null;
          component_issues?: StartupComponentIssue[];
        }>('data_governance_get_maintenance_status');
        const componentHealth =
          status.component_health?.components
          ?? status.component_issues
          ?? [];
        useSystemStatusStore.getState().setComponentHealth(componentHealth);
        if (status.is_in_maintenance_mode) {
          useSystemStatusStore.getState().requireMaintenanceRestart(
            status.blocked_components?.length
              ? t('common:maintenance.recovery_required')
              : t('common:maintenance.banner_description')
          );
        } else if (componentHealth.some((entry) => entry.status !== 'healthy')) {
          const affected = componentHealth
            .filter((entry) => entry.status !== 'healthy')
            .map((entry) => entry.component)
            .join(', ');
          useSystemStatusStore.getState().showMigrationStatus({
            level: componentHealth.some((entry) => entry.status === 'blocked') ? 'error' : 'warning',
            message: t('common:maintenance.partial_degradation_title'),
            details: t('common:maintenance.partial_degradation_description', { components: affected }),
          });
        }
      } catch (err) {
        // 命令可能不存在（旧版后端），静默忽略
        console.warn('[App] 查询后端维护模式状态失败:', err);
      }
    };
    syncMaintenanceStatus();
  }, [t]);

  // 🌐 全局网络状态监测
  const { isOnline } = useNetworkStatus();
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    // 跳过首次渲染
    if (wasOnline === isOnline) return;
    if (!isOnline) {
      showGlobalNotification('warning', t('common:network.offline_message'), t('common:network.offline_title'));
    } else {
      showGlobalNotification('info', t('common:network.online_message'), t('common:network.online_title'));
    }
  }, [isOnline, t]);
}
