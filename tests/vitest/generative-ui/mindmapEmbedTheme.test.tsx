import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';

const { capturedFlowProps, apiMocks } = vi.hoisted(() => ({
  capturedFlowProps: { current: null as { nodes: Node[]; edges: Edge[] } | null },
  apiMocks: {
    getMindMap: vi.fn(),
    getMindMapContent: vi.fn(),
    getMindMapVersion: vi.fn(),
    getMindMapVersionContent: vi.fn(),
  },
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  const translation = { t };
  return {
    useTranslation: () => translation,
    initReactI18next: { type: '3rdParty' as const, init: () => undefined },
  };
});

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: { nodes: Node[]; edges: Edge[] }) => {
    capturedFlowProps.current = { nodes: props.nodes, edges: props.edges };
    return <div data-testid="embed-flow" />;
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({
    fitView: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    setCenter: vi.fn(),
    getZoom: () => 1,
  }),
  useNodesInitialized: () => true,
}));

vi.mock('@/features/mindmap/components/mindmap/nodes', () => ({ nodeTypes: {} }));
vi.mock('@/features/mindmap/components/mindmap/edges', () => ({ edgeTypes: {} }));
vi.mock('@/features/mindmap/api', () => apiMocks);
vi.mock('@/dstu', () => ({ dstu: { watch: vi.fn(() => () => undefined) } }));

import { StyleRegistry } from '@/features/mindmap/registry/StyleRegistry';
import {
  COLORFUL_DARK_PALETTE,
  COLORFUL_LIGHT_PALETTE,
  defaultDarkTheme,
  defaultTheme,
} from '@/features/mindmap/styles/themes';
import {
  MindMapEmbed,
  shouldApplyEmbedBranchPalette,
} from '@/features/mindmap/components/mindmap/MindMapEmbed';

function makeDocJson(styleId: string): string {
  return JSON.stringify({
    version: '1.0',
    root: {
      id: 'root',
      text: 'Root Topic',
      children: [
        { id: 'b1', text: 'Branch 1', children: [] },
        { id: 'b2', text: 'Branch 2', children: [] },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00Z',
      renderConfig: {
        layoutId: 'balanced',
        direction: 'both',
        styleId,
        edgeType: 'bezier',
      },
    },
  });
}

describe('MindMapEmbed — live dark mode & useBranchPalette parity', () => {
  beforeEach(() => {
    capturedFlowProps.current = null;
    document.documentElement.classList.remove('dark');
    apiMocks.getMindMap.mockReset().mockResolvedValue({
      id: 'mm_theme',
      resourceId: 'res_theme',
      title: 'Theme Embed',
      isFavorite: false,
      defaultView: 'mindmap',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    apiMocks.getMindMapContent.mockReset().mockResolvedValue(makeDocJson('default'));
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    StyleRegistry.unregister('custom-rainbow');
    StyleRegistry.unregister('custom-mono');
  });

  it('keeps default theme monochrome and updates CSS vars live when dark mode toggles', async () => {
    const { container } = render(<MindMapEmbed mindmapId="mm_theme" />);
    await screen.findByTestId('embed-flow');

    const rootEl = container.querySelector('.mindmap-container') as HTMLElement;
    expect(rootEl.style.getPropertyValue('--mm-bg')).toBe(defaultTheme.canvas?.background);

    // default 主题单色，不注入彩虹 branchColor / 彩色边 stroke
    const branchNode = capturedFlowProps.current?.nodes.find((n) => n.id === 'b1');
    const branchEdge = capturedFlowProps.current?.edges.find((e) => e.target === 'b1');
    expect(branchNode?.data?.branchColor).toBeUndefined();
    expect(branchEdge?.style?.stroke).toBeUndefined();

    // 实时切换 html.dark -> useMindMapTheme 立刻切换至 default-dark
    await act(async () => {
      document.documentElement.classList.add('dark');
    });
    await waitFor(() => {
      expect(rootEl.style.getPropertyValue('--mm-bg')).toBe(defaultDarkTheme.canvas?.background);
    });
    expect(capturedFlowProps.current?.nodes.find((n) => n.id === 'b1')?.data?.branchColor).toBeUndefined();
  });

  it('applies rainbow palette for colorful theme and switches to dark palette in dark mode', async () => {
    apiMocks.getMindMapContent.mockResolvedValue(makeDocJson('colorful'));
    render(<MindMapEmbed mindmapId="mm_theme" />);
    await screen.findByTestId('embed-flow');

    expect(capturedFlowProps.current?.nodes.find((n) => n.id === 'b1')?.data?.branchColor).toBe(
      COLORFUL_LIGHT_PALETTE[0],
    );
    expect(capturedFlowProps.current?.edges.find((e) => e.target === 'b1')?.style?.stroke).toBe(
      COLORFUL_LIGHT_PALETTE[0],
    );

    await act(async () => {
      document.documentElement.classList.add('dark');
    });
    await waitFor(() => {
      expect(capturedFlowProps.current?.nodes.find((n) => n.id === 'b1')?.data?.branchColor).toBe(
        COLORFUL_DARK_PALETTE[0],
      );
    });
    expect(capturedFlowProps.current?.edges.find((e) => e.target === 'b1')?.style?.stroke).toBe(
      COLORFUL_DARK_PALETTE[0],
    );
  });

  it('strictly honors explicit theme.useBranchPalette flag', () => {
    expect(
      shouldApplyEmbedBranchPalette({
        id: 'custom-rainbow',
        name: 'Custom Rainbow',
        palette: ['#111111', '#222222'],
        useBranchPalette: true,
      }),
    ).toBe(true);
    expect(
      shouldApplyEmbedBranchPalette({
        id: 'colorful',
        name: 'Colorful Overridden',
        palette: ['#111111', '#222222'],
        useBranchPalette: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyEmbedBranchPalette({
        id: 'default',
        name: 'Default',
        palette: ['#111111', '#222222'],
      }),
    ).toBe(false);
  });
});
