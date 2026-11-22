import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;
  return {
    ...actual,
    useTranslation: () => ({ t }),
  };
});

import { createMindMapStore, MindMapStoreContext } from '../../../../store';
import { StyleRegistry } from '../../../../registry/StyleRegistry';
import { builtinThemes, darkTheme, paperTheme } from '../../../../styles/themes';
import { getBranchColor } from '../../../../constants/colors';
import { BranchNode, getMasteryBorderColor, type BranchNodeData } from '../BranchNode';
import { RootNode, type RootNodeData } from '../RootNode';
import { NodeContent } from '../NodeContent';
import { MindMapActiveContext } from '../../../../MindMapActiveContext';
import {
  clearPendingTypeToEditChar,
  useMindMapKeyboard,
} from '../../../../hooks/useMindMapKeyboard';

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

describe('Nodes, Lightbox, Embed Theme Sync & Selection Bubble Remediation', () => {
  beforeEach(() => {
    StyleRegistry.clear();
    builtinThemes.forEach((theme) => StyleRegistry.register(theme));
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    clearPendingTypeToEditChar();
    cleanup();
    document.documentElement.classList.remove('dark');
    vi.restoreAllMocks();
  });

  it('scopes image lightbox portal with .mindmap-container + fixed so --mm-* tokens resolve in light/dark mode', () => {
    render(
      <NodeContent
        text="Node With Image"
        images={[{ src: 'data:image/png;base64,AAA', name: 'Diagram B' }]}
      />,
    );

    fireEvent.click(screen.getByAltText('Diagram B'));
    const lightbox = screen.getByTestId('mm-image-lightbox');
    expect(lightbox.className).toContain('mindmap-container');
    expect(lightbox.className).toContain('fixed');
    expect(lightbox.style.background).toContain('var(--shadow-base)');
  });

  it('restores exact theme border on BranchNode & RootNode when mastery overlay turns off (no border/borderColor mix)', () => {
    const store = createMindMapStore();
    store.setState({ styleId: 'default' });

    const { container, rerender } = render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'b1',
            level: 1,
            showMasteryOverlay: false,
            masteryStatus: 'due',
          })}
        />
      </MindMapStoreContext.Provider>,
    );

    const branchEl = container.querySelector('.mm-branch-node') as HTMLElement;
    const initialBorder = branchEl.style.border;
    expect(initialBorder).toBeTruthy();

    // Enable mastery overlay
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'b1',
            level: 1,
            showMasteryOverlay: true,
            masteryStatus: 'due',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(branchEl.style.border).toContain('var(--warning');

    // Disable mastery overlay -> border must match initial theme border, never degrade to empty/currentColor
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'b1',
            level: 1,
            showMasteryOverlay: false,
            masteryStatus: 'due',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(branchEl.style.border).toBe(initialBorder);

    // Same contract for RootNode
    const { container: rootContainer, rerender: rerenderRoot } = render(
      <MindMapStoreContext.Provider value={store}>
        <RootNode
          {...makeRootProps({
            nodeId: 'root',
            showMasteryOverlay: false,
            masteryStatus: 'struggling',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    const rootEl = rootContainer.querySelector('.mm-root-node') as HTMLElement;
    const initialRootBorder = rootEl.style.border;
    expect(initialRootBorder).toBeTruthy();

    rerenderRoot(
      <MindMapStoreContext.Provider value={store}>
        <RootNode
          {...makeRootProps({
            nodeId: 'root',
            showMasteryOverlay: true,
            masteryStatus: 'struggling',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(rootEl.style.border).toContain('var(--destructive)');

    rerenderRoot(
      <MindMapStoreContext.Provider value={store}>
        <RootNode
          {...makeRootProps({
            nodeId: 'root',
            showMasteryOverlay: false,
            masteryStatus: 'struggling',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(rootEl.style.border).toBe(initialRootBorder);
  });

  it('orders L2+ --mm-underline-color by masteryBorderColor > hasCustomBg > branchColor', () => {
    const store = createMindMapStore();
    store.setState({ styleId: 'colorful' });

    const { container, rerender } = render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'leaf',
            level: 2,
            branchIndex: 0,
            showMasteryOverlay: true,
            masteryStatus: 'struggling',
            style: { bgColor: '#ffeeaa' },
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    const leafEl = container.querySelector('[data-node-chrome="underline"]') as HTMLElement;
    expect(leafEl.style.getPropertyValue('--mm-underline-color')).toBe(
      getMasteryBorderColor('struggling'),
    );

    // Turn off mastery -> custom bg derived color wins over branchColor
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'leaf',
            level: 2,
            branchIndex: 0,
            showMasteryOverlay: false,
            masteryStatus: 'struggling',
            style: { bgColor: '#ffeeaa' },
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(leafEl.style.getPropertyValue('--mm-underline-color')).toContain('#ffeeaa');

    // Remove custom bg -> branchColor takes over
    rerender(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'leaf',
            level: 2,
            branchIndex: 0,
            showMasteryOverlay: false,
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    expect(leafEl.style.getPropertyValue('--mm-underline-color')).toBe(getBranchColor(0, 1, false));
  });

  it('prioritizes data.embedStyleId over store styleId on RootNode and BranchNode and uses dark branch colors for dark themes', () => {
    const store = createMindMapStore();
    store.setState({ styleId: 'default' });

    const { container: rootBox } = render(
      <MindMapStoreContext.Provider value={store}>
        <RootNode {...makeRootProps({ nodeId: 'root', embedStyleId: 'dark' })} />
      </MindMapStoreContext.Provider>,
    );
    const rootEl = rootBox.querySelector('.mm-root-node') as HTMLElement;
    const probe = document.createElement('div');
    probe.style.background = darkTheme.node!.root.background;
    expect(rootEl.style.background).toBe(probe.style.background);

    const { container: branchBox } = render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode {...makeBranchProps({ nodeId: 'b1', level: 1, embedStyleId: 'paper' })} />
      </MindMapStoreContext.Provider>,
    );
    const branchEl = branchBox.querySelector('.mm-branch-node') as HTMLElement;
    const probePaper = document.createElement('div');
    probePaper.style.background = paperTheme.node!.branch.background;
    expect(branchEl.style.background).toBe(probePaper.style.background);

    // Explicit colorful-dark theme in light app mode uses dark rainbow palette
    const { container: darkRainbowBox } = render(
      <MindMapStoreContext.Provider value={store}>
        <BranchNode
          {...makeBranchProps({
            nodeId: 'b-dark-rainbow',
            level: 1,
            branchIndex: 1,
            embedStyleId: 'colorful-dark',
          })}
        />
      </MindMapStoreContext.Provider>,
    );
    const darkRainbowEl = darkRainbowBox.querySelector('.mm-branch-node') as HTMLElement;
    const probeDarkRainbow = document.createElement('div');
    probeDarkRainbow.style.borderColor = getBranchColor(1, 0, true);
    expect(darkRainbowEl.style.borderColor).toBe(probeDarkRainbow.style.borderColor);

    // Source contract for MindMapEmbed gradient & embedStyleId injection
    const embedSource = readFileSync(
      resolve(process.cwd(), 'src/features/mindmap/components/mindmap/MindMapEmbed.tsx'),
      'utf8',
    );
    expect(embedSource).toContain('embedStyleId');
    expect(embedSource).toContain('from-[var(--mm-bg)]/85');
    expect(embedSource).toContain('text-[var(--mm-text)]');
    expect(embedSource).not.toContain('from-background/80');
  });

  it('derives secondary note/unnamed/completed text from currentColor for contrast on dark/inverted root nodes', () => {
    const { container } = render(
      <NodeContent text="" note="Secondary note" isRoot isCompleted />,
    );
    const noteEl = screen.getByText('Secondary note');
    expect(noteEl.className).toContain('[color:color-mix(in_srgb,currentColor_68%,transparent)]');
    const textEl = container.querySelector('.mm-node-text') as HTMLElement;
    expect(textEl.className).toContain('[color:color-mix(in_srgb,currentColor_68%,transparent)]');
  });

  it('cleans up useTextSelectionBubble capture Escape listener when exiting edit mode or typing', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <NodeContent
        nodeId="n-sel"
        text="Alpha Beta"
        isEditing
        onAddBlank={vi.fn()}
        onToggleBold={vi.fn()}
        onEndEdit={vi.fn()}
      />,
    );

    const textarea = screen.getByDisplayValue('Alpha Beta') as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 5);
    fireEvent.mouseUp(textarea);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    // Selection bubble toolbar should now be mounted
    expect(document.querySelector('[role="toolbar"]')).toBeTruthy();

    // Typing closes the selection bubble immediately
    fireEvent.change(textarea, { target: { value: 'Alpha Beta!' } });
    expect(document.querySelector('[role="toolbar"]')).toBeNull();

    // Re-open selection bubble, then exit editing -> bubble & its capture Escape listener must clean up
    textarea.setSelectionRange(0, 5);
    fireEvent.mouseUp(textarea);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(document.querySelector('[role="toolbar"]')).toBeTruthy();

    rerender(
      <NodeContent
        nodeId="n-sel"
        text="Alpha Beta"
        isEditing={false}
        onAddBlank={vi.fn()}
        onToggleBold={vi.fn()}
        onEndEdit={vi.fn()}
      />,
    );
    expect(document.querySelector('[role="toolbar"]')).toBeNull();

    // Subsequent Escape must NOT be swallowed by a zombie capture listener
    const postExitEsc = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(postExitEsc);
    expect(postExitEsc.defaultPrevented).toBe(false);
    vi.useRealTimers();
  });

  it('integrates useMindMapKeyboard type-to-edit synchronously with real NodeContent and restores original text on Escape', () => {
    const store = createMindMapStore();
    const rootId = store.getState().document.root.id;
    const nodeId = store.getState().addNode(rootId)!;
    store.getState().updateNode(nodeId, { text: '初始内容' });
    store.setState({ focusedNodeId: nodeId, selection: [nodeId], editingNodeId: null });

    const IntegrationHarness: React.FC = () => {
      useMindMapKeyboard();
      const isEditing = store.getState().editingNodeId === nodeId;
      const [, forceRender] = React.useState(0);
      React.useEffect(() => store.subscribe(() => forceRender((n) => n + 1)), []);
      return (
        <NodeContent
          nodeId={nodeId}
          text="初始内容"
          isEditing={isEditing}
          onTextChange={(next) => store.getState().updateNode(nodeId, { text: next })}
          onEndEdit={() => store.getState().setEditingNodeId(null)}
        />
      );
    };

    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <IntegrationHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'X', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });

    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.value).toBe('X');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(store.getState().editingNodeId).toBeNull();
    expect(screen.getByText('初始内容')).toBeInTheDocument();
  });
});
