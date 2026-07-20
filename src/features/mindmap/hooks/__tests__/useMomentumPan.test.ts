/**
 * useMomentumPan — 惯性平移速度估算与限幅（纯函数部分）
 */
import { describe, expect, it } from 'vitest';
import {
  MOMENTUM_MAX_SPEED,
  MOMENTUM_MIN_LAUNCH_SPEED,
  MOMENTUM_SAMPLE_WINDOW_MS,
  clampSpeed,
  estimatePanVelocity,
  type PanSample,
} from '../useMomentumPan';

const sample = (time: number, x: number, y: number): PanSample => ({ time, x, y });

describe('estimatePanVelocity', () => {
  it('用窗口内首尾差分估算速度（px/ms）', () => {
    const samples = [
      sample(0, 0, 0),
      sample(50, 25, -10),
      sample(100, 50, -20),
    ];
    const v = estimatePanVelocity(samples, 100);
    expect(v).not.toBeNull();
    expect(v!.vx).toBeCloseTo(0.5, 5);
    expect(v!.vy).toBeCloseTo(-0.2, 5);
  });

  it('只统计采样窗口内的样本（丢弃停顿前的旧轨迹）', () => {
    // 早期快速移动，之后停在原地：松手速度应接近 0
    const now = 1000;
    const samples = [
      sample(now - 500, 0, 0),
      sample(now - 400, 400, 0),
      sample(now - 60, 400, 0),
      sample(now, 400, 0),
    ];
    const v = estimatePanVelocity(samples, now);
    expect(v).not.toBeNull();
    expect(Math.hypot(v!.vx, v!.vy)).toBeLessThan(MOMENTUM_MIN_LAUNCH_SPEED);
  });

  it('样本不足或时间跨度过小返回 null', () => {
    expect(estimatePanVelocity([], 100)).toBeNull();
    expect(estimatePanVelocity([sample(100, 0, 0)], 100)).toBeNull();
    // 两个几乎同时的样本：dt < 8ms
    expect(
      estimatePanVelocity([sample(96, 0, 0), sample(100, 50, 0)], 100),
    ).toBeNull();
  });

  it('窗口常量契约', () => {
    expect(MOMENTUM_SAMPLE_WINDOW_MS).toBe(100);
  });
});

describe('clampSpeed', () => {
  it('模长不超上限时原样返回', () => {
    expect(clampSpeed(0.5, -0.5)).toEqual({ vx: 0.5, vy: -0.5 });
  });

  it('超上限时按比例缩放、方向不变', () => {
    const clamped = clampSpeed(30, 40); // speed 50
    const speed = Math.hypot(clamped.vx, clamped.vy);
    expect(speed).toBeCloseTo(MOMENTUM_MAX_SPEED, 5);
    // 方向保持 3:4
    expect(clamped.vx / clamped.vy).toBeCloseTo(30 / 40, 5);
  });

  it('零速度不产生 NaN', () => {
    expect(clampSpeed(0, 0)).toEqual({ vx: 0, vy: 0 });
  });
});
