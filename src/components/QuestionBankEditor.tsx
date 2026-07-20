import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '../lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent, CardHeader } from './ui/shad/Card';
import { Badge } from './ui/shad/Badge';
import { Progress } from './ui/shad/Progress';
import { AppSelect } from './ui/app-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/shad/Popover';
import { Input } from './ui/shad/Input';
import { Textarea } from './ui/shad/Textarea';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useQbankAiGrading } from '@/hooks/useQbankAiGrading';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { formatTime } from '@/utils/formatUtils';
import { MarkdownRenderer, StreamingMarkdownRenderer } from '@/features/chat/components/renderers';
import { LatexText } from '@/components/LatexText';
import { ImageCropDialog } from '@/components/ImageCropDialog';
import DsAnalysisIconMuted from '@/components/icons/DsAnalysisIconMuted';
import {
  CaretLeft,
  CaretRight,
  CaretDown,
  CaretUp,
  Check,
  X,
  Shuffle,
  ListNumbers,
  ArrowCounterClockwise,
  Tag,
  CircleNotch,
  BookOpen,
  Target,
  TrendUp,
  WarningCircle,
  Lightbulb,
  PaperPlaneRight,
  Clock,
  Star,
  GearSix,
  Crosshair,
  ArrowClockwise,
  Note,
  MagnifyingGlass,
  Flame,
  Trophy,
  Eye,
  EyeSlash,
  Sparkle,
  Confetti,
  Keyboard,
  Crop,
  ImageIcon,
  Trash,
} from '@phosphor-icons/react';

import type {
  QuestionType,
  QuestionStatus,
  Difficulty,
  PracticeMode,
  QuestionImage,
  Question,
  QuestionBankStats,
  SubmitResult,
} from '@/api/questionBankApi';
import { getNextQuestionIndex, parseNumericInput } from '@/api/questionBankApi';
import {
  type ExtendedQuestionType,
  type MatchingPair,
  getQuestionStructuredData,
  parseMatchingData,
  parseOrderingData,
  parseNumericData,
  parseFillBlankData,
  encodeMatchingUserAnswer,
  encodeOrderingUserAnswer,
  encodeFillBlankUserAnswer,
  TrueFalseAnswer,
  MatchingAnswer,
  OrderingAnswer,
  NumericAnswer,
  FillBlankAnswer,
  StructuredAnswerSummary,
} from '@/components/question-types';

export interface QuestionBankEditorProps {
  sessionId: string;
  questions: Question[];
  stats?: QuestionBankStats;
  currentIndex?: number;
  isLoading?: boolean;
  error?: string | null;
  /** 编辑模式（true=编辑题目信息，false=做题模式） */
  editMode?: boolean;
  /** 练习模式（从 store 传入，SSOT） */
  practiceMode?: PracticeMode;
  /** 当前标签（用于按标签练习的同步） */
  selectedTag?: string;
  onSubmitAnswer?: (questionId: string, answer: string, questionType?: QuestionType) => Promise<SubmitResult>;
  onNavigate?: (index: number) => void;
  onModeChange?: (mode: PracticeMode, tag?: string) => void;
  onMarkCorrect?: (questionId: string, isCorrect: boolean) => Promise<void>;
  onRefreshQuestion?: (questionId: string) => Promise<void>;
  onToggleFavorite?: (questionId: string, isFavorite: boolean) => Promise<void>;
  /** 编辑模式：删除题目 */
  onDeleteQuestion?: (questionId: string) => Promise<void>;
  onBack?: () => void;
  className?: string;
  showTimer?: boolean;
  timerDuration?: number;
  timerElapsedSeconds?: number;
  timerRunning?: boolean;
  onTimerRunningChange?: (running: boolean) => void;
  allowTimerControl?: boolean;
  /** 专注模式：隐藏统计卡片和标签，聚焦刷题 */
  focusMode?: boolean;
  onFocusModeChange?: (focusMode: boolean) => void;
  /** 设置侧栏（受控时由宿主维护，便于工作区 action 精确开关） */
  settingsPanelOpen?: boolean;
  onSettingsPanelOpenChange?: (open: boolean) => void;
  /** 暗记模式：遮挡答案区域 */
  hideAnswerMode?: boolean;
  onHideAnswerModeChange?: (hideMode: boolean) => void;
  /** 更新用户笔记 */
  onUpdateUserNote?: (questionId: string, note: string) => Promise<void>;
  /** Reports answer/note drafts to an owning resource view. */
  onDraftDirtyChange?: (dirty: boolean) => void;
  /** Lets an owning resource view confirm an externally-triggered navigation. */
  onDraftNavigationRequested?: (targetIndex: number) => void;
  /** ★ 标签页：当前面板是否为活跃标签页（控制计时器暂停） */
  isActive?: boolean;
}

const DIFFICULTY_CONFIG: Record<Difficulty, { color: string; bg: string }> = {
  easy: { color: 'text-success', bg: 'bg-success/10' },
  medium: { color: 'text-warning', bg: 'bg-warning/10' },
  hard: { color: 'text-warning', bg: 'bg-warning/10' },
  very_hard: { color: 'text-destructive', bg: 'bg-destructive/10' },
};

const STATUS_CONFIG: Record<QuestionStatus, { color: string }> = {
  new: { color: 'text-muted-foreground' },
  in_progress: { color: 'text-primary' },
  mastered: { color: 'text-success' },
  review: { color: 'text-warning' },
};

const MODE_ICON: Record<PracticeMode, React.ElementType> = {
  sequential: ListNumbers,
  random: Shuffle,
  review_first: ArrowCounterClockwise,
  review_only: ArrowCounterClockwise,
  by_tag: Tag,
  timed: Clock,
  mock_exam: BookOpen,
  daily: Target,
  paper: Target,
};

/** Maps snake_case PracticeMode to camelCase i18n key */
const MODE_I18N_KEY: Record<PracticeMode, string> = {
  sequential: 'sequential',
  random: 'random',
  review_first: 'reviewFirst',
  review_only: 'reviewOnly',
  by_tag: 'byTag',
  timed: 'timed',
  mock_exam: 'mockExam',
  daily: 'daily',
  paper: 'paper',
};

/** Maps snake_case Difficulty to camelCase i18n key */
const DIFFICULTY_I18N_KEY: Record<Difficulty, string> = {
  easy: 'easy',
  medium: 'medium',
  hard: 'hard',
  very_hard: 'veryHard',
};

/** Maps snake_case QuestionStatus to camelCase i18n key */
const STATUS_I18N_KEY: Record<QuestionStatus, string> = {
  new: 'new',
  in_progress: 'inProgress',
  mastered: 'mastered',
  review: 'review',
};

/** Maps snake_case QuestionType to camelCase i18n key */
const QUESTION_TYPE_I18N_KEY: Record<ExtendedQuestionType, string> = {
  single_choice: 'singleChoice',
  multiple_choice: 'multipleChoice',
  indefinite_choice: 'indefiniteChoice',
  fill_blank: 'fillBlank',
  short_answer: 'shortAnswer',
  essay: 'essay',
  calculation: 'calculation',
  proof: 'proof',
  other: 'other',
  true_false: 'trueFalse',
  matching: 'matching',
  ordering: 'ordering',
  numeric: 'numeric',
};

/**
 * 做题视图共享动效关键帧。
 * scale / translate 使用独立属性（与 ui-motion.css 一致），不覆盖 inline transform。
 */
const QBANK_KEYFRAMES = `
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes qbankPopIn {
    0% { scale: 0.4; opacity: 0; }
    60% { scale: 1.18; opacity: 1; }
    100% { scale: 1; opacity: 1; }
  }
  @keyframes qbankShake {
    0%, 100% { translate: 0 0; }
    20% { translate: -4px 0; }
    40% { translate: 4px 0; }
    60% { translate: -3px 0; }
    80% { translate: 3px 0; }
  }
  .qbank-anim-pop {
    animation: qbankPopIn 320ms var(--dropdown-ease, cubic-bezier(0.22, 1, 0.36, 1)) both;
  }
  .qbank-anim-shake {
    animation: qbankShake 340ms ease-in-out both;
  }
  @media (prefers-reduced-motion: reduce) {
    .qbank-anim-pop, .qbank-anim-shake { animation: none; }
  }
`;

/** 内联放大预览图片：点击在题目区内展开/收起，不使用遮罩层灯箱 */
const InlineZoomImage: React.FC<{
  src: string;
  alt: string;
  collapsedClassName?: string;
}> = React.memo(({ src, alt, collapsedClassName = 'max-h-64' }) => {
  const [expanded, setExpanded] = React.useState(false);
  const { t } = useTranslation('practice');
  return (
    <button
      type="button"
      onClick={() => setExpanded(v => !v)}
      className={cn(
        'block w-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40',
        expanded ? 'cursor-zoom-out' : 'cursor-zoom-in'
      )}
      aria-expanded={expanded}
      aria-label={expanded ? t('editor.imageCollapse') : t('editor.imageExpand')}
      title={expanded ? t('editor.imageCollapse') : t('editor.imageExpand')}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={cn(
          'w-full object-contain transition-[max-height] duration-300 ease-out',
          expanded ? 'max-h-[70vh]' : collapsedClassName
        )}
/>
    </button>
  );
});
InlineZoomImage.displayName = 'InlineZoomImage';

/** 题干 Markdown 渲染 memo 化：计时器每秒 tick 等无关重渲染时跳过富文本重渲染 */
const QuestionContentBlock = React.memo<{ content: string }>(({ content }) => (
  <MarkdownRenderer content={content} />
));
QuestionContentBlock.displayName = 'QuestionContentBlock';

/** 自动关联的原始图片折叠气泡 — 默认展开 */
const SourceImagesBubble: React.FC<{
  images: QuestionImage[];
  imageUrls: Record<string, string>;
}> = ({ images, imageUrls }) => {
  const [expanded, setExpanded] = React.useState(true);
  const { t } = useTranslation('exam_sheet');

  return (
    <div className="rounded-lg border border-border/40 bg-muted/10 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-[var(--interactive-hover)] transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <ImageIcon size={14} className="flex-shrink-0" />
        <span className="flex-1 text-left">
          {t('image.source_images_bubble', {
            count: images.length,
          })}
        </span>
        {expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
      </button>
      {expanded && (
        <div className={cn(
          'grid gap-2 p-2 pt-0',
          images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
        )}>
          {images.map((img) => (
            <div key={img.id} className="rounded-lg overflow-hidden border border-border/30 bg-muted/20">
              {imageUrls[img.id] ? (
                <InlineZoomImage
                  src={imageUrls[img.id]}
                  alt={img.name}
                  collapsedClassName="max-h-64"
/>
              ) : (
                <div className="w-full h-24 flex items-center justify-center text-muted-foreground">
                  <CircleNotch size={16} className="animate-spin" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface StatCardProps {
  icon: React.ElementType;
  label: string;
  value: number | string;
  color: string;
  delay?: number;
}

const StatCard: React.FC<StatCardProps> = ({ icon: Icon, label, value, color, delay = 0 }) => (
  <div 
    className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-[var(--interactive-hover)] transition-colors"
    style={{ 
      animationDelay: `${delay}ms`,
      animation: 'fadeSlideUp 0.4s ease-out backwards'
    }}
  >
    <Icon className={cn('w-4 h-4 flex-shrink-0', color.split(' ').find(c => c.startsWith('text-')) || 'text-muted-foreground')} />
    <div className="min-w-0 flex items-baseline gap-1.5">
      <span className="text-base font-medium tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  </div>
);

interface OptionButtonProps {
  optionKey: string;
  content: string;
  isSelected: boolean;
  isCorrect?: boolean | null;
  isSubmitted: boolean;
  correctAnswer?: string;
  /** 稳定回调 + optionKey，配合 React.memo 避免计时器 tick 等无关渲染 */
  onSelect: (key: string) => void;
  type: 'single' | 'multiple';
  /** 内联键盘快捷键提示（桌面端），如 "1" */
  shortcutHint?: string;
}

const OptionButton: React.FC<OptionButtonProps> = React.memo(({
  optionKey,
  content,
  isSelected,
  isSubmitted,
  correctAnswer,
  onSelect,
  type,
  shortcutHint,
}) => {
  const { t } = useTranslation('practice');
  // 大小写归一：后端返回小写字母答案时也能正确高亮
  const isThisCorrect = correctAnswer?.toUpperCase().includes(optionKey.toUpperCase());
  const isWrong = isSubmitted && isSelected && !isThisCorrect;
  const showCorrect = isSubmitted && isThisCorrect;

  const handleClick = React.useCallback(() => onSelect(optionKey), [onSelect, optionKey]);

  return (
    <NotionButton
      variant="ghost" size="sm"
      onClick={handleClick}
      disabled={isSubmitted}
      className={cn(
        'group w-full !justify-start !h-auto !p-0 !rounded-md ui-state-colors',
        // 未提交：按压缩放反馈（ui-press 使用独立 scale 属性）
        !isSubmitted && 'ui-press',
        !isSubmitted && !isSelected && 'hover:bg-foreground/[0.04]',
        // 选中：描边 + 浅色填充
        !isSubmitted && isSelected && 'bg-primary/[0.07] dark:bg-primary/[0.15] ring-1 ring-inset ring-primary/40',
        showCorrect && 'bg-success/[0.08] dark:bg-success/[0.15]',
        // 答错：轻微 shake
        isWrong && 'bg-destructive/[0.08] dark:bg-destructive/[0.15] qbank-anim-shake',
        isSubmitted && !isSelected && !isThisCorrect && 'opacity-50',
        'disabled:cursor-default'
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        {/* 选项标识 - Notion 风格 */}
        <div className={cn(
          'flex-shrink-0 w-6 h-6 flex items-center justify-center text-sm font-medium',
          type === 'single' ? 'rounded-full' : 'rounded',
          // 默认 - 灰色边框
          !isSubmitted && !isSelected && 'border border-foreground/[0.16] text-foreground/65',
          // 选中 - 蓝色填充
          !isSubmitted && isSelected && 'bg-primary text-primary-foreground',
          // 正确 - 绿色填充 + 对勾弹入
          showCorrect && 'bg-success text-success-foreground qbank-anim-pop',
          // 错误 - 红色填充
          isWrong && 'bg-destructive text-white',
          // 已提交非选中非正确
          isSubmitted && !isSelected && !isThisCorrect && 'border border-foreground/[0.08] text-foreground/35'
        )}>
          {showCorrect ? (
            <Check size={14} weight="bold" />
          ) : isWrong ? (
            <X size={14} />
          ) : (
            optionKey
          )}
        </div>
        
        {/* 选项内容 */}
        <div className="flex-1 min-w-0 pt-0.5">
          <LatexText
            content={content}
            className={cn(
              'text-sm leading-relaxed',
              !isSubmitted && 'text-foreground',
              showCorrect && 'text-success',
              isWrong && 'text-destructive',
              isSubmitted && !isSelected && !isThisCorrect && 'text-foreground/50'
            )}
/>
        </div>

        {/* 内联快捷键提示：仅悬停未提交时淡入 */}
        {!isSubmitted && shortcutHint && (
          <kbd className="flex-shrink-0 hidden sm:inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded bg-muted text-[10px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
            {shortcutHint}
          </kbd>
        )}

        {/* 状态文字 - Notion 风格：简洁文字标识 */}
        {showCorrect && (
          <span className="flex-shrink-0 text-xs text-success ui-rise-in">
            {t('editor.correct')}
          </span>
        )}
        {isWrong && (
          <span className="flex-shrink-0 text-xs text-destructive ui-rise-in">
            {t('editor.wrong')}
          </span>
        )}
      </div>
    </NotionButton>
  );
});
OptionButton.displayName = 'OptionButton';

export const QuestionBankEditor: React.FC<QuestionBankEditorProps> = ({
  sessionId,
  questions,
  stats,
  currentIndex = 0,
  isLoading = false,
  error = null,
  practiceMode = 'sequential',
  selectedTag: selectedTagProp,
  onSubmitAnswer,
  onNavigate,
  onModeChange,
  onMarkCorrect,
  onRefreshQuestion,
  onToggleFavorite,
  onDeleteQuestion,
  onBack,
  className,
  showTimer = true,
  timerDuration,
  timerElapsedSeconds,
  timerRunning,
  onTimerRunningChange,
  allowTimerControl = true,
  editMode = false,
  focusMode: focusModeProp,
  onFocusModeChange,
  settingsPanelOpen,
  onSettingsPanelOpenChange,
  hideAnswerMode: hideAnswerModeProp,
  onHideAnswerModeChange,
  onUpdateUserNote,
  onDraftDirtyChange,
  onDraftNavigationRequested,
  isActive,
}) => {
  const { t } = useTranslation('practice');
  const [selectedAnswer, setSelectedAnswer] = useState<string>('');
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 连点防重入：isSubmitting state 在同一帧内读到旧值，用 ref 同步拦截
  const submitInFlightRef = useRef(false);
  const [isManualGrading, setIsManualGrading] = useState(false);
  const manualGradeInFlightRef = useRef(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteInFlightRef = useRef(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [selectedTag, setSelectedTag] = useState<string>(selectedTagProp ?? '');

  // AI 评判 Hook（解构出稳定回调，供 useCallback/useEffect 依赖使用）
  const aiGrading = useQbankAiGrading();
  const {
    resetState: resetAiGrading,
    startGrading: startAiGrading,
    retryGrading: retryAiGrading,
  } = aiGrading;
  // AI 解析缓存（questionId -> feedback），跨题目切换保持
  const aiFeedbackCacheRef = useRef<Map<string, string>>(new Map());
  
  // P1-2: 计时功能
  const [elapsedTime, setElapsedTime] = useState(0);
  const [localTimerRunning, setLocalTimerRunning] = useState(true);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const isTimerRunning = timerRunning ?? localTimerRunning;
  const setTimerRunning = useCallback((running: boolean) => {
    if (onTimerRunningChange) {
      onTimerRunningChange(running);
      return;
    }
    setLocalTimerRunning(running);
  }, [onTimerRunningChange]);
  const resolvedElapsedTime = timerElapsedSeconds ?? elapsedTime;
  const remainingTime = timerDuration != null
    ? Math.max(timerDuration - resolvedElapsedTime, 0)
    : null;
  const timerDisplay = remainingTime ?? resolvedElapsedTime;
  
  // 设置面板可由工作区精确控制；独立使用编辑器时仍保留本地状态。
  const [localSettingsPanelOpen, setLocalSettingsPanelOpen] = useState(false);
  const showSettingsPanel = settingsPanelOpen ?? localSettingsPanelOpen;
  const setShowSettingsPanel = useCallback((open: boolean) => {
    if (onSettingsPanelOpenChange) {
      onSettingsPanelOpenChange(open);
      return;
    }
    setLocalSettingsPanelOpen(open);
  }, [onSettingsPanelOpenChange]);
  
  // P1-1: 专注模式（刷题降噪）
  const [localFocusMode, setLocalFocusMode] = useState(false);
  const focusMode = focusModeProp ?? localFocusMode;
  const handleFocusModeChange = useCallback((newMode: boolean) => {
    if (onFocusModeChange) {
      onFocusModeChange(newMode);
    } else {
      setLocalFocusMode(newMode);
    }
  }, [onFocusModeChange]);

  // ========== 新功能状态 ==========
  // 暗记模式
  const [localHideAnswerMode, setLocalHideAnswerMode] = useState(false);
  const hideAnswerMode = hideAnswerModeProp ?? localHideAnswerMode;
  const handleHideAnswerModeChange = useCallback((newMode: boolean) => {
    if (onHideAnswerModeChange) {
      onHideAnswerModeChange(newMode);
    } else {
      setLocalHideAnswerMode(newMode);
    }
  }, [onHideAnswerModeChange]);
  
  // 暗记模式下是否已揭示答案
  const [answerRevealed, setAnswerRevealed] = useState(false);
  
  // 用户笔记编辑（内联展开 + 失焦自动保存）
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteSaveState, setNoteSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const noteSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次已成功保存的笔记内容（避免 blur 与点击保存的双重提交，并驱动草稿脏状态）
  const [lastSavedNote, setLastSavedNote] = useState('');
  
  // 答案解析折叠
  const [explanationExpanded, setExplanationExpanded] = useState(false);
  
  // 题目搜索
  const [searchQuery, setSearchQuery] = useState('');
  
  // 连对计数 & 激励（里程碑提示走 showGlobalNotification 统一通知，不再用本地 z-50 toast）
  const [streakCount, setStreakCount] = useState(0);
  const [totalCorrectCount, setTotalCorrectCount] = useState(0);
  
  // 完成庆祝
  const [showCompletionCelebration, setShowCompletionCelebration] = useState(false);
  const [completionStats, setCompletionStats] = useState<{
    totalAnswered: number;
    correctCount: number;
    totalTime: number;
  } | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清理庆祝/笔记指示定时器，避免定时器泄漏与卸载后 setState
  useEffect(() => () => {
    if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
    if (noteSavedTimerRef.current) clearTimeout(noteSavedTimerRef.current);
  }, []);
  
  // 单题计时（使用 ref 避免 stale closure）
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());
  const questionStartTimeRef = useRef<number>(questionStartTime);
  questionStartTimeRef.current = questionStartTime;
  // 单题用时仅在切题时累加、不参与渲染，用 ref 避免多余重渲染
  const questionTimesRef = useRef<Record<string, number>>({});
  // 本轮已真实作答的题目 ID（完成庆祝以此判定，而非"访问过"的题数估算）
  const answeredIdsRef = useRef<Set<string>>(new Set());
  const prevQuestionIdRef = useRef<string | undefined>(undefined);
  
  // 填空题多空位
  const [fillBlankAnswers, setFillBlankAnswers] = useState<string[]>([]);
  // 匹配题配对 / 排序题当前排列（结构化题型作答状态）
  const [matchingPairs, setMatchingPairs] = useState<MatchingPair[]>([]);
  const [orderingOrder, setOrderingOrder] = useState<string[]>([]);
  const [pendingNavigationIndex, setPendingNavigationIndex] = useState<number | null>(null);

  // 题目图片预览
  const [questionImageUrls, setQuestionImageUrls] = useState<Record<string, string>>({});
  // ref 镜像：题目切换 effect 里读取最新缓存，避免把 questionImageUrls 放进依赖导致循环
  const questionImageUrlsRef = useRef(questionImageUrls);
  questionImageUrlsRef.current = questionImageUrls;
  // 原始图片裁剪（内联工具，非模态）
  const [cropDialogOpen, setCropDialogOpen] = useState(false);
  const [imageRefreshKey, setImageRefreshKey] = useState(0);

  // 题目切换方向（用于滑动过渡动画）：>=0 下一题（从右滑入），<0 上一题（从左滑入）
  const prevIndexForAnimRef = useRef(currentIndex);
  const navDirection = currentIndex >= prevIndexForAnimRef.current ? 1 : -1;
  useEffect(() => {
    prevIndexForAnimRef.current = currentIndex;
  }, [currentIndex]);

  // 响应式断点
  const { isSmallScreen } = useBreakpoint();

  // ========== 移动端滑动面板状态 ==========
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  const dragStateRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    currentTranslate: 0,
    axisLocked: null as 'horizontal' | 'vertical' | null,
  });

  // 监听容器宽度
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(container);
    return () => ro.disconnect();
  }, [isSmallScreen]);

  // 设置面板宽度
  const settingsPanelWidth = Math.max(containerWidth - 60, 280);

  // 计算基础偏移
  const getBaseTranslate = useCallback(() => {
    return showSettingsPanel ? -settingsPanelWidth : 0;
  }, [showSettingsPanel, settingsPanelWidth]);

  // 拖拽处理
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    dragStateRef.current = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      currentTranslate: getBaseTranslate(),
      axisLocked: null,
    };
    setIsDragging(true);
    setDragOffset(0);
  }, [getBaseTranslate]);

  const handleDragMove = useCallback((clientX: number, clientY: number, preventDefault: () => void) => {
    if (!dragStateRef.current.isDragging) return;

    const deltaX = clientX - dragStateRef.current.startX;
    const deltaY = clientY - dragStateRef.current.startY;

    if (dragStateRef.current.axisLocked === null && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
        dragStateRef.current.axisLocked = 'horizontal';
      } else {
        dragStateRef.current.axisLocked = 'vertical';
        dragStateRef.current.isDragging = false;
        setIsDragging(false);
        return;
      }
    }

    if (dragStateRef.current.axisLocked === 'vertical') return;
    if (dragStateRef.current.axisLocked === 'horizontal') preventDefault();

    const minTranslate = -settingsPanelWidth;
    const maxTranslate = 0;
    let newTranslate = dragStateRef.current.currentTranslate + deltaX;
    newTranslate = Math.max(minTranslate, Math.min(maxTranslate, newTranslate));

    setDragOffset(newTranslate - getBaseTranslate());
  }, [settingsPanelWidth, getBaseTranslate]);

  const handleDragEnd = useCallback(() => {
    if (!dragStateRef.current.isDragging) {
      dragStateRef.current.axisLocked = null;
      return;
    }

    const threshold = settingsPanelWidth * 0.3;
    const offset = dragOffset;

    if (Math.abs(offset) > threshold) {
      if (offset > 0 && showSettingsPanel) {
        setShowSettingsPanel(false);
      } else if (offset < 0 && !showSettingsPanel) {
        setShowSettingsPanel(true);
      }
    }

    dragStateRef.current.isDragging = false;
    dragStateRef.current.axisLocked = null;
    setIsDragging(false);
    setDragOffset(0);
  }, [dragOffset, showSettingsPanel, settingsPanelWidth]);

  // 绑定触摸事件
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    // 起点位于可横向滚动的内容（宽表格 / 溢出公式等）时放弃面板拖拽手势，
    // 把横向滑动让位给内容自身的横向滚动，避免手势劫持。
    const startsInHorizontalScrollable = (target: EventTarget | null): boolean => {
      let node = target instanceof Element ? target : null;
      while (node && node !== container) {
        if (
          node instanceof HTMLElement
          && node.scrollWidth > node.clientWidth + 1
        ) {
          const { overflowX } = getComputedStyle(node);
          if (overflowX === 'auto' || overflowX === 'scroll') return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (startsInHorizontalScrollable(e.target)) return;
      const touch = e.touches[0];
      handleDragStart(touch.clientX, touch.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY, () => e.preventDefault());
    };

    const onTouchEnd = () => handleDragEnd();

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isSmallScreen, handleDragStart, handleDragMove, handleDragEnd]);

  // 兼容旧工作区事件，并支持 action 传入精确的 open 值而不是盲目切换。
  useEffect(() => {
    const handleSettingsChange = (evt: Event) => {
      const detail = (evt as CustomEvent<{ targetResourceId?: string; open?: boolean }>).detail;
      if (detail?.targetResourceId && sessionId && detail.targetResourceId !== sessionId) {
        return;
      }
      setShowSettingsPanel(
        typeof detail?.open === 'boolean' ? detail.open : !showSettingsPanel,
      );
    };
    window.addEventListener('exam:openSettings', handleSettingsChange);
    return () => {
      window.removeEventListener('exam:openSettings', handleSettingsChange);
    };
  }, [sessionId, showSettingsPanel, setShowSettingsPanel]);

  // 计时器逻辑
  // ★ 标签页：isActive === false 时暂停计时器
  useEffect(() => {
    if (timerElapsedSeconds === undefined && showTimer && isTimerRunning && isActive !== false) {
      timerRef.current = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [timerElapsedSeconds, showTimer, isTimerRunning, isActive]);

  // 题目切换时重置状态和记录单题用时（使用 ref 避免 stale closure）
  useEffect(() => {
    // 记录上一题的用时
    const prevId = prevQuestionIdRef.current;
    const startTime = questionStartTimeRef.current;
    if (prevId && startTime) {
      const timeSpent = Math.floor((Date.now() - startTime) / 1000);
      questionTimesRef.current[prevId] = (questionTimesRef.current[prevId] || 0) + timeSpent;
    }
    // 更新 prevQuestionIdRef 为当前题目
    prevQuestionIdRef.current = questions[currentIndex]?.id;
    // 重置单题计时
    setQuestionStartTime(Date.now());
    // 重置暗记模式揭示状态
    setAnswerRevealed(false);
    // 重置解析折叠状态
    setExplanationExpanded(false);
  }, [currentIndex, questions]);

  // 同步外部标签选择（知识点导航进入时）
  useEffect(() => {
    if (selectedTagProp !== undefined) {
      setSelectedTag(selectedTagProp);
    }
  }, [selectedTagProp]);

  const currentQuestion = questions[currentIndex];
  const totalQuestions = questions.length;
  const progressPercent = totalQuestions > 0 ? ((currentIndex + 1) / totalQuestions) * 100 : 0;

  const tagOptions = useMemo(() => {
    const tagSet = new Set<string>();
    let hasUntaggedQuestions = false;
    questions.forEach((question) => {
      const tags = question.tags?.filter((tag) => tag.trim().length > 0) ?? [];
      if (tags.length === 0) hasUntaggedQuestions = true;
      tags.forEach((tag) => tagSet.add(tag));
    });
    const options = Array.from(tagSet)
      .sort()
      .map((tag) => ({ value: tag, label: tag }));
    if (hasUntaggedQuestions) {
      options.push({ value: '__untagged__', label: t('tagPicker.untagged') });
    }
    return options;
  }, [questions, t]);

  // 当前题型（扩展联合：true_false / matching / ordering / numeric 等新题型）
  const qType = (currentQuestion?.questionType ?? 'other') as ExtendedQuestionType;

  // structured_data 解析（各题型收窄；结构非法时为 null，作答区回退自由文本）
  const structuredRaw = useMemo(() => getQuestionStructuredData(currentQuestion), [currentQuestion]);
  const matchingData = useMemo(
    () => (qType === 'matching' ? parseMatchingData(structuredRaw) : null),
    [qType, structuredRaw]
  );
  const orderingData = useMemo(
    () => (qType === 'ordering' ? parseOrderingData(structuredRaw) : null),
    [qType, structuredRaw]
  );
  // 排序题条目签名：仅在题面 items 真正变化时触发作答状态重置。
  // orderingData 每次解析都是新对象——提交答案/收藏/刷新会替换题目对象并让它换引用，
  // 若直接作为重置 effect 的依赖，排序题提交后 submitResult 会被立刻清掉（揭示态闪退、排列被还原）。
  const orderingItemsSignature = useMemo(
    () => (orderingData ? orderingData.items.map((item) => item.key).join('\u0000') : ''),
    [orderingData]
  );
  const orderingDataRef = useRef(orderingData);
  orderingDataRef.current = orderingData;
  const numericData = useMemo(
    () => (qType === 'numeric' ? parseNumericData(structuredRaw) : null),
    [qType, structuredRaw]
  );
  const fillBlankData = useMemo(
    () => (qType === 'fill_blank' ? parseFillBlankData(structuredRaw) : null),
    [qType, structuredRaw]
  );

  // 解析填空题的空位数量：优先 structured blanks，缺失时回退正文占位符推断
  const fillBlankCount = useMemo(() => {
    if (qType !== 'fill_blank') return 0;
    if (fillBlankData) return fillBlankData.blanks.length;
    const content = currentQuestion?.content || currentQuestion?.ocrText || '';
    const matches = content.match(/_{2,}|（\s*）|\(\s*\)/g);
    return matches ? matches.length : 1;
  }, [qType, fillBlankData, currentQuestion]);

  // 题目切换时重置答题状态
  // 切题同时取消进行中的 AI 判分流（resetAiGrading 内部会向后端发送取消），避免上一题的流串到新题
  useEffect(() => {
    setSelectedAnswer('');
    setSelectedOptions(new Set());
    setSubmitResult(null);
    setFillBlankAnswers(new Array(fillBlankCount).fill(''));
    // 结构化题型作答状态重置：排序题按题面 items 顺序初始化
    // （经 ref 读取，避免 orderingData 引用变化触发本 effect —— 见 orderingItemsSignature 注释）
    setMatchingPairs([]);
    setOrderingOrder(orderingDataRef.current ? orderingDataRef.current.items.map((item) => item.key) : []);
    resetAiGrading();
    // 初始化笔记文本
    setNoteText(currentQuestion?.userNote || '');
    setLastSavedNote(currentQuestion?.userNote || '');
    setIsEditingNote(false);
    setNoteSaveState('idle');
    // 关闭上一题遗留的内联删除确认，避免误删旧题
    setDeleteConfirmOpen(false);
    setDeleteTargetId(null);
    // 加载题目图片（带竞态保护和缓存控制；通过 ref 读取缓存避免依赖循环）
    let cancelled = false;
    if (currentQuestion?.images && currentQuestion.images.length > 0) {
      const loadImages = async () => {
        const cachedSnapshot = questionImageUrlsRef.current;
        const imagesToLoad = currentQuestion.images!.filter(
          img => !cachedSnapshot[img.id] || cachedSnapshot[img.id] === 'error'
        );
        const cachedUrls: Record<string, string> = {};
        currentQuestion.images!.forEach(img => {
          if (cachedSnapshot[img.id] && cachedSnapshot[img.id] !== 'error') {
            cachedUrls[img.id] = cachedSnapshot[img.id];
          }
        });
        const results = await Promise.allSettled(
          imagesToLoad.map(async (img) => {
            const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
              attachmentId: img.id,
            });
            if (result.found && result.content) {
              return { id: img.id, url: `data:${img.mime};base64,${result.content}` };
            }
            return null;
          })
        );
        if (cancelled) return;
        const urls: Record<string, string> = { ...cachedUrls };
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value) {
            urls[r.value.id] = r.value.url;
          }
        });
        setQuestionImageUrls(prev => {
          const merged = { ...prev, ...urls };
          const keys = Object.keys(merged);
          if (keys.length > 50) {
            const toRemove = keys.slice(0, keys.length - 50);
            toRemove.forEach(k => delete merged[k]);
          }
          return merged;
        });
      };
      loadImages();
    }
    return () => { cancelled = true; };
  }, [currentIndex, currentQuestion?.id, fillBlankCount, orderingItemsSignature, imageRefreshKey, resetAiGrading]);

  // 题目搜索过滤
  const filteredQuestionIndices = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const query = searchQuery.toLowerCase();
    return questions
      .map((q, idx) => ({ q, idx }))
      .filter(({ q }) => 
        q.content?.toLowerCase().includes(query) ||
        q.questionLabel?.toLowerCase().includes(query) ||
        q.tags?.some(t => t.toLowerCase().includes(query))
      )
      .map(({ idx }) => idx);
  }, [questions, searchQuery]);

  const handleOptionClick = useCallback((key: string) => {
    if (submitResult) return;
    
    const isMulti = currentQuestion?.questionType === 'multiple_choice' 
      || currentQuestion?.questionType === 'indefinite_choice';
    
    if (isMulti) {
      setSelectedOptions(prev => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    } else {
      setSelectedAnswer(key);
    }
  }, [currentQuestion?.questionType, submitResult]);

  // 提前定义 canSubmit 以供提交与键盘快捷键使用
  const canSubmit = useMemo(() => {
    if (submitResult) return false;
    const isMulti = qType === 'multiple_choice' || qType === 'indefinite_choice';
    if (isMulti) {
      return selectedOptions.size > 0;
    }
    if (qType === 'fill_blank') {
      return fillBlankAnswers.some(a => a.trim().length > 0);
    }
    if (qType === 'true_false') {
      return selectedAnswer === 'true' || selectedAnswer === 'false';
    }
    if (qType === 'numeric') {
      // 与后端 parse_numeric_input 同口径：接受 "3.14 m"、"1/2"、全角数字等宽松写法
      const trimmed = selectedAnswer.trim();
      return trimmed.length > 0 && parseNumericInput(trimmed) != null;
    }
    if (qType === 'matching' && matchingData) {
      return matchingPairs.length > 0;
    }
    if (qType === 'ordering' && orderingData) {
      return orderingOrder.length > 1;
    }
    return selectedAnswer.trim().length > 0;
  }, [qType, selectedAnswer, selectedOptions, submitResult, fillBlankAnswers, matchingData, matchingPairs, orderingData, orderingOrder]);

  const handleSubmit = useCallback(async () => {
    if (!currentQuestion || !onSubmitAnswer || !canSubmit) return;
    // 防重入：isSubmitting state 在同一帧内读到旧值，双击/连点/Enter 连按会触发两次提交
    if (isSubmitting || submitInFlightRef.current) return;
    
    const isMulti = qType === 'multiple_choice' || qType === 'indefinite_choice';
    
    // user_answer 序列化（与后端判分契约一致）
    let answer: string;
    if (qType === 'fill_blank') {
      // 多空 JSON 数组 ["a","b"]，单空保留裸字符串（兼容旧数据）
      answer = encodeFillBlankUserAnswer(fillBlankAnswers);
    } else if (isMulti) {
      answer = Array.from(selectedOptions).sort().join('');
    } else if (qType === 'matching' && matchingData) {
      answer = encodeMatchingUserAnswer(matchingPairs);
    } else if (qType === 'ordering' && orderingData) {
      answer = encodeOrderingUserAnswer(orderingOrder);
    } else if (qType === 'numeric') {
      answer = selectedAnswer.trim();
    } else {
      answer = selectedAnswer;
    }
    
    if (!answer.trim()) return;
    
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const result = await onSubmitAnswer(currentQuestion.id, answer, currentQuestion.questionType);
      setSubmitResult(result);

      // 主观题：自动触发 AI 评判
      if (result.needsManualGrading && result.submissionId) {
        const questionId = currentQuestion.id;
        resetAiGrading();
        startAiGrading(
          questionId,
          result.submissionId,
          'grade',
          undefined,
          // onComplete 回调：在事件 handler 中直接获取最新 verdict/score
          (verdict) => {
            if (verdict) {
              const isCorrect = verdict === 'correct';
              setSubmitResult(prev => prev ? { ...prev, isCorrect, needsManualGrading: false } : null);
              if (onRefreshQuestion) {
                onRefreshQuestion(questionId).catch((err) => {
                  debugLog.error('[QuestionBankEditor] refresh after AI grading failed:', err);
                  setSubmitResult(prev => prev ? { ...prev, isCorrect: null, needsManualGrading: true } : null);
                  showGlobalNotification('error', t('exam_sheet:errors.manual_grade_failed'));
                });
              }
            }
          },
        ).catch(() => {
          // AI 评判失败，保留手动批改兜底
          debugLog.warn('[QuestionBankEditor] AI grading failed, falling back to manual');
        });
      }
      
      // 连对计数逻辑：null (主观题/待判定) 不中断连对，仅 false 中断
      if (result.isCorrect) {
        const newStreak = streakCount + 1;
        setStreakCount(newStreak);
        setTotalCorrectCount(prev => prev + 1);
        // 检查里程碑 (3, 5, 10, 15, 20...)：走统一通知（替代原 z-50 本地 toast）
        const milestones = [3, 5, 10, 15, 20, 30, 50];
        if (milestones.includes(newStreak)) {
          showGlobalNotification(
            'success',
            `${t('editor.streakMessage', { count: newStreak })} · ${t('editor.keepItUp')}`,
          );
        }
      } else if (result.isCorrect === false) {
        // 仅明确错误时中断连对，null(主观题)不中断
        setStreakCount(0);
      }

      // 检查是否完成所有题目：基于真实已作答题目数（快速翻题只"访问"不作答，不计入）
      answeredIdsRef.current.add(currentQuestion.id);
      const answeredCount = answeredIdsRef.current.size;
      if (answeredCount >= totalQuestions && totalQuestions > 0) {
        // result.isCorrect 可能为 null（主观题），null 不计为正确也不计为错误
        const finalCorrectCount = totalCorrectCount + (result.isCorrect === true ? 1 : 0);
        setCompletionStats({
          totalAnswered: answeredCount,
          correctCount: finalCorrectCount,
          totalTime: resolvedElapsedTime
        });
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        completionTimerRef.current = setTimeout(() => setShowCompletionCelebration(true), 500);
      }
    } catch (err) {
      debugLog.error('Submit answer failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.submit_failed'));
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [currentQuestion, canSubmit, qType, selectedAnswer, selectedOptions, fillBlankAnswers, matchingData, matchingPairs, orderingData, orderingOrder, onSubmitAnswer, onRefreshQuestion, streakCount, totalCorrectCount, totalQuestions, resolvedElapsedTime, resetAiGrading, startAiGrading, t, isSubmitting]);

  // 重做当前题目
  const handleRetry = useCallback(() => {
    setSelectedAnswer('');
    setSelectedOptions(new Set());
    setSubmitResult(null);
    setFillBlankAnswers(new Array(fillBlankCount).fill(''));
    setMatchingPairs([]);
    setOrderingOrder(orderingData ? orderingData.items.map((item) => item.key) : []);
    setAnswerRevealed(false);
    resetAiGrading();
  }, [fillBlankCount, orderingData, resetAiGrading]);

  // 保存用户笔记（失焦自动保存 + 保存状态指示）
  // blur 与点击"完成"可能同帧触发，用 ref 记录进行中的保存内容避免重复请求
  const noteSaveInFlightTextRef = useRef<string | null>(null);
  const saveNote = useCallback(async (text: string, opts?: { close?: boolean }) => {
    if (!currentQuestion) return;
    if (!onUpdateUserNote) {
      showGlobalNotification('warning', t('exam_sheet:errors.note_update_unavailable'));
      return;
    }
    // 内容未变化 / 相同内容正在保存中：不发请求，仅按需收起
    if (text === lastSavedNote || noteSaveInFlightTextRef.current === text) {
      if (opts?.close) setIsEditingNote(false);
      return;
    }
    noteSaveInFlightTextRef.current = text;
    setNoteSaveState('saving');
    try {
      await onUpdateUserNote(currentQuestion.id, text);
      setLastSavedNote(text);
      setNoteSaveState('saved');
      if (noteSavedTimerRef.current) clearTimeout(noteSavedTimerRef.current);
      noteSavedTimerRef.current = setTimeout(() => {
        setNoteSaveState(prev => (prev === 'saved' ? 'idle' : prev));
      }, 2000);
      if (opts?.close) setIsEditingNote(false);
    } catch (err) {
      debugLog.error('Save note failed:', err);
      setNoteSaveState('error');
      showGlobalNotification('error', t('exam_sheet:errors.save_note_failed'));
    } finally {
      noteSaveInFlightTextRef.current = null;
    }
  }, [currentQuestion, lastSavedNote, onUpdateUserNote, t]);

  const handleSaveNote = useCallback(() => {
    void saveNote(noteText, { close: true });
  }, [noteText, saveNote]);

  const handleNoteBlur = useCallback(() => {
    void saveNote(noteText);
  }, [noteText, saveNote]);

  const handleManualGrade = useCallback(async (isCorrect: boolean) => {
    if (!currentQuestion || !onMarkCorrect || manualGradeInFlightRef.current) return;
    manualGradeInFlightRef.current = true;
    setIsManualGrading(true);
    try {
      await onMarkCorrect(currentQuestion.id, isCorrect);
      setSubmitResult(prev => prev ? { ...prev, isCorrect, needsManualGrading: false } : null);
    } catch (err) {
      debugLog.error('Manual grade failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.manual_grade_failed'));
    } finally {
      manualGradeInFlightRef.current = false;
      setIsManualGrading(false);
    }
  }, [currentQuestion, onMarkCorrect, t]);

  const handleModeChange = useCallback((mode: PracticeMode) => {
    onModeChange?.(mode, mode === 'by_tag' ? selectedTag : undefined);
  }, [selectedTag, onModeChange]);

  const handleTagChange = useCallback((tag: string) => {
    setSelectedTag(tag);
    if (practiceMode === 'by_tag') {
      onModeChange?.('by_tag', tag);
    }
  }, [practiceMode, onModeChange]);

  // P1-3: 收藏功能 - 直接从 question 数据读取状态，调用 store action 更新
  const handleToggleFavorite = useCallback(async () => {
    if (!currentQuestion) return;
    try {
      await onToggleFavorite?.(currentQuestion.id, !currentQuestion.isFavorite);
    } catch (err) {
      debugLog.error('Toggle favorite failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.toggle_favorite_failed'));
    }
  }, [currentQuestion, onToggleFavorite, t]);

  const handleRequestDelete = useCallback(() => {
    if (!currentQuestion || !onDeleteQuestion) return;
    setDeleteTargetId(currentQuestion.id);
    setDeleteConfirmOpen(true);
  }, [currentQuestion, onDeleteQuestion]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTargetId || !onDeleteQuestion || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setIsDeleting(true);
    try {
      await onDeleteQuestion(deleteTargetId);
      setDeleteConfirmOpen(false);
      setDeleteTargetId(null);
      onBack?.();
    } catch (err) {
      debugLog.error('Delete question failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.delete_question_failed'));
    } finally {
      deleteInFlightRef.current = false;
      setIsDeleting(false);
    }
  }, [deleteTargetId, onBack, onDeleteQuestion, t]);

  // P1-2: 计时器控制
  const toggleTimer = useCallback(() => {
    if (!allowTimerControl) return;
    setTimerRunning(!isTimerRunning);
  }, [allowTimerControl, isTimerRunning, setTimerRunning]);

  // 从 question 数据读取收藏状态（SSOT: store -> question -> UI）
  const isFavorite = currentQuestion?.isFavorite ?? false;

  const hasUnsavedNote = isEditingNote && noteText !== lastSavedNote;
  const hasUnsavedDraft = canSubmit || hasUnsavedNote;

  useEffect(() => {
    onDraftDirtyChange?.(hasUnsavedDraft);
  }, [hasUnsavedDraft, onDraftDirtyChange]);

  useEffect(() => () => onDraftDirtyChange?.(false), [onDraftDirtyChange]);

  const requestNavigate = useCallback((targetIndex: number) => {
    if (!onNavigate || targetIndex === currentIndex) return;
    if (hasUnsavedDraft) {
      if (onDraftNavigationRequested) {
        onDraftNavigationRequested(targetIndex);
        return;
      }
      setPendingNavigationIndex(targetIndex);
      return;
    }
    onNavigate(targetIndex);
  }, [currentIndex, hasUnsavedDraft, onDraftNavigationRequested, onNavigate]);

  const handleNavigate = useCallback((direction: 'prev' | 'next') => {
    const newIndex = direction === 'prev'
      ? Math.max(0, currentIndex - 1)
      : getNextQuestionIndex(questions, currentIndex, practiceMode, selectedTag);
    requestNavigate(newIndex);
  }, [currentIndex, practiceMode, questions, requestNavigate, selectedTag]);

  // ========== 键盘快捷键支持 ==========
  useEffect(() => {
    // 编辑模式和移动端不启用快捷键；窗口/标签页非激活时不监听（多窗做题与复习评分共用数字键，避免互扰）
    if (editMode || isSmallScreen || isActive === false) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // 带修饰键的组合（Ctrl+R 刷新、Ctrl+数字切标签等）不拦截
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      // 如果正在输入框中，不处理快捷键
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      
      const isChoiceQuestion = currentQuestion?.questionType === 'single_choice' 
        || currentQuestion?.questionType === 'multiple_choice'
        || currentQuestion?.questionType === 'indefinite_choice';
      
      // 数字键 1-9 选择选项
      if (isChoiceQuestion && !submitResult && /^[1-9]$/.test(e.key)) {
        const optionIndex = parseInt(e.key) - 1;
        const options = currentQuestion?.options;
        if (options && optionIndex < options.length) {
          e.preventDefault();
          handleOptionClick(options[optionIndex].key);
        }
      }

      // 字母键 A-Z 选择选项（与实际选项 key 动态对齐；命中选项时优先于 F/R/H 等功能键）
      if (isChoiceQuestion && !submitResult && /^[a-z]$/i.test(e.key)) {
        const letter = e.key.toUpperCase();
        const match = currentQuestion?.options?.find(
          (opt) => opt.key.toUpperCase() === letter
        );
        if (match) {
          e.preventDefault();
          handleOptionClick(match.key);
          return;
        }
      }

      // 判断题：1 = 正确，2 = 错误
      if (qType === 'true_false' && !submitResult && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        setSelectedAnswer(e.key === '1' ? 'true' : 'false');
      }

      // F 键收藏/取消收藏（选项字母未命中时才会到这里）
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        void handleToggleFavorite();
      }
      
      // Enter：未提交时提交答案；已提交后进入下一题
      if (e.key === 'Enter' && !e.shiftKey) {
        if (canSubmit && !isSubmitting) {
          e.preventDefault();
          handleSubmit();
        } else if (submitResult && currentIndex < totalQuestions - 1) {
          e.preventDefault();
          handleNavigate('next');
        }
      }
      
      // 左右箭头切换题目
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        handleNavigate('prev');
      }
      if (e.key === 'ArrowRight' && currentIndex < totalQuestions - 1) {
        e.preventDefault();
        handleNavigate('next');
      }
      
      // R 键重做（仅明确答错后，不含主观题 null 状态）
      if (e.key === 'r' && submitResult && submitResult.isCorrect === false) {
        e.preventDefault();
        handleRetry();
      }
      
      // Space 暂停/继续计时器
      if (e.key === ' ' && showTimer) {
        e.preventDefault();
        toggleTimer();
      }
      
      // H 键切换暗记模式
      if (e.key === 'h') {
        e.preventDefault();
        if (hideAnswerMode && !answerRevealed) {
          setAnswerRevealed(true);
        } else {
          handleHideAnswerModeChange(!hideAnswerMode);
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    editMode, isSmallScreen, isActive, currentQuestion, qType, submitResult, canSubmit, isSubmitting,
    currentIndex, totalQuestions, showTimer, hideAnswerMode, answerRevealed,
    handleOptionClick, handleSubmit, handleNavigate, handleRetry, toggleTimer,
    handleHideAnswerModeChange, handleToggleFavorite
  ]);

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center min-h-[400px]', className)}>
        <div className="flex flex-col items-center gap-4">
          <CircleNotch size={32} className="animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('editor.loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex items-center justify-center min-h-[400px]', className)}>
        <div className="flex flex-col items-center gap-4 text-center px-6">
          <div className="rounded-md bg-destructive/10 p-2">
            <WarningCircle size={24} className="text-destructive" />
          </div>
          <p className="text-sm text-muted-foreground max-w-sm">{error}</p>
          {onBack && (
            <NotionButton variant="ghost" onClick={onBack}>{t('editor.back')}</NotionButton>
          )}
        </div>
      </div>
    );
  }

  if (!currentQuestion || totalQuestions === 0) {
    return (
      <div className={cn('flex items-center justify-center min-h-[400px]', className)}>
        <div className="flex flex-col items-center gap-4 text-center px-6">
          <div className="rounded-md bg-muted/50 p-3">
            <BookOpen size={24} className="text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold mb-1">{t('editor.noQuestionsTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('editor.noQuestionsDesc')}</p>
          </div>
          {onBack && (
            <NotionButton variant="ghost" onClick={onBack}>{t('editor.back')}</NotionButton>
          )}
        </div>
      </div>
    );
  }

  const isChoiceQuestion = currentQuestion.questionType === 'single_choice' 
    || currentQuestion.questionType === 'multiple_choice'
    || currentQuestion.questionType === 'indefinite_choice';
  
  const isMultiSelect = currentQuestion.questionType === 'multiple_choice' 
    || currentQuestion.questionType === 'indefinite_choice';

  // 判断题标准答案（提交结果优先，回退题目 answer 字段）
  const trueFalseCorrectRaw = (submitResult?.correctAnswer ?? currentQuestion.answer ?? '').trim().toLowerCase();
  const trueFalseCorrectAnswer: 'true' | 'false' | null =
    trueFalseCorrectRaw === 'true' ? 'true' : trueFalseCorrectRaw === 'false' ? 'false' : null;

  // 结构化题型：作答组件内部已完成正误揭示与标准答案对照，结果卡不再重复展示原始 JSON 答案
  const structuredRevealsAnswer =
    (qType === 'matching' && !!matchingData)
    || (qType === 'ordering' && !!orderingData)
    || (qType === 'numeric' && !!numericData)
    || qType === 'true_false';

  // 编辑模式下结构化标准答案的只读摘要（有内容才渲染面板）
  const structuredAnswerSummaryNode = (
    (qType === 'matching' && matchingData && matchingData.pairs.length > 0)
    || (qType === 'ordering' && orderingData && orderingData.correct_order.length > 0)
    || (qType === 'numeric' && numericData)
    || (qType === 'true_false' && trueFalseCorrectAnswer)
  ) ? (
    <StructuredAnswerSummary
      questionType={qType}
      matching={matchingData}
      ordering={orderingData}
      numeric={numericData}
      trueFalseAnswer={trueFalseCorrectAnswer}
    />
  ) : null;

  // 提交结果里的 explanation 可能缺失（会话 hook 不返回该字段），回退到题目自身解析
  const effectiveExplanation = submitResult?.explanation || currentQuestion.explanation || '';

  // 题目切换滑动过渡：key 变化触发重新挂载 + 方向化滑入
  const questionTransitionStyle = {
    ['--ui-enter-x' as string]: navDirection >= 0 ? '24px' : '-24px',
  } as React.CSSProperties;

  // ========== 右侧设置面板内容 ==========
  const renderSettingsPanel = () => (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-border/50">
        <h3 className="font-medium">{t('editor.settings')}</h3>
        <NotionButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={() => setShowSettingsPanel(false)}
          aria-label={t('common:close')}
        >
          <X size={16} />
        </NotionButton>
      </div>
      <CustomScrollArea className="flex-1" viewportClassName="p-4 space-y-6">
        {/* 学习统计 */}
        {stats && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.studyStats')}</h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-muted p-2">
                <div className="text-xs text-muted-foreground">{t('editor.totalQuestions')}</div>
                <div className="text-lg font-semibold">{stats.total}</div>
              </div>
              <div className="rounded-md bg-success/10 p-2">
                <div className="text-xs text-success">{t('editor.mastered')}</div>
                <div className="text-lg font-semibold text-success">{stats.mastered}</div>
              </div>
              <div className="rounded-md bg-warning/10 p-2">
                <div className="text-xs text-warning">{t('editor.needsReview')}</div>
                <div className="text-lg font-semibold text-warning">{stats.review}</div>
              </div>
              <div className="rounded-md bg-primary/10 p-2">
                <div className="text-xs text-primary">{t('editor.correctRate')}</div>
                <div className="text-lg font-semibold text-primary">{Math.round(stats.correctRate * 100)}%</div>
              </div>
            </div>
          </div>
        )}

        {/* 练习模式 */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">{t('editor.practiceMode')}</h4>
          <AppSelect value={practiceMode} onValueChange={(v) => handleModeChange(v as PracticeMode)}
            options={Object.keys(MODE_ICON).map(key => ({ value: key, label: t(`editor.modeShort.${MODE_I18N_KEY[key as PracticeMode]}`), description: t(`modes.${MODE_I18N_KEY[key as PracticeMode]}.desc`) }))}
            variant="outline"
/>
          {/* 当前模式说明 */}
          <p className="text-xs text-muted-foreground px-1">
            {t(`modes.${MODE_I18N_KEY[practiceMode]}.desc`)}
          </p>

          {practiceMode === 'by_tag' && tagOptions.length > 0 && (
            <AppSelect value={selectedTag} onValueChange={handleTagChange}
              placeholder={t('editor.selectTag')}
              options={tagOptions}
              variant="outline"
/>
          )}
        </div>

        {/* 计时器控制 */}
        {showTimer && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.timer')}</h4>
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
              <div className="flex items-center gap-2">
                <Clock className={cn('w-5 h-5', isTimerRunning ? 'text-primary' : 'text-muted-foreground')} />
                <div className="flex flex-col">
                  <span className="text-xl font-mono tabular-nums">{formatTime(timerDisplay)}</span>
                  {remainingTime != null && (
                    <span className="text-[11px] text-muted-foreground">
                      {t('timed.remaining')}
                    </span>
                  )}
                </div>
              </div>
              {allowTimerControl && (
                <NotionButton variant="ghost" size="sm" onClick={toggleTimer}>
                  {isTimerRunning ? t('editor.pause') : t('editor.resume')}
                </NotionButton>
              )}
            </div>
          </div>
        )}

        {/* 当前题目操作 */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">{t('editor.currentQuestion')}</h4>
          <div className="space-y-2">
            <NotionButton
              variant="outline"
              className="w-full justify-start gap-2"
              onClick={handleToggleFavorite}
            >
              {isFavorite ? (
                <Star size={16} className="fill-warning text-warning" />
              ) : (
                <Star size={16} />
              )}
              {isFavorite ? t('editor.unfavorite') : t('editor.favorite')}
            </NotionButton>
            {onDeleteQuestion && (
              deleteConfirmOpen ? (
                /* 内联删除确认：替代模态对话框 */
                <div className="ui-rise-in rounded-md border border-destructive/30 bg-destructive/5 p-2.5 space-y-2">
                  <p className="text-xs text-destructive flex items-start gap-1.5">
                    <WarningCircle size={14} className="flex-shrink-0 mt-0.5" />
                    {t('exam_sheet:questionBank.confirmDeleteSingle')}
                  </p>
                  <div className="flex gap-2">
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="flex-1 !h-7"
                      disabled={isDeleting}
                      onClick={() => {
                        setDeleteConfirmOpen(false);
                        setDeleteTargetId(null);
                      }}
                    >
                      {t('common:cancel')}
                    </NotionButton>
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="flex-1 !h-7 bg-destructive/10 text-destructive hover:bg-destructive/[0.15]"
                      disabled={isDeleting}
                      onClick={() => void handleConfirmDelete()}
                    >
                      {isDeleting ? (
                        <CircleNotch size={14} className="animate-spin" />
                      ) : (
                        <Trash size={14} />
                      )}
                      {t('common:delete')}
                    </NotionButton>
                  </div>
                </div>
              ) : (
                <NotionButton
                  variant="outline"
                  className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10"
                  onClick={handleRequestDelete}
                >
                  <Trash size={16} />
                  {t('common:delete')}
                </NotionButton>
              )
            )}
          </div>
        </div>

        {/* 显示设置 */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">{t('editor.displaySettings')}</h4>
          <NotionButton
            variant={focusMode ? 'default' : 'outline'}
            className="w-full justify-start gap-2"
            onClick={() => handleFocusModeChange(!focusMode)}
          >
            <Crosshair size={16} />
            {t('editor.focusMode')}
            {focusMode && <span className="ml-auto text-xs opacity-70">{t('editor.enabled')}</span>}
          </NotionButton>
          <p className="text-xs text-muted-foreground">
            {t('editor.focusModeDesc')}
          </p>
          <NotionButton
            variant={hideAnswerMode ? 'default' : 'outline'}
            className="w-full justify-start gap-2"
            onClick={() => handleHideAnswerModeChange(!hideAnswerMode)}
          >
            {hideAnswerMode ? <EyeSlash size={16} /> : <Eye size={16} />}
            {t('editor.hideAnswerMode')}
            {hideAnswerMode && <span className="ml-auto text-xs opacity-70">{t('editor.enabled')}</span>}
          </NotionButton>
          <p className="text-xs text-muted-foreground">
            {t('editor.hideAnswerModeDesc')}
          </p>
        </div>

        {/* 快捷键提示 */}
        {!isSmallScreen && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Keyboard size={16} />
              {t('editor.shortcuts')}
            </h4>
            <div className="text-xs text-muted-foreground space-y-1.5">
              <div className="flex justify-between"><span>{t('editor.shortcutSelectOption')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">1-9 / A-D</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutSubmit')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">Enter</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutNextAfterSubmit')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">Enter</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutNavigate')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">← →</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutFavorite')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">F</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutTrueFalse')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">1 / 2</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutRetry')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">R</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutPauseTimer')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">Space</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutHideAnswer')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">H</kbd></div>
            </div>
          </div>
        )}

        {/* 连对统计 */}
        {streakCount > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.currentStreak')}</h4>
            <div className="flex items-center gap-2 p-2 rounded-md bg-warning/10">
              <Flame size={16} className="text-warning" />
              <span className="text-base font-semibold text-warning">{streakCount}</span>
              <span className="text-sm text-muted-foreground">{t('editor.questionsUnit')}</span>
            </div>
          </div>
        )}
      </CustomScrollArea>
    </div>
  );

  /** 内联未保存草稿提示条：替代模态确认框，锚定在底部导航上方 */
  const draftNavigationBanner = pendingNavigationIndex !== null ? (
    <div className="ui-rise-in mx-auto max-w-3xl px-1 pb-2">
      <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/[0.08] px-3 py-2">
        <WarningCircle size={16} className="flex-shrink-0 text-warning" />
        <span className="flex-1 min-w-0 truncate text-xs text-warning">
          {t('common:confirmMessages.unsaved_changes')}
        </span>
        <NotionButton
          variant="ghost"
          size="sm"
          className="!h-7 !px-2 text-xs"
          onClick={() => setPendingNavigationIndex(null)}
        >
          {t('common:cancel')}
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="sm"
          className="!h-7 !px-2 text-xs bg-warning/10 text-warning hover:bg-warning/20"
          onClick={() => {
            const targetIndex = pendingNavigationIndex;
            setPendingNavigationIndex(null);
            if (targetIndex !== null) onNavigate?.(targetIndex);
          }}
        >
          {t('common:actions.discard')}
        </NotionButton>
      </div>
    </div>
  ) : null;

  // ========== 答题输入区（移动端与桌面端共用，覆盖全部题型） ==========
  const renderAnswerInput = () => {
    if (isChoiceQuestion && currentQuestion.options) {
      return (
        <div className="space-y-3">
          {currentQuestion.options.map((opt, index) => (
            <OptionButton
              key={opt.key}
              optionKey={opt.key}
              content={opt.content}
              isSelected={
                isMultiSelect
                  ? selectedOptions.has(opt.key)
                  : selectedAnswer === opt.key
              }
              isSubmitted={!!submitResult}
              correctAnswer={submitResult?.correctAnswer}
              onSelect={handleOptionClick}
              type={isMultiSelect ? 'multiple' : 'single'}
              shortcutHint={!isSmallScreen ? String(index + 1) : undefined}
            />
          ))}
        </div>
      );
    }
    if (qType === 'true_false') {
      return (
        <TrueFalseAnswer
          value={selectedAnswer === 'true' || selectedAnswer === 'false' ? selectedAnswer : ''}
          onChange={(v) => setSelectedAnswer(v)}
          submitted={!!submitResult}
          correctAnswer={submitResult ? trueFalseCorrectAnswer : null}
        />
      );
    }
    if (qType === 'matching' && matchingData) {
      return (
        <MatchingAnswer
          data={matchingData}
          pairs={matchingPairs}
          onChange={setMatchingPairs}
          submitted={!!submitResult}
        />
      );
    }
    if (qType === 'ordering' && orderingData) {
      return (
        <OrderingAnswer
          data={orderingData}
          order={orderingOrder}
          onChange={setOrderingOrder}
          submitted={!!submitResult}
        />
      );
    }
    if (qType === 'numeric') {
      return (
        <NumericAnswer
          value={selectedAnswer}
          onChange={setSelectedAnswer}
          spec={numericData}
          submitted={!!submitResult}
          isCorrect={submitResult ? submitResult.isCorrect : null}
        />
      );
    }
    if (qType === 'fill_blank') {
      return (
        <FillBlankAnswer
          answers={fillBlankAnswers}
          onChange={setFillBlankAnswers}
          blanks={fillBlankData}
          submitted={!!submitResult}
        />
      );
    }
    if (qType === 'short_answer') {
      return (
        <Input
          value={selectedAnswer}
          onChange={(e) => setSelectedAnswer(e.target.value)}
          placeholder={t('editor.answerPlaceholder')}
          disabled={!!submitResult}
          className="h-11"
        />
      );
    }
    return (
      <Textarea
        value={selectedAnswer}
        onChange={(e) => setSelectedAnswer(e.target.value)}
        placeholder={t('editor.answerPlaceholder')}
        disabled={!!submitResult}
        rows={4}
        className="resize-none"
      />
    );
  };

  // ========== 完成庆祝（内联卡片，随内容滚动，不使用遮罩层） ==========
  const renderCompletionCelebration = () => {
    if (!showCompletionCelebration || !completionStats) return null;
    const correctRate = completionStats.totalAnswered > 0
      ? Math.round((completionStats.correctCount / completionStats.totalAnswered) * 100)
      : 0;

    return (
      <div className="ui-rise-in p-4 rounded-md bg-card border border-border/50 shadow-sm text-center space-y-3">
        <div className="flex justify-center">
          <div className="p-2 rounded-md bg-warning/10">
            <Trophy size={24} className="text-warning qbank-anim-pop" />
          </div>
        </div>
        <div>
          <h2 className="text-lg font-semibold flex items-center justify-center gap-2">
            <Confetti size={16} className="text-warning" />
            {t('editor.congratulations')}
            <Confetti size={16} className="text-warning" />
          </h2>
          <p className="text-muted-foreground mt-1">{t('editor.completedMessage')}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 py-2">
          <div className="p-2 rounded-md bg-muted/50">
            <div className="text-lg font-semibold">{completionStats.totalAnswered}</div>
            <div className="text-xs text-muted-foreground">{t('editor.answeredCount')}</div>
          </div>
          <div className="p-2 rounded-md bg-success/10">
            <div className="text-lg font-semibold text-success">{correctRate}%</div>
            <div className="text-xs text-success">{t('editor.correctRate')}</div>
          </div>
          <div className="p-2 rounded-md bg-primary/10">
            <div className="text-lg font-semibold text-primary">{formatTime(completionStats.totalTime)}</div>
            <div className="text-xs text-primary">{t('editor.timeSpent')}</div>
          </div>
        </div>
        <div className="flex gap-2">
          <NotionButton
            variant="outline"
            className="flex-1"
            onClick={() => {
              setShowCompletionCelebration(false);
              requestNavigate(0);
            }}
          >
            <ArrowClockwise size={16} className="mr-1" />
            {t('editor.restart')}
          </NotionButton>
          <NotionButton
            className="flex-1"
            onClick={() => setShowCompletionCelebration(false)}
          >
            {t('editor.viewQuestions')}
          </NotionButton>
        </div>
      </div>
    );
  };

  // ========== 提交结果卡片（移动端与桌面端共用） ==========
  // 包含：AI 判分流式结果 / 失败重试 / 手动批改兜底 / 解析折叠 / 客观题 AI 解析
  const renderSubmitResultCard = (extraClassName?: string) => {
    if (!submitResult || editMode) return null;
    return (
      <div
        className={cn(
          'ui-rise-in p-3 rounded-md space-y-3',
          submitResult.needsManualGrading
            ? 'bg-warning/[0.08] dark:bg-warning/[0.15]'
            : submitResult.isCorrect
              ? 'bg-success/[0.08] dark:bg-success/[0.15]'
              : 'bg-destructive/[0.08] dark:bg-destructive/[0.15]',
          extraClassName
        )}
      >
        {submitResult.needsManualGrading ? (
          <>
            {/* AI 评判中 */}
            {aiGrading.state.isGrading ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-info flex items-center justify-center">
                    <Sparkle size={12} className="text-info-foreground animate-pulse" />
                  </div>
                  <span className="text-sm font-medium text-info">
                    {t('editor.aiGrading')}
                  </span>
                  <NotionButton variant="ghost" size="sm" onClick={() => aiGrading.cancelGrading()} className="ml-auto !h-auto !p-0 text-xs text-muted-foreground hover:text-foreground">
                    {t('common:cancel')}
                  </NotionButton>
                </div>
                {aiGrading.state.feedback ? (
                  <div className="pl-7.5 text-sm text-muted-foreground leading-relaxed max-h-48 overflow-y-auto">
                    <StreamingMarkdownRenderer
                      content={aiGrading.state.feedback}
                      isStreaming={true}
                    />
                  </div>
                ) : (
                  /* 流尚未产出内容：优雅加载态（三点跳动） */
                  <div className="pl-7.5 flex items-center gap-1 py-1" aria-hidden>
                    <span className="w-1.5 h-1.5 rounded-full bg-info/60 animate-bounce" />
                    <span className="w-1.5 h-1.5 rounded-full bg-info/60 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-info/60 animate-bounce [animation-delay:300ms]" />
                  </div>
                )}
              </div>
            ) : aiGrading.state.error ? (
              /* AI 评判失败，回退手动批改 + 内联重试 */
              <div className="space-y-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-warning flex items-center justify-center">
                    <WarningCircle size={12} className="text-white" />
                  </div>
                  <span className="text-sm text-warning">
                    {t('editor.aiGradingFailed')}
                  </span>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      retryAiGrading()?.catch((err) => {
                        debugLog.warn('[QuestionBankEditor] AI grading retry failed:', err);
                      });
                    }}
                    className="ml-auto !h-auto !px-2 !py-0.5 text-xs text-info hover:bg-info/10"
                  >
                    <ArrowClockwise size={12} />
                    {t('editor.aiRetry')}
                  </NotionButton>
                </div>
                {/* #56: 评判失败时保留已流式输出的内容，不再整段消失 */}
                {aiGrading.state.feedback && (
                  <div className="pl-7.5 text-sm text-muted-foreground leading-relaxed max-h-48 overflow-y-auto">
                    <StreamingMarkdownRenderer
                      content={aiGrading.state.feedback}
                      isStreaming={false}
                    />
                  </div>
                )}
                {submitResult.correctAnswer && (
                  <p className="text-sm text-muted-foreground pl-7.5">
                    {t('editor.referenceAnswerLabel')}<LatexText content={submitResult.correctAnswer} className="inline font-medium text-foreground" />
                  </p>
                )}
                {onMarkCorrect && (
                  <div className="flex gap-2 pt-1">
                    <NotionButton variant="ghost" size="sm" onClick={() => handleManualGrade(true)} disabled={isManualGrading} className="flex-1 !h-8 bg-success/10 text-success hover:bg-success/[0.15]">
                      <Check size={14} />
                      {t('editor.iGotItRight')}
                    </NotionButton>
                    <NotionButton variant="ghost" size="sm" onClick={() => handleManualGrade(false)} disabled={isManualGrading} className="flex-1 !h-8 text-destructive bg-destructive/10 hover:bg-destructive/[0.15]">
                      <X size={14} />
                      {t('editor.iGotItWrong')}
                    </NotionButton>
                  </div>
                )}
              </div>
            ) : (
              /* 等待 AI 评判（尚未开始）- 显示等待状态 + 手动兜底 */
              <div className="space-y-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-warning flex items-center justify-center">
                    <Lightbulb size={12} className="text-white" />
                  </div>
                  <div>
                    <span className="text-sm font-medium text-warning">{t('editor.subjectiveSubmitted')}</span>
                    <span className="text-xs text-muted-foreground ml-2">{t('editor.judgeSelf')}</span>
                  </div>
                </div>
                {submitResult.correctAnswer && (
                  <p className="text-sm text-muted-foreground pl-7.5">
                    {t('editor.referenceAnswerLabel')}<LatexText content={submitResult.correctAnswer} className="inline font-medium text-foreground" />
                  </p>
                )}
                {onMarkCorrect && (
                  <div className="flex gap-2 pt-1">
                    <NotionButton variant="ghost" size="sm" onClick={() => handleManualGrade(true)} disabled={isManualGrading} className="flex-1 !h-8 bg-success/10 text-success hover:bg-success/[0.15]">
                      <Check size={14} />
                      {t('editor.iGotItRight')}
                    </NotionButton>
                    <NotionButton variant="ghost" size="sm" onClick={() => handleManualGrade(false)} disabled={isManualGrading} className="flex-1 !h-8 text-destructive bg-destructive/10 hover:bg-destructive/[0.15]">
                      <X size={14} />
                      {t('editor.iGotItWrong')}
                    </NotionButton>
                  </div>
                )}
              </div>
            )}

            {/* AI 评判完成后的结果展示（verdict + score + feedback） */}
            {!aiGrading.state.isGrading && aiGrading.state.feedback && !aiGrading.state.error && (
              <div className="pt-2 border-t border-foreground/[0.06] space-y-2">
                {aiGrading.state.verdict && (
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'text-xs font-medium px-2 py-0.5 rounded-full',
                      aiGrading.state.verdict === 'correct' ? 'bg-success/10 text-success' :
                      aiGrading.state.verdict === 'partial' ? 'bg-warning/20 text-warning' :
                      'bg-destructive/10 text-destructive'
                    )}>
                      {aiGrading.state.verdict === 'correct' ? t('editor.verdictCorrect') : aiGrading.state.verdict === 'partial' ? t('editor.verdictPartial') : t('editor.verdictIncorrect')}
                    </span>
                    {aiGrading.state.score != null && (
                      <span className="text-xs text-muted-foreground">
                        {t('editor.aiScore', { score: aiGrading.state.score })}
                      </span>
                    )}
                  </div>
                )}
                <div className="text-sm text-muted-foreground leading-relaxed">
                  <StreamingMarkdownRenderer
                    content={aiGrading.state.feedback}
                    isStreaming={false}
                  />
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center',
                  submitResult.isCorrect ? 'bg-success qbank-anim-pop' : 'bg-destructive'
                )}>
                  {submitResult.isCorrect ? (
                    <Check size={12} weight="bold" className="text-white" />
                  ) : (
                    <X size={12} className="text-white" />
                  )}
                </div>
                <span className={cn(
                  'text-sm font-medium',
                  submitResult.isCorrect ? 'text-success' : 'text-destructive'
                )}>
                  {submitResult.isCorrect ? t('editor.answerCorrect') : t('editor.answerWrong')}
                </span>
                {/* 结构化题型的标准答案由作答组件内联揭示，这里不再重复展示原始 JSON */}
                {submitResult.correctAnswer && !submitResult.isCorrect && !structuredRevealsAnswer && (
                  <span className="text-sm text-muted-foreground">
                    · {t('editor.correctAnswerLabel')}<LatexText content={submitResult.correctAnswer} className="inline font-medium text-foreground" />
                  </span>
                )}
              </div>
              {/* 重做按钮 */}
              {!submitResult.isCorrect && (
                <NotionButton variant="ghost" size="sm" onClick={handleRetry} className="!h-auto !px-2.5 !py-1 text-xs text-muted-foreground hover:bg-foreground/5" title={t('editor.retryTitle')}>
                  <ArrowClockwise size={14} />
                  {t('editor.retry')}
                </NotionButton>
              )}
            </div>

            {/* 解析折叠（回退到题目自身解析） */}
            {effectiveExplanation && (
              <div className="pt-2 border-t border-foreground/[0.06]">
                <NotionButton variant="ghost" size="sm" onClick={() => setExplanationExpanded(!explanationExpanded)} className="!h-auto !p-0 text-warning hover:underline">
                  <Lightbulb size={16} />
                  {explanationExpanded ? t('editor.collapseExplanation') : t('editor.viewExplanation')}
                  {explanationExpanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
                </NotionButton>
                {explanationExpanded && (
                  <div className="ui-rise-in mt-2 text-sm text-muted-foreground leading-relaxed">
                    <MarkdownRenderer
                      content={effectiveExplanation}
                    />
                  </div>
                )}
              </div>
            )}

            {/* AI 解析按钮（客观题） */}
            <div className="pt-2 border-t border-foreground/[0.06]">
              {aiGrading.state.isGrading ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <DsAnalysisIconMuted className="w-4 h-4 text-info animate-pulse" />
                    <span className="text-sm text-info">{t('editor.aiAnalyzing')}</span>
                    <NotionButton variant="ghost" size="sm" onClick={() => aiGrading.cancelGrading()} className="ml-auto !h-auto !p-0 text-xs text-muted-foreground hover:text-foreground">
                      {t('common:cancel')}
                    </NotionButton>
                  </div>
                  {aiGrading.state.feedback ? (
                    <div className="text-sm text-muted-foreground leading-relaxed">
                      <StreamingMarkdownRenderer
                        content={aiGrading.state.feedback}
                        isStreaming={true}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 py-1" aria-hidden>
                      <span className="w-1.5 h-1.5 rounded-full bg-info/60 animate-bounce" />
                      <span className="w-1.5 h-1.5 rounded-full bg-info/60 animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-info/60 animate-bounce [animation-delay:300ms]" />
                    </div>
                  )}
                </div>
              ) : aiGrading.state.feedback ? (
                /* #56: 即使流异常中断（error 态）也保留已输出的解析内容 */
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-sm text-info">
                    <DsAnalysisIconMuted className="w-4 h-4" />
                    {t('editor.aiAnalysis')}
                  </div>
                  {aiGrading.state.error && (
                    <div className="flex items-center gap-1.5 text-xs text-warning">
                      <WarningCircle size={12} />
                      {aiGrading.state.error}
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          retryAiGrading()?.catch((err) => {
                            debugLog.warn('[QuestionBankEditor] AI analyze retry failed:', err);
                          });
                        }}
                        className="!h-auto !px-1.5 !py-0.5 text-xs text-info hover:bg-info/10"
                      >
                        <ArrowClockwise size={12} />
                        {t('editor.aiRetry')}
                      </NotionButton>
                    </div>
                  )}
                  <div className="text-sm text-muted-foreground leading-relaxed">
                    <StreamingMarkdownRenderer
                      content={aiGrading.state.feedback}
                      isStreaming={false}
                    />
                  </div>
                </div>
              ) : (currentQuestion?.ai_feedback || aiFeedbackCacheRef.current.get(currentQuestion?.id ?? '')) ? (
                /* 展示缓存的 AI 解析（prop 或本地缓存） */
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-sm text-info">
                    <DsAnalysisIconMuted className="w-4 h-4" />
                    {t('editor.aiAnalysis')}
                  </div>
                  <div className="text-sm text-muted-foreground leading-relaxed">
                    <StreamingMarkdownRenderer
                      content={currentQuestion?.ai_feedback || aiFeedbackCacheRef.current.get(currentQuestion?.id ?? '') || ''}
                      isStreaming={false}
                    />
                  </div>
                </div>
              ) : (
                <NotionButton variant="ghost" size="sm" onClick={() => {
                    if (!currentQuestion || !submitResult.submissionId) return;
                    const qId = currentQuestion.id;
                    resetAiGrading();
                    startAiGrading(
                      qId,
                      submitResult.submissionId,
                      'analyze',
                      undefined,
                      (_verdict, _score, feedback) => {
                        if (feedback) aiFeedbackCacheRef.current.set(qId, feedback);
                      },
                    ).catch((err) => { debugLog.error('[QBankEditor] AI analyze failed:', err); });
                  }} className="!h-auto !p-0 text-info hover:underline">
                  <DsAnalysisIconMuted className="w-4 h-4" />
                  {t('editor.aiAnalysis')}
                </NotionButton>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  // ========== 移动端滑动布局 ==========
  if (isSmallScreen) {
    const translateX = getBaseTranslate() + dragOffset;

    return (
      <div
        ref={containerRef}
        data-agent-qbank-editor
        className={cn('relative h-full overflow-hidden bg-background select-none', className)}
        style={{ touchAction: 'pan-y pinch-zoom' }}
      >
        <style>{QBANK_KEYFRAMES}</style>

        {/* 滑动内容容器 */}
        <div
          className="flex h-full"
          style={{
            width: `calc(100% + ${settingsPanelWidth}px)`,
            transform: `translateX(${translateX}px)`,
            transition: isDragging ? 'none' : 'transform var(--resize-dur, 300ms) var(--resize-ease, cubic-bezier(0.22, 1, 0.36, 1))',
          }}
        >
          {/* 主界面 - 顶栏由 Learning Hub 统一管理 */}
          <div
            className="h-full flex-shrink-0 flex flex-col"
            style={{ width: containerWidth || '100vw' }}
          >
            {/* 进度条 */}
            <div className="flex-shrink-0 px-3 py-1.5 border-b border-border/30">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>{t('editor.progress')}</span>
                <span className="font-medium tabular-nums">
                  {currentIndex + 1}/{totalQuestions}
                </span>
              </div>
              <Progress value={progressPercent} className="h-1" />
            </div>

            {/* 题目内容区 */}
            <CustomScrollArea className="flex-1" viewportClassName="p-3 space-y-3">
                {/* 完成庆祝（内联） */}
                {renderCompletionCelebration()}
                <div key={currentQuestion.id} className="ui-slide-fade-in" style={questionTransitionStyle}>
                <Card className="overflow-hidden border-border/60 shadow-sm">
                  <CardHeader className="pb-2 space-y-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="font-mono text-xs h-5">
                        {currentQuestion.questionLabel || `Q${currentIndex + 1}`}
                      </Badge>
                      <Badge variant="secondary" className="text-xs h-5">
                        {t(`editor.questionType.${QUESTION_TYPE_I18N_KEY[currentQuestion.questionType]}`)}
                      </Badge>
                      {/* 专注模式下隐藏难度 */}
                      {!focusMode && currentQuestion.difficulty && (
                        <Badge 
                          variant="secondary" 
                          className={cn(
                            'text-xs h-5',
                            DIFFICULTY_CONFIG[currentQuestion.difficulty].color,
                            DIFFICULTY_CONFIG[currentQuestion.difficulty].bg
                          )}
                        >
                          {t(`questionBank.difficulty.${DIFFICULTY_I18N_KEY[currentQuestion.difficulty]}`)}
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="prose prose-sm dark:prose-invert max-w-none text-base leading-relaxed">
                      <QuestionContentBlock
                        content={currentQuestion.content || currentQuestion.ocrText || t('editor.noContent')}
/>
                    </div>

                    {/* 题目图片 */}
                    {currentQuestion.images && currentQuestion.images.length > 0 && (() => {
                      const confirmedImages = currentQuestion.images!.filter(img => img.name.startsWith('crop_'));
                      const sourceImages = currentQuestion.images!.filter(img => !img.name.startsWith('crop_'));
                      return (
                        <>
                          {/* 用户确认的图片（裁剪/上传）正常显示 */}
                          {confirmedImages.length > 0 && (
                            <div className={cn(
                              'grid gap-2',
                              confirmedImages.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
                            )}>
                              {confirmedImages.map((img) => (
                                <div key={img.id} className="rounded-lg overflow-hidden border border-border/40 bg-muted/20">
                                  {questionImageUrls[img.id] ? (
                                    <InlineZoomImage
                                      src={questionImageUrls[img.id]}
                                      alt={img.name}
                                      collapsedClassName="max-h-48"
/>
                                  ) : (
                                    <div className="w-full h-24 flex items-center justify-center text-muted-foreground">
                                      <CircleNotch size={16} className="animate-spin" />
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {/* 自动关联的原始图片 — 折叠气泡，点击展开 */}
                          {sourceImages.length > 0 && (
                            <SourceImagesBubble
                              images={sourceImages}
                              imageUrls={questionImageUrls}
/>
                          )}
                        </>
                      );
                    })()}

                    {/* 原始图片裁剪入口 */}
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setCropDialogOpen(true)}
                    >
                      <Crop size={14} className="mr-1.5" />
                      {t('common:question_bank.source_images')}
                    </NotionButton>

                    {/* 答题区域 */}
                    {editMode ? (
                      <div className="space-y-3">
                        {isChoiceQuestion && currentQuestion.options && (
                          <div className="space-y-2">
                            {currentQuestion.options.map(opt => (
                              <div
                                key={opt.key}
                                className={cn(
                                  'flex items-start gap-2 rounded-md border p-2.5',
                                  currentQuestion.answer?.includes(opt.key)
                                    ? 'border-success/50 bg-success/5'
                                    : 'border-border/50'
                                )}
                              >
                                <span className={cn(
                                  'flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium',
                                  currentQuestion.answer?.includes(opt.key)
                                    ? 'bg-success text-success-foreground'
                                    : 'bg-muted'
                                )}>
                                  {opt.key}
                                </span>
                                <LatexText content={opt.content} className="text-sm flex-1" />
                              </div>
                            ))}
                          </div>
                        )}
                        {(structuredAnswerSummaryNode || currentQuestion.answer) && (
                          <div className="rounded-md border border-success/30 bg-success/5 p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Check size={14} className="text-success" />
                              <span className="text-xs font-medium text-success">{t('editor.referenceAnswer')}</span>
                            </div>
                            {structuredAnswerSummaryNode ?? (
                              <LatexText content={currentQuestion.answer!} className="text-sm" />
                            )}
                          </div>
                        )}
                        {currentQuestion.explanation && (
                          <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Lightbulb size={14} className="text-primary" />
                              <span className="text-xs font-medium text-primary">{t('editor.explanation')}</span>
                            </div>
                            <div className="text-sm">
                              <MarkdownRenderer
                                content={currentQuestion.explanation}
/>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* 暗记模式遮罩 */}
                        {hideAnswerMode && !answerRevealed && !submitResult && (
                          <NotionButton variant="ghost" size="sm" onClick={() => setAnswerRevealed(true)} className="w-full !h-auto !p-8 !rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/30 flex-col items-center justify-center gap-2 hover:bg-[var(--interactive-hover)]">
                            <Eye size={32} className="text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">{t('editor.clickToReveal')}</span>
                          </NotionButton>
                        )}

                        {/* 正常答题区域（与桌面端共用题型渲染） */}
                        {(!hideAnswerMode || answerRevealed || submitResult) && renderAnswerInput()}

                        {!submitResult && (
                          <NotionButton
                            variant="primary"
                            size="lg"
                            onClick={handleSubmit}
                            disabled={!canSubmit || isSubmitting}
                            className="w-full"
                          >
                            {isSubmitting ? (
                              <><CircleNotch size={16} className="animate-spin" />{t('editor.submitting')}</>
                            ) : (
                              <><PaperPlaneRight size={16} />{t('editor.submitAnswer')}</>
                            )}
                          </NotionButton>
                        )}

                        {/* 提交结果（含 AI 判分/解析，与桌面端共用） */}
                        {renderSubmitResultCard('mt-1')}
                      </>
                    )}
                  </CardContent>
                </Card>
                </div>
            </CustomScrollArea>

            {/* 底部导航 - 仅保留安全区域间距（历史 tab 栏已移除） */}
            <div
              className="flex-shrink-0 px-3 pt-2 pb-2 border-t border-border/50 bg-card/50"
              style={{ paddingBottom: 'max(0.5rem, var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)))' }}
            >
              {/* 未保存草稿的内联确认条 */}
              {draftNavigationBanner}
              <div className="flex items-center justify-between gap-2">
                {/* 触控目标 ≥44px（h-11），拇指可达 */}
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={() => handleNavigate('prev')}
                  disabled={currentIndex === 0}
                  className="flex-1 !h-11"
                >
                  <CaretLeft size={16} className="mr-1" />
                  {t('editor.prevQuestion')}
                </NotionButton>
                <NotionButton
                  variant={submitResult ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleNavigate('next')}
                  disabled={currentIndex === totalQuestions - 1}
                  className="flex-1 !h-11"
                >
                  {t('editor.nextQuestion')}
                  <CaretRight size={16} className="ml-1" />
                </NotionButton>
              </div>
            </div>
          </div>

          {/* 右侧设置面板 */}
          <div
            className="h-full flex-shrink-0 border-l border-border/50"
            style={{ width: settingsPanelWidth }}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
          >
            {renderSettingsPanel()}
          </div>
        </div>
        {/* 原始图片裁剪：移动端全屏内联裁剪工具（此前移动分支未挂载，裁剪入口点了没反应） */}
        {currentQuestion && (
          <ImageCropDialog
            open={cropDialogOpen}
            onOpenChange={setCropDialogOpen}
            examId={sessionId}
            questionId={currentQuestion.id}
            inline
            onImageAdded={() => {
              if (!currentQuestion?.id) return;

              const reloadImages = () => {
                setQuestionImageUrls({});
                setImageRefreshKey(k => k + 1);
              };

              if (onRefreshQuestion) {
                onRefreshQuestion(currentQuestion.id)
                  .catch((err) => {
                    debugLog.error('[QuestionBankEditor] refresh after crop failed:', err);
                  })
                  .finally(reloadImages);
                return;
              }

              reloadImages();
            }}
          />
        )}
      </div>
    );
  }

  // ========== 桌面端布局（去 head 化） ==========
  return (
    <div
      data-agent-qbank-editor
      className={cn('relative flex flex-col h-full bg-background', className)}
    >
      <style>{QBANK_KEYFRAMES}</style>

      {/* 顶部细进度条：题目切换时平滑过渡 */}
      <div className="flex-shrink-0 h-0.5 bg-border/40" role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin={1} aria-valuemax={totalQuestions}>
        <div
          className="h-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${progressPercent}%` }}
/>
      </div>

      <CustomScrollArea className="flex-1" viewportClassName="max-w-3xl mx-auto px-3 py-3 sm:p-4 space-y-3 sm:space-y-4">
          {/* 完成庆祝（内联） */}
          {renderCompletionCelebration()}
          {/* 统计卡片 - 专注模式下隐藏 */}
          {stats && !focusMode && (
            <>
              {/* 移动端：单行摘要 */}
              <div className="flex sm:hidden items-center justify-between px-3 py-2 rounded-lg bg-muted/30 text-xs">
                <span className="text-muted-foreground">
                  {t('editor.totalSummary', { count: stats.total })}
                </span>
                <span className="text-success">
                  {t('editor.masteredSummary', { count: stats.mastered })}
                </span>
                <span className="text-warning">
                  {t('editor.reviewSummary', { count: stats.review })}
                </span>
                <span className="text-primary font-medium">
                  {Math.round(stats.correctRate * 100)}%
                </span>
              </div>
              {/* 桌面端：完整卡片 */}
              <div className="hidden sm:grid grid-cols-4 gap-2">
                <StatCard 
                  icon={BookOpen} 
                  label={t('editor.totalQuestions')} 
                  value={stats.total} 
                  color="bg-muted text-muted-foreground"
                  delay={0}
/>
                <StatCard 
                  icon={Target} 
                  label={t('editor.mastered')} 
                  value={stats.mastered} 
                  color="bg-success/10 text-success"
                  delay={50}
/>
                <StatCard 
                  icon={ArrowCounterClockwise} 
                  label={t('editor.needsReview')} 
                  value={stats.review} 
                  color="bg-warning/10 text-warning"
                  delay={100}
/>
                <StatCard 
                  icon={TrendUp} 
                  label={t('editor.correctRate')} 
                  value={`${Math.round(stats.correctRate * 100)}%`} 
                  color="bg-primary/10 text-primary"
                  delay={150}
/>
              </div>
            </>
          )}

          <div key={currentQuestion.id} className="ui-slide-fade-in" style={questionTransitionStyle}>
          <Card className="overflow-hidden border-border/60 shadow-sm">
            <CardHeader className="pb-2 sm:pb-3 space-y-2">
              {/* 题目标签行 - 专注模式下简化显示 */}
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <Badge variant="outline" className="font-mono text-xs h-5">
                  {currentQuestion.questionLabel || `Q${currentIndex + 1}`}
                </Badge>
                <Badge variant="secondary" className="text-xs h-5">
                  {t(`editor.questionType.${QUESTION_TYPE_I18N_KEY[currentQuestion.questionType]}`)}
                </Badge>
                {/* 专注模式下隐藏难度和状态 */}
                {!focusMode && currentQuestion.difficulty && (
                  <Badge 
                    variant="secondary" 
                    className={cn(
                      'text-xs h-5',
                      DIFFICULTY_CONFIG[currentQuestion.difficulty].color,
                      DIFFICULTY_CONFIG[currentQuestion.difficulty].bg
                    )}
                  >
                    {t(`questionBank.difficulty.${DIFFICULTY_I18N_KEY[currentQuestion.difficulty]}`)}
                  </Badge>
                )}
                {!focusMode && currentQuestion.status && (
                  <span className={cn('text-xs', STATUS_CONFIG[currentQuestion.status].color)}>
                    {t(`questionBank.status.${STATUS_I18N_KEY[currentQuestion.status]}`)}
                  </span>
                )}
                <NotionButton
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() => setShowSettingsPanel(!showSettingsPanel)}
                  aria-label={t('editor.settings')}
                  aria-pressed={showSettingsPanel}
                  title={t('editor.settings')}
                  className="ml-auto"
                >
                  <GearSix size={16} />
                </NotionButton>
              </div>

              {/* 标签 - 专注模式下隐藏 */}
              {!focusMode && currentQuestion.tags && currentQuestion.tags.length > 0 && (
                <div className="hidden sm:flex flex-wrap gap-1.5">
                  {currentQuestion.tags.map(tag => (
                    <span 
                      key={tag} 
                      className="inline-flex items-center gap-1 rounded-md bg-muted/80 px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      <Tag size={12} />
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </CardHeader>

            <CardContent className="space-y-6">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <QuestionContentBlock
                  content={currentQuestion.content || currentQuestion.ocrText || t('editor.noContent')}
/>
              </div>

              {/* 题目图片 */}
              {currentQuestion.images && currentQuestion.images.length > 0 && (() => {
                const confirmedImgs = currentQuestion.images!.filter(img => img.name.startsWith('crop_'));
                const sourceImgs = currentQuestion.images!.filter(img => !img.name.startsWith('crop_'));
                return (
                  <>
                    {confirmedImgs.length > 0 && (
                      <div className={cn(
                        'grid gap-2',
                        confirmedImgs.length === 1 ? 'grid-cols-1 max-w-md' : 'grid-cols-2'
                      )}>
                        {confirmedImgs.map((img) => (
                          <div key={img.id} className="rounded-lg overflow-hidden border border-border/40 bg-muted/20">
                            {questionImageUrls[img.id] ? (
                              <InlineZoomImage
                                src={questionImageUrls[img.id]}
                                alt={img.name}
                                collapsedClassName="max-h-64"
/>
                            ) : (
                              <div className="w-full h-32 flex items-center justify-center text-muted-foreground">
                                <CircleNotch size={20} className="animate-spin" />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {sourceImgs.length > 0 && (
                      <SourceImagesBubble images={sourceImgs} imageUrls={questionImageUrls} />
                    )}
                  </>
                );
              })()}

              {/* 原始图片裁剪入口 */}
              <NotionButton
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setCropDialogOpen(true)}
              >
                <Crop size={14} className="mr-1.5" />
                {t('common:question_bank.source_images')}
              </NotionButton>

              {/* 编辑模式：直接显示答案和解析 */}
              {editMode ? (
                <div className="space-y-4">
                  {/* 选项展示（只读） */}
                  {isChoiceQuestion && currentQuestion.options && (
                    <div className="space-y-2">
                      {currentQuestion.options.map(opt => (
                        <div
                          key={opt.key}
                          className={cn(
                            'flex items-start gap-3 rounded-md border p-3 transition-colors',
                            currentQuestion.answer?.includes(opt.key)
                              ? 'border-success/50 bg-success/5'
                              : 'border-border/50 bg-card/30'
                          )}
                        >
                          <span className={cn(
                            'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-sm font-medium',
                            currentQuestion.answer?.includes(opt.key)
                              ? 'bg-success text-success-foreground'
                              : 'bg-muted text-muted-foreground'
                          )}>
                            {opt.key}
                          </span>
                          <LatexText content={opt.content} className="text-sm flex-1" />
                          {currentQuestion.answer?.includes(opt.key) && (
                            <Check size={16} className="text-success flex-shrink-0" />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 答案显示（结构化题型渲染可读摘要而非原始 JSON） */}
                  {(structuredAnswerSummaryNode || currentQuestion.answer) && (
                    <div className="rounded-md border border-success/30 bg-success/5 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Check size={16} className="text-success" />
                        <span className="text-sm font-medium text-success">{t('editor.referenceAnswer')}</span>
                      </div>
                      {structuredAnswerSummaryNode ?? (
                        <LatexText content={currentQuestion.answer!} className="text-sm" />
                      )}
                    </div>
                  )}

                  {/* 解析显示 */}
                  {currentQuestion.explanation && (
                    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Lightbulb size={16} className="text-primary" />
                        <span className="text-sm font-medium text-primary">{t('editor.explanation')}</span>
                      </div>
                      <div className="text-sm">
                        <MarkdownRenderer
                          content={currentQuestion.explanation}
/>
                      </div>
                    </div>
                  )}

                  {/* 无答案提示 */}
                  {!structuredAnswerSummaryNode && !currentQuestion.answer && !currentQuestion.explanation && (
                    <div className="rounded-md bg-muted/50 p-3 text-center">
                      <p className="text-sm text-muted-foreground">{t('editor.noAnswerOrExplanation')}</p>
                    </div>
                  )}
                </div>
              ) : (
                /* 做题模式：答题 UI */
                <>
                  {/* 暗记模式遮罩 */}
                  {hideAnswerMode && !answerRevealed && !submitResult && (
                    <NotionButton variant="ghost" size="sm" onClick={() => setAnswerRevealed(true)} className="w-full !h-auto !p-12 !rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/30 flex-col items-center justify-center gap-3 hover:bg-[var(--interactive-hover)]">
                      <Eye size={40} className="text-muted-foreground" />
                      <span className="text-muted-foreground">{t('editor.clickToRevealWithKey')}</span>
                    </NotionButton>
                  )}

                  {/* 正常答题区域（与移动端共用题型渲染） */}
                  {(!hideAnswerMode || answerRevealed || submitResult) && (
                    <div className="space-y-4">
                      {renderAnswerInput()}
                    </div>
                  )}

                  {!submitResult && (
                    <NotionButton
                      variant="primary"
                      size="lg"
                      onClick={handleSubmit}
                      disabled={!canSubmit || isSubmitting}
                      className="w-full"
                    >
                      {isSubmitting ? (
                        <>
                          <CircleNotch size={16} className="animate-spin" />
                          {t('editor.submitting')}
                        </>
                      ) : (
                        <>
                          <PaperPlaneRight size={16} />
                          {t('editor.submitAnswer')}
                        </>
                      )}
                    </NotionButton>
                  )}

                  {/* 内联快捷键提示（桌面端，按题型展示对应提示） */}
                  {!isSmallScreen && (
                    <p className="text-center text-[11px] text-muted-foreground/60 select-none">
                      {submitResult
                        ? t('editor.inlineShortcutHintAfterSubmit')
                        : isChoiceQuestion
                          ? t('editor.inlineShortcutHint')
                          : qType === 'true_false'
                            ? t('editor.inlineShortcutHintTrueFalse')
                            : t('editor.inlineShortcutHintGeneric')}
                    </p>
                  )}
                </>
              )}

              {/* 提交结果（含 AI 判分/解析，与移动端共用） */}
              {renderSubmitResultCard()}

              {/* 用户笔记：内联展开编辑，失焦自动保存 */}
              {!editMode && (
                <div className="pt-4 border-t border-border/30">
                  {isEditingNote ? (
                    <div className="ui-rise-in space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium flex items-center gap-1.5">
                          <Note size={16} className="text-warning" />
                          {t('editor.myNotes')}
                          {/* 自动保存指示 */}
                          {noteSaveState === 'saving' && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground font-normal">
                              <CircleNotch size={12} className="animate-spin" />
                              {t('editor.noteSaving')}
                            </span>
                          )}
                          {noteSaveState === 'saved' && (
                            <span className="ui-rise-in flex items-center gap-1 text-xs text-success font-normal">
                              <Check size={12} />
                              {t('editor.noteSaved')}
                            </span>
                          )}
                          {noteSaveState === 'error' && (
                            <span className="flex items-center gap-1 text-xs text-destructive font-normal">
                              <WarningCircle size={12} />
                              {t('editor.noteSaveFailed')}
                            </span>
                          )}
                        </span>
                        <NotionButton
                          variant="primary"
                          size="sm"
                          onClick={handleSaveNote}
                          disabled={!onUpdateUserNote || noteSaveState === 'saving'}
                        >
                          {t('editor.noteDone')}
                        </NotionButton>
                      </div>
                      <Textarea
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        onBlur={handleNoteBlur}
                        placeholder={t('editor.notePlaceholder')}
                        rows={3}
                        autoFocus
                        className="resize-none text-sm"
/>
                      <p className="text-[11px] text-muted-foreground/60">
                        {t('editor.noteAutoSaveHint')}
                      </p>
                    </div>
                  ) : (
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditingNote(true)}
                      disabled={!onUpdateUserNote}
                      className="w-full !justify-start !h-auto !rounded-md !p-3 border border-dashed border-border/50 hover:border-border hover:bg-[var(--interactive-hover)] group"
                    >
                      <div className="flex items-center gap-2 text-sm w-full">
                        <Note size={16} className="text-warning" />
                        <span className="font-medium">{t('editor.myNotes')}</span>
                        {!currentQuestion?.userNote && (
                          <span className="text-muted-foreground text-xs group-hover:hidden">{t('editor.clickToAdd')}</span>
                        )}
                      </div>
                      {currentQuestion?.userNote && (
                        <p className="mt-1.5 text-sm text-muted-foreground line-clamp-2 text-left w-full">
                          {currentQuestion.userNote}
                        </p>
                      )}
                    </NotionButton>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
          </div>
      </CustomScrollArea>

      <div className="flex-shrink-0 border-t border-border/40 bg-background safe-area-bottom">
        <div className="px-4 py-3">
          {/* 未保存草稿的内联确认条 */}
          {draftNavigationBanner}
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => handleNavigate('prev')}
              disabled={currentIndex === 0}
              className="h-8 px-3"
            >
              <CaretLeft size={16} className="mr-1" />
              {t('editor.prevQuestion')}
            </NotionButton>

            <Popover>
              <PopoverTrigger asChild>
                <NotionButton variant="ghost" size="sm" className="!px-3 !py-1.5 hover:bg-[var(--interactive-hover)]">
                  <span className="font-medium">{currentIndex + 1}</span>
                  <span className="text-muted-foreground">/ {totalQuestions}</span>
                  <CaretDown size={14} className="text-muted-foreground" />
                </NotionButton>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-3" align="center" side="top" sideOffset={8}>
                {/* 搜索框 */}
                <div className="relative mb-3">
                  <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('editor.searchPlaceholder')}
                    className="h-8 pl-8 text-sm"
/>
                </div>
                <div className="text-xs text-muted-foreground mb-2">
                  {filteredQuestionIndices 
                    ? t('editor.foundCount', { count: filteredQuestionIndices.length })
                    : t('editor.jumpToQuestion')}
                </div>
                <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto">
                  {(filteredQuestionIndices || questions.map((_, idx) => idx)).map((idx) => {
                    const q = questions[idx];
                    const status = q.status || 'new';
                    return (
                      <NotionButton key={q.id} variant="ghost" size="icon" iconOnly onClick={() => { requestNavigate(idx); setSearchQuery(''); }} className={cn('!w-7 !h-7 text-xs font-medium', idx === currentIndex && 'bg-primary text-primary-foreground', idx !== currentIndex && status === 'mastered' && 'bg-success/10 text-success hover:bg-success/20', idx !== currentIndex && status === 'review' && 'bg-warning/10 text-warning hover:bg-warning/20', idx !== currentIndex && status === 'new' && 'bg-muted/50 text-muted-foreground hover:bg-[var(--interactive-hover)]', idx !== currentIndex && status === 'in_progress' && 'bg-primary/10 text-primary hover:bg-primary/20')}>
                        {idx + 1}
                      </NotionButton>
                    );
                  })}
                </div>
                <div className="flex items-center gap-3 mt-3 pt-2 border-t border-border/40 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-success/20" /> {t('editor.legendMastered')}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-warning/20" /> {t('editor.legendReview')}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-muted" /> {t('editor.legendNew')}</span>
                </div>
              </PopoverContent>
            </Popover>

            <NotionButton
              variant={submitResult ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleNavigate('next')}
              disabled={currentIndex === totalQuestions - 1}
              className="h-8 px-3"
            >
              {t('editor.nextQuestion')}
              <CaretRight size={16} className="ml-1" />
            </NotionButton>
          </div>
        </div>
      </div>
      {showSettingsPanel && (
        <aside
          className="absolute inset-y-0 right-0 z-20 w-80 max-w-[calc(100%-2rem)] border-l border-border/50 bg-background shadow-[var(--shadow-shell-floating)]"
          aria-label={t('editor.settings')}
        >
          {renderSettingsPanel()}
        </aside>
      )}
      {/* 原始图片裁剪：容器内内联裁剪工具（非模态浮层） */}
      {currentQuestion && (
        <ImageCropDialog
          open={cropDialogOpen}
          onOpenChange={setCropDialogOpen}
          examId={sessionId}
          questionId={currentQuestion.id}
          inline
          onImageAdded={() => {
            if (!currentQuestion?.id) return;

            const reloadImages = () => {
              setQuestionImageUrls({});
              setImageRefreshKey(k => k + 1);
            };

            if (onRefreshQuestion) {
              onRefreshQuestion(currentQuestion.id)
                .catch((err) => {
                  debugLog.error('[QuestionBankEditor] refresh after crop failed:', err);
                })
                .finally(reloadImages);
              return;
            }

            reloadImages();
          }}
/>
      )}
    </div>
  );
};

export default QuestionBankEditor;
