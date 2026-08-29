/**
 * Generative UI — 内置块注册（import 即注册）
 */

import { generativeUIRegistry } from '../registry';
import {
  statCardPropsSchema,
  alertBlockPropsSchema,
  listBlockPropsSchema,
  progressBlockPropsSchema,
  actionBarPropsSchema,
  textBlockPropsSchema,
  keyValueGridPropsSchema,
} from '../schema';
import { flashcardPreviewPropsSchema } from '../components/FlashcardPreviewBlock';
import { reviewCalendarPropsSchema } from '../components/ReviewCalendarBlock';
import { mistakeAnalysisPropsSchema } from '../components/MistakeAnalysisBlock';
import { StatCardBlock } from '../components/StatCardBlock';
import { AlertBlock } from '../components/AlertBlock';
import { ListBlock } from '../components/ListBlock';
import { ProgressBlock } from '../components/ProgressBlock';
import { ActionBarBlock } from '../components/ActionBarBlock';
import { TextBlock } from '../components/TextBlock';
import { KeyValueGridBlock } from '../components/KeyValueGridBlock';
import { FlashcardPreviewBlock } from '../components/FlashcardPreviewBlock';
import { ReviewCalendarBlock } from '../components/ReviewCalendarBlock';
import { MistakeAnalysisBlock } from '../components/MistakeAnalysisBlock';
import { MindmapEmbedBlock, mindmapEmbedPropsSchema } from '../components/MindmapEmbedBlock';
import { PaperDigestBlock, paperDigestPropsSchema } from '../components/PaperDigestBlock';
import { ResearchPlanBlock, researchPlanPropsSchema } from '../components/ResearchPlanBlock';
import { ResearchReportBlock, researchReportPropsSchema } from '../components/ResearchReportBlock';
import { MarkdownBlock, markdownPropsSchema } from '../components/MarkdownBlock';
import { ChartBlock, chartBlockPropsSchema } from '../components/ChartBlock';
import { StepsBlock, stepsBlockPropsSchema } from '../components/StepsBlock';
import { TableBlock, tableBlockPropsSchema } from '../components/TableBlock';

generativeUIRegistry.register({
  type: 'stat-card',
  component: StatCardBlock,
  propsSchema: statCardPropsSchema,
  description: '指标卡片：标题、数值、可选趋势',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'alert',
  component: AlertBlock,
  propsSchema: alertBlockPropsSchema,
  description: '提示条：info/warning/destructive',
});

generativeUIRegistry.register({
  type: 'list',
  component: ListBlock,
  propsSchema: listBlockPropsSchema,
  description: '列表：标题 + 条目（label/description/badge）',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'progress',
  component: ProgressBlock,
  propsSchema: progressBlockPropsSchema,
  description: '进度条：current/total',
});

generativeUIRegistry.register({
  type: 'action-bar',
  component: ActionBarBlock,
  propsSchema: actionBarPropsSchema,
  description: '操作栏：仅声明 action id，副作用由 handler 执行',
});

generativeUIRegistry.register({
  type: 'text',
  component: TextBlock,
  propsSchema: textBlockPropsSchema,
  description: '文本块：heading + body，SaaS 信息密度',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'key-value-grid',
  component: KeyValueGridBlock,
  propsSchema: keyValueGridPropsSchema,
  description: '键值对网格：摘要/metadata',
});

generativeUIRegistry.register({
  type: 'flashcard-preview',
  component: FlashcardPreviewBlock,
  propsSchema: flashcardPreviewPropsSchema,
  description: '闪卡预览：front/back/tags',
});

generativeUIRegistry.register({
  type: 'review-calendar',
  component: ReviewCalendarBlock,
  propsSchema: reviewCalendarPropsSchema,
  description: '复习日历：日期 + 待复习数量',
});

generativeUIRegistry.register({
  type: 'mistake-analysis',
  component: MistakeAnalysisBlock,
  propsSchema: mistakeAnalysisPropsSchema,
  description: '错题分析：主题 + 错误率 + 建议',
});

generativeUIRegistry.register({
  type: 'mindmap-embed',
  component: MindmapEmbedBlock,
  propsSchema: mindmapEmbedPropsSchema,
  description: '思维导图嵌入：mindmapId 引用式预览',
  allowPartialRender: false,
});

generativeUIRegistry.register({
  type: 'paper-digest',
  component: PaperDigestBlock,
  propsSchema: paperDigestPropsSchema,
  description: '论文摘要：标题、作者、要点、引用标签',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'research-plan',
  component: ResearchPlanBlock,
  propsSchema: researchPlanPropsSchema,
  description: '研究计划：多步骤进度（pending/active/done）',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'research-report',
  component: ResearchReportBlock,
  propsSchema: researchReportPropsSchema,
  description: '研究报告：正文 + [类型-N] 引用标记（可流式 partial body）',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'markdown',
  component: MarkdownBlock,
  propsSchema: markdownPropsSchema,
  description: 'Markdown 正文：title + body，复用 Chat MarkdownRenderer',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'chart',
  component: ChartBlock,
  propsSchema: chartBlockPropsSchema,
  description: '图表：限定 bar/line/pie，categories + series',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'steps',
  component: StepsBlock,
  propsSchema: stepsBlockPropsSchema,
  description: '学习计划步骤：通用步骤列表（pending/active/done/error/skipped，可选时长）',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'table',
  component: TableBlock,
  propsSchema: tableBlockPropsSchema,
  description: '表格：列 schema + 行数据（允许流式 rows）',
  allowPartialRender: true,
});

export {
  StatCardBlock,
  AlertBlock,
  ListBlock,
  ProgressBlock,
  ActionBarBlock,
  TextBlock,
  KeyValueGridBlock,
  FlashcardPreviewBlock,
  ReviewCalendarBlock,
  MistakeAnalysisBlock,
  MindmapEmbedBlock,
  PaperDigestBlock,
  ResearchPlanBlock,
  ResearchReportBlock,
  MarkdownBlock,
  ChartBlock,
  StepsBlock,
  TableBlock,
};
