/**
 * BulkActionBar — 批量多选内联操作条（非弹窗）
 *
 * Cmd/Ctrl/Shift 点选进入多选后出现在工具栏下方：
 * 完成 / 改到今天 / 改到明天 / 设置优先级 / 删除（二次点击确认 + 撤销 toast）/ 清除选择。
 * 批量写走 store 的 bulk* action（单事务后端命令 + 乐观更新 + 失败回滚 + 静默校准），
 * 无需手动 reloadCurrentView；成功提示由本组件按返回结果展示（store 只弹失败）。
 * 后端单命令上限 500：超限时经 runChunkedBulk 按片顺序执行（每片单事务），
 * 聚合各片结果后统一 toast；删除撤销用聚合后的全部 affectedIds。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarPlus,
  CheckCircle,
  CircleNotch,
  Flag,
  Trash,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useTodoStore } from '../../stores/useTodoStore';
import type { TodoBatchItemsResult } from '../../api';
import type { TodoPriority } from '../../types';
import { PRIORITY_CONFIG, addDays, formatLocalDate, localToday } from '../../types';
import {
  mergeBatchIdsResults,
  mergeBatchItemsResults,
  runChunkedBulk,
  type ChunkedBulkOutcome,
} from './bulkChunks';

const PRIORITY_ORDER: TodoPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

interface BulkActionBarProps {
  checkedIds: ReadonlySet<string>;
  /** 操作完成（或点击清除）后由父级清空选择集 */
  onClear: () => void;
}

export const BulkActionBar: React.FC<BulkActionBarProps> = ({ checkedIds, onClear }) => {
  const { t } = useTranslation(['todo', 'common']);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const count = checkedIds.size;

  // 选择集变化时收回删除二次确认态
  useEffect(() => {
    setConfirmingDelete(false);
  }, [checkedIds]);

  /**
   * 批量执行包装：busy 互斥 + 完成后清空选择。
   * store 的 bulk* action 自带乐观更新/失败回滚/静默校准，这里不再手动 reload。
   * 超过后端单命令上限（500）时按片顺序执行（每片仍是单事务），结果由调用方聚合。
   */
  const runBulk = useCallback(
    async <R,>(
      op: (ids: string[]) => Promise<R | null>,
    ): Promise<ChunkedBulkOutcome<R> | undefined> => {
      if (busy) return undefined;
      setBusy(true);
      try {
        return await runChunkedBulk([...checkedIds], op);
      } finally {
        setBusy(false);
        onClear();
      }
    },
    [busy, checkedIds, onClear],
  );

  /** 有跳过项时在成功消息后追加计数（与列表计数同款 " · " 分隔） */
  const withSkippedNote = useCallback(
    (base: string, skippedCount: number): string =>
      skippedCount > 0
        ? `${base} · ${t('todo:bulk.skippedCount', {
            count: skippedCount,
            defaultValue: '跳过 {{count}} 项',
          })}`
        : base,
    [t],
  );

  /**
   * 返回实体类批量操作（complete/reschedule/setPriority）的聚合成功提示。
   * undefined = busy 未执行；分片失败时 store 已回滚该片并弹错误，
   * 这里只按已成功分片的聚合结果提示（部分成功也如实计数）。
   */
  const notifyItemsOutcome = useCallback(
    (
      outcome: ChunkedBulkOutcome<TodoBatchItemsResult> | undefined,
      messageKey: string,
      defaultValue: string,
    ) => {
      if (!outcome) return;
      const merged = mergeBatchItemsResults(outcome.results);
      if (merged.items.length === 0) {
        // 全部被跳过（如并发删除）时也要给出反馈，避免点了没动静
        if (!outcome.failed && merged.skippedIds.length > 0) {
          showGlobalNotification(
            'info',
            t('todo:bulk.skippedCount', {
              count: merged.skippedIds.length,
              defaultValue: '跳过 {{count}} 项',
            }),
          );
        }
        return;
      }
      showGlobalNotification(
        'success',
        withSkippedNote(
          t(messageKey, { count: merged.items.length, defaultValue }),
          merged.skippedIds.length,
        ),
      );
    },
    [t, withSkippedNote],
  );

  const handleComplete = useCallback(() => {
    // 已完成的条目后端幂等返回原状态，无需预过滤
    void runBulk((ids) => useTodoStore.getState().bulkCompleteItems(ids)).then((outcome) =>
      notifyItemsOutcome(outcome, 'todo:bulk.completed', '已完成 {{count}} 项'),
    );
  }, [runBulk, notifyItemsOutcome]);

  const handleReschedule = useCallback(
    (date: string) => {
      void runBulk((ids) => useTodoStore.getState().bulkRescheduleItems(ids, date)).then(
        (outcome) => notifyItemsOutcome(outcome, 'todo:bulk.rescheduled', '已改期 {{count}} 项'),
      );
    },
    [runBulk, notifyItemsOutcome],
  );

  const handlePriority = useCallback(
    (priority: TodoPriority) => {
      void runBulk((ids) => useTodoStore.getState().bulkSetPriorityItems(ids, priority)).then(
        (outcome) =>
          notifyItemsOutcome(outcome, 'todo:bulk.prioritySet', '已更新 {{count}} 项优先级'),
      );
    },
    [runBulk, notifyItemsOutcome],
  );

  const handleDelete = useCallback(() => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    void runBulk((ids) => useTodoStore.getState().bulkDeleteItems(ids)).then((outcome) => {
      // undefined = busy 未执行；失败分片 store 已回滚并弹错误，这里聚合成功分片
      if (!outcome) return;
      const merged = mergeBatchIdsResults(outcome.results);
      if (merged.affectedIds.length === 0) {
        if (!outcome.failed && merged.skippedIds.length > 0) {
          showGlobalNotification(
            'info',
            t('todo:bulk.skippedCount', {
              count: merged.skippedIds.length,
              defaultValue: '跳过 {{count}} 项',
            }),
          );
        }
        return;
      }
      const deletedIds = merged.affectedIds;
      showGlobalNotification(
        'success',
        withSkippedNote(
          t('todo:bulk.deleted', { count: deletedIds.length, defaultValue: '已删除 {{count}} 项' }),
          merged.skippedIds.length,
        ),
        undefined,
        {
          action: {
            label: t('todo:notifications.undo'),
            onClick: () => {
              // 恢复同样受 500 上限约束：按片顺序恢复聚合后的全部 affectedIds
              void runChunkedBulk(deletedIds, (chunk) =>
                useTodoStore.getState().bulkRestoreItems(chunk),
              );
            },
          },
        },
      );
    });
  }, [confirmingDelete, runBulk, t, withSkippedNote]);

  if (count === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label={t('todo:bulk.title', { defaultValue: '批量操作' })}
      className={cn(
        'ui-rise-in flex flex-wrap items-center gap-1.5 border-b border-border/30 px-4 py-1.5 sm:px-6',
        'bg-[color:hsl(var(--primary))]/[0.05]',
      )}
    >
      <span className="mr-1 text-xs font-medium tabular-nums text-foreground">
        {t('todo:bulk.selectedCount', { count, defaultValue: '已选 {{count}} 项' })}
      </span>

      {busy ? (
        <CircleNotch size={14} className="animate-spin text-muted-foreground" />
      ) : (
        <>
          <NotionButton
            variant="utility"
            size="sm"
            onClick={handleComplete}
            className="h-7 gap-1 !px-2 text-xs"
          >
            <CheckCircle size={13} />
            {t('todo:bulk.complete', { defaultValue: '完成' })}
          </NotionButton>

          <NotionButton
            variant="utility"
            size="sm"
            // 点击时刻取「今天」：操作条可能跨午夜常驻（对齐 RescheduleMenu 的口径）
            onClick={() => handleReschedule(localToday())}
            className="h-7 gap-1 !px-2 text-xs"
          >
            <CalendarPlus size={13} />
            {t('todo:reschedule.today')}
          </NotionButton>

          <NotionButton
            variant="utility"
            size="sm"
            onClick={() => handleReschedule(formatLocalDate(addDays(new Date(), 1)))}
            className="h-7 gap-1 !px-2 text-xs"
          >
            <CalendarPlus size={13} />
            {t('todo:reschedule.tomorrow')}
          </NotionButton>

          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton variant="utility" size="sm" className="h-7 gap-1 !px-2 text-xs">
                <Flag size={13} />
                {t('todo:fields.priority')}
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="start" width={160}>
              {PRIORITY_ORDER.map((p) => (
                <AppMenuItem key={p} onClick={() => handlePriority(p)}>
                  <span className={PRIORITY_CONFIG[p].color}>{t(PRIORITY_CONFIG[p].labelKey)}</span>
                </AppMenuItem>
              ))}
            </AppMenuContent>
          </AppMenu>

          <NotionButton
            variant="utility"
            size="sm"
            onClick={handleDelete}
            className={cn(
              'h-7 gap-1 !px-2 text-xs transition-colors',
              confirmingDelete
                ? '!bg-[color:hsl(var(--destructive))] !text-white'
                : 'hover:!bg-[color:var(--button-danger-surface)] hover:!text-[color:hsl(var(--destructive))]',
            )}
          >
            <Trash size={13} weight={confirmingDelete ? 'fill' : 'regular'} />
            {confirmingDelete
              ? t('todo:bulk.confirmDelete', { defaultValue: '确认删除' })
              : t('common:actions.delete', '删除')}
          </NotionButton>
        </>
      )}

      <NotionButton
        variant="ghost"
        size="sm"
        onClick={onClear}
        className="ml-auto h-7 gap-1 !px-2 text-xs text-muted-foreground"
      >
        <X size={13} />
        {t('todo:bulk.clear', { defaultValue: '清除选择' })}
      </NotionButton>
    </div>
  );
};
