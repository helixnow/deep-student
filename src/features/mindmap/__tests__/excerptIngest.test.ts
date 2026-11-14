import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fnv1a64Hex,
  sanitizeExcerptDragPayload,
  serializeSemanticAnchor,
  type ExcerptDragPayload,
  type MediaSemanticAnchor,
  type PdfSemanticAnchor,
} from '@/ui-sdk';
import { createMindMapStore, MAX_MINDMAP_DEPTH } from '../store/mindmapStore';
import type { MindMapDocument, MindMapNode } from '../types';
import {
  __resetMindMapAnchorEdgeSyncForTests,
  buildMindMapAnchorEdgeId,
  collectMindMapAnchorEdgeInputs,
  computeBranchInsertIndex,
  createAutoExcerptDeduper,
  createExcerptDragDepthTracker,
  isScreenRectWithinViewportInset,
  registerMindMapAnchorEdgeSink,
  resolveAutoExcerptParent,
  syncMindMapAnchorEdges,
} from '../utils/excerptIngest';
import { findNodeById } from '../utils/node/find';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const pdfAnchor218: PdfSemanticAnchor = {
  kind: 'pdf',
  resourceId: 'pdf_linear_algebra',
  page: 218,
  rect: { x: 0.1, y: 0.25, w: 0.65, h: 0.09 },
  quote: 'Every symmetric real matrix can be diagonalized by an orthogonal matrix.',
  label: 'Linear Algebra Done Right',
};

const mediaAnchor: MediaSemanticAnchor = {
  kind: 'media',
  resourceId: 'vid_mit_1806',
  startMs: 862_000, // 14:22
  endMs: 875_000,
  quote: 'Orthogonal eigenvectors come from distinct eigenvalues of symmetric matrices.',
};

function makePayload(overrides: Partial<Parameters<typeof sanitizeExcerptDragPayload>[0]> = {}): ExcerptDragPayload {
  const payload = sanitizeExcerptDragPayload({
    excerptKind: 'text',
    text: 'Every symmetric real matrix can be diagonalized by an orthogonal matrix. In particular, all eigenvalues of a real symmetric matrix are real numbers and eigenspaces are mutually perpendicular.',
    anchor: pdfAnchor218,
    sourceTitle: 'Linear Algebra Done Right',
    ...overrides,
  });
  if (!payload) throw new Error('Expected valid ExcerptDragPayload');
  return payload;
}

function makeBaseDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: 'Spectral Theorem',
      children: [
        {
          id: 'b1',
          text: 'Real Symmetric Matrices',
          collapsed: true,
          children: [{ id: 'b1_leaf', text: 'Real eigenvalues', children: [] }],
        },
        {
          id: 'b2_blank',
          text: '   ',
          children: [],
        },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

describe('excerptIngest & store excerptSlice', () => {
  beforeEach(() => {
    __resetMindMapAnchorEdgeSyncForTests();
  });

  afterEach(() => {
    __resetMindMapAnchorEdgeSyncForTests();
    vi.useRealTimers();
  });

  it('ingests child excerpt, distills first sentence, stores full quote, expands parent, and pushes exactly ONE undo step', () => {
    const store = createMindMapStore();
    store.setState({ mindmapId: 'mm_spectral', document: makeBaseDoc(), isDirty: false });

    const payload = makePayload();
    const createdId = store.getState().ingestExcerpt(payload, {
      mode: 'child',
      targetNodeId: 'b1',
    });

    expect(createdId).toBeTruthy();
    const after = store.getState();
    expect(after.history.past).toHaveLength(1);
    expect(after.isDirty).toBe(true);
    expect(after.focusedNodeId).toBe(createdId);
    expect(after.agentEnteringIds.has(createdId!)).toBe(true);
    expect(after.excerptRevealRequest?.nodeId).toBe(createdId);

    const parent = findNodeById(after.document.root, 'b1')!;
    expect(parent.collapsed).toBe(false);

    const created = findNodeById(after.document.root, createdId!)!;
    expect(created.text).toBe(
      'Every symmetric real matrix can be diagonalized by an orthogonal matrix.',
    );
    expect(created.excerptQuote).toContain('eigenspaces are mutually perpendicular.');
    expect(created.anchors).toHaveLength(1);
    expect(created.anchors?.[0]).toMatchObject({ kind: 'pdf', page: 218 });

    // Single Cmd+Z atomic undo removes the entire excerpt node + anchors + quote in one step
    store.getState().undo();
    expect(findNodeById(store.getState().document.root, createdId!)).toBeNull();
    expect(findNodeById(store.getState().document.root, 'b1')?.collapsed).toBe(true);
  });

  it('supports Alt-merge mode (deduplicating anchors and appending excerptQuote) and auto-merges into blank leaf nodes', () => {
    const store = createMindMapStore();
    store.setState({ mindmapId: 'mm_merge', document: makeBaseDoc(), isDirty: false });

    // Dropping onto a blank non-root leaf in 'child' mode merges in place instead of leaving an empty parent
    const filledBlankId = store.getState().ingestExcerpt(makePayload(), {
      mode: 'child',
      targetNodeId: 'b2_blank',
    });
    expect(filledBlankId).toBe('b2_blank');
    const filledNode = findNodeById(store.getState().document.root, 'b2_blank')!;
    expect(filledNode.text).toBe(
      'Every symmetric real matrix can be diagonalized by an orthogonal matrix.',
    );
    expect(filledNode.anchors).toHaveLength(1);

    // Alt-dropping duplicate PDF anchor + new media anchor merges cleanly without duplicating P.218
    store.getState().ingestExcerpt(makePayload(), {
      mode: 'merge',
      targetNodeId: 'b2_blank',
    });
    expect(findNodeById(store.getState().document.root, 'b2_blank')!.anchors).toHaveLength(1);

    const mediaPayload = makePayload({
      excerptKind: 'transcript-cue',
      text: mediaAnchor.quote!,
      anchor: mediaAnchor,
      sourceTitle: 'MIT 18.06 Lecture 25',
    });
    store.getState().ingestExcerpt(mediaPayload, {
      mode: 'merge',
      targetNodeId: 'b2_blank',
    });

    const merged = findNodeById(store.getState().document.root, 'b2_blank')!;
    expect(merged.anchors).toHaveLength(2);
    expect(merged.excerptQuote).toContain(
      'Orthogonal eigenvectors come from distinct eigenvalues of symmetric matrices.',
    );
    expect(store.getState().history.past).toHaveLength(3);
  });

  it('supports branch insertion at computed flow slot index, region-image thumbnail attachment, and MAX_MINDMAP_DEPTH sibling fallback', () => {
    const store = createMindMapStore();
    store.setState({ mindmapId: 'mm_branch', document: makeBaseDoc(), isDirty: false });

    const slots = [
      { id: 'b1', x: 240, y: 100, width: 160, height: 36 },
      { id: 'b2_blank', x: 240, y: 260, width: 160, height: 36 },
    ];
    expect(computeBranchInsertIndex({ x: 260, y: 40 }, slots, 'y')).toBe(0);
    expect(computeBranchInsertIndex({ x: 260, y: 180 }, slots, 'y')).toBe(1);
    expect(computeBranchInsertIndex({ x: 260, y: 340 }, slots, 'y')).toBe(2);

    const regionPayload = makePayload({
      excerptKind: 'region-image',
      text: '',
      imageDataUrl: PNG_DATA_URL,
      sourceTitle: 'Proof Diagram',
    });
    const branchId = store.getState().ingestExcerpt(regionPayload, {
      mode: 'branch',
      insertIndex: 1,
    });

    expect(branchId).toBeTruthy();
    expect(store.getState().document.root.children[1].id).toBe(branchId);
    const regionNode = store.getState().document.root.children[1];
    expect(regionNode.text).toBe('Proof Diagram (P.218)');
    expect(regionNode.imageAssetId).toBe(`img_${fnv1a64Hex(PNG_DATA_URL)}`);
    expect(regionNode.images).toEqual([
      {
        id: `img_${fnv1a64Hex(PNG_DATA_URL)}`,
        src: PNG_DATA_URL,
        width: 220,
      },
    ]);

    // Build a chain down to MAX_MINDMAP_DEPTH - 1 and verify child drop falls back to sibling instead of dropping excerpt
    let deepCursor: MindMapNode = { id: 'd_0', text: 'root', children: [] };
    const deepRoot = deepCursor;
    for (let d = 1; d < MAX_MINDMAP_DEPTH; d += 1) {
      const next: MindMapNode = { id: `d_${d}`, text: `level ${d}`, children: [] };
      deepCursor.children.push(next);
      deepCursor = next;
    }
    store.setState({
      document: { version: '1.0', root: deepRoot, meta: { createdAt: '2026-01-01T00:00:00.000Z' } },
    });

    const fallbackId = store.getState().ingestExcerpt(makePayload({ text: 'At max depth' }), {
      mode: 'child',
      targetNodeId: `d_${MAX_MINDMAP_DEPTH - 1}`,
    });
    expect(fallbackId).toBeTruthy();
    const deepestParent = findNodeById(store.getState().document.root, `d_${MAX_MINDMAP_DEPTH - 2}`)!;
    expect(deepestParent.children.map((c) => c.id)).toEqual([
      `d_${MAX_MINDMAP_DEPTH - 1}`,
      fallbackId,
    ]);
  });

  it('resolves deterministic Auto-Excerpt targets, deduplicates within 400ms, and enforces viewport/drag smoothness invariants', () => {
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_auto',
      document: makeBaseDoc(),
      focusedNodeId: 'b1',
      selection: ['b1'],
    });

    // Consecutive auto-excerpts under 'b1' become siblings under 'b1' rather than nesting into a deep chain
    const firstAuto = store.getState().ingestAutoExcerpt(makePayload({ text: 'Excerpt One' }));
    const secondAuto = store.getState().ingestAutoExcerpt(makePayload({ text: 'Excerpt Two' }));
    const b1 = findNodeById(store.getState().document.root, 'b1')!;
    expect(b1.children.map((c) => c.id)).toEqual(['b1_leaf', firstAuto, secondAuto]);

    // Clearing selection still falls back to lastExcerptContext.parentId ('b1')
    store.setState({ focusedNodeId: null, selection: [] });
    expect(
      resolveAutoExcerptParent(store.getState().document.root, {
        focusedNodeId: null,
        selection: [],
        viewRootId: null,
        lastExcerptContext: store.getState().lastExcerptContext,
      }),
    ).toBe('b1');

    // Deleting 'b1' clears stale lastExcerptContext and falls back cleanly to root
    store.getState().deleteNode('b1');
    expect(store.getState().lastExcerptContext).toBeNull();
    const rootFallback = store.getState().ingestAutoExcerpt(makePayload({ text: 'Excerpt Root' }));
    expect(store.getState().document.root.children.some((c) => c.id === rootFallback)).toBe(true);

    // 400ms auto-excerpt deduper
    const isDup = createAutoExcerptDeduper(400);
    const sample = makePayload({ text: 'Bounce highlight' });
    expect(isDup(sample, 1_000)).toBe(false);
    expect(isDup(sample, 1_250)).toBe(true);
    expect(isDup(sample, 1_700)).toBe(false);

    // Depth-counted drag tracker never hits 0 on nested child transitions
    const tracker = createExcerptDragDepthTracker();
    expect(tracker.enter()).toBe(1);
    expect(tracker.enter()).toBe(2);
    expect(tracker.leave()).toBe(false);
    expect(tracker.leave()).toBe(true);

    // Viewport 12% inset check
    const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
    expect(
      isScreenRectWithinViewportInset({ left: 150, top: 120, right: 350, bottom: 180 }, viewport),
    ).toBe(true);
    expect(
      isScreenRectWithinViewportInset({ left: 40, top: 120, right: 240, bottom: 180 }, viewport),
    ).toBe(false);
  });

  it('emits deterministic edge_ FNV-1a IDs and reconciles upsertAnchorEdges + pruneAnchorEdgesBySource on ingest, delete, and undo', () => {
    const upsertAnchorEdges = vi.fn(async () => undefined);
    const pruneAnchorEdgesBySource = vi.fn(async () => undefined);
    const unregister = registerMindMapAnchorEdgeSink({
      upsertAnchorEdges,
      pruneAnchorEdgesBySource,
    });

    const store = createMindMapStore();
    store.setState({ mindmapId: 'mm_edges', document: makeBaseDoc() });

    const payload = makePayload();
    const nodeId = store.getState().ingestExcerpt(payload, {
      mode: 'child',
      targetNodeId: 'b1',
    })!;

    const expectedUri = serializeSemanticAnchor(pdfAnchor218);
    const expectedEdgeId = `edge_${fnv1a64Hex(`mindmap:mm_edges:${nodeId}:${expectedUri}`)}`;
    expect(buildMindMapAnchorEdgeId('mm_edges', nodeId, expectedUri)).toBe(expectedEdgeId);

    const collected = collectMindMapAnchorEdgeInputs(
      'mm_edges',
      store.getState().document.root,
      'space_math_01',
    );
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      edgeId: expectedEdgeId,
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_edges',
      sourceSubId: nodeId,
      sourceAnchor: {
        kind: 'mindmap',
        resourceId: 'mm_edges',
        nodeId,
      },
      targetAnchor: pdfAnchor218,
      studySpaceId: 'space_math_01',
    });

    // Immediate <16ms upsert on ingestExcerpt
    expect(upsertAnchorEdges).toHaveBeenCalledTimes(1);
    expect(upsertAnchorEdges).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ edgeId: expectedEdgeId })]),
    );

    // Deleting the excerpt node immediately prunes stale edges for mm_edges
    store.getState().deleteNode(nodeId);
    expect(pruneAnchorEdgesBySource).toHaveBeenCalledWith({
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_edges',
      keepEdgeIds: [],
    });

    // Undo restores the node and re-syncs its anchor edge; Redo prunes it again
    store.getState().undo();
    expect(pruneAnchorEdgesBySource).toHaveBeenLastCalledWith({
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_edges',
      keepEdgeIds: [expectedEdgeId],
    });

    // Calling syncMindMapAnchorEdges again with identical tree skips redundant IPC
    const callCountBefore = pruneAnchorEdgesBySource.mock.calls.length;
    syncMindMapAnchorEdges('mm_edges', store.getState().document.root);
    expect(pruneAnchorEdgesBySource).toHaveBeenCalledTimes(callCountBefore);

    unregister();
  });
});
