import * as React from "react";
import {
  OverlayScrollbarsComponent,
  type OverlayScrollbarsComponentRef,
} from "overlayscrollbars-react";

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
 * `@study-ui` alias. The `.scroll-area--native` styles live in App.css.
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
  viewportProps?: Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "ref">;
  orientation?: ScrollOrientation;
  /** Hide delay in ms. 0 = always visible. Default 700. */
  scrollHideDelay?: number;
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
      scrollHideDelay = 700,
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

    const osRef = React.useRef<OverlayScrollbarsComponentRef | null>(null);

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
          className={cn("relative", className)}
          style={offsetStyle}
          {...restProps}
        >
          <div
            ref={viewportRef}
            className={cn(
              SCROLL_AREA_NATIVE_CLASS,
              "h-full w-full",
              overflowClass,
              viewportClassName,
            )}
            {...viewportProps}
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
        className={cn("relative", className)}
        style={offsetStyle}
        {...restProps}
      >
        <OverlayScrollbarsComponent
          ref={osRef}
          element="div"
          className={cn("h-full w-full", viewportClassName)}
          options={{
            scrollbars: {
              theme,
              autoHide: scrollHideDelay > 0 ? "leave" : "never",
              autoHideDelay: scrollHideDelay,
              autoHideSuspend: true,
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
          {...(viewportProps ?? {})}
        >
          {children}
        </OverlayScrollbarsComponent>
      </div>
    );
  },
);

ScrollArea.displayName = "ScrollArea";
