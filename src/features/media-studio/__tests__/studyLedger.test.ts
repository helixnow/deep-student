import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/media-handout', () => ({ useGenerateHandout: vi.fn(), openHandoutNote: vi.fn() }));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({ useReferenceToChat: vi.fn() }));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { ledgerAccuracy, mediaStudioApi, normalizeStudyLedger } from '../api';
import { lectureCardBudget } from '../components/MediaStudyTabs';
import type { TranscriptSegment } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';

describe('media study ledger', () => {
  it('normalizes camel or snake payloads and drops rows without a resource id', () => {
    expect(normalizeStudyLedger({
      resource_id: 'file_lec',
      card_count: 12,
      cards_due: '3',
      cards_new: -1,
      card_ids: ['c1', 2, ''],
      questionCount: 8,
      questionsAttempted: 5,
      attemptTotal: 9,
      correctTotal: 6,
      questionsWrong: 2,
      examIds: ['exam_a'],
    })).toEqual({
      resourceId: 'file_lec',
      cardCount: 12,
      cardsDue: 3,
      cardsNew: 0,
      cardIds: ['c1'],
      questionCount: 8,
      questionsAttempted: 5,
      attemptTotal: 9,
      correctTotal: 6,
      questionsWrong: 2,
      examIds: ['exam_a'],
    });
    expect(normalizeStudyLedger({ cardCount: 1 })).toBeNull();
  });

  it('computes accuracy only when there are attempts', () => {
    expect(ledgerAccuracy({ attemptTotal: 9, correctTotal: 6 })).toBe(67);
    expect(ledgerAccuracy({ attemptTotal: 0, correctTotal: 0 })).toBeNull();
    expect(ledgerAccuracy({ attemptTotal: 2, correctTotal: 5 })).toBe(100);
  });

  it('skips the IPC call for an empty id list', async () => {
    invokeMock.mockReset();
    expect(await mediaStudioApi.studyLedger([])).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
    invokeMock.mockResolvedValueOnce([{ resourceId: 'file_lec', cardCount: 1 }]);
    const [ledger] = await mediaStudioApi.studyLedger(['file_lec'], true);
    expect(invokeMock).toHaveBeenCalledWith('media_study_ledger', { resourceIds: ['file_lec'], includeCardIds: true });
    expect(ledger.cardCount).toBe(1);
  });
});

describe('lectureCardBudget', () => {
  const seg = (startS: number, endS: number, status: TranscriptSegment['status'] = 'done'): TranscriptSegment => ({
    idx: startS,
    startMs: startS * 1000,
    endMs: endS * 1000,
    text: '内容',
    status,
  });

  it('scales with the transcribed span, clamped to 6–40 cards', () => {
    expect(lectureCardBudget([])).toBe(0);
    expect(lectureCardBudget([seg(0, 60)])).toBe(6);
    expect(lectureCardBudget([seg(0, 30), seg(1770, 1800)])).toBe(18);
    expect(lectureCardBudget([seg(0, 30), seg(7170, 7200), seg(9000, 9999, 'pending')])).toBe(40);
  });
});
