/**
 * 「今日学习」的可订阅快照：工作台 AI 仪表盘 / 桌面简报与首页共用 loadTodayLearning 口径。
 * 有订阅者才轮询（笔记复习需列出笔记，间隔放宽到 5 分钟），窗口回到前台即刷新。
 */
import { loadTodayLearning, type TodayLearning } from './todayLearning';

const POLL_INTERVAL_MS = 5 * 60_000;
const EMPTY: TodayLearning = { cards: 0, mistakes: 0, notes: 0, dueNotes: [] };

let snapshot: TodayLearning = EMPTY;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let onVisible: (() => void) | null = null;
const listeners = new Set<() => void>();

export function getTodayLearningSnapshot(): TodayLearning {
  return snapshot;
}

export function refreshTodayLearning(): Promise<void> {
  if (inflight) return inflight;
  inflight = loadTodayLearning()
    .then((next) => {
      if (
        next.cards === snapshot.cards && next.mistakes === snapshot.mistakes && next.notes === snapshot.notes
        && next.cardsTotal === snapshot.cardsTotal && next.plansTotal === snapshot.plansTotal
      ) return;
      snapshot = next;
      for (const fn of Array.from(listeners)) fn();
    })
    .catch(() => { /* 保持上次快照 */ })
    .finally(() => { inflight = null; });
  return inflight;
}

function start(): void {
  if (timer != null) return;
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshTodayLearning();
  }, POLL_INTERVAL_MS);
  if (typeof document !== 'undefined') {
    onVisible = () => { if (document.visibilityState === 'visible') void refreshTodayLearning(); };
    document.addEventListener('visibilitychange', onVisible);
  }
  void refreshTodayLearning();
}

function stop(): void {
  if (timer != null) clearInterval(timer);
  timer = null;
  if (onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  onVisible = null;
}

export function subscribeTodayLearning(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}
