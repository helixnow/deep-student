import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ArrowsLeftRight, CircleNotch, Warning } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { DsButton } from '@/components/ui/DsButton';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DataGovernanceApi, runSyncWithProgress } from '@/api/dataGovernance';
import * as cloudApi from '@/utils/cloudStorageApi';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  localizeCloudStorageError,
  notifyErrorDeduped,
} from './data-governance/localizeCloudError';
import { cn } from '@/lib/utils';

function isValidSafeCloudConfigJson(raw: string | null | undefined): boolean {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const provider = (parsed as { provider?: unknown }).provider;
    return provider === 'webdav' || provider === 's3' || provider === 'ftp';
  } catch {
    return false;
  }
}

export async function probeStoredCloudConfigured(options?: {
  allowBackendResolve?: boolean;
}): Promise<boolean> {
  try {
    const cached = cloudApi.loadStoredCloudStorageConfigSafe();
    if (cached && typeof cached === 'object') return true;
  } catch {
    // Ignore storage read failure
  }
  try {
    const rawSetting = await invoke<string | null>('get_setting', {
      key: 'cloud_storage.config.safe_v1',
    });
    if (isValidSafeCloudConfigJson(rawSetting)) return true;
  } catch {
    // Ignore when Tauri IPC is unavailable in isolated unit tests
  }
  if (options?.allowBackendResolve !== false) {
    try {
      const resolved = await cloudApi.resolveCloudStorageConfig();
      if (resolved && typeof resolved === 'object') return true;
    } catch {
      // Fall back to safe local cache / settings probe
    }
  }
  return false;
}

export interface QuickSyncNowButtonProps {
  /** Optional explicit cloudConfigured flag from parent state */
  cloudConfiguredOverride?: boolean;
  /** Optional custom sync trigger (e.g. DataGovernanceDashboard's runCloudSync) */
  onSyncTrigger?: () => void | boolean | Promise<void | boolean>;
  /** Custom testid for unambiguous test targeting */
  dataTestId?: string;
  className?: string;
}

export const QuickSyncNowButton: React.FC<QuickSyncNowButtonProps> = ({
  cloudConfiguredOverride,
  onSyncTrigger,
  dataTestId = 'settings-quick-sync-now-btn',
  className,
}) => {
  const { t, i18n } = useTranslation(['sync', 'data', 'common']);
  const isSyncing = useGlobalSyncStore((state) => state.isSyncing);
  const unresolvedConflictCount = useGlobalSyncStore((state) => state.unresolvedConflictCount ?? 0);
  const { enterMaintenanceMode, exitMaintenanceMode } = useSystemStatusStore(
    useShallow((state) => ({
      enterMaintenanceMode: state.enterMaintenanceMode,
      exitMaintenanceMode: state.exitMaintenanceMode,
    })),
  );

  const [storedConfigured, setStoredConfigured] = useState<boolean>(() => {
    try {
      return Boolean(cloudApi.loadStoredCloudStorageConfigSafe());
    } catch {
      return false;
    }
  });
  const [localRunning, setLocalRunning] = useState(false);
  const probeSeqRef = useRef(0);

  const refreshConfigured = useCallback(async () => {
    const seq = ++probeSeqRef.current;
    const found = await probeStoredCloudConfigured();
    if (seq === probeSeqRef.current) {
      setStoredConfigured(found);
    }
  }, []);

  const refreshConflictCount = useCallback(() => {
    const refreshFn = useGlobalSyncStore?.getState?.()?.refreshUnresolvedConflictCount;
    if (typeof refreshFn === 'function') {
      void refreshFn();
    }
  }, []);

  useEffect(() => {
    refreshConflictCount();
  }, [refreshConflictCount]);

  useEffect(() => {
    if (cloudConfiguredOverride !== undefined) return;
    void refreshConfigured();
  }, [cloudConfiguredOverride, refreshConfigured]);

  useEventRegistry(
    [
      {
        target: 'window',
        type: 'data-governance:local-change',
        listener: () => { refreshConflictCount(); },
      },
      ...(cloudConfiguredOverride === undefined
        ? [
            {
              target: 'window' as const,
              type: 'data-governance:cloud-config-changed',
              listener: () => { void refreshConfigured(); },
            },
            {
              target: 'window' as const,
              type: 'storage',
              listener: () => { void refreshConfigured(); },
            },
            {
              target: 'window' as const,
              type: 'focus',
              listener: () => {
                void refreshConfigured();
                refreshConflictCount();
              },
            },
          ]
        : []),
    ],
    [cloudConfiguredOverride, refreshConfigured, refreshConflictCount],
  );

  const handleOpenConflicts = useCallback(() => {
    useSettingsShellStore.getState().applySettingsRoute({
      tab: 'data-governance',
      dataGovernanceTab: 'sync',
    });
    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, {
      tab: 'data-governance',
      dataGovernanceTab: 'sync',
    });
    window.dispatchEvent(new CustomEvent('data-governance:jump-to-conflicts'));
  }, []);

  const effectiveConfigured =
    cloudConfiguredOverride !== undefined
      ? Boolean(cloudConfiguredOverride || storedConfigured)
      : storedConfigured;

  const handleQuickSync = useCallback(async () => {
    if (isSyncing || localRunning) return;
    if (onSyncTrigger) {
      setLocalRunning(true);
      try {
        await onSyncTrigger();
      } finally {
        setLocalRunning(false);
      }
      return;
    }

    setLocalRunning(true);
    try {
      const cloudConfig = await cloudApi.loadStoredCloudStorageConfigWithCredentials();
      if (!cloudConfig) {
        setStoredConfigured(false);
        showGlobalNotification('warning', t('data:governance.cloud_sync_not_configured'));
        return;
      }
      setStoredConfigured(true);

      if (!useGlobalSyncStore.getState().beginSync('settings-quick-sync')) {
        showGlobalNotification('warning', t('data:governance.sync_already_running'));
        return;
      }

      enterMaintenanceMode(t('data:governance.maintenance_sync'));
      try {
        const gap = await DataGovernanceApi.detectPruneGap(cloudConfig);
        if (gap.has_gap) {
          throw new Error(
            gap.gap_details ??
              t('data:governance.sync_prune_gap_warning', {
                since: gap.since_version,
                minAvail: gap.min_available_version ?? 0,
              }),
          );
        }

        const result = await runSyncWithProgress('bidirectional', cloudConfig, 'keep_latest');
        let quarantineCount = 0;
        try {
          const q = await DataGovernanceApi.listQuarantine(500, 0);
          quarantineCount = Array.isArray(q) ? q.length : 0;
        } catch {
          // Ignore optional quarantine query error
        }
        let liveConflictCount = 0;
        try {
          const refreshFn = useGlobalSyncStore?.getState?.()?.refreshUnresolvedConflictCount;
          if (typeof refreshFn === 'function') {
            liveConflictCount = await refreshFn();
          }
        } catch {
          // Ignore optional conflict query error
        }
        const effectiveConflictCount = Math.max(liveConflictCount, result.conflicts_detected ?? 0);
        if (effectiveConflictCount > liveConflictCount) {
          useGlobalSyncStore?.getState?.()?.setUnresolvedConflictCount?.(effectiveConflictCount);
        }

        window.dispatchEvent(new CustomEvent('data-governance:local-change'));

        if (
          result.success &&
          !result.error_message &&
          (result.skipped_changes ?? 0) === 0 &&
          quarantineCount === 0
        ) {
          if (effectiveConflictCount > 0) {
            showGlobalNotification(
              'warning',
              t('data:governance.sync_completed_with_conflicts', {
                count: effectiveConflictCount,
              }),
            );
          } else {
            showGlobalNotification('success', t('data:sync_settings.sync_success'));
          }
          return;
        }

        const message =
          result.error_message ??
          (quarantineCount > 0
            ? t('data:governance.sync_partial_with_quarantine', { count: quarantineCount })
            : t('data:governance.sync_partial_with_skipped', {
                skipped: result.skipped_changes ?? 0,
              }));

        if (result.success) {
          showGlobalNotification(
            'warning',
            localizeCloudStorageError(message, t, i18n?.language),
          );
        } else {
          notifyErrorDeduped(
            'error',
            localizeCloudStorageError(
              `${t('data:sync_settings.sync_failed')}: ${message}`,
              t,
              i18n?.language,
            ),
          );
        }
      } finally {
        useGlobalSyncStore.getState().endSync();
        exitMaintenanceMode();
      }
    } catch (error: unknown) {
      const raw = getErrorMessage(error);
      if (/同步已取消|sync\s+cancel(?:led|ed)/i.test(raw)) {
        showGlobalNotification('info', t('data:governance.sync_cancelled'));
      } else {
        notifyErrorDeduped(
          'error',
          `${t('data:sync_settings.sync_failed')}: ${localizeCloudStorageError(
            error,
            t,
            i18n?.language,
          )}`,
        );
      }
    } finally {
      setLocalRunning(false);
    }
  }, [enterMaintenanceMode, exitMaintenanceMode, i18n?.language, isSyncing, localRunning, onSyncTrigger, t]);

  if (!effectiveConfigured && unresolvedConflictCount === 0) {
    return null;
  }

  const busy = isSyncing || localRunning;

  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      {unresolvedConflictCount > 0 && (
        <DsButton
          type="button"
          variant="warning"
          size="sm"
          data-testid="quick-sync-conflict-badge"
          onClick={handleOpenConflicts}
          aria-label={t('data:governance.unresolved_conflicts_banner_title', {
            count: unresolvedConflictCount,
          })}
          className="shrink-0 rounded-xl border-warning/45 bg-warning/15 px-2.5 text-xs font-medium text-warning hover:bg-warning/25"
        >
          <Warning size={14} className="mr-1 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">
            {t('data:governance.unresolved_conflicts_badge', {
              count: unresolvedConflictCount,
            })}
          </span>
        </DsButton>
      )}
      {effectiveConfigured && (
        <DsButton
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          data-testid={dataTestId}
          onClick={() => {
            void handleQuickSync();
          }}
          className={cn(
            'shrink-0 rounded-xl border-primary/40 bg-primary/12 px-3 font-medium text-primary hover:bg-primary/20',
            className,
          )}
        >
          {busy ? (
            <CircleNotch size={14} className="mr-1.5 animate-spin shrink-0" />
          ) : (
            <ArrowsLeftRight size={14} className="mr-1.5 shrink-0" />
          )}
          <span>{t('sync:syncNow', { defaultValue: '立即同步' })}</span>
        </DsButton>
      )}
    </div>
  );
};

export default QuickSyncNowButton;
