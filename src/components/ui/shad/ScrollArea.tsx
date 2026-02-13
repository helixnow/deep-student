import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { CustomScrollArea } from '../../custom-scroll-area';
import { cn } from '../../../lib/utils';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
  hideTrackWhenIdle?: boolean;
  trackOffsetTop?: number | string;
  trackOffsetBottom?: number | string;
  trackOffsetRight?: number | string;
  trackOffsetLeft?: number | string;
  orientation?: 'vertical' | 'horizontal' | 'both';
  variant?: 'default' | 'dense';
  applyDefaultViewportClassName?: boolean;
  viewportProps?: HTMLAttributes<HTMLDivElement>;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  (
    {
      className,
      style,
      children,
      viewportClassName,
      hideTrackWhenIdle = true,
      trackOffsetTop,
      trackOffsetBottom,
      trackOffsetRight,
      trackOffsetLeft,
      orientation = 'vertical',
      variant = 'default',
      applyDefaultViewportClassName = true,
      viewportProps,
      ...props
    },
    ref,
  ) => {
    const resolvedViewportClassName = applyDefaultViewportClassName
      ? cn('max-h-[420px] pr-1', viewportClassName)
      : viewportClassName;

    return (
      <CustomScrollArea
        ref={ref}
        className={cn(className)}
        data-variant={variant === 'dense' ? 'dense' : undefined}
        orientation={orientation}
        viewportClassName={resolvedViewportClassName}
        viewportProps={viewportProps}
        hideTrackWhenIdle={hideTrackWhenIdle}
        trackOffsetTop={trackOffsetTop}
        trackOffsetBottom={trackOffsetBottom}
        trackOffsetRight={trackOffsetRight}
        trackOffsetLeft={trackOffsetLeft}
        style={style}
        {...props}
      >
        {children}
      </CustomScrollArea>
    );
  }
);
ScrollArea.displayName = 'ScrollArea';

export default ScrollArea;
