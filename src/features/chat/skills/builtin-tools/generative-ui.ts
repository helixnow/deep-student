/**
 * 生成式 UI 技能组
 *
 * 通过 render_generative_ui 工具输出结构化 UI 意图，由前端 GenerativeUIRenderer 渲染。
 */

import type { SkillDefinition } from '../types';

export const generativeUiSkill: SkillDefinition = {
  id: 'generative-ui',
  name: 'generative-ui',
  description:
    '结构化生成式 UI。用于学习简报、进度仪表盘、闪卡预览、复习日历、错题分析等可扫描界面，禁止输出 HTML/JS。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://generative-ui',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'composite',
  allowedTools: ['builtin-render_generative_ui'],
  content: `# 生成式 UI 技能

当用户需要**可视化学习摘要、进度面板、统计卡片、操作按钮栏**（而非纯 Markdown  prose）时，调用 \`builtin-render_generative_ui\`。

## 工具

- **builtin-render_generative_ui**: 提交结构化 UI 意图 JSON；前端按组件注册表渲染，副作用仅能通过 action-bar 声明的 action id 触发。

## 输出格式

\`\`\`json
{
  "version": "1",
  "meta": { "title": "可选标题", "description": "可选说明" },
  "blocks": [
    { "type": "stat-card", "props": { "title": "到期闪卡", "value": 5 } }
  ]
}
\`\`\`

## 可用 block type

stat-card, alert, list, progress, action-bar, text, key-value-grid, flashcard-preview, review-calendar, mistake-analysis, mindmap-embed, paper-digest, research-plan, research-report

## 规则

1. 只能使用上述 type；props 必须符合各组件 schema，禁止发明字段。
2. 禁止输出 HTML、JSX、inline style 或可执行代码。
3. 删除/提交/导出等副作用只能通过 action-bar 的 action id 声明；不得假设已执行。
4. 最多 12 个 blocks；优先信息密度与可扫描性。
5. action-bar 的 action id 应使用已注册 id（如 start-review、open-qbank、export-plan、apply-note-edit、save-to-library），label 仅作展示。
6. **笔记写入**：若 intent 含 apply-note-edit，必须同时提供 noteEdit 参数（operation/content/search/replace）；前端经 canvas:ai-edit-request HITL 链落盘，禁止假设已写入。
`,
  embeddedTools: [
    {
      name: 'builtin-render_generative_ui',
      description:
        '渲染结构化生成式 UI。传入 intent 对象（含 blocks 数组）；每个 block 含 type 与 props。适合学习简报、统计面板、复习日历等。',
      inputSchema: {
        type: 'object',
        properties: {
          intent: {
            type: 'object',
            description: '【必填】Generative UI 意图文档，必须含 blocks 数组。',
            properties: {
              version: { type: 'string', enum: ['1'] },
              meta: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                },
                additionalProperties: false,
              },
              blocks: {
                type: 'array',
                minItems: 1,
                maxItems: 12,
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    props: { type: 'object' },
                    id: { type: 'string' },
                  },
                  required: ['type'],
                  additionalProperties: false,
                },
              },
            },
            required: ['blocks'],
            additionalProperties: true,
          },
          noteEdit: {
            type: 'object',
            description:
              '【可选】笔记编辑载荷；当 intent 含 apply-note-edit 时必填。经 HITL diff 面板落盘。',
            properties: {
              operation: { type: 'string', enum: ['append', 'replace', 'set'] },
              content: { type: 'string' },
              search: { type: 'string' },
              replace: { type: 'string' },
              isRegex: { type: 'boolean' },
              section: { type: 'string' },
            },
            required: ['operation'],
            additionalProperties: false,
          },
        },
        required: ['intent'],
        additionalProperties: false,
      },
    },
  ],
};
