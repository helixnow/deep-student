import { describe, it, expect, vi } from 'vitest';

// validateCardsForExport 的问题明细带本地化 message，测试环境直接回显 key
vi.mock('@/utils/i18n', () => ({
  t: (key: string) => key,
}));

import {
  filterExportableCards,
  validateCardsForExport,
} from '@/components/anki/cardforge/engines/exportNormalize';

describe('validateCardsForExport', () => {
  it('flags error cards and empty cards as blocking (error level)', () => {
    const cards = [
      { id: 'ok', front: 'F', back: 'B' },
      { id: 'err', front: 'F', back: 'B', isErrorCard: true },
      { id: 'empty', front: '', back: '', fields: {} },
    ];

    const result = validateCardsForExport(cards);

    expect(result.ok).toBe(true);
    expect(result.totalCount).toBe(3);
    expect(result.exportableCount).toBe(1);
    expect(result.issues.map((i) => [i.code, i.level])).toEqual(
      expect.arrayContaining([
        ['error_card', 'error'],
        ['empty_card', 'error'],
      ])
    );
  });

  it('accepts snake_case cards (global AnkiCard shape) via extra_fields/is_error_card', () => {
    const cards = [
      { id: 'a', front: '', back: '', extra_fields: { Front: 'F', Back: 'B' } },
      { id: 'b', front: 'F', back: 'B', is_error_card: true },
    ];

    const result = validateCardsForExport(cards);

    expect(result.exportableCount).toBe(1);
    expect(result.issues.some((i) => i.code === 'error_card' && i.index === 1)).toBe(true);
  });

  it('emits warnings (missing_front/missing_back) without blocking export', () => {
    const cards = [{ id: 'w', front: '', back: '', fields: { Extra: 'content' } }];

    const result = validateCardsForExport(cards);

    expect(result.ok).toBe(true);
    expect(result.exportableCount).toBe(1);
    expect(result.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['missing_front', 'missing_back'])
    );
    expect(result.issues.every((i) => i.level === 'warning')).toBe(true);
  });

  it('reports missing required template fields as warnings', () => {
    const cards = [{ id: 'r', front: 'F', back: 'B', fields: { Front: 'F' } }];

    const result = validateCardsForExport(cards, ['Front', 'Back']);

    expect(
      result.issues.some((i) => i.code === 'missing_field' && i.field === 'Back')
    ).toBe(true);
  });

  it('returns ok:false when no card survives validation', () => {
    const result = validateCardsForExport([
      { id: 'x', front: 'F', back: 'B', isErrorCard: true },
    ]);

    expect(result.ok).toBe(false);
    expect(result.exportableCount).toBe(0);
  });
});

describe('filterExportableCards', () => {
  it('drops only error-level cards and keeps warning-level cards', () => {
    const cards = [
      { id: 'ok', front: 'F', back: 'B' },
      { id: 'warn', front: '', back: '', fields: { Extra: 'content' } },
      { id: 'err', front: 'F', back: 'B', isErrorCard: true },
    ];

    const validation = validateCardsForExport(cards);
    const filtered = filterExportableCards(cards, validation);

    expect(filtered.map((c) => c.id)).toEqual(['ok', 'warn']);
  });
});
