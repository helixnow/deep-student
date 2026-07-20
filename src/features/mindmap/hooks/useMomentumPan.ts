/**
 * 惯性平移（momentum pan）：空白拖拽平移松手后按初速度减速滑行，
 * 对齐 XMind / MindNode / 原生触控的「甩动」手感。
 *
 * 设计约束：
 * - 只在指针拖拽平移（mouse/touch）松手时启动；滚轮平移（WheelEvent）
 *   交给系统自带惯性，不叠加，避免双重惯性
 * - 程序化 setViewport（fitView / setCenter / 恢复视口）触发的 onMove
 *   event 为 null，不采样也不启动
 * - 新手势开始（onMoveStart / 指针按下 / 滚轮）立即取消滑行
 * - prefers-reduced-motion：完全禁用
 * - 指数衰减（时间常数 ~ MOMENTUM_FRICTION_TAU），速度低于阈值即停
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface MomentumViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface MomentumPanAdapter {
  getViewport: () => MomentumViewport;
  setViewport: (
    viewport: MomentumViewport,
    options?: { duration?: number },
  ) => unknown;
}

export interface MomentumPanHandlers {
  /** 接到 ReactFlow onMoveStart */
  onMoveStart: (event: unknown, viewport: MomentumViewport) => void;
  /** 接到 ReactFlow onMove */
  onMove: (event: unknown, viewport: MomentumViewport) => void;
  /** 接到 ReactFlow onMoveEnd */
  onMoveEnd: (event: unknown, viewport: MomentumViewport) => void;
  /** 任何新交互（指针按下 / 滚轮）时取消滑行 */
  cancelMomentum: () => void;
}

export interface UseMomentumPanOptions {
  /** false 时手势照常记录但永不启动滑行（如背诵/导出模式） */
  enabled?: boolean;
}

/** 速度采样窗口（ms）：只用松手前这段时间内的位移估算初速度 */
export const MOMENTUM_SAMPLE_WINDOW_MS = 100;
/** 启动阈值（px/ms）：低于该速度松手视为精确摆放，不滑行 */
export const MOMENTUM_MIN_LAUNCH_SPEED = 0.4;
/** 初速度上限（px/ms）：防止极端采样噪声把画布甩飞 */
export const MOMENTUM_MAX_SPEED = 3.5;
/** 停止阈值（px/ms）：衰减到该速度以下即结束 */
export const MOMENTUM_MIN_STOP_SPEED = 0.02;
/** 指数衰减时间常数（ms）：v(t) = v0 · e^(−t/τ)，越大滑得越远 */
export const MOMENTUM_FRICTION_TAU = 260;

export interface PanSample {
  time: number;
  x: number;
  y: number;
}

/**
 * 由采样序列估算松手速度（px/ms）。
 * 只取窗口内首尾两点差分：对 rAF 派发的 move 事件足够稳定，
 * 且天然平滑单帧抖动。样本不足或时间跨度过小返回 null。
 */
export function estimatePanVelocity(
  samples: readonly PanSample[],
  now: number,
  windowMs = MOMENTUM_SAMPLE_WINDOW_MS,
): { vx: number; vy: number } | null {
  const cutoff = now - windowMs;
  const recent = samples.filter((s) => s.time >= cutoff);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.time - first.time;
  if (dt < 8) return null;
  return {
    vx: (last.x - first.x) / dt,
    vy: (last.y - first.y) / dt,
  };
}

/** 限制速度矢量模长，方向不变 */
export function clampSpeed(
  vx: number,
  vy: number,
  maxSpeed = MOMENTUM_MAX_SPEED,
): { vx: number; vy: number } {
  const speed = Math.hypot(vx, vy);
  if (speed <= maxSpeed || speed === 0) return { vx, vy };
  const k = maxSpeed / speed;
  return { vx: vx * k, vy: vy * k };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 是否是应当参与惯性的指针手势事件（排除滚轮与程序化 null） */
function isPointerGestureEvent(event: unknown): boolean {
  if (!event) return false;
  if (typeof WheelEvent !== 'undefined' && event instanceof WheelEvent) {
    return false;
  }
  if (typeof MouseEvent !== 'undefined' && event instanceof MouseEvent) {
    return true;
  }
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    return true;
  }
  return false;
}

export function useMomentumPan(
  adapter: MomentumPanAdapter,
  options: UseMomentumPanOptions = {},
): MomentumPanHandlers {
  const { enabled = true } = options;

  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const samplesRef = useRef<PanSample[]>([]);
  const trackingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const velocityRef = useRef({ vx: 0, vy: 0 });
  const lastFrameTimeRef = useRef(0);

  const cancelMomentum = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelMomentum(), [cancelMomentum]);

  const step = useCallback((now: number) => {
    const dt = Math.min(64, now - lastFrameTimeRef.current);
    lastFrameTimeRef.current = now;

    // 指数衰减：v ← v · e^(−dt/τ)
    const decay = Math.exp(-dt / MOMENTUM_FRICTION_TAU);
    const v = velocityRef.current;
    v.vx *= decay;
    v.vy *= decay;

    if (Math.hypot(v.vx, v.vy) < MOMENTUM_MIN_STOP_SPEED) {
      rafRef.current = null;
      return;
    }

    const { getViewport, setViewport } = adapterRef.current;
    const viewport = getViewport();
    setViewport(
      { x: viewport.x + v.vx * dt, y: viewport.y + v.vy * dt, zoom: viewport.zoom },
      { duration: 0 },
    );
    rafRef.current = requestAnimationFrame(step);
  }, []);

  const onMoveStart = useCallback((event: unknown, viewport: MomentumViewport) => {
    // 程序化 setViewport（fitView / setCenter / 惯性自身逐帧写入）event 为
    // null：不打断滑行，也不进入采样。真实用户手势（含滚轮）才接管画布。
    if (!event) return;
    cancelMomentum();
    if (!isPointerGestureEvent(event)) {
      trackingRef.current = false;
      return;
    }
    trackingRef.current = true;
    samplesRef.current = [
      { time: performance.now(), x: viewport.x, y: viewport.y },
    ];
  }, [cancelMomentum]);

  const onMove = useCallback((event: unknown, viewport: MomentumViewport) => {
    if (!trackingRef.current || !isPointerGestureEvent(event)) return;
    const now = performance.now();
    const samples = samplesRef.current;
    samples.push({ time: now, x: viewport.x, y: viewport.y });
    // 只保留采样窗口 + 余量，防止长拖拽累积
    const cutoff = now - MOMENTUM_SAMPLE_WINDOW_MS * 2;
    while (samples.length > 2 && samples[0].time < cutoff) {
      samples.shift();
    }
  }, []);

  const onMoveEnd = useCallback((event: unknown, viewport: MomentumViewport) => {
    const wasTracking = trackingRef.current;
    trackingRef.current = false;
    const samples = samplesRef.current;
    samplesRef.current = [];
    if (!wasTracking || !enabledRef.current) return;
    if (!isPointerGestureEvent(event)) return;
    if (prefersReducedMotion()) return;

    const now = performance.now();
    samples.push({ time: now, x: viewport.x, y: viewport.y });
    const velocity = estimatePanVelocity(samples, now);
    if (!velocity) return;
    const speed = Math.hypot(velocity.vx, velocity.vy);
    if (speed < MOMENTUM_MIN_LAUNCH_SPEED) return;

    velocityRef.current = clampSpeed(velocity.vx, velocity.vy);
    lastFrameTimeRef.current = now;
    cancelMomentum();
    rafRef.current = requestAnimationFrame(step);
  }, [cancelMomentum, step]);

  return useMemo(
    () => ({ onMoveStart, onMove, onMoveEnd, cancelMomentum }),
    [onMoveStart, onMove, onMoveEnd, cancelMomentum],
  );
}
