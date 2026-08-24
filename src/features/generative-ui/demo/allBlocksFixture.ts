/**
 * 18 种内置块最小合法 props — 用于 SOTA 运行时渲染验收
 */
import type { GenerativeUIIntent } from '../types';

export const ALL_BLOCKS_MINIMAL_PROPS: Record<string, Record<string, unknown>> = {
  'stat-card': { title: '指标', value: 42 },
  alert: { title: '提示', description: '说明' },
  list: { items: [{ label: '条目 A' }] },
  progress: { current: 2, total: 5, title: '进度' },
  'action-bar': {
    actions: [{ id: 'demo-action', label: '操作', variant: 'default', riskLevel: 'low' }],
  },
  text: { body: '正文内容' },
  'key-value-grid': { rows: [{ key: '键', value: '值' }] },
  'flashcard-preview': { front: '正面', back: '背面' },
  'review-calendar': { days: [{ date: '2026-08-24', dueCount: 3 }] },
  'mistake-analysis': { topic: '代数', errorRate: 35, suggestion: '加强练习' },
  'mindmap-embed': { versionId: 'mv_all_blocks_demo', title: '导图' },
  'paper-digest': { title: '论文标题', keyFindings: ['发现 A'] },
  'research-plan': {
    title: '研究计划',
    steps: [{ label: '检索', status: 'pending' }],
  },
  'research-report': { body: '报告正文 [paper-1]' },
  markdown: { title: '说明', body: '**Markdown** 正文' },
  chart: {
    title: '复习量',
    kind: 'bar',
    categories: ['周一', '周二'],
    series: [{ name: '张数', values: [3, 5] }],
  },
  steps: {
    title: '今日计划',
    steps: [{ label: '复习到期卡', status: 'active' }],
  },
  table: {
    title: '错题',
    columns: [{ key: 'topic', label: '主题' }, { key: 'rate', label: '错误率' }],
    rows: [{ topic: '代数', rate: '35%' }],
  },
};

export const ALL_BLOCK_TYPES = Object.keys(ALL_BLOCKS_MINIMAL_PROPS);

/** 单块意图 */
export function buildSingleBlockIntent(blockType: string): GenerativeUIIntent {
  const props = ALL_BLOCKS_MINIMAL_PROPS[blockType];
  if (!props) {
    throw new Error(`Unknown block type: ${blockType}`);
  }
  return {
    version: '1',
    meta: { title: `Block: ${blockType}` },
    blocks: [{ type: blockType, props }],
  };
}

/** 18 块合一意图（用于全量 smoke） */
export function buildAllBlocksIntent(): GenerativeUIIntent {
  return {
    version: '1',
    meta: { title: 'All 18 blocks' },
    blocks: ALL_BLOCK_TYPES.map((type) => ({
      type,
      props: ALL_BLOCKS_MINIMAL_PROPS[type]!,
    })),
  };
}

/** 宽块跨两列，避免 chart / table / report 挤在半列 */
const WIDE_SHOWCASE_TYPES = new Set([
  'chart',
  'table',
  'markdown',
  'research-report',
  'mindmap-embed',
  'steps',
]);

/** 18 块 v1.1 两列 grid Showcase（最小合法 props） */
export function buildAllBlocksGridIntent(): GenerativeUIIntent {
  return {
    version: '1.1',
    layout: { mode: 'grid', columns: 2 },
    meta: {
      title: '18 块 Showcase · v1.1 grid',
      description: '全部内置块最小合法 props，两列栅格',
    },
    blocks: ALL_BLOCK_TYPES.map((type) => ({
      type,
      id: `showcase-${type}`,
      span: WIDE_SHOWCASE_TYPES.has(type) ? 2 : 1,
      props: ALL_BLOCKS_MINIMAL_PROPS[type]!,
    })),
  };
}
