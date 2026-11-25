import React, { useEffect, useRef } from 'react';
import { cn } from '@/utils/cn';

export interface TableBlockShellProps extends React.HTMLAttributes<HTMLDivElement> {
  tableClassName?: string;
  tableProps?: React.TableHTMLAttributes<HTMLTableElement>;
}

/**
 * Updates left/right horizontal overflow cue attributes on a non-scrolling wrapper
 * without triggering React re-renders or subscribing to theme mutations.
 */
export function syncHorizontalScrollCue(
  wrapper: HTMLElement | null,
  scroller: HTMLElement | null,
): void {
  if (!wrapper || !scroller) return;
  const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
  const canScrollLeft = scroller.scrollLeft > 1;
  const canScrollRight = maxScrollLeft > 1 && scroller.scrollLeft < maxScrollLeft - 1;

  if (canScrollLeft) {
    wrapper.setAttribute('data-scroll-overflow-left', 'true');
  } else {
    wrapper.removeAttribute('data-scroll-overflow-left');
  }

  if (canScrollRight) {
    wrapper.setAttribute('data-scroll-overflow-right', 'true');
  } else {
    wrapper.removeAttribute('data-scroll-overflow-right');
  }
}

/**
 * Lightweight native horizontal scroll cue observer for wide markdown tables
 * and display math blocks. Uses passive scroll + ResizeObserver instead of
 * OverlayScrollbars so theme toggles never re-initialize scrollbars.
 */
export function useHorizontalScrollCue(
  wrapperRef: React.RefObject<HTMLElement | null>,
  scrollerRef: React.RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const wrapper = wrapperRef.current;
    const scroller = scrollerRef.current;
    if (!wrapper || !scroller) return;

    let rafId: number | null = null;
    const scheduleSync = () => {
      if (rafId !== null) return;
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          syncHorizontalScrollCue(wrapper, scroller);
        });
      } else {
        syncHorizontalScrollCue(wrapper, scroller);
      }
    };

    syncHorizontalScrollCue(wrapper, scroller);
    scroller.addEventListener('scroll', scheduleSync, { passive: true });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(scheduleSync);
      ro.observe(scroller);
      if (scroller.firstElementChild) {
        ro.observe(scroller.firstElementChild);
      }
    }

    return () => {
      scroller.removeEventListener('scroll', scheduleSync);
      ro?.disconnect();
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [wrapperRef, scrollerRef, enabled]);
}

/**
 * Shared shell for markdown tables.
 * Uses a lightweight native horizontal scroll container with visible thin scrollbars
 * and edge overflow cues so wide tables remain discoverably scrollable without
 * OverlayScrollbars theme re-init overhead.
 */
export const TableBlockShell: React.FC<TableBlockShellProps> = ({
  className,
  tableClassName,
  tableProps,
  children,
  ...props
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useHorizontalScrollCue(wrapperRef, scrollerRef);

  return (
    <div ref={wrapperRef} className={cn('table-wrapper', className)} {...props}>
      <div
        ref={scrollerRef}
        data-orientation="horizontal"
        data-native-scrollbars="true"
        className="table-scroll-area scroll-area--native min-w-0 max-w-full overflow-x-auto overflow-y-hidden"
      >
        <table className={cn('markdown-table', tableClassName)} {...tableProps}>
          {children}
        </table>
      </div>
    </div>
  );
};
