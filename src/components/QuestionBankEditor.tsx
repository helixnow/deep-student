import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useQbankAiGrading } from '@/hooks/useQbankAiGrading';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { usePracticeShortcuts, type PracticeShortcutOptions } from './practice/usePracticeShortcuts';
import { ImageCropDialog } from '@/components/ImageCropDialog';
import { loadQuestionImageUrls, QUESTION_IMAGE_LOAD_ERROR } from '@/components/questionImageLoader';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { QuestionExplanation } from './practice/QuestionExplanation';
import {
  CaretLeft,
  CaretRight,
  CircleNotch,
  BookOpen,
  WarningCircle,
  PaperPlaneRight,
} from '@phosphor-icons/react';

import type {
  QuestionType,
  PracticeMode,
  QuestionImage,
  Question,
  QuestionBankStats,
  SubmitResult,
  ImageAnswerPayload,
} from '@/api/questionBankApi';
import {
  getNextQuestionIndex,
  parseNumericInput,
  encodeImageAnswerUserAnswer,
  isSubjectiveQuestionType,
  parseImageAnswerEnvelope,
  IMAGE_ANSWER_MAX_IMAGES,
} from '@/api/questionBankApi';
import {
  getPracticeSessionKey,
  useQuestionBankStore,
  type PracticeSessionOwner,
  countCorrectQuestions,
} from '@/stores/questionBankStore';
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
  StructuredAnswerSummary,
  uploadImageAnswerImage,
} from '@/components/question-types';

import { QBANK_KEYFRAMES } from './question-bank/questionBankEditorConfig';
import { useQuestionSwipeGesture } from './question-bank/useQuestionSwipeGesture';
import { QuestionSettingsDrawer } from './question-bank/QuestionSettingsDrawer';
import {
  QuestionCompletionCard,
  type QuestionCompletionStats,
} from './question-bank/QuestionCompletionCard';
import { QuestionSubmitResultCard } from './question-bank/QuestionSubmitResultCard';
import {
  QuestionJumperPopover,
  QuestionUserNoteSection,
  type NoteSaveState,
} from './question-bank/QuestionUserNoteAndJumper';
import { QuestionAnswerInputSection } from './question-bank/QuestionAnswerInputSection';
import { QuestionEditorStage } from './question-bank/QuestionEditorStage';

export interface QuestionBankEditorProps {
  sessionId: string;
  /** 当前保活视图的显式会话归属；由 useQuestionBankSession 生成。 */
  practiceSessionOwner: PracticeSessionOwner;
  questions: Question[];
  stats?: QuestionBankStats;
  currentIndex?: number;
  isLoading?: boolean;
  error?: string | null;
  /**
   * 只读浏览（#466）：直接显示选项正确项、参考答案与解析，不作答、不计时、不记录练习进度；
   * 提供 onRefreshQuestion（可写）时附带 AI 解析入口。false = 做题模式。
   */
  browseMode?: boolean;
  /** 浏览模式：从当前题进入做题 */
  onPracticeQuestion?: (questionId: string) => void;
  /** 练习模式（从 store 传入，SSOT） */
  practiceMode?: PracticeMode;
  /** 当前标签（用于按标签练习的同步） */
  selectedTag?: string;
  onSubmitAnswer?: (questionId: string, answer: string, questionType?: QuestionType) => Promise<SubmitResult>;
  onNavigate?: (index: number) => void;
  onModeChange?: (mode: PracticeMode, tag?: string) => void;
  onMarkCorrect?: (questionId: string, isCorrect: boolean) => Promise<void>;
  onRefreshQuestion?: (questionId: string) => Promise<void>;
  /** 主观题/填空题 AI 评判完成（verdict 已落库）：宿主据此回写练习进度与模拟考成绩 */
  onGradingResolved?: (questionId: string, isCorrect: boolean) => void;
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

export const QuestionBankEditor: React.FC<QuestionBankEditorProps> = ({
  sessionId,
  practiceSessionOwner,
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
  onGradingResolved,
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
  browseMode = false,
  onPracticeQuestion,
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
  const [noteSaveState, setNoteSaveState] = useState<NoteSaveState>('idle');
  const noteSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次已成功保存的笔记内容（避免 blur 与点击保存的双重提交，并驱动草稿脏状态）
  const [lastSavedNote, setLastSavedNote] = useState('');

  // 题目搜索
  const [searchQuery, setSearchQuery] = useState('');

  // 连对计数 & 激励（里程碑提示走 showGlobalNotification 统一通知，不再用本地 z-50 toast）
  // 会话进度提到 questionBankStore：切到错题本 / 统计再回来不清零（仅内存，重启不恢复）
  const practiceSessionKey = getPracticeSessionKey(practiceSessionOwner);
  const practiceSession = useQuestionBankStore((state) => (
    practiceSessionKey ? state.practiceSessions[practiceSessionKey] : undefined
  ));
  const streakCount = practiceSession?.streakCount ?? 0;
  const recordPracticeSessionAnswer = useQuestionBankStore(
    (state) => state.recordPracticeSessionAnswer,
  );

  // 完成庆祝
  const [showCompletionCelebration, setShowCompletionCelebration] = useState(false);
  const [completionStats, setCompletionStats] = useState<QuestionCompletionStats | null>(null);
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
  const prevQuestionIdRef = useRef<string | undefined>(undefined);

  // 填空题多空位
  const [fillBlankAnswers, setFillBlankAnswers] = useState<string[]>([]);
  // 匹配题配对 / 排序题当前排列（结构化题型作答状态）
  const [matchingPairs, setMatchingPairs] = useState<MatchingPair[]>([]);
  const [orderingOrder, setOrderingOrder] = useState<string[]>([]);
  const [pendingNavigationIndex, setPendingNavigationIndex] = useState<number | null>(null);

  // 图片作答（主观题/填空题）：压缩上传后的信封引用 + 上传中状态
  const [answerImages, setAnswerImages] = useState<QuestionImage[]>([]);
  const [isUploadingAnswerImage, setIsUploadingAnswerImage] = useState(false);
  const answerImageInputRef = useRef<HTMLInputElement | null>(null);
  const answerImageUploadRef = useRef<symbol | null>(null);
  // 已提交的信封回显（结果卡只读缩略图；切题/重做时清空）
  const [submittedImageAnswer, setSubmittedImageAnswer] = useState<ImageAnswerPayload | null>(null);

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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSmallScreen || !showSettingsPanel) return;
    return registerBackHandler(() => {
      // 可见性守卫（同 EnhancedPdfViewer）：保活但不可见的实例（display:none
      // 标签页）不得吞掉活跃视图的返回键、不得触发关闭回调。
      // visibility:hidden 不清布局盒（getClientRects 仍有返回值），需单独查 computed 值。
      const el = containerRef.current;
      if (!el || !el.isConnected) return false;
      if (el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      setShowSettingsPanel(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, showSettingsPanel, setShowSettingsPanel]);

  // ========== 移动端滑动面板状态 ==========
  const {
    containerWidth,
    settingsPanelWidth,
    isDragging,
    dragOffset,
    getBaseTranslate,
  } = useQuestionSwipeGesture({
    containerRef,
    isSmallScreen,
    showSettingsPanel,
    onShowSettingsPanelChange: setShowSettingsPanel,
  });

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

  // 图片作答开关：仅主观题 + 填空题（后端判分口径一律走 AI 评判的题型）
  const imageAnswerEnabled = useMemo(
    () => isSubjectiveQuestionType(qType),
    [qType]
  );

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
    // 图片作答状态重置；切回有已提交图片信封的题时按信封回显（只读）
    answerImageUploadRef.current = null;
    setIsUploadingAnswerImage(false);
    setAnswerImages([]);
    setSubmittedImageAnswer(
      isSubjectiveQuestionType(qType)
        ? parseImageAnswerEnvelope(currentQuestion?.userAnswer ?? null)
        : null
    );
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
          img => !cachedSnapshot[img.id] || cachedSnapshot[img.id] === QUESTION_IMAGE_LOAD_ERROR
        );
        const cachedUrls: Record<string, string> = {};
        currentQuestion.images!.forEach(img => {
          if (cachedSnapshot[img.id] && cachedSnapshot[img.id] !== QUESTION_IMAGE_LOAD_ERROR) {
            cachedUrls[img.id] = cachedSnapshot[img.id];
          }
        });
        // 失败也写入 'error' 哨兵，占位显示加载失败而不是无限转圈（#465）
        const loadedUrls = await loadQuestionImageUrls(imagesToLoad);
        if (cancelled) return;
        const urls: Record<string, string> = { ...cachedUrls, ...loadedUrls };
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
    return () => {
      cancelled = true;
      answerImageUploadRef.current = null;
    };
  }, [sessionId, practiceSessionKey, currentIndex, currentQuestion?.id, qType, fillBlankCount, orderingItemsSignature, imageRefreshKey, resetAiGrading]);

  // 题目搜索过滤
  const filteredQuestionIndices = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const query = searchQuery.toLowerCase();
    return questions
      .map((q, idx) => ({ q, idx }))
      .filter(({ q }) =>
        q.content?.toLowerCase().includes(query) ||
        q.questionLabel?.toLowerCase().includes(query) ||
        q.tags?.some(tag => tag.toLowerCase().includes(query))
      )
      .map(({ idx }) => idx);
  }, [questions, searchQuery]);

  const handleOptionClick = useCallback((key: string) => {
    if (submitResult || submitInFlightRef.current || answerImageUploadRef.current) return;

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
    if (submitResult || isUploadingAnswerImage) return false;
    // 图片作答：有图即可提交（文本/逐空输入可留空）
    if (answerImages.length > 0) return true;
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
  }, [qType, selectedAnswer, selectedOptions, submitResult, fillBlankAnswers, matchingData, matchingPairs, orderingData, orderingOrder, answerImages, isUploadingAnswerImage]);

  // 图片作答上传：压缩 → vfs_upload_attachment → 信封引用（题目图片同款路径）
  const handleAnswerImageSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || answerImageUploadRef.current || submitInFlightRef.current || submitResult) return;
    const remaining = IMAGE_ANSWER_MAX_IMAGES - answerImages.length;
    if (remaining <= 0) {
      showGlobalNotification('warning', t('editor.imageAnswerLimit', { count: IMAGE_ANSWER_MAX_IMAGES, defaultValue: `最多上传 ${IMAGE_ANSWER_MAX_IMAGES} 张图片` }));
      return;
    }
    const list = Array.from(files).slice(0, remaining);
    const upload = Symbol('answer-image-upload');
    answerImageUploadRef.current = upload;
    setIsUploadingAnswerImage(true);
    try {
      const uploaded = await Promise.all(list.map(uploadImageAnswerImage));
      if (answerImageUploadRef.current !== upload) return;
      setAnswerImages(prev => [...prev, ...uploaded]);
    } catch (err) {
      if (answerImageUploadRef.current !== upload) return;
      debugLog.error('[QuestionBankEditor] answer image upload failed:', err);
      showGlobalNotification('error', err instanceof Error ? err.message : String(err));
    } finally {
      if (answerImageUploadRef.current === upload) {
        answerImageUploadRef.current = null;
        setIsUploadingAnswerImage(false);
        if (answerImageInputRef.current) answerImageInputRef.current.value = '';
      }
    }
  }, [answerImages.length, submitResult, t]);

  const removeAnswerImage = useCallback((id: string) => {
    setAnswerImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!currentQuestion || !onSubmitAnswer || !canSubmit) return;
    // 防重入：isSubmitting state 在同一帧内读到旧值，双击/连点/Enter 连按会触发两次提交
    if (isSubmitting || submitInFlightRef.current || answerImageUploadRef.current) return;

    submitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const isMulti = qType === 'multiple_choice' || qType === 'indefinite_choice';

      // user_answer 序列化（与后端判分契约一致）
      let answer: string;
      if (qType === 'fill_blank') {
        // 逐空文字与图片属于同一份作答，保留空位编号供 AI 判分与回看。
        answer = answerImages.length > 0
          ? encodeImageAnswerUserAnswer(answerImages, fillBlankAnswers.some(value => value.trim())
            ? fillBlankAnswers.map((value, index) => `${index + 1}. ${value}`).join('\n')
            : '')
          : encodeFillBlankUserAnswer(fillBlankAnswers);
      } else if (isMulti) {
        answer = Array.from(selectedOptions).sort().join('');
      } else if (qType === 'matching' && matchingData) {
        answer = encodeMatchingUserAnswer(matchingPairs);
      } else if (qType === 'ordering' && orderingData) {
        answer = encodeOrderingUserAnswer(orderingOrder);
      } else if (qType === 'numeric') {
        answer = selectedAnswer.trim();
      } else if (answerImages.length > 0) {
        // 主观题：有图走信封（selectedAnswer 作为信封 text 补充）
        answer = encodeImageAnswerUserAnswer(answerImages, selectedAnswer);
      } else {
        answer = selectedAnswer;
      }

      if (!answer.trim()) return;

      // 图片作答：仅在提交成功后更新只读回显。
      const pendingEnvelope = parseImageAnswerEnvelope(answer);

      const result = await onSubmitAnswer(currentQuestion.id, answer, currentQuestion.questionType);
      setSubmitResult(result);
      setSubmittedImageAnswer(pendingEnvelope);

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
          (verdict, score) => {
            if (verdict) {
              const isCorrect = verdict === 'correct';
              // 保留 AI 分数/判定到 submitResult：needsManualGrading 置 false 后
              // 会切到客观题结果分支，必须把 score 带过去，否则只剩「回答错误」无分数。
              const resolvedScore = score != null
                ? Math.max(0, Math.min(100, Math.round(score)))
                : (verdict === 'correct' ? 100 : verdict === 'incorrect' ? 0 : 60);
              setSubmitResult(prev => prev ? {
                ...prev,
                isCorrect,
                needsManualGrading: false,
                aiScore: resolvedScore,
                aiVerdict: verdict,
              } : null);
              // verdict 已由后端落库（grading_method='ai'）：通知宿主回写
              // 练习进度（首答按 null 记的差量修正）与模拟考成绩，否则
              // 成绩单把 AI 已判对的主观题/填空题按错统计。
              onGradingResolved?.(questionId, isCorrect);
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

      // 图片作答已落信封：清空编辑区引用（回显由 submittedImageAnswer 承担）
      if (pendingEnvelope) {
        setAnswerImages([]);
      }

      // 连对与已作答集合由 store 统一推进（null = 主观题待判定，不中断连对）；
      // 返回值是同帧快照，里程碑与完成判定都读它，避免 setState 异步导致的错位。
      const progress = recordPracticeSessionAnswer(
        practiceSessionOwner,
        currentQuestion.id,
        result.isCorrect ?? null,
      );
      if (!progress) {
        // 后端提交已经成功，但归属或题目白名单不匹配时不得写入其他实例。
        debugLog.warn('[QuestionBankEditor] practice session ownership rejected answer progress');
        return;
      }

      if (result.isCorrect) {
        // 检查里程碑 (3, 5, 10, 15, 20...)：走统一通知（替代原 z-50 本地 toast）
        const milestones = [3, 5, 10, 15, 20, 30, 50];
        if (milestones.includes(progress.streakCount)) {
          showGlobalNotification(
            'success',
            `${t('editor.streakMessage', { count: progress.streakCount })} · ${t('editor.keepItUp')}`,
          );
        }
      }

      // 检查是否完成所有题目：基于真实已作答题目数（快速翻题只"访问"不作答，不计入）
      const totalAnswered = progress.answeredIds.length;
      if (totalAnswered >= totalQuestions && totalQuestions > 0) {
        // 正确率用题目维度（correctQuestionCount），勿用尝试维度 totalCorrectCount（可超 100%）
        const correctCount = progress.correctQuestionCount
          ?? countCorrectQuestions(progress.answeredResults);
        setCompletionStats({
          totalAnswered,
          correctCount,
          totalTime: resolvedElapsedTime,
        });
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        completionTimerRef.current = setTimeout(() => {
          setShowCompletionCelebration(true);
          // 本轮完成：停掉宿主顶栏计时/倒计时，避免庆祝卡下仍继续走秒
          setLocalTimerRunning(false);
          onTimerRunningChange?.(false);
        }, 500);
      }
    } catch (err) {
      debugLog.error('Submit answer failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.submit_failed'));
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [currentQuestion, canSubmit, qType, selectedAnswer, selectedOptions, fillBlankAnswers, matchingData, matchingPairs, orderingData, orderingOrder, answerImages, onSubmitAnswer, onRefreshQuestion, onGradingResolved, recordPracticeSessionAnswer, practiceSessionOwner, totalQuestions, resolvedElapsedTime, resetAiGrading, startAiGrading, onTimerRunningChange, t, isSubmitting]);

  // 重做当前题目
  const handleRetry = useCallback(() => {
    setSelectedAnswer('');
    setSelectedOptions(new Set());
    setSubmitResult(null);
    setFillBlankAnswers(new Array(fillBlankCount).fill(''));
    setMatchingPairs([]);
    setOrderingOrder(orderingData ? orderingData.items.map((item) => item.key) : []);
    setAnswerRevealed(false);
    answerImageUploadRef.current = null;
    setIsUploadingAnswerImage(false);
    setAnswerImages([]);
    setSubmittedImageAnswer(null);
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
  const favoriteInFlightRef = useRef(false);
  const handleToggleFavorite = useCallback(async () => {
    if (!currentQuestion || favoriteInFlightRef.current) return;
    favoriteInFlightRef.current = true;
    try {
      await onToggleFavorite?.(currentQuestion.id, !currentQuestion.isFavorite);
    } catch (err) {
      debugLog.error('Toggle favorite failed:', err);
      showGlobalNotification('error', t('exam_sheet:errors.toggle_favorite_failed'));
    } finally {
      favoriteInFlightRef.current = false;
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

  const handleCropImageAdded = useCallback(() => {
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
  }, [currentQuestion?.id, onRefreshQuestion]);

  // 从 question 数据读取收藏状态（SSOT: store -> question -> UI）
  const isFavorite = currentQuestion?.isFavorite ?? false;

  const hasUnsavedNote = isEditingNote && noteText !== lastSavedNote;
  const hasUnsavedDraft = canSubmit || isUploadingAnswerImage || hasUnsavedNote;

  useEffect(() => {
    onDraftDirtyChange?.(hasUnsavedDraft);
  }, [hasUnsavedDraft, onDraftDirtyChange]);

  useEffect(() => () => onDraftDirtyChange?.(false), [onDraftDirtyChange]);

  const requestNavigate = useCallback((targetIndex: number) => {
    if (!onNavigate || targetIndex === currentIndex || submitInFlightRef.current || answerImageUploadRef.current) return;
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
      : browseMode
        // 浏览按题目顺序逐题看，不受练习模式（随机/错题优先等）影响
        ? Math.min(currentIndex + 1, Math.max(questions.length - 1, 0))
        : getNextQuestionIndex(questions, currentIndex, practiceMode, selectedTag);
    requestNavigate(newIndex);
  }, [browseMode, currentIndex, practiceMode, questions, requestNavigate, selectedTag]);

  const shortcutBusy = isSubmitting || isUploadingAnswerImage || isManualGrading || isDeleting;
  const shortcutActions: PracticeShortcutOptions['actions'] = {
    previous: onNavigate && currentIndex > 0 ? () => handleNavigate('prev') : undefined,
    next: onNavigate && currentIndex < totalQuestions - 1 ? () => handleNavigate('next') : undefined,
    favorite: onToggleFavorite ? () => { void handleToggleFavorite(); } : undefined,
    ...(browseMode ? {
      primary: onNavigate && currentIndex < totalQuestions - 1 ? () => handleNavigate('next') : undefined,
    } : {}),
    ...(!browseMode ? {
      selectOption: !submitResult && ['single_choice', 'multiple_choice', 'indefinite_choice'].includes(qType) ? handleOptionClick : undefined,
      selectTrueFalse: !submitResult && qType === 'true_false' ? setSelectedAnswer : undefined,
      primary: canSubmit && onSubmitAnswer ? () => { void handleSubmit(); }
        : submitResult && onNavigate && currentIndex < totalQuestions - 1 ? () => handleNavigate('next') : undefined,
      retry: submitResult?.isCorrect === false && !aiGrading.state.isGrading ? handleRetry : undefined,
      toggleTimer: showTimer && allowTimerControl ? toggleTimer : undefined,
      toggleHidden: () => {
        if (hideAnswerMode && !answerRevealed) setAnswerRevealed(true);
        else handleHideAnswerModeChange(!hideAnswerMode);
      },
    } : {}),
  };
  const shortcutOptions: PracticeShortcutOptions = {
    enabled: !isSmallScreen && isActive !== false && !isLoading && !error && !!currentQuestion && !shortcutBusy,
    rootRef: containerRef,
    optionKeys: currentQuestion?.options?.map(option => option.key),
    actions: shortcutActions,
    primaryLabel: browseMode || submitResult ? 'editor.nextQuestion' : 'editor.shortcutSubmit',
  };
  const onAnswerPrimaryAction = usePracticeShortcuts(shortcutOptions);

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
            <DsButton variant="ghost" onClick={onBack}>{t('editor.back')}</DsButton>
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
            <DsButton variant="ghost" onClick={onBack}>{t('editor.back')}</DsButton>
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

  const renderExplanation = (defaultExpanded = false) => (
    <QuestionExplanation
      key={currentQuestion.id}
      questionId={currentQuestion.id}
      explanation={submitResult?.explanation || currentQuestion.explanation}
      aiFeedback={currentQuestion.ai_feedback}
      defaultExpanded={defaultExpanded}
      onRefreshQuestion={onRefreshQuestion}
    />
  );

  const browsePracticeButton = browseMode && onPracticeQuestion ? (
    <DsButton
      variant="primary"
      size="sm"
      onClick={() => onPracticeQuestion(currentQuestion.id)}
      className="ml-auto min-h-9 sm:min-h-0 !h-auto rounded-lg border-primary/40 bg-primary/15 !px-3 !py-1.5 sm:!px-2.5 sm:!py-1 text-xs font-medium text-primary hover:bg-primary/25 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]"
    >
      <PaperPlaneRight size={14} />
      {t('editor.practiceThisQuestion')}
    </DsButton>
  ) : null;

  // 题目切换滑动过渡：key 变化触发重新挂载 + 方向化滑入
  const questionTransitionStyle = {
    ['--ui-enter-x' as string]: navDirection >= 0 ? '24px' : '-24px',
  } as React.CSSProperties;

  const settingsPanelNode = (
    <QuestionSettingsDrawer
      onClose={() => setShowSettingsPanel(false)}
      stats={stats}
      practiceMode={practiceMode}
      onModeChange={onModeChange ? handleModeChange : undefined}
      selectedTag={selectedTag}
      onTagChange={handleTagChange}
      tagOptions={tagOptions}
      showTimer={showTimer}
      isTimerRunning={isTimerRunning}
      timerDisplay={timerDisplay}
      remainingTime={remainingTime}
      allowTimerControl={allowTimerControl}
      onToggleTimer={toggleTimer}
      isFavorite={isFavorite}
      onToggleFavorite={() => void handleToggleFavorite()}
      canDelete={!!onDeleteQuestion}
      deleteConfirmOpen={deleteConfirmOpen}
      isDeleting={isDeleting}
      onRequestDelete={handleRequestDelete}
      onCancelDelete={() => {
        setDeleteConfirmOpen(false);
        setDeleteTargetId(null);
      }}
      onConfirmDelete={() => void handleConfirmDelete()}
      focusMode={focusMode}
      onFocusModeChange={handleFocusModeChange}
      hideAnswerMode={hideAnswerMode}
      onHideAnswerModeChange={handleHideAnswerModeChange}
      isSmallScreen={isSmallScreen}
      shortcutOptions={shortcutOptions}
      streakCount={streakCount}
    />
  );

  /** 内联未保存草稿提示条：替代模态确认框，锚定在底部导航上方 */
  const draftNavigationBanner = pendingNavigationIndex !== null ? (
    <div className="ui-rise-in mx-auto max-w-3xl px-1 pb-2">
      <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/[0.08] px-3 py-2">
        <WarningCircle size={16} className="flex-shrink-0 text-warning" />
        <span className="flex-1 min-w-0 truncate text-xs text-warning">
          {t('common:confirmMessages.unsaved_changes')}
        </span>
        <DsButton
          variant="ghost"
          size="sm"
          className="!h-7 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] !px-2 text-xs"
          onClick={() => setPendingNavigationIndex(null)}
        >
          {t('common:cancel')}
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          className="!h-7 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] !px-2 text-xs bg-warning/10 text-warning hover:bg-warning/20"
          onClick={() => {
            const targetIndex = pendingNavigationIndex;
            setPendingNavigationIndex(null);
            if (targetIndex !== null) onNavigate?.(targetIndex);
          }}
        >
          {t('common:actions.discard')}
        </DsButton>
      </div>
    </div>
  ) : null;

  const answerInputNode = (
    <QuestionAnswerInputSection
      currentQuestion={currentQuestion}
      qType={qType}
      isChoiceQuestion={isChoiceQuestion}
      isMultiSelect={isMultiSelect}
      isSmallScreen={isSmallScreen}
      selectedAnswer={selectedAnswer}
      onSelectAnswer={setSelectedAnswer}
      selectedOptions={selectedOptions}
      onOptionClick={handleOptionClick}
      submitResult={submitResult}
      trueFalseCorrectAnswer={trueFalseCorrectAnswer}
      matchingData={matchingData}
      matchingPairs={matchingPairs}
      onMatchingPairsChange={setMatchingPairs}
      orderingData={orderingData}
      orderingOrder={orderingOrder}
      onOrderingOrderChange={setOrderingOrder}
      numericData={numericData}
      fillBlankData={fillBlankData}
      fillBlankAnswers={fillBlankAnswers}
      onFillBlankAnswersChange={setFillBlankAnswers}
      onAnswerPrimaryAction={onAnswerPrimaryAction}
      imageAnswerEnabled={imageAnswerEnabled}
      answerImages={answerImages}
      submittedImageAnswer={submittedImageAnswer}
      isUploadingAnswerImage={isUploadingAnswerImage}
      isSubmitting={isSubmitting}
      answerImageInputRef={answerImageInputRef}
      onAnswerImageSelect={(files) => { void handleAnswerImageSelect(files); }}
      onRemoveAnswerImage={removeAnswerImage}
    />
  );

  const completionCelebrationNode = showCompletionCelebration && completionStats ? (
    <QuestionCompletionCard
      stats={completionStats}
      onRestart={() => {
        setShowCompletionCelebration(false);
        requestNavigate(0);
      }}
      onDismiss={() => setShowCompletionCelebration(false)}
    />
  ) : null;

  const renderSubmitResultCard = (extraClassName?: string) => {
    if (!submitResult || browseMode) return null;
    return (
      <QuestionSubmitResultCard
        submitResult={submitResult}
        submittedImageAnswer={submittedImageAnswer}
        aiGrading={aiGrading}
        onRetryAiGrading={retryAiGrading}
        canManualGrade={!!onMarkCorrect}
        isManualGrading={isManualGrading}
        onManualGrade={(isCorrect) => { void handleManualGrade(isCorrect); }}
        structuredRevealsAnswer={structuredRevealsAnswer}
        onRetry={handleRetry}
        currentQuestion={currentQuestion}
        sessionId={sessionId}
        selectedAnswer={selectedAnswer}
        extraClassName={extraClassName}
      />
    );
  };

  const userNoteSectionNode = (
    <QuestionUserNoteSection
      isEditingNote={isEditingNote}
      noteText={noteText}
      noteSaveState={noteSaveState}
      savedUserNote={currentQuestion?.userNote}
      canUpdateNote={!!onUpdateUserNote}
      onStartEdit={() => setIsEditingNote(true)}
      onChangeNoteText={setNoteText}
      onBlurNote={handleNoteBlur}
      onSaveNote={handleSaveNote}
    />
  );

  const renderQuestionJumper = (triggerClassName?: string) => (
    <QuestionJumperPopover
      questions={questions}
      currentIndex={currentIndex}
      totalQuestions={totalQuestions}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      filteredQuestionIndices={filteredQuestionIndices}
      onJumpToIndex={requestNavigate}
      triggerClassName={triggerClassName}
    />
  );

  // ========== 移动端滑动布局 ==========
  if (isSmallScreen) {
    const translateX = getBaseTranslate() + dragOffset;

    return (
      <div
        ref={containerRef}
        data-practice-shortcuts
        data-agent-qbank-editor
        className={cn('relative h-full overflow-hidden bg-background', className)}
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
            {/* 顶部 2px 细进度条 */}
            <div className="flex-shrink-0 h-0.5 bg-border/40" role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin={1} aria-valuemax={totalQuestions}>
              <div
                className="h-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {/* 题目内容区（无框纸感舞台） */}
            <CustomScrollArea className="flex-1" viewportClassName="px-4 py-4 space-y-4">
              {/* 完成庆祝（内联） */}
              {completionCelebrationNode}
              <QuestionEditorStage
                variant="mobile"
                currentQuestion={currentQuestion}
                currentIndex={currentIndex}
                totalQuestions={totalQuestions}
                qType={qType}
                isChoiceQuestion={isChoiceQuestion}
                isSmallScreen={isSmallScreen}
                focusMode={focusMode}
                browseMode={browseMode}
                isFavorite={isFavorite}
                canToggleFavorite={!!onToggleFavorite}
                showSettingsPanel={showSettingsPanel}
                hideAnswerMode={hideAnswerMode}
                answerRevealed={answerRevealed}
                submitResult={submitResult}
                canSubmit={canSubmit}
                isSubmitting={isSubmitting}
                questionImageUrls={questionImageUrls}
                questionTransitionStyle={questionTransitionStyle}
                structuredAnswerSummaryNode={structuredAnswerSummaryNode}
                browsePracticeButton={browsePracticeButton}
                answerInputNode={answerInputNode}
                submitResultCardNode={renderSubmitResultCard('mt-1')}
                browseExplanationNode={renderExplanation(true)}
                practiceExplanationNode={renderExplanation()}
                userNoteSectionNode={userNoteSectionNode}
                onToggleFavorite={() => { void handleToggleFavorite(); }}
                onOpenCropDialog={() => setCropDialogOpen(true)}
                onToggleSettingsPanel={() => setShowSettingsPanel(true)}
                onRefreshQuestion={onRefreshQuestion}
                onRevealAnswer={() => setAnswerRevealed(true)}
                onSubmit={() => { void handleSubmit(); }}
              />
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
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={() => handleNavigate('prev')}
                  disabled={currentIndex === 0}
                  className="flex-1 !h-11"
                >
                  <CaretLeft size={16} className="mr-1" />
                  {t('editor.prevQuestion')}
                </DsButton>
                {renderQuestionJumper('shrink-0 !h-11 border border-border/45')}
                <DsButton
                  variant={submitResult ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleNavigate('next')}
                  disabled={currentIndex === totalQuestions - 1}
                  className="flex-1 !h-11"
                >
                  {t('editor.nextQuestion')}
                  <CaretRight size={16} className="ml-1" />
                </DsButton>
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
            {settingsPanelNode}
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
            isActive={isActive}
            onImageAdded={handleCropImageAdded}
          />
        )}
      </div>
    );
  }

  // ========== 桌面端布局（去 head 化） ==========
  return (
    <div
      ref={containerRef}
      data-practice-shortcuts
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

      {/* 居中栏放在视口内层：视口的 margin / padding 由 OverlayScrollbars 接管，写在 viewportClassName 上的 mx-auto 不生效 */}
      <CustomScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-3 py-4 sm:px-6 sm:py-6 space-y-4">
          {/* 完成庆祝（内联） */}
          {completionCelebrationNode}

          <QuestionEditorStage
            variant="desktop"
            currentQuestion={currentQuestion}
            currentIndex={currentIndex}
            totalQuestions={totalQuestions}
            qType={qType}
            isChoiceQuestion={isChoiceQuestion}
            isSmallScreen={isSmallScreen}
            focusMode={focusMode}
            browseMode={browseMode}
            isFavorite={isFavorite}
            canToggleFavorite={!!onToggleFavorite}
            showSettingsPanel={showSettingsPanel}
            hideAnswerMode={hideAnswerMode}
            answerRevealed={answerRevealed}
            submitResult={submitResult}
            canSubmit={canSubmit}
            isSubmitting={isSubmitting}
            questionImageUrls={questionImageUrls}
            questionTransitionStyle={questionTransitionStyle}
            structuredAnswerSummaryNode={structuredAnswerSummaryNode}
            browsePracticeButton={browsePracticeButton}
            answerInputNode={answerInputNode}
            submitResultCardNode={renderSubmitResultCard()}
            browseExplanationNode={renderExplanation(true)}
            practiceExplanationNode={renderExplanation()}
            userNoteSectionNode={userNoteSectionNode}
            onToggleFavorite={() => { void handleToggleFavorite(); }}
            onOpenCropDialog={() => setCropDialogOpen(true)}
            onToggleSettingsPanel={() => setShowSettingsPanel(!showSettingsPanel)}
            onRefreshQuestion={onRefreshQuestion}
            onRevealAnswer={() => setAnswerRevealed(true)}
            onSubmit={() => { void handleSubmit(); }}
          />
        </div>
      </CustomScrollArea>

      <div className="flex-shrink-0 border-t border-border/35 bg-background/95 backdrop-blur-sm safe-area-bottom">
        <div className="px-4 py-2.5">
          {/* 未保存草稿的内联确认条 */}
          {draftNavigationBanner}
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => handleNavigate('prev')}
              disabled={currentIndex === 0}
              className="h-8 px-3 text-muted-foreground hover:text-foreground"
            >
              <CaretLeft size={16} className="mr-1" />
              {t('editor.prevQuestion')}
            </DsButton>

            {renderQuestionJumper()}

            <DsButton
              variant={submitResult ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleNavigate('next')}
              disabled={currentIndex === totalQuestions - 1}
              className="h-8 px-3"
            >
              {t('editor.nextQuestion')}
              <CaretRight size={16} className="ml-1" />
            </DsButton>
          </div>
        </div>
      </div>
      {showSettingsPanel && (
        <aside
          className="absolute inset-y-0 right-0 z-20 w-80 max-w-[calc(100%-2rem)] border-l border-border/50 bg-background shadow-[var(--shadow-shell-floating)]"
          aria-label={t('editor.settings')}
        >
          {settingsPanelNode}
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
          isActive={isActive}
          onImageAdded={handleCropImageAdded}
        />
      )}
    </div>
  );
};

export default QuestionBankEditor;
