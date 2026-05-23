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
  const stickySentinelRef = React.useRef<HTMLDivElement>(null);
  const [isStuck, setIsStuck] = React.useState(false);

  React.useEffect(() => {
    if (!stickyHeader) {
      setIsStuck(false);
      return;
    }

    const wrapper = wrapperRef.current;
    const sentinel = stickySentinelRef.current;
    if (!wrapper || !sentinel || typeof IntersectionObserver === 'undefined') return;

    const root = findScrollRoot(wrapper);
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsStuck(!entry.isIntersecting);
      },
      {
        root,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [stickyHeader]);

  return (
    <div ref={wrapperRef} className={cn('code-block-wrapper', className)} {...props}>
      {stickyHeader ? <div ref={stickySentinelRef} className="code-block-sticky-sentinel" aria-hidden="true" /> : null}
      {header ? (
        <div
          className={cn(
            'code-block-sticky-header',
            stickyHeader && 'code-block-sticky-header--sticky',
            isStuck && 'code-block-sticky-header--stuck',
          )}
          data-stuck={isStuck ? 'true' : 'false'}
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
