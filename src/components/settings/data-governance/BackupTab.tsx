/**
 * 备份管理标签页组件
 *
 * 从 DataGovernanceDashboard.tsx 拆分提取
 * 提供一键导出备份、ZIP 导入/导出、备份列表管理
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Shield,
  Loader2,
  Play,
  Trash2,
  XCircle,
  AlertTriangle,
  Archive,
  Upload,
  Image,
  FileText,
  File,
  Folder,
  FileAudio,
  FileVideo,
  CheckCircle2,
  RotateCcw,
  Settings,
  FileOutput,
} from 'lucide-react';

import { NotionButton } from '../../ui/NotionButton';
import { Badge } from '../../ui/shad/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/shad/Table';
import { AppSelect } from '../../ui/app-menu';
import { showGlobalNotification } from '../../UnifiedNotification';
import { NotionAlertDialog } from '../../ui/NotionDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/shad/Dialog';
import { Checkbox } from '../../ui/shad/Checkbox';
import { Label } from '../../ui/shad/Label';
import { Switch } from '../../ui/shad/Switch';
import type {
  BackupInfoResponse,
  BackupVerifyResponse,
  BackupTier,
  AssetType,
  AutoVerifyResponse,
} from '../../../types/dataGovernance';
import {
  formatBytes,
  formatTimestamp,
  formatDuration,
  getDatabaseDisplayName,
} from '../../../types/dataGovernance';
import type { BackupJobEvent, ResumableJob, BackupConfig } from '../../../api/dataGovernance';
import { getBackupConfig, setBackupConfig } from '../../../api/dataGovernance';
import { Input } from '../../ui/shad/Input';

export type BackupJobOperation = 'backup' | 'tiered_backup' | 'zip_export' | 'zip_import' | 'restore';

/** 备份验证状态 */
export type BackupVerificationStatus = 'verified' | 'unverified' | 'failed' | 'verifying';

export interface BackupTabProps {
  backups: BackupInfoResponse[];
  loading: boolean;
  onRefresh: () => void;
  onBackupAndExportZip: (options: {
    compressionLevel: number;
    addToBackupList: boolean;
    useTiered: boolean;
    tiers?: BackupTier[];
    includeAssets?: boolean;
    assetTypes?: AssetType[];
  }) => void;
  onDeleteBackup: (backupId: string) => void;
  onVerifyBackup: (backupId: string) => void;
  onRestoreBackup: (backupId: string) => void;
  onExportZip: (backupId: string, compressionLevel: number) => void;
  onImportZip: () => void;
  // 后台任务相关
  backupProgress?: BackupJobEvent | null;
  isBackupRunning?: boolean;
  onCancelBackup?: () => void;
  /** 当前后台任务的操作类型（用于正确展示文案） */
  currentJobOperation?: BackupJobOperation | null;
  // 可恢复任务相关
  resumableJobs?: ResumableJob[];
  onResumeJob?: (jobId: string) => void;
  // 恢复完成后重启对话框
  showRestartDialog?: boolean;
  onRestartNow?: () => void;
  onRestartLater?: () => void;
  // 导入完成后提示恢复对话框
  showRestorePromptDialog?: boolean;
  onRestoreNow?: () => void;
  onRestoreLater?: () => void;
  // 备份验证详细结果
  verifyResult?: BackupVerifyResponse | null;
  showVerifyDialog?: boolean;
  onCloseVerifyDialog?: () => void;
  // 备份验证状态映射（backup_id -> status）
  verificationStatusMap?: Record<string, BackupVerificationStatus>;
  // 最新自动验证结果
  lastAutoVerifyResult?: AutoVerifyResponse | null;
}

// Task 2: 恢复操作阶段指示器
interface RestorePhaseIndicatorProps {
  phase: string;
  progress: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const RESTORE_PHASES = [
  { key: 'pre_backup', minProgress: 0 },
  { key: 'restoring', minProgress: 25 },
  { key: 'verifying', minProgress: 70 },
  { key: 'finalizing', minProgress: 95 },
] as const;

const RestorePhaseIndicator: React.FC<RestorePhaseIndicatorProps> = ({ phase, progress, t }) => {
  // 根据 progress 和 phase 确定当前阶段
  const getPhaseIndex = () => {
    const phaseLower = phase.toLowerCase();
    if (phaseLower.includes('pre') || phaseLower.includes('backup') || phaseLower.includes('creating')) return 0;
    if (phaseLower.includes('restor') || phaseLower.includes('database') || phaseLower.includes('copy')) return 1;
    if (phaseLower.includes('verif') || phaseLower.includes('integrit') || phaseLower.includes('check')) return 2;
    if (phaseLower.includes('done') || phaseLower.includes('final') || phaseLower.includes('complet') || phaseLower.includes('restart')) return 3;
    // 按进度 fallback
    if (progress >= 95) return 3;
    if (progress >= 70) return 2;
    if (progress >= 25) return 1;
    return 0;
  };

  const currentPhaseIndex = getPhaseIndex();

  const phaseLabels = [
    t('data:governance.restore_phase_pre_backup'),
    t('data:governance.restore_phase_restoring'),
    t('data:governance.restore_phase_verifying'),
    t('data:governance.restore_phase_finalizing'),
  ];

  return (
    <div className="flex flex-col gap-1">
      {phaseLabels.map((label, idx) => (
        <div key={idx} className="flex items-center gap-2">
          {idx < currentPhaseIndex ? (
            <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
          ) : idx === currentPhaseIndex ? (
            <Loader2 className="h-3 w-3 text-primary animate-spin shrink-0" />
          ) : (
            <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />
          )}
          <span className={idx === currentPhaseIndex ? 'text-foreground font-medium' : idx < currentPhaseIndex ? 'text-muted-foreground line-through' : 'text-muted-foreground/50'}>
            {label}
          </span>
        </div>
      ))}
    </div>
  );
};

export const BackupTab: React.FC<BackupTabProps> = ({
  backups,
  loading,
  onRefresh,
  onBackupAndExportZip,
  onDeleteBackup,
  onVerifyBackup,
  onRestoreBackup,
  onExportZip,
  onImportZip,
  backupProgress,
  isBackupRunning,
  onCancelBackup,
  currentJobOperation,
  resumableJobs,
  onResumeJob,
  showRestartDialog,
  onRestartNow,
  onRestartLater,
  showRestorePromptDialog,
  onRestoreNow,
  onRestoreLater,
  verifyResult,
  showVerifyDialog,
  onCloseVerifyDialog,
  verificationStatusMap,
  lastAutoVerifyResult,
}) => {
  const { t } = useTranslation(['data', 'common', 'settings']);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);

  // 备份设置状态
  const [backupConfig, setBackupConfigState] = useState<BackupConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  // 加载备份配置
  const loadBackupConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const config = await getBackupConfig();
      setBackupConfigState(config);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showGlobalNotification(
        'error',
        message,
        t('data:governance.backup_config_load_failed')
      );
    } finally {
      setConfigLoading(false);
    }
  }, [t]);

  // 进入页面时加载配置
  useEffect(() => {
    if (!backupConfig && !configLoading) {
      loadBackupConfig();
    }
  }, [backupConfig, configLoading, loadBackupConfig]);

  // 保存备份配置
  const saveBackupConfig = useCallback(async (config: BackupConfig) => {
    setConfigSaving(true);
    try {
      await setBackupConfig(config);
      setBackupConfigState(config);
      showGlobalNotification(
        'success',
        t('data:governance.backup_config_saved')
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showGlobalNotification(
        'error',
        message,
        t('data:governance.backup_config_save_failed')
      );
    } finally {
      setConfigSaving(false);
    }
  }, [t]);

  // 防抖保存定时器：避免每次字段变更都立即落库+通知
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConfigRef = useRef<BackupConfig | null>(null);

  // 更新并保存单个配置字段（带 500ms 防抖）
  const updateConfigField = useCallback(<K extends keyof BackupConfig>(
    key: K,
    value: BackupConfig[K]
  ) => {
    if (!backupConfig) return;
    const newConfig = { ...backupConfig, [key]: value };
    setBackupConfigState(newConfig);
    pendingConfigRef.current = newConfig;

    // 清除之前的定时器
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    // 500ms 后落库
    saveTimerRef.current = setTimeout(() => {
      if (pendingConfigRef.current) {
        saveBackupConfig(pendingConfigRef.current);
        pendingConfigRef.current = null;
      }
    }, 500);
  }, [backupConfig, saveBackupConfig]);

  // 保持 saveBackupConfig 最新引用，供卸载 cleanup 使用
  const saveConfigRef = useRef(saveBackupConfig);
  saveConfigRef.current = saveBackupConfig;

  // 组件卸载时立即保存未落库的配置（空依赖，仅在真正卸载时执行）
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (pendingConfigRef.current) {
        saveConfigRef.current(pendingConfigRef.current);
        pendingConfigRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 备份层级选项 */
  const BACKUP_TIERS = useMemo(() => [
    { value: 'core' as BackupTier, label: t('settings:data_governance.backup_tiers.core_label'), desc: t('settings:data_governance.backup_tiers.core_desc') },
    { value: 'important' as BackupTier, label: t('settings:data_governance.backup_tiers.important_label'), desc: t('settings:data_governance.backup_tiers.important_desc') },
    { value: 'rebuildable' as BackupTier, label: t('settings:data_governance.backup_tiers.rebuildable_label'), desc: t('settings:data_governance.backup_tiers.rebuildable_desc') },
    { value: 'large_assets' as BackupTier, label: t('settings:data_governance.backup_tiers.large_assets_label'), desc: t('settings:data_governance.backup_tiers.large_assets_desc') },
  ], [t]);

  /** 资产类型选项 */
  const ASSET_TYPES = useMemo(() => [
    { value: 'images' as AssetType, label: t('settings:data_governance.asset_types.images'), icon: <Image className="h-4 w-4" /> },
    { value: 'notes_assets' as AssetType, label: t('settings:data_governance.asset_types.notes_assets'), icon: <FileText className="h-4 w-4" /> },
    { value: 'documents' as AssetType, label: t('settings:data_governance.asset_types.documents'), icon: <File className="h-4 w-4" /> },
    { value: 'vfs_blobs' as AssetType, label: t('settings:data_governance.asset_types.vfs_blobs'), icon: <Folder className="h-4 w-4" /> },
    { value: 'subjects' as AssetType, label: t('settings:data_governance.asset_types.subjects'), icon: <Folder className="h-4 w-4" /> },
    { value: 'workspaces' as AssetType, label: t('settings:data_governance.asset_types.workspaces'), icon: <Folder className="h-4 w-4" /> },
    { value: 'audio' as AssetType, label: t('settings:data_governance.asset_types.audio'), icon: <FileAudio className="h-4 w-4" /> },
    { value: 'videos' as AssetType, label: t('settings:data_governance.asset_types.videos'), icon: <FileVideo className="h-4 w-4" /> },
  ], [t]);
  const [actionType, setActionType] = useState<'delete' | 'restore' | 'export' | null>(null);
  // 分层备份状态
  const [useTieredBackup, setUseTieredBackup] = useState(false);
  const [addToBackupList, setAddToBackupList] = useState(true);
  const [selectedTiers, setSelectedTiers] = useState<BackupTier[]>(['core']);
  const [includeAssets, setIncludeAssets] = useState(false);
  const [selectedAssetTypes, setSelectedAssetTypes] = useState<AssetType[]>([]);
  const [compressionLevel, setCompressionLevel] = useState(6);

  const handleAction = async () => {
    if (!selectedBackup || !actionType) return;
    try {
      if (actionType === 'delete') {
        await onDeleteBackup(selectedBackup);
      } else if (actionType === 'restore') {
        await onRestoreBackup(selectedBackup);
      } else if (actionType === 'export') {
        await onExportZip(selectedBackup, compressionLevel);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showGlobalNotification(
        'error',
        message,
        t('data:governance.action_failed')
      );
    } finally {
      setSelectedBackup(null);
      setActionType(null);
    }
  };

  const handleTierToggle = (tier: BackupTier) => {
    setSelectedTiers((prev) =>
      prev.includes(tier) ? prev.filter((t) => t !== tier) : [...prev, tier]
    );
  };

  const handleAssetTypeToggle = (assetType: AssetType) => {
    setSelectedAssetTypes((prev) =>
      prev.includes(assetType)
        ? prev.filter((t) => t !== assetType)
        : [...prev, assetType]
    );
  };

  const handleBackupAndExport = () => {
    if (useTieredBackup && selectedTiers.length === 0) {
      showGlobalNotification(
        'warning',
        t('data:governance.tiered_backup_select_tier_first')
      );
      return;
    }

    onBackupAndExportZip({
      compressionLevel,
      addToBackupList,
      useTiered: useTieredBackup,
      tiers: useTieredBackup ? selectedTiers : undefined,
      includeAssets: useTieredBackup ? includeAssets : true,
      assetTypes: useTieredBackup && selectedAssetTypes.length > 0 ? selectedAssetTypes : undefined,
    });
  };

  return (
    <div className="space-y-8">
      {/* 可恢复任务提示 */}
      {resumableJobs && resumableJobs.length > 0 && !isBackupRunning && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
          <div className="flex items-center gap-2 font-medium text-warning">
            <AlertTriangle className="h-4 w-4" />
            {t('data:governance.resumable_jobs_title')}
          </div>
          {resumableJobs.map(job => (
            <div key={job.job_id} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {job.kind === 'export' ? t('data:governance.export') : t('data:governance.import')} - {job.phase} ({Math.round(job.progress)}%)
              </span>
              <NotionButton size="sm" onClick={() => onResumeJob?.(job.job_id)}>
                <Play className="h-3 w-3 mr-1" />
                {t('data:governance.resume')}
              </NotionButton>
            </div>
          ))}
        </div>
      )}

      {/* 备份进度显示 */}
      {isBackupRunning && backupProgress && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="font-medium text-sm">
                {currentJobOperation === 'zip_export'
                  ? t('data:governance.export_in_progress')
                  : currentJobOperation === 'zip_import'
                  ? t('data:governance.import_in_progress')
                  : currentJobOperation === 'restore'
                  ? t('data:governance.restore_in_progress')
                  : t('data:governance.backup_in_progress')}
              </span>
              {backupProgress.message && (
                <span className="text-xs text-muted-foreground">- {backupProgress.message}</span>
              )}
            </div>
            {backupProgress.cancellable && onCancelBackup && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={onCancelBackup}
                className="text-destructive hover:text-destructive"
              >
                <XCircle className="h-4 w-4 mr-1" />
                {t('common:cancel')}
              </NotionButton>
            )}
          </div>

          {/* Task 2: 恢复操作阶段详细信息 */}
          {currentJobOperation === 'restore' && (
            <div className="text-xs text-muted-foreground bg-background/50 rounded-md p-2 space-y-1">
              <RestorePhaseIndicator phase={backupProgress.phase} progress={backupProgress.progress} t={t} />
            </div>
          )}

          {/* 进度条 */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{backupProgress.phase}</span>
              <span>{Math.round(backupProgress.progress)}%</span>
            </div>
            <div className="h-2 bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${backupProgress.progress}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                {backupProgress.processed_items} / {backupProgress.total_items} {t('data:governance.items')}
              </span>
              {backupProgress.eta_seconds != null && backupProgress.eta_seconds > 0 && (
                <span>
                  {t('data:governance.eta')}: {formatDuration(backupProgress.eta_seconds * 1000)}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 导出备份 */}
      <div className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-base font-medium text-foreground">
            <Archive className="h-4 w-4" />
            {t('data:governance.export_backup')}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('data:governance.export_backup_desc')}
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="add-to-backup-list"
              checked={addToBackupList}
              onCheckedChange={(checked) => setAddToBackupList(Boolean(checked))}
              disabled={loading || isBackupRunning}
            />
            <Label htmlFor="add-to-backup-list" className="text-sm">
              {t('data:governance.add_to_backup_list')}
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="use-tiered-backup"
              checked={useTieredBackup}
              onCheckedChange={(checked) => setUseTieredBackup(Boolean(checked))}
              disabled={loading || isBackupRunning}
            />
            <Label htmlFor="use-tiered-backup" className="text-sm">
              {t('data:governance.use_tiered_backup')}
            </Label>
          </div>
        </div>

        {useTieredBackup && (
          <div className="space-y-4 pl-4 border-l-2 border-border/40">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BACKUP_TIERS.map((tier) => (
                <div
                  key={tier.value}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedTiers.includes(tier.value)
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/60 hover:border-border hover:bg-muted/30'
                  }`}
                  onClick={() => handleTierToggle(tier.value)}
                >
                  <Checkbox
                    checked={selectedTiers.includes(tier.value)}
                    onCheckedChange={() => handleTierToggle(tier.value)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-foreground">{tier.label}</div>
                    <div className="text-xs text-muted-foreground">{tier.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between py-2">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-foreground">
                  {t('data:governance.include_assets')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('data:governance.include_assets_desc')}
                </p>
              </div>
              <Switch checked={includeAssets} onCheckedChange={setIncludeAssets} />
            </div>

            {includeAssets && (
              <div className="space-y-3">
                <Label className="text-sm font-medium text-foreground">
                  {t('data:governance.select_asset_types')}
                </Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {ASSET_TYPES.map((asset) => (
                    <div
                      key={asset.value}
                      className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                        selectedAssetTypes.includes(asset.value)
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border/60 hover:border-border hover:bg-muted/30'
                      }`}
                      onClick={() => handleAssetTypeToggle(asset.value)}
                    >
                      <Checkbox
                        checked={selectedAssetTypes.includes(asset.value)}
                        onCheckedChange={() => handleAssetTypeToggle(asset.value)}
                      />
                      {asset.icon}
                      <span className="text-sm text-foreground">{asset.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 shrink-0 h-9">
            <Label className="text-sm text-muted-foreground whitespace-nowrap">
              {t('data:governance.compression_level')}
            </Label>
            <AppSelect
              value={String(compressionLevel)}
              onValueChange={(v) => setCompressionLevel(Number(v))}
              options={[
                { value: '0', label: '0', description: t('data:governance.compression_none') },
                { value: '1', label: '1', description: t('data:governance.compression_fast') },
                { value: '3', label: '3', description: t('data:governance.compression_light') },
                { value: '6', label: '6', description: t('data:governance.compression_balanced') },
                { value: '9', label: '9', description: t('data:governance.compression_max') },
              ]}
              className="w-20"
              width={180}
              variant="outline"
              size="sm"
              disabled={loading || isBackupRunning}
            />
          </div>
          <NotionButton
            variant="primary"
            size="sm"
            onClick={handleBackupAndExport}
            disabled={loading || isBackupRunning}
            className="h-9"
          >
            {isBackupRunning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Archive className="h-4 w-4 mr-2" />
            )}
            {t('data:governance.export_backup')}
          </NotionButton>
          <NotionButton
            variant="default"
            size="sm"
            onClick={onImportZip}
            disabled={loading || isBackupRunning}
            className="h-9"
          >
            <Upload className="h-4 w-4 mr-1.5" />
            {t('data:governance.import_button')}
          </NotionButton>
          <NotionButton variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="h-9">
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            {t('common:actions.refresh')}
          </NotionButton>
        </div>
      </div>

      <div className="border-t border-border/40" />

      {/* 备份设置 */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-base font-medium text-foreground">
          <Settings className="h-4 w-4" />
          {t('data:governance.backup_settings')}
        </div>

        {configLoading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common:status.loading')}
          </div>
        ) : backupConfig ? (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
              {t('data:governance.backup_settings_desc')}
            </p>

            {/* 自动备份开关 */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-foreground">
                  {t('data:governance.auto_backup')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('data:governance.auto_backup_desc')}
                </p>
              </div>
              <Switch
                checked={backupConfig.autoBackupEnabled}
                onCheckedChange={(checked) => updateConfigField('autoBackupEnabled', checked)}
                disabled={configSaving}
              />
            </div>

            {/* 自动备份间隔（仅在自动备份启用时显示） */}
            {backupConfig.autoBackupEnabled && (
              <div className="flex items-center justify-between pl-4 border-l-2 border-border/40">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium text-foreground">
                    {t('data:governance.auto_backup_interval')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('data:governance.auto_backup_interval_desc')}
                  </p>
                </div>
                <div className="w-40 shrink-0">
                  <AppSelect
                    value={String(backupConfig.autoBackupIntervalHours)}
                    onValueChange={(v) => updateConfigField('autoBackupIntervalHours', Number(v))}
                    options={[
                      { value: '6', label: t('data:governance.interval_6h') },
                      { value: '12', label: t('data:governance.interval_12h') },
                      { value: '24', label: t('data:governance.interval_24h') },
                      { value: '48', label: t('data:governance.interval_48h') },
                      { value: '72', label: t('data:governance.interval_72h') },
                    ]}
                    variant="outline"
                    size="sm"
                    disabled={configSaving}
                  />
                </div>
              </div>
            )}

            {/* 最大备份保留数 */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-foreground">
                  {t('data:governance.max_backup_count')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('data:governance.max_backup_count_desc')}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  className="w-20 h-8 text-sm"
                  value={backupConfig.maxBackupCount ?? ''}
                  placeholder={t('data:governance.max_backup_count_unlimited')}
                  disabled={configSaving}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') {
                      updateConfigField('maxBackupCount', null);
                    } else {
                      const num = Math.min(100, Math.max(1, parseInt(raw, 10)));
                      if (!isNaN(num)) {
                        updateConfigField('maxBackupCount', num);
                      }
                    }
                  }}
                />
              </div>
            </div>

            {/* 精简备份模式 */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-foreground">
                  {t('data:governance.slim_backup')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('data:governance.slim_backup_desc')}
                </p>
              </div>
              <Switch
                checked={backupConfig.slimBackup}
                onCheckedChange={(checked) => updateConfigField('slimBackup', checked)}
                disabled={configSaving}
              />
            </div>

            {/* 保存指示器 */}
            {configSaving && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('common:status.saving')}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="border-t border-border/40" />

      {/* 备份列表 */}
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium text-foreground">
            {t('data:governance.backup_list')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('data:governance.backup_list_desc')}
          </p>
        </div>

        <div className="rounded-lg border border-border/40 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/40">
                <TableHead className="h-10 whitespace-nowrap min-w-[120px]">{t('data:governance.backup_time')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[60px]">{t('data:governance.backup_type')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[70px]">{t('data:governance.backup_size')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[60px]">{t('data:governance.databases')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[80px]">{t('data:governance.verification_status')}</TableHead>
                <TableHead className="h-10 text-right whitespace-nowrap min-w-[120px]">{t('common:actions.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((backup) => (
                <TableRow key={backup.path} className="hover:bg-muted/30 border-border/40">
                  <TableCell className="font-medium py-3 whitespace-nowrap">
                    {formatTimestamp(backup.created_at)}
                  </TableCell>
                  <TableCell className="py-3">
                    <Badge variant={backup.backup_type === 'full' ? 'default' : 'secondary'} className="rounded-sm font-normal whitespace-nowrap">
                      {backup.backup_type === 'full'
                        ? t('data:governance.full')
                        : t('data:governance.incremental')}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-3 font-mono text-xs whitespace-nowrap">{formatBytes(backup.size)}</TableCell>
                  <TableCell className="py-3">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {backup.databases.length}{' '}
                      {t('data:governance.databases_count')}
                    </span>
                  </TableCell>
                  <TableCell className="py-3">
                    {(() => {
                      const status = verificationStatusMap?.[backup.path];
                      if (status === 'verified') {
                        return (
                          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 text-xs whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                            {t('data:governance.verification_verified')}
                          </div>
                        );
                      }
                      if (status === 'failed') {
                        return (
                          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 text-xs whitespace-nowrap">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {t('data:governance.verification_failed')}
                          </div>
                        );
                      }
                      if (status === 'verifying') {
                        return (
                          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400 text-xs whitespace-nowrap">
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                            {t('data:governance.verification_verifying')}
                          </div>
                        );
                      }
                      return (
                        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs whitespace-nowrap">
                          <Shield className="h-3 w-3 shrink-0" />
                          {t('data:governance.verification_unverified')}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-right py-3">
                    <div className="flex justify-end gap-1">
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => onVerifyBackup(backup.path)}
                        disabled={isBackupRunning}
                        title={t('data:governance.verify')}
                        aria-label={t('data:governance.verify')}
                      >
                        <Shield className="h-3.5 w-3.5" />
                      </NotionButton>
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          setSelectedBackup(backup.path);
                          setActionType('export');
                        }}
                        disabled={isBackupRunning}
                        title={t('data:governance.export_zip')}
                        aria-label={t('data:governance.export_zip')}
                      >
                        <FileOutput className="h-3.5 w-3.5" />
                      </NotionButton>
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          if (backup.backup_type === 'incremental') {
                            showGlobalNotification(
                              'warning',
                              t('data:governance.restore_incremental_not_supported')
                            );
                            return;
                          }
                          setSelectedBackup(backup.path);
                          setActionType('restore');
                        }}
                        disabled={isBackupRunning}
                        title={t('data:governance.restore')}
                        aria-label={t('data:governance.restore')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </NotionButton>
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setSelectedBackup(backup.path);
                          setActionType('delete');
                        }}
                        disabled={isBackupRunning}
                        title={t('common:actions.delete')}
                        aria-label={t('common:actions.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </NotionButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {backups.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('common:status.loading')}
                      </div>
                    ) : (
                      t('data:governance.no_backups')
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 确认对话框 */}
      <NotionAlertDialog
        open={selectedBackup !== null && actionType !== null}
        onOpenChange={() => {
          setSelectedBackup(null);
          setActionType(null);
        }}
        title={
          actionType === 'delete'
            ? t('data:governance.confirm_delete')
            : actionType === 'export'
            ? t('data:governance.confirm_export')
            : t('data:governance.confirm_restore')
        }
        description={
          actionType === 'delete'
            ? t('data:governance.delete_warning')
            : actionType === 'export'
            ? t('data:governance.export_warning', { level: compressionLevel })
            : t('data:governance.restore_warning')
        }
        confirmText={
          actionType === 'delete'
            ? t('common:actions.delete')
            : actionType === 'export'
            ? t('data:governance.export')
            : t('data:governance.restore')
        }
        cancelText={t('common:actions.cancel')}
        confirmVariant={actionType === 'delete' ? 'danger' : 'primary'}
        onConfirm={handleAction}
      />

      {/* Task 3: 恢复完成后重启提示对话框 */}
      <Dialog open={showRestartDialog} onOpenChange={(open) => { if (!open) onRestartLater?.(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              {t('data:governance.restore_complete_title')}
            </DialogTitle>
            <DialogDescription className="space-y-2">
              <p>
                {t('data:governance.restore_complete_desc')}
              </p>
              <p className="text-amber-600 dark:text-amber-400 font-medium">
                {t('data:governance.restore_save_work_warning')}
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:justify-end">
            <NotionButton variant="ghost" onClick={onRestartLater}>
              {t('data:governance.restart_later')}
            </NotionButton>
            <NotionButton variant="primary" onClick={onRestartNow}>
              <RotateCcw className="h-4 w-4 mr-2" />
              {t('data:governance.restart_now')}
            </NotionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导入完成后提示恢复对话框 */}
      <Dialog open={showRestorePromptDialog} onOpenChange={(open) => { if (!open) onRestoreLater?.(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="h-5 w-5 text-primary" />
              {t('data:governance.import_complete_title', '备份导入完成')}
            </DialogTitle>
            <DialogDescription className="space-y-2">
              <p>
                {t('data:governance.import_complete_desc', '备份文件已成功导入。是否立即恢复此备份？恢复将替换当前所有数据。')}
              </p>
              <p className="text-amber-600 dark:text-amber-400 font-medium">
                {t('data:governance.restore_save_work_warning')}
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:justify-end">
            <NotionButton variant="ghost" onClick={onRestoreLater}>
              {t('data:governance.restore_later', '稍后恢复')}
            </NotionButton>
            <NotionButton variant="primary" onClick={onRestoreNow}>
              <RotateCcw className="h-4 w-4 mr-2" />
              {t('data:governance.restore_now', '立即恢复')}
            </NotionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task 4: 备份验证结果详细对话框 */}
      <Dialog open={showVerifyDialog} onOpenChange={(open) => { if (!open) onCloseVerifyDialog?.(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              {t('data:governance.verify_result_title')}
            </DialogTitle>
            <DialogDescription>
              {verifyResult?.is_valid
                ? t('data:governance.verify_result_passed')
                : t('data:governance.verify_result_failed')}
            </DialogDescription>
          </DialogHeader>

          {verifyResult && (
            <div className="space-y-3">
              {/* 总体状态 */}
              <div className={`flex items-center gap-2 p-2 rounded-md ${
                verifyResult.is_valid
                  ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400'
                  : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400'
              }`}>
                {verifyResult.is_valid ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                <span className="font-medium text-sm">
                  {verifyResult.is_valid
                    ? t('data:governance.verify_overall_pass')
                    : t('data:governance.verify_overall_fail')}
                </span>
              </div>

              {/* 数据库验证列表 */}
              {verifyResult.databases_verified && verifyResult.databases_verified.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-foreground">
                    {t('data:governance.verify_databases_title')}
                  </div>
                  <div className="rounded-md border border-border/40 divide-y divide-border/40">
                    {verifyResult.databases_verified.map((db) => (
                      <div key={db.id} className="px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-foreground">
                            {getDatabaseDisplayName(db.id, t)}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {db.is_valid ? (
                              <>
                                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                <span className="text-xs text-green-600 dark:text-green-400">
                                  {t('data:governance.verify_db_pass')}
                                </span>
                              </>
                            ) : (
                              <>
                                <XCircle className="h-3.5 w-3.5 text-red-500" />
                                <span className="text-xs text-red-600 dark:text-red-400">
                                  {t('data:governance.verify_db_fail')}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        {!db.is_valid && db.error && (
                          <div className="mt-1 ml-0.5 text-xs text-destructive/80 bg-destructive/5 rounded px-2 py-1">
                            {db.error}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 错误详情 */}
              {verifyResult.errors && verifyResult.errors.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-destructive">
                    {t('data:governance.verify_errors_title')}
                  </div>
                  <div className="bg-destructive/5 rounded-md p-2 space-y-1">
                    {verifyResult.errors.map((err, idx) => (
                      <div key={idx} className="text-xs text-destructive flex items-start gap-1.5">
                        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>{err}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 数据库级别错误详情 */}
              {verifyResult.databases_verified?.some(db => !db.is_valid && db.error) && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-destructive">
                    {t('data:governance.verify_db_errors_title')}
                  </div>
                  <div className="bg-destructive/5 rounded-md p-2 space-y-1">
                    {verifyResult.databases_verified
                      .filter(db => !db.is_valid && db.error)
                      .map((db) => (
                        <div key={db.id} className="text-xs text-destructive flex items-start gap-1.5">
                          <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span><strong>{getDatabaseDisplayName(db.id, t)}:</strong> {db.error}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <NotionButton variant="default" onClick={onCloseVerifyDialog}>
              {t('common:actions.close')}
            </NotionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
