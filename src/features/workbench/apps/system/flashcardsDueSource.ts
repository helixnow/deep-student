/**
 * 闪卡到期投射源（M3）
 *
 * 结构对标 `ankiTaskSource.ts`：轮询 `fsrs_get_due`，有订阅者才跑 watcher。
 * 投射源为 badge-only（projectWindows=false），驱动 Dock 角标。
 */
import { invoke } from '@tauri-apps/api/core';
import type { ProjectionInstance, ProjectionSource } from '../../core/projection';
import type { AppBadge } from '../../core/types';

/** 有到期卡时的对账间隔 */
const POLL_INTERVAL_ACTIVE_MS = 30_000;
/** 无到期时拉长，降低空转 IPC */
const POLL_INTERVAL_IDLE_MS = 120_000;
/** 与 fsrsReviewStore.fetchDueFromBackend 一致 */
const DUE_LIMIT = 50;

export const FLASHCARDS_DUE_INSTANCE_KEY = 'flashcards-due';

let dueCount = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityHandler: (() => void) | null = null;
let inflight: Promise<void> | null = null;
let refreshAgain = false;
let watcherRunning = false;
const listeners = new Set<(count: number) => void>();

function setCount(count: number): void {
  if (count === dueCount) return;
  dueCount = count;
  for (const fn of Array.from(listeners)) fn(count);
}

function pollDelayMs(): number {
  return dueCount > 0 ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;
}

function clearPollTimer(): void {
  if (pollTimer != null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(): void {
  if (!watcherRunning) return;
  clearPollTimer();
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (!watcherRunning) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      scheduleNextPoll();
      return;
    }
    void refreshFlashcardsDueCount().finally(() => scheduleNextPoll());
  }, pollDelayMs());
}

/**
 * 立即从后端刷新到期闪卡数（并发调用合流到同一次请求；测试可直接调用）。
 * 解析对齐 `fsrsReviewStore.fetchDueFromBackend`：数组长度 = dueCount；
 * 失败 / 非数组保持上次计数，不抛到 UI。
 */
export function refreshFlashcardsDueCount(): Promise<void> {
  if (inflight) {
    refreshAgain = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      refreshAgain = false;
      try {
        const result = await invoke<unknown>('fsrs_get_due', { limit: DUE_LIMIT });
        if (Array.isArray(result)) {
          setCount(result.length);
        }
        // 非数组：保持上次计数
      } catch {
        // 非 Tauri 环境 / 后端不可用：保持上次计数
      }
    } while (refreshAgain);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 启动 watcher（幂等）。由投射源 / 计数订阅 subscribe 时自动调用。 */
export function startFlashcardsDueWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;
  // SSR / 测试环境无 document：不装监听器，仅保留轮询
  if (typeof document !== 'undefined' && visibilityHandler == null) {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        void refreshFlashcardsDueCount().finally(() => scheduleNextPoll());
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
  void refreshFlashcardsDueCount().finally(() => scheduleNextPoll());
}

export function stopFlashcardsDueWatcher(): void {
  watcherRunning = false;
  clearPollTimer();
  if (visibilityHandler != null && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
}

export function getFlashcardsDueCount(): number {
  return dueCount;
}

/**
 * 订阅到期闪卡数变化。
 * 与投射源共用同一 listeners 集合与 watcher 生命周期：
 * 有任意订阅者即保证 watcher 运行，全部退订后自动停止。
 */
export function subscribeFlashcardsDueCount(listener: (count: number) => void): () => void {
  listeners.add(listener);
  startFlashcardsDueWatcher();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopFlashcardsDueWatcher();
  };
}

function currentInstances(): ProjectionInstance[] {
  if (dueCount <= 0) return [];
  return [{ instanceKey: FLASHCARDS_DUE_INSTANCE_KEY, title: '' }];
}

/** badge-only 投射源：subscribe 即启动 watcher，注销即停止。 */
export const flashcardsDueProjectionSource: ProjectionSource = {
  projectWindows: false,
  subscribe(notify) {
    const emit = () => notify(currentInstances());
    listeners.add(emit);
    startFlashcardsDueWatcher();
    emit();
    return () => {
      listeners.delete(emit);
      if (listeners.size === 0) stopFlashcardsDueWatcher();
    };
  },
};

/** Dock 角标源：到期闪卡数量（0 = 无角标） */
export function flashcardsDueBadgeSource(): AppBadge | null {
  return dueCount > 0 ? { kind: 'count', value: dueCount } : null;
}
