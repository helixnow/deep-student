import React, { Suspense, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { percentOf, ratioToPercent } from '@/components/stats';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import type {
  Difficulty,
  PracticeMode,
  Question,
  QuestionBankStats,
  QuestionStatus,
  QuestionType,
} from '@/api/questionBankApi';

export type ViewMode =
  | 'list'
  | 'browse'
  | 'manage'
  | 'stats'
  | 'favorites'
  | 'practice'
  | 'upload'
  | 'review'
  | 'sm2'
  | 'tags'
  | 'launcher'
  | 'csvImport'
  | 'papers';

export type LauncherRequestedMode = 'by_tag' | 'timed' | 'mock_exam' | 'daily' | 'paper';
export type DraftSource = 'practice' | 'inlineEditor';

export interface PendingViewNavigation {
  examId: string;
  view: ViewMode;
  afterViewChange?: () => void;
}

export interface PendingDraftNavigation {
  examId: string;
  proceed: () => void;
}

export interface SecondaryTabItem {
  mode: ViewMode;
  label: string;
  icon: React.ComponentType<{ size?: string | number }>;
  badge: number;
}

export const LAUNCHER_REQUIRED_MODES = new Set<LauncherRequestedMode>([
  'by_tag',
  'timed',
  'mock_exam',
  'daily',
  'paper',
]);

export interface ManageFilters {
  search?: string;
  status?: QuestionStatus[];
  difficulty?: Difficulty[];
  questionType?: QuestionType[];
  tags?: string[];
  isFavorite?: boolean;
}

export function controlStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value.filter((item) => item.trim().length > 0);
}

export function parseManageFilters(payload: unknown): ManageFilters | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const outer = payload as Record<string, unknown>;
  const raw = outer.filters && typeof outer.filters === 'object' && !Array.isArray(outer.filters)
    ? outer.filters as Record<string, unknown>
    : outer;
  const search = typeof raw.search === 'string' ? raw.search : undefined;
  const isFavorite = typeof (raw.is_favorite ?? raw.isFavorite) === 'boolean'
    ? (raw.is_favorite ?? raw.isFavorite) as boolean
    : undefined;

  return {
    search,
    status: controlStringArray(raw.status) as QuestionStatus[] | undefined,
    difficulty: controlStringArray(raw.difficulty) as Difficulty[] | undefined,
    questionType: controlStringArray(raw.question_type ?? raw.questionType) as QuestionType[] | undefined,
    tags: controlStringArray(raw.tags),
    isFavorite,
  };
}

export function matchesPracticeTag(question: Question, tag: string): boolean {
  if (tag === '__untagged__') return !question.tags || question.tags.length === 0;
  return question.tags?.includes(tag) ?? false;
}

export const MODE_LABEL_KEYS: Record<PracticeMode, string> = {
  sequential: 'learningHub:exam.mode.sequential',
  random: 'learningHub:exam.mode.random',
  review_first: 'learningHub:exam.mode.reviewFirst',
  review_only: 'learningHub:exam.mode.reviewOnly',
  by_tag: 'learningHub:exam.mode.byTag',
  daily: 'learningHub:exam.mode.daily',
  paper: 'learningHub:exam.mode.paper',
  timed: 'learningHub:exam.mode.timed',
  mock_exam: 'learningHub:exam.mode.mockExam',
};

type ReviewQueueItems = Parameters<ReturnType<typeof useReviewPlanStore.getState>['startSession']>[0];
type ReviewQueueItem = ReviewQueueItems[number];

export interface Sm2ReviewPanelProps {
  examId: string;
  isActive?: boolean;
  ReviewCalendarView: React.ComponentType<{
    examId: string;
    className?: string;
    onClose: () => void;
    isActive?: boolean;
  }>;
  ReviewSession: React.ComponentType<{
    examId: string;
    isActive?: boolean;
  }>;
  ReviewPlanView: React.ComponentType<{
    examId: string;
    onViewCalendar: () => void;
    onStartReview: (items: ReviewQueueItems) => void;
    onReviewItemClick: (item: ReviewQueueItem) => void;
  }>;
}

/**
 * I1 修复：SM-2 间隔复习面板
 *
 * 有活跃复习会话时渲染 ReviewSession（答题打分），否则渲染 ReviewPlanView
 * （今日到期/复习队列/开始复习）。会话由 reviewPlanStore 全局管理。
 * 三个子视图由宿主传入 lazy 组件，保持全部 lazy 边界在 ExamContentView 内。
 */
export const Sm2ReviewPanel: React.FC<Sm2ReviewPanelProps> = ({
  examId,
  isActive,
  ReviewCalendarView,
  ReviewSession,
  ReviewPlanView,
}) => {
  const session = useReviewPlanStore((s) => s.session);
  const startSession = useReviewPlanStore((s) => s.startSession);
  const [showCalendar, setShowCalendar] = useState(false);
  const isSessionActive = session.isActive && session.examId === examId;

  return (
    <CustomScrollArea className="min-h-0 flex-1">
      <Suspense fallback={null}>
        {showCalendar ? (
          <ReviewCalendarView
            examId={examId}
            className="p-4"
            onClose={() => setShowCalendar(false)}
            isActive={isActive}
          />
        ) : isSessionActive ? (
          <ReviewSession examId={examId} isActive={isActive} />
        ) : (
          <ReviewPlanView
            examId={examId}
            onViewCalendar={() => setShowCalendar(true)}
            onStartReview={(items) => startSession(items, examId)}
            onReviewItemClick={(item) => startSession([item], examId)}
          />
        )}
      </Suspense>
    </CustomScrollArea>
  );
};

/** 数字滚动动效：以 rAF 缓动逼近目标值，reduced-motion 时直接跳变 */
export function useAnimatedNumber(target: number, duration = 600): number {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);

  useEffect(() => {
    const from = valueRef.current;
    if (from === target) return;
    if (typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + (target - from) * eased;
      valueRef.current = next;
      setValue(next);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

/** 顶栏统计摘要：极简纯文本微指标（掌握率 · 正确率），数字滚动 */
export const StatsSummary: React.FC<{ stats: QuestionBankStats }> = ({ stats }) => {
  const { t } = useTranslation('learningHub');
  const masteryPercent = Math.round(useAnimatedNumber(percentOf(stats.mastered, stats.total)));
  const correctPercent = Math.round(useAnimatedNumber(ratioToPercent(stats.correctRate)));

  return (
    <div
      className="hidden md:flex items-center gap-2.5 pr-1 text-xs text-muted-foreground select-none"
      role="group"
      aria-label={t('exam.shell.statsSummary')}
    >
      <span className="inline-flex items-center gap-1 leading-none" title={`${t('exam.shell.mastery')} ${stats.mastered}/${stats.total}`}>
        <span>{t('exam.shell.mastery')}</span>
        <span className="font-mono font-medium tabular-nums text-foreground">{masteryPercent}%</span>
      </span>
      <span className="text-border" aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1 leading-none" title={t('exam.shell.correctRate')}>
        <span>{t('exam.shell.correctRate')}</span>
        <span className="font-mono font-medium tabular-nums text-foreground">{correctPercent}%</span>
      </span>
    </div>
  );
};

/** Suspense 骨架屏：模拟工具行 + 列表行，替代空白/转圈 */
export const ViewSkeleton: React.FC = () => {
  const { t } = useTranslation('learningHub');
  return (
    <div className="h-full overflow-hidden px-4 py-4" role="status" aria-label={t('exam.shell.viewLoading')}>
      <div className="animate-pulse space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="h-7 w-36 rounded-md bg-muted/70" />
          <div className="flex items-center gap-2">
            <div className="h-7 w-20 rounded-md bg-muted/50" />
            <div className="h-7 w-14 rounded-md bg-muted/50" />
          </div>
        </div>
        <div className="space-y-2.5">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="rounded-lg border border-border/40 px-3 py-3">
              <div className="h-4 rounded bg-muted/60" style={{ width: `${[72, 58, 84, 64, 76, 52][row]}%` }} />
              <div className="mt-2.5 flex items-center gap-2">
                <div className="h-3 w-12 rounded bg-muted/40" />
                <div className="h-3 w-16 rounded bg-muted/40" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
