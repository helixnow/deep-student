/**
 * Generative UI — few-shot 正例 + 负例关键字
 *
 * 覆盖当前 registry 的 18 个 type（含 markdown / chart / steps / table）。
 * 每套正例必须能通过 parseGenerativeUIIntent + validateBlockProps。
 */

import type { GenerativeUIIntent } from '../types';

/** 学习仪表盘：stat-card + progress + action-bar */
export const LEARNING_DASHBOARD_EXAMPLE: GenerativeUIIntent = {
  version: '1',
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

/** 错题诊断：mistake-analysis + list */
export const MISTAKE_DIAGNOSIS_EXAMPLE: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '错题诊断',
    description: '近一周题库薄弱项，仅展示诊断不直接改成绩',
  },
  blocks: [
    {
      type: 'mistake-analysis',
      props: {
        topic: '线性代数 · 特征值',
        errorRate: 42,
        mistakeCount: 7,
        suggestion: '先复习对角化条件，再做 10 道相似矩阵计算。',
        severity: 'high',
      },
    },
    {
      type: 'list',
      props: {
        title: '推荐练习',
        items: [
          { label: '特征值计算', badge: '优先', description: '错 4 道' },
          { label: '对角化判定', badge: '次优先', description: '错 3 道' },
        ],
      },
    },
    {
      type: 'action-bar',
      props: {
        actions: [
          { id: 'open-qbank', label: '打开题库', variant: 'primary', riskLevel: 'low' },
          { id: 'start-review', label: '针对复习', variant: 'default', riskLevel: 'low' },
        ],
      },
    },
  ],
};

/** 研究：research-plan + research-report + paper-digest */
export const RESEARCH_BRIEFING_EXAMPLE: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '注意力机制综述',
    description: '可附带 researchSessionId 绑定 HPIAS 会话',
  },
  blocks: [
    {
      type: 'research-plan',
      props: {
        title: '文献调研计划',
        round: 1,
        steps: [
          { label: '检索核心论文', status: 'done' },
          { label: '筛选高引文献', status: 'active' },
          { label: '综合写作', status: 'pending' },
        ],
      },
    },
    {
      type: 'paper-digest',
      props: {
        title: 'Attention Is All You Need',
        authors: 'Vaswani et al.',
        venue: 'NeurIPS',
        year: 2017,
        citationLabel: '高引',
        citationCount: 120000,
        keyFindings: ['自注意力可替代循环结构', '多头注意力捕获不同子空间'],
        abstractExcerpt: '提出 Transformer，完全基于注意力机制完成序列建模。',
      },
    },
    {
      type: 'research-report',
      props: {
        title: '阶段报告',
        body: 'Transformer 将序列建模从循环结构转向自注意力 [paper-1]。后续工作在位置编码与效率上扩展 [paper-2]。',
      },
    },
    {
      type: 'action-bar',
      props: {
        actions: [
          { id: 'copy-report', label: '复制报告', variant: 'default', riskLevel: 'low' },
          { id: 'export-plan', label: '导出计划', variant: 'default', riskLevel: 'medium' },
          { id: 'export-intent', label: '导出全部意图', variant: 'default', riskLevel: 'low' },
          { id: 'copy-block', label: '复制该组件', variant: 'default', riskLevel: 'low' },
        ],
      },
    },
  ],
};

/** Notes HITL：text + action-bar（edit-apply / edit-reject） */
export const NOTES_HITL_EXAMPLE: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '笔记编辑建议',
    description: 'HITL：edit-apply / edit-reject，用户确认前不得假设已写入',
  },
  blocks: [
    {
      type: 'text',
      props: {
        heading: '建议追加段落',
        body: '特征值是满足 Av = λv 的标量 λ。建议在本节末补充一道计算例题，并标明对角化前提。',
        density: 'normal',
      },
    },
    {
      type: 'action-bar',
      props: {
        actions: [
          {
            id: 'apply-note-edit',
            label: '应用编辑',
            variant: 'primary',
            riskLevel: 'high',
          },
          {
            id: 'dismiss-note-suggestion',
            label: '拒绝建议',
            variant: 'default',
            riskLevel: 'low',
          },
        ],
      },
    },
  ],
};

/** 学习数据：chart + table + action-bar */
export const LEARNING_ANALYTICS_EXAMPLE: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '复习数据对照',
    description: '本周复习量趋势与知识点错误率',
  },
  blocks: [
    {
      type: 'chart',
      props: {
        title: '本周复习量',
        kind: 'bar',
        categories: ['周一', '周二', '周三', '周四', '周五'],
        series: [
          { name: '已复习', values: [8, 12, 9, 15, 11] },
          { name: '到期', values: [10, 10, 12, 14, 13] },
        ],
        unit: '张',
      },
    },
    {
      type: 'table',
      props: {
        title: '知识点错误率',
        columns: [
          { key: 'topic', label: '主题' },
          { key: 'rate', label: '错误率', align: 'right' },
          { key: 'count', label: '错题数', align: 'right' },
        ],
        rows: [
          { topic: '特征值', rate: '42%', count: 7 },
          { topic: '贝叶斯', rate: '28%', count: 4 },
        ],
        caption: '仅展示近一周题库',
      },
    },
    {
      type: 'action-bar',
      props: {
        actions: [
          { id: 'start-review', label: '开始复习', variant: 'primary', riskLevel: 'low' },
          { id: 'open-qbank', label: '打开题库', variant: 'default', riskLevel: 'low' },
        ],
      },
    },
  ],
};

/** 今日计划：steps + markdown */
export const STUDY_PLAN_EXAMPLE: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '今日学习计划',
    description: '步骤清单 + Markdown 说明',
  },
  blocks: [
    {
      type: 'steps',
      props: {
        title: '今晚复习路径',
        steps: [
          { label: '复习到期闪卡', status: 'done', durationLabel: '20 分钟' },
          {
            label: '错题重做',
            status: 'active',
            description: '特征值 7 道',
            durationLabel: '25 分钟',
          },
          { label: '总结笔记', status: 'pending', durationLabel: '15 分钟' },
        ],
      },
    },
    {
      type: 'markdown',
      props: {
        title: '计划说明',
        body: '先完成**到期闪卡**，再针对错题做 10 道相似计算。笔记只记对角化前提，不要抄公式。',
        variant: 'compact',
      },
    },
  ],
};

/** 研究对照：paper-digest + table + research-report */
export const RESEARCH_COMPARISON_EXAMPLE: GenerativeUIIntent = {
  version: '1',
  meta: {
    title: '注意力文献对照',
    description: '可附带 researchSessionId 绑定 HPIAS 会话',
  },
  blocks: [
    {
      type: 'paper-digest',
      props: {
        title: 'Attention Is All You Need',
        authors: 'Vaswani et al.',
        venue: 'NeurIPS',
        year: 2017,
        citationLabel: '高引',
        keyFindings: ['自注意力可替代循环结构'],
      },
    },
    {
      type: 'table',
      props: {
        title: '模型对照',
        columns: [
          { key: 'model', label: '模型' },
          { key: 'year', label: '年份', align: 'right' },
          { key: 'note', label: '要点' },
        ],
        rows: [
          { model: 'Transformer', year: 2017, note: '纯注意力' },
          { model: 'BERT', year: 2018, note: '双向预训练' },
        ],
      },
    },
    {
      type: 'research-report',
      props: {
        title: '对照摘要',
        body: 'Transformer 奠定自注意力范式 [paper-1]；BERT 将其用于双向预训练 [paper-2]。',
      },
    },
  ],
};

export const GENERATIVE_UI_FEW_SHOT_EXAMPLES: readonly GenerativeUIIntent[] = [
  LEARNING_DASHBOARD_EXAMPLE,
  MISTAKE_DIAGNOSIS_EXAMPLE,
  RESEARCH_BRIEFING_EXAMPLE,
  NOTES_HITL_EXAMPLE,
  LEARNING_ANALYTICS_EXAMPLE,
  STUDY_PLAN_EXAMPLE,
  RESEARCH_COMPARISON_EXAMPLE,
];

export const GENERATIVE_UI_FEW_SHOT_LABELS = [
  '学习仪表盘：stat-card + progress + action-bar',
  '错题诊断：mistake-analysis + list',
  '研究：research-plan + research-report + paper-digest',
  'Notes HITL：text + action-bar（edit-apply / edit-reject）',
  '学习数据：chart + table + action-bar',
  '今日计划：steps + markdown',
  '研究对照：paper-digest + table + research-report',
] as const;

/**
 * 负例关键字 — system prompt 必须原文包含，供 contract 测试对齐。
 */
export const GENERATIVE_UI_NEGATIVE_EXAMPLE_KEYWORDS = [
  'HTML',
  'JSX',
  '发明 type',
  '已删除',
  'className',
  'hex',
  'max blocks',
  '长度不齐',
  '无 columns',
] as const;

export const GENERATIVE_UI_NEGATIVE_EXAMPLES = [
  {
    id: 'html-jsx',
    title: 'HTML/JSX',
    bad: '<div className="card">进度 80%</div> 或 return <StatCard />',
    reason: '只能输出 JSON 意图，禁止 HTML、JSX 或可执行代码。',
  },
  {
    id: 'invented-type',
    title: '发明 type',
    bad: '{ "type": "hero-banner" } / kanban / custom-widget',
    reason: '只能使用下方 catalog 动态注入的 type；未注册 type 一律拒绝。',
  },
  {
    id: 'bypass-action-bar',
    title: '绕过 action-bar 假装副作用已发生',
    bad: '{ "type": "text", "props": { "body": "该笔记已删除" } }',
    reason: '删除/写入/支付不得在文案里宣告完成；必须走 action-bar + riskLevel，由用户确认。',
  },
  {
    id: 'classname-hex',
    title: 'className / hex 外观字段',
    bad: '{ "className": "text-red-500", "color": "#FF5500" }',
    reason: '禁止 className、style、hex 色值；外观由设计系统组件决定。',
  },
  {
    id: 'over-max-blocks',
    title: '超过 max blocks',
    bad: 'blocks 数组长度大于当前上限',
    reason: '超过 max blocks 会被截断或拒绝；合并信息密度，不要堆砌。',
  },
  {
    id: 'chart-series-mismatch',
    title: 'chart series 长度不齐',
    bad: '{ "type": "chart", "props": { "kind": "bar", "categories": ["周一", "周二"], "series": [{ "name": "张数", "values": [3] }] } }',
    reason: '每条 series.values 长度必须等于 categories 长度，禁止缺值或错位。',
  },
  {
    id: 'table-no-columns',
    title: 'table 无 columns',
    bad: '{ "type": "table", "props": { "rows": [{ "topic": "代数" }] } }',
    reason: 'table 必须提供 columns（key + label）；仅有 rows 会被拒绝。',
  },
] as const;
