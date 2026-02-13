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
import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
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
    const scrollLoop = () => {
      if (!isAutoScrollingRef.current) return;

      // 检查是否需要滚动（用户可能手动滚动到其他位置）
      const { scrollTop, scrollHeight, clientHeight } = viewportElement;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;

      if (isNearBottom) {
        viewportElement.scrollTop = scrollHeight;
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

  // 新消息时滚动到底部（只在消息数量变化时触发）
  useEffect(() => {
    if (messageOrder.length > prevMessageCountRef.current) {
      // 新消息添加，滚动到底部
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
    prevMessageCountRef.current = messageOrder.length;
  }, [messageOrder.length, scrollToBottom]);

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
    const allSuggestions = [
      { text: t('messageList.empty.suggestion1'), mobileOnly: false, desktopOnly: true },
      { text: t('messageList.empty.suggestion2'), mobileOnly: false, desktopOnly: false },
      { text: t('messageList.empty.suggestion3'), mobileOnly: false, desktopOnly: false },
      { text: t('messageList.empty.suggestion4'), mobileOnly: false, desktopOnly: false },
      { text: t('messageList.empty.suggestion5'), mobileOnly: false, desktopOnly: false },
    ];
    const suggestions = allSuggestions.filter(s => isSmallScreen ? !s.desktopOnly : !s.mobileOnly);

    return (
      <div
        className={cn(
          'relative h-full w-full',
          'text-muted-foreground',
          className
        )}
      >
        {/* 居中内容区域 - 绝对定位，微调垂直位置以达到视觉居中 (top-[55%]) */}
        <div
          className="absolute left-1/2 top-[55%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center w-full max-w-2xl px-6 md:px-0"
        >
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="flex flex-col items-center mb-8 md:mb-12 relative text-center"
          >
            {/* 品牌标题 - 移动端自适应字号 */}
            <h1 className="relative text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-3 md:mb-4 bg-gradient-to-b from-foreground via-foreground/90 to-muted-foreground/70 bg-clip-text text-transparent select-none drop-shadow-sm leading-tight">
              Deep Student
            </h1>

            {/* Slogan - 移动端调整字间距和字号 */}
            <p className="relative text-sm md:text-xl text-muted-foreground/80 font-normal tracking-[0.15em] md:tracking-[0.2em] uppercase px-4">
              {t('messageList.empty.slogan')}
            </p>
          </motion.div>

          {/* 快速提问建议 - 长列表排版 (图二风格) */}
          <div className="flex flex-col gap-0 md:gap-2 w-full relative z-10">
            {suggestions.map((suggestion, i) => (
              <motion.button
                key={i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 + i * 0.08, duration: 0.4 }}
                className="group relative flex items-center justify-between w-full p-3 md:p-4 text-left rounded-xl hover:bg-muted/30 dark:hover:bg-muted/10 border border-transparent hover:border-border/10 transition-all duration-200"
                onClick={() => {
                  store.getState().setInputValue(suggestion.text);
                }}
              >
                <span className="text-sm md:text-base text-muted-foreground/80 group-hover:text-foreground transition-colors line-clamp-2 pr-4">
                  {suggestion.text}
                </span>

                {/* 箭头图标 */}
                <ArrowUpRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-foreground group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all duration-300 flex-shrink-0" />

                {/* 底部细分割线 (除最后一个) */}
                {i !== suggestions.length - 1 && (
                  <div className="absolute bottom-0 left-4 right-4 h-px bg-border/5 group-hover:bg-transparent transition-colors" />
                )}
              </motion.button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
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
        <div style={{ width: '100%' }}>
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
    prevProps.estimatedItemSize === nextProps.estimatedItemSize &&
    prevProps.overscan === nextProps.overscan &&
    prevProps.forceEmptyPreview === nextProps.forceEmptyPreview
  );
});

export default MessageList;
