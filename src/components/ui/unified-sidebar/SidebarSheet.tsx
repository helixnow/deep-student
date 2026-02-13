/**
 * SidebarSheet - 底部弹出式侧边栏
 * 
 * 用于移动端场景，从底部弹出显示侧边栏内容
 * 支持滑动关闭、自定义高度等功能
 *
 * ★ 手势隔离策略：
 *   - 只在拖拽手柄区域监听触摸事件（passive: false + preventDefault）
 *   - 内容区域不拦截触摸，保证列表正常滚动
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Sheet, SheetContent } from '@/components/ui/shad/Sheet';
import { cn } from '@/lib/utils';
import type { SidebarSheetProps } from './types';

export const SidebarSheet: React.FC<SidebarSheetProps> = ({
  children,
  open,
  onOpenChange,
  defaultHeight = 0.6,
  enableSwipeClose = true,
  className,
}) => {
  // ★ 只在拖拽手柄区域监听触摸，不干扰内容区域滚动
  const handleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startY, setStartY] = useState(0);
  const [currentY, setCurrentY] = useState(0);
  const [translateY, setTranslateY] = useState(0);

  // 计算实际高度（百分比）
  const heightPercentage = defaultHeight * 100;
  const actualHeight = heightPercentage + 'vh';

  // 处理触摸开始（仅手柄区域）
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enableSwipeClose) return;
    
    const touch = e.touches[0];
    setStartY(touch.clientY);
    setCurrentY(touch.clientY);
    setIsDragging(true);
  }, [enableSwipeClose]);

  // 处理触摸移动（仅手柄区域，可 preventDefault）
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging || !enableSwipeClose) return;

    const touch = e.touches[0];
    const deltaY = touch.clientY - startY;

    // 只允许向下拖动，阻止浏览器默认行为防止滚动冲突
    if (deltaY > 0) {
      e.preventDefault();
      setCurrentY(touch.clientY);
      setTranslateY(deltaY);
    }
  }, [isDragging, startY, enableSwipeClose]);

  // 处理触摸结束
  const handleTouchEnd = useCallback(() => {
    if (!isDragging || !enableSwipeClose) return;

    const deltaY = currentY - startY;
    const threshold = 100; // 滑动阈值（像素）

    if (deltaY > threshold) {
      // 向下滑动超过阈值，关闭 Sheet
      onOpenChange(false);
    }

    // 重置状态
    setIsDragging(false);
    setTranslateY(0);
    setStartY(0);
    setCurrentY(0);
  }, [isDragging, currentY, startY, onOpenChange, enableSwipeClose]);

  // ★ 触摸事件只绑定到拖拽手柄区域，不影响内容区域滚动
  useEffect(() => {
    const handleEl = handleRef.current;
    if (!handleEl || !enableSwipeClose) return;

    handleEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    // touchmove 使用 passive: false，以便 preventDefault 阻止手柄区域的默认滚动
    handleEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    handleEl.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      handleEl.removeEventListener('touchstart', handleTouchStart);
      handleEl.removeEventListener('touchmove', handleTouchMove);
      handleEl.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, enableSwipeClose]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn(
          'p-0 max-h-[90vh] overflow-hidden',
          'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
          className
        )}
        style={{
          height: actualHeight,
          transform: translateY > 0 ? 'translateY(' + translateY + 'px)' : undefined,
          transition: isDragging ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        <div className="h-full flex flex-col">
          {/* 拖动指示器 — 手势只在此区域生效 */}
          {enableSwipeClose && (
            <div
              ref={handleRef}
              className="flex justify-center py-2 cursor-grab active:cursor-grabbing touch-none select-none"
            >
              <div className="w-12 h-1 rounded-full bg-muted-foreground/30" />
            </div>
          )}

          {/* 内容区域 - 不拦截触摸事件，让 UnifiedSidebar 自己处理滚动 */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {children}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default SidebarSheet;
