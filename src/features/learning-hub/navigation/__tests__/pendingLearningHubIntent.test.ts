import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_LEARNING_HUB_INTENT_TTL_MS,
  isLearningHubReady,
  markLearningHubReady,
  peekPendingLearningHubIntent,
  requestLearningHubIntent,
  resetLearningHubIntentHandshakeForTest,
} from '../pendingLearningHubIntent';

function listen(type: string) {
  const received: unknown[] = [];
  const listener = (event: Event) => received.push((event as CustomEvent).detail);
  window.addEventListener(type, listener);
  return { received, dispose: () => window.removeEventListener(type, listener) };
}

describe('pendingLearningHubIntent', () => {
  beforeEach(() => {
    resetLearningHubIntentHandshakeForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLearningHubIntentHandshakeForTest();
  });

  it('buffers a cold intent without dispatching and replays it once the hub is ready', () => {
    const notes = listen('learningHubOpenNote');
    try {
      requestLearningHubIntent('learningHubOpenNote', { noteId: 'note_1', source: 'wikilink' });
      expect(notes.received).toEqual([]);
      expect(peekPendingLearningHubIntent()?.type).toBe('learningHubOpenNote');

      const release = markLearningHubReady();
      expect(notes.received).toEqual([{ noteId: 'note_1', source: 'wikilink' }]);
      expect(peekPendingLearningHubIntent()).toBeNull();
      expect(isLearningHubReady()).toBe(true);

      release();
      release();
      expect(isLearningHubReady()).toBe(false);
    } finally {
      notes.dispose();
    }
  });

  it('keeps only the latest cold intent', () => {
    const notes = listen('learningHubOpenNote');
    const exams = listen('learningHubOpenExam');
    try {
      requestLearningHubIntent('learningHubOpenNote', { noteId: 'note_old' });
      requestLearningHubIntent('learningHubOpenExam', { sessionId: 'exam_1', cardId: null, mistakeId: null });

      const release = markLearningHubReady();
      expect(notes.received).toEqual([]);
      expect(exams.received).toEqual([{ sessionId: 'exam_1', cardId: null, mistakeId: null }]);
      release();
    } finally {
      notes.dispose();
      exams.dispose();
    }
  });

  it('dispatches immediately while the hub is ready', () => {
    const resources = listen('learningHubOpenResource');
    try {
      const release = markLearningHubReady();
      requestLearningHubIntent('learningHubOpenResource', { dstuPath: '/mm_1' });
      expect(resources.received).toEqual([{ dstuPath: '/mm_1' }]);
      expect(peekPendingLearningHubIntent()).toBeNull();
      release();

      // 卸载后再次请求回到挂起态
      requestLearningHubIntent('learningHubOpenResource', { dstuPath: '/mm_2' });
      expect(resources.received).toHaveLength(1);
      expect(peekPendingLearningHubIntent()?.detail).toEqual({ dstuPath: '/mm_2' });
    } finally {
      resources.dispose();
    }
  });

  it('drops stale intents instead of replaying them on a much later mount', () => {
    vi.useFakeTimers();
    const notes = listen('learningHubOpenNote');
    try {
      requestLearningHubIntent('learningHubOpenNote', { noteId: 'note_stale' });
      vi.advanceTimersByTime(PENDING_LEARNING_HUB_INTENT_TTL_MS + 1);

      const release = markLearningHubReady();
      expect(notes.received).toEqual([]);
      expect(peekPendingLearningHubIntent()).toBeNull();
      release();
    } finally {
      notes.dispose();
    }
  });
});
