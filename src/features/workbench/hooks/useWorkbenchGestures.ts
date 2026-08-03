/**
 * useWorkbenchGestures（O19）— 触控板 / 鼠标手势统一接入层
 * ---------------------------------------------------------------------------
 * 提供给 O2/O5/O13/O16/O17 消费的横切手势能力，本 hook 自身 0 React state、
 * 0 重渲染：所有高频回调经 rAF 合帧后触发，由调用方直写 DOM。
 *
 * 能力：
 *   1. 捏合缩放（pinch）：Chromium/WebView2 把触控板双指捏合上报为
 *      ctrlKey=true 的 wheel 事件；WebKit（macOS/GTK）走非标 GestureEvent。
 *      两路统一归一为 WorkbenchPinchGesture（累计 scale + 每帧增量）。
 *   2. 双指滑动（swipe）：deltaMode=0（像素级，触控板特征）的 wheel 序列
 *      合成 start/update/end 会话，带累计位移 / 速度 / 主轴判定。
 *   3. 滚轮归一化直通（onWheel）：line/page 模式换算为 px，供自定义消费。
 *   4. useWheelStep：滚轮 notch → ±1 步进（Dock 邻近放大档调节、
 *      弹层列表循环等离散场景）。
 *   5. 全局光标锁 lockWorkbenchCursor：拖拽会话期间把光标形态锁到
 *      `<html data-wb-cursor="...">`，配合 styles/a11y-cursor.css 的单一
 *      全屏伪元素实现一致的 grab/grabbing/resize 形态。
 *      ANTI-REGRESSION：禁止用 `:root[data-wb-cursor] *` 覆盖后代 cursor，
 *      否则每次起拖都会触发全 DOM 样式重算（跨平台首帧卡顿）。栈式管理，支持嵌套。
 *
 * 纪律（编排 §1.5）：
 *   - 手势过程回调不得 setState；消费方直写 DOM（transform/opacity）。
 *   - wheel 无原生结束事件，会话以 endDelayMs 静默期合成 end。
 *   - preventDefault 仅默认作用于 pinch（阻止浏览器页面缩放），swipe 不拦截
 *     滚动语义，由调用方按需开启。
 */
import { useEffect, useRef } from 'react';
import type React from 'react';

// ============================================================================
// 目标解析（useDesktopDrop 复用）
// ============================================================================

export type WorkbenchGestureTarget =
  | React.RefObject<HTMLElement | null>
  | (() => HTMLElement | null)
  | HTMLElement
  | null;

export function resolveGestureTarget(target: WorkbenchGestureTarget): HTMLElement | null {
  if (!target) return null;
  if (target instanceof HTMLElement) return target;
  if (typeof target === 'function') return target();
  return target.current;
}

// ============================================================================
// 滚轮归一化
// ============================================================================

/** deltaMode 换算系数：1 行 ≈ 16px，1 页 ≈ 800px */
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

export interface NormalizedWheel {
  /** 归一化位移（px） */
  dx: number;
  dy: number;
  /** true = 像素级 delta（触控板特征）；false = 行/页步进（滚轮特征） */
  isPixelMode: boolean;
  event: WheelEvent;
}

export function normalizeWheelDelta(event: WheelEvent): NormalizedWheel {
  const factor =
    event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? PAGE_HEIGHT_PX : 1;
  return {
    dx: event.deltaX * factor,
    dy: event.deltaY * factor,
    isPixelMode: event.deltaMode === 0,
    event,
  };
}

// ============================================================================
// 手势载荷类型
// ============================================================================

export type WorkbenchGesturePhase = 'start' | 'update' | 'end';

export interface WorkbenchPinchGesture {
  phase: WorkbenchGesturePhase;
  /** 相对手势开始的累计缩放（1 = 原始尺寸） */
  scale: number;
  /** 距上一帧的缩放增量（乘法因子） */
  deltaScale: number;
  /** 捏合中心（相对 target 左上角，px） */
  centerX: number;
  centerY: number;
  clientX: number;
  clientY: number;
}

export type WorkbenchSwipeAxis = 'x' | 'y';
export type WorkbenchSwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface WorkbenchSwipeGesture {
  phase: WorkbenchGesturePhase;
  /** 会话累计位移（px，自然滚动方向未翻转，正值 = 内容向左/上滚） */
  deltaX: number;
  deltaY: number;
  /** 近期速度（px/ms） */
  velocityX: number;
  velocityY: number;
  /** 超过阈值后锁定的主轴；未达阈值时为 null */
  axis: WorkbenchSwipeAxis | null;
  /** 主轴上的语义方向（按累计位移符号） */
  direction: WorkbenchSwipeDirection | null;
}

export interface UseWorkbenchGesturesOptions {
  target: WorkbenchGestureTarget;
  /** 捏合缩放（ctrl+wheel / GestureEvent） */
  onPinch?: (gesture: WorkbenchPinchGesture) => void;
  /** 双指滑动（触控板像素级 wheel 序列） */
  onSwipe?: (gesture: WorkbenchSwipeGesture) => void;
  /** 所有 wheel 事件的归一化直通（含被 pinch/swipe 消费的） */
  onWheel?: (wheel: NormalizedWheel) => void;
  disabled?: boolean;
  /** swipe 主轴锁定阈值（px），默认 24 */
  swipeThreshold?: number;
  /** 无事件静默多久合成 end（ms），默认 160 */
  endDelayMs?: number;
  /** pinch 阻止默认行为（浏览器页面缩放），默认 true */
  preventDefaultPinch?: boolean;
  /** swipe 阻止默认滚动，默认 false（不与内容滚动抢） */
  preventDefaultSwipe?: boolean;
}

/** ctrl+wheel deltaY → 缩放因子的灵敏度（Chromium 惯例值） */
const PINCH_SENSITIVITY = 0.01;
const DEFAULT_SWIPE_THRESHOLD = 24;
const DEFAULT_END_DELAY_MS = 160;
/** scale 安全钳制，防御异常 delta */
const PINCH_SCALE_MIN = 0.05;
const PINCH_SCALE_MAX = 20;

interface PinchSession {
  scale: number;
  lastEmittedScale: number;
  clientX: number;
  clientY: number;
  started: boolean;
}

interface SwipeSession {
  deltaX: number;
  deltaY: number;
  velocityX: number;
  velocityY: number;
  lastEventTime: number;
  axis: WorkbenchSwipeAxis | null;
  started: boolean;
}

/** WebKit 非标 GestureEvent（TS lib 无定义，宽松声明） */
interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

export interface UseWorkbenchGesturesResult {
  /** 非响应式查询：当前是否有进行中的 pinch/swipe 会话 */
  isGestureActive: () => boolean;
}

export function useWorkbenchGestures(
  options: UseWorkbenchGesturesOptions,
): UseWorkbenchGesturesResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activeRef = useRef(false);

  useEffect(() => {
    const el = resolveGestureTarget(optionsRef.current.target);
    if (!el || optionsRef.current.disabled) return undefined;

    let pinch: PinchSession | null = null;
    let swipe: SwipeSession | null = null;
    let raf = 0;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const syncActive = () => {
      activeRef.current = pinch !== null || swipe !== null;
    };

    // 目标 rect 会话级缓存：pinch 每帧 emit 若都 getBoundingClientRect，
    // 会在跟手帧强制 layout；改为首次读取 + 会话结束/resize 失效。
    let cachedRect: DOMRect | null = null;
    const invalidateRect = () => {
      cachedRect = null;
    };
    window.addEventListener('resize', invalidateRect);

    const centerOf = (clientX: number, clientY: number) => {
      if (!cachedRect) cachedRect = el.getBoundingClientRect();
      return { centerX: clientX - cachedRect.left, centerY: clientY - cachedRect.top };
    };

    const emitPinch = (phase: WorkbenchGesturePhase, session: PinchSession) => {
      const deltaScale =
        session.lastEmittedScale > 0 ? session.scale / session.lastEmittedScale : 1;
      session.lastEmittedScale = session.scale;
      optionsRef.current.onPinch?.({
        phase,
        scale: session.scale,
        deltaScale,
        ...centerOf(session.clientX, session.clientY),
        clientX: session.clientX,
        clientY: session.clientY,
      });
    };

    const emitSwipe = (phase: WorkbenchGesturePhase, session: SwipeSession) => {
      let direction: WorkbenchSwipeDirection | null = null;
      if (session.axis === 'x') direction = session.deltaX > 0 ? 'left' : 'right';
      else if (session.axis === 'y') direction = session.deltaY > 0 ? 'up' : 'down';
      optionsRef.current.onSwipe?.({
        phase,
        deltaX: session.deltaX,
        deltaY: session.deltaY,
        velocityX: session.velocityX,
        velocityY: session.velocityY,
        axis: session.axis,
        direction,
      });
    };

    /** rAF 合帧 flush：每帧最多各发一次 update */
    const flush = () => {
      raf = 0;
      if (disposed) return;
      if (pinch) {
        if (!pinch.started) {
          pinch.started = true;
          const startSession = { ...pinch, scale: 1, lastEmittedScale: 1 };
          emitPinch('start', startSession);
          pinch.lastEmittedScale = 1;
        }
        emitPinch('update', pinch);
      }
      if (swipe) {
        if (!swipe.started) {
          swipe.started = true;
          emitSwipe('start', { ...swipe, deltaX: 0, deltaY: 0, axis: null });
        }
        emitSwipe('update', swipe);
      }
    };

    const scheduleFlush = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const endSessions = () => {
      endTimer = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        flush();
        // flush 可能因 disposed 提前返回；正常路径继续收尾
      }
      if (pinch) {
        if (pinch.started) emitPinch('end', pinch);
        pinch = null;
      }
      if (swipe) {
        if (swipe.started) emitSwipe('end', swipe);
        swipe = null;
      }
      // 会话结束失效 rect 缓存：两次手势之间布局可能已变
      invalidateRect();
      syncActive();
    };

    const armEndTimer = () => {
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(endSessions, optionsRef.current.endDelayMs ?? DEFAULT_END_DELAY_MS);
    };

    const onWheel = (event: WheelEvent) => {
      const opts = optionsRef.current;
      const normalized = normalizeWheelDelta(event);
      opts.onWheel?.(normalized);

      // ---- pinch：ctrl+wheel（触控板捏合的 Chromium 上报形态）----
      if (event.ctrlKey && opts.onPinch) {
        if (opts.preventDefaultPinch !== false && event.cancelable) event.preventDefault();
        if (!pinch) {
          pinch = {
            scale: 1,
            lastEmittedScale: 1,
            clientX: event.clientX,
            clientY: event.clientY,
            started: false,
          };
        }
        const factor = Math.exp(-normalized.dy * PINCH_SENSITIVITY);
        pinch.scale = Math.min(
          PINCH_SCALE_MAX,
          Math.max(PINCH_SCALE_MIN, pinch.scale * factor),
        );
        pinch.clientX = event.clientX;
        pinch.clientY = event.clientY;
        syncActive();
        scheduleFlush();
        armEndTimer();
        return;
      }

      // ---- swipe：像素级 delta（触控板双指）----
      if (normalized.isPixelMode && opts.onSwipe) {
        if (opts.preventDefaultSwipe && event.cancelable) event.preventDefault();
        const now =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        if (!swipe) {
          swipe = {
            deltaX: 0,
            deltaY: 0,
            velocityX: 0,
            velocityY: 0,
            lastEventTime: now,
            axis: null,
            started: false,
          };
        }
        swipe.deltaX += normalized.dx;
        swipe.deltaY += normalized.dy;
        const dt = Math.max(1, now - swipe.lastEventTime);
        // 指数平滑速度（近期事件权重高）
        swipe.velocityX = swipe.velocityX * 0.6 + (normalized.dx / dt) * 0.4;
        swipe.velocityY = swipe.velocityY * 0.6 + (normalized.dy / dt) * 0.4;
        swipe.lastEventTime = now;
        const threshold = opts.swipeThreshold ?? DEFAULT_SWIPE_THRESHOLD;
        if (
          swipe.axis === null &&
          (Math.abs(swipe.deltaX) >= threshold || Math.abs(swipe.deltaY) >= threshold)
        ) {
          swipe.axis = Math.abs(swipe.deltaX) >= Math.abs(swipe.deltaY) ? 'x' : 'y';
        }
        syncActive();
        scheduleFlush();
        armEndTimer();
      }
    };

    // ---- WebKit GestureEvent（macOS/WebKitGTK 的原生捏合）----
    const onGestureStart = (event: Event) => {
      const opts = optionsRef.current;
      if (!opts.onPinch) return;
      const ge = event as WebKitGestureEvent;
      if (opts.preventDefaultPinch !== false) ge.preventDefault();
      pinch = {
        scale: typeof ge.scale === 'number' && ge.scale > 0 ? ge.scale : 1,
        lastEmittedScale: 1,
        clientX: ge.clientX ?? 0,
        clientY: ge.clientY ?? 0,
        started: false,
      };
      syncActive();
      scheduleFlush();
    };
    const onGestureChange = (event: Event) => {
      if (!pinch) return;
      const ge = event as WebKitGestureEvent;
      if (optionsRef.current.preventDefaultPinch !== false) ge.preventDefault();
      if (typeof ge.scale === 'number' && ge.scale > 0) {
        pinch.scale = Math.min(PINCH_SCALE_MAX, Math.max(PINCH_SCALE_MIN, ge.scale));
      }
      pinch.clientX = ge.clientX ?? pinch.clientX;
      pinch.clientY = ge.clientY ?? pinch.clientY;
      scheduleFlush();
    };
    const onGestureEnd = () => {
      if (endTimer) clearTimeout(endTimer);
      endSessions();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);

    return () => {
      // 卸载时先把进行中会话正常收尾（消费方可提交结果），再释放资源
      if (endTimer) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      endSessions();
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', invalidateRect);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
      activeRef.current = false;
    };
    // target/disabled 变化时重挂监听；回调经 optionsRef 透传不重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.disabled, options.target]);

  return {
    isGestureActive: () => activeRef.current,
  };
}

// ============================================================================
// useWheelStep — 滚轮 notch 步进（Dock 放大档调节 / 弹层列表循环）
// ============================================================================

export interface UseWheelStepOptions {
  target: WorkbenchGestureTarget;
  /** 每跨过一个步进阈值触发一次；step = +1（向下/右滚）或 -1 */
  onStep: (step: 1 | -1, wheel: NormalizedWheel) => void;
  /** 取哪个轴的 delta，'dominant' = 每次事件取绝对值更大的轴；默认 'y' */
  axis?: 'x' | 'y' | 'dominant';
  /** 累计多少 px 触发一步，默认 80（≈ 一个滚轮 notch 的像素当量） */
  stepSize?: number;
  /** 静默多久清空累计余量（ms），默认 300 */
  resetDelayMs?: number;
  disabled?: boolean;
  /** 默认 true：消费掉滚动（Dock 上滚轮不应滚动页面） */
  preventDefault?: boolean;
}

const DEFAULT_STEP_SIZE = 80;
const DEFAULT_STEP_RESET_MS = 300;

export function useWheelStep(options: UseWheelStepOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const el = resolveGestureTarget(optionsRef.current.target);
    if (!el || optionsRef.current.disabled) return undefined;

    let accumulated = 0;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;

    const onWheel = (event: WheelEvent) => {
      const opts = optionsRef.current;
      const normalized = normalizeWheelDelta(event);
      if (opts.preventDefault !== false && event.cancelable) event.preventDefault();

      const axis = opts.axis ?? 'y';
      const delta =
        axis === 'x'
          ? normalized.dx
          : axis === 'y'
            ? normalized.dy
            : Math.abs(normalized.dx) >= Math.abs(normalized.dy)
              ? normalized.dx
              : normalized.dy;

      accumulated += delta;
      const stepSize = opts.stepSize ?? DEFAULT_STEP_SIZE;
      while (Math.abs(accumulated) >= stepSize) {
        const step: 1 | -1 = accumulated > 0 ? 1 : -1;
        accumulated -= step * stepSize;
        opts.onStep(step, normalized);
      }

      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        accumulated = 0;
        resetTimer = null;
      }, opts.resetDelayMs ?? DEFAULT_STEP_RESET_MS);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (resetTimer) clearTimeout(resetTimer);
      el.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.disabled, options.target]);
}

// ============================================================================
// 全局光标锁（CSS 只重算 :root 伪元素，禁止通配整棵 DOM）
// ============================================================================

export type WorkbenchCursorKind =
  | 'default'
  | 'grab'
  | 'grabbing'
  | 'move'
  | 'copy'
  | 'not-allowed'
  | 'ns-resize'
  | 'ew-resize'
  | 'nesw-resize'
  | 'nwse-resize'
  | 'col-resize'
  | 'row-resize'
  | 'zoom-in'
  | 'zoom-out';

const CURSOR_ATTR = 'data-wb-cursor';

interface CursorLockEntry {
  id: number;
  cursor: WorkbenchCursorKind;
}

let cursorLockSeq = 0;
const cursorLockStack: CursorLockEntry[] = [];

function applyCursorAttr(): void {
  if (typeof document === 'undefined') return;
  const top = cursorLockStack[cursorLockStack.length - 1];
  const rootEl = document.documentElement;
  if (top) {
    if (rootEl.getAttribute(CURSOR_ATTR) !== top.cursor) {
      rootEl.setAttribute(CURSOR_ATTR, top.cursor);
    }
  } else {
    rootEl.removeAttribute(CURSOR_ATTR);
  }
}

/**
 * 锁定全局光标形态（拖拽/缩放会话期调用）。返回释放函数；
 * 支持嵌套（栈式，释放时恢复上一层）。释放函数幂等。
 *
 * 典型用法（O2 拖拽引擎）：
 *   const release = lockWorkbenchCursor('grabbing');
 *   ...pointerup / pointercancel...
 *   release();
 */
export function lockWorkbenchCursor(cursor: WorkbenchCursorKind): () => void {
  const entry: CursorLockEntry = { id: ++cursorLockSeq, cursor };
  cursorLockStack.push(entry);
  applyCursorAttr();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = cursorLockStack.indexOf(entry);
    if (index >= 0) cursorLockStack.splice(index, 1);
    applyCursorAttr();
  };
}

/** 当前生效的全局光标锁（无锁时 null）；诊断 / 测试用 */
export function getActiveWorkbenchCursor(): WorkbenchCursorKind | null {
  return cursorLockStack[cursorLockStack.length - 1]?.cursor ?? null;
}

/** 仅供单元测试：清空光标锁栈 */
export function resetWorkbenchCursorForTests(): void {
  cursorLockStack.length = 0;
  applyCursorAttr();
}
