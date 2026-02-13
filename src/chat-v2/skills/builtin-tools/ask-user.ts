/**
 * 用户提问技能组
 *
 * 在工具调用循环中向用户提出轻量级问题，不中断执行流程。
 * 支持 3 个固定选项 + 自定义输入 + 推荐选项 + 30s 超时自动选择。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const askUserSkill: SkillDefinition = {
  id: 'ask-user',
  name: '用户提问',
  description: '向用户提出轻量级问题以确认偏好或澄清需求，不中断工具调用循环。当需要了解用户偏好、确认方向或在多个等价方案中选择时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://ask-user',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 用户提问技能

当你在执行任务过程中需要确认用户偏好时，使用此工具进行轻量级提问。

## 可用工具

- **builtin-ask_user**: 向用户提出一个问题，提供 3 个选项供选择，同时支持自定义输入

## 使用场景

- 需要确认输出格式偏好（思维导图 / 表格 / 分点总结等）
- 需要确认范围或深度偏好（概要 / 详细 / 深入等）
- 需要在多个等价方案中选择
- 需要确认用户对某个方向的意见

## 使用规则

1. 每次提供恰好 3 个明确的选项
2. 必须指定一个推荐选项（recommended 索引 0-2）
3. 问题要简洁明确，选项要互斥且覆盖常见场景
4. 推荐选项应该是最合理的默认值，因为 30 秒无响应将自动采用推荐选项
5. 不要在一次对话中过度提问（建议不超过 2-3 次）
6. 仅在确实需要用户输入时才提问，避免不必要的打扰
`,
  embeddedTools: [
    {
      name: 'builtin-ask_user',
      description:
        '向用户提出一个轻量级问题，提供 3 个选项和自定义输入。用户可以选择一个选项或输入自定义回答。30 秒无响应将自动采用推荐选项，不会阻塞执行流程。',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '【必填】问题内容，简洁明确',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 3,
            maxItems: 3,
            description: '【必填】三个固定选项，互斥且覆盖常见场景',
          },
          recommended: {
            type: 'integer',
            minimum: 0,
            maximum: 2,
            description: '【必填】推荐选项的索引（0-2），超时后自动选择此选项',
          },
          context: {
            type: 'string',
            description: '为什么要问这个问题的简要上下文（可选）',
          },
        },
        required: ['question', 'options', 'recommended'],
      },
    },
  ],
};
