import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DS_EXCERPT_MIME,
  sanitizeExcerptDragPayload,
  type ExcerptDragPayload,
  type MediaSemanticAnchor,
  type PdfSemanticAnchor,
  type QbankSemanticAnchor,
} from '@/ui-sdk';
import { createMindMapStore, MindMapStoreContext } from '../store/mindmapStore';
import type { MindMapDocument } from '../types';
import { MindMapStagingTray } from '../components/mindmap/MindMapStagingTray';
import { SummaryBraceOverlay } from '../components/mindmap/SummaryBraceOverlay';
import { MindMapFormatBar } from '../components/toolbar/FormatBar';
import { NodeSourcePills } from '../components/shared/NodeSourcePills';
import { OutlineView } from '../views/OutlineView';
import {
  __resetMindMapAnchorEdgeSyncForTests,
  computeNodeDropZone,
  registerMindMapAnchorEdgeSink,
  resolveNodeBranchColors,
} from '../utils/excerptIngest';
import {
  computeSummaryBraceGeometry,
  resolveSiblingRangeForSummary,
} from '../utils/summaryBraces';
import {
  __resetMindMapCardProjectionForTests,
  buildMindMapFlashcardId,
  buildProjectedFlashcardPayload,
  registerMindMapCardProjectionSink,
  upsertProjectedFlashcard,
  removeProjectedFlashcard,
  type MindMapProjectedFlashcardPayload,
} from '../interop/mindmapCardProjection';
import { exportToJson } from '../utils/exporters';
import { importFromJson } from '../utils/importers';
import { findNodeById } from '../utils/node/find';
import { DARK_SAFE_PALETTE, DEFAULT_LIGHT_PALETTE } from '../styles/themes/palettes';
import '@/i18n';

const { invokeMock, saveAnkiCardsMock, deleteAnkiCardsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveAnkiCardsMock: vi.fn(),
  deleteAnkiCardsMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: saveAnkiCardsMock,
    deleteAnkiCards: deleteAnkiCardsMock,
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const PNG_KEYFRAME =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const pdfAnchorTheorem: PdfSemanticAnchor = {
  kind: 'pdf',
  resourceId: 'pdf_real_analysis',
  page: 142,
  rect: { x: 0.12, y: 0.22, w: 0.68, h: 0.11 },
  quote: 'Uniform convergence preserves continuity on compact metric spaces.',
  label: 'Rudin Principles',
};

const pdfAnchorFigure: PdfSemanticAnchor = {
  kind: 'pdf',
  resourceId: 'pdf_real_analysis',
  page: 145,
  rect: { x: 0.18, y: 0.4, w: 0.55, h: 0.25 },
  label: 'Rudin Principles',
};

const mediaAnchorCue: MediaSemanticAnchor = {
  kind: 'media',
  resourceId: 'media_analysis_lec12',
  startMs: 512_000, // 08:32
  endMs: 529_000, // 08:49
  quote: 'Watch the epsilon-tube shrink uniformly across the entire interval.',
  label: 'Analysis Lecture 12',
};

const qbankAnchor42: QbankSemanticAnchor = {
  kind: 'qbank',
  resourceId: 'qbank_midterm_2026',
  questionId: 'q_42',
  label: '2026 Analysis Midterm',
};

function makePayload(
  overrides: Partial<Parameters<typeof sanitizeExcerptDragPayload>[0]> = {},
): ExcerptDragPayload {
  const payload = sanitizeExcerptDragPayload({
    excerptKind: 'text',
    text: 'Uniform convergence preserves continuity on compact metric spaces. Counterexample: x^n on [0, 1] converges pointwise to a discontinuous limit.',
    anchor: pdfAnchorTheorem,
    sourceTitle: 'Rudin Principles',
    ...overrides,
  });
  if (!payload) throw new Error('Expected valid ExcerptDragPayload');
  return payload;
}

function makeConvergenceDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: 'Function Sequences',
      children: [
        {
          id: 'b_uniform',
          text: 'Uniform Convergence',
          children: [
            { id: 'u_def', text: 'Supremum norm goes to zero', children: [] },
            { id: 'u_cont', text: 'Preserves continuity', children: [] },
            { id: 'u_int', text: 'Swaps limit and integral', children: [] },
          ],
        },
        {
          id: 'b_pointwise',
          text: 'Pointwise Convergence',
          children: [{ id: 'p_ex', text: 'x^n on [0,1]', children: [] }],
        },
      ],
    },
    meta: { createdAt: '2026-03-01T00:00:00.000Z' },
  };
}

// Emoji regex check (surrogate pairs / pictographs) to verify strict zero-emoji rule
const EMOJI_RE = /\p{Extended_Pictographic}/u;

describe('C7 §3 MindMap MN5 Convergence Hub', () => {
  beforeEach(() => {
    __resetMindMapAnchorEdgeSyncForTests();
    __resetMindMapCardProjectionForTests();
    invokeMock.mockReset();
    saveAnkiCardsMock.mockReset();
    deleteAnkiCardsMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    __resetMindMapAnchorEdgeSyncForTests();
    __resetMindMapCardProjectionForTests();
  });

  it('1) Staging Tray: stages excerpts in staging mode or unselected autoExcerpt, persists in JSON, and supports single-step Cmd+Z undo on commit/drag/remove', () => {
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_hub_staging',
      document: makeConvergenceDoc(),
      focusedNodeId: null,
      selection: [],
      lastExcerptContext: null,
      viewRootId: null,
    });

    // Unselected autoExcerpt lands zero-friction in stagingExcerpts[] and opens tray
    const firstStagedId = store.getState().ingestAutoExcerpt(makePayload());
    expect(firstStagedId).toMatch(/^stg_/);
    expect(store.getState().stagingTrayOpen).toBe(true);
    expect(store.getState().document.stagingExcerpts).toHaveLength(1);
    expect(store.getState().history.past).toHaveLength(1);

    // Even when a node IS focused, switching intakeMode to 'staging' routes autoExcerpt into stagingExcerpts[]
    store.setState({ focusedNodeId: 'b_uniform', selection: ['b_uniform'] });
    store.getState().setExcerptIntakeMode('staging');
    const secondStagedId = store.getState().ingestAutoExcerpt(
      makePayload({
        excerptKind: 'transcript-cue',
        text: mediaAnchorCue.quote!,
        anchor: mediaAnchorCue,
        imageDataUrl: PNG_KEYFRAME,
      }),
    );
    expect(secondStagedId).toMatch(/^stg_/);
    expect(store.getState().document.stagingExcerpts).toHaveLength(2);

    // Persists cleanly with MindMapDocument JSON round-trip
    const roundTripped = importFromJson(exportToJson(store.getState().document));
    expect(roundTripped.stagingExcerpts).toHaveLength(2);
    expect(roundTripped.stagingExcerpts?.[0].id).toBe(firstStagedId);

    // Render MindMapStagingTray and verify 1px hairline, tabular-nums counter, zero emojis, and [Attach to Selected]
    const { container } = render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapStagingTray />
      </MindMapStoreContext.Provider>,
    );
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
    const countBadge = screen.getByTestId('mm-staging-count');
    expect(countBadge.textContent).toBe('2');
    expect(countBadge.className).toContain('font-mono');
    expect(countBadge.className).toContain('tabular-nums');
    expect(screen.getByTestId('mm-staging-tray').className).toContain('border-border/35');

    // Click [Attach to Selected] on first card -> moves from stagingExcerpts into 'b_uniform' in ONE undo step
    const historyBeforeCommit = store.getState().history.past.length;
    fireEvent.click(screen.getAllByTestId('mm-staging-commit-btn')[0]);

    expect(store.getState().document.stagingExcerpts).toHaveLength(1);
    const bUniform = findNodeById(store.getState().document.root, 'b_uniform')!;
    expect(bUniform.children).toHaveLength(4);
    expect(store.getState().history.past).toHaveLength(historyBeforeCommit + 1);

    // Single Cmd+Z restores BOTH the staged card AND removes the created child node!
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().document.stagingExcerpts).toHaveLength(2);
    expect(findNodeById(store.getState().document.root, 'b_uniform')!.children).toHaveLength(3);

    // Drag second card from MindMapStagingTray onto OutlineView row -> atomic single-step Cmd+Z undo!
    cleanup();
    render(
      <MindMapStoreContext.Provider value={store}>
        <div>
          <MindMapStagingTray />
          <OutlineView keymap="deep-student" descriptionPreview="full" />
        </div>
      </MindMapStoreContext.Provider>,
    );

    const stagedCard = screen.getAllByTestId('mm-staging-card')[1];
    const dtData = new Map<string, string>();
    const mockDt = {
      types: [DS_EXCERPT_MIME],
      effectAllowed: 'all',
      dropEffect: 'copy',
      setData: (k: string, v: string) => dtData.set(k, v),
      getData: (k: string) => dtData.get(k) ?? '',
    };
    fireEvent.dragStart(stagedCard, { dataTransfer: mockDt });

    const outlineRow = document.querySelector<HTMLElement>('[data-outline-node-id="b_pointwise"]')!;
    const dropEv = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, 'dataTransfer', { value: mockDt });
    const historyBeforeDragDrop = store.getState().history.past.length;
    act(() => {
      outlineRow.dispatchEvent(dropEv);
    });

    expect(store.getState().document.stagingExcerpts).toHaveLength(1);
    expect(findNodeById(store.getState().document.root, 'b_pointwise')!.children).toHaveLength(2);
    expect(store.getState().history.past).toHaveLength(historyBeforeDragDrop + 1);

    // Single Cmd+Z restores dragged card back to tray and removes child from 'b_pointwise'
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().document.stagingExcerpts).toHaveLength(2);
    expect(findNodeById(store.getState().document.root, 'b_pointwise')!.children).toHaveLength(1);

    // Remove single item -> single Cmd+Z undo
    const historyBeforeRemove = store.getState().history.past.length;
    fireEvent.click(screen.getAllByTestId('mm-staging-remove-btn')[0]);
    expect(store.getState().document.stagingExcerpts).toHaveLength(1);
    expect(store.getState().history.past).toHaveLength(historyBeforeRemove + 1);
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().document.stagingExcerpts).toHaveLength(2);
  });

  it('2) Compound Excerpt Card & Dual Hit-Zone Drop UX: merges multi-modal excerpts (text + image + media cue + QBank ref), supports cardNote, and distinguishes center 60% Merge vs outer-edge Child drop in 1 undo step', () => {
    // Pure Dual Hit-Zone geometry + hysteresis verification
    const box = { left: 100, top: 200, width: 200, height: 100 };
    // Center 60% body -> 'merge'
    expect(computeNodeDropZone(box, { clientX: 200, clientY: 250 })).toBe('merge');
    expect(computeNodeDropZone(box, { clientX: 145, clientY: 250 })).toBe('merge');
    // Outer right / left edge -> 'child'
    expect(computeNodeDropZone(box, { clientX: 285, clientY: 250 })).toBe('child');
    expect(computeNodeDropZone(box, { clientX: 110, clientY: 250 })).toBe('child');
    // Hysteresis at right boundary x = 260 (relX = 0.80):
    // Staying at relX = 0.81 keeps 'merge' when prevZone === 'merge', whereas relX = 0.79 keeps 'child' when prevZone === 'child'
    expect(
      computeNodeDropZone(box, { clientX: 262, clientY: 250 }, { prevZone: 'merge' }),
    ).toBe('merge');
    expect(
      computeNodeDropZone(box, { clientX: 258, clientY: 250 }, { prevZone: 'child' }),
    ).toBe('child');

    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_compound',
      document: makeConvergenceDoc(),
    });

    render(
      <MindMapStoreContext.Provider value={store}>
        <OutlineView keymap="deep-student" descriptionPreview="full" />
      </MindMapStoreContext.Provider>,
    );

    const row = document.querySelector<HTMLElement>('[data-outline-node-id="u_cont"]')!;
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      width: 300,
      height: 40,
      right: 400,
      bottom: 140,
      toJSON: () => ({}),
    });

    const dispatchMeasuredDrop = (payload: ExcerptDragPayload, clientX: number, clientY: number) => {
      const dt = {
        types: [DS_EXCERPT_MIME],
        dropEffect: 'copy',
        getData: (mime: string) => (mime === DS_EXCERPT_MIME ? JSON.stringify(payload) : ''),
      };
      const over = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(over, 'dataTransfer', { value: dt });
      row.dispatchEvent(over);

      const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(drop, 'dataTransfer', { value: dt });
      row.dispatchEvent(drop);
    };

    // 1. Center 60% drop (clientX = 250 -> relX = 0.50): merges PDF quote into 'u_cont'
    act(() => {
      dispatchMeasuredDrop(makePayload(), 250, 120);
    });
    expect(store.getState().history.past).toHaveLength(1);
    expect(findNodeById(store.getState().document.root, 'u_cont')!.children).toHaveLength(0);
    expect(findNodeById(store.getState().document.root, 'u_cont')!.excerpts).toHaveLength(1);

    // 2. Center 60% drop: merge cropped PDF figure
    act(() => {
      dispatchMeasuredDrop(
        makePayload({
          excerptKind: 'region-image',
          text: 'Uniform epsilon band diagram',
          imageDataUrl: PNG_KEYFRAME,
          anchor: pdfAnchorFigure,
        }),
        240,
        120,
      );
    });

    // 3. Center 60% drop: merge Media [startMs, endMs] cue + keyframe thumbnail
    act(() => {
      dispatchMeasuredDrop(
        makePayload({
          excerptKind: 'transcript-cue',
          text: mediaAnchorCue.quote!,
          imageDataUrl: PNG_KEYFRAME,
          anchor: mediaAnchorCue,
        }),
        255,
        120,
      );
    });

    // 4. Center 60% drop: merge QBank question ref
    act(() => {
      dispatchMeasuredDrop(
        makePayload({
          excerptKind: 'text',
          text: 'Prove or disprove: uniform limit of bounded functions is bounded.',
          anchor: qbankAnchor42,
        }),
        260,
        120,
      );
    });

    const compoundNode = findNodeById(store.getState().document.root, 'u_cont')!;
    expect(compoundNode.excerpts?.map((s) => s.kind)).toEqual(['text', 'image', 'media', 'qbank']);
    expect(compoundNode.anchors).toHaveLength(4);
    expect(compoundNode.isExpandedCard).toBe(true);

    // 5. Outer right zone drop (clientX = 385 -> relX = 0.95): creates a NEW child card in 1 atomic undo step!
    const historyBeforeChild = store.getState().history.past.length;
    act(() => {
      dispatchMeasuredDrop(
        makePayload({ text: 'Dini Theorem special case on monotone sequences.' }),
        385,
        120,
      );
    });
    expect(store.getState().history.past).toHaveLength(historyBeforeChild + 1);
    expect(findNodeById(store.getState().document.root, 'u_cont')!.children).toHaveLength(1);

    // Add personal synthesis cardNote and render compound NodeSourcePills directly
    act(() => {
      store.getState().setNodeCardNote('u_cont', 'Key contrast: compact domain + uniform sup-norm.');
    });
    const updatedCompound = findNodeById(store.getState().document.root, 'u_cont')!;

    cleanup();
    render(
      <NodeSourcePills
        anchors={updatedCompound.anchors ?? []}
        excerpts={updatedCompound.excerpts}
        cardNote={updatedCompound.cardNote}
        isExpandedCard={updatedCompound.isExpandedCard}
        selected
        onRemoveExcerptSlot={(slotId) => store.getState().removeNodeExcerptSlot('u_cont', slotId)}
        onCardNoteChange={(note) => store.getState().setNodeCardNote('u_cont', note)}
      />,
    );

    expect(screen.getAllByTestId('mm-compound-slot')).toHaveLength(4);
    expect(screen.getByTestId('mm-node-card-note').textContent).toContain(
      'Key contrast: compact domain + uniform sup-norm.',
    );
    expect(screen.getByText('08:32-08:49')).toBeTruthy();
    expect(screen.getByText('Q.q_42')).toBeTruthy();

    // Removing one slot removes both the slot and its anchor in a single undo step
    fireEvent.click(screen.getAllByTestId('mm-remove-slot-btn')[3]);
    expect(findNodeById(store.getState().document.root, 'u_cont')!.excerpts).toHaveLength(3);
    expect(findNodeById(store.getState().document.root, 'u_cont')!.anchors).toHaveLength(3);
  });

  it('3) Summary Braces `}`: enables action only for 2+ siblings, computes descendant-safe SVG curly brace geometry, supports inline label editing, and prunes on node deletion', () => {
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_summaries',
      document: makeConvergenceDoc(),
    });

    // Cross-parent selection ('u_def' under 'b_uniform' and 'p_ex' under 'b_pointwise') is rejected
    expect(
      resolveSiblingRangeForSummary(store.getState().document.root, ['u_def', 'p_ex']),
    ).toBeNull();

    // 2+ siblings under 'b_uniform' resolves exact range
    const range = resolveSiblingRangeForSummary(store.getState().document.root, [
      'u_int',
      'u_def',
    ]);
    expect(range).toEqual({
      parentId: 'b_uniform',
      startChildId: 'u_def',
      endChildId: 'u_int',
      startIndex: 0,
      endIndex: 2,
      coveredChildIds: ['u_def', 'u_cont', 'u_int'],
    });

    // Selecting 2 siblings renders "Add Summary }" in MindMapFormatBar and adds summary in 1 undo step
    store.setState({ focusedNodeId: 'u_def', selection: ['u_def', 'u_int'] });
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapFormatBar />
      </MindMapStoreContext.Provider>,
    );

    const addSummaryBtn = screen.getByTestId('mm-format-add-summary-brace');
    fireEvent.click(addSummaryBtn);

    expect(store.getState().document.summaries).toHaveLength(1);
    expect(store.getState().history.past).toHaveLength(1);
    const summary = store.getState().document.summaries![0];
    expect(summary).toMatchObject({
      parentId: 'b_uniform',
      startChildId: 'u_def',
      endChildId: 'u_int',
    });

    // Verify SVG brace sits to the right of expanded grandchild subtrees (never colliding with children)
    act(() => {
      const grandChildId = store.getState().addNode('u_cont');
      store.getState().updateNode(grandChildId, { text: 'Deep grandchild' });
    });
    const grandChildId = findNodeById(store.getState().document.root, 'u_cont')!.children[0].id;
    const layoutMap = new Map([
      ['b_uniform', { position: { x: 100, y: 120 }, width: 140, height: 36 }],
      ['u_def', { position: { x: 300, y: 60 }, width: 160, height: 36 }],
      ['u_cont', { position: { x: 300, y: 120 }, width: 160, height: 36 }],
      [grandChildId, { position: { x: 520, y: 120 }, width: 150, height: 36 }], // right edge = 670
      ['u_int', { position: { x: 300, y: 180 }, width: 160, height: 36 }],
    ]);

    const boxMap = new Map(
      [...layoutMap.entries()].map(([id, v]) => [
        id,
        { x: v.position.x, y: v.position.y, width: v.width, height: v.height },
      ]),
    );
    const geom = computeSummaryBraceGeometry(
      store.getState().document.summaries![0],
      store.getState().document.root,
      boxMap,
      'right',
    )!;
    expect(geom).not.toBeNull();
    expect(geom.tipX).toBeGreaterThan(670);
    expect(geom.path).toContain('Q');

    cleanup();
    render(
      <SummaryBraceOverlay
        summaries={store.getState().document.summaries}
        root={store.getState().document.root}
        layoutNodeById={layoutMap}
        direction="right"
        onUpdateLabel={(id, label) => store.getState().updateSummaryBrace(id, label)}
        onRemove={(id) => store.getState().removeSummaryBrace(id)}
      />,
    );

    // Inline edit summary brace label
    const pill = screen.getByTestId('mm-summary-brace-pill');
    fireEvent.doubleClick(pill);
    const input = screen.getByTestId('mm-summary-brace-input');
    fireEvent.change(input, { target: { value: 'Three pillars of uniform limit' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store.getState().document.summaries?.[0].label).toBe('Three pillars of uniform limit');

    // JSON round-trip preserves summaries[]
    const roundTripped = importFromJson(exportToJson(store.getState().document));
    expect(roundTripped.summaries).toEqual(store.getState().document.summaries);

    // Deleting endpoint 'u_int' automatically prunes invalid summary brace
    act(() => {
      store.getState().deleteNode('u_int');
    });
    expect(store.getState().document.summaries).toBeUndefined();
  });

  it('4) Branch Semantic Color Propagation & One-Click Flashcard Projection: syncs branchColor on theme/color/move changes and updates deterministic card_mm_${mapId}_${nodeId} without resetting FSRS state', async () => {
    const upsertedBatches: unknown[][] = [];
    const unregisterEdges = registerMindMapAnchorEdgeSink({
      upsertAnchorEdges: async (edges) => {
        upsertedBatches.push([...edges]);
      },
      pruneAnchorEdgesBySource: async () => undefined,
    });

    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_calc_hub',
      document: makeConvergenceDoc(),
      styleId: 'default',
    });

    // Ingest excerpt under branch 0 ('b_uniform' -> DEFAULT_LIGHT_PALETTE[0] = '#B55A52')
    const createdId = store.getState().ingestExcerpt(makePayload(), {
      mode: 'child',
      targetNodeId: 'b_uniform',
    })!;
    expect(resolveNodeBranchColors(store.getState().document.root, 'default').get(createdId)).toBe(
      DEFAULT_LIGHT_PALETTE[0],
    );
    expect(upsertedBatches.at(-1)?.[0]).toMatchObject({
      branchColor: DEFAULT_LIGHT_PALETTE[0],
      sourceAnchor: {
        kind: 'mindmap',
        resourceId: 'mm_calc_hub',
        nodeId: createdId,
        branchColor: DEFAULT_LIGHT_PALETTE[0],
      },
    });

    // Switching theme to 'dark' automatically re-syncs vfs_anchor_edges with DARK_SAFE_PALETTE[0]
    store.getState().setStyleId('dark');
    expect(upsertedBatches.at(-1)?.[0]).toMatchObject({
      branchColor: DARK_SAFE_PALETTE[0],
      sourceAnchor: {
        branchColor: DARK_SAFE_PALETTE[0],
      },
    });

    // Setting explicit custom branch bgColor overrides palette and re-syncs immediately
    store.getState().updateNode('b_uniform', { style: { bgColor: '#3B6E8C' } });
    expect(upsertedBatches.at(-1)?.[0]).toMatchObject({
      branchColor: '#3B6E8C',
      sourceAnchor: {
        branchColor: '#3B6E8C',
      },
    });

    // Moving node to branch 1 ('b_pointwise') re-syncs to DARK_SAFE_PALETTE[1]
    store.getState().moveNode(createdId, 'b_pointwise', 0);
    expect(upsertedBatches.at(-1)?.[0]).toMatchObject({
      branchColor: DARK_SAFE_PALETTE[1],
      sourceAnchor: {
        branchColor: DARK_SAFE_PALETTE[1],
      },
    });
    unregisterEdges();

    // --- One-Click Flashcard Projection (`isFlashcard` + FSRS non-resetting updates) ---
    const projectedCalls: Array<{
      payload: MindMapProjectedFlashcardPayload;
      isInitialInsert: boolean;
    }> = [];
    const removedCalls: Array<{ id: string; mapId: string; nodeId: string }> = [];
    const unregisterProjection = registerMindMapCardProjectionSink({
      upsertProjectedCard: (payload, meta) => {
        projectedCalls.push({ payload, isInitialInsert: meta.isInitialInsert });
      },
      removeProjectedCard: (params) => {
        removedCalls.push(params);
      },
    });

    // Add synthesis note + excerpt to 'b_uniform' (which also has 3 child bullet items)
    store.getState().setNodeCardNote('b_uniform', 'Uniform norm controls worst-case pointwise error.');
    store.getState().ingestExcerpt(makePayload({ anchor: qbankAnchor42, text: 'Midterm Q42' }), {
      mode: 'merge',
      targetNodeId: 'b_uniform',
    });

    // Toggle `isFlashcard` ON
    const enabled = store.getState().toggleNodeFlashcard('b_uniform');
    expect(enabled).toBe(true);
    expect(projectedCalls).toHaveLength(1);

    const expectedCardId = buildMindMapFlashcardId('mm_calc_hub', 'b_uniform');
    expect(expectedCardId).toBe('card_mm_mm_calc_hub_b_uniform');
    expect(projectedCalls[0].isInitialInsert).toBe(true);
    expect(projectedCalls[0].payload).toMatchObject({
      id: 'card_mm_mm_calc_hub_b_uniform',
      front: '[Function Sequences] Uniform Convergence',
    });
    expect(projectedCalls[0].payload.back).toContain(
      'Uniform norm controls worst-case pointwise error.',
    );
    expect(projectedCalls[0].payload.back).toContain('Q.q_42');
    expect(projectedCalls[0].payload.back).toContain('- Supremum norm goes to zero');
    expect(projectedCalls[0].payload.anchors.some((a) => a.kind === 'qbank')).toBe(true);
    expect(projectedCalls[0].payload.anchors.some((a) => a.kind === 'mindmap')).toBe(true);

    // Subsequent edit on cardNote updates projection with `isInitialInsert: false`
    store.getState().setNodeCardNote('b_uniform', 'Updated synthesis note without resetting FSRS.');
    expect(projectedCalls).toHaveLength(2);
    expect(projectedCalls[1].isInitialInsert).toBe(false);
    expect(projectedCalls[1].payload.back).toContain(
      'Updated synthesis note without resetting FSRS.',
    );

    // Toggling OFF dispatches removeProjectedCard
    store.getState().toggleNodeFlashcard('b_uniform', false);
    expect(removedCalls).toEqual([
      { id: 'card_mm_mm_calc_hub_b_uniform', mapId: 'mm_calc_hub', nodeId: 'b_uniform' },
    ]);
    unregisterProjection();

    // Verify default persistence adapter calls `fsrs_enqueue_cards` ONLY on initial insert,
    // NEVER on subsequent content edits, and suspends FSRS state on removal!
    __resetMindMapCardProjectionForTests();
    const samplePayload = buildProjectedFlashcardPayload(
      'mm_calc_hub',
      store.getState().document.root,
      'b_uniform',
    )!;

    // 1st call: newly inserted in anki_cards -> enqueues in FSRS once
    saveAnkiCardsMock.mockResolvedValueOnce({
      savedIds: [samplePayload.id],
      taskId: 'task_1',
      cardIdMappings: [{ inputIndex: 0, inputId: samplePayload.id, persistedId: samplePayload.id }],
    });
    invokeMock.mockResolvedValueOnce({
      states: [{ id: 'fsrs_state_99', ankiCardId: samplePayload.id }],
    });
    await upsertProjectedFlashcard(samplePayload, { isInitialInsert: true });
    expect(saveAnkiCardsMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('fsrs_enqueue_cards', {
      ankiCardIds: [samplePayload.id],
    });

    // 2nd call: editing front/back hits UPDATE fallback (`savedIds: []`, `duplicatedIds: [id]`) -> 0 FSRS reset/enqueue calls!
    saveAnkiCardsMock.mockResolvedValueOnce({
      savedIds: [],
      duplicatedIds: [samplePayload.id],
      taskId: 'task_2',
      cardIdMappings: [{ inputIndex: 0, inputId: samplePayload.id, persistedId: samplePayload.id }],
    });
    await upsertProjectedFlashcard(
      { ...samplePayload, back: 'Edited back preserving stability=18.4, reps=7' },
      { isInitialInsert: false },
    );
    expect(saveAnkiCardsMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledTimes(1); // fsrs_enqueue_cards / fsrs_reset_card_progress NOT called!

    // Removing projection suspends FSRS state (`fsrs_suspend_card`) instead of wiping review history
    invokeMock.mockResolvedValueOnce({ changed: true });
    await removeProjectedFlashcard({
      id: samplePayload.id,
      mapId: 'mm_calc_hub',
      nodeId: 'b_uniform',
    });
    expect(invokeMock).toHaveBeenLastCalledWith('fsrs_suspend_card', {
      cardStateId: 'fsrs_state_99',
    });
  });
});
