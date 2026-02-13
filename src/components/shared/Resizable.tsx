import React, { useRef, useState, useEffect } from 'react';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface HorizontalResizableProps {
  left: React.ReactNode;
  right: React.ReactNode;
  initial?: number; // 0..1 fraction for left width
  minLeft?: number; // 0..1
  minRight?: number; // 0..1
  className?: string;
}

export const HorizontalResizable: React.FC<HorizontalResizableProps> = ({
  left,
  right,
  initial = 0.5,
  minLeft = 0.25,
  minRight = 0.25,
  className,
}) => {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(() => Math.min(1 - minRight, Math.max(minLeft, initial)));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const r = x / rect.width;
      setRatio(Math.min(1 - minRight, Math.max(minLeft, r)));
      e.preventDefault();
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, minLeft, minRight]);

  return (
    <div ref={containerRef} className={`w-full h-full flex select-none ${className || ''}`}>
      <div style={{ width: `calc(${ratio * 100}% - 3px)` }} className="shrink-0 min-w-0 overflow-hidden [&>*]:!w-full [&>*]:!h-full [&>*]:!basis-auto [&>*]:!flex-none">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={() => setDragging(true)}
        className={`w-1.5 cursor-col-resize flex items-center justify-center shrink-0 bg-border ${dragging ? 'bg-primary' : 'hover:bg-primary/30'} transition-colors`}
        title={t('resizable.dragToResizeWidth')}
      >
        <GripVertical className="w-3 h-3 text-muted-foreground/50" />
      </div>
      <div style={{ width: `calc(${(1 - ratio) * 100}% - 3px)` }} className="shrink-0 min-w-0 overflow-hidden [&>*]:!w-full [&>*]:!h-full [&>*]:!basis-auto [&>*]:!flex-none">
        {right}
      </div>
    </div>
  );
};

export default HorizontalResizable;

interface VerticalResizableProps {
  top: React.ReactNode;
  bottom: React.ReactNode;
  initial?: number; // 0..1 fraction for top height
  minTop?: number; // 0..1
  minBottom?: number; // 0..1
  className?: string;
}

export const VerticalResizable: React.FC<VerticalResizableProps> = ({
  top,
  bottom,
  initial = 0.5,
  minTop = 0.2,
  minBottom = 0.2,
  className,
}) => {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(() => Math.min(1 - minBottom, Math.max(minTop, initial)));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      const y = clientY - rect.top;
      const r = y / rect.height;
      setRatio(Math.min(1 - minBottom, Math.max(minTop, r)));
      e.preventDefault();
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [dragging, minTop, minBottom]);

  return (
    <div ref={containerRef} className={`w-full h-full flex flex-col select-none ${className || ''}`}>
      <div style={{ height: `calc(${ratio * 100}% - 12px)` }} className="shrink-0 min-h-0 overflow-hidden [&>*]:!h-full [&>*]:!basis-auto [&>*]:!flex-none">
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={() => setDragging(true)}
        onTouchStart={() => setDragging(true)}
        className={`h-6 cursor-row-resize flex items-center justify-center shrink-0 ${dragging ? 'bg-accent/20' : 'hover:bg-accent/10'} transition-colors`}
        title={t('resizable.dragToResizeHeight')}
      >
        {/* 拖拽手柄指示器 */}
        <div className={`w-12 h-1.5 rounded-full ${dragging ? 'bg-primary' : 'bg-muted-foreground/40'} transition-colors`} />
      </div>
      <div style={{ height: `calc(${(1 - ratio) * 100}% - 12px)` }} className="shrink-0 min-h-0 overflow-hidden [&>*]:!h-full [&>*]:!basis-auto [&>*]:!flex-none">
        {bottom}
      </div>
    </div>
  );
};

