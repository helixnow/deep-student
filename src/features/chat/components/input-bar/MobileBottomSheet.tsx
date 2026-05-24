/**
 * Chat V2 - MobileBottomSheet 移动端底部抽屉组件
 *
 * 纯 CSS + React 实现，不依赖第三方库。
 *
 * 设计规范：
 * - 默认打开时占 1/2 屏幕高度
 * - 用户可拖拽到满高度（90vh）
 * - 拖拽到低于 1/3 高度时关闭
 * - 点击遮罩关闭（符合 iOS/Material Design 平台规范）
 * - 响应 visualViewport 变化以适配虚拟键盘
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';

export interface MobileBottomSheetProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 子内容 */
  children: React.ReactNode;
  /** 头部内容（使用 MobileSheetHeader 组件） */
  header?: React.ReactNode;
  /** 自定义类名 */
  className?: string;
  /** 吸附点配置（保留兼容但不使用） */
  snapPoints?: (number | string)[];
  /** 默认吸附点索引（保留兼容但不使用） */
  defaultSnapPoint?: number;
}

/** 高度配置（基于视口高度比例） */
const SNAP_HALF = 0.5;      // 默认高度：50%
const SNAP_FULL = 0.9;      // 满高度：90%
const CLOSE_THRESHOLD = 0.33; // 低于 33% 关闭

/**
 * MobileBottomSheet - 移动端底部抽屉组件
 *
 * 纯 React 实现，特性：
 * - 默认 50% 高度，可拖到 90%
 * - 拖到低于 33% 关闭
 * - 点击遮罩关闭（符合平台规范）
 * - iOS 安全区域支持
 * - 响应 visualViewport 适配键盘弹出
 */
export const MobileBottomSheet: React.FC<MobileBottomSheetProps> = ({
  open,
  onClose,
  children,
  header,
  className,
}) => {
  // 当前高度比例（0-1）
  const [heightRatio, setHeightRatio] = useState(SNAP_HALF);
  const [isDragging, setIsDragging] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(SNAP_HALF);
  // ★ 使用 visualViewport 响应键盘弹出/收起引起的可视区域变化
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== 'undefined'
      ? (window.visualViewport?.height ?? window.innerHeight)
      : 800
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      setViewportHeight(vv.height);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // 关闭动画：先收起再隐藏
  const handleClose = useCallback(() => {
    setIsClosing(true);
    setHeightRatio(0);
    // 动画结束后真正关闭
    setTimeout(() => {
      setIsClosing(false);
      setIsVisible(false);
      onClose();
    }, 200);
  }, [onClose]);

  // 处理触摸开始
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    startYRef.current = touch.clientY;
    startHeightRef.current = heightRatio;
    setIsDragging(true);
  }, [heightRatio]);

  // 处理触摸移动
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    const deltaY = startYRef.current - touch.clientY; // 向上为正
    const deltaRatio = deltaY / viewportHeight;
    const newRatio = Math.max(0.1, Math.min(SNAP_FULL, startHeightRef.current + deltaRatio));
    setHeightRatio(newRatio);
  }, [isDragging, viewportHeight]);

  // 处理触摸结束 - snap 到合适的位置
  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);

    // 低于 1/3 关闭（带动画）
    if (heightRatio < CLOSE_THRESHOLD) {
      handleClose();
      return;
    }

    // snap 到最近的吸附点
    const midPoint = (SNAP_HALF + SNAP_FULL) / 2;
    if (heightRatio > midPoint) {
      setHeightRatio(SNAP_FULL);
    } else {
      setHeightRatio(SNAP_HALF);
    }
  }, [isDragging, heightRatio, handleClose]);

  // 鼠标事件（桌面端）
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    startYRef.current = e.clientY;
    startHeightRef.current = heightRatio;
    setIsDragging(true);
  }, [heightRatio]);

  // 全局鼠标事件监听
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const deltaY = startYRef.current - e.clientY;
      const deltaRatio = deltaY / viewportHeight;
      const newRatio = Math.max(0.1, Math.min(SNAP_FULL, startHeightRef.current + deltaRatio));
      setHeightRatio(newRatio);
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);

      // 低于 1/3 关闭（带动画）
      if (heightRatio < CLOSE_THRESHOLD) {
        handleClose();
        return;
      }

      // snap 到最近的吸附点
      const midPoint = (SNAP_HALF + SNAP_FULL) / 2;
      if (heightRatio > midPoint) {
        setHeightRatio(SNAP_FULL);
      } else {
        setHeightRatio(SNAP_HALF);
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, heightRatio, viewportHeight, handleClose]);

  // 打开动画状态
  const [isAnimatingIn, setIsAnimatingIn] = useState(false);

  // 打开时：先显示，再动画展开
  useEffect(() => {
    if (open && !isVisible) {
      setIsVisible(true);
      setIsClosing(false);
      setHeightRatio(0); // 从 0 开始
      setIsDragging(false);
      // 下一帧开始动画
      requestAnimationFrame(() => {
        setIsAnimatingIn(true);
        setHeightRatio(SNAP_HALF);
      });
    } else if (open && isVisible) {
      // 已经可见，只重置高度
      setHeightRatio(SNAP_HALF);
    }
  }, [open, isVisible]);

  // 动画结束后清除动画状态
  useEffect(() => {
    if (isAnimatingIn) {
      const timer = setTimeout(() => setIsAnimatingIn(false), 250);
      return () => clearTimeout(timer);
    }
  }, [isAnimatingIn]);

  // 不显示时返回 null
  if (!isVisible) return null;

  const currentHeight = heightRatio * viewportHeight;

  // 使用 Portal 渲染到 body，确保遮罩覆盖整个应用
  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: Z_INDEX.sheet }}>
      {/* 遮罩层 - 点击关闭（符合 iOS/Material Design 平台规范） */}
      <div 
        className={cn(
          'absolute inset-0 bg-black/60 transition-opacity duration-200',
          isClosing ? 'opacity-0' : 'opacity-100'
        )}
        onClick={() => handleClose()}
      />
      
      {/* 抽屉内容 */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex flex-col overflow-hidden',
          'bg-background rounded-t-2xl shadow-lg border-t border-border',
          !isDragging && 'transition-[height] duration-200 ease-out',
          className
        )}
        style={{
          height: `${currentHeight}px`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 拖拽手柄区域 */}
        <div
          className="flex justify-center pt-3 pb-2 flex-shrink-0 cursor-grab active:cursor-grabbing touch-none select-none"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onMouseDown={handleMouseDown}
        >
          <div className="w-10 h-1.5 rounded-full bg-muted-foreground/40" />
        </div>

        {/* 内容区域 - 子元素应充满整个区域，隐藏所有滚动条 */}
        <div 
          className="flex-1 px-4 pb-safe min-h-0 overflow-y-auto overscroll-contain flex flex-col"
          style={{
            scrollbarWidth: 'none', // Firefox
            msOverflowStyle: 'none', // IE/Edge
          }}
        >
          <style>{`
            .mobile-bottom-sheet-content::-webkit-scrollbar,
            .mobile-bottom-sheet-content *::-webkit-scrollbar {
              display: none;
              width: 0;
              height: 0;
            }
          `}</style>
          
          {/* 统一头部区域 - 确保不被内容覆盖，pointer-events-auto 确保可点击 */}
          {header && (
            <div className="flex-shrink-0 relative z-10 pointer-events-auto" style={{ touchAction: 'auto' }}>
              {header}
            </div>
          )}
          
          {/* 主内容区域 */}
          <div className="mobile-bottom-sheet-content flex-1 min-h-0 flex flex-col overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default MobileBottomSheet;
