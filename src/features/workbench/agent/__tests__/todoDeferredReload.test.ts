/**
 * ACR 4.0 A3 — todo 域监听 blur 等待不再强行 reload
 *
 * 详情面板长时间占焦时：25×400ms 超时后跳过本次 reload（不冲掉草稿），
 * 记录延迟重试；下次 blur（focusout 离开详情面板）或下次域事件到达时补刷。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadLists, reloadCurrentView, selectItem, agentFlashMany } = vi.hoisted(() => ({
  loadLists: vi.fn(async () => undefined),
  reloadCurrentView: vi.fn(async () => undefined),
  selectItem: vi.fn(),
  agentFlashMany: vi.fn(),
}));

vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: {
    getState: () => ({
      loadLists,
      reloadCurrentView,
      selectItem,
      activeListId: null,
      selectedItemId: null,
      items: [],
      lists: [],
      overdueCount: 0,
      filter: { view: 'all' },
      isLoadingLists: false,
      isLoadingItems: false,
      error: null,
    }),
  },
}));

vi.mock('../visuals/agentFlash', () => ({
  agentFlash: vi.fn(),
  agentFlashMany,
}));

import {
  __resetTodoDriverForTests,
  handleTodoDomainChange,
} from '../drivers/todoDriver';

const BLUR_TIMEOUT_MS = 25 * 400;

function mountDetailPanel(): { input: HTMLInputElement; panel: HTMLDivElement } {
  const panel = document.createElement('div');
  panel.dataset.todoDetailPanel = '';
  const input = document.createElement('input');
  panel.appendChild(input);
  document.body.appendChild(panel);
  input.focus();
  return { input, panel };
}

describe('todo 域监听延迟重试（ACR 4.0 A3）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadLists.mockClear();
    reloadCurrentView.mockClear();
    selectItem.mockClear();
    agentFlashMany.mockClear();
  });

  afterEach(() => {
    __resetTodoDriverForTests();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('详情面板未占焦时立即 reload + flash + 选中', async () => {
    handleTodoDomainChange({ source: 'agent', action: 'update', entityIds: ['item-1'] });
    await vi.runAllTimersAsync();

    expect(loadLists).toHaveBeenCalledTimes(1);
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
    expect(agentFlashMany).toHaveBeenCalledWith('todo', ['item-1'], { scroll: 'first' });
    expect(selectItem).toHaveBeenCalledWith('item-1');
  });

  it('超时仍占焦：跳过本次 reload，blur 后补刷一次', async () => {
    const { input } = mountDetailPanel();

    handleTodoDomainChange({ source: 'agent', action: 'update', entityIds: ['item-1'] });
    await vi.advanceTimersByTimeAsync(BLUR_TIMEOUT_MS + 100);

    // 强行 reload 已移除：超时后不再冲掉详情面板草稿
    expect(loadLists).not.toHaveBeenCalled();
    expect(reloadCurrentView).not.toHaveBeenCalled();

    // blur 离开详情面板 → 延迟重试触发补刷
    input.blur();
    await vi.runAllTimersAsync();

    expect(loadLists).toHaveBeenCalledTimes(1);
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
    expect(agentFlashMany).toHaveBeenCalledWith('todo', ['item-1'], { scroll: 'first' });
    expect(selectItem).toHaveBeenCalledWith('item-1');

    // 一次性监听：后续 focus/blur 不重复补刷
    input.focus();
    input.blur();
    await vi.runAllTimersAsync();
    expect(loadLists).toHaveBeenCalledTimes(1);
  });

  it('占焦期间的多个域事件合并 entityIds，一次补刷', async () => {
    const { input } = mountDetailPanel();

    handleTodoDomainChange({ source: 'agent', action: 'update', entityIds: ['item-1'] });
    await vi.advanceTimersByTimeAsync(BLUR_TIMEOUT_MS + 100);
    expect(loadLists).not.toHaveBeenCalled();

    // 第二个域事件到达时接管挂起的 entityIds；焦点仍在详情面板 → 继续延迟
    handleTodoDomainChange({ source: 'agent', action: 'update', entityIds: ['item-2'] });
    await vi.advanceTimersByTimeAsync(BLUR_TIMEOUT_MS + 100);
    expect(loadLists).not.toHaveBeenCalled();

    input.blur();
    await vi.runAllTimersAsync();

    expect(loadLists).toHaveBeenCalledTimes(1);
    expect(agentFlashMany).toHaveBeenCalledTimes(1);
    expect(agentFlashMany).toHaveBeenCalledWith('todo', ['item-2', 'item-1'], { scroll: 'first' });
    expect(selectItem).toHaveBeenCalledWith('item-2');
  });

  it('user 来源与空 entityIds 事件不触发任何刷新', async () => {
    handleTodoDomainChange({ source: 'user', action: 'update', entityIds: ['item-1'] });
    handleTodoDomainChange({ source: 'agent', action: 'update', entityIds: [] });
    await vi.runAllTimersAsync();

    expect(loadLists).not.toHaveBeenCalled();
    expect(agentFlashMany).not.toHaveBeenCalled();
  });
});
