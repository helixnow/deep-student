/** Built-in validation/catalog registration, without loading UI components. */
import { generativeUIRegistry } from './registry';
import type { GenerativeComponentSchemaConfig } from './types';
import {
  statCardPropsSchema,
  alertBlockPropsSchema,
  listBlockPropsSchema,
  progressBlockPropsSchema,
  actionBarPropsSchema,
  textBlockPropsSchema,
  keyValueGridPropsSchema,
  flashcardPreviewPropsSchema,
  reviewCalendarPropsSchema,
  mistakeAnalysisPropsSchema,
  mindmapEmbedPropsSchema,
  paperDigestPropsSchema,
  researchPlanPropsSchema,
  researchReportPropsSchema,
  markdownPropsSchema,
  chartBlockPropsSchema,
  stepsBlockPropsSchema,
  tableBlockPropsSchema,
  choicePropsSchema,
  formPropsSchema,
  imageBlockPropsSchema,
} from './schema';

export const BUILTIN_GENERATIVE_BLOCK_SCHEMAS: GenerativeComponentSchemaConfig[] = [
  {
    type: 'stat-card',
    propsSchema: statCardPropsSchema,
    description: '指标卡片：标题、数值、可选趋势',
    allowPartialRender: true,
  },
  {
    type: 'alert',
    propsSchema: alertBlockPropsSchema,
    description: '提示条：info/warning/destructive',
  },
  {
    type: 'list',
    propsSchema: listBlockPropsSchema,
    description: '列表：标题 + 条目（label/description/badge）',
    allowPartialRender: true,
  },
  {
    type: 'progress',
    propsSchema: progressBlockPropsSchema,
    description: '进度条：current/total',
  },
  {
    type: 'action-bar',
    propsSchema: actionBarPropsSchema,
    description: '操作栏：仅声明 action id，副作用由 handler 执行',
  },
  {
    type: 'text',
    propsSchema: textBlockPropsSchema,
    description: '文本块：heading + body，SaaS 信息密度',
    allowPartialRender: true,
  },
  {
    type: 'key-value-grid',
    propsSchema: keyValueGridPropsSchema,
    description: '键值对网格：摘要/metadata',
  },
  {
    type: 'flashcard-preview',
    propsSchema: flashcardPreviewPropsSchema,
    description: '闪卡预览：front/back/tags',
  },
  {
    type: 'review-calendar',
    propsSchema: reviewCalendarPropsSchema,
    description: '复习日历：日期 + 待复习数量',
  },
  {
    type: 'mistake-analysis',
    propsSchema: mistakeAnalysisPropsSchema,
    description: '错题分析：主题 + 错误率 + 建议',
  },
  {
    type: 'mindmap-embed',
    propsSchema: mindmapEmbedPropsSchema,
    description: '思维导图嵌入：mindmapId 引用式预览',
    allowPartialRender: false,
  },
  {
    type: 'paper-digest',
    propsSchema: paperDigestPropsSchema,
    description: '论文摘要：标题、作者、要点、引用标签',
    allowPartialRender: true,
  },
  {
    type: 'research-plan',
    propsSchema: researchPlanPropsSchema,
    description: '研究计划：多步骤进度（pending/active/done）',
    allowPartialRender: true,
  },
  {
    type: 'research-report',
    propsSchema: researchReportPropsSchema,
    description: '研究报告：正文 + [类型-N] 引用标记（可流式 partial body）',
    allowPartialRender: true,
  },
  {
    type: 'markdown',
    propsSchema: markdownPropsSchema,
    description: 'Markdown 正文：title + body，复用 Chat MarkdownRenderer',
    allowPartialRender: true,
  },
  {
    type: 'chart',
    propsSchema: chartBlockPropsSchema,
    description: '图表：限定 bar/line/pie，categories + series',
    allowPartialRender: true,
  },
  {
    type: 'steps',
    propsSchema: stepsBlockPropsSchema,
    description: '学习计划步骤：通用步骤列表（pending/active/done/error/skipped，可选时长）',
    allowPartialRender: true,
  },
  {
    type: 'table',
    propsSchema: tableBlockPropsSchema,
    description: '表格：列 schema + 行数据（允许流式 rows）',
    allowPartialRender: true,
  },
  {
    type: 'choice',
    propsSchema: choicePropsSchema,
    description: '选择题（交互，需 awaitAnswer=true 且块 id 必填）：question + 2–12 个 options，single/multiple，可选 allowOther',
    allowPartialRender: true,
  },
  {
    type: 'form',
    propsSchema: formPropsSchema,
    description: '表单（交互，需 awaitAnswer=true 且块 id 必填）：1–12 个字段 text/number/slider/rating/switch',
    allowPartialRender: true,
  },
  {
    type: 'image',
    propsSchema: imageBlockPropsSchema,
    description: '图片：source 为 resource（att_/file_/img_/res_）、pdf-page（res_ + page）或 https url；alt 必填',
    allowPartialRender: true,
  },
];

export function registerBuiltinGenerativeSchemas(): void {
  for (const config of BUILTIN_GENERATIVE_BLOCK_SCHEMAS) generativeUIRegistry.registerSchema(config);
}

registerBuiltinGenerativeSchemas();
