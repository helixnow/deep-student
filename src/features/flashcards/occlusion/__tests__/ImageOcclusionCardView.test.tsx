import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcclusionSpec } from '@/components/anki/utils/imageOcclusion';
import { resetProjectedFlashcardCache } from '@/services/liveCardProjector';

if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

const mocks = vi.hoisted(() => ({
  reveal: vi.fn(async () => ({ ok: true, outcome: 'revealed-in-open-pane', elapsedMs: 4 })),
  upsertAnchorEdges: vi.fn(async () => ({ upserted: 1, edges: [] })),
  pruneAnchorEdgesBySource: vi.fn(async () => ({ deleted: 0 })),
  upload: vi.fn(async () => ({ sourceId: 'vfs_uploaded_99', resourceHash: 'h', isNew: true })),
  saveAnkiCards: vi.fn(async ({ cards }: { cards: Array<{ id: string }> }) => ({
    savedIds: cards.map((c) => c.id),
    taskId: 't_io',
  })),
  invoke: vi.fn(async () => ({ enqueued: 1 })),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@/api/vfsFileApi', () => ({
  vfsFileApi: {
    upload: mocks.upload,
    getContent: vi.fn(async () => ({ content: null, found: false })),
  },
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: mocks.saveAnkiCards,
    deleteAnkiCards: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    anchors: {
      reveal: mocks.reveal,
      upsertAnchorEdges: mocks.upsertAnchorEdges,
      pruneAnchorEdgesBySource: mocks.pruneAnchorEdgesBySource,
    },
  }),
}));

vi.mock('@/i18n', async () => ({
  default: (await import('../../../../../tests/ct/mocks/react-i18next')).i18n,
}));

import { ImageOcclusionCardView } from '../ImageOcclusionCardView';
import { ImageOcclusionBuilderModal } from '../ImageOcclusionBuilderModal';

const sampleSpec: OcclusionSpec = {
  imageRef: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  boxes: [
    { x: 0.1, y: 0.15, w: 0.25, h: 0.15, label: '海马体', clozeIndex: 1 },
    { x: 0.55, y: 0.4, w: 0.25, h: 0.18, label: '杏仁核', clozeIndex: 2 },
  ],
};

describe('ImageOcclusionCardView & ImageOcclusionBuilderModal', () => {
  beforeEach(() => {
    resetProjectedFlashcardCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('masks ONLY targetClozeIndex on Front in hide-one mode and masks ALL boxes on Front in hide-all mode', () => {
    const { container, rerender } = render(
      <ImageOcclusionCardView
        spec={sampleSpec}
        side="front"
        mode="hide-one"
        targetClozeIndex={1}
        imageSrc={sampleSpec.imageRef}
      />,
    );

    const box1HideOne = container.querySelector('[data-cloze-index="1"]')!;
    const box2HideOne = container.querySelector('[data-cloze-index="2"]')!;
    expect(box1HideOne.getAttribute('data-mask-role')).toBe('target');
    expect(box1HideOne.getAttribute('data-masked')).toBe('true');
    expect(box2HideOne.getAttribute('data-mask-role')).toBe('sibling');
    expect(box2HideOne.getAttribute('data-masked')).toBe('false');

    rerender(
      <ImageOcclusionCardView
        spec={sampleSpec}
        side="front"
        mode="hide-all"
        targetClozeIndex={1}
        imageSrc={sampleSpec.imageRef}
      />,
    );

    const box1HideAll = container.querySelector('[data-cloze-index="1"]')!;
    const box2HideAll = container.querySelector('[data-cloze-index="2"]')!;
    expect(box1HideAll.getAttribute('data-mask-role')).toBe('target');
    expect(box1HideAll.getAttribute('data-masked')).toBe('true');
    expect(box2HideAll.getAttribute('data-mask-role')).toBe('sibling');
    expect(box2HideAll.getAttribute('data-masked')).toBe('true');
  });

  it('reveals target answer + extraNote on Back and jumps to source anchor on 1-click pill', () => {
    const anchorUri = 'ds-anchor://v1/pdf/pdf_neuro?page=88';
    render(
      <ImageOcclusionCardView
        spec={sampleSpec}
        side="back"
        mode="hide-all"
        targetClozeIndex={2}
        imageSrc={sampleSpec.imageRef}
        extraNote="负责情绪记忆编码"
        sourceAnchorUri={anchorUri}
      />,
    );

    const revealedTarget = screen.getByTestId('occlusion-revealed-target');
    expect(revealedTarget.getAttribute('data-cloze-index')).toBe('2');
    expect(revealedTarget.getAttribute('data-masked')).toBe('false');

    const caption = screen.getByTestId('occlusion-answer-caption');
    expect(caption.textContent).toContain('杏仁核');
    expect(caption.textContent).toContain('负责情绪记忆编码');

    const sourceBtn = screen.getByTestId('occlusion-reveal-source');
    expect(sourceBtn.innerHTML).toContain('font-mono');
    expect(sourceBtn.innerHTML).toContain('tabular-nums');
    expect(sourceBtn.textContent).toContain('p.88');

    fireEvent.click(sourceBtn);
    expect(mocks.reveal).toHaveBeenCalledWith(anchorUri, {
      splitIfClosed: true,
      pulse: true,
    });
  });

  it('ignores accidental < 8px micro-clicks, supports Escape / right-click mask deletion, and saves via VFS upload', async () => {
    render(
      <ImageOcclusionBuilderModal
        open={true}
        onOpenChange={vi.fn()}
        initialDetail={{
          imageDataUrl: sampleSpec.imageRef,
          naturalWidth: 800,
          naturalHeight: 600,
          sourceAnchor: { kind: 'pdf', resourceId: 'pdf_neuro', page: 88 },
          sourceTitle: '神经科学导论',
        }}
      />,
    );

    const svgStage = await screen.findByTestId('occlusion-svg-stage');
    vi.spyOn(svgStage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));

    // 1. Accidental tiny click (4px x 3px < 8px) -> ignored!
    fireEvent.pointerDown(svgStage, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svgStage, { clientX: 104, clientY: 103 });
    fireEvent.pointerUp(svgStage, { clientX: 104, clientY: 103 });
    expect(screen.queryByTestId('occlusion-draft-box-1')).toBeNull();

    // 2. Valid drag (160px x 120px = 20% x 20%) -> creates box #1
    fireEvent.pointerDown(svgStage, { button: 0, clientX: 80, clientY: 60 });
    fireEvent.pointerMove(svgStage, { clientX: 240, clientY: 180 });
    fireEvent.pointerUp(svgStage, { clientX: 240, clientY: 180 });
    expect(screen.getByTestId('occlusion-draft-box-1')).toBeTruthy();

    // 3. Draw second box #2, then press Escape -> deletes selected box #2 without closing modal!
    fireEvent.pointerDown(svgStage, { button: 0, clientX: 320, clientY: 200 });
    fireEvent.pointerMove(svgStage, { clientX: 520, clientY: 340 });
    fireEvent.pointerUp(svgStage, { clientX: 520, clientY: 340 });
    expect(screen.getByTestId('occlusion-draft-box-2')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('occlusion-draft-box-2')).toBeNull();
    expect(screen.getByTestId('occlusion-draft-box-1')).toBeTruthy();

    // 4. Draw another box #2 and right-click contextMenu -> deletes it cleanly!
    fireEvent.pointerDown(svgStage, { button: 0, clientX: 350, clientY: 220 });
    fireEvent.pointerMove(svgStage, { clientX: 550, clientY: 360 });
    fireEvent.pointerUp(svgStage, { clientX: 550, clientY: 360 });
    fireEvent.contextMenu(screen.getByTestId('occlusion-draft-box-2'));
    expect(screen.queryByTestId('occlusion-draft-box-2')).toBeNull();

    // 5. Switch mode to hide-all and save -> uploads via vfsFileApi.upload and saves compiled card
    fireEvent.click(screen.getByTestId('occlusion-mode-hide-all'));
    fireEvent.click(screen.getByTestId('occlusion-save-btn'));

    await waitFor(() => expect(mocks.saveAnkiCards).toHaveBeenCalledTimes(1));
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.saveAnkiCards.mock.calls[0][0].cards[0].images).toEqual(['vfs://vfs_uploaded_99']);
  });

  it('clamps inverted/outside drags and never deletes a mask while typing or composing', async () => {
    render(<ImageOcclusionBuilderModal open initialDetail={{ imageDataUrl: sampleSpec.imageRef }} />);
    const stage = await screen.findByTestId('occlusion-svg-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    fireEvent.pointerDown(stage, { clientX: 799, clientY: 100 });
    fireEvent.pointerUp(stage, { clientX: 1000, clientY: 200 });
    expect(screen.queryByTestId('occlusion-draft-box-1')).toBeNull();
    fireEvent.pointerDown(stage, { clientX: 900, clientY: 700 });
    fireEvent.pointerUp(stage, { clientX: 600, clientY: 400 });
    const box = screen.getByTestId('occlusion-draft-box-1').querySelector('rect')!;
    expect(Number(box.getAttribute('x'))).toBe(750);
    expect(Number(box.getAttribute('x')) + Number(box.getAttribute('width'))).toBe(1000);
    const input = screen.getByTestId('occlusion-box-label-input');
    for (const key of ['Delete', 'Backspace', 'Escape']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(document, { key: 'Delete', isComposing: true });
    fireEvent.keyDown(document, { key: 'Backspace', keyCode: 229 });
    expect(screen.getByTestId('occlusion-draft-box-1')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Delete' });
    expect(screen.queryByTestId('occlusion-draft-box-1')).toBeNull();
  });

  it('ignores a previous session FileReader completion after close and reopen', async () => {
    const readers: Array<{ onload: (() => void) | null; result: string | null }> = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { readers.push(this); }
    }
    vi.stubGlobal('FileReader', DeferredReader);
    try {
      const { rerender } = render(<ImageOcclusionBuilderModal open initialDetail={{ imageBlob: new Blob(['a'], { type: 'image/png' }) }} />);
      rerender(<ImageOcclusionBuilderModal open={false} />);
      rerender(<ImageOcclusionBuilderModal open initialDetail={{ imageDataUrl: sampleSpec.imageRef }} />);
      readers[0].result = 'data:image/png;base64,b2xk';
      readers[0].onload?.();
      await waitFor(() => expect(document.querySelector('img')?.getAttribute('src')).toBe(sampleSpec.imageRef));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
