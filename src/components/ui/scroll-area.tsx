import * as React from "react";
import { useOverlayScrollbars } from "overlayscrollbars-react";
import type { EventListeners, PartialOptions } from "overlayscrollbars";

import { cn } from "../../lib/utils";
import { detectScrollPlatform } from "../../lib/scroll-platform";
import { useScrollbarTheme } from "../../lib/scroll-theme";
import {
  detachOverlayNoContentChildRule,
  restoreOverlayNoContentChildRule,
} from "../../lib/scroll-overlay-stylesheet";

/**
 * Unified scroll primitive for DeepStudent (milestone v1.1).
 *
 * Wraps OverlayScrollbars with platform-aware defaults:
 * - iOS WebView → native scrollbars (preserves rubber-band + inertia)
 * - Windows / macOS / Linux → overlay scrollbars synced to app theme
 *
 * Moved from study-ui so DeepStudent can run independently without the
 * `@study-ui` alias. Overlay and native fallback visuals share the contract in
 * src/styles/native-feel/scrollbars.css.
 *
 * ## Migration checklist (when replacing `.custom-scrollbar` or legacy CustomScrollArea)
 * - Do NOT wrap CodeMirror `.cm-scroller`, Crepe/Milkdown editor body,
 *   ProseMirror editors, or Mindmap pan/zoom surface — they manage
 *   their own scroll and will conflict.
 * - When placed inside a Radix Dialog / Popover / Tooltip, add
 *   `onWheel={(e) => e.stopPropagation()}` on the surrounding content
 *   to avoid scroll-lock swallowing wheel events.
 * - Remove any manual `overflow-y-auto` / `overflow-x-auto` from the
 *   viewport — OverlayScrollbars takes over overflow management.
 */

const SCROLL_AREA_NATIVE_CLASS = "scroll-area--native";

type ScrollOrientation = "vertical" | "horizontal" | "both";
type ScrollAutoHideMode = "never" | "scroll" | "leave" | "move";

type TrackOffset = {
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
};

/**
 * 根节点默认 `relative`（滚动条轨道按它定位）。调用方显式给了定位类（absolute / fixed /
 * sticky）时不再追加：项目的 cn 只做拼接、不合并冲突类，而 Tailwind 里 `.relative`
 * 排在 `.absolute` 之后，会把调用方的 absolute 覆盖掉——导图「样式」面板因此退回文档流，
 * 被工具栏垂直居中后向上溢出、顶部压到窗口标题栏下面。
 */
export function scrollAreaRootBase(className?: string): string {
  const hasPosition = /(^|\s)(absolute|fixed|sticky|static)(?=\s|$)/.test(className ?? '');
  return hasPosition ? 'min-h-0 min-w-0' : 'relative min-h-0 min-w-0';
}

export interface ScrollAreaProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  children?: React.ReactNode;
  className?: string;
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Applied to the real scrolling viewport; className is merged with viewportClassName. */
  viewportProps?: React.HTMLAttributes<HTMLDivElement>;
  orientation?: ScrollOrientation;
  /** Hide delay in ms. 0 = always visible. Default 600. */
  scrollHideDelay?: number;
  /** Controls what interaction reveals an overlay scrollbar. */
  scrollAutoHide?: ScrollAutoHideMode;
  /** Keep the scrollbar visible until the first scroll. Default true. */
  scrollAutoHideSuspend?: boolean;
  trackOffset?: TrackOffset;
  /** Override platform default. iOS auto-detects to `true`. */
  nativeScrollbars?: boolean;
  "data-slot"?: string;
}

function formatOffset(value: number | string | undefined): string | undefined {
  if (value == null) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as React.MutableRefObject<T | null>).current = value;
}

/** 任意变体前缀（md: / [&>*]: …）+ 可选 ! + p/px/py/pt/pr/pb/pl/ps/pe 内边距工具类 */
const PADDING_UTILITY_RE = /^(?:[^\s:]+:)*!?p[xytrblse]?-\S+$/;

/**
 * OverlayScrollbars 的样式表以 `[data-overlayscrollbars-viewport]:not([data-overlayscrollbars])
 * { padding: 0 }`（特异性高于单个类）清零视口内边距，再把**宿主**的 padding 以内联样式
 * 搬到视口上。因此调用方写在 viewportClassName 里的 px-5 / pb-20 等会被吞掉、内容贴边。
 * 这里把内边距工具类挪到宿主，交给 OverlayScrollbars 按其设计搬运（响应式变体随宿主
 * 尺寸变化重新读取）；其余类名留在视口。
 */
function splitPaddingClasses(className: string | undefined): { padding: string; rest: string } {
  if (!className) return { padding: "", rest: "" };
  const padding: string[] = [];
  const rest: string[] = [];
  for (const token of className.split(/\s+/)) {
    if (!token) continue;
    (PADDING_UTILITY_RE.test(token) ? padding : rest).push(token);
  }
  return { padding: padding.join(" "), rest: rest.join(" ") };
}

const pendingScrollTimelineHandleRefreshes = new WeakSet<HTMLElement>();

function refreshScrollTimelineHandleGeometry(handles: readonly HTMLElement[]): void {
  const pendingHandles = handles.filter((handle) => {
    if (pendingScrollTimelineHandleRefreshes.has(handle)) return false;
    pendingScrollTimelineHandleRefreshes.add(handle);
    return true;
  });
  if (pendingHandles.length === 0) return;

  requestAnimationFrame(() => {
    for (const handle of pendingHandles) {
      pendingScrollTimelineHandleRefreshes.delete(handle);
      if (!handle.isConnected || typeof KeyframeEffect === "undefined") continue;
      for (const animation of handle.getAnimations()) {
        if (animation.timeline?.constructor.name !== "ScrollTimeline") continue;
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect)) continue;

        // Chromium can keep container-query units from the size at which the
        // ScrollTimeline keyframes were created. Re-applying the same frames
        // makes 100cqh / 100cqw resolve against the current track geometry.
        effect.setKeyframes(effect.getKeyframes());
      }
    }
  });
}

type ScrollAreaCssVars = {
  "--scroll-area-track-top"?: string;
  "--scroll-area-track-bottom"?: string;
  "--scroll-area-track-left"?: string;
  "--scroll-area-track-right"?: string;
};

// OverlayScrollbars 按引用比较选项里的函数，overlayscrollbars-react 又在 options 引用变化时
// 重新下发选项：每次渲染新建函数会被判成「选项已变」而触发一次完整 update（切换视口
// data-overlayscrollbars-viewport → 整个视口子树样式重算）。函数与事件放模块级，其余选项按值 memo。
const OVERLAY_UPDATE_OPTIONS: NonNullable<PartialOptions["update"]> = {
  // 避免窗口 resize / 暗色切换时全部 ScrollArea 在同一同步任务里交替读写布局（Read/Write Layout Thrashing）：
  // 库默认 resize: null（同步）与 env: [222, 666, true]（leading 同步），在 250+ 节点导图等重 DOM 场景下
  // 会把单次视口切换拉成 >2s 长任务。关闭 env leading 并将 resize 推入单帧防抖，既保留流畅反馈又打散回流风暴。
  debounce: {
    mutation: [16, 66],
    resize: [16, 66],
    event: [33, 99],
    env: [120, 300, false],
  },
  // LTR 使用标准顺向流，跳过 Chromium 容易误判的坐标探测；
  // RTL 则保留方向信号，确保横向滑块与负 scrollLeft 正确映射。
  // 只有这里返回方向时库才会给视口设 noContent 做原点量测（见 scroll-overlay-stylesheet）
  flowDirectionStyles: (viewport) => {
    const direction = getComputedStyle(viewport).direction;
    if (direction !== "rtl") return {};
    restoreOverlayNoContentChildRule(viewport.ownerDocument);
    return { direction };
  },
};

const OVERLAY_EVENTS: EventListeners = {
  initialized: (instance) => {
    const elements = instance.elements();
    refreshScrollTimelineHandleGeometry([
      elements.scrollbarHorizontal?.handle,
      elements.scrollbarVertical.handle,
    ].filter((h): h is HTMLElement => Boolean(h)));
  },
  updated: (instance) => {
    const elements = instance.elements();
    refreshScrollTimelineHandleGeometry([
      elements.scrollbarHorizontal?.handle,
      elements.scrollbarVertical.handle,
    ].filter((h): h is HTMLElement => Boolean(h)));
  },
};

const skipFocus = () => {};

// 库包裹/解包视口内容后会对当前焦点元素再调一次 focus()，防止被移动的节点丢焦点。焦点在目标之外时
// 没有节点被移动，这次 focus() 是空操作（不派发事件、不动选区与 :focus-visible），却要先强制结算整份文档的
// 样式与布局；虚拟列表滚动时每一行的挂载、卸载各来一次。
function runWithoutOutsideRefocus(target: HTMLElement, run: () => void): void {
  const active = target.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || target.contains(active)) {
    run();
    return;
  }
  const focusDescriptor = Object.getOwnPropertyDescriptor(active, "focus");
  if (focusDescriptor && !focusDescriptor.configurable) {
    run();
    return;
  }
  // focus 也可能是原型上的只读 accessor；赋值会抛错，需用自身属性临时遮蔽。
  Object.defineProperty(active, "focus", { configurable: true, value: skipFocus });
  try {
    run();
  } finally {
    if (focusDescriptor) Object.defineProperty(active, "focus", focusDescriptor);
    else delete (active as { focus?: unknown }).focus;
  }
}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  function ScrollArea(
    {
      children,
      className,
      viewportClassName,
      viewportRef,
      viewportProps,
      orientation = "vertical",
      scrollHideDelay = 600,
      scrollAutoHide,
      scrollAutoHideSuspend = false,
      trackOffset,
      nativeScrollbars,
      style,
      ...rest
    },
    ref,
  ) {
    const platform = React.useMemo(() => detectScrollPlatform(), []);
    const theme = useScrollbarTheme();
    const useNative = nativeScrollbars ?? platform.preferNativeScrollbars;

    const offsetStyle = React.useMemo<React.CSSProperties & ScrollAreaCssVars>(() => {
      const next: ScrollAreaCssVars = {};
      if (trackOffset?.top !== undefined) {
        const v = formatOffset(trackOffset.top);
        if (v) next["--scroll-area-track-top"] = v;
      }
      if (trackOffset?.bottom !== undefined) {
        const v = formatOffset(trackOffset.bottom);
        if (v) next["--scroll-area-track-bottom"] = v;
      }
      if (trackOffset?.left !== undefined) {
        const v = formatOffset(trackOffset.left);
        if (v) next["--scroll-area-track-left"] = v;
      }
      if (trackOffset?.right !== undefined) {
        const v = formatOffset(trackOffset.right);
        if (v) next["--scroll-area-track-right"] = v;
      }
      return { ...(style as React.CSSProperties), ...next };
    }, [style, trackOffset]);

    const overflowX =
      orientation === "horizontal" || orientation === "both" ? "scroll" : "hidden";
    const overflowY =
      orientation === "vertical" || orientation === "both" ? "scroll" : "hidden";

    const dataSlot = rest["data-slot"] ?? "scroll-area";
    const { "data-slot": _dataSlotDrop, ...restProps } = rest;
    void _dataSlotDrop;
    const {
      className: viewportPropsClassName,
      ...resolvedViewportProps
    } = viewportProps ?? {};
    const overlayTargetRef = React.useRef<HTMLDivElement | null>(null);
    const overlayViewportRef = React.useRef<HTMLDivElement | null>(null);
    const justInitializedRef = React.useRef(false);
    const setOverlayTargetRef = React.useCallback(
      (value: HTMLDivElement | null) => {
        overlayTargetRef.current = value;
        assignRef(ref, value);
      },
      [ref],
    );
    const setOverlayViewportRef = React.useCallback(
      (value: HTMLDivElement | null) => {
        overlayViewportRef.current = value;
        assignRef(viewportRef, value);
      },
      [viewportRef],
    );
    const overlayOptions = React.useMemo<PartialOptions>(() => ({
      update: OVERLAY_UPDATE_OPTIONS,
      scrollbars: {
        theme,
        // 默认仅在滚动时显影，停止后按 delay 隐藏（对齐 macOS 原生覆盖滚动条）：
        // 旧默认值 'leave' + autoHideSuspend=true 会让鼠标悬停列表行时滚动条常驻盖住右侧操作按钮。
        // 显式传入 scrollAutoHide 时仍以调用方为准。
        autoHide:
          scrollHideDelay > 0
            ? (scrollAutoHide ?? "scroll")
            : "never",
        autoHideDelay: scrollHideDelay,
        autoHideSuspend: scrollAutoHideSuspend,
        dragScroll: true,
        // 点击轨道跳转遵循平台惯例：macOS 原生滚动条无此行为，点击轨道
        // 不应跳转（聊天右缘是高频点击区，误触会意外跳走）；
        // Windows/Linux 惯例是点击跳转，保持开启。
        clickScroll: platform.isMac ? false : true,
      },
      overflow: { x: overflowX, y: overflowY },
    }), [theme, scrollHideDelay, scrollAutoHide, scrollAutoHideSuspend, platform, overflowX, overflowY]);
    const overflowAxesRef = React.useRef({ x: overflowX, y: overflowY });
    overflowAxesRef.current = { x: overflowX, y: overflowY };
    const destroyOverlayRef = React.useRef<(() => void) | null>(null);
    // 必须声明在 useOverlayScrollbars 之前：卸载时 React 按声明顺序执行清理，hook 自带的清理会直接 destroy
    React.useEffect(() => () => destroyOverlayRef.current?.(), []);
    const [initializeOverlay, getOverlayInstance] = useOverlayScrollbars({
      options: overlayOptions,
      events: OVERLAY_EVENTS,
    });

    React.useEffect(() => {
      if (useNative) return;
      const target = overlayTargetRef.current;
      const viewport = overlayViewportRef.current;
      if (!target || !viewport) return;

      detachOverlayNoContentChildRule(target.ownerDocument);
      runWithoutOutsideRefocus(target, () => initializeOverlay({
        target,
        elements: { viewport },
      }));
      justInitializedRef.current = true;

      let rafId: number | null = null;
      let lastMetrics = {
        scrollWidth: viewport.scrollWidth,
        scrollHeight: viewport.scrollHeight,
        clientWidth: viewport.clientWidth,
        clientHeight: viewport.clientHeight,
      };
      const observedSizes = new Map<Element, { width: number; height: number }>();

      const scheduleOverlayUpdate = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const instance = getOverlayInstance();
          if (!instance || instance.state?.().destroyed) return;
          instance.update?.(true);
          const elements = instance.elements?.();
          refreshScrollTimelineHandleGeometry([
            elements?.scrollbarHorizontal?.handle,
            elements?.scrollbarVertical?.handle,
          ].filter((h): h is HTMLElement => Boolean(h)));
        });
      };

      const hasStuckHiddenOverflow = () => {
        const vpAttr = viewport.getAttribute("data-overlayscrollbars-viewport") ?? "";
        const axes = overflowAxesRef.current;
        const yStuck =
          axes.y === "scroll" &&
          viewport.scrollHeight > viewport.clientHeight + 1 &&
          !vpAttr.includes("overflowYScroll");
        const xStuck =
          axes.x === "scroll" &&
          viewport.scrollWidth > viewport.clientWidth + 1 &&
          !vpAttr.includes("overflowXScroll");
        return yStuck || xStuck;
      };

      const checkAndScheduleUpdate = (sizeChanged: boolean) => {
        const nextMetrics = {
          scrollWidth: viewport.scrollWidth,
          scrollHeight: viewport.scrollHeight,
          clientWidth: viewport.clientWidth,
          clientHeight: viewport.clientHeight,
        };
        const metricsChanged =
          nextMetrics.scrollWidth !== lastMetrics.scrollWidth ||
          nextMetrics.scrollHeight !== lastMetrics.scrollHeight ||
          nextMetrics.clientWidth !== lastMetrics.clientWidth ||
          nextMetrics.clientHeight !== lastMetrics.clientHeight;
        lastMetrics = nextMetrics;
        if (sizeChanged || metricsChanged || hasStuckHiddenOverflow()) {
          scheduleOverlayUpdate();
        }
      };

      let resizeObserver: ResizeObserver | null = null;
      let childListObserver: MutationObserver | null = null;

      if (typeof ResizeObserver !== "undefined") {
        // OverlayScrollbars 只给 host 挂了 ResizeObserver，不观察 viewport 内层内容盒尺寸变化：
        // 当 Suspense / 动画切页 / 异步配置加载 / 容器查询换行撑高内容时，视口可能停在 overflowYHidden。
        // 观察 viewport 及其直接子元素尺寸变化，并在内容尺寸变化或溢出态失步时在下一帧触发 update(true)。
        resizeObserver = new ResizeObserver((entries) => {
          let sizeChanged = false;
          for (const entry of entries) {
            const box = entry.borderBoxSize?.[0] ?? entry.contentBoxSize?.[0];
            const width = box ? box.inlineSize : entry.contentRect.width;
            const height = box ? box.blockSize : entry.contentRect.height;
            const prev = observedSizes.get(entry.target);
            observedSizes.set(entry.target, { width, height });
            if (prev && (Math.abs(prev.width - width) > 0.5 || Math.abs(prev.height - height) > 0.5)) {
              sizeChanged = true;
            }
          }
          checkAndScheduleUpdate(sizeChanged);
        });

        resizeObserver.observe(viewport);
        const observeDirectChildren = () => {
          const currentChildren = new Set<Element>(Array.from(viewport.children));
          for (const tracked of Array.from(observedSizes.keys())) {
            if (tracked !== viewport && !currentChildren.has(tracked)) {
              resizeObserver?.unobserve(tracked);
              observedSizes.delete(tracked);
            }
          }
          for (const child of currentChildren) {
            if (!observedSizes.has(child)) {
              resizeObserver?.observe(child);
            }
          }
        };
        observeDirectChildren();

        if (typeof MutationObserver !== "undefined") {
          childListObserver = new MutationObserver(() => {
            observeDirectChildren();
            checkAndScheduleUpdate(false);
          });
          childListObserver.observe(viewport, { childList: true });
        }
      }

      const destroyOverlay = () => runWithoutOutsideRefocus(target, () => getOverlayInstance()?.destroy());
      destroyOverlayRef.current = destroyOverlay;
      return () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        childListObserver?.disconnect();
        resizeObserver?.disconnect();
        observedSizes.clear();
        destroyOverlayRef.current = null;
        destroyOverlay();
      };
    }, [getOverlayInstance, initializeOverlay, useNative]);

    React.useEffect(() => {
      if (useNative) return;
      const instance = getOverlayInstance();
      if (!instance) return;
      // 同一次提交里刚初始化：初始化已按当前 trackOffset 完整量测，再强制 update 只是重复一轮
      //（每轮都切换视口属性、强制整片视口子树样式重算）
      if (justInitializedRef.current) {
        justInitializedRef.current = false;
        return;
      }
      instance.update(true);
      const elements = instance.elements();
      refreshScrollTimelineHandleGeometry([
        elements.scrollbarHorizontal?.handle,
        elements.scrollbarVertical.handle,
      ].filter((h): h is HTMLElement => Boolean(h)));
    }, [
      getOverlayInstance,
      trackOffset?.bottom,
      trackOffset?.left,
      trackOffset?.right,
      trackOffset?.top,
      useNative,
    ]);

    if (useNative) {
      const overflowClass = cn(
        overflowY === "scroll" ? "overflow-y-auto" : "overflow-y-hidden",
        overflowX === "scroll" ? "overflow-x-auto" : "overflow-x-hidden",
      );

      return (
        <div
          ref={ref}
          data-slot={dataSlot}
          data-orientation={orientation}
          data-native-scrollbars="true"
          className={cn(scrollAreaRootBase(className), className)}
          style={offsetStyle}
          {...restProps}
        >
          <div
            ref={viewportRef}
            className={cn(
              SCROLL_AREA_NATIVE_CLASS,
              "h-full min-h-0 w-full min-w-0",
              overflowClass,
              viewportClassName,
              viewportPropsClassName,
            )}
            {...resolvedViewportProps}
          >
            {children}
          </div>
        </div>
      );
    }

    const overlayViewportClasses = splitPaddingClasses(
      cn(viewportClassName, viewportPropsClassName),
    );

    return (
      <div
        ref={setOverlayTargetRef}
        data-slot={dataSlot}
        data-orientation={orientation}
        data-scroll-axes={orientation}
        data-native-scrollbars="false"
        data-overlayscrollbars-initialize=""
        data-scroll-track-top={trackOffset?.top !== undefined ? "" : undefined}
        data-scroll-track-bottom={trackOffset?.bottom !== undefined ? "" : undefined}
        data-scroll-track-left={trackOffset?.left !== undefined ? "" : undefined}
        data-scroll-track-right={trackOffset?.right !== undefined ? "" : undefined}
        className={cn(scrollAreaRootBase(className), className, overlayViewportClasses.padding)}
        style={offsetStyle}
        {...restProps}
      >
        <div
          ref={setOverlayViewportRef}
          className={cn("h-full min-h-0 w-full min-w-0", overlayViewportClasses.rest)}
          {...resolvedViewportProps}
        >
          {children}
        </div>
      </div>
    );
  },
);

ScrollArea.displayName = "ScrollArea";
