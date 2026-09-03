/**
 * 吸附区命中检测（主责 P2；O4 打磨；L5 热区对齐 Tahoe）
 *
 * 纯几何函数，在拖动的 rAF 回调内调用（见设计文档 §5.4 / §6.2）：
 * - 四角方形热区 → 四分屏（优先级最高）；角区边长按桌面宽度比例化：
 *   min(SNAP_CORNER_THRESHOLD, width × SNAP_CORNER_WIDTH_RATIO)，
 *   窄桌面下角区不吞掉整条边缘；
 * - 左/右边缘 SNAP_EDGE_THRESHOLD 竖条 → 半屏；
 * - 顶缘 SNAP_EDGE_THRESHOLD 横条 → maximize（Fill，非全屏 Space）；
 *   按住 ⌥ 拖到顶缘 → 上半屏（对齐 macOS Sequoia Option 平铺语义）；
 * - 底缘中段（角区之外）→ 下半屏；
 * - 其余 → null（不吸附）。
 *
 * O4 追加（向后兼容，两参调用行为与旧版完全一致）：
 * - 可选第三参 `activeZone`：当前已命中的区。指针滑出热区但仍在该区的
 *   「滞回扩张区」（热区 + SNAP_ZONE_HYSTERESIS px）内时保持命中，
 *   消除沿边缘拖动时预览的抖动闪烁；命中另一个区（raw 非 null）时立即切换，
 *   不做粘滞——区间切换是用户明确意图，由 SnapPreview 的 morph 平滑呈现。
 *
 * L5：热区对齐 macOS 复刻建议（边 ~24 / 角 ~64 / 滞回 12–16）；
 * 可选第四参 `options.altKey`（⌥）扩大热区，靠近边/角即可出预览。
 */
import type { Size, SnapZone } from './types';

/** 左/右/顶/底边缘热区厚度（px）——对齐 Tahoe 复刻建议 ~24 */
export const SNAP_EDGE_THRESHOLD = 24;
/** 四角热区边长上限（px）——对齐复刻建议 ~64；角优先于边 */
export const SNAP_CORNER_THRESHOLD = 64;
/** 角区边长的桌面宽度占比：实际边长 = min(SNAP_CORNER_THRESHOLD, W × ratio) */
export const SNAP_CORNER_WIDTH_RATIO = 0.05;
/** 滞回扩张厚度（px）：已命中区在原热区外再宽容这么多才脱离 */
export const SNAP_ZONE_HYSTERESIS = 14;

/**
 * ⌥ 加速平铺：边缘热区扩大倍数（相对 SNAP_EDGE_THRESHOLD）。
 * 按住 Option/Alt 时不必贴死边缘即可出高亮。
 */
export const SNAP_ALT_EDGE_SCALE = 2;
/** ⌥ 加速平铺：角区扩大倍数（相对 SNAP_CORNER_THRESHOLD） */
export const SNAP_ALT_CORNER_SCALE = 1.5;

export interface SnapPoint {
  x: number;
  y: number;
}

export interface SnapHitOptions {
  /** 按住 ⌥/Alt 时扩大热区（Tahoe「Hold Option while dragging to tile」） */
  altKey?: boolean;
}

/** 角热区边长（px）：按桌面宽度比例化，宽桌面封顶 SNAP_CORNER_THRESHOLD */
export function snapCornerThreshold(desktopWidth: number): number {
  return Math.min(
    SNAP_CORNER_THRESHOLD,
    Math.round(Math.max(0, desktopWidth) * SNAP_CORNER_WIDTH_RATIO),
  );
}

function thresholds(desktopWidth: number, altKey: boolean): { edge: number; corner: number } {
  const corner = snapCornerThreshold(desktopWidth);
  if (!altKey) {
    return { edge: SNAP_EDGE_THRESHOLD, corner };
  }
  return {
    edge: Math.round(SNAP_EDGE_THRESHOLD * SNAP_ALT_EDGE_SCALE),
    corner: Math.round(corner * SNAP_ALT_CORNER_SCALE),
  };
}

/** 基础命中（无滞回） */
function rawHitTest(pointer: SnapPoint, desktopSize: Size, altKey: boolean): SnapZone {
  const { x, y } = pointer;
  const W = desktopSize.w;
  const H = desktopSize.h;
  const { edge, corner } = thresholds(W, altKey);

  const nearLeft = x <= corner;
  const nearRight = x >= W - corner;
  const nearTop = y <= corner;
  const nearBottom = y >= H - corner;

  // 四角优先（corner 方形区）
  if (nearLeft && nearTop) return 'tl';
  if (nearRight && nearTop) return 'tr';
  if (nearLeft && nearBottom) return 'bl';
  if (nearRight && nearBottom) return 'br';

  // 左右边缘 → 半屏
  if (x <= edge) return 'left';
  if (x >= W - edge) return 'right';

  // 顶缘 → maximize（Fill）；⌥ 拖顶缘 → 上半屏（Sequoia Option 平铺）
  if (y <= edge) return altKey ? 'top-half' : 'top-maximize';

  // 底缘中段（角区之外）→ 下半屏
  if (y >= H - edge) return 'bottom-half';

  return null;
}

/** 指针是否仍在 activeZone 的滞回扩张区内 */
function withinHysteresis(
  pointer: SnapPoint,
  desktopSize: Size,
  zone: Exclude<SnapZone, null>,
  altKey: boolean,
): boolean {
  const { x, y } = pointer;
  const W = desktopSize.w;
  const H = desktopSize.h;
  const { edge, corner } = thresholds(W, altKey);
  const cornerH = corner + SNAP_ZONE_HYSTERESIS;
  const edgeH = edge + SNAP_ZONE_HYSTERESIS;

  switch (zone) {
    case 'tl':
      return x <= cornerH && y <= cornerH;
    case 'tr':
      return x >= W - cornerH && y <= cornerH;
    case 'bl':
      return x <= cornerH && y >= H - cornerH;
    case 'br':
      return x >= W - cornerH && y >= H - cornerH;
    case 'left':
      return x <= edgeH;
    case 'right':
      return x >= W - edgeH;
    case 'top-maximize':
    case 'top-half':
      return y <= edgeH;
    case 'bottom-half':
      return y >= H - edgeH;
    default:
      return false;
  }
}

export function hitTestSnapZone(
  pointer: SnapPoint,
  desktopSize: Size,
  activeZone?: SnapZone,
  options?: SnapHitOptions,
): SnapZone {
  const { x, y } = pointer;
  const W = desktopSize.w;
  const H = desktopSize.h;
  const altKey = options?.altKey === true;

  // 桌面外（含负坐标）不吸附——指针捕获期间可能移出桌面区域
  if (x < 0 || y < 0 || x > W || y > H) return null;

  const raw = rawHitTest(pointer, desktopSize, altKey);
  if (raw !== null || !activeZone) return raw;
  // top-half 的语义依赖 ⌥。修饰键在滞回带内切换时，不能把旧语义粘住：
  // 松开 ⌥ 应退回 Fill，按下 ⌥ 应切到上半屏。raw 已命中时由上方直接切换；
  // 这里只处理刚脱离基础热区、仍处于滞回扩张区的帧。
  const hysteresisZone =
    activeZone === 'top-half' && !altKey
      ? 'top-maximize'
      : activeZone === 'top-maximize' && altKey
        ? 'top-half'
        : activeZone;
  // raw 脱离但仍在已命中区的滞回带内 → 保持，防止边缘抖动闪烁
  return withinHysteresis(pointer, desktopSize, hysteresisZone, altKey)
    ? hysteresisZone
    : null;
}
