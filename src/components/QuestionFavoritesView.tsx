/**
 * 题目收藏列表组件
 *
 * P1-5 功能：显示收藏的题目列表
 *
 * 🆕 2026-01 新增
 */

import React, { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/shad/Card';
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
import type { Question as ApiQuestion, QuestionStatus } from '@/api/questionBankApi';
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

export const QuestionFavoritesView: React.FC<QuestionFavoritesViewProps> = ({
  examId,
  onSelectQuestion,
  onToggleFavorite,
  onViewHistory,
  onBrowseQuestions,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'practice']);
  const PAGE_SIZE = 500;
  const [favorites, setFavorites] = useState<ApiQuestion[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const loadFavorites = useCallback(async () => {
    if (!examId) return;

    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<{ questions: StoreQuestion[]; total: number }>('qbank_list_questions', {
        request: {
          exam_id: examId,
          filters: { is_favorite: true },
          page: 1,
          page_size: PAGE_SIZE,
        },
      });
      setFavorites(result.questions.map(mapToApiQuestion));
      setTotalCount(result.total);
    } catch (err: unknown) {
      console.error('[QuestionFavoritesView] Failed to load favorites:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [examId, mapToApiQuestion]);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  const handleToggleFavorite = useCallback(async (questionId: string) => {
    if (!onToggleFavorite) {
      showGlobalNotification(
        'warning',
        t('exam_sheet:questionBank.actionUnavailable')
      );
      return;
    }
    setActionLoading(questionId);
    try {
      await onToggleFavorite(questionId);
      await loadFavorites();
    } catch (err: unknown) {
      showGlobalNotification(
        'error',
        `${t('exam_sheet:questionBank.favorites.toggleFailed')}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setActionLoading(null);
    }
  }, [onToggleFavorite, loadFavorites, t]);

  const renderQuestionCard = (question: ApiQuestion) => (
    <Card
      key={question.id}
      className="cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors"
      onClick={() => onSelectQuestion?.(question)}
    >
      <CardHeader className="p-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium line-clamp-1">
              {question.questionLabel || question.cardId}
            </CardTitle>
            <CardDescription className="text-xs line-clamp-2 mt-1">
              {question.content.slice(0, 80)}
              {question.content.length > 80 && '...'}
            </CardDescription>
          </div>
          <NotionButton
            variant="ghost"
            size="icon"
 className="w-8 h-8 flex-shrink-0"
            title={t('exam_sheet:questionBank.history.title')}
            onClick={(e) => {
              e.stopPropagation();
              onViewHistory?.(question.id);
            }}
          >
            <ClockCounterClockwise size={16} className="text-muted-foreground" />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="icon"
 className="w-8 h-8 flex-shrink-0"
            disabled={!onToggleFavorite || actionLoading === question.id}
            onClick={(e) => {
              e.stopPropagation();
              void handleToggleFavorite(question.id);
            }}
          >
            {actionLoading === question.id ? (
              <CircleNotch size={16} className="animate-spin" />
            ) : (
              <Star size={16} className="text-warning" />
            )}
          </NotionButton>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge className={cn('text-xs', statusColors[question.status])}>
              {t(statusLabelKeys[question.status])}
            </Badge>
            {question.isCorrect === true && (
              <CheckCircle size={14} className="text-success" />
            )}
            {question.isCorrect === false && (
              <XCircle size={14} className="text-destructive" />
            )}
          </div>
          <CaretRight size={16} className="text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
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
        <div className="flex items-center justify-center py-12">
          <CircleNotch size={24} className="animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <WarningCircle size={40} className="text-destructive/70 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.favorites.loadFailed')}
          </p>
          <NotionButton variant="ghost" size="sm" className="mt-3" onClick={() => void loadFavorites()}>
            {t('common:actions.retry')}
          </NotionButton>
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
            <NotionButton variant="ghost" size="sm" className="mt-3" onClick={onBrowseQuestions}>
              {t('exam_sheet:questionBank.favorites.browse')}
            </NotionButton>
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
            {favorites.map((q) => renderQuestionCard(q))}
          </div>
        </CustomScrollArea>
      )}
    </div>
  );
};

export default QuestionFavoritesView;
