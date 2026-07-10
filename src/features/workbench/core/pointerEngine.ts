/**
 * 指针交互引擎（主责 P2 → O2 手感深化）
 *
 * 拖动 / 八向缩放的框架无关实现，供 useWindowPointer 包装成 React hook。
 * 渲染纪律（设计文档 §5.4）：
 * - Pointer Events + setPointerCapture；
 * - pointermove 只暂存坐标，rAF 合帧后统一计算并回调 onFrameChange——
 *   调用方直接写 DOM，绝不进 React state；
 * - 吸附命中检测（仅 move 手势）在同一 rAF 帧内做纯几何计算；
 * - ⌥/Alt（altKey）加速平铺：扩大 snapZones 热区（Tahoe Hold Option to tile）；
 * - Esc / pointercancel / lostpointercapture / window blur → 回退到起始 frame。
 *
 * O2 手感层（全部在引擎内实现，不触碰冻结契约 WindowPointerCallbacks）：
 * - 亚像素跟手：过程 frame 保留小数（translate3d 亚像素渲染），commit 时才取整；
 * - 硬边界：move / resize 过程即 clamp，松手无需回弹 settle；
 * - 释放惯性：默认关闭（enableInertia === true 才开启短距滑行）；
 * - magnetic 磁吸：默认关闭（enableMagnet === true 才开启）；
 * - 八向缩放：先算尺寸（含 Shift 等比锁定 + min/max 硬钳位），再由起始 frame
 *   派生锚点——对角 / 对边严格固定，无累计漂移；
 * - move 启动阈值：pointerdown 只武装捕获，位移 ≥ MOVE_ARM_THRESHOLD_PX 才
 *   进入跟手（onMoveArmed → 消费方 tear-out）；未过阈值的
 *   up 视为纯点击（onMoveDismissed，不 onCommit）；
 * - 默认松手同步 onCommit（无放下动画）；仅显式开启惯性时才 settle。
 * - ANTI-REGRESSION：getDesktopOffset 只在手势 start 时读取一次并缓存；
 *   禁止在每帧 step 中重新测 DOMRect，否则会把起拖样式失效同步 flush 进跟手帧。
 *
 * 手势结束语义（WindowPointerCallbacks 冻结接口约定）：
 * - 命中吸附区松手：立即 onCommit(finalFrame, zone)（落位由消费方负责，默认瞬时）；
 * - 普通松手：默认同步 onCommit(finalFrame, null)——松手即停，无放下动画；
 *   仅 enableInertia 时才短距 settle 后再 commit；
 * - 取消（Esc/捕获丢失）：先 onFrameChange(startFrame) 回原位，
 *   再 onCommit(startFrame, null)；
 *   未过启动阈值时取消 / 松手：onMoveDismissed（纯点击）。
 */
import type { Frame, Size, SnapZone, WindowPointerCallbacks } from './types';
import { hitTestSnapZone } from './snapZones';

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type GestureKind = 'move' | 'resize';

/** 拖动时窗口水平方向至少保留可见的宽度（px），保证标题栏可再次抓取 */
export const MOVE_KEEP_VISIBLE_X = 80;
/** 拖动时窗口顶部距桌面底缘至少保留的高度（px） */
export const MOVE_KEEP_VISIBLE_Y = 40;
/** appRegistry 查不到 minSize 时的兜底 */
export const FALLBACK_MIN_SIZE: Size = { w: 320, h: 240 };

// ---------------------------------------------------------------------------
// O2 手感参数（导出供测试与 O20 校准）
// ---------------------------------------------------------------------------

/** move 越界 rubber band 最大溢出（px）——收紧，减少松手回弹感 */
export const MOVE_RUBBER_MAX = 10;
/** move rubber band 半饱和常数（越大越"硬"） */
export const MOVE_RUBBER_K = 160;
/** resize 低于 minSize 的软阻尼最大溢出（px） */
export const RESIZE_MIN_RUBBER_MAX = 8;
export const RESIZE_MIN_RUBBER_K = 140;
/** resize 超过桌面尺寸的软阻尼最大溢出（px） */
export const RESIZE_MAX_RUBBER_MAX = 12;
export const RESIZE_MAX_RUBBER_K = 220;
/** 命中吸附区时的磁吸位移幅度（px）；默认关闭磁吸时仍保留 API，值为 0 */
export const MAGNET_PULL_PX = 0;
/** 磁吸位移每帧向目标趋近的比例（指数趋近） */
export const MAGNET_LERP = 0.45;
/** 触发惯性滑行的最小释放速度（px/ms）；默认关闭惯性，阈值抬高作兜底 */
export const INERTIA_MIN_SPEED = 1.2;
/** 惯性位移时间常数：位移 = v·τ（ms） */
export const INERTIA_TAU_MS = 40;
/** 惯性滑行最大位移（px） */
export const INERTIA_MAX_DIST = 24;
/** 速度采样窗口（ms） */
export const VELOCITY_WINDOW_MS = 80;
/** 速度可信的最小采样时间跨度（ms）；低于此值视为无速度（同步 commit） */
export const VELOCITY_MIN_DT_MS = 30;
/** settle 动画时长范围（ms）：仅越界回弹用，跟手优先、尽快落定 */
export const SETTLE_MIN_MS = 40;
export const SETTLE_MAX_MS = 90;
/**
 * move 启动阈值（px）：pointerdown 只武装捕获，超过后才跟手 / 触发 onMoveArmed。
 * 保持极小阈值以区分单击与拖动（最大化标题栏单击不 tear-out）。
 */
export const MOVE_ARM_THRESHOLD_PX = 1;

/**
 * iOS 式 rubber band：输入越界量，返回衰减后的视觉溢出（0 ≤ 返回值 < max）。
 * 单调递增、渐近 max，导数在 0 处为 max/k（起始跟手，越拉越沉）。
 */
export function rubberBand(excess: number, max = MOVE_RUBBER_MAX, k = MOVE_RUBBER_K): number {
  if (excess <= 0) return 0;
  return (max * excess) / (excess + k);
}

// ---------------------------------------------------------------------------
// prefers-reduced-motion：模块级缓存 MediaQueryList，避免每帧 matchMedia 分配
// ---------------------------------------------------------------------------

let reducedMotionMql: MediaQueryList | null | undefined;
let reducedMotionCached = false;

function ensureReducedMotionMql(): MediaQueryList | null {
  if (reducedMotionMql !== undefined) return reducedMotionMql;
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      reducedMotionMql = null;
      return null;
    }
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionMql = mql;
    reducedMotionCached = mql.matches === true;
    const sync = () => {
      reducedMotionCached = mql.matches === true;
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', sync);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(sync);
    }
    return mql;
  } catch {
    reducedMotionMql = null;
    return null;
  }
}

/** 系统 reduce-motion 偏好（jsdom / 老环境无 matchMedia 时按 false 处理） */
export function prefersReducedMotion(): boolean {
  ensureReducedMotionMql();
  return reducedMotionCached;
}

/** 测试用：重置 MQL 缓存（matchMedia mock 切换后调用） */
export function resetPrefersReducedMotionCacheForTests(): void {
  reducedMotionMql = undefined;
  reducedMotionCached = false;
}

export interface PointerEngineOptions {
  /** 手势起始时读取当前 frame（tiled/maximized 窗口应传视觉 frame） */
  getFrame: () => Frame;
  getDesktopSize: () => Size;
  getMinSize: () => Size;
  /** 每次回调时读取（保持 React 侧引用最新，engine 自身无状态依赖） */
  getCallbacks: () => WindowPointerCallbacks;
  /**
   * 桌面区左上角相对视口的偏移（clientX/Y → 桌面坐标转换），缺省 (0,0)。
   * 引擎只在手势开始时读取一次；provider 禁止依赖每帧同步布局。
   */
  getDesktopOffset?: () => { x: number; y: number };
  /** move 手势是否做吸附命中检测，缺省 true（resize 手势永不吸附） */
  enableSnap?: boolean;
  /** 释放惯性滑行开关，缺省 false（跟手优先；reduced-motion 下亦关闭） */
  enableInertia?: boolean;
  /** 吸附磁吸位移开关，缺省 false（避免拖近边缘被「吸走」） */
  enableMagnet?: boolean;
  /**
   * move 越过启动阈值时回调一次（消费方 tear-out）。
   * 传入武装瞬间的指针坐标（视口）；不进冻结契约 WindowPointerCallbacks。
   * resize 立即武装，不触发。
   */
  onMoveArmed?: (point: { x: number; y: number }) => void;
  /**
   * move 未过阈值就结束（纯点击 / 取消）时回调——消费方用于撤掉 pointerdown 时已抬升的壳层。
   * 已武装的结束路径走 onCommit，不触发本回调。
   */
  onMoveDismissed?: () => void;
}

interface PointerSample {
  t: number;
  x: number;
  y: number;
}

interface GesturePoint {
  x: number;
  y: number;
  shift: boolean;
  /** ⌥/Alt：扩大平铺热区（见 snapZones SnapHitOptions.altKey） */
  alt: boolean;
}

interface ActiveGesture {
  kind: GestureKind;
  edge: ResizeEdge | null;
  pointerId: number;
  captureTarget: Element | null;
  startPointer: { x: number; y: number };
  startFrame: Frame;
  /** 纯几何 frame（含 rubber band，不含磁吸偏移） */
  baseFrame: Frame;
  /** 上次回调给消费方的 display frame（base + 磁吸） */
  lastFrame: Frame;
  lastPoint: GesturePoint;
  lastZone: SnapZone;
  rafId: number;
  pendingPoint: GesturePoint | null;
  /** 磁吸当前偏移（向 magnetVector(zone) 指数趋近） */
  magnetOffset: { x: number; y: number };
  /** 速度采样环（仅 move 消费） */
  samples: PointerSample[];
  /** 手势起始时缓存的 reduce-motion 偏好 */
  reduced: boolean;
  /**
   * 手势起始时缓存的桌面偏移。吸附热路径禁止调用 getBoundingClientRect，
   * 否则会在每个 pointer rAF 强制结算壳层刚写入的样式与布局。
   */
  desktopOffset: { x: number; y: number };
  /**
   * move：未过 MOVE_ARM_THRESHOLD_PX 前为 false（不跟手、不 commit）；
   * resize：起始即为 true。
   */
  armed: boolean;
}

interface SettleAnimation {
  rafId: number;
  from: Frame;
  to: Frame;
  start: number;
  duration: number;
}

function framesEqual(a: Frame, b: Frame): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function roundFrame(f: Frame): Frame {
  return { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) };
}

function lerpFrame(a: Frame, b: Frame, t: number): Frame {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

const DIAG = Math.SQRT1_2;

/** 吸附区 → 磁吸方向单位向量（乘 MAGNET_PULL_PX 得偏移） */
function magnetVector(zone: SnapZone): { x: number; y: number } {
  switch (zone) {
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'top-maximize':
      return { x: 0, y: -1 };
    case 'tl':
      return { x: -DIAG, y: -DIAG };
    case 'tr':
      return { x: DIAG, y: -DIAG };
    case 'bl':
      return { x: -DIAG, y: DIAG };
    case 'br':
      return { x: DIAG, y: DIAG };
    default:
      return { x: 0, y: 0 };
  }
}

/** 单侧软钳制：区间内原样返回，越界部分走 rubber band */
function softClamp(v: number, min: number, max: number, rubberMax: number, rubberK: number): number {
  if (v < min) return min - rubberBand(min - v, rubberMax, rubberK);
  if (v > max) return max + rubberBand(v - max, rubberMax, rubberK);
  return v;
}

export class WindowPointerEngine {
  private opts: PointerEngineOptions;
  private gesture: ActiveGesture | null = null;
  private settle: SettleAnimation | null = null;

  constructor(opts: PointerEngineOptions) {
    this.opts = opts;
  }

  isActive(): boolean {
    return this.gesture !== null;
  }

  /** move 是否已过启动阈值（resize 起始即 true） */
  isArmed(): boolean {
    return this.gesture?.armed === true;
  }

  /** 是否处于释放后的惯性/回弹动画阶段（此阶段 isActive 为 false，commit 未发出） */
  isSettling(): boolean {
    return this.settle !== null;
  }

  currentGesture(): GestureKind | null {
    return this.gesture?.kind ?? null;
  }

  startMove(e: PointerEvent, captureTarget?: Element): void {
    this.start('move', null, e, captureTarget);
  }

  startResize(e: PointerEvent, edge: ResizeEdge, captureTarget?: Element): void {
    this.start('resize', edge, e, captureTarget);
  }

  /** Esc / 外部强制取消：回退到起始 frame 并结束手势；settle 阶段则立即完结 */
  cancel(): void {
    if (this.settle) {
      this.finalizeSettle();
      return;
    }
    const g = this.gesture;
    if (!g) return;
    // 未武装：纯点击取消，无 commit / 无回位副作用
    if (!g.armed) {
      this.teardown();
      this.opts.onMoveDismissed?.();
      return;
    }
    const cb = this.opts.getCallbacks();
    this.teardown();
    cb.onFrameChange(g.startFrame);
    if (g.lastZone !== null) cb.onSnapZoneChange(null);
    cb.onCommit(g.startFrame, null);
  }

  dispose(): void {
    this.cancel();
    // cancel 只处理其中一种状态；两者理论上互斥，双保险
    if (this.settle) this.finalizeSettle();
  }

  // --------------------------------------------------------------------
  private start(
    kind: GestureKind,
    edge: ResizeEdge | null,
    e: PointerEvent,
    captureTarget?: Element,
  ): void {
    // 上一次释放的 settle 未播完就再次抓取：立即定格并 commit，再开新手势
    if (this.settle) this.finalizeSettle();
    if (this.gesture) return;
    // 仅主键（触摸/笔的 button 为 0 或 -1）
    if (e.button != null && e.button > 0) return;

    const startFrame = { ...this.opts.getFrame() };
    const desktopOffset =
      kind === 'move' && this.opts.enableSnap !== false
        ? { ...(this.opts.getDesktopOffset?.() ?? { x: 0, y: 0 }) }
        : { x: 0, y: 0 };
    const target = captureTarget ?? (e.currentTarget as Element | null) ?? (e.target as Element | null);
    if (target && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // capture 失败不阻断手势（如测试环境 / 已失效指针）
      }
    }

    const startPoint: GesturePoint = {
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey === true,
      alt: e.altKey === true,
    };
    // resize 立即武装；move 等阈值
    const armed = kind === 'resize';
    this.gesture = {
      kind,
      edge,
      pointerId: e.pointerId,
      captureTarget: target,
      startPointer: { x: e.clientX, y: e.clientY },
      startFrame,
      baseFrame: startFrame,
      lastFrame: startFrame,
      lastPoint: startPoint,
      lastZone: null,
      rafId: 0,
      pendingPoint: null,
      magnetOffset: { x: 0, y: 0 },
      samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
      reduced: prefersReducedMotion(),
      desktopOffset,
      armed,
    };

    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
    window.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('blur', this.handleWindowBlur);
    target?.addEventListener('lostpointercapture', this.handleLostCapture as EventListener);
    e.preventDefault?.();
  }

  /**
   * 尝试武装 move。返回 true 表示本帧应继续计算跟手几何；
   * false 表示未过阈值，或刚完成 tear-out（原点已重置，等下一帧）。
   */
  private armMoveIfNeeded(point: GesturePoint): boolean {
    const g = this.gesture;
    if (!g) return false;
    if (g.armed) return true;
    if (g.kind !== 'move') {
      g.armed = true;
      return true;
    }
    const dx = point.x - g.startPointer.x;
    const dy = point.y - g.startPointer.y;
    if (dx * dx + dy * dy < MOVE_ARM_THRESHOLD_PX * MOVE_ARM_THRESHOLD_PX) {
      return false;
    }
    g.armed = true;
    const before = g.startFrame;
    this.opts.onMoveArmed?.({ x: point.x, y: point.y });
    const frame = { ...this.opts.getFrame() };
    // tear-out 改写了 frame：以当前指针为新原点，本帧零位移
    if (
      frame.x !== before.x ||
      frame.y !== before.y ||
      frame.w !== before.w ||
      frame.h !== before.h
    ) {
      g.startPointer = { x: point.x, y: point.y };
      g.startFrame = frame;
      g.baseFrame = frame;
      g.lastFrame = frame;
      g.samples = [{ t: performance.now(), x: point.x, y: point.y }];
      return false;
    }
    // 浮动窗：保留原始 down 原点，本帧继续用含阈值过冲的 delta 跟手
    return true;
  }

  private handlePointerMove = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    g.pendingPoint = {
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey === true,
      alt: e.altKey === true,
    };
    if (g.rafId === 0) {
      g.rafId = requestAnimationFrame(this.processFrame);
    }
  };

  private processFrame = (): void => {
    const g = this.gesture;
    if (!g) return;
    g.rafId = 0;
    // 无新指针点时用最后一个点重算（磁吸偏移自驱收敛）
    const point = g.pendingPoint ?? g.lastPoint;
    g.pendingPoint = null;
    this.step(point);
  };

  /** 单帧计算：frame + 吸附区 + 磁吸偏移，回调直写 DOM */
  private step(point: GesturePoint): void {
    const g = this.gesture;
    if (!g) return;

    if (!g.armed) {
      g.lastPoint = point;
      if (!this.armMoveIfNeeded(point)) return;
    }

    const cb = this.opts.getCallbacks();
    g.lastPoint = point;

    // 速度采样（move 释放惯性用）
    if (g.kind === 'move') {
      const now = performance.now();
      g.samples.push({ t: now, x: point.x, y: point.y });
      while (g.samples.length > 1 && now - g.samples[0].t > VELOCITY_WINDOW_MS) {
        g.samples.shift();
      }
    }

    g.baseFrame = g.kind === 'move' ? this.computeMoveFrame(point) : this.computeResizeFrame(point);

    // 吸附命中（仅 move）——先更新 zone，磁吸目标依赖它
    if (g.kind === 'move' && this.opts.enableSnap !== false) {
      const zone = hitTestSnapZone(
        { x: point.x - g.desktopOffset.x, y: point.y - g.desktopOffset.y },
        this.opts.getDesktopSize(),
        g.lastZone,
        { altKey: point.alt },
      );
      if (zone !== g.lastZone) {
        g.lastZone = zone;
        cb.onSnapZoneChange(zone);
      }
    }

    // 磁吸位移：向 magnetVector(zone)·MAGNET_PULL_PX 指数趋近；离开热区回弹到 0
    let magnetUnsettled = false;
    if (g.kind === 'move' && this.opts.enableMagnet === true && !g.reduced) {
      const dir = magnetVector(g.lastZone);
      const tx = dir.x * MAGNET_PULL_PX;
      const ty = dir.y * MAGNET_PULL_PX;
      let ox = g.magnetOffset.x + (tx - g.magnetOffset.x) * MAGNET_LERP;
      let oy = g.magnetOffset.y + (ty - g.magnetOffset.y) * MAGNET_LERP;
      if (Math.abs(tx - ox) < 0.1 && Math.abs(ty - oy) < 0.1) {
        ox = tx;
        oy = ty;
      } else {
        magnetUnsettled = true;
      }
      g.magnetOffset = { x: ox, y: oy };
    }

    const frame: Frame =
      g.kind === 'move'
        ? {
            x: g.baseFrame.x + g.magnetOffset.x,
            y: g.baseFrame.y + g.magnetOffset.y,
            w: g.baseFrame.w,
            h: g.baseFrame.h,
          }
        : g.baseFrame;

    if (!framesEqual(frame, g.lastFrame)) {
      g.lastFrame = frame;
      cb.onFrameChange(frame);
    }

    // 磁吸未收敛：指针静止也要继续动画（自驱 rAF；有新 pendingPoint 时由其驱动）
    if (magnetUnsettled && g.rafId === 0) {
      g.rafId = requestAnimationFrame(this.processFrame);
    }
  }

  // -------------------------- move 几何 --------------------------------

  private moveBounds(w: number): { minX: number; maxX: number; maxY: number } {
    const desktop = this.opts.getDesktopSize();
    return {
      minX: MOVE_KEEP_VISIBLE_X - w,
      maxX: desktop.w - MOVE_KEEP_VISIBLE_X,
      maxY: Math.max(0, desktop.h - MOVE_KEEP_VISIBLE_Y),
    };
  }

  private computeMoveFrame(point: GesturePoint): Frame {
    const g = this.gesture!;
    const { minX, maxX, maxY } = this.moveBounds(g.startFrame.w);
    const rawX = g.startFrame.x + (point.x - g.startPointer.x);
    const rawY = g.startFrame.y + (point.y - g.startPointer.y);
    // 亚像素跟手 + 硬边界：松手无需回弹 settle（一拖就动、一放就停）
    const x = Math.min(maxX, Math.max(minX, rawX));
    const y = Math.min(maxY, Math.max(0, rawY));
    return { x, y, w: g.startFrame.w, h: g.startFrame.h };
  }

  /** 释放后的静止目标：硬边界 clamp + 惯性位移；附带释放速度供 settle 斜率匹配 */
  private computeMoveRestTarget(g: ActiveGesture): { frame: Frame; releaseSpeed: number } {
    const { minX, maxX, maxY } = this.moveBounds(g.startFrame.w);
    let dx = 0;
    let dy = 0;
    let releaseSpeed = 0;
    if (this.opts.enableInertia === true && !g.reduced) {
      const v = this.velocityFromSamples(g.samples);
      const speed = Math.hypot(v.x, v.y);
      releaseSpeed = speed;
      if (speed >= INERTIA_MIN_SPEED) {
        const dist = Math.min(speed * INERTIA_TAU_MS, INERTIA_MAX_DIST);
        dx = (v.x / speed) * dist;
        dy = (v.y / speed) * dist;
      }
    }
    return {
      frame: {
        x: Math.min(maxX, Math.max(minX, g.baseFrame.x + dx)),
        y: Math.min(maxY, Math.max(0, g.baseFrame.y + dy)),
        w: g.startFrame.w,
        h: g.startFrame.h,
      },
      releaseSpeed,
    };
  }

  private velocityFromSamples(samples: PointerSample[]): { x: number; y: number } {
    if (samples.length < 2) return { x: 0, y: 0 };
    const last = samples[samples.length - 1];
    // 窗口内最旧的采样
    let first = samples[0];
    for (const s of samples) {
      if (last.t - s.t <= VELOCITY_WINDOW_MS) {
        first = s;
        break;
      }
    }
    const dt = last.t - first.t;
    if (dt < VELOCITY_MIN_DT_MS) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }

  // -------------------------- resize 几何 -------------------------------

  private computeResizeFrame(point: GesturePoint): Frame {
    const g = this.gesture!;
    const edge = g.edge ?? 'se';
    const sf = g.startFrame;
    const min = this.opts.getMinSize();
    const desktop = this.opts.getDesktopSize();
    const minW = Math.max(1, min.w);
    const minH = Math.max(1, min.h);
    const dx = point.x - g.startPointer.x;
    const dy = point.y - g.startPointer.y;

    // 1. 先算原始尺寸（亚像素，不取整）
    let w = sf.w;
    let h = sf.h;
    if (edge.includes('e')) w = sf.w + dx;
    if (edge.includes('w')) w = sf.w - dx;
    if (edge.includes('s')) h = sf.h + dy;
    if (edge.includes('n')) h = sf.h - dy;

    // 2. Shift 等比锁定（对角柄取相对变化更大的主导轴；边柄由该轴派生另一轴）
    if (point.shift && sf.w > 0 && sf.h > 0) {
      const ratio = sf.w / sf.h;
      const horizontalOnly = edge === 'e' || edge === 'w';
      const verticalOnly = edge === 'n' || edge === 's';
      if (horizontalOnly) {
        h = w / ratio;
      } else if (verticalOnly) {
        w = h * ratio;
      } else if (Math.abs(w / sf.w - 1) >= Math.abs(h / sf.h - 1)) {
        h = w / ratio;
      } else {
        w = h * ratio;
      }
    }

    // 3. min / 桌面尺寸硬钳位（无软阻尼 → 松手无需 settle）
    w = Math.min(Math.max(w, minW), desktop.w);
    h = Math.min(Math.max(h, minH), desktop.h);

    // 4. 锚点从起始 frame 派生：对角/对边严格固定（x+w、y+h 精确守恒，无漂移）
    const x = edge.includes('w') ? sf.x + sf.w - w : sf.x;
    const y = edge.includes('n') ? sf.y + sf.h - h : sf.y;
    return { x, y, w, h };
  }

  /** 释放后的静止目标：尺寸硬 clamp 回 [minSize, 桌面]，锚点保持固定 */
  private computeResizeRestTarget(g: ActiveGesture): Frame {
    const edge = g.edge ?? 'se';
    const sf = g.startFrame;
    const min = this.opts.getMinSize();
    const desktop = this.opts.getDesktopSize();
    const w = Math.min(Math.max(g.baseFrame.w, Math.max(1, min.w)), desktop.w);
    const h = Math.min(Math.max(g.baseFrame.h, Math.max(1, min.h)), desktop.h);
    const x = edge.includes('w') ? sf.x + sf.w - w : sf.x;
    const y = edge.includes('n') ? sf.y + sf.h - h : sf.y;
    return { x, y, w, h };
  }

  // -------------------------- 结束路径 ----------------------------------

  private handlePointerUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    // 合帧中未消费的最后一个点在松手前同步补算，保证 commit 的是最终位置
    if (g.rafId !== 0) {
      cancelAnimationFrame(g.rafId);
      g.rafId = 0;
    }
    if (g.pendingPoint) {
      const point = g.pendingPoint;
      g.pendingPoint = null;
      this.step(point);
    }

    // 未过启动阈值：纯点击，不 commit；通知消费方撤掉壳层抬升
    if (!g.armed) {
      this.teardown();
      this.opts.onMoveDismissed?.();
      return;
    }

    const cb = this.opts.getCallbacks();
    const zone = g.kind === 'move' ? g.lastZone : null;
    const last = g.lastFrame;
    const kind = g.kind;
    const samples = g.samples;
    const startFrame = g.startFrame;
    this.teardown();

    if (zone !== null) {
      // 命中吸附区：立即落位（平铺几何由消费方 setDisplayMode 接管）
      cb.onSnapZoneChange(null);
      cb.onCommit(roundFrame(last), zone);
      return;
    }

    // 可选惯性：仅 enableInertia 时短距滑行；默认直接停在松手位置
    if (this.opts.enableInertia === true && !prefersReducedMotion() && kind === 'move') {
      const rest = this.computeMoveRestTarget({
        kind: 'move',
        edge: null,
        pointerId: 0,
        captureTarget: null,
        startPointer: { x: 0, y: 0 },
        startFrame,
        baseFrame: last,
        lastFrame: last,
        lastPoint: { x: 0, y: 0, shift: false, alt: false },
        lastZone: null,
        rafId: 0,
        pendingPoint: null,
        magnetOffset: { x: 0, y: 0 },
        samples,
        reduced: false,
        desktopOffset: { x: 0, y: 0 },
        armed: true,
      });
      const t = roundFrame(rest.frame);
      const dist = Math.max(Math.abs(t.x - last.x), Math.abs(t.y - last.y));
      if (dist >= 1) {
        // 惯性滑行前先结束壳层（避免「放下中」仍挂 dragging）
        this.opts.onMoveDismissed?.();
        this.startSettle(last, t, dist, rest.releaseSpeed);
        return;
      }
    }

    // 默认：松手即停、同步 commit（无放下动画）
    cb.onCommit(roundFrame(last), null);
  };

  /**
   * 释放后的惯性滑行 / 回弹动画：ease-out cubic。
   * 有释放速度时令 duration ≈ 3·dist/v，使 t=0 处斜率匹配手速（避免「向前踢一脚」）。
   */
  private startSettle(from: Frame, to: Frame, dist: number, releaseSpeed = 0): void {
    let duration: number;
    if (releaseSpeed > 0.01 && dist > 0) {
      // ease-out cubic：d(eased)/dt|_{0} = 3/duration → 物理初速 = 3·dist/duration
      duration = Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, (3 * dist) / releaseSpeed));
    } else {
      duration = Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, 30 + dist * 0.6));
    }
    this.settle = {
      rafId: 0,
      from,
      to,
      start: performance.now(),
      duration,
    };
    this.settle.rafId = requestAnimationFrame(this.settleTick);
  }

  private settleTick = (): void => {
    const s = this.settle;
    if (!s) return;
    const cb = this.opts.getCallbacks();
    const p = Math.min(1, (performance.now() - s.start) / s.duration);
    if (p >= 1) {
      this.settle = null;
      cb.onFrameChange(s.to);
      cb.onCommit(s.to, null);
      return;
    }
    const eased = 1 - Math.pow(1 - p, 3);
    cb.onFrameChange(lerpFrame(s.from, s.to, eased));
    s.rafId = requestAnimationFrame(this.settleTick);
  };

  /** settle 中断（再次抓取 / dispose / cancel）：跳到终点并立即 commit */
  private finalizeSettle(): void {
    const s = this.settle;
    if (!s) return;
    this.settle = null;
    if (s.rafId !== 0) cancelAnimationFrame(s.rafId);
    const cb = this.opts.getCallbacks();
    cb.onFrameChange(s.to);
    cb.onCommit(s.to, null);
  }

  private handlePointerCancel = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.cancel();
  };

  private handleLostCapture = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.cancel();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.gesture || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.cancel();
  };

  private handleWindowBlur = (): void => {
    this.cancel();
  };

  private teardown(): void {
    const g = this.gesture;
    if (!g) return;
    if (g.rafId !== 0) {
      cancelAnimationFrame(g.rafId);
    }
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('keydown', this.handleKeyDown, true);
    window.removeEventListener('blur', this.handleWindowBlur);
    g.captureTarget?.removeEventListener('lostpointercapture', this.handleLostCapture as EventListener);
    if (g.captureTarget && typeof (g.captureTarget as Element).releasePointerCapture === 'function') {
      try {
        (g.captureTarget as Element).releasePointerCapture(g.pointerId);
      } catch {
        // 已随 pointerup 自动释放
      }
    }
    this.gesture = null;
  }
}

/** 尺寸软钳制：minSize 与桌面尺寸各自的 rubber band 参数 */
function softClampSize(v: number, min: number, max: number): number {
  if (v < min) return min - rubberBand(min - v, RESIZE_MIN_RUBBER_MAX, RESIZE_MIN_RUBBER_K);
  if (v > max) return max + rubberBand(v - max, RESIZE_MAX_RUBBER_MAX, RESIZE_MAX_RUBBER_K);
  return v;
}
