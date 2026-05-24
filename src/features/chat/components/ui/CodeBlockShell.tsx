import React from 'react';
import { cn } from '@/utils/cn';

export interface CodeBlockShellProps extends React.HTMLAttributes<HTMLDivElement> {
  header?: React.ReactNode;
  stickyHeader?: boolean;
  bodyClassName?: string;
  bodyProps?: React.HTMLAttributes<HTMLDivElement>;
}

function findScrollRoot(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const scrollsY = /(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight;
    const scrollsX = /(auto|scroll|overlay)/.test(overflowX) && current.scrollWidth > current.clientWidth;

    if (scrollsY || scrollsX || current.dataset.slot === 'scroll-area') {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

/**
 * Shared shell for block-level code outputs.
 * Keeps the legacy CSS hooks while moving structure into a dedicated component.
 */
export const CodeBlockShell: React.FC<CodeBlockShellProps> = ({
  className,
  header,
  stickyHeader = false,
  bodyClassName,
  bodyProps,
  children,
  ...props
}) => {
  const { className: bodyClassNameFromProps, ...restBodyProps } = bodyProps ?? {};
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const stickyHeaderRef = React.useRef<HTMLDivElement>(null);
  const [isStuck, setIsStuck] = React.useState(false);
  const [isExitingSticky, setIsExitingSticky] = React.useState(false);

  React.useEffect(() => {
    if (!stickyHeader) {
      setIsStuck(false);
      setIsExitingSticky(false);
      return;
    }

    const wrapper = wrapperRef.current;
    const stickyHeaderNode = stickyHeaderRef.current;
    if (!wrapper || !stickyHeaderNode) return;

    const root = findScrollRoot(wrapper);
    const scrollTarget: HTMLElement | Window = root ?? window;
    let frameId = 0;
    let prevStuck = false;
    let prevExiting = false;

    const updateStickyState = () => {
      frameId = 0;

      const wrapperRect = wrapper.getBoundingClientRect();
      const rootTop = root ? root.getBoundingClientRect().top : 0;
      const headerHeight = stickyHeaderNode.getBoundingClientRect().height;
      const remainingBodyHeight = wrapperRect.bottom - (rootTop + headerHeight);
      const stillPinnedWithinBlock = remainingBodyHeight > 0;
      const passedBlockTop = wrapperRect.top < rootTop;
      const stickyExitThreshold = headerHeight > 0 ? headerHeight : 16;

      const exiting = passedBlockTop
        && stillPinnedWithinBlock
        && remainingBodyHeight <= stickyExitThreshold;
      const stuck = passedBlockTop && stillPinnedWithinBlock;

      if (stuck !== prevStuck || exiting !== prevExiting) {
        prevStuck = stuck;
        prevExiting = exiting;
        setIsStuck(stuck);
        setIsExitingSticky(exiting);
      }
    };

    const scheduleUpdate = () => {
      if (frameId !== 0) return;
      frameId = window.requestAnimationFrame(updateStickyState);
    };

    updateStickyState();
    scrollTarget.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleUpdate)
      : null;
    resizeObserver?.observe(wrapper);
    resizeObserver?.observe(stickyHeaderNode);
    if (root) resizeObserver?.observe(root);

    return () => {
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      scrollTarget.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [stickyHeader]);

  return (
    <div ref={wrapperRef} className={cn('code-block-wrapper', className)} {...props}>
      {header ? (
        <div
          ref={stickyHeaderRef}
          className={cn(
            'code-block-sticky-header',
            stickyHeader && 'code-block-sticky-header--sticky',
            isStuck && 'code-block-sticky-header--stuck',
            isExitingSticky && 'code-block-sticky-header--exiting',
          )}
          data-stuck={isStuck ? 'true' : 'false'}
          data-sticky-phase={isExitingSticky ? 'exiting' : isStuck ? 'pinned' : 'resting'}
        >
          {header}
        </div>
      ) : null}
      <div className={cn(bodyClassName, bodyClassNameFromProps)} {...restBodyProps}>
        {children}
      </div>
    </div>
  );
};
