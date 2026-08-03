/**
 * TodoItemDetail — 右侧详情面板（桌面 360px 抽屉 / 移动端全屏子屏共用）
 *
 * - 本地编辑态通过 useEffect 跟随 item 字段（行内改期/改名等外部更新不再陈旧）
 * - 属性行统一 12px 圆角 + --interactive-hover 悬停；分区之间以 --border-default 分隔线呼吸
 * - 日期：内联月历（MiniCalendar，InlineReveal 展开）+ 快捷 chip（今天/明天/周末/下周一）；
 *   提醒：准点/提前 15 分/提前 1 小时预设 + datetime-local 自定义兜底
 * - 标题/备注无边框行内编辑，自动增高；标题 Enter 提交、Shift+Enter 换行；
 *   两者 Esc 还原本字段并失焦（不冒泡关面板）
 * - 键盘：面板级 Esc 收起（先收内联日历）、⌘/Ctrl+Enter 立即保存
 * - 字段保存成功后顶栏对勾闪现（SaveTick）；删除走内联二次确认（无 Dialog）
 * - 顶栏勾选复用列表的 todo-check-pop 弹性动效（todo-motion.css 归 F2，只引用类名）
 * - 重复任务必须有锚定日期：清空到期日自动回填今天并给出内联提示
 * - 卸载（关面板/切任务）时无条件冲刷防抖保存，快速切换不丢编辑、不串写（面板按 item.id 挂 key）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Bell,
  Brain,
  Calendar,
  CaretDown,
  Check,
  CheckCircle,
  Play,
  Repeat,
  Tag,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { usePomodoroStore } from '@/features/pomodoro';
import { listPomodorosByTodo, type PomodoroRecord } from '@/features/pomodoro/api';
import { listAllTags } from '../../api';
import { useTodoStore } from '../../stores/useTodoStore';
import type {
  TodoItem,
  TodoPriority,
  TodoRepeatFreq,
  UpdateTodoItemInput,
} from '../../types';
import {
  PRIORITY_CONFIG,
  REPEAT_OPTIONS,
  localToday,
  nextRepeatOccurrence,
  parseRepeatRule,
  parseTags,
  repeatRuleLabel,
  serializeRepeatRule,
} from '../../types';
import '../../styles/todo-motion.css';
import { formatDueDateLabel } from './dueDateLabel';
import { InlineReveal } from './detail/InlineReveal';
import { QuickChip } from './detail/QuickChip';
import {
  REMINDER_QUICK_OFFSETS,
  getQuickDateOptions,
  normalizeReminderValue,
  reminderFromDue,
} from './detail/quickOptions';
import { MiniCalendar } from './detail/MiniCalendar';
import { PomodoroDots } from './detail/PomodoroDots';
import { SaveTick } from './detail/SaveTick';
import { InlineConfirmDelete } from './detail/InlineConfirmDelete';
import { TagsEditor } from './detail/TagsEditor';
import { SubtaskSection } from './detail/SubtaskSection';
import { FocusHistorySection } from './detail/FocusHistorySection';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

/** 属性行统一视觉：12px 圆角、悬停 --interactive-hover（对齐设计规范） */
const PROPERTY_ROW_CLASS =
  'flex items-center gap-3 rounded-[var(--radius-shell-control)] px-2 -mx-2 py-1.5 transition-colors duration-150 hover:bg-[color:var(--interactive-hover)]';

/** 分区分隔（统一 --border-default 分隔线 + 呼吸间距） */
const SECTION_CLASS = 'border-t border-[color:var(--border-default)] pt-4';

/** chip 行缩进（与属性行的标签列对齐） */
const CHIP_INDENT_CLASS = 'flex items-start gap-3 px-2 -mx-2';

/** 勾选弹性动效时长（todo-check-pop 为 260ms，留缓冲后复位状态） */
const CHECK_POP_MS = 300;

/** 内联提示自动收起时长 */
const HINT_DISMISS_MS = 4000;

/**
 * TodoMainPanel 在 document 上监听的列表快捷键（j/k 导航、Space/x 勾选、
 * Delete 删除、n/「/」聚焦输入等）。面板内的按键统一阻断冒泡——
 * 否则焦点落在子任务行这类非 input/button 元素上时，Space/Delete 会
 * 误操作列表区的键盘焦点行。
 */
const LIST_HOTKEY_KEYS = new Set([
  'j',
  'k',
  'x',
  ' ',
  'Enter',
  'ArrowDown',
  'ArrowUp',
  'Delete',
  'Backspace',
  'n',
  'N',
  '/',
]);

export const TodoItemDetail: React.FC<{
  item: TodoItem;
  onClose: () => void;
  className?: string;
  /** 移动端子屏承载时隐藏右上角关闭按钮（返回统一走顶栏返回箭头/系统返回键） */
  hideCloseButton?: boolean;
}> = ({ item, onClose, className, hideCloseButton }) => {
  const { t, i18n } = useTranslation(['todo', 'common']);
  const items = useTodoStore((s) => s.items);
  const updateItem = useTodoStore((s) => s.updateItem);
  const toggleItem = useTodoStore((s) => s.toggleItem);
  const deleteItem = useTodoStore((s) => s.deleteItem);

  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description || '');
  const [priority, setPriority] = useState<TodoPriority>(item.priority as TodoPriority);
  const [dueDate, setDueDate] = useState(item.dueDate || '');
  const [dueTime, setDueTime] = useState(item.dueTime || '');
  const [reminder, setReminder] = useState(normalizeReminderValue(item.reminder));
  const [estimatedPomodoros, setEstimatedPomodoros] = useState(item.estimatedPomodoros || 0);
  const [intervalDraft, setIntervalDraft] = useState('');
  const [pomodoroHistory, setPomodoroHistory] = useState<PomodoroRecord[]>([]);
  const [calendarOpen, setCalendarOpen] = useState(false);

  useEffect(() => {
    if (!calendarOpen) return;
    return registerBackHandler(() => {
      setCalendarOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [calendarOpen]);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // 外部更新（行内改期/改名、拖拽换象限等）跟随 prop 刷新本地编辑态。
  // 面板按 item.id 挂 key，重挂载覆盖新任务；这里处理同一任务字段被外部改写的情况。
  // 用户编辑中：字段保存后 item 值与本地一致，effect 不会打断输入。
  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => setDescription(item.description || ''), [item.description]);
  useEffect(() => setPriority(item.priority as TodoPriority), [item.priority]);
  useEffect(() => setDueDate(item.dueDate || ''), [item.dueDate]);
  useEffect(() => setDueTime(item.dueTime || ''), [item.dueTime]);
  // 提醒归一到分钟精度（旧数据可能带秒，datetime-local 会显示为空）
  useEffect(() => setReminder(normalizeReminderValue(item.reminder)), [item.reminder]);
  useEffect(() => setEstimatedPomodoros(item.estimatedPomodoros || 0), [item.estimatedPomodoros]);

  // 标题/备注多行自动增高（overflow-hidden 的固定 rows 会截断长内容）
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);
  useEffect(() => {
    const el = descriptionRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [description]);

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

  // ===== 保存反馈：字段保存成功后顶栏对勾闪现 =====
  const [savePulse, setSavePulse] = useState(0);
  const markSaved = useCallback(() => setSavePulse((n) => n + 1), []);

  // 标签直接从 item 派生（updateItem 后 store 刷新，prop 同步更新）
  const tags = useMemo(() => parseTags(item.tagsJson), [item.tagsJson]);

  // 标签自动补全词表：全库词表（listAllTags，按使用数降序；后端借道 stats 聚合，
  // 上限 100 个标签）优先，已加载条目的本地汇总作即时补充/兜底——
  // 覆盖刚创建还没进词表的、超出 100 上限的，以及词表拉取失败的场景。
  const [allTags, setAllTags] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    listAllTags()
      .then((tags) => {
        if (!cancelled) setAllTags(tags);
      })
      .catch(() => {
        // 拉取失败静默降级为本地汇总（allTags 保持空）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tagSuggestions = useMemo(() => {
    const freq = new Map<string, number>();
    for (const it of items) {
      for (const tag of parseTags(it.tagsJson)) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }
    const local = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
    if (allTags.length === 0) return local;
    const seen = new Set(allTags.map((tag) => tag.toLowerCase()));
    return [...allTags, ...local.filter((tag) => !seen.has(tag.toLowerCase()))];
  }, [items, allTags]);

  const handleTagsChange = useCallback(
    (next: string[]) => {
      void updateItem({ id: item.id, tags: next }).then(markSaved);
    },
    [item.id, updateItem, markSaved],
  );

  // 子任务（顶层任务才显示子任务区；不支持多级嵌套）
  const subtasks = useMemo(
    () => items.filter((i) => i.parentId === item.id),
    [items, item.id],
  );
  const isSubtask = Boolean(item.parentId);
  const isCompleted = item.status === 'completed';

  // ===== 顶栏勾选：与列表一致的弹性勾选动效 =====
  const [checkPop, setCheckPop] = useState(false);
  const checkPopTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (checkPopTimerRef.current !== null) window.clearTimeout(checkPopTimerRef.current);
    };
  }, []);
  const handleToggleSelf = useCallback(() => {
    if (!isCompleted) {
      if (checkPopTimerRef.current !== null) window.clearTimeout(checkPopTimerRef.current);
      setCheckPop(true);
      checkPopTimerRef.current = window.setTimeout(() => {
        checkPopTimerRef.current = null;
        setCheckPop(false);
      }, CHECK_POP_MS);
    }
    void toggleItem(item.id);
  }, [isCompleted, item.id, toggleItem]);

  const handleStartFocus = useCallback(() => {
    usePomodoroStore.getState().start(item.id, item.title);
  }, [item.id, item.title]);

  // 重复规则直接从 item 派生（updateItem 后 store 刷新，prop 同步更新）
  const repeatRule = useMemo(() => parseRepeatRule(item.repeatJson), [item.repeatJson]);

  // 间隔草稿跟随规则（失焦/回车才落库，避免逐键触发后端更新）
  useEffect(() => {
    setIntervalDraft(repeatRule ? String(repeatRule.interval) : '');
  }, [repeatRule]);

  // 下次出现预览（基于当前到期日推进一步，逾期则跳到 >= 今天）
  const nextOccurrence = useMemo(() => {
    if (!repeatRule || !item.dueDate) return null;
    return nextRepeatOccurrence(repeatRule, item.dueDate);
  }, [repeatRule, item.dueDate]);

  // ===== 重复锚定日期提示（重复任务清空到期日 → 回填今天 + 内联提示） =====
  const [repeatAnchorHint, setRepeatAnchorHint] = useState(false);
  const anchorHintTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (anchorHintTimerRef.current !== null) window.clearTimeout(anchorHintTimerRef.current);
    };
  }, []);
  const triggerRepeatAnchorHint = useCallback(() => {
    if (anchorHintTimerRef.current !== null) window.clearTimeout(anchorHintTimerRef.current);
    setRepeatAnchorHint(true);
    anchorHintTimerRef.current = window.setTimeout(() => {
      anchorHintTimerRef.current = null;
      setRepeatAnchorHint(false);
    }, HINT_DISMISS_MS);
  }, []);

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
      void updateItem(changes).then(markSaved);
    },
    [item.id, repeatRule, dueDate, updateItem, markSaved],
  );

  /** 自定义间隔（如「每 2 周」）；weekdays 语义固定不支持间隔 */
  const handleIntervalCommit = useCallback(() => {
    if (!repeatRule || repeatRule.freq === 'weekdays') return;
    const interval = Math.min(999, Math.max(1, Math.round(Number(intervalDraft)) || 1));
    setIntervalDraft(String(interval));
    if (interval === repeatRule.interval) return;
    void updateItem({
      id: item.id,
      repeatJson: serializeRepeatRule({ ...repeatRule, interval }),
    }).then(markSaved);
  }, [item.id, repeatRule, intervalDraft, updateItem, markSaved]);

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
      }).then(markSaved);
    },
    [item.id, repeatRule, updateItem, markSaved],
  );

  // ===== 日期/提醒快捷 chip =====
  // 以本地日期为 key：面板跨午夜常驻时预设自动滚动到新的一天
  const todayKey = localToday();
  const quickDates = useMemo(() => getQuickDateOptions(), [todayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyDueDate = useCallback(
    (date: string) => {
      setDueDate(date);
      void updateItem({ id: item.id, dueDate: date }).then(markSaved);
    },
    [item.id, updateItem, markSaved],
  );

  const clearDueDate = useCallback(() => {
    setDueDate('');
    setDueTime('');
    void updateItem({ id: item.id, dueDate: '', dueTime: '' }).then(markSaved);
  }, [item.id, updateItem, markSaved]);

  const applyReminder = useCallback(
    (value: string) => {
      setReminder(value);
      void updateItem({ id: item.id, reminder: value }).then(markSaved);
    },
    [item.id, updateItem, markSaved],
  );

  /** 汇总本地编辑态与 item 的差异并保存；返回是否有变更（供保存反馈） */
  const handleSave = useCallback(async (): Promise<boolean> => {
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
      if (!dueDate && repeatRule) {
        // 重复任务必须有锚定日期：清空时自动回填今天并给出内联提示
        const today = localToday();
        setDueDate(today);
        triggerRepeatAnchorHint();
        if (today !== (item.dueDate || '')) {
          changes.dueDate = today;
          hasChanges = true;
        }
      } else {
        changes.dueDate = dueDate;
        hasChanges = true;
      }
    }
    if (dueTime !== (item.dueTime || '')) {
      changes.dueTime = dueTime;
      hasChanges = true;
    }
    if (reminder !== normalizeReminderValue(item.reminder)) {
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
    return hasChanges;
  }, [
    item,
    title,
    description,
    priority,
    dueDate,
    dueTime,
    reminder,
    estimatedPomodoros,
    repeatRule,
    triggerRepeatAnchorHint,
    updateItem,
  ]);

  // blur 保存 300ms 防抖：Tab 在多个字段间移动 / 点击面板空白处时不再逐次触发保存；
  // handleSave 本身只在值变化时才发请求（hasChanges 守卫），双保险
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  const blurTimerRef = useRef<number | null>(null);
  const handleBlur = useCallback(() => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
    blurTimerRef.current = window.setTimeout(() => {
      blurTimerRef.current = null;
      void saveRef.current().then((changed) => {
        if (changed) markSaved();
      });
    }, 300);
  }, [markSaved]);

  /** ⌘/Ctrl+Enter：跳过防抖立即保存 */
  const flushSaveNow = useCallback(() => {
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    void saveRef.current().then((changed) => {
      if (changed) markSaved();
    });
  }, [markSaved]);

  // 卸载（关面板/切任务）时无条件冲刷：handleSave 有 hasChanges 守卫，重复调用无副作用。
  // 面板按 item.id 挂 key，切换 selectedItemId 先卸载旧实例——此处闭包仍指向旧 item，
  // 保证冲刷写入旧任务，不会串写到新任务。
  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      void saveRef.current();
    };
  }, []);

  // ===== 面板级键盘：Esc 收起（先收内联日历），⌘/Ctrl+Enter 立即保存 =====
  // 字段级 Esc（标题/备注还原、标签/子任务草稿清空）在各自 handler 内 stopPropagation
  const handlePanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 面板消费 Esc 后阻断冒泡：TodoMainPanel 的 document 级 Esc
        // （清多选/关面板）不再与本层级（日历→面板）双重触发
        e.stopPropagation();
        if (calendarOpen) {
          setCalendarOpen(false);
          return;
        }
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        // 先失焦让受控字段结束编辑（blur 的防抖随即被 flush 清掉）
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        flushSaveNow();
        return;
      }
      // 列表快捷键隔离：面板内按键不冒泡到 TodoMainPanel 的 document 监听
      // （不 preventDefault，输入框打字/按钮激活等默认行为不受影响）
      if (!e.metaKey && !e.ctrlKey && !e.altKey && LIST_HOTKEY_KEYS.has(e.key)) {
        e.stopPropagation();
      }
    },
    [calendarOpen, onClose, flushSaveNow],
  );

  const completedPomodoros = item.completedPomodoros || 0;

  return (
    <aside
      data-todo-detail-panel
      onKeyDown={handlePanelKeyDown}
      className={cn(
        'flex h-full flex-col bg-[color:var(--shell-inspector-panel)]',
        className,
      )}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <button
            onClick={handleToggleSelf}
            className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] focus-visible:ring-offset-1 [@media(pointer:coarse)]:p-3 [@media(pointer:coarse)]:-m-3"
            aria-label={isCompleted ? t('todo:actions.markPending') : t('todo:actions.markCompleted')}
          >
            {isCompleted ? (
              <CheckCircle
                size={20}
                weight="fill"
                className={cn(
                  'text-[color:hsl(var(--success))]',
                  // 弹性放大回落（260ms 弹性曲线；reduced-motion 下由 CSS 侧禁用）
                  checkPop && 'todo-check-pop',
                )}
              />
            ) : (
              <div className="group/check flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-[color:var(--border-default)] transition-colors duration-150 hover:border-[color:hsl(var(--primary))]">
                <Check
                  size={12}
                  className="text-[color:hsl(var(--primary))] opacity-0 transition-opacity duration-150 group-hover/check:opacity-40"
                />
              </div>
            )}
          </button>
          <span className="text-sm font-medium text-muted-foreground">
            {t('todo:detail.title')}
          </span>
          <SaveTick pulse={savePulse} />
        </div>
        <div className="flex items-center gap-1">
          {/* 触屏行尾播放按钮已收敛到详情：这里提供「开始专注」入口 */}
          {!isCompleted && (
            <DsButton
              variant="utility"
              size="icon"
              iconOnly
              onClick={handleStartFocus}
              title={t('todo:actions.startFocusSession')}
              aria-label={t('todo:actions.startFocusSession')}
              className="!p-1.5 [@media(pointer:coarse)]:!p-3"
            >
              <Play size={16} />
            </DsButton>
          )}
          {!hideCloseButton && (
            <DsButton
              variant="utility"
              size="icon"
              iconOnly
              onClick={onClose}
              aria-label={t('common:actions.close')}
              className="!p-1.5"
            >
              <X size={16} />
            </DsButton>
          )}
        </div>
      </div>

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-5 py-5 space-y-5">
        <Textarea
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            // Enter 提交（失焦触发保存），Shift+Enter 换行；Esc 还原并失焦（不冒泡关面板）
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setTitle(item.title);
              e.currentTarget.blur();
            }
          }}
          className={cn(
            'w-full resize-none overflow-hidden bg-transparent border-0 focus-visible:ring-0 text-lg font-semibold tracking-tight leading-tight placeholder:text-muted-foreground/50 transition-colors min-h-0',
            isCompleted && 'text-muted-foreground line-through',
          )}
          rows={2}
          placeholder={t('todo:placeholders.title')}
        />

        {/* 属性面板 — 扁平属性行，统一圆角/悬停语言 */}
        <div className="space-y-0.5">
          <div className={PROPERTY_ROW_CLASS}>
            <span className="w-[4.75rem] flex-shrink-0 text-xs text-muted-foreground">
              {t('todo:fields.priority')}
            </span>
            <SegmentedControl<TodoPriority>
              ariaLabel={t('todo:fields.priority')}
              value={priority}
              onValueChange={(p) => {
                setPriority(p);
                void updateItem({ id: item.id, priority: p }).then(markSaved);
              }}
              size="compact"
              className="flex-wrap"
              itemClassName="!h-auto !px-2 !py-0.5 text-xs font-medium"
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

          <div className={PROPERTY_ROW_CLASS}>
            <span className="flex w-[4.75rem] flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar size={14} />
              {t('todo:fields.dueDate')}
            </span>
            <div className="flex flex-1 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCalendarOpen((v) => !v)}
                aria-expanded={calendarOpen}
                title={dueDate || undefined}
                className={cn(
                  'flex min-w-0 flex-1 items-center justify-between gap-1.5 rounded-[var(--radius-shell-control)] px-2 py-1 text-left text-sm',
                  'transition-colors duration-150 hover:bg-[color:var(--interactive-hover)]',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))]',
                  dueDate ? 'text-foreground' : 'text-muted-foreground/70',
                )}
              >
                <span className="truncate">
                  {dueDate
                    ? formatDueDateLabel(dueDate, t, i18n.language)
                    : t('todo:reschedule.pickDate')}
                </span>
                <CaretDown
                  size={12}
                  className={cn(
                    'flex-shrink-0 text-muted-foreground/60 transition-transform duration-200 motion-reduce:transition-none',
                    calendarOpen && 'rotate-180',
                  )}
                />
              </button>
              {/* 重复任务需要锚定日期：开启重复时不提供一键清空 */}
              {dueDate && !repeatRule && (
                <DsButton
                  variant="utility"
                  size="icon"
                  iconOnly
                  onClick={clearDueDate}
                  aria-label={t('todo:reschedule.clear')}
                  title={t('todo:reschedule.clear')}
                  className="!p-1 [@media(pointer:coarse)]:!p-3"
                >
                  <X size={13} />
                </DsButton>
              )}
            </div>
          </div>

          {/* 日期快捷 chip（今天/明天/周末/下周一），内联月历兜底 */}
          <div className={cn(CHIP_INDENT_CLASS, 'pb-1')}>
            <span className="w-[4.75rem] flex-shrink-0" />
            <div className="flex flex-1 flex-wrap items-center gap-1">
              {quickDates.map((opt) => (
                <QuickChip
                  key={opt.key}
                  active={dueDate === opt.date}
                  onClick={() => applyDueDate(opt.date)}
                  title={opt.date}
                >
                  {t(`todo:reschedule.${opt.key}`)}
                </QuickChip>
              ))}
            </div>
          </div>

          {/* 内联月历（选中即收起；Esc 也可收起） */}
          <InlineReveal open={calendarOpen}>
            <div className={cn(CHIP_INDENT_CLASS, 'pb-1.5')}>
              <span className="hidden w-[4.75rem] flex-shrink-0 sm:block" />
              <div className="min-w-0 flex-1 rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)] bg-[color:var(--surface-muted)]/40 p-2">
                <MiniCalendar
                  value={dueDate}
                  onSelect={(date) => {
                    applyDueDate(date);
                    setCalendarOpen(false);
                  }}
                />
              </div>
            </div>
          </InlineReveal>

          <InlineReveal open={Boolean(dueDate)}>
            <div className={PROPERTY_ROW_CLASS}>
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
          </InlineReveal>

          <div className={PROPERTY_ROW_CLASS}>
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
                <DsButton
                  variant="utility"
                  size="icon"
                  iconOnly
                  onClick={() => applyReminder('')}
                  aria-label={t('todo:reminder.clear')}
                  className="!p-1 [@media(pointer:coarse)]:!p-3"
                >
                  <X size={13} />
                </DsButton>
              )}
            </div>
          </div>

          {/* 提醒快捷 chip（准点/提前 15 分/提前 1 小时）——需要截止日期作基准 */}
          <InlineReveal open={Boolean(dueDate)}>
            <div className={cn(CHIP_INDENT_CLASS, 'pb-1')}>
              <span className="w-[4.75rem] flex-shrink-0" />
              <div className="flex flex-1 flex-wrap items-center gap-1">
                {REMINDER_QUICK_OFFSETS.map(({ key, minutes }) => {
                  const value = dueDate ? reminderFromDue(dueDate, dueTime, minutes) : '';
                  return (
                    <QuickChip
                      key={key}
                      active={Boolean(value) && reminder === value}
                      onClick={() => value && applyReminder(value)}
                      title={value.replace('T', ' ')}
                    >
                      {t(`todo:detail.${key}`)}
                    </QuickChip>
                  );
                })}
              </div>
            </div>
          </InlineReveal>

          <div className={PROPERTY_ROW_CLASS}>
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
              itemClassName="!h-auto !px-2 !py-0.5 text-xs font-medium"
              options={REPEAT_OPTIONS.map((opt) => ({
                value: opt.value,
                title: t(opt.labelKey),
                label: <span>{t(opt.labelKey)}</span>,
              }))}
            />
          </div>

          {/* 重复任务清空到期日 → 已自动回填今天的内联提示 */}
          <InlineReveal open={repeatAnchorHint}>
            <div className="flex items-center gap-3 px-2 -mx-2 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <span className="text-xs text-[color:hsl(var(--warning))]" role="status">
                {t('todo:detail.repeatNeedsDueDate')}
              </span>
            </div>
          </InlineReveal>

          {/* 自定义间隔：如「每 2 周」（weekdays 语义固定，不提供间隔） */}
          {repeatRule && repeatRule.freq !== 'weekdays' && (
            <div className={PROPERTY_ROW_CLASS}>
              <span className="w-[4.75rem] flex-shrink-0 text-xs text-muted-foreground">
                {t('todo:fields.repeatInterval')}
              </span>
              <div className="flex flex-1 items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={999}
                  value={intervalDraft}
                  onChange={(e) => setIntervalDraft(e.target.value)}
                  onBlur={handleIntervalCommit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleIntervalCommit();
                    }
                  }}
                  className="w-20 tabular-nums"
                />
              </div>
            </div>
          )}

          {/* weekly：多选星期（如「每周一、三、五」） */}
          {repeatRule?.freq === 'weekly' && (
            <div className={PROPERTY_ROW_CLASS}>
              <span className="hidden w-[4.75rem] flex-shrink-0 sm:block" />
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
                        'h-9 w-9 rounded-full text-xs font-medium transition-colors duration-150 sm:h-6 sm:w-6',
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

          {/* 重复规则的人类可读摘要 + 下次出现预览（完成当前后将滚动到该日期） */}
          {repeatRule && (
            <div className="flex items-center gap-3 px-2 -mx-2 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground/80">
                <span className="font-medium text-muted-foreground">
                  {repeatRuleLabel(repeatRule, t)}
                </span>
                {nextOccurrence && (
                  <span className="inline-flex items-center gap-1">
                    <ArrowRight size={11} />
                    {t('todo:repeat.nextOccurrence', { date: nextOccurrence })}
                  </span>
                )}
              </span>
            </div>
          )}

          <div className={cn(PROPERTY_ROW_CLASS, 'items-start')}>
            <span className="flex w-[4.75rem] flex-shrink-0 items-center gap-1.5 pt-1.5 text-xs text-muted-foreground">
              <Tag size={14} />
              {t('todo:fields.tags')}
            </span>
            <TagsEditor tags={tags} onChange={handleTagsChange} suggestions={tagSuggestions} />
          </div>

          <div className={PROPERTY_ROW_CLASS}>
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
                className="w-20 tabular-nums"
              />
              {completedPomodoros > 0 && !estimatedPomodoros && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('todo:pomodoro.completedCount', { count: completedPomodoros })}
                </span>
              )}
            </div>
          </div>

          {/* 番茄进度点阵（预估 vs 已完成） */}
          {Boolean(estimatedPomodoros) && (
            <div className="flex items-center gap-3 px-2 -mx-2 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <div
                className="flex flex-1 items-center gap-2"
                title={t('todo:detail.pomodoroProgress', {
                  done: completedPomodoros,
                  total: estimatedPomodoros,
                })}
              >
                <PomodoroDots done={completedPomodoros} total={estimatedPomodoros} />
                <span className="text-xs tabular-nums text-muted-foreground/70">
                  {completedPomodoros}/{estimatedPomodoros}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 子任务区（仅顶层任务） */}
        {!isSubtask && (
          <div className={SECTION_CLASS}>
            <SubtaskSection item={item} subtasks={subtasks} />
          </div>
        )}

        <div className={cn(SECTION_CLASS, 'space-y-2')}>
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('todo:fields.description')}
          </span>
          <Textarea
            ref={descriptionRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              // Esc 还原备注并失焦（不冒泡关面板）；换行保持原生 Enter
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDescription(item.description || '');
                e.currentTarget.blur();
              }
            }}
            placeholder={t('todo:placeholders.description')}
            rows={4}
            className="w-full resize-none overflow-hidden leading-relaxed min-h-[6.5rem]"
          />
        </div>

        {/* 专注历史（有记录才显示） */}
        {pomodoroHistory.length > 0 && (
          <div className={SECTION_CLASS}>
            <FocusHistorySection
              records={pomodoroHistory}
              onStartFocus={isCompleted ? undefined : handleStartFocus}
            />
          </div>
        )}
      </CustomScrollArea>

      <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-default)] px-4 py-3 pb-[calc(0.75rem+var(--mobile-safe-area-bottom,0px))]">
        <span className="min-w-0 flex-shrink truncate text-xs text-muted-foreground">
          {item.updatedAt
            ? t('todo:detail.updatedAt', {
                date: new Date(item.updatedAt).toLocaleDateString(),
              })
            : ''}
        </span>
        <InlineConfirmDelete
          label={t('common:actions.delete')}
          question={t('todo:detail.deleteConfirm')}
          confirmLabel={t('common:actions.delete')}
          cancelLabel={t('common:actions.cancel')}
          onConfirm={() => {
            void deleteItem(item.id);
            onClose();
          }}
        />
      </div>
    </aside>
  );
};
