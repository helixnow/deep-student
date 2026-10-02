import { describe, expect, it } from 'vitest';
import type { AnkiLibraryCard } from '@/types';
import { getCardBack, getCardFront } from '../libraryView';

const card = (patch: Partial<AnkiLibraryCard>): AnkiLibraryCard => ({
  id: 'c1', task_id: 't1', front: '', back: '', tags: [], images: [], created_at: '', updated_at: '',
  ...patch,
} as AnkiLibraryCard);

describe('library card title/summary', () => {
  it('uses the question, not the subject, for multiple-choice cards', () => {
    const c = card({ front: '高等数学', back: 'A. 忘记验证连续性', extra_fields: { subject: '高等数学', question: '证明不等式时常见的易错点是？', explanation: '要验证条件' } });
    expect(getCardFront(c)).toBe('证明不等式时常见的易错点是？');
    expect(getCardBack(c)).toBe('要验证条件');
  });

  it('skips id-like front fields (blueprint template)', () => {
    const c = card({ front: 'LMT-01', back: '拉格朗日中值定理', extra_fields: { id: 'LMT-01', question: '拉格朗日中值定理', expl: '连续 + 可导' } });
    expect(getCardFront(c)).toBe('拉格朗日中值定理');
    expect(getCardBack(c)).toBe('连续 + 可导');
  });

  it('falls back to front/back and ignores internal _ fields', () => {
    const c = card({ front: '正面', back: '背面', extra_fields: { _qa_flags: '[]' } });
    expect(getCardFront(c)).toBe('正面');
    expect(getCardBack(c)).toBe('背面');
  });
});
