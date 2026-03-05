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
  Loader2,
  ChevronRight,
  StarOff,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { Question as ApiQuestion, QuestionStatus } from '@/api/questionBankApi';
import type { Question as StoreQuestion } from '@/stores/questionBankStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface QuestionFavoritesViewProps {
  examId: string;
  onSelectQuestion?: (question: ApiQuestion) => void;
  onToggleFavorite?: (questionId: string) => Promise<void>;
}

const statusColors: Record<QuestionStatus, string> = {
  new: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  mastered: 'bg-success/10 text-success',
  review: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
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
        t('exam_sheet:questionBank.actionUnavailable', '当前操作不可用')
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
        `${t('exam_sheet:questionBank.favorites.toggleFailed', '更新收藏失败')}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setActionLoading(null);
    }
  }, [onToggleFavorite, loadFavorites, t]);

  const renderQuestionCard = (question: ApiQuestion) => (
    <Card
      key={question.id}
      className="cursor-pointer hover:bg-muted/50 transition-colors"
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
            className="h-8 w-8 flex-shrink-0"
            disabled={!onToggleFavorite || actionLoading === question.id}
            onClick={(e) => {
              e.stopPropagation();
              void handleToggleFavorite(question.id);
            }}
          >
            {actionLoading === question.id ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <StarOff className="w-4 h-4 text-yellow-500" />
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
              <CheckCircle className="w-3.5 h-3.5 text-success" />
            )}
            {question.isCorrect === false && (
              <XCircle className="w-3.5 h-3.5 text-red-500" />
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="h-full flex flex-col p-3">
      <div className="flex items-center gap-2 mb-3">
        <Star className="w-4 h-4" />
        <span className="text-sm font-medium">
          {t('exam_sheet:questionBank.favorites.title', '收藏')}
        </span>
        {favorites.length > 0 && (
          <Badge variant="secondary" className="ml-1 h-5 px-1.5">
            {favorites.length}
          </Badge>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="w-10 h-10 text-destructive/70 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.favorites.loadFailed', '收藏加载失败')}
          </p>
          <NotionButton variant="ghost" size="sm" className="mt-3" onClick={() => void loadFavorites()}>
            {t('common:actions.retry', '重试')}
          </NotionButton>
        </div>
      ) : favorites.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Star className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.favorites.empty', '暂无收藏题目')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('exam_sheet:questionBank.favorites.hint', '点击题目上的星星图标可添加收藏')}
          </p>
        </div>
      ) : (
        <CustomScrollArea className="h-[calc(100vh-180px)]">
          <div className="space-y-2 pr-2">
            {totalCount > PAGE_SIZE && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1 rounded-md bg-warning/10 text-warning">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs">
                  {t(
                    'exam_sheet:questionBank.favorites.truncated',
                    '仅显示前 {{count}} 条收藏，共 {{total}} 条',
                    { count: PAGE_SIZE, total: totalCount }
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
