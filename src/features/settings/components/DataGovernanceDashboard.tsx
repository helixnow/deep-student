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
} from '@phosphor-icons/react';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/shad/Tabs';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { SettingSection } from './SettingsCommon';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import * as cloudApi from '@/utils/cloudStorageApi';

import {
  DataGovernanceApi,
  type BackupJobEvent,
  type ResumableJob,
  type DiskSpaceCheckResponse,
} from '@/api/dataGovernance';
import { listen } from '@tauri-apps/api/event';
import { MediaCacheSection } from './MediaCacheSection';
import { LanceOptimizationPanel } from './IndexMaintenanceSection';
import { useShallow } from 'zustand/react/shallow';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
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
  isSyncPhaseTerminal,
} from '@/types/dataGovernance';
import { open, save } from '@tauri-apps/plugin-dialog';
import { TauriAPI } from '@/utils/tauriApi';

// 拆分后的子组件
import { OverviewTab } from './data-governance/OverviewTab';
import { BackupTab, type BackupJobOperation } from './data-governance/BackupTab';
import { SyncTab } from './data-governance/SyncTab';
import { AuditTab } from './data-governance/AuditTab';
import { ChatSessionArchiveTab } from './data-governance/ChatSessionArchiveTab';
import { RecoveryCenter } from '@/features/data-recovery/RecoveryCenter';
import {
  createPartialDegradationDebugIssues,
  setRecoveryDebugScenario,
  type RecoveryDebugScenario,
} from '@/features/data-recovery/debugRecoveryScenarios';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

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
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-foreground">
          {t('data:governance.debug_panel_title')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('data:governance.debug_panel_desc')}
        </p>
      </div>

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

      {/* 清空所有应用数据（危险操作） */}
      <div className="border-t border-border/40 pt-6">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
          <div className="flex items-center gap-2 text-destructive font-medium">
            <Trash size={16} />
            {t('data:governance.danger_zone')}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('data:governance.purge_all_data_desc')}
          </p>
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
      </div>
    </div>
  );
};

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
}

export const DataGovernanceDashboard: React.FC<DataGovernanceDashboardProps> = ({
  embedded = false,
  tabTarget = null,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const { enterMaintenanceMode, requireMaintenanceRestart, exitMaintenanceMode } = useSystemStatusStore(
    useShallow((state) => ({
      enterMaintenanceMode: state.enterMaintenanceMode,
      requireMaintenanceRestart: state.requireMaintenanceRestart,
      exitMaintenanceMode: state.exitMaintenanceMode,
    }))
  );
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');

  useEffect(() => {
    if (!tabTarget) return;
    setActiveTab(tabTarget.tab);
  }, [tabTarget]);

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
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [conflicts, setConflicts] = useState<ConflictDetectionResponse | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogResponse[]>([]);
  const [auditTotal, setAuditTotal] = useState<number>(0);
  const [auditLoadError, setAuditLoadError] = useState<string | null>(null);

  // 审计日志分页
  const AUDIT_PAGE_SIZE = 50;
  const auditFilterRef = useRef<{ operationType?: AuditOperationType; status?: AuditStatus }>({});
  const auditRequestGeneration = useRef(0);

  // 云端同步状态（进度事件）
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [isSyncRunning, setIsSyncRunning] = useState(false);
  // 全局同步状态：其他入口（如设置页同步区块）正在同步时，本面板按钮也禁用
  const globalSyncing = useGlobalSyncStore((s) => s.isSyncing);
  const [syncStrategy, setSyncStrategy] = useState<MergeStrategy>('keep_latest');
  // 记录最近一次同步请求快照（用于重试）
  const lastSyncRequestRef = useRef<{
    direction: 'upload' | 'download' | 'bidirectional';
    strategy: MergeStrategy;
  }>({ direction: 'bidirectional', strategy: 'keep_latest' });
  const syncInFlightRef = useRef(false);
  const detectInFlightRef = useRef(false);
  const resolveInFlightRef = useRef(false);

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

  // 备份验证结果详细信息
  const [verifyResult, setVerifyResult] = useState<BackupVerifyResponse | null>(null);
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
  const [cloudSyncConfigured, setCloudSyncConfigured] = useState(false);
  const [showCloudSettingsEditor, setShowCloudSettingsEditor] = useState(false);

  const toggleCloudStorageSettingsEditor = useCallback(() => {
    setShowCloudSettingsEditor((prev) => !prev);
  }, []);

  const loadCloudSyncConfig = useCallback(async (): Promise<cloudApi.CloudStorageConfig | null> => {
    return await cloudApi.loadStoredCloudStorageConfigWithCredentials();
  }, []);

  const refreshCloudSyncConfigured = useCallback(async () => {
    try {
      const config = await loadCloudSyncConfig();
      setCloudSyncConfigured(Boolean(config));
    } catch (error: unknown) {
      console.error('读取云存储配置失败:', error);
      setCloudSyncConfigured(false);
    }
  }, [loadCloudSyncConfig]);

  const handleCloudConfigChanged = useCallback(() => {
    setCloudSyncSummary(readCloudSyncSummary());
    void refreshCloudSyncConfigured();
  }, [readCloudSyncSummary, refreshCloudSyncConfigured]);

  useEffect(() => {
    void refreshCloudSyncConfigured();
  }, [refreshCloudSyncConfigured]);

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
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('overview');
    }
  }, [startTabLoading, stopTabLoading]);

  // 加载备份列表
  const loadBackups = useCallback(async () => {
    startTabLoading('backup');
    try {
      const list = await DataGovernanceApi.getBackupList();
      setBackups(list);
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
        t('data:governance.resumable_jobs_load_failed')
      );
    }
  }, [t]);

  /**
   * 以后端聚合状态为真相收敛前端维护横幅。
   *
   * 退出屏障可能只在某个子库失败；此时任务已经终止，但继续撤掉横幅会让用户
   * 误以为可以写入。状态查询本身失败也保持 fail-close，提示重启恢复。
   */
  const reconcileMaintenanceMode = useCallback(async () => {
    const generation = useSystemStatusStore.getState().maintenanceGeneration;
    try {
      const status = await DataGovernanceApi.getMaintenanceStatus();
      // 查询期间若有新任务进入/退出维护模式，旧结果不得覆盖新状态。
      if (useSystemStatusStore.getState().maintenanceGeneration !== generation) return;
      if (status.is_in_maintenance_mode) {
        requireMaintenanceRestart(t('common:maintenance.recovery_required'));
      } else {
        exitMaintenanceMode();
      }
    } catch (error: unknown) {
      console.error('查询维护屏障聚合状态失败:', error);
      if (useSystemStatusStore.getState().maintenanceGeneration !== generation) return;
      requireMaintenanceRestart(t('common:maintenance.recovery_required'));
    }
  }, [exitMaintenanceMode, requireMaintenanceRestart, t]);

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
          resultSuccess ? t('data:governance.export_success_simple') : t('data:governance.backup_completed_with_issues')
        );
      } else if (op === 'zip_import') {
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.import_success_simple') : t('data:governance.backup_completed_with_issues')
        );
        void loadBackups();
        // 导入完成后提示用户是否立即恢复
        const backupId = stats && typeof stats === 'object'
          ? (stats as Record<string, unknown>).backup_id as string | undefined
          : undefined;
        if (backupId && resultSuccess) {
          setImportedBackupId(backupId);
          setShowRestorePromptDialog(true);
        }
      } else if (op === 'restore') {
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.restore_success_simple') : t('data:governance.backup_completed_with_issues')
        );
        void loadBackups();
        void loadOverviewData(); // 恢复后刷新概览数据
      } else if (op === 'tiered_backup') {
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.tiered_backup_success') : t('data:governance.backup_completed_with_issues')
        );
        void loadBackups();
      } else {
        // 普通备份完成
        showGlobalNotification(
          resultSuccess ? 'success' : 'warning',
          resultSuccess ? t('data:governance.backup_success') : t('data:governance.backup_completed_with_issues')
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

      // 刷新可恢复任务列表
      void loadResumableJobs();
    },
    onError: (event) => {
      setIsBackupRunning(false);
      stopTabLoading('backup');
      setBackupJobId(null);
      setJobOperation(null);
      void reconcileMaintenanceMode();
      showGlobalNotification(
        'error',
        localizeBackupJobError(event.result?.error || event.message, t),
      );
    },
    onCancelled: () => {
      setIsBackupRunning(false);
      stopTabLoading('backup');
      setBackupJobId(null);
      setJobOperation(null);
      void reconcileMaintenanceMode();
      showGlobalNotification('info', t('data:governance.backup_cancelled'));
      void loadResumableJobs();
    },
  });

  // 组件卸载时停止监听
  useEffect(() => {
    return () => {
      stopListening();
    };
  }, [stopListening]);

  // 恢复任务
  const resumeJob = useCallback(async (jobId: string) => {
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }
    setIsBackupRunning(true);
    setBackupProgress(null);
    const resumable = resumableJobs.find((j) => j.job_id === jobId);
    setJobOperation(resumable?.kind === 'import' ? 'zip_import' : 'backup');
    enterMaintenanceMode(t('data:governance.maintenance_backup'));
    
    try {
      const response = await DataGovernanceApi.resumeBackupJob(jobId);
      setBackupJobId(response.job_id);
      showGlobalNotification('info', t('data:governance.job_resumed'));
      
      // 使用统一的监听 Hook
      await startListening(response.job_id);
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
    }
  }, [isBackupRunning, resumableJobs, setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, t]);

  // 加载同步状态
  const loadSyncStatus = useCallback(async () => {
    startTabLoading('sync');
    // 每次加载同步状态时重新读取云存储配置，保证配置变更后及时反映
    setCloudSyncSummary(readCloudSyncSummary());
    void refreshCloudSyncConfigured();
    try {
      const status = await DataGovernanceApi.getSyncStatus();
      setSyncStatus(status);
    } catch (error: unknown) {
      console.error('加载同步状态失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('sync');
    }
  }, [startTabLoading, stopTabLoading, readCloudSyncSummary]);

  // 加载审计日志
  const loadAuditLogs = useCallback(async (
    operationType?: AuditOperationType,
    status?: AuditStatus
  ) => {
    const generation = ++auditRequestGeneration.current;
    auditFilterRef.current = { operationType, status };
    startTabLoading('audit');
    try {
      const result = await DataGovernanceApi.getAuditLogs(operationType, status, AUDIT_PAGE_SIZE, 0);
      const logs = Array.isArray(result) ? result : Array.isArray(result?.logs) ? result.logs : [];
      if (auditRequestGeneration.current === generation) {
        setAuditLogs(logs);
        setAuditTotal(typeof result?.total === 'number' ? result.total : logs.length);
        setAuditLoadError(null);
      }
    } catch (error: unknown) {
      console.error('加载审计日志失败:', error);
      setAuditLoadError(getErrorMessage(error));
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('audit');
    }
  }, [startTabLoading, stopTabLoading]);

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
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setIsAutoVerifying(false);
    }
  }, [isAutoVerifying, t]);

  // 一步导出备份（备份 + ZIP）
  const backupAndExportZip = useCallback(async (options: {
    compressionLevel: number;
    addToBackupList: boolean;
    useTiered: boolean;
    tiers?: string[];
    includeAssets?: boolean;
    assetTypes?: string[];
  }) => {
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }

    try {
      const savePath = await save({
        title: t('data:governance.save_zip'),
        defaultPath: `backup-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });

      if (!savePath) {
        return;
      }

      startTabLoading('backup');
      setIsBackupRunning(true);
      setBackupProgress(null);
      setJobOperation('backup');
      enterMaintenanceMode(t('data:governance.maintenance_backup'));

      const response = await DataGovernanceApi.backupAndExportZip(
        savePath,
        options.compressionLevel,
        options.addToBackupList,
        options.useTiered,
        options.tiers as any,
        options.includeAssets,
        options.assetTypes as any,
      );

      setBackupJobId(response.job_id);
      showGlobalNotification('info', t('data:governance.backup_and_export_started'));
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('备份并导出 ZIP 失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
    }
  }, [setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, t, isBackupRunning, startTabLoading, stopTabLoading]);

  // 取消备份
  const cancelBackup = useCallback(async () => {
    if (!backupJobId) {
      return;
    }

    try {
      const cancelled = await DataGovernanceApi.cancelBackup(backupJobId);
      if (cancelled) {
        showGlobalNotification('info', t('data:governance.backup_cancel_requested'));
      } else {
        showGlobalNotification('warning', t('data:governance.backup_cancel_failed'));
      }
    } catch (error: unknown) {
      console.error('取消备份失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [backupJobId, t]);

  // 导出为 ZIP（异步）
  const exportZip = useCallback(async (backupId: string, compressionLevel: number) => {
    // 如果已有任务在运行，不允许再次启动
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }

    try {
      // 让用户选择保存路径
      const savePath = await save({
        title: t('data:governance.save_zip'),
        defaultPath: `backup-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      
      if (!savePath) {
        return;
      }

      startTabLoading('backup');
      setIsBackupRunning(true);
      setBackupProgress(null);
      setJobOperation('zip_export');
      enterMaintenanceMode(t('data:governance.maintenance_export'));

      // 启动后台 ZIP 导出任务
      const response = await DataGovernanceApi.exportZip(
        backupId,
        savePath,
        compressionLevel,
        true // includeChecksums
      );
      setBackupJobId(response.job_id);

      showGlobalNotification('info', t('data:governance.export_started'));

      // 使用统一的监听 Hook
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('ZIP 导出失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
    }
  }, [setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, t, isBackupRunning, startTabLoading, stopTabLoading]);

  // 从 ZIP 导入（异步）
  const importZip = useCallback(async () => {
    // 如果已有任务在运行，不允许再次启动
    if (isBackupRunning) {
      showGlobalNotification('warning', t('data:governance.backup_already_running'));
      return;
    }

    try {
      // 让用户选择 ZIP 文件
      const selected = await open({
        title: t('data:governance.select_zip'),
        multiple: false,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });

      // 完整的空值检查
      if (!selected) {
        return;
      }

      // 处理数组情况（用户取消时可能返回空数组）
      let zipPath: string;
      if (Array.isArray(selected)) {
        if (selected.length === 0) {
          return; // 空数组，用户取消
        }
        zipPath = selected[0];
      } else {
        zipPath = selected;
      }

      // 确保 zipPath 有效
      if (!zipPath) {
        return;
      }

      startTabLoading('backup');
      setIsBackupRunning(true);
      setBackupProgress(null);
      setJobOperation('zip_import');
      enterMaintenanceMode(t('data:governance.maintenance_import'));

      // 启动后台 ZIP 导入任务
      const response = await DataGovernanceApi.importZip(zipPath);
      setBackupJobId(response.job_id);

      showGlobalNotification('info', t('data:governance.import_started'));

      // 使用统一的监听 Hook
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('ZIP 导入失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
      setIsBackupRunning(false);
      void reconcileMaintenanceMode();
      setJobOperation(null);
      stopTabLoading('backup');
    }
  }, [setJobOperation, enterMaintenanceMode, reconcileMaintenanceMode, startListening, t, isBackupRunning, startTabLoading, stopTabLoading]);

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
    try {
      const result = await DataGovernanceApi.verifyBackup(backupId);
      setVerifyResult(result);
      setShowVerifyDialog(true);
    } catch (error: unknown) {
      console.error('验证备份失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('backup');
    }
  }, [startTabLoading, stopTabLoading]);

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

      showGlobalNotification('info', t('data:governance.restore_started'));

      // 使用统一的监听 Hook
      await startListening(response.job_id);
    } catch (error: unknown) {
      console.error('恢复备份失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
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
  ) => {
    if (isSyncRunning || syncInFlightRef.current) {
      showGlobalNotification(
        'warning',
        t('data:governance.sync_already_running')
      );
      return;
    }
    // 全局占用：拦截来自其他入口（如设置页同步区块）的并发触发
    if (!useGlobalSyncStore.getState().beginSync('data-governance')) {
      showGlobalNotification(
        'warning',
        t('data:governance.sync_already_running')
      );
      return;
    }
    syncInFlightRef.current = true;

    lastSyncRequestRef.current = { direction, strategy };
    startTabLoading('sync');
    setIsSyncRunning(true);
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

    try {
      const cloudConfig = await loadCloudSyncConfig();
      if (!cloudConfig) {
        setCloudSyncConfigured(false);
        setSyncProgress(null);
        showGlobalNotification(
          'warning',
          t('data:governance.cloud_sync_not_configured'),
          t('data:governance.cloud_sync_configure_now')
        );
        return;
      }
      setCloudSyncConfigured(true);

      // 同步断层预检必须 fail-close。检测本身失败也不能继续，因为此时无法
      // 证明本地游标仍被云端历史覆盖。
      if (direction !== 'upload') {
        const gap = await DataGovernanceApi.detectPruneGap(cloudConfig);
        if (gap.has_gap) {
          const since = gap.since_version;
          const minAvail = gap.min_available_version ?? 0;
          throw new Error(t('data:governance.sync_prune_gap_warning', {
            since,
            minAvail,
          }));
        }
      }

      enterMaintenanceMode(t('data:governance.maintenance_sync'));

      const result = await DataGovernanceApi.runSyncWithProgressTracking(
        direction,
        cloudConfig,
        {
          onProgress: (progress) => {
            setSyncProgress(progress);
            if (isSyncPhaseTerminal(progress.phase)) {
              // 终态由最终结果兜底处理
            }
          },
        },
        strategy
      );

      if (result.success) {
        if (result.error_message || (result.skipped_changes ?? 0) > 0) {
          const skipped = result.skipped_changes ?? 0;
          const msg = result.error_message ?? t('data:governance.sync_partial_with_skipped', {
            skipped,
          });
          showGlobalNotification('warning', msg);
        } else {
          showGlobalNotification('success', t('data:governance.sync_success'));
        }
        setConflicts(null);
      } else {
        const errorMessage = result.error_message ?? t('data:governance.sync_failed');
        setSyncProgress((prev) => prev ? {
          ...prev,
          phase: 'failed',
          error: errorMessage,
        } : {
          phase: 'failed',
          percent: 0,
          current: 0,
          total: 0,
          current_item: null,
          speed_bytes_per_sec: null,
          eta_seconds: null,
          error: errorMessage,
        });
        showGlobalNotification('error', errorMessage);
      }

      await loadSyncStatus();
    } catch (error: unknown) {
      console.error('云端同步失败:', error);
      const errorMessage = getErrorMessage(error);
      setSyncProgress((prev) => prev ? {
        ...prev,
        phase: 'failed',
        error: errorMessage,
      } : {
        phase: 'failed',
        percent: 0,
        current: 0,
        total: 0,
        current_item: null,
        speed_bytes_per_sec: null,
        eta_seconds: null,
        error: errorMessage,
      });
      showGlobalNotification('error', errorMessage);
    } finally {
      stopTabLoading('sync');
      setIsSyncRunning(false);
      syncInFlightRef.current = false;
      useGlobalSyncStore.getState().endSync();
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

      const result = await DataGovernanceApi.detectConflicts(undefined, cloudConfig);
      setConflicts(result);

      showGlobalNotification(
        result.has_conflicts ? 'warning' : 'success',
        result.has_conflicts
          ? t('data:governance.conflicts_found')
          : t('data:governance.no_conflicts')
      );
    } catch (error: unknown) {
      console.error('检测冲突失败:', error);
      setConflicts(null);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('sync');
      detectInFlightRef.current = false;
    }
  }, [isSyncRunning, loadCloudSyncConfig, startTabLoading, stopTabLoading, t]);

  // 解决冲突
  const resolveConflicts = useCallback(async (strategy: MergeStrategy) => {
    if (resolveInFlightRef.current) {
      showGlobalNotification(
        'warning',
        t('data:governance.resolve_conflicts_running')
      );
      return;
    }
    if (conflicts?.needs_migration) {
      showGlobalNotification(
        'warning',
        t('data:governance.schema_mismatch_needs_migration')
      );
      return;
    }
    const cloudManifestJson = conflicts?.cloud_manifest_json;
    if (!cloudManifestJson) {
      showGlobalNotification('warning', t('data:governance.sync_conflict_manifest_missing'));
      return;
    }
    resolveInFlightRef.current = true;
    startTabLoading('sync');
    try {
      const result = await DataGovernanceApi.resolveConflicts(strategy, cloudManifestJson);
      if (result.success) {
        if (strategy === 'manual' && result.pending_manual_conflicts > 0) {
          const cloudConfig = await loadCloudSyncConfig();
          if (cloudConfig) {
            const refreshedConflicts = await DataGovernanceApi.detectConflicts(undefined, cloudConfig);
            setConflicts(refreshedConflicts);
          }
          showGlobalNotification(
            'warning',
            t('data:governance.conflicts_pending_manual', {
              count: result.pending_manual_conflicts,
            })
          );
        } else {
          showGlobalNotification('success', t('data:governance.conflicts_resolved'));
          setConflicts(null);
        }
        await loadSyncStatus();
      } else {
        showGlobalNotification('error', result.error_message || t('data:governance.sync_failed'));
      }
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      stopTabLoading('sync');
      resolveInFlightRef.current = false;
    }
  }, [conflicts, loadCloudSyncConfig, loadSyncStatus, startTabLoading, stopTabLoading, t]);

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

  // 根据 Tab 加载数据
  useEffect(() => {
    switch (activeTab) {
      case 'overview':
        void loadOverviewData();
        break;
      case 'backup':
        void loadBackups();
        void loadResumableJobs();
        break;
      case 'sync':
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

  // 监听可恢复任务事件（应用启动时发送）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let mounted = true;
    
    void (async () => {
      try {
        const maybeUnlisten = await listen<ResumableJob[]>('backup-jobs-resumable', (event) => {
          // 检查组件是否仍然挂载
          if (!mounted) return;

          setResumableJobs(event.payload);
          if (event.payload.length > 0) {
            showGlobalNotification(
              'info',
              t('data:governance.resumable_jobs_found', {
                count: event.payload.length,
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
  }, [t]);

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
          if (maintenance.is_in_maintenance_mode) {
            enterMaintenanceMode(t('data:governance.maintenance_restore'));
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

  const content = (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DashboardTab)}>
      <TabsList className="scrollbar-none mb-4 flex h-auto min-h-11 w-full max-w-full justify-start overflow-x-auto">
        <TabsTrigger value="overview" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 sm:min-h-0 sm:min-w-0">
          <Gauge className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.tab_overview')}</span>
        </TabsTrigger>
        <TabsTrigger value="recovery" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 sm:min-h-0 sm:min-w-0">
          <ShieldCheck className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.tab_recovery')}</span>
        </TabsTrigger>
        <TabsTrigger value="archive" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 sm:min-h-0 sm:min-w-0">
          <Archive className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.tab_archive')}</span>
        </TabsTrigger>
        <TabsTrigger value="backup" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 sm:min-h-0 sm:min-w-0">
          <HardDrive className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.tab_backup')}</span>
        </TabsTrigger>
        <TabsTrigger value="sync" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 sm:min-h-0 sm:min-w-0">
          <Cloud className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.tab_sync')}</span>
        </TabsTrigger>
        <TabsTrigger value="audit" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 sm:min-h-0 sm:min-w-0">
          <FileText className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.tab_audit')}</span>
        </TabsTrigger>
        <TabsTrigger value="cache" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 sm:min-h-0 sm:min-w-0">
          <Image className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.tab_cache')}</span>
        </TabsTrigger>
        <TabsTrigger value="debug" className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 text-muted-foreground sm:min-h-0 sm:min-w-0">
          <Bug className="h-4 w-4" />
          <span className="hidden sm:inline">{t('data:governance.debug_tab_title')}</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <OverviewTab
          migrationStatus={migrationStatus}
          healthCheck={healthCheck}
          loading={overviewLoading}
          onRefresh={loadOverviewData}
          onRunHealthCheck={runHealthCheck}
          lastAutoVerifyResult={lastAutoVerifyResult}
          isVerifying={isAutoVerifying}
          onVerifyLatestBackup={verifyLatestBackup}
          onOpenArchive={() => setActiveTab('archive')}
        />
      </TabsContent>

      <TabsContent value="recovery">
        <RecoveryCenter mode="settings" />
      </TabsContent>

      <TabsContent value="archive">
        <ChatSessionArchiveTab />
      </TabsContent>

      <TabsContent value="backup">
        <BackupTab
          backups={backups}
          loading={backupLoading}
          onRefresh={loadBackups}
          onBackupAndExportZip={backupAndExportZip}
          onDeleteBackup={deleteBackup}
          onVerifyBackup={verifyBackup}
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
              if (import.meta.env.DEV) {
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

      <TabsContent value="sync">
        <SyncTab
          syncStatus={syncStatus}
          conflicts={conflicts}
          loading={syncLoading}
          onRefresh={loadSyncStatus}
          onDetectConflicts={detectConflicts}
          onResolveConflicts={resolveConflicts}
          cloudSyncConfigured={cloudSyncConfigured}
          cloudSyncSummary={cloudSyncSummary}
          syncRunning={isSyncRunning || globalSyncing}
          syncProgress={syncProgress}
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
      </TabsContent>

      <TabsContent value="audit">
        <AuditTab
          logs={auditLogs}
          loading={auditLoading}
          loadError={auditLoadError}
          onRefresh={() => loadAuditLogs()}
          onFilterChange={loadAuditLogs}
          total={auditTotal}
          onLoadMore={loadMoreAuditLogs}
          hasMore={auditLogs.length < auditTotal}
        />
      </TabsContent>

      <TabsContent value="cache">
        <div className="space-y-8">
          <MediaCacheSection />
          <div className="border-t border-border/40" />
          <LanceOptimizationPanel />
        </div>
      </TabsContent>

      <TabsContent value="debug">
        <DebugTab />
      </TabsContent>
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
