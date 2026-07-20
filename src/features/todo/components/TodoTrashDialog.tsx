/**
 * Todo 回收站（已去 Dialog 化，内联视图承载）
 *
 * 列出软删除的清单与任务（任务仅含可独立恢复的根条目，
 * 随清单/父任务删除的内容由对应条目的恢复带回）。
 * 支持单条恢复、单条彻底删除与清空回收站——不可逆操作走
 * 行内二次确认条（250ms 展开），不再使用 AlertDialog。
 *
 * 承载形态：
 * - TodoTrashWorkspace：桌面端主内容区内联视图（侧栏点击回收站后
 *   由 TodoContentView 切换渲染，带返回按钮）
 * - TodoTrashScreen：移动端 inline 子屏（由 TodoContentView 全屏承载，
 *   标题/返回走统一顶栏，符合移动端「禁弹层承载列表」契约）
 * - TodoTrashDialog：兼容旧调用方的适配器——open 时转为打开内联视图，
 *   不再挂载任何模态框（保留导出符号与 props 契约）
 *
 * useTodoTrashView：跨挂载点（Shell 侧栏 / 内容区）共享的回收站
 * 视图开关状态。仅 UI 视图态，数据操作仍全部走 useTodoStore。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { AnimatePresence } from 'framer-motion';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ListChecks,
  Trash,
  CheckSquare,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { AnimatedListRow } from '@/components/ui/AnimatedListRow';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import { useTodoStore } from '../stores/useTodoStore';

// ============================================================================
// 回收站视图开关（侧栏与内容区分属不同挂载点，经模块级 store 协调）
// ============================================================================

interface TodoTrashViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useTodoTrashView = create<TodoTrashViewState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

// ============================================================================
// 工具
// ============================================================================

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

// ============================================================================
// TrashRow — 单条记录（恢复 / 彻底删除 + 行内二次确认条）
// ============================================================================

interface TrashRowProps {
  icon: React.ReactNode;
  title: string;
  deletedLabel: string;
  confirming: boolean;
  onRestore: () => void;
  onRequestPurge: () => void;
  onConfirmPurge: () => void;
  onCancelPurge: () => void;
}

const TrashRow: React.FC<TrashRowProps> = ({
  icon,
  title,
  deletedLabel,
  confirming,
  onRestore,
  onRequestPurge,
  onConfirmPurge,
  onCancelPurge,
}) => {
  const { t } = useTranslation(['todo', 'common']);
  const restoreLabel = t('todo:trash.restore');
  const purgeLabel = t('todo:trash.purge');

  return (
    <div
      className={cn(
        'group flex items-center gap-2.5 rounded-xl px-2.5 py-1.5',
        'transition-colors duration-150 hover:bg-[color:var(--interactive-hover)]',
        '[@media(pointer:coarse)]:min-h-[2.75rem]',
        confirming && 'bg-[color:var(--interactive-hover)]',
      )}
    >
      <span className="flex-shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-foreground">{title}</div>
        {deletedLabel && (
          <div className="text-[11px] tabular-nums text-muted-foreground/70">{deletedLabel}</div>
        )}
      </div>
      {confirming ? (
        <div className="ui-zoom-fade-in flex flex-shrink-0 items-center gap-1">
          <span className="hidden text-[11px] text-[color:hsl(var(--destructive))] sm:inline">
            {t('todo:trash.purgeInlineHint')}
          </span>
          <NotionButton
            variant="danger"
            size="sm"
            onClick={onConfirmPurge}
            className="!px-2 !py-1 text-[12px] [@media(pointer:coarse)]:min-h-[2.5rem]"
          >
            {purgeLabel}
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={onCancelPurge}
            className="!px-2 !py-1 text-[12px] [@media(pointer:coarse)]:min-h-[2.5rem]"
          >
            {t('common:actions.cancel')}
          </NotionButton>
        </div>
      ) : (
        <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={onRestore}
            title={restoreLabel}
            aria-label={restoreLabel}
            className="!px-2 !py-1 text-[12px] [@media(pointer:coarse)]:min-h-[2.5rem] [@media(pointer:coarse)]:!px-3"
          >
            <ArrowCounterClockwise size={13} />
            <span>{restoreLabel}</span>
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onRequestPurge}
            title={purgeLabel}
            aria-label={purgeLabel}
            className="!p-1.5 [@media(pointer:coarse)]:!p-3 hover:!bg-[color:var(--button-danger-surface)] hover:!text-[color:hsl(var(--destructive))]"
          >
            <Trash size={13} />
          </NotionButton>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// TrashSections — 列表主体（加载/空态/清单区/任务区/加载更多），两种形态共用
// ============================================================================

const TrashSections: React.FC = () => {
  const { t, i18n } = useTranslation(['todo', 'common']);
  const {
    trashLists,
    trashItems,
    isLoadingTrash,
    trashHasMore,
    loadMoreTrash,
    restoreListFromTrash,
    restoreItemFromTrash,
    purgeListFromTrash,
    purgeItemFromTrash,
  } = useTodoStore();

  // 行内二次确认：同一时刻只允许一条处于确认态（"list:{id}" / "item:{id}"）
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);

  const isEmpty = trashLists.length === 0 && trashItems.length === 0;
  const locale = i18n.language || 'zh-CN';

  if (isLoadingTrash && isEmpty) {
    return (
      <div className="py-8 text-center text-[13px] text-muted-foreground">
        {t('common:status.loading', { defaultValue: '加载中...' })}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="study-shell-empty-state mx-2 my-4 sm:mx-4">
        <span className="study-shell-empty-state__icon">
          <Trash size={22} weight="duotone" />
        </span>
        <div className="study-shell-empty-state__title">{t('todo:trash.empty')}</div>
        <div className="study-shell-empty-state__description">{t('todo:trash.description')}</div>
      </div>
    );
  }

  const sectionHeaderClass = cn(
    'sticky top-0 z-[1] px-2.5 pb-1 pt-2',
    'bg-[color:var(--surface-root)]/95 backdrop-blur-sm',
    'text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70',
  );

  return (
    <div className="space-y-3">
      {trashLists.length > 0 && (
        <section>
          <div data-wb-blur-surface className={sectionHeaderClass}>{t('todo:trash.listsSection')}</div>
          <div className="space-y-0.5">
            <AnimatePresence initial={false}>
              {trashLists.map((list) => (
                <AnimatedListRow key={list.id}>
                  <TrashRow
                    icon={<ListChecks size={16} />}
                    title={list.title}
                    deletedLabel={t('todo:trash.deletedAt', {
                      time: formatDeletedAt(list.deletedAt, locale),
                    })}
                    confirming={confirmingKey === `list:${list.id}`}
                    onRestore={() => void restoreListFromTrash(list.id)}
                    onRequestPurge={() => setConfirmingKey(`list:${list.id}`)}
                    onConfirmPurge={() => {
                      setConfirmingKey(null);
                      void purgeListFromTrash(list.id);
                    }}
                    onCancelPurge={() => setConfirmingKey(null)}
                  />
                </AnimatedListRow>
              ))}
            </AnimatePresence>
          </div>
        </section>
      )}

      {trashItems.length > 0 && (
        <section>
          <div data-wb-blur-surface className={sectionHeaderClass}>{t('todo:trash.itemsSection')}</div>
          <div className="space-y-0.5">
            <AnimatePresence initial={false}>
              {trashItems.map((item) => (
                <AnimatedListRow key={item.id}>
                  <TrashRow
                    icon={<CheckSquare size={16} />}
                    title={item.title}
                    deletedLabel={t('todo:trash.deletedAt', {
                      time: formatDeletedAt(item.deletedAt, locale),
                    })}
                    confirming={confirmingKey === `item:${item.id}`}
                    onRestore={() => void restoreItemFromTrash(item.id)}
                    onRequestPurge={() => setConfirmingKey(`item:${item.id}`)}
                    onConfirmPurge={() => {
                      setConfirmingKey(null);
                      void purgeItemFromTrash(item.id);
                    }}
                    onCancelPurge={() => setConfirmingKey(null)}
                  />
                </AnimatedListRow>
              ))}
            </AnimatePresence>
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
            className="text-[12px] text-muted-foreground [@media(pointer:coarse)]:min-h-[2.5rem]"
          >
            {isLoadingTrash
              ? t('common:status.loading', { defaultValue: '加载中...' })
              : t('todo:trash.loadMore')}
          </NotionButton>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// TrashEmptyAllButton — 清空回收站（行内二次确认展开）
// ============================================================================

const TrashEmptyAllButton: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { trashLists, trashItems, emptyTrash } = useTodoStore();
  const [confirming, setConfirming] = useState(false);

  const isEmpty = trashLists.length === 0 && trashItems.length === 0;

  useEffect(() => {
    if (isEmpty) setConfirming(false);
  }, [isEmpty]);

  if (confirming) {
    return (
      <div className={cn('ui-zoom-fade-in flex items-center gap-1.5', className)}>
        <span className="hidden text-[12px] text-muted-foreground sm:inline">
          {t('todo:trash.emptyAllInlineHint')}
        </span>
        <NotionButton
          variant="danger"
          size="sm"
          onClick={() => {
            setConfirming(false);
            void emptyTrash();
          }}
          className="[@media(pointer:coarse)]:min-h-[2.5rem]"
        >
          {t('todo:trash.confirmEmptyAll')}
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(false)}
          className="[@media(pointer:coarse)]:min-h-[2.5rem]"
        >
          {t('common:actions.cancel')}
        </NotionButton>
      </div>
    );
  }

  return (
    <NotionButton
      variant="ghost"
      size="sm"
      disabled={isEmpty}
      onClick={() => setConfirming(true)}
      className={cn(
        'text-[color:hsl(var(--destructive))] disabled:opacity-40 [@media(pointer:coarse)]:min-h-[2.5rem]',
        className,
      )}
    >
      {t('todo:trash.emptyAll')}
    </NotionButton>
  );
};

// ============================================================================
// TodoTrashWorkspace — 桌面端主内容区内联回收站视图（带返回）
// ============================================================================

export const TodoTrashWorkspace: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { loadTrash } = useTodoStore();
  const close = useTodoTrashView((s) => s.close);

  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-1 flex-col bg-[color:var(--surface-root,var(--background))]',
        className,
      )}
    >
      <header className="study-shell-toolbar flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={close}
            aria-label={t('todo:trash.back')}
            title={t('todo:trash.back')}
          >
            <ArrowLeft size={16} />
          </NotionButton>
          <Trash size={18} weight="duotone" className="shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold leading-tight text-foreground">
              {t('todo:trash.title')}
            </h2>
            <p className="hidden truncate text-[12px] text-muted-foreground md:block">
              {t('todo:trash.description')}
            </p>
          </div>
        </div>
        <TrashEmptyAllButton className="shrink-0" />
      </header>

      <CustomScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-4 sm:px-4">
        <TrashSections />
      </CustomScrollArea>
    </div>
  );
};

// ============================================================================
// TodoTrashScreen — 移动端回收站 inline 子屏
// ============================================================================

/**
 * 由 TodoContentView 全屏承载（标题与返回箭头走统一顶栏，
 * Android 返回键由承载它的子屏覆盖层注册）。挂载即加载回收站数据。
 */
export const TodoTrashScreen: React.FC<{ className?: string }> = ({ className }) => {
  const { loadTrash } = useTodoStore();

  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  return (
    <div className={cn('flex h-full flex-col bg-[color:var(--surface-root)]', className)}>
      <CustomScrollArea className="min-h-0 flex-1" viewportClassName="px-1.5 pb-3">
        <TrashSections />
      </CustomScrollArea>

      <div className="flex flex-shrink-0 items-center justify-end px-4 py-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]">
        <TrashEmptyAllButton />
      </div>
    </div>
  );
};

// ============================================================================
// TodoTrashDialog — 兼容适配器（不再渲染模态框）
// ============================================================================

interface TodoTrashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 历史调用方以 Dialog 形式打开回收站；现统一转为打开内联视图。
 * open=true 时打开 useTodoTrashView 并立即回写 onOpenChange(false)，
 * 保留导出符号与 props 契约，自身不渲染任何内容。
 */
export const TodoTrashDialog: React.FC<TodoTrashDialogProps> = ({ open, onOpenChange }) => {
  const openTrashView = useTodoTrashView((s) => s.open);

  useEffect(() => {
    if (open) {
      openTrashView();
      onOpenChange(false);
    }
  }, [open, onOpenChange, openTrashView]);

  return null;
};
