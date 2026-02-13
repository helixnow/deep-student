import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  HTMLAttributes,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "../lib/utils";
import "./custom-scroll-area.css";

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
  fullHeight?: boolean;
  /** 是否应用默认的 viewport className（兼容 shadcn ScrollArea） */
  applyDefaultViewportClassName?: boolean;
}

export const CustomScrollArea = forwardRef<HTMLDivElement, CustomScrollAreaProps>(
  function CustomScrollArea(
    {
      className,
      children,
      viewportClassName,
      viewportRef,
      viewportProps,
      hideTrackWhenIdle = true,
      trackOffsetTop = 0,
      trackOffsetBottom = 0,
      trackOffsetRight = 0,
      trackOffsetLeft = 0,
      orientation = "vertical",
      fullHeight = true,
      style,
      ...rest
    },
    ref
  ) {
    const viewportInnerRef = useRef<HTMLDivElement | null>(null);
    const verticalMetricsRef = useRef<{ size: number; offset: number }>({ size: 0, offset: 0 });
    const horizontalMetricsRef = useRef<{ size: number; offset: number }>({
      size: 0,
      offset: 0,
    });
    const verticalTrackRef = useRef<HTMLDivElement | null>(null);
    const horizontalTrackRef = useRef<HTMLDivElement | null>(null);
    const hideTimerRef = useRef<number | null>(null);
    const [verticalThumbMetrics, setVerticalThumbMetrics] = useState({ size: 0, offset: 0 });
    const [horizontalThumbMetrics, setHorizontalThumbMetrics] = useState({ size: 0, offset: 0 });
    const [verticalTrackActive, setVerticalTrackActive] = useState(false);
    const [horizontalTrackActive, setHorizontalTrackActive] = useState(false);
    const isVerticalDraggingRef = useRef(false);
    const isHorizontalDraggingRef = useRef(false);
    const verticalPointerIdRef = useRef<number | null>(null);
    const horizontalPointerIdRef = useRef<number | null>(null);
    const dragStartYRef = useRef(0);
    const dragStartScrollTopRef = useRef(0);
    const dragStartXRef = useRef(0);
    const dragStartScrollLeftRef = useRef(0);
    // 缓存上一次尺寸，用于 MutationObserver 判断是否需要刷新
    const lastDimensionsRef = useRef({ scrollHeight: 0, clientHeight: 0, scrollWidth: 0, clientWidth: 0 });

    const enableVertical = orientation === "vertical" || orientation === "both";
    const enableHorizontal = orientation === "horizontal" || orientation === "both";

    const assignViewportRef = useCallback(
      (node: HTMLDivElement | null) => {
        viewportInnerRef.current = node;
        if (typeof viewportRef === "function") {
          viewportRef(node);
        } else if (viewportRef && typeof viewportRef === "object") {
          (viewportRef as MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [viewportRef]
    );

    const clearHideTimer = useCallback(() => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    }, []);

    const scheduleHide = useCallback(() => {
      if (!hideTrackWhenIdle) return;
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        setVerticalTrackActive(false);
        setHorizontalTrackActive(false);
        hideTimerRef.current = null;
      }, 700);
    }, [hideTrackWhenIdle, clearHideTimer]);

    const showTrack = useCallback(() => {
      if (enableVertical && verticalMetricsRef.current.size > 0) {
        setVerticalTrackActive(true);
      }
      if (enableHorizontal && horizontalMetricsRef.current.size > 0) {
        setHorizontalTrackActive(true);
      }
    }, [enableHorizontal, enableVertical]);

    useEffect(() => {
      const viewport = viewportInnerRef.current;
      if (!viewport) return;

      let frame = 0;

      const updateThumbMetrics = (showTrackAfterUpdate = true) => {
        const { scrollTop, scrollHeight, clientHeight, scrollLeft, scrollWidth, clientWidth } =
          viewport;

        // 更新缓存尺寸
        lastDimensionsRef.current = { scrollHeight, clientHeight, scrollWidth, clientWidth };

        if (enableVertical) {
          if (scrollHeight <= clientHeight + 1) {
            verticalMetricsRef.current = { size: 0, offset: 0 };
            setVerticalThumbMetrics({ size: 0, offset: 0 });
            setVerticalTrackActive(false);
          } else {
            const ratio = clientHeight / scrollHeight;
            const size = Math.max(clientHeight * ratio, 36);
            const maxOffset = clientHeight - size;
            const offset =
              maxOffset <= 0 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxOffset;

            const nextVerticalMetrics = { size, offset };
            verticalMetricsRef.current = nextVerticalMetrics;
            setVerticalThumbMetrics(nextVerticalMetrics);
            // 仅在明确需要显示时设置 active（如滚动操作）
            if (showTrackAfterUpdate) {
              setVerticalTrackActive(true);
            }
          }
        } else {
          verticalMetricsRef.current = { size: 0, offset: 0 };
          setVerticalThumbMetrics({ size: 0, offset: 0 });
          setVerticalTrackActive(false);
        }

        if (enableHorizontal) {
          if (scrollWidth <= clientWidth + 1) {
            horizontalMetricsRef.current = { size: 0, offset: 0 };
            setHorizontalThumbMetrics({ size: 0, offset: 0 });
            setHorizontalTrackActive(false);
          } else {
            const ratio = clientWidth / scrollWidth;
            const size = Math.max(clientWidth * ratio, 36);
            const maxOffset = clientWidth - size;
            const offset =
              maxOffset <= 0 ? 0 : (scrollLeft / (scrollWidth - clientWidth)) * maxOffset;

            const nextHorizontalMetrics = { size, offset };
            horizontalMetricsRef.current = nextHorizontalMetrics;
            setHorizontalThumbMetrics(nextHorizontalMetrics);
            if (showTrackAfterUpdate) {
              setHorizontalTrackActive(true);
            }
          }
        } else {
          horizontalMetricsRef.current = { size: 0, offset: 0 };
          setHorizontalThumbMetrics({ size: 0, offset: 0 });
          setHorizontalTrackActive(false);
        }

        if (showTrackAfterUpdate && (enableVertical || enableHorizontal)) {
          scheduleHide();
        }
      };

      const handleScroll = () => {
        showTrack();
        clearHideTimer();
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => updateThumbMetrics(true));
      };

      // 初始化缓存尺寸
      lastDimensionsRef.current = {
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        scrollWidth: viewport.scrollWidth,
        clientWidth: viewport.clientWidth,
      };
      updateThumbMetrics();

      viewport.addEventListener("scroll", handleScroll, { passive: true });

      const resizeObserver = new ResizeObserver(() => {
        // 同样检查尺寸是否真正变化，避免不必要的滚动条刷新
        const { scrollHeight, clientHeight, scrollWidth, clientWidth } = viewport;
        const last = lastDimensionsRef.current;
        if (
          scrollHeight === last.scrollHeight &&
          clientHeight === last.clientHeight &&
          scrollWidth === last.scrollWidth &&
          clientWidth === last.clientWidth
        ) {
          return;
        }
        lastDimensionsRef.current = { scrollHeight, clientHeight, scrollWidth, clientWidth };
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => updateThumbMetrics(false));
      });

      resizeObserver.observe(viewport);

      const mutationObserver = new MutationObserver(() => {
        // 仅当滚动容器尺寸真正变化时才刷新滚动条，
        // 避免 ProseMirror 选区等临时 DOM 变化导致滚动条闪烁
        const { scrollHeight, clientHeight, scrollWidth, clientWidth } = viewport;
        const last = lastDimensionsRef.current;
        if (
          scrollHeight === last.scrollHeight &&
          clientHeight === last.clientHeight &&
          scrollWidth === last.scrollWidth &&
          clientWidth === last.clientWidth
        ) {
          return;
        }
        lastDimensionsRef.current = { scrollHeight, clientHeight, scrollWidth, clientWidth };
        if (frame) cancelAnimationFrame(frame);
        // MutationObserver 和 ResizeObserver 触发时不主动显示滚动条
        frame = requestAnimationFrame(() => updateThumbMetrics(false));
      });

      mutationObserver.observe(viewport, { childList: true, subtree: true, characterData: false });

      return () => {
        viewport.removeEventListener("scroll", handleScroll);
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        if (frame) cancelAnimationFrame(frame);
        clearHideTimer();
      };
    }, [clearHideTimer, enableHorizontal, enableVertical, scheduleHide, showTrack]);

    const handlePointerEnter = useCallback(() => {
      clearHideTimer();
      showTrack();
    }, [clearHideTimer, showTrack]);

    const handlePointerLeave = useCallback(() => {
      scheduleHide();
    }, [scheduleHide]);

    const shouldShowVerticalTrack = useMemo(
      () => enableVertical && verticalTrackActive && verticalThumbMetrics.size > 0,
      [enableVertical, verticalThumbMetrics.size, verticalTrackActive]
    );

    const shouldShowHorizontalTrack = useMemo(
      () => enableHorizontal && horizontalTrackActive && horizontalThumbMetrics.size > 0,
      [enableHorizontal, horizontalTrackActive, horizontalThumbMetrics.size]
    );

    const formatOffset = useCallback((value: number | string) => {
      return typeof value === "number" ? `${value}px` : value;
    }, []);

    const mergedStyle = useMemo<CSSProperties>(() => {
      return {
        ...(style as CSSProperties),
        ["--scroll-area-track-offset-top" as const]: formatOffset(trackOffsetTop),
        ["--scroll-area-track-offset-bottom" as const]: formatOffset(trackOffsetBottom),
        ["--scroll-area-track-offset-right" as const]: formatOffset(trackOffsetRight),
        ["--scroll-area-track-offset-left" as const]: formatOffset(trackOffsetLeft),
      };
    }, [
      formatOffset,
      style,
      trackOffsetBottom,
      trackOffsetLeft,
      trackOffsetRight,
      trackOffsetTop,
    ]);

    const finalizeVerticalDrag = useCallback(() => {
      isVerticalDraggingRef.current = false;
      verticalPointerIdRef.current = null;
      scheduleHide();
    }, [scheduleHide]);

    const finalizeHorizontalDrag = useCallback(() => {
      isHorizontalDraggingRef.current = false;
      horizontalPointerIdRef.current = null;
      scheduleHide();
    }, [scheduleHide]);

    const handleVerticalThumbPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableVertical) return;
        const viewport = viewportInnerRef.current;
        if (!viewport) return;
        event.preventDefault();
        event.stopPropagation();
        clearHideTimer();
        showTrack();
        isVerticalDraggingRef.current = true;
        verticalPointerIdRef.current = event.pointerId;
        dragStartYRef.current = event.clientY;
        dragStartScrollTopRef.current = viewport.scrollTop;
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      [clearHideTimer, enableVertical, showTrack]
    );

    const handleVerticalThumbPointerMove = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableVertical || !isVerticalDraggingRef.current) return;
        const viewport = viewportInnerRef.current;
        const track = verticalTrackRef.current;
        if (!viewport || !track) return;
        event.preventDefault();
        showTrack();
        clearHideTimer();

        const deltaY = event.clientY - dragStartYRef.current;
        const { scrollHeight, clientHeight } = viewport;
        const maxScrollTop = scrollHeight - clientHeight;
        if (maxScrollTop <= 0) return;

        const maxThumbOffset = track.clientHeight - verticalMetricsRef.current.size;
        if (maxThumbOffset <= 0) {
          viewport.scrollTop = 0;
          return;
        }

        const scrollRatio = maxScrollTop / maxThumbOffset;
        const nextScrollTop = dragStartScrollTopRef.current + deltaY * scrollRatio;
        viewport.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
      },
      [clearHideTimer, enableVertical, showTrack]
    );

    const handleVerticalThumbPointerUp = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableVertical || verticalPointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.releasePointerCapture(event.pointerId);
        finalizeVerticalDrag();
      },
      [enableVertical, finalizeVerticalDrag]
    );

    const handleVerticalThumbPointerCancel = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableVertical || verticalPointerIdRef.current !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        finalizeVerticalDrag();
      },
      [enableVertical, finalizeVerticalDrag]
    );

    const handleHorizontalThumbPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableHorizontal) return;
        const viewport = viewportInnerRef.current;
        if (!viewport) return;
        event.preventDefault();
        event.stopPropagation();
        clearHideTimer();
        showTrack();
        isHorizontalDraggingRef.current = true;
        horizontalPointerIdRef.current = event.pointerId;
        dragStartXRef.current = event.clientX;
        dragStartScrollLeftRef.current = viewport.scrollLeft;
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      [clearHideTimer, enableHorizontal, showTrack]
    );

    const handleHorizontalThumbPointerMove = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableHorizontal || !isHorizontalDraggingRef.current) return;
        const viewport = viewportInnerRef.current;
        const track = horizontalTrackRef.current;
        if (!viewport || !track) return;
        event.preventDefault();
        showTrack();
        clearHideTimer();

        const deltaX = event.clientX - dragStartXRef.current;
        const { scrollWidth, clientWidth } = viewport;
        const maxScrollLeft = scrollWidth - clientWidth;
        if (maxScrollLeft <= 0) return;

        const maxThumbOffset = track.clientWidth - horizontalMetricsRef.current.size;
        if (maxThumbOffset <= 0) {
          viewport.scrollLeft = 0;
          return;
        }

        const scrollRatio = maxScrollLeft / maxThumbOffset;
        const nextScrollLeft = dragStartScrollLeftRef.current + deltaX * scrollRatio;
        viewport.scrollLeft = Math.max(0, Math.min(nextScrollLeft, maxScrollLeft));
      },
      [clearHideTimer, enableHorizontal, showTrack]
    );

    const handleHorizontalThumbPointerUp = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableHorizontal || horizontalPointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.releasePointerCapture(event.pointerId);
        finalizeHorizontalDrag();
      },
      [enableHorizontal, finalizeHorizontalDrag]
    );

    const handleHorizontalThumbPointerCancel = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enableHorizontal || horizontalPointerIdRef.current !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        finalizeHorizontalDrag();
      },
      [enableHorizontal, finalizeHorizontalDrag]
    );

    const { className: viewportPropsClassName, ...viewportRestProps } = viewportProps ?? {};

    return (
      <div
        ref={ref}
        className={cn("scroll-area", className)}
        data-orientation={orientation}
        data-full-height={fullHeight ? "true" : "false"}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        style={mergedStyle}
        {...rest}
      >
        <div
          ref={assignViewportRef}
          className={cn("scroll-area__viewport", viewportClassName, viewportPropsClassName)}
          {...viewportRestProps}
        >
          {children}
        </div>
        {enableVertical ? (
          <div
            ref={verticalTrackRef}
            className="scroll-area__track scroll-area__track--vertical"
            data-visible={shouldShowVerticalTrack}
          >
            <div
              className="scroll-area__thumb scroll-area__thumb--vertical"
              style={{
                height: `${verticalThumbMetrics.size}px`,
                transform: `translateY(${verticalThumbMetrics.offset}px)`,
              }}
              onPointerDown={handleVerticalThumbPointerDown}
              onPointerMove={handleVerticalThumbPointerMove}
              onPointerUp={handleVerticalThumbPointerUp}
              onPointerCancel={handleVerticalThumbPointerCancel}
            />
          </div>
        ) : null}
        {enableHorizontal ? (
          <div
            ref={horizontalTrackRef}
            className="scroll-area__track scroll-area__track--horizontal"
            data-visible={shouldShowHorizontalTrack}
          >
            <div
              className="scroll-area__thumb scroll-area__thumb--horizontal"
              style={{
                width: `${horizontalThumbMetrics.size}px`,
                transform: `translateX(${horizontalThumbMetrics.offset}px)`,
              }}
              onPointerDown={handleHorizontalThumbPointerDown}
              onPointerMove={handleHorizontalThumbPointerMove}
              onPointerUp={handleHorizontalThumbPointerUp}
              onPointerCancel={handleHorizontalThumbPointerCancel}
            />
          </div>
        ) : null}
      </div>
    );
  }
);
