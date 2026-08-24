/**
 * RowPriorityMenu — 行内一键改优先级浮层
 *
 * 与 RescheduleMenu 同范式：hover 渐显图标按钮 + Popover 锚定菜单，
 * 不进详情面板即可调整优先级（行内 p1-p4 快改）。
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Flag,
  Minus,
  Warning,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { useTodoStore } from '../../stores/useTodoStore';
import type { TodoItem, TodoPriority } from '../../types';
import { PRIORITY_CONFIG } from '../../types';

const PRIORITY_ORDER: TodoPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

// 图标映射与 TodoItemRow.PriorityIcon 一致；此处内联以避免 TodoItemRow ↔ 本模块循环依赖
const PRIORITY_ICONS: Record<string, React.ElementType> = {
  Minus,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  AlertTriangle: Warning,
};

const InlinePriorityIcon: React.FC<{ priority: TodoPriority; className?: string }> = ({
  priority,
  className,
}) => {
  const config = PRIORITY_CONFIG[priority];
  const Icon = PRIORITY_ICONS[config.icon] || Minus;
  return <Icon size={14} className={cn(config.color, className)} />;
};

export const RowPriorityMenu: React.FC<{ item: TodoItem }> = ({ item }) => {
  const { t } = useTranslation(['todo']);
  const updateItem = useTodoStore((s) => s.updateItem);
  const [open, setOpen] = useState(false);

  const handlePick = useCallback(
    (priority: TodoPriority) => {
      setOpen(false);
      if (priority === item.priority) return;
      void updateItem({ id: item.id, priority });
    },
    [item.id, item.priority, updateItem],
  );

  return (
    // stopPropagation：菜单交互不应触发所在行的选中/详情
    <span
      className="flex-shrink-0"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <DsButton
            variant="utility"
            size="icon"
            iconOnly
            title={t('todo:actions.setPriority', '设置优先级')}
            aria-label={t('todo:actions.setPriority', '设置优先级')}
            // 触屏：min-h/min-w 压过 lg: 档的固定尺寸，保住 44px 命中区
            className="flex-shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-60 !p-1.5 [@media(pointer:coarse)]:!p-3.5 [@media(pointer:coarse)]:!-m-2 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          >
            <Flag
              size={16}
              weight={item.priority !== 'none' ? 'fill' : 'regular'}
              className={item.priority !== 'none' ? PRIORITY_CONFIG[item.priority].color : undefined}
            />
          </DsButton>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-44 rounded-[var(--radius-shell-control)] p-1.5"
          role="menu"
          aria-label={t('todo:actions.setPriority', '设置优先级')}
        >
          {PRIORITY_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              role="menuitemradio"
              aria-checked={item.priority === p}
              onClick={() => handlePick(p)}
              className={cn(
                'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-xs text-foreground transition-colors duration-150',
                '[@media(pointer:coarse)]:min-h-[2.75rem]',
                'hover:bg-[color:var(--interactive-hover)] focus-visible:bg-[color:var(--interactive-hover)] focus:outline-none',
              )}
            >
              <InlinePriorityIcon priority={p} className="h-3.5 w-3.5" />
              <span className="flex-1">{t(PRIORITY_CONFIG[p].labelKey)}</span>
              {item.priority === p && (
                <Check size={13} className="text-[color:hsl(var(--primary))]" />
              )}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </span>
  );
};
