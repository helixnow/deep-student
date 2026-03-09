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
  description: '用户个人待办事项管理能力组（持久化存储），用于创建、查看、完成用户的个人待办事项。当用户提到"帮我添加待办""我今天有什么任务""提醒我..."等个人待办相关请求时使用。❗ 本工具操作用户的真实待办列表，与 AI 内部任务进度管理（todo-tools）无关。',
  version: '1.0.0',
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

## 使用场景

- 用户说"帮我记一下..."、"添加待办..."时，用 user_todo_create_item
- 用户问"我今天有什么任务"时，用 user_todo_list_items (view=today)
- 用户说"XX完成了"时，用 user_todo_complete_item
- 需要了解用户待办全貌时，用 user_todo_get_summary
`,
  embeddedTools: [
    {
      name: 'builtin-user_todo_list_lists',
      description: '[用户待办] 列出用户的所有个人待办列表。返回列表的ID、标题等信息。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-user_todo_create_item',
      description: '[用户待办] 在用户的个人待办列表中创建新的待办项（持久化存储）。如果不指定 list_id，将使用默认收件箱。支持设置优先级和截止日期。',
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
          list_id: { type: 'string', description: '目标待办列表ID（可选，默认使用收件箱）' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签列表（可选）',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'builtin-user_todo_complete_item',
      description: '[用户待办] 将用户的待办项标记为已完成。',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '【必填】待办项ID' },
        },
        required: ['item_id'],
      },
    },
    {
      name: 'builtin-user_todo_list_items',
      description: '[用户待办] 列出用户的待办项。支持按列表ID筛选，也可查看今日、逾期、即将到期等视图。',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'string', description: '待办列表ID（可选）' },
          view: {
            type: 'string',
            enum: ['all', 'today', 'overdue', 'upcoming'],
            description: '视图过滤，默认 all',
          },
          include_completed: { type: 'boolean', description: '是否包含已完成项，默认 false' },
        },
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
      description: '[用户待办] 更新用户待办项的属性（标题、描述、优先级、截止日期等）。',
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
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '新标签列表（可选）',
          },
        },
        required: ['item_id'],
      },
    },
  ],
};
