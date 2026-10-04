/**
 * 画布容器尺寸变化时让视口跟随（2026-10 修复「导图窗口平铺后画布空白」）。
 *
 * ReactFlow 只在挂载 / 布局变化时 fitView 一次，容器之后变尺寸（工作台窗口
 * floating → 四分之一平铺、agent 的 tileAll、分栏拖拽）视口 transform 原封不动：
 * 按大窗口算出的 translate 在小容器里会把整张图推到可视区外，叠加
 * onlyRenderVisibleElements 剔除后 `.react-flow__node` 为 0，MiniMap 却仍画出全部节点。
 *
 * 策略：
 * - 视口仍是上次自动 fit 的结果（用户未平移/缩放）→ 尺寸稳定后重新 fit；
 * - 用户已手动调整过视口 → 只做中心锚定（保持原来位于可视区中心的内容仍居中），
 *   不擅自改缩放。
 * 两种情况都会先立即做中心锚定，拖拽改尺寸过程中内容不会滑出可视区。
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

export interface FollowViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ContainerSize {
  width: number;
  height: number;
}

/** 尺寸稳定后再重新 fit，避免窗口拖拽缩放 / 平铺过渡期间逐帧整图 fit */
export const RESIZE_REFIT_DEBOUNCE_MS = 150;

const POSITION_EPSILON = 0.5;
const ZOOM_EPSILON = 1e-4;

/** 容器从 prev 变为 next 时平移视口，使原可视区中心的内容仍位于新可视区中心 */
export function anchorViewportToResize(
  viewport: FollowViewport,
  prev: ContainerSize,
  next: ContainerSize,
): FollowViewport {
  return {
    x: viewport.x + (next.width - prev.width) / 2,
    y: viewport.y + (next.height - prev.height) / 2,
    zoom: viewport.zoom,
  };
}

export function viewportsMatch(a: FollowViewport | null, b: FollowViewport | null): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= POSITION_EPSILON &&
    Math.abs(a.y - b.y) <= POSITION_EPSILON &&
    Math.abs(a.zoom - b.zoom) <= ZOOM_EPSILON
  );
}

export interface ViewportFollowAdapter {
  getViewport: () => FollowViewport;
  setViewport: (viewport: FollowViewport) => void;
  /** 整图重新 fit；画布暂不可 fit（隐藏/零尺寸）时返回 false */
  refit: () => boolean;
}

export interface UseViewportFollowContainerResizeOptions {
  containerRef: RefObject<HTMLElement | null>;
  adapter: ViewportFollowAdapter;
  /** 画布就绪且有节点时才调整视口（尺寸基线始终跟踪） */
  enabled: boolean;
  /**
   * 最近一次自动 fit 落定后的视口（由调用方在 fitView 完成时写入）。
   * 当前视口与之相同 = 用户尚未手动调整，容器变尺寸后应重新 fit。
   */
  autoFitViewportRef: MutableRefObject<FollowViewport | null>;
}

function measure(element: HTMLElement | null): ContainerSize | null {
  if (!element) return null;
  // offsetWidth/Height 是布局尺寸，不受窗口开合动画的 transform: scale 影响（与 ReactFlow 一致）
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  if (!(width > 1) || !(height > 1)) return null;
  return { width, height };
}

export function useViewportFollowContainerResize({
  containerRef,
  adapter,
  enabled,
  autoFitViewportRef,
}: UseViewportFollowContainerResizeOptions): void {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    // 最近一次有效（可见、非零）尺寸：隐藏期间不覆盖，恢复可见时以它为锚定基线
    let lastSize = measure(element);
    let refitTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefit = () => {
      if (refitTimer !== null) clearTimeout(refitTimer);
      refitTimer = setTimeout(() => {
        refitTimer = null;
        if (!enabledRef.current) return;
        const current = adapterRef.current.getViewport();
        // 防抖期间用户动过画布：尊重用户视口，不再整图 fit
        if (!viewportsMatch(current, autoFitViewportRef.current)) return;
        adapterRef.current.refit();
      }, RESIZE_REFIT_DEBOUNCE_MS);
    };

    const handleResize = () => {
      if (window.document.visibilityState === 'hidden') return;
      const next = measure(element);
      if (!next) return;
      const prev = lastSize;
      lastSize = next;
      if (!prev || !enabledRef.current) return;
      if (prev.width === next.width && prev.height === next.height) return;

      const { getViewport, setViewport } = adapterRef.current;
      const current = getViewport();
      const stillAutoFit = viewportsMatch(current, autoFitViewportRef.current);
      const anchored = anchorViewportToResize(current, prev, next);
      setViewport(anchored);
      if (stillAutoFit) {
        // 锚定是我们自己的程序化调整，不算用户改动：同步期望视口，尺寸稳定后重新 fit
        autoFitViewportRef.current = anchored;
        scheduleRefit();
      } else {
        autoFitViewportRef.current = null;
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (refitTimer !== null) clearTimeout(refitTimer);
    };
  }, [containerRef, autoFitViewportRef]);
}
