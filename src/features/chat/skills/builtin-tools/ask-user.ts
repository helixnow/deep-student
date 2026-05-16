/**
 * 用户提问技能组
 *
 * 在工具调用循环中向用户提出轻量级问题，不中断执行流程。
 * 支持 2-6 个选项 + 可选自定义输入 + 单选/多选 + 可选超时。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const askUserSkill: SkillDefinition = {
  id: 'ask-user',
  name: '用户提问',
  description: '向用户提出轻量级问题以确认偏好或澄清需求，不中断工具调用循环。当需要了解用户偏好、确认方向或在多个等价方案中选择时使用。',
  version: '1.2.0',
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

- **builtin-ask_user**: 向用户提出一个问题，提供 2-6 个选项供选择，支持单选/多选模式，可配置是否允许自由输入

## 使用场景

- 需要确认输出格式偏好（思维导图 / 表格 / 分点总结等）
- 需要确认范围或深度偏好（概要 / 详细 / 深入等）
- 需要在多个等价方案中选择
- 需要确认用户对某个方向的意见
- 需要用户同时选择多个适用项（使用 multiple: true）

## 使用规则

1. 提供 2-6 个明确的选项
2. **推荐选项必须放在 options 数组第一位（索引 0），并在标签末尾标注 "(Recommended)"**
3. 问题要简洁明确，选项要互斥（单选时）或可组合（多选时）且覆盖常见场景
4. 默认无超时，会无限等待用户回答。仅在非关键性问题上可设置 timeoutSeconds
5. 超时行为（仅当设置了 timeoutSeconds 时生效）：
   - 单选模式：自动选择第一个选项（即推荐选项）
   - 多选模式：自动提交已勾选的项；若无勾选则自动选择第一个选项
6. 不要在一次对话中过度提问（建议不超过 2-3 次）
7. 仅在确实需要用户输入时才提问，避免不必要的打扰
8. 当选项已经足够覆盖所有合理场景时，设置 allowCustom: false 隐藏自由输入框
`,
  embeddedTools: [
    {
      name: 'builtin-ask_user',
      description:
        '向用户提出一个轻量级问题，提供 2-6 个选项。支持单选/多选模式，可配置是否允许自由输入。推荐选项放在数组首位并标注 (Recommended)。永久等待用户回答，不会超时。',
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
            minItems: 2,
            maxItems: 6,
            description:
              '【必填】2-6 个选项。推荐选项必须放在第一位（索引 0），并在标签末尾标注 "(Recommended)"',
          },
          multiple: {
            type: 'boolean',
            default: false,
            description: '是否允许多选（默认 false，单选模式）',
          },
          allowCustom: {
            type: 'boolean',
            default: true,
            description: '是否允许用户自由输入（默认 true）',
          },

          context: {
            type: 'string',
            description: '为什么要问这个问题的简要上下文（可选）',
          },
        },
        required: ['question', 'options'],
      },
    },
  ],
};
