/**
 * MobileSlidingLayout - 移动端推拉式三屏滑动布局
 *
 * DeepSeek 风格：侧边栏、主视图、右侧面板连为一体，滑动时整体平移
 * 无遮罩层，更接近原生 App 体验
 * 支持触摸和鼠标拖拽
 *
 * 三屏布局：左侧栏 ← 中间主视图 → 右侧面板
 */

import React, { useRef, useState, useCallback, useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** 三屏位置枚举 */
export type ScreenPosition = 'left' | 'center' | 'right';

/** 需要放行手势的交互元素选择器，避免阻断点击 */
const INTERACTIVE_SELECTOR = 'button, [role="button"], a, input, select, textarea, option, label, [data-gesture-ignore]';

const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
};

interface MobileSlidingLayoutProps {
  /** 侧边栏内容 */
  sidebar: ReactNode;
  /** 主内容 */
  children: ReactNode;
  /** 右侧面板内容（可选，用于三屏布局） */
  rightPanel?: ReactNode;
  /** 侧边栏是否打开（两屏模式兼容） */
  sidebarOpen?: boolean;
  /** 侧边栏状态变化回调（两屏模式兼容） */
  onSidebarOpenChange?: (open: boolean) => void;
  /** 当前屏幕位置（三屏模式） */
  screenPosition?: ScreenPosition;
  /** 屏幕位置变化回调（三屏模式） */
  onScreenPositionChange?: (position: ScreenPosition) => void;
  /**
   * 侧边栏宽度
   * - 数字：固定像素宽度（默认 280px）
   * - 'auto'：自动计算为接近全屏宽度（100vw - mainContentPeekWidth）
   */
  sidebarWidth?: number | 'auto';
  /**
   * 主内容露出宽度（仅当 sidebarWidth='auto' 时生效）
   * 默认 60px，让主内容露出一小部分作为视觉提示
   */
  mainContentPeekWidth?: number;
  /** 是否启用手势滑动，默认 true */
  enableGesture?: boolean;
  /** 触发滑动的边缘宽度，默认 20px */
  edgeWidth?: number;
  /** 滑动阈值比例，超过则切换状态，默认 0.3 */
  threshold?: number;
  /** 容器类名 */
  className?: string;
  /** 右侧面板是否可用（只有可用时才能滑动到右侧） */
  rightPanelEnabled?: boolean;
}

export const MobileSlidingLayout: React.FC<MobileSlidingLayoutProps> = ({
  sidebar,
  children,
  rightPanel,
  sidebarOpen,
  onSidebarOpenChange,
  screenPosition: screenPositionProp,
  onScreenPositionChange,
  sidebarWidth: sidebarWidthProp = 'auto',
  mainContentPeekWidth = 60,
  enableGesture = true,
  threshold = 0.3,
  className,
  rightPanelEnabled = false,
}) => {
  // 判断是否为三屏模式
  const isThreeScreenMode = rightPanel !== undefined && onScreenPositionChange !== undefined;

  // 三屏模式下的屏幕位置，两屏模式下通过 sidebarOpen 推断
  const screenPosition: ScreenPosition = isThreeScreenMode
    ? (screenPositionProp ?? 'center')
    : (sidebarOpen ? 'left' : 'center');
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    currentTranslate: 0,
    axisLocked: null as 'horizontal' | 'vertical' | null,
    baseTranslate: 0,
  });

  // 用于触发重渲染
  const [, forceUpdate] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [currentTranslate, setCurrentTranslate] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  // 监听容器宽度变化
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setContainerWidth(container.clientWidth);
    };

    // 初始化宽度
    updateWidth();

    // 使用 ResizeObserver 监听容器尺寸变化
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // 计算实际侧边栏宽度
  const sidebarWidth = sidebarWidthProp === 'auto'
    ? Math.max(containerWidth - mainContentPeekWidth, 280) // 最小 280px
    : sidebarWidthProp;

  // 计算当前偏移量（三屏模式）
  const getBaseTranslate = useCallback(() => {
    switch (screenPosition) {
      case 'left': return 0; // 显示左侧边栏
      case 'center': return -sidebarWidth; // 显示中间主视图
      case 'right': return -(sidebarWidth + containerWidth); // 显示右侧面板
      default: return -sidebarWidth;
    }
  }, [screenPosition, sidebarWidth, containerWidth]);

  const baseTranslate = getBaseTranslate();
  stateRef.current.baseTranslate = baseTranslate;

  // 处理开始拖拽（触摸/鼠标）
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    if (!enableGesture) return;

    stateRef.current.isDragging = true;
    stateRef.current.startX = clientX;
    stateRef.current.startY = clientY;
    stateRef.current.currentTranslate = baseTranslate;
    stateRef.current.axisLocked = null;

    setIsDragging(true);
    setCurrentTranslate(baseTranslate);
  }, [enableGesture, baseTranslate]);

  // 处理拖拽移动
  const handleDragMove = useCallback((clientX: number, clientY: number, preventDefault: () => void) => {
    if (!enableGesture || !stateRef.current.isDragging) return;

    const deltaX = clientX - stateRef.current.startX;
    const deltaY = clientY - stateRef.current.startY;

    // 首先确定滑动轴向（只判断一次）
    if (stateRef.current.axisLocked === null && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
      // 水平滑动幅度大于垂直滑动的 1.2 倍，认为是水平滑动
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
        stateRef.current.axisLocked = 'horizontal';
      } else {
        // 垂直滑动，取消拖拽，让原生滚动接管
        stateRef.current.axisLocked = 'vertical';
        stateRef.current.isDragging = false;
        setIsDragging(false);
        return;
      }
    }

    // 如果是垂直滑动，不处理
    if (stateRef.current.axisLocked === 'vertical') {
      return;
    }

    // 水平滑动时阻止默认行为
    if (stateRef.current.axisLocked === 'horizontal') {
      preventDefault();
    }

    // 计算新的偏移量
    let newTranslate = stateRef.current.baseTranslate + deltaX;

    // 限制范围：三屏模式下考虑右侧面板
    const minTranslate = isThreeScreenMode && rightPanelEnabled
      ? -(sidebarWidth + containerWidth) // 可以滑动到右侧面板
      : -sidebarWidth; // 两屏模式或右侧面板不可用
    const maxTranslate = 0;
    newTranslate = Math.max(minTranslate, Math.min(maxTranslate, newTranslate));

    stateRef.current.currentTranslate = newTranslate;
    setCurrentTranslate(newTranslate);
  }, [enableGesture, sidebarWidth, containerWidth, isThreeScreenMode, rightPanelEnabled]);

  // 处理拖拽结束
  const handleDragEnd = useCallback(() => {
    if (!stateRef.current.isDragging) {
      stateRef.current.axisLocked = null;
      return;
    }

    const deltaX = stateRef.current.currentTranslate - stateRef.current.baseTranslate;
    const thresholdPx = sidebarWidth * threshold;

    // 三屏模式下的状态切换逻辑
    if (isThreeScreenMode && onScreenPositionChange) {
      if (Math.abs(deltaX) > thresholdPx) {
        if (deltaX > 0) {
          // 向右滑动
          if (screenPosition === 'center') onScreenPositionChange('left');
          else if (screenPosition === 'right') onScreenPositionChange('center');
        } else {
          // 向左滑动
          if (screenPosition === 'center' && rightPanelEnabled) onScreenPositionChange('right');
          else if (screenPosition === 'left') onScreenPositionChange('center');
        }
      }
    } else if (onSidebarOpenChange) {
      // 两屏模式兼容逻辑
      const progress = Math.abs(deltaX) / sidebarWidth;
      if (sidebarOpen) {
        if (deltaX < 0 && progress > threshold) {
          onSidebarOpenChange(false);
        }
      } else {
        if (deltaX > 0 && progress > threshold) {
          onSidebarOpenChange(true);
        }
      }
    }

    stateRef.current.isDragging = false;
    stateRef.current.axisLocked = null;
    setIsDragging(false);
  }, [sidebarWidth, sidebarOpen, threshold, onSidebarOpenChange, isThreeScreenMode, onScreenPositionChange, screenPosition, rightPanelEnabled]);

  // 绑定原生事件（支持 passive: false）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 触摸事件
    const onTouchStart = (e: TouchEvent) => {
      if (isInteractiveTarget(e.target)) return;
      const touch = e.touches[0];
      handleDragStart(touch.clientX, touch.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY, () => e.preventDefault());
    };

    const onTouchEnd = () => {
      handleDragEnd();
    };

    // 鼠标事件
    const onMouseDown = (e: MouseEvent) => {
      // 只响应左键
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;
      handleDragStart(e.clientX, e.clientY);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!stateRef.current.isDragging) return;
      handleDragMove(e.clientX, e.clientY, () => e.preventDefault());
    };

    const onMouseUp = () => {
      handleDragEnd();
    };

    // 绑定触摸事件
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });

    // 绑定鼠标事件
    container.addEventListener('mousedown', onMouseDown);
    // mousemove 和 mouseup 绑定到 document，以便在容器外也能响应
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [handleDragStart, handleDragMove, handleDragEnd]);

  // 计算最终的 transform 值
  const translateX = isDragging ? currentTranslate : baseTranslate;

  // 计算容器总宽度
  const totalWidth = isThreeScreenMode
    ? sidebarWidth + containerWidth + containerWidth // 三屏：侧栏 + 主视图 + 右侧面板
    : sidebarWidth + containerWidth; // 两屏：侧栏 + 主视图

  return (
    <div
      ref={containerRef}
      className={cn('h-full overflow-hidden select-none', className)}
      style={{ touchAction: 'pan-y pinch-zoom', cursor: isDragging ? 'grabbing' : 'default' }}
    >
      <div
        className="flex h-full"
        style={{
          width: totalWidth || `calc(100% + ${sidebarWidth}px)`,
          transform: `translateX(${translateX}px)`,
          transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* 侧边栏 */}
        <div
          className="h-full flex-shrink-0 bg-background"
          style={{ width: sidebarWidth }}
        >
          {sidebar}
        </div>

        {/* 主内容区域 - 宽度等于外层容器宽度（视口宽度） */}
        <div
          className="h-full flex-shrink-0 bg-background overflow-x-hidden"
          style={{ width: containerWidth || '100vw' }}
        >
          {children}
        </div>

        {/* 右侧面板（三屏模式） */}
        {isThreeScreenMode && (
          <div
            className="flex flex-col bg-background"
            style={{ width: containerWidth || '100vw', height: '100%' }}
          >
            {rightPanel}
          </div>
        )}
      </div>
    </div>
  );
};

export default MobileSlidingLayout;
