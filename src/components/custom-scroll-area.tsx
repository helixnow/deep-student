import { forwardRef, useMemo } from "react";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/utils";
import { ScrollArea } from "./ui/scroll-area";

/**
 * @deprecated Legacy compatibility shim (milestone v1.1 Phase 5).
 *
 * Thin adapter over the unified `<ScrollArea>` primitive at
 * `./ui/scroll-area`. It preserves the legacy prop surface so existing
 * consumers keep working without code changes. New code should import
 * `ScrollArea` directly instead.
 *
 * The 492-line self-built implementation that this file replaced was
 * retired along with `custom-scroll-area.css`. Behavior now comes from
 * OverlayScrollbars with platform-aware defaults.
 */
interface CustomScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportProps?: HTMLAttributes<HTMLDivElement>;
  hideTrackWhenIdle?: boolean;
  trackOffsetTop?: number | string;
  trackOffsetBottom?: number | string;
  trackOffsetRight?: number | string;
  trackOffsetLeft?: number | string;
  orientation?: "vertical" | "horizontal" | "both";
  /** Legacy: when true the host fills its container. Default true. */
  fullHeight?: boolean;
  /** Legacy: apply `h-full w-full` to the viewport for shadcn compatibility. */
  applyDefaultViewportClassName?: boolean;
}

export const CustomScrollArea = forwardRef<HTMLDivElement, CustomScrollAreaProps>(
  function CustomScrollArea(
    {
      className,
      viewportClassName,
      viewportRef,
      viewportProps,
      hideTrackWhenIdle = true,
      trackOffsetTop,
      trackOffsetBottom,
      trackOffsetRight,
      trackOffsetLeft,
      orientation = "vertical",
      fullHeight = true,
      applyDefaultViewportClassName = true,
      children,
      ...rest
    },
    ref,
  ) {
    const trackOffset = useMemo(() => {
      const next: {
        top?: number | string;
        bottom?: number | string;
        left?: number | string;
        right?: number | string;
      } = {};
      if (trackOffsetTop !== undefined) next.top = trackOffsetTop;
      if (trackOffsetBottom !== undefined) next.bottom = trackOffsetBottom;
      if (trackOffsetLeft !== undefined) next.left = trackOffsetLeft;
      if (trackOffsetRight !== undefined) next.right = trackOffsetRight;
      return Object.keys(next).length > 0 ? next : undefined;
    }, [trackOffsetTop, trackOffsetBottom, trackOffsetLeft, trackOffsetRight]);

    const resolvedViewportClassName = cn(
      applyDefaultViewportClassName && "h-full w-full",
      viewportClassName,
    );

    return (
      <ScrollArea
        ref={ref}
        className={cn(fullHeight && "h-full", className)}
        viewportClassName={resolvedViewportClassName}
        viewportRef={viewportRef}
        viewportProps={viewportProps}
        orientation={orientation}
        scrollHideDelay={hideTrackWhenIdle ? 700 : 0}
        trackOffset={trackOffset}
        {...rest}
      >
        {children}
      </ScrollArea>
    );
  },
);

CustomScrollArea.displayName = "CustomScrollArea";
