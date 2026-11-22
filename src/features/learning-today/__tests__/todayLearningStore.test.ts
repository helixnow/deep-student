import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadTodayLearning, listen } = vi.hoisted(() => ({
  loadTodayLearning: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('../todayLearning', () => ({ loadTodayLearning }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
import { requestFlashcardsDueRefresh } from '@/events/flashcards';
import {
  FSRS_DUE_REFRESH_EVENT,
  TODAY_LEARNING_REFRESH_EVENT,
  getTodayLearningSnapshot,
  refreshTodayLearning,
  subscribeTodayLearning,
} from '../todayLearningStore';

describe('todayLearningStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes immediately when FSRS_DUE_REFRESH_EVENT or requestFlashcardsDueRefresh fires', async () => {
    let call = 0;
    loadTodayLearning.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { cards: 5, mistakes: 2, notes: 1, dueNotes: [] };
      if (call === 2) return { cards: 2, mistakes: 2, notes: 1, dueNotes: [] };
      return { cards: 0, mistakes: 0, notes: 1, dueNotes: [] };
    });

    const onChange = vi.fn();
    const unsub = subscribeTodayLearning(onChange);
    try {
      await vi.waitFor(() => {
        expect(getTodayLearningSnapshot()).toMatchObject({ cards: 5, mistakes: 2, notes: 1 });
      });

      window.dispatchEvent(new CustomEvent(FSRS_DUE_REFRESH_EVENT));
      await vi.waitFor(() => {
        expect(getTodayLearningSnapshot()).toMatchObject({ cards: 2, mistakes: 2, notes: 1 });
      });

      requestFlashcardsDueRefresh();
      await vi.waitFor(() => {
        expect(getTodayLearningSnapshot()).toMatchObject({ cards: 0, mistakes: 0, notes: 1 });
      });

      expect(onChange).toHaveBeenCalledTimes(3);
    } finally {
      unsub();
    }
  });

  it('coalesces a refresh triggered while another refresh is still in flight', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let count = 0;
    loadTodayLearning.mockImplementation(async () => {
      count += 1;
      if (count === 1) {
        await firstPending;
        return { cards: 4, mistakes: 1, notes: 0, dueNotes: [] };
      }
      return { cards: 1, mistakes: 0, notes: 0, dueNotes: [] };
    });

    const p1 = refreshTodayLearning();
    const p2 = refreshTodayLearning();
    releaseFirst();
    await Promise.all([p1, p2]);

    expect(loadTodayLearning).toHaveBeenCalledTimes(2);
    expect(getTodayLearningSnapshot()).toMatchObject({ cards: 1, mistakes: 0, notes: 0 });
  });

  it('refreshes on TODAY_LEARNING_REFRESH_EVENT, DSTU_FOLDER_CHANGE_EVENT, and review-changed Tauri events (BUG-18)', async () => {
    const tauriHandlers = new Map<string, () => void>();
    listen.mockImplementation(async (eventName: string, handler: () => void) => {
      tauriHandlers.set(eventName, handler);
      return () => {
        if (tauriHandlers.get(eventName) === handler) tauriHandlers.delete(eventName);
      };
    });

    let call = 0;
    loadTodayLearning.mockImplementation(async () => {
      call += 1;
      return { cards: 0, mistakes: call, notes: call, dueNotes: [] };
    });

    const unsub = subscribeTodayLearning(() => {});
    try {
      await vi.waitFor(() => expect(getTodayLearningSnapshot().mistakes).toBe(1));

      window.dispatchEvent(new CustomEvent(TODAY_LEARNING_REFRESH_EVENT));
      await vi.waitFor(() => expect(getTodayLearningSnapshot().mistakes).toBe(2));

      window.dispatchEvent(new CustomEvent(DSTU_FOLDER_CHANGE_EVENT));
      await vi.waitFor(() => expect(getTodayLearningSnapshot().mistakes).toBe(3));

      await vi.waitFor(() => expect(tauriHandlers.has('review-changed')).toBe(true));
      expect(tauriHandlers.has('review://changed')).toBe(true);
      expect(tauriHandlers.has('fsrs://changed')).toBe(true);

      tauriHandlers.get('review-changed')!();
      await vi.waitFor(() => expect(getTodayLearningSnapshot().mistakes).toBe(4));

      tauriHandlers.get('review://changed')!();
      await vi.waitFor(() => expect(getTodayLearningSnapshot().mistakes).toBe(5));
    } finally {
      unsub();
    }
  });
});
