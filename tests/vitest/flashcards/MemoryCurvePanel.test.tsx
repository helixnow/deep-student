import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import zhFlashcards from '@/locales/zh-CN/flashcards.json';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// 走真实 zh-CN 文案（含 i18next 复数后缀回退）：缺 key 会退化成 key 本身，断言随即失败。
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
        const template = lookup(key) ?? (options && 'count' in options ? lookup(`${key}_other`) : undefined);
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

import { MemoryCurvePanel } from '@/features/flashcards/components/MemoryCurvePanel';

const MINUTE = 60_000;
const DAY = 86_400_000;

function memoryCard(id: string, front: string, rating: number, state: number, stability: number, dueInMs: number, now: number) {
  return {
    cardStateId: id,
    ankiCardId: `anki-${id}`,
    deckId: 'deck_default',
    front,
    extraFields: {},
    state,
    stability,
    difficulty: 5,
    lastReviewMs: now - 1000,
    dueMs: now + dueInMs,
    reps: 1,
    lapses: 0,
    lastRating: rating,
  };
}

function overviewPayload(now: number) {
  return {
    generatedAtMs: now,
    desiredRetention: 0.9,
    curve: { decay: -0.5, factor: 19 / 81 },
    recent: [
      memoryCard('again', 'ξ 的取值范围', 1, 1, 0.4072, MINUTE, now),
      memoryCard('easy', '构造辅助函数 φ(x)', 4, 2, 15.4722, 15 * DAY, now),
      memoryCard('good', '拉格朗日中值定理的两个条件', 3, 1, 3.1262, 10 * MINUTE, now),
    ],
    memorizedCount: 389,
    averageRetrievability: 0.934,
    trueRetention: { windowDays: 30, reviews: 412, passed: 376 },
  };
}

describe('MemoryCurvePanel', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the three memory figures and one row per recently reviewed card', async () => {
    const now = Date.now();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_get_memory_overview') return overviewPayload(now);
      throw new Error(`unexpected ${command}`);
    });

    render(<MemoryCurvePanel />);

    expect(await screen.findByText('平均记忆保持率')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('fsrs_get_memory_overview', { recentLimit: 5 });
    expect(screen.getByText('93%')).toBeInTheDocument();
    expect(screen.getByText('389 张已学卡片此刻的平均回忆概率')).toBeInTheDocument();
    expect(screen.getByText('近 30 天实际保持率')).toBeInTheDocument();
    expect(screen.getByText('91%')).toBeInTheDocument();
    expect(screen.getByText('412 次到期复习中答对的比例')).toBeInTheDocument();
    expect(screen.getByText('期望保留率 90%')).toBeInTheDocument();
    expect(screen.getByText('最近复习的 3 张卡')).toBeInTheDocument();

    const rows = screen.getAllByRole('button', { name: /完整复习历史/ });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('ξ 的取值范围');
    expect(rows[0]).toHaveTextContent('重来');
    expect(rows[0]).toHaveTextContent('稳定性 9.8 小时');
    expect(rows[0]).toHaveTextContent('学习步 · 1分钟后');
    expect(rows[1]).toHaveTextContent('稳定性 15 天');
    expect(rows[1]).toHaveTextContent('下次复习 15天后');
    expect(rows[2]).toHaveTextContent('学习步 · 10分钟后');
    expect(screen.getByRole('img', { name: '3 张卡的遗忘曲线' })).toBeInTheDocument();
  });

  it('opens a card history and returns to the recent view', async () => {
    const now = Date.now();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'fsrs_get_memory_overview') return overviewPayload(now);
      if (command === 'fsrs_get_card_memory_history') {
        expect(args).toEqual({ cardStateId: 'easy' });
        return {
          generatedAtMs: now,
          desiredRetention: 0.9,
          curve: { decay: -0.5, factor: 19 / 81 },
          card: { ...memoryCard('easy', '构造辅助函数 φ(x)', 4, 2, 15.4722, 15 * DAY, now), reps: 2 },
          reviews: [
            { logId: 'l1', reviewMs: now - 4 * DAY, rating: 3, stateBefore: 0, stateAfter: 1, stabilityAfter: 3.1262, difficultyAfter: 5, dueAfterMs: null },
            { logId: 'l2', reviewMs: now - 1000, rating: 4, stateBefore: 1, stateAfter: 2, stabilityAfter: 15.4722, difficultyAfter: 4, dueAfterMs: now + 15 * DAY },
          ],
        };
      }
      throw new Error(`unexpected ${command}`);
    });

    render(<MemoryCurvePanel />);
    fireEvent.click(await screen.findByRole('button', { name: '查看「构造辅助函数 φ(x)」的完整复习历史' }));

    const history = await screen.findByTestId('fsrs-memory-history');
    expect(history).toHaveTextContent('复习 2 次 · 遗忘 0 次');
    expect(history).toHaveTextContent('首次学习');
    expect(history).toHaveTextContent('间隔 4 天');
    // R(4 天, S = 3.1262) = (1 + 19/81 · 4/3.1262)^-0.5 ≈ 0.877
    expect(history).toHaveTextContent('复习前保持率 88%');
    expect(history).toHaveTextContent('稳定性 → 15 天');
    expect(screen.getByRole('img', { name: '2 次复习的记忆曲线' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '最近复习' }));
    await waitFor(() => expect(screen.queryByTestId('fsrs-memory-history')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /完整复习历史/ })).toHaveLength(3);
  });

  it('explains empty and unavailable states instead of drawing fake curves', async () => {
    invokeMock.mockResolvedValueOnce({ ...overviewPayload(Date.now()), recent: [], memorizedCount: 0, averageRetrievability: null });
    render(<MemoryCurvePanel />);
    expect(await screen.findByText(zhFlashcards.stats.memory.empty)).toBeInTheDocument();
    cleanup();

    invokeMock.mockRejectedValueOnce(new Error('command fsrs_get_memory_overview not found'));
    render(<MemoryCurvePanel />);
    expect(await screen.findByText(zhFlashcards.stats.memory.unavailable)).toBeInTheDocument();
  });
});
