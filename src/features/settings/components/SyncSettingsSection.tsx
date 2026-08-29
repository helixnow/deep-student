/**
 * 同步设置区域组件
 *
 * 提供数据同步相关的设置和冲突解决功能：
 * - 同步状态概览
 * - 同步进度显示
 * - 冲突检测和解决
 * - 同步历史记录
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cloud,
  CloudSlash,
  ArrowClockwise,
  Warning,
  CheckCircle,
  Database,
  CircleNotch,
  ArrowCircleUp,
  ArrowCircleDown,
  ClockCounterClockwise,
  GearSix,
  Lightning,
  Upload,
  Download,
  ArrowsLeftRight,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { AppSelect } from '@/components/ui/app-menu';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/shad/Card';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import { Separator } from '@/components/ui/shad/Separator';
import { Progress } from '@/components/ui/shad/Progress';
import { SettingSection } from './SettingsCommon';
import { ConflictResolutionDialog, MergeStrategy } from '@/components/ConflictResolutionDialog';
import { useConflictResolution } from '@/hooks/useConflictResolution';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  SyncProgress,
  SyncPhase,
  formatSpeed,
  formatEta,
} from '@/types/dataGovernance';
import { Switch } from '@/components/ui/shad/Switch';
import { loadStoredCloudStorageConfigWithCredentials } from '@/utils/cloudStorageApi';
import {
  useGlobalSyncStore,
  useAutoSyncStore,
  ensureAutoSyncSchedulerStarted,
  type AutoSyncIntervalPreset,
  type AutoSyncOutcome,
} from '@/stores/syncStatusStore';
import {
  DataGovernanceApi,
  listenSyncProgress,
  runSyncWithProgress,
} from '@/api/dataGovernance';

interface SyncSettingsSectionProps {
  embedded?: boolean;
}

export const SyncSettingsSection: React.FC<SyncSettingsSectionProps> = ({
  embedded = false,
}) => {
  const { t } = useTranslation(['data', 'common', 'sync']);

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
    cloudManifestJson,
    error,
    lastResult,
    getSyncStatus,
    detectConflicts,
    resolveConflicts,
    detectConflictsMock,
    resolveConflictsMock,
    clearError,
  } = useConflictResolution();

  // UI 状态
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 同步进度状态
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  // 全局同步状态：与数据治理面板等其他入口共享，任一入口同步时本入口按钮禁用
  const isSyncing = useGlobalSyncStore((s) => s.isSyncing);
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

  // 初始化加载同步状态
  useEffect(() => {
    if (!useMock) {
      void getSyncStatus().catch(console.error);
    }
  }, [getSyncStatus, useMock]);

  // 刷新同步状态
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      if (useMock) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        await getSyncStatus();
      }
      showGlobalNotification(
        'success',
        t('data:sync_settings.refresh_success')
      );
    } catch (err: unknown) {
      showGlobalNotification(
        'error',
        `${t('data:sync_settings.refresh_failed')}: ${getErrorMessage(err)}`
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [getSyncStatus, t, useMock]);

  // 检测冲突
  const handleDetectConflicts = useCallback(async () => {
    try {
      if (useMock) {
        await detectConflictsMock();
      } else {
        await detectConflicts();
      }
      setShowConflictDialog(true);
    } catch (err: unknown) {
      showGlobalNotification(
        'error',
        `${t('data:sync_settings.detect_failed')}: ${getErrorMessage(err)}`
      );
    }
  }, [detectConflicts, detectConflictsMock, t, useMock]);

  // 解决冲突
  const handleResolveConflicts = useCallback(
    async (strategy: MergeStrategy) => {
      try {
        let result;
        if (useMock) {
          result = await resolveConflictsMock(strategy);
        } else {
          if (!cloudManifestJson) {
            throw new Error('cloud manifest missing (configure cloud storage and detect conflicts first)');
          }
          result = await resolveConflicts(strategy, cloudManifestJson);
        }

        if (result.success) {
          showGlobalNotification(
            'success',
            t('data:sync_settings.resolve_success', {
              count: result.resolved_conflicts,
            })
          );
          setShowConflictDialog(false);
        } else {
          showGlobalNotification(
            'warning',
            result.error_message ??
              t('data:sync_settings.resolve_partial')
          );
        }
      } catch (err: unknown) {
        showGlobalNotification(
          'error',
          `${t('data:sync_settings.resolve_failed')}: ${getErrorMessage(err)}`
        );
      }
    },
    [cloudManifestJson, resolveConflicts, resolveConflictsMock, t, useMock]
  );

  // 关闭冲突对话框
  const handleCloseConflictDialog = useCallback(() => {
    setShowConflictDialog(false);
  }, []);

  // 执行同步（带进度跟踪）
  const handleSync = useCallback(
    async (direction: 'upload' | 'download' | 'bidirectional') => {
      const cloudConfig = await loadStoredCloudStorageConfigWithCredentials();
      if (!cloudConfig) {
        showGlobalNotification(
          'warning',
          t('data:governance.cloud_sync_not_configured')
        );
        return;
      }

      // 全局占用：任何入口已有同步进行中则直接拒绝本次触发
      if (!useGlobalSyncStore.getState().beginSync('sync-settings')) {
        showGlobalNotification(
          'warning',
          t('data:governance.sync_already_running')
        );
        return;
      }

      let unlisten: (() => void) | null = null;
      try {
        setSyncProgress({
          phase: 'preparing',
          percent: 0,
          current: 0,
          total: 0,
          current_item: null,
          speed_bytes_per_sec: null,
          eta_seconds: null,
          error: null,
        });

        if (direction !== 'upload') {
          const gap = await DataGovernanceApi.detectPruneGap(cloudConfig);
          if (gap.has_gap) {
            throw new Error(t('data:governance.sync_prune_gap_warning', {
              since: gap.since_version,
              minAvail: gap.min_available_version ?? 0,
            }));
          }
        }

        unlisten = await listenSyncProgress({
          onProgress: (progress) => setSyncProgress(progress),
        });

        const result = await runSyncWithProgress(direction, cloudConfig, syncStrategy);
        setSyncProgress(null);

        if (result.success && !result.error_message && (result.skipped_changes ?? 0) === 0) {
          showGlobalNotification(
            'success',
            t('data:sync_settings.sync_success')
          );
          void getSyncStatus().catch(console.error);
          return;
        }

        const message = result.error_message ??
          t('data:governance.sync_partial_with_skipped', {
            skipped: result.skipped_changes ?? 0,
          });

        if (result.success) {
          showGlobalNotification('warning', message);
          void getSyncStatus().catch(console.error);
        } else {
          showGlobalNotification(
            'error',
            `${t('data:sync_settings.sync_failed')}: ${message}`
          );
        }
      } catch (err: unknown) {
        setSyncProgress(null);
        showGlobalNotification(
          'error',
          `${t('data:sync_settings.sync_failed')}: ${getErrorMessage(err)}`
        );
      } finally {
        useGlobalSyncStore.getState().endSync();
        unlisten?.();
      }
    },
    [getSyncStatus, syncStrategy, t]
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
    <div className="space-y-6">
      {/* 同步状态概览 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {syncSummary.status === 'synced' ? (
                <Cloud className="h-5 w-5 text-success" />
              ) : syncSummary.status === 'pending' ? (
                <CloudSlash className="h-5 w-5 text-warning" />
              ) : (
                <Cloud className="h-5 w-5 text-muted-foreground" />
              )}
              <CardTitle className="text-base">
                {t('data:sync_settings.sync_status')}
              </CardTitle>
              {/* 与数据治理面板 SyncTab 的同款入口保持一致：实验版徽章 + 备份提示 */}
              <span
                className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs font-medium text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/20"
                title={t('sync:experimentalBadgeTooltip')}
              >
                {t('data:governance.experimental_badge')}
              </span>
            </div>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            >
              {isRefreshing ? (
                <CircleNotch className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowClockwise className="h-4 w-4" />
              )}
            </DsButton>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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
                <span>
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
          {syncStatus?.last_sync_at && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ClockCounterClockwise className="h-3 w-3" />
              <span>
                {t('data:sync_settings.last_sync')}: {syncStatus.last_sync_at}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 同步操作 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <ArrowClockwise className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">
              {t('data:sync_settings.sync_actions')}
            </CardTitle>
          </div>
          <CardDescription>
            {t('data:sync_settings.sync_actions_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
          <div className="flex items-center gap-3">
            <DsButton
              variant="outline"
              onClick={() => handleSync('upload')}
              disabled={isSyncing}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              <Upload className="h-4 w-4 mr-2" />
              {t('data:sync_settings.upload')}
            </DsButton>
            <DsButton
              variant="outline"
              onClick={() => handleSync('download')}
              disabled={isSyncing}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              <Download className="h-4 w-4 mr-2" />
              {t('data:sync_settings.download')}
            </DsButton>
            <DsButton
              onClick={() => handleSync('bidirectional')}
              disabled={isSyncing}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              <ArrowsLeftRight className="h-4 w-4 mr-2" />
              {t('data:sync_settings.bidirectional')}
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
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : syncProgress.phase === 'failed' ? (
                      <Warning className="h-4 w-4 text-red-500" />
                    ) : (
                      <CircleNotch className="h-4 w-4 animate-spin text-primary" />
                    )}
                    <span className="font-medium">
                      {localizedPhaseNames[syncProgress.phase]}
                    </span>
                    {syncProgress.phase !== 'completed' &&
                      syncProgress.phase !== 'failed' && (
                        <Badge variant="secondary" className="ml-auto">
                          {syncProgress.percent.toFixed(0)}%
                        </Badge>
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
                      {syncProgress.current_item}
                    </div>
                  )}

                  {/* 错误信息 */}
                  {syncProgress.error && (
                    <Alert variant="destructive" className="py-2">
                      <Warning className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        {syncProgress.error}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      {/* 冲突检测和解决 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <GearSix className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">
              {t('data:sync_settings.conflict_management')}
            </CardTitle>
          </div>
          <CardDescription>
            {t('data:sync_settings.conflict_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 冲突状态 */}
          {conflicts?.has_conflicts ? (
            <Alert variant="warning">
              <Warning className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span>
                  {t('data:sync_settings.conflicts_found', {
                    count:
                      conflicts.database_conflicts.length + conflicts.record_conflicts.length,
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
          ) : lastResult?.success ? (
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
          <div className="flex items-center gap-3">
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
            {conflicts?.has_conflicts && (
              <DsButton
                onClick={() => setShowConflictDialog(true)}
                disabled={isResolving}
                className="flex-1 [@media(pointer:coarse)]:!min-h-11"
              >
                <Lightning className="h-4 w-4 mr-2" />
                {t('data:sync_settings.resolve_conflicts')}
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
        </CardContent>
      </Card>

      {/* 冲突解决对话框 */}
      {conflicts && (
        <ConflictResolutionDialog
          open={showConflictDialog}
          onClose={handleCloseConflictDialog}
          conflicts={conflicts}
          onResolve={handleResolveConflicts}
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
