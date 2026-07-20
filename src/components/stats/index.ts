/**
 * 统计组件导出
 *
 * 2026-01 新增：时间维度统计与趋势可视化
 * 2026-07 新增：题型分布与正确率（13 种契约题型）、活跃度日期工具
 */

export { LearningTrendChart } from './LearningTrendChart';
export type { LearningTrendChartProps } from './LearningTrendChart';

export { LearningHeatmapChart } from './LearningHeatmapChart';
export type { LearningHeatmapChartProps } from './LearningHeatmapChart';

export { KnowledgeRadar } from './KnowledgeRadar';
export type { KnowledgeRadarProps } from './KnowledgeRadar';

export { QuestionTypeBreakdown } from './QuestionTypeBreakdown';
export type { QuestionTypeBreakdownProps } from './QuestionTypeBreakdown';

export { clampPercent, normalizePercent, ratioToPercent, percentOf } from './percent';
export {
  toLocalDateStr,
  normalizeDateKey,
  parseLocalDate,
  computeCurrentStreak,
  todayActivityCount,
} from './activityDates';
export {
  QUESTION_TYPE_ORDER,
  isKnownQuestionType,
  questionTypeColor,
  questionTypeLabelKey,
} from './questionTypeMeta';
