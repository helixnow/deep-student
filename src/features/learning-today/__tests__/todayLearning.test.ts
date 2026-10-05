import { describe, expect, it, vi } from 'vitest';

const { invoke, list } = vi.hoisted(() => ({ invoke: vi.fn(), list: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/dstu', () => ({ dstu: { list } }));
import { loadTodayLearning } from '../todayLearning';

const note = (id: string, reviewDate?: string) => ({
  id, name: id, type: 'note', metadata: reviewDate ? { props: { study_review_date: reviewDate } } : {},
});

describe('loadTodayLearning', () => {
  it('sums the three review lines with one shared definition of "due"', async () => {
    // 后端 due_today = next_review_date ≤ 今天，已含 overdue_count，不能再相加
    invoke.mockImplementation(async (cmd: string) => cmd === 'fsrs_get_stats' ? { due: 7 } : { due_today: 5, overdue_count: 3 });
    list.mockResolvedValue({ ok: true, value: [note('a', '2026-09-30'), note('b', '2026-10-01'), note('c', '2026-10-05'), note('d')] });
    const today = await loadTodayLearning(new Date('2026-10-01T12:00:00'));
    expect(today).toMatchObject({ cards: 7, mistakes: 5, notes: 2 });
    expect(today.dueNotes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('reports card and review-plan totals only when they were actually read', async () => {
    invoke.mockImplementation(async (cmd: string) => cmd === 'fsrs_get_stats' ? { due: 0, total: 0 } : { due_today: 0, total_plans: 3 });
    list.mockResolvedValue({ ok: true, value: [] });
    expect(await loadTodayLearning(new Date('2026-10-01T12:00:00'))).toMatchObject({ cardsTotal: 0, plansTotal: 3 });
    invoke.mockRejectedValue(new Error('offline'));
    const degraded = await loadTodayLearning(new Date('2026-10-01T12:00:00'));
    expect(degraded.cardsTotal).toBeUndefined();
    expect(degraded.plansTotal).toBeUndefined();
  });

  it('degrades each line independently on failure', async () => {
    invoke.mockImplementation(async (cmd: string) => { if (cmd === 'fsrs_get_stats') throw new Error('x'); return { due_today: 1 }; });
    list.mockResolvedValue({ ok: false });
    expect(await loadTodayLearning(new Date('2026-10-01T12:00:00'))).toMatchObject({ cards: 0, mistakes: 1, notes: 0 });
  });
});
