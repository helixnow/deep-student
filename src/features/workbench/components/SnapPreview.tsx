/**
 * SnapPreview（O4 精修）— 拖动吸附预览轮廓 + 平铺落位动画协调器
 *
 * 独立 fixed 层（不触碰窗口树），接收当前命中的 SnapZone，
 * 经 zoneToDisplayMode + computeTiledFrame 计算落位轮廓。
 *
 * 视觉（SnapPreview.css，wb-snap-* 前缀）：
 * - 双层结构：外层只管几何（inline transform/width/height），内层承载
 *   描边 + 玻璃填充 + 圆角 + 顶缘高光；淡入淡出由 data-wb-snap-visible 驱动 CSS；
 * - 圆角随目标：margin=0（平铺间距关闭）时目标窗口贴边，预览圆角收紧；
 * - 命中不同区时平滑 morph：FLIP（transform-only）——外层先一帧回到旧几何
 *   的反演 transform，下一帧过渡回新几何，全程不动画布局属性；
 * - 离开热区后按 --wb-motion-quick 淡出再卸载；全部时长走 token，
 *   reduced-motion/minimal 归零。
 *
 * 落位动画（O4，"平铺落位用 spring 曲线过渡"）：
 * - 订阅 windowStore，检测窗口 displayMode 进入 tiled/maximized；
 * - 记录变更前的 DOM 几何（拖拽位置只存在于 inline transform，store 里没有），
 *   等 React 提交新布局后，用 buildTileSettleKeyframes 的 spring 采样跑一段
 *   WAAPI FLIP（transform-only，fill:none，结束后自动让位给 inline 样式）；
 * - 用户中途按下窗口立即取消动画；reduced-motion / minimal 档直接跳过。
 */
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import './SnapPreview.css';
import type { Frame, SnapZone } from '../core/types';
import {
  buildTileSettleKeyframes,
  computeTiledFrame,
  getTilingRatioForWindow,
  isTiledMode,
  zoneToDisplayMode,
  DEFAULT_TILE_MARGIN,
} from '../core/tiling';
import { beginInteraction, endInteraction } from '../core/interactionTrace';
import { beginShellSettling, endShellSettling } from '../core/shellGestureFlags';
import { useWindowStore } from '../core/windowStore';
import {
  getActiveSnapZone,
  subscribeActiveSnapZone,
} from '../core/snapZoneStore';

/** 淡出卸载兜底（与 --wb-snap-fade-duration / --wb-motion-quick 对齐，含余量） */
const FADE_UNMOUNT_FALLBACK_MS = 100;
/** 落位 spring 动画时长（L2：打开 WAAPI settle；RM/minimal 仍瞬时） */
export const TILE_SETTLE_DURATION_MS = 280;

/** reduced-motion / minimal 材质档 → 所有 O4 动效直接跳过 */
function prefersInstantMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.getAttribute('data-wb-material') === 'minimal') return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

function parseCssDurationMs(raw: string): number | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.endsWith('ms')) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v.endsWith('s')) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** 读 --wb-snap-fade-duration / --wb-motion-quick；归零档返回 0 */
function getSnapFadeMs(el?: Element | null): number {
  if (prefersInstantMotion()) return 0;
  const probe = el ?? document.documentElement;
  try {
    const fromLocal = parseCssDurationMs(
      getComputedStyle(probe).getPropertyValue('--wb-snap-fade-duration'),
    );
    if (fromLocal != null) return Math.max(0, fromLocal);
  } catch { /* ignore */ }
  try {
    const fromToken = parseCssDurationMs(
      getComputedStyle(document.documentElement).getPropertyValue('--wb-motion-quick'),
    );
    if (fromToken != null) return Math.max(0, fromToken);
  } catch { /* ignore */ }
  return 150;
}

// ---------------------------------------------------------------------------
// 落位 settle 引擎（模块级：跨 SnapPreview 重挂载保持每窗至多一个动画）
// ---------------------------------------------------------------------------

const settleAnimations = new Map<string, Animation>();

function cancelSettle(windowId: string): void {
  const anim = settleAnimations.get(windowId);
  if (anim) {
    settleAnimations.delete(windowId);
    anim.cancel();
  }
}

function runTileSettle(windowId: string, el: HTMLElement, from: Frame, to: Frame): boolean {
  // 时长为 0：瞬时落位，无「放下」FLIP
  if (TILE_SETTLE_DURATION_MS <= 0 || prefersInstantMotion()) return false;
  // 微位移：跳过动画，避免无意义 WAAPI + 采样噪声
  const dx = Math.abs(from.x - to.x);
  const dy = Math.abs(from.y - to.y);
  const dw = Math.abs(from.w - to.w);
  const dh = Math.abs(from.h - to.h);
  if (dx + dy + dw + dh < 2) return false;

  const keyframes = buildTileSettleKeyframes(from, to);
  if (!keyframes) return false;

  cancelSettle(windowId);

  // FLIP 的 scale 分量按左上角锚定；结束后恢复原 transform-origin
  const prevOrigin = el.style.transformOrigin;
  el.style.transformOrigin = '0 0';

  let anim: Animation;
  try {
    anim = el.animate(keyframes as Keyframe[], {
      duration: TILE_SETTLE_DURATION_MS,
      easing: 'linear', // spring 已烘焙进采样 keyframes
      fill: 'none',
    });
  } catch (error) {
    el.style.transformOrigin = prevOrigin;
    console.warn('[SnapPreview] tile settle animation failed:', error);
    return false;
  }
  beginInteraction({ kind: 'snap.settle', windowId });
  settleAnimations.set(windowId, anim);

  // 用户中途抓取窗口 → 立刻取消，让位给指针引擎的直写 transform
  const onGrab = (): void => cancelSettle(windowId);
  el.addEventListener('pointerdown', onGrab);

  let cleaned = false;
  const cleanup = (cancelled: boolean): void => {
    if (cleaned) return;
    cleaned = true;
    el.removeEventListener('pointerdown', onGrab);
    el.style.transformOrigin = prevOrigin;
    if (settleAnimations.get(windowId) === anim) settleAnimations.delete(windowId);
    endInteraction({ cancelled });
    endShellSettling();
  };
  anim.addEventListener('finish', () => cleanup(false));
  anim.addEventListener('cancel', () => cleanup(true));
  return true;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export interface SnapPreviewProps {
  /** @deprecated 改由 snapZoneStore 订阅；传入时仅作初始/测试覆盖 */
  zone?: SnapZone;
  /** 平铺间距，缺省 DEFAULT_TILE_MARGIN（设置读取由 Desktop 接线） */
  margin?: number;
  /** 桌面区左上角相对视口的偏移（fixed 定位换算），缺省 (0,0) */
  desktopOffset?: { x: number; y: number };
}

const SnapPreviewComponent: React.FC<SnapPreviewProps> = ({
  zone: zoneProp,
  margin = DEFAULT_TILE_MARGIN,
  desktopOffset,
}) => {
  const storeZone = useSyncExternalStore(
    subscribeActiveSnapZone,
    getActiveSnapZone,
    () => null,
  );
  const zone = zoneProp !== undefined ? zoneProp : storeZone;
  const desktopSize = useWindowStore((s) => s.desktopSize);

  // zone → null 时保留最后一个 frame 做 fade-out
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const elRef = useRef<HTMLDivElement | null>(null);
  const lastFrameRef = useRef<Frame | null>(null);
  /** 当前已提交到 DOM 的几何（morph 的 FLIP 起点） */
  const paintedFrameRef = useRef<Frame | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mode = zoneToDisplayMode(zone);
  const frame = mode ? computeTiledFrame(mode, { desktopSize, margin }) : null;
  if (frame) lastFrameRef.current = frame;

  useEffect(() => {
    if (zone !== null) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setMounted(true);
      // 两帧后再置 visible，确保初次挂载走 0→1 的 fade-in 过渡
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const fadeMs = getSnapFadeMs(elRef.current);
    const wait = fadeMs > 0 ? Math.max(fadeMs, FADE_UNMOUNT_FALLBACK_MS) : 0;
    hideTimerRef.current = setTimeout(() => {
      setMounted(false);
      paintedFrameRef.current = null;
      hideTimerRef.current = null;
    }, wait);
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [zone]);

  const renderFrame = frame ?? lastFrameRef.current;
  const offsetX = desktopOffset?.x ?? 0;
  const offsetY = desktopOffset?.y ?? 0;

  // ---- zone 间平滑 morph（FLIP，仅 transform 参与过渡）----
  const rx = renderFrame?.x ?? 0;
  const ry = renderFrame?.y ?? 0;
  const rw = renderFrame?.w ?? 0;
  const rh = renderFrame?.h ?? 0;
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || rw <= 0 || rh <= 0) return undefined;
    const prev = paintedFrameRef.current;
    const next: Frame = { x: rx, y: ry, w: rw, h: rh };
    paintedFrameRef.current = next;
    if (!prev || (prev.x === rx && prev.y === ry && prev.w === rw && prev.h === rh)) {
      return undefined;
    }
    if (prefersInstantMotion()) return undefined;
    // First(prev) → Invert：写反演 transform；用双 rAF 代替 getBoundingClientRect 强制同步布局
    const sx = prev.w / rw;
    const sy = prev.h / rh;
    el.style.transition = 'none';
    el.style.transform = `translate3d(${prev.x + offsetX}px, ${prev.y + offsetY}px, 0) scale(${sx}, ${sy})`;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      // Play：下一帧恢复 CSS 类过渡并落到新几何（勿写回 inline transition，避免与 opacity 冲突）
      raf2 = requestAnimationFrame(() => {
        el.style.removeProperty('transition');
        el.style.transform = `translate3d(${rx + offsetX}px, ${ry + offsetY}px, 0)`;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [rx, ry, rw, rh, offsetX, offsetY]);

  // ---- 平铺落位 spring 动画（displayMode 进入 tiled/maximized 时触发）----
  const settleCtxRef = useRef({ margin, offsetX, offsetY });
  settleCtxRef.current = { margin, offsetX, offsetY };
  useEffect(() => {
    type PendingSettle = {
      id: string;
      el: HTMLElement;
      from: Frame;
      to: Frame;
      focusAt: number;
    };
    let pending: PendingSettle[] = [];
    let flushRaf1 = 0;
    let flushRaf2 = 0;
    let pendingSettling = false;

    const releasePendingSettling = () => {
      if (!pendingSettling) return;
      pendingSettling = false;
      endShellSettling();
    };

    const flushSettles = () => {
      flushRaf1 = 0;
      flushRaf2 = 0;
      if (pending.length === 0) {
        releasePendingSettling();
        return;
      }
      // 同帧多窗：只动画最近聚焦的一扇，其余瞬时落位（避免并发 WAAPI 叠帧）
      pending.sort((a, b) => b.focusAt - a.focusAt);
      const [primary, ...rest] = pending;
      pending = [];
      for (const extra of rest) {
        cancelSettle(extra.id);
      }
      if (!primary || !primary.el.isConnected) {
        releasePendingSettling();
        return;
      }
      if (runTileSettle(primary.id, primary.el, primary.from, primary.to)) {
        // The animation cleanup now owns this beginShellSettling call.
        pendingSettling = false;
      } else {
        releasePendingSettling();
      }
    };

    const scheduleFlush = () => {
      if (flushRaf1 || flushRaf2) return;
      // Mark the handoff before React commits the tiled frame. Native child
      // surfaces must be hidden before the two-rAF FLIP measurement window.
      beginShellSettling();
      pendingSettling = true;
      // 等 React 提交新布局后再 FLIP
      flushRaf1 = requestAnimationFrame(() => {
        flushRaf1 = 0;
        flushRaf2 = requestAnimationFrame(() => {
          flushRaf2 = 0;
          flushSettles();
        });
      });
    };

    const unsubscribe = useWindowStore.subscribe((state, prev) => {
      if (state.windows === prev.windows) return;
      const ctx = settleCtxRef.current;
      let added = false;
      for (const id of Object.keys(state.windows)) {
        const cur = state.windows[id];
        const before = prev.windows[id];
        if (!before || !cur) continue;
        if (cur.displayMode === before.displayMode) continue;
        if (!isTiledMode(cur.displayMode) || cur.minimized) continue;
        if (prefersInstantMotion()) continue;

        const selector = `[data-wb-window-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id}"]`;
        const el = document.querySelector<HTMLElement>(selector);
        if (!el || typeof el.animate !== 'function') continue;

        // 变更前几何必须在 React 提交前同步读取（拖拽位置只在 inline transform）。
        // batchSetDisplayModes 保证同帧多窗只触发一次订阅，避免 N 次强制布局。
        const rect = el.getBoundingClientRect();
        const from: Frame = {
          x: rect.left - ctx.offsetX,
          y: rect.top - ctx.offsetY,
          w: rect.width,
          h: rect.height,
        };
        const to = computeTiledFrame(cur.displayMode, {
          desktopSize: state.desktopSize,
          margin: cur.displayMode === 'maximized' ? 0 : ctx.margin,
          ratio:
            cur.displayMode === 'tiled-left' || cur.displayMode === 'tiled-right'
              ? getTilingRatioForWindow(state.windows, state.tilingRatios, id)
              : undefined,
        });
        if (!to) continue;
        // 同 id 后写覆盖前写
        pending = pending.filter((p) => p.id !== id);
        pending.push({ id, el, from, to, focusAt: cur.lastFocusedAt });
        added = true;
      }
      if (added) scheduleFlush();
    });
    return () => {
      unsubscribe();
      if (flushRaf1) cancelAnimationFrame(flushRaf1);
      if (flushRaf2) cancelAnimationFrame(flushRaf2);
      releasePendingSettling();
    };
  }, []);

  if (!mounted || !renderFrame) return null;

  return (
    <div
      ref={elRef}
      className="wb-snap-preview wb-snap-skin"
      data-testid="wb-snap-preview"
      data-zone={zone ?? ''}
      data-wb-snap-visible={visible ? 'true' : 'false'}
      data-wb-snap-flush={margin === 0 ? 'true' : undefined}
      aria-hidden="true"
      style={{
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: 'var(--wb-z-snap-preview)',
        width: renderFrame.w,
        height: renderFrame.h,
        transform: `translate3d(${renderFrame.x + offsetX}px, ${renderFrame.y + offsetY}px, 0)`,
      }}
    >
      <div className="wb-snap-inner" />
    </div>
  );
};

export const SnapPreview = React.memo(SnapPreviewComponent);
SnapPreview.displayName = 'SnapPreview';

export default SnapPreview;
