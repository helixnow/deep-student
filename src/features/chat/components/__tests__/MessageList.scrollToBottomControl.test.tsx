import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '@/features/chat/core/types';

let mockMessageOrder = ['message-1'];
let mockSessionStatus = 'idle';
let mockIsDataLoaded = true;
let latestViewport: HTMLDivElement | null = null;
let latestVirtualizerOptions: any = null;
let resizeObserverCallbacks: ResizeObserverCallback[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; count?: number }) => {
      // 断言依赖的可见文案（真实文案在 i18n 资源里，这里给出稳定桩值）
      if (_key === 'messageList.scrollToBottom') return 'Scroll to bottom';
      return options?.defaultValue ?? _key;
    },
  }),
  // MessageItem 经 fileManager/errorUtils 传递引入 src/i18n.ts，需要 initReactI18next 桩
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: any) => {
    latestVirtualizerOptions = options;
    return {
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      measure: vi.fn(),
      measureElement: vi.fn(),
    };
  },
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: React.forwardRef(function MockCustomScrollArea(
    {
      children,
      className,
      viewportClassName,
      viewportRef,
    }: {
      children: React.ReactNode;
      className?: string;
      viewportClassName?: string;
      viewportRef?: React.Ref<HTMLDivElement>;
    },
    ref: React.ForwardedRef<HTMLDivElement>
  ) {
    const hostRef = React.useRef<HTMLDivElement>(null);
    const viewportInnerRef = React.useRef<HTMLDivElement>(null);

    React.useImperativeHandle(ref, () => hostRef.current as HTMLDivElement);

    React.useEffect(() => {
      latestViewport = viewportInnerRef.current;

      if (typeof viewportRef === 'function') {
        viewportRef(viewportInnerRef.current);
      } else if (viewportRef && 'current' in viewportRef) {
        viewportRef.current = viewportInnerRef.current;
      }

      return () => {
        latestViewport = null;
        if (typeof viewportRef === 'function') {
          viewportRef(null);
        } else if (viewportRef && 'current' in viewportRef) {
          viewportRef.current = null;
        }
      };
    }, [viewportRef]);

    return (
      <div ref={hostRef} className={className}>
        <div ref={viewportInnerRef} className={viewportClassName}>
          {children}
        </div>
      </div>
    );
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({
    isSmallScreen: false,
  }),
}));

vi.mock('@/features/chat/hooks/useChatStore', () => ({
  useMessageOrder: () => mockMessageOrder,
  useSessionStatus: () => mockSessionStatus,
  useIsDataLoaded: () => mockIsDataLoaded,
}));

vi.mock('@/features/chat/debug/sessionSwitchPerf', () => ({
  sessionSwitchPerf: {
    mark: vi.fn(),
    endTrace: vi.fn(),
  },
}));

vi.mock('@/features/chat/components/MessageItem', () => ({
  MessageItem: ({ messageId }: { messageId: string }) => (
    <div data-testid={`message-${messageId}`}>{messageId}</div>
  ),
}));

vi.mock('@/features/chat/components/ui/ThreadEmptyStateShell', () => ({
  ThreadEmptyStateShell: ({ title }: { title: string }) => <div>{title}</div>,
}));

import { MessageList } from '@/features/chat/components/MessageList';

function renderMessageList() {
  const store = {
    getState: () => ({
      getMessage: (messageId: string) => ({
        id: messageId,
        role: 'assistant',
      }),
    }),
    subscribe: vi.fn(() => vi.fn()),
    setState: vi.fn(),
    destroy: vi.fn(),
  } as unknown as StoreApi<ChatStore>;
  return {
    ...render(<MessageList store={store} />),
    store,
  };
}

function requireViewport() {
  if (!latestViewport) {
    throw new Error('Viewport was not mounted');
  }
  return latestViewport;
}

function configureViewportMetrics(
  viewport: HTMLDivElement,
  {
    scrollHeight = 1000,
    clientHeight = 400,
    scrollTop = 200,
  }: {
    scrollHeight?: number;
    clientHeight?: number;
    scrollTop?: number;
  } = {}
) {
  let currentScrollTop = scrollTop;
  let currentScrollHeight = scrollHeight;
  const floor = () => Math.max(0, currentScrollHeight - clientHeight);

  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => currentScrollHeight,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      // 浏览器行为：程序化写入 clamp 到 [0, floor]
      currentScrollTop = Math.max(0, Math.min(value, floor()));
    },
  });

  const scrollTo = vi.fn(({ top }: { top: number }) => {
    currentScrollTop = Math.max(0, Math.min(top, floor()));
    fireEvent.scroll(viewport);
  });

  Object.defineProperty(viewport, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });

  return {
    scrollTo,
    getScrollTop: () => currentScrollTop,
    setScrollTop: (value: number) => {
      currentScrollTop = value;
    },
    setScrollHeight: (value: number) => {
      currentScrollHeight = value;
    },
  };
}

/** 触发所有已注册的 ResizeObserver（模拟 [role="log"] 内容增长/收缩） */
function fireResizeObservers() {
  resizeObserverCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
}

describe('MessageList scroll-to-bottom control', () => {
  beforeEach(() => {
    mockMessageOrder = ['message-1'];
    mockSessionStatus = 'idle';
    mockIsDataLoaded = true;
    latestViewport = null;
    latestVirtualizerOptions = null;
    resizeObserverCallbacks = [];
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not reserve space for the removed bottom fade', () => {
    renderMessageList();

    expect(screen.getByRole('log')).toHaveStyle({ paddingBottom: '0px' });
  });

  it('shows an icon-only scroll-to-bottom control whenever the thread is away from the bottom', async () => {
    renderMessageList();

    const viewport = requireViewport();
    configureViewportMetrics(viewport, { scrollTop: 220 });

    fireEvent.scroll(viewport);

    const button = await screen.findByRole('button', { name: 'Scroll to bottom' });
    expect(button).toBeInTheDocument();
    expect(button.querySelector('span')).toBeNull();
    expect(screen.queryByText('新内容')).not.toBeInTheDocument();

    const animatedContainer = button.parentElement;
    expect(animatedContainer).toHaveAttribute('data-open', 'true');
    expect(animatedContainer).toHaveAttribute('aria-hidden', 'false');
  });

  it('jumps instantly to the latest message and fades the control into its closed state after click', async () => {
    renderMessageList();

    const viewport = requireViewport();
    const { scrollTo, getScrollTop } = configureViewportMetrics(viewport, { scrollTop: 240 });

    fireEvent.scroll(viewport);

    const button = await screen.findByRole('button', { name: 'Scroll to bottom' });
    const animatedContainer = button.parentElement;

    fireEvent.click(button);

    // 瞬时定位（deepseek/opencode 同款）：不走 scrollTo({behavior:'smooth'})，
    // 直接写 scrollTop（浏览器 clamp 到 floor = 1000-400 = 600）
    expect(scrollTo).not.toHaveBeenCalled();
    expect(getScrollTop()).toBe(600);
    expect(animatedContainer).toHaveAttribute('data-open', 'false');
    expect(animatedContainer).toHaveAttribute('aria-hidden', 'true');

    await waitFor(() => {
      expect(screen.getByRole('button', { hidden: true, name: 'Scroll to bottom' })).toHaveAttribute('tabindex', '-1');
    });
  });

  it('keeps following streamed growth, breaks on any reader scroll, and resumes after click back to bottom', async () => {
    mockSessionStatus = 'streaming';
    renderMessageList();
    const viewport = requireViewport();
    const metrics = configureViewportMetrics(viewport, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });

    // 内容增长：ResizeObserver 同帧跟随（无 rAF 循环）
    metrics.setScrollHeight(1120);
    fireResizeObservers();
    expect(metrics.getScrollTop()).toBe(720);

    // 读者滚动（滚动条拖拽/触控板/键盘——任何设备）：仅 scroll 事件偏离账本即解除跟随，
    // 不再需要 pointerdown 等意图监听（修复流式期间拖滚动条被拽回的问题）
    metrics.setScrollTop(400);
    fireEvent.scroll(viewport);
    await screen.findByRole('button', { name: 'Scroll to bottom' });

    // 跟随已解除：内容继续增长不再拽回
    metrics.setScrollHeight(1220);
    fireResizeObservers();
    expect(metrics.getScrollTop()).toBe(400);

    // 回到底部：瞬时定位并恢复跟随
    const button = screen.getByRole('button', { name: 'Scroll to bottom' });
    fireEvent.click(button);
    expect(metrics.getScrollTop()).toBe(820);

    metrics.setScrollHeight(1320);
    fireResizeObservers();
    expect(metrics.getScrollTop()).toBe(920);
  });

  it('does not break follow when browser clamps scrollTop after content shrink', async () => {
    mockSessionStatus = 'streaming';
    renderMessageList();
    const viewport = requireViewport();
    const metrics = configureViewportMetrics(viewport, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });

    metrics.setScrollHeight(1120);
    fireResizeObservers();
    expect(metrics.getScrollTop()).toBe(720);

    // 上方内容收缩（思维链折叠）：浏览器把 scrollTop clamp 到新 floor（720 → 500）。
    // clamp 恰好落在 min(observedTop, floor) 上 → 不算读者滚动 → 跟随保持
    metrics.setScrollHeight(900);
    metrics.setScrollTop(500);
    fireEvent.scroll(viewport);

    metrics.setScrollHeight(1000);
    fireResizeObservers();
    expect(metrics.getScrollTop()).toBe(600);
  });

  it('still breaks follow when a real reader scroll rides along with a shrink clamp', async () => {
    mockSessionStatus = 'streaming';
    renderMessageList();
    const viewport = requireViewport();
    const metrics = configureViewportMetrics(viewport, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });

    metrics.setScrollHeight(1120);
    fireResizeObservers();
    expect(metrics.getScrollTop()).toBe(720);

    // 收缩 clamp（720→500）叠加真实上滚（500→400）：
    // 偏离账本 100px > 0.5 → 读者移动 → 解除跟随（旧 shrink 启发式会误吞这次上滚）
    metrics.setScrollHeight(900);
    metrics.setScrollTop(400);
    fireEvent.scroll(viewport);
    await screen.findByRole('button', { name: 'Scroll to bottom' });

    metrics.setScrollHeight(1000);
    fireResizeObservers();
    expect(metrics.getScrollTop()).toBe(400);
  });

  it('preserves the visible anchor offset when history is inserted at the head', () => {
    mockMessageOrder = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const { rerender, store } = renderMessageList();
    const viewport = requireViewport();
    const { getScrollTop } = configureViewportMetrics(viewport, {
      scrollHeight: 800,
      clientHeight: 300,
      scrollTop: 200,
    });
    // 产生该滚动位置的读者滚动事件，让账本分类器结算为"阅读中"（非吸底）
    fireEvent.scroll(viewport);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this === viewport) {
        return { top: 0, bottom: 300, left: 0, right: 600, width: 600, height: 300, x: 0, y: 0, toJSON() {} } as DOMRect;
      }
      if (this instanceof HTMLElement && this.dataset.chatMessageId) {
        const siblings = Array.from(this.parentElement?.children ?? []);
        const top = siblings.indexOf(this) * 100 - viewport.scrollTop;
        return { top, bottom: top + 100, left: 0, right: 600, width: 600, height: 100, x: 0, y: top, toJSON() {} } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });

    mockMessageOrder = ['old', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    rerender(<MessageList store={store} className="history-updated" />);

    // 锚点 'c'（首个可见行）下移 100px → 补偿 scrollTop 200 → 300，且不触发吸底跟随
    expect(getScrollTop()).toBe(300);
  });

  it('preserves the visible anchor offset for a middle insertion above the viewport', () => {
    mockMessageOrder = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const { rerender, store } = renderMessageList();
    const viewport = requireViewport();
    const { getScrollTop } = configureViewportMetrics(viewport, {
      scrollHeight: 800,
      clientHeight: 300,
      scrollTop: 200,
    });
    fireEvent.scroll(viewport);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this === viewport) {
        return { top: 0, bottom: 300, left: 0, right: 600, width: 600, height: 300, x: 0, y: 0, toJSON() {} } as DOMRect;
      }
      if (this instanceof HTMLElement && this.dataset.chatMessageId) {
        const siblings = Array.from(this.parentElement?.children ?? []);
        const top = siblings.indexOf(this) * 100 - viewport.scrollTop;
        return { top, bottom: top + 100, left: 0, right: 600, width: 600, height: 100, x: 0, y: top, toJSON() {} } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });

    mockMessageOrder = ['a', 'b', 'middle-history', 'c', 'd', 'e', 'f', 'g', 'h'];
    rerender(<MessageList store={store} className="history-updated" />);

    expect(getScrollTop()).toBe(300);
  });

  it('gates entry animation: history insertion does not animate the existing tail, append does', () => {
    mockMessageOrder = ['a', 'b', 'c', 'd'];
    const { rerender, store, container } = renderMessageList();

    // 初始挂载：无入场动画
    expect(container.querySelectorAll('.chat-msg-enter')).toHaveLength(0);

    // 头部历史插入：既有消息（含末条）不得播放入场动画——
    // initialMessageCount 必须在 render 阶段同步累加（由 previousOrder !==
    // messageOrder + prevMessageOrderRef 写回保证 StrictMode 下恰好一次），
    // 否则本次 render 读到旧计数，末条消息会被误判为新增而播放动画
    mockMessageOrder = ['old', 'a', 'b', 'c', 'd'];
    rerender(<MessageList store={store} className="history-updated" />);
    expect(container.querySelectorAll('.chat-msg-enter')).toHaveLength(0);

    // 尾部追加：仅新消息播放入场动画
    mockMessageOrder = ['old', 'a', 'b', 'c', 'd', 'e'];
    rerender(<MessageList store={store} className="appended" />);
    expect(container.querySelectorAll('.chat-msg-enter')).toHaveLength(1);
  });

  it('keys virtualized measurements by message ID across head insertion', () => {
    const originalOrder = Array.from({ length: 81 }, (_, index) => `message-${index}`);
    mockMessageOrder = originalOrder;
    const { rerender, store } = renderMessageList();

    expect(latestVirtualizerOptions.getItemKey(40)).toBe('message-40');

    mockMessageOrder = ['history-message', ...originalOrder];
    rerender(<MessageList store={store} className="history-updated" />);

    expect(latestVirtualizerOptions.getItemKey(0)).toBe('history-message');
    expect(latestVirtualizerOptions.getItemKey(41)).toBe('message-40');
  });
});
