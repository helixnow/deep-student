/**
 * 智能题目集管理视图
 * 
 * P1-2 功能：表格展示 + 筛选 + 批量操作
 * 
 * 🆕 2026-01 新增
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { DsButton } from '@/components/ui/DsButton';
import { UiPresence } from '@/components/ui/UiPresence';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { CustomScrollArea } from './custom-scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/shad/Table';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  MagnifyingGlass,
  Funnel,
  DotsThree,
  Trash,
  Star,
  ArrowCounterClockwise,
  CheckCircle,
  XCircle,
  X,
  CaretLeft,
  CaretRight,
  CircleNotch,
  Download,
  Upload,
  Gauge,
  Tag,
  Warning,
  ClockCounterClockwise,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { Question, QuestionStatus, Difficulty, QuestionType } from '@/api/questionBankApi';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { getQuestionTypeMeta, QUESTION_TYPE_ORDER } from './questionTypeMeta';

interface QuestionBankManageViewProps {
  questions: Question[];
  isLoading?: boolean;
  /** Controlled by the OS resource view when an agent applies a filter. */
  filters?: QuestionFilters;
  onSelect?: (questionIds: string[]) => void;
  onDelete?: (questionIds: string[]) => Promise<void>;
  onToggleFavorite?: (questionId: string) => Promise<void>;
  onResetProgress?: (questionIds: string[]) => Promise<void>;
  /** 批量修改难度（可选，向后兼容新增；未提供时不展示入口） */
  onBatchUpdateDifficulty?: (questionIds: string[], difficulty: Difficulty) => Promise<void>;
  /** 批量增删标签（可选，向后兼容新增；未提供时不展示入口） */
  onBatchUpdateTags?: (questionIds: string[], op: { add?: string[]; remove?: string[] }) => Promise<void>;
  onViewDetail?: (question: Question) => void;
  onViewHistory?: (questionId: string) => void;
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
  tags?: string[];
  isFavorite?: boolean;
}

const statusColors: Record<QuestionStatus, string> = {
  new: 'text-muted-foreground',
  in_progress: 'text-primary',
  mastered: 'text-success',
  review: 'text-warning',
};

const statusLabelKeys: Record<QuestionStatus, string> = {
  new: 'practice:questionBank.status.new',
  in_progress: 'practice:questionBank.status.inProgress',
  mastered: 'practice:questionBank.status.mastered',
  review: 'practice:questionBank.status.review',
};

const difficultyColors: Record<Difficulty, string> = {
  easy: 'text-success',
  medium: 'text-warning',
  hard: 'text-warning',
  very_hard: 'text-destructive',
};

const difficultyLabelKeys: Record<Difficulty, string> = {
  easy: 'practice:questionBank.difficulty.easy',
  medium: 'practice:questionBank.difficulty.medium',
  hard: 'practice:questionBank.difficulty.hard',
  very_hard: 'practice:questionBank.difficulty.veryHard',
};

/** 列表进入 stagger：延迟随索引递增，封顶避免长列表尾部等待过久 */
const staggerStyle = (index: number): React.CSSProperties => ({
  animationDelay: `${Math.min(index, 16) * 20}ms`,
});

export const QuestionBankManageView: React.FC<QuestionBankManageViewProps> = ({
  questions,
  isLoading = false,
  filters: controlledFilters,
  onSelect,
  onDelete,
  onToggleFavorite,
  onResetProgress,
  onBatchUpdateDifficulty,
  onBatchUpdateTags,
  onViewDetail,
  onViewHistory,
  onFilterChange,
  onCsvImport,
  onCsvExport,
  showCsvActions = true,
  pagination,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'practice', 'learningHub']);
  // <768：表格换卡片列表（hidden md: 列在窄屏信息残缺），确认改行内条
  const { isSmallScreen } = useBreakpoint();
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<QuestionFilters>(controlledFilters ?? {});
  const [showFilters, setShowFilters] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // 移动端卡片操作区行内展开的题目 id（一次只展开一张卡）
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null);
  
  // 内联二次确认状态（吸底确认条，桌面/移动端统一，不用模态框）
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [singleDeleteId, setSingleDeleteId] = useState<string | null>(null);
  const [singleResetId, setSingleResetId] = useState<string | null>(null);
  // 批量删除倒计时：确认按钮短暂禁用，防止连点误删（危险操作二段式的第二重保护）
  const [deleteCountdown, setDeleteCountdown] = useState(0);
  // 批量改难度 / 改标签 的内联面板（吸底展开，不用弹窗）
  const [batchPanel, setBatchPanel] = useState<'difficulty' | 'tags' | null>(null);
  const [batchTagInput, setBatchTagInput] = useState('');

  // 搜索防抖：输入即时回显，静默 250ms 后才通知父级发起请求
  const searchTimerRef = useRef<number | null>(null);
  // shift 范围选择锚点（当前页 questions 内的索引）
  const lastSelectedIndexRef = useRef<number | null>(null);
  // Checkbox 的 onCheckedChange 拿不到修饰键，经外层 onClickCapture 捕获
  const shiftKeyRef = useRef(false);

  const allSelected = questions.length > 0 && selectedIds.size === questions.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < questions.length;
  const canDelete = Boolean(onDelete);
  const canReset = Boolean(onResetProgress);
  const canToggleFavorite = Boolean(onToggleFavorite);

  useEffect(() => {
    if (controlledFilters) setFilters(controlledFilters);
  }, [controlledFilters]);

  useEffect(() => () => {
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current);
    }
  }, []);

  // ★ 修复：原实现把 onSelect 副作用放在 setState updater 内部，
  // React 严格模式下 updater 可能执行两次导致重复通知；改为在 effect 中先算再提交
  useEffect(() => {
    // 数据集变化后旧的范围选择锚点已失效
    lastSelectedIndexRef.current = null;
    if (selectedIds.size === 0) return;
    const visibleIds = new Set(questions.map((q) => q.id));
    const next = new Set(Array.from(selectedIds).filter((id) => visibleIds.has(id)));
    if (next.size === selectedIds.size) return;
    setSelectedIds(next);
    onSelect?.(Array.from(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在题目集变化时清理选中
  }, [questions]);

  // ★ 修复：分页边界 —— 删除/筛选导致当前页码超出总页数时自动回退
  useEffect(() => {
    if (!pagination) return;
    const pages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
    if (pagination.page > pages) {
      pagination.onPageChange(pages);
    }
  }, [pagination]);

  const handleSelectAll = useCallback(() => {
    const nextSelected = allSelected ? new Set<string>() : new Set(questions.map(q => q.id));
    setSelectedIds(nextSelected);
    onSelect?.(Array.from(nextSelected));
    lastSelectedIndexRef.current = null;
  }, [questions, allSelected, onSelect]);

  // 单选/shift 范围选择；index 为当前页内索引
  const handleSelectOne = useCallback((id: string, checked: boolean, index: number) => {
    const anchor = lastSelectedIndexRef.current;
    const useRange = shiftKeyRef.current && anchor != null && anchor !== index;
    shiftKeyRef.current = false;
    const next = new Set(selectedIds);
    if (useRange && anchor != null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = from; i <= to; i++) {
        const q = questions[i];
        if (!q) continue;
        if (checked) {
          next.add(q.id);
        } else {
          next.delete(q.id);
        }
      }
    } else if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setSelectedIds(next);
    onSelect?.(Array.from(next));
    lastSelectedIndexRef.current = index;
  }, [questions, selectedIds, onSelect]);

  // 反选（作用于当前页）
  const handleInvertSelection = useCallback(() => {
    const next = new Set<string>();
    questions.forEach(q => {
      if (!selectedIds.has(q.id)) next.add(q.id);
    });
    setSelectedIds(next);
    onSelect?.(Array.from(next));
    lastSelectedIndexRef.current = null;
  }, [questions, selectedIds, onSelect]);

  const emitFilterChange = useCallback((newFilters: QuestionFilters) => {
    onFilterChange?.(newFilters);
    // 筛选变化后回到第一页，避免停留在超出新结果集的页码
    if (pagination && pagination.page > 1) {
      pagination.onPageChange(1);
    }
  }, [onFilterChange, pagination]);

  const handleFilterChange = useCallback((key: keyof QuestionFilters, value: unknown) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    if (key === 'search') {
      if (searchTimerRef.current != null) {
        window.clearTimeout(searchTimerRef.current);
      }
      searchTimerRef.current = window.setTimeout(() => {
        searchTimerRef.current = null;
        emitFilterChange(newFilters);
      }, 250);
      return;
    }
    emitFilterChange(newFilters);
  }, [filters, emitFilterChange]);

  // 清空搜索：立即生效，不等防抖
  const handleSearchClear = useCallback(() => {
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    const newFilters = { ...filters, search: undefined };
    setFilters(newFilters);
    emitFilterChange(newFilters);
  }, [filters, emitFilterChange]);

  const handleToggleFavoriteAction = useCallback(async (questionId: string) => {
    if (!onToggleFavorite) {
      showGlobalNotification('warning', t('exam_sheet:questionBank.actionUnavailable'));
      return;
    }
    setActionLoading(`favorite:${questionId}`);
    try {
      await onToggleFavorite(questionId);
      showGlobalNotification('success', t('exam_sheet:questionBank.favoriteUpdated'));
    } catch (err: unknown) {
      showGlobalNotification(
        'error',
        `${t('exam_sheet:questionBank.favoriteUpdateFailed')}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setActionLoading(null);
    }
  }, [onToggleFavorite, t]);

  // 批量操作点击（切换到吸底内联确认条）
  const handleBatchActionClick = useCallback((action: 'delete' | 'reset') => {
    if (selectedIds.size === 0) return;
    
    setBatchPanel(null);
    if (action === 'delete') {
      setSingleDeleteId(null);
      setDeleteConfirmOpen(true);
    } else if (action === 'reset') {
      setSingleResetId(null);
      setResetConfirmOpen(true);
    }
  }, [selectedIds.size]);

  // 批量删除确认倒计时：打开批量（非单条）删除确认时 2 秒内禁用确认按钮
  useEffect(() => {
    if (!deleteConfirmOpen || singleDeleteId) {
      setDeleteCountdown(0);
      return;
    }
    setDeleteCountdown(2);
    const timer = window.setInterval(() => {
      setDeleteCountdown((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deleteConfirmOpen, singleDeleteId]);

  // 选中集清空后内联批量面板自动关闭（防止面板针对空选择执行）
  useEffect(() => {
    if (selectedIds.size === 0) {
      setBatchPanel(null);
    }
  }, [selectedIds.size]);

  // 批量修改难度（内联面板选择难度后执行）
  const handleBatchDifficulty = useCallback(async (difficulty: Difficulty) => {
    if (!onBatchUpdateDifficulty || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setBatchPanel(null);
    setActionLoading('difficulty');
    try {
      await onBatchUpdateDifficulty(ids, difficulty);
      showGlobalNotification('success', t('learningHub:exam.library.difficultyUpdated', { count: ids.length }));
    } catch (err: unknown) {
      console.error('[QuestionBankManageView] batch difficulty failed:', err);
      showGlobalNotification(
        'error',
        `${t('learningHub:exam.library.difficultyUpdateFailed')}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setActionLoading(null);
    }
  }, [onBatchUpdateDifficulty, selectedIds, t]);

  // 批量增删标签（内联面板输入标签后执行）
  const handleBatchTags = useCallback(async (op: 'add' | 'remove') => {
    const tag = batchTagInput.trim();
    if (!onBatchUpdateTags || selectedIds.size === 0 || !tag) return;
    const ids = Array.from(selectedIds);
    setActionLoading('tags');
    try {
      await onBatchUpdateTags(ids, op === 'add' ? { add: [tag] } : { remove: [tag] });
      showGlobalNotification('success', t('learningHub:exam.library.tagsUpdated', { count: ids.length }));
      setBatchTagInput('');
      setBatchPanel(null);
    } catch (err: unknown) {
      console.error('[QuestionBankManageView] batch tags failed:', err);
      showGlobalNotification(
        'error',
        `${t('learningHub:exam.library.tagsUpdateFailed')}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setActionLoading(null);
    }
  }, [onBatchUpdateTags, batchTagInput, selectedIds, t]);
  
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
    if (!onDelete) {
      showGlobalNotification('warning', t('exam_sheet:questionBank.actionUnavailable'));
      return;
    }
    const ids = singleDeleteId ? [singleDeleteId] : Array.from(selectedIds);
    if (ids.length === 0) return;
    
    setDeleteConfirmOpen(false);
    setActionLoading('delete');
    try {
      await onDelete(ids);
      const next = new Set(selectedIds);
      ids.forEach((id) => next.delete(id));
      setSelectedIds(next);
      onSelect?.(Array.from(next));
    } catch (err: unknown) {
      console.error('[QuestionBankManageView] handleDelete failed:', err);
      const alreadyNotified =
        err instanceof Error && (err as Error & { __notified?: boolean }).__notified === true;
      if (!alreadyNotified) {
        showGlobalNotification(
          'error',
          `${t('practice:questionBank.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      setActionLoading(null);
      setSingleDeleteId(null);
    }
  }, [singleDeleteId, selectedIds, onDelete, onSelect, t]);
  
  // 确认重置进度
  const handleResetConfirm = useCallback(async () => {
    if (!onResetProgress) {
      showGlobalNotification('warning', t('exam_sheet:questionBank.actionUnavailable'));
      return;
    }
    const ids = singleResetId ? [singleResetId] : Array.from(selectedIds);
    if (ids.length === 0) return;
    
    setResetConfirmOpen(false);
    setActionLoading('reset');
    try {
      await onResetProgress(ids);
      const next = new Set(selectedIds);
      ids.forEach((id) => next.delete(id));
      setSelectedIds(next);
      onSelect?.(Array.from(next));
    } catch (err: unknown) {
      console.error('[QuestionBankManageView] handleReset failed:', err);
      const alreadyNotified =
        err instanceof Error && (err as Error & { __notified?: boolean }).__notified === true;
      if (!alreadyNotified) {
        showGlobalNotification(
          'error',
          `${t('practice:questionBank.resetFailed')}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      setActionLoading(null);
      setSingleResetId(null);
    }
  }, [singleResetId, selectedIds, onResetProgress, onSelect, t]);

  const totalPages = pagination ? Math.ceil(pagination.total / pagination.pageSize) : 1;

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 - 简洁风格 */}
      <div className="flex-shrink-0 px-4 py-2 space-y-2">
        {/* 搜索和筛选 */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              type="search"
              placeholder={t('exam_sheet:questionBank.search')}
              value={filters.search || ''}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              className={cn(
                'pl-9 h-8 text-sm bg-muted/30 border-transparent focus:border-border focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors',
                '[&::-webkit-search-cancel-button]:hidden',
                filters.search && 'pr-8'
              )}
/>
            {filters.search ? (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={handleSearchClear}
                className="!absolute !right-1.5 !top-1/2 !-translate-y-1/2 !h-5 !w-5 !p-0 text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3"
                aria-label={t('learningHub:exam.library.clearSearch')}
                title={t('learningHub:exam.library.clearSearch')}
              >
                <X size={12} />
              </DsButton>
            ) : null}
          </div>
          
          {/* CSV 导入导出按钮 */}
          {showCsvActions && (
            <div className="flex items-center gap-1">
              {onCsvImport && (
                <DsButton variant="ghost" size="sm" onClick={onCsvImport} className="!h-auto !px-2.5 !py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]" title={t('exam_sheet:csv.import_title')}>
                  <Upload size={14} />
                  <span className="hidden sm:inline">{t('exam_sheet:csv.import_title')}</span>
                </DsButton>
              )}
              {onCsvExport && (
                <DsButton variant="ghost" size="sm" onClick={onCsvExport} className="!h-auto !px-2.5 !py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]" title={t('exam_sheet:questionBank.export.title')}>
                  <Download size={14} />
                  <span className="hidden sm:inline">{t('exam_sheet:questionBank.export.title')}</span>
                </DsButton>
              )}
            </div>
          )}
          
          <DsButton variant="ghost" size="sm" onClick={() => setShowFilters(!showFilters)} className={cn('!h-auto !px-2.5 !py-1.5 text-xs', showFilters ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]')}>
            <Funnel size={14} />
            {t('common:actions.filter')}
          </DsButton>
        </div>

        {/* 筛选器 - 简洁风格按钮组（展开入场 + 选中态平滑过渡） */}
        {showFilters && (
          <div className="ui-drop-in flex flex-wrap gap-1.5">
            {/* 状态筛选 */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-muted/30">
              {(['all', 'new', 'in_progress', 'mastered', 'review'] as const).map((status) => (
                <DsButton key={status} variant="ghost" size="sm" onClick={() => handleFilterChange('status', status === 'all' ? undefined : [status as QuestionStatus])} className={cn('ui-state-colors !h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs', (status === 'all' && !filters.status) || filters.status?.[0] === status ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground')}>
                  {status === 'all' ? t('practice:questionBank.all') : t(statusLabelKeys[status])}
                </DsButton>
              ))}
            </div>
            
            {/* 难度筛选 */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-muted/30">
              {(['all', 'easy', 'medium', 'hard', 'very_hard'] as const).map((diff) => (
                <DsButton key={diff} variant="ghost" size="sm" onClick={() => handleFilterChange('difficulty', diff === 'all' ? undefined : [diff as Difficulty])} className={cn('ui-state-colors !h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs', (diff === 'all' && !filters.difficulty) || filters.difficulty?.[0] === diff ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground')}>
                  {diff === 'all' ? t('practice:questionBank.all') : t(difficultyLabelKeys[diff])}
                </DsButton>
              ))}
            </div>

            {/* 题型筛选（覆盖全部题型，含判断/匹配/排序/数值） */}
            <div className="flex flex-wrap items-center gap-0.5 p-0.5 rounded-md bg-muted/30">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => handleFilterChange('questionType', undefined)}
                className={cn('ui-state-colors !h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs', !filters.questionType ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground')}
              >
                {t('learningHub:exam.library.typeFilterLabel')}
              </DsButton>
              {QUESTION_TYPE_ORDER.map((type) => (
                <DsButton
                  key={type}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleFilterChange(
                    'questionType',
                    filters.questionType?.[0] === type ? undefined : [type as QuestionType]
                  )}
                  className={cn('ui-state-colors !h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs', filters.questionType?.[0] === type ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground')}
                  aria-pressed={filters.questionType?.[0] === type}
                >
                  {t(getQuestionTypeMeta(type).labelKey)}
                </DsButton>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 表格 */}
      <CustomScrollArea className="min-h-0 flex-1" orientation="both">
        {isLoading ? (
          // 加载骨架：模拟行结构，避免整屏转圈闪切
          <div className="space-y-2 px-4 py-3" role="status" aria-busy>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 w-10" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="hidden h-4 w-12 md:block" />
                <Skeleton className="hidden h-4 w-10 md:block" />
              </div>
            ))}
          </div>
        ) : questions.length === 0 ? (
          <div className="ui-rise-in flex flex-col items-center justify-center h-full text-muted-foreground">
            {(filters.search || filters.status || filters.difficulty) ? (
              <>
                <MagnifyingGlass size={28} className="mb-3 opacity-40" />
                <p className="text-sm">
                  {filters.search
                    ? t('learningHub:exam.library.noMatchFor', { query: filters.search })
                    : t('practice:questionBank.noMatch')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/70">{t('learningHub:exam.library.noMatchHint')}</p>
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    if (searchTimerRef.current != null) {
                      window.clearTimeout(searchTimerRef.current);
                      searchTimerRef.current = null;
                    }
                    const cleared: QuestionFilters = {};
                    setFilters(cleared);
                    emitFilterChange(cleared);
                  }}
                >
                  <X size={14} />
                  {t('common:clear')}
                </DsButton>
              </>
            ) : (
              <>
                <p>{t('exam_sheet:questionBank.empty')}</p>
                {showCsvActions && onCsvImport && (
                  <DsButton variant="ghost" size="sm" className="mt-3" onClick={onCsvImport}>
                    <Upload size={14} />
                    {t('exam_sheet:questionBank.import')}
                  </DsButton>
                )}
              </>
            )}
          </div>
        ) : isSmallScreen ? (
          /* <768：卡片列表（表格的 hidden md: 列在窄屏信息残缺）。
             每题一卡：题干摘要 + 标签 + 状态；操作经「⋯」行内展开，不用浮层 */
          <div
            className="space-y-2 px-3 py-2"
            style={{
              paddingBottom:
                'calc(var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 12px)',
            }}
          >
            {/* 全选行 */}
            <label className="flex min-h-[40px] items-center gap-2.5 px-1">
              <Checkbox
                checked={allSelected || (someSelected ? 'indeterminate' : false)}
                onCheckedChange={handleSelectAll}
              />
              <span className="text-xs text-muted-foreground">
                {selectedIds.size > 0
                  ? t('practice:questionBank.selectedCount', { count: selectedIds.size })
                  : t('common:contextMenu.selectAll')}
              </span>
            </label>

            {questions.map((q, index) => {
              const actionsExpanded = expandedActionId === q.id;
              return (
                <div
                  key={q.id}
                  style={staggerStyle(index)}
                  className={cn(
                    'ui-rise-in rounded-lg border bg-card p-3 transition-colors motion-reduce:transition-none',
                    // 长列表渲染优化：视口外卡片跳过渲染（与 QuestionBankListView 同一模式）
                    '[content-visibility:auto] [contain-intrinsic-size:auto_96px]',
                    selectedIds.has(q.id)
                      ? 'border-primary/40 bg-muted/30'
                      : 'border-border/60',
                  )}
                  onClick={() => onViewDetail?.(q)}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className="flex min-h-[24px] items-center"
                      onClick={(e) => e.stopPropagation()}
                      onClickCapture={(e) => { shiftKeyRef.current = e.shiftKey; }}
                    >
                      <Checkbox
                        checked={selectedIds.has(q.id)}
                        onCheckedChange={(checked) => handleSelectOne(q.id, !!checked, index)}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-muted-foreground">
                          {q.questionLabel || q.cardId}
                        </span>
                        {q.isCorrect === true && (
                          <CheckCircle size={14} className="flex-shrink-0 text-success" />
                        )}
                        {q.isCorrect === false && (
                          <XCircle size={14} className="flex-shrink-0 text-destructive" />
                        )}
                      </div>
                      <p className="mt-1 text-sm leading-snug line-clamp-2">
                        {q.content.slice(0, 100)}
                        {q.content.length > 100 && '...'}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                        <span className={cn('font-medium', statusColors[q.status])}>
                          {t(statusLabelKeys[q.status])}
                        </span>
                        {q.difficulty && (
                          <span className={cn('font-medium', difficultyColors[q.difficulty])}>
                            {t(difficultyLabelKeys[q.difficulty])}
                          </span>
                        )}
                        {q.questionType && q.questionType !== 'other' && (
                          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', getQuestionTypeMeta(q.questionType).pill)}>
                            {t(getQuestionTypeMeta(q.questionType).labelKey)}
                          </span>
                        )}
                        <span className="tabular-nums text-muted-foreground">
                          {q.correctCount}/{q.attemptCount}
                        </span>
                        {q.tags?.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="max-w-[8rem] truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <DsButton
                      variant="ghost"
                      iconOnly
                      size="sm"
                      className="!h-11 !w-11 -mr-1 -mt-1 flex-shrink-0 text-muted-foreground"
                      aria-label={t('common:more')}
                      aria-expanded={actionsExpanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedActionId(actionsExpanded ? null : q.id);
                      }}
                    >
                      <DotsThree size={18} weight="bold" />
                    </DsButton>
                  </div>

                  {/* 行内展开的操作区 */}
                  {actionsExpanded && (
                    <div
                      className="mt-2 grid grid-cols-4 gap-1 border-t border-border/40 pt-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="!h-11 flex-col gap-0.5 px-1 text-[10px] text-muted-foreground"
                        onClick={() => { setExpandedActionId(null); onViewHistory?.(q.id); }}
                      >
                        <ClockCounterClockwise size={16} />
                        {t('exam_sheet:questionBank.history.title')}
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className={cn(
                          '!h-11 flex-col gap-0.5 px-1 text-[10px]',
                          q.isFavorite ? 'text-warning' : 'text-muted-foreground',
                        )}
                        disabled={!canToggleFavorite || actionLoading === `favorite:${q.id}` || isLoading}
                        onClick={() => void handleToggleFavoriteAction(q.id)}
                      >
                        <Star size={16} weight={q.isFavorite ? 'fill' : 'regular'} />
                        {q.isFavorite
                          ? t('exam_sheet:questionBank.unfavorite')
                          : t('exam_sheet:questionBank.favorite')}
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="!h-11 flex-col gap-0.5 px-1 text-[10px] text-muted-foreground"
                        disabled={!canReset}
                        onClick={() => { setExpandedActionId(null); handleSingleResetClick(q.id); }}
                      >
                        <ArrowCounterClockwise size={16} />
                        {t('exam_sheet:questionBank.resetProgress')}
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="!h-11 flex-col gap-0.5 px-1 text-[10px] text-destructive hover:bg-destructive/10"
                        disabled={!canDelete}
                        onClick={() => { setExpandedActionId(null); handleSingleDeleteClick(q.id); }}
                      >
                        <Trash size={16} />
                        {t('common:delete')}
                      </DsButton>
                    </div>
                  )}
                </div>
              );
            })}
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
                <TableHead className="w-16">{t('exam_sheet:questionBank.label')}</TableHead>
                <TableHead>{t('exam_sheet:questionBank.content')}</TableHead>
                <TableHead className="w-20">{t('practice:questionBank.statusHeader')}</TableHead>
                {/* 窄屏隐藏次要列，保证题目内容可读 */}
                <TableHead className="w-20 hidden md:table-cell">{t('practice:questionBank.difficultyHeader')}</TableHead>
                <TableHead className="w-20 hidden lg:table-cell">{t('learningHub:exam.library.typeFilterLabel')}</TableHead>
                <TableHead className="w-20 hidden md:table-cell">{t('exam_sheet:questionBank.attempts')}</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {questions.map((q, index) => (
                <TableRow
                  key={q.id}
                  style={staggerStyle(index)}
                  className={cn(
                    'ui-rise-in cursor-pointer hover:bg-[var(--interactive-hover)]',
                    selectedIds.has(q.id) && 'bg-muted/30'
                  )}
                  onClick={() => onViewDetail?.(q)}
                >
                  <TableCell
                    onClick={(e) => e.stopPropagation()}
                    onClickCapture={(e) => { shiftKeyRef.current = e.shiftKey; }}
                  >
                    <Checkbox
                      checked={selectedIds.has(q.id)}
                      onCheckedChange={(checked) => handleSelectOne(q.id, !!checked, index)}
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
                        <CheckCircle size={16} className="text-success flex-shrink-0" />
                      )}
                      {q.isCorrect === false && (
                        <XCircle size={16} className="text-destructive flex-shrink-0" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={cn('text-xs font-medium', statusColors[q.status])}>
                      {t(statusLabelKeys[q.status])}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {q.difficulty && (
                      <span className={cn('text-xs font-medium', difficultyColors[q.difficulty])}>
                        {t(difficultyLabelKeys[q.difficulty])}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {q.questionType && q.questionType !== 'other' && (
                      <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', getQuestionTypeMeta(q.questionType).pill)}>
                        {t(getQuestionTypeMeta(q.questionType).labelKey)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {q.correctCount}/{q.attemptCount}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <AppMenu>
                      <AppMenuTrigger asChild>
                        <DsButton variant="ghost" iconOnly size="sm" className="w-8 h-8" >
                          <DotsThree size={16} />
                        </DsButton>
                      </AppMenuTrigger>
                      <AppMenuContent align="end" width={160}>
                        <AppMenuItem
                          onClick={() => onViewHistory?.(q.id)}
                          icon={<ClockCounterClockwise size={16} />}
                        >
                          {t('exam_sheet:questionBank.history.title')}
                        </AppMenuItem>
                        <AppMenuSeparator />
                        <AppMenuItem
                          onClick={() => void handleToggleFavoriteAction(q.id)}
                          disabled={!canToggleFavorite || actionLoading === `favorite:${q.id}` || isLoading}
                          icon={<Star size={16} weight={q.isFavorite ? 'fill' : 'regular'} className={q.isFavorite ? 'text-warning' : undefined} />}
                        >
                          {q.isFavorite
                            ? t('exam_sheet:questionBank.unfavorite')
                            : t('exam_sheet:questionBank.favorite')}
                        </AppMenuItem>
                        <AppMenuSeparator />
                        <AppMenuItem
                          onClick={() => handleSingleResetClick(q.id)}
                          disabled={!canReset}
                          icon={<ArrowCounterClockwise size={16} />}
                        >
                          {t('exam_sheet:questionBank.resetProgress')}
                        </AppMenuItem>
                        <AppMenuItem
                          onClick={() => handleSingleDeleteClick(q.id)}
                          disabled={!canDelete}
                          destructive
                          icon={<Trash size={16} />}
                        >
                          {t('common:delete')}
                        </AppMenuItem>
                      </AppMenuContent>
                    </AppMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CustomScrollArea>

      {/* 内联二次确认条（吸底，桌面/移动端统一，替代原模态 AlertDialog） */}
      <UiPresence
        open={deleteConfirmOpen || resetConfirmOpen}
        inClass="ui-slide-up-panel"
        outClass="ui-slide-up-panel-out"
        exitMs={260}
        role="alert"
        className={cn(
          'flex-shrink-0 mx-3 mb-2 rounded-lg border px-3 py-2',
          deleteConfirmOpen ? 'border-destructive/30 bg-destructive/5' : 'border-warning/30 bg-warning/10'
        )}
        aria-label={deleteConfirmOpen ? t('exam_sheet:questionBank.confirmDelete') : t('exam_sheet:questionBank.confirmReset')}
      >
          <div className="flex items-start gap-2">
            <Warning size={16} className={cn('mt-0.5 flex-shrink-0', deleteConfirmOpen ? 'text-destructive' : 'text-warning')} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                {deleteConfirmOpen ? t('exam_sheet:questionBank.confirmDelete') : t('exam_sheet:questionBank.confirmReset')}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {deleteConfirmOpen
                  ? (singleDeleteId
                    ? t('exam_sheet:questionBank.confirmDeleteSingle')
                    : t('exam_sheet:questionBank.confirmDeleteBatch', { count: selectedIds.size }))
                  : (singleResetId
                    ? t('exam_sheet:questionBank.confirmResetSingle')
                    : t('exam_sheet:questionBank.confirmResetBatch', { count: selectedIds.size }))}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-8 px-3 text-xs"
                onClick={() => {
                  if (deleteConfirmOpen) {
                    setDeleteConfirmOpen(false);
                    setSingleDeleteId(null);
                  } else {
                    setResetConfirmOpen(false);
                    setSingleResetId(null);
                  }
                }}
              >
                {t('common:cancel')}
              </DsButton>
              <DsButton
                variant={deleteConfirmOpen ? 'danger' : 'warning'}
                size="sm"
                className="!h-8 px-3 text-xs"
                disabled={
                  actionLoading === 'delete'
                  || actionLoading === 'reset'
                  || (deleteConfirmOpen && deleteCountdown > 0)
                }
                onClick={() => {
                  if (deleteConfirmOpen) {
                    void handleDeleteConfirm();
                  } else {
                    void handleResetConfirm();
                  }
                }}
              >
                {(actionLoading === 'delete' || actionLoading === 'reset') && (
                  <CircleNotch size={12} className="animate-spin" />
                )}
                {deleteConfirmOpen ? t('common:delete') : t('exam_sheet:questionBank.resetProgress')}
                {deleteConfirmOpen && deleteCountdown > 0 && (
                  <span className="tabular-nums">({deleteCountdown})</span>
                )}
              </DsButton>
            </div>
          </div>
      </UiPresence>

      {/* 批量改难度 / 改标签 内联面板（吸底展开，不用弹窗） */}
      {batchPanel !== null && selectedIds.size > 0 && !deleteConfirmOpen && !resetConfirmOpen && (
        <div className="ui-drop-in flex-shrink-0 mx-3 mb-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          {batchPanel === 'difficulty' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('learningHub:exam.library.applyToSelected', { count: selectedIds.size })}
              </span>
              {(['easy', 'medium', 'hard', 'very_hard'] as const).map((diff) => (
                <DsButton
                  key={diff}
                  variant="ghost"
                  size="sm"
                  disabled={actionLoading === 'difficulty'}
                  onClick={() => void handleBatchDifficulty(diff)}
                  className={cn(
                    '!h-auto !px-2.5 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs border border-border/60',
                    difficultyColors[diff],
                    'hover:bg-[var(--interactive-hover)]'
                  )}
                >
                  {t(difficultyLabelKeys[diff])}
                </DsButton>
              ))}
              {actionLoading === 'difficulty' && <CircleNotch size={14} className="animate-spin text-muted-foreground" />}
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => setBatchPanel(null)}
                className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-muted-foreground hover:text-foreground ml-auto"
              >
                {t('common:cancel')}
              </DsButton>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('learningHub:exam.library.applyToSelected', { count: selectedIds.size })}
              </span>
              <Input
                value={batchTagInput}
                onChange={(e) => setBatchTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && batchTagInput.trim()) {
                    e.preventDefault();
                    void handleBatchTags('add');
                  }
                }}
                placeholder={t('learningHub:exam.library.batchAddTagPlaceholder')}
                className="h-8 w-40 flex-1 min-w-[8rem] bg-background text-sm"
              />
              <DsButton
                variant="ghost"
                size="sm"
                disabled={!batchTagInput.trim() || actionLoading === 'tags'}
                onClick={() => void handleBatchTags('add')}
                className="!h-8 !px-2.5 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-primary hover:bg-primary/10"
              >
                {actionLoading === 'tags' ? <CircleNotch size={12} className="animate-spin" /> : null}
                {t('learningHub:exam.library.batchTagAdd')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                disabled={!batchTagInput.trim() || actionLoading === 'tags'}
                onClick={() => void handleBatchTags('remove')}
                className="!h-8 !px-2.5 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-warning hover:bg-warning/10"
              >
                {t('learningHub:exam.library.batchTagRemove')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => { setBatchPanel(null); setBatchTagInput(''); }}
                className="!h-8 !px-2 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-muted-foreground hover:text-foreground"
              >
                {t('common:cancel')}
              </DsButton>
            </div>
          )}
        </div>
      )}

      {/* 批量操作吸底操作条 */}
      <UiPresence
        open={selectedIds.size > 0 && !deleteConfirmOpen && !resetConfirmOpen}
        inClass="ui-slide-up-panel"
        outClass="ui-slide-up-panel-out"
        exitMs={260}
        className="flex-shrink-0 flex items-center justify-between gap-2 border-t border-border/50 bg-background/95 px-3 py-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]"
      >
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-xs text-muted-foreground whitespace-nowrap px-1">
              {t('practice:questionBank.selectedCount', { count: selectedIds.size })}
            </span>
            <DsButton variant="ghost" size="sm" onClick={handleInvertSelection} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]">
              {t('learningHub:exam.library.invertSelection')}
            </DsButton>
            <span className="hidden lg:inline text-[11px] text-muted-foreground/60 whitespace-nowrap">
              {t('learningHub:exam.library.shiftRangeHint')}
            </span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onBatchUpdateDifficulty && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => setBatchPanel(batchPanel === 'difficulty' ? null : 'difficulty')}
                disabled={actionLoading === 'difficulty'}
                className={cn(
                  '!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs hover:bg-[var(--interactive-hover)]',
                  batchPanel === 'difficulty' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                aria-expanded={batchPanel === 'difficulty'}
                title={t('learningHub:exam.library.batchSetDifficulty')}
              >
                <Gauge size={14} />
                <span className="hidden sm:inline">{t('learningHub:exam.library.batchSetDifficulty')}</span>
              </DsButton>
            )}
            {onBatchUpdateTags && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => setBatchPanel(batchPanel === 'tags' ? null : 'tags')}
                disabled={actionLoading === 'tags'}
                className={cn(
                  '!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs hover:bg-[var(--interactive-hover)]',
                  batchPanel === 'tags' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                aria-expanded={batchPanel === 'tags'}
                title={t('learningHub:exam.library.batchEditTags')}
              >
                <Tag size={14} />
                <span className="hidden sm:inline">{t('learningHub:exam.library.batchEditTags')}</span>
              </DsButton>
            )}
            {(onBatchUpdateDifficulty || onBatchUpdateTags) && <div className="w-px h-3 bg-border/60 mx-1" />}
            <DsButton variant="ghost" size="sm" onClick={() => handleBatchActionClick('reset')} disabled={!canReset || actionLoading === 'reset'} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-primary hover:bg-primary/10" title={t('practice:questionBank.reset')}>
              <ArrowCounterClockwise className={cn('w-3 h-3', actionLoading === 'reset' && 'animate-spin')} />
              <span className="hidden sm:inline">{t('practice:questionBank.reset')}</span>
            </DsButton>
            <DsButton variant="ghost" size="sm" onClick={() => handleBatchActionClick('delete')} disabled={!canDelete || actionLoading === 'delete'} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-destructive hover:bg-destructive/10" title={t('common:delete')}>
              <Trash size={12} />
              <span className="hidden sm:inline">{t('common:delete')}</span>
            </DsButton>
            <div className="w-px h-3 bg-border/60 mx-1" />
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => { setSelectedIds(new Set()); onSelect?.([]); lastSelectedIndexRef.current = null; setBatchPanel(null); }}
              className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
              title={t('common:cancel')}
            >
              <X size={12} />
              <span className="hidden sm:inline">{t('common:cancel')}</span>
            </DsButton>
          </div>
      </UiPresence>

      {/* 分页 */}
      {pagination && totalPages > 1 && (
        <div className="flex-shrink-0 flex items-center justify-between p-3 border-t border-border/50">
          <span className="text-sm text-muted-foreground">
            {t('exam_sheet:questionBank.paginationInfo', { total: pagination.total })}
          </span>
          <div className="flex items-center gap-1">
            <DsButton
              variant="outline"
              iconOnly size="sm"
              className="w-8 h-8 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!min-w-[44px]"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              aria-label={t('common:prev')}
            >
              <CaretLeft size={16} />
            </DsButton>
            <span className="text-sm px-2 tabular-nums">
              {pagination.page} / {totalPages}
            </span>
            <DsButton
              variant="outline"
              iconOnly size="sm"
              className="w-8 h-8 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!min-w-[44px]"
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              aria-label={t('common:next')}
            >
              <CaretRight size={16} />
            </DsButton>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuestionBankManageView;
