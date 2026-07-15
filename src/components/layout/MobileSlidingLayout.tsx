/**
 * MobileSlidingLayout - 移动端推拉式三屏滑动布局
 *
 * DeepSeek 风格：侧边栏、主视图、右侧面板连为一体，滑动时整体平移
 * 可选主内容遮罩，用于贴近 study-ui 抽屉式侧边栏
 * 支持触摸和鼠标拖拽
 *
 * 三屏布局：左侧栏 ← 中间主视图 → 右侧面板
 */

import React, { useRef, useState, useCallback, useEffect, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMobileLayoutSafe } from './MobileLayoutContext';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MobileUnifiedDrawerProvider } from './MobileDrawerContext';
import { MobileSidebarNavigation } from './MobileSidebarNavigation';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

/** 三屏位置枚举 */
export type ScreenPosition = 'left' | 'center' | 'right';

/** 需要放行手势的交互元素选择器，避免阻断点击 */
const INTERACTIVE_SELECTOR = 'button, [role="button"], a, input, select, textarea, option, label, [data-gesture-ignore]';

/**
 * F1/C-9: 自带手势的内容默认豁免布局手势（非边缘起手时）。
 * PDF 查看器（捏合缩放/拖动）、思维导图画布（节点拖拽/平移）、富文本编辑器
 * （光标拖选）内的横向手势不应被三屏布局劫持;屏幕边缘 edgeWidth 内起手仍
 * 优先布局手势,保证"随时可滑回"。调用方可通过 gestureIgnoreSelector 覆盖。
 */
export const DEFAULT_GESTURE_IGNORE_SELECTOR =
  '[data-no-screen-swipe], .ds-pdf-viewer, .react-pdf__Page, .mindmap-container, .react-flow, .ProseMirror';

const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
};

/**
 * C-9: 触点落在可横向滚动的内容（代码块/宽表格/横滑卡片区）内时，
 * 放行原生滚动，避免布局手势劫持。
 */
const isInsideHorizontalScrollable = (target: EventTarget | null, boundary: HTMLElement): boolean => {
  let el: Element | null = target instanceof Element ? target : null;
  while (el && el !== boundary) {
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1) {
      const overflowX = window.getComputedStyle(el).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
};

/** C-9: 存在未折叠文本选区时挂起布局手势（用户可能在拖选择手柄） */
const hasActiveTextSelection = (): boolean => {
  const selection = window.getSelection();
  return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
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
   * - 数字 > 1：固定像素宽度（默认 280px）
   * - 数字 (0, 1]：容器宽度的比例（如 0.575 = 57.5%）
   * - 'auto'：自动计算为接近全屏宽度（100vw - mainContentPeekWidth）
   * - 'half'：容器宽度的 50%
   */
  sidebarWidth?: number | 'auto' | 'half';
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
  /** 是否自动注入移动端应用导航 */
  showSidebarAppNavigation?: boolean;
  /** 侧边栏打开时是否给主内容加遮罩 */
  showContentOverlay?: boolean;
  /**
   * 额外的手势豁免选择器：触点落在匹配元素内时不启动布局手势，
   * 用于 PDF 查看器/思维导图画布/富文本编辑器等自带手势的内容
   */
  gestureIgnoreSelector?: string;
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
  edgeWidth = 20,
  threshold = 0.3,
  className,
  rightPanelEnabled = false,
  showSidebarAppNavigation = true,
  showContentOverlay = false,
  gestureIgnoreSelector = DEFAULT_GESTURE_IGNORE_SELECTOR,
}) => {
  const { t } = useTranslation('common');
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
    /** 拖拽开始时的 baseTranslate 快照，拖拽过程中不会被渲染更新覆盖 */
    dragStartBase: 0,
    /** fling 检测：最近一次 move 的位置/时间与指数平滑速度（px/ms） */
    lastMoveX: 0,
    lastMoveTime: 0,
    velocityX: 0,
  });

  const [isDragging, setIsDragging] = useState(false);
  const [currentTranslate, setCurrentTranslate] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isActiveViewLayer, setIsActiveViewLayer] = useState(true);
  const mobileLayout = useMobileLayoutSafe();
  const isMobileLayout = mobileLayout?.isMobile ?? false;
  const enterFullscreen = mobileLayout?.enterFullscreen;
  const exitFullscreen = mobileLayout?.exitFullscreen;
  const fullscreenClaimId = useId();
  const hasSidebar = sidebar !== null && sidebar !== undefined;

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

  // The app keeps visited views mounted. Only the visible layer should be allowed
  // to claim fullscreen-content state (consumed by InputBarUI bottom padding)
  // when one of its side panels is open.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const viewLayer = container.closest('[data-view-layer-shell]');
    if (!viewLayer) {
      setIsActiveViewLayer(true);
      return;
    }

    const updateActiveState = () => {
      const style = window.getComputedStyle(viewLayer);
      setIsActiveViewLayer(
        style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none' &&
        style.opacity !== '0'
      );
    };

    updateActiveState();
    const observer = new MutationObserver(updateActiveState);
    observer.observe(viewLayer, { attributes: true, attributeFilter: ['class', 'style'] });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const shouldHideBottomTab = Boolean(
      isMobileLayout &&
      isActiveViewLayer &&
      (screenPosition !== 'center' || isDragging)
    );

    if (shouldHideBottomTab) {
      enterFullscreen?.(fullscreenClaimId);
    } else {
      exitFullscreen?.(fullscreenClaimId);
    }

    return () => {
      exitFullscreen?.(fullscreenClaimId);
    };
  }, [enterFullscreen, exitFullscreen, fullscreenClaimId, isActiveViewLayer, isDragging, isMobileLayout, screenPosition]);

  // 计算实际侧边栏宽度
  const sidebarWidth = sidebarWidthProp === 'auto'
    ? Math.max(containerWidth - mainContentPeekWidth, 280) // 最小 280px
    : sidebarWidthProp === 'half'
      ? Math.max(Math.round(containerWidth / 2), 180)
      : sidebarWidthProp > 0 && sidebarWidthProp <= 1
        ? Math.max(Math.round(containerWidth * sidebarWidthProp), 200) // 比例宽度
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
  // 仅在未拖拽时同步 baseTranslate，防止拖拽中途被渲染更新覆盖
  if (!stateRef.current.isDragging) {
    stateRef.current.baseTranslate = baseTranslate;
  }

  // 处理开始拖拽（触摸/鼠标）
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    if (!enableGesture) return;

    stateRef.current.isDragging = true;
    stateRef.current.startX = clientX;
    stateRef.current.startY = clientY;
    stateRef.current.currentTranslate = baseTranslate;
    stateRef.current.axisLocked = null;
    stateRef.current.dragStartBase = baseTranslate;
    stateRef.current.baseTranslate = baseTranslate;
    stateRef.current.lastMoveX = clientX;
    stateRef.current.lastMoveTime = performance.now();
    stateRef.current.velocityX = 0;

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

    // 轴向尚未确定时不更新位置，避免微小偏移
    if (stateRef.current.axisLocked !== 'horizontal') {
      return;
    }

    // fling 检测：指数平滑瞬时速度，抑制单帧抖动
    const now = performance.now();
    const dt = now - stateRef.current.lastMoveTime;
    if (dt > 0) {
      const instantVelocity = (clientX - stateRef.current.lastMoveX) / dt;
      stateRef.current.velocityX = stateRef.current.velocityX * 0.7 + instantVelocity * 0.3;
    }
    stateRef.current.lastMoveX = clientX;
    stateRef.current.lastMoveTime = now;

    // 计算新的偏移量（使用拖拽开始时的快照，防止中途被渲染更新干扰）
    let newTranslate = stateRef.current.dragStartBase + deltaX;

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

    const deltaX = stateRef.current.currentTranslate - stateRef.current.dragStartBase;
    const thresholdPx = sidebarWidth * threshold;

    // fling：快速轻扫时即使位移不足距离阈值也按方向切换（与原生抽屉手感一致）。
    // 松手前停顿超过 100ms 视为无惯性，避免"拖出去停住再松手"误判为 fling。
    const FLING_VELOCITY_THRESHOLD = 0.35; // px/ms
    const flingExpired = performance.now() - stateRef.current.lastMoveTime > 100;
    const velocityX = flingExpired ? 0 : stateRef.current.velocityX;
    const isFling =
      (velocityX > FLING_VELOCITY_THRESHOLD && deltaX > 0) ||
      (velocityX < -FLING_VELOCITY_THRESHOLD && deltaX < 0);
    const shouldSwitch = Math.abs(deltaX) > thresholdPx || isFling;

    // 三屏模式下的状态切换逻辑
    if (isThreeScreenMode && onScreenPositionChange) {
      if (shouldSwitch) {
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
      if (sidebarOpen) {
        if (deltaX < 0 && shouldSwitch) {
          onSidebarOpenChange(false);
        }
      } else {
        if (deltaX > 0 && shouldSwitch) {
          onSidebarOpenChange(true);
        }
      }
    }

    stateRef.current.isDragging = false;
    stateRef.current.axisLocked = null;
    setIsDragging(false);
  }, [sidebarWidth, sidebarOpen, threshold, onSidebarOpenChange, isThreeScreenMode, onScreenPositionChange, screenPosition, rightPanelEnabled]);

  const closeSidebarAfterAppNavigation = useCallback(() => {
    if (isThreeScreenMode && onScreenPositionChange) {
      onScreenPositionChange('center');
      return;
    }

    onSidebarOpenChange?.(false);
  }, [isThreeScreenMode, onScreenPositionChange, onSidebarOpenChange]);

  // Android 返回键（A-5）：侧栏/右面板展开时，返回键先收回到主视图
  //
  // ⚠️ 调用方契约：本 handler 在非中屏时无条件消费返回键并调用
  // onScreenPositionChange('center')（或 onSidebarOpenChange(false)）。
  // 调用方必须保证该回调真正把 screenPosition 派生回 'center'——若存在额外
  // 状态把位置锁在 left/right（如"工作台打开时强制右屏"），返回键会被消费
  // 但界面不动，形成死循环。此类场景调用方需在回调里同步重置锁定状态
  // （参考 ChatV2Page 沙箱工作台的处理）。
  const backStateRef = useRef({ screenPosition, isActiveViewLayer, close: closeSidebarAfterAppNavigation });
  backStateRef.current = { screenPosition, isActiveViewLayer, close: closeSidebarAfterAppNavigation };
  useEffect(() => {
    if (!isMobileLayout) return;
    return registerBackHandler(() => {
      const { screenPosition: pos, isActiveViewLayer: active, close } = backStateRef.current;
      if (!active || pos === 'center') return false;
      close();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isMobileLayout]);

  // 绑定原生事件（支持 passive: false）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // C-9: 非边缘起手时检测冲突源（横向滚动容器/文本选区/自带手势内容），避免手势劫持。
    // 边缘起手（edgeWidth 内）保持布局手势优先，保证"随时可滑回"的可达性。
    const shouldYieldToContent = (target: EventTarget | null, clientX: number): boolean => {
      const rect = container.getBoundingClientRect();
      const fromEdge = clientX - rect.left <= edgeWidth || rect.right - clientX <= edgeWidth;
      if (fromEdge) return false;
      if (hasActiveTextSelection()) return true;
      if (
        gestureIgnoreSelector &&
        target instanceof Element &&
        target.closest(gestureIgnoreSelector)
      ) {
        return true;
      }
      return isInsideHorizontalScrollable(target, container);
    };

    // 触摸事件
    const onTouchStart = (e: TouchEvent) => {
      if (isInteractiveTarget(e.target)) return;
      const touch = e.touches[0];
      if (shouldYieldToContent(e.target, touch.clientX)) return;
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
      if (shouldYieldToContent(e.target, e.clientX)) return;
      handleDragStart(e.clientX, e.clientY);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!stateRef.current.isDragging) return;
      handleDragMove(e.clientX, e.clientY, () => e.preventDefault());
    };

    const onMouseUp = () => {
      handleDragEnd();
    };

    // 页面失焦 / 上下文菜单弹出时，强制结束拖拽，防止 isDragging 卡死
    const onDragAbort = () => {
      if (stateRef.current.isDragging) {
        handleDragEnd();
      }
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

    // 安全兜底：页面不可见或弹出菜单时结束拖拽
    document.addEventListener('visibilitychange', onDragAbort);
    document.addEventListener('contextmenu', onDragAbort);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('visibilitychange', onDragAbort);
      document.removeEventListener('contextmenu', onDragAbort);
    };
  }, [handleDragStart, handleDragMove, handleDragEnd, edgeWidth, gestureIgnoreSelector]);

  // 计算最终的 transform 值
  const translateX = isDragging ? currentTranslate : baseTranslate;
  const sidebarRevealProgress = showContentOverlay && hasSidebar
    ? Math.max(0, Math.min(1, (translateX + sidebarWidth) / Math.max(sidebarWidth, 1)))
    : 0;
  const isSidebarOverlayInteractive = sidebarRevealProgress > 0.98 && screenPosition === 'left' && !isDragging;

  // 计算容器总宽度
  const totalWidth = isThreeScreenMode
    ? sidebarWidth + containerWidth + containerWidth // 三屏：侧栏 + 主视图 + 右侧面板
    : sidebarWidth + containerWidth; // 两屏：侧栏 + 主视图

  return (
    <div
      ref={containerRef}
      className={cn('relative h-full overflow-hidden select-none', className)}
      style={{
        touchAction: 'pan-y pinch-zoom',
        cursor: isDragging ? 'grabbing' : 'default',
      }}
    >
      <div
        className="flex h-full motion-reduce:transition-none"
        style={{
          width: totalWidth || `calc(100% + ${sidebarWidth}px)`,
          transform: `translate3d(${translateX}px, 0, 0)`,
          // WebView 下 transform 过渡会卡在起点，导致汉堡菜单点了抽屉不动；手势拖拽期间本就不过渡
          transition: 'none',
        }}
      >
        {/* 侧边栏：页内工具 + 全局导航 统一滚动（融合双栏） */}
        <MobileUnifiedDrawerProvider value={isMobileLayout && hasSidebar}>
          <div
            data-mobile-unified-drawer={isMobileLayout && hasSidebar ? '' : undefined}
            className={cn(
              'relative z-[2] flex h-full min-h-0 flex-shrink-0 flex-col font-sidebar-study-ui',
              isMobileLayout && hasSidebar
                ? 'bg-background text-foreground'
                : 'bg-background',
            )}
            style={{ width: sidebarWidth }}
          >
            {hasSidebar ? (
              isMobileLayout ? (
                <CustomScrollArea
                  className="min-h-0 flex-1"
                  viewportClassName="px-2 py-1 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]"
                >
                  <div data-mobile-drawer-page className="min-h-0">
                    {sidebar}
                  </div>
                  {showSidebarAppNavigation && (
                    <MobileSidebarNavigation
                      embedded
                      onNavigate={closeSidebarAfterAppNavigation}
                    />
                  )}
                </CustomScrollArea>
              ) : (
                <div className="min-h-0 flex-1 overflow-hidden">{sidebar}</div>
              )
            ) : null}
          </div>
        </MobileUnifiedDrawerProvider>

        {/* 主内容区域 - 宽度等于外层容器宽度（视口宽度） */}
        <div
          className="relative z-[1] h-full flex-shrink-0 overflow-x-hidden bg-background"
          style={{ width: containerWidth || '100vw' }}
        >
          {showContentOverlay && hasSidebar && (
            <button
              type="button"
              aria-label={t('sidebar.close')}
              aria-hidden={sidebarRevealProgress <= 0.02}
              tabIndex={isSidebarOverlayInteractive ? 0 : -1}
              onClick={closeSidebarAfterAppNavigation}
              data-mobile-sidebar-mask
              className="absolute inset-0 z-[60] appearance-none border-0 bg-[color:var(--overlay)] p-0 transition-opacity duration-300 ease-out motion-reduce:transition-none"
              style={{
                opacity: sidebarRevealProgress,
                pointerEvents: isSidebarOverlayInteractive ? 'auto' : 'none',
              }}
            />
          )}
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
