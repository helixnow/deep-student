/**
 * TodoTrashDialog - 待办回收站
 *
 * 列出软删除的清单与任务（任务仅含可独立恢复的根条目，
 * 随清单/父任务删除的内容由对应条目的恢复带回）。
 * 支持单条恢复、单条彻底删除与清空回收站（均不可逆操作需确认）。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, ListChecks, Trash, CheckSquare } from '@phosphor-icons/react';
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
  NotionDialogDescription,
  NotionDialogBody,
  NotionDialogFooter,
  NotionAlertDialog,
} from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTodoStore } from '../stores/useTodoStore';

interface TodoTrashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PendingPurge =
  | { type: 'list'; id: string; title: string }
  | { type: 'item'; id: string; title: string }
  | { type: 'all' }
  | null;

function formatDeletedAt(deletedAt: string | undefined, locale: string): string {
  if (!deletedAt) return '';
  const d = new Date(deletedAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface TrashRowProps {
  icon: React.ReactNode;
  title: string;
  deletedLabel: string;
  onRestore: () => void;
  onPurge: () => void;
  restoreLabel: string;
  purgeLabel: string;
}

const TrashRow: React.FC<TrashRowProps> = ({
  icon,
  title,
  deletedLabel,
  onRestore,
  onPurge,
  restoreLabel,
  purgeLabel,
}) => (
  <div className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[color:var(--interactive-hover)]">
    <span className="flex-shrink-0 text-muted-foreground">{icon}</span>
    <div className="min-w-0 flex-1">
      <div className="truncate text-[13px] text-foreground">{title}</div>
      {deletedLabel && (
        <div className="text-[11px] text-muted-foreground/70">{deletedLabel}</div>
      )}
    </div>
    <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={onRestore}
        title={restoreLabel}
        aria-label={restoreLabel}
        className="!px-2 !py-1 text-[12px]"
      >
        <ArrowCounterClockwise size={13} />
        <span>{restoreLabel}</span>
      </NotionButton>
      <NotionButton
        variant="ghost"
        size="sm"
        iconOnly
        onClick={onPurge}
        title={purgeLabel}
        aria-label={purgeLabel}
        className="!p-1.5 hover:!bg-[color:var(--button-danger-surface)] hover:!text-[color:hsl(var(--destructive))]"
      >
        <Trash size={13} />
      </NotionButton>
    </div>
  </div>
);

export const TodoTrashDialog: React.FC<TodoTrashDialogProps> = ({ open, onOpenChange }) => {
  const { t, i18n } = useTranslation(['todo', 'common']);
  const {
    trashLists,
    trashItems,
    isLoadingTrash,
    trashHasMore,
    loadTrash,
    loadMoreTrash,
    restoreListFromTrash,
    restoreItemFromTrash,
    purgeListFromTrash,
    purgeItemFromTrash,
    emptyTrash,
  } = useTodoStore();

  const [pendingPurge, setPendingPurge] = useState<PendingPurge>(null);

  useEffect(() => {
    if (open) void loadTrash();
  }, [open, loadTrash]);

  const isEmpty = trashLists.length === 0 && trashItems.length === 0;
  const locale = i18n.language || 'zh-CN';

  const confirmPurge = () => {
    if (!pendingPurge) return;
    if (pendingPurge.type === 'all') {
      void emptyTrash();
    } else if (pendingPurge.type === 'list') {
      void purgeListFromTrash(pendingPurge.id);
    } else {
      void purgeItemFromTrash(pendingPurge.id);
    }
    setPendingPurge(null);
  };

  return (
    <>
      <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-md">
        <NotionDialogHeader>
          <NotionDialogTitle>{t('todo:trash.title')}</NotionDialogTitle>
          <NotionDialogDescription>{t('todo:trash.description')}</NotionDialogDescription>
        </NotionDialogHeader>

        <NotionDialogBody overlayScroll>
          {isLoadingTrash && isEmpty ? (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              {t('common:status.loading', { defaultValue: '加载中...' })}
            </div>
          ) : isEmpty ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground/70">
              <Trash size={28} weight="thin" />
              <span className="text-[13px]">{t('todo:trash.empty')}</span>
            </div>
          ) : (
            <div className="space-y-4">
              {trashLists.length > 0 && (
                <section>
                  <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {t('todo:trash.listsSection')}
                  </div>
                  <div className="space-y-0.5">
                    {trashLists.map((list) => (
                      <TrashRow
                        key={list.id}
                        icon={<ListChecks size={16} />}
                        title={list.title}
                        deletedLabel={t('todo:trash.deletedAt', {
                          time: formatDeletedAt(list.deletedAt, locale),
                        })}
                        onRestore={() => void restoreListFromTrash(list.id)}
                        onPurge={() =>
                          setPendingPurge({ type: 'list', id: list.id, title: list.title })
                        }
                        restoreLabel={t('todo:trash.restore')}
                        purgeLabel={t('todo:trash.purge')}
                      />
                    ))}
                  </div>
                </section>
              )}

              {trashItems.length > 0 && (
                <section>
                  <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {t('todo:trash.itemsSection')}
                  </div>
                  <div className="space-y-0.5">
                    {trashItems.map((item) => (
                      <TrashRow
                        key={item.id}
                        icon={<CheckSquare size={16} />}
                        title={item.title}
                        deletedLabel={t('todo:trash.deletedAt', {
                          time: formatDeletedAt(item.deletedAt, locale),
                        })}
                        onRestore={() => void restoreItemFromTrash(item.id)}
                        onPurge={() =>
                          setPendingPurge({ type: 'item', id: item.id, title: item.title })
                        }
                        restoreLabel={t('todo:trash.restore')}
                        purgeLabel={t('todo:trash.purge')}
                      />
                    ))}
                  </div>
                </section>
              )}

              {trashHasMore && (
                <div className="flex justify-center pt-1">
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    disabled={isLoadingTrash}
                    onClick={() => void loadMoreTrash()}
                    className="text-[12px] text-muted-foreground"
                  >
                    {isLoadingTrash
                      ? t('common:status.loading', { defaultValue: '加载中...' })
                      : t('todo:trash.loadMore')}
                  </NotionButton>
                </div>
              )}
            </div>
          )}
        </NotionDialogBody>

        <NotionDialogFooter>
          <NotionButton
            variant="ghost"
            size="sm"
            disabled={isEmpty}
            onClick={() => setPendingPurge({ type: 'all' })}
            className="text-[color:hsl(var(--destructive))] disabled:opacity-40"
          >
            {t('todo:trash.emptyAll')}
          </NotionButton>
          <NotionButton variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:actions.close', { defaultValue: '关闭' })}
          </NotionButton>
        </NotionDialogFooter>
      </NotionDialog>

      {/* 彻底删除确认 */}
      <NotionAlertDialog
        open={pendingPurge !== null}
        onOpenChange={(o) => {
          if (!o) setPendingPurge(null);
        }}
        title={
          pendingPurge?.type === 'all'
            ? t('todo:trash.emptyAllConfirmTitle')
            : t('todo:trash.purgeConfirmTitle')
        }
        description={
          pendingPurge?.type === 'all'
            ? t('todo:trash.emptyAllConfirmDescription')
            : t('todo:trash.purgeConfirmDescription', {
                title: pendingPurge && 'title' in pendingPurge ? pendingPurge.title : '',
              })
        }
        confirmText={t('todo:trash.purge')}
        cancelText={t('common:actions.cancel')}
        onConfirm={confirmPurge}
      />
    </>
  );
};
