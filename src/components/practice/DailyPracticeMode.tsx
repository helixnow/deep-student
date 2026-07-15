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
import { NotionButton } from '@/components/ui/NotionButton';
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
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarBlank size={18} className="text-primary" />
            {t('daily.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 连续打卡 */}
          {activeCheckInCalendar && activeCheckInCalendar.streak_days > 0 && (
            <div className="flex items-center justify-center gap-3 rounded-md bg-warning/10 p-3">
              <Flame size={20} className="text-warning" />
              <div>
                <div className="text-xl font-semibold text-warning">{activeCheckInCalendar.streak_days}</div>
                <div className="text-sm text-muted-foreground">{t('daily.streakDays')}</div>
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
            <div className="flex items-center gap-4">
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
                  <NotionButton
                    key={n}
                    variant={dailyTarget === n ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setDailyTarget(n)}
                  >
                    {n}
                  </NotionButton>
                ))}
              </div>
            </div>
          </div>

          {calendarError && (
            <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <WarningCircle size={16} />
                <span>{calendarError}</span>
              </div>
              <NotionButton
                size="sm"
                variant="outline"
                onClick={() => {
                  void loadCalendar();
                }}
              >
                {t('common:retry')}
              </NotionButton>
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
                <div className="flex items-center gap-2 text-success">
                  <Trophy size={16} />
                  <span className="text-sm font-medium">{t('daily.completed')}</span>
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
          
          <NotionButton
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
          </NotionButton>
        </CardContent>
      </Card>
      
      {/* 打卡日历 */}
      <Card className="bg-transparent border-transparent shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('daily.calendar')}</CardTitle>
            <div className="flex items-center gap-2">
              <NotionButton variant="ghost" iconOnly size="sm" onClick={handlePrevMonth}>
                <CaretLeft size={16} />
              </NotionButton>
              <span className="text-sm font-medium w-24 text-center">
                {t('daily.yearMonth', { year: calendarYear, month: calendarMonth })}
              </span>
              <NotionButton variant="ghost" iconOnly size="sm" onClick={handleNextMonth}>
                <CaretRight size={16} />
              </NotionButton>
            </div>
          </div>
        </CardHeader>
        <CardContent>
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
          
          {/* 日期格子 */}
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((item, idx) => (
              <div
                key={idx}
                className={cn(
                  'relative flex aspect-square flex-col items-center justify-center rounded-md text-sm',
                  item.day === null && 'invisible',
                  item.day !== null && isToday(item.day) && 'ring-2 ring-primary',
                  item.checkIn?.target_achieved && 'bg-success/20',
                  item.checkIn && !item.checkIn.target_achieved && 'bg-warning/10',
                )}
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
                      <span className="text-[10px] text-muted-foreground">
                        {t('daily.questionsCount', { count: item.checkIn.question_count })}
                      </span>
                    )}
                    {item.checkIn?.target_achieved && (
                      <CheckCircle size={12} className="absolute top-0.5 right-0.5 text-success" />
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
