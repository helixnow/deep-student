import { useState, useEffect, useCallback, useRef, useMemo, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import type { PracticeMode } from '@/api/questionBankApi';
import type { GradingMode } from '@/api/practiceApi';
import type { ViewMode } from './ExamViewPrimitives';

type QuestionBankStoreState = ReturnType<typeof useQuestionBankStore.getState>;

export interface UseExamPracticeTimersOptions {
  sessionId: string;
  sessionScope: { sessionId: string };
  latestSessionScopeRef: RefObject<{ sessionId: string } | null>;
  viewMode: ViewMode;
  practiceMode: PracticeMode;
  gradingMode: GradingMode;
  isActive?: boolean;
  activeTimedSession: QuestionBankStoreState['timedSession'];
  activeMockExamSession: QuestionBankStoreState['mockExamSession'];
  activeDailyPractice: QuestionBankStoreState['dailyPractice'];
  setTimedSession: QuestionBankStoreState['setTimedSession'];
  submitMockExam: QuestionBankStoreState['submitMockExam'];
  switchViewMode: (mode: ViewMode) => void;
}

/**
 * 练习计时与限时/模拟考倒计时状态机：
 * - 普通练习秒表（非活跃标签暂停）
 * - 限时/模拟考墙钟倒计时（含 paused_seconds 暂停补偿）
 * - 限时到期强制结束 & 模拟考到期自动交卷
 */
export function useExamPracticeTimers({
  sessionId,
  sessionScope,
  latestSessionScopeRef,
  viewMode,
  practiceMode,
  gradingMode,
  isActive,
  activeTimedSession,
  activeMockExamSession,
  activeDailyPractice,
  setTimedSession,
  submitMockExam,
  switchViewMode,
}: UseExamPracticeTimersOptions) {
  const { t } = useTranslation(['exam_sheet', 'common', 'learningHub', 'review']);

  const [elapsedTime, setElapsedTime] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mockExamTimeoutHandledRef = useRef<string | null>(null);
  const timedTimeoutHandledRef = useRef<string | null>(null);

  // 会话切换重置已用时长
  useEffect(() => {
    setElapsedTime(0);
  }, [sessionId]);

  // 进入做题模式时自动开始计时
  useEffect(() => {
    if (viewMode === 'practice') {
      setIsTimerRunning(true);
    } else {
      setIsTimerRunning(false);
    }
  }, [viewMode]);

  const toggleTimer = useCallback(() => {
    setIsTimerRunning(prev => !prev);
  }, []);

  const activeAdvancedTimerDuration = useMemo(() => {
    if (gradingMode === 'on_submit') return null;
    if (
      practiceMode === 'timed' &&
      activeTimedSession &&
      !activeTimedSession.is_submitted &&
      !activeTimedSession.is_timeout
    ) {
      return activeTimedSession.duration_minutes * 60;
    }
    if (
      practiceMode === 'mock_exam' &&
      activeMockExamSession &&
      !activeMockExamSession.is_submitted
    ) {
      return activeMockExamSession.config.duration_minutes * 60;
    }
    return null;
  }, [practiceMode, activeTimedSession, activeMockExamSession, gradingMode]);

  const activeAdvancedStartedAt = useMemo(() => {
    if (practiceMode === 'timed') return activeTimedSession?.started_at || null;
    if (practiceMode === 'mock_exam') return activeMockExamSession?.started_at || null;
    return null;
  }, [practiceMode, activeTimedSession, activeMockExamSession]);

  // 限时练习的暂停补偿：TimedPracticeMode 恢复会话按 started_at + duration
  // + paused_seconds 计算倒计时终点，这里的 elapsed 必须同口径扣除
  // paused_seconds，否则暂停过的用户会被超时 effect 提前强制交卷。
  // 模拟考无暂停机制，恒为 0。
  const activeAdvancedPausedSeconds = useMemo(() => {
    if (practiceMode !== 'timed') return 0;
    const paused = activeTimedSession?.paused_seconds;
    return typeof paused === 'number' && Number.isFinite(paused) ? Math.max(0, paused) : 0;
  }, [practiceMode, activeTimedSession]);

  // 会话完成（限时交卷/超时、模拟考交卷、每日目标达成）后停掉顶栏计时，
  // 避免「已完成」庆祝卡下倒计时/秒表继续走。卸载时由下方 interval cleanup 清表。
  useEffect(() => {
    const timedDone = Boolean(
      practiceMode === 'timed'
      && activeTimedSession
      && (activeTimedSession.is_submitted || activeTimedSession.is_timeout),
    );
    const mockDone = Boolean(
      practiceMode === 'mock_exam'
      && activeMockExamSession?.is_submitted,
    );
    const dailyDone = Boolean(
      practiceMode === 'daily'
      && activeDailyPractice?.is_completed,
    );
    if (timedDone || mockDone || dailyDone) {
      setIsTimerRunning(false);
    }
  }, [
    viewMode,
    practiceMode,
    activeTimedSession,
    activeMockExamSession,
    activeDailyPractice,
  ]);

  // 计时器逻辑
  // 标签页：普通练习的秒表在 isActive === false 时暂停，避免后台计时不精确；
  //   限时/模拟考（advanced runtime）必须按墙钟走：后台切换、休眠恢复都不能"暂停"考试，
  //   否则与后端 time_spent（ended_at - started_at）和启动页的绝对时间倒计时不一致。
  useEffect(() => {
    if (gradingMode === 'on_submit') return;
    const advancedRuntime = activeAdvancedTimerDuration != null;
    if (viewMode === 'practice' && isTimerRunning && (isActive !== false || advancedRuntime)) {
      timerRef.current = setInterval(() => {
        if (advancedRuntime && activeAdvancedStartedAt) {
          const startedMs = Date.parse(activeAdvancedStartedAt);
          if (Number.isFinite(startedMs)) {
            // 墙钟推算，免疫 setInterval 漂移与系统休眠；扣除累计暂停时长，
            // 与 TimedPracticeMode 的倒计时终点口径一致
            setElapsedTime(Math.max(
              0,
              Math.floor((Date.now() - startedMs) / 1000) - activeAdvancedPausedSeconds,
            ));
            return;
          }
        }
        setElapsedTime(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [viewMode, isTimerRunning, isActive, activeAdvancedTimerDuration, activeAdvancedStartedAt, activeAdvancedPausedSeconds, gradingMode]);

  const isAdvancedRuntimeTimer = activeAdvancedTimerDuration != null;
  const advancedTimerRemaining = useMemo(() => {
    if (activeAdvancedTimerDuration == null) return null;
    return Math.max(activeAdvancedTimerDuration - elapsedTime, 0);
  }, [activeAdvancedTimerDuration, elapsedTime]);

  useEffect(() => {
    if (viewMode !== 'practice' || !activeAdvancedStartedAt || activeAdvancedTimerDuration == null) {
      return;
    }
    const startedMs = Date.parse(activeAdvancedStartedAt);
    if (!Number.isFinite(startedMs)) return;
    // 恢复时同样扣除累计暂停时长，保持与 tick 推算、启动页倒计时同口径
    const restoredElapsed = Math.min(
      activeAdvancedTimerDuration,
      Math.max(0, Math.floor((Date.now() - startedMs) / 1000) - activeAdvancedPausedSeconds),
    );
    setElapsedTime(restoredElapsed);
    setIsTimerRunning(true);
  }, [viewMode, activeAdvancedStartedAt, activeAdvancedTimerDuration, activeAdvancedPausedSeconds]);

  // 限时练习到期强制结束
  useEffect(() => {
    if (!activeTimedSession || activeTimedSession.is_submitted || activeTimedSession.is_timeout) {
      timedTimeoutHandledRef.current = null;
      return;
    }
    if (
      viewMode !== 'practice' ||
      practiceMode !== 'timed' ||
      activeAdvancedTimerDuration == null ||
      Date.now() < Date.parse(activeTimedSession.started_at) + (activeAdvancedTimerDuration + activeAdvancedPausedSeconds) * 1000 ||
      elapsedTime < activeAdvancedTimerDuration
    ) {
      return;
    }
    if (timedTimeoutHandledRef.current === activeTimedSession.id) {
      return;
    }
    timedTimeoutHandledRef.current = activeTimedSession.id;
    setIsTimerRunning(false);
    // 时间到是系统强制结束，不是可取消的导航。若改成普通草稿确认，用户
    // 取消后会留下已停止但仍标记为 active 的计时会话，无法再次触发结算。
    setElapsedTime(0);
    setTimedSession({
      ...activeTimedSession,
      ended_at: new Date().toISOString(),
      is_timeout: true,
      is_submitted: true,
    });
    switchViewMode('launcher');
    showGlobalNotification(
      'info',
      t('learningHub:exam.timedPracticeTimeout'),
      t('learningHub:exam.timerEnded'),
    );
  }, [
    activeTimedSession,
    activeAdvancedTimerDuration,
    activeAdvancedPausedSeconds,
    elapsedTime,
    practiceMode,
    setTimedSession,
    switchViewMode,
    t,
    viewMode,
  ]);

  // 模拟考到期自动交卷
  useEffect(() => {
    if (!activeMockExamSession || activeMockExamSession.is_submitted) {
      mockExamTimeoutHandledRef.current = null;
      return;
    }
    if (
      viewMode !== 'practice' ||
      practiceMode !== 'mock_exam' ||
      activeAdvancedTimerDuration == null ||
      Date.now() < Date.parse(activeMockExamSession.started_at) + activeAdvancedTimerDuration * 1000 ||
      elapsedTime < activeAdvancedTimerDuration
    ) {
      return;
    }
    if (mockExamTimeoutHandledRef.current === activeMockExamSession.id) {
      return;
    }
    mockExamTimeoutHandledRef.current = activeMockExamSession.id;
    setIsTimerRunning(false);
    const isCurrentSubmission = () => (
      latestSessionScopeRef.current === sessionScope
      && useQuestionBankStore.getState().mockExamSession?.id === activeMockExamSession.id
      && useQuestionBankStore.getState().mockExamSession?.exam_id === activeMockExamSession.exam_id
    );

    const submitSession = {
      ...activeMockExamSession,
      ended_at: new Date().toISOString(),
      is_submitted: true,
    };

    void submitMockExam(submitSession)
      .then((scoreCard) => {
        if (!isCurrentSubmission() || useQuestionBankStore.getState().mockExamScoreCard !== scoreCard) return;
        setElapsedTime(0);
        switchViewMode('launcher');
        showGlobalNotification(
          'info',
          t('learningHub:exam.mockExamAutoSubmitted'),
          t('learningHub:exam.timerEnded'),
        );
      })
      .catch((err: unknown) => {
        debugLog.error('[ExamContentView] auto submit mock exam failed:', err);
        if (!isCurrentSubmission()) return;
        showGlobalNotification(
          'error',
          t('learningHub:exam.mockExamAutoSubmitFailed'),
        );
      });
  }, [
    activeMockExamSession,
    activeAdvancedTimerDuration,
    elapsedTime,
    latestSessionScopeRef,
    practiceMode,
    sessionScope,
    submitMockExam,
    switchViewMode,
    t,
    viewMode,
  ]);

  return {
    elapsedTime,
    setElapsedTime,
    isTimerRunning,
    setIsTimerRunning,
    toggleTimer,
    activeAdvancedTimerDuration,
    isAdvancedRuntimeTimer,
    advancedTimerRemaining,
  };
}
