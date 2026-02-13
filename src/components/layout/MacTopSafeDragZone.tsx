import React from 'react';
import { isMacOS } from '../../utils/platform';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import { cn } from '../../lib/utils';
import { Z_INDEX } from '@/config/zIndex';

interface MacTopSafeDragZoneProps {
  height?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const MacTopSafeDragZone: React.FC<MacTopSafeDragZoneProps> = ({
  height = 'calc(var(--safe-area-inset-top) + 28px)',
  className,
  style,
}) => {
  const { startDragging } = useWindowDrag();

  // 默认关闭伪装标题栏，仅当显式开启时才渲染
  const enabled = typeof window !== 'undefined' &&
    (window as any).__DS_ENABLE_FAKE_TITLEBAR__ === true;

  if (!isMacOS() || !enabled) return null;

  const baseStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    height,
    minHeight: height,
    width: '100%',
    cursor: 'grab',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    background: 'hsl(var(--background))',
    borderBottom: '1px solid hsl(var(--border) / 0.6)',
    touchAction: 'none',
    zIndex: Z_INDEX.systemTitlebar - 1,
    pointerEvents: 'auto',
  };

  return (
    <div
      className={cn('mac-top-safe-drag-zone', className)}
      style={{ ...baseStyle, ...style }}
      onMouseDown={(e) => { void startDragging(e); }}
      onTouchStart={(e) => { void startDragging(e); }}
    />
  );
};

export default MacTopSafeDragZone;
