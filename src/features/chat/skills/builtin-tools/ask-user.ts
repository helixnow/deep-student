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

1. 常规提问提供 2-6 个明确的选项；若使用 ui（openui-lang 生成式决策面板）或 html（内联交互画板），options 可省略或传空数组
2. **推荐选项必须放在 options 数组第一位（索引 0），并在标签末尾标注 "(Recommended)"**
3. 问题要简洁明确，选项要互斥（单选时）或可组合（多选时）且覆盖常见场景
4. 默认无超时，会无限等待用户回答；当前实现不会根据 timeoutSeconds 自动替用户作答
5. 不要在一次对话中过度提问（建议不超过 2-3 次）
6. 仅在确实需要用户输入时才提问，避免不必要的打扰
7. 当选项已经足够覆盖所有合理场景时，设置 allowCustom: false 隐藏自由输入框
8. 如需解释每个选项背后的原因，可把 options 写成对象数组并附带 reason 字段；前端会在 hover 时显示该说明
9. 当需要多字段配置、滑块/日期/多选组合或可视化对比拍板时，优先传入 ui（openui-lang DSL，含 Choice / Input / DateInput / Slider / Button）或 html（内联沙盒画板，按钮调用 window.dstu.submit(data, summary) 或 window.openchamber.submit(data, summary) 回传结构化决策）
`,
  embeddedTools: [
    {
      name: 'builtin-ask_user',
      description:
        '向用户提出一个轻量级选择题（2-6 个选项，单选/多选，可自由输入），或通过 ui (openui-lang) / html (内联交互画板) 发起可视化拍板决策。永久等待回答，不超时。',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '问题内容，简洁明确',
          },
          title: {
            type: 'string',
            description: '画板或生成式决策面板的可选标题',
          },
          options: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: '用户可见的选项文本',
                    },
                    reason: {
                      type: 'string',
                      description: '提供此选项的原因；前端 hover 展示',
                    },
                  },
                  required: ['label'],
                },
              ],
            },
            minItems: 0,
            maxItems: 6,
            description:
              '选项数组：字符串或 { label, reason? } 对象。推荐选项放第一位并在标签末尾标注 "(Recommended)"。当提供 html 或 ui 时可省略。',
          },
          ui: {
            type: 'string',
            description:
              'openui-lang 生成式 UI 程序代码（支持 Stack/Row/Card/Choice/Input/DateInput/Slider/Button 等组件），点击 Button 时自动提交表单值与备注',
          },
          html: {
            type: 'string',
            description:
              '内联自包含交互式 HTML/SVG 画板文档，内部按钮调用 window.dstu.submit(data, summary) 或 window.openchamber.submit(data, summary) 提交用户决策',
          },
          multiple: {
            type: 'boolean',
            default: false,
            description: '是否允许多选',
          },
          allowCustom: {
            type: 'boolean',
            default: true,
            description: '是否允许自由输入',
          },

          context: {
            type: 'string',
            description: '提问原因的简要上下文',
          },
        },
        required: ['question'],
      },
    },
  ],
};
