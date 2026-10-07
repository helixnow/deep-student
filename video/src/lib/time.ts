import { Easing, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const FPS = 60;
/**
 * 成片节奏：1 秒脚本时间 = PACE 秒成片时间。
 * 场景/相机/字幕里写的秒数都是「脚本时间」（30s 剧本），成片按 PACE 放慢（2:46）。
 * 产品弹簧（springAt）按真实时间求值，保持与应用一致的手感。
 */
export const PACE = 2;
export const SCRIPT_S = 83;
export const DURATION_S = SCRIPT_S * PACE;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  brand: Easing.bezier(0.22, 1, 0.36, 1),
  wbOut: Easing.bezier(0.16, 1, 0.3, 1),
  overshoot: Easing.bezier(0.34, 1.56, 0.64, 1),
  outCubic: Easing.bezier(0.33, 1, 0.68, 1),
  inOutCubic: Easing.bezier(0.65, 0, 0.35, 1),
  inCubic: Easing.bezier(0.32, 0, 0.67, 0),
  inOutQuint: Easing.bezier(0.83, 0, 0.17, 1),
  outExpo: Easing.bezier(0.16, 1, 0.3, 1),
  inExpo: Easing.bezier(0.7, 0, 0.84, 0),
} satisfies Record<string, Ease>;

export const useTime = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame / fps / PACE;
};

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export const prog = (t: number, start: number, end: number, e: Ease = ease.linear) =>
  e(clamp((t - start) / Math.max(1e-6, end - start)));

export const between = (t: number, start: number, end: number) => t >= start && t < end;

export type Key = [time: number, value: number, easeIn?: Ease];

/** 分段关键帧插值：每段使用「到达点」上声明的缓动。 */
export const keys = (t: number, frames: Key[]): number => {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1, e = ease.inOutCubic] = frames[i];
    const [t0, v0] = frames[i - 1];
    if (t <= t1) return lerp(v0, v1, e(clamp((t - t0) / Math.max(1e-6, t1 - t0))));
  }
  return frames[frames.length - 1][1];
};

export type SpringCfg = { stiffness: number; damping: number; mass?: number };

/** 与 framer-motion 同参的物理弹簧（产品 motion-springs 预设可直接传入）。 */
export const springAt = (t: number, start: number, cfg: SpringCfg) =>
  t < start
    ? 0
    : spring({
        frame: (t - start) * PACE * FPS,
        fps: FPS,
        config: { stiffness: cfg.stiffness, damping: cfg.damping, mass: cfg.mass ?? 1 },
      });

export const fadeWindow = (t: number, a: number, b: number, fadeIn = 0.2, fadeOut = 0.2) =>
  Math.min(prog(t, a, a + fadeIn), 1 - prog(t, b - fadeOut, b));

/** 确定性伪随机（逐帧渲染必须可复现）。 */
export const rand = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
