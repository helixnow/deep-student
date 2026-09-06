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

import React, { useRef, useEffect, useLayoutEffect, useCallback, memo, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { cn } from '@/utils/cn';
import { newMessageVariants } from '@/styles/motion-variants';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MessageItem } from './MessageItem';
import { clearPdfPageCache } from './renderers/MarkdownRenderer';
import { useMessageOrder, useSessionStatus, useIsDataLoaded } from '../hooks/useChatStore';
import type { Block, ChatStore } from '../core/types';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import Z_INDEX from '@/config/zIndex';
import { useSmoothWheel } from '../hooks/useSmoothWheel';
import {
  registerChatMessageListScrollHandle,
  type ChatMessageScrollResult,
} from './messageListScrollRegistry';
import { ArrowDown } from '@phosphor-icons/react';
import { ThreadEmptyStateShell } from './ui/ThreadEmptyStateShell';
import { ThreadContentShell } from './ui/ThreadContentShell';
import { MessageSearchBar } from './MessageSearchBar';
import { findMessageSearchMatches } from './messageSearch';
import { useDesktopShellChatHeaderPortal } from '@/app/shell/DesktopShellHeaderPortal';
import { useViewStore } from '@/stores/viewStore';

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

/** 距底 ≤ 该值视为"在底部"（滚回底部时恢复吸底跟随的灵敏度，主流聊天产品同级） */
const BOTTOM_THRESHOLD_PX = 50;

const EMPTY_BLOCK_MAP = new Map<string, Block>();

/**
 * 助手消息轻量入场：复用 motion.css 共享类 .chat-msg-enter（fade + 4px 上移，
 * 150ms 标准出口曲线，自带 prefers-reduced-motion 降级）。
 * 用户消息保持 newMessageVariants 的气泡弹出感；仅挂载后新追加的消息播放。
 */
const ASSISTANT_ENTER_CLASS = 'chat-msg-enter';

/**
 * P0-4: 计算输入栏对消息视口的实际遮挡像素。
 *
 * 当前布局中输入栏（.unified-input-docked）是消息列表的流内 flex 兄弟，
 * 矩形不重叠时返回 0（消息区不增加额外 padding）。当键盘 inset /
 * 浮动式输入栏使其矩形盖到视口上时，以重叠像素动态抬高底部 padding，
 * 并用输入栏写入的 CSS 变量 --unified-input-docked-height 作为上限
 * （变量缺失时以视口高度 60% 兜底），避免动画中间态的异常矩形放大 padding。
 */
function measureInputBarOverlapPx(viewport: HTMLElement): number {
  const chatRoot = viewport.closest('.chat-v2') ?? document;
  const inputBar = chatRoot.querySelector<HTMLElement>('.unified-input-docked');
  if (!inputBar) return 0;

  const viewportRect = viewport.getBoundingClientRect();
  const inputRect = inputBar.getBoundingClientRect();
  // 未布局/隐藏（display:none 的矩形全 0）视为不遮挡
  if (viewportRect.height === 0 || (inputRect.width === 0 && inputRect.height === 0)) {
    return 0;
  }

  const overlap = Math.max(0, Math.round(viewportRect.bottom - inputRect.top));
  if (overlap === 0) return 0;

  const dockedHeightRaw = getComputedStyle(inputBar).getPropertyValue('--unified-input-docked-height');
  const dockedHeight = Number.parseFloat(dockedHeightRaw);
  const cap = Number.isFinite(dockedHeight) && dockedHeight > 0
    ? dockedHeight
    : viewportRect.height * 0.6;
  return Math.min(overlap, Math.round(cap));
}

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
  const scrollToBottomLabel = t('messageList.scrollToBottom');

  // 用户偏好减少动效时跳过消息入场动画（framer variants 无法被 CSS 媒体查询覆盖）
  const prefersReducedMotion = useReducedMotion();

  // 📱 移动端适配：检测屏幕尺寸
  const { isSmallScreen } = useBreakpoint();
  const desktopChatHeaderTarget = useDesktopShellChatHeaderPortal();

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

  // 历史分页状态（顶部横幅 + 滚动自动触发）
  const hasMoreHistory = useStore(store, (s) => s.hasMoreHistory);
  const isLoadingEarlier = useStore(store, (s) => s.isLoadingEarlier);
  const loadEarlierError = useStore(store, (s) => s.loadEarlierError);
  const earlierHistoryExhausted = useStore(store, (s) => s.earlierHistoryExhausted);

  // 历史分页：滚动接近顶部时自动加载更早消息。
  // 出错后自动触发解除（避免失败风暴），由横幅上的重试按钮恢复；
  // store action 内含防重入与 hasMoreHistory 守卫，这里无需节流。
  useEffect(() => {
    if (!viewportElement) return;
    const maybeLoadEarlier = () => {
      if (viewportElement.scrollTop > 120) return;
      const s = store.getState();
      if (s.hasMoreHistory && !s.isLoadingEarlier && !s.loadEarlierError) {
        void s.loadEarlierMessages();
      }
    };
    viewportElement.addEventListener('scroll', maybeLoadEarlier, { passive: true });
    return () => viewportElement.removeEventListener('scroll', maybeLoadEarlier);
  }, [viewportElement, store]);

  // 历史分页：内容不足一屏时 scrollTop 恒 0、滚动事件不触发，主动补页
  // 直到填满视口或抵达最早一页（messageOrder.length 驱动逐页复查）
  useEffect(() => {
    if (!viewportElement || !hasMoreHistory || isLoadingEarlier || loadEarlierError) return;
    if (viewportElement.scrollHeight <= viewportElement.clientHeight + 120) {
      void store.getState().loadEarlierMessages();
    }
  }, [viewportElement, hasMoreHistory, isLoadingEarlier, loadEarlierError, messageOrder.length, store]);


  // 搜索打开时才订阅 blocks：流式输出会频繁替换 blocks Map，避免关闭搜索时
  // 让整个消息列表跟着每个 token 重渲染。
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const searchBlocks = useStore(
    store,
    useCallback((state: ChatStore) => isSearchOpen ? state.blocks : EMPTY_BLOCK_MAP, [isSearchOpen]),
  );
  const searchMatches = useMemo(
    () => findMessageSearchMatches(
      messageOrder,
      store.getState().messageMap,
      searchBlocks,
      searchQuery,
    ),
    [messageOrder, searchBlocks, searchQuery, store],
  );
  const resolvedActiveSearchIndex = searchMatches.length > 0
    ? Math.min(activeSearchIndex, searchMatches.length - 1)
    : 0;
  const activeSearchMatch = searchMatches[resolvedActiveSearchIndex] ?? null;
  const activeSearchMessageId = activeSearchMatch?.messageId ?? null;
  const searchMatchSet = useMemo(
    () => new Set(searchMatches.map((match) => match.messageId)),
    [searchMatches],
  );

  // 切换会话时不把上一个会话的搜索词带到新会话。
  useEffect(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setActiveSearchIndex(0);
  }, [store]);

  // Ctrl/Cmd+F 只拦截当前会话页的内容搜索，避免把浏览器原生查找框打开。
  const handleWindowKeyDown = useCallback((event: KeyboardEvent) => {
    const isFindShortcut = (event.metaKey || event.ctrlKey)
      && !event.altKey
      && event.key.toLowerCase() === 'f';

    if (isFindShortcut) {
      if (forceEmptyPreview || messageOrder.length === 0) return;
      event.preventDefault();
      setIsSearchOpen(true);
      return;
    }

    if (event.key === 'Escape' && isSearchOpen) {
      event.preventDefault();
      setIsSearchOpen(false);
      setSearchQuery('');
      setActiveSearchIndex(0);
    }
  }, [forceEmptyPreview, isSearchOpen, messageOrder.length]);

  useEventRegistry([
    {
      target: 'window',
      type: 'keydown',
      listener: handleWindowKeyDown as EventListener,
    },
  ], [handleWindowKeyDown]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (activeSearchIndex < searchMatches.length) return;
    setActiveSearchIndex(Math.max(0, searchMatches.length - 1));
  }, [activeSearchIndex, searchMatches.length]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setActiveSearchIndex(0);
  }, []);

  // 全局视图切走 chat-v2 时强制关闭搜索：搜索条两种形态都 portal 在宿主视图
  // 之外（body / 桌面壳顶栏），ViewLayer 保活（visibility:hidden）不会连带
  // 隐藏它。状态驱动兜底，覆盖不派发 app:view-switched 的切换路径
  // （对照 InlineImageViewer 在 currentView !== 'chat-v2' 时关闭预览）。
  const currentView = useViewStore((s) => s.currentView);
  useEffect(() => {
    if (isSearchOpen && currentView !== 'chat-v2') {
      closeSearch();
    }
  }, [isSearchOpen, currentView, closeSearch]);

  const moveToSearchMatch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return;
    setActiveSearchIndex((current) => (
      (current + direction + searchMatches.length) % searchMatches.length
    ));
  }, [searchMatches.length]);

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
  // 虚拟化初始化耗时记录（会话切换时重置，避免打点只在首个会话生效）
  const hasLoggedVirtualizerRef = useRef(false);
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
  // 本次 render 检测到的"既有消息之前插入"条数（幂等赋值，StrictMode 安全）；
  // 供提交后的布局效应区分追加 vs 插入（锚定补偿也在布局效应执行）
  const lastInsertedCountRef = useRef(0);

  // ===== 吸底跟随 v2：observedTop 账本（参考 deepseek-harness ChatView）=====
  // 所有程序化 scrollTop 写入必须经 writeScroll 记账；scroll 事件里
  // |scrollTop - min(observedTop, floor)| > 0.5 才算用户滚动——设备无关
  //（滚轮/触控板/滚动条拖拽/键盘/触摸全覆盖），且浏览器收缩 clamp 恰好
  // 落在 min(observedTop, floor) 上，天然不会被误判为用户上滚。
  const observedTopRef = useRef(0);
  // 是否处于吸底跟随状态（即滚动所有权在不在程序手里）
  const atBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // P1-8: 用户滚离底部期间有新消息追加时，回到底部按钮上显示小圆点提示
  const [hasUnseenNewMessages, setHasUnseenNewMessages] = useState(false);
  // 🔧 优化：使用 ref 追踪上一次消息数量（追加 vs 插入检测）
  const prevMessageCountRef = useRef(messageOrder.length);

  // 列表纪元：按会话递增，作为消息容器的 key。切换会话时旧列表子树整体卸载，
  // AnimatePresence 不再对旧会话消息播放退场动画（避免新旧内容短暂混排）；
  // 外层 CustomScrollArea / viewport / 虚拟化器保持存活
  const listEpochRef = useRef(0);

  // 当 store 变化时（切换会话），重置标记和状态
  const storeChanged = lastStoreRef.current !== store;
  if (storeChanged) {
    hasMarkedFirstRenderRef.current = false;
    hasMarkedFirstRenderScheduledRef.current = false;
    hasLoggedVirtualizerRef.current = false;
    lastStoreRef.current = store;
    hasAnchoredRef.current = false;
    pendingScrollCompensationRef.current = null;
    initialMessageCountRef.current = messageOrder.length;
    prevMessageOrderRef.current = messageOrder;
    lastInsertedCountRef.current = 0;
    // 会话切换：从底部锚定的吸底状态重新开始（render 阶段重置，保证提交后
    // 的布局效应/scroll 分类器读到的已是新会话状态）
    atBottomRef.current = true;
    observedTopRef.current = 0;
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
      // 幂等赋值（StrictMode 双调用安全）；供提交后的布局效应区分追加 vs 插入
      lastInsertedCountRef.current = insertedBeforeExisting;
      if (insertedBeforeExisting > 0) {
        // 入场动画门槛（isNewlyAppended）在 render 中消费 initialMessageCount，
        // 必须在这里同步累加（移到布局效应会让本次 render 读到旧值，导致插入时
        // 末条消息被误判为新增而播放入场动画）。安全性：本块由
        // previousOrder !== messageOrder + prevMessageOrderRef 写回保护，
        // StrictMode 双调用/并发重放的后续调用整体跳过，每次 order 迁移恰好累加一次
        initialMessageCountRef.current += insertedBeforeExisting;
        // render 阶段读取的是提交前 DOM（与被丢弃的并发 render 看到的一致，
        // 几何是确定性的）；此处仅记录快照，补偿在布局效应中执行
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

  // 吸底跟随中禁止虚拟化器的尺寸变化补偿：其 scrollTop 调整写入未记账，
  // 会被账本分类器误判为用户滚离而中断跟随；阅读时保持 core 默认行为
  //（仅补偿视口上方的行，保持阅读位置稳定）。
  // 注意：shouldAdjustScrollPositionOnItemSizeChange 是 virtual-core 的
  // Virtualizer 实例属性而非构造选项（scrollAdjustments 私有，默认判定中的
  // 瞬态修正项无法复刻，省略不影响主场景）
  useEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      if (atBottomRef.current) return false;
      return item.start < (instance.scrollOffset ?? 0) && instance.scrollDirection !== 'backward';
    };
    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [virtualizer]);

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

  // ===== 吸底跟随 v2：程序化写入唯一入口（写入即记账）=====
  const writeScroll = useCallback((top: number) => {
    const el = viewportElement;
    if (!el) return;
    el.scrollTop = top;
    // 写后回读：浏览器可能把越界值 clamp 到 [0, floor]，账本记真实落点
    observedTopRef.current = el.scrollTop;
  }, [viewportElement]);

  // 跟随写入：仅在拥有滚动所有权（atBottom）时生效
  const followBottom = useCallback(() => {
    const el = viewportElement;
    if (!el || !atBottomRef.current) return;
    writeScroll(el.scrollHeight);
  }, [viewportElement, writeScroll]);

  // 🆕 追踪 streaming 状态变化，用于检测"用户刚发送了新消息"
  const prevIsStreamingRef = useRef(isStreaming);

  // 统一的提交后结算（布局效应，绘制前完成）：
  // 1) 历史插入/尾部窗口补齐的锚定补偿（优先首可见行像素偏移，兜底 scrollHeight 差值）
  // 2) 流式开始的所有权转移（发送即回底）
  // 3) 追加/流式边沿/会话切换时的吸底跟随
  // 4) 滚离期间尾部追加 → 未读圆点
  useLayoutEffect(() => {
    // --- 插入补偿 ---
    const insertedCount = lastInsertedCountRef.current;
    lastInsertedCountRef.current = 0;
    const pending = pendingScrollCompensationRef.current;
    pendingScrollCompensationRef.current = null;
    if (pending && viewportElement) {
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
        writeScroll(pending.scrollTop + delta);
      }
    }

    // --- 流式开始：发送即回底（所有权转移）---
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (isStreaming && !wasStreaming) {
      atBottomRef.current = true;
      setShowScrollToBottom(false);
      setHasUnseenNewMessages(false);
    }

    // --- 跟随 / 未读圆点 ---
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messageOrder.length;
    const appended = messageOrder.length > prevCount && insertedCount === 0;
    if (atBottomRef.current) {
      followBottom();
    } else if (appended) {
      // P1-8: 用户滚离底部期间尾部有新消息追加 → 回到底部按钮显示未读圆点
      setHasUnseenNewMessages(true);
    }
  }, [messageOrder, tailWindowExpanded, isStreaming, store, viewportElement, followBottom, writeScroll]);

  // 🚀 会话打开即底部锚定：在绘制前执行，避免"先见顶部再跳底部"的闪动
  useLayoutEffect(() => {
    if (hasAnchoredRef.current) return;
    if (!viewportElement || messageOrder.length === 0) return;
    writeScroll(viewportElement.scrollHeight);
    hasAnchoredRef.current = true;
  }, [store, viewportElement, messageOrder.length, writeScroll]);

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

  // P0-4: 输入栏（键盘 inset / 浮动态）盖到消息视口上的像素数，动态抬高底部安全区
  const [inputOverlapPx, setInputOverlapPx] = useState(0);

  // 切换会话（不 remount）：清理上一会话的按钮/未读点 UI 状态
  //（atBottomRef 等 ref 已在 render 阶段的 storeChanged 块重置）
  useEffect(() => {
    setShowScrollToBottom(false);
    setHasUnseenNewMessages(false);
  }, [store]);

  // P0-4: 观察输入栏矩形对消息视口的实际遮挡（键盘 inset / 输入栏长高 / 浮动态），
  // 动态抬高消息区底部 padding。输入栏与列表是流内兄弟，常态下 overlap 为 0，无额外开销
  useEffect(() => {
    if (!viewportElement) return;
    const chatRoot = viewportElement.closest('.chat-v2');
    const inputBar = chatRoot?.querySelector<HTMLElement>('.unified-input-docked');
    if (!inputBar) return;

    let rafId: number | null = null;
    const sync = () => {
      rafId = null;
      setInputOverlapPx((prev) => {
        const next = measureInputBarOverlapPx(viewportElement);
        return next === prev ? prev : next;
      });
    };
    const schedule = () => {
      if (rafId === null) rafId = requestAnimationFrame(sync);
    };

    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(inputBar);
    resizeObserver.observe(viewportElement);
    // 键盘 inset 走 inline style（padding/CSS 变量），高度不变时也要重测
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(inputBar, { attributes: true, attributeFilter: ['style', 'class'] });
    window.visualViewport?.addEventListener('resize', schedule);

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.visualViewport?.removeEventListener('resize', schedule);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [viewportElement]);

  // 🔧 P0：会话切换时清空 PDF 页图模块缓存，释放跨会话滞留的 dataUrl 堆内存
  useEffect(() => {
    return () => {
      clearPdfPageCache();
    };
  }, [store]);

  // 滚动到底部（"回到底部"按钮）：瞬时定位并收回滚动所有权。
  // 与 deepseek/opencode 一致使用瞬时滚动：smooth 动画途中若内容继续增长，
  // 落点会短缺且跟随状态难以结算；瞬时写入即记账，后续增长由 ResizeObserver 跟随
  const scrollToBottom = useCallback(() => {
    atBottomRef.current = true;
    setShowScrollToBottom(false);
    setHasUnseenNewMessages(false);
    followBottom();
  }, [followBottom]);

  // 🚀 虚拟化就绪交接：从直渲兜底切到虚拟定位时，若仍在吸底则重新钉底
  useEffect(() => {
    if (!virtualizerReady || useDirectRender) return;
    const rafId = requestAnimationFrame(() => { followBottom(); });
    return () => cancelAnimationFrame(rafId);
  }, [virtualizerReady, useDirectRender, followBottom]);

  /** 点击"回到底部"按钮 */
  const handleScrollToBottomClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    scrollToBottom();
  }, [scrollToBottom]);

  // ===== 账本分类器：scroll 事件里区分用户滚动与程序化写入 =====
  // 偏离账本（|scrollTop - min(observedTop, floor)| > 0.5）才算用户滚动；
  // 浏览器收缩 clamp 恰好落在 min(observedTop, floor) 上，天然免疫误判。
  // 设备无关：滚轮/触控板/滚动条拖拽/键盘/触摸/辅助技术全覆盖。
  useEffect(() => {
    const el = viewportElement;
    if (!el) return;

    const onScroll = () => {
      const floor = Math.max(0, el.scrollHeight - el.clientHeight);
      const movedByReader =
        Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5;
      const isAtBottom = movedByReader
        ? floor - el.scrollTop <= BOTTOM_THRESHOLD_PX
        : atBottomRef.current;
      if (!movedByReader && isAtBottom) {
        // 账本内事件且贴底：异步内容增长可能落在两次记账之间，补钉到底
        followBottom();
        return;
      }
      atBottomRef.current = isAtBottom;
      setShowScrollToBottom(!isAtBottom);
      // P1-8: 回到底部即视为"已读"，清除新消息圆点
      if (isAtBottom) setHasUnseenNewMessages(false);
      observedTopRef.current = el.scrollTop;
    };

    observedTopRef.current = el.scrollTop;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [viewportElement, followBottom]);

  // 内容原地增长（流式 token / 图片加载 / 块展开 / 输入栏遮挡抬 padding）→ 贴底时同帧跟随。
  // ResizeObserver 回调运行于布局后、绘制前，无可见跳动；不吸底时不写。
  // 常驻（不限流式）：非流式期间底部内容增长同样保持贴底。
  // log 节点随会话/模式切换 remount（key=listEpoch），用 state 跟踪保证重新观察。
  const [logElement, setLogElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!logElement || typeof ResizeObserver !== 'function') return;
    const resizeObserver = new ResizeObserver(() => { followBottom(); });
    resizeObserver.observe(logElement);
    return () => resizeObserver.disconnect();
  }, [logElement, followBottom]);

  // 🖱️ 平滑滚轮惯性（纯手感层）：其写入不记账，自然被分类为用户滚动，
  // 无需再向上滚回调与跟随判定耦合
  useSmoothWheel(containerRef.current, {
    // 直接提供已知 viewport，避免缓动循环每帧 querySelector
    getScrollElement: () => viewportElement,
  });

  // ==========================================================================
  // A45-5（docs/dev/acr/ACR-4.5.md）：agent 程序化滚动到指定消息
  // 旧路径（workbench chat/register.ts 直接 querySelector role="log" 子节点）
  // 在虚拟化长会话（>80 条）下目标行未渲染必然失败；这里暴露按 messageId
  // 的滚动 handle：虚拟化走 virtualizer.scrollToIndex，直渲先补齐尾部窗口，
  // 滚动后等目标行真实挂载才报成功。
  // ==========================================================================

  // handle 闭包读取的最新渲染态快照（避免依赖变化时反复注册/注销 handle）
  const agentScrollStateRef = useRef({
    useDirectRender,
    virtualizerReady,
    tailWindowExpanded,
    viewportElement,
  });
  agentScrollStateRef.current = {
    useDirectRender,
    virtualizerReady,
    tailWindowExpanded,
    viewportElement,
  };

  const scrollToMessageForAgent = useCallback(
    async (
      messageId: string,
      searchOccurrenceIndex?: number,
    ): Promise<ChatMessageScrollResult> => {
      const order = store.getState().messageOrder;
      const index = order.indexOf(messageId);
      if (index < 0) return { status: 'message_not_found' };
      const viewport = agentScrollStateRef.current.viewportElement;
      if (!viewport) return { status: 'view_not_ready' };

      // 程序化定位视为用户接管滚动：立即释放吸底所有权，
      // 避免刚定位到历史消息又被自动拉回底部。
      // 定位写入不记账，其 scroll 事件会被账本分类为读者移动，状态随事件结算
      atBottomRef.current = false;

      // 直渲模式且尾部窗口未补齐：目标可能在窗口之外，先展开再等挂载
      if (
        agentScrollStateRef.current.useDirectRender
        && !agentScrollStateRef.current.tailWindowExpanded
      ) {
        setTailWindowExpanded(true);
      }

      const escapeAttr = (value: string) =>
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(value)
          : value.replace(/["\\]/g, '\\$&');
      const findRow = () =>
        viewport.querySelector<HTMLElement>(
          `[data-chat-message-id="${escapeAttr(messageId)}"]`,
        );
      const nextFrame = () =>
        new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
          } else {
            setTimeout(resolve, 16);
          }
        });

      // 上限约 30 帧（≈0.5s）：覆盖虚拟化测量收敛与直渲窗口补齐的提交时序
      for (let frame = 0; frame < 30; frame += 1) {
        const mode = agentScrollStateRef.current;
        if (!mode.useDirectRender && mode.virtualizerReady) {
          // 虚拟化：让虚拟化器按当前测量把目标 index 滚入视口；
          // 行挂载后仍以 DOM 实测做一次精确对齐（动态测量可能微调偏移）
          virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' });
        }
        const el = findRow();
        if (el) {
          // 与既有消息定位一致：滚动只发生在消息视口内，不用 scrollIntoView
          //（scrollIntoView 会连带滚动 OS/workbench 宿主窗口）
          const viewportRect = viewport.getBoundingClientRect();
          const rowRect = el.getBoundingClientRect();
          const target = viewport.scrollTop + rowRect.top - viewportRect.top;
          viewport.scrollTop = Math.max(
            0,
            Math.min(target, viewport.scrollHeight - viewport.clientHeight),
          );

          if (searchOccurrenceIndex !== undefined) {
            viewport.querySelectorAll<HTMLElement>(
              '[data-chat-search-match="true"][data-search-active="true"]',
            ).forEach((mark) => {
              delete mark.dataset.searchActive;
            });
            const searchMatchesInRow = el.querySelectorAll<HTMLElement>(
              '[data-chat-search-match="true"]',
            );
            const activeMark = searchMatchesInRow[searchOccurrenceIndex];
            if (activeMark) {
              activeMark.dataset.searchActive = 'true';
              const markRect = activeMark.getBoundingClientRect();
              const markTarget = viewport.scrollTop + markRect.top - viewportRect.top
                - Math.max(0, (viewport.clientHeight - markRect.height) / 3);
              viewport.scrollTop = Math.max(
                0,
                Math.min(markTarget, viewport.scrollHeight - viewport.clientHeight),
              );
            }
          }
          return { status: 'scrolled', element: el };
        }
        await nextFrame();
      }
      return { status: 'view_not_ready' };
    },
    [store, virtualizer],
  );

  // 挂载期按 sessionId 注册 handle；会话固定绑定 store 实例，依赖 [store] 即可
  useEffect(() => {
    const sessionId = store.getState().sessionId;
    if (!sessionId) return undefined;
    return registerChatMessageListScrollHandle(sessionId, {
      scrollToMessage: scrollToMessageForAgent,
    });
  }, [store, scrollToMessageForAgent]);

  // 📊 性能打点：首次渲染完成
  // 只有当 isDataLoaded 为 true 时才触发 first_render，避免 race condition
  useEffect(() => {
    // 📊 细粒度打点：useEffect 触发
    sessionSwitchPerf.mark('ml_effect_trigger', { isDataLoaded });

    if (hasMarkedFirstRenderRef.current) return;
    if (!isDataLoaded) return; // 等待数据加载完成

    // 使用 requestAnimationFrame 确保 DOM 已经渲染；卸载时取消，避免向已卸载实例的 ref 写入
    const rafId = requestAnimationFrame(() => {
      if (hasMarkedFirstRenderRef.current) return; // 双重检查

      sessionSwitchPerf.mark('first_render', {
        messageCount: messageOrder.length,
        isEmpty: messageOrder.length === 0,
      });
      sessionSwitchPerf.endTrace(); // 结束追踪
      hasMarkedFirstRenderRef.current = true;
    });
    return () => cancelAnimationFrame(rafId);
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
        })
      : t('messageList.empty.primaryAction');

    return (
      <div
        className={cn(
          'flex h-full w-full flex-col',
          className
        )}
      >
        <CustomScrollArea
          className="min-h-0 flex-1"
          viewportClassName="px-4 pb-6 pt-3 overscroll-contain md:px-8 md:pb-8 md:pt-4"
          hideTrackWhenIdle
        >
          <ThreadEmptyStateShell
            title={emptyStatePrimaryAction}
            brandIcon={
              <img
                src="/logo-black.svg"
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-9 w-9 select-none brightness-0 invert-[0.55] transition-[filter] duration-200 hover:invert-[0.4]"
              />
            }
            brandIconClassName="border-0 bg-transparent shadow-none"
            contentClassName={isSmallScreen ? 'py-10' : 'py-16'}
          />
        </CustomScrollArea>
      </div>
    );
  }

  const searchBar = isSearchOpen ? (
    <MessageSearchBar
      placement={desktopChatHeaderTarget && !isSmallScreen ? 'header' : 'floating'}
      query={searchQuery}
      matchCount={searchMatches.length}
      activeMatchIndex={resolvedActiveSearchIndex}
      activeMessageId={activeSearchMessageId}
      activeOccurrenceIndex={activeSearchMatch?.occurrenceIndex ?? 0}
      onQueryChange={setSearchQuery}
      onPrevious={() => moveToSearchMatch(-1)}
      onNext={() => moveToSearchMatch(1)}
      onClose={closeSearch}
      onNavigate={scrollToMessageForAgent}
    />
  ) : null;
  // header 形态 portal 到桌面壳顶栏插槽；floating 形态（小屏 / 无顶栏插槽）由
  // MessageSearchBar 自身 portal 到 document.body——小屏下本组件位于
  // MobileSlidingLayout 的 track 内（常驻 transform），in-tree fixed 会错位。
  const searchBarPortal = searchBar && desktopChatHeaderTarget && !isSmallScreen
    ? createPortal(searchBar, desktopChatHeaderTarget)
    : searchBar;

  return (
    <div className="relative h-full">
    {searchBarPortal}
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
      viewportClassName="overscroll-contain"
      hideTrackWhenIdle
    >
      {/* 历史分页横幅：加载中 / 失败重试 / 加载更早 / 已到最早。
          常驻占位避免 exhausted 时内容跳动；滚动补偿由既有锚定逻辑承担 */}
      {(hasMoreHistory || isLoadingEarlier || loadEarlierError || earlierHistoryExhausted) && (
        <div
          className="flex justify-center py-2 text-xs text-muted-foreground"
          data-testid="history-pagination-banner"
        >
          {isLoadingEarlier ? (
            <span>{t('history.loading')}</span>
          ) : loadEarlierError ? (
            <button
              type="button"
              className="transition-colors hover:text-foreground"
              onClick={() => { void store.getState().loadEarlierMessages(); }}
            >
              {t('history.loadFailedRetry')}
            </button>
          ) : hasMoreHistory ? (
            <button
              type="button"
              className="transition-colors hover:text-foreground"
              onClick={() => { void store.getState().loadEarlierMessages(); }}
            >
              {t('history.loadEarlier')}
            </button>
          ) : (
            <span>{t('history.exhausted')}</span>
          )}
        </div>
      )}
      {showDirectFlow ? (
        // 直接渲染模式（禁用虚拟化）+ 虚拟化就绪前的尾部窗口兜底（不再渲染空白）
        // P0-4: 底部安全区随输入栏遮挡（键盘 inset 等）动态抬高
        <div
          key={`direct-${listEpochRef.current}`}
          ref={setLogElement}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          style={{ width: '100%', paddingBottom: inputOverlapPx }}
        >
          <AnimatePresence>
            {messageOrder.slice(directRenderStart).map((messageId, sliceIndex) => {
              const messageIndex = directRenderStart + sliceIndex;
              const isUserMessage = store.getState().getMessage(messageId)?.role === 'user';
              const isSearchMatch = searchMatchSet.has(messageId);
              const isActiveSearchMatch = activeSearchMessageId === messageId;
              const searchHighlightClass = isActiveSearchMatch
                ? 'rounded-[var(--chat-radius-md)] bg-primary/5 ring-2 ring-primary/45'
                : isSearchMatch
                  ? 'rounded-[var(--chat-radius-md)] ring-1 ring-primary/20'
                  : undefined;
              // 只有挂载后追加的消息播放入场动画；历史消息（含窗口补齐插入的）静态呈现
              const isNewlyAppended = messageIndex >= initialMessageCountRef.current;
              const content = (
                <MessageItem
                  messageId={messageId}
                  store={store}
                  searchQuery={searchQuery}
                  isFirst={messageIndex === 0}
                  isLatest={messageIndex === messageOrder.length - 1}
                />
              );
              if (isUserMessage) {
                return (
                  <motion.div
                    key={messageId}
                    data-chat-message-id={messageId}
                    data-search-match={isSearchMatch ? 'true' : undefined}
                    data-search-active={isActiveSearchMatch ? 'true' : undefined}
                    // A45-5：ACR 实体锚点（agentFlash 定位演出用）
                    data-agent-entity={`chat:${messageId}`}
                    className={searchHighlightClass}
                    variants={newMessageVariants}
                    initial={isNewlyAppended && !prefersReducedMotion ? 'initial' : false}
                    animate="animate"
                    exit="exit"
                  >
                    {content}
                  </motion.div>
                );
              }
              // P1-7: 新追加的助手消息轻量入场——复用 motion.css 共享类
              // .chat-msg-enter（fade + 4px 上移，150ms，自带 reduced-motion 降级）；
              // 一次性 CSS 动画，流式内容更新不重播，历史消息保持静态
              return (
                <div
                  key={messageId}
                  data-chat-message-id={messageId}
                  data-search-match={isSearchMatch ? 'true' : undefined}
                  data-search-active={isActiveSearchMatch ? 'true' : undefined}
                  // A45-5：ACR 实体锚点（agentFlash 定位演出用）
                  data-agent-entity={`chat:${messageId}`}
                  className={cn(isNewlyAppended && ASSISTANT_ENTER_CLASS, searchHighlightClass)}
                >
                  {content}
                </div>
              );
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
          ref={setLogElement}
          role="log"
          aria-live="off"
          style={{
            height: `${virtualizer.getTotalSize() + inputOverlapPx}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const messageId = messageOrder[virtualRow.index];
            if (!messageId) return null;

            const isUserMessage = store.getState().getMessage(messageId)?.role === 'user';
            const isSearchMatch = searchMatchSet.has(messageId);
            const isActiveSearchMatch = activeSearchMessageId === messageId;
            const searchHighlightClass = isActiveSearchMatch
              ? 'rounded-[var(--chat-radius-md)] bg-primary/5 ring-2 ring-primary/45'
              : isSearchMatch
                ? 'rounded-[var(--chat-radius-md)] ring-1 ring-primary/20'
                : undefined;
            const isNewlyAppended = virtualRow.index >= initialMessageCountRef.current;

            return (
              <div
                key={messageId}
                data-index={virtualRow.index}
                data-chat-message-id={messageId}
                data-search-match={isSearchMatch ? 'true' : undefined}
                data-search-active={isActiveSearchMatch ? 'true' : undefined}
                // A45-5：ACR 实体锚点（agentFlash 定位演出用）
                data-agent-entity={`chat:${messageId}`}
                className={searchHighlightClass}
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
                    initial={isNewlyAppended && !prefersReducedMotion ? 'initial' : false}
                    animate="animate"
                  >
                    <MessageItem
                      messageId={messageId}
                      store={store}
                      searchQuery={searchQuery}
                      isFirst={virtualRow.index === 0}
                      isLatest={virtualRow.index === messageOrder.length - 1}
                    />
                  </motion.div>
                ) : (
                  // P1-7: 新追加的助手消息轻量入场（与直渲模式一致，复用 chat-msg-enter）；
                  // keyframes 只碰 opacity + 独立 translate，与外层虚拟行的
                  // inline transform 定位互不冲突
                  <div className={cn(isNewlyAppended && ASSISTANT_ENTER_CLASS)}>
                    <MessageItem
                      messageId={messageId}
                      store={store}
                      searchQuery={searchQuery}
                      isFirst={virtualRow.index === 0}
                      isLatest={virtualRow.index === messageOrder.length - 1}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CustomScrollArea>
    {/* 回到底部浮动按钮（P0-4: 键盘/输入栏遮挡时整体上抬，始终锚定在输入栏上沿） */}
    <div
      className="pointer-events-none absolute inset-x-0 bottom-2 px-4 md:bottom-3 md:px-8"
      style={{
        zIndex: Z_INDEX.inputBar - 10,
        transform: inputOverlapPx > 0 ? `translateY(-${inputOverlapPx}px)` : undefined,
      }}
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
          {/* P1-8: 视觉 40px、透明伪元素扩大命中区到 ≥44px 触控目标 */}
          <button
            type="button"
            onClick={handleScrollToBottomClick}
            title={scrollToBottomLabel}
            data-slot="message-list-scroll-to-bottom"
            tabIndex={showScrollToBottom ? 0 : -1}
            className={cn(
              'pointer-events-auto ml-auto flex h-10 w-10 items-center justify-center rounded-full',
              'relative after:absolute after:-inset-1 after:rounded-full after:content-[\'\']',
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
            {/* P1-8: 滚离底部期间到达新消息的未读圆点 */}
            {hasUnseenNewMessages && (
              <span
                aria-hidden="true"
                data-slot="message-list-unseen-dot"
                className="absolute -right-px -top-px h-2.5 w-2.5 rounded-full border-2 border-[color:var(--button-utility-surface)] bg-primary"
              />
            )}
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
