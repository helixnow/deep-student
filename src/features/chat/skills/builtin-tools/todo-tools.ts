/**
 * TodoList 任务列表技能组
 *
 * 支持永续执行 Agent 的任务分解和管理
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const todoToolsSkill: SkillDefinition = {
  id: 'todo-tools',
  name: 'todo-tools',
  description: 'AI Agent 内部任务进度管理工具，用于将复杂任务分解为可执行的子步骤并跟踪执行进度。仅用于 AI 自己的任务分解、步骤跟踪，与用户的个人待办事项无关。❗ 当用户说“帮我添加待办”“我今天有什么任务”等个人待办相关请求时，请使用 user-todo-tools 而非本工具。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://todo-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# AI Agent 内部任务进度管理技能

> ⚠️ **重要区分**：本工具组是 AI 自己用于分解和跟踪任务执行步骤的内部工具，**不会**影响用户的个人待办列表。
> 如果用户要求管理他们的个人待办事项（如“帮我添加待办”“我今天有什么任务”），请加载 **user-todo-tools** 技能组。

当你需要执行多步骤任务时，使用这些工具来管理任务进度：

## 可用工具

- **builtin-todo_init**: 初始化任务列表，将复杂任务分解为可执行的子步骤
- **builtin-todo_update**: 更新步骤状态（running/completed/failed/skipped）
- **builtin-todo_add**: 动态添加新步骤
- **builtin-todo_get**: 获取当前任务进度

## 使用流程

1. 收到复杂任务时，用 todo_init 创建任务列表
2. 逐步执行，每完成一步用 todo_update 更新状态
3. 如需添加步骤，用 todo_add 动态插入
4. 用 todo_get 查看整体进度
`,
  embeddedTools: [
    {
      name: 'builtin-todo_init',
      description:
        '[AI内部工具] 初始化任务执行计划，把复杂任务分解为子步骤供 AI 自己跟踪进度；不写入用户待办列表。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务整体目标或标题' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: '步骤描述' },
              },
              required: ['description'],
            },
            description: '按执行顺序排列的步骤列表',
          },
        },
        required: ['title', 'steps'],
      },
    },
    {
      name: 'builtin-todo_update',
      description: '更新步骤状态，每完成一步调用一次。',
      inputSchema: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: '步骤 ID（如 step_1）' },
          status: {
            type: 'string',
            enum: ['running', 'completed', 'failed', 'skipped'],
            description: '新状态',
          },
          result: { type: 'string', description: '执行结果摘要（完成或失败时提供）' },
        },
        required: ['stepId', 'status'],
      },
    },
    {
      name: 'builtin-todo_add',
      description: '执行中发现需要额外步骤时动态添加。',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '新步骤描述' },
          afterStepId: { type: 'string', description: '在此步骤后插入；省略则追加到末尾' },
        },
        required: ['description'],
      },
    },
    {
      name: 'builtin-todo_get',
      description: '获取当前任务列表与各步骤状态。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
};
