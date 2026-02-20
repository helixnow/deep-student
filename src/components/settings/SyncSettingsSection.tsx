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
  CloudOff,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  ArrowUpCircle,
  ArrowDownCircle,
  History,
  Settings2,
  Zap,
  Upload,
  Download,
  ArrowLeftRight,
} from 'lucide-react';
import { NotionButton } from '../ui/NotionButton';
import { Badge } from '../ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/shad/Card';
import { Alert, AlertDescription } from '../ui/shad/Alert';
import { Separator } from '../ui/shad/Separator';
import { Progress } from '../ui/shad/Progress';
import { SettingSection } from './SettingsCommon';
import { ConflictResolutionDialog, MergeStrategy } from '../ConflictResolutionDialog';
import { useConflictResolution } from '@/hooks/useConflictResolution';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  SyncProgress,
  SyncPhase,
  formatSpeed,
  formatEta,
} from '../../types/dataGovernance';
import { loadStoredCloudStorageConfigWithCredentials } from '@/utils/cloudStorageApi';
import {
  listenSyncProgress,
  runSyncWithProgress,
} from '../../api/dataGovernance';

interface SyncSettingsSectionProps {
  embedded?: boolean;
}

export const SyncSettingsSection: React.FC<SyncSettingsSectionProps> = ({
  embedded = false,
}) => {
  const { t } = useTranslation(['data', 'common']);

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
  const [isSyncing, setIsSyncing] = useState(false);

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
      if (isSyncing) return;

      const cloudConfig = await loadStoredCloudStorageConfigWithCredentials();
      if (!cloudConfig) {
        showGlobalNotification(
          'warning',
          t('data:governance.cloud_sync_not_configured')
        );
        return;
      }

      setIsSyncing(true);
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

      // 设置进度监听
      const unlisten = await listenSyncProgress({
        onProgress: (progress) => setSyncProgress(progress),
        onComplete: () => {
          setSyncProgress(null);
          setIsSyncing(false);
          showGlobalNotification(
            'success',
            t('data:sync_settings.sync_success')
          );
          // 刷新同步状态
          void getSyncStatus().catch(console.error);
        },
        onError: (error) => {
          setSyncProgress(null);
          setIsSyncing(false);
          showGlobalNotification(
            'error',
            `${t('data:sync_settings.sync_failed')}: ${error}`
          );
        },
      });

      try {
        // TODO: 从配置中获取 cloudConfig 和 strategy
        await runSyncWithProgress(direction, cloudConfig, 'keep_latest');
      } catch (err: unknown) {
        setSyncProgress(null);
        setIsSyncing(false);
        showGlobalNotification(
          'error',
          `${t('data:sync_settings.sync_failed')}: ${getErrorMessage(err)}`
        );
      } finally {
        unlisten();
      }
    },
    [getSyncStatus, isSyncing, t]
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
                <CloudOff className="h-5 w-5 text-warning" />
              ) : (
                <Cloud className="h-5 w-5 text-muted-foreground" />
              )}
              <CardTitle className="text-base">
                {t('data:sync_settings.sync_status')}
              </CardTitle>
            </div>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </NotionButton>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 状态指示 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {syncSummary.status === 'synced' ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <span className="text-sm text-success">
                    {t('data:sync_settings.all_synced')}
                  </span>
                </>
              ) : syncSummary.status === 'pending' ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-warning" />
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
                          <ArrowUpCircle className="h-3 w-3 mr-1" />
                          {db.pending_changes}
                        </Badge>
                      ) : (
                        <CheckCircle2 className="h-4 w-4 text-success" />
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
              <History className="h-3 w-3" />
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
            <RefreshCw className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">
              {t('data:sync_settings.sync_actions')}
            </CardTitle>
          </div>
          <CardDescription>
            {t('data:sync_settings.sync_actions_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 同步按钮组 */}
          <div className="flex items-center gap-3">
            <NotionButton
              variant="outline"
              onClick={() => handleSync('upload')}
              disabled={isSyncing}
              className="flex-1"
            >
              <Upload className="h-4 w-4 mr-2" />
              {t('data:sync_settings.upload')}
            </NotionButton>
            <NotionButton
              variant="outline"
              onClick={() => handleSync('download')}
              disabled={isSyncing}
              className="flex-1"
            >
              <Download className="h-4 w-4 mr-2" />
              {t('data:sync_settings.download')}
            </NotionButton>
            <NotionButton
              onClick={() => handleSync('bidirectional')}
              disabled={isSyncing}
              className="flex-1"
            >
              <ArrowLeftRight className="h-4 w-4 mr-2" />
              {t('data:sync_settings.bidirectional')}
            </NotionButton>
          </div>

          {/* 同步进度显示 */}
          {syncProgress && (
            <Card className="border-dashed">
              <CardContent className="pt-4">
                <div className="space-y-3">
                  {/* 阶段指示器 */}
                  <div className="flex items-center gap-2">
                    {syncProgress.phase === 'completed' ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : syncProgress.phase === 'failed' ? (
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
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
                  <Progress value={syncProgress.percent} className="h-2" />

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
                      <AlertTriangle className="h-4 w-4" />
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
            <Settings2 className="h-5 w-5 text-muted-foreground" />
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
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span>
                  {t('data:sync_settings.conflicts_found', {
                    count:
                      conflicts.database_conflicts.length + conflicts.record_conflicts.length,
                  })}
                </span>
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={() => setShowConflictDialog(true)}
                >
                  {t('data:sync_settings.view_conflicts')}
                </NotionButton>
              </AlertDescription>
            </Alert>
          ) : lastResult?.success ? (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>
                {t('data:sync_settings.no_conflicts')}
              </AlertDescription>
            </Alert>
          ) : null}

          {/* 错误提示 */}
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span>{error}</span>
                <NotionButton variant="ghost" size="sm" onClick={clearError}>
                  {t('common:actions.dismiss')}
                </NotionButton>
              </AlertDescription>
            </Alert>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center gap-3">
            <NotionButton
              variant="outline"
              onClick={handleDetectConflicts}
              disabled={isDetecting}
              className="flex-1"
            >
              {isDetecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {t('data:sync_settings.detecting')}
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {t('data:sync_settings.detect_conflicts')}
                </>
              )}
            </NotionButton>
            {conflicts?.has_conflicts && (
              <NotionButton
                onClick={() => setShowConflictDialog(true)}
                disabled={isResolving}
                className="flex-1"
              >
                <Zap className="h-4 w-4 mr-2" />
                {t('data:sync_settings.resolve_conflicts')}
              </NotionButton>
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
