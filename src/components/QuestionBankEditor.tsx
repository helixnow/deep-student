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
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { formatTime } from '@/utils/formatUtils';
import { MarkdownRenderer, StreamingMarkdownRenderer } from '@/chat-v2/components/renderers';
import DsAnalysisIconMuted from '@/components/icons/DsAnalysisIconMuted';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  Shuffle,
  ListOrdered,
  RotateCcw,
  Tag,
  Loader2,
  BookOpen,
  Target,
  TrendingUp,
  AlertCircle,
  Lightbulb,
  Send,
  Clock,
  Star,
  MoreHorizontal,
  Settings2,
  PanelRightOpen,
  Focus,
  RefreshCw,
  StickyNote,
  Search,
  Flame,
  Trophy,
  Eye,
  EyeOff,
  Sparkles,
  PartyPopper,
  Keyboard,
} from 'lucide-react';

import type {
  QuestionType,
  QuestionStatus,
  Difficulty,
  PracticeMode,
  QuestionOption,
  QuestionImage,
  Question,
  QuestionBankStats,
  SubmitResult,
} from '@/api/questionBankApi';

/** 编辑模式下的题目更新数据 */
export interface QuestionUpdateData {
  answer?: string;
  explanation?: string;
  difficulty?: Difficulty;
  tags?: string[];
  userNote?: string;
}

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
  onToggleFavorite?: (questionId: string, isFavorite: boolean) => Promise<void>;
  /** 编辑模式：更新题目信息 */
  onUpdateQuestion?: (questionId: string, data: QuestionUpdateData) => Promise<void>;
  /** 编辑模式：删除题目 */
  onDeleteQuestion?: (questionId: string) => Promise<void>;
  onBack?: () => void;
  className?: string;
  showTimer?: boolean;
  timerDuration?: number;
  /** 专注模式：隐藏统计卡片和标签，聚焦刷题 */
  focusMode?: boolean;
  onFocusModeChange?: (focusMode: boolean) => void;
  /** 暗记模式：遮挡答案区域 */
  hideAnswerMode?: boolean;
  onHideAnswerModeChange?: (hideMode: boolean) => void;
  /** 更新用户笔记 */
  onUpdateUserNote?: (questionId: string, note: string) => Promise<void>;
  /** 答题进度持久化 key */
  persistKey?: string;
}

const DIFFICULTY_CONFIG: Record<Difficulty, { color: string; bg: string }> = {
  easy: { color: 'text-emerald-600', bg: 'bg-emerald-500/10' },
  medium: { color: 'text-amber-600', bg: 'bg-amber-500/10' },
  hard: { color: 'text-orange-600', bg: 'bg-orange-500/10' },
  very_hard: { color: 'text-rose-600', bg: 'bg-rose-500/10' },
};

const STATUS_CONFIG: Record<QuestionStatus, { color: string }> = {
  new: { color: 'text-slate-500' },
  in_progress: { color: 'text-sky-500' },
  mastered: { color: 'text-emerald-500' },
  review: { color: 'text-amber-500' },
};

const MODE_ICON: Record<PracticeMode, React.ElementType> = {
  sequential: ListOrdered,
  random: Shuffle,
  review_first: RotateCcw,
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
const QUESTION_TYPE_I18N_KEY: Record<QuestionType, string> = {
  single_choice: 'singleChoice',
  multiple_choice: 'multipleChoice',
  indefinite_choice: 'indefiniteChoice',
  fill_blank: 'fillBlank',
  short_answer: 'shortAnswer',
  essay: 'essay',
  calculation: 'calculation',
  proof: 'proof',
  other: 'other',
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
    className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors"
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
  onClick: () => void;
  type: 'single' | 'multiple';
}

const OptionButton: React.FC<OptionButtonProps> = ({
  optionKey,
  content,
  isSelected,
  isSubmitted,
  correctAnswer,
  onClick,
  type,
}) => {
  const { t } = useTranslation('practice');
  const isThisCorrect = correctAnswer?.includes(optionKey);
  const isWrong = isSubmitted && isSelected && !isThisCorrect;
  const showCorrect = isSubmitted && isThisCorrect;
  
  return (
    <button
      onClick={onClick}
      disabled={isSubmitted}
      className={cn(
        'group w-full text-left rounded-md transition-colors duration-100',
        // 默认状态 - Notion 风格：极淡边框，悬停时淡灰背景
        !isSubmitted && !isSelected && [
          'hover:bg-foreground/[0.04]',
        ],
        // 选中状态 - 淡蓝背景
        !isSubmitted && isSelected && 'bg-primary/[0.07] dark:bg-primary/[0.15]',
        // 正确答案 - 淡绿背景
        showCorrect && 'bg-emerald-600/[0.08] dark:bg-emerald-600/[0.15]',
        // 错误答案 - 淡红背景
        isWrong && 'bg-destructive/[0.08] dark:bg-destructive/[0.15]',
        // 已提交但非选中非正确
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
          // 正确 - 绿色填充
          showCorrect && 'bg-emerald-600 dark:bg-emerald-500 text-white',
          // 错误 - 红色填充
          isWrong && 'bg-destructive text-white',
          // 已提交非选中非正确
          isSubmitted && !isSelected && !isThisCorrect && 'border border-foreground/[0.08] text-foreground/35'
        )}>
          {showCorrect ? (
            <Check className="w-3.5 h-3.5" />
          ) : isWrong ? (
            <X className="w-3.5 h-3.5" />
          ) : (
            optionKey
          )}
        </div>
        
        {/* 选项内容 */}
        <div className="flex-1 min-w-0 pt-0.5">
          <span className={cn(
            'text-sm leading-relaxed',
            !isSubmitted && 'text-foreground',
            showCorrect && 'text-emerald-600 dark:text-emerald-400',
            isWrong && 'text-destructive',
            isSubmitted && !isSelected && !isThisCorrect && 'text-foreground/50'
          )}>
            {content}
          </span>
        </div>
        
        {/* 状态文字 - Notion 风格：简洁文字标识 */}
        {showCorrect && (
          <span className="flex-shrink-0 text-xs text-emerald-600 dark:text-emerald-400">
            {t('editor.correct')}
          </span>
        )}
        {isWrong && (
          <span className="flex-shrink-0 text-xs text-destructive">
            {t('editor.wrong')}
          </span>
        )}
      </div>
    </button>
  );
};

export const QuestionBankEditor: React.FC<QuestionBankEditorProps> = ({
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
  onToggleFavorite,
  onUpdateQuestion,
  onDeleteQuestion,
  onBack,
  className,
  showTimer = true,
  timerDuration,
  editMode = false,
  focusMode: focusModeProp,
  onFocusModeChange,
  hideAnswerMode: hideAnswerModeProp,
  onHideAnswerModeChange,
  onUpdateUserNote,
  persistKey,
}) => {
  const { t } = useTranslation('practice');
  const [selectedAnswer, setSelectedAnswer] = useState<string>('');
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [selectedTag, setSelectedTag] = useState<string>(selectedTagProp ?? '');

  // AI 评判 Hook
  const aiGrading = useQbankAiGrading();
  // AI 解析缓存（questionId -> feedback），跨题目切换保持
  const aiFeedbackCacheRef = useRef<Map<string, string>>(new Map());
  
  // P1-2: 计时功能
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(true);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  
  // P1-3: 设置面板状态（收藏/书签现在从 question 数据读取，不再使用本地状态）
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  
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
  
  // 用户笔记编辑
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  
  // 答案解析折叠
  const [explanationExpanded, setExplanationExpanded] = useState(false);
  
  // 题目搜索
  const [searchQuery, setSearchQuery] = useState('');
  
  // 连对计数 & 激励
  const [streakCount, setStreakCount] = useState(0);
  const [totalCorrectCount, setTotalCorrectCount] = useState(0);
  const [showStreakAnimation, setShowStreakAnimation] = useState(false);
  const [streakMilestone, setStreakMilestone] = useState<number | null>(null);
  
  // 完成庆祝
  const [showCompletionCelebration, setShowCompletionCelebration] = useState(false);
  const [completionStats, setCompletionStats] = useState<{
    totalAnswered: number;
    correctCount: number;
    totalTime: number;
  } | null>(null);
  
  // 单题计时（使用 ref 避免 stale closure）
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());
  const questionStartTimeRef = useRef<number>(questionStartTime);
  questionStartTimeRef.current = questionStartTime;
  const [questionTimes, setQuestionTimes] = useState<Record<string, number>>({});
  const prevQuestionIdRef = useRef<string | undefined>(undefined);
  
  // 填空题多空位
  const [fillBlankAnswers, setFillBlankAnswers] = useState<string[]>([]);

  // 题目图片预览
  const [questionImageUrls, setQuestionImageUrls] = useState<Record<string, string>>({});

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

    const onTouchStart = (e: TouchEvent) => {
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

  // 监听 Store 中的设置面板状态（替代 window.addEventListener）
  const storeShowSettingsPanel = useQuestionBankStore(state => state.showSettingsPanel);
  useEffect(() => {
    setShowSettingsPanel(storeShowSettingsPanel);
  }, [storeShowSettingsPanel]);

  // 计时器逻辑
  useEffect(() => {
    if (showTimer && isTimerRunning) {
      timerRef.current = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [showTimer, isTimerRunning]);

  // 题目切换时重置状态和记录单题用时（使用 ref 避免 stale closure）
  useEffect(() => {
    // 记录上一题的用时
    const prevId = prevQuestionIdRef.current;
    const startTime = questionStartTimeRef.current;
    if (prevId && startTime) {
      const timeSpent = Math.floor((Date.now() - startTime) / 1000);
      setQuestionTimes(prev => ({
        ...prev,
        [prevId]: (prev[prevId] || 0) + timeSpent
      }));
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

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    questions.forEach(q => q.tags?.forEach(t => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [questions]);

  // 解析填空题的空位数量
  const fillBlankCount = useMemo(() => {
    if (currentQuestion?.questionType !== 'fill_blank') return 0;
    const content = currentQuestion.content || currentQuestion.ocrText || '';
    const matches = content.match(/_{2,}|（\s*）|\(\s*\)/g);
    return matches ? matches.length : 1;
  }, [currentQuestion]);

  // 题目切换时重置答题状态
  useEffect(() => {
    setSelectedAnswer('');
    setSelectedOptions(new Set());
    setSubmitResult(null);
    setFillBlankAnswers(new Array(fillBlankCount).fill(''));
    aiGrading.resetState();
    // 初始化笔记文本
    setNoteText(currentQuestion?.userNote || '');
    setIsEditingNote(false);
    // 加载题目图片（带竞态保护和缓存控制）
    let cancelled = false;
    if (currentQuestion?.images && currentQuestion.images.length > 0) {
      const loadImages = async () => {
        const imagesToLoad = currentQuestion.images!.filter(
          img => !questionImageUrls[img.id] || questionImageUrls[img.id] === 'error'
        );
        const cachedUrls: Record<string, string> = {};
        currentQuestion.images!.forEach(img => {
          if (questionImageUrls[img.id] && questionImageUrls[img.id] !== 'error') {
            cachedUrls[img.id] = questionImageUrls[img.id];
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
  }, [currentIndex, currentQuestion?.id, fillBlankCount]);

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

  const handleSubmit = useCallback(async () => {
    if (!currentQuestion || !onSubmitAnswer) return;
    
    const isMulti = currentQuestion.questionType === 'multiple_choice'
      || currentQuestion.questionType === 'indefinite_choice';
    const isFillBlank = currentQuestion.questionType === 'fill_blank' && fillBlankCount > 1;
    
    let answer: string;
    if (isFillBlank) {
      answer = fillBlankAnswers.join('|||');
    } else if (isMulti) {
      answer = Array.from(selectedOptions).sort().join('');
    } else {
      answer = selectedAnswer;
    }
    
    if (!answer.trim()) return;
    
    setIsSubmitting(true);
    try {
      const result = await onSubmitAnswer(currentQuestion.id, answer, currentQuestion.questionType);
      setSubmitResult(result);

      // 主观题：自动触发 AI 评判
      if (result.needsManualGrading && result.submissionId) {
        const questionId = currentQuestion.id;
        aiGrading.resetState();
        aiGrading.startGrading(
          questionId,
          result.submissionId,
          'grade',
          undefined,
          // onComplete 回调：在事件 handler 中直接获取最新 verdict/score
          (verdict) => {
            if (verdict) {
              const isCorrect = verdict === 'correct';
              setSubmitResult(prev => prev ? { ...prev, isCorrect, needsManualGrading: false } : null);
              // 同步到后端
              if (onMarkCorrect) {
                onMarkCorrect(questionId, isCorrect).catch((err) => {
                  debugLog.error('[QuestionBankEditor] markCorrect after AI grading failed:', err);
                  // 回滚乐观更新，恢复手动批改状态
                  setSubmitResult(prev => prev ? { ...prev, isCorrect: false, needsManualGrading: true } : null);
                  showGlobalNotification('error', t('exam_sheet:errors.manual_grade_failed', '评分同步失败，请手动重试'));
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
        // 检查里程碑 (3, 5, 10, 15, 20...)
        const milestones = [3, 5, 10, 15, 20, 30, 50];
        if (milestones.includes(newStreak)) {
          setStreakMilestone(newStreak);
          setShowStreakAnimation(true);
          setTimeout(() => setShowStreakAnimation(false), 2000);
        }
      } else if (result.isCorrect === false) {
        // 仅明确错误时中断连对，null(主观题)不中断
        setStreakCount(0);
      }

      // 检查是否完成所有题目：基于已作答题目数，而非当前索引
      const answeredCount = Object.keys(questionTimes).length + 1; // +1 for current question
      if (answeredCount >= totalQuestions && totalQuestions > 0) {
        // result.isCorrect 可能为 null（主观题），null 不计为正确也不计为错误
        const finalCorrectCount = totalCorrectCount + (result.isCorrect === true ? 1 : 0);
        setCompletionStats({
          totalAnswered: answeredCount,
          correctCount: finalCorrectCount,
          totalTime: elapsedTime
        });
        setTimeout(() => setShowCompletionCelebration(true), 500);
      }
    } catch (err) {
      debugLog.error('Submit answer failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.submit_failed', '提交答案失败，请重试'));
    } finally {
      setIsSubmitting(false);
    }
  }, [currentQuestion, selectedAnswer, selectedOptions, fillBlankAnswers, fillBlankCount, onSubmitAnswer, streakCount, totalCorrectCount, currentIndex, totalQuestions, questionTimes, elapsedTime]);

  // 重做当前题目
  const handleRetry = useCallback(() => {
    setSelectedAnswer('');
    setSelectedOptions(new Set());
    setSubmitResult(null);
    setFillBlankAnswers(new Array(fillBlankCount).fill(''));
    setAnswerRevealed(false);
    aiGrading.resetState();
  }, [fillBlankCount]);

  // 保存用户笔记
  const handleSaveNote = useCallback(async () => {
    if (!currentQuestion || !onUpdateUserNote) return;
    try {
      await onUpdateUserNote(currentQuestion.id, noteText);
      setIsEditingNote(false);
    } catch (err) {
      debugLog.error('Save note failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.save_note_failed', '保存笔记失败'));
    }
  }, [currentQuestion, noteText, onUpdateUserNote]);

  const handleManualGrade = useCallback(async (isCorrect: boolean) => {
    if (!currentQuestion || !onMarkCorrect) return;
    try {
      await onMarkCorrect(currentQuestion.id, isCorrect);
      setSubmitResult(prev => prev ? { ...prev, isCorrect, needsManualGrading: false } : null);
    } catch (err) {
      debugLog.error('Manual grade failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.manual_grade_failed', '评分失败，请重试'));
    }
  }, [currentQuestion, onMarkCorrect, t]);

  const handleNavigate = useCallback((direction: 'prev' | 'next') => {
    if (!onNavigate) return;
    const newIndex = direction === 'prev' 
      ? Math.max(0, currentIndex - 1)
      : Math.min(totalQuestions - 1, currentIndex + 1);
    onNavigate(newIndex);
  }, [currentIndex, totalQuestions, onNavigate]);

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
      showGlobalNotification('error', t('exam_sheet:errors.toggle_favorite_failed', '收藏操作失败，请重试'));
    }
  }, [currentQuestion, onToggleFavorite, t]);

  // P1-2: 计时器控制
  const toggleTimer = useCallback(() => {
    setIsTimerRunning(prev => !prev);
  }, []);

  // 从 question 数据读取收藏状态（SSOT: store -> question -> UI）
  const isFavorite = currentQuestion?.isFavorite ?? false;

  // 提前定义 canSubmit 以供键盘快捷键使用
  const canSubmit = useMemo(() => {
    if (submitResult) return false;
    const isMulti = currentQuestion?.questionType === 'multiple_choice'
      || currentQuestion?.questionType === 'indefinite_choice';
    const isFillBlank = currentQuestion?.questionType === 'fill_blank' && fillBlankCount > 1;
    if (isMulti) {
      return selectedOptions.size > 0;
    }
    if (isFillBlank) {
      return fillBlankAnswers.some(a => a.trim().length > 0);
    }
    return selectedAnswer.trim().length > 0;
  }, [currentQuestion?.questionType, selectedAnswer, selectedOptions, submitResult, fillBlankAnswers, fillBlankCount]);

  // ========== 键盘快捷键支持 ==========
  useEffect(() => {
    if (editMode || isSmallScreen) return; // 编辑模式和移动端不启用快捷键
    
    const handleKeyDown = (e: KeyboardEvent) => {
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
      
      // Enter 提交答案
      if (e.key === 'Enter' && !e.shiftKey && canSubmit && !isSubmitting) {
        e.preventDefault();
        handleSubmit();
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
    editMode, isSmallScreen, currentQuestion, submitResult, canSubmit, isSubmitting,
    currentIndex, totalQuestions, showTimer, hideAnswerMode, answerRevealed,
    handleOptionClick, handleSubmit, handleNavigate, handleRetry, toggleTimer, handleHideAnswerModeChange
  ]);

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center min-h-[400px]', className)}>
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-sky-500" />
          <p className="text-sm text-muted-foreground">{t('editor.loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex items-center justify-center min-h-[400px]', className)}>
        <div className="flex flex-col items-center gap-4 text-center px-6">
          <div className="p-3 rounded-full bg-rose-500/10">
            <AlertCircle className="w-8 h-8 text-rose-500" />
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
          <div className="p-4 rounded-2xl bg-muted/50">
            <BookOpen className="w-10 h-10 text-muted-foreground" />
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

  // ========== 右侧设置面板内容 ==========
  const renderSettingsPanel = () => (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-shrink-0 px-4 py-3 border-b border-border/50">
        <h3 className="font-medium">{t('editor.settings')}</h3>
      </div>
      <CustomScrollArea className="flex-1" viewportClassName="p-4 space-y-6">
        {/* 学习统计 */}
        {stats && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.studyStats')}</h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-lg bg-slate-500/10">
                <div className="text-xs text-muted-foreground">{t('editor.totalQuestions')}</div>
                <div className="text-lg font-semibold">{stats.total}</div>
              </div>
              <div className="p-3 rounded-lg bg-emerald-500/10">
                <div className="text-xs text-emerald-600">{t('editor.mastered')}</div>
                <div className="text-lg font-semibold text-emerald-600">{stats.mastered}</div>
              </div>
              <div className="p-3 rounded-lg bg-amber-500/10">
                <div className="text-xs text-amber-600">{t('editor.needsReview')}</div>
                <div className="text-lg font-semibold text-amber-600">{stats.review}</div>
              </div>
              <div className="p-3 rounded-lg bg-sky-500/10">
                <div className="text-xs text-sky-600">{t('editor.correctRate')}</div>
                <div className="text-lg font-semibold text-sky-600">{Math.round(stats.correctRate * 100)}%</div>
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

          {practiceMode === 'by_tag' && allTags.length > 0 && (
            <AppSelect value={selectedTag} onValueChange={handleTagChange}
              placeholder={t('editor.selectTag')}
              options={allTags.map(tag => ({ value: tag, label: tag }))}
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
                <Clock className={cn('w-5 h-5', isTimerRunning ? 'text-sky-500' : 'text-muted-foreground')} />
                <span className="text-xl font-mono tabular-nums">{formatTime(elapsedTime)}</span>
              </div>
              <NotionButton variant="ghost" size="sm" onClick={toggleTimer}>
                {isTimerRunning ? t('editor.pause') : t('editor.resume')}
              </NotionButton>
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
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
              ) : (
                <Star className="w-4 h-4" />
              )}
              {isFavorite ? t('editor.unfavorite') : t('editor.favorite')}
            </NotionButton>
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
            <Focus className="w-4 h-4" />
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
            {hideAnswerMode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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
              <Keyboard className="w-4 h-4" />
              {t('editor.shortcuts')}
            </h4>
            <div className="text-xs text-muted-foreground space-y-1.5">
              <div className="flex justify-between"><span>{t('editor.shortcutSelectOption')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">1-9</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutSubmit')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">Enter</kbd></div>
              <div className="flex justify-between"><span>{t('editor.shortcutNavigate')}</span><kbd className="px-1.5 py-0.5 rounded bg-muted">← →</kbd></div>
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
            <div className="flex items-center gap-2 p-3 rounded-lg bg-gradient-to-r from-orange-500/10 to-amber-500/10">
              <Flame className="w-5 h-5 text-orange-500" />
              <span className="text-lg font-bold text-orange-600">{streakCount}</span>
              <span className="text-sm text-muted-foreground">{t('editor.questionsUnit')}</span>
            </div>
          </div>
        )}
      </CustomScrollArea>
    </div>
  );

  // ========== 连对激励动效组件 - Notion 极简风格 ==========
  const renderStreakAnimation = () => {
    if (!showStreakAnimation || !streakMilestone) return null;
    return (
      <div 
        className="absolute bottom-20 left-1/2 z-50 pointer-events-none"
        style={{
          animation: 'streakSlideUp 2s ease-out forwards'
        }}
      >
        <style>{`
          @keyframes streakSlideUp {
            0% { opacity: 0; transform: translate(-50%, 20px); }
            15% { opacity: 1; transform: translate(-50%, 0); }
            85% { opacity: 1; transform: translate(-50%, 0); }
            100% { opacity: 0; transform: translate(-50%, -10px); }
          }
        `}</style>
        <div className="flex items-center gap-2 px-4 py-2 rounded-md bg-foreground text-background">
          <span className="text-sm font-medium">{t('editor.streakMessage', { count: streakMilestone })}</span>
          <span className="w-1 h-1 rounded-full bg-current opacity-40" />
          <span className="text-sm opacity-70">{t('editor.keepItUp')}</span>
        </div>
      </div>
    );
  };

  // ========== 完成庆祝页面 ==========
  const renderCompletionCelebration = () => {
    if (!showCompletionCelebration || !completionStats) return null;
    const correctRate = completionStats.totalAnswered > 0 
      ? Math.round((completionStats.correctCount / completionStats.totalAnswered) * 100) 
      : 0;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <div className="max-w-sm mx-4 p-6 rounded-2xl bg-card border shadow-2xl text-center space-y-4">
          <div className="flex justify-center">
            <div className="p-4 rounded-full bg-gradient-to-br from-amber-400 to-orange-500">
              <Trophy className="w-12 h-12 text-white" />
            </div>
          </div>
          <div>
            <h2 className="text-2xl font-bold flex items-center justify-center gap-2">
              <PartyPopper className="w-6 h-6 text-amber-500" />
              {t('editor.congratulations')}
              <PartyPopper className="w-6 h-6 text-amber-500" />
            </h2>
            <p className="text-muted-foreground mt-1">{t('editor.completedMessage')}</p>
          </div>
          <div className="grid grid-cols-3 gap-3 py-4">
            <div className="p-3 rounded-lg bg-muted/50">
              <div className="text-2xl font-bold">{completionStats.totalAnswered}</div>
              <div className="text-xs text-muted-foreground">{t('editor.answeredCount')}</div>
            </div>
            <div className="p-3 rounded-lg bg-emerald-500/10">
              <div className="text-2xl font-bold text-emerald-600">{correctRate}%</div>
              <div className="text-xs text-emerald-600">{t('editor.correctRate')}</div>
            </div>
            <div className="p-3 rounded-lg bg-sky-500/10">
              <div className="text-2xl font-bold text-sky-600">{formatTime(completionStats.totalTime)}</div>
              <div className="text-xs text-sky-600">{t('editor.timeSpent')}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <NotionButton 
              variant="outline" 
              className="flex-1"
              onClick={() => {
                setShowCompletionCelebration(false);
                onNavigate?.(0);
              }}
            >
              <RefreshCw className="w-4 h-4 mr-1" />
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
      </div>
    );
  };

  // ========== 移动端滑动布局 ==========
  if (isSmallScreen) {
    const translateX = getBaseTranslate() + dragOffset;

    return (
      <div
        ref={containerRef}
        className={cn('relative h-full overflow-hidden bg-background select-none', className)}
        style={{ touchAction: 'pan-y pinch-zoom' }}
      >
        <style>{`
          @keyframes fadeSlideUp {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {/* 滑动内容容器 */}
        <div
          className="flex h-full"
          style={{
            width: `calc(100% + ${settingsPanelWidth}px)`,
            transform: `translateX(${translateX}px)`,
            transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
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
                      <MarkdownRenderer
                        content={currentQuestion.content || currentQuestion.ocrText || t('editor.noContent')}
                      />
                    </div>

                    {/* 题目图片 */}
                    {currentQuestion.images && currentQuestion.images.length > 0 && (
                      <div className={cn(
                        'grid gap-2',
                        currentQuestion.images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
                      )}>
                        {currentQuestion.images.map((img) => (
                          <div key={img.id} className="rounded-lg overflow-hidden border border-border/40 bg-muted/20">
                            {questionImageUrls[img.id] ? (
                              <img
                                src={questionImageUrls[img.id]}
                                alt={img.name}
                                className="w-full object-contain max-h-48"
                                loading="lazy"
                              />
                            ) : (
                              <div className="w-full h-24 flex items-center justify-center text-muted-foreground">
                                <Loader2 className="w-4 h-4 animate-spin" />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 答题区域 */}
                    {editMode ? (
                      <div className="space-y-3">
                        {isChoiceQuestion && currentQuestion.options && (
                          <div className="space-y-2">
                            {currentQuestion.options.map(opt => (
                              <div
                                key={opt.key}
                                className={cn(
                                  'flex items-start gap-2 p-2.5 rounded-lg border',
                                  currentQuestion.answer?.includes(opt.key)
                                    ? 'border-emerald-500/50 bg-emerald-500/5'
                                    : 'border-border/50'
                                )}
                              >
                                <span className={cn(
                                  'flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium',
                                  currentQuestion.answer?.includes(opt.key)
                                    ? 'bg-emerald-500 text-white'
                                    : 'bg-muted'
                                )}>
                                  {opt.key}
                                </span>
                                <span className="text-sm flex-1">{opt.content}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {currentQuestion.answer && (
                          <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/30">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Check className="w-3.5 h-3.5 text-emerald-500" />
                              <span className="text-xs font-medium text-emerald-600">{t('editor.referenceAnswer')}</span>
                            </div>
                            <p className="text-sm">{currentQuestion.answer}</p>
                          </div>
                        )}
                        {currentQuestion.explanation && (
                          <div className="p-3 rounded-lg bg-sky-500/5 border border-sky-500/30">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Lightbulb className="w-3.5 h-3.5 text-sky-500" />
                              <span className="text-xs font-medium text-sky-600">{t('editor.explanation')}</span>
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
                          <button
                            onClick={() => setAnswerRevealed(true)}
                            className="w-full p-8 rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/30 flex flex-col items-center justify-center gap-2 hover:bg-muted/50 transition-colors"
                          >
                            <Eye className="w-8 h-8 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">{t('editor.clickToReveal')}</span>
                          </button>
                        )}

                        {/* 正常答题区域 */}
                        {(!hideAnswerMode || answerRevealed || submitResult) && (
                          <>
                            {isChoiceQuestion && currentQuestion.options ? (
                              <div className="space-y-3">
                                {currentQuestion.options.map(opt => (
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
                                    onClick={() => handleOptionClick(opt.key)}
                                    type={isMultiSelect ? 'multiple' : 'single'}
                                  />
                                ))}
                              </div>
                            ) : currentQuestion.questionType === 'fill_blank' && fillBlankCount > 1 ? (
                              <div className="space-y-2">
                                {fillBlankAnswers.map((ans, idx) => (
                                  <div key={idx} className="flex items-center gap-2">
                                    <span className="text-sm text-muted-foreground w-8">({idx + 1})</span>
                                    <Input
                                      value={ans}
                                      onChange={(e) => {
                                        const newAnswers = [...fillBlankAnswers];
                                        newAnswers[idx] = e.target.value;
                                        setFillBlankAnswers(newAnswers);
                                      }}
                                      placeholder={t('editor.fillBlankPlaceholder', { n: idx + 1 })}
                                      disabled={!!submitResult}
                                      className="flex-1"
                                    />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <Textarea
                                value={selectedAnswer}
                                onChange={(e) => setSelectedAnswer(e.target.value)}
                                placeholder={t('editor.answerPlaceholder')}
                                disabled={!!submitResult}
                                rows={3}
                                className="resize-none"
                              />
                            )}
                          </>
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
                              <><Loader2 className="w-4 h-4 animate-spin" />{t('editor.submitting')}</>
                            ) : (
                              <><Send className="w-4 h-4" />{t('editor.submitAnswer')}</>
                            )}
                          </NotionButton>
                        )}

                        {submitResult && !editMode && (
                          <div className={cn(
                            'p-3 rounded-md mt-1 space-y-3',
                            submitResult.needsManualGrading
                              ? 'bg-warning/[0.08] dark:bg-warning/[0.15]'
                              : submitResult.isCorrect 
                                ? 'bg-emerald-600/[0.08] dark:bg-emerald-600/[0.15]' 
                                : 'bg-destructive/[0.08] dark:bg-destructive/[0.15]'
                          )}>
                            {submitResult.needsManualGrading ? (
                              <div className="space-y-2">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-5 h-5 rounded-full bg-warning flex items-center justify-center">
                                    <Lightbulb className="w-3 h-3 text-white" />
                                  </div>
                                  <div>
                                    <span className="text-sm font-medium text-amber-600 dark:text-amber-400">{t('editor.subjectiveSubmitted')}</span>
                                    <span className="text-xs text-muted-foreground ml-2">{t('editor.judgeSelf')}</span>
                                  </div>
                                </div>
                                {submitResult.correctAnswer && (
                                  <p className="text-sm text-muted-foreground pl-7.5">
                                    {t('editor.referenceAnswerLabel')}<span className="font-medium text-foreground">{submitResult.correctAnswer}</span>
                                  </p>
                                )}
                                {onMarkCorrect && (
                                  <div className="flex gap-2 pt-1">
                                    <button
                                      onClick={() => handleManualGrade(true)}
                                      className="flex-1 h-8 flex items-center justify-center gap-1.5 text-sm font-medium rounded text-emerald-600 dark:text-emerald-400 bg-emerald-600/10 hover:bg-emerald-600/[0.15] transition-colors"
                                    >
                                      <Check className="w-3.5 h-3.5" />
                                      {t('editor.iGotItRight')}
                                    </button>
                                    <button
                                      onClick={() => handleManualGrade(false)}
                                      className="flex-1 h-8 flex items-center justify-center gap-1.5 text-sm font-medium rounded text-destructive bg-destructive/10 hover:bg-destructive/[0.15] transition-colors"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                      {t('editor.iGotItWrong')}
                                    </button>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2.5">
                                    <div className={cn(
                                      'w-5 h-5 rounded-full flex items-center justify-center',
                                      submitResult.isCorrect ? 'bg-emerald-600 dark:bg-emerald-500' : 'bg-destructive'
                                    )}>
                                      {submitResult.isCorrect 
                                        ? <Check className="w-3 h-3 text-white" /> 
                                        : <X className="w-3 h-3 text-white" />
                                      }
                                    </div>
                                    <span className={cn(
                                      'text-sm font-medium',
                                      submitResult.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
                                    )}>
                                      {submitResult.isCorrect ? t('editor.answerCorrect') : t('editor.answerWrong')}
                                    </span>
                                  </div>
                                  {/* 重做按钮 */}
                                  {!submitResult.isCorrect && (
                                    <button
                                      onClick={handleRetry}
                                      className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-foreground/5 text-muted-foreground"
                                    >
                                      <RefreshCw className="w-3 h-3" />
                                      {t('editor.retry')}
                                    </button>
                                  )}
                                </div>
                                {submitResult.correctAnswer && !submitResult.isCorrect && (
                                  <p className="text-sm text-muted-foreground pl-7.5">
                                    {t('editor.correctAnswerLabel')}<span className="font-medium text-foreground">{submitResult.correctAnswer}</span>
                                  </p>
                                )}
                                {/* 解析折叠 */}
                                {submitResult.explanation && (
                                  <div className="pt-2 border-t border-foreground/[0.06]">
                                    <button
                                      onClick={() => setExplanationExpanded(!explanationExpanded)}
                                      className="flex items-center gap-1.5 text-sm text-warning hover:underline"
                                    >
                                      <Lightbulb className="w-4 h-4" />
                                      {t('editor.viewExplanation')}
                                      {explanationExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                    </button>
                                    {explanationExpanded && (
                                      <div className="text-sm text-muted-foreground mt-2 leading-relaxed">
                                        <MarkdownRenderer
                                          content={submitResult.explanation}
                                        />
                                      </div>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
            </CustomScrollArea>

            {/* 底部导航 - 增加底部间距避免被 tab 栏遮挡 */}
            <div className="flex-shrink-0 px-3 pt-2 pb-16 border-t border-border/50 bg-card/50">
              <div className="flex items-center justify-between gap-2">
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={() => handleNavigate('prev')}
                  disabled={currentIndex === 0}
                  className="flex-1 h-9"
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  {t('editor.prevQuestion')}
                </NotionButton>
                <NotionButton
                  variant={submitResult ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleNavigate('next')}
                  disabled={currentIndex === totalQuestions - 1}
                  className="flex-1 h-9"
                >
                  {t('editor.nextQuestion')}
                  <ChevronRight className="w-4 h-4 ml-1" />
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
        {/* 连对激励动效 */}
        {renderStreakAnimation()}
        {/* 完成庆祝 */}
        {renderCompletionCelebration()}
      </div>
    );
  }

  // ========== 桌面端布局（去 head 化） ==========
  return (
    <div className={cn('relative flex flex-col h-full bg-gradient-to-b from-background to-muted/20', className)}>
      <style>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <CustomScrollArea className="flex-1" viewportClassName="max-w-3xl mx-auto px-3 py-3 sm:p-4 space-y-3 sm:space-y-4">
          {/* 统计卡片 - 专注模式下隐藏 */}
          {stats && !focusMode && (
            <>
              {/* 移动端：单行摘要 */}
              <div className="flex sm:hidden items-center justify-between px-3 py-2 rounded-lg bg-muted/30 text-xs">
                <span className="text-muted-foreground">
                  {t('editor.totalSummary', { count: stats.total })}
                </span>
                <span className="text-emerald-600">
                  {t('editor.masteredSummary', { count: stats.mastered })}
                </span>
                <span className="text-amber-600">
                  {t('editor.reviewSummary', { count: stats.review })}
                </span>
                <span className="text-sky-600 font-medium">
                  {Math.round(stats.correctRate * 100)}%
                </span>
              </div>
              {/* 桌面端：完整卡片 */}
              <div className="hidden sm:grid grid-cols-4 gap-2">
                <StatCard 
                  icon={BookOpen} 
                  label={t('editor.totalQuestions')} 
                  value={stats.total} 
                  color="bg-slate-500/10 text-slate-600"
                  delay={0}
                />
                <StatCard 
                  icon={Target} 
                  label={t('editor.mastered')} 
                  value={stats.mastered} 
                  color="bg-emerald-500/10 text-emerald-600"
                  delay={50}
                />
                <StatCard 
                  icon={RotateCcw} 
                  label={t('editor.needsReview')} 
                  value={stats.review} 
                  color="bg-amber-500/10 text-amber-600"
                  delay={100}
                />
                <StatCard 
                  icon={TrendingUp} 
                  label={t('editor.correctRate')} 
                  value={`${Math.round(stats.correctRate * 100)}%`} 
                  color="bg-sky-500/10 text-sky-600"
                  delay={150}
                />
              </div>
            </>
          )}

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
              </div>

              {/* 标签 - 专注模式下隐藏 */}
              {!focusMode && currentQuestion.tags && currentQuestion.tags.length > 0 && (
                <div className="hidden sm:flex flex-wrap gap-1.5">
                  {currentQuestion.tags.map(tag => (
                    <span 
                      key={tag} 
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-muted/80 text-muted-foreground"
                    >
                      <Tag className="w-3 h-3" />
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </CardHeader>

            <CardContent className="space-y-6">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <MarkdownRenderer
                  content={currentQuestion.content || currentQuestion.ocrText || t('editor.noContent')}
                />
              </div>

              {/* 题目图片 */}
              {currentQuestion.images && currentQuestion.images.length > 0 && (
                <div className={cn(
                  'grid gap-2',
                  currentQuestion.images.length === 1 ? 'grid-cols-1 max-w-md' : 'grid-cols-2'
                )}>
                  {currentQuestion.images.map((img) => (
                    <div key={img.id} className="rounded-lg overflow-hidden border border-border/40 bg-muted/20">
                      {questionImageUrls[img.id] ? (
                        <img
                          src={questionImageUrls[img.id]}
                          alt={img.name}
                          className="w-full object-contain max-h-64"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-32 flex items-center justify-center text-muted-foreground">
                          <Loader2 className="w-5 h-5 animate-spin" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

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
                            'flex items-start gap-3 p-3 rounded-xl border transition-colors',
                            currentQuestion.answer?.includes(opt.key)
                              ? 'border-emerald-500/50 bg-emerald-500/5'
                              : 'border-border/50 bg-card/30'
                          )}
                        >
                          <span className={cn(
                            'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-sm font-medium',
                            currentQuestion.answer?.includes(opt.key)
                              ? 'bg-emerald-500 text-white'
                              : 'bg-muted text-muted-foreground'
                          )}>
                            {opt.key}
                          </span>
                          <span className="text-sm flex-1">{opt.content}</span>
                          {currentQuestion.answer?.includes(opt.key) && (
                            <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 答案显示 */}
                  {currentQuestion.answer && (
                    <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/30">
                      <div className="flex items-center gap-2 mb-2">
                        <Check className="w-4 h-4 text-emerald-500" />
                        <span className="text-sm font-medium text-emerald-600">{t('editor.referenceAnswer')}</span>
                      </div>
                      <p className="text-sm">{currentQuestion.answer}</p>
                    </div>
                  )}

                  {/* 解析显示 */}
                  {currentQuestion.explanation && (
                    <div className="p-4 rounded-xl bg-sky-500/5 border border-sky-500/30">
                      <div className="flex items-center gap-2 mb-2">
                        <Lightbulb className="w-4 h-4 text-sky-500" />
                        <span className="text-sm font-medium text-sky-600">{t('editor.explanation')}</span>
                      </div>
                      <div className="text-sm">
                        <MarkdownRenderer
                          content={currentQuestion.explanation}
                        />
                      </div>
                    </div>
                  )}

                  {/* 无答案提示 */}
                  {!currentQuestion.answer && !currentQuestion.explanation && (
                    <div className="p-4 rounded-xl bg-muted/50 text-center">
                      <p className="text-sm text-muted-foreground">{t('editor.noAnswerOrExplanation')}</p>
                    </div>
                  )}
                </div>
              ) : (
                /* 做题模式：答题 UI */
                <>
                  {/* 暗记模式遮罩 */}
                  {hideAnswerMode && !answerRevealed && !submitResult && (
                    <button
                      onClick={() => setAnswerRevealed(true)}
                      className="w-full p-12 rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/30 flex flex-col items-center justify-center gap-3 hover:bg-muted/50 transition-colors"
                    >
                      <Eye className="w-10 h-10 text-muted-foreground" />
                      <span className="text-muted-foreground">{t('editor.clickToRevealWithKey')}</span>
                    </button>
                  )}

                  {/* 正常答题区域 */}
                  {(!hideAnswerMode || answerRevealed || submitResult) && (
                    <div className="space-y-4">
                      {isChoiceQuestion && currentQuestion.options ? (
                        <div className="space-y-3">
                          {currentQuestion.options.map(opt => (
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
                              onClick={() => handleOptionClick(opt.key)}
                              type={isMultiSelect ? 'multiple' : 'single'}
                            />
                          ))}
                        </div>
                      ) : currentQuestion.questionType === 'fill_blank' && fillBlankCount > 1 ? (
                        <div className="space-y-3">
                          {fillBlankAnswers.map((ans, idx) => (
                            <div key={idx} className="flex items-center gap-3">
                              <span className="text-sm text-muted-foreground w-10 text-right">({idx + 1})</span>
                              <Input
                                value={ans}
                                onChange={(e) => {
                                  const newAnswers = [...fillBlankAnswers];
                                  newAnswers[idx] = e.target.value;
                                  setFillBlankAnswers(newAnswers);
                                }}
                                placeholder={t('editor.fillBlankPlaceholder', { n: idx + 1 })}
                                disabled={!!submitResult}
                                className="flex-1 h-10"
                              />
                            </div>
                          ))}
                        </div>
                      ) : currentQuestion.questionType === 'fill_blank' || currentQuestion.questionType === 'short_answer' ? (
                        <Input
                          value={selectedAnswer}
                          onChange={(e) => setSelectedAnswer(e.target.value)}
                          placeholder={t('editor.answerPlaceholder')}
                          disabled={!!submitResult}
                          className="h-11"
                        />
                      ) : (
                        <Textarea
                          value={selectedAnswer}
                          onChange={(e) => setSelectedAnswer(e.target.value)}
                          placeholder={t('editor.answerPlaceholder')}
                          disabled={!!submitResult}
                          rows={4}
                          className="resize-none"
                        />
                      )}
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
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t('editor.submitting')}
                        </>
                      ) : (
                        <>
                          <Send className="w-4 h-4" />
                          {t('editor.submitAnswer')}
                        </>
                      )}
                    </NotionButton>
                  )}
                </>
              )}

              {submitResult && !editMode && (
                <div 
                  className={cn(
                    'p-3 rounded-md space-y-3',
                    submitResult.needsManualGrading 
                      ? 'bg-warning/[0.08] dark:bg-warning/[0.15]'
                      : submitResult.isCorrect 
                        ? 'bg-emerald-600/[0.08] dark:bg-emerald-600/[0.15]' 
                        : 'bg-destructive/[0.08] dark:bg-destructive/[0.15]'
                  )}
                >
                  {submitResult.needsManualGrading ? (
                    <>
                      {/* AI 评判中 */}
                      {aiGrading.state.isGrading ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2.5">
                            <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center animate-pulse">
                              <Sparkles className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
                              {t('editor.aiGrading')}
                            </span>
                            <button
                              onClick={() => aiGrading.cancelGrading()}
                              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                            >
                              {t('common:cancel', '取消')}
                            </button>
                          </div>
                          {aiGrading.state.feedback && (
                            <div className="pl-7.5 text-sm text-muted-foreground leading-relaxed max-h-48 overflow-y-auto">
                              <StreamingMarkdownRenderer
                                content={aiGrading.state.feedback}
                                isStreaming={true}
                              />
                            </div>
                          )}
                        </div>
                      ) : aiGrading.state.error ? (
                        /* AI 评判失败，回退手动批改 */
                        <div className="space-y-2">
                          <div className="flex items-center gap-2.5">
                            <div className="w-5 h-5 rounded-full bg-warning flex items-center justify-center">
                              <AlertCircle className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-sm text-amber-600 dark:text-amber-400">
                              {t('editor.aiGradingFailed')}
                            </span>
                          </div>
                          {submitResult.correctAnswer && (
                            <p className="text-sm text-muted-foreground pl-7.5">
                              {t('editor.referenceAnswerLabel')}<span className="font-medium text-foreground">{submitResult.correctAnswer}</span>
                            </p>
                          )}
                          {onMarkCorrect && (
                            <div className="flex gap-2 pt-1">
                              <button
                                onClick={() => handleManualGrade(true)}
                                className="flex-1 h-8 flex items-center justify-center gap-1.5 text-sm font-medium rounded text-emerald-600 dark:text-emerald-400 bg-emerald-600/10 hover:bg-emerald-600/[0.15] transition-colors"
                              >
                                <Check className="w-3.5 h-3.5" />
                                {t('editor.iGotItRight')}
                              </button>
                              <button
                                onClick={() => handleManualGrade(false)}
                                className="flex-1 h-8 flex items-center justify-center gap-1.5 text-sm font-medium rounded text-destructive bg-destructive/10 hover:bg-destructive/[0.15] transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                                {t('editor.iGotItWrong')}
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        /* 等待 AI 评判（尚未开始）- 显示等待状态 + 手动兜底 */
                        <div className="space-y-2">
                          <div className="flex items-center gap-2.5">
                            <div className="w-5 h-5 rounded-full bg-warning flex items-center justify-center">
                              <Lightbulb className="w-3 h-3 text-white" />
                            </div>
                            <div>
                              <span className="text-sm font-medium text-amber-600 dark:text-amber-400">{t('editor.subjectiveSubmitted')}</span>
                              <span className="text-xs text-muted-foreground ml-2">{t('editor.judgeSelf')}</span>
                            </div>
                          </div>
                          {submitResult.correctAnswer && (
                            <p className="text-sm text-muted-foreground pl-7.5">
                              {t('editor.referenceAnswerLabel')}<span className="font-medium text-foreground">{submitResult.correctAnswer}</span>
                            </p>
                          )}
                          {onMarkCorrect && (
                            <div className="flex gap-2 pt-1">
                              <button
                                onClick={() => handleManualGrade(true)}
                                className="flex-1 h-8 flex items-center justify-center gap-1.5 text-sm font-medium rounded text-emerald-600 dark:text-emerald-400 bg-emerald-600/10 hover:bg-emerald-600/[0.15] transition-colors"
                              >
                                <Check className="w-3.5 h-3.5" />
                                {t('editor.iGotItRight')}
                              </button>
                              <button
                                onClick={() => handleManualGrade(false)}
                                className="flex-1 h-8 flex items-center justify-center gap-1.5 text-sm font-medium rounded text-destructive bg-destructive/10 hover:bg-destructive/[0.15] transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                                {t('editor.iGotItWrong')}
                              </button>
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
                                aiGrading.state.verdict === 'correct' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                                aiGrading.state.verdict === 'partial' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                                'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
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
                            submitResult.isCorrect ? 'bg-emerald-600 dark:bg-emerald-500' : 'bg-destructive'
                          )}>
                            {submitResult.isCorrect ? (
                              <Check className="w-3 h-3 text-white" />
                            ) : (
                              <X className="w-3 h-3 text-white" />
                            )}
                          </div>
                          <span className={cn(
                            'text-sm font-medium',
                            submitResult.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
                          )}>
                            {submitResult.isCorrect ? t('editor.answerCorrect') : t('editor.answerWrong')}
                          </span>
                          {submitResult.correctAnswer && !submitResult.isCorrect && (
                            <span className="text-sm text-muted-foreground">
                              · {t('editor.correctAnswerLabel')}<span className="font-medium text-foreground">{submitResult.correctAnswer}</span>
                            </span>
                          )}
                        </div>
                        {/* 重做按钮 */}
                        {!submitResult.isCorrect && (
                          <button
                            onClick={handleRetry}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded hover:bg-foreground/5 text-muted-foreground"
                            title={t('editor.retryTitle')}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            {t('editor.retry')}
                          </button>
                        )}
                      </div>

                      {/* 解析折叠 */}
                      {submitResult.explanation && (
                        <div className="pt-2 border-t border-foreground/[0.06]">
                          <button
                            onClick={() => setExplanationExpanded(!explanationExpanded)}
                            className="flex items-center gap-1.5 text-sm text-warning hover:underline"
                          >
                            <Lightbulb className="w-4 h-4" />
                            {explanationExpanded ? t('editor.collapseExplanation') : t('editor.viewExplanation')}
                            {explanationExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </button>
                          {explanationExpanded && (
                            <div className="mt-2 text-sm text-muted-foreground leading-relaxed">
                              <MarkdownRenderer
                                content={submitResult.explanation}
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
                              <DsAnalysisIconMuted className="w-4 h-4 text-blue-500 animate-pulse" />
                              <span className="text-sm text-blue-600 dark:text-blue-400">{t('editor.aiAnalyzing')}</span>
                              <button
                                onClick={() => aiGrading.cancelGrading()}
                                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                              >
                                {t('common:cancel', '取消')}
                              </button>
                            </div>
                            {aiGrading.state.feedback && (
                              <div className="text-sm text-muted-foreground leading-relaxed">
                                <StreamingMarkdownRenderer
                                  content={aiGrading.state.feedback}
                                  isStreaming={true}
                                />
                              </div>
                            )}
                          </div>
                        ) : aiGrading.state.feedback && !aiGrading.state.error ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400">
                              <DsAnalysisIconMuted className="w-4 h-4" />
                              {t('editor.aiAnalysis')}
                            </div>
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
                            <div className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400">
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
                          <button
                            onClick={() => {
                              if (!currentQuestion || !submitResult.submissionId) return;
                              const qId = currentQuestion.id;
                              aiGrading.resetState();
                              aiGrading.startGrading(
                                qId,
                                submitResult.submissionId,
                                'analyze',
                                undefined,
                                // 完成后缓存到本地 ref（从回调参数获取最新 feedback，避免闭包过时值）
                                (_verdict, _score, feedback) => {
                                  if (feedback) aiFeedbackCacheRef.current.set(qId, feedback);
                                },
                              ).catch((err) => { debugLog.error('[QBankEditor] AI analyze failed:', err); });
                            }}
                            className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            <DsAnalysisIconMuted className="w-4 h-4" />
                            {t('editor.aiAnalysis')}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* 用户笔记 */}
              {!editMode && (
                <div className="pt-4 border-t border-border/30">
                  {isEditingNote ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium flex items-center gap-1.5">
                          <StickyNote className="w-4 h-4 text-amber-500" />
                          {t('editor.myNotes')}
                        </span>
                        <div className="flex gap-1">
                          <NotionButton
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setIsEditingNote(false);
                              setNoteText(currentQuestion?.userNote || '');
                            }}
                          >
                            {t('editor.cancel')}
                          </NotionButton>
                          <NotionButton
                            variant="primary"
                            size="sm"
                            onClick={handleSaveNote}
                          >
                            {t('editor.save')}
                          </NotionButton>
                        </div>
                      </div>
                      <Textarea
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder={t('editor.notePlaceholder')}
                        rows={3}
                        className="resize-none text-sm"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setIsEditingNote(true)}
                      className="w-full text-left p-3 rounded-lg border border-dashed border-border/50 hover:border-border hover:bg-muted/30 transition-colors group"
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <StickyNote className="w-4 h-4 text-amber-500" />
                        <span className="font-medium">{t('editor.myNotes')}</span>
                        {!currentQuestion?.userNote && (
                          <span className="text-muted-foreground text-xs group-hover:hidden">{t('editor.clickToAdd')}</span>
                        )}
                      </div>
                      {currentQuestion?.userNote && (
                        <p className="mt-1.5 text-sm text-muted-foreground line-clamp-2">
                          {currentQuestion.userNote}
                        </p>
                      )}
                    </button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
      </CustomScrollArea>

      <div className="flex-shrink-0 border-t border-border/40 bg-background safe-area-bottom">
        <div className="px-4 py-3">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => handleNavigate('prev')}
              disabled={currentIndex === 0}
              className="h-8 px-3"
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              {t('editor.prevQuestion')}
            </NotionButton>

            <Popover>
              <PopoverTrigger asChild>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-muted/50 transition-colors text-sm">
                  <span className="font-medium">{currentIndex + 1}</span>
                  <span className="text-muted-foreground">/ {totalQuestions}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-3" align="center" side="top" sideOffset={8}>
                {/* 搜索框 */}
                <div className="relative mb-3">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
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
                      <button
                        key={q.id}
                        onClick={() => {
                          onNavigate?.(idx);
                          setSearchQuery('');
                        }}
                        className={cn(
                          'w-7 h-7 rounded text-xs font-medium transition-colors',
                          idx === currentIndex && 'bg-primary text-primary-foreground',
                          idx !== currentIndex && status === 'mastered' && 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20',
                          idx !== currentIndex && status === 'review' && 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20',
                          idx !== currentIndex && status === 'new' && 'bg-muted/50 text-muted-foreground hover:bg-muted',
                          idx !== currentIndex && status === 'in_progress' && 'bg-blue-500/10 text-blue-600 hover:bg-blue-500/20'
                        )}
                      >
                        {idx + 1}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-3 mt-3 pt-2 border-t border-border/40 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/20" /> {t('editor.legendMastered')}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/20" /> {t('editor.legendReview')}</span>
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
              <ChevronRight className="w-4 h-4 ml-1" />
            </NotionButton>
          </div>
        </div>
      </div>
      {/* 连对激励动效 */}
      {renderStreakAnimation()}
      {/* 完成庆祝 */}
      {renderCompletionCelebration()}
    </div>
  );
};

export default QuestionBankEditor;
