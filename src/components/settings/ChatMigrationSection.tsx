import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
/**
 * Chat V2 数据迁移设置组件
 * 
 * 提供旧版 chat_messages 到 Chat V2 的手动迁移功能
 * 支持实时进度显示和回滚
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  DataGovernanceApi,
  type ChatMigrationCheckResult as MigrationCheckResult,
  type ChatMigrationReport as MigrationReport,
} from '@/api/dataGovernance';
import {
  Database,
  Play,
  RotateCcw,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Clock,
  MessageSquare,
  FolderOpen,
  Blocks,
  Paperclip,
} from 'lucide-react';
import { NotionButton } from '../ui/NotionButton';
import { Progress } from '../ui/shad/Progress';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';

// ============================================================================
// 类型定义（与后端对齐）
// ============================================================================

type MigrationStatus = 'not_started' | 'in_progress' | 'completed' | 'rolled_back' | 'failed';

type MigrationStep = 
  | 'check_legacy_data'
  | 'group_by_mistake_id'
  | 'create_session'
  | 'migrate_messages'
  | 'create_blocks'
  | 'create_attachments'
  | 'mark_migrated'
  | 'finished';

interface MigrationProgress {
  status: MigrationStatus;
  currentStep: MigrationStep;
  totalMessages: number;
  migratedMessages: number;
  totalSessions: number;
  createdSessions: number;
  percent: number;
  currentMistakeId: string | null;
  error: string | null;
}

// MigrationCheckResult and MigrationReport are imported from DataGovernanceApi

interface MigrationEvent {
  eventType: 'started' | 'progress' | 'step_changed' | 'completed' | 'failed' | 'rollback_started' | 'rollback_completed' | 'rollback_failed';
  progress: MigrationProgress;
  message: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

const stepLabels: Record<MigrationStep, string> = {
  check_legacy_data: 'checkLegacyData',
  group_by_mistake_id: 'groupByMistakeId',
  create_session: 'createSession',
  migrate_messages: 'migrateMessages',
  create_blocks: 'createBlocks',
  create_attachments: 'createAttachments',
  mark_migrated: 'markMigrated',
  finished: 'finished',
};

const statusLabels: Record<MigrationStatus, string> = {
  not_started: 'notStarted',
  in_progress: 'inProgress',
  completed: 'completed',
  rolled_back: 'rolledBack',
  failed: 'failed',
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};

const formatDateTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString();
};

// ============================================================================
// 组件
// ============================================================================


const StatItem = ({ icon: Icon, label, value, variant = 'default' }: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  variant?: 'default' | 'success' | 'warning' | 'error';
}) => {
  const variantClasses = {
    default: 'text-foreground',
    success: 'text-green-600 dark:text-green-400',
    warning: 'text-yellow-600 dark:text-yellow-400',
    error: 'text-red-600 dark:text-red-400',
  };

  return (
    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/30 border border-border/40">
      <Icon className={`h-4 w-4 ${variantClasses[variant]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground truncate">{label}</p>
        <p className={`text-sm font-medium ${variantClasses[variant]}`}>{value}</p>
      </div>
    </div>
  );
};

export const ChatMigrationSection: React.FC = () => {
  const { t } = useTranslation('migration');
  
  // 状态
  const [checkResult, setCheckResult] = useState<MigrationCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [currentMessage, setCurrentMessage] = useState<string>('');
  
  // 追踪组件挂载状态，避免卸载后更新状态
  const isMountedRef = React.useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 检查迁移状态
  const checkStatus = useCallback(async () => {
    setIsChecking(true);
    try {
      const result = await DataGovernanceApi.checkChatMigrationStatus();
      setCheckResult(result);
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error), t('toast.checkFailed'));
    } finally {
      setIsChecking(false);
    }
  }, [t]);

  // 初始化时检查状态
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // 监听迁移事件
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    const setupListener = async () => {
      const fn = await listen<MigrationEvent>('chat_v2_migration', (event) => {
        // 组件卸载后不更新状态
        if (!isMountedRef.current) return;
        
        const { eventType, progress: prog, message } = event.payload;
        
        setProgress(prog);
        setCurrentMessage(message);

        switch (eventType) {
          case 'started':
            showGlobalNotification('info', message, t('toast.migrationStarted'));
            break;
          case 'completed':
            setIsMigrating(false);
            showGlobalNotification('success', message, t('toast.migrationCompleted'));
            checkStatus();
            break;
          case 'failed':
            setIsMigrating(false);
            showGlobalNotification('error', prog.error || message, t('toast.migrationFailed'));
            break;
          case 'rollback_started':
            showGlobalNotification('info', message, t('toast.rollbackStarted'));
            break;
          case 'rollback_completed':
            setIsRollingBack(false);
            showGlobalNotification('success', message, t('toast.rollbackCompleted'));
            checkStatus();
            break;
          case 'rollback_failed':
            setIsRollingBack(false);
            showGlobalNotification('error', message, t('toast.rollbackFailed'));
            break;
        }
      });

      // 如果在 listen 解析之前组件已卸载，立即清除监听
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [t, checkStatus]);

  // 开始迁移
  const startMigration = useCallback(async () => {
    if (!unifiedConfirm(t('confirm.migrate'))) {
      return;
    }

    setIsMigrating(true);
    setProgress(null);
    setReport(null);

    try {
      const result = await DataGovernanceApi.migrateLegacyChat();
      setReport(result);
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error), t('toast.migrationFailed'));
      setIsMigrating(false);
    }
  }, [t]);

  // 回滚迁移
  const rollbackMigration = useCallback(async () => {
    if (!unifiedConfirm(t('confirm.rollback'))) {
      return;
    }

    setIsRollingBack(true);
    setProgress(null);
    setReport(null);

    try {
      const result = await DataGovernanceApi.rollbackChatMigration();
      setReport(result);
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error), t('toast.rollbackFailed'));
      setIsRollingBack(false);
    }
  }, [t]);

  // 获取状态图标
  const getStatusIcon = (status: MigrationStatus) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'in_progress':
        return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
      case 'rolled_back':
        return <RotateCcw className="h-5 w-5 text-yellow-500" />;
      default:
        return <Database className="h-5 w-5 text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-8">
      {/* 标题区域 */}
      <div className="space-y-1">
        <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {/* 状态检查区域 */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">{t('check.title')}</h3>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={checkStatus}
            disabled={isChecking || isMigrating || isRollingBack}
            className="h-8"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            {t('actions.checkStatus')}
          </NotionButton>
        </div>

        {isChecking && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t('check.loading')}</span>
          </div>
        )}

        {checkResult && !isChecking && (
          <div className="space-y-4">
            {/* 状态概览 */}
            <div className={`p-4 rounded-lg border ${
              checkResult.needsMigration 
                ? 'border-yellow-500/50 bg-yellow-500/10' 
                : 'border-green-500/50 bg-green-500/10'
            }`}>
              <div className="flex items-center gap-2">
                {checkResult.needsMigration ? (
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                ) : (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                )}
                <span className="font-medium">
                  {checkResult.needsMigration 
                    ? t('check.needsMigration')
                    : t('check.noNeedsMigration')
                  }
                </span>
              </div>
            </div>

            {/* 统计信息 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatItem
                icon={MessageSquare}
                label={t('check.pendingMessages')}
                value={checkResult.pendingMessages}
                variant={checkResult.pendingMessages > 0 ? 'warning' : 'default'}
              />
              <StatItem
                icon={FolderOpen}
                label={t('check.pendingSessions')}
                value={checkResult.pendingSessions}
                variant={checkResult.pendingSessions > 0 ? 'warning' : 'default'}
              />
              <StatItem
                icon={CheckCircle}
                label={t('check.migratedMessages')}
                value={checkResult.migratedMessages}
                variant={checkResult.migratedMessages > 0 ? 'success' : 'default'}
              />
              <StatItem
                icon={Clock}
                label={t('check.lastMigrationAt')}
                value={checkResult.lastMigrationAt 
                  ? formatDateTime(checkResult.lastMigrationAt)
                  : '-'
                }
              />
            </div>

            {/* 操作按钮 */}
            <div className="flex gap-3">
              <NotionButton
                onClick={startMigration}
                disabled={!checkResult.needsMigration || isMigrating || isRollingBack}
              >
                {isMigrating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                {t('actions.startMigration')}
              </NotionButton>
              
              <NotionButton
                variant="ghost"
                onClick={rollbackMigration}
                disabled={!checkResult.canRollback || isMigrating || isRollingBack}
              >
                {isRollingBack ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-2" />
                )}
                {t('actions.rollback')}
              </NotionButton>
            </div>
          </div>
        )}
      </div>

      {/* 进度显示区域 */}
      {(isMigrating || isRollingBack) && progress && (
        <div className="space-y-4 mt-6 p-4 rounded-lg border border-border bg-muted/30">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium text-foreground">{t('progress.title')}</h3>
            <div className="flex items-center gap-2">
              {getStatusIcon(progress.status)}
              <span className="text-sm text-muted-foreground">
                {t(`status.${statusLabels[progress.status]}`)}
              </span>
            </div>
          </div>

          {/* 进度条 */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {t('progress.currentStep')}: {t(`steps.${stepLabels[progress.currentStep]}`)}
              </span>
              <span className="font-medium">{progress.percent}%</span>
            </div>
            <Progress value={progress.percent} className="h-2" />
          </div>

          {/* 详细进度 */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('progress.messages')}:</span>
              <span>{progress.migratedMessages} / {progress.totalMessages}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('progress.sessions')}:</span>
              <span>{progress.createdSessions} / {progress.totalSessions}</span>
            </div>
          </div>

          {/* 当前操作 */}
          {currentMessage && (
            <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
              {currentMessage}
            </p>
          )}
        </div>
      )}

      {/* 报告显示区域 */}
      {report && !isMigrating && !isRollingBack && (
        <div className="space-y-4 mt-6 p-4 rounded-lg border border-border bg-muted/30">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium text-foreground">{t('report.title')}</h3>
            {getStatusIcon(report.status)}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatItem
              icon={FolderOpen}
              label={t('report.sessionsCreated')}
              value={report.sessionsCreated}
              variant="success"
            />
            <StatItem
              icon={MessageSquare}
              label={t('report.messagesMigrated')}
              value={report.messagesMigrated}
              variant="success"
            />
            <StatItem
              icon={Blocks}
              label={t('report.blocksCreated')}
              value={report.blocksCreated}
              variant="success"
            />
            <StatItem
              icon={Paperclip}
              label={t('report.attachmentsCreated')}
              value={report.attachmentsCreated}
            />
            <StatItem
              icon={Clock}
              label={t('report.duration')}
              value={formatDuration(report.durationMs)}
            />
            {report.messagesSkipped > 0 && (
              <StatItem
                icon={AlertTriangle}
                label={t('report.messagesSkipped')}
                value={report.messagesSkipped}
                variant="warning"
              />
            )}
          </div>

          {/* 错误列表 */}
          {report.errors.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-red-600 dark:text-red-400">
                {t('report.errors')} ({report.errors.length})
              </h4>
              <ul className="text-xs text-muted-foreground bg-red-50 dark:bg-red-950/30 p-3 rounded space-y-1 max-h-32 overflow-y-auto">
                {report.errors.map((error, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <XCircle className="h-3 w-3 text-red-500 mt-0.5 flex-shrink-0" />
                    <span>{error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChatMigrationSection;
