import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOcclusionSpec } from '@/components/anki/utils/imageOcclusion';
import { resetProjectedFlashcardCache } from '@/services/liveCardProjector';
import { AnchorRegistry } from '@/ui-kernel/services/anchors';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  saveAnkiCards: vi.fn(),
  deleteAnkiCards: vi.fn(),
  emitFlashcardsChanged: vi.fn(),
  anchors: null as AnchorRegistry | null,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: mocks.saveAnkiCards,
    deleteAnkiCards: mocks.deleteAnkiCards,
  },
}));

vi.mock('@/events/flashcards', () => ({
  emitFlashcardsChanged: mocks.emitFlashcardsChanged,
}));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => (mocks.anchors ? { anchors: mocks.anchors } : null),
}));

import {
  compileOcclusionCards,
  saveCompiledOcclusionCards,
} from '../occlusionCompiler';

describe('occlusionCompiler (Multi-Card Image Occlusion Compiler)', () => {
  beforeEach(() => {
    resetProjectedFlashcardCache();
    vi.clearAllMocks();
    mocks.anchors = new AnchorRegistry();
    mocks.invoke.mockResolvedValue({ enqueued: 3 });
    mocks.saveAnkiCards.mockImplementation(async ({ cards }) => ({
      savedIds: cards.map((c: { id: string }) => c.id),
      taskId: 'task_io_1',
    }));
  });

  it('compiles 3 boxes into 3 distinct cards with unique id, front, and text, valid _occlusion JSON, and PDF _source_anchor', () => {
    const bundle = compileOcclusionCards({
      documentScopeId: 'pdf_anat_01',
      imageRef: 'vfs://img_heart_diagram',
      mode: 'hide-all',
      title: '心脏解剖图',
      extraNote: '注意房室瓣血流方向',
      sourceAnchor: {
        kind: 'pdf',
        resourceId: 'pdf_anat_01',
        page: 42,
        rect: { x: 0.1, y: 0.15, w: 0.8, h: 0.5 },
      },
      boxes: [
        { x: 0.12, y: 0.2, w: 0.18, h: 0.12, label: '左心房' },
        { x: 0.42, y: 0.45, w: 0.2, h: 0.14, label: '左心室' },
        { x: 0.68, y: 0.25, w: 0.16, h: 0.15, label: '主动脉弓' },
      ],
    });

    expect(bundle.cards).toHaveLength(3);

    const ids = new Set(bundle.cards.map((c) => c.id));
    const fronts = new Set(bundle.cards.map((c) => c.front));
    const texts = new Set(bundle.cards.map((c) => c.text));
    expect(ids.size).toBe(3);
    expect(fronts.size).toBe(3);
    expect(texts.size).toBe(3);

    bundle.cards.forEach((card, index) => {
      const targetStr = String(index + 1);
      expect(card.id).toMatch(/^card_io_[0-9a-f]{16}$/);
      expect(card.fields?._occlusion_mode).toBe('hide-all');
      expect(card.fields?._occlusion_target).toBe(targetStr);
      expect(card.fields?._source_anchor).toContain('ds-anchor://v1/pdf/pdf_anat_01?page=42');

      const parsedSpec = parseOcclusionSpec(card.fields);
      expect(parsedSpec).not.toBeNull();
      expect(parsedSpec!.imageRef).toBe('vfs://img_heart_diagram');
      expect(parsedSpec!.boxes).toHaveLength(3);
    });
  });

  it('rejects tiny (< 0.01) or out-of-bounds boxes and caps valid boxes at 12', () => {
    expect(() =>
      compileOcclusionCards({
        documentScopeId: 'pdf_anat_01',
        imageRef: 'vfs://img_1',
        mode: 'hide-one',
        boxes: [
          { x: 0.2, y: 0.2, w: 0.004, h: 0.005 }, // tiny < 1%
          { x: 0.9, y: 0.9, w: 0.25, h: 0.25 }, // out of [0, 1]
        ],
      }),
    ).toThrow();

    const fifteenBoxes = Array.from({ length: 15 }, (_, idx) => ({
      x: (idx % 5) * 0.18 + 0.02,
      y: Math.floor(idx / 5) * 0.25 + 0.02,
      w: 0.12,
      h: 0.12,
      label: `区域 ${idx + 1}`,
    }));

    const capped = compileOcclusionCards({
      documentScopeId: 'pdf_anat_01',
      imageRef: 'vfs://img_1',
      mode: 'hide-one',
      boxes: fifteenBoxes,
    });
    expect(capped.spec.boxes).toHaveLength(12);
    expect(capped.cards).toHaveLength(12);
  });

  it('persists compiled cards, enqueues FSRS, and upserts PDF backlink edges via liveCardProjector', async () => {
    const saved = await saveCompiledOcclusionCards({
      documentScopeId: 'pdf_cell_09',
      imageRef: 'vfs://img_mitochondria',
      mode: 'hide-one',
      title: '线粒体亚显微结构',
      deckName: '细胞生物学',
      sourceAnchor: {
        kind: 'pdf',
        resourceId: 'pdf_cell_09',
        page: 18,
      },
      boxes: [
        { x: 0.15, y: 0.2, w: 0.22, h: 0.14, label: '外膜' },
        { x: 0.48, y: 0.35, w: 0.24, h: 0.16, label: '线粒体嵴' },
      ],
    });

    expect(saved.savedIds).toHaveLength(2);
    expect(mocks.saveAnkiCards).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('fsrs_enqueue_cards', {
      ankiCardIds: saved.savedIds,
    });
    expect(mocks.emitFlashcardsChanged).toHaveBeenCalledWith('image-occlusion-create');

    const incomingEdges = await mocks.anchors!.queryAnchorEdgesByTarget({
      targetResourceIds: ['pdf_cell_09'],
      targetKind: 'pdf',
    });
    expect(incomingEdges).toHaveLength(2);
    expect(incomingEdges.every((e) => e.targetPage === 18)).toBe(true);
  });
});
