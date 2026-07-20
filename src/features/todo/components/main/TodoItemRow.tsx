/**
 * TodoItemRow — 待办列表行（React.memo 优化）
 *
 * - 双击标题区行内编辑（Enter 确认 / Esc 取消 / blur 确认 / IME 安全）
 * - 勾选完成：勾选圈填充 + 行淡出动画（约 220ms，尊重 prefers-reduced-motion）
 * - 逾期高亮在展示层考虑 dueTime（今天到期且时间已过也标红）
 * - 键盘导航焦点态（data-focused）
 * - 触屏（coarse 指针）滑动手势：左滑（内容左移）露出绿色完成块，松手过阈值
 *   直接完成；右滑露出「改期 / 删除」动作块（删除需第二次点击色块确认）。
 *   与页级三屏手势隔离：行根节点带 data-no-screen-swipe（MobileSlidingLayout
 *   的豁免选择器），且水平位移 >10px 并大于垂直位移才接管（轴锁定），
 *   屏幕边缘起手保留给页级手势。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Brain,
  Calendar,
  CalendarPlus,
  Check,
  CheckCircle,
  DotsSixVertical,
  Minus,
  Play,
  Repeat,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { haptics } from '@/hooks/mobile';
import { usePomodoroStore } from '@/features/pomodoro';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useTodoStore } from '../../stores/useTodoStore';
import type { TodoItem, TodoPriority } from '../../types';
import {
  PRIORITY_CONFIG,
  addDays,
  formatLocalDate,
  isDueToday,
  mondayWeekStart,
  parseRepeatRule,
  parseTags,
  repeatRuleLabel,
} from '../../types';
import { formatDueDateLabel, isDisplayOverdue } from './dueDateLabel';
import { RescheduleMenu } from './RescheduleMenu';
import { RowPriorityMenu } from './RowPriorityMenu';
import '../../styles/todo-motion.css';

export const PriorityIcon: React.FC<{ priority: TodoPriority; className?: string }> = ({
  priority,
  className,
}) => {
  const config = PRIORITY_CONFIG[priority];
  const icons: Record<string, React.ElementType> = {
    Minus,
    ArrowDown,
    ArrowRight,
    ArrowUp,
    AlertTriangle: Warning,
  };
  const Icon = icons[config.icon] || Minus;
  return <Icon size={16} className={cn(config.color, className)} />;
};

// 勾选圈按优先级着色（一眼识别轻重；none 保持中性并在 hover 时转主色）
const PRIORITY_CHECKBOX_CLASS: Record<TodoPriority, string> = {
  none: 'border-[color:var(--border-default)] group-hover:border-[color:hsl(var(--primary))] group-focus-within:border-[color:hsl(var(--primary))]',
  low: 'border-[color:hsl(var(--info))]/75',
  medium: 'border-[color:hsl(var(--warning))]/80',
  high: 'border-[color:hsl(var(--brand-warm,var(--warning)))]',
  urgent: 'border-[color:hsl(var(--destructive))]',
};

const PRIORITY_CHECK_ICON_CLASS: Record<TodoPriority, string> = {
  none: 'text-[color:hsl(var(--primary))]',
  low: 'text-[color:hsl(var(--info))]',
  medium: 'text-[color:hsl(var(--warning))]',
  high: 'text-[color:hsl(var(--brand-warm,var(--warning)))]',
  urgent: 'text-[color:hsl(var(--destructive))]',
};

/** 完成动画时长（勾选圈填充 + 行淡出），与设计规范 150-250ms 区间一致 */
const COMPLETE_ANIMATION_MS = 220;

// ===== 触屏滑动手势参数 =====
/** 右滑动作块总宽（改期 + 删除 各 72px） */
const SWIPE_ACTION_WIDTH = 144;
/** 左滑完成触发阈值（露出量超过该值松手即完成） */
const SWIPE_COMPLETE_THRESHOLD = 88;
/** 左滑最大露出量（超出后阻尼缓行） */
const SWIPE_MAX_REVEAL = 132;
/** 轴锁定阈值：位移超过该值且大于另一轴位移才接管 */
const SWIPE_AXIS_LOCK_PX = 10;
/** 屏幕边缘保留宽度：边缘起手让给页级布局手势（侧栏滑出/返回） */
const SCREEN_EDGE_RESERVED_PX = 24;

// ===== 滑动手势首次使用提示（残留#4：触屏行操作全靠滑动但无视觉暗示）=====
// 首个可滑动的任务行在首次进入时播放一次「滑动预览」：内容左移露出绿色
// 完成色块再回弹（.todo-swipe-hint-content，token 见 --m-swipe-hint-*）。
// localStorage 记一次性标记；模块级 claim 保证同屏多行只有第一行播放。
const SWIPE_HINT_STORAGE_KEY = 'todo.swipeHintShown';
/** 进入页面到开始播放提示的延迟（先让列表入场动画走完） */
const SWIPE_HINT_DELAY_MS = 900;
let swipeHintClaimed = false;

function claimSwipeHint(): boolean {
  if (swipeHintClaimed) return false;
  swipeHintClaimed = true;
  try {
    if (localStorage.getItem(SWIPE_HINT_STORAGE_KEY) === '1') return false;
    localStorage.setItem(SWIPE_HINT_STORAGE_KEY, '1');
  } catch {
    // 存储不可用时仍播放（最坏情况：下次会话再播一次）
  }
  return true;
}

// ============================================================================
// InlineRescheduleBar — 行下方内联改期展开条（触屏滑动「改期」动作使用）
// 今天/明天/下周一/移除日期 + 日期输入；outside pointerdown / Esc /
// Android 返回键关闭。非弹层、非屏幕坐标菜单。
// ============================================================================

const InlineRescheduleBar: React.FC<{
  item: TodoItem;
  onClose: () => void;
}> = ({ item, onClose }) => {
  const { t } = useTranslation(['todo']);
  const updateItem = useTodoStore((s) => s.updateItem);
  const barRef = useRef<HTMLDivElement>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleOutside = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, []);

  // Android 返回键：展开条打开时先收起，不触发页面级返回
  useEffect(() => {
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, []);

  // 打开时刻计算一次即可（展开条生命周期短，无跨午夜常驻问题）
  const options = useMemo(() => {
    const now = new Date();
    const today = formatLocalDate(now);
    const tomorrow = formatLocalDate(addDays(now, 1));
    const nextMonday = formatLocalDate(addDays(mondayWeekStart(now), 7));
    const opts: Array<{ key: string; label: string; date: string; hint?: string }> = [];
    if (item.dueDate !== today) {
      opts.push({ key: 'today', label: t('todo:reschedule.today'), date: today });
    }
    if (item.dueDate !== tomorrow) {
      opts.push({ key: 'tomorrow', label: t('todo:reschedule.tomorrow'), date: tomorrow });
    }
    if (item.dueDate !== nextMonday) {
      opts.push({
        key: 'nextMonday',
        label: t('todo:reschedule.nextMonday'),
        date: nextMonday,
        hint: nextMonday.slice(5),
      });
    }
    if (item.dueDate) {
      opts.push({ key: 'clear', label: t('todo:reschedule.clear'), date: '' });
    }
    return opts;
  }, [item.dueDate, t]);

  const handlePick = useCallback(
    (date: string) => {
      onCloseRef.current();
      void updateItem({ id: item.id, dueDate: date });
    },
    [item.id, updateItem],
  );

  return (
    <div
      ref={barRef}
      role="group"
      aria-label={t('todo:reschedule.title')}
      className="ui-rise-in flex flex-wrap items-center gap-1.5 px-4 pb-2.5 pt-0.5 sm:px-6"
      onClick={(e) => e.stopPropagation()}
    >
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => handlePick(opt.date)}
          className={cn(
            'inline-flex items-center gap-1 rounded-[var(--radius-shell-control)] border px-2.5 py-1 text-xs transition-colors duration-150',
            '[@media(pointer:coarse)]:min-h-[2.75rem] [@media(pointer:coarse)]:px-3',
            'border-[color:var(--border-default)]/60 hover:bg-[color:var(--interactive-hover)]',
            opt.key === 'clear' ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          <span>{opt.label}</span>
          {opt.hint && (
            <span className="text-2xs tabular-nums text-muted-foreground">{opt.hint}</span>
          )}
        </button>
      ))}
      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)]/60 px-2 py-1 [@media(pointer:coarse)]:min-h-[2.75rem]">
        <Calendar size={13} className="text-muted-foreground" />
        <Input
          type="date"
          value={item.dueDate || ''}
          onChange={(e) => {
            if (e.target.value) handlePick(e.target.value);
          }}
          aria-label={t('todo:fields.dueDate')}
          className="h-auto min-h-0 w-auto cursor-pointer border-0 bg-transparent p-0 text-xs focus-visible:ring-0"
        />
      </label>
    </div>
  );
};

// ============================================================================
// RowTitleEditor — 行内标题编辑（InlineEditText 的 Enter/Esc/blur/IME 模式）
// ============================================================================

const RowTitleEditor: React.FC<{
  value: string;
  onConfirm: (next: string) => void;
  onCancel: () => void;
}> = ({ value, onConfirm, onCancel }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(value);
  const isComposingRef = useRef(false);
  const hasHandledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleConfirm = useCallback(() => {
    if (hasHandledRef.current) return;
    hasHandledRef.current = true;
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== value) {
      onConfirm(trimmed);
    } else {
      onCancel();
    }
  }, [editValue, value, onConfirm, onCancel]);

  const handleCancel = useCallback(() => {
    if (hasHandledRef.current) return;
    hasHandledRef.current = true;
    onCancel();
  }, [onCancel]);

  return (
    <Input
      ref={inputRef}
      value={editValue}
      maxLength={255}
      onChange={(e) => setEditValue(e.target.value)}
      onCompositionStart={() => {
        isComposingRef.current = true;
      }}
      onCompositionEnd={() => {
        isComposingRef.current = false;
      }}
      onKeyDown={(e) => {
        if (isComposingRef.current) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          handleConfirm();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          handleCancel();
        }
      }}
      onBlur={() => {
        requestAnimationFrame(() => handleConfirm());
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="h-6 min-h-0 w-full rounded border border-[color:hsl(var(--primary))]/50 bg-background px-1 py-0 text-sm font-medium focus-visible:ring-1 focus-visible:ring-[color:hsl(var(--primary))]/50 selection:bg-[color:hsl(var(--primary))]/30"
    />
  );
};

// ============================================================================
// TodoItemRow
// ============================================================================

export interface TodoItemRowProps {
  item: TodoItem;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** 行内改名（双击标题触发） */
  onRename?: (id: string, title: string) => void;
  isSelected: boolean;
  /** 键盘导航焦点（j/k / ↑↓） */
  isFocused?: boolean;
  /** 批量多选：本行是否被勾入选择集 */
  isChecked?: boolean;
  /** 批量多选：Cmd/Ctrl/Shift + 点击时回调（shift = 范围选择） */
  onCheckToggle?: (id: string, opts: { shift: boolean }) => void;
  /** 子任务缩进层级（0 = 顶层） */
  depth?: number;
  /** 子任务完成进度（仅父任务显示） */
  subtaskProgress?: { done: number; total: number };
  /** 拖拽手柄（仅手动排序视图传入） */
  dragHandle?: React.ReactNode;
}

const TodoItemRowInner: React.FC<TodoItemRowProps> = ({
  item,
  onToggle,
  onSelect,
  onDelete,
  onRename,
  isSelected,
  isFocused = false,
  isChecked = false,
  onCheckToggle,
  depth = 0,
  subtaskProgress,
  dragHandle,
}) => {
  const { t, i18n } = useTranslation(['todo', 'common']);
  const overdue = isDisplayOverdue(item);
  const dueToday = isDueToday(item);
  const tags = parseTags(item.tagsJson);
  const isCompleted = item.status === 'completed';
  const repeatRule = parseRepeatRule(item.repeatJson);
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  const [isEditing, setIsEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const completeTimerRef = useRef<number | null>(null);
  // 最新状态/回调镜像：完成动画的延迟提交与卸载兜底读取，避免闭包读到过期值
  const isCompletedRef = useRef(isCompleted);
  isCompletedRef.current = isCompleted;
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;

  // ===== 滑动手势状态 =====
  const [dragX, setDragX] = useState(0);
  const dragXRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  /** 右滑动作块是否处于展开吸附态 */
  const [actionsOpen, setActionsOpen] = useState(false);
  /** 滑出的删除块二次确认态 */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** 行下方内联改期展开条 */
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    locked: boolean | 'rejected';
  }>({ pointerId: -1, startX: 0, startY: 0, baseX: 0, locked: false });

  const setDrag = useCallback((x: number) => {
    dragXRef.current = x;
    setDragX(x);
  }, []);

  const itemIdRef = useRef(item.id);
  itemIdRef.current = item.id;

  useEffect(() => {
    return () => {
      if (completeTimerRef.current !== null) {
        window.clearTimeout(completeTimerRef.current);
        completeTimerRef.current = null;
        // 动画期间行被卸载（虚拟化滚动/切视图）：立即提交，用户的完成操作不能静默丢失
        if (!isCompletedRef.current) onToggleRef.current(itemIdRef.current);
      }
    };
  }, []);

  /** 完成提交（勾选圈填充 + 行淡出后 toggle；行移除的高度收合由 AnimatedListRow 承担） */
  const beginComplete = useCallback(() => {
    // 动画进行中再触发一次 = 反悔：取消提交，不翻转状态
    if (completing) {
      if (completeTimerRef.current !== null) {
        window.clearTimeout(completeTimerRef.current);
        completeTimerRef.current = null;
      }
      setCompleting(false);
      return;
    }
    if (isCompleted) {
      onToggleRef.current(item.id);
      return;
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      onToggleRef.current(item.id);
      return;
    }
    // 满足感动画：先填充勾选圈 + 行淡出，再提交状态变更
    setCompleting(true);
    completeTimerRef.current = window.setTimeout(() => {
      completeTimerRef.current = null;
      setCompleting(false);
      // 动画间隙内条目可能已被其他路径完成（批量完成/详情面板/静默校准），
      // 此时再 toggle 会把它误翻回 pending——按最新状态跳过提交
      if (!isCompletedRef.current) onToggleRef.current(item.id);
    }, COMPLETE_ANIMATION_MS);
  }, [isCompleted, completing, item.id]);

  const handleToggleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      beginComplete();
    },
    [beginComplete],
  );

  const showCheckFilled = isCompleted || completing;

  // ===== 滑动手势（pointer events + 轴锁定；仅 coarse 指针、未完成、非编辑态） =====
  const swipeEnabled = isTouchPrimary && !isCompleted && !completing && !isEditing;

  // ===== 首次使用滑动提示（一次性；claim 逻辑见文件头）=====
  const [swipeHintPlaying, setSwipeHintPlaying] = useState(false);
  useEffect(() => {
    if (!swipeEnabled || swipeHintClaimed) return;
    if (!claimSwipeHint()) return;
    // 提示本身是纯动效引导，reduced-motion 下直接跳过（详情面板是全功能兜底）
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setTimeout(() => setSwipeHintPlaying(true), SWIPE_HINT_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      setSwipeHintPlaying(false);
    };
  }, [swipeEnabled]);

  const closeActions = useCallback(() => {
    setActionsOpen(false);
    setConfirmingDelete(false);
    setDrag(0);
  }, [setDrag]);

  // 动作块展开时：点击行外任意处收起
  useEffect(() => {
    if (!actionsOpen) return;
    const handleOutside = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        closeActions();
      }
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [actionsOpen, closeActions]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 用户开始交互即取消滑动提示动画（同值 setState 会被 React 跳过）
      setSwipeHintPlaying(false);
      if (!swipeEnabled || e.pointerType === 'mouse') return;
      // 屏幕边缘起手保留给页级布局手势（MobileSlidingLayout 边缘优先）
      if (
        e.clientX < SCREEN_EDGE_RESERVED_PX ||
        e.clientX > window.innerWidth - SCREEN_EDGE_RESERVED_PX
      ) {
        return;
      }
      gestureRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseX: actionsOpen ? SWIPE_ACTION_WIDTH : 0,
        locked: false,
      };
    },
    [swipeEnabled, actionsOpen],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      if (g.pointerId !== e.pointerId || g.locked === 'rejected') return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (g.locked !== true) {
        // 轴锁定：竖向意图让给列表滚动，只在水平意图明确时接管
        if (Math.abs(dy) > SWIPE_AXIS_LOCK_PX && Math.abs(dy) > Math.abs(dx)) {
          g.locked = 'rejected';
          return;
        }
        if (Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy)) {
          g.locked = true;
          setDragging(true);
          suppressClickRef.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } else {
          return;
        }
      }
      let next = g.baseX + dx;
      // 越过吸附/触发位后按 0.3 阻尼缓行，制造「拉到底」的手感
      if (next > SWIPE_ACTION_WIDTH) {
        next = SWIPE_ACTION_WIDTH + (next - SWIPE_ACTION_WIDTH) * 0.3;
      } else if (next < -SWIPE_MAX_REVEAL) {
        next = -SWIPE_MAX_REVEAL + (next + SWIPE_MAX_REVEAL) * 0.3;
      }
      setDrag(next);
    },
    [setDrag],
  );

  const handlePointerEnd = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      if (g.pointerId !== e.pointerId) return;
      const wasLocked = g.locked === true;
      gestureRef.current.pointerId = -1;
      if (!wasLocked) return;
      setDragging(false);
      const x = dragXRef.current;
      if (e.type === 'pointercancel') {
        setDrag(actionsOpen ? SWIPE_ACTION_WIDTH : 0);
        return;
      }
      if (x < -SWIPE_COMPLETE_THRESHOLD) {
        // 左滑过阈值：直接完成（回弹后走完成动画）
        haptics.impact('light');
        setDrag(0);
        setActionsOpen(false);
        setConfirmingDelete(false);
        beginComplete();
      } else if (x > SWIPE_ACTION_WIDTH / 2) {
        setActionsOpen(true);
        setDrag(SWIPE_ACTION_WIDTH);
      } else {
        closeActions();
      }
    },
    [actionsOpen, beginComplete, closeActions, setDrag],
  );

  // 水平拖拽发生后吞掉松手时的 click（捕获阶段，防止误触发行选中/按钮点击）
  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      if (actionsOpen) {
        closeActions();
        return;
      }
      // Cmd/Ctrl 点选 或 Shift 范围选：进入批量多选，不打开详情
      if (onCheckToggle && (e.metaKey || e.ctrlKey || e.shiftKey)) {
        onCheckToggle(item.id, { shift: e.shiftKey });
        return;
      }
      onSelect(item.id);
    },
    [actionsOpen, closeActions, onCheckToggle, onSelect, item.id],
  );

  const handleSwipeReschedule = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeActions();
      setRescheduleOpen(true);
    },
    [closeActions],
  );

  const handleSwipeDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!confirmingDelete) {
        // 第一次点击：进入二次确认态（色块加深 + 文案变「确认删除」）
        setConfirmingDelete(true);
        return;
      }
      closeActions();
      onDelete(item.id);
    },
    [confirmingDelete, closeActions, onDelete, item.id],
  );

  const swipeRevealLeft = dragX > 0;
  const swipeRevealRight = dragX < 0;
  const completeArmed = dragX < -SWIPE_COMPLETE_THRESHOLD;

  return (
    // 外层：滑动舞台（动作块 + 可平移的行内容 + 行下方内联改期条）。
    // data-no-screen-swipe：豁免 MobileSlidingLayout 页级三屏手势（非边缘起手）。
    <div ref={wrapRef} data-no-screen-swipe className="relative" onClickCapture={handleClickCapture}>
      {/* 左滑完成背景（绿色勾）：过阈值时整块转实色示意「松手即完成」；
          首次使用提示播放期间同样露出，暗示行可左滑 */}
      {(swipeRevealRight || swipeHintPlaying) && (
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 flex items-center justify-end pr-5 transition-colors duration-150',
            completeArmed
              ? 'bg-[color:hsl(var(--success))]'
              : 'bg-[color:hsl(var(--success))]/20',
          )}
        >
          <Check
            size={20}
            weight="bold"
            className={cn(
              'transition-transform duration-150',
              // success-foreground：暗色模式下 success 转浅，配对前景色保证对比度
              completeArmed
                ? 'scale-110 text-[color:hsl(var(--success-foreground))]'
                : 'text-[color:hsl(var(--success))]',
            )}
          />
        </div>
      )}

      {/* 右滑动作块：改期 / 删除（删除需第二次点击确认） */}
      {(swipeRevealLeft || actionsOpen) && (
        <div
          className="absolute inset-y-0 left-0 flex overflow-hidden"
          style={{ width: SWIPE_ACTION_WIDTH }}
        >
          <button
            type="button"
            tabIndex={actionsOpen ? 0 : -1}
            onClick={handleSwipeReschedule}
            aria-label={t('todo:reschedule.title')}
            className="flex h-full w-1/2 flex-col items-center justify-center gap-0.5 bg-[color:hsl(var(--info))] text-xs font-medium text-[color:hsl(var(--info-foreground))]"
          >
            <CalendarPlus size={18} />
            {t('todo:reschedule.title')}
          </button>
          <button
            type="button"
            tabIndex={actionsOpen ? 0 : -1}
            onClick={handleSwipeDelete}
            aria-label={
              confirmingDelete
                ? t('todo:swipe.confirmDelete', '确认删除')
                : t('todo:actions.deleteItem')
            }
            className={cn(
              'flex h-full w-1/2 flex-col items-center justify-center gap-0.5 text-xs font-medium text-[color:hsl(var(--destructive-foreground))] transition-colors duration-150',
              confirmingDelete
                ? 'bg-[color:hsl(var(--destructive))]'
                : 'bg-[color:hsl(var(--destructive))]/75',
            )}
          >
            <Trash size={18} weight={confirmingDelete ? 'fill' : 'regular'} />
            {confirmingDelete
              ? t('todo:swipe.confirmDelete', '确认删除')
              : t('common:actions.delete', '删除')}
          </button>
        </div>
      )}

      <div
        data-selected={isSelected}
        data-focused={isFocused || undefined}
        data-checked={isChecked || undefined}
        data-agent-entity={`todo:${item.id}`}
        className={cn(
          'group relative flex cursor-pointer items-center gap-3 px-4 py-2.5 sm:px-6',
          dragging
            ? 'transition-none'
            : 'transition-[background-color,opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          'hover:bg-[color:var(--interactive-hover)]',
          'data-[selected=true]:bg-[color:var(--interactive-selected)]',
          'data-[focused=true]:bg-[color:var(--interactive-hover)]',
          // 批量多选态：主色淡底 + 左侧 2px 主色指示条
          'data-[checked=true]:bg-[color:hsl(var(--primary))]/[0.08]',
          'data-[checked=true]:shadow-[inset_2px_0_0_hsl(var(--primary))]',
          // 平移期间行内容需要不透明底色，遮住下层动作块
          (dragX !== 0 || swipeHintPlaying) &&
            'bg-[color:var(--surface-root,hsl(var(--background)))]',
          isCompleted && 'opacity-60',
          // 完成提交动画：轻微右移淡出（reduced-motion 下 completing 恒为 false）
          completing && 'todo-row-completing',
          // 首次使用滑动提示：左移露出完成色块再回弹（一次性）
          swipeHintPlaying && 'todo-swipe-hint-content',
        )}
        style={{
          ...(depth > 0 ? { paddingLeft: `${16 + depth * 28}px` } : null),
          ...(dragX !== 0 ? { transform: `translateX(${dragX}px)` } : null),
          ...(swipeEnabled ? { touchAction: 'pan-y' } : null),
        }}
        onClick={handleRowClick}
        onAnimationEnd={(e) => {
          // 滑动提示播放完毕即移除类名（露出的色块一并卸载）
          if (e.animationName === 'todo-swipe-hint') setSwipeHintPlaying(false);
        }}
        onMouseDown={(e) => {
          // Shift 点选时阻止原生文本选区（多选手势的常见副作用）
          if (onCheckToggle && e.shiftKey) e.preventDefault();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
      {dragHandle}

      <button
        onClick={handleToggleClick}
        // 触屏：透明 padding 扩大命中到 ≥44px，负 margin 保持布局不变
        className="flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] focus-visible:ring-offset-1 [@media(pointer:coarse)]:p-3 [@media(pointer:coarse)]:-m-3"
        aria-label={isCompleted ? t('todo:actions.markPending') : t('todo:actions.markCompleted')}
      >
        {showCheckFilled ? (
          // 外圈扩散光环 + 图标弹性放大回落（reduced-motion 下由 CSS 侧禁用）
          <span className={cn('flex', completing && 'todo-check-burst')}>
            <CheckCircle
              size={20}
              weight="fill"
              className={cn(
                'text-[color:hsl(var(--success))]',
                completing && 'todo-check-pop',
              )}
            />
          </span>
        ) : (
          <div
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] transition-colors duration-150',
              PRIORITY_CHECKBOX_CLASS[item.priority as TodoPriority] ?? PRIORITY_CHECKBOX_CLASS.none,
            )}
          >
            <Check
              size={12}
              className={cn(
                'opacity-0 transition-opacity group-hover:opacity-40 group-focus-within:opacity-40',
                PRIORITY_CHECK_ICON_CLASS[item.priority as TodoPriority] ?? PRIORITY_CHECK_ICON_CLASS.none,
              )}
            />
          </div>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {isEditing && onRename ? (
          <RowTitleEditor
            value={item.title}
            onConfirm={(next) => {
              setIsEditing(false);
              onRename(item.id, next);
            }}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <div
            className={cn(
              'truncate text-sm transition-all duration-150',
              isCompleted || completing
                ? 'text-muted-foreground line-through'
                : 'font-medium text-foreground',
            )}
            title={onRename && !isCompleted ? t('todo:actions.editTitleHint') : undefined}
            onDoubleClick={(e) => {
              if (!onRename || isCompleted) return;
              e.stopPropagation();
              setIsEditing(true);
            }}
          >
            {item.title}
          </div>
        )}

        {(item.dueDate ||
          tags.length > 0 ||
          item.priority !== 'none' ||
          item.estimatedPomodoros ||
          repeatRule ||
          item.reminder ||
          subtaskProgress) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {subtaskProgress && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-xs tabular-nums',
                  subtaskProgress.done >= subtaskProgress.total
                    ? 'text-[color:hsl(var(--success))]'
                    : 'text-muted-foreground',
                )}
                title={t('todo:subtasks.progress', {
                  done: subtaskProgress.done,
                  total: subtaskProgress.total,
                })}
              >
                {/* 迷你进度环：一眼读出子任务完成比例（式） */}
                <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden className="flex-shrink-0">
                  <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
                  <circle
                    cx="6"
                    cy="6"
                    r="4.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 4.75}
                    strokeDashoffset={
                      2 * Math.PI * 4.75 *
                      (1 - (subtaskProgress.total > 0 ? subtaskProgress.done / subtaskProgress.total : 0))
                    }
                    transform="rotate(-90 6 6)"
                    className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
                  />
                </svg>
                {subtaskProgress.done}/{subtaskProgress.total}
              </span>
            )}

            {item.estimatedPomodoros ? (
              <span
                className="study-shell-badge study-shell-badge--warning tabular-nums"
                title={t('todo:pomodoro.progressTitle', {
                  done: item.completedPomodoros || 0,
                  total: item.estimatedPomodoros,
                })}
              >
                <Brain size={12} />
                {item.completedPomodoros || 0}/{item.estimatedPomodoros}
              </span>
            ) : null}

            {item.priority !== 'none' && (
              <span className="inline-flex items-center gap-1 text-xs">
                <PriorityIcon priority={item.priority as TodoPriority} className="h-3 w-3" />
                <span className="text-muted-foreground">
                  {t(PRIORITY_CONFIG[item.priority as TodoPriority].labelKey)}
                </span>
              </span>
            )}

            {item.dueDate && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-xs',
                  // 逾期：淡红底 pill，比纯文字着色更醒目（深浅色模式均用 /10 透明底）
                  overdue
                    ? '-mx-0.5 rounded-full bg-[color:hsl(var(--destructive))]/10 px-1.5 py-px font-medium text-[color:hsl(var(--destructive))]'
                    : dueToday
                    ? 'font-medium text-[color:hsl(var(--primary))]'
                    : 'text-muted-foreground',
                )}
                title={`${item.dueDate}${item.dueTime ? ` ${item.dueTime}` : ''}`}
              >
                <Calendar size={12} weight={overdue || dueToday ? 'fill' : 'regular'} />
                {formatDueDateLabel(item.dueDate, t, i18n.language)}
                {item.dueTime && ` ${item.dueTime}`}
              </span>
            )}

            {repeatRule && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Repeat size={12} />
                {repeatRuleLabel(repeatRule, t)}
              </span>
            )}

            {item.reminder && (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                title={item.reminder.replace('T', ' ')}
              >
                <Bell size={12} />
                {item.reminder.slice(11, 16) || item.reminder}
              </span>
            )}

            {tags.length > 0 && (
              <div className="flex gap-1">
                {tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="study-shell-badge">
                    {tag}
                  </span>
                ))}
                {tags.length > 3 && <span className="study-shell-badge">+{tags.length - 3}</span>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 行尾操作按钮：触屏隐藏（改期/删除走滑动手势，开始专注走详情），
          桌面 hover 渐显保持不变，避免挤占标题与误触 */}
      {!isCompleted && <RowPriorityMenu item={item} />}

      {!isCompleted && (
        <span className="flex-shrink-0 [@media(pointer:coarse)]:hidden">
          <RescheduleMenu item={item} />
        </span>
      )}

      {!isCompleted && (
        <DsButton
          variant="utility"
          size="icon"
          iconOnly
          onClick={(e) => {
            e.stopPropagation();
            usePomodoroStore.getState().start(item.id, item.title);
          }}
          title={t('todo:actions.startFocusSession')}
          aria-label={t('todo:actions.startFocusSession')}
          className="flex-shrink-0 opacity-40 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 !p-1.5 [@media(pointer:coarse)]:hidden"
        >
          <Play size={16} />
        </DsButton>
      )}

      <DsButton
        variant="utility"
        size="icon"
        iconOnly
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item.id);
        }}
        title={t('todo:actions.deleteItem')}
        aria-label={t('todo:actions.deleteItem')}
        className="flex-shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100 !p-1.5 [@media(pointer:coarse)]:hidden hover:!bg-[color:var(--button-danger-surface)] hover:!text-[color:hsl(var(--destructive))]"
      >
        <Trash size={16} />
      </DsButton>
      </div>

      {/* 行下方内联改期展开条（滑动「改期」动作 / 触屏路径） */}
      {rescheduleOpen && (
        <InlineRescheduleBar item={item} onClose={() => setRescheduleOpen(false)} />
      )}
    </div>
  );
};

export const TodoItemRow = React.memo(TodoItemRowInner);
TodoItemRow.displayName = 'TodoItemRow';

// ============================================================================
// SortableTodoItemRow — 拖拽排序包装（仅 'all' 视图顶层任务）
// ============================================================================

export const SortableTodoItemRow: React.FC<Omit<TodoItemRowProps, 'dragHandle'>> = (props) => {
  const { t } = useTranslation(['todo']);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.item.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'relative z-10 opacity-70 shadow-lg')}
    >
      <TodoItemRow
        {...props}
        dragHandle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('todo:actions.dragToReorder')}
            title={t('todo:actions.dragToReorder')}
            className={cn(
              '-ml-2 flex h-6 w-5 flex-shrink-0 cursor-grab items-center justify-center rounded',
              'text-muted-foreground/0 transition-colors active:cursor-grabbing',
              'group-hover:text-muted-foreground/60 hover:!text-muted-foreground',
              'focus-visible:text-muted-foreground focus:outline-none',
              // 触屏无 hover：手柄常显淡色，长按可拖拽排序（否则功能不可发现）；
              // touch-none 防止长按判定期间被原生滚动打断，加高命中区便于点中
              '[@media(pointer:coarse)]:text-muted-foreground/50',
              '[@media(pointer:coarse)]:touch-none [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-7',
            )}
          >
            <DotsSixVertical size={14} weight="bold" />
          </button>
        }
      />
    </div>
  );
};
