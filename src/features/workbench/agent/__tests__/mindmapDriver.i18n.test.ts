/**
 * mindmapDriver 用户/agent 可见文案 i18n 契约 — mindmap:agent.*
 *
 * key-echo mock：断言与语言无关（真实运行时由 mindmap.json 提供 zh-CN / en-US 文案，
 * driver 侧 defaultValue 兜底 namespace 异步加载窗口期；zh-CN 文案 = 主干原文）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: { t: tSpy } }));

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
  SUGGESTION_MESSAGE,
  validateMindmapSubtreeInput,
} from '../drivers/mindmapDriver';
import type { AcrRunContext, AgentOp, RunLedger } from '../types';

const MM_ID = 'mm_i18n_test';
const MM_OTHER = 'mm_i18n_other';
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

function seedStore(
  overrides?: { isDirty?: boolean; mindmapId?: string },
): ReturnType<typeof vi.fn> {
  const save = vi.fn(async () => {
    useMindMapStore.setState({ isDirty: false, isSaving: false });
    return true;
  });
  useMindMapStore.setState({
    mindmapId: overrides?.mindmapId ?? MM_ID,
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
    viewports: {},
    agentEnteringIds: new Set(),
    agentFitViewNonce: 0,
    save,
  });
  return save;
}

function makeRun(label: string, ledger: RunLedger = runLedger): AcrRunContext {
  return {
    runId: `run_${label}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId: 'sess_i18n',
    target: { typeId: 'mindmap', resourceId: MM_ID },
    windowId: 'win_mm',
    pacing: createPacer('fast'),
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger,
  };
}

function opAdd(parentId: string, text: string, children?: unknown): AgentOp {
  return {
    kind: 'add_node',
    anchor: { parent_id: parentId },
    payload: { data: { text, ...(children === undefined ? {} : { children }) } },
    destructive: false,
    label: `添加节点「${text}」`,
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

beforeEach(() => {
  vi.useFakeTimers();
  tSpy.mockClear();
  unregisterDriverStore = registerMindMapStore(
    MM_ID,
    useMindMapStore,
    `win_mm:mindmap:${MM_ID}`,
  );
  seedStore();
});

afterEach(() => {
  unregisterDriverStore();
  useMindMapStore.getState().reset();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('mindmapDriver apply — 回执文案走 mindmap:agent.* key', () => {
  it('dirty + destructive → suggestion_pending（defaultValue = SUGGESTION_MESSAGE 常量）', async () => {
    seedStore({ isDirty: true });
    const receipt = await mindmapDriver.apply(makeRun('sug'), [opDelete('node_b')]);

    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.mode).toBe('suggestion');
    expect(receipt.message).toBe('mindmap:agent.suggestion_pending');
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.suggestion_pending',
      expect.objectContaining({ defaultValue: SUGGESTION_MESSAGE }),
    );
  });

  it('锚点缺失 → node_not_found 进 op_undone_with_reason，全败 message = all_ops_failed', async () => {
    const receipt = await mindmapDriver.apply(makeRun('missing'), [
      opDelete('missing_node'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.applied).toBe(0);
    expect(receipt.undone).toEqual(['mindmap:agent.op_undone_with_reason']);
    expect(receipt.message).toBe('mindmap:agent.all_ops_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.node_not_found',
      expect.objectContaining({
        id: 'missing_node',
        defaultValue: expect.any(String),
      }),
    );
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.op_undone_with_reason',
      expect.objectContaining({
        label: '删除节点 missing_node',
        reason: 'mindmap:agent.node_not_found',
      }),
    );
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.op_skipped_progress',
      expect.objectContaining({ reason: 'mindmap:agent.node_not_found' }),
    );
  });

  it('add_node 缺少 parent_id → missing_parent_id', async () => {
    const receipt = await mindmapDriver.apply(makeRun('no-parent'), [
      {
        kind: 'add_node',
        anchor: {},
        payload: { data: { text: 'X' } },
        destructive: false,
        label: '无锚点添加',
      },
    ]);

    expect(receipt.status).toBe('failed');
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.missing_parent_id',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
  });

  it('嵌套 children 重复 id → validation_duplicate_id（携带 {{id}} 插值）', async () => {
    const receipt = await mindmapDriver.apply(makeRun('dup'), [
      opAdd('root_test', 'P', [
        { id: 'dup', text: 'one', children: [] },
        { id: 'dup', text: 'two', children: [] },
      ]),
    ]);

    expect(receipt.status).toBe('failed');
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.validation_duplicate_id',
      expect.objectContaining({ id: 'dup', defaultValue: expect.any(String) }),
    );
  });

  it('validateMindmapSubtreeInput 非数组入参 → validation_children_not_array', () => {
    const root = useMindMapStore.getState().document.root;
    const result = validateMindmapSubtreeInput(root, 'root_test', 'not-an-array');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_CHILDREN');
    expect(result.reason).toBe('mindmap:agent.validation_children_not_array');
  });

  it('全部成功 → message = applied', async () => {
    const receipt = await mindmapDriver.apply(makeRun('ok'), [
      opAdd('root_test', 'Fresh'),
    ]);

    expect(receipt.status).toBe('completed');
    expect(receipt.applied).toBe(1);
    expect(receipt.message).toBe('mindmap:agent.applied');
  });

  it('保存失败 → partial + save_failed', async () => {
    const save = seedStore();
    save.mockResolvedValueOnce(false);
    const receipt = await mindmapDriver.apply(makeRun('savefail'), [
      opAdd('root_test', 'Unsaved'),
    ]);

    expect(receipt.status).toBe('partial');
    expect(receipt.message).toBe('mindmap:agent.save_failed');
  });

  it('store 未加载目标资源 → store_not_loaded', async () => {
    seedStore({ mindmapId: MM_OTHER });
    const receipt = await mindmapDriver.apply(makeRun('closed'), [
      opAdd('root_test', 'Nope'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.message).toBe('mindmap:agent.store_not_loaded');
  });

  it('checkPaused=abort → cancelled + aborted_by_user', async () => {
    const run = makeRun('pause-abort');
    run.checkPaused = vi.fn(async () => 'abort' as const);
    const receipt = await mindmapDriver.apply(run, [opAdd('root_test', 'Stop')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.applied).toBe(0);
    expect(receipt.message).toBe('mindmap:agent.aborted_by_user');
  });

  it('执行期间目标切换 → target_switched + 未执行项走 op_undone_target_switched', async () => {
    const run = makeRun('switch');
    let pauses = 0;
    run.checkPaused = vi.fn(async () => {
      pauses += 1;
      if (pauses === 2) {
        useMindMapStore.setState({ mindmapId: MM_OTHER });
      }
      return 'resume' as const;
    });

    const receipt = await mindmapDriver.apply(run, [
      opAdd('root_test', 'First'),
      opAdd('root_test', 'Second'),
    ]);

    expect(receipt.status).toBe('partial');
    expect(receipt.applied).toBe(1);
    expect(receipt.message).toBe('mindmap:agent.target_switched');
    expect(receipt.undone).toEqual(['mindmap:agent.op_undone_target_switched']);
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.op_undone_target_switched',
      expect.objectContaining({ label: '添加节点「Second」' }),
    );
  });
});

describe('mindmapDriver ledger inverse — 撤销文案走 mindmap:agent.* key', () => {
  it('撤销添加冲突（节点被继续编辑）→ undo_add_conflict', async () => {
    const ledger: RunLedger = {
      record: vi.fn(),
      revertRun: vi.fn(async () => true),
      hasRun: vi.fn(() => false),
      sealRun: vi.fn(),
    };
    const run = makeRun('undo-conflict', ledger);
    const receipt = await mindmapDriver.apply(run, [opAdd('root_test', 'Mine')]);
    expect(receipt.status).toBe('completed');
    expect(ledger.record).toHaveBeenCalledTimes(1);

    const newId = receipt.entityIds[0];
    expect(findNodeById(useMindMapStore.getState().document.root, newId)).not.toBeNull();
    useMindMapStore.getState().updateNode(newId, { text: 'User edited' });

    const inverse = vi.mocked(ledger.record).mock.calls[0]![1] as () => Promise<void>;
    await expect(inverse()).rejects.toThrow('mindmap:agent.undo_add_conflict');
    expect(tSpy).toHaveBeenCalledWith(
      'mindmap:agent.undo_add_conflict',
      expect.objectContaining({ id: newId, defaultValue: expect.any(String) }),
    );
  });

  it('撤销添加时保存失败 → undo_add_save_failed', async () => {
    const ledger: RunLedger = {
      record: vi.fn(),
      revertRun: vi.fn(async () => true),
      hasRun: vi.fn(() => false),
      sealRun: vi.fn(),
    };
    const save = seedStore();
    const run = makeRun('undo-save-fail', ledger);
    const receipt = await mindmapDriver.apply(run, [opAdd('root_test', 'Rollback')]);
    expect(receipt.status).toBe('completed');

    save.mockResolvedValueOnce(false);
    const inverse = vi.mocked(ledger.record).mock.calls[0]![1] as () => Promise<void>;
    await expect(inverse()).rejects.toThrow('mindmap:agent.undo_add_save_failed');
  });
});

describe('mindmapDriver abort — 回执文案走 mindmap:agent.* key', () => {
  it('run 不存在 → no_active_run', () => {
    const receipt = mindmapDriver.abort('run_ghost');
    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('mindmap:agent.no_active_run');
  });
});
