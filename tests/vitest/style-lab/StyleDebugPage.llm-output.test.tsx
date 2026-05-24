import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

function createMatchMedia(matches = false): typeof window.matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

describe('StyleDebugPage LLM output lab', () => {
  const originalMatchMedia = window.matchMedia;
  const originalLocalStorage = globalThis.localStorage;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: createMatchMedia(false),
    });
  });

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a compact real-playback lab without the fake state matrix', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'LLM 输出' }));

    expect(screen.getAllByText('LLM 输出真实回放').length).toBeGreaterThan(0);
    expect(screen.getByText('这里只保留一条真实 assistant message 的自动回放，用来看等待点、thinking badge、正文打字、工具块和停止收尾。')).toBeInTheDocument();
    expect(document.querySelector('.llm-output-playback')).toBeInTheDocument();
    expect(document.querySelector('.llm-output-grid')).toBeNull();
    expect(screen.queryByText('发送中')).toBeNull();
  });

  it('auto-plays a realistic full LLM output lifecycle sample', async () => {
    vi.useFakeTimers();
    render(<StyleDebugPage />);

    fireEvent.click(screen.getByRole('button', { name: 'LLM 输出' }));

    expect(screen.getByText('真实输出回放')).toBeInTheDocument();
    const playback = document.querySelector('.llm-output-playback');
    expect(playback).toBeInTheDocument();
    expect(playback).toHaveAttribute('data-current-step', 'ready');

    fireEvent.click(screen.getByRole('button', { name: '开始回放' }));

    expect(playback).toHaveAttribute('data-current-step', 'waiting');
    expect(playback?.querySelector('.chat-thinking-indicator')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(playback).toHaveAttribute('data-current-step', 'thinking');

    await act(async () => {
      vi.advanceTimersByTime(280);
    });
    expect(playback).toHaveAttribute('data-current-step', 'thinking');

    await act(async () => {
      vi.advanceTimersByTime(520);
    });
    expect(playback).toHaveAttribute('data-current-step', 'content-intro');
    expect(playback?.querySelector('.streaming-cursor')).toBeInTheDocument();
    expect(playback).toHaveTextContent('我会先按当前 Chat V2 的真实状态机收口：');
    expect(playback).not.toHaveTextContent('正文开始后才出现当前内容末尾的输入态。');

    await act(async () => {
      vi.advanceTimersByTime(220);
    });
    expect(playback).toHaveAttribute('data-current-step', 'content-intro');
    expect(playback).toHaveTextContent('我会先按当前 Chat V2 的真实状态机收口：首包前只显示等待点，');
    expect(playback).not.toHaveTextContent('正文开始后才出现当前内容末尾的输入态。');

    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    expect(playback).toHaveAttribute('data-current-step', 'content-intro');
    expect(playback).toHaveTextContent('我会先按当前 Chat V2 的真实状态机收口：首包前只显示等待点，正文开始后才出现当前内容末尾的输入态。');

    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    expect(playback).toHaveAttribute('data-current-step', 'tool');
    expect(playback?.querySelector('.streaming-cursor')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(playback).toHaveAttribute('data-current-step', 'content-resume');
    expect(playback?.querySelector('.streaming-cursor')).toBeInTheDocument();
    expect(playback).toHaveTextContent('工具阶段结束后，再继续正文；');
    expect(playback).not.toHaveTextContent('不让 cursor 残留。');

    await act(async () => {
      vi.advanceTimersByTime(220);
    });
    expect(playback).toHaveAttribute('data-current-step', 'content-resume');
    expect(playback).toHaveTextContent('工具阶段结束后，再继续正文；手动停止时则立刻清掉活跃态，');
    expect(playback).not.toHaveTextContent('不让 cursor 残留。');

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(playback).toHaveAttribute('data-current-step', 'aborting');
    expect(playback?.querySelector('.streaming-cursor')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(playback).toHaveAttribute('data-current-step', 'idle');
    expect(playback?.querySelector('.streaming-cursor')).toBeNull();
    expect(playback).toHaveTextContent('工具阶段结束后，再继续正文；手动停止时则立刻清掉活跃态，');
    expect(playback).not.toHaveTextContent('不让 cursor 残留。');
    expect(screen.getByRole('button', { name: '重新回放' })).toBeInTheDocument();
  });
});
