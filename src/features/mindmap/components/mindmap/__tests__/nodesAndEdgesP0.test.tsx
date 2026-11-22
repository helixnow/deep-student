import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => ({
  Position: {
    Left: 'left',
    Right: 'right',
    Top: 'top',
    Bottom: 'bottom',
  },
  Handle: ({
    type,
    position,
    style,
    className,
  }: {
    type: string;
    position: string;
    style?: React.CSSProperties;
    className?: string;
  }) => (
    <div
      data-testid={`rf-handle-${type}`}
      data-position={position}
      className={className}
      style={style}
    />
  ),
  BaseEdge: ({ id, path, style, className }: Record<string, unknown>) => (
    <path
      data-testid="rf-base-edge"
      id={id as string}
      d={path as string}
      className={className as string}
      style={style as React.CSSProperties}
    />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getBezierPath: () => ['M0,0 C10,0 20,10 30,10', 15, 5],
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;
  return {
    ...actual,
    useTranslation: () => ({ t }),
  };
});

import { createMindMapStore, MindMapStoreContext } from '../../../store';
import { StyleRegistry } from '../../../registry/StyleRegistry';
import { builtinThemes } from '../../../styles/themes';
import { getBranchColor } from '../../../constants/colors';
import { BranchNode, type BranchNodeData } from '../nodes/BranchNode';
import { RootNode, type RootNodeData } from '../nodes/RootNode';
import { NodeContent } from '../nodes/NodeContent';
import { CurvedEdge } from '../edges/CurvedEdge';
import { AssociationEdge } from '../edges/AssociationEdge';
import { SummaryBraceOverlay } from '../SummaryBraceOverlay';
import { BlankedText } from '../../shared/BlankedText';
import { PriorityBadge } from '../../shared/NodeDecorationBadges';
import { NodeSourcePills } from '../../shared/NodeSourcePills';

function makeBranchProps(overrides: Partial<BranchNodeData> = {}) {
  const data: BranchNodeData = {
    label: 'Branch A',
    nodeId: 'node-a',
    level: 1,
    collapsed: false,
    completed: false,
    hasChildren: false,
    childCount: 0,
    sourcePosition: 'right',
    targetPosition: 'left',
    ...overrides,
  };
  return {
    id: data.nodeId,
    type: 'branchNode',
    data,
    selected: false,
    dragging: false,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as React.ComponentProps<typeof BranchNode>;
}

function makeRootProps(overrides: Partial<RootNodeData> = {}) {
  const data: RootNodeData = {
    label: 'Root Topic',
    nodeId: 'root',
    completed: false,
    hasChildren: true,
    childCount: 2,
    sourcePosition: 'right',
    ...overrides,
  };
  return {
    id: data.nodeId,
    type: 'rootNode',
    data,
    selected: false,
    dragging: false,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as React.ComponentProps<typeof RootNode>;
}

describe('Nodes & Edges P0 fixes', () => {
  beforeEach(() => {
    StyleRegistry.clear();
    builtinThemes.forEach((theme) => StyleRegistry.register(theme));
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('dark');
    vi.restoreAllMocks();
  });

  it('wraps BranchNode, RootNode, and CurvedEdge in React.memo', () => {
    const memoSymbol = Symbol.for('react.memo');
    expect((BranchNode as unknown as { $$typeof?: symbol }).$$typeof).toBe(memoSymbol);
    expect((RootNode as unknown as { $$typeof?: symbol }).$$typeof).toBe(memoSymbol);
    expect((CurvedEdge as unknown as { $$typeof?: symbol }).$$typeof).toBe(memoSymbol);
  });

  it('isolates BranchNode re-renders via atomic per-nodeId selectors', () => {
    const store = createMindMapStore();
    const rootId = store.getState().document.root.id;
    const nodeA = store.getState().addNode(rootId)!;
    const nodeB = store.getState().addNode(rootId)!;
    store.getState().updateNode(nodeA, { text: 'Node A' });
    store.getState().updateNode(nodeB, { text: 'Node B' });

    const onRenderA = vi.fn();
    const propsA = makeBranchProps({ nodeId: nodeA, label: 'Node A' });

    render(
      <MindMapStoreContext.Provider value={store}>
        <React.Profiler id="node-a" onRender={onRenderA}>
          <BranchNode {...propsA} />
        </React.Profiler>
      </MindMapStoreContext.Provider>,
    );

    const initialRenders = onRenderA.mock.calls.length;
    expect(initialRenders).toBe(1);

    // Mutating volatile global store fields for nodeB must NOT re-render nodeA
    act(() => {
      store.getState().setEditingNodeId(nodeB);
      store.getState().setEditingNoteNodeId(nodeB);
      store.setState({ searchResults: [nodeB], currentSearchIndex: 0 });
      store.getState().revealBlank(nodeB, 0);
    });
    expect(onRenderA.mock.calls.length).toBe(initialRenders);

    // Mutating editingNodeId for nodeA DOES re-render nodeA and sets data-node-editing="true"
    act(() => {
      store.getState().setEditingNodeId(nodeA);
    });
    expect(onRenderA.mock.calls.length).toBeGreaterThan(initialRenders);
    expect(document.querySelector('[data-node-editing="true"]')).toBeTruthy();
  });

  it('aligns vertical orgchart L2+ handles to true top/bottom center without piercing text', () => {
    const store = createMindMapStore();
    const props = makeBranchProps({
      nodeId: 'org-leaf',
      level: 2,
      targetPosition: 'top',
      sourcePosition: 'bottom',
    });

    render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode {...props} />
      </MindMapStoreContext.Provider>,
    );

    const targetHandle = screen.getByTestId('rf-handle-target');
    const sourceHandle = screen.getByTestId('rf-handle-source');

    expect(targetHandle.getAttribute('data-position')).toBe('top');
    expect(targetHandle.style.top).toBe('-3px');
    expect(targetHandle.style.left).toBe('50%');
    expect(targetHandle.style.bottom).toBe('auto');
    expect(targetHandle.style.transform).toBe('translateX(-50%)');

    expect(sourceHandle.getAttribute('data-position')).toBe('bottom');
    expect(sourceHandle.style.bottom).toBe('-4px');
    expect(sourceHandle.style.left).toBe('50%');
    expect(sourceHandle.style.transform).toBe('translateX(-50%)');
  });

  it('offsets action buttons away from same-side collapse dot, docks left on left-growing nodes, and renders >=100 capsule pill', () => {
    const store = createMindMapStore();

    // Case 1: right-side node with >=100 collapsed children
    const { container, rerender } = render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'right-heavy',
            hasChildren: true,
            collapsed: true,
            childCount: 128,
            sourcePosition: 'right',
            targetPosition: 'left',
          })}
        />
      </MindMapStoreContext.Provider>,
    );

    const collapseBtn = container.querySelector('.mm-collapse-btn') as HTMLElement;
    expect(collapseBtn.className).toContain('min-w-5');
    expect(collapseBtn.className).toContain('px-1');
    expect(collapseBtn.className).toContain('rounded-full');
    expect(collapseBtn.textContent).toBe('128');

    const actionsRight = container.querySelector('.mm-node-actions') as HTMLElement;
    expect(actionsRight.style.left).toBe('100%');
    expect(actionsRight.style.marginLeft).toBe('36px');

    // Case 2: right-side expanded node with children -> 28px clearance
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'right-expanded',
            hasChildren: true,
            collapsed: false,
            childCount: 3,
            sourcePosition: 'right',
            targetPosition: 'left',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect((container.querySelector('.mm-node-actions') as HTMLElement).style.marginLeft).toBe('28px');

    // Case 3: left-growing node -> actions dock on left with 28px clearance
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'left-branch',
            hasChildren: true,
            collapsed: false,
            childCount: 5,
            sourcePosition: 'left',
            targetPosition: 'right',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    const actionsLeft = container.querySelector('.mm-node-actions') as HTMLElement;
    expect(actionsLeft.style.right).toBe('100%');
    expect(actionsLeft.style.left).toBe('auto');
    expect(actionsLeft.style.marginRight).toBe('28px');
  });

  it('renders FSRS mastery micro-dot and data-mastery-status on BranchNode and RootNode when overlay is enabled', () => {
    const store = createMindMapStore();

    const { container, rerender } = render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'fsrs-node',
            masteryStatus: 'struggling',
            showMasteryOverlay: true,
          })}
        />
      </MindMapStoreContext.Provider>,
    );

    expect(container.querySelector('[data-mastery-status="struggling"]')).toBeTruthy();
    expect(screen.getByTestId('mm-mastery-dot')).toHaveAttribute('data-mastery-status', 'struggling');

    // Disabled overlay hides dot and attribute
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'fsrs-node',
            masteryStatus: 'struggling',
            showMasteryOverlay: false,
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(container.querySelector('[data-mastery-status]')).toBeNull();

    // RootNode supports data-node-editing and mastery overlay
    act(() => {
      store.getState().setEditingNodeId('root');
    });
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <RootNode
          {...makeRootProps({
            nodeId: 'root',
            masteryStatus: 'mastered',
            showMasteryOverlay: true,
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(container.querySelector('[data-node-editing="true"]')).toBeTruthy();
    expect(screen.getByTestId('mm-mastery-dot')).toHaveAttribute('data-mastery-status', 'mastered');
  });

  it('activates low-saturation mineral rainbow branch colors when colorful theme is selected', () => {
    const store = createMindMapStore();
    store.setState({ styleId: 'colorful' });

    const { container } = render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'rainbow-branch',
            level: 1,
            branchIndex: 2,
          })}
        />
      </MindMapStoreContext.Provider>,
    );

    const nodeEl = container.querySelector('.mm-branch-node') as HTMLElement;
    const probe = document.createElement('div');
    probe.style.borderColor = getBranchColor(2, 0, false);
    expect(nodeEl.style.borderColor).toBe(probe.style.borderColor);
  });

  it('unblocks normal canvas drag in BlankedText when not reciting and not editing', () => {
    const onParentPointerDown = vi.fn();
    const onParentMouseDown = vi.fn();

    const { container } = render(
      <div onPointerDown={onParentPointerDown} onMouseDown={onParentMouseDown}>
        <NodeContent
          text="Draggable Topic"
          reciteMode={false}
          isEditing={false}
          onAddBlank={vi.fn()}
        />
      </div>,
    );

    const textEl = container.querySelector('.mm-node-text') as HTMLElement;
    expect(textEl).toBeTruthy();
    expect(textEl.className).not.toContain('nodrag');
    expect(textEl.className).not.toContain('nopan');
    expect(textEl.style.cursor).not.toBe('text');
    expect(textEl.style.userSelect).toBe('none');

    fireEvent.pointerDown(textEl);
    fireEvent.mouseDown(textEl);
    expect(onParentPointerDown).toHaveBeenCalledTimes(1);
    expect(onParentMouseDown).toHaveBeenCalledTimes(1);
  });

  it('uses semantic contrast styling and motion-reduce on BlankedText in recite mode', () => {
    const { container } = render(
      <BlankedText
        text="Alpha Beta Gamma"
        blankedRanges={[
          { start: 0, end: 5 },
          { start: 6, end: 10 },
        ]}
        revealedIndices={{ 0: true }}
        reciteMode
        onRevealBlank={vi.fn()}
      />,
    );

    const revealed = container.querySelector('[data-blank-state="revealed"]') as HTMLElement;
    const covered = container.querySelector('[data-blank-state="covered"]') as HTMLElement;

    expect(revealed.className).not.toContain('bg-emerald-100');
    expect(revealed.className).toContain('motion-reduce:transition-none');
    expect(revealed.style.backgroundColor).toContain('var(--success');

    expect(covered.style.color).not.toBe('var(--mm-text)');
    expect(covered.className).toContain('motion-reduce:transition-none');
  });

  it('unifies note textarea shortcuts: Escape cancels/restores, Cmd/Ctrl+Enter saves, plain Enter keeps newline', () => {
    const onNoteChange = vi.fn();
    const onEndEditNote = vi.fn();

    const { rerender } = render(
      <NodeContent
        text="Title"
        note="Original note"
        isEditingNote
        onNoteChange={onNoteChange}
        onEndEditNote={onEndEditNote}
      />,
    );

    const textarea = screen.getByDisplayValue('Original note');
    fireEvent.change(textarea, { target: { value: 'Unsaved edit' } });

    // Plain Enter does NOT save
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onNoteChange).not.toHaveBeenCalled();
    expect(onEndEditNote).not.toHaveBeenCalled();

    // Escape cancels and restores without calling onNoteChange
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onNoteChange).not.toHaveBeenCalled();
    expect(onEndEditNote).toHaveBeenCalledTimes(1);

    // Re-open note editor and commit with Cmd+Enter
    onEndEditNote.mockClear();
    rerender(
      <NodeContent
        text="Title"
        note="Original note"
        isEditingNote
        onNoteChange={onNoteChange}
        onEndEditNote={onEndEditNote}
      />,
    );
    const textarea2 = screen.getByDisplayValue('Original note');
    fireEvent.change(textarea2, { target: { value: 'Saved note' } });
    fireEvent.keyDown(textarea2, { key: 'Enter', metaKey: true });
    expect(onNoteChange).toHaveBeenCalledWith('Saved note');
    expect(onEndEditNote).toHaveBeenCalledTimes(1);
  });

  it('opens and closes full-screen image lightbox on thumbnail click, Escape, and close button', () => {
    render(
      <NodeContent
        text="With Image"
        images={[{ src: 'data:image/png;base64,AAA', name: 'Diagram A' }]}
      />,
    );

    const thumbImg = screen.getByAltText('Diagram A');
    fireEvent.click(thumbImg);

    expect(screen.getByTestId('mm-image-lightbox')).toBeInTheDocument();

    // Close via Escape
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('mm-image-lightbox')).toBeNull();

    // Reopen and close via close button
    fireEvent.click(thumbImg);
    expect(screen.getByTestId('mm-image-lightbox')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mm-image-lightbox-close'));
    expect(screen.queryByTestId('mm-image-lightbox')).toBeNull();
  });

  it('uses hsl(var(--destructive-foreground)) on Priority 1 badge for dark/light contrast', () => {
    const { container } = render(<PriorityBadge priority={1} />);
    const badge = container.querySelector('.mm-deco-priority') as HTMLElement;
    expect(badge.style.backgroundColor).toBe('hsl(var(--destructive))');
    expect(badge.style.color).toBe('hsl(var(--destructive-foreground))');
  });

  it('guards WKWebView IME post-compositionend Enter in NodeContent, AssociationEdge, SummaryBraceOverlay, and NodeSourcePills', () => {
    let now = 2000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(now);
      return 1;
    });

    // 1. NodeContent title
    const onTextChange = vi.fn();
    const onEndEdit = vi.fn();
    render(
      <NodeContent
        text="Old"
        isEditing
        onTextChange={onTextChange}
        onEndEdit={onEndEdit}
      />,
    );
    const titleInput = screen.getByDisplayValue('Old');
    fireEvent.compositionStart(titleInput);
    fireEvent.change(titleInput, { target: { value: '中文' } });
    fireEvent.compositionEnd(titleInput);
    now = 2020; // within 100ms WKWebView window
    fireEvent.keyDown(titleInput, { key: 'Enter' });
    expect(onTextChange).not.toHaveBeenCalled();
    expect(onEndEdit).not.toHaveBeenCalled();
    cleanup();

    // 2. AssociationEdge
    const onAssocChange = vi.fn();
    render(
      <AssociationEdge
        id="assoc-1"
        source="a"
        target="b"
        sourceX={0}
        sourceY={0}
        targetX={100}
        targetY={50}
        sourcePosition={'right' as never}
        targetPosition={'left' as never}
        data={{
          kind: 'association',
          associationId: 'assoc-1',
          label: 'rel',
          editing: true,
          onLabelChange: onAssocChange,
        }}
      />,
    );
    const assocInput = screen.getByDisplayValue('rel');
    fireEvent.compositionStart(assocInput);
    fireEvent.compositionEnd(assocInput);
    now = 2030;
    fireEvent.keyDown(assocInput, { key: 'Enter' });
    expect(onAssocChange).not.toHaveBeenCalled();
    cleanup();

    // 3. SummaryBraceOverlay (IME + coarse touch delete button + motion-reduce)
    const onSummaryUpdate = vi.fn();
    const root = {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'c1', text: 'C1', children: [] },
        { id: 'c2', text: 'C2', children: [] },
      ],
    };
    const layoutMap = new Map([
      ['root', { position: { x: 0, y: 0 }, width: 100, height: 36 }],
      ['c1', { position: { x: 160, y: 0 }, width: 100, height: 36 }],
      ['c2', { position: { x: 160, y: 60 }, width: 100, height: 36 }],
    ]);
    render(
      <SummaryBraceOverlay
        summaries={[{
          id: 'sum-1',
          parentId: 'root',
          startChildId: 'c1',
          endChildId: 'c2',
          label: '归纳',
        }]}
        root={root}
        layoutNodeById={layoutMap}
        direction="right"
        onUpdateLabel={onSummaryUpdate}
        onRemove={vi.fn()}
      />,
    );
    const removeBtn = screen.getByTestId('mm-summary-brace-remove');
    expect(removeBtn.className).toContain('motion-reduce:transition-none');
    expect(removeBtn.className).toContain('[@media(pointer:coarse)]:opacity-80');
    expect(removeBtn.className).toContain('[@media(pointer:coarse)]:after:-inset-[14px]');

    fireEvent.click(screen.getByText('归纳'));
    const summaryInput = screen.getByTestId('mm-summary-brace-input');
    fireEvent.compositionStart(summaryInput);
    fireEvent.compositionEnd(summaryInput);
    now = 2040;
    fireEvent.keyDown(summaryInput, { key: 'Enter' });
    expect(onSummaryUpdate).not.toHaveBeenCalled();
    cleanup();

    // 4. NodeSourcePills cardNote textarea
    const onCardNoteChange = vi.fn();
    render(
      <NodeSourcePills
        anchors={[]}
        cardNote="批注"
        onCardNoteChange={onCardNoteChange}
      />,
    );
    fireEvent.click(screen.getByText('批注'));
    const cardInput = screen.getByTestId('mm-node-card-note-input');
    fireEvent.compositionStart(cardInput);
    fireEvent.compositionEnd(cardInput);
    now = 2050;
    fireEvent.keyDown(cardInput, { key: 'Enter', metaKey: true });
    expect(onCardNoteChange).not.toHaveBeenCalled();
  });
});
