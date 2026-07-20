/**
 * MiniCalendar — 详情面板内联月历（无 Dialog/Popover，直接内联展开）
 *
 * - 周一为一周起点（与 mondayWeekStart / 后端重复规则一致）
 * - 今天描边、选中日 primary 填充、非本月日子淡化
 * - 月份切换：方向感知的水平滑动（tweenFast），reduced-motion 退化瞬时
 * - 键盘：格子为 button，Tab/Enter 原生可达；月份切换按钮带 aria-label
 * - 项目内无现成日历组件（无 react-day-picker），此处用主题 token 自绘
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { tweenFast, transitionInstant } from '@/styles/motion-springs';
import { addDays, formatLocalDate, localToday, mondayWeekStart } from '../../../types';

/** 周一起始的星期表头顺序（值对应 Date.getDay()） */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

interface MonthCell {
  date: string;
  dayOfMonth: number;
  inMonth: boolean;
}

/** 生成某月的完整周网格（周一起始，含前后月补位，恒为整周） */
function buildMonthGrid(year: number, month: number): MonthCell[] {
  const first = new Date(year, month, 1);
  const start = mondayWeekStart(first);
  const cells: MonthCell[] = [];
  // 6 周恒定高度会浪费空间；按需生成到覆盖月末的整周为止
  let cursor = start;
  const lastOfMonth = new Date(year, month + 1, 0);
  const end = addDays(mondayWeekStart(lastOfMonth), 6);
  while (cursor <= end) {
    cells.push({
      date: formatLocalDate(cursor),
      dayOfMonth: cursor.getDate(),
      inMonth: cursor.getMonth() === month,
    });
    cursor = addDays(cursor, 1);
  }
  return cells;
}

export const MiniCalendar: React.FC<{
  /** 当前选中日期（YYYY-MM-DD），空串/undefined 表示未选 */
  value?: string;
  onSelect: (date: string) => void;
  className?: string;
}> = ({ value, onSelect, className }) => {
  const { t, i18n } = useTranslation(['todo']);
  const prefersReducedMotion = useReducedMotion();
  const today = localToday();

  // 显示的月份锚点：优先选中日期，其次今天
  const anchor = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today;
  const [viewYm, setViewYm] = useState<{ year: number; month: number }>(() => {
    const [y, m] = anchor.split('-').map(Number);
    return { year: y, month: m - 1 };
  });
  // 月份切换方向（1 = 下月，-1 = 上月），驱动滑动动画方向
  const [direction, setDirection] = useState(0);

  // 外部改选（快捷 chip / 清空）时跟随跳到对应月份
  const anchorYm = anchor.slice(0, 7);
  const [lastAnchorYm, setLastAnchorYm] = useState(anchorYm);
  if (anchorYm !== lastAnchorYm) {
    setLastAnchorYm(anchorYm);
    const [y, m] = anchor.split('-').map(Number);
    if (y !== viewYm.year || m - 1 !== viewYm.month) {
      setDirection(0);
      setViewYm({ year: y, month: m - 1 });
    }
  }

  const cells = useMemo(
    () => buildMonthGrid(viewYm.year, viewYm.month),
    [viewYm.year, viewYm.month],
  );

  // ARIA grid 要求 gridcell 必须位于 row 内：按整周切行
  const weeks = useMemo(() => {
    const rows: MonthCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [cells]);

  const monthLabel = useMemo(() => {
    const locale = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
    try {
      return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(
        new Date(viewYm.year, viewYm.month, 1),
      );
    } catch {
      return `${viewYm.year}-${String(viewYm.month + 1).padStart(2, '0')}`;
    }
  }, [viewYm.year, viewYm.month, i18n.language]);

  const shiftMonth = (delta: 1 | -1) => {
    setDirection(delta);
    setViewYm((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const jumpToToday = () => {
    const [y, m] = today.split('-').map(Number);
    setDirection(0);
    setViewYm({ year: y, month: m - 1 });
  };

  const viewingToday =
    Number(today.slice(0, 4)) === viewYm.year && Number(today.slice(5, 7)) - 1 === viewYm.month;

  const slide = prefersReducedMotion ? 0 : 16;

  return (
    <div className={cn('select-none', className)}>
      <div className="flex items-center justify-between px-0.5 pb-1.5">
        <span className="text-xs font-medium text-foreground tabular-nums">{monthLabel}</span>
        <div className="flex items-center gap-0.5">
          {!viewingToday && (
            <button
              type="button"
              onClick={jumpToToday}
              className="rounded-[var(--radius-shell-control)] px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors duration-150 hover:bg-[color:var(--interactive-hover)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:px-2"
            >
              {t('todo:calendar.backToToday')}
            </button>
          )}
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label={t('todo:calendar.prevMonth')}
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-shell-control)] text-muted-foreground transition-colors duration-150 hover:bg-[color:var(--interactive-hover)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
          >
            <CaretLeft size={13} />
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label={t('todo:calendar.nextMonth')}
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-shell-control)] text-muted-foreground transition-colors duration-150 hover:bg-[color:var(--interactive-hover)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
          >
            <CaretRight size={13} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 pb-0.5">
        {WEEKDAY_ORDER.map((day) => (
          <span
            key={day}
            className="py-0.5 text-center text-2xs font-medium text-muted-foreground/60"
          >
            {t(`todo:repeat.weekdayShort.${day}`)}
          </span>
        ))}
      </div>

      {/* overflow-hidden 裁掉滑动过程中的相邻月；高度随内容（5/6 周）自然过渡 */}
      {/* variants + custom：exit 方向取最新 direction（普通对象会捕获上一渲染的旧方向） */}
      <div className="overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
          <motion.div
            key={`${viewYm.year}-${viewYm.month}`}
            custom={direction}
            variants={{
              enter: (dir: number) => ({ x: dir * slide, opacity: dir === 0 ? 1 : 0 }),
              center: { x: 0, opacity: 1 },
              exit: (dir: number) => ({ x: -dir * slide, opacity: 0 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={prefersReducedMotion ? transitionInstant : tweenFast}
            className="space-y-0.5"
            role="grid"
            aria-label={monthLabel}
          >
            {weeks.map((week) => (
              <div key={week[0].date} role="row" className="grid grid-cols-7">
                {week.map((cell) => {
                  const isToday = cell.date === today;
                  const isSelected = value === cell.date;
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      role="gridcell"
                      aria-selected={isSelected}
                      aria-label={cell.date}
                      title={cell.date}
                      onClick={() => onSelect(cell.date)}
                      className={cn(
                        'mx-auto flex h-9 w-9 items-center justify-center rounded-full text-xs tabular-nums sm:h-[1.625rem] sm:w-[1.625rem] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9',
                        'transition-colors duration-150 motion-reduce:transition-none',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))]',
                        isSelected
                          ? 'bg-primary font-semibold text-primary-foreground'
                          : isToday
                            ? 'font-semibold text-[color:hsl(var(--primary))] ring-1 ring-inset ring-[color:hsl(var(--primary))]/45 hover:bg-[color:var(--interactive-hover)]'
                            : cell.inMonth
                              ? 'text-foreground hover:bg-[color:var(--interactive-hover)]'
                              : 'text-muted-foreground/40 hover:bg-[color:var(--interactive-hover)] hover:text-muted-foreground',
                      )}
                    >
                      {cell.dayOfMonth}
                    </button>
                  );
                })}
              </div>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

export default MiniCalendar;
