/**
 * 复习日历视图
 *
 * 日历热力图展示每日复习量（与题目集管理页同一设计语言）：
 * - 日历热力图展示每日复习量（密度色阶 + 图例）
 * - 点击日期内联展开当日明细（无弹窗）
 * - 月份切换带方向感滑动过渡；数据随所见月份加载
 *
 * 🆕 2026-01 新增；2026-07 复习体验改造；2026-07 美术对齐管理页
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from './custom-scroll-area';
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
import { ReviewStatTile } from '@/components/review/ReviewStatTile';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

// ============================================================================
// 类型定义
// ============================================================================

interface ReviewCalendarViewProps {
  examId?: string;
  className?: string;
  onClose?: () => void;
  /** 宿主标签页是否活跃：保活隐藏（display:none）的实例不注册 Android 返回键 handler */
  isActive?: boolean;
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

// 主题色阶（跟随 --primary，与做题统计视图 LearningHeatmapChart 的色阶策略一致）
const getHeatmapColor = (count: number): string => {
  if (count === 0) return 'bg-muted/30';
  if (count <= 3) return 'bg-primary/20';
  if (count <= 7) return 'bg-primary/40';
  if (count <= 12) return 'bg-primary/60';
  if (count <= 20) return 'bg-primary/80';
  return 'bg-primary';
};

// 高密度格子（深色底）上的文字需要反色才可读
const isDenseHeatmapCell = (count: number): boolean => count > 12;

const getAccuracyColor = (passed: number, total: number): string => {
  if (total === 0) return 'text-muted-foreground';
  const rate = passed / total;
  if (rate >= 0.9) return 'text-success';
  if (rate >= 0.7) return 'text-info';
  if (rate >= 0.5) return 'text-warning';
  return 'text-destructive';
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
    <div className="ui-rise-in rounded-lg border border-primary/20 bg-card p-3 sm:p-4">
      {/* 头部 */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{formattedDate}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{weekday}</p>
        </div>
        <DsButton
          variant="ghost"
          iconOnly
          size="sm"
          onClick={onClose}
          aria-label={t('review:calendar.closeDetail')}
          className="h-10 w-10 shrink-0 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground sm:h-8 sm:w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <X size={16} />
        </DsButton>
      </div>

      {/* 统计概览 */}
      {data && data.count > 0 ? (
        <>
          <div className="mb-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ReviewStatTile
              icon={<Target size={15} />}
              label={t('review:calendar.totalReviews')}
              value={data.count}
              color="text-info"
              className="!p-2.5"
            />
            <ReviewStatTile
              icon={<CheckCircle size={15} />}
              label={t('review:calendar.passed')}
              value={data.passed}
              color="text-success"
              className="!p-2.5"
            />
            <ReviewStatTile
              icon={<XCircle size={15} />}
              label={t('review:calendar.failed')}
              value={failed}
              color="text-destructive"
              className="!p-2.5"
            />
            <ReviewStatTile
              icon={<TrendUp size={15} />}
              label={t('review:calendar.accuracy')}
              value={`${accuracy}%`}
              color={getAccuracyColor(data.passed, data.count)}
              className="!p-2.5"
            />
          </div>

          {/* 说明：store 仅提供按计划（planId）查询复习历史的接口，没有按日期查询的方法；
              此前这里固定渲染空的「复习记录」区块（histories 恒为 []），已移除，仅展示当日统计。 */}
        </>
      ) : duePlans.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-center">
          <div
            aria-hidden="true"
            className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-border/50 bg-muted/20"
          >
            <Calendar size={20} className="text-muted-foreground/60" />
          </div>
          <p className="text-sm text-muted-foreground">{t('review:calendar.noData')}</p>
        </div>
      ) : null}

      {/* 当日到期队列明细（内联展开，无弹窗） */}
      {duePlans.length > 0 && (
        <div className={cn('space-y-1.5', data && data.count > 0 && 'mt-4 border-t border-border/50 pt-3')}>
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <Target size={13} />
            {t('review:calendar.dueQueue', { count: duePlans.length })}
          </p>
          <CustomScrollArea className="max-h-52" viewportClassName="pr-1" fullHeight={false}>
            <ul className="space-y-1">
              {duePlans.slice(0, 30).map((plan) => {
                const question = questionMap.get(plan.question_id);
                const typeMeta = getReviewQuestionTypeMeta(question?.question_type);
                const TypeIcon = typeMeta.Icon;
                return (
                  <li
                    key={plan.id}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2.5 py-1.5 transition-colors duration-150 ease-standard hover:bg-muted/30 motion-reduce:transition-none"
                  >
                    <TypeIcon size={13} className="shrink-0 text-muted-foreground/70" />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">
                      {question?.content || t('review:unknownQuestion')}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {t(`review:status.${plan.status}`, plan.status)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CustomScrollArea>
          {duePlans.length > 30 && (
            <p className="text-center text-[10px] text-muted-foreground/70">
              {t('review:calendar.dueMore', { count: duePlans.length - 30 })}
            </p>
          )}
        </div>
      )}
    </div>
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
  const dense = isDenseHeatmapCell(count);

  return (
    <DsButton
      variant="ghost" size="sm"
      onClick={onClick}
      aria-pressed={isSelected}
      className={cn(
        // 单元格随七列网格收缩，min-h-9 兜底触控高度（aspect-square 下实际接近方形命中区）
        '!p-0.5 sm:!p-1 !h-auto !rounded-md aspect-square relative min-h-9 min-w-0 sm:min-h-10',
        // 粗指针：::after 向四周扩 4px 命中区（36px 视觉 → ~44px 命中），不改变视觉尺寸与七列网格
        "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-['']",
        'ui-state-colors border transition-[background-color,border-color,box-shadow] duration-150 ease-standard motion-reduce:transition-none',
        getHeatmapColor(count),
        // 边框层级：选中 > 今日 > 常态细边框
        isSelected
          ? 'border-primary bg-primary/10 shadow-[0_0_0_1px_var(--primary)]'
          : isToday
            ? 'border-primary/60'
            : count > 0
              ? 'border-transparent hover:border-primary/40'
              : 'border-border/30 hover:border-border/70',
        isCurrentMonth ? 'opacity-100' : 'opacity-30 hover:opacity-60'
      )}
    >
      <span
        className={cn(
          'absolute left-1 top-1 text-[10px] font-medium leading-none tabular-nums',
          isToday
            ? 'flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-0.5 font-semibold text-primary-foreground'
            : dense
              ? 'text-primary-foreground/85'
              : 'text-foreground/70'
        )}
      >
        {date.getDate()}
      </span>
      {count > 0 && (
        <span
          className={cn(
            'absolute bottom-1 right-1 text-[10px] font-semibold tabular-nums',
            dense ? 'text-primary-foreground' : 'text-primary'
          )}
        >
          {count}
        </span>
      )}
      {/* 到期密度指示（警示色，与已完成的主题色区分） */}
      {dueCount > 0 && (
        <span
          className={cn(
            'absolute bottom-1 left-1 inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums',
            dense ? 'text-primary-foreground/85' : 'text-warning'
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              dueCount > 10 ? 'bg-warning' : dueCount > 5 ? 'bg-warning/80' : 'bg-warning/60'
            )}
          />
          {dueCount}
        </span>
      )}
    </DsButton>
  );
};

// ============================================================================
// 热力图图例
// ============================================================================

const HeatmapLegend: React.FC<{ showDueLegend?: boolean }> = ({ showDueLegend }) => {
  const { t } = useTranslation(['review']);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground/80">
      {/* 到期密度图例（警示色，与已完成的主题色区分） */}
      {showDueLegend ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          {t('review:calendar.dueLegend')}
        </span>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-1">
        <span className="mr-0.5">{t('review:calendar.less')}</span>
        {[0, 2, 5, 10, 15, 25].map((n) => (
          <span
            key={n}
            className={cn(
              'h-2.5 w-2.5 rounded-[3px] border border-border/30',
              getHeatmapColor(n)
            )}
          />
        ))}
        <span className="ml-0.5">{t('review:calendar.more')}</span>
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
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <ReviewStatTile
        icon={<Flame size={15} />}
        label={t('review:calendar.currentStreak')}
        value={stats.currentStreak}
        color="text-warning"
        className="!p-2.5"
      />
      <ReviewStatTile
        icon={<TrendUp size={15} />}
        label={t('review:calendar.longestStreak')}
        value={stats.longestStreak}
        color="text-primary"
        className="!p-2.5"
      />
      <ReviewStatTile
        icon={<Calendar size={15} />}
        label={t('review:calendar.totalDays')}
        value={stats.totalDays}
        color="text-info"
        className="!p-2.5"
      />
      <ReviewStatTile
        icon={<Target size={15} />}
        label={t('review:calendar.totalReviews')}
        value={stats.totalReviews}
        color="text-success"
        className="!p-2.5"
      />
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
  isActive,
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

  // isActive === false：保活隐藏（display:none 标签页）的实例不注册返回键 handler，
  // 避免吞掉当前活跃视图的返回键（未传 isActive 的宿主行为不变）
  useEffect(() => {
    if (!selectedDate || isActive === false) return;
    return registerBackHandler(() => {
      setSelectedDate(null);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [selectedDate, isActive]);
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
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">
            {t('review:calendar.title')}
          </h2>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {t('review:calendar.subtitle')}
          </p>
        </div>
        {onClose && (
          <DsButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={onClose}
            aria-label={t('common:close')}
            className="shrink-0 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
          >
            <X size={18} />
          </DsButton>
        )}
      </div>

      {/* 从未复习过：空态引导提示条 */}
      {!hasAnyReview && (
        <div className="ui-rise-in flex items-start gap-2 rounded-lg border border-info/15 bg-info/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <Info size={14} className="mt-0.5 shrink-0 text-info" />
          <span>{t('review:calendar.emptyHint')}</span>
        </div>
      )}

      {/* 统计概览 */}
      <StreakStats calendarData={calendarData} />

      {/* 日历区域 */}
      <div className="overflow-hidden rounded-lg border border-border/50 bg-card p-2 sm:p-4">
        {/* 月份导航 */}
        <div className="mb-3 flex items-center justify-between gap-1">
          <DsButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={goToPrevMonth}
            aria-label={t('review:calendar.prevMonth')}
            className="h-8 w-8 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!min-w-[44px] text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
          >
            <CaretLeft size={16} />
          </DsButton>
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold tabular-nums text-foreground">
              {monthName}
            </h3>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={goToToday}
              className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!px-3 rounded-md border border-border/50 text-[11px] text-muted-foreground hover:border-border hover:bg-[var(--interactive-hover)] hover:text-foreground"
            >
              {t('review:calendar.today')}
            </DsButton>
          </div>
          <DsButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={goToNextMonth}
            aria-label={t('review:calendar.nextMonth')}
            className="h-8 w-8 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!min-w-[44px] text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
          >
            <CaretRight size={16} />
          </DsButton>
        </div>

        {/* 星期标题 */}
        <div className="mb-1.5 grid grid-cols-7 gap-1">
          {weekdays.map((day, index) => (
            <div
              key={index}
              className={cn(
                'py-1 text-center text-[11px] font-medium',
                index === 0 || index === 6
                  ? 'text-muted-foreground/60'
                  : 'text-muted-foreground'
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
        <div className="mt-3 border-t border-border/50 pt-3">
          <HeatmapLegend showDueLegend={!!examId && dueMap.size > 0} />
        </div>
      </div>

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
