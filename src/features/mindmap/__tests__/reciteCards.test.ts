import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MindMapNode } from '../types';

const { invoke, saveAnkiCards } = vi.hoisted(() => ({ invoke: vi.fn(), saveAnkiCards: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/services/ankiApiAdapter', () => ({ ankiApiAdapter: { saveAnkiCards } }));

import { buildReciteMissCards } from '../utils/reciteCards';
import { saveReciteMissCards } from '../utils/saveReciteMissCards';

const node = (id: string, text: string, children: MindMapNode[] = [], blankedRanges?: Array<{ start: number; end: number }>) =>
  ({ id, text, children, blankedRanges }) as unknown as MindMapNode;

const root = node('root', '线性代数', [
  node('ch', '特征值', [
    node('a', '特征多项式 det(λE−A)=0', [], [{ start: 6, end: 17 }]),
    node('b', '迹 = 特征值之和，行列式 = 特征值之积', [], [{ start: 4, end: 7 }, { start: 16, end: 19 }]),
    node('c', '相似矩阵特征值相同', [], [{ start: 0, end: 4 }]),
  ]),
]);

describe('buildReciteMissCards', () => {
  it('turns only the blanks revealed this session into cards, keeping the topic path as a hint', () => {
    const cards = buildReciteMissCards(root, {
      a: { 0: { presented: true, missed: true } },
      b: { 0: { presented: true }, 1: { presented: true, missed: true } },
      c: { 0: { presented: true } },
    });
    expect(cards).toEqual([
      { nodeId: 'a', front: '【线性代数 › 特征值】特征多项式 ［　？　］', back: '特征多项式 det(λE−A)=0' },
      { nodeId: 'b', front: '【线性代数 › 特征值】迹 = 特征值之和，行列式 = ［　？　］之积', back: '迹 = 特征值之和，行列式 = 特征值之积' },
    ]);
  });

  it('returns nothing when every blank was recalled', () => {
    expect(buildReciteMissCards(root, { a: { 0: { presented: true } } })).toEqual([]);
  });
});

describe('saveReciteMissCards', () => {
  beforeEach(() => {
    invoke.mockReset();
    saveAnkiCards.mockReset();
  });

  it('saves basic cards under a recall deck with the mind map as source and enqueues them', async () => {
    saveAnkiCards.mockResolvedValue({ savedIds: ['c1', 'c2'], taskId: 't' });
    const count = await saveReciteMissCards({
      cards: [{ nodeId: 'a', front: 'F1', back: 'B1' }, { nodeId: 'b', front: 'F2', back: 'B2' }],
      mindmapId: 'mm_1',
      title: '线性代数',
      deckPrefix: '导图背诵',
      tag: '导图背诵',
    });
    expect(count).toBe(2);
    const request = saveAnkiCards.mock.calls[0][0];
    expect(request.options).toMatchObject({
      deck_name: '导图背诵::线性代数',
      note_type: 'Basic',
      source_ref: { kind: 'mindmap', id: 'mm_1', title: '线性代数' },
    });
    expect(request.cards[0]).toMatchObject({ front: 'F1', back: 'B1', tags: ['导图背诵', '线性代数'] });
    expect(invoke).toHaveBeenCalledWith('fsrs_enqueue_cards', { ankiCardIds: ['c1', 'c2'] });
  });

  it('fails loudly when nothing was saved instead of enqueueing nothing', async () => {
    saveAnkiCards.mockResolvedValue({ savedIds: [], taskId: 't', failed: [{ id: 'x', error: 'db busy' }] });
    await expect(saveReciteMissCards({
      cards: [{ nodeId: 'a', front: 'F', back: 'B' }], mindmapId: null, title: '', deckPrefix: '导图背诵', tag: 't',
    })).rejects.toThrow('db busy');
    expect(invoke).not.toHaveBeenCalled();
  });
});
