import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import zhFlashcards from '@/locales/zh-CN/flashcards.json';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// 走真实 zh-CN 文案：缺 key 会退化成 key 本身，断言随即失败。
vi.mock('react-i18next', () => {
  const lookup = (key: string): string | undefined => {
    let cursor: unknown = zhFlashcards;
    for (const part of key.split('.')) {
      if (cursor == null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return typeof cursor === 'string' ? cursor : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const template = lookup(key);
        if (template == null) return key;
        if (!options) return template;
        return template.replace(
          /\{\{\s*([^}\s]+)\s*\}\}/g,
          (placeholder, name: string) => (options[name] == null ? placeholder : String(options[name])),
        );
      },
      i18n: { language: 'zh-CN' },
    }),
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { TodayScreen } from '@/features/flashcards/screens/TodayScreen';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';

interface StatsOverrides {
  total?: number;
  due?: number;
  newCount?: number;
  reviewsToday?: number;
}

function stats(overrides: StatsOverrides = {}) {
  return {
    total: 0,
    due: 0,
    newCount: 0,
    learning: 0,
    review: 0,
    relearning: 0,
    suspended: 0,
    reviewsToday: 0,
    ...overrides,
  };
}

const setScreen = vi.fn();
const loadDue = vi.fn(async () => true);

/** 把 fsrs_get_stats 换成给定聚合，其余命令返回复习活动的空但合法响应。 */
function mockBackend(statsPayload: ReturnType<typeof stats>) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'fsrs_get_stats') return statsPayload;
    if (command === 'fsrs_get_review_statistics') {
      return { dailyReviews: [], ratingDistribution: { again: 0, hard: 0, good: 0, easy: 0, total: 0 } };
    }
    return null;
  });
}

function renderToday() {
  render(<TodayScreen />);
  // 首帧 stats 还是 null；等 fsrs_get_stats 落盘后再断言，避免读到加载中的中间态。
  return waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fsrs_get_stats'));
}

describe('TodayScreen progress and empty states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFsrsReviewStore.setState({
      screen: 'today',
      dueCards: [],
      dueTotal: 0,
      loading: false,
      error: null,
      loadDue,
      setScreen,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps an empty card library off 100% and routes to library building', async () => {
    mockBackend(stats({ total: 0, reviewsToday: 0 }));

    await renderToday();

    // 回归点：旧实现在 stats 存在时把进度回落到 1，空卡库显示「100%」伪完成。
    const ring = await screen.findByRole('img', { name: '今日已复习 0 张，还剩 0 张到期' });
    expect(ring).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('0%')).toBeInTheDocument());
    expect(screen.queryByText('100%')).not.toBeInTheDocument();

    expect(screen.getByText(zhFlashcards.today.libraryEmpty)).toBeInTheDocument();
    expect(screen.getByText(zhFlashcards.today.libraryEmptyHint)).toBeInTheDocument();
    expect(screen.queryByText(zhFlashcards.today.allDone)).not.toBeInTheDocument();
    expect(screen.queryByText(zhFlashcards.today.empty)).not.toBeInTheDocument();

    // 当前树的空卡库 CTA 复用 today.goLibrary 文案（primary 变体），点击进卡片库。
    const cta = screen.getByRole('button', { name: zhFlashcards.today.goLibrary });
    fireEvent.click(cta);
    expect(setScreen).toHaveBeenCalledWith('library');
  });

  it('still reports 100% and all-done once a non-empty library is fully reviewed', async () => {
    mockBackend(stats({ total: 12, reviewsToday: 7 }));

    await renderToday();

    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument());
    expect(screen.getByText(zhFlashcards.today.allDone)).toBeInTheDocument();
    expect(screen.queryByText(zhFlashcards.today.libraryEmpty)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: zhFlashcards.today.goLibrary })).toBeInTheDocument();
  });

  it('shows the nothing-due idle state, not the empty-library state, when cards exist', async () => {
    mockBackend(stats({ total: 12, newCount: 5, reviewsToday: 0 }));

    await renderToday();

    // 「新卡 5」只能来自已落盘的 stats，用它作为聚合到位的信号。
    await waitFor(() => {
      expect(document.querySelector('.wb-fcx-count[data-tone="new"]')).toHaveTextContent('5');
    });
    expect(screen.getByText(zhFlashcards.today.empty)).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.queryByText(zhFlashcards.today.allDone)).not.toBeInTheDocument();
    expect(screen.queryByText(zhFlashcards.today.libraryEmpty)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: zhFlashcards.today.goLibrary })).toBeInTheDocument();
  });
});
