// chat_v2/tools/user_todo_executor.rs::get_user_todo_schemas.
//
// The chat tool registry (L02/L04) will consume these OpenAI function wire
// schemas once the tool runtime is migrated. They are kept here because
// `user_todo_executor.rs` is owned by this lane and the MFJS compatibility test
// asserts the *real* builtin schemas, not a hand-written sample.
import {
  USER_TODO_COMPLETE_ITEM, USER_TODO_CREATE_ITEM, USER_TODO_CREATE_LIST,
  USER_TODO_DELETE_ITEM, USER_TODO_DELETE_LIST, USER_TODO_GET_SUMMARY,
  USER_TODO_LIST_ITEMS, USER_TODO_LIST_LISTS, USER_TODO_LIST_TRASH,
  USER_TODO_REORDER, USER_TODO_RESTORE, USER_TODO_SEARCH,
  USER_TODO_UPDATE_ITEM, USER_TODO_UPDATE_LIST,
} from './user-todo-tool.ts';

type Schema = Record<string, unknown>;

function tool(name: string, description: string, parameters: Schema): Schema {
  return { type: 'function', function: { name, description, parameters } };
}

const PRIORITY = {
  type: 'string',
  enum: ['none', 'low', 'medium', 'high', 'urgent'],
};

const PAGE = {
  type: 'integer',
  minimum: 1,
  default: 1,
};
const PAGE_SIZE = {
  type: 'integer',
  minimum: 1,
  maximum: 20,
  default: 20,
};

/** Rust `get_user_todo_schemas()`: a fresh array on every call. */
export function getUserTodoSchemas(): Schema[] {
  return [
    tool(USER_TODO_LIST_LISTS, '列出用户的所有待办列表。返回列表的ID、标题等信息。', {
      type: 'object',
      properties: { page: { ...PAGE }, page_size: { ...PAGE_SIZE } },
      additionalProperties: false,
      required: [],
    }),
    tool(USER_TODO_CREATE_ITEM, '在用户的待办列表中创建新的待办项。如果不指定 list_id，将使用默认收件箱。', {
      type: 'object',
      properties: {
        title: { type: 'string', description: '待办项标题' },
        description: { type: 'string', description: '详细描述（可选）' },
        priority: { ...PRIORITY, description: '优先级，默认 none' },
        due_date: { type: 'string', description: '截止日期，格式 YYYY-MM-DD（可选）' },
        due_time: { type: 'string', description: '截止时间，格式 HH:MM（可选）' },
        reminder: { type: 'string', description: '提醒时间，格式 YYYY-MM-DDTHH:MM（可选）' },
        list_id: { type: 'string', description: '目标待办列表ID（可选，默认使用收件箱）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
        parent_id: { type: 'string', description: '父待办项 ID（可选，用于创建子任务）' },
        repeat: {
          type: 'object',
          additionalProperties: false,
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'] },
            interval: { type: 'integer', minimum: 1, maximum: 999 },
            byWeekday: {
              type: 'array',
              items: { type: 'integer', minimum: 0, maximum: 6 },
              uniqueItems: true,
            },
          },
          required: ['freq'],
          description: '重复规则（可选）',
        },
      },
      required: ['title'],
      additionalProperties: false,
    }),
    tool(USER_TODO_COMPLETE_ITEM, '将待办项标记为已完成。', {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '待办项ID' },
        expected_updated_at: {
          type: 'string', minLength: 1, description: 'list_items 返回的 updatedAt OCC 基线',
        },
      },
      required: ['item_id', 'expected_updated_at'],
      additionalProperties: false,
    }),
    tool(USER_TODO_LIST_ITEMS, '列出待办列表中的待办项。可按列表ID筛选，也可查看今日、逾期等视图。', {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: '待办列表ID（可选）' },
        view: {
          type: 'string',
          enum: ['all', 'today', 'overdue', 'upcoming', 'completed'],
          description: '视图过滤，默认 all',
        },
        include_completed: { type: 'boolean', description: '是否包含已完成项，默认 false' },
        page: { ...PAGE },
        page_size: { ...PAGE_SIZE },
      },
      required: [],
      additionalProperties: false,
    }),
    tool(USER_TODO_GET_SUMMARY, '获取用户待办事项的总览摘要，包括今日待办、逾期项、统计数据等。', {
      type: 'object',
      properties: {},
      required: [],
    }),
    tool(USER_TODO_DELETE_ITEM, '将待办项软删除到回收站（Medium，可恢复；强制 OCC）。', {
      type: 'object',
      properties: {
        item_id: { type: 'string', minLength: 1 },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
      required: ['item_id', 'expected_updated_at'],
      additionalProperties: false,
    }),
    tool(USER_TODO_CREATE_LIST, '创建待办清单。', {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 2000 },
        icon: { type: 'string', maxLength: 64 },
        color: { type: 'string', maxLength: 32 },
      },
      required: ['title'],
      additionalProperties: false,
    }),
    tool(USER_TODO_UPDATE_LIST, '更新待办清单（强制 OCC）。', {
      type: 'object',
      properties: {
        list_id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 2000 },
        icon: { type: 'string', maxLength: 64 },
        color: { type: 'string', maxLength: 32 },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
      required: ['list_id', 'expected_updated_at'],
      anyOf: [
        { required: ['title'] },
        { required: ['description'] },
        { required: ['icon'] },
        { required: ['color'] },
      ],
      additionalProperties: false,
    }),
    tool(USER_TODO_DELETE_LIST, '将非默认清单及其待办软删除到回收站（High，每次 ask_user，不可记住授权；强制 OCC）。', {
      type: 'object',
      properties: {
        list_id: { type: 'string', minLength: 1 },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
      required: ['list_id', 'expected_updated_at'],
      additionalProperties: false,
    }),
    tool(USER_TODO_SEARCH, '跨清单分页搜索待办项（每页最多 20 条）。', {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        page: { ...PAGE },
        page_size: { ...PAGE_SIZE },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    tool(USER_TODO_LIST_TRASH, '分页列出待办项或清单回收站。', {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['item', 'list'] },
        page: { ...PAGE },
        page_size: { ...PAGE_SIZE },
      },
      required: ['entity_type'],
      additionalProperties: false,
    }),
    tool(USER_TODO_RESTORE, '从回收站恢复一个待办项或清单（Medium）。', {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['item', 'list'] },
        entity_id: { type: 'string', minLength: 1 },
      },
      required: ['entity_type', 'entity_id'],
      additionalProperties: false,
    }),
    tool(USER_TODO_REORDER, '按 item_ids 的完整顺序重排清单待办项（Medium，强制 OCC）。', {
      type: 'object',
      properties: {
        list_id: { type: 'string', minLength: 1 },
        item_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: { type: 'string', minLength: 1 },
        },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
      required: ['list_id', 'item_ids', 'expected_updated_at'],
      additionalProperties: false,
    }),
    tool(USER_TODO_UPDATE_ITEM, '更新待办项的属性（标题、描述、优先级、日期等）。', {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '待办项ID' },
        title: { type: 'string', description: '新标题（可选）' },
        description: { type: 'string', description: '新描述（可选）' },
        priority: { ...PRIORITY, description: '新优先级（可选）' },
        due_date: { type: 'string', description: '新截止日期 YYYY-MM-DD（可选）' },
        due_time: { type: 'string', description: '新截止时间 HH:MM（可选）' },
        reminder: { type: 'string', description: '新提醒时间 YYYY-MM-DDTHH:MM；省略保持不变' },
        clear_reminder: { type: 'boolean', description: '设为 true 清空提醒；不可与 reminder 同时提供' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签列表（可选）' },
        parent_id: { type: 'string', description: '新父待办项 ID；省略保持不变' },
        clear_parent: { type: 'boolean', description: '设为 true 移到顶层；不可与 parent_id 同时提供' },
        repeat: {
          type: 'object',
          additionalProperties: false,
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'] },
            interval: { type: 'integer', minimum: 1, maximum: 999 },
            byWeekday: {
              type: 'array',
              items: { type: 'integer', minimum: 0, maximum: 6 },
            },
          },
          required: ['freq'],
          description: '新重复规则；省略保持不变',
        },
        clear_repeat: { type: 'boolean', description: '设为 true 清空重复规则；不可与 repeat 同时提供' },
        expected_updated_at: {
          type: 'string', minLength: 1, description: 'list_items 返回的 updatedAt OCC 基线',
        },
      },
      required: ['item_id', 'expected_updated_at'],
      additionalProperties: false,
    }),
  ];
}
