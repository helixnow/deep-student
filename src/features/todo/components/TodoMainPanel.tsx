/**
 * TodoMainPanel - 待办项主面板
 *
 * 设计原则：扁平工作区，避免"盒中盒"嵌套。
 * - 顶部 study-shell-toolbar 承载标题/搜索/筛选
 * - 中部直接平铺快速添加栏 + 列表项（或空状态）
 * - 右侧详情抽屉（桌面端）或全屏覆盖（移动端）
 * - 底部嵌入番茄钟面板
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  MagnifyingGlass,
  CheckCircle,
  CircleNotch,
  Calendar,
  Warning,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Minus,
  Trash,
  X,
  Check,
  Play,
  Brain,
  ListChecks,
  DotsSixVertical,
  TreeStructure,
  Repeat,
  Tag,
  Bell,
  SortAscending,
  Sparkle,
  CalendarPlus,
} from '@phosphor-icons/react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { useTouchFriendlyDndSensors } from '@/hooks/useTouchFriendlyDndSensors';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/shad/Select';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useTodoStore } from '../stores/useTodoStore';
import { usePomodoroStore, PomodoroPanel } from '@/features/pomodoro';
import { listPomodorosByTodo, type PomodoroRecord } from '@/features/pomodoro/api';
import type {
  EisenhowerQuadrant,
  TodoItem,
  TodoPriority,
  TodoRepeatFreq,
  TodoSortBy,
  UpdateTodoItemInput,
} from '../types';
import {
  EISENHOWER_QUADRANTS,
  PRIORITY_CONFIG,
  REPEAT_OPTIONS,
  addDays,
  classifyEisenhower,
  formatLocalDate,
  groupItemsByDueBucket,
  isOverdue,
  isDueToday,
  localToday,
  mondayWeekStart,
  nextRepeatOccurrence,
  parseTags,
  parseRepeatRule,
  repeatRuleLabel,
  serializeRepeatRule,
  sortTodoItems,
} from '../types';
import { parseQuickAddInput } from '../quickAddParser';
import { aiBreakdownTodo } from '../api';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import { useViewStore } from '@/stores/viewStore';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

// ============================================================================
// MobileDetailOverlay — 移动端子屏全屏覆盖层（详情/回收站/番茄设置等共用）
// 滑入/滑出过渡 + Android 系统返回键关闭（BACK_PRIORITY.view：
// 叠加在其上的确认对话框等 overlay 层先于子屏被返回键关闭）
// ============================================================================

const MOBILE_DETAIL_EXIT_MS = 200;

export const MobileDetailOverlay: React.FC<{
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ open, onClose, children }) => {
  const [visible, setVisible] = useState(open);
  const [entered, setEntered] = useState(false);
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

  if (!visible) return null;

  return (
    <div
      className={cn(
        'absolute inset-0 z-40 flex bg-[color:var(--surface-root)]',
        'transition-transform duration-200 ease-out motion-reduce:transition-none',
        entered && open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      {open ? children : lastChildrenRef.current}
    </div>
  );
};

// ============================================================================
// TodoQuickAdd — 扁平输入条
// ============================================================================

const TodoQuickAdd: React.FC = () => {
  const { t, i18n } = useTranslation(['todo']);
  const {
    createItem,
    activeListId,
    quickAddPreset,
    clearQuickAddPreset,
  } = useTodoStore();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('none');
  const [dueDate, setDueDate] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  // 自然语言解析（如「明天交作业 !高」），结果以 chip 预览，提交时应用
  const parsed = useMemo(() => parseQuickAddInput(title), [title]);

  useEffect(() => {
    if (!quickAddPreset) return;
    setDueDate(quickAddPreset.dueDate ?? '');
    setIsExpanded(true);
    document.querySelector<HTMLInputElement>('[data-todo-quick-add]')?.focus();
    clearQuickAddPreset(quickAddPreset.requestId);
  }, [clearQuickAddPreset, quickAddPreset]);
  const parsedDateLabel = useMemo(() => {
    if (!parsed.dueDate) return null;
    try {
      return new Date(`${parsed.dueDate}T00:00:00`).toLocaleDateString(
        i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US',
        { month: 'short', day: 'numeric', weekday: 'short' },
      );
    } catch {
      return parsed.dueDate;
    }
  }, [parsed.dueDate, i18n.language]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !activeListId) return;
    // 手动设置的字段优先于自然语言解析结果
    const finalTitle = (parsed.title || title).trim();
    const finalDueDate = dueDate || parsed.dueDate;
    const finalPriority = priority !== 'none' ? priority : (parsed.priority ?? 'none');
    if (!finalTitle) return;
    try {
      await createItem({
        todoListId: activeListId,
        title: finalTitle,
        priority: finalPriority,
        dueDate: finalDueDate || undefined,
        dueTime: parsed.dueTime,
        tags: parsed.tags,
        repeatJson: parsed.repeat ? serializeRepeatRule(parsed.repeat) : undefined,
      });
      setTitle('');
      setPriority('none');
      setDueDate('');
      setIsExpanded(false);
    } catch {
      // error handled in store
    }
  }, [title, parsed, priority, dueDate, activeListId, createItem]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape') setIsExpanded(false);
    },
    [handleSubmit],
  );

  if (!activeListId) return null;

  return (
    <div>
      <div className="flex items-center gap-2.5 px-4 py-2.5 sm:px-6">
        <Plus size={16} className="flex-shrink-0 text-[color:var(--text-muted)]" />
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsExpanded(true)}
          placeholder={t('todo:actions.quickAddPlaceholder')}
          data-todo-quick-add
          className="min-w-0 flex-1 bg-transparent border-0 focus-visible:ring-0 placeholder:text-muted-foreground/50"
        />
        {/* 自然语言解析预览 chip（提交时生效） */}
        {title.trim() &&
          (parsedDateLabel || parsed.dueTime || parsed.priority || parsed.repeat || parsed.tags) && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {parsedDateLabel && !dueDate && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] whitespace-nowrap">
                <Calendar size={11} />
                {parsedDateLabel}
                {parsed.dueTime ? ` ${parsed.dueTime}` : ''}
              </span>
            )}
            {parsed.repeat && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] whitespace-nowrap">
                <Repeat size={11} />
                {repeatRuleLabel(parsed.repeat, t)}
              </span>
            )}
            {parsed.tags?.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap"
              >
                <Tag size={10} />
                {tag}
              </span>
            ))}
            {parsed.priority && priority === 'none' && (
              <span className={cn(
                'inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] whitespace-nowrap',
                PRIORITY_CONFIG[parsed.priority].color,
              )}>
                {t(PRIORITY_CONFIG[parsed.priority].labelKey)}
              </span>
            )}
          </div>
        )}
        {title.trim() && (
          <NotionButton variant="shell" size="sm" onClick={handleSubmit} className="h-7 text-xs">
            {t('todo:actions.add')}
          </NotionButton>
        )}
      </div>

      {isExpanded && (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-2.5 sm:px-6">
          <SegmentedControl<TodoPriority>
            ariaLabel={t('todo:fields.priority')}
            value={priority}
            onValueChange={setPriority}
            size="compact"
            itemClassName="!h-auto !px-2 !py-1 text-[11px] font-medium"
            options={(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => {
              const config = PRIORITY_CONFIG[p];
              const isActive = priority === p;
              return {
                value: p,
                title: t(config.labelKey),
                label: (
                  <span className={isActive ? config.color : ''}>{t(config.labelKey)}</span>
                ),
              };
            })}
          />

          <div className="flex items-center gap-1.5 rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--input-shell-surface)] px-2 py-1">
            <Calendar size={14} className="text-muted-foreground" />
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="cursor-pointer bg-transparent border-0 focus-visible:ring-0 text-xs h-auto min-h-0 p-0 w-auto"
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// TodoItemRow
// ============================================================================

const PriorityIcon: React.FC<{ priority: TodoPriority; className?: string }> = ({
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

// ============================================================================
// RescheduleButton — 行内一键改期（今天/明天/下周一/移除日期）
// 对标 Todoist 的 quick reschedule：不进详情面板即可挪动到期日
// ============================================================================

const RescheduleButton: React.FC<{ item: TodoItem }> = ({ item }) => {
  const { t } = useTranslation(['todo']);
  const { updateItem } = useTodoStore();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number; openUp: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuPos) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuPos(null);
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuPos(null);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [menuPos]);

  // Android 返回键：菜单打开时先关菜单，不触发页面级返回
  useEffect(() => {
    if (!menuPos) return;
    return registerBackHandler(() => {
      setMenuPos(null);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [menuPos]);

  // 仅在菜单打开时计算：menuPos 每次打开都变化，"今天/明天"以打开时刻为准，
  // 避免 useMemo 捕获渲染时的 now、组件常驻跨午夜后日期过期
  const options = useMemo(() => {
    if (!menuPos) return [];
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
  }, [menuPos, item.dueDate, t]);

  const handlePick = useCallback(
    (date: string) => {
      setMenuPos(null);
      void updateItem({ id: item.id, dueDate: date });
    },
    [item.id, updateItem],
  );

  return (
    <>
      <NotionButton
        variant="utility"
        size="icon"
        iconOnly
        onClick={(e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          // 菜单宽 144px；贴右对齐按钮，靠近视口底部时向上弹
          // 触屏菜单项更高（44px），预估高度按触屏放大避免底部溢出
          const estimatedMenuHeight = window.matchMedia('(pointer: coarse)').matches ? 220 : 160;
          const openUp = rect.bottom + estimatedMenuHeight > window.innerHeight;
          setMenuPos({
            x: Math.max(8, rect.right - 144),
            y: openUp ? rect.top - 4 : rect.bottom + 4,
            openUp,
          });
        }}
        title={t('todo:reschedule.title')}
        aria-label={t('todo:reschedule.title')}
        className="flex-shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-60 !p-1.5 [@media(pointer:coarse)]:!p-3 [@media(pointer:coarse)]:!-m-1.5"
      >
        <CalendarPlus size={16} />
      </NotionButton>
      {menuPos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('todo:reschedule.title')}
          className="fixed z-50 w-36 rounded-[var(--radius-shell-control)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root,var(--background))] py-1 shadow-xl"
          style={
            menuPos.openUp
              ? { left: menuPos.x, bottom: window.innerHeight - menuPos.y }
              : { left: menuPos.x, top: menuPos.y }
          }
          onClick={(e) => e.stopPropagation()}
        >
          {options.map((opt) => (
            <button
              key={opt.key}
              role="menuitem"
              onClick={() => handlePick(opt.date)}
              className={cn(
                'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                '[@media(pointer:coarse)]:min-h-[2.75rem]',
                'hover:bg-[color:var(--interactive-hover)]',
                opt.key === 'clear' ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              <span>{opt.label}</span>
              {opt.hint && <span className="text-[10px] text-muted-foreground">{opt.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
};

interface TodoItemRowProps {
  item: TodoItem;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  isSelected: boolean;
  /** 子任务缩进层级（0 = 顶层） */
  depth?: number;
  /** 子任务完成进度（仅父任务显示） */
  subtaskProgress?: { done: number; total: number };
  /** 拖拽手柄（仅手动排序视图传入） */
  dragHandle?: React.ReactNode;
}

const TodoItemRow: React.FC<TodoItemRowProps> = ({
  item,
  onToggle,
  onSelect,
  onDelete,
  isSelected,
  depth = 0,
  subtaskProgress,
  dragHandle,
}) => {
  const { t } = useTranslation(['todo']);
  const overdue = isOverdue(item);
  const dueToday = isDueToday(item);
  const tags = parseTags(item.tagsJson);
  const isCompleted = item.status === 'completed';
  const repeatRule = parseRepeatRule(item.repeatJson);

  return (
    <div
      data-selected={isSelected}
      data-agent-entity={`todo:${item.id}`}
      className={cn(
        'group relative flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-100 sm:px-6',
        'hover:bg-[color:var(--interactive-hover)]',
        'data-[selected=true]:bg-[color:var(--interactive-selected)]',
        isCompleted && 'opacity-60',
      )}
      style={depth > 0 ? { paddingLeft: `${16 + depth * 28}px` } : undefined}
      onClick={() => onSelect(item.id)}
    >
      {dragHandle}

      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle(item.id);
        }}
        // 触屏：透明 padding 扩大命中到 ≥44px，负 margin 保持布局不变
        className="flex-shrink-0 transition-transform duration-150 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] focus-visible:ring-offset-1 rounded-full [@media(pointer:coarse)]:p-3 [@media(pointer:coarse)]:-m-3"
        aria-label={isCompleted ? t('todo:actions.markPending') : t('todo:actions.markCompleted')}
      >
        {isCompleted ? (
          <CheckCircle size={20} className="text-[color:hsl(var(--success))]" />
        ) : (
          <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-[color:var(--border-default)] transition-colors group-hover:border-[color:hsl(var(--primary))] group-focus-within:border-[color:hsl(var(--primary))]">
            <Check size={12} className="text-[color:hsl(var(--primary))] opacity-0 transition-opacity group-hover:opacity-40 group-focus-within:opacity-40" />
          </div>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div
          className={cn(
            'truncate text-sm transition-all duration-150',
            isCompleted
              ? 'text-muted-foreground line-through'
              : 'font-medium text-foreground',
          )}
        >
          {item.title}
        </div>

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
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                title={t('todo:subtasks.progress', {
                  done: subtaskProgress.done,
                  total: subtaskProgress.total,
                })}
              >
                <TreeStructure size={12} />
                {subtaskProgress.done}/{subtaskProgress.total}
              </span>
            )}

            {item.estimatedPomodoros ? (
              <span
                className="study-shell-badge study-shell-badge--warning"
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
              <span className="inline-flex items-center gap-1 text-[11px]">
                <PriorityIcon priority={item.priority as TodoPriority} className="h-3 w-3" />
                <span className="text-muted-foreground">
                  {t(PRIORITY_CONFIG[item.priority as TodoPriority].labelKey)}
                </span>
              </span>
            )}

            {item.dueDate && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[11px]',
                  overdue
                    ? 'font-medium text-[color:hsl(var(--destructive))]'
                    : dueToday
                    ? 'font-medium text-[color:hsl(var(--primary))]'
                    : 'text-muted-foreground',
                )}
              >
                <Calendar size={12} />
                {item.dueDate}
                {item.dueTime && ` ${item.dueTime}`}
              </span>
            )}

            {repeatRule && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Repeat size={12} />
                {repeatRuleLabel(repeatRule, t)}
              </span>
            )}

            {item.reminder && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
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

      {!isCompleted && <RescheduleButton item={item} />}

      {!isCompleted && (
        <NotionButton
          variant="utility"
          size="icon"
          iconOnly
          onClick={(e) => {
            e.stopPropagation();
            usePomodoroStore.getState().start(item.id, item.title);
          }}
          title={t('todo:actions.startFocusSession')}
          aria-label={t('todo:actions.startFocusSession')}
          className="flex-shrink-0 opacity-40 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 !p-1.5 [@media(pointer:coarse)]:!p-3 [@media(pointer:coarse)]:!-m-1.5"
        >
          <Play size={16} />
        </NotionButton>
      )}

      <NotionButton
        variant="utility"
        size="icon"
        iconOnly
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item.id);
        }}
        title={t('todo:actions.deleteItem')}
        aria-label={t('todo:actions.deleteItem')}
        className="flex-shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60 !p-1.5 [@media(pointer:coarse)]:!p-3 [@media(pointer:coarse)]:!-m-1.5 hover:!bg-[color:var(--button-danger-surface)] hover:!text-[color:hsl(var(--destructive))]"
      >
        <Trash size={16} />
      </NotionButton>
    </div>
  );
};

// ============================================================================
// SortableTodoItemRow — 拖拽排序包装（仅 'all' 视图顶层任务）
// ============================================================================

const SortableTodoItemRow: React.FC<
  Omit<TodoItemRowProps, 'dragHandle'>
> = (props) => {
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
              // 触屏无 hover：手柄常显淡色，长按可拖拽排序（否则功能不可发现）
              '[@media(pointer:coarse)]:text-muted-foreground/50',
            )}
          >
            <DotsSixVertical size={14} weight="bold" />
          </button>
        }
      />
    </div>
  );
};

// ============================================================================
// TodoItemDetail
// ============================================================================

const TodoItemDetail: React.FC<{
  item: TodoItem;
  onClose: () => void;
  className?: string;
  /** 移动端子屏承载时隐藏右上角关闭按钮（返回统一走顶栏返回箭头/系统返回键） */
  hideCloseButton?: boolean;
}> = ({ item, onClose, className, hideCloseButton }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { items, updateItem, toggleItem, deleteItem, createItem, reloadCurrentView } = useTodoStore();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description || '');
  const [priority, setPriority] = useState<TodoPriority>(item.priority as TodoPriority);
  const [dueDate, setDueDate] = useState(item.dueDate || '');
  const [dueTime, setDueTime] = useState(item.dueTime || '');
  const [reminder, setReminder] = useState(item.reminder || '');
  const [estimatedPomodoros, setEstimatedPomodoros] = useState(item.estimatedPomodoros || 0);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [pomodoroHistory, setPomodoroHistory] = useState<PomodoroRecord[]>([]);
  const [aiBreaking, setAiBreaking] = useState(false);
  const [aiBreakdownError, setAiBreakdownError] = useState<string | null>(null);

  // 任务的专注历史（completedPomodoros 变化时刷新——新完成番茄后同步）
  useEffect(() => {
    let cancelled = false;
    listPomodorosByTodo(item.id)
      .then((records) => {
        if (!cancelled) {
          setPomodoroHistory(records.filter((r) => r.type === 'work'));
        }
      })
      .catch(() => {
        if (!cancelled) setPomodoroHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.completedPomodoros]);

  // 标签直接从 item 派生（updateItem 后 store 刷新，prop 同步更新）
  const tags = useMemo(() => parseTags(item.tagsJson), [item.tagsJson]);

  const handleAddTag = useCallback(() => {
    const trimmed = tagInput.trim().replace(/^#/, '');
    if (!trimmed) return;
    setTagInput('');
    if (tags.includes(trimmed)) return;
    void updateItem({ id: item.id, tags: [...tags, trimmed] });
  }, [tagInput, tags, item.id, updateItem]);

  const handleRemoveTag = useCallback(
    (tag: string) => {
      void updateItem({ id: item.id, tags: tags.filter((t) => t !== tag) });
    },
    [tags, item.id, updateItem],
  );

  // 子任务（顶层任务才显示子任务区；不支持多级嵌套）
  const subtasks = useMemo(
    () => items.filter((i) => i.parentId === item.id),
    [items, item.id],
  );
  const isSubtask = Boolean(item.parentId);

  // 重复规则直接从 item 派生（updateItem 后 store 刷新，prop 同步更新）
  const repeatRule = useMemo(() => parseRepeatRule(item.repeatJson), [item.repeatJson]);

  // 下次出现预览（基于当前到期日推进一步，逾期则跳到 >= 今天）
  const nextOccurrence = useMemo(() => {
    if (!repeatRule || !item.dueDate) return null;
    return nextRepeatOccurrence(repeatRule, item.dueDate);
  }, [repeatRule, item.dueDate]);

  const handleRepeatChange = useCallback(
    (freq: TodoRepeatFreq | 'none') => {
      const changes: UpdateTodoItemInput = { id: item.id };
      if (freq === 'none') {
        changes.repeatJson = '';
      } else {
        // 同频率保留 quickAdd 解析出的自定义间隔与多选星期
        const sameFreq = repeatRule && repeatRule.freq === freq;
        const interval = sameFreq ? repeatRule.interval : 1;
        const byWeekday = sameFreq && freq === 'weekly' ? repeatRule.byWeekday : undefined;
        changes.repeatJson = serializeRepeatRule({ freq, interval, byWeekday });
        // 重复任务必须有到期日（后端生成下一次依赖 dueDate）
        if (!dueDate) {
          const today = localToday();
          changes.dueDate = today;
          setDueDate(today);
        }
      }
      void updateItem(changes);
    },
    [item.id, repeatRule, dueDate, updateItem],
  );

  /** weekly 多选星期切换（全部取消则回到普通每周） */
  const handleToggleWeekday = useCallback(
    (day: number) => {
      if (!repeatRule || repeatRule.freq !== 'weekly') return;
      const current = repeatRule.byWeekday ?? [];
      const next = current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b);
      void updateItem({
        id: item.id,
        repeatJson: serializeRepeatRule({
          ...repeatRule,
          byWeekday: next.length > 0 ? next : undefined,
        }),
      });
    },
    [item.id, repeatRule, updateItem],
  );

  const handleAddSubtask = useCallback(async () => {
    const trimmed = newSubtaskTitle.trim();
    if (!trimmed) return;
    setNewSubtaskTitle('');
    try {
      await createItem({
        todoListId: item.todoListId,
        title: trimmed,
        parentId: item.id,
      });
    } catch {
      // error handled in store
    }
  }, [newSubtaskTitle, createItem, item.todoListId, item.id]);

  /** AI 拆解：后端生成子任务并落库，完成后刷新当前视图 */
  const handleAiBreakdown = useCallback(async () => {
    if (aiBreaking) return;
    setAiBreaking(true);
    setAiBreakdownError(null);
    try {
      await aiBreakdownTodo(item.id);
      await reloadCurrentView();
    } catch (err) {
      setAiBreakdownError(String(err));
    } finally {
      setAiBreaking(false);
    }
  }, [aiBreaking, item.id, reloadCurrentView]);

  const handleSave = useCallback(async () => {
    const changes: UpdateTodoItemInput = { id: item.id };
    let hasChanges = false;
    if (title !== item.title) {
      changes.title = title;
      hasChanges = true;
    }
    if (description !== (item.description || '')) {
      changes.description = description;
      hasChanges = true;
    }
    if (priority !== item.priority) {
      changes.priority = priority;
      hasChanges = true;
    }
    if (dueDate !== (item.dueDate || '')) {
      changes.dueDate = dueDate;
      hasChanges = true;
    }
    if (dueTime !== (item.dueTime || '')) {
      changes.dueTime = dueTime;
      hasChanges = true;
    }
    if (reminder !== (item.reminder || '')) {
      changes.reminder = reminder;
      hasChanges = true;
    }
    if (estimatedPomodoros !== (item.estimatedPomodoros || 0)) {
      changes.estimatedPomodoros = estimatedPomodoros;
      hasChanges = true;
    }

    if (hasChanges) {
      await updateItem(changes);
    }
  }, [item, title, description, priority, dueDate, dueTime, reminder, estimatedPomodoros, updateItem]);

  const handleBlur = useCallback(() => {
    handleSave();
  }, [handleSave]);

  const isCompleted = item.status === 'completed';

  return (
    <aside
      data-todo-detail-panel
      className={cn(
        'flex h-full flex-col bg-[color:var(--shell-inspector-panel)]',
        className,
      )}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => toggleItem(item.id)}
            className="transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] focus-visible:ring-offset-1 rounded-full [@media(pointer:coarse)]:p-3 [@media(pointer:coarse)]:-m-3"
            aria-label={isCompleted ? t('todo:actions.markPending') : t('todo:actions.markCompleted')}
          >
            {isCompleted ? (
              <CheckCircle size={20} className="text-[color:hsl(var(--success))]" />
            ) : (
              <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-[color:var(--border-default)] hover:border-[color:hsl(var(--primary))]">
                <Check size={12} className="text-[color:hsl(var(--primary))] opacity-0" />
              </div>
            )}
          </button>
          <span className="text-sm font-medium text-muted-foreground">
            {t('todo:detail.title')}
          </span>
        </div>
        {!hideCloseButton && (
          <NotionButton
            variant="utility"
            size="icon"
            iconOnly
            onClick={onClose}
            aria-label={t('common:actions.close')}
            className="!p-1.5"
          >
            <X size={16} />
          </NotionButton>
        )}
      </div>

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-5 py-5 space-y-5">
        <Textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleBlur}
          className={cn(
            'w-full resize-none overflow-hidden bg-transparent border-0 focus-visible:ring-0 text-lg font-semibold tracking-tight leading-tight placeholder:text-muted-foreground/50 transition-colors min-h-0',
            isCompleted && 'text-muted-foreground line-through',
          )}
          rows={2}
          placeholder={t('todo:placeholders.title')}
        />

        {/* 属性面板 — 扁平列表，不用卡片包裹 */}
        <div className="space-y-1">
          <div className="flex items-center gap-3 py-1">
            <span className="w-[4.75rem] flex-shrink-0 text-xs text-muted-foreground">
              {t('todo:fields.priority')}
            </span>
            <SegmentedControl<TodoPriority>
              ariaLabel={t('todo:fields.priority')}
              value={priority}
              onValueChange={(p) => {
                setPriority(p);
                updateItem({ id: item.id, priority: p });
              }}
              size="compact"
              className="flex-wrap"
              itemClassName="!h-auto !px-2 !py-0.5 text-[11px] font-medium"
              options={(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => {
                const isActive = priority === p;
                return {
                  value: p,
                  title: t(PRIORITY_CONFIG[p].labelKey),
                  label: (
                    <span className={isActive ? PRIORITY_CONFIG[p].color : ''}>
                      {t(PRIORITY_CONFIG[p].labelKey)}
                    </span>
                  ),
                };
              })}
            />
          </div>

          <div className="flex items-center gap-3 py-1">
            <span className="flex w-[4.75rem] flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar size={14} />
              {t('todo:fields.dueDate')}
            </span>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              onBlur={handleBlur}
              className="flex-1"
            />
          </div>

          {dueDate && (
            <div className="flex items-center gap-3 py-1">
              <span className="w-[4.75rem] flex-shrink-0 text-xs text-muted-foreground">
                {t('todo:fields.dueTime')}
              </span>
              <Input
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                onBlur={handleBlur}
                className="flex-1"
              />
            </div>
          )}

          <div className="flex items-center gap-3 py-1">
            <span className="flex w-[4.75rem] flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Bell size={14} />
              {t('todo:fields.reminder')}
            </span>
            <div className="flex flex-1 items-center gap-1.5">
              <Input
                type="datetime-local"
                value={reminder}
                onChange={(e) => setReminder(e.target.value)}
                onBlur={handleBlur}
                className="flex-1"
              />
              {reminder && (
                <NotionButton
                  variant="utility"
                  size="icon"
                  iconOnly
                  onClick={() => {
                    setReminder('');
                    void updateItem({ id: item.id, reminder: '' });
                  }}
                  aria-label={t('todo:reminder.clear')}
                  className="!p-1"
                >
                  <X size={13} />
                </NotionButton>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 py-1">
            <span className="flex w-[4.75rem] flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Repeat size={14} />
              {t('todo:fields.repeat')}
            </span>
            <SegmentedControl<TodoRepeatFreq | 'none'>
              ariaLabel={t('todo:fields.repeat')}
              value={repeatRule?.freq ?? 'none'}
              onValueChange={handleRepeatChange}
              size="compact"
              className="flex-wrap"
              itemClassName="!h-auto !px-2 !py-0.5 text-[11px] font-medium"
              options={REPEAT_OPTIONS.map((opt) => ({
                value: opt.value,
                title: t(opt.labelKey),
                label: <span>{t(opt.labelKey)}</span>,
              }))}
            />
          </div>

          <div className="flex items-start gap-3 py-1">
            <span className="flex w-[4.75rem] flex-shrink-0 items-center gap-1.5 pt-1.5 text-xs text-muted-foreground">
              <Tag size={14} />
              {t('todo:fields.tags')}
            </span>
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    aria-label={t('todo:tags.remove', { tag })}
                    className="rounded-full hover:text-foreground focus:outline-none [@media(pointer:coarse)]:p-2 [@media(pointer:coarse)]:-m-2"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    handleAddTag();
                  }
                  if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                    handleRemoveTag(tags[tags.length - 1]);
                  }
                }}
                onBlur={handleAddTag}
                placeholder={t('todo:tags.addPlaceholder')}
                className="h-6 w-28 min-w-0 flex-shrink-0 border-0 bg-transparent px-1 text-xs focus-visible:ring-0 placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {/* weekly：多选星期（如「每周一、三、五」） */}
          {repeatRule?.freq === 'weekly' && (
            <div className="flex items-center gap-3 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <div
                className="flex flex-wrap items-center gap-1"
                role="group"
                aria-label={t('todo:repeat.pickWeekdays')}
              >
                {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                  const active = repeatRule.byWeekday?.includes(day) ?? false;
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={active}
                      onClick={() => handleToggleWeekday(day)}
                      className={cn(
                        'h-6 w-6 rounded-full text-[11px] font-medium transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-[color:var(--interactive-hover)]',
                      )}
                    >
                      {t(`todo:repeat.weekdayShort.${day}`)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {repeatRule && (repeatRule.interval > 1 || (repeatRule.byWeekday?.length ?? 0) > 0) && (
            <div className="flex items-center gap-3 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <span className="text-[11px] text-muted-foreground">
                {repeatRuleLabel(repeatRule, t)}
              </span>
            </div>
          )}

          {/* 重复任务：下次出现预览（完成当前后将滚动到该日期） */}
          {repeatRule && nextOccurrence && (
            <div className="flex items-center gap-3 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
                <ArrowRight size={11} />
                {t('todo:repeat.nextOccurrence', { date: nextOccurrence })}
              </span>
            </div>
          )}

          <div className="flex items-center gap-3 py-1">
            <span className="flex w-[4.75rem] flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Brain size={14} />
                  {t('todo:fields.pomodoros')}
            </span>
            <div className="flex flex-1 items-center gap-2">
              <Input
                type="number"
                min={0}
                max={99}
                value={estimatedPomodoros || ''}
                onChange={(e) => setEstimatedPomodoros(Number(e.target.value) || 0)}
                onBlur={handleBlur}
                placeholder="0"
                className="w-20"
              />
              {(item.completedPomodoros || 0) > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  {t('todo:pomodoro.completedCount', { count: item.completedPomodoros || 0 })}
                </span>
              )}
            </div>
          </div>

          {/* 番茄进度条 */}
          {Boolean(estimatedPomodoros) && (
            <div className="flex items-center gap-3 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <div className="flex flex-1 items-center gap-1">
                {Array.from({ length: Math.min(estimatedPomodoros, 20) }).map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-1.5 flex-1 rounded-full',
                      i < (item.completedPomodoros || 0)
                        ? 'bg-[color:hsl(var(--warning))]'
                        : 'bg-[color:var(--shell-workspace-border)]',
                    )}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 子任务区（仅顶层任务） */}
        {!isSubtask && (
          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('todo:subtasks.title')}
                {subtasks.length > 0 && (
                  <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">
                    {subtasks.filter((s) => s.status === 'completed').length}/{subtasks.length}
                  </span>
                )}
              </span>
              <button
                onClick={() => void handleAiBreakdown()}
                disabled={aiBreaking}
                className={cn(
                  'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                  aiBreaking
                    ? 'cursor-default text-muted-foreground/50'
                    : 'text-muted-foreground hover:bg-[color:var(--interactive-hover)] hover:text-foreground',
                )}
                title={t('todo:subtasks.aiBreakdownHint')}
              >
                {aiBreaking ? (
                  <CircleNotch size={12} className="animate-spin" />
                ) : (
                  <Sparkle size={12} />
                )}
                {aiBreaking ? t('todo:subtasks.aiBreaking') : t('todo:subtasks.aiBreakdown')}
              </button>
            </div>
            {aiBreakdownError && (
              <p className="px-1 text-[11px] text-[color:hsl(var(--destructive))]">
                {aiBreakdownError}
              </p>
            )}

            {subtasks.map((sub) => (
              <div
                key={sub.id}
                className="group/subtask flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-[color:var(--interactive-hover)]"
              >
                <button
                  onClick={() => toggleItem(sub.id)}
                  className="flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] [@media(pointer:coarse)]:p-3 [@media(pointer:coarse)]:-m-3"
                  aria-label={
                    sub.status === 'completed'
                      ? t('todo:actions.markPending')
                      : t('todo:actions.markCompleted')
                  }
                >
                  {sub.status === 'completed' ? (
                    <CheckCircle size={16} className="text-[color:hsl(var(--success))]" />
                  ) : (
                    <span className="block h-4 w-4 rounded-full border-[1.5px] border-[color:var(--border-default)] hover:border-[color:hsl(var(--primary))]" />
                  )}
                </button>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px]',
                    sub.status === 'completed' && 'text-muted-foreground line-through',
                  )}
                >
                  {sub.title}
                </span>
                <button
                  onClick={() => deleteItem(sub.id)}
                  aria-label={t('todo:actions.deleteItem')}
                  title={t('todo:actions.deleteItem')}
                  // 触屏无 hover：常显淡色并扩大命中（否则子任务删除不可发现/难点中）
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-[color:hsl(var(--destructive))] group-hover/subtask:opacity-100 [@media(pointer:coarse)]:opacity-60 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:-my-3 [@media(pointer:coarse)]:-mr-3"
                >
                  <X size={12} />
                </button>
              </div>
            ))}

            <div className="flex items-center gap-2 px-1">
              <Plus size={14} className="flex-shrink-0 text-muted-foreground/60" />
              <Input
                value={newSubtaskTitle}
                onChange={(e) => setNewSubtaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddSubtask();
                  }
                }}
                placeholder={t('todo:subtasks.addPlaceholder')}
                className="h-7 flex-1 border-0 bg-transparent px-0 text-[13px] focus-visible:ring-0 placeholder:text-muted-foreground/50"
              />
            </div>
          </div>
        )}

        <div className="space-y-2 pt-2">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('todo:fields.description')}
          </span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={handleBlur}
            placeholder={t('todo:placeholders.description')}
            rows={8}
            className="w-full resize-none leading-relaxed"
          />
        </div>

        {/* 专注历史（有记录才显示） */}
        {pomodoroHistory.length > 0 && (
          <div className="space-y-1.5 pt-2">
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('todo:focusHistory.title')}
              <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">
                {t('todo:focusHistory.summary', {
                  count: pomodoroHistory.filter((r) => r.status === 'completed').length,
                  minutes: Math.round(
                    pomodoroHistory.reduce((acc, r) => acc + r.actualDuration, 0) / 60,
                  ),
                })}
              </span>
            </span>
            <div className="space-y-0.5">
              {pomodoroHistory.slice(0, 8).map((record) => {
                const start = new Date(record.startTime);
                const minutes = Math.max(1, Math.round(record.actualDuration / 60));
                return (
                  <div
                    key={record.id}
                    className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-muted-foreground"
                  >
                    {record.status === 'completed' ? (
                      <CheckCircle size={13} className="flex-shrink-0 text-[color:hsl(var(--success))]" />
                    ) : (
                      <X size={13} className="flex-shrink-0 text-[color:hsl(var(--destructive))]/70" />
                    )}
                    <span className="flex-1 tabular-nums">
                      {start.toLocaleDateString()} {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="tabular-nums">
                      {t('todo:focusHistory.minutes', { count: minutes })}
                    </span>
                  </div>
                );
              })}
              {pomodoroHistory.length > 8 && (
                <div className="px-1 text-[11px] text-muted-foreground/60">
                  {t('todo:focusHistory.more', { count: pomodoroHistory.length - 8 })}
                </div>
              )}
            </div>
          </div>
        )}
      </CustomScrollArea>

      <div className="flex items-center justify-between px-4 py-3 pb-[calc(0.75rem+var(--mobile-safe-area-bottom,0px))]">
        <span className="text-xs text-muted-foreground">
          {item.updatedAt
            ? t('todo:detail.updatedAt', {
                date: new Date(item.updatedAt).toLocaleDateString(),
              })
            : ''}
        </span>
        <NotionButton
          variant="danger"
          size="sm"
          onClick={() => {
            deleteItem(item.id);
            onClose();
          }}
          className="gap-1.5"
        >
          <Trash size={16} />
          {t('common:actions.delete')}
        </NotionButton>
      </div>
    </aside>
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
        window.dispatchEvent(
          new CustomEvent('navigate-to-tab', { detail: { tabName: 'learning-hub' } }),
        );
      }}
      className={cn(
        'group mx-4 mt-3 flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5 text-left transition-colors sm:mx-6',
        'hover:border-border hover:bg-[color:var(--interactive-hover)]',
      )}
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[color:hsl(var(--info))]/10 text-[color:hsl(var(--info))]">
        <Brain size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-foreground">
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
  const { t } = useTranslation(['todo']);
  const { isSmallScreen } = useBreakpoint();
  const {
    items,
    activeListId,
    lists,
    isLoadingItems,
    filter,
    selectedItemId,
    toggleItem,
    deleteItem,
    reorderItems,
    selectItem,
    setSearch,
    setShowCompleted,
    setSortBy,
  } = useTodoStore();

  const activeList = lists.find((l) => l.id === activeListId);
  const selectedItem = items.find((i) => i.id === selectedItemId);

  // 键盘快捷键：/ 聚焦搜索，n 聚焦快速添加（仅 Todo 页面、非输入态生效）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (useViewStore.getState().currentView !== 'todo') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-todo-search]')?.focus();
      } else if (e.key === 'n' || e.key === 'N') {
        const quickAdd = document.querySelector<HTMLInputElement>('[data-todo-quick-add]');
        if (quickAdd) {
          e.preventDefault();
          quickAdd.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const filteredItems = useMemo(() => {
    const visible = items.filter((item) => {
      if (filter.priorityFilter && item.priority !== filter.priorityFilter) return false;
      if (filter.view !== 'completed' && !filter.showCompleted && item.status === 'completed')
        return false;
      return true;
    });
    return sortTodoItems(visible, filter.sortBy);
  }, [items, filter.priorityFilter, filter.showCompleted, filter.view, filter.sortBy]);

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const completedCount = items.filter((i) => i.status === 'completed').length;

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

  // 计算子任务进度（含被 showCompleted 过滤掉的已完成子任务，进度才真实）
  const subtaskProgressOf = useCallback(
    (parentId: string): { done: number; total: number } | undefined => {
      const all = items.filter((i) => i.parentId === parentId);
      if (all.length === 0) return undefined;
      return {
        done: all.filter((i) => i.status === 'completed').length,
        total: all.length,
      };
    },
    [items],
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

  // 空态按视图差异化：清零类视图用庆祝语气（对齐 Todoist「Todoist Zero」体验）
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
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <div className="relative">
              <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" size={14} />
              <Input
                type="text"
                value={filter.search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('todo:actions.search')}
                data-todo-search
                className="h-8 w-28 pl-8 pr-3 text-xs sm:w-56"
              />
            </div>

            <Select value={filter.sortBy} onValueChange={(v) => setSortBy(v as TodoSortBy)}>
              <SelectTrigger
                aria-label={t('todo:sort.label')}
                className="!h-8 !min-h-0 !w-auto gap-1 !px-2.5 !py-0 text-xs"
              >
                <SortAscending size={14} className="text-muted-foreground" />
                {/* !hidden：对抗 SelectTrigger 基类的 [&>span]:line-clamp-1（会把 span 重置为 -webkit-box） */}
                <span className="!hidden sm:!inline">
                  {t(`todo:sort.${filter.sortBy}`)}
                </span>
              </SelectTrigger>
              <SelectContent align="end">
                {(['manual', 'dueDate', 'priority', 'title'] as TodoSortBy[]).map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {t(`todo:sort.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <NotionButton
              variant="utility"
              size="sm"
              onClick={() => setShowCompleted(!filter.showCompleted)}
              disabled={filter.view === 'completed'}
              data-selected={filter.showCompleted}
              className={cn(
                'h-8 gap-1.5 !px-2.5 text-xs',
                filter.showCompleted &&
                  '!bg-[color:var(--button-primary-surface)] !text-[color:var(--button-primary-foreground)]',
              )}
            >
              <CheckCircle size={14} />
              <span className="hidden sm:inline">{t('todo:filters.showCompleted')}</span>
            </NotionButton>
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <CustomScrollArea className="flex-1 min-h-0" viewportClassName="pb-6">
            {filter.view === 'all' && (
              <>
                <TodoQuickAdd />
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
                    emptyState.celebratory && '!text-[color:hsl(var(--success))]',
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
                          onSelect={selectItem}
                          onDelete={deleteItem}
                          isSelected={selectedItemId === item.id}
                          subtaskProgress={subtaskProgressOf(item.id)}
                        />
                        {(childrenByParent.get(item.id) || []).map((child) => (
                          <TodoItemRow
                            key={child.id}
                            item={child}
                            onToggle={toggleItem}
                            onSelect={selectItem}
                            onDelete={deleteItem}
                            isSelected={selectedItemId === child.id}
                            depth={1}
                          />
                        ))}
                      </React.Fragment>
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : isTreeView ? (
              <div className="flex flex-col divide-y divide-border/[0.08]">
                {topLevelItems.map((item) => (
                  <React.Fragment key={item.id}>
                    <TodoItemRow
                      item={item}
                      onToggle={toggleItem}
                      onSelect={selectItem}
                      onDelete={deleteItem}
                      isSelected={selectedItemId === item.id}
                      subtaskProgress={subtaskProgressOf(item.id)}
                    />
                    {(childrenByParent.get(item.id) || []).map((child) => (
                      <TodoItemRow
                        key={child.id}
                        item={child}
                        onToggle={toggleItem}
                        onSelect={selectItem}
                        onDelete={deleteItem}
                        isSelected={selectedItemId === child.id}
                        depth={1}
                      />
                    ))}
                  </React.Fragment>
                ))}
              </div>
            ) : matrixQuadrants ? (
              <div className="grid grid-cols-1 gap-3 p-4 sm:p-6 lg:grid-cols-2">
                {EISENHOWER_QUADRANTS.map((quadrant) => {
                  const quadItems = matrixQuadrants[quadrant];
                  const accents: Record<EisenhowerQuadrant, string> = {
                    urgentImportant: 'text-[color:hsl(var(--destructive))]',
                    importantNotUrgent: 'text-[color:hsl(var(--warning))]',
                    urgentNotImportant: 'text-[color:hsl(var(--info))]',
                    neither: 'text-muted-foreground',
                  };
                  return (
                    <div
                      key={quadrant}
                      className="flex min-h-[180px] flex-col rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)]/60 bg-[color:var(--surface-raised,transparent)]"
                    >
                      <div className="flex items-center gap-2 px-3 py-2">
                        <span className={cn('text-xs font-semibold', accents[quadrant])}>
                          {t(`todo:matrix.${quadrant}`)}
                        </span>
                        <span className="text-[11px] tabular-nums text-muted-foreground/50">
                          {quadItems.length}
                        </span>
                      </div>
                      <div className="flex min-h-0 flex-1 flex-col divide-y divide-border/[0.08]">
                        {quadItems.length === 0 ? (
                          <div className="flex flex-1 items-center justify-center py-6 text-xs text-muted-foreground/40">
                            {t('todo:matrix.empty')}
                          </div>
                        ) : (
                          quadItems.map((item) => (
                            <TodoItemRow
                              key={item.id}
                              item={item}
                              onToggle={toggleItem}
                              onSelect={selectItem}
                              onDelete={deleteItem}
                              isSelected={selectedItemId === item.id}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : upcomingGroups ? (
              <div className="flex flex-col">
                {upcomingGroups.map((group) => (
                  <div key={group.bucket}>
                    <div className="sticky top-0 z-[1] flex items-center gap-2 bg-[color:var(--surface-root)]/95 px-4 pb-1 pt-3 backdrop-blur-sm sm:px-6">
                      <span
                        className={cn(
                          'text-[11px] font-semibold uppercase tracking-wide',
                          group.bucket === 'overdue'
                            ? 'text-[color:hsl(var(--destructive))]'
                            : 'text-muted-foreground',
                        )}
                      >
                        {t(`todo:groups.${group.bucket}`)}
                      </span>
                      <span className="text-[11px] tabular-nums text-muted-foreground/50">
                        {group.items.length}
                      </span>
                    </div>
                    <div className="flex flex-col divide-y divide-border/[0.08]">
                      {group.items.map((item) => (
                        <TodoItemRow
                          key={item.id}
                          item={item}
                          onToggle={toggleItem}
                          onSelect={selectItem}
                          onDelete={deleteItem}
                          isSelected={selectedItemId === item.id}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-border/[0.08]">
                {filteredItems.map((item) => (
                  <TodoItemRow
                    key={item.id}
                    item={item}
                    onToggle={toggleItem}
                    onSelect={selectItem}
                    onDelete={deleteItem}
                    isSelected={selectedItemId === item.id}
                  />
                ))}
              </div>
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
