import { describe, expect, it } from 'vitest';
import {
  expectedTodoRevision, localizedTodoFailure, MAX_CONTENT_CHARS,
  optionalClearableString, optionalRepeatJson, optionalText, pagination, parseTags, todoConflict,
  todoItemJson, todoView, USER_TODO_COMPLETE_ITEM, USER_TODO_CREATE_ITEM, USER_TODO_CREATE_LIST, USER_TODO_DELETE_ITEM,
  USER_TODO_DELETE_LIST, USER_TODO_GET_SUMMARY, USER_TODO_LIST_ITEMS, USER_TODO_LIST_LISTS,
  USER_TODO_LIST_TRASH, USER_TODO_REORDER, USER_TODO_RESTORE, USER_TODO_SEARCH,
  USER_TODO_UPDATE_ITEM, USER_TODO_UPDATE_LIST, UserTodoExecutor, withUndoContract,
} from '../src/user-todo-tool.ts';
import { getUserTodoSchemas } from '../src/user-todo-schemas.ts';

describe('occ contract tests', () => {
  it('todo_revision_is_required_for_mutations', () => {
    let caught: unknown;
    try {
      expectedTodoRevision({}, '更新待办');
    } catch (error) {
      caught = error;
    }
    const error = JSON.parse((caught as Error).message) as Record<string, unknown>;
    expect(error.code).toBe('TODO_OCC_REQUIRED');
    expect(error.retryable).toBe(false);
    expect(error.messageKey).toBe('chat.tools.todo.occ_required');
    expect(typeof (error.messageFallback as Record<string, unknown>)['en-US']).toBe('string');
    expect(expectedTodoRevision({ expected_updated_at: ' rev-1 ' }, '更新待办')).toBe('rev-1');
  });

  it('todo_conflicts_use_one_structured_code', () => {
    const error = JSON.parse(todoConflict('changed', { id: 'todo-1', updatedAt: 'revision-2' })) as Record<string, unknown>;
    expect(error.code).toBe('TODO_CONFLICT');
    expect(error.retryable).toBe(false);
    expect((error.current as Record<string, unknown>).id).toBe('todo-1');
    expect(error.currentUpdatedAt).toBe('revision-2');
    expect(error.messageKey).toBe('chat.tools.todo.conflict');
    expect(String(error.hint)).toContain('list_items');
  });

  it('executor_failure_boundary_localizes_plain_errors_and_preserves_domain_errors', () => {
    const plain = JSON.parse(localizedTodoFailure('缺少必需参数: title')) as Record<string, unknown>;
    expect(plain.code).toBe('TODO_OPERATION_FAILED');
    expect(plain.messageKey).toBe('chat.tools.todo.error');
    expect(typeof (plain.messageFallback as Record<string, unknown>)['en-US']).toBe('string');

    const conflict = JSON.parse(localizedTodoFailure(todoConflict('changed', null))) as Record<string, unknown>;
    expect(conflict.code).toBe('TODO_CONFLICT');
    expect(conflict.messageKey).toBe('chat.tools.todo.conflict');
    expect((conflict.messageParams as Record<string, unknown>).code).toBe('TODO_CONFLICT');
  });

  it('optional_todo_fields_preserve_omit_and_support_clear', () => {
    expect(optionalClearableString({}, 'reminder', 'clear_reminder')).toBeNull();
    expect(optionalClearableString({ clear_reminder: true }, 'reminder', 'clear_reminder')).toBe('');
    expect(optionalClearableString({ reminder: '2026-07-14T08:00' }, 'reminder', 'clear_reminder'))
      .toBe('2026-07-14T08:00');

    expect(optionalRepeatJson({})).toBeNull();
    const repeat = optionalRepeatJson({
      repeat: { freq: 'weekly', interval: 2, byWeekday: [1, 3, 5] },
    }) as string;
    const parsed = JSON.parse(repeat) as Record<string, unknown>;
    expect(parsed.freq).toBe('weekly');
    expect(parsed.byWeekday).toEqual([1, 3, 5]);
    expect(optionalRepeatJson({ clear_repeat: true })).toBe('');
    expect(() => optionalRepeatJson({ repeat: { freq: 'daily' }, clear_repeat: true })).toThrow();
  });

  it('real_todo_writes_are_not_low_sensitivity', () => {
    const executor = new UserTodoExecutor();
    for (const tool of [USER_TODO_CREATE_ITEM, USER_TODO_COMPLETE_ITEM, USER_TODO_UPDATE_ITEM,
      USER_TODO_DELETE_ITEM, USER_TODO_CREATE_LIST, USER_TODO_UPDATE_LIST, USER_TODO_RESTORE,
      USER_TODO_REORDER]) {
      expect(executor.sensitivityLevel(tool), tool).toBe('medium');
    }
    expect(executor.sensitivityLevel(USER_TODO_DELETE_LIST)).toBe('high');
    for (const tool of [USER_TODO_LIST_LISTS, USER_TODO_LIST_ITEMS, USER_TODO_GET_SUMMARY,
      USER_TODO_SEARCH, USER_TODO_LIST_TRASH]) {
      expect(executor.sensitivityLevel(tool), tool).toBe('low');
    }
  });

  it('undo_contract_never_claims_an_unexecutable_restore', () => {
    const direct = withUndoContract({ success: true }, false, null, 'cannot replay', false);
    expect(direct.reversible).toBe(false);
    expect(direct.restoreWith).toBeNull();
    expect(direct.undoReason).toBe('cannot replay');

    const approval = withUndoContract(
      { success: true }, false, { tool: USER_TODO_DELETE_LIST }, 'high approval required', true);
    expect(approval.reversible).toBe(false);
    expect(approval.reversibleWithApproval).toBe(true);
    expect((approval.restoreWith as Record<string, unknown>).tool).toBe(USER_TODO_DELETE_LIST);
  });

  it('user_text_is_unicode_safely_bounded_and_reports_fields', () => {
    const long = '你'.repeat(MAX_CONTENT_CHARS + 3);
    const value = todoItemJson({
      id: 'ti_test',
      todo_list_id: 'tdl_test',
      title: long,
      description: long,
      status: 'pending',
      priority: 'none',
      due_date: null,
      due_time: null,
      reminder: null,
      tags_json: JSON.stringify([long]),
      sort_order: 0,
      parent_id: null,
      completed_at: null,
      repeat_json: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
    });
    expect([...(value.title as string)].length).toBe(MAX_CONTENT_CHARS);
    expect([...(value.description as string)].length).toBe(MAX_CONTENT_CHARS);
    expect([...(value.tags as string[])[0]!].length).toBe(MAX_CONTENT_CHARS);
    expect(value.fieldsTruncated).toEqual(['title', 'description', 'tags']);
  });

  it('executor_validates_text_tags_pagination_and_views', () => {
    expect(() => optionalText({ title: 'x'.repeat(201) }, 'title', 200)).toThrow();
    expect(() => parseTags({ tags: ['ok', 7] })).toThrow();
    expect(() => pagination({ page: 1, page_size: 21 })).toThrow();
    expect(todoView({})).toBe('all');
    expect(() => todoView({ view: 'unknown' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MFJS schema tests
//
// L02 owns `normalize_tool_schemas_for_mfjs` but has not published it through
// `llm/api.ts` yet, so this module uses a minimal test double implementing the
// documented MFJS rewrite subset the Rust test relies on: drop unsupported
// keywords and distribute `anyOf` siblings into the branches. The schemas under
// test are the real `get_user_todo_schemas()` port, not samples.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

const MFJS_SUPPORTED_KEYWORDS = new Set([
  'type', 'properties', 'additionalProperties', 'items', 'enum', 'required', 'anyOf',
  'description', '$defs', '$ref', 'title', '$id', 'default', 'maxLength', 'minLength',
  'maximum', 'minimum', 'maxItems', 'minItems', 'pattern',
]);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMfjsForTest(tools: JsonObject[]): number {
  let rewrites = 0;
  const mergeBranch = (branch: JsonObject, key: string, value: unknown): void => {
    if (key === 'required') {
      const existing = branch.required;
      if (Array.isArray(existing)) {
        if (Array.isArray(value)) {
          for (const item of value) if (!existing.includes(item)) existing.push(structuredClone(item));
        }
        return;
      }
    } else if (key === 'properties') {
      const existing = branch.properties;
      if (isJsonObject(existing)) {
        if (isJsonObject(value)) {
          for (const [name, sub] of Object.entries(value)) {
            if (!Object.prototype.hasOwnProperty.call(existing, name)) existing[name] = structuredClone(sub);
          }
        }
        return;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(branch, key)) branch[key] = structuredClone(value);
  };

  const visit = (node: unknown): void => {
    if (!isJsonObject(node)) return;
    for (const key of Object.keys(node)) {
      if (!MFJS_SUPPORTED_KEYWORDS.has(key)) {
        delete node[key];
        rewrites += 1;
      }
    }
    const anyOf = node.anyOf;
    if (Array.isArray(anyOf) && anyOf.length > 0 && anyOf.every(isJsonObject)) {
      const branches = anyOf as JsonObject[];
      const siblings = Object.keys(node).filter((key) => key !== 'anyOf'
        && key !== 'description' && key !== 'title' && key !== '$defs' && key !== '$id');
      if (siblings.length > 0) {
        for (const key of siblings) {
          for (const branch of branches) mergeBranch(branch, key, node[key]);
        }
        for (const key of siblings) delete node[key];
        rewrites += 1;
      }
    }
    if (Array.isArray(node.anyOf)) for (const branch of node.anyOf) visit(branch);
    if (isJsonObject(node.properties)) for (const sub of Object.values(node.properties)) visit(sub);
    if (isJsonObject(node.$defs)) for (const sub of Object.values(node.$defs)) visit(sub);
    if (Array.isArray(node.items)) for (const sub of node.items) visit(sub);
    else if (node.items !== undefined) visit(node.items);
  };

  for (const tool of tools) {
    if (!isJsonObject(tool.function)) continue;
    visit(tool.function.parameters);
  }
  return rewrites;
}

const MFJS_BANNED_KEYWORDS = [
  'uniqueItems', 'minProperties', 'maxProperties', 'exclusiveMinimum',
  'exclusiveMaximum', 'oneOf', 'allOf', 'const',
] as const;

function expectMfjsClean(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => expectMfjsClean(value, `${path}[${index}]`));
    return;
  }
  if (!isJsonObject(node)) return;
  for (const banned of MFJS_BANNED_KEYWORDS) {
    expect(node[banned], `${banned} remains at ${path}`).toBeUndefined();
  }
  if ('anyOf' in node) {
    for (const key of Object.keys(node)) {
      expect(
        ['anyOf', 'description', 'title', '$defs', '$id'],
        `anyOf sibling '${key}' at ${path}`,
      ).toContain(key);
    }
  }
  if ('enum' in node) expect('type' in node, `bare enum at ${path}`).toBe(true);
  for (const [key, value] of Object.entries(node)) expectMfjsClean(value, `${path}.${key}`);
}

describe('mfjs schema tests', () => {
  it('mfjs_normalizes_real_rust_builtin_tool_schemas', () => {
    const tools = getUserTodoSchemas();
    const rewrites = normalizeMfjsForTest(tools);
    expect(rewrites).toBeGreaterThan(0);

    for (const tool of tools) {
      const fn = tool.function;
      if (!isJsonObject(fn)) continue;
      const name = typeof fn.name === 'string' ? fn.name : '<unnamed>';
      expectMfjsClean(fn.parameters, name);
    }

    const update = tools.find((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) && fn.name === USER_TODO_UPDATE_LIST;
    });
    expect(update, 'user_todo_update_list schema').toBeDefined();
    const fn = update!.function as JsonObject;
    expect(Object.keys(fn.parameters as JsonObject)).toEqual(['anyOf']);
  });
});
