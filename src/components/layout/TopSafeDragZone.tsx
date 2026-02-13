import React from 'react';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import { cn } from '../../lib/utils';

interface TopSafeDragZoneProps {
  height?: string;
  className?: string;
  style?: React.CSSProperties;
}

// A generic top safe drag zone: renders a top spacer bar that can also start window-drag if supported.
const TopSafeDragZone: React.FC<TopSafeDragZoneProps> = ({
  height = '28px',
  className,
  style,
}) => {
  const { startDragging } = useWindowDrag();
  const baseStyle: React.CSSProperties = {
    height,
    minHeight: height,
    width: '100%',
    cursor: 'grab',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    background: 'hsl(var(--background))',
    borderBottom: '1px solid hsl(var(--border) / 0.6)',
    // 仅拦截水平手势，允许垂直方向滚动穿透
    touchAction: 'pan-x',
  };
  return (
    <div
      className={cn('top-safe-drag-zone', className)}
      style={{ ...baseStyle, ...style }}
      onMouseDown={(e) => { try { void startDragging(e); } catch {} }}
      onTouchStart={(e) => { try { void startDragging(e); } catch {} }}
    />
  );
};

export default TopSafeDragZone;

