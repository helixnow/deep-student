import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mindmapApiMocks = vi.hoisted(() => ({
  getMindMapVersions: vi.fn(),
  restoreMindMapVersion: vi.fn(),
}));

vi.mock('@/features/mindmap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/mindmap')>();
  return {
    ...actual,
    getMindMapVersions: mindmapApiMocks.getMindMapVersions,
    restoreMindMapVersion: mindmapApiMocks.restoreMindMapVersion,
  };
});

import {
  registerMindMapStore,
  useMindMapStore,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/features/mindmap/types';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import { runLedger } from '../ledger';
import { createPacer } from '../pacing';
import {
  acceptMindmapSuggestion,
  acceptMindmapSuggestionBranch,
  GHOST_CLEAN_STRUCTURAL_NODE_THRESHOLD,
  mindmapDriver,
  proposeMindmapOps,
  rejectMindmapSuggestionBranch,
  revertLastAcceptedMindmapSuggestion,
  setMindmapGhostReviewPreference,
} from '../drivers/mindmapDriver';
import {
  __clearAllMindmapSuggestions,
  getAcceptedMindmapCheckpoint,
  getMindmapSuggestion,
} from '../drivers/mindmapSuggestionStore';
import type { AcrRunContext, AgentOp } from '../types';

const MM_ID = 'mm_ghost_w09';
let unregisterStore = () => undefined;

function createBaseDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: '线性代数复习',
      children: [
        { id: 'n_matrix', text: '矩阵运算', children: [] },
        { id: 'n_det', text: '行列式', children: [] },
        { id: 'n_old', text: '待清理旧节', children: [] },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function seedCleanStore(): ReturnType<typeof vi.fn> {
  const save = vi.fn(async () => {
    useMindMapStore.setState({ isDirty: false, isSaving: false });
    return true;
  });
  useMindMapStore.setState({
    mindmapId: MM_ID,
    metadata: null,
    document: JSON.parse(JSON.stringify(createBaseDoc())) as MindMapDocument,
    focusedNodeId: null,
    editingNodeId: null,
    selection: [],
    history: { past: [], future: [] },
    clipboard: null,
    isDirty: false,
    isSaving: false,
    lastSavedAt: null,
    _documentVersion: 0,
    hideCompleted: false,
    searchFilterMode: false,
    viewports: {},
    agentEnteringIds: new Set(),
    agentExitingIds: new Set(),
    agentUpdatedIds: new Set(),
    agentFitViewNonce: 0,
    save,
  });
  return save;
}

function makeRun(label: string): AcrRunContext {
  return {
    runId: `run_${label}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId: 'sess_ghost',
    target: { typeId: 'mindmap', resourceId: MM_ID },
    windowId: 'win_mm',
    pacing: createPacer('fast'),
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger: runLedger,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mindmapApiMocks.getMindMapVersions.mockReset();
  mindmapApiMocks.restoreMindMapVersion.mockReset();
  setMindmapGhostReviewPreference('auto');
  __clearAllMindmapSuggestions();
  unregisterStore = registerMindMapStore(MM_ID, useMindMapStore, `win_mm:mindmap:${MM_ID}`);
  seedCleanStore();
});

afterEach(() => {
  setMindmapGhostReviewPreference('auto');
  __clearAllMindmapSuggestions();
  unregisterStore();
  useMindMapStore.getState().reset();
  vi.useRealTimers();
});

describe('W09 Ghost Proposal Staging, Per-Branch Resolution & 1-Click Checkpoint Revert', () => {
  it('stages clean-window multi-branch structural restructures (>= 6 nodes) as Ghost Branches', async () => {
    expect(GHOST_CLEAN_STRUCTURAL_NODE_THRESHOLD).toBe(6);

    const structuralOps: AgentOp[] = [
      {
        kind: 'delete_node',
        anchor: { node_id: 'n_old' },
        payload: {},
        destructive: true,
        label: '删除旧节',
      },
      {
        kind: 'add_node',
        anchor: { parent_id: 'n_matrix' },
        payload: {
          data: {
            text: '特征值与特征向量',
            children: [
              { id: 'eig_1', text: '特征多项式', children: [] },
              { id: 'eig_2', text: '相似对角化', children: [] },
            ],
          },
        },
        destructive: false,
        label: '新增特征值分支',
      },
      {
        kind: 'add_node',
        anchor: { parent_id: 'root' },
        payload: {
          data: {
            text: '二次型',
            children: [{ id: 'quad_1', text: '正定二次型判别', children: [] }],
          },
        },
        destructive: false,
        label: '新增二次型分支',
      },
    ];

    const receipt = await mindmapDriver.apply(makeRun('clean-restructure'), structuralOps);
    expect(receipt.mode).toBe('suggestion');
    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.applied).toBe(0);

    const suggestion = getMindmapSuggestion(MM_ID);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.reason).toBe('clean_structural');
    expect(suggestion!.branches).toHaveLength(3);
    // Clean document was NOT mutated before learner review
    expect(findNodeById(useMindMapStore.getState().document.root, 'n_old')).not.toBeNull();
  });

  it('stages explicit proposals via proposeMindmapOps and supports partial branch accept & reject', async () => {
    const save = seedCleanStore();
    const suggestion = proposeMindmapOps({
      mindmapId: MM_ID,
      windowId: 'win_mm',
      runId: 'run_explicit',
      ops: [
        {
          kind: 'add_node',
          anchor: { parent_id: 'n_matrix' },
          payload: {
            data: {
              id: 'prop_rank',
              text: '矩阵的秩',
              children: [{ id: 'prop_rank_1', text: '初等行变换求秩', children: [] }],
            },
          },
          destructive: false,
          label: '添加矩阵的秩',
        },
        {
          kind: 'update_node',
          anchor: { node_id: 'n_det' },
          payload: { patch: { text: '行列式性质与展开' } },
          destructive: false,
          label: '更新行列式标题',
        },
        {
          kind: 'delete_node',
          anchor: { node_id: 'n_old' },
          payload: {},
          destructive: true,
          label: '删除待清理旧节',
        },
      ],
    });

    expect(suggestion.reason).toBe('explicit_proposal');
    expect(suggestion.branches).toHaveLength(3);

    const [addBranch, modifyBranch, removeBranch] = suggestion.branches;

    // 1) Accept ONLY the first Ghost Branch (add_branch)
    const branchResult = await acceptMindmapSuggestionBranch(
      suggestion.id,
      MM_ID,
      addBranch.branchId,
    );
    expect(branchResult).toEqual({
      applied: 1,
      failed: [],
      saved: true,
      documentVersion: 1,
    });
    expect(save).toHaveBeenCalledTimes(1);

    // Added branch (including nested child) is materialized & marked agentEntering
    const rootAfterFirst = useMindMapStore.getState().document.root;
    expect(findNodeById(rootAfterFirst, 'prop_rank')?.text).toBe('矩阵的秩');
    expect(findNodeById(rootAfterFirst, 'prop_rank_1')?.text).toBe('初等行变换求秩');
    expect(useMindMapStore.getState().agentEnteringIds.has('prop_rank')).toBe(true);
    expect(useMindMapStore.getState().agentEnteringIds.has('prop_rank_1')).toBe(true);

    // Other 2 Ghost Branches remain pending and untouched!
    expect(findNodeById(rootAfterFirst, 'n_det')?.text).toBe('行列式');
    expect(findNodeById(rootAfterFirst, 'n_old')).not.toBeNull();
    const remainingAfterAccept = getMindmapSuggestion(MM_ID);
    expect(remainingAfterAccept).not.toBeNull();
    expect(remainingAfterAccept!.branches).toHaveLength(2);

    // 2) Reject ONLY the remove_subtree branch (find by kind in recomputed branches)
    const nextRemoveBranch = remainingAfterAccept!.branches.find(
      (b) => b.kind === 'remove_subtree',
    )!;
    expect(rejectMindmapSuggestionBranch(suggestion.id, MM_ID, nextRemoveBranch.branchId)).toBe(
      true,
    );
    expect(findNodeById(useMindMapStore.getState().document.root, 'n_old')).not.toBeNull();

    // Only modify_node branch remains
    const remainingFinal = getMindmapSuggestion(MM_ID);
    expect(remainingFinal).not.toBeNull();
    expect(remainingFinal!.branches).toHaveLength(1);
    expect(remainingFinal!.branches[0].kind).toBe(modifyBranch.kind);

    // Rejecting last remaining branch clears the suggestion completely
    expect(
      rejectMindmapSuggestionBranch(
        suggestion.id,
        MM_ID,
        remainingFinal!.branches[0].branchId,
      ),
    ).toBe(true);
    expect(getMindmapSuggestion(MM_ID)).toBeNull();
    // Checkpoint from the 1 accepted branch is retained for [全部撤回]
    expect(getAcceptedMindmapCheckpoint(MM_ID)?.appliedCount).toBe(1);
    expect(removeBranch.kind).toBe('remove_subtree');
  });

  it('captures mindmap_versions checkpoint on acceptAll and restores via revertLastAcceptedMindmapSuggestion', async () => {
    mindmapApiMocks.getMindMapVersions.mockResolvedValue([
      {
        versionId: 'mv_pre_accept_001',
        mindmapId: MM_ID,
        resourceId: MM_ID,
        title: '线性代数复习',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mindmapApiMocks.restoreMindMapVersion.mockResolvedValue({
      mindmapId: MM_ID,
      title: '线性代数复习',
      updatedAt: '2026-01-01T00:05:00.000Z',
    });

    const beforeSnapshot = JSON.stringify(useMindMapStore.getState().document.root);

    const suggestion = proposeMindmapOps({
      mindmapId: MM_ID,
      windowId: 'win_mm',
      ops: [
        {
          kind: 'update_node',
          anchor: { node_id: 'n_matrix' },
          payload: { patch: { text: '矩阵与线性变换' } },
          destructive: false,
          label: '重命名矩阵节点',
        },
        {
          kind: 'delete_node',
          anchor: { node_id: 'n_old' },
          payload: {},
          destructive: true,
          label: '移除旧节点',
        },
      ],
    });

    const acceptRes = await acceptMindmapSuggestion(suggestion.id, MM_ID);
    expect(acceptRes?.applied).toBe(2);
    expect(getMindmapSuggestion(MM_ID)).toBeNull();

    // Document reflects AI changes
    expect(findNodeById(useMindMapStore.getState().document.root, 'n_matrix')?.text).toBe(
      '矩阵与线性变换',
    );
    expect(findNodeById(useMindMapStore.getState().document.root, 'n_old')).toBeNull();

    // Checkpoint recorded with server versionId
    const cp = getAcceptedMindmapCheckpoint(MM_ID);
    expect(cp).not.toBeNull();
    expect(cp!.preAcceptVersionId).toBe('mv_pre_accept_001');
    expect(cp!.appliedCount).toBe(2);

    // 1-Click [全部撤回] calls restoreMindMapVersion(versionId) AND restores live store document
    const reverted = await revertLastAcceptedMindmapSuggestion(MM_ID);
    expect(reverted).toBe(true);
    expect(mindmapApiMocks.restoreMindMapVersion).toHaveBeenCalledWith('mv_pre_accept_001');
    expect(JSON.stringify(useMindMapStore.getState().document.root)).toBe(beforeSnapshot);
    expect(getAcceptedMindmapCheckpoint(MM_ID)).toBeNull();
  });
});
