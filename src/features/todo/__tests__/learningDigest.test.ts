import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn(async () => true);
const loadMock = vi.fn();
vi.mock('@/utils/systemNotification', () => ({ sendSystemNotification: (...a: unknown[]) => sendMock(...a) }));
vi.mock('@/features/learning-today/todayLearning', () => ({ loadTodayLearning: (...a: unknown[]) => loadMock(...a) }));
vi.mock('@/i18n', () => ({
  default: { t: (_k: string, o?: Record<string, unknown>) => String(o?.defaultValue ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, n) => String(o?.[n] ?? '')) },
}));
vi.mock('../api', () => ({ listReminderItems: vi.fn(async () => []), listTodayItems: vi.fn(async () => []) }));

import { checkDailyLearningDigest } from '../reminderScheduler';

const MORNING = new Date(2026, 9, 2, 8, 0, 0);

describe('daily learning digest', () => {
  beforeEach(() => {
    localStorage.clear();
    sendMock.mockClear();
    loadMock.mockReset();
  });

  it('sends one digest per day with cards, mistakes and notes', async () => {
    loadMock.mockResolvedValue({ cards: 16, mistakes: 2, notes: 1, dueNotes: [] });
    await checkDailyLearningDigest(MORNING);
    await checkDailyLearningDigest(new Date(2026, 9, 2, 9, 0, 0));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('今日有 19 项待复习', '卡片 16 张、错题 2 道、笔记 1 篇');
  });

  it('stays quiet before 7am and when nothing is due', async () => {
    loadMock.mockResolvedValue({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] });
    await checkDailyLearningDigest(new Date(2026, 9, 2, 6, 0, 0));
    expect(loadMock).not.toHaveBeenCalled();
    await checkDailyLearningDigest(MORNING);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
