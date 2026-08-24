/**
 * Style Lab / demo 组合意图配方 — 覆盖学习、研究、翻译、错题、空态、v1.1 grid。
 * 仅演示数据，不走生产 builder。
 */
import type { GenerativeUIIntent } from '../types';
import { ALL_BLOCKS_MINIMAL_PROPS, buildAllBlocksGridIntent } from './allBlocksFixture';
import { buildStyleLabHpiasResearchIntent } from './styleLabHpiasDemo';

export const INTENT_RECIPE_IDS = [
  'learning-dashboard',
  'research-briefing',
  'translation-chart',
  'mistake-table',
  'empty-markdown',
  'v11-grid-two-col',
] as const;

export type IntentRecipeId = (typeof INTENT_RECIPE_IDS)[number];

export interface IntentRecipe {
  id: IntentRecipeId;
  /** generativeUi namespace key, e.g. demo.recipes.learning_dashboard */
  i18nKey: `demo.recipes.${string}`;
  requiredTypes: readonly string[];
  intent: GenerativeUIIntent;
}

const LEARNING_DASHBOARD_RECIPE_INTENT: GenerativeUIIntent = {
  version: '1.1',
  layout: { mode: 'stack', columns: 1 },
  meta: {
    title: '本周复习节奏',
    description: '学习仪表盘：chart + table + steps',
  },
  blocks: [
    {
      type: 'chart',
      id: 'learning-review-chart',
      props: {
        title: '每日复习量',
        kind: 'bar',
        categories: ['周一', '周二', '周三', '周四', '周五'],
        series: [{ name: '张数', values: [4, 6, 3, 8, 5] }],
        unit: '张',
      },
    },
    {
      type: 'table',
      id: 'learning-weak-table',
      props: {
        title: '待巩固主题',
        columns: [
          { key: 'topic', label: '主题' },
          { key: 'due', label: '到期' },
          { key: 'rate', label: '正确率' },
        ],
        rows: [
          { topic: '特征值', due: 6, rate: '58%' },
          { topic: '贝叶斯', due: 3, rate: '71%' },
        ],
        caption: '按到期优先排序',
      },
    },
    {
      type: 'steps',
      id: 'learning-today-steps',
      props: {
        title: '今日计划',
        steps: [
          { label: '复习到期卡', status: 'done', durationLabel: '12 分' },
          { label: '错题回看', status: 'active', durationLabel: '20 分' },
          { label: '新卡预习', status: 'pending', durationLabel: '10 分' },
        ],
      },
    },
  ],
};

const TRANSLATION_CHART_RECIPE_INTENT: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '翻译会话吞吐',
    description: '翻译配方：chart 展示字数与段落节奏',
  },
  blocks: [
    {
      type: 'chart',
      id: 'translation-throughput',
      props: {
        title: '近 5 段字数',
        kind: 'line',
        categories: ['段 1', '段 2', '段 3', '段 4', '段 5'],
        series: [
          { name: '原文', values: [120, 86, 140, 98, 110] },
          { name: '译文', values: [132, 90, 151, 104, 118] },
        ],
        unit: '字',
      },
    },
  ],
};

const MISTAKE_TABLE_RECIPE_INTENT: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '薄弱项诊断',
    description: '错题配方：table + mistake-analysis',
  },
  blocks: [
    {
      type: 'table',
      id: 'mistake-topic-table',
      props: {
        title: '错题分布',
        columns: [
          { key: 'topic', label: '主题' },
          { key: 'count', label: '错题数' },
          { key: 'rate', label: '错误率' },
        ],
        rows: [
          { topic: '线性代数 · 特征值', count: 7, rate: '42%' },
          { topic: '概率论 · 贝叶斯', count: 3, rate: '28%' },
        ],
      },
    },
    {
      type: 'mistake-analysis',
      id: 'mistake-focus',
      props: {
        topic: '线性代数 · 特征值',
        errorRate: 42,
        mistakeCount: 7,
        suggestion: '先复习对角化条件，再做 10 道相似矩阵计算。',
        severity: 'high',
      },
    },
  ],
};

const EMPTY_MARKDOWN_RECIPE_INTENT: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '暂无数据',
    description: '空态配方：markdown 引导下一步',
  },
  blocks: [
    {
      type: 'markdown',
      id: 'empty-state',
      props: {
        title: '还没有学习记录',
        variant: 'compact',
        body: '完成一次复习或导入笔记后，这里会生成仪表盘。当前没有可展示的进度、错题或图表。',
      },
    },
  ],
};

const V11_GRID_TWO_COL_RECIPE_INTENT: GenerativeUIIntent = {
  version: '1.1',
  layout: { mode: 'grid', columns: 2 },
  meta: {
    title: 'v1.1 两列 Showcase',
    description: 'grid columns=2 + span 组合',
  },
  blocks: [
    {
      type: 'stat-card',
      id: 'grid-stat-due',
      props: { title: '到期', value: 12, trend: 'up', trendLabel: '较昨日 +3' },
    },
    {
      type: 'stat-card',
      id: 'grid-stat-done',
      props: { title: '已复习', value: 18, subtitle: '今日' },
    },
    {
      type: 'chart',
      id: 'grid-chart',
      span: 2,
      props: {
        ...ALL_BLOCKS_MINIMAL_PROPS.chart,
        title: '两列栅格中的复习量',
      },
    },
    {
      type: 'list',
      id: 'grid-list',
      props: {
        title: '下一步',
        items: [{ label: '错题回看', badge: '优先' }, { label: '导图补全' }],
      },
    },
    {
      type: 'progress',
      id: 'grid-progress',
      props: { title: '计划', current: 2, total: 5 },
    },
  ],
};

export const INTENT_RECIPES: readonly IntentRecipe[] = [
  {
    id: 'learning-dashboard',
    i18nKey: 'demo.recipes.learning_dashboard',
    requiredTypes: ['chart', 'table', 'steps'],
    intent: LEARNING_DASHBOARD_RECIPE_INTENT,
  },
  {
    id: 'research-briefing',
    i18nKey: 'demo.recipes.research_briefing',
    requiredTypes: ['markdown', 'research-plan'],
    intent: buildStyleLabHpiasResearchIntent(),
  },
  {
    id: 'translation-chart',
    i18nKey: 'demo.recipes.translation_chart',
    requiredTypes: ['chart'],
    intent: TRANSLATION_CHART_RECIPE_INTENT,
  },
  {
    id: 'mistake-table',
    i18nKey: 'demo.recipes.mistake_table',
    requiredTypes: ['table', 'mistake-analysis'],
    intent: MISTAKE_TABLE_RECIPE_INTENT,
  },
  {
    id: 'empty-markdown',
    i18nKey: 'demo.recipes.empty_markdown',
    requiredTypes: ['markdown'],
    intent: EMPTY_MARKDOWN_RECIPE_INTENT,
  },
  {
    id: 'v11-grid-two-col',
    i18nKey: 'demo.recipes.v11_grid_two_col',
    requiredTypes: ['stat-card', 'chart'],
    intent: V11_GRID_TWO_COL_RECIPE_INTENT,
  },
];

export function getIntentRecipe(id: string): IntentRecipe | undefined {
  return INTENT_RECIPES.find((recipe) => recipe.id === id);
}

export function listIntentRecipes(): readonly IntentRecipe[] {
  return INTENT_RECIPES;
}

/** Style Lab Showcase：18 块 v1.1 grid，与配方目录并列挂载 */
export function buildShowcaseAllBlocksRecipeIntent(): GenerativeUIIntent {
  return buildAllBlocksGridIntent();
}
