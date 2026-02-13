/**
 * 练习启动页
 * 
 * 展示所有练习模式，作为做题前的模式选择入口：
 * - 基础模式（顺序/随机/错题优先/按标签）→ 直接进入做题
 * - 高级模式（限时/模拟考/每日/组卷）→ 展开配置面板
 * - 顶部快速统计摘要
 * 
 * @see PracticeModeSelector 模式卡片网格
 */

import React, { lazy, Suspense, useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import {
  ListOrdered,
  Shuffle,
  RotateCcw,
  Tag,
  Clock,
  FileText,
  Target,
  FileDown,
  Loader2,
  BookOpen,
  ChevronLeft,
  Play,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QuestionBankStats } from '@/api/questionBankApi';
import type { PracticeMode } from '@/api/questionBankApi';

// 懒加载高级模式组件
const TimedPracticeMode = lazy(() => import('./TimedPracticeMode'));
const MockExamMode = lazy(() => import('./MockExamMode'));
const DailyPracticeMode = lazy(() => import('./DailyPracticeMode'));
const PaperGenerator = lazy(() => import('./PaperGenerator'));

export interface PracticeLauncherProps {
  examId: string;
  stats?: QuestionBankStats | null;
  questions: Array<{ tags?: string[] }>;
  onStartPractice: (mode: PracticeMode, tag?: string) => void;
  className?: string;
}

type AdvancedMode = 'timed' | 'mock_exam' | 'daily' | 'paper' | null;

interface ModeCardConfig {
  key: PracticeMode;
  icon: React.ElementType;
  label: string;
  desc: string;
  colorText: string;
  colorBg: string;
  isAdvanced: boolean;
}

export const PracticeLauncher: React.FC<PracticeLauncherProps> = ({
  examId,
  stats,
  questions,
  onStartPractice,
  className,
}) => {
  const { t } = useTranslation(['exam_sheet', 'practice']);
  const [activeAdvanced, setActiveAdvanced] = useState<AdvancedMode>(null);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    questions.forEach(q => q.tags?.forEach(tag => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, [questions]);

  const modes: ModeCardConfig[] = useMemo(() => [
    {
      key: 'sequential',
      icon: ListOrdered,
      label: t('practice:modes.sequential.label'),
      desc: t('practice:modes.sequential.desc'),
      colorText: 'text-slate-600 dark:text-slate-400',
      colorBg: 'bg-slate-500/10',
      isAdvanced: false,
    },
    {
      key: 'random',
      icon: Shuffle,
      label: t('practice:modes.random.label'),
      desc: t('practice:modes.random.desc'),
      colorText: 'text-purple-600 dark:text-purple-400',
      colorBg: 'bg-purple-500/10',
      isAdvanced: false,
    },
    {
      key: 'review_first',
      icon: RotateCcw,
      label: t('practice:modes.reviewFirst.label'),
      desc: t('practice:modes.reviewFirst.desc'),
      colorText: 'text-amber-600 dark:text-amber-400',
      colorBg: 'bg-amber-500/10',
      isAdvanced: false,
    },
    {
      key: 'by_tag',
      icon: Tag,
      label: t('practice:modes.byTag.label'),
      desc: t('practice:modes.byTag.desc'),
      colorText: 'text-sky-600 dark:text-sky-400',
      colorBg: 'bg-sky-500/10',
      isAdvanced: false,
    },
    {
      key: 'timed',
      icon: Clock,
      label: t('practice:modes.timed.label'),
      desc: t('practice:modes.timed.desc'),
      colorText: 'text-rose-600 dark:text-rose-400',
      colorBg: 'bg-rose-500/10',
      isAdvanced: true,
    },
    {
      key: 'mock_exam',
      icon: FileText,
      label: t('practice:modes.mockExam.label'),
      desc: t('practice:modes.mockExam.desc'),
      colorText: 'text-indigo-600 dark:text-indigo-400',
      colorBg: 'bg-indigo-500/10',
      isAdvanced: true,
    },
    {
      key: 'daily',
      icon: Target,
      label: t('practice:modes.daily.label'),
      desc: t('practice:modes.daily.desc'),
      colorText: 'text-emerald-600 dark:text-emerald-400',
      colorBg: 'bg-emerald-500/10',
      isAdvanced: true,
    },
    {
      key: 'paper',
      icon: FileDown,
      label: t('practice:modes.paper.label'),
      desc: t('practice:modes.paper.desc'),
      colorText: 'text-orange-600 dark:text-orange-400',
      colorBg: 'bg-orange-500/10',
      isAdvanced: true,
    },
  ], [t]);

  const handleModeClick = useCallback((mode: PracticeMode, isAdvanced: boolean) => {
    if (isAdvanced) {
      setActiveAdvanced(prev => prev === mode ? null : mode as AdvancedMode);
    } else {
      onStartPractice(mode);
    }
  }, [onStartPractice]);

  const hasQuestions = questions.length > 0;

  // 空状态
  if (!hasQuestions) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full gap-4 px-6', className)}>
        <div className="p-4 rounded-2xl bg-muted/50">
          <BookOpen className="w-10 h-10 text-muted-foreground" />
        </div>
        <div className="text-center">
          <h3 className="text-lg font-semibold mb-1">
            {t('exam_sheet:questionBank.practice.noQuestions')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.practice.addFirst')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <CustomScrollArea className={cn('h-full', className)} viewportClassName="p-4 space-y-5">
      {/* 快速统计 */}
      {stats && (
        <div className="flex items-center gap-6 px-1">
          <div className="flex items-center gap-2">
            <div className="relative w-10 h-10">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
                <circle
                  cx="20" cy="20" r="16"
                  fill="none" stroke="currentColor" strokeWidth="3"
                  strokeDasharray={`${stats.total > 0 ? (stats.mastered / stats.total) * 100.5 : 0} 100.5`}
                  className="text-emerald-500"
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[10px] font-semibold tabular-nums">
                  {stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0}%
                </span>
              </div>
            </div>
            <div className="text-sm whitespace-nowrap">
              <span className="text-muted-foreground">{t('exam_sheet:questionBank.stats.mastered')} </span>
              <span className="font-medium">{stats.mastered}</span>
              <span className="text-muted-foreground">/ {stats.total}</span>
            </div>
          </div>
          {stats.review > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              <span>{stats.review} {t('exam_sheet:questionBank.stats.toReview')}</span>
            </div>
          )}
          <div className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.stats.correctRate')}{' '}
            <span className="font-medium text-foreground tabular-nums">
              {Math.round(stats.correctRate * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* 选择练习模式 */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
          <Play className="w-3.5 h-3.5" />
          {t('exam_sheet:questionBank.practice.chooseMode')}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {modes.map(({ key, icon: Icon, label, desc, colorText, colorBg, isAdvanced }) => {
            const isActive = activeAdvanced === key;
            return (
              <button
                key={key}
                onClick={() => handleModeClick(key, isAdvanced)}
                className={cn(
                  'group relative flex flex-col items-start gap-3 p-4 rounded-xl text-left transition-all duration-200',
                  'border border-transparent hover:border-border/60 hover:bg-muted/30',
                  'hover:shadow-[var(--shadow-notion)]',
                  isActive && 'ring-2 ring-primary/50 bg-primary/5 border-primary/30'
                )}
              >
                <div className={cn('p-2.5 rounded-lg transition-colors', isActive ? 'bg-primary/10' : colorBg)}>
                  <Icon className={cn('w-5 h-5 transition-colors', isActive ? 'text-primary' : colorText)} />
                </div>
                <div>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                </div>
                {/* 错题数量 badge */}
                {key === 'review_first' && stats && stats.review > 0 && (
                  <Badge variant="secondary" className="absolute top-2 right-2 text-[10px] h-5 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    {stats.review}
                  </Badge>
                )}
                {/* 高级模式标识 */}
                {isAdvanced && !isActive && (
                  <Sparkles className="absolute top-3 right-3 w-3 h-3 text-muted-foreground/40" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 高级模式配置面板 */}
      {activeAdvanced && (
        <div className="border-t border-border/40 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">
              {modes.find(m => m.key === activeAdvanced)?.label}
            </h3>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setActiveAdvanced(null)}
              className="h-7 px-2 text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5 mr-1" />
              {t('common:actions.back')}
            </NotionButton>
          </div>
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            }
          >
            {activeAdvanced === 'timed' && (
              <TimedPracticeMode
                examId={examId}
                onStart={() => onStartPractice('timed')}
              />
            )}
            {activeAdvanced === 'mock_exam' && (
              <MockExamMode
                examId={examId}
                onStart={() => onStartPractice('mock_exam')}
              />
            )}
            {activeAdvanced === 'daily' && (
              <DailyPracticeMode
                examId={examId}
                onStart={() => onStartPractice('daily')}
              />
            )}
            {activeAdvanced === 'paper' && (
              <PaperGenerator
                examId={examId}
                availableTags={allTags}
                onGenerate={() => onStartPractice('paper')}
              />
            )}
          </Suspense>
        </div>
      )}
    </CustomScrollArea>
  );
};

export default PracticeLauncher;
