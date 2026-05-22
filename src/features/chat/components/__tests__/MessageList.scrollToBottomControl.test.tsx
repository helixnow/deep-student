import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '@/features/chat/core/types';

let mockMessageOrder = ['message-1'];
let mockSessionStatus = 'idle';
let mockIsDataLoaded = true;
let latestViewport: HTMLDivElement | null = null;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; count?: number }) =>
      options?.defaultValue ?? _key,
  }),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    measure: vi.fn(),
    measureElement: vi.fn(),
  }),
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
  const store = {} as StoreApi<ChatStore>;
  return render(<MessageList store={store} />);
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

  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
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
    currentScrollTop = top;
    fireEvent.scroll(viewport);
  });

  Object.defineProperty(viewport, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });

  return {
    scrollTo,
    getScrollTop: () => currentScrollTop,
  };
}

describe('MessageList scroll-to-bottom control', () => {
  beforeEach(() => {
    mockMessageOrder = ['message-1'];
    mockSessionStatus = 'idle';
    mockIsDataLoaded = true;
    latestViewport = null;
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
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
    expect(getScrollTop()).toBe(1000);
    expect(animatedContainer).toHaveAttribute('data-open', 'false');
    expect(animatedContainer).toHaveAttribute('aria-hidden', 'true');

    await waitFor(() => {
      expect(screen.getByRole('button', { hidden: true, name: 'Scroll to bottom' })).toHaveAttribute('tabindex', '-1');
    });
  });
});
