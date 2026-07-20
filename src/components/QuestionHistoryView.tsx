/**
 * 题目历史记录查看组件
 *
 * P1-4 功能：显示题目的修改历史和答题记录
 *
 * 🆕 2026-01 新增
 * 🆕 2026-07 重构：
 *   - 桌面端不再使用右侧 Sheet 抽屉，统一为宿主容器内的内联子屏
 *   - 时间线按日分组（今天/昨天/日期），正确/错误视觉区分
 *   - 筛选 chip（全部/答题/仅错题）
 *   - 分页加载（加载更多）
 *   - 点击记录内联展开完整变更内容（不跳转、不弹窗）
 *   - 加载态骨架屏
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import {
  ClockCounterClockwise,
  Clock,
  CheckCircle,
  XCircle,
  PencilSimple,
  Chat,
  CircleNotch,
  CaretRight,
  CaretDown,
  ArrowLeft,
  ArrowSquareOut,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import {
  QBANK_FOCUS_EVENT,
  type QbankFocusEventDetail,
} from '@/features/workbench/agent/drivers/qbankDriver';

type ChangeType = 'create' | 'update' | 'answer' | 'status_change';

type HistoryFilter = 'all' | 'answer' | 'wrong';

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
   * inline 模式（移动端）：宿主容器内的全屏内联子屏。
   * 2026-07 起桌面端也使用同样的内联子屏（不再有 Sheet 抽屉），
   * 该 prop 仅额外控制 Android 返回键接管，保持接口兼容。
   */
  inline?: boolean;
  /**
   * 从历史跳回题目（可选，向后兼容新增）。
   * 未提供时回退为派发 QBANK_FOCUS_EVENT（沿用 agent 聚焦题目的既有事件机制），
   * 宿主 ExamContentView 已监听该事件并导航到对应题目。
   */
  onJumpToQuestion?: (questionId: string) => void;
}

const PAGE_SIZE = 50;

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

const statusLabelKeys: Record<string, string> = {
  new: 'practice:questionBank.status.new',
  in_progress: 'practice:questionBank.status.inProgress',
  mastered: 'practice:questionBank.status.mastered',
  review: 'practice:questionBank.status.review',
};

// ============================================================================
// 工具
// ============================================================================

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 是否为「答错」记录 */
function isWrongRecord(item: QuestionHistory): boolean {
  return item.field_name === 'is_correct' && item.new_value === 'false';
}

/** 是否为「答对」记录 */
function isCorrectRecord(item: QuestionHistory): boolean {
  return item.field_name === 'is_correct' && item.new_value === 'true';
}

/** 值较长时才需要展开/收起 */
function hasLongValue(item: QuestionHistory): boolean {
  return (item.old_value?.length ?? 0) > 100 || (item.new_value?.length ?? 0) > 100;
}

// ============================================================================
// 骨架屏
// ============================================================================

const HistorySkeleton: React.FC = () => (
  <div className="space-y-4 pr-4">
    <Skeleton className="h-4 w-20" />
    {[1, 2, 3].map(i => (
      <Skeleton key={i} className="h-24 rounded-lg" />
    ))}
    <Skeleton className="h-4 w-20" />
    {[4, 5].map(i => (
      <Skeleton key={i} className="h-24 rounded-lg" />
    ))}
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

export const QuestionHistoryView: React.FC<QuestionHistoryViewProps> = ({
  questionId,
  open,
  onOpenChange,
  inline = false,
  onJumpToQuestion,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'practice', 'stats', 'learningHub']);
  const [history, setHistory] = useState<QuestionHistory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const inferChangeType = useCallback((fieldName: string): ChangeType => {
    if (fieldName === 'status') return 'status_change';
    if (['user_answer', 'is_correct', 'attempt_count', 'correct_count'].includes(fieldName)) {
      return 'answer';
    }
    return 'update';
  }, []);

  // 后端 qbank_get_history 仅支持 limit（无 offset），
  // "加载更多" = 以更大的 limit 重新拉取并整体替换。
  const loadHistory = useCallback(async (requestLimit: number, isMore: boolean) => {
    if (!questionId) return;

    if (isMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const result = await invoke<RawQuestionHistory[]>('qbank_get_history', {
        questionId,
        limit: requestLimit,
      });
      setHistory(result.map((item) => ({
        ...item,
        change_type: item.change_type ?? inferChangeType(item.field_name),
      })));
      setHasMore(result.length >= requestLimit);
    } catch (err: unknown) {
      console.error('[QuestionHistoryView] Failed to load history:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [questionId, inferChangeType]);

  // 打开 / 切换题目时重置并加载第一页
  useEffect(() => {
    if (open && questionId) {
      setHistory([]);
      setExpandedIds(new Set());
      setLimit(PAGE_SIZE);
      setHasMore(false);
      void loadHistory(PAGE_SIZE, false);
    }
  }, [open, questionId, loadHistory]);

  const handleLoadMore = useCallback(() => {
    const next = limit + PAGE_SIZE;
    setLimit(next);
    void loadHistory(next, true);
  }, [limit, loadHistory]);

  const handleRetry = useCallback(() => {
    void loadHistory(limit, false);
  }, [limit, loadHistory]);

  // inline 子屏（移动端）：Android 返回键 = 关闭
  useEffect(() => {
    if (!inline || !open) return;
    return registerBackHandler(() => {
      onOpenChange(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [inline, open, onOpenChange]);

  // 桌面 / 通用：Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  // 从历史直接跳回题目：优先走宿主回调，否则复用 QBANK_FOCUS_EVENT 事件机制
  const handleJumpToQuestion = useCallback(() => {
    if (!questionId) return;
    if (onJumpToQuestion) {
      onJumpToQuestion(questionId);
      onOpenChange(false);
      return;
    }
    let handled = false;
    // dispatchEvent 同步执行监听器，acknowledge 会在返回前被调用
    window.dispatchEvent(
      new CustomEvent<QbankFocusEventDetail>(QBANK_FOCUS_EVENT, {
        detail: {
          questionId,
          acknowledge: (result) => { handled = result.handled; },
        },
      })
    );
    // 宿主未接管（如有未保存草稿待确认）时保持历史子屏打开
    if (handled) {
      onOpenChange(false);
    }
  }, [questionId, onJumpToQuestion, onOpenChange]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 筛选
  const filteredHistory = useMemo(() => {
    switch (filter) {
      case 'answer':
        return history.filter(item => item.change_type === 'answer');
      case 'wrong':
        return history.filter(isWrongRecord);
      default:
        return history;
    }
  }, [history, filter]);

  const filterCounts = useMemo(() => ({
    all: history.length,
    answer: history.filter(item => item.change_type === 'answer').length,
    wrong: history.filter(isWrongRecord).length,
  }), [history]);

  // 按日分组（本地时区；后端已按 created_at DESC 排序，此处防御性再排一次）
  const groupedHistory = useMemo(() => {
    const sorted = [...filteredHistory].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const groups: Array<{ dateKey: string; items: QuestionHistory[] }> = [];
    for (const item of sorted) {
      const date = new Date(item.created_at);
      const dateKey = Number.isNaN(date.getTime()) ? item.created_at : toLocalDateStr(date);
      const last = groups[groups.length - 1];
      if (last && last.dateKey === dateKey) {
        last.items.push(item);
      } else {
        groups.push({ dateKey, items: [item] });
      }
    }
    return groups;
  }, [filteredHistory]);

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDayLabel = (dateKey: string) => {
    const today = new Date();
    if (dateKey === toLocalDateStr(today)) return t('stats:historyView.today');
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (dateKey === toLocalDateStr(yesterday)) return t('stats:historyView.yesterday');
    const date = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateKey;
    return date.toLocaleDateString(undefined, {
      year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    });
  };

  const changeTypeIcon = (item: QuestionHistory): React.ReactNode => {
    if (isCorrectRecord(item)) return <CheckCircle size={12} weight="fill" className="text-success" />;
    if (isWrongRecord(item)) return <XCircle size={12} weight="fill" className="text-destructive" />;
    switch (item.change_type) {
      case 'create': return <PencilSimple size={12} className="text-success" />;
      case 'answer': return <Chat size={12} className="text-info" />;
      case 'status_change': return <CheckCircle size={12} className="text-warning" />;
      default: return <PencilSimple size={12} className="text-primary" />;
    }
  };

  const renderValue = (value: string | undefined, fieldName: string, expanded: boolean) => {
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

    if (value.length > 100 && !expanded) {
      return <span className="line-clamp-2 break-words">{value}</span>;
    }

    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  };

  // 筛选 chip
  const filterChip = (value: HistoryFilter, label: string, count: number, tone?: string) => (
    <button
      type="button"
      onClick={() => setFilter(value)}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium',
        'border ui-state-colors cursor-pointer',
        filter === value
          ? 'bg-primary/10 border-primary/40 text-primary'
          : 'bg-muted/40 border-border/60 text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
      )}
      aria-pressed={filter === value}
    >
      <span className={cn(filter === value ? undefined : tone)}>{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );

  // 单条历史卡片
  const renderItem = (item: QuestionHistory, isLastInGroup: boolean) => {
    const expanded = expandedIds.has(item.id);
    const expandable = hasLongValue(item);
    const wrong = isWrongRecord(item);
    const correct = isCorrectRecord(item);

    return (
      <div
        key={item.id}
        className={cn('relative pl-6 pb-4', !isLastInGroup && 'border-l-2 border-border ml-2')}
      >
        {/* 时间线节点 */}
        <div
          className={cn(
            'w-5 h-5 absolute left-0 top-0 rounded-full bg-background border-2 flex items-center justify-center -translate-x-1/2',
            correct ? 'border-success' : wrong ? 'border-destructive' : 'border-primary/60'
          )}
        >
          {changeTypeIcon(item)}
        </div>

        {/* 内容卡片：可点击内联展开 */}
        <div
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          onClick={expandable ? () => toggleExpanded(item.id) : undefined}
          onKeyDown={expandable ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleExpanded(item.id);
            }
          } : undefined}
          className={cn(
            'bg-card rounded-lg p-3 border border-border/50 border-l-2 transition-colors',
            correct && 'border-l-success/70 bg-success/[0.03]',
            wrong && 'border-l-destructive/70 bg-destructive/[0.03]',
            !correct && !wrong && 'border-l-border',
            expandable && 'cursor-pointer hover:border-border hover:bg-[var(--interactive-hover)]'
          )}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="outline" className="text-xs flex-shrink-0">
                {changeTypeLabelKeys[item.change_type] ? t(changeTypeLabelKeys[item.change_type]) : item.change_type}
              </Badge>
              <span className="text-sm text-muted-foreground truncate">
                {fieldNameLabelKeys[item.field_name] ? t(fieldNameLabelKeys[item.field_name]) : item.field_name}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
              <Clock size={12} />
              <span className="tabular-nums">{formatTime(item.created_at)}</span>
              {expandable && (
                <CaretDown
                  size={12}
                  className={cn('transition-transform duration-200', expanded && 'rotate-180')}
                />
              )}
            </div>
          </div>

          {item.change_type === 'update' && (
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground flex-shrink-0">{t('practice:questionBank.oldValue')}</span>
                <div className="flex-1 min-w-0 rounded bg-destructive/5 px-2 py-1">
                  {renderValue(item.old_value, item.field_name, expanded)}
                </div>
              </div>
              <div className="flex items-center justify-center">
                <CaretRight size={16} className="text-muted-foreground rotate-90" />
              </div>
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground flex-shrink-0">{t('practice:questionBank.newValue')}</span>
                <div className="flex-1 min-w-0 rounded bg-success/5 px-2 py-1">
                  {renderValue(item.new_value, item.field_name, expanded)}
                </div>
              </div>
            </div>
          )}

          {item.change_type === 'answer' && (
            <div className="text-sm">
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground flex-shrink-0">{t('practice:questionBank.answerLabel')}</span>
                <div className="flex-1 min-w-0">
                  {renderValue(item.new_value, item.field_name, expanded)}
                </div>
              </div>
              {/* 展开时补充展示上一次作答（如有） */}
              {expanded && item.old_value && (
                <div className="flex items-start gap-2 mt-2">
                  <span className="text-muted-foreground flex-shrink-0">{t('practice:questionBank.oldValue')}</span>
                  <div className="flex-1 min-w-0 rounded bg-muted/40 px-2 py-1">
                    {renderValue(item.old_value, item.field_name, expanded)}
                  </div>
                </div>
              )}
            </div>
          )}

          {item.change_type === 'status_change' && (
            <div className="flex items-center gap-2 text-sm flex-wrap">
              {renderValue(item.old_value, 'status', expanded)}
              <CaretRight size={16} className="text-muted-foreground" />
              {renderValue(item.new_value, 'status', expanded)}
            </div>
          )}

          {item.change_type === 'create' && (
            <div className="text-sm text-muted-foreground">
              {t('practice:questionBank.questionCreated')}
            </div>
          )}
        </div>
      </div>
    );
  };

  // 历史时间线主体
  const historyBody = (scrollAreaClassName: string) => {
    if (isLoading) {
      return <HistorySkeleton />;
    }
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <XCircle size={32} className="text-destructive mb-2" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <NotionButton variant="ghost" size="sm" className="mt-4" onClick={handleRetry}>
            {t('common:retry')}
          </NotionButton>
        </div>
      );
    }
    if (history.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <ClockCounterClockwise size={32} className="text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.history.empty')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('exam_sheet:questionBank.history.emptyHint')}
          </p>
        </div>
      );
    }

    return (
      <CustomScrollArea className={scrollAreaClassName}>
        <div className="pr-4 ui-rise-in">
          {filteredHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <ClockCounterClockwise size={28} className="text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">{t('stats:historyView.noFilterResult')}</p>
            </div>
          ) : (
            groupedHistory.map(group => (
              <div key={group.dateKey}>
                {/* 日期分组头（sticky） */}
                <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-background/95 backdrop-blur-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      {formatDayLabel(group.dateKey)}
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {t('stats:historyView.recordCount', { count: group.items.length })}
                    </span>
                    <div className="flex-1 border-t border-border/50" />
                  </div>
                </div>
                <div className="pt-2">
                  {group.items.map((item, i) => renderItem(item, i === group.items.length - 1))}
                </div>
              </div>
            ))
          )}

          {/* 加载更多 */}
          {hasMore && (
            <div className="flex justify-center pb-4">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="text-muted-foreground"
              >
                {isLoadingMore ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <CaretDown size={14} />
                )}
                {t('stats:historyView.loadMore')}
              </NotionButton>
            </div>
          )}
        </div>
      </CustomScrollArea>
    );
  };

  // ==================== 内联子屏（桌面端与移动端统一） ====================
  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background ui-rise-in"
      role="region"
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
          className={cn('text-muted-foreground', inline ? '!h-11 !w-11' : '!h-9 !w-9')}
        >
          <ArrowLeft size={20} />
        </NotionButton>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ClockCounterClockwise size={16} className="flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">
            {t('exam_sheet:questionBank.history.title')}
          </span>
        </div>
        {/* 从历史直接跳回题目 */}
        {questionId && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleJumpToQuestion}
            className={cn('flex-shrink-0 gap-1.5 text-xs text-primary hover:bg-primary/10', inline ? '!h-11 px-3' : '!h-8 px-2.5')}
          >
            <ArrowSquareOut size={14} />
            {t('learningHub:exam.library.viewQuestion')}
          </NotionButton>
        )}
      </div>

      {/* 描述 + 筛选 chip */}
      <div className="flex-shrink-0 border-b border-border/40 px-4 py-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          {t('exam_sheet:questionBank.history.description')}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {filterChip('all', t('stats:historyView.filterAll'), filterCounts.all)}
          {filterChip('answer', t('stats:historyView.filterAnswers'), filterCounts.answer)}
          {filterChip('wrong', t('stats:historyView.filterWrongOnly'), filterCounts.wrong, 'text-destructive')}
        </div>
      </div>

      {/* 时间线内容 */}
      <div
        className="min-h-0 flex-1 overflow-hidden px-4 pt-3"
        style={{
          paddingBottom: 'var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
        }}
      >
        {historyBody('h-full')}
      </div>
    </div>
  );
};

export default QuestionHistoryView;
