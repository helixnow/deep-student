import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../kernel/agent-api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  CreateTodoItemParams, CreateTodoListParams, TodoActiveSummary, TodoItem, TodoList,
  TodoRepository, UpdateTodoItemParams, UpdateTodoListParams,
} from '../../vfs-repos/api.ts';
import {
  USER_TODO_COMPLETE_ITEM, USER_TODO_CREATE_ITEM, USER_TODO_DELETE_ITEM, USER_TODO_LIST_ITEMS,
  USER_TODO_REORDER, USER_TODO_RESTORE, USER_TODO_UPDATE_ITEM, UserTodoExecutor,
  type UserTodoExecutorPorts,
} from '../src/user-todo-tool.ts';

const CONN = {} as SqlExecutor;

function item(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'item-1', todoListId: 'inbox', title: 'Buy milk', description: '2 litres',
    status: 'pending', priority: 'none', tagsJson: '["errand"]', sortOrder: 0,
    attachmentsJson: '[]', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: 'rev-1', ...overrides,
  };
}

function list(overrides: Partial<TodoList> = {}): TodoList {
  return {
    id: 'inbox', title: 'Inbox', sortOrder: 0, isDefault: true, isFavorite: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: 'rev-1', ...overrides,
  };
}

interface FakeState {
  lists: TodoList[];
  items: TodoItem[];
  events: Array<[string, unknown]>;
  toggled: string[];
  updated?: UpdateTodoItemParams;
  updatedList?: UpdateTodoListParams;
  reordered?: { listId: string; itemIds: readonly string[]; expected: string | null | undefined };
}

function fakeRepo(state: FakeState): TodoRepository {
  const findItem = (id: string) => state.items.find((row) => row.id === id) ?? null;
  const findList = (id: string) => state.lists.find((row) => row.id === id) ?? null;
  const repo = {
    listTodoLists: () => state.lists,
    getTodoList: (_conn: SqlExecutor, id: string) => findList(id),
    ensureDefaultInbox: () => findList('inbox') ?? (state.lists.push(list()), findList('inbox')!),
    createTodoList: (_conn: SqlExecutor, params: CreateTodoListParams) => {
      const created = list({ id: `list-${state.lists.length + 1}`, title: params.title,
        description: params.description ?? undefined, icon: params.icon ?? undefined,
        color: params.color ?? undefined, isDefault: false, updatedAt: 'rev-2' });
      state.lists.push(created);
      return created;
    },
    updateTodoListIfVersion: (_conn: SqlExecutor, id: string, params: UpdateTodoListParams, expected: string) => {
      const current = findList(id)!;
      if (current.updatedAt !== expected) throw new Error('TODO_CONFLICT list');
      const previous = { ...current };
      const updated = { ...current, ...params, description: params.description ?? current.description,
        icon: params.icon ?? current.icon, color: params.color ?? current.color,
        title: params.title ?? current.title, updatedAt: 'rev-2' };
      state.updatedList = params;
      state.lists = state.lists.map((row) => (row.id === id ? updated : row));
      return [previous, updated];
    },
    deleteTodoListIfVersion: (_conn: SqlExecutor, id: string, expected: string) => {
      const current = findList(id)!;
      if (current.updatedAt !== expected) throw new Error('TODO_CONFLICT list');
      return current;
    },
    restoreTodoList: (_conn: SqlExecutor, id: string) => findList(id)!,
    createTodoItem: (_conn: SqlExecutor, params: CreateTodoItemParams) => {
      const created = item({
        id: `item-${state.items.length + 1}`,
        todoListId: params.todoListId,
        title: params.title,
        description: params.description ?? undefined,
        priority: params.priority ?? 'none',
        dueDate: params.dueDate ?? undefined,
        dueTime: params.dueTime ?? undefined,
        reminder: params.reminder ?? undefined,
        tagsJson: JSON.stringify(params.tags ?? []),
        parentId: params.parentId ?? undefined,
        repeatJson: params.repeatJson ?? undefined,
        updatedAt: 'rev-2',
      });
      state.items.push(created);
      return created;
    },
    getTodoItem: (_conn: SqlExecutor, id: string) => findItem(id),
    toggleTodoItem: (_conn: SqlExecutor, id: string, expected?: string | null) => {
      const current = findItem(id)!;
      if (expected != null && expected !== '' && current.updatedAt !== expected) {
        throw new Error('TODO_CONFLICT item');
      }
      state.toggled.push(id);
      const updated = { ...current, status: 'completed', updatedAt: 'rev-2' };
      state.items = state.items.map((row) => (row.id === id ? updated : row));
      return updated;
    },
    updateTodoItem: (_conn: SqlExecutor, id: string, params: UpdateTodoItemParams) => {
      const current = findItem(id)!;
      if (params.expectedUpdatedAt != null && params.expectedUpdatedAt !== current.updatedAt) {
        throw new Error('TODO_CONFLICT item');
      }
      state.updated = params;
      const updated: TodoItem = {
        ...current,
        title: params.title ?? current.title,
        description: params.description ?? current.description,
        priority: params.priority ?? current.priority,
        dueDate: params.dueDate ?? current.dueDate,
        dueTime: params.dueTime ?? current.dueTime,
        reminder: params.reminder === '' ? undefined : (params.reminder ?? current.reminder),
        parentId: params.parentId === '' ? undefined : (params.parentId ?? current.parentId),
        repeatJson: params.repeatJson === '' ? undefined : (params.repeatJson ?? current.repeatJson),
        updatedAt: 'rev-2',
      };
      state.items = state.items.map((row) => (row.id === id ? updated : row));
      return updated;
    },
    deleteTodoItemIfVersion: (_conn: SqlExecutor, id: string, expected: string) => {
      const current = findItem(id)!;
      if (current.updatedAt !== expected) throw new Error('TODO_CONFLICT item');
      state.items = state.items.map((row) => (row.id === id ? { ...row, deletedAt: 'now' } : row));
      return current;
    },
    restoreTodoItem: (_conn: SqlExecutor, id: string) => findItem(id)!,
    listItemsByList: (_conn: SqlExecutor, listId: string) => state.items.filter((row) => row.todoListId === listId),
    listAllPendingItems: () => state.items.filter((row) => row.status !== 'completed'),
    listCompletedItems: (_conn: SqlExecutor, listId?: string | null) => state.items.filter((row) =>
      row.status === 'completed' && (listId == null || row.todoListId === listId)),
    listTodayItems: () => state.items,
    listOverdueItems: () => [],
    listUpcomingItems: () => [],
    getActiveTodoSummary: (): TodoActiveSummary | null => null,
    formatActiveSummaryForPrompt: (summary: TodoActiveSummary) => `summary:${summary.stats.totalPending}`,
    searchItemsPaginated: (_conn: SqlExecutor, query: string) => {
      const matches = state.items.filter((row) => row.title.includes(query));
      return [matches, matches.length];
    },
    listDeletedTodoItems: (_conn: SqlExecutor, limit: number, offset: number) =>
      state.items.filter((row) => row.deletedAt !== undefined).slice(offset, offset + limit),
    countDeletedTodoItems: () => state.items.filter((row) => row.deletedAt !== undefined).length,
    listDeletedTodoLists: (_conn: SqlExecutor, limit: number, offset: number) =>
      state.lists.filter((row) => row.deletedAt !== undefined).slice(offset, offset + limit),
    countDeletedTodoLists: () => state.lists.filter((row) => row.deletedAt !== undefined).length,
    reorderItems: (_conn: SqlExecutor, listId: string, itemIds: readonly string[], expected?: string | null) => {
      state.reordered = { listId, itemIds, expected };
    },
  };
  return repo as unknown as TodoRepository;
}

function makeState(): FakeState {
  return { lists: [list()], items: [item()], events: [], toggled: [] };
}

function context(state: FakeState): ExecutionContext {
  return {
    ids: { sessionId: 'session-1', messageId: 'message-1', blockId: 'block-1', toolCallId: 'call-1', round: 0 },
    host: {
      hasFrontend: () => true,
      emit: (event: string, payload: unknown) => { state.events.push([event, payload]); },
    },
    isCancelled: () => false,
  } as unknown as ExecutionContext;
}

function executor(state: FakeState): UserTodoExecutor {
  const ports: UserTodoExecutorPorts = { conn: () => CONN, todos: fakeRepo(state) };
  return new UserTodoExecutor(ports);
}

function call(name: string, args: Record<string, unknown> = {}) {
  return { id: 'call-1', name, arguments: args };
}

describe('user_todo_executor execute', () => {
  it('create_item_uses_default_inbox_and_emits_agent_event', async () => {
    const state = makeState();
    state.items = [];
    const result = await executor(state).execute(call(USER_TODO_CREATE_ITEM, { title: 'Buy milk' }), context(state));
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect((output.item as Record<string, unknown>).listId).toBe('inbox');
    expect((output.item as Record<string, unknown>).title).toBe('Buy milk');
    expect((output.restoreWith as Record<string, unknown>).tool).toBe(USER_TODO_DELETE_ITEM);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]![0]).toBe('todo://changed');
    expect(state.events[0]![1]).toMatchObject({
      source: 'agent', action: 'create_item', entityIds: ['item-1', 'inbox'], runId: 'call-1',
    });
  });

  it('complete_item_is_idempotent_and_does_not_toggle_completed_item', async () => {
    const state = makeState();
    state.items = [item({ status: 'completed', updatedAt: 'rev-1' })];
    const result = await executor(state).execute(
      call(USER_TODO_COMPLETE_ITEM, { item_id: 'item-1', expected_updated_at: 'rev-1' }), context(state),
    );
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.reversible).toBe(false);
    expect(output.undoReason).toBe('本次调用未产生状态变化，无需撤销');
    expect(state.toggled).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it('complete_item_maps_revision_conflict_to_structured_todo_conflict', async () => {
    const state = makeState();
    state.items = [item({ updatedAt: 'rev-2' })];
    const result = await executor(state).execute(
      call(USER_TODO_COMPLETE_ITEM, { item_id: 'item-1', expected_updated_at: 'rev-1' }), context(state),
    );
    expect(result.success).toBe(false);
    const error = JSON.parse(result.error!) as Record<string, unknown>;
    expect(error.code).toBe('TODO_CONFLICT');
    expect(error.retryable).toBe(false);
    expect((error.current as Record<string, unknown>).id).toBe('item-1');
    expect(error.currentUpdatedAt).toBe('rev-2');
  });

  it('update_item_preserves_three_state_clear_semantics', async () => {
    const state = makeState();
    state.items = [item({ reminder: '2026-07-14T08:00', parentId: 'parent-1' })];
    const result = await executor(state).execute(
      call(USER_TODO_UPDATE_ITEM, {
        item_id: 'item-1', expected_updated_at: 'rev-1', clear_reminder: true, clear_parent: true,
      }),
      context(state),
    );
    expect(result.success).toBe(true);
    expect(state.updated?.reminder).toBe('');
    expect(state.updated?.parentId).toBe('');
    expect(state.updated?.expectedUpdatedAt).toBe('rev-1');
    const output = result.output as Record<string, unknown>;
    expect((output.previous as Record<string, unknown>).reminder).toBe('2026-07-14T08:00');
  });

  it('list_items_reports_pagination_and_view', async () => {
    const state = makeState();
    state.items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const result = await executor(state).execute(
      call(USER_TODO_LIST_ITEMS, { page: 1, page_size: 2 }), context(state),
    );
    const output = result.output as Record<string, unknown>;
    expect(output.view).toBe('all');
    expect(output.count).toBe(2);
    expect(output.total).toBe(3);
    expect(output.has_more).toBe(true);
    expect(output.page).toBe(1);
    expect(output.page_size).toBe(2);
  });

  it('delete_item_returns_soft_delete_and_restore_contract', async () => {
    const state = makeState();
    const result = await executor(state).execute(
      call(USER_TODO_DELETE_ITEM, { item_id: 'item-1', expected_updated_at: 'rev-1' }), context(state),
    );
    const output = result.output as Record<string, unknown>;
    expect(output.softDeleted).toBe(true);
    expect(output.reversible).toBe(true);
    expect((output.restoreWith as Record<string, unknown>).tool).toBe(USER_TODO_RESTORE);
    expect(state.events[0]![1]).toMatchObject({ action: 'delete_item', entityIds: ['item-1', 'inbox'] });
  });

  it('restore_list_requires_approval_and_points_at_high_risk_delete', async () => {
    const state = makeState();
    state.lists = [list()];
    const result = await executor(state).execute(
      call(USER_TODO_RESTORE, { entity_type: 'list', entity_id: 'inbox' }), context(state),
    );
    const output = result.output as Record<string, unknown>;
    expect(output.reversible).toBe(false);
    expect(output.reversibleWithApproval).toBe(true);
    expect(typeof output.undoReason).toBe('string');
    expect((output.restoreWith as Record<string, unknown>).tool).toBe('user_todo_delete_list');
  });

  it('reorder_records_previous_order_and_revision', async () => {
    const state = makeState();
    state.items = [item({ id: 'a' }), item({ id: 'b' })];
    const result = await executor(state).execute(
      call(USER_TODO_REORDER, {
        list_id: 'inbox', item_ids: ['b', 'a'], expected_updated_at: 'rev-1',
      }),
      context(state),
    );
    const output = result.output as Record<string, unknown>;
    expect(output.reorderedCount).toBe(2);
    expect(state.reordered?.itemIds).toEqual(['b', 'a']);
    expect((output.previous as Record<string, unknown>).itemIds).toEqual(['a', 'b']);
    expect((output.restoreWith as Record<string, unknown>).arguments).toMatchObject({
      list_id: 'inbox', item_ids: ['a', 'b'], expected_updated_at: 'rev-1',
    });
  });

  it('mutation_without_occ_returns_localized_occ_required', async () => {
    const state = makeState();
    const result = await executor(state).execute(
      call(USER_TODO_UPDATE_ITEM, { item_id: 'item-1', title: 'x' }), context(state),
    );
    expect(result.success).toBe(false);
    const error = JSON.parse(result.error!) as Record<string, unknown>;
    expect(error.code).toBe('TODO_OCC_REQUIRED');
    expect(error.messageKey).toBe('chat.tools.todo.occ_required');
  });

  it('unknown_tool_is_localized_operation_failure', async () => {
    const state = makeState();
    const result = await executor(state).execute(call('builtin-user_todo_unknown'), context(state));
    expect(result.success).toBe(false);
    const error = JSON.parse(result.error!) as Record<string, unknown>;
    expect(error.code).toBe('TODO_OPERATION_FAILED');
  });

  it('emits tool_call lifecycle hooks and saves tool block when provided by chat runtime', async () => {
    const state = makeState();
    const starts: unknown[] = [];
    const ends: unknown[] = [];
    const errors: string[] = [];
    const saved: unknown[] = [];
    const runtimeCtx = Object.assign(context(state), {
      emitToolCallStart: (toolName: string, input: unknown, toolCallId: string | null) => {
        starts.push({ toolName, input, toolCallId });
      },
      emitToolCallEnd: (result: unknown | null) => {
        ends.push(result);
      },
      emitToolCallError: (error: string) => {
        errors.push(error);
      },
      saveToolBlock: (result: unknown) => {
        saved.push(result);
      },
    });
    const ok = await executor(state).execute(
      { id: 'call_summary', name: 'builtin-user_todo_get_summary', arguments: {} },
      runtimeCtx,
    );
    expect(ok.success).toBe(true);
    expect(starts).toEqual([{ toolName: 'builtin-user_todo_get_summary', input: {}, toolCallId: 'call_summary' }]);
    expect(ends).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(saved).toHaveLength(1);

    const fail = await executor(state).execute(call('builtin-user_todo_unknown'), runtimeCtx);
    expect(fail.success).toBe(false);
    expect(errors).toHaveLength(1);
    expect(saved).toHaveLength(2);
  });
});
