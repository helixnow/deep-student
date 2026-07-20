/**
 * SidebarDrawer - 抽屉式侧边栏
 *
 * @deprecated 已废弃（2026-07 移动端 UI 规范）：移动端禁止模态浮层，
 * UnifiedSidebar 小屏已强制 panel 内联模式，不再触达本组件（Radix Sheet 模态）。
 * 移动端侧栏统一由 MobileSlidingLayout 页内推拉抽屉承载。
 * 文件保留仅为兼容仍显式使用 displayMode='drawer' 的桌面路径
 * （以及 migrationFoundation.source.test.ts 的源码规范断言），勿在新代码中使用。
 *
 * 从左侧或右侧滑出显示侧边栏内容，支持滑动关闭、自定义宽度等功能
 *
 * ★ 2024-12 更新：增加统一的移动端头部布局支持
 */

import React, { useRef, useEffect, useState, useCallback, type ReactNode } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { shellIconButtonClassName } from '@/components/ui/buttonPrimitiveContract';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetContent } from '@/components/ui/shad/Sheet';
import { X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import type { SidebarDrawerProps } from './types';

export const SidebarDrawer: React.FC<SidebarDrawerProps> = ({
  children,
  open,
  onOpenChange,
  side = 'left',
  width = 280,
  enableSwipeClose = true,
  className,
  // ★ 新增：统一头部布局支持
  showHeader = false,
  headerTitle,
  headerSubtitle,
  headerActions,
}) => {
  const { t } = useTranslation(['common']);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [currentX, setCurrentX] = useState(0);
  const [translateX, setTranslateX] = useState(0);

  // 计算实际宽度
  const actualWidth = typeof width === 'number' ? width + 'px' : width;

  // 处理触摸开始
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enableSwipeClose) return;
    
    const touch = e.touches[0];
    setStartX(touch.clientX);
    setCurrentX(touch.clientX);
    setIsDragging(true);
  }, [enableSwipeClose]);

  // 处理触摸移动
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging || !enableSwipeClose) return;

    const touch = e.touches[0];
    const deltaX = touch.clientX - startX;

    // 左侧抽屉：只允许向左拖动
    // 右侧抽屉：只允许向右拖动
    if (side === 'left' && deltaX < 0) {
      setCurrentX(touch.clientX);
      setTranslateX(deltaX);
    } else if (side === 'right' && deltaX > 0) {
      setCurrentX(touch.clientX);
      setTranslateX(deltaX);
    }
  }, [isDragging, startX, side, enableSwipeClose]);

  // 处理触摸结束
  const handleTouchEnd = useCallback(() => {
    if (!isDragging || !enableSwipeClose) return;

    const deltaX = currentX - startX;
    const threshold = 100; // 滑动阈值（像素）

    // 左侧抽屉：向左滑动超过阈值，关闭
    // 右侧抽屉：向右滑动超过阈值，关闭
    if (
      (side === 'left' && deltaX < -threshold) ||
      (side === 'right' && deltaX > threshold)
    ) {
      onOpenChange(false);
    }

    // 重置状态
    setIsDragging(false);
    setTranslateX(0);
    setStartX(0);
    setCurrentX(0);
  }, [isDragging, currentX, startX, side, onOpenChange, enableSwipeClose]);

  // 添加触摸事件监听
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || !enableSwipeClose) return;

    contentEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    contentEl.addEventListener('touchmove', handleTouchMove, { passive: true });
    contentEl.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      contentEl.removeEventListener('touchstart', handleTouchStart);
      contentEl.removeEventListener('touchmove', handleTouchMove);
      contentEl.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, enableSwipeClose]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={cn(
          // 开闭滑入滑出由 SheetContent 按 side 提供（ui-slide-in-* / ui-slide-out-*）
          'sidebar-shell-drawer !p-0 overflow-hidden flex flex-col [&>button]:hidden',
          className
        )}
        style={{
          width: actualWidth,
          maxWidth: actualWidth,
          // 从顶栏下方开始，不覆盖顶栏。
          // P0-3: 移动壳的真实顶栏高度是 --mobile-header-total-height（56px + 安全区），
          // 优先消费它；未定义时（桌面壳）回退到旧的 48px + --topbar-safe-area 估算。
          top: 'var(--mobile-header-total-height, calc(48px + var(--topbar-safe-area, 20px)))',
          height: 'calc(100% - var(--mobile-header-total-height, calc(48px + var(--topbar-safe-area, 20px))))',
          transform: translateX !== 0 ? 'translateX(' + translateX + 'px)' : undefined,
          transition: isDragging ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        <div
          ref={contentRef}
          className="h-full w-full flex flex-col bg-background overflow-hidden"
        >
          {/* ★ 统一的移动端侧边栏头部（如果需要外部头部） */}
          {showHeader && (
            <div className="flex items-center gap-3 px-4 py-3 shrink-0 border-b border-border/50">
              {/* 关闭按钮 */}
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => onOpenChange(false)} className={cn(shellIconButtonClassName, '-ml-1')} aria-label={t('common:sidebar.close')}>
                <X size={20} weight="regular" />
              </NotionButton>

              {/* 标题区域 */}
              {(headerTitle || headerSubtitle) && (
                <div className="flex-1 min-w-0">
                  {headerTitle && (
                    <h3 className="text-sm font-medium text-foreground truncate">
                      {headerTitle}
                    </h3>
                  )}
                  {headerSubtitle && (
                    <p className="text-xs text-muted-foreground truncate">
                      {headerSubtitle}
                    </p>
                  )}
                </div>
              )}

              {/* 右侧操作区 */}
              {headerActions && (
                <div className="flex items-center gap-1 shrink-0">
                  {headerActions}
                </div>
              )}
            </div>
          )}

          {/* 内容区域 - 直接渲染 children，让 UnifiedSidebar 自己处理滚动 */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {children}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default SidebarDrawer;
