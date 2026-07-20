/**
 * TodoItemDetail — 右侧详情面板（桌面 360px 抽屉 / 移动端全屏子屏共用）
 *
 * - 本地编辑态通过 useEffect 跟随 item 字段（行内改期/改名等外部更新不再陈旧）
 * - 属性行统一 12px 圆角 + --interactive-hover 悬停
 * - 子任务行可点击切换详情
 * - 重复规则支持 interval > 1（「每 2 周」）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Bell,
  Brain,
  Calendar,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Play,
  Plus,
  Repeat,
  Sparkle,
  Tag,
  Trash,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { usePomodoroStore } from '@/features/pomodoro';
import { listPomodorosByTodo, type PomodoroRecord } from '@/features/pomodoro/api';
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
import { aiBreakdownTodo } from '../../api';

/** 属性行统一视觉：12px 圆角、悬停 --interactive-hover（对齐设计规范） */
const PROPERTY_ROW_CLASS =
  'flex items-center gap-3 rounded-[var(--radius-shell-control)] px-2 -mx-2 py-1.5 transition-colors duration-150 hover:bg-[color:var(--interactive-hover)]';

export const TodoItemDetail: React.FC<{
  item: TodoItem;
  onClose: () => void;
  className?: string;
  /** 移动端子屏承载时隐藏右上角关闭按钮（返回统一走顶栏返回箭头/系统返回键） */
  hideCloseButton?: boolean;
}> = ({ item, onClose, className, hideCloseButton }) => {
  const { t } = useTranslation(['todo', 'common']);
  const items = useTodoStore((s) => s.items);
  const updateItem = useTodoStore((s) => s.updateItem);
  const toggleItem = useTodoStore((s) => s.toggleItem);
  const deleteItem = useTodoStore((s) => s.deleteItem);
  const createItem = useTodoStore((s) => s.createItem);
  const selectItem = useTodoStore((s) => s.selectItem);
  const reloadCurrentView = useTodoStore((s) => s.reloadCurrentView);

  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description || '');
  const [priority, setPriority] = useState<TodoPriority>(item.priority as TodoPriority);
  const [dueDate, setDueDate] = useState(item.dueDate || '');
  const [dueTime, setDueTime] = useState(item.dueTime || '');
  const [reminder, setReminder] = useState(item.reminder || '');
  const [estimatedPomodoros, setEstimatedPomodoros] = useState(item.estimatedPomodoros || 0);
  const [intervalDraft, setIntervalDraft] = useState('');
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [pomodoroHistory, setPomodoroHistory] = useState<PomodoroRecord[]>([]);
  const [aiBreaking, setAiBreaking] = useState(false);
  const [aiBreakdownError, setAiBreakdownError] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // 外部更新（行内改期/改名、拖拽换象限等）跟随 prop 刷新本地编辑态。
  // 面板按 item.id 挂 key，重挂载覆盖新任务；这里处理同一任务字段被外部改写的情况。
  // 用户编辑中：字段保存后 item 值与本地一致，effect 不会打断输入。
  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => setDescription(item.description || ''), [item.description]);
  useEffect(() => setPriority(item.priority as TodoPriority), [item.priority]);
  useEffect(() => setDueDate(item.dueDate || ''), [item.dueDate]);
  useEffect(() => setDueTime(item.dueTime || ''), [item.dueTime]);
  useEffect(() => setReminder(item.reminder || ''), [item.reminder]);
  useEffect(() => setEstimatedPomodoros(item.estimatedPomodoros || 0), [item.estimatedPomodoros]);

  // 标题多行自动增高（overflow-hidden 的固定 rows 会截断长标题）
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

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

  // 间隔草稿跟随规则（失焦/回车才落库，避免逐键触发后端更新）
  useEffect(() => {
    setIntervalDraft(repeatRule ? String(repeatRule.interval) : '');
  }, [repeatRule]);

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

  /** 自定义间隔（如「每 2 周」）；weekdays 语义固定不支持间隔 */
  const handleIntervalCommit = useCallback(() => {
    if (!repeatRule || repeatRule.freq === 'weekdays') return;
    const interval = Math.min(999, Math.max(1, Math.round(Number(intervalDraft)) || 1));
    setIntervalDraft(String(interval));
    if (interval === repeatRule.interval) return;
    void updateItem({
      id: item.id,
      repeatJson: serializeRepeatRule({ ...repeatRule, interval }),
    });
  }, [item.id, repeatRule, intervalDraft, updateItem]);

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

  // blur 保存 300ms 防抖：Tab 在多个字段间移动 / 点击面板空白处时不再逐次触发保存；
  // handleSave 本身只在值变化时才发请求（hasChanges 守卫），双保险
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  const blurTimerRef = useRef<number | null>(null);
  const handleBlur = useCallback(() => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
    blurTimerRef.current = window.setTimeout(() => {
      blurTimerRef.current = null;
      void saveRef.current();
    }, 300);
  }, []);
  // 卸载（关面板/切任务）时冲刷未保存的编辑，避免丢改动
  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
        void saveRef.current();
      }
    };
  }, []);

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
            className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] focus-visible:ring-offset-1 [@media(pointer:coarse)]:p-3 [@media(pointer:coarse)]:-m-3"
            aria-label={isCompleted ? t('todo:actions.markPending') : t('todo:actions.markCompleted')}
          >
            {isCompleted ? (
              <CheckCircle size={20} weight="fill" className="text-[color:hsl(var(--success))]" />
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
        </div>
        <div className="flex items-center gap-1">
          {/* 触屏行尾播放按钮已收敛到详情：这里提供「开始专注」入口 */}
          {!isCompleted && (
            <NotionButton
              variant="utility"
              size="icon"
              iconOnly
              onClick={() => usePomodoroStore.getState().start(item.id, item.title)}
              title={t('todo:actions.startFocusSession')}
              aria-label={t('todo:actions.startFocusSession')}
              className="!p-1.5 [@media(pointer:coarse)]:!p-3"
            >
              <Play size={16} />
            </NotionButton>
          )}
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
      </div>

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-5 py-5 space-y-5">
        <Textarea
          ref={titleRef}
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

          <div className={PROPERTY_ROW_CLASS}>
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
          )}

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
              itemClassName="!h-auto !px-2 !py-0.5 text-[11px] font-medium"
              options={REPEAT_OPTIONS.map((opt) => ({
                value: opt.value,
                title: t(opt.labelKey),
                label: <span>{t(opt.labelKey)}</span>,
              }))}
            />
          </div>

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
                <span className="text-[11px] text-muted-foreground">
                  {repeatRuleLabel(repeatRule, t)}
                </span>
              </div>
            </div>
          )}

          <div className={cn(PROPERTY_ROW_CLASS, 'items-start')}>
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
            <div className={PROPERTY_ROW_CLASS}>
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
                        'h-6 w-6 rounded-full text-[11px] font-medium transition-colors duration-150',
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

          {/* 重复任务：下次出现预览（完成当前后将滚动到该日期） */}
          {repeatRule && nextOccurrence && (
            <div className="flex items-center gap-3 px-2 -mx-2 py-1">
              <span className="w-[4.75rem] flex-shrink-0" />
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
                <ArrowRight size={11} />
                {t('todo:repeat.nextOccurrence', { date: nextOccurrence })}
              </span>
            </div>
          )}

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
              {(item.completedPomodoros || 0) > 0 && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {t('todo:pomodoro.completedCount', { count: item.completedPomodoros || 0 })}
                </span>
              )}
            </div>
          </div>

          {/* 番茄进度条 */}
          {Boolean(estimatedPomodoros) && (
            <div className="flex items-center gap-3 px-2 -mx-2 py-1">
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
                  <span className="ml-1.5 font-normal normal-case tabular-nums text-muted-foreground/70">
                    {subtasks.filter((s) => s.status === 'completed').length}/{subtasks.length}
                  </span>
                )}
              </span>
              <button
                onClick={() => void handleAiBreakdown()}
                disabled={aiBreaking}
                className={cn(
                  'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors duration-150',
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
                role="button"
                tabIndex={0}
                onClick={() => selectItem(sub.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    selectItem(sub.id);
                  }
                }}
                title={t('todo:subtasks.openDetail')}
                className="group/subtask flex cursor-pointer items-center gap-2 rounded-[var(--radius-shell-control)] px-1.5 py-1 transition-colors duration-150 hover:bg-[color:var(--interactive-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:hsl(var(--primary))]/50"
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleItem(sub.id);
                  }}
                  className="flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] [@media(pointer:coarse)]:p-3 [@media(pointer:coarse)]:-m-3"
                  aria-label={
                    sub.status === 'completed'
                      ? t('todo:actions.markPending')
                      : t('todo:actions.markCompleted')
                  }
                >
                  {sub.status === 'completed' ? (
                    <CheckCircle size={16} weight="fill" className="text-[color:hsl(var(--success))]" />
                  ) : (
                    <span className="block h-4 w-4 rounded-full border-[1.5px] border-[color:var(--border-default)] transition-colors duration-150 hover:border-[color:hsl(var(--primary))]" />
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
                <CaretRight
                  size={12}
                  className="flex-shrink-0 text-muted-foreground/0 transition-colors group-hover/subtask:text-muted-foreground/60"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteItem(sub.id);
                  }}
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
