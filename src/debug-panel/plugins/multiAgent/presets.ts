/**
 * 多 Agent 调试面板「调试」页的预设 Prompt。
 */

export interface PresetPrompt {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

// =============================================================================
// 预设调试 Prompt
// =============================================================================

export const PRESET_PROMPTS: PresetPrompt[] = [
  {
    id: 'create-workspace',
    name: '创建工作区',
    description: '创建一个新的多 Agent 工作区',
    prompt: '请创建一个工作区，用于协作完成任务。',
  },
  {
    id: 'create-research-agent',
    name: '创建研究 Agent',
    description: '创建一个负责调研的 Worker Agent',
    prompt: '请在当前工作区中创建一个研究员 Agent（skill_id: research），让它帮我调研"人工智能在教育领域的应用"这个主题。',
  },
  {
    id: 'create-writer-agent',
    name: '创建写作 Agent',
    description: '创建一个负责写作的 Worker Agent',
    prompt: '请在当前工作区中创建一个写作 Agent（skill_id: writer），让它根据调研结果撰写一篇文章。',
  },
  {
    id: 'full-workflow',
    name: '完整工作流测试',
    description: '创建工作区并启动完整的多 Agent 协作流程',
    prompt: `请帮我完成以下任务：
1. 创建一个名为"AI教育研究"的工作区
2. 创建一个研究员 Agent，让它调研"人工智能在教育领域的最新应用"
3. 等待研究完成后，创建一个写作 Agent 来整理研究结果
请开始执行。`,
  },
  {
    id: 'query-workspace',
    name: '查询工作区状态',
    description: '查询当前工作区的 Agent 和消息',
    prompt: '请查询当前工作区的状态，包括所有 Agent 和最近的消息。',
  },
];
