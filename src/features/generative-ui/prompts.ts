/**
 * Generative UI — 系统 Prompt 模板
 *
 * 约束模型只输出结构化 JSON，且仅使用注册表中的 type。
 * few-shot / 负例见 prompts/fewShotExamples.ts。
 */

import { generativeUIRegistry } from './registry';
import {
  GENERATIVE_UI_FEW_SHOT_EXAMPLES,
  GENERATIVE_UI_FEW_SHOT_LABELS,
  GENERATIVE_UI_NEGATIVE_EXAMPLES,
} from './prompts/fewShotExamples';
import { MAX_GENERATIVE_UI_BLOCKS } from './schema';
import { exportGenerativeUIJsonSchema } from './utils/exportGenerativeUIJsonSchema';

export {
  GENERATIVE_UI_FEW_SHOT_EXAMPLES,
  GENERATIVE_UI_FEW_SHOT_LABELS,
  GENERATIVE_UI_NEGATIVE_EXAMPLE_KEYWORDS,
  GENERATIVE_UI_NEGATIVE_EXAMPLES,
  LEARNING_ANALYTICS_EXAMPLE,
  LEARNING_DASHBOARD_EXAMPLE,
  MISTAKE_DIAGNOSIS_EXAMPLE,
  NOTES_HITL_EXAMPLE,
  RESEARCH_BRIEFING_EXAMPLE,
  RESEARCH_COMPARISON_EXAMPLE,
  STUDY_PLAN_EXAMPLE,
} from './prompts/fewShotExamples';

function formatFewShotSection(): string {
  return GENERATIVE_UI_FEW_SHOT_EXAMPLES.map((example, index) => {
    const label = GENERATIVE_UI_FEW_SHOT_LABELS[index] ?? `示例 ${index + 1}`;
    return [`### 正例 ${index + 1} — ${label}`, '```json', JSON.stringify(example, null, 2), '```'].join(
      '\n',
    );
  }).join('\n\n');
}

function formatNegativeSection(): string {
  return GENERATIVE_UI_NEGATIVE_EXAMPLES.map((ex, index) => {
    return `${index + 1}. **${ex.title}**：❌ ${ex.bad} — ${ex.reason}`;
  }).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

/** 从 JSON Schema 取出已注册 type enum（扩展字段优先，其次 items.type.enum）。 */
function extractRegisteredBlockTypes(schema: Record<string, unknown>): string[] {
  const types = new Set<string>();
  for (const value of stringArray(schema['x-registered-block-types']) ?? []) {
    types.add(value);
  }
  const typeNode = asRecord(
    asRecord(asRecord(asRecord(asRecord(schema.properties)?.blocks)?.items)?.properties)?.type,
  );
  for (const value of stringArray(typeNode?.enum) ?? []) {
    types.add(value);
  }
  return [...types].sort();
}

function extractBlocksMaxItems(schema: Record<string, unknown>): number {
  const maxItems = asRecord(asRecord(schema.properties)?.blocks)?.maxItems;
  return typeof maxItems === 'number' ? maxItems : 32;
}

export function buildGenerativeUISystemPrompt(options?: {
  domain?: 'saas' | 'learning' | 'creative';
  maxBlocks?: number;
}): string {
  const domain = options?.domain ?? 'learning';
  const maxBlocks = Math.min(
    options?.maxBlocks ?? MAX_GENERATIVE_UI_BLOCKS,
    MAX_GENERATIVE_UI_BLOCKS,
  );
  const catalog = generativeUIRegistry.getCatalogForPrompt();
  const catalogTypes = catalog.map((c) => c.type).join(', ');
  const schema = exportGenerativeUIJsonSchema();
  const registeredTypes = extractRegisteredBlockTypes(schema).join(', ');
  const schemaMaxBlocks = extractBlocksMaxItems(schema);

  const domainGuidance =
    domain === 'saas'
      ? '偏信息密度与可扫描性；避免营销式大 Hero；优先 stat-card、key-value-grid、list。'
      : domain === 'learning'
        ? 'DeepStudent 学习工作台：复习进度、错题、闪卡、笔记摘要；禁止直接执行删除/提交。'
        : '可更活泼，但仍只能使用注册表组件。';

  return [
    '你是 DeepStudent 生成式 UI 编排器。你只能输出 JSON，不得输出 HTML、JSX 或可执行代码。',
    '',
    '## 输出格式',
    '```json',
    '{',
    '  "version": "1",',
    '  "meta": { "title": "可选标题", "description": "可选说明" },',
    '  "blocks": [',
    '    { "type": "<组件type>", "props": { ... }, "id": "可选" }',
    '  ]',
    '}',
    '```',
    '',
    '## 流式约束',
    '- 只输出一个 JSON 文档（可包在 ```json 围栏内）。不要 markdown 围栏外的闲聊、解释或前后缀。',
    '- 先输出完整 JSON 结构：先写 `version` / `meta` / `blocks` 数组骨架，再逐个输出**已闭合**的 block（先 `type`，再填完整 `props`）。',
    '- 不要先吐半截 props 再回头补字段；增量解析器只提交已闭合的 block 对象。',
    '- 流式过程中不要插入 HTML/JSX 注释或自然语言进度播报。',
    '',
    `## 约束`,
    `- 最多 ${maxBlocks} 个 blocks；超过 max blocks 会被拒绝。`,
    `- 只能使用以下 type（catalog 动态来自 registry）：${catalogTypes}`,
    `- 每个 type 的 props 必须符合 schema；不要发明新字段，不要传 className / style / hex 色值`,
    `- 高风险操作（删除、支付、发布、笔记写入、覆盖文件）必须使用 action-bar，且对应 action 必须带 riskLevel（high 或 medium），不得假设已执行`,
    `- 禁止用 text/alert 宣告「已删除」「已支付」「已提交」来绕过 action-bar`,
    `- ${domainGuidance}`,
    '',
    '## HITL / 研究桥接',
    '- Notes 写入：action-bar 使用 apply-note-edit（edit-apply）与 dismiss-note-suggestion（edit-reject）；同时提供 noteEdit（operation/content/search/replace）。前端经 canvas:ai-edit-request HITL，用户确认前禁止假设已写入。',
    '- 深度研究：research-plan / research-report / paper-digest 可附带 researchSessionId 绑定 HPIAS；前端经 hpias_event 更新研究面板。',
    '',
    '## 可用组件',
    ...catalog.map(
      (c) => `- **${c.type}**: ${c.description} — props ${c.propsHint}`,
    ),
    '',
    '## JSON Schema 类型约束',
    '- 意图 version 只能是 1 或 1.1',
    `- blocks 最多 ${schemaMaxBlocks}`,
    `- type 只能是：${registeredTypes}`,
    '- 禁止 className / style / 裸 hex / fontSize',
    '',
    '## Few-shot 正例',
    '以下均为合法 GenerativeUIIntent。模仿结构，不要发明 type。',
    '',
    formatFewShotSection(),
    '',
    '## 负例（禁止）',
    formatNegativeSection(),
    '',
    '## 正负对照（短）',
    '✅ 正确：blocks 数组内 stat-card + progress + action-bar 组合展示学习进度',
    '❌ 错误：输出 <div> 或 inline style 或任意 JavaScript',
  ].join('\n');
}
