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
      currentScrollTop = value;
    },
  });

  const scrollTo = vi.fn(({ top }: { top: number }) => {
    currentScrollTop = Math.max(0, Math.min(top, currentScrollHeight - clientHeight));
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

  it('keeps the final message above the bottom fade', () => {
    renderMessageList();

    expect(screen.getByRole('log')).toHaveStyle({ paddingBottom: '32px' });
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

  it('smooth-scrolls to the latest message and fades the control into its closed state after click', async () => {
    renderMessageList();

    const viewport = requireViewport();
    const { scrollTo, getScrollTop } = configureViewportMetrics(viewport, { scrollTop: 240 });

    fireEvent.scroll(viewport);

    const button = await screen.findByRole('button', { name: 'Scroll to bottom' });
    const animatedContainer = button.parentElement;

    fireEvent.click(button);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(getScrollTop()).toBe(600);
    expect(animatedContainer).toHaveAttribute('data-open', 'false');
    expect(animatedContainer).toHaveAttribute('aria-hidden', 'true');

    await waitFor(() => {
      expect(screen.getByRole('button', { hidden: true, name: 'Scroll to bottom' })).toHaveAttribute('tabindex', '-1');
    });
  });

  it('keeps following streamed growth after the user clicks back to bottom', async () => {
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frameCallbacks.delete(id);
    });
    const flushFrame = () => {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      callbacks.forEach((callback) => callback(0));
    };

    mockSessionStatus = 'streaming';
    renderMessageList();
    const viewport = requireViewport();
    const metrics = configureViewportMetrics(viewport, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });

    flushFrame();
    metrics.setScrollHeight(1120);
    resizeObserverCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    flushFrame();
    expect(metrics.getScrollTop()).toBe(720);

    // 明确的指针滚动才会暂停跟随；单纯内容重排产生的 scroll 事件不会。
    fireEvent.scroll(viewport);
    fireEvent.pointerDown(viewport);
    metrics.setScrollTop(400);
    fireEvent.scroll(viewport);
    fireEvent.pointerUp(window);

    const button = await screen.findByRole('button', { name: 'Scroll to bottom' });
    fireEvent.click(button);
    expect(metrics.getScrollTop()).toBe(720);

    metrics.setScrollHeight(1220);
    resizeObserverCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    flushFrame();
    expect(metrics.getScrollTop()).toBe(820);
  });

  it('preserves the visible anchor offset when history is inserted at the head', () => {
    mockMessageOrder = ['a', 'b', 'c', 'd'];
    const { rerender, store } = renderMessageList();
    const viewport = requireViewport();
    const { getScrollTop } = configureViewportMetrics(viewport, {
      scrollHeight: 400,
      clientHeight: 300,
      scrollTop: 150,
    });
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

    mockMessageOrder = ['old', 'a', 'b', 'c', 'd'];
    rerender(<MessageList store={store} className="history-updated" />);

    expect(getScrollTop()).toBe(250);
  });

  it('preserves the visible anchor offset for a middle insertion above the viewport', () => {
    mockMessageOrder = ['a', 'b', 'c', 'd', 'e'];
    const { rerender, store } = renderMessageList();
    const viewport = requireViewport();
    const { getScrollTop } = configureViewportMetrics(viewport, {
      scrollHeight: 500,
      clientHeight: 300,
      scrollTop: 250,
    });
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

    mockMessageOrder = ['a', 'b', 'middle-history', 'c', 'd', 'e'];
    rerender(<MessageList store={store} className="history-updated" />);

    expect(getScrollTop()).toBe(350);
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
