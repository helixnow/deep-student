/**
 * 题目集列表视图
 * 
 * 简洁风格设计：
 * - 极简主义，内容优先
 * - 大量留白，清晰层级
 * - 微妙的 hover 效果
 * - 柔和的颜色系统
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  MagnifyingGlass,
  Check,
  X,
  CaretRight,
  GridNine,
  List,
  Star,
  Play,
  Trash,
  ArrowClockwise,
  CheckSquare,
  SelectionInverse,
  ListChecks,
  PencilSimple,
  Warning,
  Image as ImageIcon,
  Plus,
  CircleNotch,
  Scan,
  Table as TableIcon,
} from '@phosphor-icons/react';
import { ExamIcon } from '@/features/learning-hub/icons/ResourceIcons';
import { useTranslation } from 'react-i18next';
import type { Question, QuestionBankStats, QuestionStatus, Difficulty, QuestionType } from '@/api/questionBankApi';
import { ratioToPercent } from '@/components/stats';
import { QuestionInlineEditor } from './QuestionInlineEditor';
import { UnifiedDragDropZone } from '@/components/shared/UnifiedDragDropZone';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { EXAM_DOCUMENT_TYPE, EXAM_IMAGE_TYPE } from './ExamSheetUploader';
import { getQuestionTypeMeta, QUESTION_TYPE_ORDER, type ExtendedQuestionType } from './questionTypeMeta';

export interface QuestionListFilters {
  search?: string;
  status?: QuestionStatus | 'all';
  difficulty?: Difficulty | 'all';
  isFavorite?: boolean;
  /** 题型筛选（可选，向后兼容新增） */
  questionType?: QuestionType | 'all';
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
  /** 单题收藏切换回调（可选，行 hover 快捷操作） */
  onToggleFavorite?: (questionId: string) => Promise<void>;
  /** 更新题目回调 */
  onUpdateQuestion?: (question: Question) => Promise<void>;
  /** 题目集 ID（用于内联创建新题目） */
  examId?: string;
  /** 创建新题目回调 */
  onCreateQuestion?: (question: Question) => Promise<void>;
  /** 空题目集时打开导入流程 */
  onUploadQuestions?: () => void;
  /** 空状态启动台拖入文件、携带文件进入识别导入 */
  onUploadFiles?: (files: File[]) => void;
  /** 空状态启动台打开 CSV 导入对话框 */
  onCsvImport?: () => void;
  /** 外部请求打开内联创建编辑器（值变化时触发一次） */
  createRequestKey?: number;
  /** Reports unsaved inline edits to an owning resource view. */
  onDraftDirtyChange?: (dirty: boolean) => void;
  /** Lets an owning resource view confirm a question jump that discards an inline edit. */
  onDraftNavigationRequested?: (index: number) => void;
  className?: string;
}

type PendingInlineEditorAction =
  | { kind: 'edit'; id: string | null }
  | { kind: 'question'; index: number }
  | { kind: 'callback'; run: () => void };

const STATUS_CONFIG: Record<QuestionStatus, { labelKey: string; color: string; bg: string }> = {
  new: { labelKey: 'questionBank.statusShort.new', color: 'text-muted-foreground', bg: 'bg-muted-foreground/20' },
  in_progress: { labelKey: 'questionBank.statusShort.inProgress', color: 'text-primary', bg: 'bg-primary/10' },
  mastered: { labelKey: 'questionBank.statusShort.mastered', color: 'text-success', bg: 'bg-success/10' },
  review: { labelKey: 'questionBank.statusShort.review', color: 'text-warning', bg: 'bg-warning/10' },
};

const DIFFICULTY_CONFIG: Record<Difficulty, { labelKey: string; color: string; pill: string }> = {
  easy: { labelKey: 'questionBank.difficultyShort.easy', color: 'text-success', pill: 'bg-success/10 text-success' },
  medium: { labelKey: 'questionBank.difficultyShort.medium', color: 'text-warning', pill: 'bg-warning/10 text-warning' },
  hard: { labelKey: 'questionBank.difficultyShort.hard', color: 'text-warning', pill: 'bg-warning/15 text-warning' },
  very_hard: { labelKey: 'questionBank.difficultyShort.veryHard', color: 'text-destructive', pill: 'bg-destructive/10 text-destructive' },
};

const VIEW_TYPE_STORAGE_KEY = 'qbank.listView.viewType';

const readStoredViewType = (): 'grid' | 'list' => {
  try {
    const stored = window.localStorage.getItem(VIEW_TYPE_STORAGE_KEY);
    return stored === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 搜索命中高亮：按 query 切分并用 <mark> 包裹命中片段 */
const HighlightText: React.FC<{ text: string; query?: string }> = ({ text, query }) => {
  const trimmed = query?.trim();
  if (!trimmed) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(trimmed)})`, 'ig'));
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === trimmed.toLowerCase() ? (
          <mark key={i} className="rounded-[2px] bg-warning/30 px-0 text-inherit">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
};

/** 列表进入 stagger：延迟随索引递增，封顶避免长列表尾部等待过久 */
const staggerStyle = (index: number): React.CSSProperties => ({
  animationDelay: `${Math.min(index, 16) * 24}ms`,
});

/** 激活筛选条件 chip（可单个移除） */
const FilterChip: React.FC<{ label: string; onRemove: () => void }> = ({ label, onRemove }) => {
  const { t } = useTranslation('learningHub');
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 py-0.5 pl-2 pr-1 text-xs text-primary">
      {label}
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={onRemove}
        className="!h-4 !w-4 !p-0 [@media(pointer:coarse)]:!h-7 [@media(pointer:coarse)]:!w-7 text-primary/70 hover:text-primary hover:bg-primary/10"
        aria-label={t('exam.library.removeFilter', { label })}
        title={t('exam.library.removeFilter', { label })}
      >
        <X size={10} />
      </DsButton>
    </span>
  );
};

/** 桌面端统计摘要（移动端隐藏） */
const StatsSummary: React.FC<{ stats: QuestionBankStats; onStartPractice?: () => void }> = ({ stats, onStartPractice }) => {
  const { t } = useTranslation('practice');
  const progressPercent = stats.total > 0 ? (stats.mastered / stats.total) * 100 : 0;
  
  return (
    <div className="hidden sm:flex items-center justify-between gap-6 px-1">
      <div className="flex items-center gap-6">
        {/* 进度环和掌握数（轨道用 currentColor + strokeOpacity，进度平滑过渡） */}
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 relative text-success">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth="3" />
              <circle
                cx="20" cy="20" r="16"
                fill="none" stroke="currentColor" strokeWidth="3"
                strokeDasharray={`${progressPercent * 1.005} 100.5`}
                strokeLinecap="round"
                className="transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none"
/>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[10px] font-semibold tabular-nums text-foreground">{Math.round(progressPercent)}%</span>
            </div>
          </div>
          <div className="text-sm whitespace-nowrap">
            <span className="text-muted-foreground">{t('questionBank.masteredLabel')} </span>
            <span className="font-medium tabular-nums">{stats.mastered}</span>
            <span className="text-muted-foreground tabular-nums">/ {stats.total}</span>
          </div>
        </div>

        <div className="w-px h-3.5 bg-border/60" aria-hidden="true" />

        {/* 待复习 */}
        {stats.review > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-warning">
            <span className="w-1.5 h-1.5 rounded-full bg-warning" aria-hidden="true" />
            <span className="tabular-nums">{t('questionBank.pendingReview', { count: stats.review })}</span>
          </div>
        )}
        
        {/* 正确率 */}
        <div className="text-sm text-muted-foreground">
          {t('questionBank.correctRate')} <span className="font-medium text-foreground tabular-nums">{ratioToPercent(stats.correctRate)}%</span>
        </div>
      </div>
      
      {/* 开始做题按钮 */}
      {onStartPractice && (
        <DsButton variant="ghost" size="sm" onClick={onStartPractice} className="text-primary hover:bg-primary/10">
          <Play size={14} />
          {t('questionBank.startPractice')}
        </DsButton>
      )}
    </div>
  );
};

/** 行 hover 浮现的快捷操作（收藏 / 编辑 / 删除二段式确认），桌面 hover 显示、触屏常显 */
const RowHoverActions: React.FC<{
  question: Question;
  /** true = 网格卡片（更小的按钮尺寸） */
  dense?: boolean;
  onEdit?: () => void;
  onToggleFavorite?: () => void;
  favoriteLoading?: boolean;
  onDeleteAction?: () => void;
  deleteArmed?: boolean;
  deleteLoading?: boolean;
}> = ({ question, dense, onEdit, onToggleFavorite, favoriteLoading, onDeleteAction, deleteArmed, deleteLoading }) => {
  const { t } = useTranslation(['practice', 'exam_sheet', 'learningHub', 'common']);
  const iconSize = dense ? 12 : 14;
  // 触屏命中区放大到 40px，负 margin 抵消占位保持布局紧凑
  const buttonClass = cn(
    dense ? '!w-5 !h-5' : '!w-6 !h-6',
    '!p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
    '[@media(pointer:coarse)]:opacity-60 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:-m-2',
    'hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground'
  );
  return (
    <>
      {onToggleFavorite && (
        <DsButton
          variant="ghost" size="icon" iconOnly
          disabled={favoriteLoading}
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className={cn(buttonClass, question.isFavorite && 'opacity-100 text-warning hover:text-warning')}
          title={question.isFavorite ? t('exam_sheet:questionBank.unfavorite') : t('exam_sheet:questionBank.favorite')}
          aria-label={question.isFavorite ? t('exam_sheet:questionBank.unfavorite') : t('exam_sheet:questionBank.favorite')}
        >
          {favoriteLoading
            ? <CircleNotch size={iconSize} className="animate-spin" />
            : <Star size={iconSize} weight={question.isFavorite ? 'fill' : 'regular'} className={question.isFavorite ? 'text-warning' : undefined} />}
        </DsButton>
      )}
      {onEdit && (
        <DsButton
          variant="ghost" size="icon" iconOnly
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className={buttonClass}
          title={t('practice:questionBank.editQuestion')}
          aria-label={t('practice:questionBank.editQuestion')}
        >
          <PencilSimple size={iconSize} />
        </DsButton>
      )}
      {onDeleteAction && (
        deleteArmed ? (
          // 二段式确认：按钮变红，再次点击才执行；3 秒无操作自动复位
          <DsButton
            variant="danger" size="sm"
            disabled={deleteLoading}
            onClick={(e) => { e.stopPropagation(); onDeleteAction(); }}
            className="!h-5 !px-1.5 !py-0 text-[10px] opacity-100 [@media(pointer:coarse)]:!h-8"
            aria-label={t('learningHub:exam.library.confirmDeleteShort')}
          >
            {deleteLoading ? <CircleNotch size={10} className="animate-spin" /> : <Trash size={10} />}
            {t('learningHub:exam.library.confirmDeleteShort')}
          </DsButton>
        ) : (
          <DsButton
            variant="ghost" size="icon" iconOnly
            onClick={(e) => { e.stopPropagation(); onDeleteAction(); }}
            className={cn(buttonClass, 'hover:!text-destructive hover:!bg-destructive/10')}
            title={t('learningHub:exam.library.deleteQuestion')}
            aria-label={t('learningHub:exam.library.deleteQuestion')}
          >
            <Trash size={iconSize} />
          </DsButton>
        )
      )}
    </>
  );
};

interface RowActionProps {
  onEdit?: () => void;
  onToggleFavorite?: () => void;
  favoriteLoading?: boolean;
  onDeleteAction?: () => void;
  deleteArmed?: boolean;
  deleteLoading?: boolean;
}

const QuestionGridCard: React.FC<{
  question: Question;
  index: number;
  /** 在筛选结果中的位置（用于 stagger 入场） */
  listIndex: number;
  /** 搜索命中高亮词 */
  highlight?: string;
  onClick: () => void;
  isEditMode?: boolean;
  isSelected?: boolean;
  onSelect?: (selected: boolean, shiftKey: boolean) => void;
} & RowActionProps> = ({ question, index, listIndex, highlight, onClick, onEdit, isEditMode, isSelected, onSelect, ...actionProps }) => {
  const { t } = useTranslation(['practice', 'learningHub']);
  const status = question.status || 'new';
  const hasAttempt = (question.attemptCount ?? 0) > 0;
  const isCorrect = hasAttempt && (question.correctCount ?? 0) > 0;
  const typeMeta = getQuestionTypeMeta(question.questionType);
  
  return (
    <div
      role="button"
      tabIndex={0}
      data-agent-entity={`exam:${question.id}`}
      onClick={(e) => { if (isEditMode) { onSelect?.(!isSelected, e.shiftKey); } else { onClick(); } }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (isEditMode) { onSelect?.(!isSelected, e.shiftKey); } else { onClick(); } } }}
      style={staggerStyle(listIndex)}
      className={cn(
        'ui-rise-in group relative flex flex-col p-4 rounded-lg text-left cursor-pointer',
        // 长列表渲染优化：视口外卡片跳过渲染（记忆上次尺寸避免滚动条跳动）
        '[content-visibility:auto] [contain-intrinsic-size:auto_150px]',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-200',
        'border border-border/40 bg-card/30 hover:border-border/70 hover:bg-[var(--interactive-hover)]',
        'hover:shadow-[var(--shadow-card)] hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        status === 'mastered' && 'bg-success/5',
        status === 'review' && 'bg-warning/5',
        isSelected && 'ring-2 ring-primary/50 bg-primary/5'
      )}
    >
      <div className="flex items-center justify-between mb-2">
        {isEditMode ? (
          <div className={cn(
            'w-4 h-4 rounded border flex items-center justify-center transition-colors',
            isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'
          )}>
            {isSelected && <Check size={12} />}
          </div>
        ) : (
          <span className="text-sm font-medium text-muted-foreground">
            {question.questionLabel || `${index + 1}`}
          </span>
        )}
        <div className="flex items-center gap-1.5">
          {question.isFavorite && !actionProps.onToggleFavorite && (
            <Star size={14} className="fill-warning text-warning" />
          )}
          {hasAttempt && (
            <div className={cn(
              'w-4 h-4 rounded-full flex items-center justify-center',
              isCorrect ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'
            )}>
              {isCorrect ? <Check size={10} /> : <X size={10} />}
            </div>
          )}
          {/* hover 浮现快捷操作：收藏 / 编辑 / 删除（非编辑模式） */}
          {!isEditMode && (
            <RowHoverActions question={question} dense onEdit={onEdit} {...actionProps} />
          )}
        </div>
      </div>
      
      {question.images && question.images.length > 0 && (
        <div className="flex items-center gap-1 mb-1.5 text-xs text-muted-foreground">
          <ImageIcon size={12} />
          <span>{question.images.length}</span>
        </div>
      )}
      <p className="text-sm text-foreground/80 line-clamp-2 flex-1 mb-3 leading-relaxed">
        <HighlightText
          text={question.content || question.ocrText || t('practice:questionBank.noContent')}
          query={highlight}
        />
      </p>
      
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {question.questionType && question.questionType !== 'other' && (
          <span className={cn('rounded px-1.5 py-0.5 font-medium', typeMeta.pill)}>
            {t(typeMeta.labelKey)}
          </span>
        )}
        {question.difficulty && (
          <span className={cn('rounded px-1.5 py-0.5 font-medium', DIFFICULTY_CONFIG[question.difficulty].pill)}>
            {t(`practice:${DIFFICULTY_CONFIG[question.difficulty].labelKey}`)}
          </span>
        )}
        <span className={cn(STATUS_CONFIG[status].color)}>
          {t(`practice:${STATUS_CONFIG[status].labelKey}`)}
        </span>
      </div>
      
      <CaretRight size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-[background-color,border-color,color,box-shadow]" />
    </div>
  );
};

const QuestionListRow: React.FC<{
  question: Question;
  index: number;
  /** 在筛选结果中的位置（用于 stagger 入场） */
  listIndex: number;
  /** 搜索命中高亮词 */
  highlight?: string;
  onClick: () => void;
  isEditMode?: boolean;
  isSelected?: boolean;
  onSelect?: (selected: boolean, shiftKey: boolean) => void;
} & RowActionProps> = ({ question, index, listIndex, highlight, onClick, onEdit, isEditMode, isSelected, onSelect, ...actionProps }) => {
  const { t } = useTranslation(['practice', 'learningHub']);
  const status = question.status || 'new';
  const hasAttempt = (question.attemptCount ?? 0) > 0;
  const isCorrect = hasAttempt && (question.correctCount ?? 0) > 0;
  const typeMeta = getQuestionTypeMeta(question.questionType);
  
  return (
    <DsButton
      variant="ghost" size="sm"
      data-agent-entity={`exam:${question.id}`}
      onClick={(e) => { if (isEditMode) { onSelect?.(!isSelected, e.shiftKey); } else { onClick(); } }}
      style={staggerStyle(listIndex)}
      className={cn(
        'ui-rise-in group w-full !justify-start gap-4 !px-3 !py-3 !h-auto !rounded-lg',
        // 长列表渲染优化：视口外行跳过渲染（记忆上次尺寸避免滚动条跳动）
        '[content-visibility:auto] [contain-intrinsic-size:auto_48px]',
        !isSelected && 'hover:bg-[var(--interactive-hover)]',
        isSelected && 'bg-primary/5'
      )}
    >
      {isEditMode ? (
        <div className={cn(
          'w-4 h-4 rounded border flex items-center justify-center transition-colors flex-shrink-0',
          isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'
        )}>
          {isSelected && <Check size={12} />}
        </div>
      ) : (
        <span className="text-sm font-medium text-muted-foreground w-8 flex-shrink-0">
          {question.questionLabel || `${index + 1}`}
        </span>
      )}
      
      <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', STATUS_CONFIG[status].bg)} />
      
      {question.images && question.images.length > 0 && (
        <ImageIcon size={14} className="flex-shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 text-sm truncate text-foreground/80">
        <HighlightText
          text={question.content || question.ocrText || t('practice:questionBank.noContent')}
          query={highlight}
        />
      </span>
      
      <div className="flex items-center gap-2 flex-shrink-0">
        {question.questionType && question.questionType !== 'other' && (
          <span className={cn('hidden md:inline-block rounded px-1.5 py-0.5 text-[11px] font-medium', typeMeta.pill)}>
            {t(typeMeta.labelKey)}
          </span>
        )}
        {question.difficulty && (
          <span className={cn('hidden sm:inline-block rounded px-1.5 py-0.5 text-[11px] font-medium', DIFFICULTY_CONFIG[question.difficulty].pill)}>
            {t(`practice:${DIFFICULTY_CONFIG[question.difficulty].labelKey}`)}
          </span>
        )}
        {question.isFavorite && !actionProps.onToggleFavorite && (
          <Star size={14} className="fill-warning text-warning" />
        )}
        {hasAttempt && (
          <div className={cn(
            'w-4 h-4 rounded-full flex items-center justify-center',
            isCorrect ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'
          )}>
            {isCorrect ? <Check size={10} /> : <X size={10} />}
          </div>
        )}
        {/* hover 浮现快捷操作：收藏 / 编辑 / 删除（非编辑模式） */}
        {!isEditMode && (
          <RowHoverActions question={question} onEdit={onEdit} {...actionProps} />
        )}
      </div>
      
      <CaretRight size={16} className="text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-[background-color,border-color,color,box-shadow] flex-shrink-0" />
    </DsButton>
  );
};

/** 空状态启动台的动作卡 */
const LauncherCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}> = ({ icon, title, desc, onClick }) => (
  <DsButton
    variant="ghost"
    onClick={onClick}
    className={cn(
      'group !h-auto !flex-col !items-start !justify-start gap-2.5 !rounded-xl !p-4 border border-border/60 bg-card/40 text-left',
      'transition-[background-color,border-color,color,box-shadow] duration-200',
      'hover:border-primary/40 hover:bg-primary/5 hover:shadow-[var(--shadow-card)]'
    )}
  >
    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
      {icon}
    </div>
    <div className="text-sm font-medium">{title}</div>
    <div className="text-xs leading-relaxed text-muted-foreground whitespace-normal">{desc}</div>
  </DsButton>
);

export const QuestionBankListView: React.FC<QuestionBankListViewProps> = ({
  questions,
  stats,
  onQuestionClick,
  onFilterChange,
  isLoading = false,
  onDelete,
  onResetProgress,
  onToggleFavorite,
  onUpdateQuestion,
  examId,
  onCreateQuestion,
  onUploadQuestions,
  onUploadFiles,
  onCsvImport,
  createRequestKey,
  onDraftDirtyChange,
  onDraftNavigationRequested,
  className,
}) => {
  const { t } = useTranslation(['practice', 'common', 'exam_sheet', 'learningHub']);
  // 视图偏好持久化：记住用户上次选择的卡片/列表视图
  const [viewType, setViewType] = useState<'grid' | 'list'>(readStoredViewType);
  const [searchQuery, setSearchQuery] = useState('');
  // 防抖后的搜索词：驱动本地过滤 / 后端请求 / 命中高亮
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimerRef = useRef<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<QuestionStatus | 'all'>('all');
  const [difficultyFilter, setDifficultyFilter] = useState<Difficulty | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<QuestionType | 'all'>('all');
  const [showFavoriteOnly, setShowFavoriteOnly] = useState(false);

  // 编辑模式状态（批量操作）
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isOperating, setIsOperating] = useState(false);
  // shift 范围选择锚点（筛选结果内的索引）
  const lastSelectedIndexRef = useRef<number | null>(null);
  
  // 内联二次确认状态（吸底操作条内切换为确认态，不用模态框）
  const [confirmingBatch, setConfirmingBatch] = useState<'delete' | 'reset' | null>(null);

  // 行级快捷操作状态：待确认删除的行（二段式）+ 行内异步操作 loading
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [rowActionLoading, setRowActionLoading] = useState<string | null>(null);
  const armedDeleteTimerRef = useRef<number | null>(null);
  
  // 内联编辑状态（同时只有一个题目展开编辑）
  const [expandedEditId, setExpandedEditId] = useState<string | null>(null);
  const [inlineEditorDirty, setInlineEditorDirty] = useState(false);
  const [pendingEditorAction, setPendingEditorAction] = useState<PendingInlineEditorAction | null>(null);

  // 组件卸载时清理搜索防抖计时器
  useEffect(() => () => {
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current);
    }
    if (armedDeleteTimerRef.current != null) {
      window.clearTimeout(armedDeleteTimerRef.current);
    }
  }, []);
  
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

  const requestInlineEditorDiscard = useCallback((action: PendingInlineEditorAction): boolean => {
    if (expandedEditId && inlineEditorDirty) {
      setPendingEditorAction(action);
      return false;
    }
    return true;
  }, [expandedEditId, inlineEditorDirty]);

  // 本地过滤（仅在不使用后端筛选时）；搜索使用防抖后的关键词
  const filteredQuestions = useMemo(() => {
    if (useBackendFilter) {
      return questions; // 后端筛选模式下，questions 已经是筛选后的结果
    }
    return questions.filter(q => {
      // 搜索过滤
      if (debouncedSearch) {
        const content = (q.content || q.ocrText || '').toLowerCase();
        const label = (q.questionLabel || '').toLowerCase();
        if (!content.includes(debouncedSearch.toLowerCase()) && !label.includes(debouncedSearch.toLowerCase())) {
          return false;
        }
      }
      // 状态过滤
      if (statusFilter !== 'all' && q.status !== statusFilter) {
        return false;
      }
      // 难度过滤
      if (difficultyFilter !== 'all' && q.difficulty !== difficultyFilter) {
        return false;
      }
      // 题型过滤
      if (typeFilter !== 'all' && q.questionType !== typeFilter) {
        return false;
      }
      // 收藏过滤
      if (showFavoriteOnly && !q.isFavorite) {
        return false;
      }
      return true;
    });
  }, [questions, debouncedSearch, statusFilter, difficultyFilter, typeFilter, showFavoriteOnly, useBackendFilter]);

  // ★ 修复：筛选结果变化后旧的 shift 范围选择锚点已失效（索引意义改变），
  // 保留会导致下一次 shift+点击按错误的区间批量选中
  useEffect(() => {
    lastSelectedIndexRef.current = null;
  }, [filteredQuestions]);

  // 数据/筛选变化后行级待确认删除态复位，避免确认按钮落到错误的行
  useEffect(() => {
    setArmedDeleteId(null);
  }, [filteredQuestions]);

  // 当前数据集中出现过的题型（数据驱动：仅展示实际存在的题型 chip；
  // 已激活的题型筛选即使计数归零也保留，避免筛选项凭空消失无法取消）
  const presentTypes = useMemo(() => {
    const present = new Set<string>();
    questions.forEach(q => { if (q.questionType) present.add(q.questionType); });
    if (typeFilter !== 'all') present.add(typeFilter);
    return QUESTION_TYPE_ORDER.filter(type => present.has(type)) as ExtendedQuestionType[];
  }, [questions, typeFilter]);

  // 筛选变更时通知父组件（后端筛选模式）
  // ★ P1 修复：拆分为按维度的独立入口。原先搜索框/收藏按钮复用同一 handleFilterChange
  // 并把当前 statusFilter/difficultyFilter 原样传入，toggle-to-clear 判定恒成立，
  // 导致在搜索框输入任意字符就把已激活的状态/难度筛选悄悄重置为 all。
  const emitFilterChange = useCallback((
    search: string,
    status: QuestionStatus | 'all',
    difficulty: Difficulty | 'all',
    favorite: boolean,
    type: QuestionType | 'all' = 'all',
  ) => {
    if (onFilterChange) {
      onFilterChange({
        search: search || undefined,
        status,
        difficulty: difficulty === 'all' ? undefined : difficulty,
        isFavorite: favorite ? true : undefined,
        questionType: type === 'all' ? undefined : type,
      });
    }
  }, [onFilterChange]);

  // 搜索防抖：输入即时回显，250ms 静默后才触发过滤/后端请求，避免逐字请求竞态
  const applySearchChange = useCallback((newSearch: string) => {
    setSearchQuery(newSearch);
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      setDebouncedSearch(newSearch);
      emitFilterChange(newSearch, statusFilter, difficultyFilter, showFavoriteOnly, typeFilter);
    }, 250);
  }, [emitFilterChange, statusFilter, difficultyFilter, showFavoriteOnly, typeFilter]);

  const handleSearchChange = useCallback((newSearch: string) => {
    const apply = () => applySearchChange(newSearch);
    if (!requestInlineEditorDiscard({ kind: 'callback', run: apply })) return;
    apply();
  }, [applySearchChange, requestInlineEditorDiscard]);

  // 清空按钮：立即生效，不等防抖
  const handleSearchClear = useCallback(() => {
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    setSearchQuery('');
    setDebouncedSearch('');
    emitFilterChange('', statusFilter, difficultyFilter, showFavoriteOnly, typeFilter);
  }, [emitFilterChange, statusFilter, difficultyFilter, showFavoriteOnly, typeFilter]);

  // toggle-to-clear 只作用于用户点击的状态维度
  const applyStatusToggle = useCallback((newStatus: QuestionStatus | 'all') => {
    const finalStatus = (newStatus !== 'all' && newStatus === statusFilter) ? 'all' : newStatus;
    setStatusFilter(finalStatus);
    emitFilterChange(searchQuery, finalStatus, difficultyFilter, showFavoriteOnly, typeFilter);
  }, [emitFilterChange, searchQuery, statusFilter, difficultyFilter, showFavoriteOnly, typeFilter]);

  const handleStatusToggle = useCallback((newStatus: QuestionStatus | 'all') => {
    const apply = () => applyStatusToggle(newStatus);
    if (!requestInlineEditorDiscard({ kind: 'callback', run: apply })) return;
    apply();
  }, [applyStatusToggle, requestInlineEditorDiscard]);

  // toggle-to-clear 只作用于用户点击的难度维度
  const applyDifficultyToggle = useCallback((newDifficulty: Difficulty | 'all') => {
    const finalDifficulty = (newDifficulty !== 'all' && newDifficulty === difficultyFilter) ? 'all' : newDifficulty;
    setDifficultyFilter(finalDifficulty);
    emitFilterChange(searchQuery, statusFilter, finalDifficulty, showFavoriteOnly, typeFilter);
  }, [emitFilterChange, searchQuery, statusFilter, difficultyFilter, showFavoriteOnly, typeFilter]);

  const handleDifficultyToggle = useCallback((newDifficulty: Difficulty | 'all') => {
    const apply = () => applyDifficultyToggle(newDifficulty);
    if (!requestInlineEditorDiscard({ kind: 'callback', run: apply })) return;
    apply();
  }, [applyDifficultyToggle, requestInlineEditorDiscard]);

  const applyFavoriteToggle = useCallback(() => {
    const nextFavorite = !showFavoriteOnly;
    setShowFavoriteOnly(nextFavorite);
    emitFilterChange(searchQuery, statusFilter, difficultyFilter, nextFavorite, typeFilter);
  }, [emitFilterChange, searchQuery, statusFilter, difficultyFilter, showFavoriteOnly, typeFilter]);

  const handleFavoriteToggle = useCallback(() => {
    if (!requestInlineEditorDiscard({ kind: 'callback', run: applyFavoriteToggle })) return;
    applyFavoriteToggle();
  }, [applyFavoriteToggle, requestInlineEditorDiscard]);

  // toggle-to-clear 只作用于用户点击的题型维度
  const applyTypeToggle = useCallback((newType: QuestionType | 'all') => {
    const finalType = (newType !== 'all' && newType === typeFilter) ? 'all' : newType;
    setTypeFilter(finalType);
    emitFilterChange(searchQuery, statusFilter, difficultyFilter, showFavoriteOnly, finalType);
  }, [emitFilterChange, searchQuery, statusFilter, difficultyFilter, showFavoriteOnly, typeFilter]);

  const handleTypeToggle = useCallback((newType: QuestionType | 'all') => {
    const apply = () => applyTypeToggle(newType);
    if (!requestInlineEditorDiscard({ kind: 'callback', run: apply })) return;
    apply();
  }, [applyTypeToggle, requestInlineEditorDiscard]);

  const hasActiveFilters = Boolean(
    searchQuery || statusFilter !== 'all' || difficultyFilter !== 'all' || typeFilter !== 'all' || showFavoriteOnly,
  );

  const applyClearFilters = useCallback(() => {
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    setSearchQuery('');
    setDebouncedSearch('');
    setStatusFilter('all');
    setDifficultyFilter('all');
    setTypeFilter('all');
    setShowFavoriteOnly(false);
    emitFilterChange('', 'all', 'all', false, 'all');
  }, [emitFilterChange]);

  const clearFilters = useCallback(() => {
    if (!requestInlineEditorDiscard({ kind: 'callback', run: applyClearFilters })) return;
    applyClearFilters();
  }, [applyClearFilters, requestInlineEditorDiscard]);

  const handleViewTypeChange = useCallback((nextViewType: 'grid' | 'list') => {
    if (nextViewType === viewType) return;
    const apply = () => {
      setViewType(nextViewType);
      try {
        window.localStorage.setItem(VIEW_TYPE_STORAGE_KEY, nextViewType);
      } catch {
        // localStorage 不可用时静默降级为会话内偏好
      }
    };
    if (!requestInlineEditorDiscard({ kind: 'callback', run: apply })) return;
    apply();
  }, [requestInlineEditorDiscard, viewType]);
  
  const handleQuestionClick = useCallback((index: number) => {
    // ★ 边界修复：筛选结果为空（或索引越界）时「开始做题」不再抛 TypeError
    const target = filteredQuestions[index];
    if (!target) return;
    // 找到原始索引（使用预计算 Map，O(1) 查找）
    const originalIndex = questionIndexMap.get(target.id) ?? index;
    if (expandedEditId && inlineEditorDirty) {
      if (onDraftNavigationRequested) {
        onDraftNavigationRequested(originalIndex);
        return;
      }
      setPendingEditorAction({ kind: 'question', index: originalIndex });
      return;
    }
    onQuestionClick?.(originalIndex);
  }, [expandedEditId, filteredQuestions, inlineEditorDirty, onDraftNavigationRequested, onQuestionClick, questionIndexMap]);

  useEffect(() => {
    onDraftDirtyChange?.(inlineEditorDirty);
  }, [inlineEditorDirty, onDraftDirtyChange]);

  useEffect(() => () => onDraftDirtyChange?.(false), [onDraftDirtyChange]);
  
  // ★ 修复：题目列表变化（外部删除/筛选后刷新）时清理失效的选中 id，
  // 避免吸底操作条显示过期的选中数量、批量操作携带不存在的 id
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const validIds = new Set(questions.map(q => q.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach(id => {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [questions]);

  // 选中集合变化后，待确认的批量操作自动失效（防止确认条针对旧选择执行）
  useEffect(() => {
    if (selectedIds.size === 0) setConfirmingBatch(null);
  }, [selectedIds]);

  // 切换选中状态；shift+点击时以上次点击为锚点做范围选择
  const toggleSelect = useCallback((id: string, selected: boolean, shiftKey: boolean, listIndex: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const anchor = lastSelectedIndexRef.current;
      if (shiftKey && anchor != null && anchor !== listIndex) {
        const [from, to] = anchor < listIndex ? [anchor, listIndex] : [listIndex, anchor];
        for (let i = from; i <= to; i++) {
          const q = filteredQuestions[i];
          if (!q) continue;
          if (selected) {
            next.add(q.id);
          } else {
            next.delete(q.id);
          }
        }
      } else if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    lastSelectedIndexRef.current = listIndex;
  }, [filteredQuestions]);
  
  // ★ 修复：全选判定改为「当前筛选结果是否全部选中」，
  // 原先按 size 相等比较，在选中项包含筛选外题目时会误判
  const allFilteredSelected = filteredQuestions.length > 0 && filteredQuestions.every(q => selectedIds.has(q.id));

  // 全选/取消全选（作用于当前筛选结果）
  const toggleSelectAll = useCallback(() => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredQuestions.map(q => q.id)));
    }
    lastSelectedIndexRef.current = null;
  }, [allFilteredSelected, filteredQuestions]);

  // 反选（作用于当前筛选结果）
  const invertSelection = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set<string>();
      filteredQuestions.forEach(q => {
        if (!prev.has(q.id)) next.add(q.id);
      });
      return next;
    });
    lastSelectedIndexRef.current = null;
  }, [filteredQuestions]);
  
  // 批量删除：第一次点击进入内联确认态，确认后执行
  const handleBatchDeleteClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setConfirmingBatch('delete');
  }, [selectedIds.size]);
  
  const handleBatchDeleteConfirm = useCallback(async () => {
    if (!onDelete || selectedIds.size === 0) return;
    setConfirmingBatch(null);
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
  }, [onDelete, selectedIds, t]);
  
  // 批量重置进度：内联确认
  const handleBatchResetClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setConfirmingBatch('reset');
  }, [selectedIds.size]);
  
  const handleBatchResetConfirm = useCallback(async () => {
    if (!onResetProgress || selectedIds.size === 0) return;
    setConfirmingBatch(null);
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
  }, [onResetProgress, selectedIds, t]);
  
  // 退出编辑模式
  const exitEditMode = useCallback(() => {
    setIsEditMode(false);
    setSelectedIds(new Set());
    setConfirmingBatch(null);
    lastSelectedIndexRef.current = null;
  }, []);

  // 行级收藏切换（hover 快捷操作）
  const handleRowToggleFavorite = useCallback(async (questionId: string) => {
    if (!onToggleFavorite) return;
    setRowActionLoading(`favorite:${questionId}`);
    try {
      await onToggleFavorite(questionId);
    } catch (err: unknown) {
      console.error('[QuestionBankListView] toggle favorite failed:', err);
      showGlobalNotification('error', `${t('exam_sheet:questionBank.favoriteUpdateFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRowActionLoading(null);
    }
  }, [onToggleFavorite, t]);

  // 行级删除：二段式确认 —— 首次点击进入待确认态（按钮变红），
  // 3 秒无操作自动复位；再次点击才真正删除
  const handleRowDeleteAction = useCallback(async (questionId: string) => {
    if (!onDelete) return;
    if (armedDeleteId !== questionId) {
      setArmedDeleteId(questionId);
      if (armedDeleteTimerRef.current != null) {
        window.clearTimeout(armedDeleteTimerRef.current);
      }
      armedDeleteTimerRef.current = window.setTimeout(() => {
        armedDeleteTimerRef.current = null;
        setArmedDeleteId(null);
      }, 3000);
      return;
    }
    if (armedDeleteTimerRef.current != null) {
      window.clearTimeout(armedDeleteTimerRef.current);
      armedDeleteTimerRef.current = null;
    }
    setRowActionLoading(`delete:${questionId}`);
    try {
      await onDelete([questionId]);
      showGlobalNotification('success', t('practice:questionBank.deleteSuccess', { count: 1 }));
    } catch (err: unknown) {
      console.error('[QuestionBankListView] row delete failed:', err);
      showGlobalNotification('error', `${t('practice:questionBank.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRowActionLoading(null);
      setArmedDeleteId(null);
    }
  }, [onDelete, armedDeleteId, t]);

  // 放弃未保存草稿并继续被拦截的操作（内联确认条的「放弃并继续」）
  const confirmPendingEditorAction = useCallback(() => {
    const action = pendingEditorAction;
    setPendingEditorAction(null);
    setInlineEditorDirty(false);
    if (!action) return;
    if (action.kind === 'edit') {
      setExpandedEditId(action.id);
    } else if (action.kind === 'question') {
      setExpandedEditId(null);
      onQuestionClick?.(action.index);
    } else {
      setExpandedEditId(null);
      action.run();
    }
  }, [pendingEditorAction, onQuestionClick]);
  
  const requestInlineEditorTarget = useCallback((nextId: string | null) => {
    if (!requestInlineEditorDiscard({ kind: 'edit', id: nextId })) return;
    setExpandedEditId(nextId);
  }, [requestInlineEditorDiscard]);

  // 外部（Tab 栏「添加题目」菜单）请求打开内联创建编辑器。
  // 父级 requestViewMode 已统一处理草稿确认（确认后才递增 key），
  // 这里直接定位并复位内部编辑状态，不再走内部守卫，避免空态下弹不出二次确认
  const lastCreateRequestKeyRef = useRef(createRequestKey ?? 0);
  useEffect(() => {
    if (createRequestKey == null || createRequestKey === lastCreateRequestKeyRef.current) return;
    lastCreateRequestKeyRef.current = createRequestKey;
    if (examId && onCreateQuestion) {
      setPendingEditorAction(null);
      setInlineEditorDirty(false);
      setExpandedEditId('__new__');
    }
  }, [createRequestKey, examId, onCreateQuestion]);

  // 展开内联编辑
  const handleEditQuestion = useCallback((question: Question) => {
    requestInlineEditorTarget(expandedEditId === question.id ? null : question.id);
  }, [expandedEditId, requestInlineEditorTarget]);

  const closeInlineEditor = useCallback(() => {
    setExpandedEditId(null);
    setInlineEditorDirty(false);
  }, []);
  
  // 保存编辑（QuestionInlineEditor 内部已通过 onCancel 收起，此处仅负责回调）
  const handleSaveQuestion = useCallback(async (updatedQuestion: Question) => {
    if (onUpdateQuestion) {
      await onUpdateQuestion(updatedQuestion);
    }
  }, [onUpdateQuestion]);
  
  if (isLoading && questions.length === 0) {
    // 加载骨架：模拟工具行 + 列表行结构，与管理视图同款，避免整屏转圈闪切
    return (
      <div className={cn('h-full overflow-hidden px-3 sm:px-4 py-3', className)} role="status" aria-busy>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 flex-1 rounded-md" />
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-7 w-7 rounded-md" />
        </div>
        <div className="mt-3 space-y-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-lg border border-border/40 px-3 py-3">
              <Skeleton className="h-4" style={{ width: `${[72, 58, 84, 64, 76, 52][i]}%` }} />
              <div className="mt-2.5 flex items-center gap-2">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 空状态：启动台 —— 手动新建 / 识别导入 / CSV 导入，整页可拖入文件
  if (questions.length === 0) {
    const canCreate = Boolean(examId && onCreateQuestion);
    const canImport = Boolean(onUploadQuestions);
    const canCsvImport = Boolean(onCsvImport);
    const hasLauncherActions = canCreate || canImport || canCsvImport;
    const showCreateEditor = expandedEditId === '__new__' && canCreate;

    const launcher = showCreateEditor ? (
      // 编辑器打开：隐藏启动台头部；容器收敛高度，滚动交给编辑器内容区（页脚钉底）
      <div className={cn('flex h-full flex-col px-3 py-4 sm:px-4', className)}>
        <div className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col">
          <QuestionInlineEditor
            question={null}
            mode="create"
            examId={examId!}
            onCreate={async (question) => {
              await onCreateQuestion?.(question);
              closeInlineEditor();
            }}
            onCancel={closeInlineEditor}
            onDirtyChange={setInlineEditorDirty}
          />
        </div>
      </div>
    ) : (
      <CustomScrollArea
        className={cn('h-full', className)}
        viewportClassName="flex min-h-full flex-col items-center justify-center px-4 py-10"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/60">
            <ExamIcon size={28} className="opacity-80" />
          </div>
          <h3 className="mb-1.5 text-base font-medium">{t('practice:questionBank.emptyTitle')}</h3>
          <p className="text-sm text-muted-foreground">
            {hasLauncherActions
              ? t('practice:questionBank.emptyChoosePath')
              : t('practice:questionBank.emptyReadOnlyDesc')}
          </p>
        </div>

        {hasLauncherActions && (
          <>
            <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-3">
              {canCreate && (
                <LauncherCard
                  icon={<Plus size={18} />}
                  title={t('exam_sheet:questionBank.create.title')}
                  desc={t('practice:questionBank.emptyCreateDesc')}
                  onClick={() => requestInlineEditorTarget('__new__')}
                />
              )}
              {canImport && (
                <LauncherCard
                  icon={<Scan size={18} />}
                  title={t('exam_sheet:questionBank.import')}
                  desc={t('practice:questionBank.emptyImportDesc')}
                  onClick={() => onUploadQuestions?.()}
                />
              )}
              {canCsvImport && (
                <LauncherCard
                  icon={<TableIcon size={18} />}
                  title={t('exam_sheet:csv.import_title')}
                  desc={t('practice:questionBank.emptyCsvDesc')}
                  onClick={() => onCsvImport?.()}
                />
              )}
            </div>
            {canImport && onUploadFiles && (
              <p className="mt-6 text-xs text-muted-foreground/80">
                {t('practice:questionBank.emptyDropHint')}
              </p>
            )}
          </>
        )}
      </CustomScrollArea>
    );

    // 整个启动台都是拖放目标：拖入文件直接进入识别导入流程
    if (canImport && onUploadFiles) {
      return (
        <UnifiedDragDropZone
          zoneId={`qbank-launcher-${examId ?? 'default'}`}
          onFilesDropped={onUploadFiles}
          acceptedFileTypes={[EXAM_IMAGE_TYPE, EXAM_DOCUMENT_TYPE]}
          maxFiles={20}
          maxFileSize={50 * 1024 * 1024}
          showOverlay
          className="h-full"
        >
          {launcher}
        </UnifiedDragDropZone>
      );
    }
    return launcher;
  }
  
  return (
    <div className={cn('flex flex-col h-full', className)} aria-busy={isLoading}>
      {/* 桌面端：统计摘要 */}
      {stats && (
        <div className="flex-shrink-0 px-4 py-4 border-b border-border/40 hidden sm:block">
          <StatsSummary stats={stats} onStartPractice={() => handleQuestionClick(0)} />
        </div>
      )}
      {/* 移动端：紧凑单行统计 */}
      {stats && (
        <div className="flex sm:hidden flex-shrink-0 items-center justify-between gap-2 px-3 py-2 border-b border-border/40 text-xs">
          <span className="text-muted-foreground tabular-nums">
            {t('practice:questionBank.all')} {stats.total}
          </span>
          <span className="flex items-center gap-1 text-success tabular-nums">
            <span className="w-1.5 h-1.5 rounded-full bg-success" aria-hidden="true" />
            {t('practice:questionBank.masteredFilter')} {stats.mastered}
          </span>
          <span className="flex items-center gap-1 text-warning tabular-nums">
            <span className="w-1.5 h-1.5 rounded-full bg-warning" aria-hidden="true" />
            {t('practice:questionBank.needsReview')} {stats.review}
          </span>
          <DsButton
            variant="primary"
            size="sm"
            onClick={() => handleQuestionClick(0)}
            className="!h-8 !px-2.5 !py-0 text-xs gap-1"
          >
            <Play size={12} weight="fill" />
            {t('practice:questionBank.startPractice')}
          </DsButton>
        </div>
      )}
      
      {/* 搜索和视图切换 */}
      <div className="flex-shrink-0 px-3 sm:px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t('practice:questionBank.searchPlaceholder')}
              className={cn(
                'pl-9 h-8 sm:h-9 bg-muted/30 border-transparent focus:border-border focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors text-sm',
                '[&::-webkit-search-cancel-button]:hidden',
                (searchQuery || isLoading) && 'pr-8'
              )}
            />
            {isLoading ? (
              <CircleNotch
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
                aria-label={t('common:loading')}
              />
            ) : searchQuery ? (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={handleSearchClear}
                className="!absolute !right-1.5 !top-1/2 !-translate-y-1/2 !h-5 !w-5 !p-0 [@media(pointer:coarse)]:!h-8 [@media(pointer:coarse)]:!w-8 text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
                aria-label={t('learningHub:exam.library.clearSearch')}
                title={t('learningHub:exam.library.clearSearch')}
              >
                <X size={12} />
              </DsButton>
            ) : null}
          </div>
          
          <div className="flex items-center p-0.5 rounded-md bg-muted/30 flex-shrink-0">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => handleViewTypeChange('grid')}
              className={cn('ui-state-colors h-7 w-7 p-0 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9', viewType === 'grid' && 'bg-background shadow-sm')}
              aria-label={t('learningHub:exam.library.gridView')}
              title={t('learningHub:exam.library.gridView')}
            >
              <GridNine size={14} />
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => handleViewTypeChange('list')}
              className={cn('ui-state-colors h-7 w-7 p-0 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9', viewType === 'list' && 'bg-background shadow-sm')}
              aria-label={t('learningHub:exam.library.listView')}
              title={t('learningHub:exam.library.listView')}
            >
              <List size={14} />
            </DsButton>
          </div>
          
          {/* 收藏和书签按钮 */}
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleFavoriteToggle} className={cn('!h-7 !w-7 !p-1.5 [@media(pointer:coarse)]:!h-9 [@media(pointer:coarse)]:!w-9 flex-shrink-0', showFavoriteOnly ? 'bg-warning/20 text-warning' : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]')} aria-label="favorites">
            <Star className={cn('w-4 h-4', showFavoriteOnly && 'fill-current')} />
          </DsButton>

          {/* 手动添加题目按钮 */}
          {examId && onCreateQuestion && (
            <DsButton variant="ghost" size="icon" iconOnly onClick={() => requestInlineEditorTarget(expandedEditId === '__new__' ? null : '__new__')} className={cn('!h-7 !w-7 !p-1.5 [@media(pointer:coarse)]:!h-9 [@media(pointer:coarse)]:!w-9 flex-shrink-0', expandedEditId === '__new__' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]')} aria-label="add question">
              <Plus size={16} />
            </DsButton>
          )}

          {/* 编辑模式按钮 */}
          {hasBatchOperations && !isEditMode && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                const openBatchMode = () => setIsEditMode(true);
                if (!requestInlineEditorDiscard({ kind: 'callback', run: openBatchMode })) return;
                openBatchMode();
              }}
              className="!h-7 !px-2 !py-1 [@media(pointer:coarse)]:!h-9 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] flex-shrink-0"
              aria-label="batch manage"
            >
              <ListChecks size={14} className="mr-1" />
              <span className="hidden sm:inline">{t('exam_sheet:questionBank.manage')}</span>
            </DsButton>
          )}
        </div>
        
        {/* 未保存草稿的内联确认条（替代原模态确认框） */}
        {pendingEditorAction !== null && (
          <div
            role="alert"
            className="ui-drop-in mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
          >
            <Warning size={15} className="flex-shrink-0 text-warning" />
            <span className="min-w-0 flex-1 text-xs text-foreground">
              {t('learningHub:exam.library.unsavedDraftInline')}
            </span>
            <div className="flex items-center gap-1.5">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => setPendingEditorAction(null)}
                className="!h-auto !px-2 !py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
              >
                {t('learningHub:exam.library.keepEditing')}
              </DsButton>
              <DsButton
                variant="danger"
                size="sm"
                onClick={confirmPendingEditorAction}
                className="!h-auto !px-2 !py-1 text-xs"
              >
                {t('learningHub:exam.library.discardAndContinue')}
              </DsButton>
            </div>
          </div>
        )}
        
        {/* 筛选 Tab — ui-state-colors 让选中态颜色平滑过渡；
            激活中的筛选即使计数归零也保留 chip，避免筛选项凭空消失无法取消 */}
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          <DsButton variant="ghost" size="sm" onClick={() => handleStatusToggle('all')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'all' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]')}>
            {t('practice:questionBank.all')} {questions.length}
          </DsButton>
          {stats && (stats.newCount > 0 || statusFilter === 'new') && (
            <DsButton variant="ghost" size="sm" onClick={() => handleStatusToggle('new')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'new' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]')}>
              {t('practice:questionBank.newQuestions')} {stats.newCount}
            </DsButton>
          )}
          {stats && (stats.review > 0 || statusFilter === 'review') && (
            <DsButton variant="ghost" size="sm" onClick={() => handleStatusToggle('review')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'review' ? 'bg-accent text-accent-foreground font-medium' : 'text-warning hover:bg-warning/10')}>
              {t('practice:questionBank.needsReview')} {stats.review}
            </DsButton>
          )}
          {stats && (stats.mastered > 0 || statusFilter === 'mastered') && (
            <DsButton variant="ghost" size="sm" onClick={() => handleStatusToggle('mastered')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', statusFilter === 'mastered' ? 'bg-accent text-accent-foreground font-medium' : 'text-success hover:bg-success/10')}>
              {t('practice:questionBank.masteredFilter')} {stats.mastered}
            </DsButton>
          )}

          <div className="w-px h-3 bg-border/60 mx-1" />

          <DsButton variant="ghost" size="sm" onClick={() => handleDifficultyToggle('easy')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', difficultyFilter === 'easy' ? 'bg-accent text-accent-foreground font-medium' : 'text-success hover:bg-success/10')}>
            {t('practice:questionBank.difficultyShort.easy')}
          </DsButton>
          <DsButton variant="ghost" size="sm" onClick={() => handleDifficultyToggle('medium')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', difficultyFilter === 'medium' ? 'bg-accent text-accent-foreground font-medium' : 'text-warning hover:bg-warning/10')}>
            {t('practice:questionBank.difficultyShort.medium')}
          </DsButton>
          <DsButton variant="ghost" size="sm" onClick={() => handleDifficultyToggle('hard')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', difficultyFilter === 'hard' ? 'bg-accent text-accent-foreground font-medium' : 'text-warning hover:bg-warning/10')}>
            {t('practice:questionBank.difficultyShort.hard')}
          </DsButton>
          <DsButton variant="ghost" size="sm" onClick={() => handleDifficultyToggle('very_hard')} className={cn('ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs', difficultyFilter === 'very_hard' ? 'bg-accent text-accent-foreground font-medium' : 'text-destructive hover:bg-destructive/10')}>
            {t('practice:questionBank.difficultyShort.veryHard')}
          </DsButton>

          {/* 题型筛选（数据驱动：仅展示当前数据集中出现过的题型，含新题型） */}
          {presentTypes.length >= 2 && (
            <>
              <div className="w-px h-3 bg-border/60 mx-1" />
              {presentTypes.map((type) => {
                const meta = getQuestionTypeMeta(type);
                return (
                  <DsButton
                    key={type}
                    variant="ghost"
                    size="sm"
                    onClick={() => handleTypeToggle(type as QuestionType)}
                    className={cn(
                      'ui-state-colors !h-auto !px-2 !py-1 !rounded-md text-xs',
                      typeFilter === type
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                    )}
                    aria-pressed={typeFilter === type}
                  >
                    {t(meta.labelKey)}
                  </DsButton>
                );
              })}
            </>
          )}
        </div>

        {/* 激活筛选条件 chip：每个条件可单独移除，一键清除全部 */}
        {hasActiveFilters && (
          <div className="ui-drop-in flex flex-wrap items-center gap-1.5 mt-2">
            {debouncedSearch && (
              <FilterChip
                label={t('learningHub:exam.library.filterSearchChip', { query: debouncedSearch })}
                onRemove={handleSearchClear}
              />
            )}
            {statusFilter !== 'all' && (
              <FilterChip
                label={t(`practice:${STATUS_CONFIG[statusFilter].labelKey}`)}
                onRemove={() => handleStatusToggle(statusFilter)}
              />
            )}
            {difficultyFilter !== 'all' && (
              <FilterChip
                label={t(`practice:${DIFFICULTY_CONFIG[difficultyFilter].labelKey}`)}
                onRemove={() => handleDifficultyToggle(difficultyFilter)}
              />
            )}
            {typeFilter !== 'all' && (
              <FilterChip
                label={t(getQuestionTypeMeta(typeFilter).labelKey)}
                onRemove={() => handleTypeToggle(typeFilter)}
              />
            )}
            {showFavoriteOnly && (
              <FilterChip
                label={t('learningHub:exam.library.filterFavoriteChip')}
                onRemove={handleFavoriteToggle}
              />
            )}
            <DsButton
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="!h-auto !px-2 !py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
            >
              {t('learningHub:exam.library.clearAllFilters')}
            </DsButton>
          </div>
        )}
      </div>
      
      <CustomScrollArea className="flex-1" viewportClassName="px-3 sm:px-4 pt-1 pb-4">
        {/* 新题目内联创建区域（置顶） */}
        {expandedEditId === '__new__' && examId && (
          <div className="pb-2 ui-rise-in">
            <QuestionInlineEditor
              question={null}
              mode="create"
              examId={examId}
              onCreate={async (q) => {
                await onCreateQuestion?.(q);
                showGlobalNotification('success', t('learningHub:exam.library.createSuccess'));
                closeInlineEditor();
              }}
              onCancel={closeInlineEditor}
              onDirtyChange={setInlineEditorDirty}
/>
          </div>
        )}

        {filteredQuestions.length === 0 ? (
          <div className="ui-rise-in flex flex-col items-center justify-center py-16 text-muted-foreground">
            <MagnifyingGlass size={28} className="mb-3 opacity-40" />
            <p className="text-sm">
              {debouncedSearch
                ? t('learningHub:exam.library.noMatchFor', { query: debouncedSearch })
                : t('practice:questionBank.noMatch')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">{t('learningHub:exam.library.noMatchHint')}</p>
            {hasActiveFilters && (
              <DsButton variant="ghost" size="sm" className="mt-3" onClick={clearFilters}>
                <X size={14} />
                {t('common:clear')}
              </DsButton>
            )}
          </div>
        ) : viewType === 'grid' ? (
          // key=viewType：切换视图时整体重挂载，触发 stagger 淡入形成平滑过渡
          <div key="grid" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-2">
            {filteredQuestions.map((q, idx) => (
              <React.Fragment key={q.id}>
                <QuestionGridCard
                  question={q}
                  index={questionIndexMap.get(q.id) ?? 0}
                  listIndex={idx}
                  highlight={debouncedSearch}
                  onClick={() => handleQuestionClick(idx)}
                  onEdit={onUpdateQuestion ? () => handleEditQuestion(q) : undefined}
                  onToggleFavorite={onToggleFavorite ? () => void handleRowToggleFavorite(q.id) : undefined}
                  favoriteLoading={rowActionLoading === `favorite:${q.id}`}
                  onDeleteAction={onDelete ? () => void handleRowDeleteAction(q.id) : undefined}
                  deleteArmed={armedDeleteId === q.id}
                  deleteLoading={rowActionLoading === `delete:${q.id}`}
                  isEditMode={isEditMode}
                  isSelected={selectedIds.has(q.id)}
                  onSelect={(selected, shiftKey) => toggleSelect(q.id, selected, shiftKey, idx)}
/>
                {expandedEditId === q.id && (
                  <div className="col-span-full ui-rise-in">
                    <QuestionInlineEditor
                      question={q}
                      onSave={handleSaveQuestion}
                      onCancel={closeInlineEditor}
                      onDirtyChange={setInlineEditorDirty}
/>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        ) : (
          <div key="list" className="space-y-0.5">
            {filteredQuestions.map((q, idx) => (
              <React.Fragment key={q.id}>
                <QuestionListRow
                  question={q}
                  index={questionIndexMap.get(q.id) ?? 0}
                  listIndex={idx}
                  highlight={debouncedSearch}
                  onClick={() => handleQuestionClick(idx)}
                  onEdit={onUpdateQuestion ? () => handleEditQuestion(q) : undefined}
                  onToggleFavorite={onToggleFavorite ? () => void handleRowToggleFavorite(q.id) : undefined}
                  favoriteLoading={rowActionLoading === `favorite:${q.id}`}
                  onDeleteAction={onDelete ? () => void handleRowDeleteAction(q.id) : undefined}
                  deleteArmed={armedDeleteId === q.id}
                  deleteLoading={rowActionLoading === `delete:${q.id}`}
                  isEditMode={isEditMode}
                  isSelected={selectedIds.has(q.id)}
                  onSelect={(selected, shiftKey) => toggleSelect(q.id, selected, shiftKey, idx)}
/>
                {expandedEditId === q.id && (
                  <div className="ui-rise-in">
                    <QuestionInlineEditor
                      question={q}
                      onSave={handleSaveQuestion}
                      onCancel={closeInlineEditor}
                      onDirtyChange={setInlineEditorDirty}
/>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </CustomScrollArea>
      
      {/* 批量管理吸底操作条：全选/反选、选中数量、内联二次确认（不用模态框） */}
      {isEditMode && (
        <div className="ui-slide-up-panel flex-shrink-0 border-t border-border/50 bg-background/95 px-3 sm:px-4 pt-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]">
          {confirmingBatch !== null ? (
            <div
              role="alert"
              className={cn(
                'ui-drop-in flex flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5',
                confirmingBatch === 'delete' ? 'border-destructive/30 bg-destructive/5' : 'border-warning/30 bg-warning/10'
              )}
            >
              <Warning size={15} className={cn('flex-shrink-0', confirmingBatch === 'delete' ? 'text-destructive' : 'text-warning')} />
              <span className="min-w-0 flex-1 text-xs text-foreground">
                {confirmingBatch === 'delete'
                  ? t('learningHub:exam.library.confirmDeleteInline', { count: selectedIds.size })
                  : t('learningHub:exam.library.confirmResetInline', { count: selectedIds.size })}
              </span>
              <div className="flex items-center gap-1.5">
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingBatch(null)}
                  className="!h-auto !px-2 !py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
                >
                  {t('common:cancel')}
                </DsButton>
                <DsButton
                  variant={confirmingBatch === 'delete' ? 'danger' : 'warning'}
                  size="sm"
                  disabled={isOperating}
                  onClick={() => {
                    if (confirmingBatch === 'delete') {
                      void handleBatchDeleteConfirm();
                    } else {
                      void handleBatchResetConfirm();
                    }
                  }}
                  className="!h-auto !px-2.5 !py-1 text-xs"
                >
                  {isOperating && <CircleNotch size={12} className="animate-spin" />}
                  {t('learningHub:exam.library.confirm')}
                </DsButton>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              {/* 触屏（pointer:coarse）批量操作按钮放大到 44px 触控目标 */}
              <div className="flex items-center gap-1 min-w-0">
                <DsButton variant="ghost" size="sm" onClick={toggleSelectAll} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]">
                  <CheckSquare size={14} />
                  <span className="hidden sm:inline">{allFilteredSelected ? t('practice:questionBank.deselectAll') : t('practice:questionBank.selectAll')}</span>
                </DsButton>
                <DsButton variant="ghost" size="sm" onClick={invertSelection} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]">
                  <SelectionInverse size={14} />
                  <span className="hidden sm:inline">{t('learningHub:exam.library.invertSelection')}</span>
                </DsButton>
                <span className="text-xs text-muted-foreground whitespace-nowrap px-1">
                  {t('practice:questionBank.selectedCount', { count: selectedIds.size })}
                </span>
                <span className="hidden lg:inline text-[11px] text-muted-foreground/60 whitespace-nowrap">
                  {t('learningHub:exam.library.shiftRangeHint')}
                </span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {onResetProgress && (
                  <DsButton variant="ghost" size="sm" onClick={handleBatchResetClick} disabled={isOperating || selectedIds.size === 0} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!px-3 text-xs text-primary hover:bg-primary/10">
                    <ArrowClockwise className={cn('w-3 h-3', isOperating && 'animate-spin')} />
                    <span className="hidden sm:inline">{t('practice:questionBank.reset')}</span>
                  </DsButton>
                )}
                {onDelete && (
                  <DsButton variant="ghost" size="sm" onClick={handleBatchDeleteClick} disabled={isOperating || selectedIds.size === 0} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!px-3 text-xs text-destructive hover:bg-destructive/10">
                    <Trash size={12} />
                    <span className="hidden sm:inline">{t('common:delete')}</span>
                  </DsButton>
                )}
                <div className="w-px h-3 bg-border/60 mx-1" />
                <DsButton variant="ghost" size="sm" onClick={exitEditMode} className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] gap-1">
                  <X size={12} />
                  <span className="hidden sm:inline">{t('common:cancel')}</span>
                </DsButton>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default QuestionBankListView;
