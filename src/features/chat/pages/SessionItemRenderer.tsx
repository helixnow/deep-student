import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PencilSimple, Check, X, CircleNotch, PushPin, PushPinSlash, Archive, DotsThree, Trash, FolderSimple, Folder, Export, FileText, BracketsCurly } from '@phosphor-icons/react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useSwipeGesture } from '@/hooks/mobile/useSwipeGesture';
import { type DraggableProvided, type DraggableStateSnapshot } from '@hello-pangea/dnd';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuSub,
  AppMenuSubContent,
  AppMenuSubTrigger,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/utils/errorUtils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { getSidebarStudyRowClassName } from './sessionSidebarStyles';
import { beginSessionHoverPrefetch, cancelSessionHoverPrefetch } from '../core/session/sessionPrefetch';
import {
  markSessionSidebarIndicatorSeen,
  useSessionSidebarIndicators,
} from '../hooks/useSessionSidebarIndicators';
import { getSessionTitleText } from '../utils/sessionTitle';
import { exportSessionToFile } from '../components/session-browser/sessionExport';
import type { SessionOpenTarget } from '../components/session-browser/SessionBrowser';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { TFunction } from 'i18next';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export type SessionDragState = {
  provided: DraggableProvided;
  snapshot: DraggableStateSnapshot;
};

export interface UseSessionItemRendererDeps {
  editingSessionId: string | null;
  hoveredSessionId: string | null;
  currentSessionId: string | null;
  pendingDeleteSessionId: string | null;
  pendingArchiveSessionId: string | null;
  editingTitle: string;
  renamingSessionId: string | null;
  renameError: string | null;
  groups: SessionGroup[];
  sessions: ChatSession[];
  totalSessionCount: number | null;
  t: TFunction<any, any>;
  resetDeleteConfirmation: () => void;
  setCurrentSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
  setHoveredSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingTitle: React.Dispatch<React.SetStateAction<string>>;
  setPendingDeleteSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingArchiveSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  clearDeleteConfirmTimeout: () => void;
  deleteConfirmTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  startEditSession: (session: ChatSession, e: React.MouseEvent) => void;
  saveSessionTitle: (sessionId: string) => Promise<void>;
  cancelEditSession: () => void;
  moveSessionToGroup: (sessionId: string, groupId?: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  togglePinSession: (sessionId: string, pinned: boolean, metadata?: ChatSession['metadata']) => Promise<void>;
  formatTime: (isoString: string) => string;
  /**
   * B3: 点击会话行切换会话后的回调（移动端用于收起左侧抽屉回到聊天中屏）。
   * 仅由行主体点击触发；行内菜单/滑动操作不触发。
   */
  onSessionActivated?: () => void;
}

export const resolveDragStyle = (
  style: React.CSSProperties | undefined,
  isDragging: boolean
) => (isDragging && style ? { ...style, left: 'auto', top: 'auto' } : style);

// ============================================================================
// P1-12: 会话行左滑操作（触屏）——行内 translateX 露出「置顶/删除」色块按钮。
// 非 Sheet / 非 Portal；useSwipeGesture 自带轴锁定（垂直滚动/页级手势起手即让位），
// 删除走既有的行内二次确认条（requestDeleteConfirmation），不直接执行破坏性操作。
// ============================================================================

/** 单个滑出按钮宽度（px） */
const SWIPE_ACTION_WIDTH = 72;
/** 两个按钮的总宽度 */
const SWIPE_ACTIONS_TOTAL_WIDTH = SWIPE_ACTION_WIDTH * 2;
/** 松手时按位移判定开/关的阈值 */
const SWIPE_OPEN_THRESHOLD = 48;

interface SwipeableSessionRowProps {
  /** 仅触屏启用；false 时直接透传 children，不加包装 DOM */
  enabled: boolean;
  /**
   * 手势临时禁用（重命名编辑中 / dnd 拖拽中）。
   * 与 enabled 分离：DOM 结构保持稳定，避免 dnd 拖拽中途 remount 丢失拖拽节点。
   */
  gestureEnabled?: boolean;
  pinned: boolean;
  pinLabel: string;
  deleteLabel: string;
  onTogglePin: () => void;
  /** 进入行内删除二次确认（非直接删除） */
  onRequestDelete: () => void;
  children: React.ReactNode;
}

const SwipeableSessionRow: React.FC<SwipeableSessionRowProps> = ({
  enabled,
  gestureEnabled = true,
  pinned,
  pinLabel,
  deleteLabel,
  onTogglePin,
  onRequestDelete,
  children,
}) => {
  const [open, setOpen] = useState(false);
  /** 跟手中的实时位移；null 表示不在拖动（吸附到 open/closed 基准位） */
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const baseOffset = open ? -SWIPE_ACTIONS_TOTAL_WIDTH : 0;
  const baseOffsetRef = React.useRef(baseOffset);
  baseOffsetRef.current = baseOffset;

  const gestureActive = enabled && gestureEnabled;

  // 手势加固：useSwipeGesture 的 enabled 只在 touchstart 时检查一次，
  // 起手后 dnd 长按拖拽成立（gestureEnabled 翻 false）时，迟到的跟手回调
  // 仍会到达——在回调侧二次校验并丢弃，同时复位跟手位移与滑开态，
  // 避免「行在 dnd 拖拽镜像下方继续 translateX」的双手势叠加。
  React.useEffect(() => {
    if (gestureActive) return;
    setDragOffset(null);
    setOpen(false);
  }, [gestureActive]);

  const swipe = useSwipeGesture<HTMLDivElement>({
    axis: 'horizontal',
    enabled: gestureActive,
    threshold: SWIPE_OPEN_THRESHOLD,
    onSwipeMove: (dx) => {
      if (!gestureActive) return;
      // 左滑为负；越过全开位置后有 16px 的橡皮筋余量
      const next = Math.max(
        -SWIPE_ACTIONS_TOTAL_WIDTH - 16,
        Math.min(0, baseOffsetRef.current + dx),
      );
      setDragOffset(next);
    },
    onSwipeEnd: ({ delta, isFling, direction }) => {
      setDragOffset(null);
      if (!gestureActive) return;
      const passed = Math.abs(delta) > SWIPE_OPEN_THRESHOLD || isFling;
      if (!passed) return;
      if (direction < 0) setOpen(true);
      else if (direction > 0) setOpen(false);
    },
  });

  // 打开状态下点行外任意位置收起
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 依赖 swipe.ref（稳定引用）而非 swipe 对象：避免拖动中每帧重挂原生监听器
  const swipeRef = swipe.ref;
  const setRefs = React.useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    swipeRef(node);
  }, [swipeRef]);

  if (!enabled) {
    return <>{children}</>;
  }

  const translate = dragOffset ?? baseOffset;
  const revealedWidth = Math.min(-translate, SWIPE_ACTIONS_TOTAL_WIDTH);
  const isDragging = dragOffset !== null;
  const actionButtonClassName =
    'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 overflow-hidden whitespace-nowrap text-[11px] font-medium leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div ref={setRefs} className="relative overflow-hidden rounded-2xl">
      {/* 滑出的操作色块：宽度跟随位移渐进展开 */}
      <div
        className="absolute inset-y-0 right-0 flex items-stretch overflow-hidden rounded-r-2xl"
        style={{ width: revealedWidth }}
        aria-hidden={!open}
      >
        {/* eslint-disable-next-line ds-components/no-native-button -- 左滑色块按钮：全高填充的 iOS 式滑出操作，共享按钮组件的胶囊排版不适配 */}
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          className={cn(actionButtonClassName, 'bg-primary text-primary-foreground')}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
            onTogglePin();
          }}
          aria-label={pinLabel}
        >
          {pinned ? <PushPinSlash size={16} aria-hidden="true" /> : <PushPin size={16} aria-hidden="true" />}
          <span>{pinLabel}</span>
        </button>
        {/* eslint-disable-next-line ds-components/no-native-button -- 左滑色块按钮：同上 */}
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          className={cn(actionButtonClassName, 'bg-destructive text-destructive-foreground')}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
            onRequestDelete();
          }}
          aria-label={deleteLabel}
        >
          <Trash size={16} aria-hidden="true" />
          <span>{deleteLabel}</span>
        </button>
      </div>

      {/* 行内容：跟手位移；打开时首次点按只负责收起，不触发会话切换 */}
      <div
        style={{
          transform: translate !== 0 ? `translateX(${translate}px)` : undefined,
          transition: isDragging ? 'none' : 'transform var(--chat-motion-base, 200ms) var(--chat-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))',
        }}
        className="motion-reduce:!transition-none"
        onClickCapture={open ? (e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        } : undefined}
      >
        {children}
      </div>
    </div>
  );
};

export function useSessionItemRenderer(deps: UseSessionItemRendererDeps) {
  const {
    editingSessionId, currentSessionId, pendingDeleteSessionId,
    editingTitle, renamingSessionId, renameError, groups,
    t, resetDeleteConfirmation, setCurrentSessionId,
    setEditingTitle, setPendingDeleteSessionId, setSessions, setViewMode,
    clearDeleteConfirmTimeout, deleteConfirmTimeoutRef,
    startEditSession, saveSessionTitle, cancelEditSession,
    moveSessionToGroup, deleteSession,
    archiveSession, togglePinSession, formatTime,
    onSessionActivated,
  } = deps;

  // 后台流式 / 未读回复 / 等待继续 指示器（与桌面 ModernSidebar 同一数据源）
  const streamingSessionIds = useSessionSidebarIndicators((state) => state.streamingSessionIds);
  const blockingSessionIds = useSessionSidebarIndicators((state) => state.blockingSessionIds);
  const unreadSessionIds = useSessionSidebarIndicators((state) => state.unreadSessionIds);
  const streamingSessionIdSet = useMemo(() => new Set(streamingSessionIds), [streamingSessionIds]);
  const blockingSessionIdSet = useMemo(() => new Set(blockingSessionIds), [blockingSessionIds]);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);

  // 菜单点「删除」后进入行内二次确认，5s 无操作自动复位
  const requestDeleteConfirmation = useCallback((sessionId: string) => {
    clearDeleteConfirmTimeout();
    setPendingDeleteSessionId(sessionId);
    deleteConfirmTimeoutRef.current = setTimeout(() => {
      setPendingDeleteSessionId(null);
      deleteConfirmTimeoutRef.current = null;
    }, 5000);
  }, [clearDeleteConfirmTimeout, deleteConfirmTimeoutRef, setPendingDeleteSessionId]);

  const groupNameById = useMemo(() => {
    const map = new Map<string, string>();
    groups.forEach((group) => map.set(group.id, group.name));
    return map;
  }, [groups]);

  // 「移动到分组」候选：排除 stale 占位分组（persistStatus 非 active 的“待修复”项）
  const moveTargetGroups = useMemo(
    () => groups.filter((group) => group.persistStatus === 'active'),
    [groups]
  );

  // C-7: 触屏设备无右键/hover，提供常显"…"按钮打开会话操作菜单
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const openSessionMenuFromButton = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const button = e.currentTarget as HTMLElement;
    const rect = button.getBoundingClientRect();
    const clientX = e.clientX || rect.left + rect.width / 2;
    const clientY = e.clientY || rect.top + rect.height / 2;
    // 合成 contextmenu 事件交给 AppMenuTrigger（mode="context"）打开菜单
    button.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    }));
  }, []);

  // 渲染单个会话项 - Notion 风格
  const renderSessionItem = (session: ChatSession, drag?: SessionDragState) => {
    const sessionTitle = getSessionTitleText(session.title, t('page.untitled'));
    const pinned = !!session.metadata?.pinned;
    const groupLabel = session.groupId
      ? (groupNameById.get(session.groupId) ?? t('page.ungrouped', '未分组'))
      : t('page.ungrouped', '未分组');
    const isSessionStreaming = streamingSessionIdSet.has(session.id);
    const hasBlockingInteraction = blockingSessionIdSet.has(session.id);
    const hasUnreadAssistantReply = unreadSessionIdSet.has(session.id);

    // 行内删除二次确认条：替换正常行内容，明确「永久删除」语义（区别于归档）
    if (pendingDeleteSessionId === session.id) {
      return (
        <div
          ref={drag?.provided.innerRef}
          {...drag?.provided.draggableProps}
          {...drag?.provided.dragHandleProps}
          style={resolveDragStyle(drag?.provided.draggableProps.style, !!drag?.snapshot.isDragging)}
          className={getSidebarStudyRowClassName({
            variant: 'session',
            selected: false,
            className: 'items-center gap-2 border-destructive/30 bg-destructive/5',
          })}
          role="alertdialog"
          aria-label={t('page.deleteSessionConfirm', '永久删除该会话？此操作不可恢复')}
        >
          <span className="min-w-0 flex-1 truncate text-ui leading-4 text-destructive">
            {t('page.deleteSessionConfirm', '永久删除该会话？此操作不可恢复')}
          </span>
          {/* 破坏性操作确认按钮：移动/平板保持较大触控目标，桌面 lg 起紧凑 */}
          <div className="flex shrink-0 items-center gap-1">
            <NotionButton
              variant="danger"
              size="sm"
              className="!h-9 lg:!h-7 !px-2 text-[12px]"
              onClick={(e) => {
                e.stopPropagation();
                resetDeleteConfirmation();
                void deleteSession(session.id);
              }}
            >
              <Trash size={13} />
              <span>{t('common:delete', '删除')}</span>
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              className="!h-9 !w-9 lg:!h-7 lg:!w-7"
              aria-label={t('page.cancelEdit')}
              onClick={(e) => {
                e.stopPropagation();
                resetDeleteConfirmation();
              }}
            >
              <X size={13} />
            </NotionButton>
          </div>
        </div>
      );
    }

    return (
      <SwipeableSessionRow
        // 触屏才渲染滑动容器；编辑/拖拽中仅禁手势，DOM 保持稳定（dnd 拖拽不 remount）
        enabled={isTouchPrimary}
        gestureEnabled={editingSessionId !== session.id && !drag?.snapshot.isDragging}
        pinned={pinned}
        pinLabel={pinned ? t('page.unpinSession') : t('page.pinSession')}
        deleteLabel={t('page.deleteSession')}
        onTogglePin={() => { void togglePinSession(session.id, !pinned, session.metadata); }}
        onRequestDelete={() => requestDeleteConfirmation(session.id)}
      >
      <AppMenu mode="context">
        <AppMenuTrigger asChild>
          <div
            ref={drag?.provided.innerRef}
            {...drag?.provided.draggableProps}
            {...drag?.provided.dragHandleProps}
            style={resolveDragStyle(drag?.provided.draggableProps.style, !!drag?.snapshot.isDragging)}
            onClick={() => {
              if (editingSessionId !== session.id) {
                resetDeleteConfirmation();
                markSessionSidebarIndicatorSeen(session.id);
                setCurrentSessionId(session.id);
                // B3: 移动端点会话条目后收起抽屉，直接回到聊天中屏
                onSessionActivated?.();
              }
            }}
            onMouseEnter={() => beginSessionHoverPrefetch(session.id)}
            onMouseLeave={() => cancelSessionHoverPrefetch(session.id)}
            className={getSidebarStudyRowClassName({
              variant: 'session',
              selected: currentSessionId === session.id,
              draggable: !!drag,
              dragging: !!drag?.snapshot.isDragging,
              className: cn(
                editingSessionId === session.id && 'ring-1 ring-primary/60 bg-[var(--sidebar-study-selected)]'
              ),
            })}
          >
      <div className="flex-1 min-w-0 overflow-hidden">
        {editingSessionId === session.id ? (
          <div className="flex flex-col gap-1.5 w-full">
            <Input
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                // IME 安全：中文输入法组合期间的 Enter/Escape 只作用于候选词
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && renamingSessionId !== session.id) {
                  e.preventDefault();
                  saveSessionTitle(session.id);
                } else if (e.key === 'Escape') {
                  cancelEditSession();
                }
              }}
              autoFocus
              disabled={renamingSessionId === session.id}
              className="w-full bg-transparent text-sm px-2 py-1.5 rounded-md border border-primary/60 bg-card/60 shadow-sm ring-1 ring-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground disabled:opacity-60"
              placeholder={t('page.sessionNamePlaceholder')}
            />
            <div className="flex items-center justify-end gap-1.5">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelEditSession();
                }}
                disabled={renamingSessionId === session.id}
                title={t('page.cancelEdit')}
              >
                <X size={14} />
                <span>{t('page.cancelEdit')}</span>
              </NotionButton>
              <NotionButton
                variant="primary"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  saveSessionTitle(session.id);
                }}
                disabled={renamingSessionId === session.id}
                title={t('page.saveSessionName')}
              >
                {renamingSessionId === session.id ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" />
                    <span>{t('page.renameSaving')}</span>
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    <span>{t('page.saveSessionName')}</span>
                  </>
                )}
              </NotionButton>
            </div>
            <div className="flex items-center justify-between text-[11px] leading-none">
              <span className="text-muted-foreground/80">
                {t('page.renameShortcutHint')}
              </span>
              {renameError && editingSessionId === session.id && (
                <span className="text-destructive">
                  {renameError}
                </span>
              )}
            </div>
          </div>
        ) : (
          pinned ? (
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex min-w-0 items-center gap-2 text-[16px] font-normal leading-5 text-foreground/90">
                <PushPin size={12} weight="fill" className="h-3 w-3 shrink-0 text-[color:var(--sidebar-muted)]" />
                <span className="min-w-0 flex-1 truncate">{sessionTitle}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-ui font-normal leading-4 text-muted-foreground">
                <span className="truncate">{groupLabel}</span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 tabular-nums">{formatTime(session.updatedAt)}</span>
              </div>
            </div>
          ) : (
            <div className={cn(
              'min-w-0 flex-1 text-[16px] font-normal leading-5 transition-colors',
              currentSessionId === session.id
                ? 'line-clamp-1 break-words text-foreground'
                : 'truncate text-foreground/88'
            )}>
                {sessionTitle}
            </div>
          )
        )}
      </div>
      {editingSessionId !== session.id && (!pinned || isTouchPrimary || isSessionStreaming || hasBlockingInteraction || hasUnreadAssistantReply) && (
        <div className="ml-2 flex min-h-6 shrink-0 items-center justify-end gap-1 transition-opacity duration-150 opacity-100">
          {/* 后台状态优先于时间戳：流式 > 等待继续 > 未读 */}
          {isSessionStreaming ? (
            <span data-testid="mobile-sidebar-streaming-indicator" className="inline-flex h-4 w-4 items-center justify-center" aria-label={t('messageList.waiting', '正在思考...')}>
              <CircleNotch size={14} className="animate-spin text-muted-foreground" aria-hidden="true" />
            </span>
          ) : hasBlockingInteraction ? (
            <span
              data-testid="mobile-sidebar-blocking-indicator"
              className="inline-flex min-h-5 items-center rounded-full border border-foreground/15 bg-foreground/[0.06] px-1.5 text-2xs font-medium leading-none text-foreground/80"
            >
              {t('tool_limit.continue', '继续执行')}
            </span>
          ) : hasUnreadAssistantReply ? (
            <span data-testid="mobile-sidebar-unread-indicator" className="inline-flex h-4 w-4 items-center justify-center" aria-hidden="true">
              <span className="h-2 w-2 rounded-full bg-[hsl(var(--ring))]" />
            </span>
          ) : !pinned && (
            <span className="text-ui tabular-nums text-muted-foreground/80">
              {formatTime(session.updatedAt)}
            </span>
          )}
          {isTouchPrimary && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              // 视觉 36px、命中区 44px（before 伪元素外扩，满足移动端触控目标）
              className="relative !h-9 !w-9 !p-1.5 before:absolute before:-inset-1 before:content-['']"
              onClick={openSessionMenuFromButton}
              aria-label={t('page.sessionActions', '会话操作')}
            >
              <DotsThree size={18} className="text-muted-foreground/70" />
            </NotionButton>
          )}
        </div>
      )}
          </div>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={200}>
          <AppMenuGroup>
            <AppMenuItem
              icon={<PencilSimple size={16} />}
              onClick={() => startEditSession(session, { stopPropagation() {} } as React.MouseEvent)}
            >
              {t('page.renameSession')}
            </AppMenuItem>
            <AppMenuItem
              icon={<PushPin size={16} />}
              onClick={() => togglePinSession(session.id, !pinned, session.metadata)}
            >
              {pinned ? t('page.unpinSession') : t('page.pinSession')}
            </AppMenuItem>
            {moveTargetGroups.length > 0 && (
              <AppMenuSub>
                <AppMenuSubTrigger icon={<FolderSimple size={16} />}>
                  {t('page.moveToGroup', '移动到分组')}
                </AppMenuSubTrigger>
                <AppMenuSubContent>
                  {moveTargetGroups.map((group) => (
                    <AppMenuItem
                      key={group.id}
                      icon={<Folder size={16} />}
                      checked={session.groupId === group.id}
                      onClick={() => {
                        if (session.groupId !== group.id) {
                          void moveSessionToGroup(session.id, group.id);
                        }
                      }}
                    >
                      {group.name}
                    </AppMenuItem>
                  ))}
                  <AppMenuSeparator />
                  <AppMenuItem
                    icon={<FolderSimple size={16} />}
                    checked={!session.groupId}
                    onClick={() => {
                      if (session.groupId) {
                        void moveSessionToGroup(session.id, undefined);
                      }
                    }}
                  >
                    {t('page.ungrouped', '未分组')}
                  </AppMenuItem>
                </AppMenuSubContent>
              </AppMenuSub>
            )}
            <AppMenuSub>
              <AppMenuSubTrigger icon={<Export size={16} />}>
                {t('page.exportSession', '导出会话')}
              </AppMenuSubTrigger>
              <AppMenuSubContent>
                <AppMenuItem
                  icon={<FileText size={16} />}
                  onClick={() => {
                    void exportSessionToFile({ sessionId: session.id, title: sessionTitle, format: 'markdown' });
                  }}
                >
                  Markdown
                </AppMenuItem>
                <AppMenuItem
                  icon={<BracketsCurly size={16} />}
                  onClick={() => {
                    void exportSessionToFile({ sessionId: session.id, title: sessionTitle, format: 'json' });
                  }}
                >
                  JSON
                </AppMenuItem>
              </AppMenuSubContent>
            </AppMenuSub>
            <AppMenuItem
              icon={<Archive size={16} />}
              onClick={() => archiveSession(session.id)}
            >
              {t('page.archiveSession')}
            </AppMenuItem>
            <AppMenuSeparator />
            <AppMenuItem
              icon={<Trash size={16} />}
              destructive
              onClick={() => requestDeleteConfirmation(session.id)}
            >
              {t('page.deleteSession')}
            </AppMenuItem>
          </AppMenuGroup>
        </AppMenuContent>
      </AppMenu>
      </SwipeableSessionRow>
    );
  };

  // 处理从浏览器视图选择会话（默认回到侧栏聊天视图）
  const handleBrowserSelectSession = useCallback((sessionId: string, target: SessionOpenTarget = 'sidebar') => {
    setCurrentSessionId(sessionId);
    setViewMode(target);
  }, [setCurrentSessionId, setViewMode]);

  // 处理从浏览器视图重命名会话
  const handleBrowserRenameSession = useCallback(async (sessionId: string, newTitle: string) => {
    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { title: newTitle },
      });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
    } catch (error) {
      console.error('[ChatV2Page] Failed to rename session:', getErrorMessage(error));
    }
  }, [setSessions]);

  return {
    renderSessionItem,
    handleBrowserSelectSession,
    handleBrowserRenameSession,
  };
}
