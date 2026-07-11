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

/** 导出供单测与 AppDefinition.onActivation。 */
export async function handleTodoActivation(ctx: ActivationContext): Promise<ActivationResult> {
  const { useTodoStore } = await import('@/features/todo/stores/useTodoStore');
  const store = useTodoStore.getState();

  switch (ctx.action) {
    case 'showList': {
      const listId = payloadString(ctx.payload, 'listId');
      if (!listId) return invalid('showList 需要 payload.listId');
      store.setActiveList(listId);
      await useTodoStore.getState().reloadCurrentView();
      return { handled: true };
    }
    case 'focusItem': {
      const itemId = payloadString(ctx.payload, 'itemId');
      if (!itemId) return invalid('focusItem 需要 payload.itemId');
      store.selectItem(itemId);
      agentFlash('todo', itemId);
      return { handled: true };
    }
    case 'showView': {
      const view = payloadString(ctx.payload, 'view') as TodoViewFilter | null;
      if (!view || !TODO_VIEWS.has(view)) {
        return invalid('showView 需要 view=all|today|upcoming|overdue|completed|matrix');
      }
      store.setViewFilter(view);
      await useTodoStore.getState().reloadCurrentView();
      return { handled: true };
    }
    case 'search': {
      const query = payloadString(ctx.payload, 'query') ?? '';
      store.setSearch(query);
      if (query) await useTodoStore.getState().searchItems(query);
      else await useTodoStore.getState().reloadCurrentView();
      return { handled: true };
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
      await useTodoStore.getState().reloadCurrentView();
      return { handled: true };
    }
    default:
      return {
        handled: false,
        code: 'UNKNOWN_ACTION',
        hint: `Todo 不支持指令 ${ctx.action}`,
      };
  }
}
