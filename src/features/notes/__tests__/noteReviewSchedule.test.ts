import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, setMetadata } = vi.hoisted(() => ({ get: vi.fn(), setMetadata: vi.fn() }));
vi.mock('@/dstu', () => ({
  dstu: { get, setMetadata },
  updatedAtToVersionToken: (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : undefined),
}));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

import { addCalendarDays, rescheduleNoteReview } from '../noteReviewSchedule';

const node = (props: Record<string, unknown>) => ({
  ok: true,
  value: { id: 'note_1', path: '/课程/note_1', type: 'note', updatedAt: 1_700_000_000_000, metadata: { props } },
});

describe('rescheduleNoteReview', () => {
  beforeEach(() => {
    get.mockReset();
    setMetadata.mockReset();
    setMetadata.mockResolvedValue({ ok: true });
  });

  it('moves the review date forward from today and keeps every other prop', async () => {
    get.mockResolvedValue(node({ study_review_date: '2026-10-01', study_course: '高数', custom: 'x' }));
    const next = await rescheduleNoteReview('note_1', 3, new Date(2026, 9, 5, 22, 30));
    expect(next).toBe('2026-10-08');
    expect(get).toHaveBeenCalledWith('/note_1');
    expect(setMetadata).toHaveBeenCalledWith(
      '/课程/note_1',
      { props: { study_review_date: '2026-10-08', study_course: '高数', custom: 'x' } },
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it('marks the note mastered and drops it from reviews', async () => {
    get.mockResolvedValue(node({ study_review_date: '2026-10-01', study_mastery: 'needs-review' }));
    expect(await rescheduleNoteReview('note_1', null)).toBeNull();
    expect(setMetadata.mock.calls[0][1]).toEqual({ props: { study_mastery: 'mastered' } });
  });

  it('surfaces a stale-version write instead of silently losing it', async () => {
    get.mockResolvedValue(node({}));
    setMetadata.mockResolvedValue({ ok: false, error: { toUserMessage: () => 'conflict' } });
    await expect(rescheduleNoteReview('note_1', 1)).rejects.toThrow('conflict');
  });
});

describe('addCalendarDays', () => {
  it('counts local calendar days across month ends', () => {
    expect(addCalendarDays(new Date(2026, 9, 30), 3)).toBe('2026-11-02');
  });
});
