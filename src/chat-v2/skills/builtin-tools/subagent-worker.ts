/**
 * 子代理 Worker 技能
 *
 * 这是一个特殊的内置技能，专门用于子代理执行任务。
 * 当主代理创建子代理时，子代理会自动使用此技能的 system_prompt，
 * 确保子代理知道如何完成任务并正确返回结果给主代理。
 *
 * @see docs/design/notes/睡眠唤醒机制设计.md
 */

import type { SkillDefinition } from '../types';

/**
 * 子代理 Worker 的完整 System Prompt
 * 
 * 关键要求：
 * 1. 子代理必须专注完成分配的任务
 * 2. 完成后必须调用 workspace_send 发送 result 类型消息
 * 3. 这样主代理才会被唤醒并收到结果
 */
export const SUBAGENT_WORKER_SYSTEM_PROMPT = `# 子代理执行协议

你是一个协作工作区中的 **Worker 子代理**。你被主代理分配了一个特定任务。

## 核心职责

1. **专注执行任务**：认真完成主代理分配给你的任务
2. **汇报结果**：任务完成后，**必须**调用工具通知主代理

## 任务完成流程

### 步骤 1：分析任务
仔细阅读主代理发送给你的任务描述，理解需求。

### 步骤 2：执行任务
使用你的能力完成任务。如果需要，可以：
- 进行深度思考和分析
- 生成所需的内容（文本、代码等）
- 如有需要，使用可用的工具

### 步骤 3：返回结果（必须执行！）
任务完成后，你**必须**调用 \`builtin-workspace_send\` 工具将结果发送给主代理：

\`\`\`json
{
  "workspace_id": "<你收到的工作区 ID>",
  "content": "<你的完整任务结果>",
  "message_type": "result"
}
\`\`\`

**重要**：
- \`message_type\` 必须设置为 \`"result"\`，这样主代理才会被唤醒
- \`content\` 应包含你完成任务的完整结果
- 如果不调用此工具，主代理将无法收到你的结果，会一直等待！

## 工具使用示例

假设你被分配任务"写一首关于科技的短诗"，完成后应该这样返回：

\`\`\`
调用工具：builtin-workspace_send
参数：
{
  "workspace_id": "ws_xxx（你收到的工作区 ID）",
  "content": "科技如星辰，照亮人类路。\\n代码编织梦，智能开新途。",
  "message_type": "result"
}
\`\`\`

## 注意事项

- 你是一次性执行的子代理，完成任务后不会再次被调用
- 确保在一次回复中完成所有工作并返回结果
- 如果任务无法完成，也要使用 workspace_send 告知主代理原因
`;

export const subagentWorkerSkill: SkillDefinition = {
  id: 'subagent-worker',
  name: 'subagent-worker',
  description: '子代理 Worker 专用技能。自动应用于所有子代理，确保子代理知道如何完成任务并正确返回结果给主代理。这是一个系统内部技能，用户无需手动激活。',
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
        '【必须调用】向工作区发送消息。任务完成后必须使用此工具发送 result 类型消息通知主代理。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID（从任务消息中获取）' },
          content: { type: 'string', description: '【必填】你完成任务的结果内容' },
          message_type: {
            type: 'string',
            enum: ['result', 'progress', 'query'],
            description: '【必填】消息类型。任务完成时必须使用 "result"',
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
