import { describe, it, expect } from 'vitest';
import type { AnkiCard } from '@/types';
import {
  normalizeTaskCardsForExport,
  selectTaskExportCards,
} from '@/components/anki/utils/normalizeTaskCardsForExport';

describe('normalizeTaskCardsForExport', () => {
  it('should preserve template_id and prefer structured fields for export', () => {
    const cards: AnkiCard[] = [
      {
        front: '',
        back: '',
        tags: [],
        images: [],
        template_id: 'template-1',
        fields: {
          Front: 'Q1',
          Back: 'A1',
          Question: 'Question 1',
        },
      },
    ];

    const result = normalizeTaskCardsForExport(cards);

    expect(result[0].template_id).toBe('template-1');
    expect(result[0].front).toBe('Q1');
    expect(result[0].back).toBe('A1');
    expect(result[0].extra_fields).toEqual({
      Front: 'Q1',
      Back: 'A1',
      Question: 'Question 1',
    });
  });

  it('should keep extra_fields when present and fallback to explicit front/back', () => {
    const cards: AnkiCard[] = [
      {
        front: 'front-value',
        back: 'back-value',
        tags: ['tag1'],
        images: [],
        extra_fields: {
          question: 'q',
          answer: 'a',
        },
      },
    ];

    const result = normalizeTaskCardsForExport(cards);

    expect(result[0].front).toBe('front-value');
    expect(result[0].back).toBe('back-value');
    expect(result[0].tags).toEqual(['tag1']);
    expect(result[0].extra_fields).toEqual({
      question: 'q',
      answer: 'a',
    });
  });

  it('should prefer edited cards when selecting export source', () => {
    const editedCards: AnkiCard[] = [{ front: 'edited', back: 'edited', tags: [], images: [] }];
    const dbCards: AnkiCard[] = [{ front: 'raw', back: 'raw', tags: [], images: [] }];

    const selected = selectTaskExportCards(editedCards, dbCards);

    expect(selected).toBe(editedCards);
    expect(selected[0].front).toBe('edited');
  });

  it('should fallback to db cards when edited cards are unavailable', () => {
    const dbCards: AnkiCard[] = [{ front: 'raw', back: 'raw', tags: [], images: [] }];

    expect(selectTaskExportCards([], dbCards)).toBe(dbCards);
    expect(selectTaskExportCards(undefined, dbCards)).toBe(dbCards);
    expect(selectTaskExportCards(null, dbCards)).toBe(dbCards);
  });
});
