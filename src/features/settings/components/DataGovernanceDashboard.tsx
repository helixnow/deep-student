/**
 * 数据治理 Dashboard 组件
 *
 * 提供数据库状态概览、备份管理、同步状态、审计日志功能
 *
 * 子组件已拆分至 data-governance/ 目录：
 * - OverviewTab: 概览标签页
 * - BackupTab: 备份管理标签页
 * - SyncTab: 同步标签页
 * - AuditTab: 审计日志标签页
 */

import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Bug,
  Cloud,
  FileText,
  Gauge,
  HardDrive,
  Image,
  ArrowsClockwise,
  Warning,
  XCircle,
  Play,
  Database,
  Trash,
  CircleNotch,
  ShieldCheck,
  Upload,
  ArrowCounterClockwise,
} from '@phosphor-icons/react';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/shad/Tabs';
import { Badge } from '@/components/ui/shad/Badge';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { SecurityStatusIndicator } from '@/components/SecurityStatusIndicator';
import { SettingSection } from './SettingsCommon';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { readShellPlatform } from '@/ui-kernel/services/shell-platform';
import { isAndroidMobileShell, isWebUiShell } from '@/utils/platform';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import * as cloudApi from '@/utils/cloudStorageApi';
import {
  formatFriendlySyncError,
  localizeBackendErrorText,
  localizeCloudStorageError,
  notifyErrorDeduped,
  shouldNotifyDeduped,
} from './data-governance/localizeCloudError';

import {
  DataGovernanceApi,
  type BackupJobEvent,
  type ResumableJob,
  type DiskSpaceCheckResponse,
} from '@/api/dataGovernance';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MediaCacheSection } from './MediaCacheSection';
import { LanceOptimizationPanel } from './IndexMaintenanceSection';
import { GroupTitle } from './settingsTabPrimitives';
import { useShallow } from 'zustand/react/shallow';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { createFailedSyncProgress, useGlobalSyncStore } from '@/stores/syncStatusStore';
import { useBackupJobListener } from '@/hooks/useBackupJobListener';
import type {
  DashboardTab,
  HealthCheckResponse,
  MigrationStatusResponse,
  BackupInfoResponse,
  BackupVerifyResponse,
  AutoVerifyResponse,
  SyncStatusResponse,
  ConflictDetectionResponse,
  SyncProgress,
  AuditLogResponse,
  AuditOperationType,
  AuditStatus,
  MergeStrategy,
} from '@/types/dataGovernance';
import {
  INCREMENTAL_BACKUP_REMOVED_MESSAGE,
  INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE,
  formatBytes,
  formatTimestamp,
  getDatabaseDisplayName,
} from '@/types/dataGovernance';
import { APP_EVENTS, useAppEvent } from '@/events';
import { QuickSyncNowButton, probeStoredCloudConfigured } from './QuickSyncNowButton';
import {
  BackupImportDialog,
  buildSnapshotAriaLabelMap,
  isPreRestoreSafetySnapshot,
} from './data-governance/BackupImportDialog';
import { open, save } from '@tauri-apps/plugin-dialog';
import { TauriAPI } from '@/utils/tauriApi';

// 拆分后的子组件
import { OverviewTab } from './data-governance/OverviewTab';
import { BackupTab, type BackupJobOperation, type BackupVerificationStatus } from './data-governance/BackupTab';
import { SyncTab } from './data-governance/SyncTab';
import { AuditTab } from './data-governance/AuditTab';
import { ChatSessionArchiveTab } from './data-governance/ChatSessionArchiveTab';
import { DataMaintenanceSection } from './data-governance/DataMaintenanceSection';
import { RecoveryCenter } from '@/features/data-recovery/RecoveryCenter';
import {
  createPartialDegradationDebugIssues,
  setRecoveryDebugScenario,
  type RecoveryDebugScenario,
} from '@/features/data-recovery/debugRecoveryScenarios';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** 备份/恢复/导出/导入任务生命周期通知复用键：新状态原子替换在途 info，避免「已完成」与「进行中」同屏叠放 */
const BACKUP_JOB_NOTIFICATION_KEY = 'data-governance:backup-job';

const notifyBackupJobError = (message: string) => {
  if (!shouldNotifyDeduped('error', message)) return;
  showGlobalNotification('error', message, undefined, {
    replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
  });
};

/**
 * Debug 页签是否可见。
 *
 * 生产构建里该页签的每个控件都被 `disabled={!import.meta.env.DEV}` 灰掉，
 * 页签本身却照常渲染 —— 用户（移动端更只看得到一个虫子图标）点进去
 * 只会看到一屏无法操作的按钮。实现保留，入口只在开发构建暴露。
 */
const isDebugTabEnabled = (): boolean => import.meta.env.DEV;

// ==================== 调试面板（DEV only） ====================

export const DebugTab: React.FC = () => {
  const { t } = useTranslation(['data', 'common']);
  const { showMigrationStatus, clearMigrationStatus, setComponentHealth } = useSystemStatusStore(
    useShallow((state) => ({
      showMigrationStatus: state.showMigrationStatus,
      clearMigrationStatus: state.clearMigrationStatus,
      setComponentHealth: state.setComponentHealth,
    }))
  );
  const [flowRunning, setFlowRunning] = useState(false);
  const [slotCTestRunning, setSlotCTestRunning] = useState(false);
  const [slotDTestRunning, setSlotDTestRunning] = useState(false);
  const [slotCResult, setSlotCResult] = useState<{ success: boolean; report: string; finishedAt: string } | null>(null);
  const [slotDResult, setSlotDResult] = useState<{ success: boolean; report: string; finishedAt: string } | null>(null);
  const flowTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [showPurgeDialog, setShowPurgeDialog] = useState(false);
  const [isPurgeRunning, setIsPurgeRunning] = useState(false);
  const componentHealthBeforePreviewRef = useRef(
    useSystemStatusStore.getState().componentHealth,
  );
  const partialPreviewActiveRef = useRef(false);

  const openRecoveryScenario = useCallback((scenario: RecoveryDebugScenario) => {
    if (!import.meta.env.DEV) return;
    setRecoveryDebugScenario(scenario);
    window.location.reload();
  }, []);

  const previewPartialDegradation = useCallback(() => {
    if (!import.meta.env.DEV) return;
    if (!partialPreviewActiveRef.current) {
      componentHealthBeforePreviewRef.current =
        useSystemStatusStore.getState().componentHealth;
      partialPreviewActiveRef.current = true;
    }
    setComponentHealth(createPartialDegradationDebugIssues());
    showMigrationStatus({
      level: 'error',
      message: t('data:governance.debug_partial_degradation_message'),
      details: t('data:governance.debug_partial_degradation_details'),
    });
    showGlobalNotification(
      'info',
      t('data:governance.debug_partial_degradation_hint'),
    );
  }, [setComponentHealth, showMigrationStatus, t]);

  const clearPartialDegradationPreview = useCallback(() => {
    setComponentHealth(componentHealthBeforePreviewRef.current);
    clearMigrationStatus();
    partialPreviewActiveRef.current = false;
  }, [clearMigrationStatus, setComponentHealth]);

  const handlePurgeAllData = useCallback(async () => {
    if (isPurgeRunning) return;
    setIsPurgeRunning(true);
    try {
      await DataGovernanceApi.purgeAllData();
      showGlobalNotification('info', t('data:governance.purge_initiated'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showGlobalNotification('error', message, t('data:governance.purge_failed'));
      setIsPurgeRunning(false);
    }
  }, [isPurgeRunning, t]);

  // 清理所有定时器
  useEffect(() => {
    return () => {
      for (const timer of flowTimersRef.current) {
        clearTimeout(timer);
      }
      flowTimersRef.current = [];
    };
  }, []);

  const triggerWarning = useCallback(() => {
    showMigrationStatus({
      level: 'warning',
      message: t('data:governance.listener_migration_warning_title'),
      details: t('data:governance.debug_warning_details'),
    });
  }, [showMigrationStatus, t]);

  const triggerError = useCallback(() => {
    showMigrationStatus({
      level: 'error',
      message: t('data:governance.listener_migration_failed_title'),
      details: 'Refinery error: `error applying migrations`, `FOREIGN KEY constraint failed`',
    });
  }, [showMigrationStatus, t]);

  const triggerInfo = useCallback(() => {
    showMigrationStatus({
      level: 'info',
      message: t('data:governance.debug_info_message'),
      details: t('data:governance.debug_info_details'),
    });
  }, [showMigrationStatus, t]);

  const simulateFlow = useCallback(() => {
    if (flowRunning) return;
    setFlowRunning(true);

    // 清理之前残留的定时器
    for (const timer of flowTimersRef.current) {
      clearTimeout(timer);
    }
    flowTimersRef.current = [];

    // Step 1: error
    showMigrationStatus({
      level: 'error',
      message: t('data:governance.debug_flow_error_message'),
      details: t('data:governance.debug_flow_error_details'),
    });

    // Step 2: warning after 2.5s
    flowTimersRef.current.push(setTimeout(() => {
      showMigrationStatus({
        level: 'warning',
        message: t('data:governance.debug_flow_warning_message'),
        details: t('data:governance.debug_flow_warning_details'),
      });
    }, 2500));

    // Step 3: success after 5s
    flowTimersRef.current.push(setTimeout(() => {
      showMigrationStatus({
        level: 'info',
        message: t('data:governance.debug_flow_success_message'),
        details: t('data:governance.debug_flow_success_details'),
      });
    }, 5000));

    // Step 4: clear after 8s
    flowTimersRef.current.push(setTimeout(() => {
      clearMigrationStatus();
      setFlowRunning(false);
    }, 8000));
  }, [flowRunning, showMigrationStatus, clearMigrationStatus, t]);

  const runSlotCEmptyDbTest = useCallback(async () => {
    if (slotCTestRunning) return;
    setSlotCTestRunning(true);
    try {
      const result = await DataGovernanceApi.runSlotCEmptyDbTest();
      setSlotCResult({
        success: result.success,
        report: result.report,
        finishedAt: new Date().toLocaleString(),
      });
      showGlobalNotification(
        result.success ? 'success' : 'warning',
        result.success
          ? t('data:governance.debug_slot_c_test_success')
          : t('data:governance.debug_slot_c_test_failed')
      );
      if (!result.success) {
        console.warn('[DataGovernance][DebugTab] Slot C test failed report:', result.report);
      }
    } catch (error: unknown) {
      setSlotCResult({
        success: false,
        report: getErrorMessage(error),
        finishedAt: new Date().toLocaleString(),
      });
      showGlobalNotification(
        'error',
        t('data:governance.debug_slot_test_error_action', { error: getErrorMessage(error) })
      );
    } finally {
      setSlotCTestRunning(false);
    }
  }, [slotCTestRunning, t]);

  const runSlotDCloneDbTest = useCallback(async () => {
    if (slotDTestRunning) return;
    setSlotDTestRunning(true);
    try {
      const result = await DataGovernanceApi.runSlotDCloneDbTest();
      setSlotDResult({
        success: result.success,
        report: result.report,
        finishedAt: new Date().toLocaleString(),
      });
      showGlobalNotification(
        result.success ? 'success' : 'warning',
        result.success
          ? t('data:governance.debug_slot_d_test_success')
          : t('data:governance.debug_slot_d_test_failed')
      );
      if (!result.success) {
        console.warn('[DataGovernance][DebugTab] Slot D test failed report:', result.report);
      }
    } catch (error: unknown) {
      setSlotDResult({
        success: false,
        report: getErrorMessage(error),
        finishedAt: new Date().toLocaleString(),
      });
      showGlobalNotification(
        'error',
        t('data:governance.debug_slot_test_error_action', { error: getErrorMessage(error) })
      );
    } finally {
      setSlotDTestRunning(false);
    }
  }, [slotDTestRunning, t]);

  return (
    <div className="space-y-8">
      <section className="min-w-0">
        <GroupTitle
          title={t('data:governance.debug_panel_title')}
          description={t('data:governance.debug_panel_desc')}
        />
        <div className="rounded-2xl bg-muted p-4 space-y-4">
          <div className="rounded-[var(--radius-shell-panel)] border border-warning/25 bg-warning/5 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 shrink-0 text-warning" size={20} />
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-foreground">
              {t('data:governance.debug_recovery_scenarios_title')}
            </h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('data:governance.debug_recovery_scenarios_desc')}
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <DsButton
            variant="secondary"
            size="sm"
            disabled={!import.meta.env.DEV}
            onClick={() => openRecoveryScenario('startup-conflict')}
            data-testid="debug-startup-conflict"
          >
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            {t('data:governance.debug_preview_startup_conflict')}
          </DsButton>
          <DsButton
            variant="secondary"
            size="sm"
            disabled={!import.meta.env.DEV}
            onClick={() => openRecoveryScenario('startup-preflight-failure')}
            data-testid="debug-startup-preflight-failure"
          >
            <Warning className="mr-1.5 h-3.5 w-3.5" />
            {t('data:governance.debug_preview_preflight_failure')}
          </DsButton>
          <DsButton
            variant="secondary"
            size="sm"
            disabled={!import.meta.env.DEV}
            onClick={() => openRecoveryScenario('core-migration-failure')}
            data-testid="debug-core-migration-failure"
          >
            <Database className="mr-1.5 h-3.5 w-3.5" />
            {t('data:governance.debug_preview_core_failure')}
          </DsButton>
          <DsButton
            variant="secondary"
            size="sm"
            disabled={!import.meta.env.DEV}
            onClick={previewPartialDegradation}
            data-testid="debug-partial-degradation"
          >
            <Warning className="mr-1.5 h-3.5 w-3.5" />
            {t('data:governance.debug_preview_partial_failure')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={clearPartialDegradationPreview}
            className="sm:col-span-2"
          >
            <XCircle className="mr-1.5 h-3.5 w-3.5" />
            {t('data:governance.debug_clear_partial_failure')}
          </DsButton>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <DsButton variant="warning" size="sm" onClick={triggerWarning}>
          <Warning className="h-3.5 w-3.5 mr-1.5" />
          {t('data:governance.debug_trigger_warning')}
        </DsButton>
        <DsButton variant="danger" size="sm" onClick={triggerError}>
          <XCircle className="h-3.5 w-3.5 mr-1.5" />
          {t('data:governance.debug_trigger_error')}
        </DsButton>
        <DsButton variant="primary" size="sm" onClick={triggerInfo}>
          <Database className="h-3.5 w-3.5 mr-1.5" />
          {t('data:governance.debug_trigger_info')}
        </DsButton>
        <DsButton variant="ghost" size="sm" onClick={clearMigrationStatus}>
          <XCircle className="h-3.5 w-3.5 mr-1.5" />
          {t('data:governance.debug_clear_toast')}
        </DsButton>
        <DsButton
          variant="default"
          size="sm"
          onClick={simulateFlow}
          disabled={flowRunning}
          className="col-span-2 sm:col-span-2"
        >
          <Play className="h-3.5 w-3.5 mr-1.5" />
          {flowRunning
            ? t('data:governance.debug_flow_in_progress')
            : t('data:governance.debug_simulate_flow')}
        </DsButton>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {t('data:governance.debug_slot_test_title')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <DsButton
            variant="default"
            size="sm"
            onClick={runSlotCEmptyDbTest}
            disabled={slotCTestRunning}
            data-testid="slot-c-empty-db-test-button"
          >
            <Database className="h-3.5 w-3.5 mr-1.5" />
            {slotCTestRunning
              ? t('data:governance.debug_slot_test_running')
              : t('data:governance.debug_run_slot_c_test')}
          </DsButton>
          <DsButton
            variant="default"
            size="sm"
            onClick={runSlotDCloneDbTest}
            disabled={slotDTestRunning}
            data-testid="slot-d-clone-db-test-button"
          >
            <Database className="h-3.5 w-3.5 mr-1.5" />
            {slotDTestRunning
              ? t('data:governance.debug_slot_test_running')
              : t('data:governance.debug_run_slot_d_test')}
          </DsButton>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-lg border border-border/40 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {t('data:governance.debug_slot_c_log_title')}
            </p>
            <span className={`text-xs px-2 py-0.5 rounded ${
              slotCResult == null
                ? 'bg-muted text-muted-foreground'
                : slotCResult.success
                  ? 'bg-success/10 text-success'
                  : 'bg-destructive/10 text-destructive'
            }`}>
              {slotCResult == null
                ? t('data:governance.debug_slot_status_idle')
                : slotCResult.success
                  ? t('data:governance.debug_slot_status_success')
                  : t('data:governance.debug_slot_status_failed')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {slotCResult
              ? `${t('data:governance.debug_slot_last_run')}: ${slotCResult.finishedAt}`
              : t('data:governance.debug_slot_no_log')}
          </p>
          {slotCResult && (
            <CustomScrollArea className="h-48 rounded-md border border-border/40 bg-muted/20" viewportClassName="p-2">
              <pre className="whitespace-pre-wrap break-words text-xs">{slotCResult.report}</pre>
            </CustomScrollArea>
          )}
        </div>

        <div className="rounded-lg border border-border/40 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {t('data:governance.debug_slot_d_log_title')}
            </p>
            <span className={`text-xs px-2 py-0.5 rounded ${
              slotDResult == null
                ? 'bg-muted text-muted-foreground'
                : slotDResult.success
                  ? 'bg-success/10 text-success'
                  : 'bg-destructive/10 text-destructive'
            }`}>
              {slotDResult == null
                ? t('data:governance.debug_slot_status_idle')
                : slotDResult.success
                  ? t('data:governance.debug_slot_status_success')
                  : t('data:governance.debug_slot_status_failed')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {slotDResult
              ? `${t('data:governance.debug_slot_last_run')}: ${slotDResult.finishedAt}`
              : t('data:governance.debug_slot_no_log')}
          </p>
          {slotDResult && (
            <CustomScrollArea className="h-48 rounded-md border border-border/40 bg-muted/20" viewportClassName="p-2">
              <pre className="whitespace-pre-wrap break-words text-xs">{slotDResult.report}</pre>
            </CustomScrollArea>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border/40 p-4 text-xs text-muted-foreground space-y-1">
        <p>{t('data:governance.debug_toast_behavior_title')}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>{t('data:governance.debug_toast_behavior_warning_info')}</li>
          <li>{t('data:governance.debug_toast_behavior_error')}</li>
          <li>{t('data:governance.debug_toast_behavior_flow')}</li>
        </ul>
      </div>
        </div>
      </section>

      {/* 清空所有应用数据（危险操作） */}
      <section className="min-w-0">
        <GroupTitle
          title={t('data:governance.danger_zone')}
          description={t('data:governance.purge_all_data_desc')}
        />
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
          <DsButton
            variant="danger"
            size="sm"
            onClick={() => setShowPurgeDialog(true)}
            disabled={isPurgeRunning}
          >
            {isPurgeRunning ? (
              <CircleNotch className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Trash className="h-4 w-4 mr-2" />
            )}
            {t('data:governance.purge_all_data_button')}
          </DsButton>
        </div>

        <DsAlertDialog
          open={showPurgeDialog}
          onOpenChange={(open) => { if (!open) setShowPurgeDialog(false); }}
          title={t('data:governance.purge_confirm_title')}
          description={t('data:governance.purge_confirm_desc')}
          confirmText={t('data:governance.purge_confirm_button')}
          cancelText={t('common:actions.cancel')}
          confirmVariant="danger"
          onConfirm={handlePurgeAllData}
          loading={isPurgeRunning}
          disabled={isPurgeRunning}
        />
      </section>
    </div>
  );
};

/** 识别用户/后端取消同步，按中性态处理而非报错 */
export function isSyncCancelledMessage(message: string | undefined | null): boolean {
  if (!message) return false;
  return /同步已取消|sync\s+cancel(?:led|ed)/i.test(message) || /\bcancel(?:led|ed)\b/i.test(message);
}

/** 拦截 Tauri ACL 权限异常，并将内部同步错误/堆栈转为用户可读的本地化文案 */
export function sanitizeAclErrorMessage(
  raw: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  language?: string,
): string {
  return formatFriendlySyncError(raw, t, language);
}

export function formatGovernanceError(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
  language?: string,
): string {
  return sanitizeAclErrorMessage(getErrorMessage(error), t, language);
}

/** 生成本地时区 YYYY-MM-DD，避免 UTC 跨日导致的导出文件名偏移 */
function formatLocalDateYmd(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Map Rust English backup rejection strings to i18n (identity for en-US). */
function localizeBackupJobError(
  message: string | undefined,
  t: (key: string) => string,
): string {
  if (!message) return t('data:governance.backup_failed');
  if (message === INCREMENTAL_BACKUP_REMOVED_MESSAGE) {
    return t('data:governance.incremental_create_removed');
  }
  if (message === INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE) {
    return t('data:governance.restore_incremental_not_supported');
  }
  if (
    message.includes('E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE') ||
    /备份不能用于完整恢复|不是可替换数据槽的完整快照|partial archive 不能替换数据槽/.test(
      message,
    )
  ) {
    return t('data:governance.restore_partial_archive_refused');
  }
  if (message.includes('E_BACKUP_SEALED_PASSWORD_REQUIRED')) {
    return t('data:governance.import_sealed_password_required');
  }
  if (message.includes('E_BACKUP_SEALED_DECRYPT_FAILED')) {
    return t('data:governance.import_sealed_decrypt_failed');
  }
  if (message.includes('E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE')) {
    return t('data:governance.restore_atomic_unavailable');
  }
  // 恢复域账本稳定码（src-tauri/src/data_governance/restore_codes.rs）。
  // 结果 details JSON 里对应字段：`isolation_state`（值 "IsolatedPendingTrust"
  // → data:governance.restore_isolated_pending_trust）、`unconsumed_domains`、
  // `failed_domains`。
  if (message.includes('E_RESTORE_DOMAIN_UNCONSUMED')) {
    return t('data:governance.restore_domain_unconsumed');
  }
  if (message.includes('E_RESTORE_DOMAIN_FAILED')) {
    return t('data:governance.restore_domain_failed');
  }
  if (message.includes('E_RESTORE_UNTRUSTED_ISOLATED')) {
    return t('data:governance.restore_untrusted_isolated');
  }
  return message;
}

// ==================== 主 Dashboard 组件 ====================

export interface DataGovernanceTabTarget {
  tab: DashboardTab;
  requestId: number;
}

interface DataGovernanceDashboardProps {
  embedded?: boolean;
  tabTarget?: DataGovernanceTabTarget | null;
  hideHeaderQuickSync?: boolean;
}


const BACKUP_VERIFICATION_STORAGE_KEY = 'dataGovernance.backupVerification.v1';

/** 读取本机记录的备份验证结论；「验证中」不落盘（重开页面不会卡在验证中） */
function readBackupVerificationStatuses(): Record<string, BackupVerificationStatus> {
  try {
    const raw = localStorage.getItem(BACKUP_VERIFICATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, BackupVerificationStatus] => entry[1] === 'verified' || entry[1] === 'failed',
      ),
    );
  } catch {
    return {};
  }
}

function writeBackupVerificationStatuses(map: Record<string, BackupVerificationStatus>): void {
  try {
    const persisted = Object.fromEntries(
      Object.entries(map).filter(([, status]) => status === 'verified' || status === 'failed'),
    );
    localStorage.setItem(BACKUP_VERIFICATION_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // 存储不可用（隐私模式等）：本次会话内仍显示
  }
}

export const DataGovernanceDashboard: React.FC<DataGovernanceDashboardProps> = ({
  embedded = false,
  tabTarget = null,
  hideHeaderQuickSync = true,
}) => {
  const { t, i18n } = useTranslation(['data', 'common', 'sync']);
  /**
   * `t` 的身份不保证跨渲染稳定。
   *
   * 「按 activeTab 拉数据」的 effect 依赖各个 loader，只要有一个 loader 把 `t` 放进
   * useCallback 依赖，它就每渲染换一次身份 → effect 每渲染重跑 → loader 里的
   * setState 又触发下一次渲染，构成自激循环（jsdom 下会一路吃到堆溢出）。
   * 这些地方只在报错分支用文案，从 ref 读即可，不需要参与依赖。
   */
  const tRef = useRef(t);
  tRef.current = t;
  const {
    maintenanceMode,
    maintenanceReason,
    maintenanceRequiresRestart,
    enterMaintenanceMode,
    requireMaintenanceRestart,
    exitMaintenanceMode,
  } = useSystemStatusStore(
    useShallow((state) => ({
      maintenanceMode: state.maintenanceMode,
      maintenanceReason: state.maintenanceReason,
      maintenanceRequiresRestart: state.maintenanceRequiresRestart,
      enterMaintenanceMode: state.enterMaintenanceMode,
      requireMaintenanceRestart: state.requireMaintenanceRestart,
      exitMaintenanceMode: state.exitMaintenanceMode,
    }))
  );
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [syncTabVisited, setSyncTabVisited] = useState(false);
  const debugTabEnabled = isDebugTabEnabled();
  const lastAppliedTabRequestIdRef = useRef<number | null>(null);

  const handleSelectTab = useCallback((next: DashboardTab) => {
    if (next === 'sync') {
      setSyncTabVisited(true);
    }
    setActiveTab(next);
  }, []);

  useEffect(() => {
    if (!tabTarget) return;
    if (lastAppliedTabRequestIdRef.current === tabTarget.requestId) return;
    lastAppliedTabRequestIdRef.current = tabTarget.requestId;
    // 生产构建没有 debug 页签，外部深链不能把面板切到一个不存在的页签
    if (tabTarget.tab === 'debug' && !debugTabEnabled) return;
    if (tabTarget.tab === 'sync') {
      setSyncTabVisited(true);
    }
    setActiveTab(tabTarget.tab);
  }, [tabTarget, debugTabEnabled]);

  const [loadingState, setLoadingState] = useState({
    overview: 0,
    backup: 0,
    sync: 0,
    audit: 0,
  });

  const startTabLoading = useCallback((tab: 'overview' | 'backup' | 'sync' | 'audit') => {
    setLoadingState((prev) => ({
      ...prev,
      [tab]: prev[tab] + 1,
    }));
  }, []);

  const stopTabLoading = useCallback((tab: 'overview' | 'backup' | 'sync' | 'audit') => {
    setLoadingState((prev) => ({
      ...prev,
      [tab]: Math.max(0, prev[tab] - 1),
    }));
  }, []);

  const overviewLoading = loadingState.overview > 0;
  const backupLoading = loadingState.backup > 0;
  const syncLoading = loadingState.sync > 0;
  const auditLoading = loadingState.audit > 0;

  // 数据状态
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatusResponse | null>(null);
  const [healthCheck, setHealthCheck] = useState<HealthCheckResponse | null>(null);
  const [backups, setBackups] = useState<BackupInfoResponse[]>([]);
  const [hasLoadedBackups, setHasLoadedBackups] = useState(false);
  const hasLoadedBackupsRef = useRef(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [conflicts, setConflicts] = useState<ConflictDetectionResponse | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogResponse[]>([]);
  const [auditTotal, setAuditTotal] = useState<number>(0);
  const [auditLoadError, setAuditLoadError] = useState<string | null>(null);

  // 审计日志分页
  const AUDIT_PAGE_SIZE = 50;
  const auditFilterRef = useRef<{ operationType?: AuditOperationType; status?: AuditStatus }>({});
  const auditRequestGeneration = useRef(0);

  // 云端同步状态：进度与「正在同步」都在全局 store（#447）——本面板是 lazy
  // 渲染的设置栏目，切栏目会被卸载；进度由应用级事件监听写入，重挂载后
  // 立即恢复显示。其他入口（设置页同步区块、自动同步）同步时本面板同样可见。
  const syncProgress = useGlobalSyncStore((s) => s.progress);
  const [isSyncRunning, setIsSyncRunning] = useState(false);
  const globalSyncing = useGlobalSyncStore((s) => s.isSyncing);
  const syncCancelRequested = useGlobalSyncStore((s) => s.cancelRequested);
  const unresolvedConflictCount = useGlobalSyncStore((s) => s.unresolvedConflictCount ?? 0);
  const handleCancelSync = useCallback(() => {
    void useGlobalSyncStore.getState().requestCancel();
  }, []);
  const [syncStrategy, setSyncStrategy] = useState<MergeStrategy>('keep_latest');
  // 记录最近一次同步请求快照（用于重试）
  const lastSyncRequestRef = useRef<{
    direction: 'upload' | 'download' | 'bidirectional';
    strategy: MergeStrategy;
  }>({ direction: 'bidirectional', strategy: 'keep_latest' });
  const syncInFlightRef = useRef(false);
  const detectInFlightRef = useRef(false);

  // 后台备份任务状态
  const [backupJobId, setBackupJobId] = useState<string | null>(null);
  const [backupProgress, setBackupProgress] = useState<BackupJobEvent | null>(null);
  const [isBackupRunning, setIsBackupRunning] = useState(false);
  const currentJobOperationRef = useRef<BackupJobOperation | null>(null);
  const [currentJobOperation, setCurrentJobOperation] = useState<BackupJobOperation | null>(null);

  const setJobOperation = useCallback((op: BackupJobOperation | null) => {
    currentJobOperationRef.current = op;
    setCurrentJobOperation(op);
  }, []);

  // 可恢复任务状态
  const [resumableJobs, setResumableJobs] = useState<ResumableJob[]>([]);

  // 恢复完成后重启对话框状态
  const [showRestartDialog, setShowRestartDialog] = useState(false);

  // 导入完成后提示恢复对话框状态
  const [showRestorePromptDialog, setShowRestorePromptDialog] = useState(false);
  const [importedBackupId, setImportedBackupId] = useState<string | null>(null);
  const [showRecoveryImportDialog, setShowRecoveryImportDialog] = useState(false);
  const [pendingRecoveryRestoreId, setPendingRecoveryRestoreId] = useState<string | null>(null);
  const recoverySnapshotAriaLabels = React.useMemo(
    () => buildSnapshotAriaLabelMap(backups),
    [backups]
  );

  // 备份验证结果详细信息
  const [verifyResult, setVerifyResult] = useState<BackupVerifyResponse | null>(null);
  // 备份列表「验证状态」列：此前 BackupTab 的 verificationStatusMap 无人传入，验证通过后仍显示「未验证」。
  // 备份内容不可变，验证结论按备份 ID 记在本机（localStorage），重开页面仍可见。
  const [verificationStatusMap, setVerificationStatusMap] = useState<Record<string, BackupVerificationStatus>>(
    readBackupVerificationStatuses,
  );
  const setBackupVerification = useCallback((backupId: string, status: BackupVerificationStatus) => {
    setVerificationStatusMap((prev) => {
      const next = { ...prev, [backupId]: status };
      writeBackupVerificationStatuses(next);
      return next;
    });
  }, []);
  const [showVerifyDialog, setShowVerifyDialog] = useState(false);

  // 最新备份自动验证（概览页「验证最新备份」按钮）
  const [lastAutoVerifyResult, setLastAutoVerifyResult] = useState<AutoVerifyResponse | null>(null);
  const [isAutoVerifying, setIsAutoVerifying] = useState(false);

  // 云存储配置（由 CloudStorageSection 维护：localStorage + 安全存储）
  // 从 localStorage 同步读取当前配置摘要
  const readCloudSyncSummary = useCallback(() => {
    const safe = cloudApi.loadStoredCloudStorageConfigSafe();
    if (!safe) return null;
    const root = typeof safe.root === 'string' && safe.root.trim().length > 0 ? safe.root : undefined;
    return { provider: safe.provider, root };
  }, []);

  const [cloudSyncSummary, setCloudSyncSummary] = useState(readCloudSyncSummary);
  const [cloudSyncConfigured, setCloudSyncConfigured] = useState<boolean>(() => Boolean(readCloudSyncSummary()));
  const [showCloudSettingsEditor, setShowCloudSettingsEditor] = useState(false);

  const toggleCloudStorageSettingsEditor = useCallback(() => {
    setShowCloudSettingsEditor((prev) => !prev);
  }, []);

  const loadCloudSyncConfig = useCallback(async (): Promise<cloudApi.CloudStorageConfig | null> => {
    return await cloudApi.loadStoredCloudStorageConfigWithCredentials();
  }, []);

  const refreshCloudSyncConfigured = useCallback(async () => {
    try {
      const resolved = await cloudApi.resolveCloudStorageConfig().catch(() => undefined);
      const config = resolved !== undefined ? resolved : (await loadCloudSyncConfig().catch(() => null));
      if (config) {
        setCloudSyncConfigured(true);
        const root =
          typeof config.root === 'string' && config.root.trim().length > 0
            ? config.root
            : undefined;
        setCloudSyncSummary({ provider: config.provider, root });
      } else if (resolved === null) {
        const fallbackConfigured = await probeStoredCloudConfigured();
        if (fallbackConfigured) {
          setCloudSyncConfigured(true);
          const cached = readCloudSyncSummary();
          if (cached) setCloudSyncSummary(cached);
        } else {
          setCloudSyncConfigured(false);
          setCloudSyncSummary(null);
        }
      } else {
        const cached = readCloudSyncSummary();
        setCloudSyncConfigured(Boolean(cached));
        setCloudSyncSummary(cached);
      }
    } catch (error: unknown) {
      console.error('读取云存储配置失败:', error);
      const cached = readCloudSyncSummary();
      setCloudSyncConfigured(Boolean(cached));
    }
  }, [loadCloudSyncConfig, readCloudSyncSummary]);

  const handleCloudConfigChanged = useCallback(() => {
    setCloudSyncSummary(readCloudSyncSummary());
    void refreshCloudSyncConfigured();
  }, [readCloudSyncSummary, refreshCloudSyncConfigured]);

  useEffect(() => {
    void refreshCloudSyncConfigured();
  }, [refreshCloudSyncConfigured]);

  useEffect(() => {
    const onCloudConfigChanged = () => {
      handleCloudConfigChanged();
    };
    window.addEventListener('data-governance:cloud-config-changed', onCloudConfigChanged);
    return () => {
      window.removeEventListener('data-governance:cloud-config-changed', onCloudConfigChanged);
    };
  }, [handleCloudConfigChanged]);

  // 加载概览数据
  const loadOverviewData = useCallback(async () => {
    startTabLoading('overview');
    try {
      const [migration, health] = await Promise.all([
        DataGovernanceApi.getMigrationStatus(),
        DataGovernanceApi.runHealthCheck(),
      ]);
      setMigrationStatus(migration);
      setHealthCheck(health);
    } catch (error: unknown) {
      console.error('加载概览数据失败:', error);
      showGlobalNotification('error', formatGovernanceError(error, t));
    } finally {
      stopTabLoading('overview');
    }
  }, [startTabLoading, stopTabLoading, t]);

  // 加载备份列表
  const loadBackups = useCallback(async () => {
    startTabLoading('backup');
    try {
      const list = await DataGovernanceApi.getBackupList();
      setBackups(list);
      hasLoadedBackupsRef.current = true;
      setHasLoadedBackups(true);
    } catch (error: unknown) {
      console.error('加载备份列表失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('backup');
    }
  }, [startTabLoading, stopTabLoading]);

  // 加载可恢复任务列表
  const loadResumableJobs = useCallback(async () => {
    try {
      const jobs = await DataGovernanceApi.listResumableJobs();
      setResumableJobs(jobs);
    } catch (error: unknown) {
      console.error('加载可恢复任务失败:', error);
      showGlobalNotification(
        'warning',
        tRef.current('data:governance.resumable_jobs_load_failed')
      );
    }
  }, []);

  type BackupJobOutcome = {
    success: boolean;
    cancelled?: boolean;
    error?: string;
    requiresRestart?: boolean;
  };
  const jobOutcomeWaitersRef = useRef<Map<string, (outcome: BackupJobOutcome) => void>>(new Map());

  const resolveJobOutcome = useCallback((jobId: string | undefined | null, outcome: BackupJobOutcome) => {
    if (jobId) {
      const waiter = jobOutcomeWaitersRef.current.get(jobId);
      if (waiter) {
        jobOutcomeWaitersRef.current.delete(jobId);
        waiter(outcome);
      }
      return;
    }
    if (jobOutcomeWaitersRef.current.size > 0) {
      const entries = Array.from(jobOutcomeWaitersRef.current.entries());
      jobOutcomeWaitersRef.current.clear();
      for (const [, waiter] of entries) {
        waiter(outcome);
      }
    }
  }, []);

  const waitForBackupJobOutcome = useCallback((jobId: string): Promise<BackupJobOutcome> => {
    return new Promise((resolve) => {
      jobOutcomeWaitersRef.current.set(jobId, resolve);
    });
  }, []);

  /**
   * 以后端聚合状态为真相收敛前端维护横幅。
   *
   * 仅当后端处于恢复切槽、启动降级或无活跃非恢复操作却仍被屏障锁住时，
   * 才进入不可撤销的重启恢复态；瞬时查询失败不再误锁整个桌面 UI。
   */
  const reconcileMaintenanceMode = useCallback(async () => {
    const generation = useSystemStatusStore.getState().maintenanceGeneration;
    try {
      const status = await DataGovernanceApi.getMaintenanceStatus();
      // 查询期间若有新任务进入/退出维护模式，旧结果不得覆盖新状态。
      if (useSystemStatusStore.getState().maintenanceGeneration !== generation) return;
      if (status?.is_in_maintenance_mode) {
        const opKind = (status as { current_operation?: { kind?: string } | null }).current_operation?.kind;
        const hasComponentIssues = (status.component_issues?.length ?? 0) > 0;
        if (!opKind || opKind === 'restore' || hasComponentIssues) {
          requireMaintenanceRestart(t('common:maintenance.recovery_required'));
        } else {
          enterMaintenanceMode(t('data:governance.maintenance_backup'));
        }
      } else {
        exitMaintenanceMode();
      }
    } catch (error: unknown) {
      console.error('查询维护屏障聚合状态失败:', error);
      if (useSystemStatusStore.getState().maintenanceGeneration !== generation) return;
      if (!useSystemStatusStore.getState().maintenanceRequiresRestart) {
        exitMaintenanceMode();
      }
    }
  }, [enterMaintenanceMode, exitMaintenanceMode, requireMaintenanceRestart, t]);

  // 使用统一的备份任务监听 Hook
  const { startListening, stopListening } = useBackupJobListener({
    onProgress: (event) => {
      setBackupProgress(event);
    },
    onComplete: (event) => {
      setIsBackupRunning(false);
      stopTabLoading('backup');
      setBackupJobId(null);
      const op = currentJobOperationRef.current;
      setJobOperation(null);

      const stats = event.result?.stats;
      const autoVerify = stats && typeof stats === 'object'
        ? (stats as Record<string, unknown>).auto_verify
        : null;
      const autoVerifyValid = autoVerify && typeof autoVerify === 'object'
        ? (autoVerify as Record<string, unknown>).is_valid
        : undefined;
      const autoVerifyFailed = autoVerifyValid === false;
      const resultSuccess = event.result?.success !== false;

      if (autoVerifyFailed) {
        showGlobalNotification(
          'warning',
          t('data:governance.auto_verify_failed_action'),
          t('data:governance.auto_verify_failed')
        );
      }

      // 根据任务操作类型显示不同消息（注意：后端 kind=export/import 过于粗粒度，不能直接区分备份 vs ZIP 导出）
      if (op === 'zip_export') {
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.export_success_simple') : t('data:governance.backup_completed_with_issues'),
          undefined,
          { replaceKey: BACKUP_JOB_NOTIFICATION_KEY },
        );
      } else if (op === 'zip_import') {
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.import_success_simple') : t('data:governance.backup_completed_with_issues'),
          undefined,
          { replaceKey: BACKUP_JOB_NOTIFICATION_KEY },
        );
        void loadBackups();
        // 导入完成后提示用户是否立即恢复
        const backupId = stats && typeof stats === 'object'
          ? (stats as Record<string, unknown>).backup_id as string | undefined
          : undefined;
        const importedArchiveIsRestorable = cloudApi.isImportedArchiveSlotRestorable(stats);
        if (backupId && resultSuccess && importedArchiveIsRestorable) {
          setImportedBackupId(backupId);
          setShowRestorePromptDialog(true);
        } else if (resultSuccess && !importedArchiveIsRestorable) {
          // Portable/partial archives import successfully for inspection/export,
          // but must never be offered as an immediate full-slot restore.
          setImportedBackupId(null);
          setShowRestorePromptDialog(false);
        }
      } else if (op === 'restore') {
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.restore_success_simple') : t('data:governance.backup_completed_with_issues'),
          undefined,
          { replaceKey: BACKUP_JOB_NOTIFICATION_KEY },
        );
        void loadBackups();
        void loadOverviewData(); // 恢复后刷新概览数据
      } else if (op === 'tiered_backup') {
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.tiered_backup_success') : t('data:governance.backup_completed_with_issues'),
          undefined,
          { replaceKey: BACKUP_JOB_NOTIFICATION_KEY },
        );
        void loadBackups();
      } else {
        // 普通备份完成
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.backup_success') : t('data:governance.backup_completed_with_issues'),
          undefined,
          { replaceKey: BACKUP_JOB_NOTIFICATION_KEY },
        );
        void loadBackups();
      }

      // 检查是否需要重启（恢复操作特有）—— 显示模态对话框而非通知
      if (event.result?.requires_restart) {
        // 恢复切槽在重启前有意保持后端屏障；横幅与不可关闭对话框必须一致。
        requireMaintenanceRestart(t('common:maintenance.recovery_required'));
        setShowRestartDialog(true);
      } else {
        void reconcileMaintenanceMode();
      }

      resolveJobOutcome(event.job_id, {
        success: resultSuccess,
        error: resultSuccess
          ? undefined
          : localizeBackupJobError(event.result?.error || event.message, t),
        requiresRestart: Boolean(event.result?.requires_restart),
      });

      // 刷新可恢复任务列表
      void loadResumableJobs();
    },
    onError: (event) => {
      setIsBackupRunning(false);
      stopTabLoading('backup');
      setBackupJobId(null);
      setJobOperation(null);
      void reconcileMaintenanceMode();
      const localizedError = localizeBackupJobError(
        localizeCloudStorageError(event.result?.error || event.message, t, i18n?.language),
        t,
      );
      notifyBackupJobError(localizedError);
      resolveJobOutcome(event.job_id, {
        success: false,
        error: localizedError,
      });
    },
    onCancelled: (event?: BackupJobEvent) => {
      setIsBackupRunning(false);
      stopTabLoading('backup');
      setBackupJobId(null);
      setJobOperation(null);
      void reconcileMaintenanceMode();
      showGlobalNotification('info', t('data:governance.backup_cancelled'), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });
      resolveJobOutcome(event?.job_id, {
        success: false,
        cancelled: true,
      });
      void loadResumableJobs();
    },
  });

  // 组件卸载时停止监听并清理未决等待器
  useEffect(() => {
    const waiters = jobOutcomeWaitersRef.current;
    return () => {
      stopListening();
      if (waiters.size > 0) {
        for (const [, waiter] of Array.from(waiters.entries())) {
          waiter({ success: false, cancelled: true });
        }
        waiters.clear();
      }
    };
  }, [stopListening]);

  // 恢复任务
  const resumeJob = useCallback(async (jobId: string, password?: string): Promise<BackupJobOutcome> => {
    if (isBackupRunning) {
      const msg = t('data:governance.backup_already_running');
      showGlobalNotification('warning', msg);
      return { success: false, error: msg };
    }
    setIsBackupRunning(true);
    setBackupProgress(null);
    const resumable = resumableJobs.find((j) => j.job_id === jobId);
    setJobOperation(resumable?.kind === 'import' ? 'zip_import' : 'backup');
    enterMaintenanceMode(t('data:governance.maintenance_backup'));
    
    try {
      const response = await DataGovernanceApi.resumeBackupJob(jobId, password);
      setBackupJobId(response.job_id);
      showGlobalNotification('info', t('data:governance.job_resumed'), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });
      
      // 使用统一的监听 Hook
      const outcomePromise = waitForBackupJobOutcome(response.job_id);
      await startListening(response.job_id);
      return await outcomePromise;
    } catch (error: unknown) {
      const msg = localizeBackupJobError(
        localizeCloudStorageError(error, t, i18n?.language),
        t,
      );
      notifyBackupJobError(msg);
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      return { success: false, error: msg };
    }
  }, [isBackupRunning, resumableJobs, setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, waitForBackupJobOutcome, t, i18n?.language]);

  // 加载同步状态
  // 加载同步状态（silent=true 用于后台轮询和本地变更事件刷新，避免闪烁 loading 或重复报错）
  const loadSyncStatus = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      startTabLoading('sync');
    }
    // 每次加载同步状态时重新读取云存储配置，保证配置变更后及时反映
    const cachedSummary = readCloudSyncSummary();
    if (cachedSummary) {
      setCloudSyncSummary(cachedSummary);
    }
    void refreshCloudSyncConfigured();
    try {
      const status = await DataGovernanceApi.getSyncStatus();
      setSyncStatus(status);
    } catch (error: unknown) {
      console.error('加载同步状态失败:', error);
      if (!silent) {
        notifyErrorDeduped('error', formatGovernanceError(error, t, i18n?.language));
      }
    } finally {
      if (!silent) {
        stopTabLoading('sync');
      }
    }
  }, [startTabLoading, stopTabLoading, readCloudSyncSummary, refreshCloudSyncConfigured, t, i18n?.language]);

  // 加载审计日志
  const loadAuditLogs = useCallback(async (
    operationType?: AuditOperationType,
    status?: AuditStatus,
    limit = AUDIT_PAGE_SIZE,
  ) => {
    const generation = ++auditRequestGeneration.current;
    auditFilterRef.current = { operationType, status };
    startTabLoading('audit');
    try {
      const result = await DataGovernanceApi.getAuditLogs(operationType, status, limit, 0);
      const logs = Array.isArray(result) ? result : Array.isArray(result?.logs) ? result.logs : [];
      if (auditRequestGeneration.current === generation) {
        setAuditLogs(logs);
        setAuditTotal(typeof result?.total === 'number' ? result.total : logs.length);
        setAuditLoadError(null);
      }
    } catch (error: unknown) {
      if (auditRequestGeneration.current === generation) {
        console.error('加载审计日志失败:', error);
        setAuditLoadError(getErrorMessage(error));
        showGlobalNotification('error', getErrorMessage(error));
      }
    } finally {
      stopTabLoading('audit');
    }
  }, [startTabLoading, stopTabLoading]);

  const reloadAuditLogs = useCallback(() => {
    const { operationType, status } = auditFilterRef.current;
    return loadAuditLogs(operationType, status, Math.max(AUDIT_PAGE_SIZE, auditLogs.length));
  }, [auditLogs.length, loadAuditLogs]);

  // 加载更多审计日志（追加）
  const loadMoreAuditLogs = useCallback(async () => {
    const { operationType, status } = auditFilterRef.current;
    const generation = ++auditRequestGeneration.current;
    startTabLoading('audit');
    try {
      const offset = auditLogs.length;
      const result = await DataGovernanceApi.getAuditLogs(operationType, status, AUDIT_PAGE_SIZE, offset);
      const moreLogs = Array.isArray(result) ? result : Array.isArray(result?.logs) ? result.logs : [];
      if (auditRequestGeneration.current === generation) {
        setAuditLogs((prev) => [...prev, ...moreLogs]);
        if (typeof result?.total === 'number') {
          setAuditTotal(result.total);
        }
      }
    } catch (error: unknown) {
      console.error('加载更多审计日志失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('audit');
    }
  }, [startTabLoading, stopTabLoading, auditLogs.length]);

  // 运行健康检查
  const runHealthCheck = useCallback(async () => {
    startTabLoading('overview');
    try {
      const result = await DataGovernanceApi.runHealthCheck();
      setHealthCheck(result);
      showGlobalNotification(
        result.overall_healthy ? 'success' : 'warning',
        result.overall_healthy
          ? t('data:governance.health_check_passed')
          : t('data:governance.health_check_issues')
      );
    } catch (error: unknown) {
      console.error('健康检查失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('overview');
    }
  }, [startTabLoading, stopTabLoading, t]);

  // 验证最新备份（调用后端 data_governance_auto_verify_latest_backup）
  const verifyLatestBackup = useCallback(async () => {
    if (isAutoVerifying) return;
    let currentBackups = backups;
    if (!hasLoadedBackupsRef.current) {
      try {
        currentBackups = await DataGovernanceApi.getBackupList();
        if (Array.isArray(currentBackups)) {
          setBackups(currentBackups);
          hasLoadedBackupsRef.current = true;
          setHasLoadedBackups(true);
        }
      } catch {
        // 若读取列表失败，继续交给后端 autoVerifyLatestBackup 兜底报错
      }
    }
    if (Array.isArray(currentBackups) && currentBackups.length === 0) {
      showGlobalNotification('info', t('data:governance.auto_verify_no_backups'));
      return;
    }
    setIsAutoVerifying(true);
    try {
      const result = await DataGovernanceApi.autoVerifyLatestBackup();
      setLastAutoVerifyResult(result);
      showGlobalNotification(
        result.is_valid ? 'success' : 'warning',
        result.is_valid
          ? t('data:governance.auto_verify_success')
          : t('data:governance.auto_verify_failed')
      );
    } catch (error: unknown) {
      console.error('验证最新备份失败:', error);
      showGlobalNotification('error', formatGovernanceError(error, t));
    } finally {
      setIsAutoVerifying(false);
    }
  }, [backups, isAutoVerifying, t]);

  // 立即创建完整本地恢复点（直接写入备份列表，支持整槽恢复）
  const createLocalBackup = useCallback(async () => {
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }

    startTabLoading('backup');
    setIsBackupRunning(true);
    setBackupProgress(null);
    setJobOperation('backup');
    enterMaintenanceMode(t('data:governance.maintenance_backup'));

    try {
      const response = await DataGovernanceApi.runBackup('full', true);
      setBackupJobId(response.job_id);
      showGlobalNotification('info', t('data:governance.create_restore_point_started'), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('创建本地恢复点失败:', error);
      notifyBackupJobError(localizeCloudStorageError(error, t));
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
    }
  }, [isBackupRunning, startTabLoading, setJobOperation, enterMaintenanceMode, t, startListening, i18n?.language, reconcileMaintenanceMode, stopTabLoading]);

  // 一步导出备份（备份 + ZIP）
  const backupAndExportZip = useCallback(async (options: {
    compressionLevel: number;
    addToBackupList: boolean;
    useTiered: boolean;
    tiers?: string[];
    includeAssets?: boolean;
    assetTypes?: string[];
    /** 可选 E2EE 备份密码：提供后导出加密全保真换机包 */
    encryptionPassword?: string;
    /** 未加密便携 ZIP 默认排除回收站软删除内容 */
    excludeTrash?: boolean;
  }) => {
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }

    try {
      const useNativeMobilePicker = !isWebUiShell() && isAndroidMobileShell();
      const savePath = useNativeMobilePicker ? '' : await save({
        title: t('data:governance.save_zip'),
        defaultPath: `backup-${formatLocalDateYmd()}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });

      if (savePath === null) {
        return;
      }

      startTabLoading('backup');
      setIsBackupRunning(true);
      setBackupProgress(null);
      setJobOperation(
        options.addToBackupList
          ? (options.useTiered ? 'tiered_backup' : 'backup')
          : 'zip_export',
      );
      enterMaintenanceMode(t('data:governance.maintenance_backup'));

      const response =
        !options.encryptionPassword && options.excludeTrash === false
          ? await invoke<{ job_id: string }>('data_governance_backup_and_export_zip', {
              outputPath: savePath,
              compressionLevel: options.compressionLevel,
              addToBackupList: options.addToBackupList,
              useTiered: options.useTiered,
              tiers: options.tiers ?? null,
              includeAssets: options.includeAssets ?? null,
              assetTypes: options.assetTypes ?? null,
              encryptionPassword: null,
              excludeTrash: false,
            })
          : await DataGovernanceApi.backupAndExportZip(
              savePath,
              options.compressionLevel,
              options.addToBackupList,
              options.useTiered,
              options.tiers as any,
              options.includeAssets,
              options.assetTypes as any,
              options.encryptionPassword,
            );

      setBackupJobId(response.job_id);
      showGlobalNotification('info', t('data:governance.backup_and_export_started'), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('备份并导出 ZIP 失败:', error);
      notifyBackupJobError(localizeCloudStorageError(error, t));
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
    }
  }, [setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, t, i18n?.language, isBackupRunning, startTabLoading, stopTabLoading]);

  // 取消备份
  const cancelBackup = useCallback(async () => {
    if (!backupJobId) {
      return;
    }

    try {
      const cancelled = await DataGovernanceApi.cancelBackup(backupJobId);
      if (cancelled) {
        showGlobalNotification('info', t('data:governance.backup_cancel_requested'), undefined, {
          replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
        });
      } else {
        showGlobalNotification('warning', t('data:governance.backup_cancel_failed'), undefined, {
          replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
        });
      }
    } catch (error: unknown) {
      console.error('取消备份失败:', error);
      showGlobalNotification('error', getErrorMessage(error), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });
    }
  }, [backupJobId, t]);

  // 导出为 ZIP（异步）；encryptionPassword 非空时执行加密全保真导出
  const exportZip = useCallback(async (
    backupId: string,
    compressionLevel: number,
    encryptionPassword?: string,
    excludeTrash?: boolean,
  ) => {
    // 如果已有任务在运行，不允许再次启动
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }

    try {
      // 让用户选择保存路径（仅原生 Android 移动壳跳过桌面保存对话框，手机 WebUI 仍走浏览器保存导出）
      const useNativeMobilePicker = !isWebUiShell() && isAndroidMobileShell();
      const savePath = useNativeMobilePicker ? '' : await save({
        title: t('data:governance.save_zip'),
        defaultPath: `backup-${formatLocalDateYmd()}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      
      if (savePath === null) {
        return;
      }

      startTabLoading('backup');
      setIsBackupRunning(true);
      setBackupProgress(null);
      setJobOperation('zip_export');
      enterMaintenanceMode(t('data:governance.maintenance_export'));

      // 启动后台 ZIP 导出任务
      const response =
        !encryptionPassword && excludeTrash === false
          ? await invoke<{ job_id: string }>('data_governance_export_zip', {
              backupId,
              outputPath: savePath ?? null,
              compressionLevel,
              includeChecksums: true,
              encryptionPassword: null,
              excludeTrash: false,
            })
          : await DataGovernanceApi.exportZip(
              backupId,
              savePath,
              compressionLevel,
              true, // includeChecksums
              encryptionPassword,
            );
      setBackupJobId(response.job_id);

      showGlobalNotification('info', t('data:governance.export_started'), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });

      // 使用统一的监听 Hook
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('ZIP 导出失败:', error);
      notifyBackupJobError(localizeCloudStorageError(error, t));
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
    }
  }, [setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, t, i18n?.language, isBackupRunning, startTabLoading, stopTabLoading]);

  // 从 ZIP 导入（异步）；WebUI/显式路径优先直接提交，否则走系统文件选择器；password 为加密备份密码
  const importZip = useCallback(async (password?: string, explicitPath?: string): Promise<BackupJobOutcome> => {
    // 如果已有任务在运行，不允许再次启动
    if (isBackupRunning) {
      const msg = t('data:governance.backup_already_running');
      showGlobalNotification('warning', msg);
      return { success: false, error: msg };
    }

    try {
      const trimmedExplicit = explicitPath?.trim();
      let selected: string | string[] | null = trimmedExplicit || null;
      if (!selected) {
        // 让用户选择 ZIP 文件（仅原生 Android 移动壳使用 'mobile-picker:'，手机 WebUI 走浏览器文件选择与上传暂存）
        const useNativeMobilePicker = !isWebUiShell() && isAndroidMobileShell();
        selected = useNativeMobilePicker ? 'mobile-picker:' : await open({
          title: t('data:governance.select_zip'),
          multiple: false,
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        });
      }

      // 完整的空值检查
      if (!selected) {
        return { success: false, cancelled: true };
      }

      // 处理数组情况（用户取消时可能返回空数组）
      let zipPath: string;
      if (Array.isArray(selected)) {
        if (selected.length === 0) {
          return { success: false, cancelled: true }; // 空数组，用户取消
        }
        zipPath = selected[0];
      } else {
        zipPath = selected;
      }

      // 确保 zipPath 有效
      if (!zipPath) {
        return { success: false, cancelled: true };
      }

      startTabLoading('backup');
      setIsBackupRunning(true);
      setBackupProgress(null);
      setJobOperation('zip_import');
      enterMaintenanceMode(t('data:governance.maintenance_import'));

      // 启动后台 ZIP 导入任务（password 非空时用于解封加密全保真包）
      const response = await DataGovernanceApi.importZip(zipPath, undefined, password);
      setBackupJobId(response.job_id);

      showGlobalNotification('info', t('data:governance.import_started'), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });

      // 使用统一的监听 Hook 并等待任务终态（供口令错弹窗保留错误反馈）
      const outcomePromise = waitForBackupJobOutcome(response.job_id);
      await startListening(response.job_id);
      return await outcomePromise;
    } catch (error: unknown) {
      console.error('ZIP 导入失败:', error);
      const msg = localizeBackupJobError(
        localizeCloudStorageError(error, t),
        t,
      );
      notifyBackupJobError(msg);
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
      return { success: false, error: msg };
    }
  }, [setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, waitForBackupJobOutcome, t, i18n?.language, isBackupRunning, startTabLoading, stopTabLoading]);

  // 删除备份
  const deleteBackup = useCallback(async (backupId: string) => {
    startTabLoading('backup');
    try {
      await DataGovernanceApi.deleteBackup(backupId);
      showGlobalNotification('success', t('data:governance.backup_deleted'));
      await loadBackups();
    } catch (error: unknown) {
      console.error('删除备份失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('backup');
    }
  }, [loadBackups, t, startTabLoading, stopTabLoading]);

  // 验证备份（展示详细结果）
  const verifyBackup = useCallback(async (backupId: string) => {
    startTabLoading('backup');
    setBackupVerification(backupId, 'verifying');
    try {
      const result = await DataGovernanceApi.verifyBackup(backupId);
      setBackupVerification(backupId, result.is_valid ? 'verified' : 'failed');
      setVerifyResult(result);
      setShowVerifyDialog(true);
    } catch (error: unknown) {
      console.error('验证备份失败:', error);
      setBackupVerification(backupId, 'failed');
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('backup');
    }
  }, [startTabLoading, stopTabLoading, setBackupVerification]);

  // 恢复备份（异步，含磁盘空间预检查）
  const restoreBackup = useCallback(async (backupId: string) => {
    // 如果已有任务在运行，不允许再次启动
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }
    const selectedBackup = backups.find((backup) => backup.path === backupId);
    if (
      selectedBackup &&
      !(selectedBackup.restorable ?? selectedBackup.backup_type === 'full')
    ) {
      showGlobalNotification(
        'warning',
        t('data:governance.restore_non_full_not_supported'),
      );
      return;
    }

    // Task 1: 恢复前磁盘空间检查
    startTabLoading('backup');
    try {
      const spaceCheck = await DataGovernanceApi.checkDiskSpaceForRestore(backupId);
      if (!spaceCheck.has_enough_space) {
        const availableGB = (spaceCheck.available_bytes / 1024 / 1024 / 1024).toFixed(2);
        const requiredGB = (spaceCheck.required_bytes / 1024 / 1024 / 1024).toFixed(2);
        showGlobalNotification(
          'error',
          t('data:governance.restore_insufficient_space', { required: requiredGB, available: availableGB })
        );
        stopTabLoading('backup');
        return;
      }
    } catch (error: unknown) {
      // 只有 API 层确认是旧后端 CommandNotFound 时才会返回兼容结果。
      // 权限、I/O、清单损坏、目标卷不明等错误必须 fail-close。
      console.error('磁盘空间检查失败，已阻止恢复:', error);
      showGlobalNotification('error', getErrorMessage(error));
      stopTabLoading('backup');
      return;
    }

    setIsBackupRunning(true);
    setBackupProgress(null);
    setJobOperation('restore');
    enterMaintenanceMode(t('data:governance.maintenance_restore'));

    try {
      // 启动后台恢复任务
      const response = await DataGovernanceApi.restoreBackup(backupId);
      setBackupJobId(response.job_id);

      showGlobalNotification('info', t('data:governance.restore_started'), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });

      // 使用统一的监听 Hook
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('恢复备份失败:', error);
      showGlobalNotification('error', getErrorMessage(error), undefined, {
        replaceKey: BACKUP_JOB_NOTIFICATION_KEY,
      });
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
    }
  }, [backups, setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, t, isBackupRunning, startTabLoading, stopTabLoading]);

  // 执行云端同步（带进度事件）
  const runCloudSync = useCallback(async (
    direction: 'upload' | 'download' | 'bidirectional',
    strategy: MergeStrategy
  ): Promise<boolean> => {
    if (isSyncRunning || syncInFlightRef.current) {
      showGlobalNotification(
        'warning',
        t('data:governance.sync_already_running')
      );
      return false;
    }
    // 全局占用：拦截来自其他入口（如设置页同步区块）的并发触发
    if (!useGlobalSyncStore.getState().beginSync('data-governance')) {
      showGlobalNotification(
        'warning',
        t('data:governance.sync_already_running')
      );
      return false;
    }
    syncInFlightRef.current = true;

    lastSyncRequestRef.current = { direction, strategy };
    startTabLoading('sync');
    setIsSyncRunning(true);
    // 结束时保留展示的进度：失败时带 error，供面板继续显示错误结论
    let finalProgress: SyncProgress | null = null;
    const failWith = (errorMessage: string) => {
      finalProgress = createFailedSyncProgress(
        useGlobalSyncStore.getState().progress,
        errorMessage,
      );
    };
    let succeeded = false;

    try {
      const cloudConfig = await loadCloudSyncConfig();
      if (!cloudConfig) {
        setCloudSyncConfigured(false);
        showGlobalNotification(
          'warning',
          t('data:governance.cloud_sync_not_configured'),
          t('data:governance.cloud_sync_configure_now')
        );
        return false;
      }
      setCloudSyncConfigured(true);

      // 同步断层预检必须 fail-close。检测本身失败也不能继续，因为此时无法
      // 证明本地游标仍被云端历史覆盖。
      if (direction !== 'upload') {
        const gap = await DataGovernanceApi.detectPruneGap(cloudConfig);
        if (gap.has_gap) {
          const since = gap.since_version;
          const minAvail = gap.min_available_version ?? 0;
          throw new Error(gap.gap_details ?? t('data:governance.sync_prune_gap_warning', {
            since,
            minAvail,
          }));
        }
      }

      enterMaintenanceMode(t('data:governance.maintenance_sync'));

      // 进度由应用级监听写入全局 store（不绑定本组件实例）；成功与否以命令
      // 返回结果为准
      const result = await DataGovernanceApi.runSyncWithProgress(
        direction,
        cloudConfig,
        strategy
      );

      if (result.success) {
        succeeded = true;
        let unresolvedQuarantine = 0;
        try {
          const items = await DataGovernanceApi.listQuarantine(500, 0);
          unresolvedQuarantine = Array.isArray(items) ? items.length : 0;
        } catch {
          // ignore quarantine count check failure
        }
        let liveConflictCount = 0;
        try {
          liveConflictCount = await useGlobalSyncStore.getState().refreshUnresolvedConflictCount();
        } catch {
          // ignore optional conflict count failure
        }
        const effectiveConflictCount = Math.max(liveConflictCount, result.conflicts_detected ?? 0);
        if (effectiveConflictCount > liveConflictCount) {
          useGlobalSyncStore.getState().setUnresolvedConflictCount(effectiveConflictCount);
        }
        window.dispatchEvent(new CustomEvent('data-governance:local-change'));
        if (result.error_message || (result.skipped_changes ?? 0) > 0 || unresolvedQuarantine > 0) {
          const skipped = result.skipped_changes ?? 0;
          const rawMsg = result.error_message;
          const msg = rawMsg
            ? sanitizeAclErrorMessage(rawMsg, t, i18n?.language)
            : unresolvedQuarantine > 0
              ? t('data:governance.sync_partial_with_quarantine', {
                  count: unresolvedQuarantine,
                  defaultValue: `同步部分完成：${unresolvedQuarantine} 条变更应用失败（详见隔离区）`,
                })
              : t('data:governance.sync_partial_with_skipped', {
                  skipped,
                });
          showGlobalNotification('warning', msg);
        } else if (effectiveConflictCount > 0) {
          showGlobalNotification(
            'warning',
            t('data:governance.sync_completed_with_conflicts', {
              count: effectiveConflictCount,
            }),
          );
        } else {
          showGlobalNotification('success', t('data:governance.sync_success'));
        }
        setConflicts(null);
      } else {
        const errorMessage = result.error_message ?? t('data:governance.sync_failed');
        if (isSyncCancelledMessage(errorMessage)) {
          finalProgress = null;
          showGlobalNotification('info', t('data:governance.sync_cancelled'));
        } else {
          const sanitized = sanitizeAclErrorMessage(errorMessage, t, i18n?.language);
          failWith(sanitized);
          notifyErrorDeduped('error', sanitized);
        }
      }

      await loadSyncStatus();
      return succeeded;
    } catch (error: unknown) {
      console.error('云端同步失败:', error);
      const rawMessage = getErrorMessage(error);
      if (isSyncCancelledMessage(rawMessage)) {
        finalProgress = null;
        showGlobalNotification('info', t('data:governance.sync_cancelled'));
      } else {
        const errorMessage = sanitizeAclErrorMessage(rawMessage, t, i18n?.language);
        failWith(errorMessage);
        if (shouldNotifyDeduped('error', errorMessage)) {
          showGlobalNotification('error', errorMessage);
        }
      }
      return false;
    } finally {
      stopTabLoading('sync');
      setIsSyncRunning(false);
      syncInFlightRef.current = false;
      useGlobalSyncStore.getState().endSync(finalProgress);
      exitMaintenanceMode();
    }
  }, [
    isSyncRunning,
    loadCloudSyncConfig,
    loadSyncStatus,
    enterMaintenanceMode,
    exitMaintenanceMode,
    startTabLoading,
    stopTabLoading,
    i18n?.language,
    t,
  ]);

  // 检测冲突
  const detectConflicts = useCallback(async () => {
    if (isSyncRunning || syncInFlightRef.current) {
      showGlobalNotification(
        'warning',
        t('data:governance.sync_already_running')
      );
      return;
    }
    if (detectInFlightRef.current) {
      showGlobalNotification(
        'warning',
        t('data:governance.detect_conflicts_running')
      );
      return;
    }
    detectInFlightRef.current = true;
    startTabLoading('sync');
    setConflicts(null);
    try {
      const cloudConfig = await loadCloudSyncConfig();

      if (!cloudConfig) {
        showGlobalNotification(
          'warning',
          t('data:governance.cloud_sync_not_configured'),
          t('data:governance.cloud_sync_configure_now')
        );
        return;
      }

      const [result, recordCounts] = await Promise.all([
        DataGovernanceApi.detectConflicts(undefined, cloudConfig),
        typeof DataGovernanceApi.countRecordConflicts === 'function'
          ? DataGovernanceApi.countRecordConflicts().catch(() => null)
          : Promise.resolve(null),
      ]);
      const unresolvedRecordGroups = recordCounts?.total_groups ?? 0;
      if (recordCounts) {
        useGlobalSyncStore.getState().setUnresolvedConflictCount(
          unresolvedRecordGroups,
          recordCounts.per_database,
        );
      }
      const mergedResult: ConflictDetectionResponse = {
        ...result,
        record_conflict_count: Math.max(result.record_conflict_count ?? 0, unresolvedRecordGroups),
        has_conflicts: Boolean(result.has_conflicts || unresolvedRecordGroups > 0),
      };
      setConflicts(mergedResult);

      showGlobalNotification(
        mergedResult.has_conflicts ? 'warning' : 'success',
        mergedResult.has_conflicts
          ? t('data:governance.conflicts_found')
          : t('data:governance.no_conflicts')
      );
    } catch (error: unknown) {
      console.error('检测冲突失败:', error);
      setConflicts(null);
      notifyErrorDeduped('error', formatGovernanceError(error, t, i18n?.language));
    } finally {
      stopTabLoading('sync');
      detectInFlightRef.current = false;
    }
  }, [isSyncRunning, loadCloudSyncConfig, startTabLoading, stopTabLoading, i18n?.language, t]);

  const [externalConflictJumpSignal, setExternalConflictJumpSignal] = useState(0);

  // 跳转到记录级冲突面板（旧版批量清单级覆盖接口 data_governance_resolve_conflicts 已停用）
  const jumpToRecordConflicts = useCallback(() => {
    setSyncTabVisited(true);
    setActiveTab('sync');
    setExternalConflictJumpSignal((n) => n + 1);
    const scrollToPanel = () => {
      if (typeof document === 'undefined') return;
      const el = document.getElementById('record-conflicts-panel');
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => scrollToPanel());
    } else {
      scrollToPanel();
    }
  }, []);

  // 预取审计日志：提升切换体验（并与单测期望对齐）
  useEffect(() => {
    let mounted = true;
    const generation = ++auditRequestGeneration.current;
    void (async () => {
      try {
        const result = await DataGovernanceApi.getAuditLogs(undefined, undefined, AUDIT_PAGE_SIZE);
        if (mounted && auditRequestGeneration.current === generation) {
          const logs = Array.isArray(result) ? result : Array.isArray(result?.logs) ? result.logs : [];
          setAuditLogs(logs);
          setAuditTotal(typeof result?.total === 'number' ? result.total : logs.length);
          setAuditLoadError(null);
        }
      } catch (error: unknown) {
        console.error('预加载审计日志失败:', error);
        if (mounted && auditRequestGeneration.current === generation) {
          setAuditLoadError(getErrorMessage(error));
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const loadActiveTab = useCallback(() => {
    switch (activeTab) {
      case 'overview':
        void loadOverviewData();
        break;
      case 'recovery':
        void loadBackups();
        break;
      case 'backup':
        void loadBackups();
        void loadResumableJobs();
        break;
      case 'sync':
        setSyncTabVisited(true);
        void loadSyncStatus();
        break;
      case 'audit':
        void loadAuditLogs();
        break;
    }
  }, [
    activeTab,
    loadOverviewData,
    loadBackups,
    loadResumableJobs,
    loadSyncStatus,
    loadAuditLogs,
  ]);

  useRefreshOnReturn(() => activeTab === 'audit' ? reloadAuditLogs() : loadActiveTab());

  useEffect(loadActiveTab, [loadActiveTab]);

  // 首屏冷启动即水合本地备份统计与同步/云存储配置，避免概览页与同步页在首次访问前显示 0 / 未配置
  // embedded 模式下由当前激活 Tab 按需加载，保持原有按需请求契约
  useEffect(() => {
    if (embedded) return;
    void loadBackups();
    void loadSyncStatus({ silent: true });
    void refreshCloudSyncConfigured();
  }, [embedded, loadBackups, loadSyncStatus, refreshCloudSyncConfigured]);

  // 停留在同步标签页时后台静默轮询 + 监听本地编辑/窗口获焦，离线也能及时更新待同步计数
  useEffect(() => {
    if (activeTab !== 'sync') return;
    const refreshSilently = () => {
      if (!syncInFlightRef.current) {
        void loadSyncStatus({ silent: true });
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshSilently();
      }
    };
    const intervalId = window.setInterval(refreshSilently, 5000);
    window.addEventListener('data-governance:local-change', refreshSilently);
    window.addEventListener('focus', refreshSilently);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('data-governance:local-change', refreshSilently);
      window.removeEventListener('focus', refreshSilently);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activeTab, loadSyncStatus]);

  // 监听可恢复任务事件（应用启动时发送）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let mounted = true;
    
    void (async () => {
      try {
        const maybeUnlisten = await listen<unknown[]>('backup-jobs-resumable', (event) => {
          // 检查组件是否仍然挂载
          if (!mounted) return;

          // 启动事件只负责提示；重新走列表命令，以取得后端根据 ZIP 条目
          // 实时计算的 requires_password，避免密封导入续传绕过口令对话框。
          void loadResumableJobs();
          const count = Array.isArray(event.payload) ? event.payload.length : 0;
          if (count > 0) {
            showGlobalNotification(
              'info',
              tRef.current('data:governance.resumable_jobs_found', {
                count,
              })
            );
          }
        });

        if (!mounted) {
          // 组件已卸载，立即清理
          if (typeof maybeUnlisten === 'function') {
            maybeUnlisten();
          }
          return;
        }

        if (typeof maybeUnlisten === 'function') {
          unlisten = maybeUnlisten;
        }
      } catch (error: unknown) {
        // 测试环境或非 Tauri 环境下可能不可用；静默失败即可
      }
    })();
    
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [loadResumableJobs]);

  // 组件挂载时自动重连到正在运行的备份任务
  useEffect(() => {
    let mounted = true;

    const reconnectRunningJob = async () => {
      // 如果已经在监听，不需要重连
      if (isBackupRunning) return;

      try {
        const maintenanceGeneration =
          useSystemStatusStore.getState().maintenanceGeneration;
        const allJobs = await DataGovernanceApi.listBackupJobs();
        const runningJob = allJobs.find(
          (j) => j.status === 'running' || j.status === 'queued'
        );

        if (
          runningJob
          && mounted
          && useSystemStatusStore.getState().maintenanceGeneration === maintenanceGeneration
        ) {
          setBackupJobId(runningJob.job_id);
          setIsBackupRunning(true);
          setBackupProgress({
            job_id: runningJob.job_id,
            kind: runningJob.kind,
            status: runningJob.status,
            phase: runningJob.phase || '',
            progress: runningJob.progress ?? 0,
            message: runningJob.message || '',
          } as BackupJobEvent);

          // 恢复维护模式（防止导航切换后丢失）
          enterMaintenanceMode(
            runningJob.kind === 'import'
              ? t('data:governance.maintenance_restore')
              : t('data:governance.maintenance_backup')
          );

          // 重新建立进度监听
          await startListening(runningJob.job_id);
          return;
        }

        // 页面卸载期间任务可能已经结束。listener 的终态回调此时不会执行，
        // 需要以后端维护状态为真相清理前端残留；恢复切槽成功时后端仍为 true，
        // 因而不会误解除等待重启的安全屏障。
        if (
          mounted
          && useSystemStatusStore.getState().maintenanceGeneration === maintenanceGeneration
        ) {
          const maintenance = await DataGovernanceApi.getMaintenanceStatus();
          if (
            !mounted
            || useSystemStatusStore.getState().maintenanceGeneration !== maintenanceGeneration
          ) {
            return;
          }
          if (maintenance?.is_in_maintenance_mode) {
            const opKind = (maintenance as { current_operation?: { kind?: string } | null }).current_operation?.kind;
            const hasBlockedWithoutOp =
              !opKind && (maintenance.blocked_components?.length ?? 0) > 0;
            const hasComponentIssues = (maintenance.component_issues?.length ?? 0) > 0;
            if (opKind === 'restore' || hasBlockedWithoutOp || hasComponentIssues) {
              enterMaintenanceMode(t('data:governance.maintenance_restore'));
            }
          } else {
            exitMaintenanceMode();
          }
        }
      } catch (error: unknown) {
        console.error('检查运行中的备份任务失败:', error);
        showGlobalNotification(
          'warning',
          t('data:governance.reconnect_running_job_failed')
        );
      }
    };

    void reconnectRunningJob();

    return () => {
      mounted = false;
    };
  }, []); // 仅在挂载时执行一次

  const revealActiveMaintenanceDetail = useCallback(() => {
    const reasonText = maintenanceReason ?? '';
    let nextTab: DashboardTab = activeTab;
    if (isSyncRunning || globalSyncing || /同步|sync/i.test(reasonText)) {
      nextTab = 'sync';
      setSyncTabVisited(true);
    } else if (isBackupRunning) {
      nextTab = 'backup';
    } else if (maintenanceRequiresRestart) {
      nextTab = 'recovery';
    } else if (/云|cloud/i.test(reasonText)) {
      nextTab = 'sync';
      setSyncTabVisited(true);
      setShowCloudSettingsEditor(true);
    } else if (/恢复|restore/i.test(reasonText)) {
      nextTab = 'recovery';
    } else if (maintenanceMode) {
      nextTab = cloudSyncConfigured ? 'sync' : 'backup';
      if (nextTab === 'sync') {
        setSyncTabVisited(true);
        setShowCloudSettingsEditor(true);
      }
    }
    setActiveTab(nextTab);
    const scrollDetailPanel = () => {
      if (typeof document === 'undefined') return;
      const target = document.querySelector<HTMLElement>(
        '[data-testid="active-sync-progress-panel"], [data-testid="cloud-op-progress-panel"], [data-testid="active-backup-progress-panel"], [data-testid="sync-status-overview-card"], [data-testid="recovery-quick-actions"]',
      );
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => scrollDetailPanel());
    } else {
      scrollDetailPanel();
    }
  }, [
    activeTab,
    cloudSyncConfigured,
    globalSyncing,
    isBackupRunning,
    isSyncRunning,
    maintenanceMode,
    maintenanceReason,
    maintenanceRequiresRestart,
  ]);

  useAppEvent(
    APP_EVENTS.SETTINGS_NAVIGATE_TAB,
    (detail) => {
      if (
        (detail.tab === 'data-governance' || (detail.tab as string) === 'data') &&
        !detail.dataGovernanceTab &&
        (maintenanceMode || isSyncRunning || globalSyncing || isBackupRunning)
      ) {
        revealActiveMaintenanceDetail();
      }
    },
    [revealActiveMaintenanceDetail, maintenanceMode, isSyncRunning, globalSyncing, isBackupRunning],
  );

  // 启动/挂载即刷新持久化未解决冲突计数，并监听外部跳转冲突事件
  const refreshUnresolvedConflicts = useCallback(() => {
    const fn = useGlobalSyncStore?.getState?.()?.refreshUnresolvedConflictCount;
    if (typeof fn === 'function') {
      void fn();
    }
  }, []);

  useEffect(() => {
    refreshUnresolvedConflicts();
  }, [refreshUnresolvedConflicts]);

  useEventRegistry(
    [
      {
        target: 'window',
        type: 'data-governance:local-change',
        listener: () => { refreshUnresolvedConflicts(); },
      },
      {
        target: 'window',
        type: 'data-governance:jump-to-conflicts',
        listener: () => { jumpToRecordConflicts(); },
      },
    ],
    [jumpToRecordConflicts, refreshUnresolvedConflicts],
  );

  const tabTriggerClassName =
    'inline-flex shrink-0 max-w-full cursor-pointer min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-border/45 bg-muted/40 !px-2.5 sm:!px-3 !py-1.5 !text-xs text-muted-foreground data-[state=active]:border-primary/40 data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:shadow-none sm:justify-start [@media(pointer:coarse)]:!min-h-11';
  const isNativeMobile = !isWebUiShell() && readShellPlatform()?.kind === 'mobile';

  const content = (
    <Tabs value={activeTab} onValueChange={(v) => handleSelectTab(v as DashboardTab)} className="min-w-0">
      {unresolvedConflictCount > 0 && (
        <div
          role="alert"
          data-testid="governance-unresolved-conflicts-banner"
          className="mb-3 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-warning/45 bg-warning/10 px-3.5 py-2.5 text-xs text-foreground"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Warning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 space-y-0.5">
              <div className="font-semibold text-foreground">
                {t('data:governance.unresolved_conflicts_banner_title', {
                  count: unresolvedConflictCount,
                })}
              </div>
              <p className="text-muted-foreground leading-relaxed">
                {t('data:governance.unresolved_conflicts_banner_desc')}
              </p>
            </div>
          </div>
          <DsButton
            type="button"
            variant="warning"
            size="sm"
            data-testid="governance-unresolved-conflicts-jump-btn"
            onClick={jumpToRecordConflicts}
            className="h-7 shrink-0 px-2.5 text-xs"
          >
            {t('data:governance.unresolved_conflicts_go_resolve')}
          </DsButton>
        </div>
      )}
      {maintenanceMode && (
        <div
          role="status"
          data-testid="governance-maintenance-banner"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2 text-xs text-foreground"
        >
          <div className="flex min-w-0 items-center gap-2">
            <CircleNotch className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
            <span className="font-medium text-warning">
              {t('data:governance.maintenance_banner_active')}
            </span>
            {maintenanceReason && (
              <span className="truncate text-muted-foreground">
                · {maintenanceReason}
              </span>
            )}
          </div>
          <DsButton
            type="button"
            variant="outline"
            size="sm"
            data-testid="governance-maintenance-view-details"
            onClick={revealActiveMaintenanceDetail}
            className="h-7 px-2.5 text-xs"
          >
            {t('data:governance.maintenance_view_details', {
              defaultValue: i18n?.language?.startsWith('en') ? 'View Details' : '查看详情',
            })}
          </DsButton>
        </div>
      )}
      {/* 移动端（如 360px）使用 !flex !h-auto flex-wrap 自动换行，防止固定 h-10 截断与死点。 */}
      <div className="relative z-10 mb-4 min-w-0 max-w-full" data-testid="governance-tabs-strip">
        <TabsList
          aria-label={t('data:governance.tabs_nav_label')}
          style={{ height: 'auto' }}
          className="!flex !h-auto !min-h-0 !w-full min-w-0 max-w-full flex-wrap items-center justify-start !gap-1.5 rounded-none border-b border-border/40 bg-transparent !p-0 !pb-3"
        >
          <TabsTrigger value="overview" aria-label={t('data:governance.tab_overview')} className={tabTriggerClassName}>
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap text-xs">{t('data:governance.tab_overview')}</span>
          </TabsTrigger>
          <TabsTrigger value="recovery" aria-label={t('data:governance.tab_recovery')} className={tabTriggerClassName}>
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap text-xs">{t('data:governance.tab_recovery')}</span>
          </TabsTrigger>
          <TabsTrigger value="archive" aria-label={t('data:governance.tab_archive')} className={tabTriggerClassName}>
            <Archive className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap text-xs">{t('data:governance.tab_archive')}</span>
          </TabsTrigger>
          <TabsTrigger value="backup" aria-label={t('data:governance.tab_backup')} className={tabTriggerClassName}>
            <HardDrive className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap text-xs">{t('data:governance.tab_backup')}</span>
          </TabsTrigger>
          <TabsTrigger value="sync" aria-label={t('data:governance.tab_sync')} className={tabTriggerClassName}>
            <Cloud className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap text-xs">{t('data:governance.tab_sync')}</span>
            {unresolvedConflictCount > 0 && (
              <span
                data-testid="governance-sync-tab-conflict-badge"
                className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-warning/20 px-1.5 text-2xs font-semibold tabular-nums text-warning ring-1 ring-inset ring-warning/40"
              >
                {unresolvedConflictCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="audit" aria-label={t('data:governance.tab_audit')} className={tabTriggerClassName}>
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap text-xs">{t('data:governance.tab_audit')}</span>
          </TabsTrigger>
          <TabsTrigger value="cache" aria-label={t('data:governance.tab_cache')} className={tabTriggerClassName}>
            <Image className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap text-xs">{t('data:governance.tab_cache')}</span>
          </TabsTrigger>
          {/* Debug 页签只在开发构建出现：生产里它的控件全部 disabled，
              对用户是一个「点得到但什么都不能做」的死页签，移动端尤其误导。 */}
          {debugTabEnabled && (
            <TabsTrigger value="debug" aria-label={t('data:governance.debug_tab_title')} className={tabTriggerClassName}>
              <Bug className="h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-nowrap text-xs">{t('data:governance.debug_tab_title')}</span>
            </TabsTrigger>
          )}
        </TabsList>
        {!hideHeaderQuickSync && cloudSyncConfigured && activeTab !== 'sync' && (
          <div className="mt-2 flex justify-end">
            <QuickSyncNowButton
              dataTestId="governance-quick-sync-now-btn"
              cloudConfiguredOverride={cloudSyncConfigured}
              onSyncTrigger={() => runCloudSync('bidirectional', syncStrategy)}
            />
          </div>
        )}
      </div>

      <TabsContent value="overview">
        {isNativeMobile && <SecurityStatusIndicator className="mb-4" />}
        <OverviewTab
          migrationStatus={migrationStatus}
          healthCheck={healthCheck}
          loading={overviewLoading}
          onRunHealthCheck={runHealthCheck}
          backups={hasLoadedBackups ? backups : undefined}
          lastAutoVerifyResult={lastAutoVerifyResult}
          isVerifying={isAutoVerifying}
          onVerifyLatestBackup={verifyLatestBackup}
          onOpenArchive={() => setActiveTab('archive')}
          onOpenSync={() => handleSelectTab('sync')}
        />
      </TabsContent>

      <TabsContent value="recovery">
        <div className="space-y-6">
          <section data-testid="recovery-quick-actions" className="min-w-0">
            <GroupTitle
              title={t('data:governance.recovery_quick_title', {
                defaultValue: '从备份或快照恢复数据',
              })}
              description={t('data:governance.recovery_quick_desc', {
                defaultValue: '可直接导入加密备份 (.zip) 或选择本机完整快照一键恢复。',
              })}
            />
            <div className="rounded-2xl bg-muted p-4 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <DsButton
                  variant="primary"
                  size="sm"
                  onClick={() => setShowRecoveryImportDialog(true)}
                  disabled={backupLoading || isBackupRunning}
                  className="rounded-xl border-primary/40 bg-primary/15 px-4 font-medium text-primary hover:bg-primary/25 [@media(pointer:coarse)]:!h-11"
                >
                  <Upload className="h-4 w-4 mr-1.5" />
                  {t('data:governance.recovery_import_encrypted_zip', {
                    defaultValue: '导入加密备份 (.zip)',
                  })}
                </DsButton>
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveTab('backup')}
                  className="rounded-xl border-border/70 bg-background/60 px-4 text-foreground hover:bg-background/90 [@media(pointer:coarse)]:!h-11"
                >
                  <HardDrive className="h-4 w-4 mr-1.5" />
                  {t('data:governance.recovery_manage_backups', {
                    defaultValue: '前往备份管理',
                  })}
                </DsButton>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">
                  {t('data:governance.recovery_restore_local_snapshot', {
                    defaultValue: '从本地快照恢复',
                  })}
                </div>
                {backupLoading && backups.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                    <CircleNotch size={14} className="animate-spin" />
                    {t('common:status.loading')}
                  </div>
                ) : backups.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-1">
                    {t('data:governance.no_backups')}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {backups.map((backup) => {
                      const preRestoreSafety = isPreRestoreSafetySnapshot(backup);
                      const restorable = backup.restorable ?? backup.backup_type === 'full';
                      const ariaTime =
                        recoverySnapshotAriaLabels.get(backup.path) ??
                        formatTimestamp(backup.created_at);
                      return (
                        <div
                          key={backup.path}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-background/60 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground whitespace-nowrap">
                              {formatTimestamp(backup.created_at)}
                            </span>
                            <Badge
                              variant={
                                preRestoreSafety
                                  ? 'secondary'
                                  : backup.backup_type === 'full'
                                    ? 'default'
                                    : 'secondary'
                              }
                              className="rounded-sm font-normal whitespace-nowrap"
                            >
                              {preRestoreSafety
                                ? t('data:governance.backup_type_pre_restore', {
                                    defaultValue: '[恢复前安全快照]',
                                  })
                                : backup.recovery_kind === 'partial_archive'
                                  ? t('data:governance.partial_archive', {
                                      defaultValue: 'Partial archive',
                                    })
                                  : backup.backup_type === 'full'
                                    ? t('data:governance.full')
                                    : t('data:governance.partial_overlay')}
                            </Badge>
                            <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                              {formatBytes(backup.size)}
                            </span>
                          </div>
                          <DsButton
                            variant="outline"
                            size="sm"
                            disabled={isBackupRunning || !restorable}
                            onClick={() => setPendingRecoveryRestoreId(backup.path)}
                            aria-label={t('data:governance.restore_snapshot_aria', {
                              time: ariaTime,
                              defaultValue: '恢复 {{time}} 快照',
                            })}
                            className="gap-1.5 [@media(pointer:coarse)]:!min-h-11"
                          >
                            <ArrowCounterClockwise size={14} className="shrink-0" />
                            <span>{t('data:governance.restore')}</span>
                          </DsButton>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </section>
          <RecoveryCenter mode="settings" />
          <DataMaintenanceSection />
        </div>
        <BackupImportDialog
          open={showRecoveryImportDialog}
          onOpenChange={setShowRecoveryImportDialog}
          onImportZip={importZip}
        />
        {(() => {
          const pendingBackup = pendingRecoveryRestoreId
            ? backups.find((b) => b.path === pendingRecoveryRestoreId) ?? null
            : null;
          const snapshotName = pendingRecoveryRestoreId
            ? pendingRecoveryRestoreId.split(/[/\\]/).filter(Boolean).pop() ||
              pendingRecoveryRestoreId
            : '-';
          const snapshotTime = pendingBackup
            ? formatTimestamp(pendingBackup.created_at)
            : '-';
          const listSep = i18n?.language?.startsWith('zh') ? '、' : ', ';
          const coveredDbsText =
            pendingBackup && pendingBackup.databases.length > 0
              ? pendingBackup.databases
                  .map((dbId) => getDatabaseDisplayName(dbId, t))
                  .join(listSep)
              : t('data:governance.full');
          return (
            <DsAlertDialog
              open={pendingRecoveryRestoreId !== null}
              onOpenChange={(open) => {
                if (!open) setPendingRecoveryRestoreId(null);
              }}
              title={t('data:governance.confirm_restore_title')}
              description={t('data:governance.restore_warning')}
              confirmText={t('data:governance.restore')}
              cancelText={t('common:actions.cancel')}
              confirmVariant="warning"
              onConfirm={() => {
                const targetId = pendingRecoveryRestoreId;
                setPendingRecoveryRestoreId(null);
                if (targetId) void restoreBackup(targetId);
              }}
            >
              <div
                data-testid="recovery-restore-confirm-details"
                className="space-y-1.5 text-xs text-muted-foreground"
              >
                <p className="font-medium text-foreground">
                  {t('data:governance.restore_dialog_snapshot_info', {
                    name: snapshotName,
                    time: snapshotTime,
                  })}
                </p>
                <p>
                  {t('data:governance.restore_dialog_covered_dbs', {
                    databases: coveredDbsText,
                  })}
                </p>
                <p>{t('data:governance.restore_dialog_safety_backup_notice')}</p>
                <p>{t('data:governance.restore_dialog_reload_notice')}</p>
                <p className="text-warning font-medium">
                  {t('data:governance.restore_save_work_warning')}
                </p>
              </div>
            </DsAlertDialog>
          );
        })()}
        <DsAlertDialog
          open={showRestorePromptDialog}
          onOpenChange={(open) => {
            if (!open) {
              setShowRestorePromptDialog(false);
              setImportedBackupId(null);
            }
          }}
          title={t('data:governance.import_complete_title')}
          description={
            <div className="space-y-2">
              <p>{t('data:governance.import_complete_desc')}</p>
              <p className="text-warning font-medium">
                {t('data:governance.restore_save_work_warning')}
              </p>
            </div>
          }
          confirmText={t('data:governance.restore_now')}
          cancelText={t('data:governance.restore_later')}
          confirmVariant="warning"
          onConfirm={() => {
            const targetId = importedBackupId;
            setShowRestorePromptDialog(false);
            setImportedBackupId(null);
            if (targetId) void restoreBackup(targetId);
          }}
        />
        <DsAlertDialog
          open={showRestartDialog}
          onOpenChange={() => undefined}
          title={t('data:governance.restore_complete_title')}
          description={
            <div className="space-y-2">
              <p>{t('data:governance.restore_complete_desc')}</p>
              <p className="text-warning font-medium">
                {t('data:governance.restore_save_work_warning')}
              </p>
            </div>
          }
          confirmText={t('data:governance.restart_now')}
          cancelText={t('common:actions.cancel')}
          confirmVariant="primary"
          onConfirm={async () => {
            setShowRestartDialog(false);
            try {
              await TauriAPI.restartApp();
              if (import.meta.env.DEV || isWebUiShell()) {
                window.location.reload();
              }
            } catch (error: unknown) {
              console.error('重启应用失败:', error);
              showGlobalNotification('error', getErrorMessage(error));
            }
          }}
        />
      </TabsContent>

      <TabsContent value="archive">
        <ChatSessionArchiveTab />
      </TabsContent>

      <TabsContent value="backup">
        <BackupTab
          backups={backups}
          loading={backupLoading}
          onCreateLocalBackup={createLocalBackup}
          onBackupAndExportZip={backupAndExportZip}
          onDeleteBackup={deleteBackup}
          onVerifyBackup={verifyBackup}
          verificationStatusMap={verificationStatusMap}
          onRestoreBackup={restoreBackup}
          onExportZip={exportZip}
          onImportZip={importZip}
          backupProgress={backupProgress}
          isBackupRunning={isBackupRunning}
          onCancelBackup={cancelBackup}
          currentJobOperation={currentJobOperation}
          resumableJobs={resumableJobs}
          onResumeJob={resumeJob}
          showRestartDialog={showRestartDialog}
          onRestartNow={async () => {
            setShowRestartDialog(false);
            try {
              await TauriAPI.restartApp();
              if (import.meta.env.DEV || isWebUiShell()) {
                window.location.reload();
              }
            } catch (error: unknown) {
              console.error('重启应用失败:', error);
              showGlobalNotification('error', getErrorMessage(error));
            }
          }}
          showRestorePromptDialog={showRestorePromptDialog}
          onRestoreNow={() => {
            setShowRestorePromptDialog(false);
            if (importedBackupId) {
              void restoreBackup(importedBackupId);
              setImportedBackupId(null);
            }
          }}
          onRestoreLater={() => {
            setShowRestorePromptDialog(false);
            setImportedBackupId(null);
          }}
          verifyResult={verifyResult}
          showVerifyDialog={showVerifyDialog}
          onCloseVerifyDialog={() => {
            setShowVerifyDialog(false);
            setVerifyResult(null);
          }}
        />
      </TabsContent>

      <TabsContent value="sync" forceMount className="min-w-0">
        {syncTabVisited ? (
          <SyncTab
            syncStatus={syncStatus}
            conflicts={conflicts}
            loading={syncLoading}
            onRefresh={loadSyncStatus}
            onDetectConflicts={detectConflicts}
            unresolvedConflictCount={unresolvedConflictCount}
            externalConflictFocusSignal={externalConflictJumpSignal}
            cloudSyncConfigured={cloudSyncConfigured}
            cloudSyncSummary={cloudSyncSummary}
            syncRunning={isSyncRunning || globalSyncing}
            syncProgress={syncProgress}
            syncCancelRequested={syncCancelRequested}
            onCancelSync={handleCancelSync}
            syncStrategy={syncStrategy}
            onSyncStrategyChange={setSyncStrategy}
            showCloudSettingsEditor={showCloudSettingsEditor}
            onToggleCloudSettingsEditor={toggleCloudStorageSettingsEditor}
            onSetCloudSettingsEditorOpen={setShowCloudSettingsEditor}
            onCloudConfigChanged={handleCloudConfigChanged}
            onRunSync={runCloudSync}
            onRetrySync={() =>
              runCloudSync(
                lastSyncRequestRef.current.direction,
                lastSyncRequestRef.current.strategy
              )
            }
            onViewAuditLog={() => setActiveTab('audit')}
          />
        ) : null}
      </TabsContent>

      <TabsContent value="audit">
        <AuditTab
          logs={auditLogs}
          loading={auditLoading}
          loadError={auditLoadError}
          onRefresh={reloadAuditLogs}
          onFilterChange={loadAuditLogs}
          total={auditTotal}
          onLoadMore={loadMoreAuditLogs}
          hasMore={auditLogs.length < auditTotal}
        />
      </TabsContent>

      <TabsContent value="cache">
        <div className="space-y-8">
          <MediaCacheSection />
          {!isNativeMobile && <LanceOptimizationPanel />}
        </div>
      </TabsContent>

      {debugTabEnabled && (
        <TabsContent value="debug">
          <DebugTab />
        </TabsContent>
      )}
    </Tabs>
  );

  if (embedded) {
    return content;
  }

  return (
    <SettingSection
      title={t('data:governance.title')}
      description={t('data:governance.description')}
      hideHeader
    >
      {content}
    </SettingSection>
  );
};

export default DataGovernanceDashboard;
