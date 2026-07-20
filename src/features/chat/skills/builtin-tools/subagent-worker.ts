/**
 * 子代理 Worker 技能
 *
 * 这是一个特殊的内置技能，专门用于子代理执行任务。
 * 当主代理派发子代理时，子代理会自动使用此技能的 system_prompt。
 *
 * 结果交付由运行时负责（runtime-owned completion envelope）：
 * 子代理的最终回答会被运行时自动打包并交付给主代理，
 * 不再要求模型调用 workspace_send 来"交付结果"。
 *
 * @see docs/dev/chat-v2-subagent-runtime.md
 */

import type { SkillDefinition } from '../types';

/**
 * 子代理 Worker 的完整 System Prompt
 *
 * 关键要求：
 * 1. 子代理专注完成分配的任务
 * 2. 最终回答由运行时自动交付给主代理（不需要调用工具来交付结果）
 * 3. workspace_send 仅用于中间进度汇报、提问或共享中间数据
 */
export const SUBAGENT_WORKER_SYSTEM_PROMPT = `# 子代理执行协议

你是被主代理委派任务的 **Worker 子代理**。

## 核心职责

1. **专注执行任务**：认真完成主代理分配给你的任务。
2. **在最终回答中给出完整结果**：你的最终回答会由运行时**自动交付**给主代理。你不需要（也不应该）为了"交付结果"调用任何工具——直接把完整结果写在最终回答里即可。

## 任务执行流程

### 步骤 1：分析任务
仔细阅读任务描述，理解需求。可以用 \`builtin-workspace_query\` / \`builtin-workspace_get_context\` 读取工作区共享信息（主代理可能预先放入了上下文数据）。

### 步骤 2：执行任务
使用你的能力完成任务。如果需要，可以：
- 进行深度思考和分析
- 生成所需的内容（文本、代码等）
- 使用可用的工具

### 步骤 3：写出最终回答
把完成任务的**完整结果**直接写在最终回答中。运行时会自动把它交付给主代理，无需额外操作。如果任务无法完成，也在最终回答中说明原因。

## 中间协作（可选）

\`builtin-workspace_send\` **仅**在以下场景使用，不用于交付最终结果：
- 汇报中间进度（message_type: "progress"）
- 向主代理提问（message_type: "query"）
- 共享中间数据供其他 Agent 使用

## 注意事项

- 你是一次性执行的子代理，完成任务后不会再次被调用
- 确保在一次回复中完成所有工作，并在最终回答中给出完整结果
`;

export const subagentWorkerSkill: SkillDefinition = {
  id: 'subagent-worker',
  name: 'subagent-worker',
  description: '子代理 Worker 专用技能。自动应用于所有子代理：专注完成主代理委派的任务，最终回答由运行时自动交付给主代理；workspace_send 仅用于中间进度汇报、提问或协作。这是一个系统内部技能，用户无需手动激活。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 10, // 低优先级（数值越小越优先，系统默认为3）
  location: 'builtin',
  sourcePath: 'builtin://subagent-worker',
  isBuiltin: true,
  disableAutoInvoke: true, // 不需要 LLM 自动调用，系统自动应用
  skillType: 'standalone',
  content: SUBAGENT_WORKER_SYSTEM_PROMPT,
  embeddedTools: [
    {
      name: 'builtin-workspace_send',
      description:
        '向工作区发送协作消息。仅用于汇报中间进度（progress）、向主代理提问（query）或共享中间数据；最终结果由运行时自动交付给主代理，不需要用此工具发送。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID（从任务消息中获取）' },
          content: { type: 'string', description: '【必填】消息内容文本' },
          message_type: {
            type: 'string',
            enum: ['result', 'progress', 'query'],
            description: '【必填】消息类型。中间进度用 "progress"，提问用 "query"',
          },
        },
        required: ['workspace_id', 'content', 'message_type'],
      },
    },
    {
      name: 'builtin-workspace_query',
      description: '查询工作区信息，包括共享上下文、文档等。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          query_type: {
            type: 'string',
            enum: ['agents', 'messages', 'documents', 'context', 'all'],
            description: '查询类型',
          },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'builtin-workspace_get_context',
      description: '从工作区读取一个共享上下文值。主代理可通过 workspace_set_context 预先存储数据，子代理用此工具读取。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          key: { type: 'string', description: '【必填】上下文键名' },
        },
        required: ['workspace_id', 'key'],
      },
    },
  ],
  allowedTools: [
    'builtin-workspace_send',
    'builtin-workspace_query',
    'builtin-workspace_get_context',
  ],
};

export default subagentWorkerSkill;
