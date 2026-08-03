/**
 * 吸附区命中检测（主责 P2；O4 打磨；L5 热区对齐 Tahoe）
 *
 * 纯几何函数，在拖动的 rAF 回调内调用（见设计文档 §5.4 / §6.2）：
 * - 四角 SNAP_CORNER_THRESHOLD 方形热区 → 四分屏（优先级最高）；
 * - 左/右边缘 SNAP_EDGE_THRESHOLD 竖条 → 半屏；
 * - 顶缘 SNAP_EDGE_THRESHOLD 横条 → maximize（Fill，非全屏 Space）；
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
 * 上/下半屏拖拽热区未做：`SnapZone` 无 top/bottom-half 扩展点（见 COORDINATION）。
 */
import type { Size, SnapZone } from './types';

/** 左/右/顶边缘热区厚度（px）——对齐 Tahoe 复刻建议 ~24 */
export const SNAP_EDGE_THRESHOLD = 24;
/** 四角热区边长（px）——对齐复刻建议 ~64；角优先于边 */
export const SNAP_CORNER_THRESHOLD = 64;
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

function thresholds(altKey: boolean): { edge: number; corner: number } {
  if (!altKey) {
    return { edge: SNAP_EDGE_THRESHOLD, corner: SNAP_CORNER_THRESHOLD };
  }
  return {
    edge: Math.round(SNAP_EDGE_THRESHOLD * SNAP_ALT_EDGE_SCALE),
    corner: Math.round(SNAP_CORNER_THRESHOLD * SNAP_ALT_CORNER_SCALE),
  };
}

/** 基础命中（无滞回） */
function rawHitTest(pointer: SnapPoint, desktopSize: Size, altKey: boolean): SnapZone {
  const { x, y } = pointer;
  const W = desktopSize.w;
  const H = desktopSize.h;
  const { edge, corner } = thresholds(altKey);

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

  // 顶缘 → maximize（Fill）
  if (y <= edge) return 'top-maximize';

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
  const { edge, corner } = thresholds(altKey);
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
      return y <= edgeH;
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
  // raw 脱离但仍在已命中区的滞回带内 → 保持，防止边缘抖动闪烁
  return withinHysteresis(pointer, desktopSize, activeZone, altKey) ? activeZone : null;
}
