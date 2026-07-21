import React, { useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';

export interface SettingsVirtualItem {
  key: React.Key;
  estimateSize?: number;
  render: () => React.ReactNode;
}

interface SettingsVirtualListProps {
  items: SettingsVirtualItem[];
  scrollElement: HTMLElement | null;
  className?: string;
  threshold?: number;
  overscan?: number;
  disabled?: boolean;
}

const DEFAULT_THRESHOLD = 20;
const DEFAULT_ESTIMATED_SIZE = 72;

export const SettingsVirtualList: React.FC<SettingsVirtualListProps> = ({
  items,
  scrollElement,
  className,
  threshold = DEFAULT_THRESHOLD,
  overscan = 6,
  disabled = false,
}) => {
  const shouldVirtualize = !disabled && Boolean(scrollElement) && items.length > threshold;

  if (!shouldVirtualize || !scrollElement) {
    return <div className={className}>{items.map((item) => item.render())}</div>;
  }

  return (
    <VirtualSettingsRows
      items={items}
      scrollElement={scrollElement}
      className={className}
      overscan={overscan}
    />
  );
};

const VirtualSettingsRows: React.FC<{
  items: SettingsVirtualItem[];
  scrollElement: HTMLElement;
  className?: string;
  overscan: number;
}> = ({ items, scrollElement, className, overscan }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setScrollMargin(
      container.getBoundingClientRect().top
        - scrollElement.getBoundingClientRect().top
        + scrollElement.scrollTop,
    );
  });

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    getItemKey: (index) => items[index]?.key ?? index,
    estimateSize: (index) => items[index]?.estimateSize ?? DEFAULT_ESTIMATED_SIZE,
    overscan,
    scrollMargin,
  });

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full', className)}
      style={{ height: virtualizer.getTotalSize() }}
      data-settings-virtualized
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) return null;
        return (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
          >
            {item.render()}
          </div>
        );
      })}
    </div>
  );
};
