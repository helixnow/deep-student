/**
 * TodoQuickAdd — 扁平输入条（自然语言解析 + 可移除 chip 预览）
 *
 * 对标 Todoist 快速添加：
 * - 输入时实时解析日期/时间/优先级/重复/提醒/标签，以 chip 内联预览
 * - 每个 chip 可点击 × 移除（把对应 token 从输入文本中剥掉）
 * - Enter 连续添加：提交后保持展开与焦点，可流水式录入
 * - 添加成功时加号图标弹跳转绿（todo-quickadd-pop）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Brain, Calendar, Plus, Repeat, Tag, Tray, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { useTodoStore } from '../../stores/useTodoStore';
import type { TodoPriority } from '../../types';
import { PRIORITY_CONFIG, repeatRuleLabel, serializeRepeatRule } from '../../types';
import {
  normalizeQuickAddInput,
  parseQuickAddInput,
  type QuickAddTokenType,
} from '../../quickAddParser';
import { formatDueDateLabel } from './dueDateLabel';
import '../../styles/todo-motion.css';

/** 解析 chip：淡主色 pill + 可点击 × 移除 */
const ParsedChip: React.FC<{
  icon?: React.ReactNode;
  label: React.ReactNode;
  tone?: 'primary' | 'muted';
  className?: string;
  removeLabel: string;
  /** 不传则不渲染 ×（如由重复规则派生、无独立 token 可剥离的日期 chip） */
  onRemove?: () => void;
}> = ({ icon, label, tone = 'primary', className, removeLabel, onRemove }) => (
  <span
    className={cn(
      'ui-rise-in inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full py-0.5 pl-2 text-xs',
      onRemove ? 'pr-1' : 'pr-2',
      tone === 'primary' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      className,
    )}
  >
    {icon}
    {label}
    {onRemove && (
      <button
        type="button"
        tabIndex={-1}
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className="flex h-4 w-4 items-center justify-center rounded-full opacity-60 transition-opacity hover:bg-foreground/10 hover:opacity-100"
      >
        <X size={9} weight="bold" />
      </button>
    )}
  </span>
);

export const TodoQuickAdd: React.FC<{
  /** 智能视图（如「今日」）内使用：无明确日期时的默认截止日 */
  defaultDueDate?: string;
}> = ({ defaultDueDate }) => {
  const { t, i18n } = useTranslation(['todo']);
  const createItem = useTodoStore((s) => s.createItem);
  const updateItem = useTodoStore((s) => s.updateItem);
  const activeListId = useTodoStore((s) => s.activeListId);
  const lists = useTodoStore((s) => s.lists);
  const quickAddPreset = useTodoStore((s) => s.quickAddPreset);
  const clearQuickAddPreset = useTodoStore((s) => s.clearQuickAddPreset);
  // 智能视图下 activeListId 为空，落到默认清单（收件箱）
  const targetListId =
    activeListId ?? (lists.find((l) => l.isDefault) || lists[0])?.id ?? null;
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('none');
  const [dueDate, setDueDate] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  /** 本条录入中用户显式移除了智能视图默认截止日 chip */
  const [suppressDefaultDue, setSuppressDefaultDue] = useState(false);
  /** 添加成功微动效（加号弹跳转绿），animation key 触发重播 */
  const [addedFlash, setAddedFlash] = useState(0);
  const flashTimerRef = useRef<number | null>(null);

  // 自然语言解析（如「明天交作业 !高」），结果以 chip 预览，提交时应用
  const parsed = useMemo(() => parseQuickAddInput(title), [title]);

  // ~清单 / @清单 token：按标题匹配现有清单（忽略首尾空白与大小写）。
  // 匹配不到时保持当前清单，chip 以淡态提示未命中（token 仍可点 × 还原判断）
  const resolvedList = useMemo(() => {
    if (!parsed.listName) return null;
    const name = parsed.listName.trim().toLowerCase();
    return lists.find((l) => l.title.trim().toLowerCase() === name) ?? null;
  }, [parsed.listName, lists]);

  useEffect(() => {
    if (!quickAddPreset) return;
    setDueDate(quickAddPreset.dueDate ?? '');
    setIsExpanded(true);
    document.querySelector<HTMLInputElement>('[data-todo-quick-add]')?.focus();
    clearQuickAddPreset(quickAddPreset.requestId);
  }, [clearQuickAddPreset, quickAddPreset]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  const removeChipLabel = t('todo:quickAdd.removeToken', { defaultValue: '移除' });

  // 按 token 在原文中的位置精确剥离（而非字符串 replace）：
  // 同词多次出现时不会误删前面的普通文本，全角 token（＃标签/！ｐ１）也能正确移除
  const removeTokenSpans = useCallback(
    (spans: Array<{ start: number; end: number }>) => {
      if (spans.length === 0) return;
      let next = title;
      for (const s of [...spans].sort((a, b) => b.start - a.start)) {
        next = `${next.slice(0, s.start)} ${next.slice(s.end)}`;
      }
      setTitle(next.replace(/\s{2,}/g, ' ').trim());
      // 移除后焦点回到输入框，连续编辑不中断
      document.querySelector<HTMLInputElement>('[data-todo-quick-add]')?.focus();
    },
    [title],
  );

  const removeTokensOfTypes = useCallback(
    (...types: QuickAddTokenType[]) => {
      removeTokenSpans(parsed.tokens.filter((tk) => types.includes(tk.type)));
    },
    [parsed, removeTokenSpans],
  );

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !targetListId) return;
    // 手动设置的字段优先于自然语言解析结果
    const finalTitle = (parsed.title || title).trim();
    const finalDueDate =
      dueDate || parsed.dueDate || (suppressDefaultDue ? undefined : defaultDueDate);
    const finalPriority = priority !== 'none' ? priority : (parsed.priority ?? 'none');
    if (!finalTitle) return;
    try {
      const created = await createItem({
        // ~清单/@清单 命中现有清单时直接建到目标清单
        todoListId: resolvedList?.id ?? targetListId,
        title: finalTitle,
        priority: finalPriority,
        dueDate: finalDueDate || undefined,
        dueTime: parsed.dueTime,
        reminder: parsed.reminder,
        tags: parsed.tags,
        repeatJson: parsed.repeat ? serializeRepeatRule(parsed.repeat) : undefined,
      });
      // 时长语法（如「预计30分钟」）→ 预估番茄数。创建命令不收该字段，
      // 补一笔 update 持久化（失败由 store 弹错，不阻塞连续录入）
      if (parsed.estimatedPomodoros) {
        void updateItem({ id: created.id, estimatedPomodoros: parsed.estimatedPomodoros });
      }
      setTitle('');
      setPriority('none');
      setDueDate('');
      setSuppressDefaultDue(false);
      // 保持展开与焦点：Enter 连续添加（对标 Todoist）；Esc 收起。
      // 点「添加」按钮提交时焦点在按钮上，这里统一拉回输入框
      document.querySelector<HTMLInputElement>('[data-todo-quick-add]')?.focus();
      setAddedFlash((n) => n + 1);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => {
        flashTimerRef.current = null;
        setAddedFlash(0);
      }, 400);
    } catch {
      // error handled in store
    }
  }, [title, parsed, priority, dueDate, suppressDefaultDue, defaultDueDate, targetListId, resolvedList, createItem, updateItem]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME 组词中的 Enter/Esc 属于输入法交互（如拼音上屏），不触发提交/收起
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape') setIsExpanded(false);
    },
    [handleSubmit],
  );

  if (!targetListId) return null;

  const showDefaultDueChip =
    Boolean(defaultDueDate) && !dueDate && !parsed.dueDate && !suppressDefaultDue;
  const hasChips =
    title.trim() &&
    (parsed.dueDate || parsed.dueTime || parsed.priority || parsed.repeat ||
      parsed.reminder || (parsed.tags?.length ?? 0) > 0 || showDefaultDueChip ||
      parsed.listName || parsed.estimatedPomodoros);

  return (
    <div>
      <div className="flex items-center gap-2.5 px-4 py-2.5 sm:px-6">
        <Plus
          size={16}
          // key 变化重播弹跳动画；0 = 静息态
          key={addedFlash}
          className={cn(
            'flex-shrink-0 text-[color:var(--text-muted)]',
            addedFlash > 0 && 'todo-quickadd-pop',
          )}
        />
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsExpanded(true)}
          placeholder={t('todo:actions.quickAddPlaceholder')}
          data-todo-quick-add
          className="min-w-0 flex-1 bg-transparent border-0 focus-visible:ring-0 placeholder:text-muted-foreground/50"
        />
        {/* 自然语言解析预览 chip（可点击 × 移除；提交时生效）；窄屏横向滚动 */}
        {hasChips && (
          <div className="flex min-w-0 max-w-[45%] flex-shrink items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* 智能视图默认截止日提示（如「今日」视图默认落到今天），可移除 */}
            {showDefaultDueChip && defaultDueDate && (
              <ParsedChip
                tone="muted"
                icon={<Calendar size={11} />}
                label={formatDueDateLabel(defaultDueDate, t, i18n.language)}
                removeLabel={removeChipLabel}
                onRemove={() => setSuppressDefaultDue(true)}
              />
            )}
            {parsed.dueDate && !dueDate && (
              <ParsedChip
                icon={<Calendar size={11} />}
                label={
                  <>
                    {formatDueDateLabel(parsed.dueDate, t, i18n.language)}
                    {parsed.dueTime ? ` ${parsed.dueTime}` : ''}
                  </>
                }
                removeLabel={removeChipLabel}
                onRemove={
                  parsed.dateToken || parsed.timeToken
                    ? () => removeTokensOfTypes('date', 'time')
                    : undefined
                }
              />
            )}
            {parsed.repeat && (
              <ParsedChip
                icon={<Repeat size={11} />}
                label={repeatRuleLabel(parsed.repeat, t)}
                removeLabel={removeChipLabel}
                onRemove={parsed.repeatToken ? () => removeTokensOfTypes('repeat') : undefined}
              />
            )}
            {parsed.reminder && (
              <ParsedChip
                icon={<Bell size={11} />}
                label={parsed.reminder.slice(11, 16)}
                removeLabel={removeChipLabel}
                onRemove={
                  parsed.reminderToken ? () => removeTokensOfTypes('reminder') : undefined
                }
              />
            )}
            {parsed.tags?.map((tag) => (
              <ParsedChip
                key={tag}
                tone="muted"
                icon={<Tag size={10} />}
                label={tag}
                removeLabel={removeChipLabel}
                onRemove={() =>
                  // 同名标签可能多处出现（解析已去重）：一并移除该标签的全部 token。
                  // token 原文可能含全角 ＃/字符，用解析器同款归一（1:1 长度保持）对齐比较
                  removeTokenSpans(
                    parsed.tokens.filter(
                      (tk) =>
                        tk.type === 'tag' && normalizeQuickAddInput(tk.text).slice(1) === tag,
                    ),
                  )
                }
              />
            ))}
            {parsed.priority && priority === 'none' && (
              <ParsedChip
                tone="muted"
                label={t(PRIORITY_CONFIG[parsed.priority].labelKey)}
                className={PRIORITY_CONFIG[parsed.priority].color}
                removeLabel={removeChipLabel}
                onRemove={
                  parsed.priorityToken ? () => removeTokensOfTypes('priority') : undefined
                }
              />
            )}
            {parsed.listName && (
              <ParsedChip
                tone={resolvedList ? 'primary' : 'muted'}
                icon={<Tray size={10} />}
                label={resolvedList ? resolvedList.title : parsed.listName}
                // 未命中现有清单时淡化提示（提交仍落当前清单）
                className={resolvedList ? undefined : 'opacity-60'}
                removeLabel={removeChipLabel}
                onRemove={() => removeTokensOfTypes('list')}
              />
            )}
            {parsed.estimatedPomodoros && (
              <ParsedChip
                tone="muted"
                icon={<Brain size={10} />}
                label={t('todo:stats.pomodoroLoad', { count: parsed.estimatedPomodoros })}
                removeLabel={removeChipLabel}
                onRemove={
                  parsed.durationToken ? () => removeTokensOfTypes('duration') : undefined
                }
              />
            )}
          </div>
        )}
        {title.trim() && (
          <NotionButton
            variant="shell"
            size="sm"
            onClick={handleSubmit}
            className="h-7 flex-shrink-0 text-xs [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-4"
          >
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
            itemClassName="!h-auto !px-2 !py-1 text-xs font-medium"
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
