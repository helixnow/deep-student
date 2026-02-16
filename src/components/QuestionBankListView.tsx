/**
 * 题目集列表视图
 * 
 * Notion 风格设计：
 * - 极简主义，内容优先
 * - 大量留白，清晰层级
 * - 微妙的 hover 效果
 * - 柔和的颜色系统
 */

import React, { useState, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { Badge } from '@/components/ui/shad/Badge';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  BookOpen,
  Search,
  Check,
  X,
  ChevronRight,
  Grid3X3,
  List,
  Star,
  Play,
  Pencil,
  Trash2,
  RefreshCw,
  CheckSquare,
  Edit3,
  AlertTriangle,
  Image as ImageIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Question, QuestionBankStats, QuestionStatus, Difficulty } from '@/api/questionBankApi';
import { QuestionInlineEditor } from './QuestionInlineEditor';

export interface QuestionListFilters {
  search?: string;
  status?: QuestionStatus | 'all';
  difficulty?: Difficulty | 'all';
  isFavorite?: boolean;
}

export interface QuestionBankListViewProps {
  questions: Question[];
  stats?: QuestionBankStats;
  onQuestionClick?: (index: number) => void;
  /** 后端筛选回调（如果提供，则使用后端筛选而不是本地过滤） */
  onFilterChange?: (filters: QuestionListFilters) => void;
  /** 是否正在加载（后端筛选时使用） */
  isLoading?: boolean;
  /** 批量删除回调 */
  onDelete?: (questionIds: string[]) => Promise<void>;
  /** 批量重置进度回调 */
  onResetProgress?: (questionIds: string[]) => Promise<void>;
  /** 更新题目回调 */
  onUpdateQuestion?: (question: Question) => Promise<void>;
  /** 题目集 ID（用于内联创建新题目） */
  examId?: string;
  /** 创建新题目回调 */
  onCreateQuestion?: (question: Question) => Promise<void>;
  className?: string;
}

const STATUS_CONFIG: Record<QuestionStatus, { labelKey: string; color: string; bg: string }> = {
  new: { labelKey: 'questionBank.statusShort.new', color: 'text-muted-foreground', bg: 'bg-muted-foreground/20' },
  in_progress: { labelKey: 'questionBank.statusShort.inProgress', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-500/10' },
  mastered: { labelKey: 'questionBank.statusShort.mastered', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10' },
  review: { labelKey: 'questionBank.statusShort.review', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10' },
};

const DIFFICULTY_CONFIG: Record<Difficulty, { labelKey: string; color: string }> = {
  easy: { labelKey: 'questionBank.difficultyShort.easy', color: 'text-emerald-600 dark:text-emerald-400' },
  medium: { labelKey: 'questionBank.difficultyShort.medium', color: 'text-amber-600 dark:text-amber-400' },
  hard: { labelKey: 'questionBank.difficultyShort.hard', color: 'text-orange-600 dark:text-orange-400' },
  very_hard: { labelKey: 'questionBank.difficultyShort.veryHard', color: 'text-rose-600 dark:text-rose-400' },
};

/** 桌面端统计摘要（移动端隐藏） */
const StatsSummary: React.FC<{ stats: QuestionBankStats; onStartPractice?: () => void }> = ({ stats, onStartPractice }) => {
  const { t } = useTranslation('practice');
  const progressPercent = stats.total > 0 ? (stats.mastered / stats.total) * 100 : 0;
  
  return (
    <div className="hidden sm:flex items-center justify-between gap-6 px-1">
      <div className="flex items-center gap-6">
        {/* 进度环和掌握数 */}
        <div className="flex items-center gap-2">
          <div className="relative w-10 h-10">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
              <circle
                cx="20" cy="20" r="16"
                fill="none" stroke="currentColor" strokeWidth="3"
                strokeDasharray={`${progressPercent * 1.005} 100.5`}
                className="text-emerald-500"
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[10px] font-semibold tabular-nums">{Math.round(progressPercent)}%</span>
            </div>
          </div>
          <div className="text-sm whitespace-nowrap">
            <span className="text-muted-foreground">{t('questionBank.masteredLabel')} </span>
            <span className="font-medium">{stats.mastered}</span>
            <span className="text-muted-foreground">/ {stats.total}</span>
          </div>
        </div>
        
        {/* 待复习 */}
        {stats.review > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            <span>{t('questionBank.pendingReview', { count: stats.review })}</span>
          </div>
        )}
        
        {/* 正确率 */}
        <div className="text-sm text-muted-foreground">
          {t('questionBank.correctRate')} <span className="font-medium text-foreground tabular-nums">{Math.round(stats.correctRate * 100)}%</span>
        </div>
      </div>
      
      {/* 开始做题按钮 */}
      {onStartPractice && (
        <NotionButton variant="ghost" size="sm" onClick={onStartPractice} className="text-primary hover:bg-primary/10">
          <Play className="w-3.5 h-3.5" />
          {t('questionBank.startPractice')}
        </NotionButton>
      )}
    </div>
  );
};

const QuestionGridCard: React.FC<{
  question: Question;
  index: number;
  onClick: () => void;
  onEdit?: () => void;
  isEditMode?: boolean;
  isSelected?: boolean;
  onSelect?: (selected: boolean) => void;
}> = ({ question, index, onClick, onEdit, isEditMode, isSelected, onSelect }) => {
  const { t } = useTranslation('practice');
  const status = question.status || 'new';
  const hasAttempt = (question.attemptCount ?? 0) > 0;
  const isCorrect = hasAttempt && (question.correctCount ?? 0) > 0;
  
  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.();
  }, [onEdit]);
  
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={isEditMode ? () => onSelect?.(!isSelected) : onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (isEditMode ? () => onSelect?.(!isSelected) : onClick)?.(); } }}
      className={cn(
        'group relative flex flex-col p-4 rounded-lg text-left transition-all duration-200 cursor-pointer',
        'border border-transparent hover:border-border/60 hover:bg-muted/30',
        'hover:shadow-[var(--shadow-notion)]',
        status === 'mastered' && 'bg-emerald-500/[0.03]',
        status === 'review' && 'bg-amber-500/[0.03]',
        isSelected && 'ring-2 ring-primary/50 bg-primary/5'
      )}
    >
      <div className="flex items-center justify-between mb-2">
        {isEditMode ? (
          <div className={cn(
            'w-4 h-4 rounded border flex items-center justify-center transition-colors',
            isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'
          )}>
            {isSelected && <Check className="w-3 h-3" />}
          </div>
        ) : (
          <span className="text-sm font-medium text-muted-foreground">
            {question.questionLabel || `${index + 1}`}
          </span>
        )}
        <div className="flex items-center gap-1.5">
          {question.isFavorite && <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />}
          {hasAttempt && (
            <div className={cn(
              'w-4 h-4 rounded-full flex items-center justify-center',
              isCorrect ? 'bg-emerald-500/20 text-emerald-600' : 'bg-rose-500/20 text-rose-600'
            )}>
              {isCorrect ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
            </div>
          )}
          {/* 编辑按钮 - 非编辑模式下显示 */}
          {!isEditMode && onEdit && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleEditClick} className="!w-5 !h-5 !p-0 opacity-0 group-hover:opacity-100 hover:bg-muted/60 text-muted-foreground hover:text-foreground" title={t('questionBank.editQuestion')} aria-label="edit">
              <Edit3 className="w-3 h-3" />
            </NotionButton>
          )}
        </div>
      </div>
      
      {question.images && question.images.length > 0 && (
        <div className="flex items-center gap-1 mb-1.5 text-xs text-muted-foreground">
          <ImageIcon className="w-3 h-3" />
          <span>{question.images.length}</span>
        </div>
      )}
      <p className="text-sm text-foreground/80 line-clamp-2 flex-1 mb-3 leading-relaxed">
        {question.content || question.ocrText || t('questionBank.noContent')}
      </p>
      
      <div className="flex items-center gap-2 text-xs">
        {question.difficulty && (
          <span className={cn('font-medium', DIFFICULTY_CONFIG[question.difficulty].color)}>
            {t(DIFFICULTY_CONFIG[question.difficulty].labelKey)}
          </span>
        )}
        <span className={cn(STATUS_CONFIG[status].color)}>
          {t(STATUS_CONFIG[status].labelKey)}
        </span>
      </div>
      
      <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-all" />
    </div>
  );
};

const QuestionListRow: React.FC<{
  question: Question;
  index: number;
  onClick: () => void;
  onEdit?: () => void;
  isEditMode?: boolean;
  isSelected?: boolean;
  onSelect?: (selected: boolean) => void;
}> = ({ question, index, onClick, onEdit, isEditMode, isSelected, onSelect }) => {
  const { t } = useTranslation('practice');
  const status = question.status || 'new';
  const hasAttempt = (question.attemptCount ?? 0) > 0;
  const isCorrect = hasAttempt && (question.correctCount ?? 0) > 0;
  
  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.();
  }, [onEdit]);
  
  return (
    <NotionButton
      variant="ghost" size="sm"
      onClick={isEditMode ? () => onSelect?.(!isSelected) : onClick}
      className={cn(
        'group w-full !justify-start gap-4 !px-3 !py-3 !h-auto !rounded-lg',
        'hover:bg-muted/40',
        isSelected && 'bg-primary/5'
      )}
    >
      {isEditMode ? (
        <div className={cn(
          'w-4 h-4 rounded border flex items-center justify-center transition-colors flex-shrink-0',
          isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'
        )}>
          {isSelected && <Check className="w-3 h-3" />}
        </div>
      ) : (
        <span className="text-sm font-medium text-muted-foreground w-8 flex-shrink-0">
          {question.questionLabel || `${index + 1}`}
        </span>
      )}
      
      <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', STATUS_CONFIG[status].bg)} />
      
      {question.images && question.images.length > 0 && (
        <ImageIcon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 text-sm truncate text-foreground/80">
        {question.content || question.ocrText || t('questionBank.noContent')}
      </span>
      
      <div className="flex items-center gap-2 flex-shrink-0">
        {question.isFavorite && <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />}
        {hasAttempt && (
          <div className={cn(
            'w-4 h-4 rounded-full flex items-center justify-center',
            isCorrect ? 'bg-emerald-500/20 text-emerald-600' : 'bg-rose-500/20 text-rose-600'
          )}>
            {isCorrect ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
          </div>
        )}
        {/* 编辑按钮 - 非编辑模式下显示 */}
        {!isEditMode && onEdit && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleEditClick} className="!w-6 !h-6 !p-0 opacity-0 group-hover:opacity-100 hover:bg-muted/60 text-muted-foreground hover:text-foreground" title={t('questionBank.editQuestion')} aria-label="edit">
            <Edit3 className="w-3.5 h-3.5" />
          </NotionButton>
        )}
      </div>
      
      <ChevronRight className="w-4 h-4 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-all flex-shrink-0" />
    </NotionButton>
  );
};

export const QuestionBankListView: React.FC<QuestionBankListViewProps> = ({
  questions,
  stats,
  onQuestionClick,
  onFilterChange,
  isLoading = false,
  onDelete,
  onResetProgress,
  onUpdateQuestion,
  examId,
  onCreateQuestion,
  className,
}) => {
  const { t } = useTranslation(['practice', 'common']);
  const [viewType, setViewType] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<QuestionStatus | 'all'>('all');
  const [showFavoriteOnly, setShowFavoriteOnly] = useState(false);

  // 编辑模式状态（批量操作）
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isOperating, setIsOperating] = useState(false);
  
  // 确认对话框状态
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  
  // 内联编辑状态（同时只有一个题目展开编辑）
  const [expandedEditId, setExpandedEditId] = useState<string | null>(null);
  
  // 支持批量操作
  const hasBatchOperations = !!(onDelete || onResetProgress);
  
  // 是否使用后端筛选模式
  const useBackendFilter = !!onFilterChange;
  
  // 预计算 question ID → 原始索引映射，避免渲染时 O(n²) findIndex
  const questionIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    questions.forEach((q, i) => map.set(q.id, i));
    return map;
  }, [questions]);

  // 本地过滤（仅在不使用后端筛选时）
  const filteredQuestions = useMemo(() => {
    if (useBackendFilter) {
      return questions; // 后端筛选模式下，questions 已经是筛选后的结果
    }
    return questions.filter(q => {
      // 搜索过滤
      if (searchQuery) {
        const content = (q.content || q.ocrText || '').toLowerCase();
        const label = (q.questionLabel || '').toLowerCase();
        if (!content.includes(searchQuery.toLowerCase()) && !label.includes(searchQuery.toLowerCase())) {
          return false;
        }
      }
      // 状态过滤
      if (statusFilter !== 'all' && q.status !== statusFilter) {
        return false;
      }
      // 收藏过滤
      if (showFavoriteOnly && !q.isFavorite) {
        return false;
      }
      return true;
    });
  }, [questions, searchQuery, statusFilter, showFavoriteOnly, useBackendFilter]);

  // 筛选变更时通知父组件（后端筛选模式）
  const handleFilterChange = useCallback((
    newSearch: string,
    newStatus: QuestionStatus | 'all',
    newFavorite?: boolean,
  ) => {
    setSearchQuery(newSearch);
    setStatusFilter(newStatus);
    if (newFavorite !== undefined) setShowFavoriteOnly(newFavorite);
    if (onFilterChange) {
      onFilterChange({
        search: newSearch || undefined,
        status: newStatus,
        isFavorite: newFavorite || undefined,
      });
    }
  }, [onFilterChange]);
  
  const handleQuestionClick = useCallback((index: number) => {
    // 找到原始索引（使用预计算 Map，O(1) 查找）
    const originalIndex = questionIndexMap.get(filteredQuestions[index].id) ?? index;
    onQuestionClick?.(originalIndex);
  }, [questionIndexMap, filteredQuestions, onQuestionClick]);
  
  // 切换选中状态
  const toggleSelect = useCallback((id: string, selected: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);
  
  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredQuestions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredQuestions.map(q => q.id)));
    }
  }, [filteredQuestions, selectedIds.size]);
  
  // 批量删除（带确认）
  const handleBatchDeleteClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteConfirmOpen(true);
  }, [selectedIds.size]);
  
  const handleBatchDeleteConfirm = useCallback(async () => {
    if (!onDelete || selectedIds.size === 0) return;
    setDeleteConfirmOpen(false);
    setIsOperating(true);
    try {
      await onDelete(Array.from(selectedIds));
      showGlobalNotification('success', t('practice:questionBank.deleteSuccess', { count: selectedIds.size }));
      setSelectedIds(new Set());
      setIsEditMode(false);
    } catch (err: unknown) {
      console.error('[QuestionBankListView] handleBatchDelete failed:', err);
      showGlobalNotification('error', `${t('practice:questionBank.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsOperating(false);
    }
  }, [onDelete, selectedIds]);
  
  // 批量重置进度（带确认）
  const handleBatchResetClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setResetConfirmOpen(true);
  }, [selectedIds.size]);
  
  const handleBatchResetConfirm = useCallback(async () => {
    if (!onResetProgress || selectedIds.size === 0) return;
    setResetConfirmOpen(false);
    setIsOperating(true);
    try {
      await onResetProgress(Array.from(selectedIds));
      showGlobalNotification('success', t('practice:questionBank.resetSuccess', { count: selectedIds.size }));
      setSelectedIds(new Set());
    } catch (err: unknown) {
      console.error('[QuestionBankListView] handleBatchReset failed:', err);
      showGlobalNotification('error', `${t('practice:questionBank.resetFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsOperating(false);
    }
  }, [onResetProgress, selectedIds]);
  
  // 退出编辑模式
  const exitEditMode = useCallback(() => {
    setIsEditMode(false);
    setSelectedIds(new Set());
  }, []);
  
  // 展开内联编辑
  const handleEditQuestion = useCallback((question: Question) => {
    setExpandedEditId(prev => prev === question.id ? null : question.id);
  }, []);
  
  // 保存编辑（QuestionInlineEditor 内部已通过 onCancel 收起，此处仅负责回调）
  const handleSaveQuestion = useCallback(async (updatedQuestion: Question) => {
    if (onUpdateQuestion) {
      await onUpdateQuestion(updatedQuestion);
    }
  }, [onUpdateQuestion]);
  
  // 空状态
  if (questions.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-16', className)}>
        <div className="p-5 rounded-2xl bg-muted/30 mb-5">
          <BookOpen className="w-12 h-12 text-muted-foreground/60" />
        </div>
        <h3 className="text-lg font-medium mb-1.5">{t('practice:questionBank.emptyTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('practice:questionBank.emptyDesc')}</p>
      </div>
    );
  }
  
  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 桌面端：统计摘要（移动端隐藏） */}
      {stats && (
        <div className="flex-shrink-0 px-4 py-4 border-b border-border/40 hidden sm:block">
          <StatsSummary stats={stats} onStartPractice={() => onQuestionClick?.(0)} />
        </div>
      )}
      
      {/* 搜索和视图切换 */}
      <div className="flex-shrink-0 px-3 sm:px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
            <Input
              value={searchQuery}
              onChange={(e) => handleFilterChange(e.target.value, statusFilter)}
              placeholder={t('practice:questionBank.searchPlaceholder')}
              className="pl-9 h-8 sm:h-9 bg-muted/30 border-transparent focus:border-border focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors text-sm"
            />
          </div>
          
          <div className="flex items-center p-0.5 rounded-md bg-muted/30 flex-shrink-0">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setViewType('grid')}
              className={cn('h-7 w-7 p-0', viewType === 'grid' && 'bg-background shadow-sm')}
            >
              <Grid3X3 className="w-3.5 h-3.5" />
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setViewType('list')}
              className={cn('h-7 w-7 p-0', viewType === 'list' && 'bg-background shadow-sm')}
            >
              <List className="w-3.5 h-3.5" />
            </NotionButton>
          </div>
          
          {/* 收藏和书签按钮 */}
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleFilterChange(searchQuery, statusFilter, !showFavoriteOnly)} className={cn('!h-7 !w-7 !p-1.5 flex-shrink-0', showFavoriteOnly ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50')} aria-label="favorites">
            <Star className={cn('w-4 h-4', showFavoriteOnly && 'fill-current')} />
          </NotionButton>

          {/* 编辑模式按钮 */}
          {hasBatchOperations && !isEditMode && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setIsEditMode(true)} className="!h-7 !w-7 !p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50 flex-shrink-0" aria-label="edit mode">
              <Pencil className="w-4 h-4" />
            </NotionButton>
          )}
        </div>
        
        {/* 编辑模式操作栏 */}
        {isEditMode && (
          <div className="flex items-center justify-between gap-2 mt-3 px-1 py-2 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 min-w-0">
              <NotionButton variant="ghost" size="sm" onClick={toggleSelectAll} className="!h-auto !px-2 !py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50">
                <CheckSquare className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{selectedIds.size === filteredQuestions.length ? t('practice:questionBank.deselectAll') : t('practice:questionBank.selectAll')}</span>
              </NotionButton>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {t('practice:questionBank.selectedCount', { count: selectedIds.size })}
              </span>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {onResetProgress && (
                <NotionButton variant="ghost" size="sm" onClick={handleBatchResetClick} disabled={isOperating || selectedIds.size === 0} className="!h-auto !px-2 !py-1 text-xs text-sky-600 hover:bg-sky-500/10">
                  <RefreshCw className={cn('w-3 h-3', isOperating && 'animate-spin')} />
                  <span className="hidden sm:inline">{t('practice:questionBank.reset')}</span>
                </NotionButton>
              )}
              {onDelete && (
                <NotionButton variant="ghost" size="sm" onClick={handleBatchDeleteClick} disabled={isOperating || selectedIds.size === 0} className="!h-auto !px-2 !py-1 text-xs text-rose-600 hover:bg-rose-500/10">
                  <Trash2 className="w-3 h-3" />
                  <span className="hidden sm:inline">{t('common:delete')}</span>
                </NotionButton>
              )}
              <NotionButton variant="ghost" size="sm" onClick={exitEditMode} className="!h-auto !px-2 !py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50">
                {t('practice:questionBank.done')}
              </NotionButton>
            </div>
          </div>
        )}
        
        {/* 筛选 Tab */}
        <div className="flex items-center gap-1.5 mt-3">
          <NotionButton variant="ghost" size="sm" onClick={() => handleFilterChange(searchQuery, 'all', false)} className={cn('!h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'all' && !showFavoriteOnly ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50')}>
            {t('practice:questionBank.all')} {questions.length}
          </NotionButton>
          {stats && stats.newCount > 0 && (
            <NotionButton variant="ghost" size="sm" onClick={() => handleFilterChange(searchQuery, 'new')} className={cn('!h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'new' ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50')}>
              {t('practice:questionBank.newQuestions')} {stats.newCount}
            </NotionButton>
          )}
          {stats && stats.review > 0 && (
            <NotionButton variant="ghost" size="sm" onClick={() => handleFilterChange(searchQuery, 'review')} className={cn('!h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'review' ? 'bg-amber-500 text-white font-medium' : 'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10')}>
              {t('practice:questionBank.needsReview')} {stats.review}
            </NotionButton>
          )}
          {stats && stats.mastered > 0 && (
            <NotionButton variant="ghost" size="sm" onClick={() => handleFilterChange(searchQuery, 'mastered')} className={cn('!h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'mastered' ? 'bg-emerald-500 text-white font-medium' : 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10')}>
              {t('practice:questionBank.masteredFilter')} {stats.mastered}
            </NotionButton>
          )}
        </div>
      </div>
      
      <CustomScrollArea className="flex-1" viewportClassName="px-3 sm:px-4 pt-1 pb-4">
        {filteredQuestions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Search className="w-8 h-8 mb-3 opacity-40" />
            <p className="text-sm">{t('practice:questionBank.noMatch')}</p>
          </div>
        ) : viewType === 'grid' ? (
          <div className="grid grid-cols-2 gap-2">
            {filteredQuestions.map((q, idx) => (
              <React.Fragment key={q.id}>
                <QuestionGridCard
                  question={q}
                  index={questionIndexMap.get(q.id) ?? 0}
                  onClick={() => handleQuestionClick(idx)}
                  onEdit={onUpdateQuestion ? () => handleEditQuestion(q) : undefined}
                  isEditMode={isEditMode}
                  isSelected={selectedIds.has(q.id)}
                  onSelect={(selected) => toggleSelect(q.id, selected)}
                />
                {expandedEditId === q.id && (
                  <div className="col-span-2">
                    <QuestionInlineEditor
                      question={q}
                      onSave={handleSaveQuestion}
                      onCancel={() => setExpandedEditId(null)}
                    />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredQuestions.map((q, idx) => (
              <React.Fragment key={q.id}>
                <QuestionListRow
                  question={q}
                  index={questionIndexMap.get(q.id) ?? 0}
                  onClick={() => handleQuestionClick(idx)}
                  onEdit={onUpdateQuestion ? () => handleEditQuestion(q) : undefined}
                  isEditMode={isEditMode}
                  isSelected={selectedIds.has(q.id)}
                  onSelect={(selected) => toggleSelect(q.id, selected)}
                />
                {expandedEditId === q.id && (
                  <QuestionInlineEditor
                    question={q}
                    onSave={handleSaveQuestion}
                    onCancel={() => setExpandedEditId(null)}
                  />
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </CustomScrollArea>
      
      {/* 新题目内联创建区域 */}
      {expandedEditId === '__new__' && examId && (
        <div className="px-3 sm:px-4 pb-4">
          <QuestionInlineEditor
            question={null}
            mode="create"
            examId={examId}
            onCreate={async (q) => {
              await onCreateQuestion?.(q);
              setExpandedEditId(null);
            }}
            onCancel={() => setExpandedEditId(null)}
          />
        </div>
      )}
      
      {/* 删除确认对话框 */}
      <NotionAlertDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        icon={<AlertTriangle className="w-5 h-5 text-rose-500" />}
        title={t('practice:questionBank.confirmDeleteTitle')}
        description={t('practice:questionBank.confirmDeleteDesc', { count: selectedIds.size })}
        confirmText={t('common:delete')}
        cancelText={t('common:cancel')}
        confirmVariant="danger"
        onConfirm={handleBatchDeleteConfirm}
      />
      
      {/* 重置进度确认对话框 */}
      <NotionAlertDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        icon={<AlertTriangle className="w-5 h-5 text-amber-500" />}
        title={t('practice:questionBank.confirmResetTitle')}
        description={t('practice:questionBank.confirmResetDesc', { count: selectedIds.size })}
        confirmText={t('practice:questionBank.resetProgress')}
        cancelText={t('common:cancel')}
        confirmVariant="warning"
        onConfirm={handleBatchResetConfirm}
      />
    </div>
  );
};

export default QuestionBankListView;

