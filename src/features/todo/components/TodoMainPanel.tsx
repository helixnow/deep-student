/**
 * TodoMainPanel - 待办项主面板
 *
 * 设计原则：扁平工作区，避免"盒中盒"嵌套。
 * - 顶部 study-shell-toolbar 承载标题/搜索/排序/优先级筛选
 * - 中部直接平铺快速添加栏 + 列表项（或空状态）；大列表虚拟化
 * - 右侧详情抽屉（桌面端）或全屏覆盖（移动端）
 * - 底部嵌入番茄钟面板
 *
 * 键盘：/ 搜索、n 快加、j/k 或 ↑/↓ 移动焦点、Space/x 完成、
 * Enter 打开详情、Delete 删除、Esc 关闭详情/清除焦点。
 * 子组件拆分在 ./main/ 目录（行、详情、四象限、改期菜单等）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  CalendarPlus,
  CaretDown,
  CheckCircle,
  CircleNotch,
  ListChecks,
  MagnifyingGlass,
  SortAscending,
  ArrowRight,
  Brain,
  X,
} from '@phosphor-icons/react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { useTouchFriendlyDndSensors, SHELL_SAFE_AUTO_SCROLL } from '@/hooks/useTouchFriendlyDndSensors';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/shad/Select';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useTodoStore } from '../stores/useTodoStore';
import { PomodoroPanel } from '@/features/pomodoro';
import '../styles/todo-motion.css';
import type { EisenhowerQuadrant, TodoDueBucket, TodoItem, TodoSortBy } from '../types';
import {
  addDays,
  classifyEisenhower,
  formatLocalDate,
  groupItemsByDueBucket,
  localToday,
  sortTodoItems,
} from '../types';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import { useViewStore } from '@/stores/viewStore';
import { useKeyboardInset } from '@/hooks/useKeyboardHeight';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { TodoItemRow, SortableTodoItemRow } from './main/TodoItemRow';
import { TodoRowsList, type TodoRowSpec } from './main/TodoRowsList';
import { TodoItemDetail } from './main/TodoItemDetail';
import { MatrixBoard } from './main/MatrixBoard';
import { TodoQuickAdd } from './main/TodoQuickAdd';
import { PriorityFilterMenu } from './main/PriorityFilterMenu';
import { BulkActionBar } from './main/BulkActionBar';
import { mergeBatchItemsResults, runChunkedBulk } from './main/bulkChunks';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { InlineReveal } from './main/detail/InlineReveal';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

// formatDueDateLabel 的实现移到 main/dueDateLabel.ts（行/chip/quick add 共用）；
// 这里保持导出位置不变（tests/vitest/todo/formatDueDateLabel.test.ts 从本模块导入）
export { formatDueDateLabel } from './main/dueDateLabel';

// ============================================================================
// MobileDetailOverlay — 移动端子屏全屏覆盖层（详情/回收站/番茄设置等共用）
// 滑入/滑出过渡 + Android 系统返回键关闭（BACK_PRIORITY.view：
// 叠加在其上的确认对话框等 overlay 层先于子屏被返回键关闭）
// 左边缘（24px）右滑返回：translateX 跟手，松手超过 1/3 宽度即关闭
// ============================================================================

const MOBILE_DETAIL_EXIT_MS = 200;
/** 左边缘触发返回手势的宽度 */
const OVERLAY_EDGE_WIDTH = 24;
/** 手势轴锁定阈值：位移超过该值且大于另一轴位移才接管 */
const OVERLAY_AXIS_LOCK_PX = 10;

export const MobileDetailOverlay: React.FC<{
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ open, onClose, children }) => {
  const [visible, setVisible] = useState(open);
  const [entered, setEntered] = useState(false);
  // 键盘避让（G3/残留#4）：iOS overlay 键盘下布局视口不变，聚焦低位输入框
  // （备注/提醒等）会被键盘遮住——用实时 inset 收缩内容区，让内部滚动容器
  // 能把焦点滚到可视区。Android adjustResize 下 inset≈0，无双重抬升。
  // （订阅该 hook 同时保证 useKeyboardHeight 单例开始向 root 写 --keyboard-inset）
  const keyboardInset = useKeyboardInset();
  // 退场动画期间 children 已变 null，缓存最后一帧内容避免闪空
  const lastChildrenRef = useRef<React.ReactNode>(children);
  if (open) {
    lastChildrenRef.current = children;
  }

  useEffect(() => {
    if (open) {
      setVisible(true);
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    const timer = window.setTimeout(() => setVisible(false), MOBILE_DETAIL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.view);
  }, [open]);

  // ===== 左边缘右滑返回（触屏；pointer events + 轴锁定，内联实现） =====
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [edgeDragX, setEdgeDragX] = useState(0);
  const edgeDragXRef = useRef(0);
  const edgeGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    locked: boolean | 'rejected';
  }>({ pointerId: -1, startX: 0, startY: 0, locked: false });

  const setEdgeDrag = useCallback((x: number) => {
    edgeDragXRef.current = x;
    setEdgeDragX(x);
  }, []);

  useEffect(() => {
    if (!open) setEdgeDrag(0);
  }, [open, setEdgeDrag]);

  // 子屏全屏期间隔断页级三屏手势：MobileSlidingLayout 通过 touchstart/mousedown
  // 冒泡到布局容器启动手势，这里在子屏层截断冒泡，避免详情覆盖层上的滑动
  // 同时把下层侧栏拖出来（stopPropagation 不影响子屏内的滚动与点击）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !visible) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener('touchstart', stop, { passive: true });
    el.addEventListener('mousedown', stop);
    return () => {
      el.removeEventListener('touchstart', stop);
      el.removeEventListener('mousedown', stop);
    };
  }, [visible]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!open || e.pointerType === 'mouse') return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || e.clientX - rect.left > OVERLAY_EDGE_WIDTH) return;
    edgeGestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      locked: false,
    };
  }, [open]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const g = edgeGestureRef.current;
    if (g.pointerId !== e.pointerId || g.locked === 'rejected') return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.locked !== true) {
      if (Math.abs(dy) > OVERLAY_AXIS_LOCK_PX && Math.abs(dy) > Math.abs(dx)) {
        g.locked = 'rejected';
        return;
      }
      if (dx > OVERLAY_AXIS_LOCK_PX && dx > Math.abs(dy)) {
        g.locked = true;
        containerRef.current?.setPointerCapture(e.pointerId);
      } else {
        return;
      }
    }
    setEdgeDrag(Math.max(0, dx));
  }, [setEdgeDrag]);

  const handlePointerEnd = useCallback((e: React.PointerEvent) => {
    const g = edgeGestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    const wasLocked = g.locked === true;
    edgeGestureRef.current.pointerId = -1;
    if (!wasLocked) return;
    const width = containerRef.current?.offsetWidth || window.innerWidth;
    const shouldClose = e.type !== 'pointercancel' && edgeDragXRef.current > width / 3;
    setEdgeDrag(0);
    if (shouldClose) onCloseRef.current();
  }, [setEdgeDrag]);

  if (!visible) return null;

  return (
    <div
      ref={containerRef}
      data-no-screen-swipe
      className={cn(
        'absolute inset-0 z-40 flex bg-[color:var(--surface-root)]',
        'transition-transform duration-200 ease-out motion-reduce:transition-none',
        entered && open ? 'translate-x-0' : 'translate-x-full',
      )}
      style={{
        touchAction: 'pan-y',
        // 键盘弹出时收缩内容区（padding 变化无需过渡：键盘弹出本身就是瞬时事件）
        paddingBottom: keyboardInset > 0 ? keyboardInset : undefined,
        ...(edgeDragX > 0
          ? { transform: `translateX(${edgeDragX}px)`, transition: 'none' as const }
          : null),
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      {open ? children : lastChildrenRef.current}
    </div>
  );
};

// ============================================================================
// ReviewLinkCard — 复习计划联动卡（今天视图顶部，仅当有到期复习时显示）
// ============================================================================

const ReviewLinkCard: React.FC = () => {
  const { t } = useTranslation(['todo']);
  const stats = useReviewPlanStore((s) => s.stats);
  const loadStats = useReviewPlanStore((s) => s.loadStats);

  useEffect(() => {
    void loadStats(undefined);
  }, [loadStats]);

  const dueToday = stats?.due_today ?? 0;
  const overdue = stats?.overdue_count ?? 0;
  const total = dueToday + overdue;
  if (total <= 0) return null;

  return (
    <button
      onClick={() => {
        dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'learning-hub' });
      }}
      className={cn(
        'group mx-4 mt-3 flex items-center gap-3 rounded-[var(--radius-shell-control)] border border-border/40 px-3 py-2.5 text-left transition-colors duration-150 sm:mx-6',
        'hover:border-border hover:bg-[color:var(--interactive-hover)]',
      )}
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[color:hsl(var(--info))]/10 text-[color:hsl(var(--info))]">
        <Brain size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-foreground">
          {t('todo:reviewLink.title', { count: total })}
        </span>
        <span className="block text-xs text-muted-foreground">
          {overdue > 0
            ? t('todo:reviewLink.withOverdue', { overdue })
            : t('todo:reviewLink.subtitle')}
        </span>
      </span>
      <span className="flex flex-shrink-0 items-center gap-0.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
        {t('todo:reviewLink.action')}
        <ArrowRight size={12} />
      </span>
    </button>
  );
};

// ============================================================================
// TodoMainPanel
// ============================================================================

export type PomodoroSubView = 'settings' | 'stats';

interface TodoMainPanelProps {
  /**
   * 移动端：番茄钟设置/统计以 inline 子屏形式打开（由 TodoContentView 承载，
   * 联动统一顶栏返回箭头与 Android 返回键）。未提供时番茄钟按钮走桌面锚定弹层。
   */
  onOpenPomodoroSubView?: (view: PomodoroSubView) => void;
}

export const TodoMainPanel: React.FC<TodoMainPanelProps> = ({ onOpenPomodoroSubView }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { isSmallScreen } = useBreakpoint();

  // 细粒度订阅：只在各自切片变化时重渲染（zustand action 引用稳定）
  const items = useTodoStore((s) => s.items);
  const activeListId = useTodoStore((s) => s.activeListId);
  const lists = useTodoStore((s) => s.lists);
  const isLoadingItems = useTodoStore((s) => s.isLoadingItems);
  const filter = useTodoStore((s) => s.filter);
  const selectedItemId = useTodoStore((s) => s.selectedItemId);
  const toggleItem = useTodoStore((s) => s.toggleItem);
  const deleteItem = useTodoStore((s) => s.deleteItem);
  const reorderItems = useTodoStore((s) => s.reorderItems);
  const selectItem = useTodoStore((s) => s.selectItem);
  const updateItem = useTodoStore((s) => s.updateItem);
  const setSearch = useTodoStore((s) => s.setSearch);
  const setShowCompleted = useTodoStore((s) => s.setShowCompleted);
  const setSortBy = useTodoStore((s) => s.setSortBy);

  const activeList = lists.find((l) => l.id === activeListId);
  const selectedItem = items.find((i) => i.id === selectedItemId);

  // 虚拟化滚动容器（CustomScrollArea 的 viewport）
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);

  // 键盘导航焦点行（j/k / ↑↓ 移动；Space/x 完成；Enter 详情；Delete 删除）
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);

  // 窄屏：搜索折叠为图标，点击后在工具栏下方展开内联输入行
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  // 批量多选（Cmd/Ctrl 点选 + Shift 范围选）；非空时工具栏下方出现内联批量操作条
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const lastCheckedIdRef = useRef<string | null>(null);
  const checkedIdsRef = useRef(checkedIds);
  checkedIdsRef.current = checkedIds;

  const clearChecked = useCallback(() => {
    lastCheckedIdRef.current = null;
    setCheckedIds((prev) => (prev.size > 0 ? new Set() : prev));
  }, []);

  // 📱 触屏批量多选模式：触屏无 Cmd/Ctrl/Shift 修饰键，工具栏「选择」开关进入，
  // 进入后行首显示复选框、点行即勾选（不打开详情）。行内左右滑手势暂停避免误触。
  const [checkMode, setCheckMode] = useState(false);
  const exitCheckMode = useCallback(() => {
    setCheckMode(false);
    clearChecked();
  }, [clearChecked]);

  // 多选模式下 Android 返回键 = 退出多选（先于导航返回）
  useEffect(() => {
    if (!checkMode) return;
    return registerBackHandler(() => {
      exitCheckMode();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [checkMode, exitCheckMode]);

  // 分组折叠（upcoming/today 视图的时间段分组）
  const [collapsedBuckets, setCollapsedBuckets] = useState<ReadonlySet<TodoDueBucket>>(new Set());
  const toggleBucketCollapsed = useCallback((bucket: TodoDueBucket) => {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }, []);

  const { filteredItems, pendingCount, completedCount } = useMemo(() => {
    // 计数与列表同口径：搜索/优先级筛选后的当前数据集
    const byPriority = items.filter(
      (item) => !filter.priorityFilter || item.priority === filter.priorityFilter,
    );
    const visible = byPriority.filter(
      (item) =>
        filter.view === 'completed' || filter.showCompleted || item.status !== 'completed',
    );
    return {
      filteredItems: sortTodoItems(visible, filter.sortBy),
      pendingCount: byPriority.filter((i) => i.status === 'pending').length,
      completedCount: byPriority.filter((i) => i.status === 'completed').length,
    };
  }, [items, filter.priorityFilter, filter.showCompleted, filter.view, filter.sortBy]);

  // ===== 'all' 视图：树形展示（顶层 + 子任务缩进），手动排序时支持顶层拖拽 =====
  const isTreeView = filter.view === 'all' && !filter.search.trim();
  const isManualSortView = isTreeView && filter.sortBy === 'manual';

  const { topLevelItems, childrenByParent } = useMemo(() => {
    const childMap = new Map<string, TodoItem[]>();
    const tops: TodoItem[] = [];
    if (!isTreeView) {
      return { topLevelItems: filteredItems, childrenByParent: childMap };
    }
    const visibleIds = new Set(filteredItems.map((i) => i.id));
    for (const item of filteredItems) {
      // 父项不可见（被过滤）时子任务提升为顶层，避免凭空消失
      if (item.parentId && visibleIds.has(item.parentId)) {
        const arr = childMap.get(item.parentId) || [];
        arr.push(item);
        childMap.set(item.parentId, arr);
      } else {
        tops.push(item);
      }
    }
    return { topLevelItems: tops, childrenByParent: childMap };
  }, [filteredItems, isTreeView]);

  // ===== 'upcoming'/'today' 视图：按时间段分组 =====
  // upcoming：逾期/今天/明天/本周/以后；today：逾期置顶 + 今天（SOTA 语义，逾期不会从今天消失）
  const upcomingGroups = useMemo(() => {
    if (filter.view !== 'upcoming' && filter.view !== 'today') return null;
    const groups = groupItemsByDueBucket(filteredItems);
    // today 视图只有逾期/今天两组；只有「今天」一组时无需组头，退回普通列表
    if (filter.view === 'today' && groups.length === 1 && groups[0].bucket === 'today') {
      return null;
    }
    return groups;
  }, [filter.view, filteredItems]);

  // ===== 'matrix' 视图：四象限归类 =====
  const matrixQuadrants = useMemo(() => {
    if (filter.view !== 'matrix') return null;
    const today = localToday();
    const map: Record<EisenhowerQuadrant, TodoItem[]> = {
      urgentImportant: [],
      importantNotUrgent: [],
      urgentNotImportant: [],
      neither: [],
    };
    for (const item of filteredItems) {
      map[classifyEisenhower(item, today)].push(item);
    }
    return map;
  }, [filter.view, filteredItems]);

  // 计算子任务进度（含被 showCompleted 过滤掉的已完成子任务，进度才真实）。
  // 一次 O(n) 预聚合成 Map，替代此前每个父行 O(n) 过滤（大列表 O(n²) 热点）
  const subtaskProgressById = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const item of items) {
      if (!item.parentId) continue;
      let entry = map.get(item.parentId);
      if (!entry) {
        entry = { done: 0, total: 0 };
        map.set(item.parentId, entry);
      }
      entry.total += 1;
      if (item.status === 'completed') entry.done += 1;
    }
    return map;
  }, [items]);

  const subtaskProgressOf = useCallback(
    (parentId: string): { done: number; total: number } | undefined =>
      subtaskProgressById.get(parentId),
    [subtaskProgressById],
  );

  // 树形/平铺分支交给 TodoRowsList（>100 行自动虚拟化）
  const listRows = useMemo<TodoRowSpec[]>(() => {
    if (isTreeView) {
      return topLevelItems.flatMap((item) => [
        { item, subtaskProgress: subtaskProgressOf(item.id) },
        ...(childrenByParent.get(item.id) || []).map((child) => ({ item: child, depth: 1 })),
      ]);
    }
    return filteredItems.map((item) => ({ item }));
  }, [isTreeView, topLevelItems, childrenByParent, filteredItems, subtaskProgressOf]);

  // 键盘导航的可见行顺序（跨所有视图分支统一口径；折叠分组内的行不参与 j/k）
  const visibleRowIds = useMemo(() => {
    if (matrixQuadrants) {
      return (Object.keys(matrixQuadrants) as EisenhowerQuadrant[]).flatMap((q) =>
        matrixQuadrants[q].map((i) => i.id),
      );
    }
    if (upcomingGroups) {
      return upcomingGroups
        .filter((g) => !collapsedBuckets.has(g.bucket))
        .flatMap((g) => g.items.map((i) => i.id));
    }
    return listRows.map((r) => r.item.id);
  }, [matrixQuadrants, upcomingGroups, listRows, collapsedBuckets]);

  const visibleRowIdsRef = useRef<string[]>(visibleRowIds);
  visibleRowIdsRef.current = visibleRowIds;
  const focusedItemIdRef = useRef<string | null>(focusedItemId);
  focusedItemIdRef.current = focusedItemId;

  // 焦点行不在当前可见集合时清除（切换视图/过滤/删除后）
  useEffect(() => {
    if (focusedItemId && !visibleRowIds.includes(focusedItemId)) {
      setFocusedItemId(null);
    }
  }, [visibleRowIds, focusedItemId]);

  // 多选集合同步收敛：已不可见的行（删除/过滤/切视图）移出选择集
  useEffect(() => {
    setCheckedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(visibleRowIds);
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleRowIds]);

  // Cmd/Ctrl 点选切换；Shift 从上一次点选位置做范围并选。
  const handleCheckToggle = useCallback((id: string, opts: { shift: boolean }) => {
    const ids = visibleRowIdsRef.current;
    setCheckedIds((prev) => {
      const next = new Set(prev);
      const anchor = lastCheckedIdRef.current;
      if (opts.shift && anchor && ids.includes(anchor) && ids.includes(id)) {
        const from = ids.indexOf(anchor);
        const to = ids.indexOf(id);
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
          next.add(ids[i]);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    lastCheckedIdRef.current = id;
    // 多选期间同步键盘焦点，j/k 从最近点选位置继续
    setFocusedItemId(id);
  }, []);

  // 焦点行滚动到可见区域（虚拟化分支由 TodoRowsList 内部 scrollToIndex 兜底）
  useEffect(() => {
    if (!focusedItemId) return;
    document
      .querySelector(`[data-agent-entity="todo:${focusedItemId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focusedItemId]);

  // 键盘快捷键（仅 Todo 页面、非输入态生效）
  useEffect(() => {
    const moveFocus = (delta: number) => {
      const ids = visibleRowIdsRef.current;
      if (ids.length === 0) return;
      const current = focusedItemIdRef.current;
      const index = current ? ids.indexOf(current) : -1;
      const next =
        index < 0
          ? delta > 0
            ? 0
            : ids.length - 1
          : Math.min(ids.length - 1, Math.max(0, index + delta));
      setFocusedItemId(ids[next]);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (useViewStore.getState().currentView !== 'todo') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      // 焦点在按钮/菜单/弹层内时不做列表导航（Space/Enter 会双重触发）；
      // 但 / 与 n 这类无冲突入口仍然放行
      const inControl = Boolean(
        target?.closest('button, [role="menu"], [role="dialog"], [role="listbox"]'),
      );
      const isListNavKey = [
        'j', 'k', 'ArrowDown', 'ArrowUp', ' ', 'x', 'Enter', 'Delete', 'Backspace',
      ].includes(e.key);
      if (inControl && isListNavKey) return;
      if (e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-todo-search]')?.focus();
      } else if (e.key === 'n' || e.key === 'N') {
        const quickAdd = document.querySelector<HTMLInputElement>('[data-todo-quick-add]');
        if (quickAdd) {
          e.preventDefault();
          quickAdd.focus();
        }
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveFocus(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(-1);
      } else if ((e.key === ' ' || e.key === 'x') && focusedItemIdRef.current) {
        e.preventDefault();
        void useTodoStore.getState().toggleItem(focusedItemIdRef.current);
      } else if (e.key === 'Enter' && focusedItemIdRef.current) {
        e.preventDefault();
        useTodoStore.getState().selectItem(focusedItemIdRef.current);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && focusedItemIdRef.current) {
        e.preventDefault();
        const id = focusedItemIdRef.current;
        // 删除前把焦点交给相邻行，键盘流不中断（删除本身带撤销 toast）
        const ids = visibleRowIdsRef.current;
        const index = ids.indexOf(id);
        setFocusedItemId(ids[index + 1] ?? ids[index - 1] ?? null);
        void useTodoStore.getState().deleteItem(id);
      } else if (e.key === 'Escape') {
        // 桌面端：Esc 依次退出 多选 → 详情面板 → 键盘焦点行
        const { selectedItemId: selected, selectItem: select } = useTodoStore.getState();
        if (checkedIdsRef.current.size > 0) {
          e.preventDefault();
          clearChecked();
        } else if (selected) {
          e.preventDefault();
          select(null);
        } else if (focusedItemIdRef.current) {
          e.preventDefault();
          setFocusedItemId(null);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [clearChecked]);

  // 触屏友好：TouchSensor 长按 250ms 激活 + 8px 容差，避免竖向滚动被拖拽排序劫持（R2-07）；
  // 与 NotesTabsBar/DndFileTree/FinderFileList 等共用同一传感器范式。桌面 MouseSensor 距离激活，键盘可达。
  const sensors = useTouchFriendlyDndSensors();

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = topLevelItems.map((i) => i.id);
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      const reordered = [...ids];
      reordered.splice(to, 0, ...reordered.splice(from, 1));
      void reorderItems(reordered);
    },
    [topLevelItems, reorderItems],
  );

  // 行内改名（双击标题触发）
  const handleRename = useCallback(
    (id: string, title: string) => {
      void updateItem({ id, title });
    },
    [updateItem],
  );

  // 点击选中行时同步键盘焦点，j/k 从当前位置继续；普通点击同时退出多选
  const handleSelect = useCallback(
    (id: string) => {
      clearChecked();
      setFocusedItemId(id);
      selectItem(id);
    },
    [clearChecked, selectItem],
  );

  // 逾期分组头「全部改到今天」：store 批量改期（每片单事务 + 乐观更新 + 失败回滚 + 静默校准）。
  // 后端单命令上限 500：超限时经 runChunkedBulk 按片顺序调用，聚合各片结果统一 toast/撤销
  const [reschedulingOverdue, setReschedulingOverdue] = useState(false);
  const handleRescheduleOverdueToToday = useCallback(
    async (overdueItems: TodoItem[]) => {
      if (overdueItems.length === 0) return;
      setReschedulingOverdue(true);
      try {
        // 固定「今天」于操作起点：分片顺序执行跨午夜时各片仍改到同一天
        const today = localToday();
        const { results, failed } = await runChunkedBulk(
          overdueItems.map((i) => i.id),
          (chunk) => useTodoStore.getState().bulkRescheduleItems(chunk, today),
        );
        const merged = mergeBatchItemsResults(results);
        if (merged.items.length === 0) {
          // 全部被跳过（如并发删除）也给出反馈；分片失败时 store 已弹错，这里不再叠加
          if (!failed && merged.skippedIds.length > 0) {
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
        // 撤销覆盖聚合后的全部生效项：按原到期日分组批量改回。
        // 正向操作未传 dueTime（= 保留原时间），撤销只需还原日期
        const affectedIds = new Set(merged.items.map((i) => i.id));
        const idsByOriginalDate = new Map<string, string[]>();
        for (const item of overdueItems) {
          if (!affectedIds.has(item.id) || !item.dueDate) continue;
          const group = idsByOriginalDate.get(item.dueDate);
          if (group) group.push(item.id);
          else idsByOriginalDate.set(item.dueDate, [item.id]);
        }
        showGlobalNotification(
          'success',
          t('todo:reschedule.movedToToday', {
            count: merged.items.length,
            defaultValue: '已把 {{count}} 项改到今天',
          }),
          undefined,
          {
            action: {
              label: t('todo:notifications.undo'),
              onClick: () => {
                void (async () => {
                  for (const [date, ids] of idsByOriginalDate) {
                    await runChunkedBulk(ids, (chunk) =>
                      useTodoStore.getState().bulkRescheduleItems(chunk, date),
                    );
                  }
                })();
              },
            },
          },
        );
      } finally {
        setReschedulingOverdue(false);
      }
    },
    [t],
  );

  const viewTitle = (() => {
    switch (filter.view) {
      case 'today':
        return t('todo:views.today');
      case 'upcoming':
        return t('todo:views.upcoming');
      case 'matrix':
        return t('todo:views.matrix');
      case 'overdue':
        return t('todo:views.overdue');
      case 'completed':
        return t('todo:views.completed');
      default:
        return activeList?.title || t('todo:views.inbox');
    }
  })();

  // 空态按视图差异化：清零类视图用庆祝语气。
  const emptyState = (() => {
    if (filter.search.trim()) {
      return {
        icon: MagnifyingGlass,
        title: t('todo:empty.noSearchResults'),
        hint: t('todo:empty.noSearchResultsHint'),
        celebratory: false,
      };
    }
    switch (filter.view) {
      case 'today':
        return {
          icon: CheckCircle,
          title: t('todo:empty.todayClear'),
          hint: t('todo:empty.todayClearHint'),
          celebratory: true,
        };
      case 'overdue':
        return {
          icon: CheckCircle,
          title: t('todo:empty.overdueClear'),
          hint: t('todo:empty.overdueClearHint'),
          celebratory: true,
        };
      case 'upcoming':
        return {
          icon: Calendar,
          title: t('todo:empty.upcomingClear'),
          hint: t('todo:empty.upcomingClearHint'),
          celebratory: false,
        };
      case 'completed':
        return {
          icon: ListChecks,
          title: t('todo:empty.completedEmpty'),
          hint: t('todo:empty.completedEmptyHint'),
          celebratory: false,
        };
      default:
        return {
          icon: ListChecks,
          title: t('todo:empty.noItems'),
          hint: t('todo:empty.hint'),
          celebratory: false,
        };
    }
  })();

  // 今日负荷摘要：未完成任务的预估番茄合计（仅 today 视图、有预估时显示）
  const todayPomodoroLoad = useMemo(() => {
    if (filter.view !== 'today') return 0;
    return items
      .filter((i) => i.status === 'pending')
      .reduce((acc, i) => {
        const remaining = (i.estimatedPomodoros || 0) - (i.completedPomodoros || 0);
        return acc + Math.max(0, remaining);
      }, 0);
  }, [filter.view, items]);

  // 快速添加在所有可编辑视图可用（completed 只读）；智能视图带上合适的默认截止日
  const showQuickAdd = filter.view !== 'completed';
  const quickAddDefaultDueDate = (() => {
    switch (filter.view) {
      case 'today':
      case 'overdue':
        return localToday();
      case 'upcoming':
        return formatLocalDate(addDays(new Date(), 1));
      default:
        return undefined;
    }
  })();

  return (
    // h-full：MobileSlidingLayout 的内容窗格是普通块级容器（非 flex），flex-1 在其中不生效，
    // 高度会塌缩成内容高度，导致移动端详情覆盖层（absolute inset-0）跟着变矮
    <div className="flex h-full min-w-0 flex-1 flex-row overflow-hidden">
      {/* 主列 */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶部工具栏 */}
        <div className="study-shell-toolbar flex flex-shrink-0 flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            {!isSmallScreen && (
              <h2 className="truncate text-[15px] font-semibold text-foreground">
                {viewTitle}
              </h2>
            )}
            <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground/40">
              {pendingCount}&nbsp;{t('todo:stats.pending')}
              {completedCount > 0 && (
                <>
                  <span className="mx-1 text-muted-foreground/30">·</span>
                  {completedCount}&nbsp;{t('todo:stats.completed')}
                </>
              )}
              {todayPomodoroLoad > 0 && (
                <>
                  <span className="mx-1 text-muted-foreground/30">·</span>
                  <span title={t('todo:stats.pomodoroLoadHint')}>
                    {t('todo:stats.pomodoroLoad', { count: todayPomodoroLoad })}
                  </span>
                </>
              )}
            </span>
            {/* 完成进度微条（与番茄目标条同款视觉；完成即清零的视图不显示） */}
            {filter.view !== 'completed' && completedCount > 0 && pendingCount + completedCount > 0 && (
              <span
                className="inline-flex h-1 w-14 flex-shrink-0 self-center overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]"
                title={t('todo:stats.progressTitle', {
                  done: completedCount,
                  total: pendingCount + completedCount,
                })}
              >
                <span
                  className="h-full rounded-full bg-[color:hsl(var(--success))] transition-all duration-500"
                  style={{
                    width: `${Math.round((completedCount / (pendingCount + completedCount)) * 100)}%`,
                  }}
                />
              </span>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            {isSmallScreen ? (
              // 窄屏：搜索折叠为图标（≥44px 触控），点击展开下方内联输入行
              <DsButton
                variant="utility"
                size="icon"
                iconOnly
                onClick={() => setMobileSearchOpen((v) => !v)}
                aria-expanded={mobileSearchOpen}
                aria-label={t('todo:actions.search')}
                title={t('todo:actions.search')}
                className={cn(
                  '!h-8 !w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
                  (mobileSearchOpen || filter.search.trim()) &&
                    '!bg-[color:var(--button-primary-surface)] !text-[color:var(--button-primary-foreground)]',
                )}
              >
                <MagnifyingGlass size={16} />
              </DsButton>
            ) : (
              <div className="relative">
                <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" size={14} />
                <Input
                  type="search"
                  value={filter.search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('todo:actions.search')}
                  data-todo-search
                  className="h-8 w-28 pl-8 pr-3 text-xs sm:w-56"
                />
              </div>
            )}

            <PriorityFilterMenu />

            <Select value={filter.sortBy} onValueChange={(v) => setSortBy(v as TodoSortBy)}>
              <SelectTrigger
                aria-label={t('todo:sort.label')}
                className="!h-8 !min-h-0 !w-auto gap-1 !px-2.5 !py-0 text-xs [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!min-w-[2.75rem]"
              >
                <SortAscending size={14} className="text-muted-foreground" />
                {/* !hidden：对抗 SelectTrigger 基类的 [&>span]:line-clamp-1（会把 span 重置为 -webkit-box） */}
                <span className="!hidden sm:!inline">
                  {t(`todo:sort.${filter.sortBy}`)}
                </span>
              </SelectTrigger>
              <SelectContent align="end">
                {(['manual', 'dueDate', 'priority', 'title'] as TodoSortBy[]).map((s) => (
                  <SelectItem key={s} value={s} className="text-xs [@media(pointer:coarse)]:min-h-[2.75rem]">
                    {t(`todo:sort.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <DsButton
              variant="utility"
              size="sm"
              onClick={() => setShowCompleted(!filter.showCompleted)}
              disabled={filter.view === 'completed'}
              data-selected={filter.showCompleted}
              className={cn(
                'h-8 gap-1.5 !px-2.5 text-xs [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-[2.75rem]',
                filter.showCompleted &&
                  '!bg-[color:var(--button-primary-surface)] !text-[color:var(--button-primary-foreground)]',
              )}
            >
              <CheckCircle size={14} />
              <span className="hidden sm:inline">{t('todo:filters.showCompleted')}</span>
            </DsButton>

            {/* 📱 批量多选开关：触屏没有 Cmd/Ctrl/Shift 点选入口，用模式切换替代 */}
            <DsButton
              variant="utility"
              size="sm"
              onClick={() => (checkMode ? exitCheckMode() : setCheckMode(true))}
              data-selected={checkMode}
              aria-pressed={checkMode}
              aria-label={t('todo:bulk.selectMode', '选择')}
              title={t('todo:bulk.selectMode', '选择')}
              className={cn(
                'h-8 gap-1.5 !px-2.5 text-xs [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-[2.75rem]',
                checkMode &&
                  '!bg-[color:var(--button-primary-surface)] !text-[color:var(--button-primary-foreground)]',
              )}
            >
              <ListChecks size={14} />
              <span className="hidden sm:inline">{t('todo:bulk.selectMode', '选择')}</span>
            </DsButton>
          </div>

          {/* 窄屏内联搜索行（flex-wrap 下换行占满整行；关闭时清空搜索词） */}
          {isSmallScreen && mobileSearchOpen && (
            <div className="ui-rise-in flex w-full items-center gap-2 pb-1">
              <div className="relative min-w-0 flex-1">
                <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" size={15} />
                <Input
                  type="search"
                  autoFocus
                  value={filter.search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearch('');
                      setMobileSearchOpen(false);
                    }
                  }}
                  placeholder={t('todo:actions.search')}
                  data-todo-search
                  className="h-10 w-full pl-9 pr-3 text-sm"
                />
              </div>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => {
                  setSearch('');
                  setMobileSearchOpen(false);
                }}
                aria-label={t('common:actions.close', '关闭')}
                className="!h-10 !w-10 flex-shrink-0"
              >
                <X size={16} />
              </DsButton>
            </div>
          )}
        </div>

        {/* 批量多选操作条（内联，非弹窗）：Cmd/Ctrl/Shift 点选行或多选模式勾选后出现 */}
        {checkedIds.size > 0 && (
          <BulkActionBar
            checkedIds={checkedIds}
            onClear={checkMode ? exitCheckMode : clearChecked}
          />
        )}

        {/* 内容区 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <CustomScrollArea
            className="flex-1 min-h-0"
            // --keyboard-inset：键盘弹出时垫高列表底部，QuickAdd/行内编辑/
            // 内联改期条等低位输入框可滚出键盘遮挡区（桌面端恒为 0px）
            viewportClassName="pb-[calc(1.5rem+var(--keyboard-inset,0px))]"
            viewportRef={setScrollViewport}
          >
            {showQuickAdd && (
              <>
                <TodoQuickAdd defaultDueDate={quickAddDefaultDueDate} />
                <div className="h-px bg-border/20" />
              </>
            )}

            {/* B2 复习联动：今天视图顶部展示到期复习入口 */}
            {filter.view === 'today' && <ReviewLinkCard />}

            {isLoadingItems ? (
              <div className="flex items-center justify-center py-20">
                <CircleNotch size={24} className="animate-spin text-muted-foreground/60" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="study-shell-empty-state m-4 sm:m-6 ui-rise-in">
                <div
                  className={cn(
                    'study-shell-empty-state__icon',
                    // 纯 CSS 同心圆装饰（缓慢呼吸），替代插画资源
                    'todo-empty-decor',
                    // 清零类空态：一次性亮色 scale 弹跳（无 confetti，reduced-motion 下退化）
                    emptyState.celebratory &&
                      '!text-[color:hsl(var(--success))] todo-celebrate-pop',
                  )}
                >
                  <emptyState.icon size={24} weight={emptyState.celebratory ? 'fill' : 'regular'} />
                </div>
                <h3 className="study-shell-empty-state__title">{emptyState.title}</h3>
                <p className="study-shell-empty-state__description">{emptyState.hint}</p>
              </div>
            ) : isManualSortView ? (
              <DndContext
                sensors={sensors}
                autoScroll={SHELL_SAFE_AUTO_SCROLL}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={topLevelItems.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col divide-y divide-border/[0.08]">
                    {topLevelItems.map((item) => (
                      <React.Fragment key={item.id}>
                        <SortableTodoItemRow
                          item={item}
                          onToggle={toggleItem}
                          onSelect={handleSelect}
                          onDelete={deleteItem}
                          onRename={handleRename}
                          isSelected={selectedItemId === item.id}
                          isFocused={focusedItemId === item.id}
                          isChecked={checkedIds.has(item.id)}
                          onCheckToggle={handleCheckToggle}
                          checkMode={checkMode}
                          subtaskProgress={subtaskProgressOf(item.id)}
                        />
                        {(childrenByParent.get(item.id) || []).map((child) => (
                          <TodoItemRow
                            key={child.id}
                            item={child}
                            onToggle={toggleItem}
                            onSelect={handleSelect}
                            onDelete={deleteItem}
                            onRename={handleRename}
                            isSelected={selectedItemId === child.id}
                            isFocused={focusedItemId === child.id}
                            isChecked={checkedIds.has(child.id)}
                            onCheckToggle={handleCheckToggle}
                            checkMode={checkMode}
                            depth={1}
                          />
                        ))}
                      </React.Fragment>
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : matrixQuadrants ? (
              <MatrixBoard
                quadrants={matrixQuadrants}
                selectedItemId={selectedItemId}
                focusedItemId={focusedItemId}
                checkedIds={checkedIds}
                onCheckToggle={handleCheckToggle}
                checkMode={checkMode}
                onToggle={toggleItem}
                onSelect={handleSelect}
                onDelete={deleteItem}
                onRename={handleRename}
              />
            ) : upcomingGroups ? (
              <div className="flex flex-col">
                {upcomingGroups.map((group) => {
                  const collapsed = collapsedBuckets.has(group.bucket);
                  return (
                    <div key={group.bucket}>
                      <div data-wb-blur-surface className="sticky top-0 z-[1] flex items-center gap-2 bg-[color:var(--surface-root)]/95 px-4 pb-1 pt-3 backdrop-blur-sm sm:px-6">
                        {/* 组头可点击折叠/展开（caret 旋转 + InlineReveal 收合动画） */}
                        <button
                          type="button"
                          onClick={() => toggleBucketCollapsed(group.bucket)}
                          aria-expanded={!collapsed}
                          className="group/header -mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:hsl(var(--primary))]/50"
                        >
                          <CaretDown
                            size={11}
                            weight="bold"
                            data-collapsed={collapsed}
                            className="todo-group-caret flex-shrink-0 text-muted-foreground/40 group-hover/header:text-muted-foreground"
                          />
                          <span
                            className={cn(
                              'text-xs font-semibold uppercase tracking-wide',
                              group.bucket === 'overdue'
                                ? 'text-[color:hsl(var(--destructive))]'
                                : 'text-muted-foreground',
                            )}
                          >
                            {t(`todo:groups.${group.bucket}`)}
                          </span>
                          <span className="text-xs tabular-nums text-muted-foreground/50">
                            {group.items.length}
                          </span>
                        </button>
                        {group.bucket === 'overdue' && (
                          <DsButton
                            variant="utility"
                            size="sm"
                            disabled={reschedulingOverdue}
                            onClick={() => void handleRescheduleOverdueToToday(group.items)}
                            title={t('todo:reschedule.allToTodayHint')}
                            className="ml-auto h-6 gap-1 !px-2 text-xs"
                          >
                            <CalendarPlus size={12} />
                            {t('todo:reschedule.allToToday')}
                          </DsButton>
                        )}
                      </div>
                      <InlineReveal open={!collapsed}>
                        <div className="flex flex-col divide-y divide-border/[0.08]">
                          {group.items.map((item) => (
                            <TodoItemRow
                              key={item.id}
                              item={item}
                              onToggle={toggleItem}
                              onSelect={handleSelect}
                              onDelete={deleteItem}
                              onRename={handleRename}
                              isSelected={selectedItemId === item.id}
                              isFocused={focusedItemId === item.id}
                              isChecked={checkedIds.has(item.id)}
                              onCheckToggle={handleCheckToggle}
                              checkMode={checkMode}
                            />
                          ))}
                        </div>
                      </InlineReveal>
                    </div>
                  );
                })}
              </div>
            ) : (
              <TodoRowsList
                rows={listRows}
                scrollElement={scrollViewport}
                selectedItemId={selectedItemId}
                focusedItemId={focusedItemId}
                checkedIds={checkedIds}
                onCheckToggle={handleCheckToggle}
                checkMode={checkMode}
                onToggle={toggleItem}
                onSelect={handleSelect}
                onDelete={deleteItem}
                onRename={handleRename}
              />
            )}
          </CustomScrollArea>
        </div>

        <PomodoroPanel
          onOpenSettingsSubView={
            isSmallScreen && onOpenPomodoroSubView
              ? () => onOpenPomodoroSubView('settings')
              : undefined
          }
          onOpenStatsSubView={
            isSmallScreen && onOpenPomodoroSubView
              ? () => onOpenPomodoroSubView('stats')
              : undefined
          }
        />

        {/* 移动端详情：全屏覆盖（滑入/滑出 + 系统返回键关闭；顶栏返回箭头由 TodoContentView 联动） */}
        {isSmallScreen && (
          <MobileDetailOverlay open={!!selectedItem} onClose={() => selectItem(null)}>
            {selectedItem && (
              <TodoItemDetail
                key={selectedItem.id}
                item={selectedItem}
                onClose={() => selectItem(null)}
                className="w-full"
                hideCloseButton
              />
            )}
          </MobileDetailOverlay>
        )}
      </div>

      {/* 桌面端详情：右侧抽屉 */}
      {!isSmallScreen && selectedItem && (
        <TodoItemDetail
          key={selectedItem.id}
          item={selectedItem}
          onClose={() => selectItem(null)}
          className="w-[360px] flex-shrink-0 border-l border-[color:var(--shell-seam)] ui-slide-fade-in [--ui-enter-x:32px]"
        />
      )}
    </div>
  );
};
