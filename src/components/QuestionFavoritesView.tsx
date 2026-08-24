/**
 * 题目收藏列表组件
 *
 * P1-5 功能：显示收藏的题目列表
 *
 * 🆕 2026-01 新增
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { getQuestionTypeMeta } from './questionTypeMeta';
import {
  Star,
  CircleNotch,
  CaretRight,
  CheckCircle,
  XCircle,
  WarningCircle,
  ClockCounterClockwise,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { Question as ApiQuestion, QuestionStatus, Difficulty } from '@/api/questionBankApi';
import type { Question as StoreQuestion } from '@/stores/questionBankStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface QuestionFavoritesViewProps {
  examId: string;
  onSelectQuestion?: (question: ApiQuestion) => void;
  onToggleFavorite?: (questionId: string) => Promise<void>;
  onViewHistory?: (questionId: string) => void;
  onBrowseQuestions?: () => void;
}

const statusColors: Record<QuestionStatus, string> = {
  new: 'bg-muted text-muted-foreground',
  in_progress: 'bg-primary/10 text-primary',
  mastered: 'bg-success/10 text-success',
  review: 'bg-warning/10 text-warning',
};

const statusLabelKeys: Record<QuestionStatus, string> = {
  new: 'practice:questionBank.status.new',
  in_progress: 'practice:questionBank.status.inProgress',
  mastered: 'practice:questionBank.status.mastered',
  review: 'practice:questionBank.status.review',
};

const difficultyPills: Record<Difficulty, string> = {
  easy: 'bg-success/10 text-success',
  medium: 'bg-warning/10 text-warning',
  hard: 'bg-warning/15 text-warning',
  very_hard: 'bg-destructive/10 text-destructive',
};

const difficultyLabelKeys: Record<Difficulty, string> = {
  easy: 'practice:questionBank.difficultyShort.easy',
  medium: 'practice:questionBank.difficultyShort.medium',
  hard: 'practice:questionBank.difficultyShort.hard',
  very_hard: 'practice:questionBank.difficultyShort.veryHard',
};

/** 列表进入 stagger：延迟随索引递增，封顶避免长列表尾部等待过久 */
const staggerStyle = (index: number): React.CSSProperties => ({
  animationDelay: `${Math.min(index, 16) * 24}ms`,
});

export const QuestionFavoritesView: React.FC<QuestionFavoritesViewProps> = ({
  examId,
  onSelectQuestion,
  onToggleFavorite,
  onViewHistory,
  onBrowseQuestions,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'practice', 'learningHub']);
  const PAGE_SIZE = 500;
  const [favorites, setFavorites] = useState<ApiQuestion[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ★ 竞态修复：请求序号递增，只有最新一次请求的响应才允许落地，
  // 防止 examId 快速切换或连续刷新时过期响应覆盖新数据；卸载后不再 setState
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mapToApiQuestion = useCallback((q: StoreQuestion): ApiQuestion => ({
    id: q.id,
    cardId: q.card_id || q.id,
    questionLabel: q.question_label || '',
    content: q.content,
    ocrText: q.content,
    questionType: q.question_type,
    options: q.options,
    answer: q.answer,
    explanation: q.explanation,
    difficulty: q.difficulty,
    tags: q.tags,
    status: q.status,
    userAnswer: q.user_answer,
    isCorrect: q.is_correct,
    userNote: q.user_note,
    attemptCount: q.attempt_count,
    correctCount: q.correct_count,
    lastAttemptAt: q.last_attempt_at,
    isFavorite: q.is_favorite,
    images: q.images,
  }), []);

  const loadFavorites = useCallback(async (options?: { silent?: boolean }) => {
    if (!examId) return;

    const seq = ++requestSeqRef.current;
    if (!options?.silent) {
      setIsLoading(true);
      setError(null);
    }
    try {
      const result = await invoke<{ questions: StoreQuestion[]; total: number }>('qbank_list_questions', {
        request: {
          exam_id: examId,
          filters: { is_favorite: true },
          page: 1,
          page_size: PAGE_SIZE,
        },
      });
      // 过期响应直接丢弃
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      setFavorites(result.questions.map(mapToApiQuestion));
      setTotalCount(result.total);
    } catch (err: unknown) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      console.error('[QuestionFavoritesView] Failed to load favorites:', err);
      if (!options?.silent) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current && !options?.silent) {
        setIsLoading(false);
      }
    }
  }, [examId, mapToApiQuestion]);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  // 乐观更新：先移除卡片，失败时回滚并提示
  const handleToggleFavorite = useCallback(async (questionId: string) => {
    if (!onToggleFavorite) {
      showGlobalNotification(
        'warning',
        t('exam_sheet:questionBank.actionUnavailable')
      );
      return;
    }
    const prevFavorites = favorites;
    const prevTotal = totalCount;
    setActionLoading(questionId);
    setFavorites((current) => current.filter((q) => q.id !== questionId));
    setTotalCount((count) => Math.max(0, count - 1));
    try {
      await onToggleFavorite(questionId);
      // 静默同步一次，修正截断计数等边缘状态（乐观结果已呈现，不闪 loading）
      void loadFavorites({ silent: true });
    } catch (err: unknown) {
      if (mountedRef.current) {
        setFavorites(prevFavorites);
        setTotalCount(prevTotal);
      }
      showGlobalNotification(
        'error',
        `${t('learningHub:exam.library.unfavoriteFailedRollback')}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (mountedRef.current) {
        setActionLoading(null);
      }
    }
  }, [onToggleFavorite, favorites, totalCount, loadFavorites, t]);

  // 简洁风格卡片：与题库列表视图统一（hover 浮起 + 微阴影 + stagger 入场）
  const renderQuestionCard = (question: ApiQuestion, index: number) => (
    <div
      key={question.id}
      role="button"
      tabIndex={0}
      style={staggerStyle(index)}
      onClick={() => onSelectQuestion?.(question)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectQuestion?.(question); } }}
      className={cn(
        'ui-rise-in group relative cursor-pointer rounded-lg border border-border/60 bg-card p-3',
        // 长列表渲染优化：视口外卡片跳过渲染（记忆上次尺寸避免滚动条跳动）
        '[content-visibility:auto] [contain-intrinsic-size:auto_88px]',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-200',
        'hover:border-border hover:bg-[var(--interactive-hover)] hover:shadow-[var(--shadow-card)] hover:-translate-y-0.5',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Star size={13} weight="fill" className="flex-shrink-0 text-warning" />
            <span className="truncate text-sm font-medium">
              {question.questionLabel || question.cardId}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground leading-relaxed">
            {question.content.slice(0, 80)}
            {question.content.length > 80 && '...'}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100">
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="!w-8 !h-8 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11"
            title={t('exam_sheet:questionBank.history.title')}
            aria-label={t('exam_sheet:questionBank.history.title')}
            onClick={(e) => {
              e.stopPropagation();
              onViewHistory?.(question.id);
            }}
          >
            <ClockCounterClockwise size={16} className="text-muted-foreground" />
          </DsButton>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="!w-8 !h-8 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11"
            title={t('exam_sheet:questionBank.unfavorite')}
            aria-label={t('exam_sheet:questionBank.unfavorite')}
            disabled={!onToggleFavorite || actionLoading === question.id}
            onClick={(e) => {
              e.stopPropagation();
              void handleToggleFavorite(question.id);
            }}
          >
            {actionLoading === question.id ? (
              <CircleNotch size={16} className="animate-spin" />
            ) : (
              <Star size={16} weight="fill" className="text-warning" />
            )}
          </DsButton>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge className={cn('text-xs', statusColors[question.status])}>
            {t(statusLabelKeys[question.status])}
          </Badge>
          {question.difficulty && (
            <span className={cn('rounded px-1.5 py-0.5 font-medium', difficultyPills[question.difficulty])}>
              {t(difficultyLabelKeys[question.difficulty])}
            </span>
          )}
          {question.questionType && question.questionType !== 'other' && (
            <span className={cn('rounded px-1.5 py-0.5 font-medium', getQuestionTypeMeta(question.questionType).pill)}>
              {t(getQuestionTypeMeta(question.questionType).labelKey)}
            </span>
          )}
          {question.isCorrect === true && (
            <CheckCircle size={14} className="text-success" />
          )}
          {question.isCorrect === false && (
            <XCircle size={14} className="text-destructive" />
          )}
        </div>
        <CaretRight size={16} className="text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col p-3">
      <div className="flex items-center gap-2 mb-3">
        <Star size={16} />
        <span className="text-sm font-medium">
          {t('exam_sheet:questionBank.favorites.title')}
        </span>
        {favorites.length > 0 && (
          <Badge variant="secondary" className="ml-1 h-5 px-1.5">
            {favorites.length}
          </Badge>
        )}
      </div>
      {isLoading ? (
        // 加载骨架：模拟收藏卡片结构，避免整屏转圈闪切
        <div className="space-y-2 pr-2" role="status" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border border-border/60 bg-card p-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-1 h-3 w-3/4" />
              <div className="mt-2 flex items-center gap-1.5">
                <Skeleton className="h-4 w-12 rounded" />
                <Skeleton className="h-4 w-10 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <WarningCircle size={40} className="text-destructive/70 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.favorites.loadFailed')}
          </p>
          <DsButton variant="ghost" size="sm" className="mt-3 [@media(pointer:coarse)]:!min-h-11" onClick={() => void loadFavorites()}>
            {t('common:actions.retry')}
          </DsButton>
        </div>
      ) : favorites.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Star size={28} className="text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.favorites.empty')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('exam_sheet:questionBank.favorites.hint')}
          </p>
          {onBrowseQuestions && (
            <DsButton variant="ghost" size="sm" className="mt-3 [@media(pointer:coarse)]:!min-h-11" onClick={onBrowseQuestions}>
              {t('exam_sheet:questionBank.favorites.browse')}
            </DsButton>
          )}
        </div>
      ) : (
        <CustomScrollArea className="flex-1 min-h-0">
          <div className="space-y-2 pr-2">
            {totalCount > PAGE_SIZE && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1 rounded-md bg-warning/10 text-warning">
                <WarningCircle size={14} className="flex-shrink-0" />
                <span className="text-xs">
                  {t(
                    'exam_sheet:questionBank.favorites.truncated', { count: PAGE_SIZE, total: totalCount }
                  )}
                </span>
              </div>
            )}
            {favorites.map((q, index) => renderQuestionCard(q, index))}
          </div>
        </CustomScrollArea>
      )}
    </div>
  );
};

export default QuestionFavoritesView;
