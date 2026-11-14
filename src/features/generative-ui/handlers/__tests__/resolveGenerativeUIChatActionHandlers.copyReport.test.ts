import { beforeEach, describe, expect, it, vi } from 'vitest';

const { copyTextToClipboard } = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard }));
vi.mock('@/i18n', () => ({ default: { t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? '' } }));
vi.mock('i18next', () => ({ default: { t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? '' } }));
vi.mock('@/features/workbench', () => ({
  workbenchBus: { activateDetailed: vi.fn(), launch: vi.fn() },
}));
vi.mock('@/features/learning-today/openTodayReview', () => ({ openTodayReviewTarget: vi.fn() }));
vi.mock('@/features/learning-today/todayLearningStore', () => ({
  getTodayLearningSnapshot: () => ({ cards: 0, mistakes: 0, notes: 0 }),
}));

import { resolveGenerativeUIChatActionHandlers } from '../../bridge/resolveGenerativeUIChatActionHandlers';
import { collectUnregisteredActionIds } from '../../utils/collectUnregisteredActionIds';
import type { GenerativeUIIntent } from '../../types';

describe('resolveGenerativeUIChatActionHandlers — non-research copy-report fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers copy-report for non-research briefings so action-bar shows no unregistered warning', async () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      meta: { title: '今日学习速览' },
      blocks: [
        { type: 'stat-card', props: { title: '今日活动', value: 32 } },
        {
          type: 'action-bar',
          props: {
            actions: [
              { id: 'start-review', label: '开始一次快速复习', riskLevel: 'low' },
              { id: 'open-qbank', label: '去题库建题', riskLevel: 'low' },
              { id: 'copy-report', label: '复制今日小结', riskLevel: 'low' },
            ],
          },
        },
      ],
    };

    const handlers = resolveGenerativeUIChatActionHandlers({ intent });
    expect(collectUnregisteredActionIds(intent, handlers)).toEqual([]);
    expect(handlers['copy-report']).toBeDefined();

    await handlers['copy-report'].handler({} as never);
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(copyTextToClipboard.mock.calls[0]?.[0]).toContain('今日学习速览');
  });
});
