import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Archive, ArrowSquareOut, Check, PencilSimple, PushPin, Trash } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  AppMenu, AppMenuContent, AppMenuGroup, AppMenuItem, AppMenuSeparator, AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { WorkbenchSidebarRow as SidebarRow } from '@/features/workbench/components/sidebar';
import { beginSessionHoverPrefetch, cancelSessionHoverPrefetch } from '@/features/chat/core/session/sessionPrefetch';

export interface SessionRowActions {
  open: (sessionId: string) => void;
  setMenuOpen: (sessionId: string, open: boolean) => void;
  startRename: (sessionId: string) => void;
  changeRenameTitle: (title: string) => void;
  saveRename: (sessionId: string) => void;
  cancelRename: () => void;
  togglePin: (sessionId: string) => void;
  archive: (sessionId: string) => void;
  setArchiveConfirmation: (sessionId: string | null) => void;
  clearArchiveConfirmation: (sessionId: string) => void;
  beginDeleteConfirmation: (sessionId: string) => void;
  resetDeleteConfirmation: () => void;
  delete: (sessionId: string) => void;
  dragStart: (event: React.DragEvent<HTMLButtonElement>, sessionId: string) => void;
  dragEnd: () => void;
}

/**
 * Event-only facade: row props keep one identity while handlers read the latest
 * committed sidebar state. Unlike a memo comparator that ignores callbacks,
 * this also keeps archive/delete selection and rename drafts current.
 */
export function useStableSessionRowActions(actions: SessionRowActions): SessionRowActions {
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  return useMemo<SessionRowActions>(() => ({
    open: (id) => actionsRef.current.open(id),
    setMenuOpen: (id, open) => actionsRef.current.setMenuOpen(id, open),
    startRename: (id) => actionsRef.current.startRename(id),
    changeRenameTitle: (title) => actionsRef.current.changeRenameTitle(title),
    saveRename: (id) => actionsRef.current.saveRename(id),
    cancelRename: () => actionsRef.current.cancelRename(),
    togglePin: (id) => actionsRef.current.togglePin(id),
    archive: (id) => actionsRef.current.archive(id),
    setArchiveConfirmation: (id) => actionsRef.current.setArchiveConfirmation(id),
    clearArchiveConfirmation: (id) => actionsRef.current.clearArchiveConfirmation(id),
    beginDeleteConfirmation: (id) => actionsRef.current.beginDeleteConfirmation(id),
    resetDeleteConfirmation: () => actionsRef.current.resetDeleteConfirmation(),
    delete: (id) => actionsRef.current.delete(id),
    dragStart: (event, id) => actionsRef.current.dragStart(event, id),
    dragEnd: () => actionsRef.current.dragEnd(),
  }), []);
}

export interface SessionRowProps {
  sessionId: string;
  title: string;
  updatedAt: string;
  pinned: boolean;
  collapsed: boolean;
  isActive: boolean;
  isSessionStreaming: boolean;
  hasBlockingInteraction: boolean;
  hasUnreadAssistantReply: boolean;
  isConfirmingArchive: boolean;
  isConfirmingDelete: boolean;
  isMenuOpen: boolean;
  isDragged: boolean;
  isEditing: boolean;
  isRenaming: boolean;
  editingTitle: string;
  renameError: string | null;
  canOpenInNewWindow: boolean;
  nowMinute: number;
  actions: SessionRowActions;
}

function HoverScrollSidebarLabel({ text }: { text: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    const textElement = textRef.current;
    if (!container || !textElement) return;

    const measureOverflow = () => {
      setOverflowDistance(Math.max(0, textElement.scrollWidth - container.clientWidth));
    };

    measureOverflow();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(container);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [text]);

  const shouldScroll = overflowDistance > 0;
  const scrollDuration = Math.min(10, Math.max(3, overflowDistance / 32 + 2));
  const isScrolling = shouldScroll && isHovered && !prefersReducedMotion;
  const edgeFadeStyle = shouldScroll
    ? {
      maskMode: 'alpha' as const,
      maskImage: isScrolling
        ? 'linear-gradient(to right, transparent 0%, #fff 10px, #fff calc(100% - 10px), transparent 100%)'
        : 'linear-gradient(to right, #fff 0%, #fff 90%, transparent 100%)',
      WebkitMaskImage: isScrolling
        ? 'linear-gradient(to right, transparent 0%, #fff 10px, #fff calc(100% - 10px), transparent 100%)'
        : 'linear-gradient(to right, #fff 0%, #fff 90%, transparent 100%)',
    }
    : undefined;

  return (
    <span
      ref={containerRef}
      className="desktop-shell-sidebar-row-title block min-w-0 flex-1 overflow-hidden whitespace-nowrap"
      style={edgeFadeStyle}
      title={text}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <motion.span
        ref={textRef}
        className="inline-block w-max min-w-full whitespace-nowrap"
        animate={{ x: isScrolling ? -overflowDistance : 0 }}
        transition={isScrolling
          ? {
            duration: scrollDuration,
            ease: 'linear',
            repeat: Infinity,
            repeatType: 'reverse',
            repeatDelay: 0.6,
          }
          : { duration: 0.15, ease: 'easeOut' }}
      >
        {text}
      </motion.span>
    </span>
  );
}

const SIDEBAR_STREAMING_RING_RADIUS = 6.75;
const SIDEBAR_STREAMING_RING_CIRCUMFERENCE = 2 * Math.PI * SIDEBAR_STREAMING_RING_RADIUS;
const SIDEBAR_STREAMING_RING_DASH = SIDEBAR_STREAMING_RING_CIRCUMFERENCE * 0.34;
const SIDEBAR_STREAMING_RING_GAP = SIDEBAR_STREAMING_RING_CIRCUMFERENCE - SIDEBAR_STREAMING_RING_DASH;
const SIDEBAR_STREAMING_RING_TRACK = 'color-mix(in oklab, var(--shell-navigation-foreground) 14%, transparent)';
const SIDEBAR_STREAMING_RING_FOREGROUND = 'var(--shell-navigation-foreground)';

function SidebarStreamingIndicator() {
  return (
    <span
      data-testid="sidebar-streaming-indicator"
      className="inline-flex h-3.5 w-3.5 items-center justify-center"
      aria-hidden="true"
    >
      <svg
        className="h-3.5 w-3.5 animate-[spin_1.1s_linear_infinite] rounded-full"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle
          cx="8"
          cy="8"
          r={SIDEBAR_STREAMING_RING_RADIUS}
          stroke={SIDEBAR_STREAMING_RING_TRACK}
          strokeWidth="2.5"
        />
        <circle
          cx="8"
          cy="8"
          r={SIDEBAR_STREAMING_RING_RADIUS}
          stroke={SIDEBAR_STREAMING_RING_FOREGROUND}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${SIDEBAR_STREAMING_RING_DASH} ${SIDEBAR_STREAMING_RING_GAP}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
    </span>
  );
}

function SidebarBlockingContinueBadge({ label }: { label: string }) {
  return (
    <span
      data-testid="sidebar-blocking-indicator"
      className="inline-flex min-h-5 items-center rounded-full border border-[color:color-mix(in_oklab,var(--shell-navigation-foreground)_16%,transparent)] bg-[color:color-mix(in_oklab,var(--shell-navigation-foreground)_8%,transparent)] px-1.5 text-[10px] font-medium leading-none text-[color:var(--shell-navigation-foreground)]"
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

function SidebarUnreadReplyDot() {
  return (
    <span
      data-testid="sidebar-unread-indicator"
      className="w-4 h-4 inline-flex items-center justify-center"
      aria-hidden="true"
    >
      <span className="h-2 w-2 rounded-full bg-[hsl(var(--ring))]" />
    </span>
  );
}

/** Only per-row primitives and stable event actions cross the memo boundary. */
export const SessionRow = React.memo(function SessionRow({
  sessionId, title, updatedAt, pinned, collapsed, isActive,
  isSessionStreaming, hasBlockingInteraction, hasUnreadAssistantReply,
  isConfirmingArchive, isConfirmingDelete, isMenuOpen, isDragged,
  isEditing, isRenaming, editingTitle, renameError, canOpenInNewWindow,
  nowMinute, actions,
}: SessionRowProps) {
  // Language changes should update every row; parent t/callback identity changes should not.
  const { t } = useTranslation(['sidebar', 'common', 'chatV2']);
  const prefersReducedMotion = useReducedMotion();
  const sessionTitle = title || t('chatV2:page.untitled');
  const blockingContinueLabel = t('chatV2:tool_limit.continue');
  const relativeTime = (() => {
    const ts = new Date(updatedAt).getTime();
    const diffMs = nowMinute * 60_000 - ts;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    const diffWeeks = Math.floor(diffDays / 7);
    if (diffMins < 1) return t('common:time.now');
    if (diffMins < 60) return t('common:time.minutes_ago', { count: diffMins });
    if (diffHours < 24) return t('common:time.hours_ago', { count: diffHours });
    if (diffDays < 7) return t('common:time.days_ago', { count: diffDays });
    if (diffWeeks < 5) return t('common:time.relative.weeks_ago', { count: diffWeeks });
    return new Date(ts).toLocaleDateString();
  })();

  // 行内重命名（替代原 DsDialog 模态）：Enter 保存 / Esc 取消 / 失焦保存
  if (!collapsed && isEditing) {
    return (
      <motion.div
        key={sessionId}
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        className="relative px-0.5 py-0.5"
      >
        <Input
          type="text"
          value={editingTitle}
          placeholder={t('chatV2:page.untitled')}
          aria-label={t('sidebar:rename.label')}
          autoFocus
          disabled={isRenaming}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            actions.changeRenameTitle(event.target.value);
          }}
          onKeyDown={(event) => {
            // IME 安全：中文输入法组合期间的 Enter/Escape 只作用于候选词
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!isRenaming) void actions.saveRename(sessionId);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              actions.cancelRename();
            }
          }}
          onBlur={() => {
            if (!isRenaming) void actions.saveRename(sessionId);
          }}
          className="h-7 w-full rounded-[10px] border-[color:var(--ring)]/45 bg-[color:var(--surface-elevated)] px-2 text-[13px] leading-none focus-visible:ring-1 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-[16px]"
        />
        {renameError ? (
          <p className="mt-1 px-1 text-[11px] leading-tight text-destructive" role="alert">
            {renameError}
          </p>
        ) : null}
      </motion.div>
    );
  }

  return (
    // 进出场（transitions-dev 观感）：新建 fade+4px 上升，归档/删除 fade+轻缩放；
    // 不使用行级 layout 测量；hover 后 20ms 触发会话预取（见 sessionPrefetch.ts）
    <motion.div
      key={sessionId}
      initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.15, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'group/thread-row relative',
        isDragged && 'opacity-55'
      )}
      onMouseEnter={() => {
        beginSessionHoverPrefetch(sessionId);
      }}
      onMouseLeave={() => {
        cancelSessionHoverPrefetch(sessionId);
        actions.clearArchiveConfirmation(sessionId);
      }}
    >
      <AppMenu
        mode="context"
        className="flex w-full"
        open={isMenuOpen}
        onOpenChange={(open) => {
          actions.setMenuOpen(sessionId, open);
        }}
      >
        <AppMenuTrigger asChild>
          <SidebarRow
            rowType="thread"
            onClick={() => actions.open(sessionId)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            draggable={!collapsed}
            onDragStart={(event) => actions.dragStart(event, sessionId)}
            onDragEnd={actions.dragEnd}
            aria-label={sessionTitle}
            aria-current={isActive ? 'page' : undefined}
            tabIndex={collapsed ? -1 : undefined}
            isActive={isActive}
            hideLeadingSlot={pinned}
            className={cn(
              // coarse 下行高容纳 44px 操作钮；右侧为 44+4+44px 操作簇留位，
              // 避免常显按钮跨行命中或盖住会话标题。
              '[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!pr-[4.25rem]',
              pinned && '!pl-3',
            )}
            rightSlot={isSessionStreaming || hasBlockingInteraction || hasUnreadAssistantReply ? (
              // 与时间戳同一让位模式：hover/focus 操作簇淡入时指示器淡出，
              // 避免置顶按钮压住圆圈指示器；opacity-0 保留占位，无布局位移。
              <span className="inline-flex items-center transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0">
                {isSessionStreaming ? (
                  <SidebarStreamingIndicator />
                ) : hasBlockingInteraction ? (
                  <SidebarBlockingContinueBadge label={blockingContinueLabel} />
                ) : (
                  <SidebarUnreadReplyDot />
                )}
              </span>
            ) : (
              <span className="ml-1 shrink-0 text-[11px] font-normal tabular-nums text-[color:var(--shell-navigation-muted)] group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0">
                {/* 触屏（coarse pointer）没有 hover：操作簇在所有行常显，时间戳同步让位 */}
                <span className={cn(pinned && 'mr-12 inline-block', '[@media(pointer:coarse)]:opacity-0')}>{relativeTime}</span>
              </span>
            )}
          >
            <HoverScrollSidebarLabel text={sessionTitle} />
          </SidebarRow>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={180}>
          <AppMenuGroup>
            {/* 在新窗口打开：chat-session multi 实例（仅 workbench 模式；legacy 隐藏） */}
            {canOpenInNewWindow && (
              <AppMenuItem
                icon={<ArrowSquareOut size={16} />}
                onClick={() => {
                  actions.setMenuOpen(sessionId, false);
                  // 动态引入，避免把 workbench chat 注册链拽进 legacy 首包
                  void import('@/features/workbench/apps/chat/newSession')
                    .then(({ openChatSessionInNewWindow }) => {
                      openChatSessionInNewWindow(sessionId);
                    })
                    .catch((error) => {
                      console.warn('[ModernSidebar] open session in new window failed:', error);
                    });
                }}
              >
                {t('chatV2:page.openInNewWindow')}
              </AppMenuItem>
            )}
            <AppMenuItem
              icon={<PencilSimple size={16} />}
              onClick={() => {
                actions.startRename(sessionId);
              }}
            >
              {t('sidebar:actions.rename_session')}
            </AppMenuItem>
            <AppMenuItem
              icon={<PushPin size={16} />}
              onClick={() => {
                actions.setMenuOpen(sessionId, false);
                void actions.togglePin(sessionId);
              }}
            >
              {pinned ? t('chatV2:page.unpinSession') : t('chatV2:page.pinSession')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Archive size={16} />}
              onClick={() => {
                actions.setMenuOpen(sessionId, false);
                void actions.archive(sessionId);
              }}
            >
              {t('chatV2:page.archiveSession')}
            </AppMenuItem>
            <AppMenuSeparator />
            <AppMenuItem
              icon={<Trash size={16} />}
              destructive
              onClick={() => actions.beginDeleteConfirmation(sessionId)}
            >
              {t('sidebar:actions.delete_session')}
            </AppMenuItem>
          </AppMenuGroup>
        </AppMenuContent>
      </AppMenu>

      {/* 永久删除的行内二次确认（无模态；5s 未操作自动收回） */}
      {!collapsed && isConfirmingDelete && (
        <div className="mt-0.5 flex items-center justify-between gap-2 rounded-[10px] border border-destructive/25 bg-destructive/10 py-1.5 pl-2 pr-1">
          <span className="min-w-0 truncate text-[11px] leading-none text-destructive">
            {t('sidebar:delete.confirm_hint')}
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            <DsButton
              variant="ghost"
              size="sm"
              className="!h-6 !px-2 text-[11px] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              onClick={actions.resetDeleteConfirmation}
            >
              {t('common:cancel')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              className="!h-6 !px-2 text-[11px] text-destructive hover:bg-destructive/15 hover:text-destructive [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              onClick={() => void actions.delete(sessionId)}
            >
              {t('common:delete')}
            </DsButton>
          </span>
        </div>
      )}

      {/* 行内快捷操作：置顶与归档组成右侧操作簇，细指针 hover 或 focus 时渐显；
          触屏（coarse pointer）没有 hover，所有行常显保证可达——
          仅活动行常显会让非活动会话在 iPad 上无法置顶/归档。 */}
      {!collapsed && (
        <div
          className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100"
        >
          {/* eslint-disable-next-line ds-components/no-native-button */}
          <button
            type="button"
            data-testid="recent-session-pin-icon"
            aria-label={pinned ? t('sidebar:aria.unpin_session') : t('sidebar:aria.pin_session')}
            className={cn(
              'flex size-5 shrink-0 appearance-none items-center justify-center rounded-md border-0 !p-0 text-[color:var(--shell-navigation-muted)] transition-colors hover:text-[color:var(--shell-navigation-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11',
              pinned && 'text-[color:var(--shell-navigation-foreground)]'
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              actions.setArchiveConfirmation(null);
              void actions.togglePin(sessionId);
            }}
          >
            <PushPin size={14} weight={pinned ? 'fill' : 'regular'} />
          </button>
          {!collapsed && !isSessionStreaming && !hasBlockingInteraction && !hasUnreadAssistantReply && (
            <CommonTooltip content={isConfirmingArchive ? t('sidebar:aria.confirm_archive_session') : t('sidebar:aria.archive_session')} position="right">
              {/* eslint-disable-next-line ds-components/no-native-button */}
              <button
                type="button"
                aria-label={isConfirmingArchive ? t('sidebar:aria.confirm_archive_session') : t('sidebar:aria.archive_session')}
                className={cn(
                  'flex size-5 shrink-0 appearance-none items-center justify-center rounded-md border-0 !p-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11',
                  isConfirmingArchive
                    ? 'bg-destructive/15 text-destructive hover:bg-destructive/20'
                    : 'bg-transparent text-[color:var(--shell-navigation-muted)] hover:text-destructive'
                )}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  actions.setMenuOpen(sessionId, false);
                  if (isConfirmingArchive) {
                    void actions.archive(sessionId);
                    return;
                  }

                  actions.setArchiveConfirmation(sessionId);
                }}
                onBlur={() => {
                  actions.clearArchiveConfirmation(sessionId);
                }}
              >
                <span className="w-3.5 h-3.5 t-icon-swap" data-state={isConfirmingArchive ? 'b' : 'a'}>
                  <span className="w-3.5 h-3.5 t-icon flex items-center justify-center" data-icon="a">
                    <Archive size={14} />
                  </span>
                  <span className="w-3.5 h-3.5 t-icon flex items-center justify-center" data-icon="b">
                    <Check size={14} />
                  </span>
                </span>
              </button>
            </CommonTooltip>
          )}
        </div>
      )}
    </motion.div>
  );
});
