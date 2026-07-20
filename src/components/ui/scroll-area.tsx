import * as React from "react";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";

import { cn } from "../../lib/utils";
import { detectScrollPlatform } from "../../lib/scroll-platform";
import { useScrollbarTheme } from "../../lib/scroll-theme";

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

export interface ScrollAreaProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  children?: React.ReactNode;
  className?: string;
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Applied to the scrolling host; className is merged with viewportClassName. */
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

type ScrollAreaCssVars = {
  "--scroll-area-track-top"?: string;
  "--scroll-area-track-bottom"?: string;
  "--scroll-area-track-left"?: string;
  "--scroll-area-track-right"?: string;
};

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
      scrollAutoHideSuspend = true,
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
          className={cn("relative min-h-0 min-w-0", className)}
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

    return (
      <div
        ref={ref}
        data-slot={dataSlot}
        data-orientation={orientation}
        data-native-scrollbars="false"
        className={cn("relative min-h-0 min-w-0", className)}
        style={offsetStyle}
        {...restProps}
      >
        <OverlayScrollbarsComponent
          element="div"
          className={cn(
            "h-full min-h-0 w-full min-w-0",
            viewportClassName,
            viewportPropsClassName,
          )}
          options={{
            update: {
              // DeepStudent 的统一 ScrollArea 都使用标准顺向流。关闭库对
              // reverse-flow 的坐标探测，避免 Chromium 舍入误判后让滑块
              // 以负方向移动（笔记文件树滚动时滑块会越出固定轨道）。
              flowDirectionStyles: () => ({}),
            },
            scrollbars: {
              theme,
              // 触屏无 hover：'leave' 策略会让滚动条永不出现（M-1），
              // 改为滚动时显影、停止后按 delay 隐藏；显式传入 scrollAutoHide 时以调用方为准
              autoHide:
                scrollHideDelay > 0
                  ? (scrollAutoHide ?? (platform.isTouchPrimary ? "scroll" : "leave"))
                  : "never",
              autoHideDelay: scrollHideDelay,
              autoHideSuspend: scrollAutoHideSuspend,
              dragScroll: true,
              clickScroll: true,
            },
            overflow: { x: overflowX, y: overflowY },
          }}
          events={{
            initialized: (instance) => {
              assignRef(viewportRef, instance.elements().viewport as HTMLDivElement);
            },
            destroyed: () => {
              assignRef(viewportRef, null);
            },
          }}
          {...resolvedViewportProps}
        >
          {children}
        </OverlayScrollbarsComponent>
      </div>
    );
  },
);

ScrollArea.displayName = "ScrollArea";
