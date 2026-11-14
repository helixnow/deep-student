import React, { useRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const zhGraph = (await import('@/locales/zh-CN/graph_conflict.json')).default as Record<
    string,
    unknown
  >;
  const zhMm = (await import('@/locales/zh-CN/mindmap.json')).default as Record<
    string,
    unknown
  >;
  const bundles: Record<string, Record<string, unknown>> = {
    graph_conflict: zhGraph,
    mindmap: zhMm,
  };

  function lookup(root: Record<string, unknown> | undefined, pathStr: string): string | undefined {
    if (!root) return undefined;
    let cur: unknown = root;
    for (const part of pathStr.split('.')) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : undefined;
  }

  function interpolate(tpl: string, opts?: Record<string, unknown>): string {
    if (!opts) return tpl;
    return tpl.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, k: string) =>
      opts[k] === undefined ? m : String(opts[k]),
    );
  }

  const cache = new Map<string, { t: (key: string, opts?: Record<string, unknown>) => string }>();
  return {
    useTranslation: (nsInput?: string | string[]) => {
      const defaultNs = Array.isArray(nsInput) ? nsInput[0] : (nsInput ?? 'common');
      const cacheKey = Array.isArray(nsInput) ? nsInput.join('|') : defaultNs;
      let entry = cache.get(cacheKey);
      if (!entry) {
        entry = {
          t: (key: string, opts?: Record<string, unknown>) => {
            let ns = typeof opts?.ns === 'string' ? opts.ns : defaultNs;
            let bareKey = key;
            if (key.includes(':')) {
              const [p, rest] = key.split(':', 2);
              ns = p;
              bareKey = rest;
            }
            const found = lookup(bundles[ns], bareKey);
            if (found !== undefined) return interpolate(found, opts);
            const fallback = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
            return interpolate(fallback, opts);
          },
        };
        cache.set(cacheKey, entry);
      }
      return entry;
    },
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

import {
  registerMindMapStore,
  useMindMapStore,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/features/mindmap/types';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import { proposeMindmapOps } from '@/features/workbench/agent/drivers/mindmapDriver';
import {
  __clearAllMindmapSuggestions,
  getAcceptedMindmapCheckpoint,
  getMindmapSuggestion,
} from '@/features/workbench/agent/drivers/mindmapSuggestionStore';
import { MindMapGhostProposalLayer } from '../MindMapGhostProposalLayer';
import { MindmapAgentSuggestionBar } from '../MindmapAgentSuggestionBar';

const MM_ID = 'mm_ghost_ui_test';
let unregisterStore = () => undefined;

function createDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: '概率论与数理统计',
      children: [
        { id: 'node_rv', text: '随机变量', children: [] },
        {
          id: 'node_obsolete',
          text: '过时附录',
          children: [{ id: 'node_obsolete_1', text: '附录子项', children: [] }],
        },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

const GhostTestHarness: React.FC = () => {
  const hostRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <MindmapAgentSuggestionBar mindmapId={MM_ID} />
      <div ref={hostRef} data-testid="canvas-host">
        <div className="react-flow__viewport" data-testid="rf-viewport" />
        <MindMapGhostProposalLayer hostRef={hostRef} />
      </div>
    </div>
  );
};

beforeEach(() => {
  __clearAllMindmapSuggestions();
  unregisterStore = registerMindMapStore(MM_ID, useMindMapStore, `win_ui:mindmap:${MM_ID}`);
  useMindMapStore.setState({
    mindmapId: MM_ID,
    metadata: null,
    document: JSON.parse(JSON.stringify(createDoc())) as MindMapDocument,
    currentView: 'mindmap',
    focusedNodeId: null,
    editingNodeId: null,
    selection: [],
    reciteMode: false,
    isDirty: false,
    isSaving: false,
    _documentVersion: 0,
    layoutId: 'tree',
    layoutDirection: 'right',
    measuredNodeHeights: {},
    _reactFlowGetter: () => ({
      getNodes: () => [
        { id: 'root', position: { x: 0, y: 100 }, width: 160, height: 48 },
        { id: 'node_rv', position: { x: 240, y: 60 }, width: 120, height: 38 },
        { id: 'node_obsolete', position: { x: 240, y: 160 }, width: 120, height: 38 },
      ],
    }),
    save: vi.fn(async () => {
      useMindMapStore.setState({ isDirty: false, isSaving: false });
      return true;
    }),
  });
});

afterEach(() => {
  __clearAllMindmapSuggestions();
  unregisterStore();
  useMindMapStore.getState().reset();
});

describe('MindMapGhostProposalLayer & MindmapAgentSuggestionBar UI', () => {
  it('renders dashed Ghost Nodes, modify_node inline diff pill, struck-through remove_subtree badge, and enforces pointer-events-none + nodrag nopan', async () => {
    act(() => {
      proposeMindmapOps({
        mindmapId: MM_ID,
        windowId: 'win_ui',
        ops: [
          {
            kind: 'add_node',
            anchor: { parent_id: 'node_rv' },
            payload: { data: { text: '大数定律与中心极限定理', children: [] } },
            destructive: false,
            label: '添加极限定理分支',
          },
          {
            kind: 'update_node',
            anchor: { node_id: 'node_rv' },
            payload: { patch: { text: '随机变量及其分布' } },
            destructive: false,
            label: '完善随机变量标题',
          },
          {
            kind: 'delete_node',
            anchor: { node_id: 'node_obsolete' },
            payload: {},
            destructive: true,
            label: '删除过时附录',
          },
        ],
      });
    });

    render(<GhostTestHarness />);

    const layer = screen.getByTestId('mindmap-ghost-proposal-layer');
    expect(layer.className).toContain('pointer-events-none');
    // Portaled inside .react-flow__viewport
    expect(screen.getByTestId('rf-viewport').contains(layer)).toBe(true);

    // 1) Ghost Added Node with border-dashed and AI 建议 badge
    const ghostNodeText = screen.getByText('大数定律与中心极限定理');
    const ghostNodeEl = ghostNodeText.closest('.mm-ghost-node')!;
    expect(ghostNodeEl).not.toBeNull();
    expect(ghostNodeEl.className).toContain('border-dashed');
    expect(ghostNodeEl.className).toContain('pointer-events-none');
    expect(screen.getByText('AI 建议')).toBeTruthy();

    // 2) Inline modify_node diff pill (struck-through beforeText -> afterText)
    expect(screen.getByText('随机变量及其分布')).toBeTruthy();
    const struckTexts = Array.from(layer.querySelectorAll('.line-through')).map(
      (el) => el.textContent,
    );
    expect(struckTexts).toContain('随机变量');

    // 3) Struck-through remove_subtree badge with subtree count (-2)
    expect(screen.getByText('建议移除')).toBeTruthy();
    expect(screen.getByText('· -2')).toBeTruthy();
    expect(struckTexts).toContain('过时附录');

    // 4) Action capsules carry pointer-events-auto + nodrag + nopan (C6 §4)
    const acceptBranchBtns = screen.getAllByRole('button', { name: '采纳分支' });
    expect(acceptBranchBtns).toHaveLength(3);
    for (const btn of acceptBranchBtns) {
      expect(btn.className).toContain('nodrag');
      expect(btn.className).toContain('nopan');
      expect(btn.className).toContain('pointer-events-auto');
    }

    // Click [采纳分支] on the Ghost Added Node branch -> materializes ONLY that branch!
    await act(async () => {
      fireEvent.click(acceptBranchBtns[0]);
    });

    await waitFor(() => {
      expect(getMindmapSuggestion(MM_ID)?.branches).toHaveLength(2);
    });
    expect(
      findNodeById(useMindMapStore.getState().document.root, 'node_rv')?.children.some(
        (c) => c.text === '大数定律与中心极限定理',
      ),
    ).toBe(true);
    // Remaining 2 branches stay rendered as pending diff annotations
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_obsolete')).not.toBeNull();
  });

  it('supports Outline View branch list parity and [全部采纳] -> [全部撤回] checkpoint lifecycle', async () => {
    act(() => {
      useMindMapStore.setState({ currentView: 'outline' });
      proposeMindmapOps({
        mindmapId: MM_ID,
        windowId: 'win_ui',
        ops: [
          {
            kind: 'update_node',
            anchor: { node_id: 'node_rv' },
            payload: { patch: { text: '多维随机变量' } },
            destructive: false,
            label: '修改随机变量',
          },
          {
            kind: 'delete_node',
            anchor: { node_id: 'node_obsolete' },
            payload: {},
            destructive: true,
            label: '移除附录',
          },
        ],
      });
    });

    render(<MindmapAgentSuggestionBar mindmapId={MM_ID} />);

    // In Outline View, branch list expands automatically for full parity
    const branchList = screen.getByTestId('mindmap-ghost-branch-list');
    expect(branchList).toBeTruthy();

    // Discard the second branch (remove_subtree) directly from Outline branch list
    const rejectBtns = screen.getAllByRole('button', { name: /放弃/ });
    expect(rejectBtns).toHaveLength(2);
    act(() => {
      fireEvent.click(rejectBtns[1]);
    });

    expect(getMindmapSuggestion(MM_ID)?.branches).toHaveLength(1);
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_obsolete')).not.toBeNull();

    // Click [全部采纳] on remaining proposal -> transitions to post-accept checkpoint banner
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /全部采纳/ }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('mindmap-ghost-checkpoint-bar')).toBeTruthy();
    });
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_rv')?.text).toBe(
      '多维随机变量',
    );
    expect(getAcceptedMindmapCheckpoint(MM_ID)?.appliedCount).toBe(1);

    // Click [全部撤回] on post-accept checkpoint banner -> restores pre-accept document and hides bar
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /全部撤回/ }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('mindmap-ghost-checkpoint-bar')).toBeNull();
    });
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_rv')?.text).toBe(
      '随机变量',
    );
    expect(getAcceptedMindmapCheckpoint(MM_ID)).toBeNull();
  });
});
