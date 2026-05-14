/**
 * 复习日历视图
 *
 * 日历热力图展示每日复习量：
 * - 日历热力图展示每日复习量
 * - 点击日期显示当日复习详情
 * - 使用简单 div 网格实现
 *
 * 🆕 2026-01 新增
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import {
  CaretLeft,
  CaretRight,
  Calendar,
  CheckCircle,
  XCircle,
  Clock,
  Target,
  TrendUp,
  Flame,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useReviewPlanStore, type CalendarHeatmapData, type ReviewHistory } from '@/stores/reviewPlanStore';

// ============================================================================
// 类型定义
// ============================================================================

interface ReviewCalendarViewProps {
  examId?: string;
  className?: string;
  onClose?: () => void;
}

interface DayDetailProps {
  date: string;
  data: CalendarHeatmapData | null;
  histories: ReviewHistory[];
  onClose: () => void;
}

// ============================================================================
// 常量
// ============================================================================

// Weekday/month names are now loaded from i18n locale files (review:calendar.weekdaysShort, etc.)

// ============================================================================
// 热力图颜色等级
// ============================================================================

const getHeatmapColor = (count: number): string => {
  if (count === 0) return 'bg-muted/30';
  if (count <= 3) return 'bg-emerald-200 dark:bg-emerald-900/50';
  if (count <= 7) return 'bg-emerald-300 dark:bg-emerald-800/60';
  if (count <= 12) return 'bg-emerald-400 dark:bg-emerald-700/70';
  if (count <= 20) return 'bg-emerald-500 dark:bg-emerald-600/80';
  return 'bg-emerald-600 dark:bg-emerald-500';
};

const getAccuracyColor = (passed: number, total: number): string => {
  if (total === 0) return 'text-muted-foreground';
  const rate = passed / total;
  if (rate >= 0.9) return 'text-emerald-500';
  if (rate >= 0.7) return 'text-sky-500';
  if (rate >= 0.5) return 'text-amber-500';
  return 'text-red-500';
};

// ============================================================================
// 日期详情组件
// ============================================================================

const DayDetail: React.FC<DayDetailProps> = ({
  date,
  data,
  histories,
  onClose,
}) => {
  const { t, i18n } = useTranslation(['review']);

  const dateObj = new Date(date);
  const formattedDate = dateObj.toLocaleDateString(i18n.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const weekday = dateObj.toLocaleDateString(i18n.language, { weekday: 'long' });

  const accuracy = data && data.count > 0
    ? Math.round((data.passed / data.count) * 100)
    : 0;

  return (
    <Card className="p-4 border-2 border-primary/20 bg-gradient-to-br from-background to-muted/20">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-foreground">{formattedDate}</h3>
          <p className="text-sm text-muted-foreground">{weekday}</p>
        </div>
        <NotionButton variant="ghost" iconOnly size="sm" onClick={onClose} className="w-8 h-8" >
          <X size={16} />
        </NotionButton>
      </div>

      {/* 统计概览 */}
      {data && data.count > 0 ? (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="text-center p-2 rounded-lg bg-sky-500/10">
              <Target size={20} className="text-sky-500 mx-auto mb-1" />
              <p className="text-lg font-bold text-sky-600 dark:text-sky-400">
                {data.count}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('review:calendar.totalReviews', '复习总数')}
              </p>
            </div>
            <div className="text-center p-2 rounded-lg bg-emerald-500/10">
              <CheckCircle size={20} className="text-emerald-500 mx-auto mb-1" />
              <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {data.passed}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('review:calendar.passed', '通过')}
              </p>
            </div>
            <div className="text-center p-2 rounded-lg bg-amber-500/10">
              <TrendUp size={20} className="text-amber-500 mx-auto mb-1" />
              <p className={cn('text-lg font-bold', getAccuracyColor(data.passed, data.count))}>
                {accuracy}%
              </p>
              <p className="text-xs text-muted-foreground">
                {t('review:calendar.accuracy', '正确率')}
              </p>
            </div>
          </div>

          {/* 复习历史列表 */}
          {histories.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {t('review:calendar.history', '复习记录')}
              </h4>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {histories.slice(0, 10).map((h) => (
                  <div
                    key={h.id}
                    className={cn(
                      'flex items-center justify-between p-2 rounded text-sm',
                      h.passed ? 'bg-emerald-500/5' : 'bg-red-500/5'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {h.passed ? (
                        <CheckCircle size={16} className="text-emerald-500" />
                      ) : (
                        <XCircle size={16} className="text-red-500" />
                      )}
                      <span className="text-muted-foreground">
                        Q{h.quality}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(h.reviewed_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-6 text-muted-foreground">
          <Calendar size={40} className="mx-auto mb-2 opacity-50" />
          <p>{t('review:calendar.noData', '当日无复习记录')}</p>
        </div>
      )}
    </Card>
  );
};

// ============================================================================
// 日历单元格组件
// ============================================================================

interface CalendarCellProps {
  date: Date;
  data: CalendarHeatmapData | null;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  onClick: () => void;
}

const CalendarCell: React.FC<CalendarCellProps> = ({
  date,
  data,
  isCurrentMonth,
  isToday,
  isSelected,
  onClick,
}) => {
  const count = data?.count || 0;

  return (
    <NotionButton
      variant="ghost" size="sm"
      onClick={onClick}
      className={cn(
        '!p-1 !h-auto !rounded-lg aspect-square relative',
        'hover:ring-2 hover:ring-primary/30',
        isCurrentMonth ? 'opacity-100' : 'opacity-30',
        isToday && 'ring-2 ring-primary',
        isSelected && 'ring-2 ring-primary bg-primary/10',
        getHeatmapColor(count)
      )}
    >
      <span
        className={cn(
          'absolute top-1 left-1 text-[10px] font-medium',
          isToday ? 'text-primary font-bold' : 'text-foreground/70'
        )}
      >
        {date.getDate()}
      </span>
      {count > 0 && (
        <span className="absolute bottom-1 right-1 text-[9px] font-bold text-emerald-700 dark:text-emerald-300">
          {count}
        </span>
      )}
    </NotionButton>
  );
};

// ============================================================================
// 热力图图例
// ============================================================================

const HeatmapLegend: React.FC = () => {
  const { t } = useTranslation(['review']);

  return (
    <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
      <span>{t('review:calendar.less', '少')}</span>
      <div className={cn('w-3 h-3 rounded', getHeatmapColor(0))} />
      <div className={cn('w-3 h-3 rounded', getHeatmapColor(2))} />
      <div className={cn('w-3 h-3 rounded', getHeatmapColor(5))} />
      <div className={cn('w-3 h-3 rounded', getHeatmapColor(10))} />
      <div className={cn('w-3 h-3 rounded', getHeatmapColor(15))} />
      <div className={cn('w-3 h-3 rounded', getHeatmapColor(25))} />
      <span>{t('review:calendar.more', '多')}</span>
    </div>
  );
};

// ============================================================================
// 连续学习天数统计
// ============================================================================

interface StreakStatsProps {
  calendarData: CalendarHeatmapData[];
}

const StreakStats: React.FC<StreakStatsProps> = ({ calendarData }) => {
  const { t } = useTranslation(['review']);

  const stats = useMemo(() => {
    // 计算连续学习天数
    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;
    let totalDays = 0;
    let totalReviews = 0;

    const sortedData = [...calendarData].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const today = new Date().toISOString().split('T')[0];

    for (let i = 0; i < sortedData.length; i++) {
      const item = sortedData[i];
      totalReviews += item.count;

      if (item.count > 0) {
        totalDays++;
        tempStreak++;
        longestStreak = Math.max(longestStreak, tempStreak);

        // 计算当前连续天数（从今天开始往前数）
        if (i === 0 && item.date === today) {
          currentStreak = 1;
        } else if (i > 0 && currentStreak > 0) {
          const prevDate = new Date(sortedData[i - 1].date);
          const currDate = new Date(item.date);
          const diffDays = Math.floor(
            (prevDate.getTime() - currDate.getTime()) / (1000 * 60 * 60 * 24)
          );
          if (diffDays === 1) {
            currentStreak++;
          }
        }
      } else {
        tempStreak = 0;
        if (i > 0 && sortedData[i - 1].count > 0) {
          // 连续断了
        }
      }
    }

    return {
      currentStreak,
      longestStreak,
      totalDays,
      totalReviews,
    };
  }, [calendarData]);

  return (
    <div className="grid grid-cols-4 gap-2">
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <Flame size={20} className="text-orange-500 mx-auto mb-1" />
        <p className="text-lg font-bold text-orange-600 dark:text-orange-400">
          {stats.currentStreak}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.currentStreak', '当前连续')}
        </p>
      </div>
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <TrendUp size={20} className="text-purple-500 mx-auto mb-1" />
        <p className="text-lg font-bold text-purple-600 dark:text-purple-400">
          {stats.longestStreak}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.longestStreak', '最长连续')}
        </p>
      </div>
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <Calendar size={20} className="text-sky-500 mx-auto mb-1" />
        <p className="text-lg font-bold text-sky-600 dark:text-sky-400">
          {stats.totalDays}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.totalDays', '学习天数')}
        </p>
      </div>
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <Target size={20} className="text-emerald-500 mx-auto mb-1" />
        <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
          {stats.totalReviews}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.totalReviews', '复习总数')}
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ReviewCalendarView: React.FC<ReviewCalendarViewProps> = ({
  examId,
  className,
  onClose,
}) => {
  const { t, i18n } = useTranslation(['review', 'common']);

  // Store
  const { calendarData, loadCalendarData } = useReviewPlanStore(
    useShallow((state) => ({
      calendarData: state.calendarData,
      loadCalendarData: state.loadCalendarData,
    }))
  );

  // 本地状态
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedHistories, setSelectedHistories] = useState<ReviewHistory[]>([]);

  // 加载数据
  useEffect(() => {
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3);
    const endDate = new Date();

    loadCalendarData(
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0],
      examId
    );
  }, [examId, loadCalendarData]);

  // 生成日历数据映射
  const dataMap = useMemo(() => {
    const map = new Map<string, CalendarHeatmapData>();
    calendarData.forEach((d) => map.set(d.date, d));
    return map;
  }, [calendarData]);

  // 生成当前月份的日历
  const calendarDays = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    // 获取当月第一天和最后一天
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // 获取上个月末尾的日期来填充第一周
    const startPadding = firstDay.getDay();
    const prevMonthLastDay = new Date(year, month, 0).getDate();

    const days: {
      date: Date;
      isCurrentMonth: boolean;
    }[] = [];

    // 添加上个月的日期
    for (let i = startPadding - 1; i >= 0; i--) {
      days.push({
        date: new Date(year, month - 1, prevMonthLastDay - i),
        isCurrentMonth: false,
      });
    }

    // 添加当月的日期
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push({
        date: new Date(year, month, i),
        isCurrentMonth: true,
      });
    }

    // 添加下个月的日期来填满最后一行
    const endPadding = 42 - days.length; // 6 rows * 7 days
    for (let i = 1; i <= endPadding; i++) {
      days.push({
        date: new Date(year, month + 1, i),
        isCurrentMonth: false,
      });
    }

    return days;
  }, [currentDate]);

  // 切换月份
  const goToPrevMonth = useCallback(() => {
    setCurrentDate((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() - 1);
      return newDate;
    });
  }, []);

  const goToNextMonth = useCallback(() => {
    setCurrentDate((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + 1);
      return newDate;
    });
  }, []);

  const goToToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  // 选择日期
  const handleSelectDate = useCallback((date: Date) => {
    const dateStr = date.toISOString().split('T')[0];
    setSelectedDate(dateStr);
    // 这里可以加载当日的复习历史
    setSelectedHistories([]);
  }, []);

  // 关闭详情
  const handleCloseDetail = useCallback(() => {
    setSelectedDate(null);
    setSelectedHistories([]);
  }, []);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekdays = t('review:calendar.weekdaysShort', { returnObjects: true }) as string[];
  const monthsFull = t('review:calendar.monthsFull', { returnObjects: true }) as string[];
  const monthName = t('review:calendar.monthYearFormat', {
    year: currentDate.getFullYear(),
    monthName: monthsFull[currentDate.getMonth()],
  });

  return (
    <div className={cn('space-y-4', className)}>
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {t('review:calendar.title', '复习日历')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('review:calendar.subtitle', '追踪你的复习记录')}
          </p>
        </div>
        {onClose && (
          <NotionButton variant="ghost" iconOnly size="sm" onClick={onClose}>
            <X size={20} />
          </NotionButton>
        )}
      </div>

      {/* 统计概览 */}
      <StreakStats calendarData={calendarData} />

      {/* 日历区域 */}
      <Card className="p-4">
        {/* 月份导航 */}
        <div className="flex items-center justify-between mb-4">
          <NotionButton variant="ghost" iconOnly size="sm" onClick={goToPrevMonth}>
            <CaretLeft size={20} />
          </NotionButton>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-foreground">{monthName}</h3>
            <NotionButton
              variant="outline"
              size="sm"
              onClick={goToToday}
              className="h-7 text-xs"
            >
              {t('review:calendar.today', '今天')}
            </NotionButton>
          </div>
          <NotionButton variant="ghost" iconOnly size="sm" onClick={goToNextMonth}>
            <CaretRight size={20} />
          </NotionButton>
        </div>

        {/* 星期标题 */}
        <div className="grid grid-cols-7 gap-1 mb-2">
          {weekdays.map((day, index) => (
            <div
              key={index}
              className={cn(
                'text-center text-xs font-medium py-1',
                index === 0 || index === 6
                  ? 'text-muted-foreground'
                  : 'text-foreground'
              )}
            >
              {day}
            </div>
          ))}
        </div>

        {/* 日历网格 */}
        <div className="grid grid-cols-7 gap-1">
          {calendarDays.map((day, index) => {
            const dateStr = day.date.toISOString().split('T')[0];
            const data = dataMap.get(dateStr) || null;
            const isToday = day.date.getTime() === today.getTime();
            const isSelected = dateStr === selectedDate;

            return (
              <CalendarCell
                key={index}
                date={day.date}
                data={data}
                isCurrentMonth={day.isCurrentMonth}
                isToday={isToday}
                isSelected={isSelected}
                onClick={() => handleSelectDate(day.date)}
/>
            );
          })}
        </div>

        {/* 图例 */}
        <div className="mt-4 pt-3 border-t border-border/50">
          <HeatmapLegend />
        </div>
      </Card>

      {/* 选中日期详情 */}
      {selectedDate && (
        <DayDetail
          date={selectedDate}
          data={dataMap.get(selectedDate) || null}
          histories={selectedHistories}
          onClose={handleCloseDetail}
/>
      )}
    </div>
  );
};

export default ReviewCalendarView;
