/**
 * 「今日学习」的可订阅快照：工作台 AI 仪表盘 / 桌面简报与首页共用 loadTodayLearning 口径。
 * 有订阅者才轮询（笔记复习需列出笔记，间隔放宽到 5 分钟），窗口回到前台或 FSRS / 冲刺写回事件到达时立即刷新。
 */
import { listen } from '@tauri-apps/api/event';
import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
import { addTypedEventListener } from '@/events';
import {
  FLASHCARDS_CHANGED_EVENT,
  FSRS_LIBRARY_REFRESH_EVENT,
  FSRS_STATS_REFRESH_EVENT,
  subscribeFlashcardsDueRefresh,
} from '@/events/flashcards';
import { loadTodayLearning, type TodayLearning } from './todayLearning';

const POLL_INTERVAL_MS = 5 * 60_000;
const FSRS_CHANGED_TAURI_EVENT = 'fsrs://changed';
const REVIEW_CHANGED_TAURI_EVENT = 'review://changed';
const LEGACY_REVIEW_CHANGED_TAURI_EVENT = 'review-changed';
const TAURI_REFRESH_EVENTS = [
  FSRS_CHANGED_TAURI_EVENT,
  REVIEW_CHANGED_TAURI_EVENT,
  LEGACY_REVIEW_CHANGED_TAURI_EVENT,
] as const;
export const FSRS_DUE_REFRESH_EVENT = 'fsrs:due-refresh';
export const TODAY_LEARNING_REFRESH_EVENT = 'learning-today:refresh';
const WINDOW_REFRESH_EVENTS = [
  FSRS_DUE_REFRESH_EVENT,
  FSRS_STATS_REFRESH_EVENT,
  FSRS_LIBRARY_REFRESH_EVENT,
  FLASHCARDS_CHANGED_EVENT,
  TODAY_LEARNING_REFRESH_EVENT,
  DSTU_FOLDER_CHANGE_EVENT,
] as const;

const EMPTY: TodayLearning = { cards: 0, mistakes: 0, notes: 0, dueNotes: [] };

let snapshot: TodayLearning = EMPTY;
let inflight: Promise<void> | null = null;
let refreshAgain = false;
let timer: ReturnType<typeof setInterval> | null = null;
let disposeVisible: (() => void) | null = null;
let disposeRefreshEvents: Array<() => void> = [];
let unsubDueRefresh: (() => void) | null = null;
let unlistenTauriEvents: Array<() => void> = [];
let watcherDisposed = false;
const listeners = new Set<() => void>();

export function getTodayLearningSnapshot(): TodayLearning {
  return snapshot;
}

export function refreshTodayLearning(): Promise<void> {
  if (inflight) {
    refreshAgain = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      refreshAgain = false;
      try {
        const next = await loadTodayLearning();
        if (
          next.cards === snapshot.cards && next.mistakes === snapshot.mistakes && next.notes === snapshot.notes
          && next.cardsTotal === snapshot.cardsTotal && next.plansTotal === snapshot.plansTotal
        ) continue;
        snapshot = next;
        for (const fn of Array.from(listeners)) fn();
      } catch {
        /* 保持上次快照 */
      }
    } while (refreshAgain);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function start(): void {
  if (timer != null) return;
  watcherDisposed = false;
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshTodayLearning();
  }, POLL_INTERVAL_MS);
  disposeVisible = addTypedEventListener(
    'visibilitychange',
    () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refreshTodayLearning();
      }
    },
    undefined,
    'document',
  );
  const triggerRefresh = () => {
    void refreshTodayLearning();
  };
  unsubDueRefresh = subscribeFlashcardsDueRefresh(triggerRefresh);
  disposeRefreshEvents = WINDOW_REFRESH_EVENTS.map((eventName) =>
    addTypedEventListener(eventName, triggerRefresh),
  );
  unlistenTauriEvents = [];
  for (const eventName of TAURI_REFRESH_EVENTS) {
    try {
      void listen(eventName, () => {
        if (!watcherDisposed) void refreshTodayLearning();
      })
        .then((unlisten) => {
          if (watcherDisposed) unlisten();
          else unlistenTauriEvents.push(unlisten);
        })
        .catch(() => { /* 非 Tauri / 测试环境无事件桥 */ });
    } catch {
      /* 非 Tauri / 测试环境 */
    }
  }
  void refreshTodayLearning();
}

function stop(): void {
  watcherDisposed = true;
  if (timer != null) clearInterval(timer);
  timer = null;
  disposeVisible?.();
  disposeVisible = null;
  for (const dispose of disposeRefreshEvents) dispose();
  disposeRefreshEvents = [];
  unsubDueRefresh?.();
  unsubDueRefresh = null;
  for (const unlisten of unlistenTauriEvents) unlisten();
  unlistenTauriEvents = [];
}

export function subscribeTodayLearning(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}
