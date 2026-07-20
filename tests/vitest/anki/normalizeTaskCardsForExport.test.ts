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

  it('should prefer edited cards wholesale for legacy id-less snapshots', () => {
    // 旧版快照没有 id，无法按 id 对齐，保留“整批优先块副本”的旧语义
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

  it('should merge by id with db as authority (A9): db-only new cards are not masked by stale snapshot', () => {
    // 块快照生成较早，只有 card-1；DB 随后又生成了 card-2
    const editedCards: AnkiCard[] = [
      { id: 'card-1', front: 'Q1', back: 'A1', tags: [], images: [] },
    ];
    const dbCards: AnkiCard[] = [
      { id: 'card-1', front: 'Q1', back: 'A1', tags: [], images: [] },
      { id: 'card-2', front: 'Q2', back: 'A2', tags: [], images: [] },
    ];

    const selected = selectTaskExportCards(editedCards, dbCards);

    expect(selected).toHaveLength(2);
    expect(selected.map(c => c.id)).toEqual(['card-1', 'card-2']);
    // 内容一致时使用 DB 权威副本
    expect(selected[0]).toBe(dbCards[0]);
  });

  it('should let genuinely edited snapshot cards override matching db cards', () => {
    const editedCards: AnkiCard[] = [
      { id: 'card-1', front: 'Q1 (edited)', back: 'A1 (edited)', tags: ['edited'], images: [] },
    ];
    const dbCards: AnkiCard[] = [
      { id: 'card-1', front: 'Q1', back: 'A1', tags: [], images: [] },
      { id: 'card-2', front: 'Q2', back: 'A2', tags: [], images: [] },
    ];

    const selected = selectTaskExportCards(editedCards, dbCards);

    expect(selected).toHaveLength(2);
    expect(selected[0].front).toBe('Q1 (edited)');
    expect(selected[0].tags).toEqual(['edited']);
    expect(selected[1].id).toBe('card-2');
  });

  it('should keep db version when db copy is newer than the edited snapshot', () => {
    // DB 卡在快照之后又被编辑过（updated_at 更新）→ DB 胜出
    const editedCards: AnkiCard[] = [
      {
        id: 'card-1',
        front: 'old edit',
        back: 'old edit',
        tags: [],
        images: [],
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const dbCards: AnkiCard[] = [
      {
        id: 'card-1',
        front: 'db newer',
        back: 'db newer',
        tags: [],
        images: [],
        updated_at: '2026-02-01T00:00:00.000Z',
      },
    ];

    const selected = selectTaskExportCards(editedCards, dbCards);

    expect(selected).toHaveLength(1);
    expect(selected[0].front).toBe('db newer');
  });

  it('should append snapshot-only cards after db cards', () => {
    // 用户在聊天块内新增的卡（DB 中不存在）应被补充进导出集合
    const editedCards: AnkiCard[] = [
      { id: 'card-1', front: 'Q1', back: 'A1', tags: [], images: [] },
      { id: 'card-extra', front: 'Extra', back: 'Extra', tags: [], images: [] },
    ];
    const dbCards: AnkiCard[] = [
      { id: 'card-1', front: 'Q1', back: 'A1', tags: [], images: [] },
    ];

    const selected = selectTaskExportCards(editedCards, dbCards);

    expect(selected.map(c => c.id)).toEqual(['card-1', 'card-extra']);
  });
});
