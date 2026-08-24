/**
 * Generative UI — 系统 Prompt 模板
 *
 * 约束模型只输出结构化 JSON，且仅使用注册表中的 type。
 */

import { generativeUIRegistry } from './registry';

export function buildGenerativeUISystemPrompt(options?: {
  domain?: 'saas' | 'learning' | 'creative';
  maxBlocks?: number;
}): string {
  const domain = options?.domain ?? 'learning';
  const maxBlocks = options?.maxBlocks ?? 12;
  const catalog = generativeUIRegistry.getCatalogForPrompt();

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
    `## 约束`,
    `- 最多 ${maxBlocks} 个 blocks`,
    `- 只能使用以下 type：${catalog.map((c) => c.type).join(', ')}`,
    `- 每个 type 的 props 必须符合 schema；不要发明新字段`,
    `- 高风险操作（删除、支付、发布）只能通过 action-bar 声明 action id，不得假设已执行`,
    `- ${domainGuidance}`,
    '',
    '## 可用组件',
    ...catalog.map(
      (c) => `- **${c.type}**: ${c.description} — props ${c.propsHint}`,
    ),
    '',
    '## 正负示例',
    '✅ 正确：blocks 数组内 stat-card + list 组合展示学习进度',
    '❌ 错误：输出 <div> 或 inline style 或任意 JavaScript',
  ].join('\n');
}

/** 学习场景示例意图（供 few-shot / 测试） */
export const LEARNING_DASHBOARD_EXAMPLE = {
  version: '1' as const,
  meta: {
    title: '本周学习概览',
    description: '基于你的笔记与练习数据',
  },
  blocks: [
    {
      type: 'stat-card',
      props: {
        title: '完成练习',
        value: 24,
        trend: 'up',
        trendLabel: '较上周 +6',
      },
    },
    {
      type: 'progress',
      props: {
        title: '复习计划',
        current: 18,
        total: 30,
        label: '18 张闪卡已复习',
      },
    },
    {
      type: 'list',
      props: {
        title: '待巩固知识点',
        items: [
          { label: '线性代数 · 特征值', badge: '高', description: '错题 3 道' },
          { label: '概率论 · 贝叶斯', badge: '中' },
        ],
      },
    },
    {
      type: 'action-bar',
      props: {
        actions: [
          { id: 'start-review', label: '开始复习', variant: 'primary', riskLevel: 'low' },
          { id: 'export-plan', label: '导出计划', variant: 'default', riskLevel: 'low' },
        ],
      },
    },
  ],
};
