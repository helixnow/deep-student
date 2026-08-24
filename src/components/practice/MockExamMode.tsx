/**
 * 模拟考试模式组件
 * 
 * 功能：
 * - 模拟考试设置面板（题型配比、难度、时长；滑杆 + 步进器）
 * - 整卷模式：倒计时进度环、答题卡题号导航、交卷前未答内联横幅
 * - 交卷内联确认（项目惯例：不用模态弹窗）
 * - 成绩单：得分环、分题型正确率、用时
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import {
  FileText,
  Clock,
  Target,
  WarningCircle,
  CheckCircle,
  Trophy,
  ChartBar,
  CircleNotch,
  Play,
  GearSix,
  ArrowRight,
} from '@phosphor-icons/react';
import {
  useQuestionBankStore,
  MockExamConfig,
  MockExamSession,
  MockExamScoreCard,
  PRACTICE_QUESTION_TYPES,
} from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';
import { useCountdown } from '@/hooks/useCountdown';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  QBANK_FOCUS_EVENT,
  type QbankFocusEventDetail,
} from '@/features/workbench/agent/drivers/qbankDriver';
import { CountdownRing } from './CountdownRing';
import { AnswerSheetGrid } from './AnswerSheetGrid';
import { CountStepperRow } from './CountStepperRow';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

interface MockExamModeProps {
  examId: string;
  onStart?: (session: MockExamSession) => void;
  onSubmit?: (scoreCard: MockExamScoreCard) => void;
  /** 本地会话的当前题 ID（宿主传入时答题卡高亮以其为准，未传回退全局 store） */
  currentQuestionId?: string | null;
  /** 收藏标记题目 ID 集（宿主传入时优先；未传回退全局 store.questions，该 map 在此流程通常未加载） */
  markedQuestionIds?: ReadonlySet<string>;
  /** 宿主标签页是否活跃：保活隐藏（display:none）的实例不注册 Android 返回键 handler */
  isActive?: boolean;
  className?: string;
}

// 模拟考试可配比的题型（含 2026-07 新增 true_false/numeric/matching/ordering）；
// 论述/证明等长主观题不适合整卷限时模式，故排除
const QUESTION_TYPE_KEYS = PRACTICE_QUESTION_TYPES.filter(
  (key) => !['essay', 'proof', 'other'].includes(key),
);

const DIFFICULTY_KEYS = [
  { key: 'easy', color: 'text-success' },
  { key: 'medium', color: 'text-warning' },
  { key: 'hard', color: 'text-warning' },
  { key: 'very_hard', color: 'text-destructive' },
];

// 成绩单得分环
const SCORE_RING_RADIUS = 52;
const SCORE_RING_CIRCUMFERENCE = 2 * Math.PI * SCORE_RING_RADIUS;

export const MockExamMode: React.FC<MockExamModeProps> = ({
  examId,
  onStart,
  onSubmit,
  currentQuestionId,
  markedQuestionIds,
  isActive,
  className,
}) => {
  const { t } = useTranslation('practice');
  
  // Store
  const {
    mockExamSession,
    mockExamScoreCard,
    setMockExamSession,
    generateMockExam,
    submitMockExam,
    isLoadingPractice,
  } = useQuestionBankStore();
  const questions = useQuestionBankStore((state) => state.questions);
  
  // 配置状态
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [totalCount, setTotalCount] = useState(30);
  const [shuffle, setShuffle] = useState(true);
  const [includeMistakes, setIncludeMistakes] = useState(true);

  // 与 TimedPracticeMode 一致的输入钳制：时长为 0/NaN 会导致 targetEndTime = 现在，
  // 考试一开始就被自动交卷
  const normalizeDurationMinutes = useCallback((value: number): number => {
    if (!Number.isFinite(value)) return 60;
    return Math.max(10, Math.min(180, Math.round(value)));
  }, []);

  const normalizeTotalCount = useCallback((value: number): number => {
    if (!Number.isFinite(value)) return 30;
    return Math.max(5, Math.min(100, Math.round(value)));
  }, []);
  const [typeDistribution, setTypeDistribution] = useState<Record<string, number>>({});
  const [difficultyDistribution, setDifficultyDistribution] = useState<Record<string, number>>({});
  
  // UI 状态（交卷确认为内联面板，非模态弹窗）
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);

  // isActive === false：保活隐藏（display:none 标签页）的实例不注册返回键 handler，
  // 避免吞掉当前活跃视图的返回键（未传 isActive 的宿主行为不变）
  useEffect(() => {
    if (!showSubmitConfirm || isActive === false) return;
    return registerBackHandler(() => {
      setShowSubmitConfirm(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [showSubmitConfirm, isActive]);
  const [showScoreCard, setShowScoreCard] = useState(false);
  
  // 考试计时器 — 基于绝对时间戳
  const [targetEndTime, setTargetEndTime] = useState<number | null>(null);
  const autoSubmitTriggeredRef = useRef(false);
  const activeSession = useMemo(
    () => (mockExamSession?.exam_id === examId ? mockExamSession : null),
    [mockExamSession, examId],
  );

  useEffect(() => {
    if (activeSession?.is_submitted && mockExamScoreCard?.exam_id === examId) {
      setShowScoreCard(true);
    }
  }, [activeSession, mockExamScoreCard, examId]);

  const buildSubmitSession = useCallback((session: MockExamSession): MockExamSession => ({
    ...session,
    ended_at: new Date().toISOString(),
    is_submitted: true,
  }), []);
  
  const handleAutoSubmit = useCallback(() => {
    if (autoSubmitTriggeredRef.current) return;
    autoSubmitTriggeredRef.current = true;
    if (activeSession) {
      const submitSession = buildSubmitSession(activeSession);
      submitMockExam(submitSession).then((scoreCard) => {
        setMockExamSession(submitSession);
        setShowScoreCard(true);
        onSubmit?.(scoreCard);
      }).catch((err) => {
        autoSubmitTriggeredRef.current = false;
        console.error('Auto-submit failed:', err);
        showGlobalNotification('error', err instanceof Error ? err.message : String(err), t('mockExam.submitError'));
      });
    }
  }, [activeSession, submitMockExam, onSubmit, buildSubmitSession, setMockExamSession, t]);
  
  const { remaining: examRemainingSeconds } = useCountdown(
    targetEndTime,
    handleAutoSubmit,
  );

  // 最后 60 秒：变色 + 脉动（CountdownRing 内处理）
  
  // 计算总配置题数
  const configuredCount = useMemo(() => {
    const typeCount = Object.values(typeDistribution).reduce((a, b) => a + b, 0);
    const diffCount = Object.values(difficultyDistribution).reduce((a, b) => a + b, 0);
    return Math.max(typeCount, diffCount, totalCount);
  }, [typeDistribution, difficultyDistribution, totalCount]);
  
  // 更新题型配比
  const handleTypeChange = useCallback((key: string, value: number) => {
    setTypeDistribution((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);
  
  // 更新难度配比
  const handleDifficultyChange = useCallback((key: string, value: number) => {
    setDifficultyDistribution((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);
  
  // 开始考试
  const handleStart = useCallback(async () => {
    const config: MockExamConfig = {
      duration_minutes: durationMinutes,
      type_distribution: typeDistribution,
      difficulty_distribution: difficultyDistribution,
      total_count: totalCount,
      shuffle,
      include_mistakes: includeMistakes,
    };
    
    try {
      const session = await generateMockExam(examId, config);
      // 优先以后端 started_at 为基准，避免请求耗时挤占考试时间
      const startedMs = Date.parse(session.started_at);
      const baseMs = Number.isFinite(startedMs) ? startedMs : Date.now();
      setTargetEndTime(baseMs + session.config.duration_minutes * 60 * 1000);
      autoSubmitTriggeredRef.current = false;
      onStart?.(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('mockExam.startError'));
    }
  }, [examId, durationMinutes, totalCount, shuffle, includeMistakes, typeDistribution, difficultyDistribution, generateMockExam, onStart, t]);

  useEffect(() => {
    if (!activeSession || activeSession.is_submitted) {
      setTargetEndTime(null);
      return;
    }
    const startedMs = Date.parse(activeSession.started_at);
    if (!Number.isFinite(startedMs)) return;
    const durationMs = (activeSession.config.duration_minutes || 0) * 60 * 1000;
    if (durationMs <= 0) return;
    const restoredEndTime = startedMs + durationMs;
    setTargetEndTime((prev) => prev ?? restoredEndTime);
  }, [activeSession]);
  
  // 交卷（手动）
  const handleSubmit = useCallback(async () => {
    if (!activeSession) return;
    // 倒计时自动交卷已触发时忽略手动交卷，避免双重提交
    if (autoSubmitTriggeredRef.current) {
      setShowSubmitConfirm(false);
      return;
    }

    setShowSubmitConfirm(false);
    const previousTargetEndTime = targetEndTime;
    setTargetEndTime(null);
    autoSubmitTriggeredRef.current = true;
    const submitSession = buildSubmitSession(activeSession);
    
    try {
      const scoreCard = await submitMockExam(submitSession);
      setMockExamSession(submitSession);
      setShowScoreCard(true);
      onSubmit?.(scoreCard);
    } catch (err: unknown) {
      autoSubmitTriggeredRef.current = false;
      setTargetEndTime(previousTargetEndTime);
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('mockExam.submitError'));
    }
  }, [activeSession, submitMockExam, onSubmit, t, targetEndTime, buildSubmitSession, setMockExamSession]);
  
  // 成绩单界面
  if (showScoreCard && mockExamScoreCard) {
    const score = mockExamScoreCard;
    const scoreRate = Math.max(0, Math.min(100, score.correct_rate));
    const scoreTone = scoreRate >= 80 ? 'text-success' : scoreRate >= 60 ? 'text-warning' : 'text-destructive';
    
    return (
      <Card className={cn('ui-rise-in bg-transparent border-transparent shadow-none', className)}>
        <CardHeader className="px-3 pb-3 text-center sm:px-6">
          <div className="mb-1 flex justify-center">
            <div className="rounded-md bg-warning/10 p-2">
              <Trophy size={24} className="text-warning" />
            </div>
          </div>
          <CardTitle className="text-base">{t('mockExam.scoreCard')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 px-3 sm:px-6">
          {/* 得分环 */}
          <div className="relative mx-auto h-32 w-32">
            <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
              <circle
                cx="60" cy="60" r={SCORE_RING_RADIUS}
                fill="none" stroke="currentColor" strokeWidth="8"
                className="text-muted/30"
/>
              <circle
                cx="60" cy="60" r={SCORE_RING_RADIUS}
                fill="none" stroke="currentColor" strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={SCORE_RING_CIRCUMFERENCE}
                strokeDashoffset={SCORE_RING_CIRCUMFERENCE * (1 - scoreRate / 100)}
                className={cn('transition-[stroke-dashoffset] duration-700 ease-out', scoreTone)}
/>
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={cn('text-3xl font-semibold tabular-nums', scoreTone)}>
                {Math.round(scoreRate)}
                <span className="text-base text-muted-foreground">%</span>
              </span>
              <span className="text-xs text-muted-foreground">{t('mockExam.correctRateLabel')}</span>
            </div>
          </div>
          {score.comment && (
            <div className="text-center text-sm text-muted-foreground">{score.comment}</div>
          )}
          
          {/* 统计数据 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md bg-muted/50 p-2 text-center">
              <div className="text-lg font-semibold">{score.total_count}</div>
              <div className="text-xs text-muted-foreground">{t('mockExam.total')}</div>
            </div>
            <div className="rounded-md bg-success/10 p-2 text-center">
              <div className="text-lg font-semibold text-success">{score.correct_count}</div>
              <div className="text-xs text-success">{t('mockExam.correct')}</div>
            </div>
            <div className="rounded-md bg-destructive/10 p-2 text-center">
              <div className="text-lg font-semibold text-destructive">{score.wrong_count}</div>
              <div className="text-xs text-destructive">{t('mockExam.wrong')}</div>
            </div>
            <div className="rounded-md bg-muted p-2 text-center">
              <div className="text-lg font-semibold">{score.unanswered_count}</div>
              <div className="text-xs text-muted-foreground">{t('mockExam.unanswered')}</div>
            </div>
          </div>
          
          {/* 用时 */}
          <div className="flex items-center justify-center gap-2 rounded-md bg-muted/50 p-2.5">
            <Clock size={16} className="text-primary" />
            <span className="font-medium text-foreground">
              {t('mockExam.timeSpent')}：
              {Math.floor(score.time_spent_seconds / 60)} {t('mockExam.minutes')}
              {score.time_spent_seconds % 60} {t('mockExam.seconds')}
            </span>
          </div>
          
          {/* 分题型正确率 */}
          {Object.keys(score.type_stats).length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <ChartBar size={16} />
                {t('mockExam.typeStats')}
              </div>
              <div className="space-y-2">
                {Object.entries(score.type_stats).map(([type, stat]) => (
                  <div key={type} className="flex items-center gap-3">
                    <span className="w-16 truncate text-sm sm:w-20" title={t(`questionType.${type}`, type)}>
                      {t(`questionType.${type}`, type)}
                    </span>
                    <Progress value={stat.rate} className="h-2 min-w-0 flex-1" />
                    <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                      {stat.correct}/{stat.total}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* 操作按钮 */}
          <div className="flex flex-col gap-2 min-[360px]:flex-row min-[360px]:gap-3">
            <DsButton
              variant="outline"
              onClick={() => {
                setShowScoreCard(false);
                setMockExamSession(null);
                setTargetEndTime(null);
              }}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              {t('mockExam.back')}
            </DsButton>
            <DsButton
              onClick={() => {
                setShowScoreCard(false);
                setMockExamSession(null);
                setTargetEndTime(null);
                autoSubmitTriggeredRef.current = false;
                handleStart();
              }}
              className="flex-1 [@media(pointer:coarse)]:!min-h-11"
            >
              {t('mockExam.newExam')}
            </DsButton>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  // 配置界面
  if (!activeSession) {
    return (
      <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
        <CardHeader className="px-0 pb-4 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText size={18} className="text-primary" />
            {t('mockExam.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 px-0 sm:px-6">
          {/* 基本配置 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('mockExam.duration')}</Label>
              <Input
                type="number"
                min={10}
                max={180}
                value={durationMinutes}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  setDurationMinutes(normalizeDurationMinutes(Number(raw)));
                }}
                onBlur={(e) => setDurationMinutes(normalizeDurationMinutes(Number(e.target.value)))}
                className="[@media(pointer:coarse)]:text-[16px]"
/>
            </div>
            <div className="space-y-2">
              <Label>{t('mockExam.totalCount')}</Label>
              <Input
                type="number"
                min={5}
                max={100}
                value={totalCount}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  setTotalCount(normalizeTotalCount(Number(raw)));
                }}
                onBlur={(e) => setTotalCount(normalizeTotalCount(Number(e.target.value)))}
                className="[@media(pointer:coarse)]:text-[16px]"
/>
            </div>
          </div>
          
          {/* 开关选项 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t('mockExam.shuffle')}</Label>
              <Switch checked={shuffle} onCheckedChange={setShuffle} />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t('mockExam.includeMistakes')}</Label>
              <Switch checked={includeMistakes} onCheckedChange={setIncludeMistakes} />
            </div>
          </div>
          
          {/* 题型配比 */}
          <div className="space-y-3">
            <Label className="flex items-center gap-1">
              <GearSix size={16} />
              {t('mockExam.typeDistribution')}
              <span className="text-muted-foreground text-xs">{t('mockExam.optional')}</span>
            </Label>
            {/* 出题数 = max(题型配比和, 难度配比和, 总题数)，配比拉大会覆盖总题数 */}
            <p className="text-xs text-muted-foreground">{t('mockExam.distributionHint')}</p>
            <div className="space-y-1.5">
              {QUESTION_TYPE_KEYS.map((key) => (
                <CountStepperRow
                  key={key}
                  label={t(`questionType.${key}`)}
                  value={typeDistribution[key] || 0}
                  onChange={(value) => handleTypeChange(key, value)}
                  max={20}
/>
              ))}
            </div>
          </div>
          
          {/* 难度配比 */}
          <div className="space-y-3">
            <Label className="flex items-center gap-1">
              <Target size={16} />
              {t('mockExam.difficultyDistribution')}
              <span className="text-muted-foreground text-xs">{t('mockExam.optional')}</span>
            </Label>
            <div className="space-y-1.5">
              {DIFFICULTY_KEYS.map(({ key, color }) => (
                <CountStepperRow
                  key={key}
                  label={t(`difficultyLevel.${key}`)}
                  labelClassName={color}
                  value={difficultyDistribution[key] || 0}
                  onChange={(value) => handleDifficultyChange(key, value)}
                  max={20}
/>
              ))}
            </div>
          </div>

          {/* 实际出题数摘要 */}
          <div className="text-sm text-muted-foreground">
            {t('mockExam.configuredCount')}{' '}
            <span className="font-medium text-foreground tabular-nums">{configuredCount}</span>{' '}
            {t('mockExam.questions')}
          </div>
          
          <DsButton
            onClick={handleStart}
            disabled={isLoadingPractice}
            className="w-full [@media(pointer:coarse)]:!min-h-11"
          >
            {isLoadingPractice ? (
              <>
                <CircleNotch size={16} className="mr-2 animate-spin" />
                {t('mockExam.generating')}
              </>
            ) : (
              <>
                <Play size={16} className="mr-2" />
                {t('mockExam.start')}
              </>
            )}
          </DsButton>
        </CardContent>
      </Card>
    );
  }
  
  // 考试中 - 整卷模式（实际答题由 QuestionBankEditor 处理，此处提供导航与交卷）
  const progress = activeSession.question_ids.length > 0
    ? (Object.keys(activeSession.answers).length / activeSession.question_ids.length) * 100
    : 0;
  
  const answeredCount = Object.keys(activeSession.answers).length;
  const unansweredCount = activeSession.question_ids.length - answeredCount;
  const answeredIds = new Set(Object.keys(activeSession.answers));
  // 收藏标记优先取宿主传入的集合；全局 store.questions 在此流程通常未加载，仅作兜底
  const markedIds = markedQuestionIds
    ?? new Set(activeSession.question_ids.filter((id) => questions.get(id)?.is_favorite));
  const firstUnansweredId = activeSession.question_ids.find((id) => !answeredIds.has(id)) ?? null;

  return (
    <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
      <CardContent className="space-y-4 px-3 pt-6 sm:px-6">
        {/* 倒计时进度环 */}
        <div className="flex flex-col items-center justify-center py-2">
          <CountdownRing
            remainingSeconds={examRemainingSeconds}
            totalSeconds={(activeSession.config.duration_minutes || durationMinutes) * 60}
            timeText={formatTime(examRemainingSeconds)}
            subtitle={t('mockExam.remaining')}
/>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary" className="shrink-0 gap-1">
              <FileText size={12} />
              {t('mockExam.inProgress')}
            </Badge>
            <span className="truncate text-sm text-muted-foreground tabular-nums">
              {answeredCount} / {activeSession.question_ids.length} {t('mockExam.questions')}
            </span>
          </div>
          <DsButton
            variant="default"
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => setShowSubmitConfirm(true)}
            disabled={showSubmitConfirm}
          >
            {t('mockExam.submit')}
          </DsButton>
        </div>
        <Progress value={progress} className="h-2" />

        {/* 交卷前未答提醒内联横幅 */}
        {!showSubmitConfirm && unansweredCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/25 bg-warning/[0.06] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm text-warning">
              <WarningCircle size={16} className="shrink-0" />
              <span className="truncate">{t('mockExam.unansweredBanner', { count: unansweredCount })}</span>
            </div>
            {firstUnansweredId && (
              <DsButton
                variant="outline"
                size="sm"
                className="[@media(pointer:coarse)]:!min-h-11"
                onClick={() => {
                  useQuestionBankStore.getState().setCurrentQuestion(firstUnansweredId);
                  window.dispatchEvent(
                    new CustomEvent<QbankFocusEventDetail>(QBANK_FOCUS_EVENT, {
                      detail: { questionId: firstUnansweredId, targetResourceId: examId },
                    }),
                  );
                }}
              >
                {t('mockExam.jumpToUnanswered')}
                <ArrowRight size={14} className="ml-1" />
              </DsButton>
            )}
          </div>
        )}

        {/* 答题卡：题号导航（已答/未答/收藏标记） */}
        <AnswerSheetGrid
          questionIds={activeSession.question_ids}
          examId={examId}
          answeredIds={answeredIds}
          markedIds={markedIds}
          currentQuestionId={currentQuestionId}
/>

        {/* 交卷内联确认（替代模态弹窗） */}
        {showSubmitConfirm && (
          <div className="ui-rise-in rounded-md border border-warning/30 bg-warning/[0.08] p-3 space-y-2.5">
            <div className="flex items-start gap-2">
              <WarningCircle size={16} className="flex-shrink-0 mt-0.5 text-warning" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{t('mockExam.confirmTitle')}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {unansweredCount > 0
                    ? t('mockExam.confirmWarning', { count: unansweredCount })
                    : t('mockExam.confirmMessage')}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <DsButton
                variant="outline"
                size="sm"
                className="flex-1 [@media(pointer:coarse)]:!min-h-11"
                onClick={() => setShowSubmitConfirm(false)}
              >
                {t('mockExam.cancel')}
              </DsButton>
              <DsButton
                variant="default"
                size="sm"
                className="flex-1 [@media(pointer:coarse)]:!min-h-11"
                onClick={() => void handleSubmit()}
              >
                <CheckCircle size={14} className="mr-1" />
                {t('mockExam.confirmSubmit')}
              </DsButton>
            </div>
          </div>
        )}
        
        {/* 时间不足警告 */}
        {examRemainingSeconds > 0 && examRemainingSeconds < 60 && (
          <div className="ui-rise-in flex items-center gap-2 rounded-md bg-destructive/10 p-2.5 text-destructive">
            <WarningCircle size={16} className="animate-pulse" />
            <span className="text-sm font-medium">{t('mockExam.timeWarning')}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default MockExamMode;
