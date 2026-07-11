/**
 * ACR todo / files onActivation 分发 — R1-14
 *
 * 单测：mock store 验证 showList / focusItem / openFolder / reveal。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 工厂提升：fn 必须经 vi.hoisted 创建
const { setActiveList, selectItem, enterFolder, navigateTo, setSelectedIds, agentFlash, todoState, finderState } = vi.hoisted(() => {
  const todoState = { activeListId: null as string | null, error: null as string | null };
  const finderState = {
    currentPath: { folderId: 'root-old' },
    inlineEdit: { editingId: null as string | null },
  };
  return {
  todoState,
  finderState,
  setActiveList: vi.fn((id: string | null) => { todoState.activeListId = id; }),
  selectItem: vi.fn(),
  enterFolder: vi.fn(async (id: string) => { finderState.currentPath = { folderId: id }; }),
  navigateTo: vi.fn((path: { folderId: string }) => { finderState.currentPath = path; }),
  setSelectedIds: vi.fn(),
  agentFlash: vi.fn(),
  };
});

vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: {
    getState: () => ({
      setActiveList,
      selectItem,
      reloadCurrentView: vi.fn(async () => undefined),
      ...todoState,
    }),
  },
}));

vi.mock('@/features/learning-hub/stores/finderStore', () => ({
  useFinderStore: {
    getState: () => ({
      enterFolder,
      navigateTo,
      setSelectedIds,
      ...finderState,
    }),
  },
}));

vi.mock('../visuals/agentFlash', () => ({
  agentFlash,
}));

import { handleTodoActivation } from '../../apps/system/todoActivation';
import { handleFilesActivation } from '../../apps/files/filesActivation';
import { todoDriver } from '../drivers/todoDriver';
import { finderDriver } from '../drivers/finderDriver';
import type { AcrRunContext, Pacer, RunLedger } from '../types';

function makeRun(typeId: string): AcrRunContext {
  const pacing: Pacer = {
    profile: { name: 'fast', opIntervalMs: 0, typeBatchMin: 1, typeBatchMax: 1, typeIntervalMs: 0, instant: true },
    tick: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const ledger: RunLedger = {
    record: vi.fn(),
    revertRun: vi.fn(async () => true),
    hasRun: vi.fn(() => false),
    sealRun: vi.fn(),
  };
  return {
    runId: `run-${typeId}`,
    sessionId: 'session',
    target: { typeId },
    windowId: 'window',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume'),
    ledger,
  };
}

describe('todo / files onActivation', () => {
  beforeEach(() => {
    setActiveList.mockClear();
    selectItem.mockClear();
    enterFolder.mockClear();
    navigateTo.mockClear();
    setSelectedIds.mockClear();
    agentFlash.mockClear();
    todoState.activeListId = null;
    todoState.error = null;
    finderState.currentPath = { folderId: 'root-old' };
    finderState.inlineEdit.editingId = null;
  });

  it('todo showList → setActiveList(listId)', async () => {
    handleTodoActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'showList',
      payload: { listId: 'list-a' },
    });
    await vi.waitFor(() => {
      expect(setActiveList).toHaveBeenCalledWith('list-a');
    });
    expect(selectItem).not.toHaveBeenCalled();
  });

  it('todo focusItem → selectItem + agentFlash', async () => {
    handleTodoActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'focusItem',
      payload: { itemId: 'item-9' },
    });
    await vi.waitFor(() => {
      expect(selectItem).toHaveBeenCalledWith('item-9');
      expect(agentFlash).toHaveBeenCalledWith('todo', 'item-9');
    });
  });

  it('files openFolder → enterFolder(folderId)', async () => {
    handleFilesActivation({
      windowId: 'w2',
      instanceKey: null,
      action: 'openFolder',
      payload: { folderId: 'folder-1' },
    });
    await vi.waitFor(() => {
      expect(enterFolder).toHaveBeenCalledWith('folder-1');
    });
  });

  it('files reveal → setSelectedIds + agentFlash（v1 不进父目录）', async () => {
    handleFilesActivation({
      windowId: 'w2',
      instanceKey: null,
      action: 'reveal',
      payload: { resourceId: 'res-42' },
    });
    await vi.waitFor(() => {
      expect(setSelectedIds).toHaveBeenCalled();
      expect(agentFlash).toHaveBeenCalledWith('files', 'res-42');
    });
    const ids = setSelectedIds.mock.calls[0][0] as Set<string>;
    expect(ids).toBeInstanceOf(Set);
    expect([...ids]).toEqual(['res-42']);
  });

  it('finder 内联编辑时 probe 为 hot', () => {
    finderState.inlineEdit.editingId = 'resource-1';
    expect(finderDriver.probe({ typeId: 'files' })).toBe('hot');
  });

  it('todo 详情编辑聚焦时 probe 为 hot', () => {
    const panel = document.createElement('div');
    panel.dataset.todoDetailPanel = '';
    const input = document.createElement('input');
    panel.appendChild(input);
    document.body.appendChild(panel);
    input.focus();
    expect(todoDriver.probe({ typeId: 'todo' })).toBe('hot');
    panel.remove();
  });

  it('todo 导航完成后记录可逆操作', async () => {
    todoState.activeListId = 'list-old';
    const run = makeRun('todo');
    const receipt = await todoDriver.apply(run, [
      { kind: 'todo_show_list', destructive: false, label: '打开清单', payload: { listId: 'list-new' } },
    ]);
    expect(receipt.status).toBe('completed');
    expect(todoState.activeListId).toBe('list-new');
    expect(run.ledger.record).toHaveBeenCalledTimes(1);
    await vi.mocked(run.ledger.record).mock.calls[0]![1]();
    expect(todoState.activeListId).toBe('list-old');
  });

  it('finder 导航完成后记录可逆操作', async () => {
    const run = makeRun('files');
    const receipt = await finderDriver.apply(run, [
      { kind: 'openFolder', destructive: false, label: '打开目录', payload: { folderId: 'folder-new' } },
    ]);
    expect(receipt.status).toBe('completed');
    expect(finderState.currentPath.folderId).toBe('folder-new');
    expect(run.ledger.record).toHaveBeenCalledTimes(1);
    await vi.mocked(run.ledger.record).mock.calls[0]![1]();
    expect(finderState.currentPath.folderId).toBe('root-old');
  });

  it.each([
    ['todo', todoDriver, { kind: 'todo_show_list', payload: { listId: 'list-new' } }],
    ['files', finderDriver, { kind: 'openFolder', payload: { folderId: 'folder-new' } }],
  ] as const)('%s pacing 失败不把已完成导航重复计入 undone', async (typeId, driver, first) => {
    const run = makeRun(typeId);
    run.pacing.tick = vi.fn(async () => {
      throw new Error('pacer failed');
    });
    const receipt = await driver.apply(run, [
      { ...first, destructive: false, label: '已完成导航' },
      { ...first, destructive: false, label: '后续导航' },
    ]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.done).toEqual(['已完成导航']);
    expect(receipt.undone).toEqual(['后续导航']);
    expect(receipt.message).toContain('pacer failed');
  });
});
