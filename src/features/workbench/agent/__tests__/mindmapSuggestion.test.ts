/**
 * P2 人机双写 MVP — 导图 suggestion 屏障：暂存 → 确认条裁决 → 接受应用/拒绝丢弃
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerMindMapStore,
  useMindMapStore,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/features/mindmap/types';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import { runLedger } from '../ledger';
import { createPacer } from '../pacing';
import {
  mindmapDriver,
  acceptMindmapSuggestion,
  dismissMindmapSuggestion,
} from '../drivers/mindmapDriver';
import {
  getMindmapSuggestion,
  stashMindmapSuggestion,
  clearMindmapSuggestion,
  summarizeSuggestionOps,
  __clearAllMindmapSuggestions,
} from '../drivers/mindmapSuggestionStore';
import type { AcrRunContext, AgentOp, PacingProfileName } from '../types';

const MM_ID = 'mm_suggestion_test';
let unregisterDriverStore = () => undefined;

function createDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_test',
      text: 'Root',
      children: [
        { id: 'node_a', text: 'Alpha', children: [] },
        { id: 'node_b', text: 'Beta', children: [] },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function seedStore(overrides?: { isDirty?: boolean }): void {
  useMindMapStore.setState({
    mindmapId: MM_ID,
    metadata: null,
    document: JSON.parse(JSON.stringify(createDocument())) as MindMapDocument,
    focusedNodeId: null,
    editingNodeId: null,
    selection: [],
    history: { past: [], future: [] },
    clipboard: null,
    isDirty: overrides?.isDirty ?? false,
    isSaving: false,
    lastSavedAt: null,
    _documentVersion: 0,
    hideCompleted: false,
    searchFilterMode: false,
    viewports: {},
    agentEnteringIds: new Set(),
    agentFitViewNonce: 0,
    save: vi.fn(async () => {
      useMindMapStore.setState({ isDirty: false, isSaving: false });
      return true;
    }),
  });
}

function makeRun(opsLabel = 'run', pacingName: PacingProfileName = 'fast'): AcrRunContext {
  return {
    runId: `run_${opsLabel}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId: 'sess_test',
    target: { typeId: 'mindmap', resourceId: MM_ID },
    windowId: 'win_mm',
    pacing: createPacer(pacingName),
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger: runLedger,
  };
}

function opDelete(nodeId: string): AgentOp {
  return {
    kind: 'delete_node',
    anchor: { node_id: nodeId },
    payload: {},
    destructive: true,
    label: `删除节点 ${nodeId}`,
  };
}

function opUpdate(nodeId: string, text: string): AgentOp {
  return {
    kind: 'update_node',
    anchor: { node_id: nodeId },
    payload: { patch: { text } },
    destructive: false,
    label: `更新节点 ${nodeId}`,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  unregisterDriverStore = registerMindMapStore(
    MM_ID,
    useMindMapStore,
    `win_mm:mindmap:${MM_ID}`,
  );
});

afterEach(() => {
  __clearAllMindmapSuggestions();
  unregisterDriverStore();
  useMindMapStore.getState().reset();
  vi.useRealTimers();
});

describe('P2 导图 suggestion 屏障：暂存 + 裁决', () => {
  it('屏障命中时暂存剩余 ops（含命中 op），文档不变', async () => {
    seedStore({ isDirty: true });
    const receipt = await mindmapDriver.apply(makeRun('stash'), [
      opUpdate('node_a', 'A2'),   // 非破坏但需屏障（update_node）
      opDelete('node_b'),
    ]);

    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.applied).toBe(0);

    const suggestion = getMindmapSuggestion(MM_ID);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.ops).toHaveLength(2);
    expect(suggestion!.ops[0].kind).toBe('update_node');
    // 文档未被改动
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_b')).toBeTruthy();
  });

  it('接受暂存：ops 全部应用并保存，暂存清除', async () => {
    seedStore({ isDirty: true });
    await mindmapDriver.apply(makeRun('accept'), [
      opUpdate('node_a', 'Alpha2'),
      opDelete('node_b'),
    ]);
    const suggestion = getMindmapSuggestion(MM_ID)!;

    const result = await acceptMindmapSuggestion(suggestion.id, MM_ID);
    expect(result).not.toBeNull();
    expect(result!.applied).toBe(2);
    expect(result!.failed).toHaveLength(0);
    expect(result!.saved).toBe(true);

    const root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'node_a')?.text).toBe('Alpha2');
    expect(findNodeById(root, 'node_b')).toBeNull();
    expect(getMindmapSuggestion(MM_ID)).toBeNull();
    expect(useMindMapStore.getState().save).toHaveBeenCalled();
  });

  it('拒绝暂存：ops 丢弃，文档不变', async () => {
    seedStore({ isDirty: true });
    await mindmapDriver.apply(makeRun('reject'), [opDelete('node_b')]);
    expect(getMindmapSuggestion(MM_ID)).not.toBeNull();

    dismissMindmapSuggestion(MM_ID);
    expect(getMindmapSuggestion(MM_ID)).toBeNull();
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_b')).toBeTruthy();
  });

  it('suggestionId 不匹配时拒绝执行（防旧暂存误应用）', async () => {
    seedStore({ isDirty: true });
    await mindmapDriver.apply(makeRun('stale'), [opDelete('node_b')]);

    const result = await acceptMindmapSuggestion('mms_nonexistent', MM_ID);
    expect(result).toBeNull();
    // 暂存仍在（未被误清）
    expect(getMindmapSuggestion(MM_ID)).not.toBeNull();
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_b')).toBeTruthy();
  });

  it('新暂存替换旧暂存（每导图至多一条）', () => {
    seedStore();
    stashMindmapSuggestion({ runId: 'r1', mindmapId: MM_ID, windowId: null, ops: [opDelete('node_a')] });
    const second = stashMindmapSuggestion({ runId: 'r2', mindmapId: MM_ID, windowId: null, ops: [opDelete('node_b')] });
    expect(getMindmapSuggestion(MM_ID)!.id).toBe(second.id);
    expect(getMindmapSuggestion(MM_ID)!.ops[0].label).toContain('node_b');
  });

  it('summarizeSuggestionOps 按 kind 统计', () => {
    const summary = summarizeSuggestionOps([
      opUpdate('a', 'x'),
      opDelete('b'),
      opDelete('c'),
      { kind: 'add_node', anchor: { parent_id: 'root' }, payload: {}, destructive: false, label: '加' },
      { kind: 'move_node', anchor: {}, payload: {}, destructive: true, label: '移' },
    ]);
    expect(summary).toEqual({ added: 1, removed: 2, updated: 1, moved: 1 });
  });

  it('clearMindmapSuggestion 对空暂存幂等', () => {
    seedStore();
    expect(() => clearMindmapSuggestion(MM_ID)).not.toThrow();
  });
});
