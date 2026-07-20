import React, { useRef, useState, useEffect } from 'react';
import { DotsSixVertical } from '@phosphor-icons/react';
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
    if (!dragging) return;
    // WebView2 高刷鼠标（125Hz+）下 per-event getBoundingClientRect + setState 会逐帧触发 layout，
    // 这里 mousemove 只缓存最新坐标，rAF 每帧消费一次；
    // 拖拽期间只有子项宽度变化、容器 rect 不变，入场缓存一次即可
    const rect = containerRef.current?.getBoundingClientRect() ?? null;
    let rafId = 0;
    let pendingX: number | null = null;

    const applyPending = () => {
      rafId = 0;
      if (pendingX === null || !rect) return;
      const r = (pendingX - rect.left) / rect.width;
      pendingX = null;
      setRatio(Math.min(1 - minRight, Math.max(minLeft, r)));
    };
    const onMove = (e: MouseEvent) => {
      pendingX = e.clientX;
      if (rafId === 0) rafId = requestAnimationFrame(applyPending);
      e.preventDefault();
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      pendingX = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, minLeft, minRight]);

  return (
    <div ref={containerRef} className={`w-full h-full min-h-0 flex select-none ${className || ''}`}>
      <div style={{ width: `calc(${ratio * 100}% - 3px)` }} className="h-full min-h-0 shrink-0 min-w-0 overflow-hidden [&>*]:!w-full [&>*]:!h-full [&>*]:!min-h-0 [&>*]:!basis-auto [&>*]:!flex-none">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={() => setDragging(true)}
        className={`w-1.5 cursor-col-resize flex items-center justify-center shrink-0 bg-border ${dragging ? 'bg-primary' : 'hover:bg-primary/30'} transition-colors`}
        title={t('resizable.dragToResizeWidth')}
      >
        <DotsSixVertical size={12} className="text-muted-foreground/50" />
      </div>
      <div style={{ width: `calc(${(1 - ratio) * 100}% - 3px)` }} className="h-full min-h-0 shrink-0 min-w-0 overflow-hidden [&>*]:!w-full [&>*]:!h-full [&>*]:!min-h-0 [&>*]:!basis-auto [&>*]:!flex-none">
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
    if (!dragging) return;
    // 同 HorizontalResizable：高频指针事件只缓存坐标，rAF 合并计算；容器 rect 在拖拽期间不变
    const rect = containerRef.current?.getBoundingClientRect() ?? null;
    let rafId = 0;
    let pendingY: number | null = null;

    const applyPending = () => {
      rafId = 0;
      if (pendingY === null || !rect) return;
      const r = (pendingY - rect.top) / rect.height;
      pendingY = null;
      setRatio(Math.min(1 - minBottom, Math.max(minTop, r)));
    };
    const onMove = (e: MouseEvent | TouchEvent) => {
      pendingY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      if (rafId === 0) rafId = requestAnimationFrame(applyPending);
      e.preventDefault();
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      pendingY = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [dragging, minTop, minBottom]);

  return (
    <div ref={containerRef} className={`w-full h-full min-h-0 flex flex-col select-none ${className || ''}`}>
      <div style={{ height: `calc(${ratio * 100}% - 12px)` }} className="shrink-0 min-h-0 overflow-hidden [&>*]:!h-full [&>*]:!min-h-0 [&>*]:!basis-auto [&>*]:!flex-none">
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={() => setDragging(true)}
        onTouchStart={() => setDragging(true)}
        className={`h-6 cursor-row-resize flex items-center justify-center shrink-0 ${dragging ? 'bg-accent/20' : 'hover:bg-[var(--interactive-hover)]'} transition-colors`}
        title={t('resizable.dragToResizeHeight')}
      >
        {/* 拖拽手柄指示器 */}
        <div className={`w-12 h-1.5 rounded-full ${dragging ? 'bg-primary' : 'bg-muted-foreground/40'} transition-colors`} />
      </div>
      <div style={{ height: `calc(${(1 - ratio) * 100}% - 12px)` }} className="shrink-0 min-h-0 overflow-hidden [&>*]:!h-full [&>*]:!min-h-0 [&>*]:!basis-auto [&>*]:!flex-none">
        {bottom}
      </div>
    </div>
  );
};

