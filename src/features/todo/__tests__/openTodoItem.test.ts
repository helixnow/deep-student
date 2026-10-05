import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workbenchEnabled: false,
  activateDetailed: vi.fn(async (..._args: unknown[]) => ({ delivered: true })),
  focusItem: vi.fn(async (_itemId: string) => 'focused'),
  closeTrash: vi.fn(),
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    isEnabled: () => mocks.workbenchEnabled,
    activateDetailed: mocks.activateDetailed,
  },
}));
vi.mock('../stores/useTodoStore', () => ({
  useTodoStore: { getState: () => ({ focusItem: mocks.focusItem }) },
}));
vi.mock('../components/TodoTrashDialog', () => ({
  useTodoTrashView: { getState: () => ({ close: mocks.closeTrash }) },
}));

import { openTodoItem } from '../openTodoItem';

describe('openTodoItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the learning-desktop todo window to focus the todo, opening it if needed', async () => {
    mocks.workbenchEnabled = true;
    await openTodoItem('ti_1');

    expect(mocks.activateDetailed).toHaveBeenCalledWith({
      typeId: 'todo',
      instanceKey: '',
      action: 'focusItem',
      payload: { itemId: 'ti_1' },
      fallbackLaunch: { typeId: 'todo', reason: 'api' },
    });
    expect(mocks.focusItem).not.toHaveBeenCalled();
  });

  it('switches the classic shell to the todo page and focuses the todo there', async () => {
    mocks.workbenchEnabled = false;
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    let navigations: unknown[] = [];
    try {
      await openTodoItem('ti_1');
      navigations = dispatch.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'NAVIGATE_TO_VIEW')
        .map((event) => (event as CustomEvent).detail);
    } finally {
      dispatch.mockRestore();
    }

    expect(navigations).toEqual([{ view: 'todo' }]);
    expect(mocks.closeTrash).toHaveBeenCalled();
    expect(mocks.focusItem).toHaveBeenCalledWith('ti_1');
    expect(mocks.activateDetailed).not.toHaveBeenCalled();
  });
});
