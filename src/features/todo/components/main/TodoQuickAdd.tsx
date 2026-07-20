/**
 * TodoQuickAdd — 扁平输入条（自然语言解析 + chip 预览）
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, Plus, Repeat, Tag } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { useTodoStore } from '../../stores/useTodoStore';
import type { TodoPriority } from '../../types';
import { PRIORITY_CONFIG, repeatRuleLabel, serializeRepeatRule } from '../../types';
import { parseQuickAddInput } from '../../quickAddParser';
import { formatDueDateLabel } from './dueDateLabel';

export const TodoQuickAdd: React.FC<{
  /** 智能视图（如「今日」）内使用：无明确日期时的默认截止日 */
  defaultDueDate?: string;
}> = ({ defaultDueDate }) => {
  const { t, i18n } = useTranslation(['todo']);
  const createItem = useTodoStore((s) => s.createItem);
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
    if (!title.trim() || !targetListId) return;
    // 手动设置的字段优先于自然语言解析结果
    const finalTitle = (parsed.title || title).trim();
    const finalDueDate = dueDate || parsed.dueDate || defaultDueDate;
    const finalPriority = priority !== 'none' ? priority : (parsed.priority ?? 'none');
    if (!finalTitle) return;
    try {
      await createItem({
        todoListId: targetListId,
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
  }, [title, parsed, priority, dueDate, defaultDueDate, targetListId, createItem]);

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

  if (!targetListId) return null;

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
        {/* 自然语言解析预览 chip（提交时生效）；窄屏横向滚动，不挤压「添加」按钮 */}
        {title.trim() &&
          (parsedDateLabel || parsed.dueTime || parsed.priority || parsed.repeat || parsed.tags ||
            (defaultDueDate && !dueDate)) && (
          <div className="flex min-w-0 max-w-[45%] flex-shrink items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* 智能视图默认截止日提示（如「今日」视图默认落到今天） */}
            {defaultDueDate && !dueDate && !parsed.dueDate && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap">
                <Calendar size={11} />
                {formatDueDateLabel(defaultDueDate, t, i18n.language)}
              </span>
            )}
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
