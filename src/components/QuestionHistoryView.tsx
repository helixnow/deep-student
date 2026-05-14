/**
 * 题目历史记录查看组件
 * 
 * P1-4 功能：显示题目的修改历史和答题记录
 * 
 * 🆕 2026-01 新增
 */

import React, { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/shad/Sheet';
import {
  ClockCounterClockwise,
  Clock,
  CheckCircle,
  XCircle,
  PencilSimple,
  Chat,
  CircleNotch,
  CaretRight,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';

type ChangeType = 'create' | 'update' | 'answer' | 'status_change';

interface RawQuestionHistory {
  id: string;
  question_id: string;
  field_name: string;
  old_value?: string;
  new_value?: string;
  change_type?: ChangeType;
  created_at: string;
}

interface QuestionHistory extends RawQuestionHistory {
  change_type: ChangeType;
}

interface QuestionHistoryViewProps {
  questionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const changeTypeIcons: Record<string, React.ReactNode> = {
  create: <PencilSimple size={16} className="text-green-500" />,
  update: <PencilSimple size={16} className="text-blue-500" />,
  answer: <Chat size={16} className="text-purple-500" />,
  status_change: <CheckCircle size={16} className="text-orange-500" />,
};

const changeTypeLabelKeys: Record<string, string> = {
  create: 'practice:questionBank.changeType.create',
  update: 'practice:questionBank.changeType.update',
  answer: 'practice:questionBank.changeType.answer',
  status_change: 'practice:questionBank.changeType.statusChange',
};

const fieldNameLabelKeys: Record<string, string> = {
  content: 'practice:questionBank.fieldName.content',
  answer: 'practice:questionBank.fieldName.answer',
  explanation: 'practice:questionBank.fieldName.explanation',
  user_answer: 'practice:questionBank.fieldName.userAnswer',
  is_correct: 'practice:questionBank.fieldName.isCorrect',
  status: 'practice:questionBank.fieldName.status',
  difficulty: 'practice:questionBank.fieldName.difficulty',
  tags: 'practice:questionBank.fieldName.tags',
  user_note: 'practice:questionBank.fieldName.userNote',
};

export const QuestionHistoryView: React.FC<QuestionHistoryViewProps> = ({
  questionId,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'practice']);
  const [history, setHistory] = useState<QuestionHistory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inferChangeType = useCallback((fieldName: string): ChangeType => {
    if (fieldName === 'status') return 'status_change';
    if (['user_answer', 'is_correct', 'attempt_count', 'correct_count'].includes(fieldName)) {
      return 'answer';
    }
    return 'update';
  }, []);

  const loadHistory = useCallback(async () => {
    if (!questionId) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await invoke<RawQuestionHistory[]>('qbank_get_history', {
        questionId,
        limit: 50,
      });
      setHistory(result.map((item) => ({
        ...item,
        change_type: item.change_type ?? inferChangeType(item.field_name),
      })));
    } catch (err: unknown) {
      console.error('[QuestionHistoryView] Failed to load history:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [questionId, inferChangeType]);

  useEffect(() => {
    if (open && questionId) {
      void loadHistory();
    }
  }, [open, questionId, loadHistory]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const statusLabelKeys: Record<string, string> = {
    new: 'practice:questionBank.status.new',
    in_progress: 'practice:questionBank.status.inProgress',
    mastered: 'practice:questionBank.status.mastered',
    review: 'practice:questionBank.status.review',
  };

  const renderValue = (value: string | undefined, fieldName: string) => {
    if (!value) return <span className="text-muted-foreground italic">{t('practice:questionBank.emptyValue')}</span>;
    
    if (fieldName === 'is_correct') {
      return value === 'true' ? (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
          {t('practice:questionBank.correctLabel')}
        </Badge>
      ) : (
        <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
          {t('practice:questionBank.incorrectLabel')}
        </Badge>
      );
    }
    
    if (fieldName === 'status') {
      return <Badge variant="secondary">{statusLabelKeys[value] ? t(statusLabelKeys[value]) : value}</Badge>;
    }
    
    if (value.length > 100) {
      return <span className="line-clamp-2">{value}</span>;
    }
    
    return <span>{value}</span>;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[540px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ClockCounterClockwise size={20} />
            {t('exam_sheet:questionBank.history.title', '历史记录')}
          </SheetTitle>
          <SheetDescription>
            {t('exam_sheet:questionBank.history.description', '查看题目的修改历史和答题记录')}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <CircleNotch size={24} className="animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <XCircle size={32} className="text-destructive mb-2" />
              <p className="text-sm text-muted-foreground">{error}</p>
              <NotionButton variant="ghost" size="sm" className="mt-4" onClick={loadHistory}>
                {t('common:retry', '重试')}
              </NotionButton>
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <ClockCounterClockwise size={32} className="text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                {t('exam_sheet:questionBank.history.empty', '暂无历史记录')}
              </p>
            </div>
          ) : (
            <CustomScrollArea className="h-[calc(100vh-200px)]">
              <div className="space-y-4 pr-4">
                {history.map((item, index) => (
                  <div
                    key={item.id}
                    className={cn(
                      'relative pl-6 pb-4',
                      index < history.length - 1 && 'border-l-2 border-border ml-2'
                    )}
                  >
                    {/* 时间线节点 */}
                    <div className="w-4 h-4 absolute left-0 top-0 rounded-full bg-background border-2 border-primary flex items-center justify-center -translate-x-1/2">
                      {changeTypeIcons[item.change_type]}
                    </div>

                    {/* 内容 */}
                    <div className="bg-card rounded-lg p-3 border border-border/50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">
                            {changeTypeLabelKeys[item.change_type] ? t(changeTypeLabelKeys[item.change_type]) : item.change_type}
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            {fieldNameLabelKeys[item.field_name] ? t(fieldNameLabelKeys[item.field_name]) : item.field_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock size={12} />
                          {formatDate(item.created_at)}
                        </div>
                      </div>

                      {item.change_type === 'update' && (
                        <div className="space-y-2 text-sm">
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground flex-shrink-0">{t('practice:questionBank.oldValue')}</span>
                            <div className="flex-1 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">
                              {renderValue(item.old_value, item.field_name)}
                            </div>
                          </div>
                          <div className="flex items-center justify-center">
                            <CaretRight size={16} className="text-muted-foreground rotate-90" />
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground flex-shrink-0">{t('practice:questionBank.newValue')}</span>
                            <div className="flex-1 bg-green-50 dark:bg-green-900/20 rounded px-2 py-1">
                              {renderValue(item.new_value, item.field_name)}
                            </div>
                          </div>
                        </div>
                      )}

                      {item.change_type === 'answer' && (
                        <div className="text-sm">
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground">{t('practice:questionBank.answerLabel')}</span>
                            <div className="flex-1">
                              {renderValue(item.new_value, item.field_name)}
                            </div>
                          </div>
                        </div>
                      )}

                      {item.change_type === 'status_change' && (
                        <div className="flex items-center gap-2 text-sm">
                          {renderValue(item.old_value, 'status')}
                          <CaretRight size={16} className="text-muted-foreground" />
                          {renderValue(item.new_value, 'status')}
                        </div>
                      )}

                      {item.change_type === 'create' && (
                        <div className="text-sm text-muted-foreground">
                          {t('practice:questionBank.questionCreated')}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CustomScrollArea>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default QuestionHistoryView;
