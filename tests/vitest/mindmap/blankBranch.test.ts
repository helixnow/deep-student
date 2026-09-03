/**
 * 背诵按分支批量遮挡（blankBranchNodes / clearBranchBlanks）：
 * - 子树内非空文本节点整行挖空（含分支根自身），空文本节点跳过
 * - 已有部分挖空合并为整行；受影响节点的揭示状态重置
 * - 整批操作单次 undo 还原
 * - clearBranchBlanks 清空子树挖空与揭示状态
 */
import { afterEach, describe, expect, it } from 'vitest';

import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import type { MindMapDocument } from '@/features/mindmap/types';

function createDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_blank',
      text: 'Root',
      children: [
        {
          id: 'branch',
          text: 'Branch',
          // 已有部分挖空：批量挖空后应合并为整行单区间
          blankedRanges: [{ start: 0, end: 2 }],
          children: [
            { id: 'leaf_a', text: 'Alpha', children: [] },
            { id: 'leaf_empty', text: '', children: [] },
            {
              id: 'leaf_b',
              text: 'Beta',
              children: [{ id: 'leaf_b1', text: 'Deep', children: [] }],
            },
          ],
        },
        { id: 'outside', text: 'Outside', children: [] },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function seedStore(): void {
  useMindMapStore.setState({
    mindmapId: null,
    metadata: null,
    document: JSON.parse(JSON.stringify(createDocument())) as MindMapDocument,
    focusedNodeId: null,
    editingNodeId: null,
    selection: [],
    history: { past: [], future: [] },
    clipboard: null,
    isDirty: false,
    isSaving: false,
    lastSavedAt: null,
    _documentVersion: 0,
    reciteMode: false,
    revealedBlanks: {},
    hideCompleted: false,
    searchFilterMode: false,
    viewports: {},
  });
}

afterEach(() => {
  useMindMapStore.getState().reset();
});

describe('blankBranchNodes', () => {
  it('blanks every non-empty node in the subtree with full-text ranges', () => {
    seedStore();
    const affected = useMindMapStore.getState().blankBranchNodes('branch');
    // branch + leaf_a + leaf_b + leaf_b1（leaf_empty 文本为空，跳过）
    expect(affected).toBe(4);

    const root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'branch')?.blankedRanges).toEqual([{ start: 0, end: 'Branch'.length }]);
    expect(findNodeById(root, 'leaf_a')?.blankedRanges).toEqual([{ start: 0, end: 'Alpha'.length }]);
    expect(findNodeById(root, 'leaf_b1')?.blankedRanges).toEqual([{ start: 0, end: 'Deep'.length }]);
    expect(findNodeById(root, 'leaf_empty')?.blankedRanges).toBeUndefined();
    // 分支外节点不受影响
    expect(findNodeById(root, 'outside')?.blankedRanges).toBeUndefined();
  });

  it('resets revealed state for re-blanked nodes and marks the document dirty', () => {
    seedStore();
    useMindMapStore.setState({ revealedBlanks: { branch: { 0: true }, outside: { 0: true } } });

    useMindMapStore.getState().blankBranchNodes('branch');

    const state = useMindMapStore.getState();
    expect(state.revealedBlanks.branch).toBeUndefined();
    // 分支外节点的揭示状态保留
    expect(state.revealedBlanks.outside).toEqual({ 0: true });
    expect(state.isDirty).toBe(true);
  });

  it('undoes the whole batch in a single step', () => {
    seedStore();
    useMindMapStore.getState().blankBranchNodes('branch');
    useMindMapStore.getState().undo();

    const root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'branch')?.blankedRanges).toEqual([{ start: 0, end: 2 }]);
    expect(findNodeById(root, 'leaf_a')?.blankedRanges).toBeUndefined();
    expect(findNodeById(root, 'leaf_b1')?.blankedRanges).toBeUndefined();
  });

  it('returns 0 and keeps the tree untouched for unknown node ids', () => {
    seedStore();
    expect(useMindMapStore.getState().blankBranchNodes('missing')).toBe(0);
    expect(useMindMapStore.getState().isDirty).toBe(false);
  });
});

describe('clearBranchBlanks', () => {
  it('clears blanks and revealed state across the subtree', () => {
    seedStore();
    useMindMapStore.getState().blankBranchNodes('branch');
    useMindMapStore.getState().revealBlank('leaf_a', 0);

    const cleared = useMindMapStore.getState().clearBranchBlanks('branch');
    expect(cleared).toBe(4);

    const state = useMindMapStore.getState();
    expect(findNodeById(state.document.root, 'branch')?.blankedRanges).toBeUndefined();
    expect(findNodeById(state.document.root, 'leaf_a')?.blankedRanges).toBeUndefined();
    expect(state.revealedBlanks.leaf_a).toBeUndefined();
  });

  it('counts only nodes that actually had blanks', () => {
    seedStore();
    // 仅 branch 自带 1 处挖空
    expect(useMindMapStore.getState().clearBranchBlanks('branch')).toBe(1);
  });
});
