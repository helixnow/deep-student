import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import type { MindMapNode } from '../../types';

const { invokeMock, saveAnkiCardsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveAnkiCardsMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: { saveAnkiCards: saveAnkiCardsMock },
}));

import {
  buildReciteMissFlashcardId,
  saveReciteMissCards,
} from '../saveReciteMissCards';

const pdfAnchor: SemanticAnchor = {
  kind: 'pdf',
  resourceId: 'pdf_linear_algebra',
  page: 42,
  quote: '特征多项式 det(λE-A)=0',
};

const root: MindMapNode = {
  id: 'root',
  text: '线性代数',
  children: [
    {
      id: 'node_eig',
      text: '特征多项式 det(λE-A)=0',
      anchors: [pdfAnchor],
      children: [],
    },
  ],
};

describe('saveReciteMissCards — deterministic dedup & provenance anchors', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveAnkiCardsMock.mockReset();
  });

  it('assigns deterministic ID, SourceNodeId, and merged PDF + mindmap anchors', async () => {
    const expectedId = buildReciteMissFlashcardId('mm_la', 'node_eig');
    expect(expectedId).toBe('card_mm_recite_mm_la_node_eig');

    saveAnkiCardsMock.mockResolvedValue({
      savedIds: [expectedId],
      taskId: 'task_1',
      cardIdMappings: [{ inputIndex: 0, inputId: expectedId, persistedId: expectedId }],
    });

    const count = await saveReciteMissCards({
      cards: [
        { nodeId: 'node_eig', front: 'Q1', back: 'A1' },
        // 同批内重复 nodeId 应自动去重
        { nodeId: 'node_eig', front: 'Q1-dup', back: 'A1-dup' },
      ],
      mindmapId: 'mm_la',
      title: '线性代数',
      deckPrefix: '导图背诵',
      tag: '导图背诵',
      root,
    });

    expect(count).toBe(1);
    const req = saveAnkiCardsMock.mock.calls[0][0];
    expect(req.documentId).toBe('mm_la');
    expect(req.cards).toHaveLength(1);
    expect(req.cards[0]).toMatchObject({
      id: expectedId,
      front: 'Q1',
      back: 'A1',
      tags: ['导图背诵', 'mindmap-card', '线性代数'],
      fields: {
        Front: 'Q1',
        Back: 'A1',
        SourceMindMapId: 'mm_la',
        SourceNodeId: 'node_eig',
      },
    });

    const parsedAnchors = JSON.parse(req.cards[0].fields.AnchorsJson) as SemanticAnchor[];
    expect(parsedAnchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'pdf', resourceId: 'pdf_linear_algebra', page: 42 }),
        expect.objectContaining({ kind: 'mindmap', resourceId: 'mm_la', nodeId: 'node_eig' }),
      ]),
    );
    expect(invokeMock).toHaveBeenCalledWith('fsrs_enqueue_cards', { ankiCardIds: [expectedId] });
  });

  it('passes persistedIds (including duplicatedIds) to idempotent fsrs_enqueue_cards and deduplicates mindmap-card tag', async () => {
    const existingId = buildReciteMissFlashcardId('mm_la', 'node_eig');
    saveAnkiCardsMock.mockResolvedValue({
      savedIds: [],
      duplicatedIds: [existingId],
      taskId: 'task_2',
      cardIdMappings: [{ inputIndex: 0, inputId: existingId, persistedId: existingId }],
    });

    const count = await saveReciteMissCards({
      cards: [{ nodeId: 'node_eig', front: 'Q1', back: 'A1' }],
      mindmapId: 'mm_la',
      title: '线性代数',
      deckPrefix: '导图背诵',
      tag: 'mindmap-card',
      root,
    });

    expect(count).toBe(1);
    const req = saveAnkiCardsMock.mock.calls[0][0];
    expect(req.cards[0].tags).toEqual(['mindmap-card', '线性代数']);
    // fsrs_enqueue_cards 幂等，传入 persistedIds 确保此前漏入队的既有错题卡也能补齐入队
    expect(invokeMock).toHaveBeenCalledWith('fsrs_enqueue_cards', { ankiCardIds: [existingId] });
  });
});
