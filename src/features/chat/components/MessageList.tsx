/**
 * Chat V2 - MessageList 消息列表组件
 *
 * 职责：虚拟滚动，订阅 messageOrder，渲染 MessageItem
 * 
 * 🚀 P1 优化（冷启动与虚拟化）：
 * 1. 首帧直接渲染少量可见项，不初始化虚拟化
 * 2. 虚拟化延迟初始化（requestIdleCallback）
 * 3. 首帧禁用 measureElement，滚动稳定后开启
 * 4. 滚动逻辑简化：rAF + 条件触发
 * 5. 移除 flushSync，异步状态更新
 */

import React, { useRef, useEffect, useCallback, memo, useMemo, useState } from 'react';
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

/** 首帧直接渲染的消息数量（不使用虚拟化） */
const INITIAL_RENDER_COUNT = 10;

/** 虚拟化初始化延迟（ms）- 使用 requestIdleCallback 或 setTimeout */
const VIRTUALIZER_INIT_DELAY = 50;

/** 默认估算消息高度（设置为合理值，测量会覆盖）*/
const DEFAULT_ESTIMATED_ITEM_SIZE = 120;
/** 超过该数量后启用虚拟滚动，避免长会话全量渲染 */
const VIRTUALIZATION_THRESHOLD = 80;

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
  /** 过滤空消息 */
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
  const viewportCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      // 异步设置 viewport，不阻塞首帧渲染
      setViewportElement(node);
    }
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

  // 🚀 性能优化：使用 useMemo 计算 scrollAreaKey
  // 当 store 变化时，key 变化，CustomScrollArea 重新挂载，callback ref 被调用
  const scrollAreaKey = useMemo(() => Math.random(), [store]);

  // 当 store 变化时（切换会话），重置标记和状态
  const storeChanged = lastStoreRef.current !== store;
  if (storeChanged) {
    hasMarkedFirstRenderRef.current = false;
    hasMarkedFirstRenderScheduledRef.current = false;
    lastStoreRef.current = store;
  }

  // 是否正在流式生成
  const isStreaming = sessionStatus === 'streaming';
  // 超长会话启用虚拟滚动，短会话保持直接渲染以降低复杂度
  const useDirectRender = messageOrder.length <= VIRTUALIZATION_THRESHOLD;

  const virtualRowCount = messageOrder.length;

  // 🚀 虚拟化延迟初始化
  useEffect(() => {
    if (!viewportElement) return;

    const timeoutId = setTimeout(() => {
      setVirtualizerReady(true);
      sessionSwitchPerf.mark('ml_virtualizer_ready', { delayed: true });
    }, VIRTUALIZER_INIT_DELAY);

    return () => clearTimeout(timeoutId);
  }, [viewportElement]);

  // 虚拟化初始化耗时记录
  const hasLoggedVirtualizerRef = useRef(false);
  const virtualizerInitStart = performance.now();

  // 虚拟滚动配置
  const virtualizer = useVirtualizer({
    count: virtualizerReady && !useDirectRender ? virtualRowCount : 0,
    getScrollElement: () => viewportElement,
    estimateSize: () => estimatedItemSize,
    overscan,
    // 🔧 修复消息重叠：始终启用测量，不再延迟
    // 延迟测量会导致虚拟化器使用估算高度定位消息，造成重叠
    measureElement: (element) => element?.getBoundingClientRect().height ?? estimatedItemSize,
  });

  if (!hasLoggedVirtualizerRef.current && virtualizerReady) {
    const virtualizerInitMs = performance.now() - virtualizerInitStart;
    sessionSwitchPerf.mark('ml_virtualizer_done', {
      ms: virtualizerInitMs,
      messageCount: messageOrder.length,
    });
    hasLoggedVirtualizerRef.current = true;
  }

  // 🚀 虚拟化就绪后强制测量一次
  useEffect(() => {
    if (virtualizerReady && !useDirectRender) {
      requestAnimationFrame(() => {
        virtualizer.measure();
      });
    }
  }, [useDirectRender, virtualizerReady, virtualizer]);

  // 动态内容（公式/代码块/图片）会改变高度，切到虚拟模式后按帧重测可避免重叠
  useEffect(() => {
    if (useDirectRender || !virtualizerReady) return;
    const rafId = requestAnimationFrame(() => {
      virtualizer.measure();
    });
    return () => cancelAnimationFrame(rafId);
  }, [useDirectRender, virtualizerReady, virtualRowCount, isStreaming, virtualizer]);

  // 🔧 优化：使用 ref 追踪上一次消息数量和滚动状态
  const prevMessageCountRef = useRef(messageOrder.length);
  const isAutoScrollingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const programmaticScrollLockRef = useRef(false);
  const programmaticScrollUnlockTimerRef = useRef<number | null>(null);

  // 🔧 用户滚动意图检测：根据实际滚动位置决定是否保持吸底跟随
  const userHasScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  /** 检查当前是否在底部附近（阈值 50px，ChatGPT/Claude 同级灵敏度） */
  const isNearBottom = useCallback(() => {
    if (!viewportElement) return true;
    const { scrollTop, scrollHeight, clientHeight } = viewportElement;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, [viewportElement]);

  const scheduleProgrammaticScrollUnlock = useCallback((delayMs: number) => {
    if (programmaticScrollUnlockTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollUnlockTimerRef.current);
    }
    programmaticScrollUnlockTimerRef.current = window.setTimeout(() => {
      programmaticScrollLockRef.current = false;
      programmaticScrollUnlockTimerRef.current = null;
    }, delayMs);
  }, []);

  // 滚动到底部
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!viewportElement) return;

    const top = viewportElement.scrollHeight;
    const shouldLock = behavior === 'smooth';

    if (shouldLock) {
      programmaticScrollLockRef.current = true;
    }

    if (typeof viewportElement.scrollTo === 'function') {
      viewportElement.scrollTo({ top, behavior });
    } else {
      viewportElement.scrollTop = top;
    }

    if (shouldLock) {
      scheduleProgrammaticScrollUnlock(250);
    }
  }, [scheduleProgrammaticScrollUnlock, viewportElement]);

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

    const syncScrollState = () => {
      if (programmaticScrollLockRef.current) return;

      const nearBottom = isNearBottom();
      userHasScrolledRef.current = !nearBottom;
      setShowScrollToBottom(!nearBottom);
    };

    syncScrollState();
    viewportElement.addEventListener('scroll', syncScrollState, { passive: true });

    return () => {
      viewportElement.removeEventListener('scroll', syncScrollState);
    };
  }, [viewportElement, isNearBottom]);

  useEffect(() => {
    return () => {
      if (programmaticScrollUnlockTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollUnlockTimerRef.current);
      }
    };
  }, []);

  // 🖱️ 平滑滚轮惯性 + 第一时间检测向上滚动意图（ChatGPT/Claude 同级手感）
  useSmoothWheel(containerRef.current, {
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

  // 新消息定位：用户发送新消息时，以该消息在顶部开始（ChatGPT/Claude 同级体验）
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
      requestAnimationFrame(() => {
        if (!viewportElement) return;
        // 程序化滚动锁：防止 scrollIntoView 触发的原生 scroll 事件
        // 被 syncScrollState 误判为"用户滚动"，从而错误地阻断 rAF 自动跟随
        programmaticScrollLockRef.current = true;
        scheduleProgrammaticScrollUnlock(300);
        if (useDirectRender) {
          // viewportElement.lastElementChild 是 div[role="log"] 包装元素
          // 其内部 children 按 messageOrder 排列，末尾两条是 [用户消息, 助手占位]
          // 需要定位到倒数第二条（用户消息）使其在视口顶部
          const logDiv = viewportElement.lastElementChild as HTMLElement | null;
          const messageItems = logDiv?.children;
          if (messageItems && messageItems.length >= 2) {
            const userMessageEl = messageItems[messageItems.length - 2] as HTMLElement;
            userMessageEl.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
            return;
          }
        }
        // 虚拟模式下用 scrollToIndex 定位用户消息（倒数第二条）
        if (messageOrder.length >= 2) {
          virtualizer.scrollToIndex(messageOrder.length - 2, { align: 'start', behavior: 'auto' });
          return;
        }
        scrollToBottom();
      });
      return;
    }

    // 流式结束 → 确保停在底部
    if (!isStreaming && wasStreaming) {
      if (!userHasScrolledRef.current) {
        requestAnimationFrame(() => { scrollToBottom(); });
      }
    }
  }, [isStreaming, viewportElement, scrollToBottom]);

  // 非流式期间新消息到达时滚动到底部（如加载历史记录）
  useEffect(() => {
    if (messageOrder.length > prevMessageCountRef.current) {
      if (!isStreaming && !userHasScrolledRef.current) {
        requestAnimationFrame(() => { scrollToBottom(); });
      }
    }
    prevMessageCountRef.current = messageOrder.length;
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
      key={scrollAreaKey}
      ref={containerRef}
      viewportRef={viewportCallbackRef}
      className={cn('h-full', className)}
      viewportClassName="scroll-smooth"
      viewportProps={{
        // 无需底部 padding，布局已分离
      }}
      hideTrackWhenIdle
    >
      {useDirectRender ? (
        // 直接渲染模式(禁用虚拟化)
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          style={{ width: '100%' }}
        >
          <AnimatePresence>
            {messageOrder.map((messageId, messageIndex) => {
              const isUserMessage = store.getState().getMessage(messageId)?.role === 'user';
              const content = (
                <MessageItem
                  messageId={messageId}
                  store={store}
                  isFirst={messageIndex === 0}
                />
              );
              if (isUserMessage) {
                return (
                  <motion.div
                    key={messageId}
                    variants={newMessageVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {content}
                  </motion.div>
                );
              }
              return <div key={messageId}>{content}</div>;
            })}
          </AnimatePresence>
        </div>
      ) : (
        // 虚拟滚动模式
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
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
                    initial="initial"
                    animate="animate"
                  >
                    <MessageItem
                      messageId={messageId}
                      store={store}
                      isFirst={virtualRow.index === 0}
                    />
                  </motion.div>
                ) : (
                  <MessageItem
                    messageId={messageId}
                    store={store}
                    isFirst={virtualRow.index === 0}
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
            ['--panel-open-dur' as string]: '180ms',
            ['--panel-close-dur' as string]: '140ms',
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
