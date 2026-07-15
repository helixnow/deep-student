/**
 * Chat V2 - MessageList 消息列表组件
 *
 * 职责：虚拟滚动，订阅 messageOrder，渲染 MessageItem
 * 
 * 🚀 P1 优化（冷启动与虚拟化）：
 * 1. 首帧只渲染尾部窗口（INITIAL_RENDER_COUNT 条），绘制后在空闲期补齐
 * 2. 虚拟化延迟初始化（requestIdleCallback）；等待期间同样渲染尾部窗口，无空白帧
 * 3. 会话打开即底部锚定（layout effect，绘制前执行）
 * 4. 滚动逻辑简化：rAF + 条件触发
 * 5. 移除 flushSync，异步状态更新
 */

import React, { useRef, useEffect, useLayoutEffect, useCallback, memo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/utils/cn';
import { newMessageVariants } from '@/styles/motion-variants';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MessageItem } from './MessageItem';
import { useMessageOrder, useSessionStatus, useIsDataLoaded } from '../hooks/useChatStore';
import type { ChatStore } from '../core/types';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import Z_INDEX from '@/config/zIndex';
import { useSmoothWheel } from '../hooks/useSmoothWheel';
import { ArrowDown } from '@phosphor-icons/react';
import { ThreadEmptyStateShell } from './ui/ThreadEmptyStateShell';
import { ThreadContentShell } from './ui/ThreadContentShell';

// ============================================================================
// 常量定义
// ============================================================================

/** 首帧直接渲染的尾部消息数量（渐进渲染窗口；虚拟化就绪前也用它兜底） */
const INITIAL_RENDER_COUNT = 10;

/** 虚拟化初始化：下一帧即启用，避免固定延迟空白 */
const VIRTUALIZER_INIT_DELAY = 0;

/** 默认估算消息高度（设置为合理值，测量会覆盖）*/
const DEFAULT_ESTIMATED_ITEM_SIZE = 120;
/** 超过该数量后启用虚拟滚动，避免长会话全量渲染 */
const VIRTUALIZATION_THRESHOLD = 80;
/** 保证最后一条消息可以滚动到 28px 底部渐隐层之上。 */
const MESSAGE_BOTTOM_SAFE_AREA_PX = 32;

interface PendingScrollCompensation {
  scrollHeight: number;
  scrollTop: number;
  anchorMessageId?: string;
  anchorViewportOffset?: number;
}

function countInsertedBeforeExisting(
  previousOrder: readonly string[],
  nextOrder: readonly string[],
): number {
  if (nextOrder.length <= previousOrder.length) return 0;
  let previousIndex = 0;
  let insertedBeforeExisting = 0;
  for (const id of nextOrder) {
    if (previousIndex < previousOrder.length && id === previousOrder[previousIndex]) {
      previousIndex += 1;
    } else if (previousIndex < previousOrder.length) {
      insertedBeforeExisting += 1;
    }
  }
  return previousIndex === previousOrder.length ? insertedBeforeExisting : 0;
}

function captureScrollCompensation(
  viewport: HTMLDivElement,
): PendingScrollCompensation {
  const viewportRect = viewport.getBoundingClientRect();
  const messageElements = viewport.querySelectorAll<HTMLElement>('[data-chat-message-id]');
  for (const element of messageElements) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) {
      return {
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
        anchorMessageId: element.dataset.chatMessageId,
        anchorViewportOffset: rect.top - viewportRect.top,
      };
    }
  }
  return {
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
  };
}

// ============================================================================
// Props 定义
// ============================================================================

export interface MessageListProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 自定义类名 */
  className?: string;
  /** 空态中显示的当前分组名；未分组时不显示 */
  emptyStateGroupName?: string | null;
  /** 预估消息高度 */
  estimatedItemSize?: number;
  /** 虚拟滚动可视区外预渲染的行数 */
  overscan?: number;
  /** 🆕 强制显示空态（用于空态预览） */
  forceEmptyPreview?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * MessageList 消息列表组件
 *
 * 功能：
 * 1. 虚拟滚动优化性能
 * 2. 自动滚动到底部（流式生成时）
 * 3. 空状态展示
 */
const MessageListInner: React.FC<MessageListProps> = ({
  store,
  className,
  emptyStateGroupName = null,
  estimatedItemSize = DEFAULT_ESTIMATED_ITEM_SIZE,
  overscan = 5,
  forceEmptyPreview = false,
}) => {
  // 📊 细粒度打点：组件函数开始执行
  const instanceIdRef = useRef(Math.random().toString(36).slice(2, 8));
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  sessionSwitchPerf.mark('ml_mount', {
    instanceId: instanceIdRef.current,
    renderCount: renderCountRef.current,
  });

  const { t } = useTranslation('chatV2');
  const scrollToBottomLabel = t('messageList.scrollToBottom', {
    defaultValue: 'Scroll to bottom',
  });

  // 📱 移动端适配：检测屏幕尺寸
  const { isSmallScreen } = useBreakpoint();

  // 容器 ref - CustomScrollArea 的外层容器
  const containerRef = useRef<HTMLDivElement>(null);

  // 🚀 P1优化：viewport 状态管理
  // 使用 useState 替代 useReducer + flushSync，避免强制同步刷新
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);

  // 🚀 虚拟滚动状态管理
  const [virtualizerReady, setVirtualizerReady] = useState(false);

  // viewport callback ref - 异步更新状态，不使用 flushSync
  // 卸载（如切到空态）时也要同步置空：否则 scroll/wheel 监听会继续挂在
  // 已脱离文档的旧节点上，泄漏内存且状态失真
  const viewportCallbackRef = useCallback((node: HTMLDivElement | null) => {
    setViewportElement(node);
  }, []);

  // 订阅消息顺序（已通过 useMessageOrder 内部的引用缓存优化）
  const messageOrder = useMessageOrder(store);

  // WCAG: 屏幕阅读器新消息通知（适用于虚拟化模式）
  const prevSrCountRef = useRef(messageOrder.length);
  const isFirstSrRender = useRef(true);
  const [srAnnouncement, setSrAnnouncement] = useState('');
  useEffect(() => {
    if (isFirstSrRender.current) {
      isFirstSrRender.current = false;
      prevSrCountRef.current = messageOrder.length;
      return;
    }
    if (messageOrder.length > prevSrCountRef.current) {
      setSrAnnouncement(
        t('messageList.srNewMessages', {
          count: messageOrder.length,
          defaultValue: `New messages received, total {{count}} messages`,
        })
      );
    }
    prevSrCountRef.current = messageOrder.length;
  }, [messageOrder.length, t]);

  // 订阅会话状态
  const sessionStatus = useSessionStatus(store);

  // 订阅数据是否已加载
  const isDataLoaded = useIsDataLoaded(store);

  // 📊 细粒度打点：hooks 执行完成
  sessionSwitchPerf.mark('ml_hooks_done', {
    messageCount: messageOrder.length,
    isDataLoaded
  });

  // 📊 性能打点：追踪首次渲染完成
  const hasMarkedFirstRenderRef = useRef(false);
  const hasMarkedFirstRenderScheduledRef = useRef(false);
  const lastStoreRef = useRef<StoreApi<ChatStore> | null>(null);

  // 🚀 渐进渲染：会话打开首帧只同步渲染尾部 INITIAL_RENDER_COUNT 条，
  // 绘制完成后在空闲期补齐其余消息（直渲模式），避免长会话切换时一次
  // commit 内同步渲染全部 markdown/KaTeX 造成数百 ms 阻塞。
  const [tailWindowExpanded, setTailWindowExpanded] = useState(false);
  // 补齐前记录的滚动基准（补齐会在上方"插入"旧消息，需要锚定补偿）
  const pendingScrollCompensationRef = useRef<PendingScrollCompensation | null>(null);
  // 会话打开时的底部锚定只执行一次
  const hasAnchoredRef = useRef(false);
  // 挂载/数据加载完成时已存在的消息数：仅之后追加的消息播放入场动画
  const initialMessageCountRef = useRef(messageOrder.length);

  // 上一次消息顺序：用于识别头部或视口上方的中部历史插入。
  const prevMessageOrderRef = useRef(messageOrder);
  const historyInsertionRef = useRef(false);

  // 列表纪元：按会话递增，作为消息容器的 key。切换会话时旧列表子树整体卸载，
  // AnimatePresence 不再对旧会话消息播放退场动画（避免新旧内容短暂混排）；
  // 外层 CustomScrollArea / viewport / 虚拟化器保持存活
  const listEpochRef = useRef(0);

  // 当 store 变化时（切换会话），重置标记和状态
  const storeChanged = lastStoreRef.current !== store;
  if (storeChanged) {
    hasMarkedFirstRenderRef.current = false;
    hasMarkedFirstRenderScheduledRef.current = false;
    lastStoreRef.current = store;
    hasAnchoredRef.current = false;
    pendingScrollCompensationRef.current = null;
    initialMessageCountRef.current = messageOrder.length;
    prevMessageOrderRef.current = messageOrder;
    historyInsertionRef.current = false;
    listEpochRef.current += 1;
    if (tailWindowExpanded) {
      // render 阶段的条件 setState（React 官方 adjust-state-during-render 模式）
      setTailWindowExpanded(false);
    }
    if (virtualizerReady) {
      // 重置虚拟化就绪态：首帧走尾部窗口直渲，避免旧会话的测量缓存造成重叠；
      // 下方 viewport effect 会在下一帧重新启用
      setVirtualizerReady(false);
    }
  } else {
    // Full-history merge may insert at the head or between two backend anchors.
    // Detect any pure insertion before an existing item, then preserve the
    // first visible message's pixel offset across the commit. An insertion
    // below the viewport yields a zero anchor delta and therefore no jump.
    const previousOrder = prevMessageOrderRef.current;
    if (previousOrder !== messageOrder) {
      const insertedBeforeExisting = countInsertedBeforeExisting(previousOrder, messageOrder);
      historyInsertionRef.current = insertedBeforeExisting > 0;
      if (insertedBeforeExisting > 0) {
        initialMessageCountRef.current += insertedBeforeExisting;
        if (viewportElement && !pendingScrollCompensationRef.current) {
          pendingScrollCompensationRef.current = captureScrollCompensation(viewportElement);
        }
      }
    }
    prevMessageOrderRef.current = messageOrder;
  }

  // 挂载时数据未就绪（如适配器已缓存但会话重载中）：加载完成后修正入场基准，
  // 避免历史消息被误判为"新消息"而整屏播放弹出动画
  const wasDataLoadedRef = useRef(isDataLoaded);
  if (!wasDataLoadedRef.current && isDataLoaded) {
    initialMessageCountRef.current = messageOrder.length;
  }
  wasDataLoadedRef.current = isDataLoaded;

  // 是否正在流式生成
  const isStreaming = sessionStatus === 'streaming';
  // 超长会话启用虚拟滚动，短会话保持直接渲染以降低复杂度
  const useDirectRender = messageOrder.length <= VIRTUALIZATION_THRESHOLD;

  const virtualRowCount = messageOrder.length;

  // 虚拟化：viewport 就绪后下一帧启用（VIRTUALIZER_INIT_DELAY=0 时等同 rAF）。
  // 依赖 virtualizerReady：会话切换时它在渲染期被重置为 false，本 effect 重新调度启用
  useEffect(() => {
    if (!viewportElement || virtualizerReady) return;

    const scheduleReady = () => {
      setVirtualizerReady(true);
      sessionSwitchPerf.mark('ml_virtualizer_ready', { delayed: VIRTUALIZER_INIT_DELAY > 0 });
    };

    if (VIRTUALIZER_INIT_DELAY <= 0) {
      const frameId = requestAnimationFrame(scheduleReady);
      return () => cancelAnimationFrame(frameId);
    }

    const timeoutId = setTimeout(scheduleReady, VIRTUALIZER_INIT_DELAY);
    return () => clearTimeout(timeoutId);
  }, [viewportElement, virtualizerReady]);

  // 虚拟化初始化耗时记录
  const hasLoggedVirtualizerRef = useRef(false);
  const virtualizerInitStart = performance.now();

  // 虚拟滚动配置
  const virtualizer = useVirtualizer({
    count: virtualizerReady && !useDirectRender ? virtualRowCount : 0,
    getScrollElement: () => viewportElement,
    // History completion can insert rows at the head or between anchors.
    // Index keys would reuse a previous message's measured height for the new
    // occupant and cause a second jump after our scroll-anchor compensation.
    getItemKey: (index) => messageOrder[index] ?? index,
    estimateSize: () => estimatedItemSize,
    overscan,
    // 🔧 修复消息重叠：始终启用测量，不再延迟
    // 延迟测量会导致虚拟化器使用估算高度定位消息，造成重叠
    // 用 offsetHeight 而非 getBoundingClientRect().height：新消息入场的 scale
    // 动画期间后者会把 0.95x 的中间态高度写入测量缓存，而 transform 结束不会
    // 触发 ResizeObserver 重测，错误高度会一直保留导致行距异常/跳动
    measureElement: (element) =>
      (element instanceof HTMLElement
        ? element.offsetHeight
        : element?.getBoundingClientRect().height) ?? estimatedItemSize,
  });

  if (!hasLoggedVirtualizerRef.current && virtualizerReady) {
    const virtualizerInitMs = performance.now() - virtualizerInitStart;
    sessionSwitchPerf.mark('ml_virtualizer_done', {
      ms: virtualizerInitMs,
      messageCount: messageOrder.length,
    });
    hasLoggedVirtualizerRef.current = true;
  }

  // 🚀 直渲模式：首帧绘制后在空闲期补齐尾部窗口之外的历史消息
  useEffect(() => {
    if (!useDirectRender || tailWindowExpanded) return;
    if (messageOrder.length <= INITIAL_RENDER_COUNT) return;

    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const schedule = win.requestIdleCallback?.bind(win)
      ?? ((cb: () => void) => window.setTimeout(cb, 32));
    const cancel = win.cancelIdleCallback?.bind(win) ?? window.clearTimeout;

    const id = schedule(() => {
      // 记录补齐前的滚动基准；补齐后在 layout effect 中做锚定补偿
      if (viewportElement) {
        pendingScrollCompensationRef.current = captureScrollCompensation(viewportElement);
      }
      setTailWindowExpanded(true);
    }, { timeout: 300 });

    return () => cancel(id);
  }, [useDirectRender, tailWindowExpanded, messageOrder.length, viewportElement]);

  // 补齐后的滚动锚定补偿：优先按首个可见消息的像素偏移补偿，
  // 兼容头插和中部插入；找不到锚点时才回退到 scrollHeight 差值。
  useLayoutEffect(() => {
    const pending = pendingScrollCompensationRef.current;
    if (!pending || !viewportElement) return;
    pendingScrollCompensationRef.current = null;

    let delta: number | null = null;
    if (pending.anchorMessageId && pending.anchorViewportOffset !== undefined) {
      const viewportRect = viewportElement.getBoundingClientRect();
      const anchor = Array.from(
        viewportElement.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
      ).find((element) => element.dataset.chatMessageId === pending.anchorMessageId);
      if (anchor) {
        delta = anchor.getBoundingClientRect().top
          - viewportRect.top
          - pending.anchorViewportOffset;
      }
    }

    if (delta === null) {
      delta = viewportElement.scrollHeight - pending.scrollHeight;
    }
    if (Math.abs(delta) > 0.5) {
      viewportElement.scrollTop = pending.scrollTop + delta;
      resetScrollBaselineRef.current();
    }
  }, [messageOrder, tailWindowExpanded, viewportElement]);

  // 🚀 会话打开即底部锚定：在绘制前执行，避免"先见顶部再跳底部"的闪动
  useLayoutEffect(() => {
    if (hasAnchoredRef.current) return;
    if (!viewportElement || messageOrder.length === 0) return;
    viewportElement.scrollTop = viewportElement.scrollHeight;
    hasAnchoredRef.current = true;
  }, [store, viewportElement, messageOrder.length]);

  // 直渲兜底 → 虚拟模式交接时按帧重测，清掉旧会话/估算值的测量缓存避免重叠。
  // 注意不依赖消息数/流式状态：virtualizer.measure() 会清空全部行高缓存，
  // 若每条新消息都全量重测，视口外的行会退回估算高度，流式期间滚动条/内容跳动；
  // 行内动态内容（公式/图片）的高度变化由虚拟化器自带的 ResizeObserver 跟踪
  useEffect(() => {
    if (useDirectRender || !virtualizerReady) return;
    const rafId = requestAnimationFrame(() => {
      virtualizer.measure();
    });
    return () => cancelAnimationFrame(rafId);
  }, [useDirectRender, virtualizerReady, virtualizer]);

  // 🔧 优化：使用 ref 追踪上一次消息数量和滚动状态
  const prevMessageCountRef = useRef(messageOrder.length);
  const isAutoScrollingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const programmaticScrollLockRef = useRef(false);
  const programmaticScrollUnlockTimerRef = useRef<number | null>(null);

  // 🔧 用户滚动意图检测：根据实际滚动位置决定是否保持吸底跟随
  const userHasScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // 由下方 scroll 监听 effect 填充：状态同步器 / 方向检测基准重置
  const syncScrollStateRef = useRef<() => void>(() => {});
  const resetScrollBaselineRef = useRef<() => void>(() => {});

  // 切换会话（不 remount）：清除上一会话的滚动意图，从底部锚定的吸底状态重新开始
  useEffect(() => {
    userHasScrolledRef.current = false;
    setShowScrollToBottom(false);
  }, [store]);

  const scheduleProgrammaticScrollUnlock = useCallback((delayMs: number) => {
    if (programmaticScrollUnlockTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollUnlockTimerRef.current);
    }
    programmaticScrollUnlockTimerRef.current = window.setTimeout(() => {
      programmaticScrollLockRef.current = false;
      programmaticScrollUnlockTimerRef.current = null;
      // 兜底：锁窗口内没有等到"抵达底部"的滚动事件时，按最终位置校正状态
      syncScrollStateRef.current();
    }, delayMs);
  }, []);

  // 滚动到底部
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!viewportElement) return;

    const top = viewportElement.scrollHeight;

    if (behavior === 'smooth') {
      programmaticScrollLockRef.current = true;
      // Chromium 平滑滚动动画最长约 500ms；锁窗口盖住全程，
      // 抵达底部或用户上滚接管时由 syncScrollState 提前解锁
      scheduleProgrammaticScrollUnlock(600);
    }

    if (typeof viewportElement.scrollTo === 'function') {
      viewportElement.scrollTo({ top, behavior });
    } else {
      viewportElement.scrollTop = top;
    }
  }, [scheduleProgrammaticScrollUnlock, viewportElement]);

  // 🚀 虚拟化就绪交接：从直渲兜底切到虚拟定位时，若用户未主动滚离底部则重新吸底
  useEffect(() => {
    if (!virtualizerReady || useDirectRender) return;
    const rafId = requestAnimationFrame(() => {
      if (!userHasScrolledRef.current) {
        scrollToBottom();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [virtualizerReady, useDirectRender, scrollToBottom]);

  /** 点击"回到底部"按钮 */
  const handleScrollToBottomClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    userHasScrolledRef.current = false;
    setShowScrollToBottom(false);
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  // 基于真实滚动位置同步吸底状态与按钮可见性
  useEffect(() => {
    if (!viewportElement) return;

    let lastScrollTop = viewportElement.scrollTop;

    const releaseLock = () => {
      programmaticScrollLockRef.current = false;
      if (programmaticScrollUnlockTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollUnlockTimerRef.current);
        programmaticScrollUnlockTimerRef.current = null;
      }
    };

    const syncScrollState = () => {
      const prevScrollTop = lastScrollTop;
      const { scrollTop, scrollHeight, clientHeight } = viewportElement;
      lastScrollTop = scrollTop;

      const distanceToBottom = scrollHeight - scrollTop - clientHeight;
      // 底部附近阈值 50px（主流聊天产品 同级灵敏度）
      const nearBottom = distanceToBottom < 50;
      // 吸底循环/平滑回底只会增大 scrollTop，因此 scrollTop 减小必然是用户向上滚
      // （滚动条拖拽/键盘/触摸等 wheel 之外的输入）。
      // distanceToBottom > 1 排除内容收缩时浏览器 clamp 产生的减小（恰好落在底部）
      const scrolledUp = scrollTop < prevScrollTop - 1 && distanceToBottom > 1;

      if (programmaticScrollLockRef.current) {
        if (scrolledUp) {
          // 锁窗口内用户上滚接管：立即解锁并暂停自动跟随
          releaseLock();
          userHasScrolledRef.current = true;
          setShowScrollToBottom(true);
          return;
        }
        if (!nearBottom) return; // 平滑滚动仍在途中，忽略中间位置
        releaseLock(); // 已抵达底部：提前解锁并落地状态
      }

      // 吸底跟随期间程序化滚动会经过"距底 > 50px"的中间位置（大块内容 easing 追赶），
      // 不能据此判定用户离开底部；跟随中只有向上滚动才代表用户接管
      const followingBottom = isAutoScrollingRef.current && !userHasScrolledRef.current;
      const awayFromBottom = followingBottom ? scrolledUp : !nearBottom;
      userHasScrolledRef.current = awayFromBottom;
      setShowScrollToBottom(awayFromBottom);
    };

    syncScrollStateRef.current = syncScrollState;
    resetScrollBaselineRef.current = () => {
      lastScrollTop = viewportElement.scrollTop;
    };
    syncScrollState();
    viewportElement.addEventListener('scroll', syncScrollState, { passive: true });

    return () => {
      syncScrollStateRef.current = () => {};
      resetScrollBaselineRef.current = () => {};
      viewportElement.removeEventListener('scroll', syncScrollState);
    };
  }, [viewportElement]);

  useEffect(() => {
    return () => {
      if (programmaticScrollUnlockTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollUnlockTimerRef.current);
      }
    };
  }, []);

  // 🖱️ 平滑滚轮惯性 + 第一时间检测向上滚动意图（主流聊天产品 同级手感）
  useSmoothWheel(containerRef.current, {
    // 直接提供已知 viewport，避免缓动循环每帧 querySelector
    getScrollElement: () => viewportElement,
    onUserScrollUp: () => {
      if (isAutoScrollingRef.current) {
        userHasScrolledRef.current = true;
        setShowScrollToBottom(true);
      }
    },
  });

  // 🚀 P1优化：流式生成时使用 rAF 自动滚动（替代 setInterval）
  useEffect(() => {
    if (!isStreaming || !viewportElement) {
      isAutoScrollingRef.current = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    isAutoScrollingRef.current = true;

    // 使用 rAF 循环，仅在流式时执行
    // 大块内容（代码块/图片）出现时用 easing 平滑追赶，逐行文本用 instant 紧跟
    const scrollLoop = () => {
      if (!isAutoScrollingRef.current) return;

      // 用户已主动滚离底部 → 停止自动滚动，尊重用户意图
      if (userHasScrolledRef.current) {
        rafIdRef.current = requestAnimationFrame(scrollLoop);
        return;
      }

      const maxScroll = viewportElement.scrollHeight - viewportElement.clientHeight;
      const currentBottom = viewportElement.scrollTop + viewportElement.clientHeight;
      const distance = maxScroll + viewportElement.clientHeight - currentBottom;

      if (distance <= 0) {
        rafIdRef.current = requestAnimationFrame(scrollLoop);
        return;
      }

      // 大块内容（>200px，如代码块/图片）→ easing 追赶，避免视觉跳动
      // 小块内容（逐行文本）→ instant 紧跟
      if (distance > 200) {
        const eased = currentBottom + distance * 0.35 - viewportElement.clientHeight;
        viewportElement.scrollTop = Math.min(eased, maxScroll);
      } else {
        viewportElement.scrollTop = maxScroll;
      }

      rafIdRef.current = requestAnimationFrame(scrollLoop);
    };

    rafIdRef.current = requestAnimationFrame(scrollLoop);

    return () => {
      isAutoScrollingRef.current = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isStreaming, viewportElement]);

  // 🆕 追踪 streaming 状态变化，用于检测"用户刚发送了新消息"
  const prevIsStreamingRef = useRef(isStreaming);

  // 新消息定位：用户发送新消息时，以该消息在顶部开始（主流聊天产品 同级体验）
  // 流式开始后由 rAF 循环接管滚动；非流式新增消息仍 scrollToBottom
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    // 流式刚开始 → 用户刚发了新消息，定位用户消息到顶部
    // 流式开始后由 rAF 循环接管，默认跟随 AI 输出滚动到底部
    // 用户向上滚动时 rAF 检测到 userHasScrolledRef 后暂停跟随，让用户接管
    if (isStreaming && !wasStreaming) {
      userHasScrolledRef.current = false;
      setShowScrollToBottom(false);
      const rafId = requestAnimationFrame(() => {
        if (!viewportElement) return;
        // 程序化滚动锁：防止 scrollIntoView 触发的原生 scroll 事件
        // 被 syncScrollState 误判为"用户滚动"，从而错误地阻断 rAF 自动跟随
        programmaticScrollLockRef.current = true;
        scheduleProgrammaticScrollUnlock(300);
        // 定位可能向上跳（超长用户消息对齐到视口顶部时），完成后立即重置
        // 方向检测基准，避免这次程序化跳变被当成"用户向上滚"
        if (useDirectRender) {
          // viewportElement.lastElementChild 是 div[role="log"] 包装元素
          // 其内部 children 按 messageOrder 排列，末尾两条是 [用户消息, 助手占位]
          // 需要定位到倒数第二条（用户消息）使其在视口顶部
          const logDiv = viewportElement.lastElementChild as HTMLElement | null;
          const messageItems = logDiv?.children;
          if (messageItems && messageItems.length >= 2) {
            const userMessageEl = messageItems[messageItems.length - 2] as HTMLElement;
            // Do not use scrollIntoView here: it may scroll every ancestor, including
            // the OS/workbench window host. Keep the scroll confined to the message viewport.
            const viewportRect = viewportElement.getBoundingClientRect();
            const messageRect = userMessageEl.getBoundingClientRect();
            const target = viewportElement.scrollTop + messageRect.top - viewportRect.top;
            viewportElement.scrollTop = Math.max(
              0,
              Math.min(target, viewportElement.scrollHeight - viewportElement.clientHeight),
            );
            resetScrollBaselineRef.current();
            return;
          }
        }
        // 虚拟模式下用 scrollToIndex 定位用户消息（倒数第二条）
        if (messageOrder.length >= 2) {
          virtualizer.scrollToIndex(messageOrder.length - 2, { align: 'start', behavior: 'auto' });
          resetScrollBaselineRef.current();
          return;
        }
        scrollToBottom();
        resetScrollBaselineRef.current();
      });
      return () => cancelAnimationFrame(rafId);
    }

    // 流式结束 → 确保停在底部
    if (!isStreaming && wasStreaming) {
      if (!userHasScrolledRef.current) {
        const rafId = requestAnimationFrame(() => { scrollToBottom(); });
        return () => cancelAnimationFrame(rafId);
      }
    }
  }, [isStreaming, viewportElement, scrollToBottom]);

  // 非流式期间新消息到达时滚动到底部（如加载历史记录）
  useEffect(() => {
    const appended = messageOrder.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messageOrder.length;
    if (historyInsertionRef.current) {
      historyInsertionRef.current = false;
      return;
    }
    if (!appended || isStreaming || userHasScrolledRef.current) return;
    const rafId = requestAnimationFrame(() => { scrollToBottom(); });
    return () => cancelAnimationFrame(rafId);
  }, [messageOrder.length, isStreaming, scrollToBottom]);

  // 📊 性能打点：首次渲染完成
  // 只有当 isDataLoaded 为 true 时才触发 first_render，避免 race condition
  useEffect(() => {
    // 📊 细粒度打点：useEffect 触发
    sessionSwitchPerf.mark('ml_effect_trigger', { isDataLoaded });

    if (hasMarkedFirstRenderRef.current) return;
    if (!isDataLoaded) return; // 等待数据加载完成

    // 使用 requestAnimationFrame 确保 DOM 已经渲染
    requestAnimationFrame(() => {
      if (hasMarkedFirstRenderRef.current) return; // 双重检查

      sessionSwitchPerf.mark('first_render', {
        messageCount: messageOrder.length,
        isEmpty: messageOrder.length === 0,
      });
      sessionSwitchPerf.endTrace(); // 结束追踪
      hasMarkedFirstRenderRef.current = true;
    });
  }, [isDataLoaded, messageOrder.length]);

  // 📊 细粒度打点：render 开始
  const getVirtualItemsStart = performance.now();
  const virtualItems = virtualizerReady ? virtualizer.getVirtualItems() : [];
  const getVirtualItemsMs = performance.now() - getVirtualItemsStart;
  sessionSwitchPerf.mark('ml_get_virtual_items', { ms: getVirtualItemsMs, count: virtualItems.length });
  const hasViewport = !!viewportElement;

  // 说明：短会话直渲避免虚拟化成本，长会话启用虚拟滚动以控制 DOM 规模。
  // 虚拟化就绪前用直渲尾部窗口兜底，消除切换长会话时的空白帧。
  const showDirectFlow = useDirectRender || !virtualizerReady;
  // 直渲窗口起点：窗口已补齐（且真直渲模式）时从头渲染；否则只渲染尾部 INITIAL_RENDER_COUNT 条
  const directRenderStart = useDirectRender && tailWindowExpanded
    ? 0
    : Math.max(0, messageOrder.length - INITIAL_RENDER_COUNT);

  sessionSwitchPerf.mark('ml_render_start', {
    messageCount: messageOrder.length,
    virtualItemCount: virtualItems.length,
    hasViewport,
    useDirectRender,
    virtualizerReady,
  });

  // 📊 细粒度打点：首帧在 render 路径上被调度（避免仅依赖 effect/rAF）
  if (!hasMarkedFirstRenderScheduledRef.current && isDataLoaded) {
    sessionSwitchPerf.mark('first_render_scheduled', {
      messageCount: messageOrder.length,
      hasViewport,
      useDirectRender,
    });
    hasMarkedFirstRenderScheduledRef.current = true;
  }

  // 空状态
  if (forceEmptyPreview || messageOrder.length === 0) {
    const emptyStatePrimaryAction = emptyStateGroupName
      ? t('messageList.empty.primaryActionInGroup', {
          groupName: emptyStateGroupName,
          defaultValue: '在「{{groupName}}」里学点什么？',
        })
      : t('messageList.empty.primaryAction', { defaultValue: '今天想学点什么？' });

    return (
      <div
        className={cn(
          'flex h-full w-full flex-col',
          className
        )}
      >
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3 md:px-8 md:pb-8 md:pt-4">
          <ThreadEmptyStateShell
            title={emptyStatePrimaryAction}
            contentClassName={isSmallScreen ? 'py-10' : 'py-16'}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
    {/* WCAG 4.1.3: 屏幕阅读器通知区域（虚拟化模式下不能在容器上用 aria-live） */}
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {srAnnouncement}
    </div>
    <CustomScrollArea
      ref={containerRef}
      viewportRef={viewportCallbackRef}
      className={cn('h-full', className)}
      hideTrackWhenIdle
    >
      {showDirectFlow ? (
        // 直接渲染模式（禁用虚拟化）+ 虚拟化就绪前的尾部窗口兜底（不再渲染空白）
        <div
          key={`direct-${listEpochRef.current}`}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          style={{ width: '100%', paddingBottom: MESSAGE_BOTTOM_SAFE_AREA_PX }}
        >
          <AnimatePresence>
            {messageOrder.slice(directRenderStart).map((messageId, sliceIndex) => {
              const messageIndex = directRenderStart + sliceIndex;
              const isUserMessage = store.getState().getMessage(messageId)?.role === 'user';
              // 只有挂载后追加的消息播放入场动画；历史消息（含窗口补齐插入的）静态呈现
              const isNewlyAppended = messageIndex >= initialMessageCountRef.current;
              const content = (
                <MessageItem
                  messageId={messageId}
                  store={store}
                  isFirst={messageIndex === 0}
                  isLatest={messageIndex === messageOrder.length - 1}
                />
              );
              if (isUserMessage) {
                return (
                  <motion.div
                    key={messageId}
                    data-chat-message-id={messageId}
                    variants={newMessageVariants}
                    initial={isNewlyAppended ? 'initial' : false}
                    animate="animate"
                    exit="exit"
                  >
                    {content}
                  </motion.div>
                );
              }
              return <div key={messageId} data-chat-message-id={messageId}>{content}</div>;
            })}
          </AnimatePresence>
        </div>
      ) : (
        // 虚拟滚动模式
        // aria-live 显式关闭：虚拟化会随滚动挂载/卸载旧消息，若保持 polite
        // 屏幕阅读器会把回收复用的历史消息当作"新增"重复播报；
        // 新消息通知统一由顶部 sr-only status 区域承担
        <div
          key={`virtual-${listEpochRef.current}`}
          role="log"
          aria-live="off"
          style={{
            height: `${virtualizer.getTotalSize() + MESSAGE_BOTTOM_SAFE_AREA_PX}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const messageId = messageOrder[virtualRow.index];
            if (!messageId) return null;

            const isUserMessage = store.getState().getMessage(messageId)?.role === 'user';

            return (
              <div
                key={messageId}
                data-index={virtualRow.index}
                data-chat-message-id={messageId}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {isUserMessage ? (
                  <motion.div
                    variants={newMessageVariants}
                    initial={virtualRow.index >= initialMessageCountRef.current ? 'initial' : false}
                    animate="animate"
                  >
                    <MessageItem
                      messageId={messageId}
                      store={store}
                      isFirst={virtualRow.index === 0}
                      isLatest={virtualRow.index === messageOrder.length - 1}
                    />
                  </motion.div>
                ) : (
                  <MessageItem
                    messageId={messageId}
                    store={store}
                    isFirst={virtualRow.index === 0}
                    isLatest={virtualRow.index === messageOrder.length - 1}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </CustomScrollArea>
    {/* 回到底部浮动按钮 */}
    <div
      className="pointer-events-none absolute inset-x-0 bottom-2 px-4 md:bottom-3 md:px-8"
      style={{ zIndex: Z_INDEX.inputBar - 10 }}
    >
      <ThreadContentShell className="pointer-events-none overflow-visible">
        <div
          className="t-panel-slide ml-auto w-fit"
          data-open={showScrollToBottom ? 'true' : 'false'}
          aria-hidden={!showScrollToBottom}
          style={{
            ['--panel-translate-y' as string]: '12px',
            ['--panel-open-dur' as string]: '300ms',
            ['--panel-close-dur' as string]: '220ms',
          }}
        >
          <button
            type="button"
            onClick={handleScrollToBottomClick}
            title={scrollToBottomLabel}
            data-slot="message-list-scroll-to-bottom"
            tabIndex={showScrollToBottom ? 0 : -1}
            className={cn(
              'pointer-events-auto ml-auto flex h-10 w-10 items-center justify-center rounded-full',
              'border border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)]',
              'text-[color:var(--button-utility-foreground)] transition-colors duration-150',
              'hover:border-[color:var(--button-utility-border)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--button-utility-foreground)]',
              'active:bg-[color:var(--button-utility-active)]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
              'cursor-pointer'
            )}
            aria-label={scrollToBottomLabel}
          >
            <ArrowDown size={16} weight="bold" />
          </button>
        </div>
      </ThreadContentShell>
    </div>
    </div>
  );
};

// 🚀 性能优化：使用 React.memo 防止父组件重渲染导致的不必要重渲染
// 自定义比较函数：只有当 store 引用或其他 props 真正变化时才重渲染
export const MessageList = memo(MessageListInner, (prevProps, nextProps) => {
  // 如果 store 引用相同，认为 props 没有变化
  // store 内部状态变化通过订阅机制处理，不需要组件重渲染
  return (
    prevProps.store === nextProps.store &&
    prevProps.className === nextProps.className &&
    prevProps.emptyStateGroupName === nextProps.emptyStateGroupName &&
    prevProps.estimatedItemSize === nextProps.estimatedItemSize &&
    prevProps.overscan === nextProps.overscan &&
    prevProps.forceEmptyPreview === nextProps.forceEmptyPreview
  );
});

export default MessageList;
