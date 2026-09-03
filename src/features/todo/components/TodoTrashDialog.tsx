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
 *   由 TodoContentView 切换渲染，带返回按钮，Esc 可直接返回待办）
 * - TodoTrashScreen：移动端 inline 子屏（由 TodoContentView 全屏承载，
 *   标题/返回走统一顶栏，符合移动端「禁弹层承载列表」契约）
 * - TodoTrashDialog：兼容旧调用方的适配器——open 时转为打开内联视图，
 *   不再挂载任何模态框（保留导出符号与 props 契约）
 *
 * useTodoTrashView：跨挂载点（Shell 侧栏 / 内容区）共享的回收站
 * 视图开关状态。仅 UI 视图态，数据操作仍全部走 useTodoStore。
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { AnimatePresence } from 'framer-motion';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  CircleNotch,
  ListChecks,
  Trash,
  CheckSquare,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { AnimatedListRow } from '@/components/ui/AnimatedListRow';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import { useTodoStore } from '../stores/useTodoStore';
import { useTodoToolbarPortalTarget } from './todoToolbarPortal';
import {
  TITLEBAR_CONTROL_CLASS,
  TITLEBAR_ICON_CONTROL_CLASS,
  TITLEBAR_TITLE_CLASS,
} from '@/app/shell/titlebarUiTokens';

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
        'group flex items-center gap-2.5 rounded-[var(--radius-shell-control)] px-2.5 py-1.5',
        'transition-colors duration-150 hover:bg-[color:var(--interactive-hover)]',
        '[@media(pointer:coarse)]:min-h-[2.75rem]',
        confirming && 'bg-[color:var(--interactive-hover)]',
      )}
    >
      <span className="flex-shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui text-foreground">{title}</div>
        {deletedLabel && (
          <div className="text-xs tabular-nums text-muted-foreground/70">{deletedLabel}</div>
        )}
      </div>
      {confirming ? (
        <div className="ui-zoom-fade-in flex flex-shrink-0 items-center gap-1">
          <span className="hidden text-xs text-[color:hsl(var(--destructive))] sm:inline">
            {t('todo:trash.purgeInlineHint')}
          </span>
          <DsButton
            variant="danger"
            size="sm"
            onClick={onConfirmPurge}
            className="!px-2 !py-1 text-sm [@media(pointer:coarse)]:!min-h-11"
          >
            {purgeLabel}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onCancelPurge}
            className="!px-2 !py-1 text-sm [@media(pointer:coarse)]:!min-h-11"
          >
            {t('common:actions.cancel')}
          </DsButton>
        </div>
      ) : (
        <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onRestore}
            title={restoreLabel}
            aria-label={restoreLabel}
            className="!px-2 !py-1 text-sm [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!px-3"
          >
            <ArrowCounterClockwise size={13} />
            <span>{restoreLabel}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onRequestPurge}
            title={purgeLabel}
            aria-label={purgeLabel}
            className="!p-1.5 [@media(pointer:coarse)]:!p-3 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 hover:!bg-[color:var(--button-danger-surface)] hover:!text-[color:hsl(var(--destructive))]"
          >
            <Trash size={13} />
          </DsButton>
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
    // 首屏加载骨架：与 TrashRow 同构（图标 + 双行文本），避免加载完成跳变
    return (
      <div
        role="status"
        aria-label={t('todo:trash.loading')}
        className="space-y-1 px-1 py-3"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-2.5 rounded-[var(--radius-shell-control)] px-2.5 py-2 motion-safe:animate-pulse motion-reduce:opacity-70"
          >
            <div className="h-4 w-4 shrink-0 rounded bg-[color:var(--interactive-hover)]" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div
                className="h-3 rounded bg-[color:var(--interactive-hover)]"
                style={{ width: `${72 - i * 14}%` }}
              />
              <div className="h-2 w-24 rounded bg-[color:var(--interactive-hover)] opacity-60" />
            </div>
          </div>
        ))}
        <span className="sr-only">{t('common:status.loading', { defaultValue: '加载中...' })}</span>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="study-shell-empty-state ui-rise-in mx-2 my-4 sm:mx-4">
        <span className="study-shell-empty-state__icon">
          <Trash size={22} weight="duotone" />
        </span>
        <div className="study-shell-empty-state__title">{t('todo:trash.empty')}</div>
        <div className="study-shell-empty-state__description">{t('todo:trash.emptyHint')}</div>
      </div>
    );
  }

  const sectionHeaderClass = cn(
    'sticky top-0 z-[1] px-2.5 pb-1 pt-2',
    'bg-[color:var(--surface-root)]/95 backdrop-blur-sm',
    'text-xs font-medium uppercase tracking-wide text-muted-foreground/70',
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
          <DsButton
            variant="ghost"
            size="sm"
            disabled={isLoadingTrash}
            onClick={() => void loadMoreTrash()}
            aria-busy={isLoadingTrash || undefined}
            className="text-sm text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
          >
            {isLoadingTrash ? (
              <>
                <CircleNotch size={13} className="motion-safe:animate-spin" aria-hidden />
                <span>{t('common:status.loading', { defaultValue: '加载中...' })}</span>
              </>
            ) : (
              t('todo:trash.loadMore')
            )}
          </DsButton>
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
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {t('todo:trash.emptyAllInlineHint')}
        </span>
        <DsButton
          variant="danger"
          size="sm"
          onClick={() => {
            setConfirming(false);
            void emptyTrash();
          }}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          {t('todo:trash.confirmEmptyAll')}
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(false)}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          {t('common:actions.cancel')}
        </DsButton>
      </div>
    );
  }

  return (
    <DsButton
      variant="ghost"
      size="sm"
      disabled={isEmpty}
      onClick={() => setConfirming(true)}
      className={cn(
        'text-[color:hsl(var(--destructive))] disabled:opacity-40 [@media(pointer:coarse)]:!min-h-11',
        className,
      )}
    >
      {t('todo:trash.emptyAll')}
    </DsButton>
  );
};

// ============================================================================
// TodoTrashWorkspace — 桌面端主内容区内联回收站视图（带返回）
// ============================================================================

export const TodoTrashWorkspace: React.FC<{ className?: string; titlebarPortalTarget?: HTMLElement | null }> = ({ className, titlebarPortalTarget }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { loadTrash } = useTodoStore();
  const close = useTodoTrashView((s) => s.close);
  // 桌面端：头部迁入全局顶栏（workbench 窗口标题栏槽位 / legacy 壳标题栏）
  const headerPortalTarget = useTodoToolbarPortalTarget(titlebarPortalTarget);

  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  // Esc 返回待办（焦点在输入框 / 打开的菜单浮层中时不劫持——
  // AppMenu 自己消费 Escape 并 stopPropagation，走不到 window 层）。
  // 本视图在被隐藏的 ViewLayerRenderer 离场层里仍保持挂载，
  // 用可见性判定避免在其他页面误吞 Escape。
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = workspaceRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return;
      if (window.getComputedStyle(el).visibility === 'hidden') return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) return;
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const headerClusters = (
    <>
      <div className={cn('flex min-w-0 items-center gap-2', headerPortalTarget && 'pointer-events-auto')}>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={close}
          aria-label={t('todo:trash.back')}
          title={t('todo:trash.back')}
          className={headerPortalTarget
            ? TITLEBAR_ICON_CONTROL_CLASS
            : '[@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11'}
        >
          <ArrowLeft size={16} />
        </DsButton>
        <Trash size={18} weight="duotone" className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className={headerPortalTarget
            ? TITLEBAR_TITLE_CLASS
            : 'truncate text-[15px] font-semibold leading-tight text-foreground'}>
            {t('todo:trash.title')}
          </h2>
          <p className="hidden truncate text-sm text-muted-foreground md:block">
            {t('todo:trash.description')}
          </p>
        </div>
      </div>
      <TrashEmptyAllButton className={cn('shrink-0', headerPortalTarget && `pointer-events-auto ${TITLEBAR_CONTROL_CLASS}`)} />
    </>
  );

  return (
    <div
      ref={workspaceRef}
      className={cn(
        'flex h-full min-w-0 flex-1 flex-col bg-[color:var(--surface-root,var(--background))]',
        className,
      )}
    >
      {headerPortalTarget ? (
        createPortal(
          <div className="pointer-events-none flex h-full min-w-0 items-center justify-between gap-3 px-2">
            {headerClusters}
          </div>,
          headerPortalTarget,
        )
      ) : (
        <header className="study-shell-toolbar flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
          {headerClusters}
        </header>
      )}

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

      {/* 底部安全区由 MobileDetailOverlay 容器统一兜底，此处不再重复叠加 */}
      <div className="flex flex-shrink-0 items-center justify-end px-4 py-2">
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
