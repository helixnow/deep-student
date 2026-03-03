import React, { useState, useCallback, useMemo, useRef } from 'react';
import { showGlobalNotification } from './UnifiedNotification';
import { getErrorMessage } from '../utils/errorUtils';
import { TauriAPI, BackupTier } from '../utils/tauriApi';
import { DataGovernanceApi } from '../api/dataGovernance';
import { fileManager, extractFileName } from '../utils/fileManager';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from './custom-scroll-area';
import {
  Upload, Download, AlertTriangle, Trash2, HardDrive, Clock, RefreshCw,
  FileArchive, X, Save, FileText, BarChart3, BookOpen, Brain, Database,
  Target, TrendingUp, Tag, Activity, Zap, AlertCircle, ArrowUpRight,
  ArrowDownRight, Loader2, Play, RotateCcw, Image, Info, Cloud, FlaskConical,
  CheckCircle2, XCircle, Square
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/shad/Card';
import { Alert, AlertDescription } from './ui/shad/Alert';
import { NotionButton } from '@/components/ui/NotionButton';
import { Checkbox } from './ui/shad/Checkbox';
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
  NotionDialogDescription,
  NotionDialogBody,
  NotionDialogFooter,
} from './ui/NotionDialog';
import { Badge } from './ui/shad/Badge';
import { Tabs, TabsList, TabsTrigger } from './ui/shad/Tabs';
import { Input } from './ui/shad/Input';
import { ImportConversationDialog } from './ImportConversationDialog';
import { SyncSettingsSection } from './settings/SyncSettingsSection';
import { SettingSection } from './settings/SettingsCommon';
import { HeaderTemplate } from './HeaderTemplate';
import { useAllStatistics } from '../hooks/useStatisticsData';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import { ChatV2StatsSection } from './ChatV2StatsSection';
import { LlmUsageStatsSection } from './llm-usage/LlmUsageStatsSection';
import { useChatV2Stats } from '../hooks/useChatV2Stats';
import { LearningHeatmap } from './LearningHeatmap';
import { Progress as ShadProgress } from './ui/shad/Progress';
import { useShallow } from 'zustand/react/shallow';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  RadialBarChart,
  RadialBar
} from 'recharts';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// Notion 风格设计系统 - 使用 CSS 变量，支持亮暗模式
const DESIGN = {
  // 图表颜色使用柔和的色调
  chart: [
    'hsl(var(--primary))',
    'hsl(var(--primary) / 0.8)',
    'hsl(var(--primary) / 0.6)',
    'hsl(var(--primary) / 0.4)',
    'hsl(217 91% 60%)',
    'hsl(142 76% 36%)',
    'hsl(199 89% 48%)',
    'hsl(262 83% 58%)'
  ]
};


const DATA_CENTER_ICON_CONTAINER_CLASS = 'flex h-8 w-8 items-center justify-center rounded-md bg-muted';
const DATA_CENTER_ICON_CLASS = 'h-5 w-5 text-primary transition-colors';
const DATA_CENTER_ICON_SM_CLASS = 'h-4 w-4 text-primary transition-colors';
const DATA_CENTER_ICON_LG_CLASS = 'h-6 w-6 text-primary transition-colors';

interface DataImportExportProps {
  onClose?: () => void;
  embedded?: boolean;
  /** 显示模式：'all' 全部显示，'stats' 只显示统计，'manage' 只显示管理 */
  mode?: 'all' | 'stats' | 'manage';
}


interface GovernanceBackupInfo {
  backup_id: string;
  display_name: string;
  size: number;
  created_at: string;
  is_auto_backup: boolean;
}

// 备份列表项组件
const BackupListItem: React.FC<{
  backup: GovernanceBackupInfo;
  onRestore: (path: string) => void;
  onSave?: (path: string) => void;
}> = ({ backup, onRestore, onSave }) => {
  const { t } = useTranslation(['data', 'common']);

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  };

  return (
    <div
      className={cn(
        'group flex items-center justify-between rounded-lg border border-transparent bg-transparent p-4 transition-colors',
        'hover:bg-muted/60'
      )}
    >
      <div className="flex-1">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-foreground">{backup.display_name}</span>
          {backup.is_auto_backup && (
            <Badge variant="secondary" className="text-xs">
              {t('data:backup_list.auto_badge')}
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3 text-muted-foreground" />
            {new Date(backup.created_at).toLocaleString()}
          </span>
          <span>{formatFileSize(backup.size)}</span>
        </div>
      </div>
      <div className="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
        {onSave && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => onSave(backup.backup_id)}
            title={t('data:backup_list.save_button')}
            className="h-9 px-3"
          >
            <Save className={cn(DATA_CENTER_ICON_SM_CLASS, 'mr-1')} />
            {t('data:backup_list.save_button')}
          </NotionButton>
        )}
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => onRestore(backup.backup_id)}
          className="h-9 px-3"
        >
          <Download className={cn(DATA_CENTER_ICON_SM_CLASS, 'mr-1')} />
          {t('data:backup_list.restore_button')}
        </NotionButton>
      </div>
    </div>
  );
};

// Notion 风格统计卡片组件 - 简洁扁平
const StatCard = ({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  isEstimated = false,
  formatNumber,
}: {
  title: string;
  value: string | number;
  subtitle: string;
  icon: any;
  gradient?: string; // 保留参数兼容性但不使用
  trend?: number;
  isEstimated?: boolean;
  formatNumber?: (num: number) => string;
  index?: number;
}) => {
  const { t } = useTranslation(['data', 'common', 'settings', 'chat_host', 'cloudStorage']);

  const defaultFormatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const displayValue = typeof value === 'number' ? (formatNumber || defaultFormatNumber)(value) : value;

  return (
    <div className="rounded-xl border border-transparent ring-1 ring-border/40 bg-card p-4 transition-shadow hover:shadow-md">
      {/* 顶部：图标 + 标题 + 趋势 */}
      <div className="flex items-center gap-2 mb-3">
        <div>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="text-sm text-muted-foreground flex-1">{title}</span>
        {trend !== undefined && trend !== 0 && (
          <span
            className={cn(
              'text-xs font-medium flex items-center gap-0.5',
              trend > 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-600 dark:text-red-500'
            )}
          >
            {trend > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>

      {/* 数值 */}
      <div className="text-2xl font-semibold text-foreground mb-1">
        {displayValue}
        {isEstimated && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t('data:backup_list.estimated')}
          </span>
        )}
      </div>

      {/* 副标题 */}
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
};

export const DataImportExport: React.FC<DataImportExportProps> = ({ onClose, embedded = false, mode = 'all' }) => {
  const { t } = useTranslation(['data', 'common']);
  const { enterMaintenanceMode, exitMaintenanceMode } = useSystemStatusStore(
    useShallow((state) => ({
      enterMaintenanceMode: state.enterMaintenanceMode,
      exitMaintenanceMode: state.exitMaintenanceMode,
    }))
  );
  const [activeTab, setActiveTab] = useState('backup');
  // 获取会话统计数据，用于合并趋势图
  const chatStats = useChatV2Stats(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportBackupTiers, setExportBackupTiers] = useState<BackupTier[]>([]);
  
  const formatEta = (seconds: number): string => {
    const secs = Math.max(0, Math.round(seconds));
    if (secs < 60) return t('data:eta_seconds', { count: secs });
    if (secs < 3600) {
      const mins = Math.floor(secs / 60);
      const remainSecs = secs % 60;
      return remainSecs > 0
        ? t('data:eta_minutes_seconds', { mins, secs: remainSecs })
        : t('data:eta_minutes', { count: mins });
    }
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    return mins > 0
      ? t('data:eta_hours_minutes', { hours, mins })
      : t('data:eta_hours', { count: hours });
  };
  const exportTierOptions = useMemo(() => ([
    {
      id: 'core_config_chat' as const,
      label: t('data:backup_settings.tier_core_title'),
      desc: t('data:backup_settings.tier_core_desc'),
    },
    {
      id: 'vfs_full' as const,
      label: t('data:backup_settings.tier_vfs_title'),
      desc: t('data:backup_settings.tier_vfs_desc'),
    },
    {
      id: 'rebuildable' as const,
      label: t('data:backup_settings.tier_rebuild_title'),
      desc: t('data:backup_settings.tier_rebuild_desc'),
    },
    {
      id: 'large_files' as const,
      label: t('data:backup_settings.tier_large_title'),
      desc: t('data:backup_settings.tier_large_desc'),
    },
  ]), [t]);
  const toggleExportTier = useCallback((tier: BackupTier) => {
    setExportBackupTiers((prev) => (
      prev.includes(tier) ? prev.filter((item) => item !== tier) : [...prev, tier]
    ));
  }, []);
  const [exportJob, setExportJob] = useState<{
    jobId: string;
    progress: number;
    phase: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    message?: string;
    etaSeconds?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    processedItems?: number;
    totalItems?: number;
    currentFile?: string;
  } | null>(null);
  const exportListenerRef = useRef<null | (() => void)>(null);
  const [restoreProgress, setRestoreProgress] = useState<{
    progress: number;
    phase: string;
    message?: string;
    processedItems: number;
    totalItems: number;
  } | null>(null);
  const [backupList, setBackupList] = useState<GovernanceBackupInfo[]>([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [showClearDataDialog, setShowClearDataDialog] = useState(false);
  const [clearDataStep, setClearDataStep] = useState(0);
  const [confirmText, setConfirmText] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [isClearing, setIsClearing] = useState(false);
  const [slotInfo, setSlotInfo] = useState<{ active_slot: string; inactive_slot: string; pending_slot?: string; active_dir: string; inactive_dir: string; } | null>(null);
  const countdownTimerRef = React.useRef<number | null>(null);

  // 备份系统测试状态
  const [backupTestRunning, setBackupTestRunning] = useState(false);
  const [backupTestResult, setBackupTestResult] = useState<{
    status: 'idle' | 'running' | 'success' | 'failed';
    currentStep: string;
    progress: number;
    logs: string[];
    error?: string;
    integrityScore?: number;
    duration?: number;
  }>({ status: 'idle', currentStep: '', progress: 0, logs: [] });
  const backupTestAbortRef = useRef(false);

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  type BackupJobEventPayload = {
    jobId?: string;
    job_id?: string;
    kind?: 'export' | 'import';
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    phase?: string;
    progress?: number;
    message?: string;
    processedItems?: number;
    processed_items?: number;
    totalItems?: number;
    total_items?: number;
    etaSeconds?: number;
    eta_seconds?: number;
    startedAt?: string;
    started_at?: string;
    finishedAt?: string;
    finished_at?: string;
    result?: {
      success?: boolean;
      outputPath?: string;
      output_path?: string;
      resolvedPath?: string;
      resolved_path?: string;
      requiresRestart?: boolean;
      requires_restart?: boolean;
      error?: string;
      stats?: Record<string, unknown>;
    };
  };

  const getEventJobId = (payload?: BackupJobEventPayload | null): string => {
    return payload?.jobId || payload?.job_id || '';
  };

  const resolveBackupIdFromEvent = (payload?: BackupJobEventPayload | null): string | null => {
    const stats = payload?.result?.stats;
    if (stats && typeof stats.backup_id === 'string' && stats.backup_id.trim().length > 0) {
      return stats.backup_id;
    }

    const outputPath =
      payload?.result?.resolvedPath ||
      payload?.result?.resolved_path ||
      payload?.result?.outputPath ||
      payload?.result?.output_path;

    if (!outputPath) {
      return null;
    }

    const parts = outputPath.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) {
      return null;
    }
    return parts[parts.length - 1].replace(/\.zip$/i, '') || null;
  };

  const mapUiTiersToGovernance = useCallback((tiers: BackupTier[]): Array<'core' | 'important' | 'rebuildable' | 'large_assets'> => {
    const mapped = new Set<'core' | 'important' | 'rebuildable' | 'large_assets'>(['core']);
    for (const tier of tiers) {
      if (tier === 'core_config_chat' || tier === 'vfs_full') {
        mapped.add('core');
      } else if (tier === 'rebuildable') {
        mapped.add('rebuildable');
      } else if (tier === 'large_files') {
        mapped.add('large_assets');
      }
    }
    return Array.from(mapped);
  }, []);

  type GovernanceJobSummary = NonNullable<Awaited<ReturnType<typeof DataGovernanceApi.getBackupJob>>>;

  const waitForJobTerminal = useCallback(async (
    jobId: string,
    kind: 'export' | 'import',
    timeoutMs = 120000,
    onProgress?: (payload: BackupJobEventPayload) => void,
  ): Promise<BackupJobEventPayload> => {
    const { listen } = await import('@tauri-apps/api/event');

    return new Promise((resolve, reject) => {
      let done = false;
      let unlisten: (() => void) | null = null;
      let polling = false;

      const toPayloadFromSummary = (job: GovernanceJobSummary): BackupJobEventPayload => ({
        job_id: job.job_id,
        kind: job.kind,
        status: job.status,
        phase: job.phase,
        progress: job.progress,
        message: job.message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        result: job.result
          ? {
            success: job.result.success,
            output_path: job.result.output_path,
            resolved_path: job.result.resolved_path,
            requires_restart: job.result.requires_restart,
            error: job.result.error,
            stats: job.result.stats,
          }
        : undefined,
      });

      const isCompletedWithIssues = (payload: BackupJobEventPayload): boolean => (
        payload.status === 'completed' && payload.result?.success === false
      );

      const finish = (payload: BackupJobEventPayload, failed: boolean) => {
        if (done) return;
        done = true;
        if (timeout) window.clearTimeout(timeout);
        if (pollTimer) window.clearInterval(pollTimer);
        if (unlisten) {
          try {
            unlisten();
          } catch {
            // ignore cleanup error
          }
        }
        if (failed) {
          reject(new Error(payload.result?.error || payload.message || t('data:errors.task_failed', { kind })));
          return;
        }
        resolve(payload);
      };

      const pollJobStatus = async () => {
        if (done || polling) return;
        polling = true;
        try {
          const job = await DataGovernanceApi.getBackupJob(jobId);
          if (!job) return;
          const payload = toPayloadFromSummary(job);
          if (isCompletedWithIssues(payload)) {
            finish(payload, true);
          } else if (payload.status === 'completed') {
            finish(payload, false);
          } else if (payload.status === 'failed' || payload.status === 'cancelled') {
            finish(payload, true);
          } else {
            onProgress?.(payload);
          }
        } catch {
          // ignore transient polling failures; event stream may still deliver terminal state
        } finally {
          polling = false;
        }
      };

      const timeout = window.setTimeout(() => {
        if (done) return;
        done = true;
        if (pollTimer) window.clearInterval(pollTimer);
        if (unlisten) {
          try {
            unlisten();
          } catch {
            // ignore cleanup error
          }
        }
        reject(new Error(t('data:errors.task_timeout', { kind, seconds: Math.floor(timeoutMs / 1000) })));
      }, timeoutMs);

      const pollTimer = window.setInterval(() => {
        void pollJobStatus();
      }, 1000);
      void pollJobStatus();

      listen<BackupJobEventPayload>('backup-job-progress', (event) => {
        const payload = event?.payload as BackupJobEventPayload;
        if (!payload || getEventJobId(payload) !== jobId) return;

        onProgress?.(payload);

        if (isCompletedWithIssues(payload)) {
          finish(payload, true);
        } else if (payload.status === 'completed') {
          finish(payload, false);
        } else if (payload.status === 'failed' || payload.status === 'cancelled') {
          finish(payload, true);
        }
      }).then((fn) => {
        if (done) {
          try {
            fn();
          } catch {
            // ignore cleanup error
          }
          return;
        }
        unlisten = fn;
      }).catch((error) => {
        if (done) return;
        done = true;
        window.clearTimeout(timeout);
        window.clearInterval(pollTimer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }, []);

  const startCountdown = useCallback(() => {
    clearCountdownTimer();
    countdownTimerRef.current = window.setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearCountdownTimer();
          setClearDataStep(2);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [clearCountdownTimer]);

  React.useEffect(() => {
    if (!showClearDataDialog) {
      clearCountdownTimer();
    }
  }, [showClearDataDialog, clearCountdownTimer]);

  React.useEffect(() => {
    return () => {
      clearCountdownTimer();
    };
  }, [clearCountdownTimer]);

  const { isActive } = useViewVisibility('data-management');
  // 统计数据相关状态
  const { data: statsData, loading: statsLoading, error: statsError, isRefreshing, refresh: refreshStats } = useAllStatistics({
    autoRefresh: isActive,
    refreshInterval: 60000
  });

  // 加载备份列表
  const loadBackupList = useCallback(async () => {
    setIsLoadingBackups(true);
    try {
      const list = await DataGovernanceApi.getBackupList();
      const normalized = list.map((item) => {
        const backupId = item.path;
        return {
          backup_id: backupId,
          display_name: backupId,
          size: item.size,
          created_at: item.created_at,
          is_auto_backup: backupId.startsWith('auto-backup-'),
        } satisfies GovernanceBackupInfo;
      });
      normalized.sort((a, b) => b.created_at.localeCompare(a.created_at));
      setBackupList(normalized);
    } catch (error) {
      debugLog.error(t('data:console.load_backups_error'), error);
      showGlobalNotification('error', t('data:load_backup_list_failed'));
    } finally {
      setIsLoadingBackups(false);
    }
  }, [t]);

  // 手动备份
  const cleanupExportListener = useCallback(() => {
    if (exportListenerRef.current) {
      try {
        exportListenerRef.current();
      } catch (err) {
        debugLog.warn('移除导出任务监听失败', err);
      } finally {
        exportListenerRef.current = null;
      }
    }
  }, []);

  React.useEffect(() => () => cleanupExportListener(), [cleanupExportListener]);

  const [exportError, setExportError] = useState<string | null>(null);

  const finalizeExport = useCallback((jobId: string, result: {
    status: 'completed' | 'failed' | 'cancelled';
    message?: string;
  }) => {
    cleanupExportListener();
    setIsExporting(false);
    exitMaintenanceMode();
    setExportJob(prev => {
      if (!prev || prev.jobId !== jobId) return prev;
      return {
        ...prev,
        status: result.status,
        progress: result.status === 'completed' ? 100 : prev.progress,
        message: result.message || prev.message,
      };
    });
  }, [cleanupExportListener, exitMaintenanceMode]);

  const handleExport = async () => {
    cleanupExportListener();
    setIsExporting(true);
    setExportError(null);
    setExportJob({
      jobId: 'pending',
      progress: 0,
      phase: 'queued',
      status: 'queued',
    });

    try {
      debugLog.log(t('data:console.export_start'));

      let targetPath: string | null = null;
      const picked = await fileManager.pickSavePath({
        title: t('data:dialogs.pick_backup_destination'),
        defaultFileName: `dstu-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
        filters: [{ name: t('data:file_filter_backup_archive'), extensions: ['zip'] }],
      });
      if (!picked) {
        setIsExporting(false);
        setExportJob({
          jobId: 'cancelled',
          progress: 0,
          phase: 'queued',
          status: 'cancelled',
          message: t('common:cancelled', '已取消'),
        });
        return;
      }
      targetPath = picked;

      enterMaintenanceMode(t('data:governance.maintenance_backup'));

      // 备份前保存 WebView localStorage 设置，确保 UI 偏好进入备份。
      try {
        const localStorageData = TauriAPI.collectLocalStorageForBackup();
        await TauriAPI.saveWebviewSettings(localStorageData);
      } catch (e) {
        debugLog.warn('[DataImportExport] 保存 WebView 设置失败，继续备份:', e);
      }

      const backupJobResp = await DataGovernanceApi.backupTiered(
        mapUiTiersToGovernance(exportBackupTiers),
        undefined,
        undefined,
        exportBackupTiers.includes('large_files') || exportBackupTiers.includes('vfs_full'),
      );
      const backupPayload = await waitForJobTerminal(backupJobResp.job_id, 'export', 600000);
      const backupId = resolveBackupIdFromEvent(backupPayload);
      if (!backupId) {
        throw new Error(t('data:errors.backup_id_not_resolved'));
      }

      const jobResp = await DataGovernanceApi.exportZip(
        backupId,
        targetPath || undefined,
        6,
        true,
      );
      const jobId = jobResp.job_id;
      setExportJob({
        jobId,
        progress: 0,
        phase: 'queued',
        status: 'queued',
      });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<BackupJobEventPayload>('backup-job-progress', (event) => {
        const p = event?.payload as BackupJobEventPayload;
        if (!p || getEventJobId(p) !== jobId || p.kind !== 'export') return;

        setExportJob({
          jobId,
          progress: p.progress ?? 0,
          phase: p.phase ?? 'running',
          status: p.status,
          message: p.message,
          etaSeconds: p.etaSeconds ?? p.eta_seconds,
          startedAt: p.startedAt?.toString() ?? p.started_at?.toString() ?? null,
          finishedAt: p.finishedAt?.toString() ?? p.finished_at?.toString() ?? null,
          processedItems: p.processedItems ?? p.processed_items,
          totalItems: p.totalItems ?? p.total_items,
        });

        if (p.status === 'completed') {
          if (p.result?.success === false) {
            const errMsg = p.result?.error || p.message || t('data:errors.export_fallback');
            debugLog.error(t('export_failed'), errMsg);
            showGlobalNotification('warning', `${t('export_failed')}: ${errMsg}`);
            setExportError(errMsg);
            finalizeExport(jobId, { status: 'failed', message: errMsg });
            return;
          }
          const resolvedPath =
            p.result?.resolvedPath ||
            p.result?.resolved_path ||
            p.result?.outputPath ||
            p.result?.output_path;
          if (resolvedPath) {
            showGlobalNotification('success', `${t('export_success')}
${resolvedPath}`);
          } else {
            showGlobalNotification('success', t('export_success'));
          }
          loadBackupList();
          finalizeExport(jobId, { status: 'completed', message: t('data:console.export_success') });
          window.setTimeout(() => {
            setExportJob(current => (current && current.jobId === jobId && current.status === 'completed' ? null : current));
          }, 1200);
        } else if (p.status === 'failed' || p.status === 'cancelled') {
          const errMsg = p.result?.error || p.message || t('data:errors.export_fallback');
          debugLog.error(t('export_failed'), errMsg);
          showGlobalNotification('error', `${t('export_failed')}: ${errMsg}`);
          setExportError(errMsg);
          finalizeExport(jobId, { status: p.status, message: errMsg });
        }
      });

      exportListenerRef.current = () => {
        (unlisten as unknown as () => void)();
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      debugLog.error(t('export_failed'), error);
      showGlobalNotification('error', `${t('export_failed')}: ${errorMessage}`);
      setExportJob(null);
      setExportError(errorMessage);
      setIsExporting(false);
      exitMaintenanceMode();
    }
  };

  // 手动备份（仅创建治理系统备份，不导出 ZIP）
  const handleAutoBackup = async () => {
    setIsExporting(true);
    try {
      debugLog.log(t('data:console.auto_backup_start'));
      const backupJobResp = await DataGovernanceApi.backupTiered(
        mapUiTiersToGovernance(exportBackupTiers),
        undefined,
        undefined,
        exportBackupTiers.includes('large_files') || exportBackupTiers.includes('vfs_full'),
      );
      await waitForJobTerminal(backupJobResp.job_id, 'export');
      showGlobalNotification('success', t('data:auto_backup_success'));
      await loadBackupList();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      debugLog.error(t('data:console.auto_backup_error'), error);
      const label = t('data:auto_backup_failed');
      showGlobalNotification('error', `${label}: ${errorMessage}`);
    } finally {
      setIsExporting(false);
    }
  };

  // 恢复进度回调：更新 restoreProgress 状态
  const handleRestoreProgress = useCallback((payload: BackupJobEventPayload) => {
    setRestoreProgress({
      progress: payload.progress ?? 0,
      phase: payload.phase ?? '',
      message: payload.message,
      processedItems: payload.processedItems ?? payload.processed_items ?? 0,
      totalItems: payload.totalItems ?? payload.total_items ?? 0,
    });
  }, []);

  // 从备份列表直接恢复
  const handleImportFromList = async (backupId: string) => {
    setIsExporting(true);
    setRestoreProgress(null);
    enterMaintenanceMode(t('data:governance.maintenance_restore'));
    try {
      const spaceCheck = await DataGovernanceApi.checkDiskSpaceForRestore(backupId);
      if (!spaceCheck.has_enough_space) {
        const availableGB = (spaceCheck.available_bytes / 1024 / 1024 / 1024).toFixed(2);
        const requiredGB = (spaceCheck.required_bytes / 1024 / 1024 / 1024).toFixed(2);
        throw new Error(
          t('data:governance.restore_insufficient_space', { required: requiredGB, available: availableGB })
        );
      }

      const restoreJob = await DataGovernanceApi.restoreBackup(backupId);
      const restoreResult = await waitForJobTerminal(restoreJob.job_id, 'import', 600000, handleRestoreProgress);
      showGlobalNotification('success', t('data:restore_complete'));
      if (restoreResult.result?.requires_restart || restoreResult.result?.requiresRestart) {
        showGlobalNotification('warning', t('data:governance.restore_restart_required'));
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', `${t('data:restore_error')}: ${errorMessage}`);
    } finally {
      setIsExporting(false);
      setRestoreProgress(null);
      exitMaintenanceMode();
    }
  };

  /**
   * 使用系统文件对话框选择 Zip 备份并执行导入恢复
   */
  const handleImportZipBackup = async () => {
    setIsExporting(true);
    let maintenanceModeEntered = false;
    try {
      const zipPath = await fileManager.pickSingleFile({
        title: t('data:dialogs.select_zip_title'),
      });

      if (!zipPath) {
        showGlobalNotification('info', t('data:import_cancelled'));
        return;
      }

      const isLikelyZipPath = (candidate: string) => {
        if (!candidate) return false;
        const trimmed = candidate.trim();
        if (!trimmed) return false;

        const lower = trimmed.toLowerCase();
        if (lower.endsWith('.zip')) {
          return true;
        }
        const extractedName = extractFileName(trimmed).toLowerCase();
        if (extractedName.endsWith('.zip')) {
          return true;
        }
        if (lower.startsWith('content://') || lower.startsWith('file://') || lower.startsWith('ph://')) {
          return true;
        }
        try {
          const parsed = new URL(trimmed);
          const name =
            parsed.searchParams.get('fileName') ||
            parsed.searchParams.get('filename') ||
            parsed.searchParams.get('name') ||
            parsed.searchParams.get('displayName');
          if (name && name.toLowerCase().endsWith('.zip')) {
            return true;
          }
        } catch {
          // 非 URL 字符串，忽略
        }
        return false;
      };

      if (!isLikelyZipPath(zipPath)) {
        showGlobalNotification('warning', t('data:dialogs.invalid_zip'));
        return;
      }

      enterMaintenanceMode(t('data:governance.maintenance_import'));
      maintenanceModeEntered = true;

      const importJob = await DataGovernanceApi.importZip(zipPath);
      const importResult = await waitForJobTerminal(importJob.job_id, 'import');
      const importedBackupId = resolveBackupIdFromEvent(importResult);
      if (!importedBackupId) {
        throw new Error(t('data:errors.zip_import_backup_id_not_resolved'));
      }

      const spaceCheck = await DataGovernanceApi.checkDiskSpaceForRestore(importedBackupId);
      if (!spaceCheck.has_enough_space) {
        const availableGB = (spaceCheck.available_bytes / 1024 / 1024 / 1024).toFixed(2);
        const requiredGB = (spaceCheck.required_bytes / 1024 / 1024 / 1024).toFixed(2);
        throw new Error(
          t('data:governance.restore_insufficient_space', { required: requiredGB, available: availableGB })
        );
      }

      setRestoreProgress(null);
      const restoreJob = await DataGovernanceApi.restoreBackup(importedBackupId);
      const restoreResult = await waitForJobTerminal(restoreJob.job_id, 'import', 600000, handleRestoreProgress);

      showGlobalNotification('success', t('data:restore_complete'));
      if (restoreResult.result?.requires_restart || restoreResult.result?.requiresRestart) {
        showGlobalNotification('warning', t('data:governance.restore_restart_required'));
      }
      await loadBackupList();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      debugLog.error(t('data:console.select_file_error'), error);
      const label = t('data:select_file_failed');
      showGlobalNotification('error', `${label}: ${errorMessage}`);
    } finally {
      setIsExporting(false);
      setRestoreProgress(null);
      if (maintenanceModeEntered) {
        exitMaintenanceMode();
      }
    }
  };


  /**
   * 导出单个备份到指定位置（iPad专用）
   */
  const handleSaveBackup = async (backupId: string) => {
    setIsExporting(true);
    try {
      const fileName = `${backupId}.zip`;
      const outputPath = await fileManager.pickSavePath({
        title: t('data:save_backup.title'),
        defaultFileName: fileName,
        filters: [{ name: t('data:file_filter_backup_archive'), extensions: ['zip'] }],
      });

      if (!outputPath) {
        showGlobalNotification('info', t('data:save_backup.cancelled'));
        return;
      }

      const exportJob = await DataGovernanceApi.exportZip(backupId, outputPath, 6, true);
      const exportResult = await waitForJobTerminal(exportJob.job_id, 'export');
      const resolvedPath =
        exportResult.result?.resolvedPath ||
        exportResult.result?.resolved_path ||
        exportResult.result?.outputPath ||
        exportResult.result?.output_path ||
        outputPath;

      showGlobalNotification('success', t('data:save_backup.success', { path: resolvedPath }));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      debugLog.error('保存备份文件失败:', error);
      showGlobalNotification('error', t('data:save_backup.failed', { error: errorMessage }));
    } finally {
      setIsExporting(false);
    }
  };


  // 清空所有数据 - 打开确认对话框
  const handleClearAllData = () => {
    setShowClearDataDialog(true);
    setClearDataStep(0);
    setConfirmText('');
  };

  // 带超时的包装函数
  const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(t('data:errors.operation_timeout', { operation: operationName, timeout: timeoutMs }))), timeoutMs)
      )
    ]);
  };

  // 加载数据空间信息
  const loadDataSpaceInfo = useCallback(async () => {
    try {
      const info = await TauriAPI.getDataSpaceInfo();
      setSlotInfo(info);
    } catch (e) {
      debugLog.error('加载数据空间信息失败:', e);
    }
  }, []);

  // 统计数据相关工具函数
  const exportStatsData = useCallback(async () => {
    if (!statsData) return;
    
    const exportData = {
      timestamp: new Date().toISOString(),
      statistics: statsData
    };
    const json = JSON.stringify(exportData, null, 2);
    const defaultFileName = `statistics-${new Date().toISOString().split('T')[0]}.json`;

    let saved = false;
    try {
      const result = await fileManager.saveTextFile({
        title: t('export_stats_title'),
        defaultFileName,
        filters: [{ name: t('data:file_filter_json'), extensions: ['json'] }],
        content: json,
      });
      if (!result.canceled) {
        saved = true;
      }
    } catch (err) {
      debugLog.warn('[DataImportExport] Export stats to file failed, fallback to browser download', err);
    }

    if (!saved) {
      debugLog.warn('[DataImportExport] Export stats was not saved (user canceled or error occurred)');
    }
  }, [statsData, t]);

  const formatNumber = useCallback((num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  }, []);

  const formatStorageFromKB = useCallback((kb?: number | null) => {
    if (typeof kb !== 'number' || Number.isNaN(kb) || kb <= 0) {
      return '0 KB';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let bytes = kb * 1024;
    let idx = 0;
    while (bytes >= 1024 && idx < units.length - 1) {
      bytes /= 1024;
      idx += 1;
    }
    const precision = idx === 0 ? 0 : 1;
    return `${bytes.toFixed(precision)} ${units[idx]}`;
  }, []);

  // 准备图表数据
  const chartData = useMemo(() => {
    if (!statsData?.enhanced) return null;

    // ★ 文档31清理：subject_stats 已废弃
    const subjectStats: Array<{name: string; value: number}> = [];

    const tagStats = Object.entries(statsData.enhanced.basic_stats?.tag_stats || {})
      .map(([name, value]) => ({ name, value: Number(value) || 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const monthlyTrend = Array.isArray((statsData.enhanced as any).monthly_trend)
      ? (statsData.enhanced as any).monthly_trend.map((item: any) => ({
          month: typeof item?.month === 'string' ? item.month : '未知',
          count: Number(item?.count ?? 0) || 0,
        }))
      : [];

    return {
      subjects: subjectStats,
      tags: tagStats,
      monthlyTrend,
    };
  }, [statsData]);

  const enhancedStats = statsData?.enhanced as any;

  const recentAdditions = Number(enhancedStats?.recent_additions ?? 0);
  const qualityScore = Number(enhancedStats?.quality_score ?? 0);
  const totalImages = Number(enhancedStats?.image_stats?.total_files ?? 0);

  const imageStorageDisplay = useMemo(() => {
    const totalBytes = enhancedStats?.image_stats?.total_size_bytes;
    if (typeof totalBytes !== 'number' || Number.isNaN(totalBytes) || totalBytes <= 0) {
      return null;
    }
    return formatStorageFromKB(totalBytes / 1024);
  }, [enhancedStats, formatStorageFromKB]);

  // 初始化加载
  React.useEffect(() => {
    loadBackupList();
    loadDataSpaceInfo();
  }, [loadBackupList, loadDataSpaceInfo]);

  // 执行清空数据的实际操作
  const isMobileRuntime = useCallback(() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /android|iphone|ipad|ipod/i.test(ua);
  }, []);

  const executeClearAllData = async () => {
    // 防止重复执行
    if (isClearing) {
      debugLog.log('⚠️ 清空操作正在进行中，跳过重复请求');
      return;
    }
    
    setIsClearing(true);
    try {
      debugLog.log('🚀 开始物理删除所有数据库文件');
      showGlobalNotification('info', t('data:clear_data.in_progress'));
      
      // 使用新的物理删除方法，直接删除所有数据库文件
      const result = await withTimeout(
        TauriAPI.purgeAllDatabaseFiles(),
        30000,
        'purge database files'
      );
      
      debugLog.log('✅ 数据库文件删除结果:', result);
      setShowClearDataDialog(false);
      
      const mobile = isMobileRuntime();

      // 显示详细的删除结果
      if (result.includes('成功删除')) {
        showGlobalNotification(
          'success',
          mobile
            ? t('data:clear_data.success_mobile')
            : t('data:clear_data.success_desktop')
        );
      } else if (result.includes('没有找到')) {
        showGlobalNotification('warning', t('data:clear_data.no_files'));
        return;
      } else {
        showGlobalNotification(
          'success',
          mobile
            ? t('data:clear_data.complete_mobile')
            : t('data:clear_data.complete_desktop')
        );
      }

      if (mobile) {
        try {
          const report = await TauriAPI.purgeActiveDataDirNow();
          debugLog.log('🧹 移动端即时清理报告:', report);
          if (report && report.trim().length > 0) {
            showGlobalNotification('info', report.trim());
          }
        } catch (error) {
          const purgeError = getErrorMessage(error);
          debugLog.warn('移动端即时清理失败:', purgeError);
          showGlobalNotification('warning', `移动端清理目录失败: ${purgeError}`);
        }

        setTimeout(() => {
          window.location.reload();
        }, 3000);
        return;
      }

      // 重启应用以确保所有缓存和状态都被重置
      try {
        setTimeout(async () => {
          try {
            await TauriAPI.restartApp();
            // 如果是开发模式，restartApp 不会真正重启，需要手动刷新页面
            if (import.meta.env.DEV) {
              debugLog.log('🔧 开发模式：执行页面刷新');
              window.location.reload();
            }
          } catch (error) {
            debugLog.error('重启应用失败，回退到页面刷新:', error);
            window.location.reload();
          }
        }, 3000);
      } catch (error) {
        debugLog.error('延时执行失败:', error);
        setTimeout(() => {
          window.location.reload();
        }, 3000);
      }
    } catch (error) {
      debugLog.error('清空数据失败:', error);
      showGlobalNotification('error', t('data:clear_data.error'));
    } finally {
      setIsClearing(false);
    }
  };

  // 手动运行完整性检查（已迁移到数据治理系统）
  const handleRunIntegrityCheck = async () => {
    try {
      const result = await DataGovernanceApi.runHealthCheck();
      debugLog.log('🧪 完整性检查结果:', result);
      if (result.overall_healthy) {
        showGlobalNotification('success', t('data:integrity.passed', { count: result.total_databases }));
      } else {
        const unhealthyDbs = result.databases
          .filter((db) => !db.is_healthy)
          .map((db) => db.id)
          .join(', ');
        showGlobalNotification('warning', t('data:integrity.issues', { databases: unhealthyDbs }));
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      debugLog.error('[DataImportExport] Integrity check failed:', error);
      showGlobalNotification('error', t('data:integrity.failed', { error: errorMessage }));
    }
  };

  // 运行备份系统全自动测试
  const runBackupSystemTest = useCallback(async () => {
    if (backupTestRunning) return;

    backupTestAbortRef.current = false;
    setBackupTestRunning(true);
    const startTime = Date.now();
    const logs: string[] = [];

    const addLog = (msg: string) => {
      const time = new Date().toLocaleTimeString(undefined, { hour12: false });
      logs.push(`[${time}] ${msg}`);
      setBackupTestResult(prev => ({ ...prev, logs: [...logs] }));
      debugLog.log(`[BackupTest] ${msg}`);
    };

    const updateProgress = (step: string, progress: number) => {
      setBackupTestResult(prev => ({ ...prev, currentStep: step, progress }));
    };

    // 等待备份任务完成的辅助函数
    const waitForBackupJob = async (jobId: string, kind: 'export' | 'import'): Promise<{ success: boolean; outputPath?: string; error?: string }> => {
      const { listen } = await import('@tauri-apps/api/event');

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          unlisten();
          reject(new Error(`${kind} 任务超时 (60秒)`));
        }, 60000);

        type BackupJobEvent = {
          jobId?: string;
          job_id?: string;
          kind: 'export' | 'import';
          status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
          phase: string;
          progress: number;
          message?: string;
          result?: { success: boolean; outputPath?: string; resolvedPath?: string; output_path?: string; resolved_path?: string; error?: string; stats?: Record<string, unknown> };
        };

        let unlisten: () => void;
        listen<BackupJobEvent>('backup-job-progress', (event) => {
          const p = event?.payload;
          const eventJobId = p?.jobId || p?.job_id;
          if (!p || eventJobId !== jobId) return;

          addLog(`  → [${kind}] ${p.phase}: ${p.progress.toFixed(0)}% ${p.message || ''}`);

          if (p.status === 'completed') {
            clearTimeout(timeout);
            unlisten();
            if (p.result?.success === false) {
              resolve({ success: false, error: p.result?.error || `${kind} 校验失败` });
              return;
            }
            const outputPath = p.result?.resolvedPath || p.result?.resolved_path || p.result?.outputPath || p.result?.output_path;
            resolve({ success: true, outputPath });
          } else if (p.status === 'failed' || p.status === 'cancelled') {
            clearTimeout(timeout);
            unlisten();
            resolve({ success: false, error: p.result?.error || p.message || `${kind} 失败` });
          }
        }).then(fn => { unlisten = fn; });
      });
    };

    try {
      setBackupTestResult({ status: 'running', currentStep: '准备中', progress: 0, logs: [] });
      addLog('🚀 开始全自动备份系统测试（完整版）');
      addLog('═══════════════════════════════════════════════════════');
      addLog('核心原则: 测试流程与生产流程 100% 一致');
      addLog('  → 使用 data_governance_backup_tiered 创建备份');
      addLog('  → 使用 data_governance_export_zip / import_zip / restore_backup 进行恢复验证');
      addLog('  → 测试插槽 C/D 用于构造边界样本，不影响主数据');
      addLog('═══════════════════════════════════════════════════════');

      // ============================================================
      // Phase 1: 准备测试环境
      // ============================================================
      updateProgress('准备测试环境', 5);
      addLog('');
      addLog('📦 Phase 1: 准备测试环境');
      addLog('清空测试插槽 C 和 D...');
      await TauriAPI.clearTestSlots();
      const slotInfo = await TauriAPI.getTestSlotInfo();
      addLog(`✅ 测试插槽已准备: C=${slotInfo.slot_c_dir.split('/').pop()}, D=${slotInfo.slot_d_dir.split('/').pop()}`);

      if (backupTestAbortRef.current) throw new Error('测试已取消');

      // ============================================================
      // Phase 2: 创建核心测试数据
      // ============================================================
      updateProgress('创建核心测试数据', 10);
      addLog('');
      addLog('📦 Phase 2: 创建核心测试数据');

      // 2.1 创建 SQLite WAL 模式数据库
      addLog('2.1 创建 SQLite WAL 模式数据库...');
      const dbResult = await invoke<{ path: string; row_count: number; wal_mode: boolean }>('create_test_database_in_slot', {
        slotDir: slotInfo.slot_c_dir,
        rowCount: 100,
        enableWal: true
      });
      addLog(`  ✅ 数据库: ${dbResult.row_count} 行, WAL=${dbResult.wal_mode}`);

      // 2.2 创建基本测试文件
      addLog('2.2 创建基本测试文件 (图片 + JSON)...');
      const filesResult = await invoke<{ directory: string; file_count: number; total_size: number }>('create_test_files_in_slot', {
        slotDir: slotInfo.slot_c_dir,
        fileCount: 20,
        includeImages: true,
        includeJson: true
      });
      addLog(`  ✅ 基本文件: ${filesResult.file_count} 个, ${(filesResult.total_size / 1024).toFixed(1)} KB`);

      if (backupTestAbortRef.current) throw new Error('测试已取消');

      // ============================================================
      // Phase 3: 创建边缘场景测试数据
      // ============================================================
      updateProgress('创建边缘场景数据', 20);
      addLog('');
      addLog('📦 Phase 3: 创建边缘场景测试数据');

      const edgeCaseResult = await invoke<{
        directory: string;
        file_count: number;
        total_size: number;
        scenarios: string[];
      }>('create_edge_case_test_files', { slotDir: slotInfo.slot_c_dir });

      addLog(`  ✅ 边缘场景: ${edgeCaseResult.file_count} 个文件, ${(edgeCaseResult.total_size / 1024 / 1024).toFixed(2)} MB`);
      for (const scenario of edgeCaseResult.scenarios) {
        addLog(`    → ${scenario}`);
      }

      if (backupTestAbortRef.current) throw new Error('测试已取消');

      // ============================================================
      // Phase 4: 符号链接测试（仅 Unix）
      // ============================================================
      updateProgress('创建符号链接测试', 25);
      addLog('');
      addLog('📦 Phase 4: 符号链接安全测试');

      try {
        const symlinkResult = await invoke<string>('create_symlink_test', { slotDir: slotInfo.slot_c_dir });
        addLog(`  ✅ ${symlinkResult}`);
        addLog('  → 备份时应跳过符号链接，验证安全防护');
      } catch (e) {
        addLog(`  ⚠️ 符号链接测试跳过: ${e}`);
      }

      if (backupTestAbortRef.current) throw new Error('测试已取消');

      // ============================================================
      // Phase 5: 执行备份（数据治理命令链路）
      // ============================================================
      updateProgress('执行备份 (data_governance)', 35);
      addLog('');
      addLog('📦 Phase 5: 执行备份 (data_governance_backup_tiered)');
      addLog('  → 创建治理备份并等待任务完成');

      const backupJob = await DataGovernanceApi.backupTiered(mapUiTiersToGovernance(exportBackupTiers));
      addLog(`  → 备份任务启动: job_id=${backupJob.job_id.slice(0, 8)}...`);

      const backupResult = await waitForBackupJob(backupJob.job_id, 'export');
      if (!backupResult.success) {
        throw new Error(`备份失败: ${backupResult.error}`);
      }

      const backupStats = (backupResult as { result?: { stats?: Record<string, unknown> } }).result?.stats;
      const backupId =
        backupStats && typeof backupStats.backup_id === 'string'
          ? backupStats.backup_id
          : null;
      if (!backupId) {
        throw new Error('备份完成但未返回 backup_id');
      }
      addLog(`  ✅ 备份完成: ${backupId}`);

      const exportZipJob = await DataGovernanceApi.exportZip(backupId);
      addLog(`  → ZIP 导出任务启动: job_id=${exportZipJob.job_id.slice(0, 8)}...`);

      const exportZipResult = await waitForBackupJob(exportZipJob.job_id, 'export');
      if (!exportZipResult.success) {
        throw new Error(`ZIP 导出失败: ${exportZipResult.error}`);
      }

      const backupPath = exportZipResult.outputPath;
      if (!backupPath) {
        throw new Error('ZIP 导出完成但未返回路径');
      }
      addLog(`  ✅ ZIP 导出完成: ${backupPath.split('/').slice(-2).join('/')}`);

      if (backupTestAbortRef.current) throw new Error('测试已取消');

      // ============================================================
      // Phase 6: 执行导入与恢复（数据治理命令链路）
      // ============================================================
      updateProgress('执行导入与恢复 (data_governance)', 55);
      addLog('');
      addLog('📦 Phase 6: 执行导入与恢复 (data_governance_import_zip + restore_backup)');

      const importJob = await DataGovernanceApi.importZip(backupPath);
      addLog(`  → 导入任务启动: job_id=${importJob.job_id.slice(0, 8)}...`);

      const importResultJob = await waitForBackupJob(importJob.job_id, 'import');
      if (!importResultJob.success) {
        throw new Error(`导入失败: ${importResultJob.error}`);
      }

      const importedStats = (importResultJob as { result?: { stats?: Record<string, unknown> } }).result?.stats;
      const importedBackupId =
        importedStats && typeof importedStats.backup_id === 'string'
          ? importedStats.backup_id
          : null;
      if (!importedBackupId) {
        throw new Error('导入完成但未返回 backup_id');
      }

      const restoreJob = await DataGovernanceApi.restoreBackup(importedBackupId);
      addLog(`  → 恢复任务启动: job_id=${restoreJob.job_id.slice(0, 8)}...`);

      const restoreResult = await waitForBackupJob(restoreJob.job_id, 'import');
      if (!restoreResult.success) {
        throw new Error(`恢复失败: ${restoreResult.error}`);
      }
      addLog('  ✅ 恢复完成');

      if (backupTestAbortRef.current) throw new Error('测试已取消');

      // ============================================================
      // Phase 7: 验证导入备份可校验
      // ============================================================
      updateProgress('验证导入备份', 75);
      addLog('');
      addLog('📦 Phase 7: 验证导入备份完整性');

      const verifyResult = await DataGovernanceApi.verifyBackup(importedBackupId);
      const integrityScore = verifyResult.is_valid ? 100 : 0;
      addLog(`  校验结果: ${verifyResult.is_valid ? '通过' : '失败'}`);
      addLog(`  数据库校验项: ${verifyResult.databases_verified.length}`);

      if (!verifyResult.is_valid) {
        const reason = verifyResult.errors.join('; ') || '未知错误';
        throw new Error(`导入备份校验失败: ${reason}`);
      }

      if (backupTestAbortRef.current) throw new Error('测试已取消');

      // ============================================================
      // Phase 8: 清理测试环境
      // ============================================================
      updateProgress('清理环境', 95);
      addLog('');
      addLog('📦 Phase 8: 清理测试环境');
      await invoke('clear_test_slot', { slotName: 'slotC' });
      await invoke('clear_test_slot', { slotName: 'slotD' });
      addLog('  ✅ 测试环境清理完成');

      // ============================================================
      // 测试完成
      // ============================================================
      const duration = Date.now() - startTime;
      updateProgress('完成', 100);
      addLog('');
      addLog('═══════════════════════════════════════════════════════');
      addLog('🎉 全部测试通过！');
      addLog(`  总耗时: ${(duration / 1000).toFixed(2)} 秒`);
      addLog(`  数据完整性: ${integrityScore.toFixed(1)}%`);
      addLog(`  测试场景: ${edgeCaseResult.scenarios.length + 2} 个`);
      addLog('═══════════════════════════════════════════════════════');

      setBackupTestResult(prev => ({
        ...prev,
        status: 'success',
        integrityScore,
        duration
      }));

      showGlobalNotification('success', t('data:backup_test.success', { score: integrityScore.toFixed(1) }));

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog('');
      addLog(`❌ 测试失败: ${errorMessage}`);

      // 尝试清理
      try {
        await TauriAPI.clearTestSlots();
        addLog('已清理测试环境');
      } catch (cleanupError) {
        addLog(`⚠️ 清理失败: ${cleanupError}`);
      }

      setBackupTestResult(prev => ({
        ...prev,
        status: 'failed',
        error: errorMessage,
        duration: Date.now() - startTime
      }));

      showGlobalNotification('error', t('data:backup_test.failed', { error: errorMessage }));
    } finally {
      setBackupTestRunning(false);
    }
  }, [backupTestRunning]);

  const stopBackupTest = useCallback(() => {
    backupTestAbortRef.current = true;
    showGlobalNotification('warning', t('data:backup_test.stopping'));
  }, []);

  const resetBackupTest = useCallback(() => {
    setBackupTestResult({ status: 'idle', currentStep: '', progress: 0, logs: [] });
  }, []);

  // 处理确认文本输入
  const handleConfirmTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmText(e.target.value);
  };

  // 下一步处理
  const handleNextStep = () => {
    if (clearDataStep === 0) {
      setClearDataStep(1);
      setCountdown(5);
      startCountdown();
    } else if (clearDataStep === 2) {
      const expectedText = t('data:clear_dialog.step2_confirm_text');
      
      if (confirmText === expectedText) {
        clearCountdownTimer();
        executeClearAllData();
      } else {
        showGlobalNotification('error', t('data:clear_data.confirm_text_error'));
      }
    }
  };


  return (
    <>
      <style>
        {`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .data-management-container {
            /* 扣除固定标题栏高度，避免底部内容被遮挡 */
            height: calc(100vh - var(--desktop-titlebar-height, 40px));
            display: flex;
            flex-direction: column;
            background-color: hsl(var(--background));
          }
          .data-management-container.embedded {
            height: auto;
            background-color: transparent;
          }
          .data-management-content {
            flex: 1;
            overflow-y: auto;
            padding: 1rem 2rem 2rem 2rem;
            min-height: 0;
          }
          .data-management-container.embedded .data-management-content {
            overflow: visible;
            padding: 0;
          }
          .data-management-inner {
            max-width: 80rem;
            margin: 0 auto;
          }
          
          /* 自定义滚动条样式 */
          .backup-list-container::-webkit-scrollbar {
            width: 8px;
          }
          
          .backup-list-container::-webkit-scrollbar-track {
            background: #f1f5f9;
            border-radius: 4px;
            margin: 4px 0;
          }
          
          .backup-list-container::-webkit-scrollbar-thumb {
            background: #cbd5e1;
            border-radius: 4px;
            margin: 2px 0;
            border: 1px solid #f1f5f9;
          }
          
          .backup-list-container::-webkit-scrollbar-thumb:hover {
            background: #94a3b8;
          }
          
          .backup-list-container::-webkit-scrollbar-corner {
            background: #f1f5f9;
          }
        `}
      </style>
      <div className={`data-management-container ${embedded ? 'embedded' : ''}`}>
        {!embedded && (
          <HeaderTemplate
            icon={FileArchive}
            title={t('data:header.title')}
            subtitle={t('data:header.subtitle')}
            onExport={handleExport}
            onRefresh={loadBackupList}
            isRefreshing={isLoadingBackups}
            refreshingText={t('data:header.refreshing_text')}
          />
        )}
        
        <div className="data-management-content">
          <div className="data-management-inner">
        
        {/* 数据统计部分 - 放在最上方 */}
        {(mode === 'all' || mode === 'stats') && (
          mode === 'stats' ? (
            // stats 模式：使用 SettingSection 包裹，与其他设置标签页保持一致
            <SettingSection 
              title={t('data:statistics_section_title')} 
              description={t('data:statistics_section_subtitle')}
              className="overflow-visible"
              hideHeader
            >
              {/* 左右两栏：会话统计 | LLM 统计 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
                <ChatV2StatsSection statsOnly />
                <LlmUsageStatsSection statsOnly days={30} />
              </div>

              {/* 学习热力图 */}
              <div className="mb-10 p-1">
                <LearningHeatmap months={12} showStats={false} showLegend={true} />
              </div>

              {/* LLM 图表 */}
              <LlmUsageStatsSection chartsOnly days={30} sessionTrends={chatStats.dailyActivity} />
            </SettingSection>
          ) : (
            // all 模式：使用原有的标题样式
            <div className="mb-8">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-foreground mb-1">{t('data:statistics_section_title')}</h2>
                  <p className="text-sm text-muted-foreground">{t('data:statistics_section_subtitle')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`border-transparent ring-1 ring-border/40 ${isRefreshing ? 'text-primary bg-primary/10' : 'text-muted-foreground bg-muted/50'}`}>
                    {t('data:auto_refresh_label')} {isRefreshing ? t('data:auto_refresh_in_progress') : t('data:auto_refresh_interval')}
                  </Badge>
                  <NotionButton variant="ghost" size="sm" onClick={exportStatsData} disabled={!statsData} className="flex items-center gap-1">
                    <Download className={DATA_CENTER_ICON_SM_CLASS} /> {t('data:export_stats_button')}
                  </NotionButton>
                </div>
              </div>
              {/* Chat V2 统计部分 - 2026-01: 错题系统已废弃，只显示 Chat V2 统计 */}
              <ChatV2StatsSection />
              
              {/* LLM 使用统计 */}
              <div className="border-t border-border/40">
                <LlmUsageStatsSection days={30} sessionTrends={chatStats.dailyActivity} />
              </div>
            </div>
          )
        )}

        {(mode === 'all' || mode === 'manage') && (
          <>
            {/* 分隔线 */}
            {mode === 'all' && <div className="border-t border-border/40 my-8"></div>}

            {/* 数据管理部分标题 - 仅在 all 模式下显示，避免与外层 SettingSection 重复 */}
            {mode === 'all' && (
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-foreground mb-1">{t('data:management_section_title')}</h2>
              <p className="text-sm text-muted-foreground">{t('data:management_section_subtitle')}</p>
            </div>
            )}
        
            {/* Main Actions - shadcn 结构（Header/Description/Footer） */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* 导出 */}
          <Card className="overflow-hidden border-transparent ring-1 ring-border/40 shadow-sm">
            <CardHeader>
              <div className={cn(DATA_CENTER_ICON_CONTAINER_CLASS, 'h-10 w-10 mb-1')}>
                {isExporting ? (
                  <RefreshCw className={cn(DATA_CENTER_ICON_CLASS, 'animate-spin')} />
                ) : (
                  <Upload className={DATA_CENTER_ICON_CLASS} />
                )}
              </div>
              <CardTitle className="text-base">{t('data:actions.export_title')}</CardTitle>
              <CardDescription>{t('data:actions.export_description')}</CardDescription>
            </CardHeader>
          <CardContent className="pt-0 pb-2 space-y-2">
            <p className="text-xs text-muted-foreground">
              {t('data:backup_settings.tiered_desc')}
            </p>
            <div className="space-y-2">
              {exportTierOptions.map((option) => (
                <label key={option.id} className="flex items-start gap-3">
                  <Checkbox
                    checked={exportBackupTiers.includes(option.id)}
                    onCheckedChange={() => toggleExportTier(option.id)}
                    disabled={isExporting}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{option.label}</p>
                    <p className="text-xs text-muted-foreground">{option.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </CardContent>
            <CardFooter>
              <NotionButton variant="ghost" size="sm" onClick={handleExport} disabled={isExporting}>
                {isExporting ? t('data:actions.exporting') : t('data:actions.export_button')}
              </NotionButton>
            </CardFooter>
            {(exportJob || exportError) && (
              <CardContent className="pt-0 pb-4 space-y-3">
                {exportJob && (
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span>
                        {t('data:export_progress.phase_label')}
                        <span className="font-medium text-foreground">
                          {t(`data:export_phases.${exportJob.phase}`, {
                            defaultValue: exportJob.phase
                              .replace(/_/g, ' ')
                              .replace(/\b\w/g, (s) => s.toUpperCase()),
                          })}
                        </span>
                      </span>
                      <span>{Math.round(exportJob.progress)}%</span>
                    </div>
                    <ShadProgress
                      value={
                        exportJob.status === 'running' || exportJob.status === 'queued'
                          ? exportJob.progress
                          : 100
                      }
                    />
                    {exportJob.message && (
                      <p className="text-xs text-muted-foreground">{exportJob.message}</p>
                    )}
                    {exportJob.processedItems !== undefined && exportJob.totalItems !== undefined && exportJob.totalItems > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {t('data:export_progress.file_progress', { processed: exportJob.processedItems, total: exportJob.totalItems })}
                      </p>
                    )}
                    {typeof exportJob.etaSeconds === 'number' && exportJob.status === 'running' && (
                      <p className="text-xs text-muted-foreground">
                        {t('data:export_progress.eta_remaining', { eta: formatEta(exportJob.etaSeconds) })}
                      </p>
                    )}
                  </div>
                )}
                {exportError && (
                  <Alert variant="destructive" className="py-2">
                    <AlertDescription className="text-xs">
                      {exportError}
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="ml-2 h-6 px-2 text-xs"
                        onClick={handleExport}
                      >
                        {t('data:actions.retry_button')}
                      </NotionButton>
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            )}
          </Card>

          {/* 导入 */}
          <Card className="overflow-hidden border-transparent ring-1 ring-border/40 shadow-sm">
            <CardHeader>
              <div className={cn(DATA_CENTER_ICON_CONTAINER_CLASS, 'h-10 w-10 mb-1')}>
                <Download className={DATA_CENTER_ICON_CLASS} />
              </div>
              <CardTitle className="text-base">{t('data:actions.import_title')}</CardTitle>
              <CardDescription>{t('data:actions.import_description')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <NotionButton variant="ghost" size="sm" onClick={handleImportZipBackup} disabled={isExporting}>
                {isExporting && restoreProgress ? (
                  <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{t('data:governance.restore_in_progress')}</>
                ) : (
                  t('data:actions.import_button')
                )}
              </NotionButton>
            </CardFooter>
            {restoreProgress && (
              <CardContent className="pt-0 pb-4 space-y-2">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{restoreProgress.message || restoreProgress.phase}</span>
                  <span>{Math.round(restoreProgress.progress)}%</span>
                </div>
                <ShadProgress value={restoreProgress.progress} />
                {restoreProgress.totalItems > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {restoreProgress.processedItems} / {restoreProgress.totalItems} {t('data:governance.items')}
                  </p>
                )}
              </CardContent>
            )}
          </Card>

          {/* 🎯 导入对话（新增）*/}
          <Card className="overflow-hidden border-transparent ring-1 ring-border/40 shadow-sm">
            <CardHeader>
              <div className={cn(DATA_CENTER_ICON_CONTAINER_CLASS, 'h-10 w-10 mb-1')}>
                <Brain className={DATA_CENTER_ICON_CLASS} />
              </div>
              <CardTitle className="text-base">{t('chat_host:import.dialog_title')}</CardTitle>
              <CardDescription>
                {t('chat_host:import.format_hint')}
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <NotionButton 
                variant="ghost" 
                size="sm" 
                onClick={() => {
                  // 触发父组件的导入对话对话框
                  const event = new CustomEvent('DSTU_OPEN_IMPORT_CONVERSATION');
                  window.dispatchEvent(event);
                }}
              >
                <Upload className="mr-1.5 h-4 w-4" />
                {t('chat_host:actions.import_chat')}
              </NotionButton>
            </CardFooter>
          </Card>


          {/* 云存储配置 */}
          <Card className="overflow-hidden border-transparent ring-1 ring-border/40 shadow-sm">
            <CardHeader>
              <div className={cn(DATA_CENTER_ICON_CONTAINER_CLASS, 'h-10 w-10 mb-1')}>
                <Cloud className={DATA_CENTER_ICON_CLASS} />
              </div>
              <CardTitle className="text-base">{t('cloudStorage:title')}</CardTitle>
              <CardDescription>
                {t('cloudStorage:description')}
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  const event = new CustomEvent('DSTU_OPEN_CLOUD_STORAGE_SETTINGS');
                  window.dispatchEvent(event);
                }}
              >
                <Cloud className="mr-1.5 h-4 w-4" />
                {t('common:actions.open')}
              </NotionButton>
            </CardFooter>
          </Card>

          {/* 备份系统测试 */}
          <Card className="overflow-hidden md:col-span-2">
            <CardHeader>
              <div className={cn(DATA_CENTER_ICON_CONTAINER_CLASS, 'h-10 w-10 mb-1')}>
                {backupTestRunning ? (
                  <Loader2 className={cn(DATA_CENTER_ICON_CLASS, 'animate-spin')} />
                ) : backupTestResult.status === 'success' ? (
                          <CheckCircle2 className={cn(DATA_CENTER_ICON_CLASS, 'text-success')} />
                        ) : backupTestResult.status === 'failed' ? (
                          <XCircle className={cn(DATA_CENTER_ICON_CLASS, 'text-destructive')} />
                ) : (
                  <FlaskConical className={DATA_CENTER_ICON_CLASS} />
                )}
              </div>
              <CardTitle className="text-base">{t('data:backup_test.title')}</CardTitle>
              <CardDescription>
                {t('data:backup_test.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {/* 测试进度 */}
              {backupTestResult.status === 'running' && (
                <div className="space-y-3 mb-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{backupTestResult.currentStep}</span>
                    <span className="font-medium">{backupTestResult.progress}%</span>
                  </div>
                  <ShadProgress value={backupTestResult.progress} />
                </div>
              )}

              {/* 测试结果 */}
              {backupTestResult.status === 'success' && (
                  <Alert className="mb-4 border-success/30 bg-success/10">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <AlertDescription className="text-success">
                    {t('data:backup_test.result_passed', { score: backupTestResult.integrityScore?.toFixed(1), duration: ((backupTestResult.duration || 0) / 1000).toFixed(2) })}
                  </AlertDescription>
                </Alert>
              )}

              {backupTestResult.status === 'failed' && (
                <Alert variant="destructive" className="mb-4">
                  <XCircle className="h-4 w-4" />
                  <AlertDescription>
                    {t('data:backup_test.result_failed_detail', { error: backupTestResult.error })}
                  </AlertDescription>
                </Alert>
              )}

              {/* 日志展示 */}
              {backupTestResult.logs.length > 0 && (
                <CustomScrollArea className="rounded-lg bg-muted/50 max-h-[200px] font-mono text-xs" viewportClassName="p-3 space-y-1">
                  {backupTestResult.logs.map((log, i) => (
                    <div key={i} className={cn(
                      log.includes('✅') ? 'text-success' :
                      log.includes('❌') ? 'text-destructive' :
                      log.includes('⚠️') ? 'text-warning' :
                      log.includes('🚀') || log.includes('🎉') ? 'text-primary' :
                      'text-muted-foreground'
                    )}>
                      {log}
                    </div>
                  ))}
                </CustomScrollArea>
              )}
            </CardContent>
            <CardFooter className="flex gap-2">
              {backupTestRunning ? (
                <NotionButton variant="danger" size="sm" onClick={stopBackupTest}>
                  <Square className="mr-1.5 h-4 w-4" />
                  {t('data:backup_test.stop_button')}
                </NotionButton>
              ) : (
                <>
                    <NotionButton
                      variant="default"
                      size="sm"
                      onClick={runBackupSystemTest}
                    >
                    <Play className="mr-1.5 h-4 w-4" />
                    {t('data:backup_test.run_button')}
                  </NotionButton>
                  {backupTestResult.status !== 'idle' && (
                    <NotionButton variant="ghost" size="sm" onClick={resetBackupTest}>
                      <RotateCcw className="mr-1.5 h-4 w-4" />
                      {t('data:backup_test.reset_button')}
                    </NotionButton>
                  )}
                </>
              )}
            </CardFooter>
          </Card>
        </div>

        {/* Tabs */}
        <div className="mb-8 rounded-2xl border border-transparent ring-1 ring-border/40 bg-card shadow-sm">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v)} className="w-full">
            <div className="border-b border-border/60 px-4 py-3">
              <TabsList className="h-9 gap-2 rounded-lg bg-muted/40 p-1">
                <TabsTrigger value="backup" className="flex-1 text-sm">
                  {t('data:backup_management')}
                </TabsTrigger>
                <TabsTrigger value="backup-settings" className="flex-1 text-sm">
                  {t('data:backup_settings.title')}
                </TabsTrigger>
                <TabsTrigger value="sync" className="flex-1 text-sm">
                  {t('data:sync_settings.title')}
                </TabsTrigger>
                <TabsTrigger value="settings" className="flex-1 text-sm">
                  {t('data:usage_tips_title')}
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="px-6 py-6">
              {activeTab === 'backup' ? (
                <div className="space-y-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <HardDrive className={DATA_CENTER_ICON_SM_CLASS} />
                      <span>{t('data:backup_list.total_count', { count: backupList.length })}</span>
                    </div>
                    <NotionButton onClick={handleAutoBackup} disabled={isExporting}>
                      {isExporting ? t('data:backup_list.backup_in_progress') : t('data:auto_backup')}
                    </NotionButton>
                  </div>

                  <CustomScrollArea className="backup-list-container flex max-h-[300px] flex-col gap-2" viewportClassName="pb-1 pr-2 pt-1">
                    {isLoadingBackups ? (
                      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-sm text-muted-foreground">
                        <RefreshCw className={cn(DATA_CENTER_ICON_LG_CLASS, 'animate-spin')} />
                        <p>{t('data:loading_backups')}</p>
                      </div>
                    ) : backupList.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-sm text-muted-foreground">
                        <HardDrive className={DATA_CENTER_ICON_CLASS} />
                        <p>{t('data:no_backups')}</p>
                      </div>
                    ) : (
                      backupList.map((backup, i) => (
                        <BackupListItem
                          key={i}
                          backup={backup}
                          onRestore={handleImportFromList}
                          onSave={handleSaveBackup}
                        />
                      ))
                    )}
                  </CustomScrollArea>
                </div>
              ) : activeTab === 'backup-settings' ? (
                <div className="p-4 text-center text-muted-foreground">
                  <p>{t('data:settings_tab.migrated')}</p>
                  <p className="mt-2 text-sm">{t('data:settings_tab.migrated_hint')}</p>
                </div>
              ) : activeTab === 'sync' ? (
                <SyncSettingsSection embedded />
              ) : (
                <div className="space-y-6">
                  <div className="space-y-4">
                    <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
                      <AlertTriangle className={DATA_CENTER_ICON_SM_CLASS} />
                      {t('data:usage_tips_title')}
                    </h3>
                    <div className="space-y-3">
                      {['usage_tip_1', 'usage_tip_2', 'usage_tip_3', 'usage_tip_4'].map((key) => (
                        <div key={key} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/80" />
                          <span>{t(`data:${key}`)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-transparent ring-1 ring-border/40 bg-muted/30 p-6">
                    <h3 className="text-base font-medium text-foreground">{t('data:data_space.title')}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('data:data_space.description')}
                    </p>
                    {slotInfo ? (
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border border-transparent ring-1 ring-border/40/60 bg-background/80 p-3 shadow-sm">
                          <div className="text-sm text-muted-foreground">{t('data:data_space.active_label')}</div>
                          <div className="text-base font-semibold text-foreground">{slotInfo.active_slot}</div>
                          <div className="break-all text-xs text-muted-foreground/80">{slotInfo.active_dir}</div>
                        </div>
                        <div className="rounded-lg border border-transparent ring-1 ring-border/40/60 bg-background/80 p-3 shadow-sm">
                          <div className="text-sm text-muted-foreground">{t('data:data_space.inactive_label')}</div>
                          <div className="text-base font-semibold text-foreground">{slotInfo.inactive_slot}</div>
                          <div className="break-all text-xs text-muted-foreground/80">{slotInfo.inactive_dir}</div>
                        </div>
                        <div className="rounded-lg border border-transparent ring-1 ring-border/40/60 bg-background/80 p-3 shadow-sm sm:col-span-2">
                          <div className="text-sm text-muted-foreground">{t('data:data_space.pending_label')}</div>
                          <div
                            className={cn(
                              'text-base font-semibold',
                              slotInfo.pending_slot ? 'text-primary' : 'text-foreground'
                            )}
                          >
                            {slotInfo.pending_slot || t('data:data_space.pending_none')}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 text-sm text-muted-foreground">{t('data:data_space.loading')}</div>
                    )}
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      <NotionButton variant="default" onClick={loadDataSpaceInfo} className="sm:w-auto">
                        <RefreshCw className={cn(DATA_CENTER_ICON_SM_CLASS, 'mr-1')} />
                        {t('data:data_space.refresh_button')}
                      </NotionButton>
                      <NotionButton
                        className="sm:w-auto"
                        onClick={async () => {
                          try {
                            const msg = await TauriAPI.markDataSpacePendingSwitchToInactive();
                            showGlobalNotification('success', msg + t('data:data_space.switch_success_suffix'));
                            await loadDataSpaceInfo();
                          } catch (e) {
                            const { getErrorMessage } = await import('../utils/errorUtils');
                            showGlobalNotification('error', t('data:data_space.switch_failed', { error: getErrorMessage(e) }));
                          }
                        }}
                      >
                        {t('data:data_space.switch_button')}
                      </NotionButton>
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-xl border border-transparent ring-1 ring-border/40 bg-muted/30 p-6">
                      <h3 className="text-base font-medium text-foreground">{t('data:integrity.title')}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t('data:integrity.description')}
                      </p>
                      <NotionButton variant="default" onClick={handleRunIntegrityCheck} className="mt-4">
                        <FileText className={cn(DATA_CENTER_ICON_SM_CLASS, 'mr-1')} />
                        {t('data:integrity.run_button')}
                      </NotionButton>
                    </div>

                    <div className="rounded-xl border border-transparent ring-1 ring-border/40 bg-muted/30 p-6">
                      <h3 className="text-base font-medium text-foreground">{t('data:clear_section.title')}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{t('data:clear_section.description')}</p>
                      <NotionButton variant="danger" onClick={handleClearAllData} className="mt-4">
                        <Trash2 className={cn(DATA_CENTER_ICON_SM_CLASS, 'mr-1')} />
                        {t('data:clear_section.button')}
                      </NotionButton>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Tabs>
        </div>
          </>
        )}

      </div>
    </div>

        {/* 清空数据确认对话框 */}
        <NotionDialog open={showClearDataDialog} onOpenChange={setShowClearDataDialog} maxWidth="max-w-md" closeOnOverlay={false} showClose={false}>
            {clearDataStep === 0 && (
              <>
                <NotionDialogHeader>
                  <NotionDialogTitle className="flex items-center gap-3">
                    <AlertTriangle className={DATA_CENTER_ICON_LG_CLASS} />
                    {t('data:clear_dialog.step0_title')}
                  </NotionDialogTitle>
                  <NotionDialogDescription>
                    {t('data:clear_dialog.step0_desc_prefix')}<strong>{t('data:clear_dialog.step0_desc_bold')}</strong>{'\n'}{t('data:clear_dialog.step0_desc_items').split('\n').map((line, i) => (<span key={i}><br />{line}</span>))}
                    <br />
                    <strong>{t('data:clear_dialog.step0_desc_warning')}</strong>{'\u3001'}{t('data:clear_dialog.step0_desc_advice')}
                  </NotionDialogDescription>
                </NotionDialogHeader>
                <NotionDialogFooter>
                  <NotionButton variant="ghost" size="sm" onClick={() => setShowClearDataDialog(false)}>{t('data:clear_dialog.step0_cancel')}</NotionButton>
                  <NotionButton variant="danger" size="sm" onClick={handleNextStep}>{t('data:clear_dialog.step0_confirm')}</NotionButton>
                </NotionDialogFooter>
              </>
            )}

            {clearDataStep === 1 && (
              <>
                <NotionDialogHeader>
                  <NotionDialogTitle className="flex items-center gap-3">
                    <Clock className={DATA_CENTER_ICON_LG_CLASS} />
                    {t('data:clear_dialog.step1_title')}
                  </NotionDialogTitle>
                  <NotionDialogDescription>
                    {t('data:clear_dialog.step1_wait')} <strong className="text-base">{countdown}</strong> {t('data:clear_dialog.step1_seconds')}
                    <br />{t('data:clear_dialog.step1_hint')}
                  </NotionDialogDescription>
                </NotionDialogHeader>
                <NotionDialogFooter>
                  <NotionButton variant="ghost" size="sm" onClick={() => setShowClearDataDialog(false)}>{t('data:clear_dialog.step1_cancel')}</NotionButton>
                </NotionDialogFooter>
              </>
            )}

            {clearDataStep === 2 && (
              <>
                <NotionDialogHeader>
                  <NotionDialogTitle className="flex items-center gap-3">
                    <Trash2 className={DATA_CENTER_ICON_LG_CLASS} />
                    {t('data:clear_dialog.step2_title')}
                  </NotionDialogTitle>
                  <NotionDialogDescription>{t('data:clear_dialog.step2_description')}</NotionDialogDescription>
                </NotionDialogHeader>
                <NotionDialogBody nativeScroll>
                  <p className="text-base font-semibold text-foreground bg-muted p-3 rounded-md text-center mb-4">
                    {t('data:clear_dialog.step2_confirm_text')}
                  </p>
                  <Input
                    type="text"
                    value={confirmText}
                    onChange={handleConfirmTextChange}
                    placeholder={t('data:clear_dialog.step2_placeholder')}
                  />
                </NotionDialogBody>
                <NotionDialogFooter>
                  <NotionButton variant="ghost" size="sm" onClick={() => setShowClearDataDialog(false)}>{t('data:clear_dialog.step2_cancel')}</NotionButton>
                  <NotionButton variant="danger" size="sm" onClick={handleNextStep} disabled={confirmText !== t('data:clear_dialog.step2_confirm_text')}>
                    {t('data:clear_dialog.step2_confirm_button')}
                  </NotionButton>
                </NotionDialogFooter>
              </>
            )}
        </NotionDialog>
      </div>
    </>
  );
};
