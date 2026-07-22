/** Todo 应用 ACR 语义导航。数据写入仍归 user_todo 领域工具。 */

import type { TodoPriority, TodoSortBy, TodoViewFilter } from '@/features/todo/types';
import type { ActivationContext, ActivationResult } from '../../core/types';
import { agentFlash } from '../../agent/visuals/agentFlash';

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: unknown, key: string): string | null {
  const value = payloadRecord(payload)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const TODO_VIEWS = new Set<TodoViewFilter>([
  'all',
  'today',
  'upcoming',
  'overdue',
  'completed',
  'matrix',
]);
const TODO_PRIORITIES = new Set<TodoPriority>(['none', 'low', 'medium', 'high', 'urgent']);
const TODO_SORTS = new Set<TodoSortBy>(['manual', 'dueDate', 'priority', 'title']);

function invalid(hint: string): ActivationResult {
  return { handled: false, code: 'INVALID_ARGS', hint };
}

/** 同步 store 写入后的读回校验：命中即返回 authoritative ack，避免 ACTION_UNVERIFIED 假阴性。 */
const ackIf = (verified: boolean): ActivationResult =>
  verified ? { handled: true, acknowledged: true } : { handled: true };

/**
 * 桌面回收站是主内容区的内联视图（useTodoTrashView）；导航类 action
 * 生效前必须收起，否则 store 状态已切换但主区仍停留在回收站。
 * 动态 import + 容错：视图模块加载失败（如精简测试环境）不阻断导航。
 */
async function closeTrashViewBestEffort(): Promise<void> {
  try {
    const { useTodoTrashView } = await import('@/features/todo/components/TodoTrashDialog');
    useTodoTrashView.getState().close();
  } catch {
    // 回收站视图属 UI 增强；模块不可用时导航行为保持原样
  }
}

/** 导出供单测与 AppDefinition.onActivation。 */
export async function handleTodoActivation(ctx: ActivationContext): Promise<ActivationResult> {
  const { useTodoStore } = await import('@/features/todo/stores/useTodoStore');
  const store = useTodoStore.getState();

  switch (ctx.action) {
    case 'showAutomations': {
      await closeTrashViewBestEffort();
      store.setWorkspaceView('automations');
      return ackIf(useTodoStore.getState().workspaceView === 'automations');
    }
    case 'showList': {
      const listId = payloadString(ctx.payload, 'listId');
      if (!listId) return invalid('showList 需要 payload.listId');
      await closeTrashViewBestEffort();
      store.setWorkspaceView('todos');
      store.setActiveList(listId);
      await useTodoStore.getState().reloadCurrentView();
      const after = useTodoStore.getState();
      return ackIf(after.workspaceView === 'todos' && after.activeListId === listId);
    }
    case 'focusItem': {
      const itemId = payloadString(ctx.payload, 'itemId');
      if (!itemId) return invalid('focusItem 需要 payload.itemId');
      let item = useTodoStore.getState().items.find((candidate) => candidate.id === itemId);
      if (!item) {
        const { getTodoItem } = await import('@/features/todo/api');
        item = await getTodoItem(itemId) ?? undefined;
      }
      if (!item) return invalid('focusItem 指向的待办不存在');
      await closeTrashViewBestEffort();
      const current = useTodoStore.getState();
      current.setWorkspaceView('todos');
      if (current.filter.view !== 'all') current.setViewFilter('all');
      if (current.activeListId !== item.todoListId) current.setActiveList(item.todoListId);
      await useTodoStore.getState().loadItems(item.todoListId, false);
      useTodoStore.getState().selectItem(itemId);
      agentFlash('todo', itemId);
      const after = useTodoStore.getState();
      return ackIf(after.selectedItemId === itemId && after.workspaceView === 'todos');
    }
    case 'quickAdd': {
      const dueDate = payloadString(ctx.payload, 'dueDate');
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return invalid('quickAdd 的 dueDate 必须是 YYYY-MM-DD');
      }
      if (useTodoStore.getState().lists.length === 0) {
        await useTodoStore.getState().initialize();
      }
      const current = useTodoStore.getState();
      const listId = payloadString(ctx.payload, 'listId')
        ?? current.activeListId
        ?? current.lists.find((list) => list.isDefault)?.id
        ?? current.lists[0]?.id;
      if (!listId) return invalid('quickAdd 找不到可用待办清单');
      await closeTrashViewBestEffort();
      current.setWorkspaceView('todos');
      if (current.filter.view !== 'all') current.setViewFilter('all');
      useTodoStore.getState().setActiveList(listId);
      await useTodoStore.getState().loadItems(listId, false);
      useTodoStore.getState().requestQuickAdd(dueDate ?? undefined);
      const after = useTodoStore.getState();
      const preset = after.quickAddPreset;
      const dueOk = dueDate ? preset?.dueDate === dueDate : preset != null;
      return ackIf(
        after.workspaceView === 'todos'
          && after.activeListId === listId
          && dueOk,
      );
    }
    case 'showView': {
      const view = payloadString(ctx.payload, 'view') as TodoViewFilter | null;
      if (!view || !TODO_VIEWS.has(view)) {
        return invalid('showView 需要 view=all|today|upcoming|overdue|completed|matrix');
      }
      await closeTrashViewBestEffort();
      store.setWorkspaceView('todos');
      store.setViewFilter(view);
      await useTodoStore.getState().reloadCurrentView();
      const after = useTodoStore.getState();
      return ackIf(after.workspaceView === 'todos' && after.filter.view === view);
    }
    case 'search': {
      const query = payloadString(ctx.payload, 'query') ?? '';
      store.setWorkspaceView('todos');
      store.setSearch(query);
      if (query) await useTodoStore.getState().searchItems(query);
      else await useTodoStore.getState().reloadCurrentView();
      const after = useTodoStore.getState();
      return ackIf(after.workspaceView === 'todos' && after.filter.search === query);
    }
    case 'setFilters': {
      const payload = payloadRecord(ctx.payload);
      if (payload.priority === null) {
        store.setPriorityFilter(null);
      } else if (typeof payload.priority === 'string') {
        const priority = payload.priority as TodoPriority;
        if (!TODO_PRIORITIES.has(priority)) return invalid('priority 值无效');
        store.setPriorityFilter(priority);
      }
      if (typeof payload.showCompleted === 'boolean') {
        store.setShowCompleted(payload.showCompleted);
      }
      if (typeof payload.sortBy === 'string') {
        const sortBy = payload.sortBy as TodoSortBy;
        if (!TODO_SORTS.has(sortBy)) return invalid('sortBy 值无效');
        store.setSortBy(sortBy);
      }
      store.setWorkspaceView('todos');
      await useTodoStore.getState().reloadCurrentView();
      const after = useTodoStore.getState();
      let verified = after.workspaceView === 'todos';
      if (payload.priority === null) {
        verified = verified && after.filter.priorityFilter === null;
      } else if (typeof payload.priority === 'string') {
        verified = verified && after.filter.priorityFilter === payload.priority;
      }
      if (typeof payload.showCompleted === 'boolean') {
        verified = verified && after.filter.showCompleted === payload.showCompleted;
      }
      if (typeof payload.sortBy === 'string') {
        verified = verified && after.filter.sortBy === payload.sortBy;
      }
      return ackIf(verified);
    }
    default:
      return {
        handled: false,
        code: 'UNKNOWN_ACTION',
        hint: `Todo 不支持指令 ${ctx.action}`,
      };
  }
}
