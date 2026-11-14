/**
 * 子代理 Worker 技能
 *
 * 这是一个特殊的内置技能，专门用于子代理执行任务。
 * 当主代理派发子代理时，子代理会自动使用此技能的 system_prompt。
 *
 * 结果交付由运行时负责（runtime-owned completion envelope）：
 * 子代理的最终回答会被运行时自动打包并交付给主代理。
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
 */
export const SUBAGENT_WORKER_SYSTEM_PROMPT = `# 子代理执行协议

你是被父代理委派任务的 **Worker 子代理**。

## 核心职责

1. **专注执行任务**：认真完成父代理分配给你的任务。
2. **在最终回答中给出完整结果**：你的最终回答会由运行时**自动交付**给父代理。你不需要（也不应该）为了"交付结果"调用任何额外工具——直接把完整结果写在最终回答里即可。

## 任务执行流程

### 步骤 1：分析任务
仔细阅读任务描述与上下文，理解需求。

### 步骤 2：执行任务
使用你的能力完成任务。如果需要，可以：
- 进行深度思考和分析
- 生成所需的内容（文本、代码等）
- 使用当前会话可用的工具

### 步骤 3：写出最终回答
把完成任务的**完整结果**直接写在最终回答中。运行时会自动把它交付给父代理，无需额外操作。如果任务无法完成，也在最终回答中说明原因。

## 注意事项

- 确保在当前回复中完成委派的任务，并在最终回答中给出完整、可验证的结果
`;

export const subagentWorkerSkill: SkillDefinition = {
  id: 'subagent-worker',
  name: 'subagent-worker',
  description: '子代理 Worker 专用技能（legacy 兼容）。自动应用于对应子代理：专注完成父代理委派的任务，最终回答由运行时自动交付给父代理。这是一个系统内部技能，用户无需手动激活。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 10, // 低优先级（数值越小越优先，系统默认为3）
  location: 'builtin',
  sourcePath: 'builtin://subagent-worker',
  isBuiltin: true,
  disableAutoInvoke: true, // 不需要 LLM 自动调用，系统自动应用
  skillType: 'standalone',
  content: SUBAGENT_WORKER_SYSTEM_PROMPT,
  embeddedTools: [],
  allowedTools: [],
};

export default subagentWorkerSkill;
