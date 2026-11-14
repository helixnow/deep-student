import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDualReaderReferenceSplit,
  buildDualReaderWorkbenchSnapshot,
  collapseDualReaderSplit,
  collectPaneLeaves,
  collectPaneTabs,
  computePaneNodeFrames,
  deserializePaneTree,
  getDualReaderArrangement,
  isDualReaderSplit,
  loadDualReaderSpaceSnapshot,
  sanitizePaneNode,
  saveDualReaderSpaceSnapshot,
  serializePaneTree,
  type PaneLeafNode,
  type PaneNode,
  type PaneTab,
} from '../dualReaderPresets';
import { invalidateSnapshotDedupeCache, registerDockPinnedProvider, registerSnapshotMirrorHook } from '../snapshot';
import { resetSpaceSnapshotsForTests, sanitizeSpaceSnapshotsEnvelope } from '../spaceSnapshots';
import { resetStagePresetStoreForTests } from '../stagePresets';
import { resetWindowStoreForTests } from '../windowStore';

function makeTab(id: string, typeId: string, title: string, resourceId?: string): PaneTab {
  return {
    id,
    typeId,
    resourceId: resourceId ?? id,
    title,
  };
}

beforeEach(() => {
  localStorage.clear();
  registerDockPinnedProvider(null);
  registerSnapshotMirrorHook(null);
  invalidateSnapshotDedupeCache();
  resetWindowStoreForTests({ w: 1600, h: 900 });
  resetStagePresetStoreForTests();
  resetSpaceSnapshotsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('applyDualReaderReferenceSplit & collapseDualReaderSplit', () => {
  it('preserves every tab and honors preferred active tabs in either pane after collapsing', () => {
    const leaf: PaneLeafNode = { kind: 'leaf', id: 'main', tabs: [
      makeTab('a', 'pdf', 'A'), makeTab('b', 'pdf', 'B'),
      makeTab('hub1', 'mindmap', 'Hub 1'), makeTab('hub2', 'mindmap', 'Hub 2'),
      makeTab('extra', 'notes', 'Extra'),
    ], activeTabId: 'a' };
    const tree = applyDualReaderReferenceSplit(leaf, { mindmapTabId: 'hub1' });
    const collapsed = collapseDualReaderSplit(tree, { mode: 'reader-and-hub', preferredActiveTabId: 'hub2' });
    expect(collectPaneTabs(collapsed).map((tab) => tab.id).sort()).toEqual(leaf.tabs.map((tab) => tab.id).sort());
    expect(collectPaneLeaves(collapsed)[1].activeTabId).toBe('hub2');
    const unified = collapseDualReaderSplit(tree, { preferredActiveTabId: 'b' });
    expect(unified.kind === 'leaf' && unified.activeTabId).toBe('b');
  });
  it.each([{ w: 0, h: 0 }, { w: 4, h: 3 }, { w: 20, h: 10 }, { w: 200, h: 90 }])(
    'keeps frames finite and inside tiny viewports: %j', (desktop) => {
      const leaf: PaneLeafNode = { kind: 'leaf', id: 'main', tabs: [], activeTabId: null };
      for (const arrangement of ['three-column', 'left-stack-right-hub'] as const) {
        const frames = computePaneNodeFrames(applyDualReaderReferenceSplit(leaf, { arrangement }), desktop);
        for (const frame of Object.values(frames)) {
          expect(Object.values(frame).every(Number.isFinite)).toBe(true);
          expect(frame.w).toBeGreaterThanOrEqual(0);
          expect(frame.h).toBeGreaterThanOrEqual(0);
          expect(frame.x + frame.w).toBeLessThanOrEqual(desktop.w);
          expect(frame.y + frame.h).toBeLessThanOrEqual(desktop.h);
        }
      }
    },
  );

  it('persists dual-reader sidecar state with the pane tree snapshot', async () => {
    const leaf: PaneLeafNode = { kind: 'leaf', id: 'main', tabs: [], activeTabId: null };
    const saved = await saveDualReaderSpaceSnapshot('space-dual', applyDualReaderReferenceSplit(leaf,
      { arrangement: 'left-stack-right-hub' }));
    expect(saved?.sidecarMode).toBe('dual_reader');
    expect((await loadDualReaderSpaceSnapshot('space-dual')).entry?.sidecarMode).toBe('dual_reader');
  });
  it('arranges Textbook PDF + Past Exam PDF + MindMap Hub into a balanced 3-column workspace while preserving all open tabs', () => {
    const initialLeaf: PaneLeafNode = {
      kind: 'leaf',
      id: 'pane-main',
      role: 'general',
      tabs: [
        makeTab('tab_tb', 'textbook', '高等数学上册.pdf', 'tb_calc_1'),
        makeTab('tab_exam', 'pdf', '2025考研数学真题.pdf', 'pdf_exam_2025'),
        makeTab('tab_mm_1', 'mindmap', '极限与连续知识图谱', 'mm_limits'),
        makeTab('tab_note_extra', 'notes', '易错反例补充笔记', 'note_counterexamples'),
        makeTab('tab_mm_2', 'mindmap', '中值定理专题导图', 'mm_mvt'),
      ],
      activeTabId: 'tab_tb',
    };

    const split = applyDualReaderReferenceSplit(initialLeaf, {
      arrangement: 'three-column',
    });

    expect(isDualReaderSplit(split)).toBe(true);
    expect(getDualReaderArrangement(split)).toBe('three-column');
    expect(split.direction).toBe('horizontal');
    expect(split.ratio).toBe(0.66);
    expect(split.first.kind).toBe('split');
    if (split.first.kind !== 'split') throw new Error('Expected nested reader split');
    expect(split.first.direction).toBe('horizontal');
    expect(split.first.ratio).toBe(0.5);

    const leaves = collectPaneLeaves(split);
    expect(leaves.map((l) => l.role)).toEqual(['reader-a', 'reader-b', 'mindmap-hub']);

    const [readerA, readerB, hub] = leaves;
    expect(readerA?.activeTabId).toBe('tab_tb');
    expect(readerB?.activeTabId).toBe('tab_exam');
    expect(hub?.activeTabId).toBe('tab_mm_1');
    expect(hub?.tabs.map((t) => t.id)).toEqual(['tab_mm_1', 'tab_mm_2']);

    // All 5 tabs preserved with zero duplicates and zero mutation of input
    const allTabs = collectPaneTabs(split);
    expect(allTabs).toHaveLength(5);
    expect(new Set(allTabs.map((t) => t.id))).toEqual(
      new Set(['tab_tb', 'tab_exam', 'tab_mm_1', 'tab_note_extra', 'tab_mm_2']),
    );
    expect(initialLeaf.tabs).toHaveLength(5);

    // Collapsing restores a single unified leaf with all 5 tabs preserved
    const collapsed = collapseDualReaderSplit(split);
    expect(collapsed.kind).toBe('leaf');
    if (collapsed.kind !== 'leaf') throw new Error('Expected collapsed leaf');
    expect(collapsed.tabs).toHaveLength(5);
    expect(collapsed.activeTabId).toBe('tab_tb');
    expect(new Set(collapsed.tabs.map((t) => t.id))).toEqual(
      new Set(['tab_tb', 'tab_exam', 'tab_mm_1', 'tab_note_extra', 'tab_mm_2']),
    );
  });

  it('supports left vertical stack + right MindMap Hub arrangement and switches arrangements losslessly', () => {
    const rootTree: PaneNode = {
      kind: 'split',
      id: 'existing-two-pane',
      direction: 'horizontal',
      ratio: 0.5,
      first: {
        kind: 'leaf',
        id: 'left-readers',
        tabs: [
          makeTab('tab_paper', 'file-preview', 'Attention Is All You Need.pdf'),
          makeTab('tab_notes', 'notes', '论文精读批注'),
          makeTab('tab_supp', 'pdf', 'Appendix Proofs.pdf'),
        ],
        activeTabId: 'tab_paper',
      },
      second: {
        kind: 'leaf',
        id: 'right-hub',
        tabs: [makeTab('tab_hub', 'mindmap', 'Transformer 收敛导图')],
        activeTabId: 'tab_hub',
      },
    };

    const stacked = applyDualReaderReferenceSplit(rootTree, {
      arrangement: 'left-stack-right-hub',
      readerATabId: 'tab_paper',
      readerBTabId: 'tab_notes',
      mindmapTabId: 'tab_hub',
      hubSplitRatio: 0.54,
      readerSplitRatio: 0.45,
    });

    expect(isDualReaderSplit(stacked)).toBe(true);
    expect(getDualReaderArrangement(stacked)).toBe('left-stack-right-hub');
    expect(stacked.ratio).toBe(0.54);
    expect(stacked.first.kind).toBe('split');
    if (stacked.first.kind !== 'split') throw new Error('Expected vertical reader stack');
    expect(stacked.first.direction).toBe('vertical');
    expect(stacked.first.ratio).toBe(0.45);

    const stackedLeaves = collectPaneLeaves(stacked);
    expect(stackedLeaves[0]?.activeTabId).toBe('tab_paper');
    expect(stackedLeaves[1]?.activeTabId).toBe('tab_notes');
    expect(stackedLeaves[2]?.activeTabId).toBe('tab_hub');
    expect(collectPaneTabs(stacked)).toHaveLength(4);

    // Switch from left-stack-right-hub to three-column without losing each pane's exact tab list
    const threeCol = applyDualReaderReferenceSplit(stacked, {
      arrangement: 'three-column',
    });
    expect(getDualReaderArrangement(threeCol)).toBe('three-column');
    const threeColLeaves = collectPaneLeaves(threeCol);
    expect(threeColLeaves[0]?.tabs.map((t) => t.id)).toEqual(stackedLeaves[0]?.tabs.map((t) => t.id));
    expect(threeColLeaves[1]?.tabs.map((t) => t.id)).toEqual(stackedLeaves[1]?.tabs.map((t) => t.id));
    expect(threeColLeaves[2]?.tabs.map((t) => t.id)).toEqual(stackedLeaves[2]?.tabs.map((t) => t.id));

    // Collapse to 2-pane reader + hub mode merges Reader A + Reader B while keeping MindMap Hub separate
    const twoPane = collapseDualReaderSplit(threeCol, { mode: 'reader-and-hub' });
    expect(twoPane.kind).toBe('split');
    const twoPaneLeaves = collectPaneLeaves(twoPane);
    expect(twoPaneLeaves).toHaveLength(2);
    expect(twoPaneLeaves[0]?.tabs.map((t) => t.id)).toEqual([
      'tab_paper',
      'tab_supp',
      'tab_notes',
    ]);
    expect(twoPaneLeaves[1]?.tabs.map((t) => t.id)).toEqual(['tab_hub']);
  });

  it('computes non-overlapping pixel-accurate frames for both 3-column and left-stack-right-hub trees', () => {
    const desktop = { w: 1600, h: 900 };
    const margin = 8;
    const base: PaneLeafNode = {
      kind: 'leaf',
      id: 'root',
      tabs: [
        makeTab('a', 'pdf', 'Textbook.pdf'),
        makeTab('b', 'exam', 'PastExam.json'),
        makeTab('m', 'mindmap', 'Hub.mm'),
      ],
      activeTabId: 'a',
    };

    const threeCol = applyDualReaderReferenceSplit(base, { arrangement: 'three-column' });
    const colFrames = computePaneNodeFrames(threeCol, desktop, margin);
    const fA = colFrames['pane-leaf-reader-a']!;
    const fB = colFrames['pane-leaf-reader-b']!;
    const fM = colFrames['pane-leaf-mindmap-hub']!;

    expect(fA.x).toBe(margin);
    expect(fA.x + fA.w + margin).toBe(fB.x);
    expect(fB.x + fB.w + margin).toBe(fM.x);
    expect(fM.x + fM.w + margin).toBe(desktop.w);
    expect(fA.h).toBe(desktop.h - margin * 2);
    expect(fB.h).toBe(desktop.h - margin * 2);
    expect(fM.h).toBe(desktop.h - margin * 2);

    const leftStack = applyDualReaderReferenceSplit(base, {
      arrangement: 'left-stack-right-hub',
    });
    const stackFrames = computePaneNodeFrames(leftStack, desktop, margin);
    const sA = stackFrames['pane-leaf-reader-a']!;
    const sB = stackFrames['pane-leaf-reader-b']!;
    const sM = stackFrames['pane-leaf-mindmap-hub']!;

    expect(sA.x).toBe(sB.x);
    expect(sA.w).toBe(sB.w);
    expect(sA.y + sA.h + margin).toBe(sB.y);
    expect(sB.y + sB.h + margin).toBe(desktop.h);
    expect(sA.x + sA.w + margin).toBe(sM.x);
    expect(sM.x + sM.w + margin).toBe(desktop.w);
  });
});

describe('PaneNode codec & spaceSnapshots round-trip persistence', () => {
  it('serializes, sanitizes, and isolates Dual-Reader 3-pane trees cleanly across Study Spaces via spaceSnapshots', async () => {
    const mathTree = applyDualReaderReferenceSplit(
      {
        kind: 'leaf',
        id: 'math-leaf',
        tabs: [
          makeTab('t_calc_book', 'textbook', '数学分析教材.pdf', 'tb_math_1'),
          makeTab('t_calc_exam', 'pdf', '数学分析历年真题.pdf', 'pdf_math_exam'),
          makeTab('t_calc_extra', 'notes', '课堂推导草稿', 'note_math_draft'),
          makeTab('t_calc_map', 'mindmap', '实数完备性汇聚导图', 'mm_math_hub'),
        ],
        activeTabId: 't_calc_book',
      },
      {
        arrangement: 'left-stack-right-hub',
        hubSplitRatio: 0.55,
        readerSplitRatio: 0.48,
      },
    );

    const physicsTree = applyDualReaderReferenceSplit(
      {
        kind: 'leaf',
        id: 'phys-leaf',
        tabs: [
          makeTab('t_phys_book', 'pdf', '电动力学讲义.pdf', 'pdf_phys_1'),
          makeTab('t_phys_paper', 'pdf', 'Maxwell Equations Paper.pdf', 'pdf_phys_2'),
          makeTab('t_phys_map', 'mindmap', '麦克斯韦方程组导图', 'mm_phys_hub'),
        ],
        activeTabId: 't_phys_book',
      },
      {
        arrangement: 'three-column',
        hubSplitRatio: 0.64,
        readerSplitRatio: 0.5,
      },
    );

    // Pure string codec round-trip
    const encoded = serializePaneTree(mathTree);
    const decoded = deserializePaneTree(encoded);
    expect(decoded).toEqual(mathTree);

    // Snapshot envelope sanitization round-trip
    const mathSnapshot = buildDualReaderWorkbenchSnapshot(mathTree, {
      desktopSize: { w: 1600, h: 900 },
      dockPinned: ['files', 'notes'],
    });
    const sanitizedEnvelope = sanitizeSpaceSnapshotsEnvelope({
      version: 1,
      activeSpaceKey: 'space_math',
      entries: {
        space_math: {
          spaceKey: 'space_math',
          snapshot: mathSnapshot,
          activeStagePreset: 'deep-reading-map',
          updatedAt: 12345,
        },
      },
    });
    expect(sanitizedEnvelope?.entries['space_math']?.snapshot.windows).toHaveLength(3);
    expect(sanitizedEnvelope?.entries['space_math']?.snapshot.tilingRatios['v']).toBe(0.55);
    expect(sanitizedEnvelope?.entries['space_math']?.snapshot.tilingRatios['h-left']).toBe(0.48);

    // Full per-space persistence round-trip across space_math and space_physics
    await saveDualReaderSpaceSnapshot('space_math', mathTree);
    await saveDualReaderSpaceSnapshot('space_physics', physicsTree);

    const loadedMath = await loadDualReaderSpaceSnapshot('space_math');
    expect(loadedMath.spaceKey).toBe('space_math');
    expect(loadedMath.entry?.activeStagePreset).toBe('deep-reading-map');
    expect(loadedMath.paneTree).toEqual(mathTree);
    expect(collectPaneTabs(loadedMath.paneTree!)).toHaveLength(4);

    const loadedPhysics = await loadDualReaderSpaceSnapshot('space_physics');
    expect(loadedPhysics.spaceKey).toBe('space_physics');
    expect(loadedPhysics.paneTree).toEqual(physicsTree);
    expect(getDualReaderArrangement(loadedPhysics.paneTree!)).toBe('three-column');
  });

  it('rejects malformed payloads and repairs invalid activeTabId or duplicate tab IDs during sanitization', () => {
    expect(deserializePaneTree('')).toBeNull();
    expect(deserializePaneTree('{bad json')).toBeNull();
    expect(sanitizePaneNode({ kind: 'split', id: 'bad', direction: 'diagonal', ratio: 0.5 })).toBeNull();

    const repaired = sanitizePaneNode({
      kind: 'leaf',
      id: 'leaf-1',
      tabs: [
        { id: 'dup', typeId: 'pdf', title: 'First' },
        { id: 'dup', typeId: 'pdf', title: 'Duplicate Dropped' },
        { id: 'second', typeId: 'mindmap', title: 'Second' },
      ],
      activeTabId: 'non-existent-id',
    });

    expect(repaired).toEqual({
      kind: 'leaf',
      id: 'leaf-1',
      tabs: [
        { id: 'dup', typeId: 'pdf', title: 'First' },
        { id: 'second', typeId: 'mindmap', title: 'Second' },
      ],
      activeTabId: 'dup',
    });
  });
});
