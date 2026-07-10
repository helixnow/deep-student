/**
 * ACR todo / files onActivation 分发 — R1-14
 *
 * 单测：mock store 验证 showList / focusItem / openFolder / reveal。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 工厂提升：fn 必须经 vi.hoisted 创建
const { setActiveList, selectItem, enterFolder, setSelectedIds, agentFlash } = vi.hoisted(() => ({
  setActiveList: vi.fn(),
  selectItem: vi.fn(),
  enterFolder: vi.fn(async () => undefined),
  setSelectedIds: vi.fn(),
  agentFlash: vi.fn(),
}));

vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: {
    getState: () => ({
      setActiveList,
      selectItem,
    }),
  },
}));

vi.mock('@/features/learning-hub/stores/finderStore', () => ({
  useFinderStore: {
    getState: () => ({
      enterFolder,
      setSelectedIds,
    }),
  },
}));

vi.mock('../visuals/agentFlash', () => ({
  agentFlash,
}));

import { handleTodoActivation } from '../../apps/system/todoActivation';
import { handleFilesActivation } from '../../apps/files/filesActivation';

describe('todo / files onActivation', () => {
  beforeEach(() => {
    setActiveList.mockClear();
    selectItem.mockClear();
    enterFolder.mockClear();
    setSelectedIds.mockClear();
    agentFlash.mockClear();
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
});
