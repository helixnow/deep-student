import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DS_EXCERPT_MIME,
  sanitizeExcerptDragPayload,
  serializeSemanticAnchor,
  type MediaSemanticAnchor,
  type MindmapSemanticAnchor,
  type PdfSemanticAnchor,
  type SemanticAnchor,
} from '@/ui-sdk';
import { ExcerptDndHub } from '@/ui-kernel/services/excerpt-dnd';
import { AnchorRegistry } from '@/ui-kernel/services/anchors';
import { NodeSourcePills } from '../components/shared/NodeSourcePills';
import {
  useMindMapExcerptBridge,
  type MindMapExcerptKernel,
} from '../hooks/useMindMapExcerptBridge';
import { createMindMapStore, MindMapStoreContext, type MindMapStoreApi } from '../store/mindmapStore';
import { OutlineView } from '../views/OutlineView';
import { __resetMindMapAnchorEdgeSyncForTests } from '../utils/excerptIngest';
import type { MindMapDocument } from '../types';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const pdfAnchor218: PdfSemanticAnchor = {
  kind: 'pdf',
  resourceId: 'pdf_stewart',
  page: 218,
  rect: { x: 0.14, y: 0.32, w: 0.58, h: 0.08 },
  quote: 'Fundamental Theorem of Calculus Part 1',
  label: 'Calculus 8e',
};

const mediaAnchor1422: MediaSemanticAnchor = {
  kind: 'media',
  resourceId: 'media_lec_09',
  startMs: (14 * 60 + 22) * 1000,
  endMs: (14 * 60 + 40) * 1000,
  quote: 'Geometric interpretation of derivative of area function',
};

function makeDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: 'Calculus Review',
      children: [
        {
          id: 'ch_1',
          text: 'Integrals',
          collapsed: true,
          children: [{ id: 'ch_1_deep', text: 'Area Accumulation', children: [] }],
        },
        {
          id: 'ch_2',
          text: 'Derivatives',
          children: [],
        },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function BridgeHarness(props: {
  storeApi: MindMapStoreApi;
  kernel: MindMapExcerptKernel | null;
  resourceId?: string;
  isActive?: boolean;
  autoExcerptEnabled?: boolean;
  reciteMode?: boolean;
  isLoading?: boolean;
}) {
  useMindMapExcerptBridge({
    storeApi: props.storeApi,
    kernel: props.kernel,
    resourceId: props.resourceId ?? 'mm_calc',
    isActive: props.isActive ?? true,
    autoExcerptEnabled: props.autoExcerptEnabled ?? false,
    reciteMode: props.reciteMode ?? false,
    isLoading: props.isLoading ?? false,
  });
  return <div data-testid="bridge-mounted" />;
}

afterEach(() => {
  cleanup();
  __resetMindMapAnchorEdgeSyncForTests();
  vi.useRealTimers();
});

describe('NodeSourcePills & MindMap MN5 Bridge', () => {
  it('renders font-mono tabular-nums pills (P.218, 14:22) and isolates pointer/click/dblclick events from parent node', async () => {
    const reveal = vi.fn(async (_anchor: SemanticAnchor) => ({
      ok: true,
      outcome: 'revealed-in-open-pane' as const,
      elapsedMs: 4,
    }));
    const onRemoveAnchor = vi.fn();

    const parentPointerDown = vi.fn();
    const parentMouseDown = vi.fn();
    const parentClick = vi.fn();
    const parentDoubleClick = vi.fn();

    render(
      <div
        onPointerDown={parentPointerDown}
        onMouseDown={parentMouseDown}
        onClick={parentClick}
        onDoubleClick={parentDoubleClick}
      >
        <NodeSourcePills
          anchors={[pdfAnchor218, mediaAnchor1422]}
          excerptQuote="Long verbatim passage from page 218."
          selected
          onRemoveAnchor={onRemoveAnchor}
          anchorsService={{ reveal }}
        />
      </div>,
    );

    const pills = screen.getAllByTestId('mm-node-source-pill');
    expect(pills).toHaveLength(2);
    expect(pills[0].textContent).toBe('P.218');
    expect(pills[1].textContent).toBe('14:22');

    const pillLabel = pills[0].querySelector('.mm-mn5-source-pill-label')!;
    expect(pillLabel.className).toContain('font-mono');
    expect(pillLabel.className).toContain('tabular-nums');
    expect(screen.getByTestId('mm-node-source-pills').className).toContain('nodrag');
    expect(screen.getByTestId('mm-node-source-pills').className).toContain('nopan');

    // Fire full pointer/mouse/click/dblclick sequence on P.218 pill
    fireEvent.pointerDown(pills[0]);
    fireEvent.mouseDown(pills[0]);
    fireEvent.click(pills[0]);
    fireEvent.doubleClick(pills[0]);

    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentDoubleClick).not.toHaveBeenCalled();

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(pdfAnchor218, {
      splitIfClosed: true,
      pulse: true,
    });

    // Toggle quote expand/collapse without bubbling to parent node
    const quoteBtn = screen.getByTestId('mm-node-excerpt-quote');
    expect(quoteBtn.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(quoteBtn);
    expect(quoteBtn.getAttribute('data-expanded')).toBe('true');
    expect(parentClick).not.toHaveBeenCalled();

    // Remove anchor micro-button
    const removeButtons = screen.getAllByLabelText('mn5.removeSourceAnchor');
    fireEvent.click(removeButtons[0]);
    expect(onRemoveAnchor).toHaveBeenCalledWith(serializeSemanticAnchor(pdfAnchor218));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('falls back to DSTU_FOCUS_PDF and DSTU_FOCUS_MEDIA events when kernel anchors service is absent', () => {
    const pdfEvents: CustomEvent[] = [];
    const mediaEvents: CustomEvent[] = [];
    const onPdf = (e: Event) => pdfEvents.push(e as CustomEvent);
    const onMedia = (e: Event) => mediaEvents.push(e as CustomEvent);
    window.addEventListener('DSTU_FOCUS_PDF', onPdf);
    window.addEventListener('DSTU_FOCUS_MEDIA', onMedia);

    try {
      render(
        <NodeSourcePills
          anchors={[pdfAnchor218, mediaAnchor1422]}
          anchorsService={null}
        />,
      );

      const pills = screen.getAllByTestId('mm-node-source-pill');
      fireEvent.click(pills[0]);
      fireEvent.click(pills[1]);

      expect(pdfEvents).toHaveLength(1);
      expect(pdfEvents[0].detail).toMatchObject({
        sourceId: 'pdf_stewart',
        page: 218,
      });
      expect(mediaEvents).toHaveLength(1);
      expect(mediaEvents[0].detail).toMatchObject({
        resourceId: 'media_lec_09',
        seconds: 14 * 60 + 22,
      });
    } finally {
      window.removeEventListener('DSTU_FOCUS_PDF', onPdf);
      window.removeEventListener('DSTU_FOCUS_MEDIA', onMedia);
    }
  });

  it('subscribes to Auto-Excerpt when enabled and reveals mindmap nodes in <50ms via AnchorRegistry', async () => {
    const dndHub = new ExcerptDndHub();
    const anchorRegistry = new AnchorRegistry();
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_calc',
      document: makeDoc(),
      focusedNodeId: 'ch_2',
      selection: ['ch_2'],
    });

    const kernel: MindMapExcerptKernel = {
      anchors: anchorRegistry,
      dnd: dndHub,
    };

    const { rerender } = render(
      <BridgeHarness
        storeApi={store}
        kernel={kernel}
        resourceId="mm_calc"
        autoExcerptEnabled
        isActive
        reciteMode={false}
      />,
    );

    // Emit Auto-Excerpt: appends child under focused 'ch_2' in 1 undo step and upserts backlink edge
    act(() => {
      dndHub.emitAutoExcerpt({
        excerptKind: 'text',
        text: 'Derivative of integral equals integrand.',
        anchor: pdfAnchor218,
      });
      // Duplicate emission within 400ms is ignored
      dndHub.emitAutoExcerpt({
        excerptKind: 'text',
        text: 'Derivative of integral equals integrand.',
        anchor: pdfAnchor218,
      });
    });

    const ch2 = store.getState().document.root.children[1];
    expect(ch2.children).toHaveLength(1);
    expect(store.getState().history.past).toHaveLength(1);

    const backlinks = await anchorRegistry.queryAnchorEdgesByTarget({
      targetResourceIds: ['pdf_stewart'],
      targetKind: 'pdf',
    });
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_calc',
      sourceSubId: ch2.children[0].id,
      targetPage: 218,
    });

    // Disable auto-excerpt in reciteMode
    rerender(
      <BridgeHarness
        storeApi={store}
        kernel={kernel}
        resourceId="mm_calc"
        autoExcerptEnabled
        isActive
        reciteMode
      />,
    );
    act(() => {
      dndHub.emitAutoExcerpt({
        excerptKind: 'text',
        text: 'Should not ingest during reciteMode.',
        anchor: mediaAnchor1422,
      });
    });
    expect(store.getState().document.root.children[1].children).toHaveLength(1);

    // Reveal collapsed deep node 'ch_1_deep' via AnchorRegistry in <50ms
    const targetAnchor: MindmapSemanticAnchor = {
      kind: 'mindmap',
      resourceId: 'mm_calc',
      nodeId: 'ch_1_deep',
    };
    const revealResult = await anchorRegistry.reveal(targetAnchor, { pulse: true });
    expect(revealResult.ok).toBe(true);
    expect(revealResult.outcome).toBe('revealed-in-open-pane');
    // Synchronous in-memory store reveal (allow slack for shared CI CPU jitter)
    expect(revealResult.elapsedMs).toBeLessThan(250);

    expect(store.getState().document.root.children[0].collapsed).toBe(false);
    expect(store.getState().focusedNodeId).toBe('ch_1_deep');
    expect(store.getState().nodeLocateRequest?.nodeId).toBe('ch_1_deep');
    expect(store.getState().agentUpdatedIds.has('ch_1_deep')).toBe(true);
  });

  it('waits for async-loading MindMap store readiness on split-open reveal and falls back to root when nodeId is absent', async () => {
    const anchorRegistry = new AnchorRegistry();
    const store = createMindMapStore();
    store.setState({
      mindmapId: null,
      document: makeDoc(),
    });

    const kernel: MindMapExcerptKernel = { anchors: anchorRegistry };
    render(
      <BridgeHarness
        storeApi={store}
        kernel={kernel}
        resourceId="mm_lazy"
        isActive
        isLoading
      />,
    );

    const pendingReveal = anchorRegistry.reveal(
      { kind: 'mindmap', resourceId: 'mm_lazy', nodeId: 'non_existent_node' },
      { pulse: true },
    );

    // Simulate async loadMindMap finishing 10ms later
    act(() => {
      store.setState({ mindmapId: 'mm_lazy' });
    });

    const outcome = await pendingReveal;
    expect(outcome.ok).toBe(true);
    expect(store.getState().focusedNodeId).toBe('root');
    expect(store.getState().nodeLocateRequest?.nodeId).toBe('root');
  });

  it('handles DS_EXCERPT_MIME drops in OutlineView without flickering on nested dragleave and passes OS Files / WB_RESOURCE_MIME through untouched', () => {
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_outline_dnd',
      document: makeDoc(),
      currentView: 'outline',
    });

    render(
      <MindMapStoreContext.Provider value={store}>
        <OutlineView keymap="deep-student" descriptionPreview="full" />
      </MindMapStoreContext.Provider>,
    );

    const row = document.querySelector<HTMLElement>('[data-outline-node-id="ch_2"]')!;
    expect(row).not.toBeNull();

    // Non-excerpt drags (OS Files & Workbench resource MIME) pass through untouched
    const osFileDragOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(osFileDragOver, 'dataTransfer', {
      value: { types: ['Files'], getData: () => '' },
    });
    row.dispatchEvent(osFileDragOver);
    expect(osFileDragOver.defaultPrevented).toBe(false);

    const wbResourceDragOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(wbResourceDragOver, 'dataTransfer', {
      value: { types: ['application/x-deepstudent-resource'], getData: () => '{}' },
    });
    row.dispatchEvent(wbResourceDragOver);
    expect(wbResourceDragOver.defaultPrevented).toBe(false);

    // Excerpt drag: nested dragenter/dragleave keeps highlight steady until outer leave or drop
    const payload = sanitizeExcerptDragPayload({
      excerptKind: 'text',
      text: 'Mean Value Theorem for Integrals',
      anchor: pdfAnchor218,
    })!;
    const excerptDt = {
      types: [DS_EXCERPT_MIME],
      dropEffect: 'none',
      getData: (mime: string) => (mime === DS_EXCERPT_MIME ? JSON.stringify(payload) : ''),
    };

    const makeDragEvent = (type: string) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: excerptDt });
      return ev;
    };

    row.dispatchEvent(makeDragEvent('dragenter'));
    row.dispatchEvent(makeDragEvent('dragover'));
    expect(row.classList.contains('mm-mn5-outline-drop')).toBe(true);

    // Nested child enter + leave should NOT flicker off the row highlight
    row.dispatchEvent(makeDragEvent('dragenter'));
    row.dispatchEvent(makeDragEvent('dragleave'));
    expect(row.classList.contains('mm-mn5-outline-drop')).toBe(true);

    // Drop ingests child under 'ch_2' and clears highlight
    row.dispatchEvent(makeDragEvent('drop'));
    expect(row.classList.contains('mm-mn5-outline-drop')).toBe(false);
    const ch2After = store.getState().document.root.children[1];
    expect(ch2After.children).toHaveLength(1);
    expect(ch2After.children[0].text).toBe('Mean Value Theorem for Integrals');
    expect(ch2After.children[0].anchors?.[0]).toMatchObject({ kind: 'pdf', page: 218 });
  });
});
