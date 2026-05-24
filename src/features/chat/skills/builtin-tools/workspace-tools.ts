/**
 * 工作区协作技能组
 *
 * 支持多 Agent 协作的工作区管理
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const workspaceToolsSkill: SkillDefinition = {
  id: 'workspace-tools',
  name: 'workspace-tools',
  description: '工作区协作能力组，支持创建多 Agent 协作工作区、分配任务、共享上下文和文档。当用户需要多个 Agent 协作完成复杂任务时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://workspace-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 工作区协作技能

当你需要协调多个 Agent 完成复杂任务时，使用这些工具：

## ⚠️ 重要：创建子代理后必须调用 sleep

创建 Worker Agent（使用 builtin-workspace_create_agent 并提供 initial_task）后，你**必须立即调用 builtin-coordinator_sleep 工具**进入睡眠状态等待结果。

**正确流程**:
1. 调用 builtin-workspace_create 创建工作区
2. 调用 builtin-workspace_create_agent 创建 Worker（带 initial_task）
3. **立即调用 builtin-coordinator_sleep** 等待 Worker 完成

## 工具选择指南

### 工作区管理
- **builtin-workspace_create**: 创建新工作区
- **builtin-workspace_create_agent**: 在工作区中创建 Agent
- **builtin-workspace_query**: 查询工作区信息

### 等待子代理
- **builtin-coordinator_sleep**: 【必需】创建 Worker 后调用，等待结果

### 消息通信
- **builtin-workspace_send**: 向 Agent 发送消息

### 共享资源
- **builtin-workspace_set_context**: 设置共享上下文
- **builtin-workspace_get_context**: 获取共享上下文
- **builtin-workspace_update_document**: 创建/更新文档
- **builtin-workspace_read_document**: 读取文档
`,
  embeddedTools: [
    {
      name: 'builtin-workspace_create',
      description:
        '创建一个新的多 Agent 协作工作区。当用户需要多个 Agent 协作完成复杂任务时使用。工作区创建后，可以在其中注册多个 Worker Agent 分工协作。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工作区名称（可选，不指定则自动生成）' },
        },
      },
    },
    {
      name: 'builtin-workspace_create_agent',
      description:
        '在工作区中创建一个新的 Agent。必须先创建工作区（workspace_create）。【重要】如果希望 Worker 自动执行任务，必须提供 initial_task 参数，否则 Worker 会保持空闲状态不会处理后续消息。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          role: {
            type: 'string',
            enum: ['coordinator', 'worker'],
            description: 'Agent 角色：worker（执行者，默认）',
          },
          skill_id: { type: 'string', description: '技能 ID，指定 Worker 使用的预置技能（可选）' },
          initial_task: { type: 'string', description: '【推荐】初始任务描述。提供此参数后 Worker 会立即自动启动执行任务并返回结果，不提供则 Worker 保持空闲' },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'builtin-workspace_send',
      description:
        '向工作区中的 Agent 发送消息。必须已创建工作区并存在目标 Agent。注意：消息内容使用 content 参数（不是 message）。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          content: { type: 'string', description: '【必填】消息内容文本，注意参数名是 content 不是 message' },
          target_session_id: { type: 'string', description: '目标 Agent 的会话 ID（可选，不指定则广播给所有 Agent）' },
          message_type: {
            type: 'string',
            enum: ['task', 'progress', 'result', 'query', 'correction', 'broadcast'],
            description: '消息类型（可选，默认 task）',
          },
        },
        required: ['workspace_id', 'content'],
      },
    },
    {
      name: 'builtin-workspace_query',
      description: '查询工作区信息，包括 Agent 列表、消息记录、文档等。必须已创建工作区。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          query_type: {
            type: 'string',
            enum: ['agents', 'messages', 'documents', 'context', 'all'],
            description: '查询类型',
          },
          limit: { type: 'integer', description: '返回结果数量限制，默认 50', default: 50, minimum: 1, maximum: 200 },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'builtin-workspace_set_context',
      description:
        '设置工作区共享上下文变量。必须已创建工作区。所有 Agent 都可以读取和修改共享上下文，用于协作时共享状态。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          key: { type: 'string', description: '【必填】上下文键名' },
          value: { description: '【必填】上下文值（任意 JSON 值）' },
        },
        required: ['workspace_id', 'key', 'value'],
      },
    },
    {
      name: 'builtin-workspace_get_context',
      description: '获取工作区共享上下文变量。必须已创建工作区。注意：必须同时提供 workspace_id 和 key 两个参数。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          key: { type: 'string', description: '【必填】上下文键名，如 "messages"、"state" 等' },
        },
        required: ['workspace_id', 'key'],
      },
    },
    {
      name: 'builtin-workspace_update_document',
      description:
        '在工作区中创建或更新文档。必须已创建工作区。文档可以是计划、研究笔记、产出物等，所有 Agent 都可以访问。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          title: { type: 'string', description: '【必填】文档标题' },
          content: { type: 'string', description: '【必填】文档内容' },
          doc_type: {
            type: 'string',
            enum: ['plan', 'research', 'artifact', 'notes'],
            description: '文档类型',
          },
        },
        required: ['workspace_id', 'title', 'content'],
      },
    },
    {
      name: 'builtin-workspace_read_document',
      description: '读取工作区中的文档。必须已创建工作区且文档存在。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          document_id: { type: 'string', description: '【必填】文档 ID' },
        },
        required: ['workspace_id', 'document_id'],
      },
    },
    {
      name: 'builtin-coordinator_sleep',
      description:
        '【重要】创建子代理后调用此工具进入睡眠状态。睡眠期间 pipeline 挂起，等待子代理发送结果消息后自动唤醒继续执行。这避免了轮询浪费，是推荐的多代理协作模式。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          awaiting_agents: {
            type: 'array',
            items: { type: 'string' },
            description: '等待的子代理 session_id 列表（可选，不指定则等待所有子代理）',
          },
          wake_condition: {
            type: 'string',
            enum: ['any_message', 'result_message', 'all_completed'],
            description: '唤醒条件：result_message=收到结果消息（默认），any_message=任意消息，all_completed=全部完成',
          },
          timeout_ms: {
            type: 'integer',
            description: '超时时间（毫秒），超时后自动唤醒。可选，默认无超时',
          },
        },
        required: ['workspace_id'],
      },
    },
  ],
};
