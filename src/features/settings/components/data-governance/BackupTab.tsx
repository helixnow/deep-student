/**
 * 备份管理标签页组件
 *
 * 从 DataGovernanceDashboard.tsx 拆分提取
 * 提供一键导出备份、ZIP 导入/导出、备份列表管理
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  Shield,
  CircleNotch,
  Play,
  Trash,
  XCircle,
  Warning,
  Archive,
  Upload,
  Image,
  FileText,
  File,
  Folder,
  FileAudio,
  FileVideo,
  CheckCircle,
  ArrowCounterClockwise,
  Gear,
  FileArrowDown,
} from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Badge } from '@/components/ui/shad/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shad/Table';
import { AppSelect } from '@/components/ui/app-menu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsAlertDialog, DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import { settingsQuietTableRowClassName } from '../SettingsCommon';
import { localizeCloudStorageError } from './localizeCloudError';
import type {
  BackupInfoResponse,
  BackupVerifyResponse,
  BackupTier,
  AssetType,
  AutoVerifyResponse,
} from '@/types/dataGovernance';
import {
  formatBytes,
  formatTimestamp,
  formatDuration,
  getDatabaseDisplayName,
} from '@/types/dataGovernance';
import type { BackupJobEvent, ResumableJob, BackupConfig } from '@/api/dataGovernance';
import { getBackupConfig, setBackupConfig } from '@/api/dataGovernance';
import { Input } from '@/components/ui/shad/Input';

export type BackupJobOperation = 'backup' | 'tiered_backup' | 'zip_export' | 'zip_import' | 'restore';

const isRestorableBackup = (backup: BackupInfoResponse): boolean =>
  backup.restorable ?? backup.backup_type === 'full';

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
    /** 可选 E2EE 备份密码：提供后导出加密全保真换机包 */
    encryptionPassword?: string;
  }) => void;
  onDeleteBackup: (backupId: string) => void;
  onVerifyBackup: (backupId: string) => void;
  onRestoreBackup: (backupId: string) => void;
  onExportZip: (backupId: string, compressionLevel: number, encryptionPassword?: string) => void;
  onImportZip: (password?: string) => void;
  // 后台任务相关
  backupProgress?: BackupJobEvent | null;
  isBackupRunning?: boolean;
  onCancelBackup?: () => void;
  /** 当前后台任务的操作类型（用于正确展示文案） */
  currentJobOperation?: BackupJobOperation | null;
  // 可恢复任务相关
  resumableJobs?: ResumableJob[];
  onResumeJob?: (jobId: string, password?: string) => void;
  // 恢复完成后重启对话框
  showRestartDialog?: boolean;
  onRestartNow?: () => void;
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

// Task 2: 恢复操作阶段指示器（细粒度：scan → verify → databases → assets → cleanup）
interface RestorePhaseIndicatorProps {
  phase: string;
  progress: number;
  message?: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const RestorePhaseIndicator: React.FC<RestorePhaseIndicatorProps> = ({ phase, progress, message, t }) => {
  // 根据后端 phase + progress 确定当前阶段索引
  // 后端阶段: scan(0-5%) → verify(5-15%) → replace/db(15-80%) → replace/assets(80-92%) → cleanup(92-100%)
  const getPhaseIndex = () => {
    const phaseLower = phase.toLowerCase();
    if (phaseLower === 'scan' || phaseLower === 'queued') return 0;
    if (phaseLower === 'verify') return 1;
    if (phaseLower === 'replace' || phaseLower === 'extract') {
      // replace 阶段内细分：数据库(15-80%) vs 资产(80-92%)
      if (progress >= 80 || (message && message.includes('资产'))) return 3;
      return 2;
    }
    if (phaseLower === 'cleanup' || phaseLower === 'completed') return 4;
    // 按进度 fallback
    if (progress >= 92) return 4;
    if (progress >= 80) return 3;
    if (progress >= 15) return 2;
    if (progress >= 5) return 1;
    return 0;
  };

  const currentPhaseIndex = getPhaseIndex();

  const phaseLabels = [
    t('data:governance.restore_phase_scan'),
    t('data:governance.restore_phase_verifying'),
    t('data:governance.restore_phase_restoring'),
    t('data:governance.restore_phase_assets'),
    t('data:governance.restore_phase_finalizing'),
  ];

  return (
    <div className="flex flex-col gap-1">
      {phaseLabels.map((label, idx) => (
        <div key={idx} className="flex items-center gap-2">
          {idx < currentPhaseIndex ? (
            <CheckCircle size={12} className="text-success shrink-0" />
          ) : idx === currentPhaseIndex ? (
            <CircleNotch size={12} className="text-primary animate-spin shrink-0" />
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
  showRestorePromptDialog,
  onRestoreNow,
  onRestoreLater,
  verifyResult,
  showVerifyDialog,
  onCloseVerifyDialog,
  verificationStatusMap,
  lastAutoVerifyResult,
}) => {
  const { t } = useTranslation(['data', 'common', 'settings', 'cloudStorage']);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);

  // 备份设置状态
  const [backupConfig, setBackupConfigState] = useState<BackupConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configLoadError, setConfigLoadError] = useState<string | null>(null);
  const configLoadAttemptedRef = useRef(false);

  // 加载备份配置
  const loadBackupConfig = useCallback(async (force = false) => {
    if (configLoadAttemptedRef.current && !force) return;
    configLoadAttemptedRef.current = true;
    setConfigLoading(true);
    setConfigLoadError(null);
    try {
      const config = await getBackupConfig();
      setBackupConfigState(config);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setConfigLoadError(message);
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
    if (!backupConfig && !configLoading && !configLoadError) {
      loadBackupConfig();
    }
  }, [backupConfig, configLoadError, configLoading, loadBackupConfig]);

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
    { value: 'textbooks' as AssetType, label: t('settings:data_governance.asset_types.textbooks'), icon: <Folder className="h-4 w-4" /> },
    { value: 'pdf_ocr_sessions' as AssetType, label: t('settings:data_governance.asset_types.pdf_ocr_sessions'), icon: <FileText className="h-4 w-4" /> },
  ], [t]);
  const [actionType, setActionType] = useState<'delete' | 'restore' | 'export' | null>(null);
  // 分层备份状态
  const [useTieredBackup, setUseTieredBackup] = useState(false);
  const [addToBackupList, setAddToBackupList] = useState(true);
  // R04-backup-defaults：默认勾选 core + important 且包含资产，
  // 使默认分层导出覆盖 vfs_blobs（文件库原始文件）等重要资产目录；用户仍可自由增减。
  const [selectedTiers, setSelectedTiers] = useState<BackupTier[]>(['core', 'important']);
  const [includeAssets, setIncludeAssets] = useState(true);
  const [selectedAssetTypes, setSelectedAssetTypes] = useState<AssetType[]>([]);
  const [compressionLevel, setCompressionLevel] = useState(6);
  const [isActionRunning, setIsActionRunning] = useState(false);
  // 备份密码（可选）：非空时密封凭据等敏感材料，使全保真包可整槽恢复。
  // 外层业务归档仍为明文，用户可见文案必须明确这一边界。
  const [encryptionPassword, setEncryptionPassword] = useState('');
  // 导入密码对话框
  const [showImportPasswordDialog, setShowImportPasswordDialog] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const [resumeImportJobId, setResumeImportJobId] = useState<string | null>(null);

  /** 与后端 MIN_ENCRYPTION_PASSWORD_CHARS / `chars().count()` 对齐（按 Unicode 标量，不是 UTF-16）。 */
  const MIN_E2EE_PASSWORD_CHARS = 8;

  /** 校验可选 E2EE 密码：为空视为不加密；非空则必须满足最小长度 */
  const validateOptionalPassword = (password: string): boolean => {
    if (password === '') return true;
    const trimmed = password.trim();
    if (trimmed.length === 0 || [...trimmed].length < MIN_E2EE_PASSWORD_CHARS) {
      showGlobalNotification(
        'warning',
        t('data:governance.e2ee_password_too_short', { min: MIN_E2EE_PASSWORD_CHARS })
      );
      return false;
    }
    return true;
  };

  const handleAction = async () => {
    if (!selectedBackup || !actionType || isActionRunning) return;
    if (actionType === 'export' && !validateOptionalPassword(encryptionPassword)) {
      return;
    }
    setIsActionRunning(true);
    try {
      if (actionType === 'delete') {
        await onDeleteBackup(selectedBackup);
      } else if (actionType === 'restore') {
        await onRestoreBackup(selectedBackup);
      } else if (actionType === 'export') {
        await onExportZip(selectedBackup, compressionLevel, encryptionPassword || undefined);
      }
    } catch (error: unknown) {
      showGlobalNotification(
        'error',
        localizeCloudStorageError(error, t),
        t('data:governance.action_failed')
      );
    } finally {
      setIsActionRunning(false);
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

  // vfs_blobs（文件库原始文件）只由 important 层的资产目录提供（见后端 BackupTier::asset_directories）：
  // 必须勾选 important 层并开启“包含资产文件”，且资产类型过滤为空（=全部）或显式包含 vfs_blobs。
  const tieredSelectionCoversVfsBlobs =
    includeAssets &&
    selectedTiers.includes('important') &&
    (selectedAssetTypes.length === 0 || selectedAssetTypes.includes('vfs_blobs'));

  const handleBackupAndExport = () => {
    if (useTieredBackup && selectedTiers.length === 0) {
      showGlobalNotification(
        'warning',
        t('data:governance.tiered_backup_select_tier_first')
      );
      return;
    }
    if (!validateOptionalPassword(encryptionPassword)) {
      return;
    }

    onBackupAndExportZip({
      compressionLevel,
      addToBackupList,
      useTiered: useTieredBackup,
      tiers: useTieredBackup ? selectedTiers : undefined,
      includeAssets: useTieredBackup ? includeAssets : true,
      assetTypes: useTieredBackup && selectedAssetTypes.length > 0 ? selectedAssetTypes : undefined,
      encryptionPassword: encryptionPassword || undefined,
    });
  };

  // 导入是对既有密文的解密：故意不做最小长度校验。v0.9.44 允许任意长度的
  // 备份密码，换机/重装用户必须能用存量短口令解开旧加密 ZIP；口令错误由
  // 解封层 fail-closed（E_BACKUP_SEALED_DECRYPT_FAILED）。最小长度只约束
  // 导出（新设口令）路径。
  const handleImportConfirm = () => {
    if (resumeImportJobId && importPassword === '') {
      showGlobalNotification(
        'warning',
        t('data:governance.import_sealed_password_required')
      );
      return;
    }
    setShowImportPasswordDialog(false);
    if (resumeImportJobId) {
      onResumeJob?.(resumeImportJobId, importPassword);
      setResumeImportJobId(null);
    } else {
      onImportZip(importPassword || undefined);
    }
    setImportPassword('');
  };

  const handleResumeJob = (job: ResumableJob) => {
    if (job.kind === 'import' && job.requires_password) {
      setResumeImportJobId(job.job_id);
      setImportPassword('');
      setShowImportPasswordDialog(true);
      return;
    }
    onResumeJob?.(job.job_id);
  };

  // 恢复入口的前置校验：桌面表格行与移动卡片共用
  const handleRestoreClick = (backup: BackupInfoResponse) => {
    if (backup.backup_type === 'incremental') {
      showGlobalNotification(
        'warning',
        t('data:governance.restore_incremental_not_supported')
      );
      return;
    }
    if (!isRestorableBackup(backup)) {
      showGlobalNotification(
        'warning',
        t('data:governance.restore_non_full_not_supported')
      );
      return;
    }
    setSelectedBackup(backup.path);
    setActionType('restore');
  };

  // 备份类型徽标：桌面表格与移动卡片共用（仅展示层）
  const renderBackupTypeBadge = (backup: BackupInfoResponse) => (
    <Badge
      variant={
        backup.backup_type === 'full'
          ? 'default'
          : backup.backup_type === 'incremental'
            ? 'destructive'
            : 'secondary'
      }
      className="rounded-sm font-normal whitespace-nowrap"
      title={
        backup.backup_type === 'incremental'
          ? t('data:governance.incremental_legacy_unsupported')
          : undefined
      }
    >
      {backup.recovery_kind === 'partial_archive'
        ? t('data:governance.partial_archive', { defaultValue: 'Partial archive' })
        : backup.backup_type === 'full'
        ? t('data:governance.full')
        : backup.backup_type === 'incremental'
        ? t('data:governance.incremental_legacy_unsupported')
        : backup.backup_type === 'partial_overlay'
        ? t('data:governance.partial_overlay')
        : t('data:governance.legacy_unknown')}
    </Badge>
  );

  // 验证状态徽标：桌面表格与移动卡片共用（仅展示层）
  const renderVerificationBadge = (backup: BackupInfoResponse) => {
    const status = verificationStatusMap?.[backup.path];
    if (status === 'verified') {
      return (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-success/10 text-success text-xs whitespace-nowrap">
          <CheckCircle size={12} className="shrink-0" />
          {t('data:governance.verification_verified')}
        </div>
      );
    }
    if (status === 'failed') {
      return (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-xs whitespace-nowrap">
          <Warning size={12} className="shrink-0" />
          {t('data:governance.verification_failed')}
        </div>
      );
    }
    if (status === 'verifying') {
      return (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-info/10 text-info text-xs whitespace-nowrap">
          <CircleNotch size={12} className="shrink-0 animate-spin" />
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
  };

  return (
    <div className="space-y-8">
      {/* 可恢复任务提示 */}
      {resumableJobs && resumableJobs.length > 0 && !isBackupRunning && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
          <div className="flex items-center gap-2 font-medium text-warning">
            <Warning size={16} />
            {t('data:governance.resumable_jobs_title')}
          </div>
          {resumableJobs.map(job => (
            <div key={job.job_id} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {job.kind === 'export' ? t('data:governance.export') : t('data:governance.import')} - {job.phase} ({Math.round(job.progress)}%)
              </span>
              <DsButton size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={() => handleResumeJob(job)}>
                <Play className="h-3 w-3 mr-1" />
                {t('data:governance.resume')}
              </DsButton>
            </div>
          ))}
        </div>
      )}

      {/* 备份进度显示 */}
      {isBackupRunning && backupProgress && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CircleNotch size={16} className="animate-spin text-primary" />
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
              <DsButton
                variant="ghost"
                size="sm"
                onClick={onCancelBackup}
                className="text-destructive hover:text-destructive [@media(pointer:coarse)]:!min-h-11"
              >
                <XCircle className="h-4 w-4 mr-1" />
                {t('common:cancel')}
              </DsButton>
            )}
          </div>

          {/* Task 2: 恢复操作阶段详细信息 */}
          {currentJobOperation === 'restore' && (
            <div className="text-xs text-muted-foreground bg-background/50 rounded-md p-2 space-y-1">
              <RestorePhaseIndicator phase={backupProgress.phase} progress={backupProgress.progress} message={backupProgress.message} t={t} />
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
          {encryptionPassword ? (
            <p className="text-xs text-success">
              {t('data:governance.e2ee_export_note', {
                defaultValue:
                  '已设置备份密码：API 凭据、密钥等敏感材料会被加密保护，输入同一密码后可整槽恢复；聊天记录、错题、文件等归档内容本身未加密，请勿通过不可信渠道传播。丢失密码后业务数据仍可读取，但凭据和整槽恢复资格将丢失。',
              })}
            </p>
          ) : (
            <p className="text-xs text-warning">
              {t('data:governance.portable_zip_honest_note', {
                defaultValue:
                  '未加密的导出 ZIP 是便携归档：不包含本地加密密钥与审计记录，在其他设备导入后不能整槽恢复，API 密钥等凭据需要重新录入。',
              })}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2 [@media(pointer:coarse)]:min-h-11">
            <Checkbox
              id="add-to-backup-list"
              className="relative [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3.5"
              checked={addToBackupList}
              onCheckedChange={(checked) => setAddToBackupList(Boolean(checked))}
              disabled={loading || isBackupRunning}
            />
            <Label htmlFor="add-to-backup-list" className="flex items-center text-sm [@media(pointer:coarse)]:min-h-11">
              {t('data:governance.add_to_backup_list')}
            </Label>
          </div>

          <div className="flex items-center gap-2 [@media(pointer:coarse)]:min-h-11">
            <Checkbox
              id="use-tiered-backup"
              className="relative [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3.5"
              checked={useTieredBackup}
              onCheckedChange={(checked) => setUseTieredBackup(Boolean(checked))}
              disabled={loading || isBackupRunning}
            />
            <Label htmlFor="use-tiered-backup" className="flex items-center text-sm [@media(pointer:coarse)]:min-h-11">
              {t('data:governance.use_tiered_backup')}
            </Label>
          </div>

          {/* E2EE 备份密码（可选）：非空时导出加密全保真换机包 */}
          <div className="space-y-1.5">
            <Label htmlFor="e2ee-export-password" className="text-sm">
              {t('data:governance.e2ee_password_label')}
            </Label>
            <Input
              id="e2ee-export-password"
              type="password"
              autoComplete="new-password"
              className="max-w-sm h-8 text-sm"
              value={encryptionPassword}
              placeholder={t('data:governance.e2ee_password_placeholder')}
              disabled={loading || isBackupRunning}
              onChange={(e) => setEncryptionPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('data:governance.e2ee_password_hint', { min: MIN_E2EE_PASSWORD_CHARS })}
            </p>
          </div>
        </div>

        {useTieredBackup && (
          <div className="space-y-4 pl-4 border-l-2 border-border/40">
            <p className="text-xs text-warning">
              {t('data:governance.tiered_backup_honest_note', {
                defaultValue:
                  '分层备份（包括默认的核心层）只覆盖所选层级，产物是部分归档，不能整槽恢复，仅支持导出与检查。',
              })}
            </p>
            {!tieredSelectionCoversVfsBlobs && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
              >
                <Warning size={14} className="mt-0.5 shrink-0" />
                <span>
                  {t('data:governance.tiered_backup_vfs_blobs_missing_warning', {
                    defaultValue:
                      '当前选择不包含文件库原始文件（vfs_blobs）：导出的部分归档不能整槽恢复，vfs_blobs 中的文件也无法从该归档找回。如需覆盖，请勾选「重要数据 (P1)」层级并开启「包含资产文件」（若筛选了资产类型，需保留 vfs_blobs）。',
                  })}
                </span>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BACKUP_TIERS.map((tier) => (
                <div
                  key={tier.value}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedTiers.includes(tier.value)
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/60 hover:border-border hover:bg-[color:var(--sidebar-quiet-hover)]'
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
              <Switch
                checked={includeAssets}
                onCheckedChange={setIncludeAssets}
                aria-label={t('data:governance.include_assets')}
              />
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
                      className={`flex items-center gap-2 p-2 [@media(pointer:coarse)]:min-h-11 rounded-md border cursor-pointer transition-colors ${
                        selectedAssetTypes.includes(asset.value)
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border/60 hover:border-border hover:bg-[color:var(--sidebar-quiet-hover)]'
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
          <DsButton
            variant="primary"
            size="sm"
            onClick={handleBackupAndExport}
            disabled={loading || isBackupRunning}
            className="h-9 [@media(pointer:coarse)]:!h-11"
          >
            {isBackupRunning ? (
              <CircleNotch size={16} className="mr-2 animate-spin" />
            ) : (
              <Archive className="h-4 w-4 mr-2" />
            )}
            {t('data:governance.export_backup')}
          </DsButton>
          <DsButton
            variant="default"
            size="sm"
            onClick={() => {
              setResumeImportJobId(null);
              setShowImportPasswordDialog(true);
            }}
            disabled={loading || isBackupRunning}
            className="h-9 [@media(pointer:coarse)]:!h-11"
          >
            <Upload className="h-4 w-4 mr-1.5" />
            {t('data:governance.import_button')}
          </DsButton>
          <DsButton variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="h-9 [@media(pointer:coarse)]:!h-11">
            <ArrowClockwise size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} />
            {t('common:actions.refresh')}
          </DsButton>
        </div>
      </div>

      <div className="border-t border-border/40" />

      {/* 备份设置 */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-base font-medium text-foreground">
          <Gear size={16} />
          {t('data:governance.backup_settings')}
        </div>

        {configLoading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
            <CircleNotch size={16} className="animate-spin" />
            {t('common:status.loading')}
          </div>
        ) : configLoadError ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <div className="min-w-0 text-sm text-destructive">
              {t('data:governance.backup_config_load_failed')}: {configLoadError}
            </div>
            <DsButton
              variant="ghost"
              size="sm"
              className="[@media(pointer:coarse)]:!min-h-11"
              onClick={() => void loadBackupConfig(true)}
            >
              <ArrowClockwise size={14} className="mr-1.5" />
              {t('common:actions.retry')}
            </DsButton>
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
                  className="w-20 h-8 [@media(pointer:coarse)]:h-11 text-sm"
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

            {/* 保存指示器 */}
            {configSaving && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CircleNotch size={12} className="animate-spin" />
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

        {/* ≥md：原宽表；<md：下方卡片列表（同 DimensionManagement 的响应式模式，仅展示层） */}
        <div className="hidden md:block">
        <CustomScrollArea
          orientation="horizontal"
          fullHeight={false}
          className="rounded-lg border border-border/40"
        >
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
                <TableRow key={backup.path} className={settingsQuietTableRowClassName}>
                  <TableCell className="font-medium py-3 whitespace-nowrap">
                    {formatTimestamp(backup.created_at)}
                  </TableCell>
                  <TableCell className="py-3">
                    {renderBackupTypeBadge(backup)}
                  </TableCell>
                  <TableCell className="py-3 font-mono text-xs whitespace-nowrap">{formatBytes(backup.size)}</TableCell>
                  <TableCell className="py-3">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {backup.databases.length}{' '}
                      {t('data:governance.databases_count')}
                    </span>
                  </TableCell>
                  <TableCell className="py-3">{renderVerificationBadge(backup)}</TableCell>
                  <TableCell className="text-right py-3">
                    <div className="flex justify-end gap-1">
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 max-md:min-h-11 max-md:min-w-11 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                        onClick={() => onVerifyBackup(backup.path)}
                        disabled={isBackupRunning}
                        title={t('data:governance.verify')}
                        aria-label={t('data:governance.verify')}
                      >
                        <Shield className="h-3.5 w-3.5" />
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 max-md:min-h-11 max-md:min-w-11 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                        onClick={() => {
                          setSelectedBackup(backup.path);
                          setActionType('export');
                        }}
                        disabled={isBackupRunning}
                        title={t('data:governance.export_zip')}
                        aria-label={t('data:governance.export_zip')}
                      >
                        <FileArrowDown size={14} />
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 max-md:min-h-11 max-md:min-w-11 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                        onClick={() => handleRestoreClick(backup)}
                        disabled={isBackupRunning}
                        title={
                          isRestorableBackup(backup)
                            ? t('data:governance.restore')
                            : t('data:governance.partial_archive_not_restorable', {
                                defaultValue: 'Partial archives cannot replace the data slot',
                              })
                        }
                        aria-label={t('data:governance.restore')}
                      >
                        <ArrowCounterClockwise size={14} />
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 max-md:min-h-11 max-md:min-w-11 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setSelectedBackup(backup.path);
                          setActionType('delete');
                        }}
                        disabled={isBackupRunning}
                        title={t('common:actions.delete')}
                        aria-label={t('common:actions.delete')}
                      >
                        <Trash size={14} />
                      </DsButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {backups.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <CircleNotch size={16} className="animate-spin" />
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
        </CustomScrollArea>
        </div>

        {/* <md：卡片列表（信息与动作同上表；动作按钮走 DsButton icon 契约，<lg 天然 44px） */}
        <div className="space-y-2 md:hidden">
          {backups.map((backup) => (
            <div
              key={backup.path}
              className="rounded-md border border-border/40 bg-background/50 p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{formatTimestamp(backup.created_at)}</span>
                {renderBackupTypeBadge(backup)}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="font-mono text-xs text-muted-foreground">{formatBytes(backup.size)}</span>
                <span className="text-xs text-muted-foreground">
                  {backup.databases.length} {t('data:governance.databases_count')}
                </span>
                {renderVerificationBadge(backup)}
              </div>
              <div className="flex items-center gap-1 border-t border-border/40 pt-1.5">
                <DsButton
                  variant="ghost"
                  size="icon"
                  onClick={() => onVerifyBackup(backup.path)}
                  disabled={isBackupRunning}
                  aria-label={t('data:governance.verify')}
                >
                  <Shield className="h-4 w-4" />
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSelectedBackup(backup.path);
                    setActionType('export');
                  }}
                  disabled={isBackupRunning}
                  aria-label={t('data:governance.export_zip')}
                >
                  <FileArrowDown size={16} />
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRestoreClick(backup)}
                  disabled={isBackupRunning}
                  aria-label={t('data:governance.restore')}
                >
                  <ArrowCounterClockwise size={16} />
                </DsButton>
                <div className="flex-1" />
                <DsButton
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    setSelectedBackup(backup.path);
                    setActionType('delete');
                  }}
                  disabled={isBackupRunning}
                  aria-label={t('common:actions.delete')}
                >
                  <Trash size={16} />
                </DsButton>
              </div>
            </div>
          ))}
          {backups.length === 0 && (
            <div className="rounded-md border border-border/40 py-8 text-center text-muted-foreground">
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <CircleNotch size={16} className="animate-spin" />
                  {t('common:status.loading')}
                </div>
              ) : (
                t('data:governance.no_backups')
              )}
            </div>
          )}
        </div>
      </div>

      {/* 确认对话框 */}
      <DsAlertDialog
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
            ? encryptionPassword
              ? t('data:governance.export_warning_encrypted', { level: compressionLevel })
              : t('data:governance.export_warning', { level: compressionLevel })
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
        // [R10-ux] 恢复会用备份覆盖当前数据槽（重启后切换），与云端恢复
        // （CloudStorageSection warning）、库级冲突覆盖（SyncTab warning/danger）
        // 同级，不能用 primary；导出不改动数据保持 primary。
        confirmVariant={
          actionType === 'delete'
            ? 'danger'
            : actionType === 'restore'
            ? 'warning'
            : 'primary'
        }
        onConfirm={handleAction}
        loading={isActionRunning}
        disabled={isActionRunning}
      />

      {/* 导入 ZIP：新导入可留空；密封敏感材料包的续传必须重新输入密码 */}
      <DsDialog
        open={showImportPasswordDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowImportPasswordDialog(false);
            setImportPassword('');
            setResumeImportJobId(null);
          }
        }}
        maxWidth="max-w-md"
      >
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            {t(resumeImportJobId
              ? 'data:governance.resume_import_password_title'
              : 'data:governance.import_password_title')}
          </DsDialogTitle>
          <DsDialogDescription>
            {t(resumeImportJobId
              ? 'data:governance.resume_import_password_desc'
              : 'data:governance.import_password_desc')}
          </DsDialogDescription>
        </DsDialogHeader>
        <DsDialogBody>
          <div className="space-y-1.5">
            <Label htmlFor="e2ee-import-password" className="text-sm">
              {t('data:governance.import_password_label')}
            </Label>
            <Input
              id="e2ee-import-password"
              type="password"
              autoComplete="current-password"
              className="h-8 text-sm"
              value={importPassword}
              placeholder={t('data:governance.import_password_placeholder')}
              required={resumeImportJobId !== null}
              onChange={(e) => setImportPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleImportConfirm();
              }}
            />
          </div>
        </DsDialogBody>
        <DsDialogFooter>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowImportPasswordDialog(false);
              setImportPassword('');
              setResumeImportJobId(null);
            }}
          >
            {t('common:actions.cancel')}
          </DsButton>
          <DsButton variant="primary" size="sm" onClick={handleImportConfirm}>
            {resumeImportJobId ? (
              <Play className="h-4 w-4 mr-1.5" />
            ) : (
              <Upload className="h-4 w-4 mr-1.5" />
            )}
            {t(resumeImportJobId
              ? 'data:governance.resume'
              : 'data:governance.import_button')}
          </DsButton>
        </DsDialogFooter>
      </DsDialog>

      {/* Task 3: 恢复完成后重启提示对话框 */}
      <DsDialog open={showRestartDialog} onOpenChange={() => undefined}>
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2">
            <CheckCircle size={20} className="text-success" />
            {t('data:governance.restore_complete_title')}
          </DsDialogTitle>
          <DsDialogDescription>
            <p>{t('data:governance.restore_complete_desc')}</p>
            <p className="text-warning font-medium mt-1">{t('data:governance.restore_save_work_warning')}</p>
          </DsDialogDescription>
        </DsDialogHeader>
        <DsDialogFooter>
          <DsButton variant="primary" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={onRestartNow}>
            <ArrowCounterClockwise size={16} className="mr-2" />
            {t('data:governance.restart_now')}
          </DsButton>
        </DsDialogFooter>
      </DsDialog>

      {/* 导入完成后提示恢复对话框 */}
      <DsDialog open={showRestorePromptDialog} onOpenChange={(open) => { if (!open) onRestoreLater?.(); }}>
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-primary" />
            {t('data:governance.import_complete_title')}
          </DsDialogTitle>
          <DsDialogDescription>
            <p>{t('data:governance.import_complete_desc')}</p>
            <p className="text-warning font-medium mt-1">{t('data:governance.restore_save_work_warning')}</p>
          </DsDialogDescription>
        </DsDialogHeader>
        <DsDialogFooter>
          <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={onRestoreLater}>
            {t('data:governance.restore_later')}
          </DsButton>
          <DsButton variant="primary" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={onRestoreNow}>
            <ArrowCounterClockwise size={16} className="mr-2" />
            {t('data:governance.restore_now')}
          </DsButton>
        </DsDialogFooter>
      </DsDialog>

      {/* Task 4: 备份验证结果详细对话框 */}
      <DsDialog open={showVerifyDialog} onOpenChange={(open) => { if (!open) onCloseVerifyDialog?.(); }} maxWidth="max-w-md">
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t('data:governance.verify_result_title')}
          </DsDialogTitle>
          <DsDialogDescription>
            {verifyResult?.is_valid
              ? t('data:governance.verify_result_passed')
              : t('data:governance.verify_result_failed')}
          </DsDialogDescription>
        </DsDialogHeader>
        <DsDialogBody overlayScroll>

          {verifyResult && (
            <div className="space-y-3">
              {/* 总体状态 */}
              <div className={`flex items-center gap-2 p-2 rounded-md ${
                verifyResult.is_valid
                  ? 'bg-success/10 text-success'
                  : 'bg-destructive/10 text-destructive'
              }`}>
                {verifyResult.is_valid ? (
                  <CheckCircle size={16} />
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
                                <CheckCircle size={14} className="text-success" />
                                <span className="text-xs text-success">
                                  {t('data:governance.verify_db_pass')}
                                </span>
                              </>
                            ) : (
                              <>
                                <XCircle className="h-3.5 w-3.5 text-destructive" />
                                <span className="text-xs text-destructive">
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

        </DsDialogBody>
        <DsDialogFooter>
          <DsButton variant="default" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={onCloseVerifyDialog}>
            {t('common:actions.close')}
          </DsButton>
        </DsDialogFooter>
      </DsDialog>
    </div>
  );
};
