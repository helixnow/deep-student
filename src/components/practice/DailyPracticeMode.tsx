/**
 * 每日一练模式组件
 * 
 * 功能：
 * - 每日一练卡片（显示今日目标、已完成）
 * - 智能推荐说明
 * - 打卡日历
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import {
  CalendarDays,
  Target,
  Flame,
  CheckCircle,
  AlertCircle,
  BookOpen,
  RotateCcw,
  Play,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Trophy,
} from 'lucide-react';
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
  
  // 配置状态
  const [dailyTarget, setDailyTarget] = useState(10);
  
  // 日历状态
  const today = new Date();
  const [calendarYear, setCalendarYear] = useState(today.getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(today.getMonth() + 1);
  
  // 加载日历数据
  useEffect(() => {
    getCheckInCalendar(examId, calendarYear, calendarMonth).catch(console.error);
  }, [examId, calendarYear, calendarMonth, getCheckInCalendar]);
  
  // 开始每日一练
  const handleStart = useCallback(async () => {
    try {
      const result = await getDailyPractice(examId, dailyTarget);
      onStart?.(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('daily.startError', '获取每日练习失败'));
    }
  }, [examId, dailyTarget, getDailyPractice, onStart]);
  
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
      const checkIn = checkInCalendar?.days.find((d) => d.date === dateStr);
      days.push({
        day: i,
        checkIn: checkIn ? {
          question_count: checkIn.question_count,
          target_achieved: checkIn.target_achieved,
        } : undefined,
      });
    }
    
    return days;
  }, [calendarYear, calendarMonth, checkInCalendar]);
  
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
          <CardTitle className="flex items-center gap-2 text-lg">
            <CalendarDays className="w-5 h-5 text-sky-500" />
            {t('daily.title', '每日一练')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 连续打卡 */}
          {checkInCalendar && checkInCalendar.streak_days > 0 && (
            <div className="flex items-center justify-center gap-3 p-4 rounded-xl bg-gradient-to-r from-orange-500/10 to-amber-500/10">
              <Flame className="w-8 h-8 text-orange-500" />
              <div>
                <div className="text-3xl font-bold text-orange-600">{checkInCalendar.streak_days}</div>
                <div className="text-sm text-muted-foreground">{t('daily.streakDays', '连续打卡天数')}</div>
              </div>
            </div>
          )}
          
          {/* 智能推荐说明 */}
          <div className="p-4 rounded-lg bg-sky-500/5 border border-sky-500/20">
            <div className="flex items-start gap-3">
              <div className="space-y-2">
                <div className="font-medium text-sky-700 dark:text-sky-400">
                  {t('daily.smartRecommend', '智能推荐')}
                </div>
                <div className="text-sm text-muted-foreground space-y-1">
                  <div className="flex items-center gap-2">
                    <RotateCcw className="w-4 h-4 text-amber-500" />
                    <span>{t('daily.recommendMistakes', '优先选择错题，巩固薄弱知识点')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-emerald-500" />
                    <span>{t('daily.recommendNew', '其次选择新题，拓展知识范围')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-sky-500" />
                    <span>{t('daily.recommendReview', '最后补充复习题，防止遗忘')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          {/* 目标设置 */}
          <div className="space-y-2">
            <Label>{t('daily.targetLabel', '今日目标（题数）')}</Label>
            <div className="flex items-center gap-4">
              <Input
                type="number"
                min={5}
                max={50}
                value={dailyTarget}
                onChange={(e) => setDailyTarget(Number(e.target.value))}
                className="w-24 text-center text-lg font-medium"
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
          
          {/* 今日进度 */}
          {dailyPractice && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('daily.todayProgress', '今日进度')}</span>
                <span className="font-medium">
                  {dailyPractice.completed_count} / {dailyPractice.daily_target}
                </span>
              </div>
              <Progress 
                value={(dailyPractice.completed_count / dailyPractice.daily_target) * 100} 
                className="h-2" 
              />
              {dailyPractice.is_completed && (
                <div className="flex items-center gap-2 text-emerald-600">
                  <Trophy className="w-4 h-4" />
                  <span className="text-sm font-medium">{t('daily.completed', '今日目标已完成！')}</span>
                </div>
              )}
            </div>
          )}
          
          {/* 来源分布 */}
          {dailyPractice && (
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 rounded-lg bg-amber-500/10">
                <div className="text-xl font-bold text-amber-600">
                  {dailyPractice.source_distribution.mistake_count}
                </div>
                <div className="text-xs text-amber-600">{t('daily.mistakes', '错题')}</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-emerald-500/10">
                <div className="text-xl font-bold text-emerald-600">
                  {dailyPractice.source_distribution.new_count}
                </div>
                <div className="text-xs text-emerald-600">{t('daily.new', '新题')}</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-sky-500/10">
                <div className="text-xl font-bold text-sky-600">
                  {dailyPractice.source_distribution.review_count}
                </div>
                <div className="text-xs text-sky-600">{t('daily.review', '复习')}</div>
              </div>
            </div>
          )}
          
          <NotionButton
            onClick={handleStart}
            disabled={isLoadingPractice}
            className="w-full h-12 text-lg"
          >
            {isLoadingPractice ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                {t('daily.loading', '准备中...')}
              </>
            ) : (
              <>
                <Play className="w-5 h-5 mr-2" />
                {dailyPractice ? t('daily.continue', '继续练习') : t('daily.start', '开始今日练习')}
              </>
            )}
          </NotionButton>
        </CardContent>
      </Card>
      
      {/* 打卡日历 */}
      <Card className="bg-transparent border-transparent shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('daily.calendar', '打卡日历')}</CardTitle>
            <div className="flex items-center gap-2">
              <NotionButton variant="ghost" iconOnly size="sm" onClick={handlePrevMonth}>
                <ChevronLeft className="w-4 h-4" />
              </NotionButton>
              <span className="text-sm font-medium w-24 text-center">
                {t('daily.yearMonth', '{{year}}年{{month}}月', { year: calendarYear, month: calendarMonth })}
              </span>
              <NotionButton variant="ghost" iconOnly size="sm" onClick={handleNextMonth}>
                <ChevronRight className="w-4 h-4" />
              </NotionButton>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* 星期标题 */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {[
              t('daily.weekdays.sun', '日'),
              t('daily.weekdays.mon', '一'),
              t('daily.weekdays.tue', '二'),
              t('daily.weekdays.wed', '三'),
              t('daily.weekdays.thu', '四'),
              t('daily.weekdays.fri', '五'),
              t('daily.weekdays.sat', '六'),
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
                  'aspect-square rounded-lg flex flex-col items-center justify-center text-sm relative',
                  item.day === null && 'invisible',
                  item.day !== null && isToday(item.day) && 'ring-2 ring-sky-500',
                  item.checkIn?.target_achieved && 'bg-emerald-500/20',
                  item.checkIn && !item.checkIn.target_achieved && 'bg-amber-500/10',
                )}
              >
                {item.day !== null && (
                  <>
                    <span className={cn(
                      'font-medium',
                      isToday(item.day) && 'text-sky-600',
                    )}>
                      {item.day}
                    </span>
                    {item.checkIn && (
                      <span className="text-[10px] text-muted-foreground">
                        {t('daily.questionsCount', '{{count}}题', { count: item.checkIn.question_count })}
                      </span>
                    )}
                    {item.checkIn?.target_achieved && (
                      <CheckCircle className="absolute top-0.5 right-0.5 w-3 h-3 text-emerald-500" />
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          
          {/* 月度统计 */}
          {checkInCalendar && (
            <div className="mt-4 pt-4 border-t flex items-center justify-around text-sm">
              <div className="text-center">
                <div className="font-bold text-lg">{checkInCalendar.month_check_in_days}</div>
                <div className="text-muted-foreground text-xs">{t('daily.monthDays', '本月打卡')}</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-lg">{checkInCalendar.month_total_questions}</div>
                <div className="text-muted-foreground text-xs">{t('daily.monthQuestions', '做题总数')}</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-lg text-orange-600">{checkInCalendar.streak_days}</div>
                <div className="text-muted-foreground text-xs">{t('daily.streak', '连续打卡')}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default DailyPracticeMode;
