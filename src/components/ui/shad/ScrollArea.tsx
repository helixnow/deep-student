import { forwardRef } from 'react';
import type { HTMLAttributes, Ref } from 'react';
import { CustomScrollArea } from '../../custom-scroll-area';
import { cn } from '../../../lib/utils';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  hideTrackWhenIdle?: boolean;
  trackOffsetTop?: number | string;
  trackOffsetBottom?: number | string;
  trackOffsetRight?: number | string;
  trackOffsetLeft?: number | string;
  orientation?: 'vertical' | 'horizontal' | 'both';
  variant?: 'default' | 'dense';
  applyDefaultViewportClassName?: boolean;
  viewportProps?: HTMLAttributes<HTMLDivElement>;
  scrollAutoHide?: 'never' | 'scroll' | 'leave' | 'move';
  scrollAutoHideSuspend?: boolean;
  nativeScrollbars?: boolean;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  (
    {
      className,
      style,
      children,
      viewportClassName,
      viewportRef,
      hideTrackWhenIdle = true,
      trackOffsetTop,
      trackOffsetBottom,
      trackOffsetRight,
      trackOffsetLeft,
      orientation = 'vertical',
      variant = 'default',
      applyDefaultViewportClassName = true,
      viewportProps,
      scrollAutoHide,
      scrollAutoHideSuspend,
      nativeScrollbars,
      ...props
    },
    ref,
  ) => {
    const resolvedViewportClassName = applyDefaultViewportClassName
      ? cn('min-h-0 min-w-0 max-h-[420px] pr-1', viewportClassName)
      : viewportClassName;

    return (
      <CustomScrollArea
        ref={ref}
        className={cn(className)}
        data-variant={variant === 'dense' ? 'dense' : undefined}
        orientation={orientation}
        viewportClassName={resolvedViewportClassName}
        viewportRef={viewportRef}
        viewportProps={viewportProps}
        hideTrackWhenIdle={hideTrackWhenIdle}
        scrollAutoHide={scrollAutoHide}
        scrollAutoHideSuspend={scrollAutoHideSuspend}
        nativeScrollbars={nativeScrollbars}
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
