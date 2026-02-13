/**
 * 同步标签页组件
 *
 * 从 DataGovernanceDashboard.tsx 拆分提取
 * 展示同步状态概览、数据库同步表、云端同步配置和冲突解决
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cloud,
  HardDrive,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Download,
  Search,
  Upload,
  ArrowRightLeft,
  FileText,
} from 'lucide-react';

import { NotionButton } from '../../ui/NotionButton';
import { Badge } from '../../ui/shad/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/shad/Table';
import { AppSelect } from '../../ui/app-menu';
import { CloudStorageSection } from '../CloudStorageSection';
import type {
  SyncStatusResponse,
  ConflictDetectionResponse,
  SyncProgress,
  MergeStrategy,
} from '../../../types/dataGovernance';
import {
  getDatabaseDisplayName,
  getSyncPhaseName,
  formatSpeed,
  formatEta,
} from '../../../types/dataGovernance';
import type { StorageProvider } from '../../../utils/cloudStorageApi';

export interface SyncTabProps {
  syncStatus: SyncStatusResponse | null;
  conflicts: ConflictDetectionResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onDetectConflicts: () => void;
  onResolveConflicts: (strategy: MergeStrategy) => void;
  cloudSyncConfigured: boolean;
  cloudSyncSummary: { provider: StorageProvider; root?: string } | null;
  syncRunning: boolean;
  syncProgress: SyncProgress | null;
  syncStrategy: MergeStrategy;
  onSyncStrategyChange: (strategy: MergeStrategy) => void;
  showCloudSettingsEditor: boolean;
  onToggleCloudSettingsEditor: () => void;
  onSetCloudSettingsEditorOpen: (open: boolean) => void;
  onCloudConfigChanged: () => void;
  onRunSync: (direction: 'upload' | 'download' | 'bidirectional', strategy: MergeStrategy) => void;
  onRetrySync?: () => void;
  onViewAuditLog?: () => void;
}

export const SyncTab: React.FC<SyncTabProps> = ({
  syncStatus,
  conflicts,
  loading,
  onRefresh,
  onDetectConflicts,
  onResolveConflicts,
  cloudSyncConfigured,
  cloudSyncSummary,
  syncRunning,
  syncProgress,
  syncStrategy,
  onSyncStrategyChange,
  showCloudSettingsEditor,
  onToggleCloudSettingsEditor,
  onSetCloudSettingsEditorOpen,
  onCloudConfigChanged,
  onRunSync,
  onRetrySync,
  onViewAuditLog,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const syncDatabases = syncStatus?.databases ?? [];
  const showSyncProgress = syncRunning || Boolean(syncProgress?.error);

  return (
    <div className="space-y-8">
      {/* 同步状态概览 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Cloud className="h-4 w-4" />
            {t('data:governance.pending_changes')}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            {syncStatus?.total_pending_changes ?? 0}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            {t('data:governance.synced_changes')}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            {syncStatus?.total_synced_changes ?? 0}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <HardDrive className="h-4 w-4" />
            {t('data:governance.device_id')}
          </div>
          <div className="text-sm font-mono truncate" title={syncStatus?.device_id}>
            {syncStatus?.device_id?.slice(0, 8) ?? '-'}...
          </div>
        </div>
      </div>

      <div className="border-t border-border/40" />

      {/* 数据库同步状态 */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h3 className="text-base font-medium text-foreground">
            {t('data:governance.database_sync_status')}
          </h3>
          <div className="flex gap-2">
            <NotionButton variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="h-8">
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              {t('common:actions.refresh')}
            </NotionButton>
            <NotionButton variant="default" size="sm" onClick={onDetectConflicts} disabled={loading} className="h-8">
              <Search className="h-3.5 w-3.5 mr-1.5" />
              {t('data:governance.detect_conflicts')}
            </NotionButton>
          </div>
        </div>

        <div className="rounded-lg border border-border/40 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/40">
                <TableHead className="h-10 whitespace-nowrap min-w-[80px]">{t('data:governance.database')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[80px]">{t('data:governance.change_log')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[60px]">{t('data:governance.pending')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[60px]">{t('data:governance.synced')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {syncDatabases.map((db) => (
                <TableRow key={db.id} className="hover:bg-muted/30 border-border/40">
                  <TableCell className="font-medium py-3 whitespace-nowrap">
                    {getDatabaseDisplayName(db.id, t)}
                  </TableCell>
                  <TableCell className="py-3">
                    {db.has_change_log ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500/70" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground/50" />
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    {db.pending_changes > 0 ? (
                      <Badge variant="secondary" className="rounded-sm font-normal">{db.pending_changes}</Badge>
                    ) : (
                      <span className="text-muted-foreground/50">0</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    <span className="text-muted-foreground/70">{db.synced_changes}</span>
                  </TableCell>
                </TableRow>
              ))}
              {(!syncStatus || syncDatabases.length === 0) && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('common:status.loading')}
                      </div>
                    ) : (
                      t('data:governance.no_data')
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="border-t border-border/40" />

      {/* 云端同步 */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h3 className="text-base font-medium text-foreground">
            {t('data:governance.cloud_sync_title')}
          </h3>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={onToggleCloudSettingsEditor}
            className="h-8"
          >
            <Cloud className="h-3.5 w-3.5 mr-1.5" />
            {t('data:governance.open_cloud_settings')}
          </NotionButton>
        </div>

        {!cloudSyncConfigured ? (
          <div className="rounded-lg border border-border/40 bg-muted/20 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              {t('data:governance.cloud_sync_not_configured')}
            </div>
            <p className="text-sm text-muted-foreground pl-6">
              {t('data:governance.cloud_sync_not_configured_desc')}
            </p>
            <div className="pl-6 pt-1">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => onSetCloudSettingsEditorOpen(true)}
                className="bg-background hover:bg-accent"
              >
                {t('data:governance.cloud_sync_configure_now')}
              </NotionButton>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border/40 bg-background p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {t('data:governance.cloud_sync_provider')}
                </span>
                <span className="ml-2 font-mono">
                  {cloudSyncSummary?.provider ?? '-'}
                </span>
                <span className="mx-2 text-muted-foreground/50">•</span>
                <span className="font-medium text-foreground">
                  {t('data:governance.cloud_sync_root')}
                </span>
                <span className="ml-2 font-mono">
                  {cloudSyncSummary?.root ?? '-'}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('data:governance.merge_strategy')}
                </span>
                <AppSelect
                  value={syncStrategy}
                  onValueChange={(v) => onSyncStrategyChange(v as MergeStrategy)}
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
            </div>

            <div className="flex flex-wrap gap-2">
              <NotionButton
                variant="default"
                size="sm"
                onClick={() => onRunSync('bidirectional', syncStrategy)}
                disabled={loading || syncRunning}
                className="h-8"
              >
                <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                {t('data:governance.sync_bidirectional')}
              </NotionButton>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => onRunSync('upload', syncStrategy)}
                disabled={loading || syncRunning}
                className="h-8 bg-background hover:bg-accent"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                {t('data:governance.sync_upload')}
              </NotionButton>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => onRunSync('download', syncStrategy)}
                disabled={loading || syncRunning}
                className="h-8 bg-background hover:bg-accent"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                {t('data:governance.sync_download')}
              </NotionButton>
            </div>

            {/* 同步进度 */}
            {showSyncProgress && syncProgress && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {syncRunning ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )}
                    <span className={`text-sm font-medium ${syncRunning ? 'text-primary' : 'text-destructive'}`}>
                      {syncRunning ? t('data:governance.sync_in_progress') : t('data:governance.sync_failed')}
                    </span>
                    {syncRunning && (
                      <span className="text-xs text-muted-foreground">
                        - {getSyncPhaseName(syncProgress.phase, t)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {syncProgress.current_item ?? '-'}
                    </span>
                    <span>{Math.round(syncProgress.percent)}%</span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 ease-out"
                      style={{ width: `${syncProgress.percent}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {syncProgress.current} / {syncProgress.total} {t('data:governance.items')}
                    </span>
                    <span>
                      {t('data:governance.speed')}: {formatSpeed(syncProgress.speed_bytes_per_sec)}
                    </span>
                    <span>
                      {t('data:governance.eta')}: {formatEta(syncProgress.eta_seconds)}
                    </span>
                  </div>
                  {syncProgress.error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs text-destructive">
                        <XCircle className="h-3 w-3 shrink-0" />
                        <span>{syncProgress.error}</span>
                      </div>
                      <div className="flex items-center gap-2 pl-[18px]">
                        {onRetrySync && (
                          <NotionButton
                            variant="ghost"
                            size="sm"
                            onClick={onRetrySync}
                            disabled={syncRunning}
                            className="h-6 text-xs px-2"
                          >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            {t('common:actions.retry')}
                          </NotionButton>
                        )}
                        {onViewAuditLog && (
                          <NotionButton
                            variant="ghost"
                            size="sm"
                            onClick={onViewAuditLog}
                            className="h-6 text-xs px-2"
                          >
                            <FileText className="h-3 w-3 mr-1" />
                            {t('data:governance.view_audit_log')}
                          </NotionButton>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {showCloudSettingsEditor && (
          <div className="rounded-lg border border-border/40 bg-background p-4">
            <CloudStorageSection
              isDialog
              onConfigChanged={onCloudConfigChanged}
            />
          </div>
        )}
      </div>

      {/* 冲突信息 */}
      {conflicts && conflicts.has_conflicts && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-4">
          <div className="flex items-center gap-2 text-amber-600 font-medium">
            <AlertTriangle className="h-4 w-4" />
            {t('data:governance.conflicts_detected')}
          </div>
          
          <p className="text-sm text-muted-foreground">
            {t('data:governance.conflicts_count', {
              count: conflicts.database_conflicts.length,
              records: conflicts.record_conflict_count,
            })}
          </p>

          {/* 冲突影响说明 */}
          <p className="text-xs text-muted-foreground/80">
            {t('data:governance.conflict_impact_hint')}
          </p>

          {/* 冲突解决策略 */}
          <div className="flex flex-wrap gap-2 pt-2">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => onResolveConflicts('keep_local')}
              disabled={loading}
              className="bg-background hover:bg-accent"
            >
              {t('data:governance.keep_local')}
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => onResolveConflicts('use_cloud')}
              disabled={loading}
              className="bg-background hover:bg-accent"
            >
              {t('data:governance.use_cloud')}
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => onResolveConflicts('keep_latest')}
              disabled={loading}
              className="bg-background hover:bg-accent"
            >
              {t('data:governance.keep_latest')}
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => onResolveConflicts('manual')}
              disabled={loading}
              className="bg-background hover:bg-accent"
            >
              {t('data:governance.manual')}
            </NotionButton>
          </div>
        </div>
      )}
    </div>
  );
};
