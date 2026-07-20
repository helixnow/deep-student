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
  ArrowLeft,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

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
  /**
   * inline 模式（移动端）：不渲染右侧 Sheet 抽屉，改为宿主容器内的
   * 全屏内联子屏（absolute inset-0 + 顶栏返回 + Android 返回键）。
   */
  inline?: boolean;
}

const changeTypeIcons: Record<string, React.ReactNode> = {
  create: <PencilSimple size={16} className="text-success" />,
  update: <PencilSimple size={16} className="text-primary" />,
  answer: <Chat size={16} className="text-info" />,
  status_change: <CheckCircle size={16} className="text-warning" />,
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
  inline = false,
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

  // inline 子屏：Android 返回键 = 关闭（Sheet 形态由 Radix 兜底处理）
  useEffect(() => {
    if (!inline || !open) return;
    return registerBackHandler(() => {
      onOpenChange(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [inline, open, onOpenChange]);

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
        <Badge className="bg-success/10 text-success">
          {t('practice:questionBank.correctLabel')}
        </Badge>
      ) : (
        <Badge className="bg-destructive/10 text-destructive">
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

  // 历史时间线主体（Sheet 与 inline 子屏共用）
  const historyBody = (scrollAreaClassName: string) => (
    <>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <CircleNotch size={24} className="animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <XCircle size={32} className="text-destructive mb-2" />
              <p className="text-sm text-muted-foreground">{error}</p>
              <NotionButton variant="ghost" size="sm" className="mt-4" onClick={loadHistory}>
                {t('common:retry')}
              </NotionButton>
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <ClockCounterClockwise size={32} className="text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                {t('exam_sheet:questionBank.history.empty')}
              </p>
            </div>
          ) : (
            <CustomScrollArea className={scrollAreaClassName}>
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
                            <div className="flex-1 rounded bg-destructive/5 px-2 py-1">
                              {renderValue(item.old_value, item.field_name)}
                            </div>
                          </div>
                          <div className="flex items-center justify-center">
                            <CaretRight size={16} className="text-muted-foreground rotate-90" />
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground flex-shrink-0">{t('practice:questionBank.newValue')}</span>
                            <div className="flex-1 rounded bg-success/5 px-2 py-1">
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
    </>
  );

  // ==================== inline 模式：全屏内联子屏（移动端） ====================
  if (inline) {
    if (!open) return null;
    return (
      <div
        className="absolute inset-0 z-30 flex flex-col bg-background"
        role="dialog"
        aria-label={t('exam_sheet:questionBank.history.title')}
      >
        {/* 顶栏：返回 + 标题 */}
        <div className="flex h-12 flex-shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => onOpenChange(false)}
            aria-label={t('common:back')}
            className="!h-11 !w-11 text-muted-foreground"
          >
            <ArrowLeft size={20} />
          </NotionButton>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ClockCounterClockwise size={16} className="flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">
              {t('exam_sheet:questionBank.history.title')}
            </span>
          </div>
        </div>
        <p className="flex-shrink-0 border-b border-border/40 px-4 py-2 text-xs text-muted-foreground">
          {t('exam_sheet:questionBank.history.description')}
        </p>
        <div
          className="min-h-0 flex-1 overflow-hidden px-4 pt-4"
          style={{
            paddingBottom: 'var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
          }}
        >
          {historyBody('h-full')}
        </div>
      </div>
    );
  }

  // ==================== 桌面端：右侧 Sheet ====================
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(92vw,400px)] sm:w-[540px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ClockCounterClockwise size={20} />
            {t('exam_sheet:questionBank.history.title')}
          </SheetTitle>
          <SheetDescription>
            {t('exam_sheet:questionBank.history.description')}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6">
          {historyBody('h-[calc(100vh-200px)]')}
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default QuestionHistoryView;
