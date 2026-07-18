/**
 * 制卡任务投射源（P9）
 *
 * 数据源与 `AnkiTasksApp` 一致：`list_document_sessions` invoke。
 * 后端没有前端 store，采用「自适应轮询 + 事件触发即时刷新」：
 * - 有活跃任务时约 5s 对账一次；无任务时约 60s（事件仍即时刷新）；
 * - 通过 eventHub 订阅 `anki_generation_event`（单一 Tauri listener，
 *   与全局完成通知器共享同名事件互不冲突），事件到达即刷新，
 *   保证 Dock 角标在任务启停后 2s 内反映（Dock 侧 2s 轮询 badgeSource）；
 * - 投射源为 badge-only（projectWindows=false）：制卡任务进行中不强行
 *   弹出 taskDashboard 窗口，只亮角标（设计文档 §4.4「可选窗口投射」）。
 */
import { invoke } from '@tauri-apps/api/core';
import { hubListen } from '../../core/eventHub';
import type { ProjectionInstance, ProjectionSource } from '../../core/projection';
import type { AppBadge } from '../../core/types';

interface DocumentSessionLite {
  activeTasks?: number;
  pausedTasks?: number;
}

/** 有活跃任务时的轮询间隔（事件已覆盖即时刷新，轮询作对账） */
const POLL_INTERVAL_ACTIVE_MS = 5_000;
/** 无任务时拉长间隔，避免空转 IPC */
const POLL_INTERVAL_IDLE_MS = 60_000;
const SESSION_LIMIT = 500;
export const ANKI_TASKS_INSTANCE_KEY = 'anki-tasks';

let activeTaskCount = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let disposeEventListener: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
let inflight: Promise<void> | null = null;
let refreshAgain = false;
let watcherRunning = false;
const listeners = new Set<(count: number) => void>();

function setCount(count: number): void {
  if (count === activeTaskCount) return;
  activeTaskCount = count;
  for (const fn of Array.from(listeners)) fn(count);
}

function pollDelayMs(): number {
  return activeTaskCount > 0 ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;
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
    void refreshAnkiTaskCount().finally(() => scheduleNextPoll());
  }, pollDelayMs());
}

/** 立即从后端刷新活跃制卡任务数（并发调用合流到同一次请求；测试可直接调用） */
export function refreshAnkiTaskCount(): Promise<void> {
  if (inflight) {
    refreshAgain = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      refreshAgain = false;
      try {
        const sessions = await invoke<DocumentSessionLite[]>('list_document_sessions', {
          limit: SESSION_LIMIT,
        });
        const count = Array.isArray(sessions)
          ? sessions.reduce((sum, s) => sum + (s.activeTasks ?? 0), 0)
          : 0;
        setCount(count);
      } catch {
        // 非 Tauri 环境 / 后端不可用：保持上次计数
      }
    } while (refreshAgain);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 启动 watcher（幂等）。由投射源 subscribe 时自动调用。 */
export function startAnkiTaskWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;
  disposeEventListener = hubListen('anki_generation_event', () => {
    void refreshAnkiTaskCount().finally(() => {
      // 事件后按当前计数重排下一轮对账间隔
      if (watcherRunning) scheduleNextPoll();
    });
  });
  // SSR / 测试环境无 document：不装监听器，仅保留轮询
  if (typeof document !== 'undefined' && visibilityHandler == null) {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        void refreshAnkiTaskCount().finally(() => scheduleNextPoll());
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
  void refreshAnkiTaskCount().finally(() => scheduleNextPoll());
}

export function stopAnkiTaskWatcher(): void {
  watcherRunning = false;
  clearPollTimer();
  disposeEventListener?.();
  disposeEventListener = null;
  if (visibilityHandler != null && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
}

export function getActiveAnkiTaskCount(): number {
  return activeTaskCount;
}

/**
 * 订阅活跃制卡任务数变化（O18：TaskDashboard 窗口标题/活动条消费）。
 * 与投射源共用同一 listeners 集合与 watcher 生命周期：
 * 有任意订阅者即保证 watcher 运行，全部退订后自动停止。
 * 可直接作为 useSyncExternalStore 的 subscribe 使用。
 */
export function subscribeAnkiTaskCount(listener: (count: number) => void): () => void {
  listeners.add(listener);
  startAnkiTaskWatcher();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopAnkiTaskWatcher();
  };
}

function currentInstances(): ProjectionInstance[] {
  if (activeTaskCount <= 0) return [];
  return [{ instanceKey: ANKI_TASKS_INSTANCE_KEY, title: '' }];
}

/**
 * badge-only 投射源：subscribe 即启动 watcher，注销即停止。
 * 实例集合（0/1 个）反映「是否有制卡任务进行中」，供诊断与未来可选投窗使用。
 */
export const ankiTaskProjectionSource: ProjectionSource = {
  projectWindows: false,
  subscribe(notify) {
    const emit = () => notify(currentInstances());
    listeners.add(emit);
    startAnkiTaskWatcher();
    emit();
    return () => {
      listeners.delete(emit);
      if (listeners.size === 0) stopAnkiTaskWatcher();
    };
  },
};

/** Dock 角标源：活跃制卡任务数量（0 = 无角标） */
export function ankiTaskBadgeSource(): AppBadge | null {
  return activeTaskCount > 0 ? { kind: 'count', value: activeTaskCount } : null;
}
