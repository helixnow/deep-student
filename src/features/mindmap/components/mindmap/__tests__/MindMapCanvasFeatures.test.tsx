import React, { useRef } from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';
import type { MindMapNode } from '../../../types';
import { getBranchColor } from '../../../constants/colors';
import {
  COLORFUL_LIGHT_PALETTE,
  COLORFUL_DARK_PALETTE,
} from '../../../styles/themes/palettes';
import {
  useCanvasHoverPath,
  computeAncestorPathEdgeKeys,
  computeBranchIndexMap,
  computeSpotlightActiveIds,
  buildStyledCanvasEdges,
  buildMinimapBranchColorMap,
} from '../hooks/useCanvasHoverPath';
import {
  resolveChildAppendIndex,
  enrichCanvasNodes,
  useCanvasNodeDrag,
} from '../hooks/useCanvasNodeDrag';
import {
  buildCanvasThemeVars,
  useCanvasZoomShortcuts,
  useCanvasEditAutoZoom,
  useCanvasSpotlightCamera,
  CanvasBottomControls,
} from '../CanvasBottomControls';
import { darkTheme, defaultTheme } from '../../../styles/themes';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
    }),
  };
});

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    Controls: (props: { showFitView?: boolean; showInteractive?: boolean; className?: string }) => (
      <div
        data-testid="mock-rf-controls"
        data-show-fit-view={String(props.showFitView ?? true)}
        data-show-interactive={String(props.showInteractive ?? true)}
        className={props.className}
      />
    ),
    useReactFlow: () => ({
      zoomTo: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      fitView: vi.fn(),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setViewport: vi.fn(),
      getNodes: () => [],
      getZoom: () => 1,
      setCenter: vi.fn(),
    }),
    useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
  };
});

function createSampleTree(): MindMapNode {
  return {
    id: 'root',
    text: 'Root',
    children: [
      {
        id: 'b1',
        text: 'Branch 1',
        children: [
          { id: 'b1-1', text: 'Leaf 1-1', children: [] },
          { id: 'b1-2', text: 'Leaf 1-2', children: [] },
        ],
      },
      {
        id: 'b2',
        text: 'Branch 2',
        children: [{ id: 'b2-1', text: 'Leaf 2-1', children: [] }],
      },
    ],
  };
}

function createSampleFlowGraph(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: 'root', type: 'root', position: { x: 0, y: 0 }, data: { nodeId: 'root', label: 'Root' } },
    { id: 'b1', type: 'branch', position: { x: 200, y: 0 }, data: { nodeId: 'b1', label: 'Branch 1', level: 1 } },
    { id: 'b1-1', type: 'branch', position: { x: 400, y: -30 }, data: { nodeId: 'b1-1', label: 'Leaf 1-1', level: 2 } },
    { id: 'b1-2', type: 'branch', position: { x: 400, y: 30 }, data: { nodeId: 'b1-2', label: 'Leaf 1-2', level: 2 } },
    { id: 'b2', type: 'branch', position: { x: 200, y: 120 }, data: { nodeId: 'b2', label: 'Branch 2', level: 1 } },
    { id: 'b2-1', type: 'branch', position: { x: 400, y: 120 }, data: { nodeId: 'b2-1', label: 'Leaf 2-1', level: 2 } },
  ];
  const edges: Edge[] = [
    { id: 'e-root-b1', source: 'root', target: 'b1' },
    { id: 'e-b1-b1-1', source: 'b1', target: 'b1-1' },
    { id: 'e-b1-b1-2', source: 'b1', target: 'b1-2' },
    { id: 'e-root-b2', source: 'root', target: 'b2' },
    { id: 'e-b2-b2-1', source: 'b2', target: 'b2-1' },
  ];
  return { nodes, edges };
}

describe('MindMapCanvas M6 modular features & P0 fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. Zero-rerender hover ancestor path (useCanvasHoverPath)', () => {
    it('toggles .mm-edge-hover-path directly on DOM edges with zero React re-renders and respects coarse pointer / dragging', () => {
      const root = createSampleTree();
      const { nodes, edges } = createSampleFlowGraph();
      let renderCount = 0;
      let handlers!: ReturnType<typeof useCanvasHoverPath>;

      function Harness({
        isCoarsePointer = false,
        isDragging = false,
        focusedNodeId = null as string | null,
      }) {
        renderCount += 1;
        const containerRef = useRef<HTMLDivElement>(null);
        const ancestorPathEdgeKeys = computeAncestorPathEdgeKeys(root, focusedNodeId);
        handlers = useCanvasHoverPath({
          canvasContainerRef: containerRef,
          root,
          edges,
          focusedNodeId,
          ancestorPathEdgeKeys,
          isCoarsePointer,
          isDragging,
        });
        return (
          <div ref={containerRef} className="mindmap-container">
            {edges.map((e) => (
              <div key={e.id} className="react-flow__edge" data-id={e.id} />
            ))}
          </div>
        );
      }

      const { container, rerender } = render(<Harness />);
      expect(renderCount).toBe(1);

      // Hovering b1-1 highlights root->b1 and b1->b1-1 with 0 React re-renders
      handlers.onNodeMouseEnter({} as React.MouseEvent, nodes[2]);
      expect(renderCount).toBe(1);
      expect(container.querySelector('[data-id="e-root-b1"]')?.classList.contains('mm-edge-hover-path')).toBe(true);
      expect(container.querySelector('[data-id="e-b1-b1-1"]')?.classList.contains('mm-edge-hover-path')).toBe(true);
      expect(container.querySelector('[data-id="e-root-b2"]')?.classList.contains('mm-edge-hover-path')).toBe(false);

      // Leaving removes the classes with 0 React re-renders
      handlers.onNodeMouseLeave();
      expect(renderCount).toBe(1);
      expect(container.querySelector('[data-id="e-root-b1"]')?.classList.contains('mm-edge-hover-path')).toBe(false);
      expect(container.querySelector('[data-id="e-b1-b1-1"]')?.classList.contains('mm-edge-hover-path')).toBe(false);

      // Starting drag clears active hover classes
      handlers.onNodeMouseEnter({} as React.MouseEvent, nodes[2]);
      expect(container.querySelector('[data-id="e-root-b1"]')?.classList.contains('mm-edge-hover-path')).toBe(true);
      rerender(<Harness isDragging />);
      expect(container.querySelector('[data-id="e-root-b1"]')?.classList.contains('mm-edge-hover-path')).toBe(false);

      // Coarse pointer skips hover highlighting completely
      rerender(<Harness isCoarsePointer />);
      handlers.onNodeMouseEnter({} as React.MouseEvent, nodes[2]);
      expect(container.querySelector('[data-id="e-root-b1"]')?.classList.contains('mm-edge-hover-path')).toBe(false);
    });
  });

  describe('2. Drag child drop appends to end (useCanvasNodeDrag)', () => {
    it('resolves child append index to target.children.length', () => {
      const root = createSampleTree();
      expect(resolveChildAppendIndex(root, 'b1')).toBe(2);
      expect(resolveChildAppendIndex(root, 'b2')).toBe(1);
      expect(resolveChildAppendIndex(root, 'b1-1')).toBe(0);
    });

    it('calls moveNodes with target.children.length when dropping onto a target node as child', () => {
      const root = createSampleTree();
      const moveNodes = vi.fn(() => true);
      const setSelection = vi.fn();
      const setFocusedNodeId = vi.fn();
      const flowNodes: Node[] = [
        { id: 'root', position: { x: 0, y: 0 }, measured: { width: 100, height: 40 }, data: {} },
        { id: 'b1', position: { x: 200, y: 0 }, measured: { width: 100, height: 40 }, data: {} },
        { id: 'b2', position: { x: 200, y: 120 }, measured: { width: 100, height: 40 }, data: {} },
      ];
      let dragApi!: ReturnType<typeof useCanvasNodeDrag>;

      function DragHarness() {
        const prevRef = useRef<string | null>(null);
        dragApi = useCanvasNodeDrag({
          root,
          selection: ['b2'],
          effectiveLayoutDirection: 'right',
          getNodes: () => flowNodes,
          setSelection,
          setFocusedNodeId,
          moveNodes,
          prevFocusedNodeIdRef: prevRef,
        });
        return null;
      }

      render(<DragHarness />);

      act(() => {
        dragApi.onNodeDragStart({} as React.MouseEvent, flowNodes[2], [flowNodes[2]]);
      });
      // Drag b2 directly over center of b1 (200, 0) -> child mode
      act(() => {
        dragApi.onNodeDrag(
          {} as React.MouseEvent,
          { ...flowNodes[2], position: { x: 200, y: 0 } },
          [flowNodes[2]],
        );
      });
      act(() => {
        dragApi.onNodeDragStop({} as React.MouseEvent, flowNodes[2], [flowNodes[2]]);
      });

      // b1 has 2 children (b1-1, b1-2), so b2 must be appended at index 2 (NOT 0)
      expect(moveNodes).toHaveBeenCalledWith(['b2'], 'b1', 2);
    });
  });

  describe('3. Mineral rainbow edges, MiniMap dark sync, Mastery overlay & Spotlight', () => {
    it('colors tree edges with getBranchColor when useBranchPalette is true and keeps default monochrome', () => {
      const root = createSampleTree();
      const { nodes, edges } = createSampleFlowGraph();
      const layoutNodeById = new Map(nodes.map((n) => [n.id, n]));
      const branchIndexById = computeBranchIndexMap(root, null);

      const colorfulLight = buildStyledCanvasEdges({
        allEdges: edges.map((e) => ({ ...e, data: { kind: 'tree' } })),
        layoutNodeById,
        ancestorPathEdgeKeys: null,
        focusedNodeId: null,
        useBranchPalette: true,
        branchIndexById,
        isDarkTheme: false,
        spotlightActiveIds: null,
      });

      // Root -> b1 (branchIndex 0, sourceLevel 0)
      expect(colorfulLight[0].style?.stroke).toContain(getBranchColor(0, 0, false));
      // b1 -> b1-1 (branchIndex 0, sourceLevel 1)
      expect(colorfulLight[1].style?.stroke).toContain(getBranchColor(0, 1, false));
      // Root -> b2 (branchIndex 1, sourceLevel 0)
      expect(colorfulLight[3].style?.stroke).toContain(getBranchColor(1, 0, false));

      const colorfulDark = buildStyledCanvasEdges({
        allEdges: edges.map((e) => ({ ...e, data: { kind: 'tree' } })),
        layoutNodeById,
        ancestorPathEdgeKeys: null,
        focusedNodeId: null,
        useBranchPalette: true,
        branchIndexById,
        isDarkTheme: true,
        spotlightActiveIds: null,
      });
      expect(colorfulDark[0].style?.stroke).toContain(getBranchColor(0, 0, true));

      const defaultTheme = buildStyledCanvasEdges({
        allEdges: edges.map((e) => ({ ...e, data: { kind: 'tree' } })),
        layoutNodeById,
        ancestorPathEdgeKeys: null,
        focusedNodeId: null,
        useBranchPalette: false,
        branchIndexById,
        isDarkTheme: false,
        spotlightActiveIds: null,
      });
      expect(defaultTheme[0].style?.stroke).toContain('var(--mm-edge)');
    });

    it('updates MiniMap branch color map immediately when switching light/dark theme palettes', () => {
      const root = createSampleTree();
      const branchIndexById = computeBranchIndexMap(root, null);

      const lightMap = buildMinimapBranchColorMap(branchIndexById, COLORFUL_LIGHT_PALETTE);
      const darkMap = buildMinimapBranchColorMap(branchIndexById, COLORFUL_DARK_PALETTE);

      expect(lightMap.get('b1')).toBe(COLORFUL_LIGHT_PALETTE[0]);
      expect(lightMap.get('b1-1')).toBe(COLORFUL_LIGHT_PALETTE[0]);
      expect(darkMap.get('b1')).toBe(COLORFUL_DARK_PALETTE[0]);
      expect(darkMap.get('b1')).not.toBe(lightMap.get('b1'));
    });

    it('injects branchIndex and FSRS masteryStatus into nodes while preserving React.memo cache stability', () => {
      const root = createSampleTree();
      const { nodes } = createSampleFlowGraph();
      const branchIndexById = computeBranchIndexMap(root, null);
      const cache = new WeakMap<object, Record<string, unknown>>();
      const openMenu = vi.fn();

      const first = enrichCanvasNodes({
        layoutNodes: nodes,
        rootId: 'root',
        focusedNodeId: null,
        selection: [],
        agentEnteringIds: new Set(),
        agentExitingIds: new Set(),
        agentUpdatedIds: new Set(),
        isDragging: false,
        dragNodeId: null,
        dragSubtreeOffsets: {},
        dropTargetId: null,
        dropMode: 'child',
        dropOrientation: 'vertical',
        excerptNodeTargetId: null,
        excerptNodeTargetMerge: false,
        spotlightActiveIds: null,
        branchIndexById,
        showMasteryOverlay: true,
        masteryStatusByNodeId: { root: 'mastered', b1: 'due', 'b2-1': 'struggling' },
        openNodeContextMenu: openMenu,
        dataCache: cache,
      });

      expect(first[0].data.showMasteryOverlay).toBe(true);
      expect(first[0].data.masteryStatus).toBe('mastered');
      expect(first[1].data.branchIndex).toBe(0);
      expect(first[1].data.masteryStatus).toBe('due');
      expect(first[4].data.branchIndex).toBe(1);

      // Updating only b1's mastery status must preserve data reference for untouched nodes (root, b2)
      const second = enrichCanvasNodes({
        layoutNodes: nodes,
        rootId: 'root',
        focusedNodeId: null,
        selection: [],
        agentEnteringIds: new Set(),
        agentExitingIds: new Set(),
        agentUpdatedIds: new Set(),
        isDragging: false,
        dragNodeId: null,
        dragSubtreeOffsets: {},
        dropTargetId: null,
        dropMode: 'child',
        dropOrientation: 'vertical',
        excerptNodeTargetId: null,
        excerptNodeTargetMerge: false,
        spotlightActiveIds: null,
        branchIndexById,
        showMasteryOverlay: true,
        masteryStatusByNodeId: { root: 'mastered', b1: 'learning', 'b2-1': 'struggling' },
        openNodeContextMenu: openMenu,
        dataCache: cache,
      });

      expect(second[0].data).toBe(first[0].data);
      expect(second[4].data).toBe(first[4].data);
      expect(second[1].data).not.toBe(first[1].data);
      expect(second[1].data.masteryStatus).toBe('learning');
    });

    it('dims non-active nodes and edges during Spotlight presentation mode', () => {
      const root = createSampleTree();
      const { nodes, edges } = createSampleFlowGraph();
      const layoutNodeById = new Map(nodes.map((n) => [n.id, n]));
      const branchIndexById = computeBranchIndexMap(root, null);
      const spotlightActiveIds = computeSpotlightActiveIds(root, null, true, 'b1');

      expect(spotlightActiveIds).not.toBeNull();
      expect(spotlightActiveIds?.has('root')).toBe(true);
      expect(spotlightActiveIds?.has('b1')).toBe(true);
      expect(spotlightActiveIds?.has('b1-1')).toBe(true);
      expect(spotlightActiveIds?.has('b2')).toBe(false);
      expect(spotlightActiveIds?.has('b2-1')).toBe(false);

      const enriched = enrichCanvasNodes({
        layoutNodes: nodes,
        rootId: 'root',
        focusedNodeId: null,
        selection: [],
        agentEnteringIds: new Set(),
        agentExitingIds: new Set(),
        agentUpdatedIds: new Set(),
        isDragging: false,
        dragNodeId: null,
        dragSubtreeOffsets: {},
        dropTargetId: null,
        dropMode: 'child',
        dropOrientation: 'vertical',
        excerptNodeTargetId: null,
        excerptNodeTargetMerge: false,
        spotlightActiveIds,
        branchIndexById,
        showMasteryOverlay: false,
        openNodeContextMenu: vi.fn(),
        dataCache: new WeakMap(),
      });

      expect(enriched.find((n) => n.id === 'root')?.className ?? '').not.toContain('mm-spotlight-dimmed');
      expect(enriched.find((n) => n.id === 'b1-1')?.className ?? '').not.toContain('mm-spotlight-dimmed');
      expect(enriched.find((n) => n.id === 'b2')?.className).toContain('mm-spotlight-dimmed');
      expect(enriched.find((n) => n.id === 'b2-1')?.className).toContain('mm-spotlight-dimmed');

      const styledEdges = buildStyledCanvasEdges({
        allEdges: edges.map((e) => ({ ...e, data: { kind: 'tree' } })),
        layoutNodeById,
        ancestorPathEdgeKeys: null,
        focusedNodeId: null,
        useBranchPalette: false,
        branchIndexById,
        isDarkTheme: false,
        spotlightActiveIds,
      });

      expect(styledEdges.find((e) => e.id === 'e-root-b1')?.className ?? '').not.toContain('mm-spotlight-dimmed');
      expect(styledEdges.find((e) => e.id === 'e-b1-b1-1')?.className ?? '').not.toContain('mm-spotlight-dimmed');
      expect(styledEdges.find((e) => e.id === 'e-root-b2')?.className).toContain('mm-spotlight-dimmed');
      expect(styledEdges.find((e) => e.id === 'e-b2-b2-1')?.className).toContain('mm-spotlight-dimmed');
    });
  });

  describe('4. Zoom shortcuts, CJK IME safety & low-zoom edit auto zoom-in', () => {
    it('handles Mod+0, Mod+1, Mod+=, Mod+- while ignoring inputs and IME composition', () => {
      const fitVisibleNodes = vi.fn(() => true);
      const zoomTo = vi.fn();
      const zoomIn = vi.fn();
      const zoomOut = vi.fn();
      const rfMock = { zoomTo, zoomIn, zoomOut } as unknown as ReactFlowInstance;
      const lastCompRef = { current: 0 };

      function ZoomHarness() {
        useCanvasZoomShortcuts({
          isCanvasActive: true,
          fitVisibleNodes,
          reactFlowInstance: rfMock,
          lastCompositionEndAtRef: lastCompRef,
        });
        return <input data-testid="text-input" />;
      }

      const { getByTestId } = render(<ZoomHarness />);

      fireEvent.keyDown(window.document, { key: '0', metaKey: true });
      expect(fitVisibleNodes).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(window.document, { key: '1', metaKey: true });
      expect(zoomTo).toHaveBeenCalledWith(1, expect.any(Object));

      fireEvent.keyDown(window.document, { key: '=', ctrlKey: true });
      expect(zoomIn).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(window.document, { key: '-', ctrlKey: true });
      expect(zoomOut).toHaveBeenCalledTimes(1);

      // Inside input -> ignored
      fireEvent.keyDown(getByTestId('text-input'), { key: '1', metaKey: true });
      expect(zoomTo).toHaveBeenCalledTimes(1);

      // During IME composition (keyCode 229) -> ignored
      fireEvent.keyDown(window.document, { key: '1', metaKey: true, keyCode: 229 });
      expect(zoomTo).toHaveBeenCalledTimes(1);

      // Within 100ms of Safari compositionend -> ignored
      lastCompRef.current = Date.now();
      fireEvent.keyDown(window.document, { key: '0', metaKey: true });
      expect(fitVisibleNodes).toHaveBeenCalledTimes(1);
    });

    it('auto-zooms to 0.85 when entering edit mode below 0.55 zoom, and delegates to ensureNodeVisible otherwise', () => {
      const setCenter = vi.fn();
      const ensureNodeVisible = vi.fn();
      let currentZoom = 0.4;
      const node: Node = {
        id: 'b1',
        position: { x: 100, y: 200 },
        measured: { width: 120, height: 40 },
        data: {},
      };
      const rfMock = {
        getNodes: () => [node],
        getZoom: () => currentZoom,
        setCenter,
      } as unknown as ReactFlowInstance;

      function EditZoomHarness({ editingNodeId }: { editingNodeId: string | null }) {
        useCanvasEditAutoZoom({
          editingNodeId,
          reactFlowInstance: rfMock,
          ensureNodeVisible,
        });
        return null;
      }

      const { rerender } = render(<EditZoomHarness editingNodeId="b1" />);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(setCenter).toHaveBeenCalledWith(160, 220, expect.objectContaining({ zoom: 0.85 }));
      expect(ensureNodeVisible).not.toHaveBeenCalled();

      // At normal zoom (>= 0.55), delegates to ensureNodeVisible('b1', 'fully')
      setCenter.mockClear();
      currentZoom = 0.9;
      rerender(<EditZoomHarness editingNodeId={null} />);
      rerender(<EditZoomHarness editingNodeId="b1" />);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(setCenter).not.toHaveBeenCalled();
      expect(ensureNodeVisible).toHaveBeenCalledWith('b1', 'fully');
    });
  });

  describe('5. Controls dedup, shortcut pill wiring & canvas contracts', () => {
    it('hides duplicate FitView on <Controls> and wires onToggleShortcutHelp to CanvasShortcutHintPill', () => {
      const onToggleShortcutHelp = vi.fn();
      const { getByTestId } = render(
        <CanvasBottomControls
          isCoarsePointer={false}
          reciteMode={false}
          showMobileToolbar={false}
          dragMode="select"
          setDragMode={vi.fn()}
          wheelMode="zoom"
          setWheelMode={vi.fn()}
          onFitView={vi.fn()}
          onAddTopic={vi.fn()}
          onToggleShortcutHelp={onToggleShortcutHelp}
        />,
      );

      expect(getByTestId('mock-rf-controls').getAttribute('data-show-fit-view')).toBe('false');
      fireEvent.click(getByTestId('mm-shortcut-hint-more'));
      expect(onToggleShortcutHelp).toHaveBeenCalledTimes(1);
    });

    it('satisfies MindMapCanvas modular size (<1100 lines), multi-select menu retention, MiniMap glass, and Background dots contracts', () => {
      const canvasSource = readFileSync(
        resolve(process.cwd(), 'src/features/mindmap/components/mindmap/MindMapCanvas.tsx'),
        'utf-8',
      );
      const lineCount = canvasSource.split('\n').length;
      expect(lineCount).toBeLessThan(1100);
      // Preserves multi-selection on right click
      expect(canvasSource).toContain('state.selection.length > 1 && state.selection.includes(nodeId)');
      // Passes onAiNodeAction to CanvasContextMenu
      expect(canvasSource).toContain('onAiNodeAction={onAiNodeAction}');
      // MiniMap no longer overrides glass surface with inline backgroundColor
      expect(canvasSource).not.toContain("backgroundColor: 'var(--mm-bg-elevated)'");
      // Background uses --mm-border token via color-mix instead of opacity: 0.3 or hardcoded --border
      expect(canvasSource).not.toContain('style={{ opacity: 0.3 }}');
      expect(canvasSource).toContain('color="color-mix(in srgb, var(--mm-border) 55%, transparent)"');
      // Uses effectiveLayoutDirection and effectiveRootId consistently
      expect(canvasSource).toContain('layoutDirection: effectiveLayoutDirection');
      expect(canvasSource).toContain('layoutDirection={effectiveLayoutDirection}');
      expect(canvasSource).toContain('rootId: effectiveRootId');
      expect(canvasSource).toContain('state.addNode(effectiveRootId)');
      // Presentation mode hides MiniMap and unlocks direct left-drag pan
      expect(canvasSource).toContain('!presentationMode && layoutNodes.length > 10');
      expect(canvasSource).toContain('panOnDrag={presentationMode ? true : marqueeProps.panOnDrag}');
    });

    it('hides bottom chrome controls in presentationMode to avoid colliding with MindMapPresentationBar', () => {
      const { container, rerender } = render(
        <CanvasBottomControls
          isCoarsePointer={false}
          reciteMode={false}
          presentationMode
          showMobileToolbar={false}
          dragMode="select"
          setDragMode={vi.fn()}
          wheelMode="zoom"
          setWheelMode={vi.fn()}
          onFitView={vi.fn()}
          onAddTopic={vi.fn()}
        />,
      );

      expect(container.querySelector('.mm-canvas-mode-switch')).toBeNull();
      expect(container.querySelector('.mm-shortcut-hint-pill')).toBeNull();

      rerender(
        <CanvasBottomControls
          isCoarsePointer
          reciteMode={false}
          presentationMode
          showMobileToolbar={false}
          dragMode="select"
          setDragMode={vi.fn()}
          wheelMode="zoom"
          setWheelMode={vi.fn()}
          onFitView={vi.fn()}
          onAddTopic={vi.fn()}
        />,
      );
      expect(container.querySelector('.mm-canvas-touch-actions')).toBeNull();
    });

    it('prevents Spotlight camera stealing on doc edits, guards initial fitView, and resets overview when branch returns to null', () => {
      const { nodes } = createSampleFlowGraph();
      const fitView = vi.fn(() => Promise.resolve(true));
      const fitVisibleNodes = vi.fn(() => true);
      const hasFitViewRef = { current: false };
      const nodesRef = { current: nodes };

      function SpotlightHarness({
        presentationMode,
        presentationBranchId,
        activeIds,
      }: {
        presentationMode: boolean;
        presentationBranchId: string | null;
        activeIds: Set<string> | null;
      }) {
        useCanvasSpotlightCamera({
          presentationMode,
          presentationBranchId,
          isCanvasReady: true,
          spotlightActiveIds: activeIds,
          nodesRef,
          hasFitViewRef,
          fitView,
          fitVisibleNodes,
        });
        return null;
      }

      const { rerender } = render(
        <SpotlightHarness
          presentationMode
          presentationBranchId="b1"
          activeIds={new Set(['root', 'b1', 'b1-1'])}
        />,
      );

      // Immediately marks hasFitViewRef so initial mount fitView(0) will not fight it
      expect(hasFitViewRef.current).toBe(true);
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(fitView).toHaveBeenCalledTimes(1);

      // Re-rendering with a brand new Set reference (simulating document edit) must NOT re-trigger fitView
      rerender(
        <SpotlightHarness
          presentationMode
          presentationBranchId="b1"
          activeIds={new Set(['root', 'b1', 'b1-1', 'b1-2'])}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(fitView).toHaveBeenCalledTimes(1);

      // Switching back to full overview (branchId -> null) while still in presentationMode resets camera
      rerender(
        <SpotlightHarness
          presentationMode
          presentationBranchId={null}
          activeIds={null}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(fitVisibleNodes).toHaveBeenCalledTimes(1);
    });

    it('supplements dark text/border/elevated tokens when explicit dark theme is used in light app mode', () => {
      const darkInLight = buildCanvasThemeVars(darkTheme, false) as Record<string, string>;
      expect(darkInLight['--mm-bg']).toBe(darkTheme.canvas?.background);
      expect(darkInLight['--mm-text']).toBe(darkTheme.node?.branch?.foreground);
      expect(darkInLight['--mm-text-secondary']).toBe(darkTheme.node?.leaf?.foreground);
      expect(darkInLight['--mm-border']).toBe(darkTheme.edge?.stroke);
      expect(darkInLight['--mm-bg-elevated']).toBe(darkTheme.node?.branch?.background);

      const lightInLight = buildCanvasThemeVars(defaultTheme, false) as Record<string, string>;
      expect(lightInLight['--mm-text']).toBeUndefined();
    });

    it('treats rootNode type as sourceLevel 0 in buildStyledCanvasEdges', () => {
      const root = createSampleTree();
      const nodes: Node[] = [
        { id: 'root', type: 'rootNode', position: { x: 0, y: 0 }, data: { nodeId: 'root', label: 'Root' } },
        { id: 'b1', type: 'branchNode', position: { x: 200, y: 0 }, data: { nodeId: 'b1', label: 'Branch 1', level: 1 } },
      ];
      const edges: Edge[] = [
        { id: 'e-root-b1', source: 'root', target: 'b1', data: { kind: 'tree' } },
      ];
      const styled = buildStyledCanvasEdges({
        allEdges: edges,
        layoutNodeById: new Map(nodes.map((n) => [n.id, n])),
        ancestorPathEdgeKeys: null,
        focusedNodeId: null,
        useBranchPalette: true,
        branchIndexById: computeBranchIndexMap(root, null),
        isDarkTheme: false,
        spotlightActiveIds: null,
      });

      expect((styled[0].data as { sourceLevel?: number }).sourceLevel).toBe(0);
      expect(styled[0].style?.strokeWidth).toBe('var(--mm-hover-stroke-width, 1.8px)');
      expect(styled[0].style?.stroke).toContain(getBranchColor(0, 0, false));
    });

    it('resets drag state on window blur, Escape, disabled toggle, and dragged node deletion, and locks effectiveRootId', () => {
      const root = createSampleTree();
      const moveNodes = vi.fn(() => true);
      const flowNodes: Node[] = [
        { id: 'root', position: { x: 0, y: 0 }, measured: { width: 100, height: 40 }, data: {} },
        { id: 'b1', position: { x: 200, y: 0 }, measured: { width: 100, height: 40 }, data: {} },
        { id: 'b2', position: { x: 200, y: 120 }, measured: { width: 100, height: 40 }, data: {} },
      ];
      let dragApi!: ReturnType<typeof useCanvasNodeDrag>;

      function InterruptDragHarness({
        tree,
        effectiveRootId = 'root',
        disabled = false,
      }: {
        tree: MindMapNode;
        effectiveRootId?: string;
        disabled?: boolean;
      }) {
        const prevRef = useRef<string | null>(null);
        dragApi = useCanvasNodeDrag({
          root: tree,
          effectiveRootId,
          disabled,
          selection: ['b2'],
          effectiveLayoutDirection: 'right',
          getNodes: () => flowNodes,
          setSelection: vi.fn(),
          setFocusedNodeId: vi.fn(),
          moveNodes,
          prevFocusedNodeIdRef: prevRef,
        });
        return null;
      }

      const { rerender } = render(<InterruptDragHarness tree={root} />);

      // 1. Window blur resets dragging
      act(() => {
        dragApi.onNodeDragStart({} as React.MouseEvent, flowNodes[2], [flowNodes[2]]);
      });
      expect(dragApi.isDragging).toBe(true);
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(dragApi.isDragging).toBe(false);
      expect(dragApi.dragPositionOverride).toEqual({});

      // 2. Escape resets dragging and stops propagation so outer listeners don't receive it
      const downstreamListener = vi.fn();
      window.addEventListener('keydown', downstreamListener);
      act(() => {
        dragApi.onNodeDragStart({} as React.MouseEvent, flowNodes[2], [flowNodes[2]]);
      });
      expect(dragApi.isDragging).toBe(true);
      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        window.dispatchEvent(escEvent);
      });
      expect(escEvent.defaultPrevented).toBe(true);
      expect(downstreamListener).not.toHaveBeenCalled();
      window.removeEventListener('keydown', downstreamListener);
      expect(dragApi.isDragging).toBe(false);

      // 3. Disabled flip resets dragging
      act(() => {
        dragApi.onNodeDragStart({} as React.MouseEvent, flowNodes[2], [flowNodes[2]]);
      });
      expect(dragApi.isDragging).toBe(true);
      rerender(<InterruptDragHarness tree={root} disabled />);
      expect(dragApi.isDragging).toBe(false);

      // 4. Dragged node disappearing from tree resets dragging
      rerender(<InterruptDragHarness tree={root} disabled={false} />);
      act(() => {
        dragApi.onNodeDragStart({} as React.MouseEvent, flowNodes[2], [flowNodes[2]]);
      });
      expect(dragApi.isDragging).toBe(true);
      const treeWithoutB2: MindMapNode = { ...root, children: [root.children[0]] };
      rerender(<InterruptDragHarness tree={treeWithoutB2} />);
      expect(dragApi.isDragging).toBe(false);

      // 5. effectiveRootId (viewRootId) cannot be dragged
      rerender(<InterruptDragHarness tree={root} effectiveRootId="b2" />);
      act(() => {
        dragApi.onNodeDragStart({} as React.MouseEvent, flowNodes[2], [flowNodes[2]]);
      });
      expect(dragApi.isDragging).toBe(false);
    });

    it('waits for isCanvasReady and prefers final layoutNodeById coordinates in useCanvasEditAutoZoom', () => {
      const setCenter = vi.fn();
      const ensureNodeVisible = vi.fn();
      const animatedNode: Node = {
        id: 'b1',
        position: { x: 10, y: 20 },
        measured: { width: 120, height: 40 },
        data: {},
      };
      const finalLayoutNode: Node = {
        id: 'b1',
        position: { x: 500, y: 300 },
        width: 120,
        height: 40,
        data: {},
      };
      const rfMock = {
        getNodes: () => [animatedNode],
        getZoom: () => 0.4,
        setCenter,
      } as unknown as ReactFlowInstance;

      function EditZoomReadyHarness({
        editingNodeId,
        isCanvasReady,
      }: {
        editingNodeId: string | null;
        isCanvasReady: boolean;
      }) {
        useCanvasEditAutoZoom({
          editingNodeId,
          isCanvasReady,
          layoutNodeById: new Map([['b1', finalLayoutNode]]),
          reactFlowInstance: rfMock,
          ensureNodeVisible,
        });
        return null;
      }

      const { rerender } = render(<EditZoomReadyHarness editingNodeId="b1" isCanvasReady={false} />);
      act(() => {
        vi.advanceTimersByTime(120);
      });
      expect(setCenter).not.toHaveBeenCalled();

      rerender(<EditZoomReadyHarness editingNodeId="b1" isCanvasReady />);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      // Targets final layout coordinates (500 + 60, 300 + 20) instead of mid-animation (10, 20)
      expect(setCenter).toHaveBeenCalledWith(560, 320, expect.objectContaining({ zoom: 0.85 }));
    });
  });
});
