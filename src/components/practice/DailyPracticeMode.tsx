/**
 * 每日一练模式组件
 * 
 * 功能：
 * - 每日一练卡片（显示今日目标、已完成）
 * - 智能推荐说明
 * - 打卡日历
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import {
  CalendarBlank,
  Flame,
  CheckCircle,
  WarningCircle,
  BookOpen,
  ArrowCounterClockwise,
  Play,
  CircleNotch,
  CaretLeft,
  CaretRight,
  Trophy,
} from '@phosphor-icons/react';
import { useQuestionBankStore, DailyPracticeResult, CheckInCalendar } from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import './practice-celebration.css';

// 庆祝彩点的散射位移（纯 CSS 动画，见 practice-celebration.css）
const CELEBRATION_BURSTS = [
  { x: '-42px', y: '-30px', delay: '0ms', className: 'text-warning' },
  { x: '40px', y: '-34px', delay: '60ms', className: 'text-success' },
  { x: '-26px', y: '-48px', delay: '120ms', className: 'text-primary' },
  { x: '26px', y: '-50px', delay: '40ms', className: 'text-destructive' },
  { x: '-50px', y: '-6px', delay: '160ms', className: 'text-success' },
  { x: '52px', y: '-8px', delay: '100ms', className: 'text-warning' },
  { x: '0px', y: '-56px', delay: '80ms', className: 'text-primary' },
  { x: '-14px', y: '-20px', delay: '200ms', className: 'text-warning' },
];

interface DailyPracticeModeProps {
  examId: string;
  onStart?: (result: DailyPracticeResult) => void;
  className?: string;
}

// 获取月份天数
const getDaysInMonth = (year: number, month: number): number => {
  return new Date(year, month, 0).getDate();
};

// 获取月份第一天是星期几
const getFirstDayOfMonth = (year: number, month: number): number => {
  return new Date(year, month - 1, 1).getDay();
};

export const DailyPracticeMode: React.FC<DailyPracticeModeProps> = ({
  examId,
  onStart,
  className,
}) => {
  const { t } = useTranslation('practice');
  
  // Store
  const {
    dailyPractice,
    checkInCalendar,
    getDailyPractice,
    getCheckInCalendar,
    isLoadingPractice,
  } = useQuestionBankStore();
  // Daily progress is store-global, but this launcher is scoped to one exam.
  // Never render another question bank's progress while its request is in flight.
  const activeDailyPractice = dailyPractice?.exam_id === examId ? dailyPractice : null;
  const activeCheckInCalendar = checkInCalendar?.exam_id === examId
    ? checkInCalendar
    : null;
  
  // 配置状态
  const [dailyTarget, setDailyTarget] = useState(10);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const calendarRequestSeqRef = useRef(0);
  
  // 日历状态
  const today = new Date();
  const [calendarYear, setCalendarYear] = useState(today.getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(today.getMonth() + 1);
  
  // 组件层按请求代际抑制过期错误，避免旧重试覆盖新题目集/月度状态。
  const loadCalendar = useCallback(async () => {
    const requestId = ++calendarRequestSeqRef.current;
    setCalendarError(null);
    try {
      await getCheckInCalendar(examId, calendarYear, calendarMonth);
    } catch (error: unknown) {
      if (requestId !== calendarRequestSeqRef.current) return;
      console.error('[DailyPracticeMode] Failed to load check-in calendar:', error);
      setCalendarError(t('daily.calendarLoadFailed'));
    }
  }, [calendarMonth, calendarYear, examId, getCheckInCalendar, t]);

  // 加载日历数据
  useEffect(() => {
    void loadCalendar();
    return () => {
      calendarRequestSeqRef.current += 1;
    };
  }, [loadCalendar]);
  
  // 开始每日一练
  const handleStart = useCallback(async () => {
    try {
      const result = await getDailyPractice(examId, dailyTarget);
      onStart?.(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('daily.startError'));
    }
  }, [examId, dailyTarget, getDailyPractice, onStart, t]);
  
  // 切换月份
  const handlePrevMonth = useCallback(() => {
    if (calendarMonth === 1) {
      setCalendarYear((y) => y - 1);
      setCalendarMonth(12);
    } else {
      setCalendarMonth((m) => m - 1);
    }
  }, [calendarMonth]);
  
  const handleNextMonth = useCallback(() => {
    if (calendarMonth === 12) {
      setCalendarYear((y) => y + 1);
      setCalendarMonth(1);
    } else {
      setCalendarMonth((m) => m + 1);
    }
  }, [calendarMonth]);

  const normalizeDailyTarget = useCallback((value: number): number => {
    if (!Number.isFinite(value)) return 10;
    return Math.max(5, Math.min(50, Math.round(value)));
  }, []);
  
  // 生成日历格子
  const calendarDays = useMemo(() => {
    const daysInMonth = getDaysInMonth(calendarYear, calendarMonth);
    const firstDay = getFirstDayOfMonth(calendarYear, calendarMonth);
    const days: Array<{ day: number | null; checkIn?: { question_count: number; target_achieved: boolean } }> = [];
    
    // 填充前面的空白
    for (let i = 0; i < firstDay; i++) {
      days.push({ day: null });
    }
    
    // 填充日期
    for (let i = 1; i <= daysInMonth; i++) {
      const dateStr = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      const checkIn = activeCheckInCalendar?.days.find((d) => d.date === dateStr);
      days.push({
        day: i,
        checkIn: checkIn ? {
          question_count: checkIn.question_count,
          target_achieved: checkIn.target_achieved,
        } : undefined,
      });
    }
    
    return days;
  }, [calendarYear, calendarMonth, activeCheckInCalendar]);
  
  // 判断是否是今天
  const isToday = (day: number) => {
    return day === today.getDate() 
      && calendarMonth === today.getMonth() + 1 
      && calendarYear === today.getFullYear();
  };
  
  return (
    <div className={cn('space-y-4', className)}>
      {/* 每日一练卡片 */}
      <Card className="bg-transparent border-transparent shadow-none">
        <CardHeader className="px-0 pb-4 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarBlank size={18} className="text-primary" />
            {t('daily.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 px-0 sm:px-6">
          {/* 连续打卡 */}
          {activeCheckInCalendar && activeCheckInCalendar.streak_days > 0 && (
            <div className="flex items-center justify-center gap-3 rounded-md border border-warning/20 bg-gradient-to-r from-warning/15 via-warning/5 to-transparent p-3">
              <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-warning/15">
                <Flame size={24} weight="fill" className="text-warning" />
              </div>
              <div>
                <div className="text-xl font-semibold leading-tight text-warning tabular-nums">
                  {activeCheckInCalendar.streak_days}
                </div>
                <div className="text-sm text-muted-foreground">{t('daily.streakDays')}</div>
              </div>
              {/* 近 7 天连续火苗点缀：点亮天数 = min(streak, 7) */}
              <div className="ml-2 hidden items-end gap-1 sm:flex" aria-hidden="true">
                {Array.from({ length: 7 }, (_, i) => {
                  const lit = i < Math.min(activeCheckInCalendar.streak_days, 7);
                  return (
                    <span
                      key={i}
                      className={cn(
                        'w-1.5 rounded-full transition-colors',
                        lit ? 'bg-warning' : 'bg-muted',
                      )}
                      style={{ height: `${8 + i * 2}px` }}
/>
                  );
                })}
              </div>
            </div>
          )}
          
          {/* 智能推荐说明 */}
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <div className="flex items-start gap-3">
              <div className="space-y-2">
                <div className="font-medium text-primary">
                  {t('daily.smartRecommend')}
                </div>
                <div className="text-sm text-muted-foreground space-y-1">
                  <div className="flex items-center gap-2">
                    <ArrowCounterClockwise size={16} className="text-warning" />
                    <span>{t('daily.recommendMistakes')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <BookOpen size={16} className="text-success" />
                    <span>{t('daily.recommendNew')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle size={16} className="text-primary" />
                    <span>{t('daily.recommendReview')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          {/* 目标设置 */}
          <div className="space-y-2">
            <Label>{t('daily.targetLabel')}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="number"
                min={5}
                max={50}
                value={dailyTarget}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  setDailyTarget(normalizeDailyTarget(Number(raw)));
                }}
                onBlur={(e) => {
                  setDailyTarget(normalizeDailyTarget(Number(e.target.value)));
                }}
                className="w-24 text-center text-sm font-medium"
/>
              <div className="flex gap-2">
                {[5, 10, 15, 20].map((n) => (
                  <DsButton
                    key={n}
                    variant={dailyTarget === n ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setDailyTarget(n)}
                  >
                    {n}
                  </DsButton>
                ))}
              </div>
            </div>
          </div>

          {calendarError && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
              <div className="flex min-w-0 items-center gap-2 text-destructive">
                <WarningCircle size={16} className="shrink-0" />
                <span className="min-w-0 break-words">{calendarError}</span>
              </div>
              <DsButton
                size="sm"
                variant="outline"
                onClick={() => {
                  void loadCalendar();
                }}
              >
                {t('common:retry')}
              </DsButton>
            </div>
          )}
          
          {/* 今日进度 */}
          {activeDailyPractice && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('daily.todayProgress')}</span>
                <span className="font-medium">
                  {activeDailyPractice.completed_count} / {activeDailyPractice.daily_target}
                </span>
              </div>
              <Progress 
                value={(activeDailyPractice.completed_count / activeDailyPractice.daily_target) * 100}
                className="h-2" 
/>
              {activeDailyPractice.is_completed && (
                <div className="relative overflow-hidden rounded-md border border-success/25 bg-success/10 px-3 py-4 text-center">
                  {/* 完成庆祝动效（纯 CSS，prefers-reduced-motion 时自动禁用） */}
                  <div className="relative mx-auto mb-1.5 h-10 w-10">
                    <div className="practice-celebrate-burst">
                      {CELEBRATION_BURSTS.map((burst, i) => (
                        <i
                          key={i}
                          className={burst.className}
                          style={{
                            '--burst-x': burst.x,
                            '--burst-y': burst.y,
                            '--burst-delay': burst.delay,
                          } as React.CSSProperties}
/>
                      ))}
                    </div>
                    <div className="practice-celebrate-pop flex h-10 w-10 items-center justify-center rounded-full bg-success/15">
                      <Trophy size={22} weight="fill" className="text-success" />
                    </div>
                  </div>
                  <div className="text-sm font-medium text-success">{t('daily.completed')}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t('daily.completedDetail', {
                      correct: activeDailyPractice.correct_count,
                      total: activeDailyPractice.completed_count,
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* 来源分布 */}
          {activeDailyPractice && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md bg-warning/10 p-2 text-center">
                <div className="text-base font-semibold text-warning">
                  {activeDailyPractice.source_distribution.mistake_count}
                </div>
                <div className="text-xs text-warning">{t('daily.mistakes')}</div>
              </div>
              <div className="rounded-md bg-success/10 p-2 text-center">
                <div className="text-base font-semibold text-success">
                  {activeDailyPractice.source_distribution.new_count}
                </div>
                <div className="text-xs text-success">{t('daily.new')}</div>
              </div>
              <div className="rounded-md bg-primary/10 p-2 text-center">
                <div className="text-base font-semibold text-primary">
                  {activeDailyPractice.source_distribution.review_count}
                </div>
                <div className="text-xs text-primary">{t('daily.review')}</div>
              </div>
            </div>
          )}
          
          <DsButton
            onClick={handleStart}
            disabled={isLoadingPractice}
            className="w-full h-9 text-sm"
          >
            {isLoadingPractice ? (
              <>
                <CircleNotch size={20} className="mr-2 animate-spin" />
                {t('daily.loading')}
              </>
            ) : (
              <>
                <Play size={20} className="mr-2" />
                {activeDailyPractice ? t('daily.continue') : t('daily.start')}
              </>
            )}
          </DsButton>
        </CardContent>
      </Card>
      
      {/* 打卡日历 */}
      <Card className="bg-transparent border-transparent shadow-none">
        <CardHeader className="px-0 pb-2 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t('daily.calendar')}</CardTitle>
            <div className="flex items-center gap-2">
              <DsButton variant="ghost" iconOnly size="sm" onClick={handlePrevMonth}>
                <CaretLeft size={16} />
              </DsButton>
              <span className="text-sm font-medium w-24 text-center">
                {t('daily.yearMonth', { year: calendarYear, month: calendarMonth })}
              </span>
              <DsButton variant="ghost" iconOnly size="sm" onClick={handleNextMonth}>
                <CaretRight size={16} />
              </DsButton>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {/* 星期标题 */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {[
              t('daily.weekdays.sun'),
              t('daily.weekdays.mon'),
              t('daily.weekdays.tue'),
              t('daily.weekdays.wed'),
              t('daily.weekdays.thu'),
              t('daily.weekdays.fri'),
              t('daily.weekdays.sat'),
            ].map((d) => (
              <div key={d} className="text-center text-xs text-muted-foreground py-1">
                {d}
              </div>
            ))}
          </div>
          
          {/* 日期格子：按月份重挂载，逐格错峰淡入的微动效 */}
          <div key={`${calendarYear}-${calendarMonth}`} className="grid grid-cols-7 gap-1">
            {calendarDays.map((item, idx) => (
              <div
                key={idx}
                className={cn(
                  'relative flex min-w-0 aspect-square flex-col items-center justify-center overflow-hidden rounded-md text-sm',
                  'ui-rise-in transition-colors hover:bg-[var(--interactive-hover)]',
                  item.day === null && 'invisible',
                  item.day !== null && isToday(item.day) && 'ring-2 ring-primary',
                  item.checkIn?.target_achieved && 'bg-success/20',
                  item.checkIn && !item.checkIn.target_achieved && 'bg-warning/10',
                )}
                style={{ animationDelay: `${Math.min(idx * 8, 320)}ms` }}
              >
                {item.day !== null && (
                  <>
                    <span className={cn(
                      'font-medium',
                      isToday(item.day) && 'text-primary',
                    )}>
                      {item.day}
                    </span>
                    {item.checkIn && (
                      <span
                        className="max-w-full truncate px-0.5 text-[9px] leading-none text-muted-foreground sm:text-[10px]"
                        title={t('daily.questionsCount', { count: item.checkIn.question_count })}
                      >
                        {t('daily.questionsCount', { count: item.checkIn.question_count })}
                      </span>
                    )}
                    {item.checkIn?.target_achieved && (
                      <CheckCircle size={12} weight="fill" className="absolute top-0.5 right-0.5 text-success" />
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          
          {/* 月度统计 */}
          {activeCheckInCalendar && (
            <div className="mt-4 pt-4 border-t flex items-center justify-around text-sm">
              <div className="text-center">
                <div className="font-bold text-lg">{activeCheckInCalendar.month_check_in_days}</div>
                <div className="text-muted-foreground text-xs">{t('daily.monthDays')}</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-lg">{activeCheckInCalendar.month_total_questions}</div>
                <div className="text-muted-foreground text-xs">{t('daily.monthQuestions')}</div>
              </div>
              <div className="text-center">
                <div className="text-base font-semibold text-warning">{activeCheckInCalendar.streak_days}</div>
                <div className="text-muted-foreground text-xs">{t('daily.streak')}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default DailyPracticeMode;
