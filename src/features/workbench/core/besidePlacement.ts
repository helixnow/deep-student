/**
 * 「开在来源窗旁边」落位（UX 审计 L1）
 *
 * 场景：对话回答里点页码 / 媒体时间戳 → 打开资源窗（阅读器）。默认级联落位会把新窗
 * 盖在刚点的那段回答上。本模块是纯函数：给定来源窗与桌面尺寸，算出资源窗（以及必要时
 * 来源窗）该怎么摆。只在「真的新建」资源窗时使用；资源窗已存在时调用方只聚焦 + 跳转。
 *
 * 规则（W = 桌面宽，m = 平铺间距，能并排 = W − 3m ≥ 来源窗 minW + 资源窗 minW）：
 * 1. 来源窗已在左/右半屏（tiled-left / tiled-right）→ 资源窗进另一半，来源窗不动；
 *    四分屏 / 上下半屏同理取互补的一侧（tl/bl → 右半，tr/br → 左半，top ↔ bottom）。
 * 2. 来源窗浮动：
 *    - 能并排且来源窗整个落在左半（或右半）→ 来源窗不动，资源窗贴在它旁边的空白里；
 *    - 能并排但来源窗横跨中线 → 来源窗进左半屏、资源窗进右半屏（吸附布局；来源窗
 *      原 frame 记在 restoreFrame，拖出半屏即恢复，不丢用户的摆位）；
 *    - 不能并排 → 资源窗贴在来源窗旁空间更大的一侧，尽量少压住来源窗。
 * 3. 来源窗最大化：
 *    - 小桌面（< SMALL_DESKTOP_WIDTH，窗口是被自动最大化的，不是用户选的）且能并排 →
 *      左右半屏；
 *    - 其余情况视为用户主动最大化：不动它，资源窗浮在右半边（不能并排时取资源窗最小宽）。
 * 4. 没有来源窗 / 来源窗已最小化 → 返回 null，走默认级联。
 */
import type { DisplayMode, Frame, Size, WorkbenchWindow } from './types';
import { clampTilingRatio, computeTiledFrame, DEFAULT_TILE_MARGIN } from './tiling';
import { FLOATING_DOCK_CLEARANCE } from './metrics';

/** 与 windowStore 一致：低于此宽度新窗默认最大化 */
export const BESIDE_SMALL_DESKTOP_WIDTH = 1280;

export interface BesidePlacementInput {
  anchor: WorkbenchWindow | null | undefined;
  desktopSize: Size;
  /** 资源窗应用的最小尺寸（未注册时调用方给兜底） */
  resourceMinSize: Size;
  /** 来源窗应用的最小尺寸 */
  anchorMinSize: Size;
  margin?: number;
}

export interface BesidePlacementPlan {
  /** 来源窗需要切换到的显示模式（不切换则缺省） */
  anchorMode?: DisplayMode;
  /** 资源窗显示模式 */
  resourceMode: DisplayMode;
  /** resourceMode === 'floating' 时的落位 frame */
  resourceFrame?: Frame;
  /** 新组成左右平铺对时的左侧占比（保证两侧都不小于各自 minW） */
  ratio?: number;
}

const COMPLEMENT_MODE: Partial<Record<DisplayMode, DisplayMode>> = {
  'tiled-left': 'tiled-right',
  'tiled-right': 'tiled-left',
  'tiled-tl': 'tiled-right',
  'tiled-bl': 'tiled-right',
  'tiled-tr': 'tiled-left',
  'tiled-br': 'tiled-left',
  'tiled-top': 'tiled-bottom',
  'tiled-bottom': 'tiled-top',
};

/** 左右平铺对的左侧占比：默认对半，某一侧放不下其 minW 时往另一侧让 */
function pairRatio(desktopW: number, margin: number, leftMinW: number, rightMinW: number): number {
  const avail = Math.max(1, desktopW - margin * 3);
  let ratio = 0.5;
  if (avail * ratio < leftMinW) ratio = leftMinW / avail;
  if (avail * (1 - ratio) < rightMinW) ratio = 1 - rightMinW / avail;
  return clampTilingRatio(ratio);
}

export function planBesidePlacement(input: BesidePlacementInput): BesidePlacementPlan | null {
  const { anchor, desktopSize } = input;
  if (!anchor || anchor.minimized) return null;
  const W = desktopSize.w;
  const H = desktopSize.h;
  if (!(W > 0) || !(H > 0)) return null;
  const m = Math.max(0, input.margin ?? DEFAULT_TILE_MARGIN);
  const resMinW = Math.min(input.resourceMinSize.w, Math.max(0, W - m * 2));
  const canSplit = W - m * 3 >= input.anchorMinSize.w + input.resourceMinSize.w;
  const floatH = Math.max(input.resourceMinSize.h, H - m - FLOATING_DOCK_CLEARANCE);
  const fullH = Math.min(floatH, Math.max(0, H - m * 2));
  const tileSplit = (): BesidePlacementPlan => {
    const ratio = pairRatio(W, m, input.anchorMinSize.w, input.resourceMinSize.w);
    return {
      anchorMode: 'tiled-left',
      resourceMode: 'tiled-right',
      ...(ratio !== 0.5 ? { ratio } : {}),
    };
  };
  /** 资源窗浮在 [left, right) 这段横向空间里（宽度至少 resMinW，越界时贴边） */
  const floatIn = (left: number, right: number, preferEdge: 'left' | 'right'): BesidePlacementPlan => {
    const w = Math.max(resMinW, Math.min(right - left, W - m * 2));
    const x = preferEdge === 'right'
      ? Math.max(m, Math.min(left, W - m - w))
      : Math.max(m, Math.min(right - w, W - m - w));
    return { resourceMode: 'floating', resourceFrame: { x, y: m, w, h: fullH } };
  };

  const complement = COMPLEMENT_MODE[anchor.displayMode];
  if (complement) return { resourceMode: complement };

  if (anchor.displayMode === 'maximized') {
    if (W < BESIDE_SMALL_DESKTOP_WIDTH && canSplit) return tileSplit();
    if (canSplit) {
      const half = computeTiledFrame('tiled-right', { desktopSize, margin: m });
      if (half) return { resourceMode: 'floating', resourceFrame: { ...half, h: fullH } };
    }
    return floatIn(W - m - resMinW, W - m, 'right');
  }

  // floating
  const a = anchor.frame;
  const aRight = a.x + a.w;
  const mid = W / 2;
  const spaceRight = W - m - (aRight + m);
  const spaceLeft = a.x - m - m;
  if (canSplit) {
    if (aRight <= mid + m && spaceRight >= resMinW) return floatIn(aRight + m, W - m, 'right');
    if (a.x >= mid - m && spaceLeft >= resMinW) return floatIn(m, a.x - m, 'left');
    return tileSplit();
  }
  if (spaceRight >= resMinW) return floatIn(aRight + m, W - m, 'right');
  if (spaceLeft >= resMinW) return floatIn(m, a.x - m, 'left');
  // 两侧都放不下：贴在空间更大的一侧，取最小宽，尽量少压住来源窗
  return spaceRight >= spaceLeft
    ? floatIn(W - m - resMinW, W - m, 'right')
    : floatIn(m, m + resMinW, 'left');
}
