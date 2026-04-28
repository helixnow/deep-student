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
import { cn } from '@/utils/cn';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MessageItem } from './MessageItem';
import { useMessageOrder, useSessionStatus, useIsDataLoaded } from '../hooks/useChatStore';
import type { ChatStore } from '../core/types';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { useBreakpoint } from '@/hooks/useBreakpoint';

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
    count: virtualizerReady && !useDirectRender ? messageOrder.length : 0,
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
  }, [useDirectRender, virtualizerReady, messageOrder.length, isStreaming, virtualizer]);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (viewportElement) {
      viewportElement.scrollTop = viewportElement.scrollHeight;
    }
  }, [viewportElement]);

  // 🔧 优化：使用 ref 追踪上一次消息数量和滚动状态
  const prevMessageCountRef = useRef(messageOrder.length);
  const isAutoScrollingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);

  // 🔧 用户滚动意图检测：通过 wheel/touch 事件判断用户是否主动滚动
  // 避免仅靠距离阈值判断导致的"拔河"问题
  const userHasScrolledRef = useRef(false);

  /** 检查当前是否在底部附近（阈值 150px） */
  const isNearBottom = useCallback(() => {
    if (!viewportElement) return true;
    const { scrollTop, scrollHeight, clientHeight } = viewportElement;
    return scrollHeight - scrollTop - clientHeight < 150;
  }, [viewportElement]);

  // 监听用户主动滚动事件（wheel / touchmove），设置 userHasScrolled 标志
  useEffect(() => {
    if (!viewportElement) return;

    const handleUserScroll = () => {
      // 用户主动滚动且不在底部附近 → 标记为用户已接管滚动
      if (!isNearBottom()) {
        userHasScrolledRef.current = true;
      }
    };

    // wheel 和 touchmove 是用户主动发起的滚动行为
    viewportElement.addEventListener('wheel', handleUserScroll, { passive: true });
    viewportElement.addEventListener('touchmove', handleUserScroll, { passive: true });

    return () => {
      viewportElement.removeEventListener('wheel', handleUserScroll);
      viewportElement.removeEventListener('touchmove', handleUserScroll);
    };
  }, [viewportElement, isNearBottom]);

  // 🚀 P1优化：流式生成时使用 rAF 自动滚动（替代 setInterval）
  useEffect(() => {
    if (!isStreaming || !viewportElement) {
      isAutoScrollingRef.current = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      // 流式结束后重置用户滚动标志，下次流式重新开始跟随
      if (!isStreaming) {
        userHasScrolledRef.current = false;
      }
      return;
    }

    isAutoScrollingRef.current = true;

    // 使用 rAF 循环，仅在流式时执行
    const scrollLoop = () => {
      if (!isAutoScrollingRef.current) return;

      // 用户已主动滚离底部 → 停止自动滚动，尊重用户意图
      if (userHasScrolledRef.current) {
        rafIdRef.current = requestAnimationFrame(scrollLoop);
        return;
      }

      // 用户未主动滚动，检查是否在底部附近
      if (isNearBottom()) {
        viewportElement.scrollTop = viewportElement.scrollHeight;
      } else {
        // 被程序以外的原因滚离（如内容高度突变），也标记为脱离
        userHasScrolledRef.current = true;
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
  }, [isStreaming, viewportElement, isNearBottom]);

  // 新消息时滚动到底部（只在用户仍在底部附近时触发，避免打断阅读）
  useEffect(() => {
    if (messageOrder.length > prevMessageCountRef.current) {
      // 仅在用户没有主动滚离底部时才自动滚动
      if (!userHasScrolledRef.current && isNearBottom()) {
        requestAnimationFrame(() => {
          scrollToBottom();
        });
      }
    }
    prevMessageCountRef.current = messageOrder.length;
  }, [messageOrder.length, scrollToBottom, isNearBottom]);

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
          <div className="mx-auto flex min-h-full w-full max-w-[44rem] items-center">
            <section
              data-slot="thread-empty-state"
              className={cn(
                'flex w-full flex-col items-center justify-center gap-4 text-center',
                isSmallScreen ? 'py-10' : 'py-16'
              )}
            >
              <h2
                data-slot="thread-empty-primary-action"
                className="text-balance text-xl font-medium text-foreground"
              >
                {emptyStatePrimaryAction}
              </h2>
            </section>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
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
          {messageOrder.map((messageId, index) => (
            <MessageItem
              key={messageId}
              messageId={messageId}
              store={store}
              isFirst={index === 0}
            />
          ))}
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
                <MessageItem
                  messageId={messageId}
                  store={store}
                  isFirst={virtualRow.index === 0}
                />
              </div>
            );
          })}
        </div>
      )}
    </CustomScrollArea>
    </>
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
