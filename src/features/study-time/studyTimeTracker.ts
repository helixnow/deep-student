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

import {
  STUDY_TICK_MS,
  isPresent,
  mergeSeconds,
  takeWholeSeconds,
  tickSlices,
  type StudyDay,
} from './studyLog';

const FLUSH_EVERY_TICKS = 4;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** 上报完成后派发（热力图等可据此刷新） */
export const STUDY_TIME_FLUSHED_EVENT = 'study-time:flushed';

type Reporter = (day: StudyDay) => Promise<unknown>;

const defaultReporter: Reporter = (day) =>
  invoke('study_time_add', { seconds: day.seconds, date: day.date });

let started = false;
let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let lastActiveAt = 0;
let ticksSinceFlush = 0;
let explicitMediaPlaying = false;
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
    for (const day of batch) {
      try {
        await reporter(day);
      } catch (error: unknown) {
        // 上报失败（库未就绪等）：放回内存下次再试，绝不因记时长影响应用
        mergeSeconds(pending, [day]);
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
  const present = isPresent({
    visible: isVisible(),
    mediaPlaying: isMediaPlaying(),
    now,
    lastActiveAt,
  });
  const slices = tickSlices(lastTick, now, present);
  if (slices.length > 0) {
    mergeSeconds(pending, slices);
    if (++ticksSinceFlush >= FLUSH_EVERY_TICKS) void flushStudyTime();
  }
  // 无论计不计时都推进：否则空闲回来会把整段空闲补记进去
  lastTick = now;
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    // 先把可见期的最后一截记上，再补报（隐藏后定时器会被节流甚至停摆）
    studyTimeTick();
    void flushStudyTime();
  } else {
    lastTick = Date.now();
    markActive();
  }
}

function onPageHide(): void {
  studyTimeTick();
  void flushStudyTime();
}

function onMediaPlay(): void {
  markActive();
}

/** 播放器可显式上报播放态（可选；默认通过 DOM 中的媒体元素自动判定） */
export function setStudyMediaPlaying(playing: boolean): void {
  explicitMediaPlaying = playing;
  if (playing) markActive();
}

/** 启动追踪（应用级挂一次）。返回停止函数。 */
export function startStudyTracking(options: { reporter?: Reporter } = {}): () => void {
  if (started) return stopStudyTracking;
  started = true;
  reporter = options.reporter ?? defaultReporter;
  lastTick = Date.now();
  lastActiveAt = Date.now();
  ticksSinceFlush = 0;
  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, markActive, { passive: true, capture: true });
  }
  // media 事件不冒泡，但可在捕获阶段于 document 上收到
  document.addEventListener('play', onMediaPlay, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  timer = setInterval(() => studyTimeTick(), STUDY_TICK_MS);
  return stopStudyTracking;
}

export function stopStudyTracking(): void {
  if (!started) return;
  started = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  for (const ev of ACTIVITY_EVENTS) {
    window.removeEventListener(ev, markActive, { capture: true });
  }
  document.removeEventListener('play', onMediaPlay, true);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', onPageHide);
  studyTimeTick();
  void flushStudyTime();
  explicitMediaPlaying = false;
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
    flushChain = Promise.resolve();
  },
  markActive(at: number): void {
    lastActiveAt = at;
  },
};
