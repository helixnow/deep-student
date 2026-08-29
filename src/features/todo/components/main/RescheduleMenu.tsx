/**
 * RescheduleMenu — 行内一键改期浮层
 *
 * 快速改期：不进详情面板即可挪动到期日。
 * 使用项目 Popover（portal + 碰撞检测定位），不再被滚动容器裁切。
 * 智能选项：今天 / 明天 / 周末 / 下周一 / 两周后 + 内嵌迷你月历 + 移除日期。
 * 月历复用 detail/MiniCalendar（点选即提交，替代原 <input type="date">——
 * 后者每次 change 都保存，键盘逐位输入年份会中途提交）。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Calendar,
  CalendarPlus,
  Sun,
  Umbrella,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { useTodoStore } from '../../stores/useTodoStore';
import type { TodoItem } from '../../types';
import { addDays, formatLocalDate, mondayWeekStart } from '../../types';
import { formatDueDateLabel } from './dueDateLabel';
// 只读复用详情面板的内联月历（detail/ 目录归 detail 代理所有，只 import 不改动）
import { MiniCalendar } from './detail/MiniCalendar';

interface RescheduleOption {
  key: string;
  label: string;
  date: string;
  icon: React.ReactNode;
}

export const RescheduleMenu: React.FC<{ item: TodoItem }> = ({ item }) => {
  const { t, i18n } = useTranslation(['todo']);
  const updateItem = useTodoStore((s) => s.updateItem);
  const [open, setOpen] = useState(false);

  // 打开时刻计算「今天/明天/周末」，避免组件常驻跨午夜后日期过期
  const options = useMemo<RescheduleOption[]>(() => {
    if (!open) return [];
    const now = new Date();
    const today = formatLocalDate(now);
    const tomorrow = formatLocalDate(addDays(now, 1));
    // 即将到来的周六；今天已是周六/周日则不再提供「周末」
    const daysToSaturday = (6 - now.getDay() + 7) % 7;
    const weekend =
      now.getDay() === 6 || now.getDay() === 0
        ? null
        : formatLocalDate(addDays(now, daysToSaturday));
    const nextMonday = formatLocalDate(addDays(mondayWeekStart(now), 7));
    const inTwoWeeks = formatLocalDate(addDays(now, 14));

    const candidates: Array<RescheduleOption | null> = [
      { key: 'today', label: t('todo:reschedule.today'), date: today, icon: <Sun size={14} /> },
      {
        key: 'tomorrow',
        label: t('todo:reschedule.tomorrow'),
        date: tomorrow,
        icon: <ArrowRight size={14} />,
      },
      weekend
        ? {
            key: 'weekend',
            label: t('todo:reschedule.weekend'),
            date: weekend,
            icon: <Umbrella size={14} />,
          }
        : null,
      {
        key: 'nextMonday',
        label: t('todo:reschedule.nextMonday'),
        date: nextMonday,
        icon: <Calendar size={14} />,
      },
      {
        key: 'inTwoWeeks',
        label: t('todo:reschedule.inTwoWeeks'),
        date: inTwoWeeks,
        icon: <CalendarPlus size={14} />,
      },
    ];
    return candidates.filter(
      (opt): opt is RescheduleOption => opt !== null && opt.date !== item.dueDate,
    );
  }, [open, item.dueDate, t]);

  const handlePick = useCallback(
    (date: string) => {
      setOpen(false);
      void updateItem({ id: item.id, dueDate: date });
    },
    [item.id, updateItem],
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
            title={t('todo:reschedule.title')}
            aria-label={t('todo:reschedule.title')}
            className="flex-shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-60 !p-1.5 [@media(pointer:coarse)]:!p-3.5 [@media(pointer:coarse)]:!-m-2 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          >
            <CalendarPlus size={16} />
          </DsButton>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-64 rounded-[var(--radius-shell-control)] p-1.5"
          role="menu"
          aria-label={t('todo:reschedule.title')}
        >
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="menuitem"
              onClick={() => handlePick(opt.date)}
              className={cn(
                'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-xs text-foreground transition-colors duration-150',
                '[@media(pointer:coarse)]:min-h-[2.75rem]',
                'hover:bg-[color:var(--interactive-hover)] focus-visible:bg-[color:var(--interactive-hover)] focus:outline-none',
              )}
            >
              <span className="text-muted-foreground">{opt.icon}</span>
              <span className="flex-1">{opt.label}</span>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {formatDueDateLabel(opt.date, t, i18n.language)}
              </span>
            </button>
          ))}

          <div className="mx-1 my-1 h-px bg-border/40" role="separator" />

          {/* 内嵌迷你月历：点选即提交并收起（Esc 由 Popover 原生关闭、不产生中间保存）。
              MiniCalendar 自带 role="grid" 与月份 aria-label */}
          <MiniCalendar value={item.dueDate || ''} onSelect={handlePick} className="px-1.5 py-1" />

          {item.dueDate && (
            <button
              type="button"
              role="menuitem"
              onClick={() => handlePick('')}
              className={cn(
                'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-150',
                '[@media(pointer:coarse)]:min-h-[2.75rem]',
                'hover:bg-[color:var(--interactive-hover)] focus-visible:bg-[color:var(--interactive-hover)] focus:outline-none',
              )}
            >
              <X size={14} />
              <span className="flex-1">{t('todo:reschedule.clear')}</span>
            </button>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
};
