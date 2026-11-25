/**
 * 学习时长追踪器（docs/dev/media-learning/README.md §3「学习时长」）。
 *
 * 语义：页面可见 + 人在场才计时。
 * - 切后台 / 锁屏 / 最小化：`visibilityState !== 'visible'` 不计；
 * - 页面开着人走开：5 分钟无输入不计；**媒体播放中不做空闲判定**（看网课不碰键鼠）。
 *   播放态直接看文档里的 <audio>/<video>，无需播放器上报。
 *
 * 记账：15 秒心跳，单次 ≤ 30 秒（睡眠唤醒不补记），按本地零点切分；内存攒 4 次心跳
 * （1 分钟）上报一次整数秒，页面隐藏 / pagehide 时补报。上报失败留在内存下次再试。
 *
 * 设计借鉴 BA7MLV/wangke-agent `src/store/studyTime.ts`（MIT, Copyright (c) 2026 BA7MLV）。
 */

import { invoke } from '@tauri-apps/api/core';
import { addTypedEventListener } from '@/events';
import { useViewStore } from '@/stores/viewStore';
import type { CurrentView } from '@/types/navigation';

import {
  STUDY_TICK_MS,
  dateKey,
  isPresent,
  mergeSeconds,
  takeWholeSeconds,
  tickSlices,
  type StudyDay,
} from './studyLog';
import {
  StudyTimeTracker as RealtimeStudyTimeTracker,
  formatLocalDateKey,
} from '@/utils/studyTimeTrackerAndHeatmap';

const FLUSH_EVERY_TICKS = 4;
// study_time_add 的单次上限；失败积压恢复后也必须遵守。
const MAX_REPORT_SECONDS = 3600;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * 传统壳 / 移动端下属于真实学习活动的视图白名单（S4-11）：
 * 排除 settings / dashboard / data-management / task-dashboard / template-management /
 * skills-management / todo / ui-lab 等配置、统计与管理界面，防止仅浏览设置或切换预设时虚增学习时长。
 */
const LEGACY_STUDY_VIEWS: ReadonlySet<CurrentView> = new Set<CurrentView>([
  'chat-v2',
  'flashcards',
  'pdf-reader',
  'learning-hub',
  'media',
  'sandbox-workbench',
]);

const NON_STUDY_WB_WINDOW_SELECTOR = [
  '[data-wb-sys-app="settings"]',
  '[data-wb-sys-app="aiDashboard"]',
  '[data-wb-sys-app="taskDashboard"]',
  '[data-wb-sys-app="skills"]',
  '[data-wb-sys-app="templates"]',
  '[data-wb-sys-app="todo"]',
  '[data-wb-sys-app="pomodoro"]',
  '[data-wb-sys-app="pluginWorkshop"]',
  '[data-testid="workshop-app"]',
  '[data-wb-files-host]',
  '[data-wb-frozen-placeholder]',
  '[data-wb-loading]',
].join(',');

const STUDY_WB_WINDOW_SELECTOR = [
  '[data-wb-sys-app="flashcards"]',
  '[data-wb-sys-app="media"]',
  '[data-wb-notes-workspace]',
  '[data-wb-mindmap-host]',
  '[data-file-preview-root]',
  '[data-wb-content-host]',
  '[data-wb-sandbox-app]',
  '[data-wb-chat-app]',
].join(',');

function isWorkbenchStudyWindow(winEl: Element): boolean {
  if (winEl.querySelector(NON_STUDY_WB_WINDOW_SELECTOR)) return false;
  if (winEl.querySelector('[data-wb-notes-workspace]')) {
    // 笔记窗口切到纯文件浏览子屏时不计学习时长
    return !winEl.querySelector('[data-notes-files-subscreen]');
  }
  if (winEl.querySelector('.wb-resource-workspace')) {
    // 试卷 / 作文 / 翻译工作区：仅在已打开具体资源（非空态占位）时计入学习时长
    return !winEl.querySelector('.wb-resource-workspace-empty');
  }
  if (winEl.querySelector('[data-wb-browser-app]')) {
    return !winEl.querySelector('[data-wb-browser-empty]');
  }
  return Boolean(winEl.querySelector(STUDY_WB_WINDOW_SELECTOR));
}

/**
 * 判定当前界面（及可选输入事件目标）是否处于真实学习交互表面（S4-11）。
 * - 显式连续学习信号（番茄工作计时 / 音视频播放）在调用方单独豁免；
 * - 学习桌面（Workbench）：必须存在聚焦且未最小化的学习窗口，空桌面、Dock、顶栏、应用启动器、
 *   以及设置 / 仪表盘 / 待办 / 技能 / 模板 / 文件浏览等管理窗口一律返回 false；
 * - 传统壳 / 移动端：按 useViewStore.currentView 白名单门控，排除 settings 等非学习页。
 */
export function isStudySurfaceActive(eventTarget?: EventTarget | null): boolean {
  if (typeof document === 'undefined') return true;

  // 全屏冲刺复习 / 桌面空格快速预览阅读属于明确的学习行为
  if (
    document.querySelector(
      '[data-testid="unified-daily-sprint-player"], [data-wb-quick-look]',
    )
  ) {
    return true;
  }

  // 全局启动器 / Exposé / 窗口切换器打开期间属于系统导航，不计学习
  if (
    document.querySelector(
      '[data-wb-apps-open="true"], [data-wb-expose-root], [data-wb-switcher-root]',
    )
  ) {
    return false;
  }

  const targetEl = eventTarget instanceof Element ? eventTarget : null;
  if (
    targetEl?.closest(
      `${NON_STUDY_WB_WINDOW_SELECTOR}, [data-testid="wb-dock"], [data-wb-menubar], [data-wb-desk-menu]`,
    )
  ) {
    return false;
  }

  const wbRoot = document.querySelector('[data-wb-workbench-root]');
  if (wbRoot) {
    const focusedWin = document.querySelector<HTMLElement>(
      '[data-wb-window][data-focused]:not([data-minimized="true"])',
    );
    if (!focusedWin) return false;
    if (
      targetEl &&
      !focusedWin.contains(targetEl) &&
      !targetEl.closest('[data-radix-popper-content-wrapper], [role="listbox"], [role="menu"]')
    ) {
      return false;
    }
    return isWorkbenchStudyWindow(focusedWin);
  }

  // 传统壳内若打开了显式设置容器也不计入学习时长
  if (document.querySelector('[data-wb-sys-app="settings"]')) {
    return false;
  }

  return LEGACY_STUDY_VIEWS.has(useViewStore.getState().currentView);
}

/** 上报完成后派发（热力图等可据此刷新） */
export const STUDY_TIME_FLUSHED_EVENT = 'study-time:flushed';
/** 专注态（如番茄钟工作计时）变更事件（避免跨 feature 深依赖） */
export const STUDY_FOCUS_ACTIVE_EVENT = 'study-time:focus-active';

type Reporter = (day: StudyDay) => Promise<unknown>;

const defaultReporter: Reporter = (day) =>
  invoke('study_time_add', { seconds: day.seconds, date: day.date });

let started = false;
let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let lastActiveAt = 0;
let ticksSinceFlush = 0;
let explicitMediaPlaying = false;
let explicitFocusActive = false;
let wasVisible = false;
let pending = new Map<string, number>();
let flushChain: Promise<void> = Promise.resolve();
let reporter: Reporter = defaultReporter;

function markActive(): void {
  lastActiveAt = Date.now();
}

function isMediaPlaying(): boolean {
  if (explicitMediaPlaying) return true;
  if (typeof document === 'undefined') return false;
  const media = document.querySelectorAll<HTMLMediaElement>('video, audio');
  for (const el of Array.from(media)) {
    if (!el.paused && !el.ended) return true;
  }
  return false;
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** 把攒下的整数秒上报；成功的部分才从内存扣除 */
export function flushStudyTime(): Promise<void> {
  flushChain = flushChain.then(async () => {
    const [batch, rest] = takeWholeSeconds(pending);
    if (batch.length === 0) return;
    pending = rest;
    for (const [index, day] of batch.entries()) {
      let remaining = day.seconds;
      try {
        while (remaining > 0) {
          const seconds = Math.min(remaining, MAX_REPORT_SECONDS);
          await reporter({ date: day.date, seconds });
          remaining -= seconds;
        }
      } catch (error: unknown) {
        // 上报失败（库未就绪等）：放回内存下次再试，绝不因记时长影响应用
        mergeSeconds(pending, [{ date: day.date, seconds: remaining }, ...batch.slice(index + 1)]);
        console.warn('[StudyTime] report failed, will retry:', error);
        return;
      }
    }
    ticksSinceFlush = 0;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(STUDY_TIME_FLUSHED_EVENT, { detail: batch }));
    }
  });
  return flushChain;
}

/** 一次心跳（导出供测试驱动） */
export function studyTimeTick(now: number = Date.now()): void {
  recordStudyTimeTick(now, isVisible());
}

function recordStudyTimeTick(now: number, visible: boolean): void {
  const continuousStudy = isMediaPlaying() || explicitFocusActive;
  const engaged = continuousStudy || isStudySurfaceActive();
  const present =
    engaged &&
    isPresent({
      visible,
      mediaPlaying: continuousStudy,
      now,
      lastActiveAt,
    });
  const slices = tickSlices(lastTick, now, present);
  if (slices.length > 0) {
    mergeSeconds(pending, slices);
    if (++ticksSinceFlush >= FLUSH_EVERY_TICKS) void flushStudyTime();
  }
  // 无论计不计时都推进：否则空闲或处于设置页回来会把非学习段补记进去
  lastTick = now;
}

function onVisibilityChange(): void {
  const visible = isVisible();
  if (!visible) {
    // 先把可见期的最后一截记上，再补报（隐藏后定时器会被节流甚至停摆）
    recordStudyTimeTick(Date.now(), wasVisible);
    void flushStudyTime();
  } else {
    lastTick = Date.now();
    if (isStudySurfaceActive()) markActive();
  }
  wasVisible = visible;
}

function onPageHide(): void {
  studyTimeTick();
  void flushStudyTime();
}

function onMediaPlay(): void {
  markActive();
}

function onStudyFocusChange(event: Event): void {
  const detail = (event as CustomEvent<{ active?: unknown }>).detail;
  setStudyFocusActive(Boolean(detail?.active));
}

/** 播放器可显式上报播放态（可选；默认通过 DOM 中的媒体元素自动判定） */
export function setStudyMediaPlaying(playing: boolean): void {
  explicitMediaPlaying = playing;
  if (playing) markActive();
}

/** 番茄钟工作专注态等可显式开启空闲豁免（仅页面可见时生效，绝不单独累加额外时长） */
export function setStudyFocusActive(active: boolean): void {
  explicitFocusActive = active;
  if (active) markActive();
}

let studyTrackingCleanups: Array<() => void> = [];

/** 启动追踪（应用级挂一次）。返回停止函数。 */
export function startStudyTracking(options: { reporter?: Reporter } = {}): () => void {
  if (started) return stopStudyTracking;
  started = true;
  reporter = options.reporter ?? defaultReporter;
  lastTick = Date.now();
  // S4-11：冷启动不预置活跃态，必须等待真实学习界面交互或番茄专注/媒体播放才开始累计
  lastActiveAt = 0;
  wasVisible = isVisible();
  ticksSinceFlush = 0;
  explicitFocusActive =
    typeof globalThis !== 'undefined' &&
    Boolean((globalThis as Record<string, unknown>).__dstuStudyFocusActive);
  if (explicitFocusActive) markActive();
  studyTrackingCleanups = [
    ...ACTIVITY_EVENTS.map((ev) =>
      addTypedEventListener(
        ev,
        (_d, event) => {
          if (isStudySurfaceActive(event?.target)) markActive();
        },
        { passive: true, capture: true },
      ),
    ),
    addTypedEventListener(STUDY_FOCUS_ACTIVE_EVENT, (_d, event) => onStudyFocusChange(event)),
    // media 事件不冒泡，但可在捕获阶段于 document 上收到
    addTypedEventListener('play', () => onMediaPlay(), true, 'document'),
    addTypedEventListener('visibilitychange', () => onVisibilityChange(), undefined, 'document'),
    addTypedEventListener('pagehide', () => onPageHide()),
  ];
  timer = setInterval(() => studyTimeTick(), STUDY_TICK_MS);
  return stopStudyTracking;
}

export function stopStudyTracking(): void {
  if (!started) return;
  started = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  for (const cleanup of studyTrackingCleanups) {
    cleanup();
  }
  studyTrackingCleanups = [];
  studyTimeTick();
  void flushStudyTime();
  explicitMediaPlaying = false;
  explicitFocusActive = false;
}

/** 读取当日或指定本地日期尚未上报的内存累计秒数 */
export function getRealtimePendingStudySeconds(
  targetDate: string = formatLocalDateKey(Date.now()),
): number {
  return pending.get(targetDate) ?? pending.get(dateKey(Date.now())) ?? 0;
}

/** 创建带独立持久化回调的 StudyTimeTracker 实例 */
export function createScopedStudyTimeTracker(
  persistedDays: readonly StudyDay[] = [],
  customReporter: Reporter = reporter,
): RealtimeStudyTimeTracker {
  return new RealtimeStudyTimeTracker({
    persistedDays,
    persist: async (deltas) => {
      for (const day of deltas) {
        const whole = Math.floor(day.seconds);
        if (whole > 0) {
          await customReporter({ date: day.date, seconds: whole });
        }
      }
    },
  });
}

/** 仅测试用：读取 / 重置内存状态 */
export const __studyTimeTestHooks = {
  pending: () => new Map(pending),
  reset(now: number = Date.now()): void {
    pending = new Map();
    lastTick = now;
    lastActiveAt = now;
    ticksSinceFlush = 0;
    explicitMediaPlaying = false;
    explicitFocusActive = false;
    if (typeof globalThis !== 'undefined') {
      (globalThis as Record<string, unknown>).__dstuStudyFocusActive = false;
    }
    flushChain = Promise.resolve();
  },
  markActive(at: number): void {
    lastActiveAt = at;
  },
};
