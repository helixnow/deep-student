/**
 * 主应用源码看到的时钟。scripts/app-clock-loader.cjs 把主应用源码里的 Date / setTimeout / setInterval 换成这里的实现；
 * 本工程自己的代码和依赖库不受影响。
 *
 * - 日期：主应用里 `new Date()` / `Date.now()` 读的是渲染那一刻的系统时间，同一帧换一天渲染，考期倒计时之类的界面就会变。
 *   这里固定在片中的「今天」（第二幕的早晨，与菜单栏时钟同一天）。
 * - 定时器：每一帧都在新页面里渲染，截帧时刻离挂载过了多久并不固定。一秒及以上的定时（审批倒计时、冲刺计时器、
 *   通知自动消失……）不再触发，界面停在挂载时的读数；一秒以内的照常执行。
 */
const RealDate = Date;
export const FILM_NOW = new RealDate(2026, 9, 3, 7, 30, 0).getTime();

export const FilmDate = function (this: unknown, ...args: unknown[]) {
  if (!new.target) return new RealDate(FILM_NOW).toString();
  return Reflect.construct(RealDate, args.length === 0 ? [FILM_NOW] : args, new.target);
} as unknown as DateConstructor;
Object.defineProperty(FilmDate, 'prototype', { value: RealDate.prototype });
Object.assign(FilmDate, { now: () => FILM_NOW, parse: RealDate.parse, UTC: RealDate.UTC });

const FROZEN_FROM_MS = 1000;
const frozen = (ms?: number) => ms !== undefined && ms >= FROZEN_FROM_MS;

export const filmSetTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
  frozen(ms) ? 0 : setTimeout(handler, ms, ...args)) as typeof setTimeout;
export const filmSetInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
  frozen(ms) ? 0 : setInterval(handler, ms, ...args)) as typeof setInterval;
