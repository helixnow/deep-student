import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('../renderers', () => ({
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/features/chat/components/ui/TextShimmer', () => ({
  TextShimmer: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

import { ActivityTimeline } from '../ActivityTimeline';
import type { Block } from '@/features/chat/core/types/block';

const zhChatV2 = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/chatV2.json'), 'utf-8')
) as {
  timeline: {
    thinking: {
      inProgress: string;
      completed: string;
      collapsed: string;
    };
  };
};

const enChatV2 = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/en-US/chatV2.json'), 'utf-8')
) as {
  timeline: {
    thinking: {
      completed: string;
      collapsed: string;
    };
  };
};

function createThinkingBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'thinking-1',
    type: 'thinking',
    status: 'success',
    messageId: 'message-1',
    content: '第一段思维链\n\n第二段思维链',
    startedAt: 1_000,
    endedAt: 9_000,
    ...overrides,
  };
}

function summaryRowOf(button: HTMLElement): HTMLElement | null {
  return button.parentElement;
}

/** jsdom 不做布局，scrollHeight/clientHeight 全为 0，滚动跟随只能靠桩件观测 */
function stubPeekScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight });
}

/** 收集 effect 内 rAF 回调里对 scrollTop 的写入（赋值本身即可观测） */
function scrollTopWrites(el: HTMLElement): number[] {
  const writes: number[] = [];
  let current = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => current,
    set: (value: number) => {
      current = value;
      writes.push(value);
    },
  });
  return writes;
}

/**
 * jsdom 不实现 Element.prototype.scrollTo，平滑跟随路径只能靠桩件观测。
 * 桩件刻意不真的滚动（scrollTop 保持不动），这样才能模拟「动画滑到一半」的状态。
 */
function stubSmoothScroll(el: HTMLElement) {
  const glides: Array<{ top: number; behavior?: ScrollBehavior }> = [];
  (el as unknown as { scrollTo: unknown }).scrollTo = (options: {
    top: number;
    behavior?: ScrollBehavior;
  }) => {
    glides.push(options);
  };
  return glides;
}

/** prefers-reduced-motion: reduce → 跟随退化为瞬时落位 */
function stubReducedMotion() {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

async function flushFrames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe('ActivityTimeline thinking summary', () => {
  it('uses distinct copy for the expanded and collapsed thinking states', () => {
    expect(zhChatV2.timeline.thinking.completed).toBe('已思考用时 {{seconds}} 秒');
    expect(zhChatV2.timeline.thinking.collapsed).toBe('已用时 {{seconds}} 秒');
    expect(enChatV2.timeline.thinking.completed).toBe('Thought for {{seconds}}s');
    expect(enChatV2.timeline.thinking.collapsed).toBe('Used {{seconds}}s');
  });

  it('renders completed thinking collapsed by default when auto-collapse is enabled', () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const button = screen.getByRole('button', { name: 'timeline.thinking.collapsed' });
    const summaryRow = summaryRowOf(button);

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('第一段思维链')).not.toBeInTheDocument();
    expect(summaryRow?.className).not.toContain('thinking-summary-row--pinned');
  });

  it('pins the summary row while the thinking chain is expanded', () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const collapsedButton = screen.getByRole('button', { name: 'timeline.thinking.collapsed' });
    fireEvent.click(collapsedButton);

    // 展开态文案换成"已思考用时 N 秒"
    const button = screen.getByRole('button', { name: 'timeline.thinking.completed' });
    const summaryRow = summaryRowOf(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('第一段思维链')).toBeInTheDocument();
    expect(screen.getByText('第二段思维链')).toBeInTheDocument();
    expect(summaryRow?.className).toContain('thinking-summary-row--pinned');
  });

  it('lifts the height cap and fade once the user takes over an in-progress chain', async () => {
    const { container } = render(
      <ActivityTimeline blocks={[createThinkingBlock({ status: 'running' })]} isStreaming />
    );

    const peek = () => container.querySelector('.activity-timeline-thinking-peek');
    const trigger = () => screen.getByRole('button', { name: 'timeline.thinking.inProgress' });

    // 中间态：自动展开，但内容被关在固定预览窗里
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(peek()).not.toHaveClass('activity-timeline-thinking-peek--expanded');

    // 用户手动收起 → 显式意图，先把中间态的预览窗整个撤掉
    fireEvent.click(trigger());
    await waitFor(() => {
      expect(peek()).toBeNull();
    });

    // 用户再手动展开 → 仍算显式意图：撤掉高度限制与渐隐，全部展开
    fireEvent.click(trigger());
    await waitFor(() => {
      expect(peek()).toHaveClass('activity-timeline-thinking-peek--expanded');
    });
  });

  it('keeps the fixed peek window while thinking and drops it after completion', async () => {
    const { container, rerender } = render(
      <ActivityTimeline blocks={[createThinkingBlock({ status: 'running' })]} isStreaming />
    );

    // 中间态：自动展开 + 固定窗口（无 --expanded）
    expect(container.querySelector('.activity-timeline-thinking-peek')).not.toHaveClass(
      'activity-timeline-thinking-peek--expanded'
    );

    rerender(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    // 完成后自动收起 → 预览窗与内容一起卸载
    await waitFor(() => {
      expect(container.querySelector('.activity-timeline-thinking-peek')).toBeNull();
    });
    expect(screen.queryByText('第一段思维链')).not.toBeInTheDocument();
  });

  it('scrolls the peek window to the newest reasoning as content streams in', async () => {
    const { container, rerender } = render(
      <ActivityTimeline
        blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链' })]}
        isStreaming
      />
    );

    const peek = container.querySelector('.activity-timeline-thinking-peek') as HTMLElement;
    stubPeekScrollMetrics(peek, { scrollHeight: 400, clientHeight: 136 });
    const writes = scrollTopWrites(peek);
    await flushFrames();
    // 首帧就对齐到底部，用户看到的是最新一段而不是被裁掉的开头
    expect(writes.at(-1)).toBe(400);

    rerender(
      <ActivityTimeline
        blocks={[
          createThinkingBlock({
            status: 'running',
            content: '第一段思维链\n\n第二段思维链\n\n第三段思维链',
          }),
        ]}
        isStreaming
      />
    );
    stubPeekScrollMetrics(peek, { scrollHeight: 900, clientHeight: 136 });
    await flushFrames();
    expect(writes.at(-1)).toBe(900);
  });

  it('stops following once the user scrolls up inside the peek window', async () => {
    const { container, rerender } = render(
      <ActivityTimeline
        blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链' })]}
        isStreaming
      />
    );

    const peek = container.querySelector('.activity-timeline-thinking-peek') as HTMLElement;
    stubPeekScrollMetrics(peek, { scrollHeight: 400, clientHeight: 136 });
    const writes = scrollTopWrites(peek);
    await flushFrames();

    // 用户往回翻，停在远离底部 264px 处
    peek.scrollTop = 0;
    await act(async () => {
      peek.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    writes.length = 0;

    rerender(
      <ActivityTimeline
        blocks={[
          createThinkingBlock({ status: 'running', content: '第一段思维链\n\n又来一段' }),
        ]}
        isStreaming
      />
    );
    await flushFrames();
    expect(writes).toEqual([]);
  });

  it('glides for large jumps but snaps for token-sized appends', async () => {
    const { container, rerender } = render(
      <ActivityTimeline
        blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链' })]}
        isStreaming
      />
    );

    const peek = container.querySelector('.activity-timeline-thinking-peek') as HTMLElement;
    stubPeekScrollMetrics(peek, { scrollHeight: 400, clientHeight: 136 });
    const writes = scrollTopWrites(peek);
    const glides = stubSmoothScroll(peek);
    await flushFrames();

    // 距底 264px 的大跳跃：平滑滑过去，让用户看清跨过了什么
    expect(glides).toEqual([{ top: 400, behavior: 'smooth' }]);
    expect(writes).toEqual([]);

    // 只差 84px —— token 追加的典型距离。直接落位，不去重启动画：
    // 每帧重启一次 ~300ms 的平滑滚动会永远走不完，看起来反而像卡住不跟随。
    peek.scrollTop = 180;
    writes.length = 0;
    rerender(
      <ActivityTimeline
        blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链\n\n又来一段' })]}
        isStreaming
      />
    );
    await flushFrames();
    expect(writes.at(-1)).toBe(400);
    expect(glides).toHaveLength(1);
  });

  it('keeps following across the intermediate frames of its own smooth scroll', async () => {
    const { container, rerender } = render(
      <ActivityTimeline
        blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链' })]}
        isStreaming
      />
    );

    const peek = container.querySelector('.activity-timeline-thinking-peek') as HTMLElement;
    stubPeekScrollMetrics(peek, { scrollHeight: 400, clientHeight: 136 });
    scrollTopWrites(peek);
    const glides = stubSmoothScroll(peek);
    await flushFrames();
    expect(glides).toHaveLength(1);

    // 动画正滑向 400 的途中，浏览器逐帧派发 scroll，此时距底还很远。
    // 这些帧不是用户上滚；若不区分，跟随会在第一次大跳跃后永久停摆。
    peek.scrollTop = 120;
    await act(async () => {
      peek.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    rerender(
      <ActivityTimeline
        blocks={[
          createThinkingBlock({ status: 'running', content: '第一段思维链\n\n第二段思维链' }),
        ]}
        isStreaming
      />
    );
    await flushFrames();
    expect(glides).toHaveLength(2);
  });

  it('still honors a real scroll-up once the smooth follow has landed', async () => {
    const { container, rerender } = render(
      <ActivityTimeline
        blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链' })]}
        isStreaming
      />
    );

    const peek = container.querySelector('.activity-timeline-thinking-peek') as HTMLElement;
    stubPeekScrollMetrics(peek, { scrollHeight: 400, clientHeight: 136 });
    scrollTopWrites(peek);
    const glides = stubSmoothScroll(peek);
    await flushFrames();

    // 动画落到底 → 解除「程序自己在滚」的标记
    peek.scrollTop = 264;
    await act(async () => {
      peek.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    // 之后用户真的往上翻：必须被正常记账
    peek.scrollTop = 0;
    await act(async () => {
      peek.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    rerender(
      <ActivityTimeline
        blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链\n\n又来一段' })]}
        isStreaming
      />
    );
    await flushFrames();
    expect(glides).toHaveLength(1);
  });

  it('falls back to an instant follow when the user prefers reduced motion', async () => {
    const restoreMatchMedia = stubReducedMotion();
    try {
      const { container } = render(
        <ActivityTimeline
          blocks={[createThinkingBlock({ status: 'running', content: '第一段思维链' })]}
          isStreaming
        />
      );

      const peek = container.querySelector('.activity-timeline-thinking-peek') as HTMLElement;
      stubPeekScrollMetrics(peek, { scrollHeight: 400, clientHeight: 136 });
      const writes = scrollTopWrites(peek);
      const glides = stubSmoothScroll(peek);
      await flushFrames();

      // 距底 264px 本该平滑滑过，但用户要求减少动效 → 直接落位
      expect(glides).toEqual([]);
      expect(writes.at(-1)).toBe(400);
    } finally {
      restoreMatchMedia();
    }
  });

  it('does not programmatically scroll an expanded chain', async () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'timeline.thinking.collapsed' }));
    await waitFor(() => {
      expect(screen.getByText('第一段思维链')).toBeInTheDocument();
    });

    const expandedPeek = document.querySelector(
      '.activity-timeline-thinking-peek--expanded'
    ) as HTMLElement;
    const writes = scrollTopWrites(expandedPeek);
    await flushFrames();

    expect(writes).toEqual([]);
  });

  it('hides thinking content after the user collapses the thinking chain', async () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const collapsedButton = screen.getByRole('button', { name: 'timeline.thinking.collapsed' });
    fireEvent.click(collapsedButton);
    expect(screen.getByText('第一段思维链')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'timeline.thinking.completed' }));

    await waitFor(() => {
      expect(screen.queryByText('第一段思维链')).not.toBeInTheDocument();
    });

    const collapsedSummary = summaryRowOf(
      screen.getByRole('button', { name: 'timeline.thinking.collapsed' })
    );
    expect(collapsedSummary?.className).not.toContain('thinking-summary-row--pinned');
  });
});
