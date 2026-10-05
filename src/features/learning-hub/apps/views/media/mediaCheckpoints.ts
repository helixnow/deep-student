/**
 * 课中检查点（docs/dev/media-learning §3，弹幕思考题的原生替代）
 *
 * 检查点 = 解析里锚定到本课某一刻的题目（出题流水线 / 聊天出题都会按要求写 `[媒体@id:mm:ss]`），
 * 后端 `media_checkpoints` 按时刻排序返回。播放器进度条标记、播到时提示作答，判分走
 * `qbank_submit_answer`（进错题复习 / 掌握度），答错可回看这一段。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEventRegistry } from '@/hooks/useEventRegistry';

export interface MediaCheckpointOption {
  key: string;
  content: string;
}

export interface MediaCheckpoint {
  questionId: string;
  examId: string;
  /** 解析里本课出处的时刻（秒） */
  seconds: number;
  content: string;
  questionType: string;
  options: MediaCheckpointOption[];
  answer: string | null;
  explanation: string | null;
  attemptCount: number;
  /** 最近一次是否答对；没做过为 null */
  isCorrect: boolean | null;
}

export type MediaCheckpointState = 'pending' | 'correct' | 'wrong';

/** 点选即可判分的题型；其余题型看答案后自评 */
export const CHOICE_QUESTION_TYPES = new Set(['single_choice', 'multiple_choice', 'indefinite_choice', 'true_false']);

/** 播放连续越过检查点时才提示：两次状态间隔超过该值视为跳转，不打断 */
export const CHECKPOINT_CROSS_MAX_STEP_SECONDS = 2;

export function checkpointState(checkpoint: Pick<MediaCheckpoint, 'attemptCount' | 'isCorrect'>): MediaCheckpointState {
  if (checkpoint.attemptCount <= 0 || checkpoint.isCorrect === null) return 'pending';
  return checkpoint.isCorrect ? 'correct' : 'wrong';
}

/** 选项 JSON 宽松解析：`[{key, content}]` / `[{label, text}]` / 字符串数组（按 A、B… 编号） */
export function parseCheckpointOptions(raw: unknown): MediaCheckpointOption[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): MediaCheckpointOption | null => {
      const fallbackKey = String.fromCharCode(65 + index);
      if (typeof item === 'string') return { key: fallbackKey, content: item };
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const key = typeof record.key === 'string' && record.key.trim() ? record.key.trim()
        : typeof record.label === 'string' && record.label.trim() ? record.label.trim() : fallbackKey;
      const content = typeof record.content === 'string' ? record.content
        : typeof record.text === 'string' ? record.text : '';
      return { key, content };
    })
    .filter((option): option is MediaCheckpointOption => option !== null);
}

export function normalizeCheckpoint(raw: unknown): MediaCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const questionId = typeof r.questionId === 'string' ? r.questionId : null;
  const examId = typeof r.examId === 'string' ? r.examId : null;
  const seconds = typeof r.seconds === 'number' && Number.isFinite(r.seconds) ? r.seconds : null;
  if (!questionId || !examId || seconds === null) return null;
  return {
    questionId,
    examId,
    seconds,
    content: typeof r.content === 'string' ? r.content : '',
    questionType: typeof r.questionType === 'string' ? r.questionType : 'other',
    options: parseCheckpointOptions(r.optionsJson),
    answer: typeof r.answer === 'string' ? r.answer : null,
    explanation: typeof r.explanation === 'string' ? r.explanation : null,
    attemptCount: typeof r.attemptCount === 'number' ? r.attemptCount : 0,
    isCorrect: typeof r.isCorrect === 'boolean' ? r.isCorrect : null,
  };
}

export async function fetchMediaCheckpoints(resourceId: string): Promise<MediaCheckpoint[]> {
  const raw = await invoke<unknown>('media_checkpoints', { resourceId });
  return (Array.isArray(raw) ? raw : [])
    .map(normalizeCheckpoint)
    .filter((checkpoint): checkpoint is MediaCheckpoint => checkpoint !== null);
}

export interface CheckpointSubmitResult {
  isCorrect: boolean | null;
  correctAnswer: string | null;
}

/** 判分走题库同一入口：作答记录、错题复习、掌握度随之更新 */
export async function submitCheckpointAnswer(
  questionId: string,
  userAnswer: string,
  isCorrectOverride?: boolean,
): Promise<CheckpointSubmitResult> {
  const result = await invoke<{ is_correct: boolean | null; correct_answer?: string | null }>('qbank_submit_answer', {
    request: {
      question_id: questionId,
      user_answer: userAnswer,
      is_correct_override: isCorrectOverride,
      client_request_id: `media-cp-${questionId}-${Date.now()}`,
    },
  });
  return { isCorrect: result.is_correct ?? null, correctAnswer: result.correct_answer ?? null };
}

/**
 * 本次连续播放从 previous 走到 current 时越过的第一个未提示检查点；跳转（步长过大）或倒退不算
 */
export function findCrossedCheckpoint(
  checkpoints: readonly MediaCheckpoint[],
  previous: number,
  current: number,
  prompted: ReadonlySet<string>,
): MediaCheckpoint | null {
  if (current <= previous || current - previous > CHECKPOINT_CROSS_MAX_STEP_SECONDS) return null;
  return checkpoints.find((cp) => cp.seconds > previous && cp.seconds <= current && !prompted.has(cp.questionId)) ?? null;
}

export interface MediaCheckpointsState {
  checkpoints: MediaCheckpoint[];
  refresh: () => Promise<void>;
  /** 作答后就地更新状态（进度条颜色），不必等重拉 */
  recordResult: (questionId: string, isCorrect: boolean | null) => void;
}

export function useMediaCheckpoints(resourceId: string, enabled: boolean): MediaCheckpointsState {
  const [checkpoints, setCheckpoints] = useState<MediaCheckpoint[]>([]);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const generation = ++generationRef.current;
    try {
      const next = await fetchMediaCheckpoints(resourceId);
      if (generation === generationRef.current) setCheckpoints(next);
    } catch {
      // 检查点是锦上添花：拉取失败保持现状，不打扰学习
    }
  }, [enabled, resourceId]);

  useEffect(() => {
    if (!enabled) {
      setCheckpoints([]);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // 在对话里出完题回到学习页时补上新检查点
  const onVisible = useCallback(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, [refresh]);
  useEventRegistry(
    enabled
      ? [
          { target: 'document', type: 'visibilitychange', listener: onVisible },
          { target: 'window', type: 'focus', listener: () => void refresh() },
        ]
      : [],
    [enabled, onVisible, refresh],
  );

  const recordResult = useCallback((questionId: string, isCorrect: boolean | null) => {
    setCheckpoints((prev) => prev.map((cp) => (cp.questionId === questionId
      ? { ...cp, attemptCount: cp.attemptCount + 1, isCorrect }
      : cp)));
  }, []);

  return { checkpoints, refresh, recordResult };
}
