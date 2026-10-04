/**
 * 学习时长的纯逻辑（不碰 DOM / IPC，可直接单测）。
 *
 * 移植自 BA7MLV/wangke-agent `src/utils/studyLog.ts`
 * （MIT License, Copyright (c) 2026 BA7MLV）。保留：本地日期键、跨零点切分、
 * 秒数合并、固定阈值热度档位与「在场」判定；去掉了其自带热力图网格与中文文案
 * （DeepStudent 复用现有 LearningHeatmap，文案走 i18n）。
 *
 * MIT License
 *
 * Copyright (c) 2026 BA7MLV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface StudyDay {
  /** 本地日期 `YYYY-MM-DD` */
  date: string;
  /** 秒数 */
  seconds: number;
}

/** 心跳间隔：15 秒 */
export const STUDY_TICK_MS = 15_000;
/**
 * 单次心跳最多计入的时长：设备睡眠 / 节流后醒来的第一次心跳 `now - lastTick`
 * 可能是几小时，那段时间人不在，不能算学习。截断到 2 个心跳周期（30 秒）。
 */
export const STUDY_MAX_TICK_MS = STUDY_TICK_MS * 2;
/** 无输入多久判为离开（播放中的媒体豁免） */
export const STUDY_IDLE_MS = 5 * 60_000;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 时间戳 → 本地日期键 `YYYY-MM-DD`。
 * 不能用 `toISOString().slice(0, 10)`：那是 UTC 日期，东八区凌晨会记到前一天。
 */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 日期键 → 当天本地零点时间戳（`new Date('2026-09-18')` 会按 UTC 解析，不能用） */
export function dateKeyToTs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

/** 日期键加减天数（走本地零点，跨月/跨年/夏令时不漂） */
export function shiftDays(key: string, delta: number): string {
  const d = new Date(dateKeyToTs(key));
  d.setDate(d.getDate() + delta);
  return dateKey(d.getTime());
}

/** 秒数保留 1 位小数 */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 把 `[fromMs, toMs)` 按本地零点切成若干天。
 * 23:59:50 → 00:00:05 的 15 秒：10 秒记今天、5 秒记明天。
 */
export function splitByDay(fromMs: number, toMs: number): StudyDay[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const out: StudyDay[] = [];
  let cursor = fromMs;
  let guard = 0;
  // guard 只是防御：正常输入最多跨 1 天（心跳 ≤ 30s）
  while (cursor < toMs && guard++ < 8) {
    const dayEnd = new Date(cursor);
    dayEnd.setHours(24, 0, 0, 0); // 本地次日零点
    const stop = Math.min(toMs, dayEnd.getTime());
    const seconds = (stop - cursor) / 1000;
    if (seconds > 0) out.push({ date: dateKey(cursor), seconds: round1(seconds) });
    cursor = stop;
  }
  return out;
}

/** 把若干段「某天 N 秒」累加进日期 → 秒数表 */
export function mergeSeconds(into: Map<string, number>, add: StudyDay[]): void {
  for (const d of add) into.set(d.date, round1((into.get(d.date) ?? 0) + d.seconds));
}

/** 此刻是否「在场」：页面可见，且（媒体播放中 或 最近有输入） */
export function isPresent(opts: {
  visible: boolean;
  mediaPlaying: boolean;
  now: number;
  lastActiveAt: number;
  idleMs?: number;
}): boolean {
  if (!opts.visible) return false;
  // 看网课全程不碰键鼠：播放中不做空闲判定
  if (opts.mediaPlaying) return true;
  return opts.now - opts.lastActiveAt < (opts.idleMs ?? STUDY_IDLE_MS);
}

/**
 * 一次心跳应计入的区间：从上次心跳起，但最多回溯 {@link STUDY_MAX_TICK_MS}。
 * 不在场时返回空（调用方仍要推进 lastTick，避免回来时补记空闲段）。
 */
export function tickSlices(lastTick: number, now: number, present: boolean): StudyDay[] {
  if (!present) return [];
  return splitByDay(Math.max(lastTick, now - STUDY_MAX_TICK_MS), now);
}

/**
 * 待上报表 → 本次可上报的整数秒（各日向下取整，零头留待下次），
 * 返回 [上报条目, 剩余零头表]。
 */
export function takeWholeSeconds(
  pending: Map<string, number>,
): [StudyDay[], Map<string, number>] {
  const out: StudyDay[] = [];
  const rest = new Map<string, number>();
  for (const [date, seconds] of pending) {
    const whole = Math.floor(seconds);
    if (whole > 0) out.push({ date, seconds: whole });
    const left = round1(seconds - whole);
    if (left > 0) rest.set(date, left);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return [out, rest];
}

/**
 * 时长热度档位阈值（分钟）：>0 → 1，≥15 → 2，≥45 → 3，≥90 → 4。
 * 用绝对刻度而非相对峰值：每天学 5 分钟的人不该看到满格。
 */
export const HEAT_STEPS_MINUTES = [15, 45, 90] as const;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function studyHeatLevel(seconds: number): HeatLevel {
  if (!(seconds > 0)) return 0;
  const minutes = seconds / 60;
  if (minutes >= HEAT_STEPS_MINUTES[2]) return 4;
  if (minutes >= HEAT_STEPS_MINUTES[1]) return 3;
  if (minutes >= HEAT_STEPS_MINUTES[0]) return 2;
  return 1;
}

/** 秒 → {hours, minutes}（向下取整到分钟），文案由调用方 i18n 拼装 */
export function splitDuration(seconds: number): { hours: number; minutes: number } {
  const totalMinutes = Math.floor(Math.max(0, Math.round(seconds)) / 60);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
