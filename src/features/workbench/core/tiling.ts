/**
 * 平铺几何（主责 P2 — 完整版）
 *
 * computeTiledFrame 是 Desktop / WindowShell / TileMenu 共同消费的纯函数（签名冻结）。
 *
 * 几何模型（margin = m）：
 * - maximized：填满整个桌面（不留 margin，对标 macOS「填满」）；
 * - 左右平铺：外缘各留 m，两窗之间留 m，可用宽 = W - 3m，按 ratio 分配（0.2–0.8）；
 * - 四分屏：水平/垂直方向均按上述规则二分（列宽固定 0.5，ratio 仅作用于左右平铺对）。
 *
 * 不变量（任意 margin / ratio / 桌面尺寸下成立，配套测试覆盖）：
 * - left.x + left.w + m === right.x；right.x + right.w + m === W；
 * - 四分屏同理在两个轴向上互补，不重叠、不超界。
 */
import type {
  DisplayMode,
  Frame,
  SnapZone,
  TilingContext,
  WorkbenchWindow,
} from './types';

/** 平铺间距默认值（px），对标 macOS Sequoia "Tiled windows have margins" 默认开 */
export const DEFAULT_TILE_MARGIN = 8;
/** 左右平铺分割比下限 */
export const MIN_TILING_RATIO = 0.2;
/** 左右平铺分割比上限 */
export const MAX_TILING_RATIO = 0.8;
/** 中缝拖动的边界软区宽度（ratio 单位）：进入软区后指数阻尼逼近上下限（O4） */
export const TILING_RATIO_SOFT_ZONE = 0.05;

/** 分割比 clamp 到 [0.2, 0.8]；非法值（NaN/Infinity）回退 0.5 */
export function clampTilingRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_TILING_RATIO, Math.max(MIN_TILING_RATIO, ratio));
}

/**
 * 带边界阻尼的分割比映射（O4，中缝拖动手感）。
 *
 * - [MIN+soft, MAX-soft] 区间线性直通（与 clampTilingRatio 一致）；
 * - 越过软区起点后按指数衰减逼近 MIN/MAX（rubber-band 阻尼：越推越"重"，
 *   永不越界），在软区边界处 C¹ 连续（值与斜率都无跳变）；
 * - 输出恒落在 (MIN, MAX) 内，可直接入快照；非法值回退 0.5。
 */
export function softClampTilingRatio(raw: number): number {
  if (!Number.isFinite(raw)) return 0.5;
  const s = TILING_RATIO_SOFT_ZONE;
  const lower = MIN_TILING_RATIO + s;
  const upper = MAX_TILING_RATIO - s;
  if (raw < lower) return MIN_TILING_RATIO + s * Math.exp((raw - lower) / s);
  if (raw > upper) return MAX_TILING_RATIO - s * Math.exp((upper - raw) / s);
  return raw;
}

/** 是否为受管（平铺/最大化）显示模式——落位动画等消费的纯谓词（O4） */
export function isTiledMode(mode: DisplayMode): boolean {
  return mode !== 'floating';
}

/** 快照 tilingRatios 的 key（见 WorkbenchSnapshotV1）：`${leftWindowId}:${rightWindowId}` */
export function tilingPairKey(leftWindowId: string, rightWindowId: string): string {
  return `${leftWindowId}:${rightWindowId}`;
}

export interface ActiveTilingPair {
  left: WorkbenchWindow;
  right: WorkbenchWindow;
  key: string;
}

// 按 windows 引用的单槽缓存（模式同 windowListCache）：每个 WindowShell 都经
// getTilingRatioForWindow 订阅本函数，每次 store.set 对每窗跑一遍全量遍历
// 会放大成 O(N²)；同一引用只算一次即回到 O(N)。store 从不原地改 windows，
// 引用相等 ⇒ 内容相等。
let pairCacheInput:
  | Record<string, WorkbenchWindow>
  | readonly WorkbenchWindow[]
  | null = null;
let pairCacheValue: ActiveTilingPair | null = null;

/**
 * 当前可交互的左右平铺对。桌面允许同一侧暂存多扇窗口（例如先后吸附），
 * 视觉上真正组成一对的是左右两侧各自 zIndex 最高且未最小化的窗口。
 */
export function getActiveTilingPair(
  windows: Record<string, WorkbenchWindow> | readonly WorkbenchWindow[],
): ActiveTilingPair | null {
  if (windows === pairCacheInput) return pairCacheValue;
  const list = Array.isArray(windows) ? windows : Object.values(windows);
  let left: WorkbenchWindow | undefined;
  let right: WorkbenchWindow | undefined;
  for (const win of list) {
    if (win.minimized) continue;
    if (win.displayMode === 'tiled-left' && (!left || win.zIndex > left.zIndex)) left = win;
    if (win.displayMode === 'tiled-right' && (!right || win.zIndex > right.zIndex)) right = win;
  }
  pairCacheInput = windows;
  pairCacheValue = left && right
    ? { left, right, key: tilingPairKey(left.id, right.id) }
    : null;
  return pairCacheValue;
}

/** 仅供测试：清空 active pair 缓存 */
export function resetActiveTilingPairCacheForTests(): void {
  pairCacheInput = null;
  pairCacheValue = null;
}

/**
 * 是否存在「可见的最大化窗口」（未最小化的 maximized）。
 * agent manifest 等布局语义消费；Dock 强制自动隐藏改由
 * hasDockObstructedWindow 判定（覆盖平铺触底场景）。
 */
export function hasVisibleMaximizedWindow(
  windows: Record<string, WorkbenchWindow> | readonly WorkbenchWindow[],
): boolean {
  const list = Array.isArray(windows) ? windows : Object.values(windows);
  for (const win of list) {
    if (!win.minimized && win.displayMode === 'maximized') return true;
  }
  return false;
}

/** 铺到桌面底缘的受管模式（computeTiledFrame 中高度触底），会被悬浮 Dock 遮挡 */
const BOTTOM_REACHING_MODES: readonly DisplayMode[] = [
  'maximized',
  'tiled-left',
  'tiled-right',
  'tiled-bl',
  'tiled-br',
];

/**
 * 是否存在「铺到底缘、会被 Dock 遮住内容」的可见受管窗口。
 * Dock 强制自动隐藏的唯一判定源：最大化窗口之外，左右平铺与下半四分屏
 * 的高度同样延伸到桌面底部（仅留 tile margin），Dock 悬浮其上会挡住
 * 窗口内容，因此一并强制收起（弹出/收起仍走 Dock 自身热区机制）。
 * 上半四分屏（tiled-tl/tr）与 floating 不触底，不触发。
 */
export function hasDockObstructedWindow(
  windows: Record<string, WorkbenchWindow> | readonly WorkbenchWindow[],
): boolean {
  const list = Array.isArray(windows) ? windows : Object.values(windows);
  for (const win of list) {
    if (!win.minimized && BOTTOM_REACHING_MODES.includes(win.displayMode)) return true;
  }
  return false;
}

/** 仅当前左右配对共享其 ratio；被遮在同侧后方的窗口使用默认 50/50。 */
export function getTilingRatioForWindow(
  windows: Record<string, WorkbenchWindow> | readonly WorkbenchWindow[],
  ratios: Record<string, number>,
  windowId: string,
): number | undefined {
  const pair = getActiveTilingPair(windows);
  if (!pair || (pair.left.id !== windowId && pair.right.id !== windowId)) return undefined;
  return clampTilingRatio(ratios[pair.key] ?? 0.5);
}

/** 吸附区 → 显示模式（松手落位 / SnapPreview 共用） */
export function zoneToDisplayMode(zone: SnapZone): DisplayMode | null {
  switch (zone) {
    case 'left':
      return 'tiled-left';
    case 'right':
      return 'tiled-right';
    case 'tl':
      return 'tiled-tl';
    case 'tr':
      return 'tiled-tr';
    case 'bl':
      return 'tiled-bl';
    case 'br':
      return 'tiled-br';
    case 'top-maximize':
      return 'maximized';
    default:
      return null;
  }
}

export function computeTiledFrame(mode: DisplayMode, ctx: TilingContext): Frame | null {
  const { desktopSize } = ctx;
  const W = desktopSize.w;
  const H = desktopSize.h;
  const m = Math.max(0, ctx.margin);
  const ratio = clampTilingRatio(ctx.ratio ?? 0.5);

  if (mode === 'floating') return null;
  if (mode === 'maximized') return { x: 0, y: 0, w: W, h: H };

  // 左右平铺可用空间：外缘 2 个 margin + 中缝 1 个 margin
  const availW = Math.max(0, W - m * 3);
  const availH = Math.max(0, H - m * 3);
  const fullH = Math.max(0, H - m * 2);

  // 左右平铺对：ratio 分配
  const leftW = Math.round(availW * ratio);
  const rightW = availW - leftW;
  const rightX = m * 2 + leftW;

  // 四分屏：固定 0.5 二分（ratio 仅作用于 tiled-left/right 对）
  const colW = Math.round(availW * 0.5);
  const colRightW = availW - colW;
  const colRightX = m * 2 + colW;
  const rowH = Math.round(availH * 0.5);
  const rowBottomH = availH - rowH;
  const rowBottomY = m * 2 + rowH;

  switch (mode) {
    case 'tiled-left':
      return { x: m, y: m, w: leftW, h: fullH };
    case 'tiled-right':
      return { x: rightX, y: m, w: rightW, h: fullH };
    case 'tiled-tl':
      return { x: m, y: m, w: colW, h: rowH };
    case 'tiled-tr':
      return { x: colRightX, y: m, w: colRightW, h: rowH };
    case 'tiled-bl':
      return { x: m, y: rowBottomY, w: colW, h: rowBottomH };
    case 'tiled-br':
      return { x: colRightX, y: rowBottomY, w: colRightW, h: rowBottomH };
    default:
      return null;
  }
}

// ============================================================================
// 落位 spring FLIP 采样（O4）
// ----------------------------------------------------------------------------
// 平铺/最大化落位的过渡动画：以目标 frame 为基准，把「起始 frame → 目标 frame」
// 表达为 transform-only 的 FLIP（translate + scale 从反演值回到 identity）。
// 缓动使用欠阻尼 spring 采样（对齐 O1 动效语言的 spring 手感），产出可直接
// 交给 WAAPI `element.animate` 的 keyframes。纯函数，无 DOM 依赖。
// ============================================================================

/** 落位 spring 参数（欠阻尼：轻微 overshoot 后稳定） */
export interface TileSettleSpringOptions {
  /** 阻尼比 ζ（<1 欠阻尼），默认 0.82 —— 轻微回弹不夸张 */
  dampingRatio?: number;
  /** 采样帧数（keyframes 数量），默认 16 */
  samples?: number;
}

/** 欠阻尼 spring 归一化响应：p(0)=0，p(1)≈1（末帧强制收敛到 1） */
export function sampleSpringProgress(options?: TileSettleSpringOptions): number[] {
  const zeta = Math.min(0.99, Math.max(0.3, options?.dampingRatio ?? 0.82));
  const n = Math.max(2, Math.round(options?.samples ?? 16));
  // 归一化时间域 [0,1]；omega 取值使响应在 t=1 处已基本稳定
  const omega = 12;
  const omegaD = omega * Math.sqrt(1 - zeta * zeta);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const decay = Math.exp(-zeta * omega * t);
    const p = 1 - decay * (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t));
    out.push(i === n - 1 ? 1 : p);
  }
  return out;
}

/**
 * 构建「from → to」的 FLIP settle keyframes（transform-only）。
 *
 * 语义：调用方已把元素布局到 `to`（React 提交后），动画从 `from` 的反演
 * transform 过渡回 identity。translate 分量为两 frame 左上角差值，scale 分量
 * 为宽高比值；spring 采样带来轻微 overshoot（p>1 时越过 identity 再回弹）。
 * from/to 面积为 0 或几何相同时返回 null（无需动画）。
 */
export function buildTileSettleKeyframes(
  from: Frame,
  to: Frame,
  options?: TileSettleSpringOptions,
): Array<{ transform: string; offset: number }> | null {
  if (to.w <= 0 || to.h <= 0 || from.w <= 0 || from.h <= 0) return null;
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const sx = from.w / to.w;
  const sy = from.h / to.h;
  if (dx === 0 && dy === 0 && sx === 1 && sy === 1) return null;

  const progress = sampleSpringProgress(options);
  const last = progress.length - 1;
  return progress.map((p, i) => {
    const tx = dx * (1 - p);
    const ty = dy * (1 - p);
    const kx = sx + (1 - sx) * p;
    const ky = sy + (1 - sy) * p;
    return {
      // 精度截断到 0.01px / 0.0001 scale，避免超长小数串
      transform: `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${kx.toFixed(4)}, ${ky.toFixed(4)})`,
      offset: i / last,
    };
  });
}
