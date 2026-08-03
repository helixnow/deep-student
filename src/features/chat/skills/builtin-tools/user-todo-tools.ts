/**
 * 用户待办管理技能组
 *
 * 允许 LLM 管理用户的个人待办事项（数据库存储）。
 * 与 todo-tools.ts（Agent 内部任务管理）不同，
 * 此技能组操作用户持久化的待办列表。
 */

import type { SkillDefinition } from '../types';

export const userTodoToolsSkill: SkillDefinition = {
  id: 'user-todo-tools',
  name: 'user-todo-tools',
  description: '用户个人待办事项管理能力组（持久化存储），用于创建、查找、更新、完成、删除与恢复待办项和清单。当用户提到"帮我添加待办""我今天有什么任务""建一个清单""提醒我..."等个人待办请求时使用。❗ 本工具操作用户的真实待办数据，与 AI 内部任务进度管理（todo-tools）无关。',
  version: '2.0.0',
  author: 'Deep Student',
  priority: 6,
  location: 'builtin',
  sourcePath: 'builtin://user-todo-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 用户个人待办事项管理技能

> ⚠️ **重要区分**：本工具组操作用户的真实待办列表（持久化存储在数据库中），与 AI 内部任务进度管理工具（todo-tools）完全不同。
> - 用户说“帮我添加待办”“我今天有什么任务” → 使用本工具组 (user-todo-tools)
> - AI 需要分解复杂任务、跟踪执行步骤 → 使用 todo-tools

管理用户的个人待办事项列表。待办事项持久化存储在数据库中。

## 可用工具

- **builtin-user_todo_list_lists**: 列出所有待办列表
- **builtin-user_todo_create_item**: 创建新待办项
- **builtin-user_todo_complete_item**: 完成待办项
- **builtin-user_todo_list_items**: 列出待办项（支持按视图筛选）
- **builtin-user_todo_get_summary**: 获取待办摘要（今日、逾期、统计）
- **builtin-user_todo_update_item**: 更新待办项属性
- **builtin-user_todo_delete_item**: 将待办项移入回收站（Medium，可恢复）
- **builtin-user_todo_create_list** / **builtin-user_todo_update_list**: 创建或编辑待办清单
- **builtin-user_todo_delete_list**: 将清单及其待办项移入回收站（High，必须先 ask_user）
- **builtin-user_todo_search**: 跨清单搜索待办项
- **builtin-user_todo_list_trash**: 分页查看待办项/清单回收站，为 restore 发现目标 ID
- **builtin-user_todo_restore**: 从回收站恢复待办项或清单
- **builtin-user_todo_reorder**: 保存某清单的待办项手动顺序

## 使用场景

- 用户说"帮我记一下..."、"添加待办..."时，用 user_todo_create_item
- 用户问"我今天有什么任务"时，用 user_todo_list_items (view=today)
- 用户说"XX完成了"时，用 user_todo_complete_item
- 需要了解用户待办全貌时，用 user_todo_get_summary
- 用户要求提醒时，create/update 传 \`reminder: YYYY-MM-DDTHH:MM\`
- 用户要求重复任务时，传 \`repeat: {freq, interval?, byWeekday?}\`；weekly 的 byWeekday 使用 0=周日到 6=周六
- LLM 拆解复杂任务时，先创建父任务，再给子任务传 \`parent_id\`；不再调用另一条 AI 拆解链路
- 更新前先 list_items 取得最新 \`updatedAt\`。省略 reminder/parent_id/repeat 表示保持不变；清空时分别传 \`clear_reminder\`、\`clear_parent\`、\`clear_repeat\`
- 用户说“把这任务拆开”时，由当前 LLM 自己拆成精简步骤，再循环调用 create_item 创建子任务。不要再调用 todo_ai_breakdown，避免双重 AI 拆解产生不一致结果
- list_lists、list_items、search 和 list_trash 都按页读取，每页最多 20 条；仅在确有需要时根据 has_more 继续下一页，不要无界拉取
- 删除单个待办项是 Medium 软删除，可用 restore 恢复。删除整个清单是 High：必须先 \`load_skills(["ask-user"])\`，再用 \`builtin-ask_user\` 列明清单及影响范围并取得明确确认；不得记住该授权
- 新增的清单写入、删除、恢复与重排工具只用于有用户在场的对话，不向 headless 自动化运行器暴露
`,
  allowedTools: [
    'builtin-user_todo_list_lists',
    'builtin-user_todo_create_item',
    'builtin-user_todo_complete_item',
    'builtin-user_todo_list_items',
    'builtin-user_todo_get_summary',
    'builtin-user_todo_update_item',
    'builtin-user_todo_delete_item',
    'builtin-user_todo_create_list',
    'builtin-user_todo_update_list',
    'builtin-user_todo_delete_list',
    'builtin-user_todo_search',
    'builtin-user_todo_list_trash',
    'builtin-user_todo_restore',
    'builtin-user_todo_reorder',
  ],
  embeddedTools: [
    {
      name: 'builtin-user_todo_list_lists',
      description: '[用户待办] 分页列出用户的个人待办清单（每页最多 20 条）。返回 lists、total、page、page_size、has_more 与 truncated；每个清单含 id、title、updatedAt 等信息。',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1, description: '页码，从 1 开始' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '每页数量，最大 20' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_create_item',
      description: '[用户待办] 在用户的个人待办列表中创建新的待办项（Medium，持久化写入）。如果不指定 list_id，将使用默认收件箱。支持提醒、重复规则和父子任务。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '【必填】待办项标题' },
          description: { type: 'string', description: '详细描述（可选）' },
          priority: {
            type: 'string',
            enum: ['none', 'low', 'medium', 'high', 'urgent'],
            description: '优先级，默认 none',
          },
          due_date: { type: 'string', description: '截止日期，格式 YYYY-MM-DD（可选）' },
          due_time: { type: 'string', description: '截止时间，格式 HH:MM（可选）' },
          reminder: { type: 'string', description: '提醒时间，格式 YYYY-MM-DDTHH:MM（可选）' },
          list_id: { type: 'string', description: '目标待办列表ID（可选，默认使用收件箱）' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签列表（可选）',
          },
          parent_id: { type: 'string', description: '父待办项 ID（可选，用于创建子任务）' },
          repeat: {
            type: 'object',
            additionalProperties: false,
            properties: {
              freq: {
                type: 'string',
                enum: ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'],
                description: '重复频率',
              },
              interval: { type: 'integer', minimum: 1, maximum: 999, default: 1 },
              byWeekday: {
                type: 'array',
                items: { type: 'integer', minimum: 0, maximum: 6 },
                description: '仅 weekly：0=周日，1=周一，...，6=周六',
              },
            },
            required: ['freq'],
            description: '重复规则（可选）',
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_complete_item',
      description: '[用户待办] 将待办项标记为已完成（Medium）。必须先 list_items 获取 updatedAt，并作为 expected_updated_at 传入。',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '【必填】待办项ID' },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】list_items 返回的 updatedAt OCC 基线',
          },
        },
        required: ['item_id', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_list_items',
      description: '[用户待办] 分页列出用户的待办项（每页最多 20 条）。每项返回 updatedAt，complete/update 必须原样传入该版本基线；返回 items、total、page、page_size、has_more 与 truncated。支持按列表 ID 或今日/逾期/即将到期视图筛选。',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'string', description: '待办列表ID（可选）' },
          view: {
            type: 'string',
            enum: ['all', 'today', 'overdue', 'upcoming', 'completed'],
            description: '视图过滤，默认 all',
          },
          include_completed: { type: 'boolean', description: '是否包含已完成项，默认 false' },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码，从 1 开始' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '每页数量，最大 20' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_get_summary',
      description: '[用户待办] 获取用户待办事项的总览摘要，包括今日待办、逾期项、统计数据等。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-user_todo_update_item',
      description: '[用户待办] 更新待办项属性（Medium）。必须先 list_items 获取 updatedAt，并作为 expected_updated_at 传入；冲突返回 TODO_CONFLICT、current 与 currentUpdatedAt，之后重新读取。',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '【必填】待办项ID' },
          title: { type: 'string', description: '新标题（可选）' },
          description: { type: 'string', description: '新描述（可选）' },
          priority: {
            type: 'string',
            enum: ['none', 'low', 'medium', 'high', 'urgent'],
            description: '新优先级（可选）',
          },
          due_date: { type: 'string', description: '新截止日期 YYYY-MM-DD（可选）' },
          due_time: { type: 'string', description: '新截止时间 HH:MM（可选）' },
          reminder: {
            type: 'string',
            description: '新提醒时间 YYYY-MM-DDTHH:MM；省略保持不变',
          },
          clear_reminder: {
            type: 'boolean',
            description: '设为 true 清空提醒；不可与 reminder 同时提供',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '新标签列表（可选）',
          },
          parent_id: {
            type: 'string',
            description: '新父待办项 ID；省略保持不变',
          },
          clear_parent: {
            type: 'boolean',
            description: '设为 true 移到顶层；不可与 parent_id 同时提供',
          },
          repeat: {
            type: 'object',
            additionalProperties: false,
            properties: {
              freq: {
                type: 'string',
                enum: ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'],
              },
              interval: { type: 'integer', minimum: 1, maximum: 999 },
              byWeekday: {
                type: 'array',
                items: { type: 'integer', minimum: 0, maximum: 6 },
              },
            },
            required: ['freq'],
            description: '新重复规则；省略保持不变',
          },
          clear_repeat: {
            type: 'boolean',
            description: '设为 true 清空重复规则；不可与 repeat 同时提供',
          },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】list_items 返回的 updatedAt OCC 基线',
          },
        },
        required: ['item_id', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_delete_item',
      description: '[用户待办] 将一个待办项软删除到回收站（Medium，可恢复）。必须先 list_items/search 取得 updatedAt 并传入 expected_updated_at；成功返回 success、itemId、listId、softDeleted 和 restoreWith。',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: {
            type: 'string',
            minLength: 1,
            description: '【必填】要移入回收站的待办项 ID',
          },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】list_items/search 返回的 updatedAt OCC 基线',
          },
        },
        required: ['item_id', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_create_list',
      description: '[用户待办] 创建一个持久化待办清单（Medium，仅前台对话）。成功返回 success 与 list（含 id、title、updatedAt）。',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: '【必填】清单标题',
          },
          description: { type: 'string', maxLength: 2000, description: '清单说明（可选）' },
          icon: { type: 'string', maxLength: 64, description: '图标名或单个 emoji（可选）' },
          color: { type: 'string', maxLength: 32, description: '颜色值（可选）' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_update_list',
      description: '[用户待办] 更新待办清单的标题、说明、图标或颜色（Medium，仅前台对话）。必须先 list_lists 取得 updatedAt 并传入 expected_updated_at；成功返回 success 与更新后的 list（含 updatedAt）。',
      inputSchema: {
        type: 'object',
        anyOf: [
          { required: ['title'] },
          { required: ['description'] },
          { required: ['icon'] },
          { required: ['color'] },
        ],
        properties: {
          list_id: { type: 'string', minLength: 1, description: '【必填】待办清单 ID' },
          title: { type: 'string', minLength: 1, maxLength: 200, description: '新标题（可选）' },
          description: { type: 'string', maxLength: 2000, description: '新说明（可选）' },
          icon: { type: 'string', maxLength: 64, description: '新图标（可选）' },
          color: { type: 'string', maxLength: 32, description: '新颜色（可选）' },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】list_lists 返回的 updatedAt OCC 基线',
          },
        },
        required: ['list_id', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_delete_list',
      description: '[用户待办] 将一个待办清单及其所有待办项软删除到回收站（High，可恢复）。必须传入 list_lists 返回的 expected_updated_at；每次调用前必须加载 ask-user 技能，用 builtin-ask_user 列明清单和影响范围并取得明确确认；不得记住授权。成功返回 success、listId、softDeleted 和 restoreWith。',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: {
            type: 'string',
            minLength: 1,
            description: '【必填】要移入回收站的非默认待办清单 ID',
          },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】list_lists 返回的 updatedAt OCC 基线',
          },
        },
        required: ['list_id', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_search',
      description: '[用户待办] 按关键词跨清单分页搜索未删除的待办项（Low，每页最多 20 条）。返回 success、items、total、page、page_size、has_more 和 truncated；每项含 updatedAt，可作为后续 update/complete/delete 的 OCC 基线。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: '【必填】搜索关键词',
          },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码，从 1 开始' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '每页数量，最大 20' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_restore',
      description: '[用户待办] 从回收站恢复一个软删除的待办项或待办清单（Medium）。恢复清单时会一并恢复其软删除的待办项。返回 success、entityType 与恢复后的 entity。',
      inputSchema: {
        type: 'object',
        properties: {
          entity_type: {
            type: 'string',
            enum: ['item', 'list'],
            description: '【必填】恢复目标类型',
          },
          entity_id: { type: 'string', minLength: 1, description: '【必填】回收站中的待办项或清单 ID' },
        },
        required: ['entity_type', 'entity_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_list_trash',
      description: '[用户待办] 分页列出待办回收站中的软删除项（Low），用于在 restore 前发现准确 ID。返回 success、items（每项含 entityType）、total、page、page_size、has_more 和 truncated；单页最多 20 项。',
      inputSchema: {
        type: 'object',
        properties: {
          entity_type: {
            type: 'string',
            enum: ['item', 'list'],
            description: '【必填】要查看的回收站实体类型',
          },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码，从 1 开始' },
          page_size: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: 20,
            description: '每页数量，默认且最大 20',
          },
        },
        required: ['entity_type'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-user_todo_reorder',
      description: '[用户待办] 按 item_ids 给定的完整顺序重排某个清单中的待办项（Medium）。必须传入 list_lists 返回的 expected_updated_at；返回 success、listId、reorderedCount、previous 与 restoreWith。',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'string', minLength: 1, description: '【必填】待办清单 ID' },
          item_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: { type: 'string', minLength: 1 },
            description: '【必填】按目标顺序排列的待办项 ID',
          },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】list_lists 返回的清单 updatedAt OCC 基线',
          },
        },
        required: ['list_id', 'item_ids', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
  ],
};
