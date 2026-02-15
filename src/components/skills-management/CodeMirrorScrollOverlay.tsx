/**
 * CodeMirror 自研滚动条覆盖层
 *
 * 桥接 CodeMirror 的 .cm-scroller 滚动容器与自研滚动条样式，
 * 完全自包含，不依赖外部 CSS class。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

interface CodeMirrorScrollOverlayProps {
  /** 包含 CodeMirror 实例的容器 ref */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function CodeMirrorScrollOverlay({ containerRef }: CodeMirrorScrollOverlayProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const metricsRef = useRef({ size: 0, offset: 0 });
  const isDraggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const dragStartYRef = useRef(0);
  const dragStartScrollTopRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  const [thumbMetrics, setThumbMetrics] = useState({ size: 0, offset: 0 });
  const [trackActive, setTrackActive] = useState(false);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setTrackActive(false);
      hideTimerRef.current = null;
    }, 700);
  }, [clearHideTimer]);

  const updateThumb = useCallback((scroller: HTMLElement, show: boolean) => {
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    if (scrollHeight <= clientHeight + 1) {
      metricsRef.current = { size: 0, offset: 0 };
      setThumbMetrics({ size: 0, offset: 0 });
      setTrackActive(false);
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const size = Math.max(clientHeight * ratio, 36);
    const maxOffset = clientHeight - size;
    const offset = maxOffset <= 0 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxOffset;
    metricsRef.current = { size, offset };
    setThumbMetrics({ size, offset });
    if (show) setTrackActive(true);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 轮询等待 .cm-scroller 出现（CodeMirror 异步渲染）
    let attempts = 0;
    const maxAttempts = 20;
    const poll = setInterval(() => {
      const scroller = container.querySelector<HTMLElement>('.cm-scroller');
      if (scroller) {
        clearInterval(poll);
        scrollerRef.current = scroller;
        setup(scroller);
      } else if (++attempts >= maxAttempts) {
        clearInterval(poll);
      }
    }, 100);

    let frame = 0;
    let cleanupFn: (() => void) | null = null;

    function setup(scroller: HTMLElement) {
      updateThumb(scroller, false);

      const handleScroll = () => {
        clearHideTimer();
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          updateThumb(scroller, true);
          scheduleHide();
        });
      };

      scroller.addEventListener('scroll', handleScroll, { passive: true });

      const ro = new ResizeObserver(() => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => updateThumb(scroller, false));
      });
      ro.observe(scroller);

      const mo = new MutationObserver(() => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => updateThumb(scroller, false));
      });
      mo.observe(scroller, { childList: true, subtree: true });

      cleanupFn = () => {
        scroller.removeEventListener('scroll', handleScroll);
        ro.disconnect();
        mo.disconnect();
        if (frame) cancelAnimationFrame(frame);
      };
    }

    return () => {
      clearInterval(poll);
      cleanupFn?.();
      clearHideTimer();
    };
  }, [containerRef, clearHideTimer, scheduleHide, updateThumb]);

  // ---- 拖拽逻辑 ----

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    e.preventDefault();
    e.stopPropagation();
    clearHideTimer();
    setTrackActive(true);
    isDraggingRef.current = true;
    pointerIdRef.current = e.pointerId;
    dragStartYRef.current = e.clientY;
    dragStartScrollTopRef.current = scroller.scrollTop;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [clearHideTimer]);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    e.preventDefault();
    clearHideTimer();
    setTrackActive(true);

    const deltaY = e.clientY - dragStartYRef.current;
    const { scrollHeight, clientHeight } = scroller;
    const maxScrollTop = scrollHeight - clientHeight;
    if (maxScrollTop <= 0) return;

    const maxThumbOffset = track.clientHeight - metricsRef.current.size;
    if (maxThumbOffset <= 0) return;

    const scrollRatio = maxScrollTop / maxThumbOffset;
    const next = dragStartScrollTopRef.current + deltaY * scrollRatio;
    scroller.scrollTop = Math.max(0, Math.min(next, maxScrollTop));
  }, [clearHideTimer]);

  const finalize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.currentTarget.releasePointerCapture(e.pointerId);
    isDraggingRef.current = false;
    pointerIdRef.current = null;
    scheduleHide();
  }, [scheduleHide]);

  const shouldShow = trackActive && thumbMetrics.size > 0;
  const [thumbHover, setThumbHover] = useState(false);
  const [thumbActive, setThumbActive] = useState(false);

  const trackStyle: CSSProperties = {
    position: 'absolute',
    top: 6,
    bottom: 6,
    right: 6,
    width: 6,
    borderRadius: 9999,
    pointerEvents: 'none',
    opacity: shouldShow ? 1 : 0,
    transition: 'opacity 0.2s ease',
    zIndex: 60,
  };

  const thumbStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    borderRadius: 9999,
    background: thumbActive
      ? 'hsl(var(--muted-foreground) / 0.7)'
      : thumbHover
        ? 'hsl(var(--muted-foreground) / 0.55)'
        : 'hsl(var(--muted-foreground) / 0.35)',
    boxShadow: 'inset 0 0 0 1px hsl(var(--background) / 0.25)',
    pointerEvents: 'auto',
    transition: 'background-color 0.15s ease',
    minHeight: 36,
    height: thumbMetrics.size,
    transform: `translateY(${thumbMetrics.offset}px)`,
    cursor: 'default',
  };

  return (
    <div ref={trackRef} style={trackStyle}>
      <div
        style={thumbStyle}
        onPointerEnter={() => setThumbHover(true)}
        onPointerLeave={() => { setThumbHover(false); setThumbActive(false); }}
        onPointerDown={(e) => { setThumbActive(true); handlePointerDown(e); }}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => { setThumbActive(false); finalize(e); }}
        onPointerCancel={(e) => { setThumbActive(false); finalize(e); }}
      />
    </div>
  );
}
