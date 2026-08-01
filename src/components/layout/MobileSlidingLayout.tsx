/**
 * MobileSlidingLayout - 移动端推拉式三屏滑动布局
 *
 * DeepSeek 风格：侧边栏、主视图、右侧面板连为一体，滑动时整体平移
 * 可选主内容遮罩，用于贴近 study-ui 抽屉式侧边栏
 * 支持触摸和鼠标拖拽
 *
 * 三屏布局：左侧栏 ← 中间主视图 → 右侧面板
 *
 * ⚠️ 页面接入约束（containing block）：track 常驻 transform（含静止态），
 * 因此本布局内任何 in-tree `position: fixed` 元素都会以 track 为包含块、
 * 随滑屏平移，不再相对视口定位。移动页面内的悬浮层（弹窗/吸底工具条/FAB）
 * 必须 portal 到 document.body，禁止在子树内直接写 fixed。
 */

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMobileLayoutSafe } from './MobileLayoutContext';
import { useMobileHeaderContextSafe } from './MobileHeaderContext';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MobileUnifiedDrawerProvider } from './MobileDrawerContext';
import { MobileSidebarNavigation } from './MobileSidebarNavigation';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { Z_INDEX } from '@/config/zIndex';

/** 三屏位置枚举 */
export type ScreenPosition = 'left' | 'center' | 'right';

/**
 * P1-5: 手势完全豁免的目标。文本输入/可编辑区域内的横向拖动是光标拖选，
 * 必须放行；[data-gesture-ignore] 为显式退出口。按钮/链接等普通交互元素
 * 不再整体豁免——轴锁定判定为水平拖后布局手势才真正接管，且拖动一旦发生
 * 会抑制随后的 click（见容器捕获阶段 click 监听），点按行为不受影响，
 * 同时会话列表行等交互元素上也能横向拖拽切屏。
 */
const GESTURE_OPT_OUT_SELECTOR =
  'input, select, textarea, option, [contenteditable="true"], [data-gesture-ignore]';

/**
 * F1/C-9: 自带手势的内容默认豁免布局手势（非边缘起手时）。
 * PDF 查看器（捏合缩放/拖动）、思维导图画布（节点拖拽/平移）、富文本编辑器
 * （光标拖选）内的横向手势不应被三屏布局劫持;屏幕边缘 edgeWidth 内起手仍
 * 优先布局手势,保证"随时可滑回"。调用方可通过 gestureIgnoreSelector 覆盖。
 */
export const DEFAULT_GESTURE_IGNORE_SELECTOR =
  '[data-no-screen-swipe], .ds-pdf-viewer, .react-pdf__Page, .mindmap-container, .react-flow, .ProseMirror';

const isGestureOptOutTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(GESTURE_OPT_OUT_SELECTOR));
};

/** P0-1: settle 动画时长（ms），与 --panel-open-dur/--panel-close-dur 同一档位 */
const SETTLE_MIN_DURATION = 250;
const SETTLE_MAX_DURATION = 350;

/**
 * P0-1: 与 CSS `--panel-ease: cubic-bezier(0.22, 1, 0.36, 1)` 同曲线的 JS 求值器。
 * settle 动画走 rAF 手动插值（WebView 的 transform CSS 过渡会卡在起点），
 * 需要在 JS 侧复现同一条缓动曲线。曲线在 x 上单调，二分反解参数即可。
 */
const panelEase = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bezierAxis = (c1: number, c2: number, u: number): number => {
    const inv = 1 - u;
    return 3 * c1 * inv * inv * u + 3 * c2 * inv * u * u + u * u * u;
  };
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 24; i++) {
    const x = bezierAxis(0.22, 0.36, u);
    if (Math.abs(x - t) < 1e-4) break;
    if (x < t) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return bezierAxis(1, 1, u);
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  /** 移动侧栏中位于滚动 viewport 上方的固定内容 */
  sidebarFixedContent?: ReactNode;
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
  sidebarFixedContent,
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
  /** track/遮罩 DOM 引用：拖拽与 settle 动画期间逐帧直写样式，绕开 React 渲染 */
  const trackRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLButtonElement>(null);
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
    /** P1-5: 水平拖拽已发生，松手后需要吞掉紧随其后的 click */
    suppressClick: false,
  });

  const [isDragging, setIsDragging] = useState(false);
  const [currentTranslate, setCurrentTranslate] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isActiveViewLayer, setIsActiveViewLayer] = useState(true);
  // P0-1: settle 动画（rAF 手动插值）状态
  const [isSettling, setIsSettling] = useState(false);
  /** 拖拽收尾时 +1，强制 settle 效应重估（screenPosition/baseTranslate 可能都没变） */
  const [settleTick, setSettleTick] = useState(0);
  const settleFrameRef = useRef<number | null>(null);
  /** 最近一次真实渲染到 DOM 的 translate（拖拽/动画/静止三种来源统一记录） */
  const renderedTranslateRef = useRef<number | null>(null);
  const prevScreenPositionRef = useRef<ScreenPosition>(screenPosition);
  const lastContainerWidthRef = useRef<number>(0);
  const mobileLayout = useMobileLayoutSafe();
  const isMobileLayout = mobileLayout?.isMobile ?? false;
  const mobileHeader = useMobileHeaderContextSafe();
  const enterFullscreen = mobileLayout?.enterFullscreen;
  const exitFullscreen = mobileLayout?.exitFullscreen;
  const fullscreenClaimId = useId();
  const hasSidebar = sidebar !== null && sidebar !== undefined;
  const isMobileDrawerFullBleed = isMobileLayout && hasSidebar && Boolean(mobileHeader?.config.hidden);

  // 监听容器宽度变化。
  // 用 useLayoutEffect：首帧在绘制前完成测量，避免 containerWidth=0 的回退几何
  //（track 宽 calc(100% + sidebarWidth) 与三屏总宽不符）闪现一帧
  useLayoutEffect(() => {
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
      // opacity 是视图入场动画的一部分，激活首帧会短暂为 0；若把它当成
      // 非活跃判据，MutationObserver 在动画结束后不会再收到属性变化，
      // 缓存页面重进后便会永久失去返回键/全屏 claim。交互态只看壳层契约。
      setIsActiveViewLayer(
        style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none'
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

  // P2: 逐帧视觉更新直写 DOM（track transform + 遮罩 opacity），绕开 React 渲染。
  // 拖拽 touchmove / settle rAF 每帧 setState 会让整棵布局子树 60fps 重渲染，
  // 低端 Android 上是跟手性与掉帧的主要来源。React 状态只在手势/动画边界同步
  // 一次；动画期间的偶发重渲染（如子树流式更新）从 renderedTranslateRef 取值，
  // 与 DOM 直写结果保持一致（见 translateX 计算）。
  const applyVisualTranslate = useCallback((value: number) => {
    renderedTranslateRef.current = value;
    const track = trackRef.current;
    if (track) {
      track.style.transform = `translate3d(${value}px, 0, 0)`;
    }
    const mask = maskRef.current;
    if (mask) {
      const progress = Math.max(0, Math.min(1, (value + sidebarWidth) / Math.max(sidebarWidth, 1)));
      mask.style.opacity = String(progress);
    }
  }, [sidebarWidth]);

  // P0-1: 侧栏 settle 动画。
  // WebView 下对 track 的 transform 做 CSS transition 会卡在起点（详见 track 的
  // transition:'none' 注释），因此松手/汉堡按钮触发的开合改用 rAF 手动插值
  // translate3d：每帧 applyVisualTranslate 直写 DOM（与拖拽同一条路径），动画
  // 结束时才 setState 一次回到 baseTranslate 静态渲染。拖拽进行中保持完全跟手。
  // prefers-reduced-motion 或容器 resize / 初始化引起的位移直接就位。
  useLayoutEffect(() => {
    // 指针仍按住（跟踪/拖拽中）时不做任何归位，松手后由 settleTick 触发重估
    if (isDragging || stateRef.current.isDragging) return;

    const from = renderedTranslateRef.current ?? baseTranslate;
    const to = baseTranslate;
    const widthChanged = lastContainerWidthRef.current !== containerWidth;
    lastContainerWidthRef.current = containerWidth;
    const positionChanged = prevScreenPositionRef.current !== screenPosition;
    prevScreenPositionRef.current = screenPosition;

    const finishAt = (value: number) => {
      if (settleFrameRef.current !== null) {
        cancelAnimationFrame(settleFrameRef.current);
        settleFrameRef.current = null;
      }
      applyVisualTranslate(value);
      setCurrentTranslate(value);
      setIsSettling(false);
    };

    // 无位移：确保插值状态清理干净
    if (from === to) {
      finishAt(to);
      return;
    }

    // 容器尺寸变化（初始化/旋转/分屏）引起的基准位移：直接就位，不做动画
    if (widthChanged && !positionChanged) {
      finishAt(to);
      return;
    }

    if (prefersReducedMotion()) {
      finishAt(to);
      return;
    }

    // 距离越短时长越短（250–350ms），拖到一半松手不会拖泥带水
    const distanceRatio = Math.abs(to - from) / Math.max(sidebarWidth, 1);
    const duration = SETTLE_MIN_DURATION +
      Math.min(1, distanceRatio) * (SETTLE_MAX_DURATION - SETTLE_MIN_DURATION);
    const startTime = performance.now();

    setCurrentTranslate(from);
    setIsSettling(true);
    applyVisualTranslate(from);

    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / duration);
      const value = from + (to - from) * panelEase(progress);
      // 每帧只直写 DOM，不 setState（见 applyVisualTranslate 注释）
      applyVisualTranslate(value);
      if (progress < 1) {
        settleFrameRef.current = requestAnimationFrame(step);
      } else {
        settleFrameRef.current = null;
        setCurrentTranslate(value);
        setIsSettling(false);
      }
    };
    settleFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (settleFrameRef.current !== null) {
        cancelAnimationFrame(settleFrameRef.current);
        settleFrameRef.current = null;
      }
    };
  }, [baseTranslate, screenPosition, containerWidth, sidebarWidth, isDragging, settleTick, applyVisualTranslate]);

  // 处理开始拖拽（触摸/鼠标）
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    if (!enableGesture) return;

    // settle 动画进行中被再次抓住：从当前插值位置接管（可"抓回"滑动中的抽屉）
    if (settleFrameRef.current !== null) {
      cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = null;
    }
    const startTranslate = renderedTranslateRef.current ?? baseTranslate;

    stateRef.current.isDragging = true;
    stateRef.current.startX = clientX;
    stateRef.current.startY = clientY;
    stateRef.current.currentTranslate = startTranslate;
    stateRef.current.axisLocked = null;
    stateRef.current.dragStartBase = startTranslate;
    stateRef.current.baseTranslate = baseTranslate;
    stateRef.current.lastMoveX = clientX;
    stateRef.current.lastMoveTime = performance.now();
    stateRef.current.velocityX = 0;
    stateRef.current.suppressClick = false;
    applyVisualTranslate(startTranslate);

    setCurrentTranslate(startTranslate);
    // 注意：此处不 setIsDragging(true)。React 侧的 isDragging 推迟到轴锁定为
    // 水平拖时才置位（见 handleDragMove），避免每次点按都触发全屏 claim /
    // 底部 inset 抖动；stateRef.isDragging 仅表示"指针按下并在跟踪"。
  }, [enableGesture, baseTranslate, applyVisualTranslate]);

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
        // P1-5: 拖拽真正接管后，抑制松手时落在交互元素上的 click
        stateRef.current.suppressClick = true;
        setIsDragging(true);
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
    // 每帧只直写 DOM，不 setState（见 applyVisualTranslate 注释）
    applyVisualTranslate(newTranslate);
  }, [enableGesture, sidebarWidth, containerWidth, isThreeScreenMode, rightPanelEnabled, applyVisualTranslate]);

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
    // P2-11: 0.35 → 0.30 px/ms，轻扫更容易触发切换
    const FLING_VELOCITY_THRESHOLD = 0.3; // px/ms
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

    // P0-1: 用 settleTick 强制 settle 效应重估——即使 screenPosition/baseTranslate
    // 没变（未过阈值弹回、或 settle 中被点按打断），也要把面板动画送回目标位。
    stateRef.current.isDragging = false;
    stateRef.current.axisLocked = null;
    setIsDragging(false);
    setSettleTick((tick) => tick + 1);
  }, [sidebarWidth, sidebarOpen, threshold, onSidebarOpenChange, isThreeScreenMode, onScreenPositionChange, screenPosition, rightPanelEnabled]);

  // C-9/残留#1: 拖拽被外部中断（touchcancel / 页面失焦 / 长按菜单）时的收尾。
  // Android 10+ 手势导航下，系统返回手势抢占边缘 swipe 会向 WebView 发
  // touchcancel——此时系统自己会执行返回动作，前端若仍按 touchend 语义
  // 「按位移/惯性提交切屏」，就会出现「系统返回 + 抽屉弹开」双重响应。
  // 因此中断路径一律不提交切换，只把 track 弹回当前 screenPosition 基准位。
  const handleDragCancel = useCallback(() => {
    if (!stateRef.current.isDragging) {
      stateRef.current.axisLocked = null;
      return;
    }
    stateRef.current.isDragging = false;
    stateRef.current.axisLocked = null;
    setIsDragging(false);
    // settleTick 触发 settle 效应，把已经跟手位移的 track 动画送回基准位
    setSettleTick((tick) => tick + 1);
  }, []);

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
    // ⚠️ 已知局限：Android 10+ 手势导航模式下，屏幕左右两缘同时是系统返回手势
    // 热区，系统会先消费边缘 swipe，此处的边缘优先在真机上可能抢不到起手；
    // 豁免区域（PDF/画布等）内的主要退路是系统返回键（见 registerBackHandler）。
    // 缓解（2026-07 残留#1）：系统抢占触摸序列时 WebView 收到 touchcancel，
    // 走 handleDragCancel 只回弹不提交切屏，避免「系统返回 + 前端切屏」双重响应；
    // 手势可达的全部目标（抽屉/右屏）均有顶栏按钮等非手势入口兜底。
    // 系统手势热区宽度 WebView 无法读取（WindowInsets systemGestures 未透传，
    // --android-safe-area-left/right 竖屏为 0），无法静态实现「起手区避开热区」。
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
      // 双指缩放/旋转必须完整让给内容。第二根手指落下时 touchstart 会再次触发，
      // 此处取消已经开始的单指跟踪，避免松开一指后布局突然跳屏。
      if (e.touches.length !== 1) {
        handleDragCancel();
        return;
      }
      // 新一轮单指交互开始：清掉可能残留的 click 抑制标记（如上一轮
      // touchcancel 收尾后没有 click 消费它），避免误吞本轮的正常点击。
      stateRef.current.suppressClick = false;
      if (isGestureOptOutTarget(e.target)) return;
      const touch = e.touches[0];
      if (shouldYieldToContent(e.target, touch.clientX)) return;
      handleDragStart(touch.clientX, touch.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        handleDragCancel();
        return;
      }
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY, () => e.preventDefault());
    };

    const onTouchEnd = (e: TouchEvent) => {
      // 仍有触点时不提交；多指序列已由 touchstart/touchmove 的 cancel 路径收尾。
      if (e.touches.length > 0) return;
      handleDragEnd();
    };

    // touchcancel ≠ touchend：系统（返回手势/通知栏下拉/来电）接管触摸序列时
    // 不提交切屏，只回弹（见 handleDragCancel 注释）
    const onTouchCancel = () => {
      handleDragCancel();
    };

    // 鼠标事件
    const onMouseDown = (e: MouseEvent) => {
      // 只响应左键
      if (e.button !== 0) return;
      stateRef.current.suppressClick = false;
      if (isGestureOptOutTarget(e.target)) return;
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

    // 页面失焦 / 上下文菜单弹出时，强制结束拖拽，防止 isDragging 卡死。
    // 与 touchcancel 同语义：中断不提交切屏，只回弹
    const onDragAbort = () => {
      if (stateRef.current.isDragging) {
        handleDragCancel();
      }
    };

    // P1-5: 水平拖拽发生后，吞掉松手时触发的 click（捕获阶段拦截一次），
    // 保证"从按钮/列表行上起手横向拖拽"不会在松手时误触点击
    const onClickCapture = (e: MouseEvent) => {
      if (!stateRef.current.suppressClick) return;
      stateRef.current.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    };

    // 绑定触摸事件
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchCancel, { passive: true });

    // 绑定鼠标事件
    container.addEventListener('mousedown', onMouseDown);
    // mousemove 和 mouseup 绑定到 document，以便在容器外也能响应
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // 安全兜底：页面不可见或弹出菜单时结束拖拽
    document.addEventListener('visibilitychange', onDragAbort);
    document.addEventListener('contextmenu', onDragAbort);

    // 捕获阶段拦截拖拽后的 click
    container.addEventListener('click', onClickCapture, true);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchCancel);
      container.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('visibilitychange', onDragAbort);
      document.removeEventListener('contextmenu', onDragAbort);
      container.removeEventListener('click', onClickCapture, true);
    };
  }, [handleDragStart, handleDragMove, handleDragEnd, handleDragCancel, edgeWidth, gestureIgnoreSelector]);

  // 计算最终的 transform 值：拖拽 / settle 动画期间用逐帧直写的最新插值
  // （renderedTranslateRef 由 applyVisualTranslate 维护，偶发重渲染不会回退到旧值），
  // 静止时用基准位
  const translateX = isDragging || isSettling
    ? (renderedTranslateRef.current ?? currentTranslate)
    : baseTranslate;
  const sidebarRevealProgress = showContentOverlay && hasSidebar
    ? Math.max(0, Math.min(1, (translateX + sidebarWidth) / Math.max(sidebarWidth, 1)))
    : 0;
  const isSidebarOverlayInteractive = sidebarRevealProgress > 0.98 && screenPosition === 'left' && !isDragging;

  // A11y：离屏区域 inert 化。三屏内容常驻 DOM、仅靠 translate 移出视口，
  // 不加 inert 时键盘 Tab / 读屏可到达不可见控件，且 focus 会把 overflow:hidden
  // 容器滚出偏移。React 18 的布尔 inert 序列化有问题，用空字符串写法
  // （React 19 升级后可改回布尔属性）。主内容本体单独包裹，遮罩按钮保持在
  // inert 包裹层之外，因此抽屉展开时既能点击遮罩关闭，也不会焦点穿透到底层。
  const inertProps = (inert: boolean) =>
    // @types/react 18 尚未声明 inert，经 unknown 双重断言透传为 DOM 属性
    (inert ? { inert: '' } : {}) as unknown as React.HTMLAttributes<HTMLDivElement>;
  const isSidebarInert = hasSidebar && screenPosition !== 'left';
  const isMainContentInert = screenPosition !== 'center';
  const isRightPanelInert = isThreeScreenMode && screenPosition !== 'right';

  // 计算容器总宽度
  const totalWidth = isThreeScreenMode
    ? sidebarWidth + containerWidth + containerWidth // 三屏：侧栏 + 主视图 + 右侧面板
    : sidebarWidth + containerWidth; // 两屏：侧栏 + 主视图

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative h-full overflow-hidden',
        // select-none 仅在拖拽期间生效：常驻会让所有移动页面继承 user-select:none，
        // 未自行恢复的页面长按选择/复制会静默失效
        isDragging && 'select-none',
        className,
      )}
      style={{
        touchAction: 'pan-y pinch-zoom',
        cursor: isDragging ? 'grabbing' : 'default',
      }}
    >
      <div
        ref={trackRef}
        className="flex h-full"
        style={{
          width: totalWidth || `calc(100% + ${sidebarWidth}px)`,
          transform: `translate3d(${translateX}px, 0, 0)`,
          // WebView 下 transform 的 CSS 过渡会卡在起点，导致汉堡菜单点了抽屉不动。
          // 因此这里永远不做 CSS transition：拖拽期间完全跟手，松手/按钮开合的
          // 滑入滑出由上方 settle 效应用 rAF 手动插值驱动（见 P0-1 注释）。
          transition: 'none',
        }}
      >
        {/* 侧边栏：页内工具 + 全局导航 统一滚动（融合双栏） */}
        <MobileUnifiedDrawerProvider value={isMobileLayout && hasSidebar}>
          <div
            data-mobile-unified-drawer={isMobileLayout && hasSidebar ? '' : undefined}
            {...inertProps(isSidebarInert)}
            aria-hidden={isSidebarInert || undefined}
            className={cn(
              'relative z-[2] flex h-full min-h-0 flex-shrink-0 flex-col font-sidebar-study-ui',
              isMobileLayout && hasSidebar
                ? 'bg-[color:var(--shell-navigation-surface)] text-[color:var(--shell-navigation-foreground)]'
                : 'bg-background',
            )}
            style={{ width: sidebarWidth }}
          >
            {hasSidebar ? (
              isMobileLayout ? (
                <>
                  {sidebarFixedContent ? (
                    <div
                      data-mobile-drawer-fixed
                      className={cn(
                        'shrink-0 px-2 pl-[calc(0.5rem+var(--mobile-safe-area-left,0px))]',
                        isMobileDrawerFullBleed
                          ? 'pt-[calc(0.5rem+var(--mobile-safe-area-top,0px))]'
                          : 'py-1',
                      )}
                    >
                      {sidebarFixedContent}
                    </div>
                  ) : null}
                  <CustomScrollArea
                    className="scrollbar-none min-h-0 flex-1"
                  // OverlayScrollbars 会清零 viewport padding；安全区/键盘避让放内层
                  viewportClassName="h-full w-full min-h-0"
                >
                  {/* 抽屉贴屏幕左缘：横屏刘海/挖孔机型需要叠加左侧安全区。
                      底部同时避让软键盘（--keyboard-inset：iOS overlay 键盘 >0，
                      Android adjustResize ≈0，键盘收起恒 0）：抽屉内含搜索等输入
                      入口，聚焦时保证列表尾部可滚出键盘遮挡区 */}
                  <div
                    className={cn(
                      'px-2 pl-[calc(0.5rem+var(--mobile-safe-area-left,0px))] pb-[calc(0.5rem+max(var(--mobile-safe-area-bottom,0px),var(--keyboard-inset,0px)))]',
                      isMobileDrawerFullBleed
                        ? sidebarFixedContent
                          ? 'pt-0'
                          : 'pt-[calc(0.5rem+var(--mobile-safe-area-top,0px))]'
                        : 'py-1',
                    )}
                  >
                    <div data-mobile-drawer-page className="min-h-0">
                      {sidebar}
                    </div>
                    {showSidebarAppNavigation && (
                      <MobileSidebarNavigation
                        embedded
                        hideSettings
                        onNavigate={closeSidebarAfterAppNavigation}
                      />
                    )}
                  </div>
                  </CustomScrollArea>
                  {showSidebarAppNavigation && (
                    <div className="shrink-0 border-t border-border/70 px-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))] pt-1">
                      <MobileSidebarNavigation
                        settingsOnly
                        onNavigate={closeSidebarAfterAppNavigation}
                      />
                    </div>
                  )}
                </>
              ) : (
                <div className="min-h-0 flex-1 overflow-hidden">{sidebar}</div>
              )
            ) : null}
          </div>
        </MobileUnifiedDrawerProvider>

        {/* 主内容区域 - 宽度等于外层容器宽度（视口宽度） */}
        <div
          className="relative z-[1] h-full flex-shrink-0 overflow-x-hidden bg-[color:var(--shell-workspace-panel)]"
          style={{ width: containerWidth || '100vw' }}
        >
          {showContentOverlay && hasSidebar && (
            <button
              ref={maskRef}
              type="button"
              aria-label={t('sidebar.close')}
              aria-hidden={sidebarRevealProgress <= 0.02}
              tabIndex={isSidebarOverlayInteractive ? 0 : -1}
              onClick={closeSidebarAfterAppNavigation}
              data-mobile-sidebar-mask
              className={cn(
                'absolute inset-0 appearance-none border-0 bg-[color:var(--overlay)] p-0',
                // 拖拽/settle 期间 opacity 已按帧驱动，叠加 CSS 过渡会让遮罩滞后脱节
                !isDragging && !isSettling &&
                  'transition-opacity duration-300 ease-out motion-reduce:transition-none',
              )}
              style={{
                // P1-4: 层级消费统一 token（同一 stacking context 内盖过内容即可）
                zIndex: Z_INDEX.overlay,
                opacity: sidebarRevealProgress,
                pointerEvents: isSidebarOverlayInteractive ? 'auto' : 'none',
              }}
            />
          )}
          <div
            {...inertProps(isMainContentInert)}
            aria-hidden={isMainContentInert || undefined}
            className="h-full min-h-0"
          >
            {children}
          </div>
        </div>

        {/* 右侧面板（三屏模式） */}
        {isThreeScreenMode && (
          <div
            {...inertProps(isRightPanelInert)}
            aria-hidden={isRightPanelInert || undefined}
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
