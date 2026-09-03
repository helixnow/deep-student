/**
 * PriorityFilterMenu — 工具栏优先级过滤器（AppMenu 锚定下拉）
 * 直接消费 store 现有的 filter.priorityFilter / setPriorityFilter。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FunnelSimple } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { useTodoStore } from '../../stores/useTodoStore';
import type { TodoPriority } from '../../types';
import { PRIORITY_CONFIG } from '../../types';
import { PriorityIcon } from './TodoItemRow';

const PRIORITY_ORDER: TodoPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export const PriorityFilterMenu: React.FC<{ triggerClassName?: string }> = ({ triggerClassName }) => {
  const { t } = useTranslation(['todo']);
  const priorityFilter = useTodoStore((s) => s.filter.priorityFilter);
  const setPriorityFilter = useTodoStore((s) => s.setPriorityFilter);
  const items = useTodoStore((s) => s.items);

  // 每档优先级的当前数据集条数（选择前预知筛选结果规模）
  const countByPriority = useMemo(() => {
    const counts: Record<TodoPriority, number> = {
      none: 0,
      low: 0,
      medium: 0,
      high: 0,
      urgent: 0,
    };
    for (const item of items) {
      counts[item.priority as TodoPriority] = (counts[item.priority as TodoPriority] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  return (
    <AppMenu>
      <AppMenuTrigger asChild>
        <DsButton
          variant="utility"
          size="sm"
          data-selected={Boolean(priorityFilter)}
          className={cn(
            triggerClassName,
            priorityFilter &&
              '!bg-[color:var(--button-primary-surface)] !text-[color:var(--button-primary-foreground)]',
          )}
          title={t('todo:filters.priority')}
          aria-label={t('todo:filters.priority')}
        >
          <FunnelSimple size={14} />
          <span className="hidden sm:inline">
            {priorityFilter
              ? t(PRIORITY_CONFIG[priorityFilter].labelKey)
              : t('todo:filters.priority')}
          </span>
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent align="end" width={180}>
        <AppMenuItem
          checked={!priorityFilter}
          onClick={() => setPriorityFilter(null)}
        >
          {t('todo:filters.allPriorities')}
        </AppMenuItem>
        <AppMenuSeparator />
        {PRIORITY_ORDER.map((p) => (
          <AppMenuItem
            key={p}
            checked={priorityFilter === p}
            onClick={() => setPriorityFilter(p)}
            icon={<PriorityIcon priority={p} className="h-3.5 w-3.5" />}
            suffix={
              countByPriority[p] > 0 ? (
                <span className="text-xs tabular-nums text-muted-foreground/60">
                  {countByPriority[p]}
                </span>
              ) : undefined
            }
          >
            {t(PRIORITY_CONFIG[p].labelKey)}
          </AppMenuItem>
        ))}
      </AppMenuContent>
    </AppMenu>
  );
};
