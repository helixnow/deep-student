/**
 * 同步设置区域组件
 *
 * 提供数据同步相关的设置和冲突解决功能：
 * - 同步状态概览
 * - 同步进度显示
 * - 冲突检测和解决
 * - 同步历史记录
 */

import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  Warning,
  CheckCircle,
  Database,
  CircleNotch,
  ArrowCircleUp,
  ClockCounterClockwise,
  Lightning,
  Upload,
  Download,
  ArrowsLeftRight,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { addTypedEventListener } from '@/events';
import { AppSelect } from '@/components/ui/app-menu';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent } from '@/components/ui/shad/Card';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import { Progress } from '@/components/ui/shad/Progress';
import { SettingSection } from './SettingsCommon';
import { GroupTitle } from './settingsTabPrimitives';
import { DevicePairingSection } from './DevicePairingSection';
import { RecordConflictsPanel } from './data-governance/RecordConflictsPanel';
import { ConflictResolutionDialog, MergeStrategy } from '@/components/ConflictResolutionDialog';
import { useConflictResolution } from '@/hooks/useConflictResolution';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  localizeBackendErrorText,
  localizeCloudStorageError,
  notifyErrorDeduped,
} from './data-governance/localizeCloudError';
import {
  SyncPhase,
  formatSpeed,
  formatEta,
} from '@/types/dataGovernance';
import { Switch } from '@/components/ui/shad/Switch';
import {
  loadStoredCloudStorageConfigSafe,
  loadStoredCloudStorageConfigWithCredentials,
} from '@/utils/cloudStorageApi';
import { resolveLatestSyncTimestamp } from './data-governance/SyncTab';
import { probeStoredCloudConfigured } from './QuickSyncNowButton';
import {
  useGlobalSyncStore,
  useAutoSyncStore,
  ensureAutoSyncSchedulerStarted,
  type AutoSyncIntervalPreset,
  type AutoSyncOutcome,
} from '@/stores/syncStatusStore';
import {
  DataGovernanceApi,
  runSyncWithProgress,
} from '@/api/dataGovernance';

interface SyncSettingsSectionProps {
  embedded?: boolean;
}

export const SyncSettingsSection: React.FC<SyncSettingsSectionProps> = ({
  embedded = false,
}) => {
  const { t, i18n } = useTranslation(['data', 'common', 'sync']);

  // 本地化的同步阶段名称
  const localizedPhaseNames = useMemo<Record<SyncPhase, string>>(
    () => ({
      preparing: t('data:sync_settings.phases.preparing'),
      detecting_changes: t('data:sync_settings.phases.detecting_changes'),
      uploading: t('data:sync_settings.phases.uploading'),
      downloading: t('data:sync_settings.phases.downloading'),
      applying: t('data:sync_settings.phases.applying'),
      completed: t('data:sync_settings.phases.completed'),
      failed: t('data:sync_settings.phases.failed'),
    }),
    [t]
  );

  // 冲突解决状态
  const {
    isDetecting,
    isResolving,
    conflicts,
    syncStatus,
    error,
    lastResult,
    getSyncStatus,
    detectConflicts,
    detectConflictsMock,
    clearError,
  } = useConflictResolution();

  // UI 状态
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [conflictRefreshNonce, setConflictRefreshNonce] = useState(0);
  const [conflictFocusNonce, setConflictFocusNonce] = useState(0);
  const [cloudConfigured, setCloudConfigured] = useState<boolean>(() =>
    Boolean(loadStoredCloudStorageConfigSafe()),
  );

  const refreshCloudConfigured = useCallback(async () => {
    const found = await probeStoredCloudConfigured();
    setCloudConfigured(found);
  }, []);

  useEffect(() => {
    void refreshCloudConfigured();
    return addTypedEventListener('data-governance:cloud-config-changed', () => {
      void refreshCloudConfigured();
    });
  }, [refreshCloudConfigured]);

  // 同步进度 / 取消 / 正在同步 / 持久化未解决冲突数：全部来自全局 store（#447）。
  const syncProgress = useGlobalSyncStore((s) => s.progress);
  const cancelRequested = useGlobalSyncStore((s) => s.cancelRequested);
  const isSyncing = useGlobalSyncStore((s) => s.isSyncing);
  const unresolvedConflictCount = useGlobalSyncStore((s) => s.unresolvedConflictCount ?? 0);
  // 自动同步开关（默认关闭；调度与安全防线在 syncStatusStore 内实现）
  const autoSyncEnabled = useAutoSyncStore((s) => s.enabled);
  const setAutoSyncEnabled = useAutoSyncStore((s) => s.setEnabled);
  // [R11-autosync2] 定时档位与上次自动同步状态
  const autoSyncIntervalPreset = useAutoSyncStore((s) => s.intervalPreset);
  const setAutoSyncIntervalPreset = useAutoSyncStore((s) => s.setIntervalPreset);
  const autoSyncLastOutcome = useAutoSyncStore((s) => s.lastOutcome);
  const autoSyncLastRunAtMs = useAutoSyncStore((s) => s.lastRunAtMs);
  const autoSyncConsecutiveFailures = useAutoSyncStore(
    (s) => s.consecutiveFailures
  );
  useEffect(() => {
    // 兼容性双保险：主启动点已上移到 App.tsx（hydration 完成后启动），
    // 此处调用仍幂等，仅兜底 App 挂载链路之外的极端渲染场景
    ensureAutoSyncSchedulerStarted();
    const refreshCount = useGlobalSyncStore?.getState?.()?.refreshUnresolvedConflictCount;
    if (typeof refreshCount === 'function') {
      void refreshCount();
    }
  }, []);

  // 各结果的人话文案（静态映射以兼容类型化 i18n）
  const autoSyncOutcomeLabels = useMemo<Record<AutoSyncOutcome, string>>(
    () => ({
      success: t('sync:autoSync.outcome.success'),
      failure: t('sync:autoSync.outcome.failure'),
      skipped_unconfigured: t('sync:autoSync.outcome.skippedUnconfigured'),
      skipped_busy: t('sync:autoSync.outcome.skippedBusy'),
      skipped_lease_held: t('sync:autoSync.outcome.skippedLeaseHeld'),
    }),
    [t]
  );

  // 合并策略（与数据治理仪表盘 SyncTab 保持一致，不再硬编码 keep_latest）
  const [syncStrategy, setSyncStrategy] = useState<MergeStrategy>('keep_latest');

  // 是否使用 Mock 模式（开发测试用）
  const useMock = import.meta.env.DEV && import.meta.env.VITE_USE_MOCK_SYNC === 'true';

  useRefreshOnReturn(() => { void getSyncStatus().catch(console.error); }, !useMock);

  // 初始化加载同步状态
  useEffect(() => {
    if (!useMock) {
      void getSyncStatus().catch(console.error);
    }
  }, [getSyncStatus, useMock]);


  // 检测冲突
  const handleDetectConflicts = useCallback(async () => {
    try {
      if (useMock) {
        await detectConflictsMock();
      } else {
        await detectConflicts();
      }
      setConflictRefreshNonce((n) => n + 1);
      setShowConflictDialog(true);
    } catch (err: unknown) {
      notifyErrorDeduped(
        'error',
        `${t('data:sync_settings.detect_failed')}: ${localizeCloudStorageError(err, t, i18n?.language)}`
      );
    }
  }, [detectConflicts, detectConflictsMock, i18n?.language, t, useMock]);

  const handleJumpToInlineConflicts = useCallback(() => {
    setConflictFocusNonce((n) => n + 1);
    const el = document.getElementById('record-conflicts-panel');
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, []);

  // 关闭冲突对话框
  const handleCloseConflictDialog = useCallback(() => {
    setShowConflictDialog(false);
    setConflictRefreshNonce((n) => n + 1);
  }, []);

  // 请求取消当前同步（协作式：等待/退避立即中断，文件传输在下一检查点停止）
  const handleCancelSync = useCallback(async () => {
    await useGlobalSyncStore.getState().requestCancel();
  }, []);

  // 执行同步（带进度跟踪）
  const handleSync = useCallback(
    async (direction: 'upload' | 'download' | 'bidirectional'): Promise<boolean> => {
      const cloudConfig = await loadStoredCloudStorageConfigWithCredentials();
      if (!cloudConfig) {
        setCloudConfigured(false);
        showGlobalNotification(
          'warning',
          t('data:governance.cloud_sync_not_configured')
        );
        return false;
      }
      setCloudConfigured(true);

      // 全局占用：任何入口已有同步进行中则直接拒绝本次触发
      if (!useGlobalSyncStore.getState().beginSync('sync-settings')) {
        showGlobalNotification(
          'warning',
          t('data:governance.sync_already_running')
        );
        return false;
      }

      // beginSync 已把全局进度置为「准备中」并复位取消标记；后续进度由
      // 应用级监听写入，不在本组件注册（避免绑定到会被卸载的实例）
      try {
        if (direction !== 'upload') {
          const gap = await DataGovernanceApi.detectPruneGap(cloudConfig);
          if (gap.has_gap) {
            throw new Error(gap.gap_details ?? t('data:governance.sync_prune_gap_warning', {
              since: gap.since_version,
              minAvail: gap.min_available_version ?? 0,
            }));
          }
        }

        const result = await runSyncWithProgress(direction, cloudConfig, syncStrategy);

        let quarantineCount = 0;
        if (direction !== 'upload') {
          try {
            const q = await DataGovernanceApi.listQuarantine(500, 0);
            quarantineCount = Array.isArray(q) ? q.length : 0;
          } catch {
            // Quarantine query failure must not mask the sync outcome.
          }
        }

        let liveConflictCount = 0;
        try {
          const refreshFn = useGlobalSyncStore?.getState?.()?.refreshUnresolvedConflictCount;
          if (typeof refreshFn === 'function') {
            liveConflictCount = await refreshFn();
          }
        } catch {
          // Ignore optional conflict count query error
        }
        const effectiveConflictCount = Math.max(liveConflictCount, result.conflicts_detected ?? 0);
        if (effectiveConflictCount > liveConflictCount) {
          useGlobalSyncStore?.getState?.()?.setUnresolvedConflictCount?.(effectiveConflictCount);
        }
        setConflictRefreshNonce((n) => n + 1);

        if (result.success && !result.error_message && (result.skipped_changes ?? 0) === 0 && quarantineCount === 0) {
          if (effectiveConflictCount > 0) {
            showGlobalNotification(
              'warning',
              t('data:governance.sync_completed_with_conflicts', {
                count: effectiveConflictCount,
              }),
            );
          } else {
            showGlobalNotification(
              'success',
              t('data:sync_settings.sync_success')
            );
          }
          await getSyncStatus().catch(console.error);
          return true;
        }

        const message = result.error_message ?? (
          quarantineCount > 0
            ? t('data:governance.sync_partial_with_quarantine', {
                count: quarantineCount,
              })
            : t('data:governance.sync_partial_with_skipped', {
                skipped: result.skipped_changes ?? 0,
              })
        );

        if (result.success) {
          showGlobalNotification(
            'warning',
            localizeCloudStorageError(message, t, i18n?.language),
          );
          await getSyncStatus().catch(console.error);
          return true;
        } else {
          notifyErrorDeduped(
            'error',
            localizeCloudStorageError(
              `${t('data:sync_settings.sync_failed')}: ${message}`,
              t,
              i18n?.language,
            ),
          );
          await getSyncStatus().catch(console.error);
          return false;
        }
      } catch (err: unknown) {
        notifyErrorDeduped(
          'error',
          `${t('data:sync_settings.sync_failed')}: ${localizeCloudStorageError(err, t, i18n?.language)}`
        );
        return false;
      } finally {
        useGlobalSyncStore.getState().endSync();
      }
    },
    [getSyncStatus, i18n?.language, syncStrategy, t]
  );

  // 计算同步状态摘要
  const syncSummary = React.useMemo(() => {
    if (!syncStatus) {
      return {
        status: 'unknown' as const,
        pendingChanges: 0,
        syncedDatabases: 0,
        totalDatabases: 0,
      };
    }

    const syncedDatabases = syncStatus.databases.filter(
      (db) => db.has_change_log && db.pending_changes === 0
    ).length;

    return {
      status: syncStatus.has_pending_changes ? ('pending' as const) : ('synced' as const),
      pendingChanges: syncStatus.total_pending_changes,
      syncedDatabases,
      totalDatabases: syncStatus.databases.length,
    };
  }, [syncStatus]);

  const content = (
    <div className="space-y-8">
      {/* 持久化未解决冲突提醒条（跨 toast 消失与刷新持续保留） */}
      {unresolvedConflictCount > 0 && (
        <div
          role="alert"
          data-testid="sync-settings-unresolved-conflicts-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warning/45 bg-warning/10 p-4"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <Warning className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold text-foreground">
                {t('data:governance.unresolved_conflicts_banner_title', {
                  count: unresolvedConflictCount,
                })}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('data:governance.unresolved_conflicts_banner_desc')}
              </p>
            </div>
          </div>
          <DsButton
            type="button"
            variant="warning"
            size="sm"
            data-testid="sync-settings-jump-conflicts-btn"
            onClick={handleJumpToInlineConflicts}
            className="shrink-0"
          >
            {t('data:governance.unresolved_conflicts_go_resolve')}
          </DsButton>
        </div>
      )}

      {/* 同步状态概览 */}
      <section className="min-w-0">
        <GroupTitle
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{t('data:sync_settings.sync_status')}</span>
              {/* 与数据治理面板 SyncTab 的同款入口保持一致：实验版徽章 + 备份提示 */}
              <span
                className="inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning ring-1 ring-inset ring-warning/20"
                title={t('sync:experimentalBadgeTooltip')}
              >
                {t('data:governance.experimental_badge')}
              </span>
            </span>
          }
        />
        <div className="rounded-2xl bg-muted p-4 space-y-4">
          {/* 状态指示 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {syncSummary.status === 'synced' ? (
                <>
                  <CheckCircle className="h-4 w-4 text-success" />
                  <span className="text-sm text-success">
                    {t('data:sync_settings.all_synced')}
                  </span>
                </>
              ) : syncSummary.status === 'pending' ? (
                <>
                  <Warning className="h-4 w-4 text-warning" />
                  <span className="text-sm text-warning">
                    {t('data:sync_settings.pending_changes', {
                      count: syncSummary.pendingChanges,
                    })}
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {t('data:sync_settings.status_unknown')}
                </span>
              )}
            </div>
            {syncStatus?.device_id && (
              <Badge variant="outline" className="text-xs font-mono">
                {syncStatus.device_id.slice(0, 8)}...
              </Badge>
            )}
          </div>

          {/* 数据库同步进度 */}
          {syncStatus && syncStatus.databases.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('data:sync_settings.databases')}</span>
                <span className="tabular-nums">
                  {syncSummary.syncedDatabases}/{syncSummary.totalDatabases}
                </span>
              </div>
              <Progress
                value={(syncSummary.syncedDatabases / syncSummary.totalDatabases) * 100}
                className="h-2"
                aria-label={t('data:sync_settings.db_sync_progress_label')}
              />
              <div className="grid grid-cols-2 gap-2 mt-3">
                {syncStatus.databases.map((db) => (
                  <div
                    key={db.id}
                    className="flex items-center justify-between p-2 bg-muted/50 rounded text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Database className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{db.id}</span>
                    </div>
                    {db.has_change_log ? (
                      db.pending_changes > 0 ? (
                        <Badge variant="secondary" className="text-xs bg-warning/10 text-warning">
                        <ArrowCircleUp className="h-3 w-3 mr-1" />
                          {db.pending_changes}
                        </Badge>
                      ) : (
                        <CheckCircle className="h-4 w-4 text-success" />
                      )
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 最后同步时间 */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ClockCounterClockwise className="h-3 w-3" />
            <span data-testid="sync-settings-last-sync-at">
              {t('data:sync_settings.last_sync')}:{' '}
              {(() => {
                const resolved = resolveLatestSyncTimestamp(syncStatus);
                return resolved
                  ? new Date(resolved).toLocaleString()
                  : t('cloudStorage:status.never', { defaultValue: '从未同步' });
              })()}
            </span>
          </div>
        </div>
      </section>

      {/* 同步操作 */}
      <section className="min-w-0">
        <GroupTitle
          title={t('data:sync_settings.sync_actions')}
          description={t('data:sync_settings.sync_actions_description')}
        />
        <div className="rounded-2xl bg-muted p-4 space-y-4">
          {/* 自动同步（默认关闭；未配置/缺凭据/租约被占时调度器静默跳过，不弹错） */}
          <div className="space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-foreground">
                  {t('sync:autoSync.label')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('sync:autoSync.description')}
                </p>
              </div>
              <Switch
                size="sm"
                checked={autoSyncEnabled}
                onCheckedChange={setAutoSyncEnabled}
                aria-label={t('sync:autoSync.label')}
              />
            </div>

            {/* 定时档位（15min / 1h / 6h），关闭时禁用但保留所选值 */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('sync:autoSync.intervalLabel')}
              </span>
              <AppSelect
                value={autoSyncIntervalPreset}
                onValueChange={(v) =>
                  setAutoSyncIntervalPreset(v as AutoSyncIntervalPreset)
                }
                options={[
                  { value: '15m', label: t('sync:autoSync.interval.15m') },
                  { value: '1h', label: t('sync:autoSync.interval.1h') },
                  { value: '6h', label: t('sync:autoSync.interval.6h') },
                ]}
                size="sm"
                variant="outline"
                disabled={!autoSyncEnabled}
              />
            </div>

            {/* 上次自动同步时间/结果（静默跳过也会记录，用户可在此看到原因） */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ClockCounterClockwise className="h-3 w-3 shrink-0" />
              {autoSyncLastRunAtMs !== null && autoSyncLastOutcome !== null ? (
                <span>
                  {t('sync:autoSync.lastRun')}:{' '}
                  {new Date(autoSyncLastRunAtMs).toLocaleString()} ·{' '}
                  {autoSyncOutcomeLabels[autoSyncLastOutcome]}
                  {autoSyncConsecutiveFailures > 0 && (
                    <>
                      {' · '}
                      {t('sync:autoSync.consecutiveFailures', {
                        count: autoSyncConsecutiveFailures,
                      })}
                    </>
                  )}
                </span>
              ) : (
                <span>
                  {t('sync:autoSync.lastRun')}: {t('sync:autoSync.neverRan')}
                </span>
              )}
            </div>
          </div>

          {/* 合并策略选择 */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {t('data:governance.merge_strategy')}
            </span>
            <AppSelect
              value={syncStrategy}
              onValueChange={(v) => setSyncStrategy(v as MergeStrategy)}
              options={[
                { value: 'keep_latest', label: t('data:governance.keep_latest') },
                { value: 'keep_local', label: t('data:governance.keep_local') },
                { value: 'use_cloud', label: t('data:governance.use_cloud') },
                { value: 'manual', label: t('data:governance.manual') },
              ]}
              size="sm"
              variant="outline"
            />
          </div>

          {/* 同步按钮组 */}
          <div className="flex flex-wrap items-center gap-3">
            <DsButton
              variant="primary"
              onClick={() => { void handleSync('bidirectional'); }}
              disabled={isSyncing}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              <ArrowsLeftRight className="h-4 w-4 mr-2" />
              {t('sync:syncNow', { defaultValue: '立即同步' })}
            </DsButton>
            <DsButton
              variant="outline"
              onClick={() => { void handleSync('upload'); }}
              disabled={isSyncing}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              <Upload className="h-4 w-4 mr-2" />
              {t('data:sync_settings.upload')}
            </DsButton>
            <DsButton
              variant="outline"
              onClick={() => { void handleSync('download'); }}
              disabled={isSyncing}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              <Download className="h-4 w-4 mr-2" />
              {t('data:sync_settings.download')}
            </DsButton>
          </div>

          {/* 同步进度显示 */}
          {syncProgress && (
            <Card className="border-border/40 bg-transparent shadow-none">
              <CardContent className="pt-4">
                <div className="space-y-3">
                  {/* 阶段指示器 */}
                  <div className="flex items-center gap-2">
                    {syncProgress.phase === 'completed' ? (
                      <CheckCircle className="h-4 w-4 text-success" />
                    ) : syncProgress.phase === 'failed' ? (
                      <Warning className="h-4 w-4 text-destructive" />
                    ) : (
                      <CircleNotch className="h-4 w-4 animate-spin text-primary" />
                    )}
                    <span className="font-medium">
                      {localizedPhaseNames[syncProgress.phase]}
                    </span>
                    {syncProgress.phase !== 'completed' &&
                      syncProgress.phase !== 'failed' && (
                        <>
                          <Badge variant="secondary" className="ml-auto">
                            {syncProgress.percent.toFixed(0)}%
                          </Badge>
                          <DsButton
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-8"
                            disabled={cancelRequested}
                            onClick={() => { void handleCancelSync(); }}
                          >
                            {cancelRequested
                              ? t('data:sync_settings.cancelling')
                              : t('data:sync_settings.cancel_sync')}
                          </DsButton>
                        </>
                      )}
                  </div>

                  {/* 进度条 */}
                  <Progress
                    value={syncProgress.percent}
                    className="h-2"
                    aria-label={t('data:sync_settings.sync_progress_label')}
                  />

                  {/* 详细信息 */}
                  <div className="text-sm text-muted-foreground flex justify-between flex-wrap gap-2">
                    <span>
                      {syncProgress.current} / {syncProgress.total}
                    </span>
                    {syncProgress.speed_bytes_per_sec !== null &&
                      syncProgress.speed_bytes_per_sec > 0 && (
                        <span>{formatSpeed(syncProgress.speed_bytes_per_sec)}</span>
                      )}
                    {syncProgress.eta_seconds !== null && syncProgress.eta_seconds > 0 && (
                      <span>
                        {t('data:sync_settings.eta')} {formatEta(syncProgress.eta_seconds)}
                      </span>
                    )}
                  </div>

                  {/* 当前处理项 */}
                  {syncProgress.current_item && (
                    <div className="text-xs text-muted-foreground truncate bg-muted/50 px-2 py-1 rounded">
                      {syncProgress.current_item.startsWith('sync:')
                        ? t(syncProgress.current_item, {
                            defaultValue: localizeBackendErrorText(
                              syncProgress.current_item,
                              i18n?.language
                            ),
                          })
                        : localizeBackendErrorText(
                            syncProgress.current_item,
                            i18n?.language
                          )}
                    </div>
                  )}

                  {/* 错误信息 */}
                  {syncProgress.error && (
                    <Alert variant="destructive" className="py-2">
                      <Warning className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        {localizeCloudStorageError(
                          syncProgress.error,
                          t,
                          i18n?.language
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      {/* 冲突检测和解决 */}
      <section className="min-w-0">
        <GroupTitle
          title={t('data:sync_settings.conflict_management')}
          description={t('data:sync_settings.conflict_description')}
        />
        <div className="rounded-2xl bg-muted p-4 space-y-4">
          {/* 冲突状态 */}
          {conflicts?.has_conflicts ? (
            <Alert variant="warning">
              <Warning className="h-4 w-4" />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {t('data:sync_settings.conflicts_found', {
                    count:
                      conflicts.database_conflicts.length +
                      Math.max(conflicts.record_conflicts.length, conflicts.record_conflict_count ?? 0, unresolvedConflictCount),
                  })}
                </span>
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={() => setShowConflictDialog(true)}
                  className="[@media(pointer:coarse)]:!min-h-11"
                >
                  {t('data:sync_settings.view_conflicts')}
                </DsButton>
              </AlertDescription>
            </Alert>
          ) : lastResult?.success && unresolvedConflictCount === 0 ? (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>
                {t('data:sync_settings.no_conflicts')}
              </AlertDescription>
            </Alert>
          ) : null}

          {/* 错误提示 */}
          {error && (
            <Alert variant="destructive">
              <Warning className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span>{error}</span>
                <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={clearError}>
                  {t('common:actions.dismiss')}
                </DsButton>
              </AlertDescription>
            </Alert>
          )}

          {/* 操作按钮 */}
          <div className="flex flex-wrap items-center gap-3">
            <DsButton
              variant="outline"
              onClick={handleDetectConflicts}
              disabled={isDetecting}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              {isDetecting ? (
                <>
                  <CircleNotch className="h-4 w-4 animate-spin mr-2" />
                  {t('data:sync_settings.detecting')}
                </>
              ) : (
                <>
                  <ArrowClockwise className="h-4 w-4 mr-2" />
                  {t('data:sync_settings.detect_conflicts')}
                </>
              )}
            </DsButton>
            {(conflicts?.has_conflicts || unresolvedConflictCount > 0) && (
              <DsButton
                variant="outline"
                onClick={conflicts?.has_conflicts ? () => setShowConflictDialog(true) : handleJumpToInlineConflicts}
                disabled={isResolving}
                className="flex-1 [@media(pointer:coarse)]:!min-h-11"
              >
                <Lightning className="h-4 w-4 mr-2" />
                {t('data:governance.open_record_conflicts_panel')}
              </DsButton>
            )}
          </div>

          {/* 最后解决结果 */}
          {lastResult && (
            <div className="p-3 bg-muted/50 rounded-lg text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t('data:sync_settings.last_resolution')}
                </span>
                <Badge variant={lastResult.success ? 'default' : 'destructive'}>
                  {lastResult.success
                    ? t('data:sync_settings.success')
                    : t('data:sync_settings.failed')}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t('data:sync_settings.strategy_used')}
                </span>
                <span>{lastResult.strategy}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t('data:sync_settings.resolved_count')}
                </span>
                <span>{lastResult.resolved_conflicts}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t('data:sync_settings.duration')}
                </span>
                <span>{lastResult.duration_ms}ms</span>
              </div>
            </div>
          )}

          {/* 记录级冲突直达面板（支持保留本地 / 采用云端 / 保留两者 / 手动合并） */}
          <RecordConflictsPanel
            refreshSignal={conflictRefreshNonce}
            focusSignal={conflictFocusNonce}
          />
        </div>
      </section>

      {/* 扫码同步与跨设备快传中心 */}
      <DevicePairingSection
        cloudConfigured={cloudConfigured}
        onApplied={() => {
          void refreshCloudConfigured();
          void getSyncStatus().catch(console.error);
        }}
        onRunSync={(direction) => handleSync(direction)}
      />

      {/* 冲突详情与记录级解决对话框（不再调用已停用的批量清单级覆盖接口） */}
      {conflicts && (
        <ConflictResolutionDialog
          open={showConflictDialog}
          onClose={handleCloseConflictDialog}
          conflicts={conflicts}
          recordConflictsContent={
            <RecordConflictsPanel refreshSignal={conflictRefreshNonce} />
          }
          isResolving={isResolving}
        />
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <SettingSection
      title={t('data:sync_settings.title')}
      description={t('data:sync_settings.description')}
    >
      {content}
    </SettingSection>
  );
};

export default SyncSettingsSection;
