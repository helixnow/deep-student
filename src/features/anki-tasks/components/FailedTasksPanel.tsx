/**
 * 制卡任务 — 失败分段面板（内联，非弹窗）
 *
 * 展开会话且存在失败口径任务（Failed / Truncated / Cancelled）时渲染：
 * 拉取 get_document_tasks，醒目展示每个分段的 error_message（后端已写入
 * 但此前前端从未展示），并提供逐段重试与一键全部重试。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import {
  controlDocumentTask,
  listFailedDocumentTasks,
  type DocumentTaskSummary,
} from '@/features/anki/taskControl';

const COLLAPSED_COUNT = 4;

export const FailedTasksPanel: React.FC<{
  documentId: string;
  /** 会话统计的失败任务数（变化时触发重新拉取） */
  failedCount: number;
  /** 重试成功后回调（通常触发上层会话列表刷新） */
  onRetried: () => void;
}> = ({ documentId, failedCount, onRetried }) => {
  const { t } = useTranslation('anki');
  const [tasks, setTasks] = useState<DocumentTaskSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const failed = await listFailedDocumentTasks(documentId);
      if (aliveRef.current) setTasks(failed);
    } catch (err: unknown) {
      debugLog.error('[AnkiTasks] loadFailedTasks failed:', err);
      if (aliveRef.current) setTasks([]);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [documentId]);

  // failedCount 变化（轮询更新）时同步刷新失败列表
  useEffect(() => {
    void loadTasks();
  }, [loadTasks, failedCount]);

  const retryOne = useCallback(async (taskId: string) => {
    setRetryingId(taskId);
    try {
      await controlDocumentTask({ taskId, action: 'retry' });
      showGlobalNotification('success', t('taskDashboard.retryStarted', { count: 1 }));
      onRetried();
      void loadTasks();
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      if (aliveRef.current) setRetryingId(null);
    }
  }, [t, onRetried, loadTasks]);

  const retryAll = useCallback(async () => {
    if (!tasks || tasks.length === 0) return;
    setRetryingAll(true);
    try {
      const results = await Promise.allSettled(
        tasks.map(task => controlDocumentTask({ taskId: task.id, action: 'retry' })),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      if (failed === 0) {
        showGlobalNotification('success', t('taskDashboard.retryStarted', { count: succeeded }));
      } else {
        showGlobalNotification('warning', t('taskDashboard.retryPartial', { succeeded, failed }));
      }
      onRetried();
      void loadTasks();
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      if (aliveRef.current) setRetryingAll(false);
    }
  }, [tasks, t, onRetried, loadTasks]);

  const statusLabel = (status: string): string => {
    if (status === 'Truncated') return t('tasks.statusTruncated');
    if (status === 'Cancelled') return t('tasks.statusCancelled');
    return t('taskDashboard.statusFailed');
  };

  if (loading && tasks === null) {
    return (
      <div className="wb-at-failed-panel">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleNotch size={13} className="animate-spin" />
          {t('tasks.loadingFailures')}
        </div>
      </div>
    );
  }

  if (!tasks || tasks.length === 0) return null;

  const visible = showAll ? tasks : tasks.slice(0, COLLAPSED_COUNT);
  const hiddenCount = tasks.length - visible.length;

  return (
    <div className="wb-at-failed-panel" role="alert">
      <div className="flex items-center gap-2">
        <WarningCircle size={15} weight="fill" className="text-[color:hsl(var(--warning))] flex-shrink-0" />
        <span className="text-xs font-medium text-[color:hsl(var(--warning))] flex-1 min-w-0">
          {t('tasks.failedPanelTitle', { count: tasks.length })}
        </span>
        <DsButton
          size="sm"
          variant="ghost"
          onClick={retryAll}
          disabled={retryingAll || !!retryingId}
          className="h-6 text-[11px] flex-shrink-0"
        >
          {retryingAll
            ? <CircleNotch size={12} className="animate-spin" />
            : <ArrowCounterClockwise size={12} />}
          {t('tasks.retryAll')}
        </DsButton>
      </div>

      <div className="mt-1.5 space-y-1">
        {visible.map(task => (
          <div key={task.id} className="wb-at-failed-item">
            <span className="wb-at-failed-seg">
              {t('tasks.segmentLabel', { index: task.segment_index + 1 })}
            </span>
            <span className="wb-at-failed-status">{statusLabel(task.status)}</span>
            <span className="wb-at-failed-msg" title={task.error_message ?? undefined}>
              {task.error_message?.trim() || t('tasks.noErrorMessage')}
            </span>
            <DsButton
              size="sm"
              variant="ghost"
              onClick={() => retryOne(task.id)}
              disabled={retryingAll || !!retryingId}
              className="h-5 w-5 p-0 flex-shrink-0 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
              aria-label={t('taskDashboard.retryFailed')}
            >
              {retryingId === task.id
                ? <CircleNotch size={11} className="animate-spin" />
                : <ArrowCounterClockwise size={11} />}
            </DsButton>
          </div>
        ))}
      </div>

      {hiddenCount > 0 && (
        <DsButton
          size="sm"
          variant="ghost"
          onClick={() => setShowAll(true)}
          className="mt-1 h-6 w-full justify-center text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
        >
          {t('tasks.showMoreFailures', { count: hiddenCount })}
        </DsButton>
      )}
    </div>
  );
};
