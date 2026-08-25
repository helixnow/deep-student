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

- **builtin-render_generative_ui**: 提交结构化 UI 意图 JSON；前端按组件注册表渲染，副作用仅能通过 action-bar 声明的 action id 触发。可选 \`noteEdit\`（Notes HITL）与 \`researchSessionId\`（HPIAS 研究会话）。

## 输出格式

只输出一个 JSON 文档（可包在 \`\`\`json 围栏内）。**禁止 HTML / JSX / 可执行代码**，围栏外不要闲聊。

流式：先输出完整 JSON 结构（\`version\` / \`meta\` / \`blocks\` 骨架），再逐个闭合 block（先 type 再填完整 props）。

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

stat-card, alert, list, progress, action-bar, text, key-value-grid, flashcard-preview, review-calendar, mistake-analysis, mindmap-embed, paper-digest, research-plan, research-report, markdown, chart, steps, table

只能使用上述 registry type。禁止发明未注册 type。禁止 className、style、hex 色值。

type 必须属于 registry（含 markdown、chart、steps、table）；JSON Schema enum 为 type 白名单的 source of truth。

- markdown：长文说明、带标题的摘要（Markdown 语法，不要 HTML）
- chart：趋势/对比（bar/line/pie）；categories 与每条 series.values 长度必须一致
- steps：今日学习计划或通用流程（pending/active/done/error/skipped）
- table：对比表、错题表；必须提供 columns，rows 按 column key 填值

## 规则

1. 只能使用上述 type；props 必须符合各组件 schema，禁止发明字段。
2. 禁止输出 HTML、JSX、inline style 或可执行代码。
3. 删除/提交/导出/笔记写入等副作用只能通过 action-bar 的 action id 声明，且高风险必须带 riskLevel（high/medium）；不得假设已执行，不得用文案宣告「已删除」。
4. 最多 32 个 blocks（MAX_GENERATIVE_UI_BLOCKS）；超过 max blocks 会被拒绝。优先信息密度与可扫描性。
5. action-bar 的 action id 应使用已注册 id（如 start-review、open-qbank、export-plan、copy-report、copy-block、export-intent、apply-note-edit），label 仅作展示。
6. **Notes HITL**：若 intent 含 apply-note-edit（edit-apply）或 dismiss-note-suggestion（edit-reject），必须同时提供 noteEdit 参数（operation/content/search/replace）；禁止 isRegex。前端经 canvas:ai-edit-request HITL 链落盘，用户确认前禁止假设已写入。
7. **深度研究**：若 intent 含 research-plan / research-report / paper-digest，**必须**传 researchSessionId（顶层优先，也可写 intent.meta.researchSessionId）。无合法 session id 时不订阅 hpias_event，避免串台。前端经 hpias_event 实时更新研究面板，静态 Research 块在会话激活后由实时面板取代。
8. **闪卡**：flashcard-preview 仅用于展示；禁止添加保存 action。制卡、QA/critic 与入库统一交给 anki_cards 管线。

## Few-shot 场景（模仿组合，不要发明 type）

1. 学习仪表盘：stat-card + progress + action-bar
2. 错题诊断：mistake-analysis + list
3. 研究：research-plan + research-report + paper-digest（可附 researchSessionId）
4. Notes HITL：text + action-bar（edit-apply / edit-reject → apply-note-edit / dismiss-note-suggestion）
5. 学习数据：chart + table + action-bar
6. 今日计划：steps + markdown
7. 研究对照：paper-digest + table（可附 research-report / researchSessionId）
`,
  embeddedTools: [
    {
      name: 'builtin-render_generative_ui',
      description:
        '渲染结构化生成式 UI。传入 intent 对象（含 blocks 数组）；每个 block 含 type 与 props。适合学习简报、统计面板、复习日历等。禁止 HTML/JSX。高风险必须 action-bar + riskLevel。笔记写入走 HITL noteEdit；研究可传 researchSessionId。',
      inputSchema: {
        type: 'object',
        properties: {
          intent: {
            type: 'object',
            description: '【必填】Generative UI 意图文档，必须含 blocks 数组。',
            properties: {
              version: { type: 'string', enum: ['1', '1.1'] },
              layout: {
                type: 'object',
                description: 'v1.1 可选布局。stack 单列；grid 按 columns 分栏。',
                properties: {
                  mode: { type: 'string', enum: ['stack', 'grid'] },
                  columns: { type: 'integer', enum: [1, 2, 3] },
                },
                required: ['mode'],
                additionalProperties: false,
              },
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
                maxItems: 32,
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    props: { type: 'object' },
                    id: { type: 'string' },
                    span: { type: 'integer', enum: [1, 2, 3], description: 'grid 下列跨度' },
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
              '【可选】笔记编辑载荷；当 intent 含 apply-note-edit（edit-apply）时必填。经 HITL diff 面板落盘，禁止假设已写入。',
            properties: {
              operation: { type: 'string', enum: ['append', 'replace', 'set'] },
              content: { type: 'string' },
              search: { type: 'string', description: 'replace 使用的字面字符串；不支持正则表达式' },
              replace: { type: 'string' },
              section: { type: 'string' },
            },
            required: ['operation'],
            additionalProperties: false,
          },
          researchSessionId: {
            type: 'string',
            description:
              '【可选】HPIAS 研究会话 ID；与 research-plan/research-report 块联用时，前端订阅 hpias_event 实时渲染研究进度。也可写在 intent.meta.researchSessionId（顶层优先）。',
          },
        },
        required: ['intent'],
        additionalProperties: false,
      },
    },
  ],
};
