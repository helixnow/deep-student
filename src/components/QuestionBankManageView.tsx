/**
 * 智能题目集管理视图
 * 
 * P1-2 功能：表格展示 + 筛选 + 批量操作
 * 
 * 🆕 2026-01 新增
 */

import React, { useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/shad/Table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/shad/AlertDialog';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  Search,
  Filter,
  MoreHorizontal,
  Trash2,
  Star,
  StarOff,
  RotateCcw,
  CheckCircle,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Download,
  Upload,
  FileSpreadsheet,
  AlertTriangle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Question, QuestionStatus, Difficulty, QuestionType } from '@/api/questionBankApi';

interface QuestionBankManageViewProps {
  questions: Question[];
  isLoading?: boolean;
  onSelect?: (questionIds: string[]) => void;
  onDelete?: (questionIds: string[]) => Promise<void>;
  onToggleFavorite?: (questionId: string) => Promise<void>;
  onResetProgress?: (questionIds: string[]) => Promise<void>;
  onViewDetail?: (question: Question) => void;
  onFilterChange?: (filters: QuestionFilters) => void;
  /** CSV 导入按钮点击回调 */
  onCsvImport?: () => void;
  /** CSV 导出按钮点击回调 */
  onCsvExport?: () => void;
  /** 是否显示 CSV 操作按钮 */
  showCsvActions?: boolean;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
  };
}

interface QuestionFilters {
  search?: string;
  status?: QuestionStatus[];
  difficulty?: Difficulty[];
  questionType?: QuestionType[];
  isFavorite?: boolean;
}

const statusColors: Record<QuestionStatus, string> = {
  new: 'text-muted-foreground',
  in_progress: 'text-sky-600 dark:text-sky-400',
  mastered: 'text-emerald-600 dark:text-emerald-400',
  review: 'text-amber-600 dark:text-amber-400',
};

const statusLabelKeys: Record<QuestionStatus, string> = {
  new: 'practice:questionBank.status.new',
  in_progress: 'practice:questionBank.status.inProgress',
  mastered: 'practice:questionBank.status.mastered',
  review: 'practice:questionBank.status.review',
};

const difficultyColors: Record<Difficulty, string> = {
  easy: 'text-emerald-600 dark:text-emerald-400',
  medium: 'text-amber-600 dark:text-amber-400',
  hard: 'text-orange-600 dark:text-orange-400',
  very_hard: 'text-rose-600 dark:text-rose-400',
};

const difficultyLabelKeys: Record<Difficulty, string> = {
  easy: 'practice:questionBank.difficulty.easy',
  medium: 'practice:questionBank.difficulty.medium',
  hard: 'practice:questionBank.difficulty.hard',
  very_hard: 'practice:questionBank.difficulty.veryHard',
};

export const QuestionBankManageView: React.FC<QuestionBankManageViewProps> = ({
  questions,
  isLoading = false,
  onSelect,
  onDelete,
  onToggleFavorite,
  onResetProgress,
  onViewDetail,
  onFilterChange,
  onCsvImport,
  onCsvExport,
  showCsvActions = true,
  pagination,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'practice']);
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<QuestionFilters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  
  // 确认对话框状态
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [singleDeleteId, setSingleDeleteId] = useState<string | null>(null);
  const [singleResetId, setSingleResetId] = useState<string | null>(null);

  const allSelected = questions.length > 0 && selectedIds.size === questions.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < questions.length;

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(questions.map(q => q.id)));
    }
  }, [questions, allSelected]);

  const handleSelectOne = useCallback((id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const handleFilterChange = useCallback((key: keyof QuestionFilters, value: unknown) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    onFilterChange?.(newFilters);
  }, [filters, onFilterChange]);

  // 批量操作点击（显示确认对话框）
  const handleBatchActionClick = useCallback((action: 'delete' | 'reset') => {
    if (selectedIds.size === 0) return;
    
    if (action === 'delete') {
      setSingleDeleteId(null);
      setDeleteConfirmOpen(true);
    } else if (action === 'reset') {
      setSingleResetId(null);
      setResetConfirmOpen(true);
    }
  }, [selectedIds.size]);
  
  // 单个操作点击（显示确认对话框）
  const handleSingleDeleteClick = useCallback((id: string) => {
    setSingleDeleteId(id);
    setDeleteConfirmOpen(true);
  }, []);
  
  const handleSingleResetClick = useCallback((id: string) => {
    setSingleResetId(id);
    setResetConfirmOpen(true);
  }, []);
  
  // 确认删除
  const handleDeleteConfirm = useCallback(async () => {
    if (!onDelete) return;  // 确保回调存在
    const ids = singleDeleteId ? [singleDeleteId] : Array.from(selectedIds);
    if (ids.length === 0) return;
    
    setDeleteConfirmOpen(false);
    setActionLoading('delete');
    try {
      await onDelete(ids);
      showGlobalNotification('success', t('practice:questionBank.deleteSuccess', { count: ids.length }));
      if (!singleDeleteId) {
        setSelectedIds(new Set());
      }
    } catch (err: unknown) {
      console.error('[QuestionBankManageView] handleDelete failed:', err);
      showGlobalNotification('error', `${t('practice:questionBank.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
      setSingleDeleteId(null);
    }
  }, [singleDeleteId, selectedIds, onDelete]);
  
  // 确认重置进度
  const handleResetConfirm = useCallback(async () => {
    if (!onResetProgress) return;  // 确保回调存在
    const ids = singleResetId ? [singleResetId] : Array.from(selectedIds);
    if (ids.length === 0) return;
    
    setResetConfirmOpen(false);
    setActionLoading('reset');
    try {
      await onResetProgress(ids);
      showGlobalNotification('success', t('practice:questionBank.resetSuccess', { count: ids.length }));
      if (!singleResetId) {
        setSelectedIds(new Set());
      }
    } catch (err: unknown) {
      console.error('[QuestionBankManageView] handleReset failed:', err);
      showGlobalNotification('error', `${t('practice:questionBank.resetFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
      setSingleResetId(null);
    }
  }, [singleResetId, selectedIds, onResetProgress]);

  const totalPages = pagination ? Math.ceil(pagination.total / pagination.pageSize) : 1;

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 - Notion 风格 */}
      <div className="flex-shrink-0 px-4 py-2 space-y-2">
        {/* 搜索和筛选 */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
            <Input
              placeholder={t('exam_sheet:questionBank.search', '搜索题目...')}
              value={filters.search || ''}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              className="pl-9 h-8 text-sm bg-muted/30 border-transparent focus:border-border focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors"
            />
          </div>
          
          {/* CSV 导入导出按钮 */}
          {showCsvActions && (
            <div className="flex items-center gap-1">
              {onCsvImport && (
                <button
                  onClick={onCsvImport}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
                  title={t('exam_sheet:csv.import_title', 'CSV 导入')}
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('exam_sheet:csv.import_title', 'CSV 导入')}</span>
                </button>
              )}
              {onCsvExport && (
                <button
                  onClick={onCsvExport}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
                  title={t('exam_sheet:questionBank.export.title', '导出')}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('exam_sheet:questionBank.export.title', '导出')}</span>
                </button>
              )}
            </div>
          )}
          
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1.5 text-xs rounded transition-colors',
              showFilters 
                ? 'bg-foreground text-background' 
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            <Filter className="w-3.5 h-3.5" />
            {t('common:filter', '筛选')}
          </button>
        </div>

        {/* 筛选器 - Notion 风格按钮组 */}
        {showFilters && (
          <div className="flex flex-wrap gap-1.5">
            {/* 状态筛选 */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-muted/30">
              {(['all', 'new', 'in_progress', 'mastered', 'review'] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => handleFilterChange('status', status === 'all' ? undefined : [status as QuestionStatus])}
                  className={cn(
                    'px-2 py-1 text-xs rounded transition-colors',
                    (status === 'all' && !filters.status) || filters.status?.[0] === status
                      ? 'bg-background shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {status === 'all' ? t('practice:questionBank.all') : t(statusLabelKeys[status])}
                </button>
              ))}
            </div>
            
            {/* 难度筛选 */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-muted/30">
              {(['all', 'easy', 'medium', 'hard', 'very_hard'] as const).map((diff) => (
                <button
                  key={diff}
                  onClick={() => handleFilterChange('difficulty', diff === 'all' ? undefined : [diff as Difficulty])}
                  className={cn(
                    'px-2 py-1 text-xs rounded transition-colors',
                    (diff === 'all' && !filters.difficulty) || filters.difficulty?.[0] === diff
                      ? 'bg-background shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {diff === 'all' ? t('practice:questionBank.all') : t(difficultyLabelKeys[diff])}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 批量操作 - 简化 */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('practice:questionBank.selectedCount', { count: selectedIds.size })}
            </span>
            <button
              onClick={() => handleBatchActionClick('reset')}
              disabled={actionLoading === 'reset'}
              className="flex items-center gap-1 px-2 py-1 text-xs text-sky-600 hover:bg-sky-500/10 rounded transition-colors disabled:opacity-50"
            >
              <RotateCcw className={cn('w-3 h-3', actionLoading === 'reset' && 'animate-spin')} />
              {t('practice:questionBank.reset')}
            </button>
            <button
              onClick={() => handleBatchActionClick('delete')}
              disabled={actionLoading === 'delete'}
              className="flex items-center gap-1 px-2 py-1 text-xs text-rose-600 hover:bg-rose-500/10 rounded transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              {t('common:delete')}
            </button>
          </div>
        )}
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : questions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p>{t('exam_sheet:questionBank.empty', '暂无题目')}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected || (someSelected ? 'indeterminate' : false)}
                    onCheckedChange={handleSelectAll}
                  />
                </TableHead>
                <TableHead className="w-16">{t('exam_sheet:questionBank.label', '题号')}</TableHead>
                <TableHead>{t('exam_sheet:questionBank.content', '题目')}</TableHead>
                <TableHead className="w-20">{t('practice:questionBank.statusHeader')}</TableHead>
                <TableHead className="w-20">{t('practice:questionBank.difficultyHeader')}</TableHead>
                <TableHead className="w-20">{t('exam_sheet:questionBank.attempts', '答题')}</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {questions.map((q) => (
                <TableRow
                  key={q.id}
                  className={cn(
                    'cursor-pointer hover:bg-muted/50',
                    selectedIds.has(q.id) && 'bg-muted/30'
                  )}
                  onClick={() => onViewDetail?.(q)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(q.id)}
                      onCheckedChange={(checked) => handleSelectOne(q.id, !!checked)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {q.questionLabel || q.cardId}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="line-clamp-2 text-sm">
                        {q.content.slice(0, 100)}
                        {q.content.length > 100 && '...'}
                      </span>
                      {q.isCorrect === true && (
                        <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                      )}
                      {q.isCorrect === false && (
                        <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={cn('text-xs font-medium', statusColors[q.status])}>
                      {t(statusLabelKeys[q.status])}
                    </span>
                  </TableCell>
                  <TableCell>
                    {q.difficulty && (
                      <span className={cn('text-xs font-medium', difficultyColors[q.difficulty])}>
                        {t(difficultyLabelKeys[q.difficulty])}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {q.correctCount}/{q.attemptCount}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <AppMenu>
                      <AppMenuTrigger asChild>
                        <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8">
                          <MoreHorizontal className="w-4 h-4" />
                        </NotionButton>
                      </AppMenuTrigger>
                      <AppMenuContent align="end" width={160}>
                        <AppMenuItem
                          onClick={() => onToggleFavorite?.(q.id)}
                          icon={q.isFavorite ? <StarOff className="w-4 h-4" /> : <Star className="w-4 h-4" />}
                        >
                          {q.isFavorite
                            ? t('exam_sheet:questionBank.unfavorite', '取消收藏')
                            : t('exam_sheet:questionBank.favorite', '收藏')}
                        </AppMenuItem>
                        <AppMenuSeparator />
                        <AppMenuItem
                          onClick={() => handleSingleResetClick(q.id)}
                          icon={<RotateCcw className="w-4 h-4" />}
                        >
                          {t('exam_sheet:questionBank.resetProgress', '重置进度')}
                        </AppMenuItem>
                        <AppMenuItem
                          onClick={() => handleSingleDeleteClick(q.id)}
                          destructive
                          icon={<Trash2 className="w-4 h-4" />}
                        >
                          {t('common:delete', '删除')}
                        </AppMenuItem>
                      </AppMenuContent>
                    </AppMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 分页 */}
      {pagination && totalPages > 1 && (
        <div className="flex-shrink-0 flex items-center justify-between p-3 border-t border-border/50">
          <span className="text-sm text-muted-foreground">
            {t('common:pagination.info', '共 {{total}} 条', { total: pagination.total })}
          </span>
          <div className="flex items-center gap-1">
            <NotionButton
              variant="outline"
              iconOnly size="sm"
              className="h-8 w-8"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
            >
              <ChevronLeft className="w-4 h-4" />
            </NotionButton>
            <span className="text-sm px-2">
              {pagination.page} / {totalPages}
            </span>
            <NotionButton
              variant="outline"
              iconOnly size="sm"
              className="h-8 w-8"
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
            >
              <ChevronRight className="w-4 h-4" />
            </NotionButton>
          </div>
        </div>
      )}
      
      {/* 删除确认对话框 */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={(open) => {
        setDeleteConfirmOpen(open);
        if (!open) setSingleDeleteId(null);  // 关闭时清理单个删除状态
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-rose-500" />
              {t('exam_sheet:questionBank.confirmDelete', '确认删除')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {singleDeleteId 
                ? t('exam_sheet:questionBank.confirmDeleteSingle', '确定要删除这道题目吗？此操作无法撤销。')
                : t('exam_sheet:questionBank.confirmDeleteBatch', '确定要删除选中的 {{count}} 道题目吗？此操作无法撤销。', { count: selectedIds.size })
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:cancel', '取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              {t('common:delete', '删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      
      {/* 重置进度确认对话框 */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={(open) => {
        setResetConfirmOpen(open);
        if (!open) setSingleResetId(null);  // 关闭时清理单个重置状态
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              {t('exam_sheet:questionBank.confirmReset', '确认重置进度')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {singleResetId
                ? t('exam_sheet:questionBank.confirmResetSingle', '确定要重置这道题目的学习进度吗？这将清除所有答题记录、正确率统计，题目将恢复为"新题"状态。')
                : t('exam_sheet:questionBank.confirmResetBatch', '确定要重置选中的 {{count}} 道题目的学习进度吗？这将清除所有答题记录、正确率统计，题目将恢复为"新题"状态。', { count: selectedIds.size })
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:cancel', '取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleResetConfirm}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {t('exam_sheet:questionBank.resetProgress', '重置进度')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default QuestionBankManageView;
