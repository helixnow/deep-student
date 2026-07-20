/**
 * 复习日历视图
 *
 * 日历热力图展示每日复习量：
 * - 日历热力图展示每日复习量（密度色阶 + 图例）
 * - 点击日期内联展开当日明细（无弹窗）
 * - 月份切换带方向感滑动过渡；数据随所见月份加载
 *
 * 🆕 2026-01 新增；2026-07 对标 Anki 体验改造
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card } from '@/components/ui/shad/Card';
import {
  CaretLeft,
  CaretRight,
  Calendar,
  CheckCircle,
  XCircle,
  Target,
  TrendUp,
  Fire as Flame,
  Info,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import {
  useReviewPlanStore,
  type CalendarHeatmapData,
  type ReviewPlan,
} from '@/stores/reviewPlanStore';
import { useQuestionBankStore, type Question } from '@/stores/questionBankStore';
import { getReviewQuestionTypeMeta } from '@/components/review/reviewQuestionTypeMeta';

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
  /** 当日到期的复习计划（逾期计划归入今天），用于当日队列明细 */
  duePlans: ReviewPlan[];
  questionMap: Map<string, Question>;
  onClose: () => void;
}

// ============================================================================
// 常量
// ============================================================================

// Weekday/month names are now loaded from i18n locale files (review:calendar.weekdaysShort, etc.)

// ★ P1 修复：日期字符串统一用本地日期拼接。
// 之前使用 toISOString().split('T')[0]（UTC 日期），对 UTC+8 用户本地 00:00-08:00
// 会得到前一天，导致热力图格子取数与"今天"判断整天级错位。
const formatLocalDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

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
// 日期详情组件（内联展开，无弹窗）
// ============================================================================

const DayDetail: React.FC<DayDetailProps> = ({
  date,
  data,
  duePlans,
  questionMap,
  onClose,
}) => {
  const { t, i18n } = useTranslation(['review']);

  // 按本地时区解析（new Date('YYYY-MM-DD') 会按 UTC 解析，西半球时区下日期/星期偏一天）
  const [year, month, day] = date.split('-').map(Number);
  const dateObj = new Date(year, (month || 1) - 1, day || 1);
  const formattedDate = dateObj.toLocaleDateString(i18n.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const weekday = dateObj.toLocaleDateString(i18n.language, { weekday: 'long' });

  const accuracy = data && data.count > 0
    ? Math.round((data.passed / data.count) * 100)
    : 0;
  const failed = data ? Math.max(0, data.count - data.passed) : 0;

  return (
    <Card className="ui-rise-in p-4 border-primary/20 bg-gradient-to-br from-background to-muted/20">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-foreground">{formattedDate}</h3>
          <p className="text-sm text-muted-foreground">{weekday}</p>
        </div>
        <NotionButton
          variant="ghost"
          iconOnly
          size="sm"
          onClick={onClose}
          aria-label={t('review:calendar.closeDetail')}
          className="w-8 h-8"
        >
          <X size={16} />
        </NotionButton>
      </div>

      {/* 统计概览 */}
      {data && data.count > 0 ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-1">
            <div className="text-center p-2 rounded-lg bg-sky-500/10">
              <Target size={20} className="text-sky-500 mx-auto mb-1" />
              <p className="text-lg font-bold tabular-nums text-sky-600 dark:text-sky-400">
                {data.count}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('review:calendar.totalReviews')}
              </p>
            </div>
            <div className="text-center p-2 rounded-lg bg-emerald-500/10">
              <CheckCircle size={20} className="text-emerald-500 mx-auto mb-1" />
              <p className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                {data.passed}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('review:calendar.passed')}
              </p>
            </div>
            <div className="text-center p-2 rounded-lg bg-red-500/10">
              <XCircle size={20} className="text-red-500 mx-auto mb-1" />
              <p className="text-lg font-bold tabular-nums text-red-600 dark:text-red-400">
                {failed}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('review:calendar.failed')}
              </p>
            </div>
            <div className="text-center p-2 rounded-lg bg-amber-500/10">
              <TrendUp size={20} className="text-amber-500 mx-auto mb-1" />
              <p className={cn('text-lg font-bold tabular-nums', getAccuracyColor(data.passed, data.count))}>
                {accuracy}%
              </p>
              <p className="text-xs text-muted-foreground">
                {t('review:calendar.accuracy')}
              </p>
            </div>
          </div>

          {/* 说明：store 仅提供按计划（planId）查询复习历史的接口，没有按日期查询的方法；
              此前这里固定渲染空的「复习记录」区块（histories 恒为 []），已移除，仅展示当日统计。 */}
        </>
      ) : duePlans.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground">
          <Calendar size={40} className="mx-auto mb-2 opacity-50" />
          <p>{t('review:calendar.noData')}</p>
        </div>
      ) : null}

      {/* 当日到期队列明细（内联展开，无弹窗） */}
      {duePlans.length > 0 && (
        <div className={cn('space-y-1.5', data && data.count > 0 && 'mt-4 pt-3 border-t border-border/50')}>
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <Target size={13} />
            {t('review:calendar.dueQueue', { count: duePlans.length })}
          </p>
          <ul className="space-y-1 max-h-52 overflow-y-auto pr-1">
            {duePlans.slice(0, 30).map((plan) => {
              const question = questionMap.get(plan.question_id);
              const typeMeta = getReviewQuestionTypeMeta(question?.question_type);
              const TypeIcon = typeMeta.Icon;
              return (
                <li
                  key={plan.id}
                  className="flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-1.5"
                >
                  <TypeIcon size={13} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">
                    {question?.content || t('review:unknownQuestion')}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t(`review:status.${plan.status}`, plan.status)}
                  </span>
                </li>
              );
            })}
          </ul>
          {duePlans.length > 30 && (
            <p className="text-center text-[10px] text-muted-foreground">
              {t('review:calendar.dueMore', { count: duePlans.length - 30 })}
            </p>
          )}
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
  /** 当日到期计划数（到期密度指示） */
  dueCount: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  onClick: () => void;
}

const CalendarCell: React.FC<CalendarCellProps> = ({
  date,
  data,
  dueCount,
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
      aria-pressed={isSelected}
      className={cn(
        // 触控目标 ≥40px（min-h/min-w 兜底，宽格子仍随网格拉伸）
        '!p-1 !h-auto !rounded-lg aspect-square relative min-h-10 min-w-10',
        'ui-state-colors hover:ring-2 hover:ring-primary/30',
        isCurrentMonth ? 'opacity-100' : 'opacity-30',
        isToday && 'ring-2 ring-primary',
        isSelected && 'ring-2 ring-primary bg-primary/10',
        getHeatmapColor(count)
      )}
    >
      <span
        className={cn(
          'absolute top-1 left-1 text-[10px] font-medium leading-none',
          isToday
            ? 'flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-0.5 font-bold text-primary-foreground'
            : 'text-foreground/70'
        )}
      >
        {date.getDate()}
      </span>
      {count > 0 && (
        <span className="absolute bottom-1 right-1 text-[9px] font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
          {count}
        </span>
      )}
      {/* 到期密度指示（琥珀色，与已完成的绿色区分） */}
      {dueCount > 0 && (
        <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 text-[9px] font-bold tabular-nums text-amber-600 dark:text-amber-400">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              dueCount > 10 ? 'bg-amber-600 dark:bg-amber-400' : dueCount > 5 ? 'bg-amber-500' : 'bg-amber-400/80'
            )}
          />
          {dueCount}
        </span>
      )}
    </NotionButton>
  );
};

// ============================================================================
// 热力图图例
// ============================================================================

const HeatmapLegend: React.FC<{ showDueLegend?: boolean }> = ({ showDueLegend }) => {
  const { t } = useTranslation(['review']);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      {/* 到期密度图例（琥珀色，与已完成绿色区分） */}
      {showDueLegend ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          {t('review:calendar.dueLegend')}
        </span>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-1">
        <span>{t('review:calendar.less')}</span>
        <div className={cn('w-3 h-3 rounded', getHeatmapColor(0))} />
        <div className={cn('w-3 h-3 rounded', getHeatmapColor(2))} />
        <div className={cn('w-3 h-3 rounded', getHeatmapColor(5))} />
        <div className={cn('w-3 h-3 rounded', getHeatmapColor(10))} />
        <div className={cn('w-3 h-3 rounded', getHeatmapColor(15))} />
        <div className={cn('w-3 h-3 rounded', getHeatmapColor(25))} />
        <span>{t('review:calendar.more')}</span>
      </div>
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
    // ★ 修复：原实现依赖数组相邻元素推断连续性，数据缺天/未含今天时
    // currentStreak 恒为 0 或漏算。改为基于"有复习的日期集合"逐日回溯。
    const reviewedDates = new Set<string>();
    let totalReviews = 0;
    for (const item of calendarData) {
      totalReviews += item.count;
      if (item.count > 0) reviewedDates.add(item.date);
    }

    // 当前连续：从今天回溯；今天还没复习不打断（从昨天起算，Anki 同款宽限）
    let currentStreak = 0;
    const cursor = new Date();
    if (!reviewedDates.has(formatLocalDate(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (reviewedDates.has(formatLocalDate(cursor))) {
      currentStreak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    // 最长连续：升序遍历唯一日期，按相邻天数差累计
    const sortedDates = Array.from(reviewedDates).sort();
    let longestStreak = 0;
    let tempStreak = 0;
    let prevTime = 0;
    const DAY_MS = 24 * 60 * 60 * 1000;
    for (const dateStr of sortedDates) {
      const [y, m, d] = dateStr.split('-').map(Number);
      const time = new Date(y, (m || 1) - 1, d || 1).getTime();
      tempStreak = prevTime && Math.round((time - prevTime) / DAY_MS) === 1 ? tempStreak + 1 : 1;
      longestStreak = Math.max(longestStreak, tempStreak);
      prevTime = time;
    }

    return {
      currentStreak,
      longestStreak,
      totalDays: reviewedDates.size,
      totalReviews,
    };
  }, [calendarData]);

  return (
    <div className="grid grid-cols-4 gap-2">
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <Flame size={20} className="text-orange-500 mx-auto mb-1" />
        <p className="text-lg font-bold tabular-nums text-orange-600 dark:text-orange-400">
          {stats.currentStreak}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.currentStreak')}
        </p>
      </div>
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <TrendUp size={20} className="text-purple-500 mx-auto mb-1" />
        <p className="text-lg font-bold tabular-nums text-purple-600 dark:text-purple-400">
          {stats.longestStreak}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.longestStreak')}
        </p>
      </div>
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <Calendar size={20} className="text-sky-500 mx-auto mb-1" />
        <p className="text-lg font-bold tabular-nums text-sky-600 dark:text-sky-400">
          {stats.totalDays}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.totalDays')}
        </p>
      </div>
      <div className="text-center p-2 rounded-lg bg-muted/30">
        <Target size={20} className="text-emerald-500 mx-auto mb-1" />
        <p className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
          {stats.totalReviews}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t('review:calendar.totalReviews')}
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
  const { t } = useTranslation(['review', 'common']);

  // Store
  const { calendarData, loadCalendarData, allPlans, loadAllPlans } = useReviewPlanStore(
    useShallow((state) => ({
      calendarData: state.calendarData,
      loadCalendarData: state.loadCalendarData,
      allPlans: state.allPlans,
      loadAllPlans: state.loadAllPlans,
    }))
  );

  // 题目内容映射（当日到期明细展示题干；仅传入 examId 时可用）
  const { questions, loadQuestions } = useQuestionBankStore(
    useShallow((state) => ({
      questions: state.questions,
      loadQuestions: state.loadQuestions,
    }))
  );

  // 本地状态
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // 月份切换方向（驱动滑动过渡的入场方向）
  const [slideDir, setSlideDir] = useState<'left' | 'right'>('left');

  const monthKey = `${currentDate.getFullYear()}-${currentDate.getMonth()}`;

  // 加载数据
  // ★ 修复：原实现固定加载"今天往前 3 个月"，翻到更早月份时热力图恒为空。
  // 现在数据范围跟随所见月份：覆盖 [min(3 个月前, 所见月首周), max(今天, 所见月末周)]，
  // 连击统计所需的近期数据始终包含在内。
  useEffect(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    // 所见月份前后各留一周，覆盖首尾行的相邻月格子
    const visibleStart = new Date(year, month, 1 - 7);
    const visibleEnd = new Date(year, month + 1, 7);
    const today = new Date();

    const startDate = visibleStart < threeMonthsAgo ? visibleStart : threeMonthsAgo;
    const endDate = visibleEnd > today ? visibleEnd : today;

    loadCalendarData(
      formatLocalDate(startDate),
      formatLocalDate(endDate),
      examId
    );
    // monthKey 代表所见月份变化（currentDate 对象引用每次翻月都会变，用 key 去抖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, monthKey, loadCalendarData]);

  // 加载到期密度数据（计划的 next_review_date）与题目内容
  useEffect(() => {
    if (!examId) return;
    loadAllPlans(examId);
    loadQuestions(examId);
  }, [examId, loadAllPlans, loadQuestions]);

  // 生成日历数据映射
  const dataMap = useMemo(() => {
    const map = new Map<string, CalendarHeatmapData>();
    calendarData.forEach((d) => map.set(d.date, d));
    return map;
  }, [calendarData]);

  const questionMap = useMemo(() => {
    const map = new Map<string, Question>();
    questions.forEach((q, id) => map.set(id, q));
    return map;
  }, [questions]);

  const todayStr = formatLocalDate(new Date());

  // 到期密度映射：date -> 当日到期计划（逾期计划归入今天；暂停计划不计）
  // ★ 多窗口隔离：allPlans 是全局单槽位，只统计属于本题目集的计划
  const dueMap = useMemo(() => {
    const map = new Map<string, ReviewPlan[]>();
    if (!examId) return map;
    for (const plan of allPlans) {
      if (plan.exam_id !== examId) continue;
      if (plan.status === 'suspended') continue;
      const date = plan.next_review_date < todayStr ? todayStr : plan.next_review_date;
      const list = map.get(date);
      if (list) list.push(plan);
      else map.set(date, [plan]);
    }
    return map;
  }, [allPlans, examId, todayStr]);

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

  // 切换月份（记录方向，驱动滑动过渡）
  const goToPrevMonth = useCallback(() => {
    setSlideDir('right');
    setCurrentDate((prev) => {
      const newDate = new Date(prev.getFullYear(), prev.getMonth() - 1, 1);
      return newDate;
    });
  }, []);

  const goToNextMonth = useCallback(() => {
    setSlideDir('left');
    setCurrentDate((prev) => {
      const newDate = new Date(prev.getFullYear(), prev.getMonth() + 1, 1);
      return newDate;
    });
  }, []);

  const goToToday = useCallback(() => {
    const now = new Date();
    const prevKey = currentDate.getFullYear() * 12 + currentDate.getMonth();
    const nowKey = now.getFullYear() * 12 + now.getMonth();
    if (prevKey !== nowKey) {
      setSlideDir(nowKey > prevKey ? 'left' : 'right');
    }
    setCurrentDate(now);
  }, [currentDate]);

  // 选择日期（点击已选中的日期再次点击可收起）
  const handleSelectDate = useCallback((date: Date) => {
    const dateStr = formatLocalDate(date);
    setSelectedDate((prev) => (prev === dateStr ? null : dateStr));
  }, []);

  // 关闭详情
  const handleCloseDetail = useCallback(() => {
    setSelectedDate(null);
  }, []);

  // 从未复习过时展示整体空态引导（数据加载范围内复习总数为 0）
  const hasAnyReview = useMemo(
    () => calendarData.some((d) => d.count > 0),
    [calendarData]
  );

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
            {t('review:calendar.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('review:calendar.subtitle')}
          </p>
        </div>
        {onClose && (
          <NotionButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={onClose}
            aria-label={t('common:close')}
          >
            <X size={20} />
          </NotionButton>
        )}
      </div>

      {/* 从未复习过：空态引导提示条 */}
      {!hasAnyReview && (
        <div className="flex items-start gap-2 rounded-md bg-info/10 px-3 py-2 text-xs text-muted-foreground">
          <Info size={14} className="mt-0.5 shrink-0 text-info" />
          <span>{t('review:calendar.emptyHint')}</span>
        </div>
      )}

      {/* 统计概览 */}
      <StreakStats calendarData={calendarData} />

      {/* 日历区域 */}
      <Card className="p-4 overflow-hidden">
        {/* 月份导航 */}
        <div className="flex items-center justify-between mb-4">
          <NotionButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={goToPrevMonth}
            aria-label={t('review:calendar.prevMonth')}
          >
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
              {t('review:calendar.today')}
            </NotionButton>
          </div>
          <NotionButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={goToNextMonth}
            aria-label={t('review:calendar.nextMonth')}
          >
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

        {/* 日历网格（key 驱动重挂载 + 方向感滑动入场） */}
        <div
          key={monthKey}
          className={cn(
            'grid grid-cols-7 gap-1 ui-slide-fade-in',
            slideDir === 'left' ? '[--ui-enter-x:24px]' : '[--ui-enter-x:-24px]'
          )}
        >
          {calendarDays.map((day, index) => {
            const dateStr = formatLocalDate(day.date);
            const data = dataMap.get(dateStr) || null;
            const isToday = day.date.getTime() === today.getTime();
            const isSelected = dateStr === selectedDate;

            return (
              <CalendarCell
                key={index}
                date={day.date}
                data={data}
                dueCount={dueMap.get(dateStr)?.length ?? 0}
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
          <HeatmapLegend showDueLegend={!!examId && dueMap.size > 0} />
        </div>
      </Card>

      {/* 选中日期详情（内联展开，key 驱动切换日期时重新入场） */}
      {selectedDate && (
        <DayDetail
          key={selectedDate}
          date={selectedDate}
          data={dataMap.get(selectedDate) || null}
          duePlans={dueMap.get(selectedDate) ?? []}
          questionMap={questionMap}
          onClose={handleCloseDetail}
        />
      )}
    </div>
  );
};

export default ReviewCalendarView;
