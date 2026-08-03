/**
 * 题型统计元信息（展示顺序 + 主题感知配色）
 *
 * 题型契约共 13 种（2026-07 新增 true_false / matching / ordering / numeric）。
 * 这里刻意用 string 键而不是 QuestionType 联合类型：
 * 联合类型的扩展由题目编辑侧负责，统计侧对未知题型要能优雅降级
 * （归入 other 展示），不能因为类型不同步而编译失败或渲染崩溃。
 *
 * 颜色全部从 shadcn 语义 CSS 变量派生（hsl(var(--*) / alpha)），
 * 深浅色模式跟随主题自动适配，不写死十六进制。
 */

/** 13 种题型的统一展示顺序（与 src/components/questionTypeMeta.ts 的 QUESTION_TYPE_ORDER 一致） */
export const QUESTION_TYPE_ORDER: readonly string[] = [
  'single_choice',
  'multiple_choice',
  'indefinite_choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'calculation',
  'numeric',
  'proof',
  'matching',
  'ordering',
  'other',
];

const TYPE_COLORS: Record<string, string> = {
  single_choice: 'hsl(var(--primary))',
  multiple_choice: 'hsl(var(--primary) / 0.65)',
  indefinite_choice: 'hsl(var(--primary) / 0.4)',
  true_false: 'hsl(var(--success))',
  fill_blank: 'hsl(var(--info))',
  matching: 'hsl(var(--info) / 0.6)',
  ordering: 'hsl(var(--warning))',
  numeric: 'hsl(var(--warning) / 0.6)',
  short_answer: 'hsl(var(--success) / 0.6)',
  calculation: 'hsl(var(--destructive) / 0.75)',
  proof: 'hsl(var(--destructive) / 0.45)',
  essay: 'hsl(var(--muted-foreground))',
  other: 'hsl(var(--muted-foreground) / 0.5)',
};

/** 是否为已知题型（未知题型统计时归入 other） */
export function isKnownQuestionType(type: string): boolean {
  return QUESTION_TYPE_ORDER.includes(type);
}

/** 题型 → 主题感知颜色（未知题型回退 other 色） */
export function questionTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? TYPE_COLORS.other;
}

/** 题型 → stats 命名空间下的 i18n key（配合 t(questionTypeLabelKey(type))） */
export function questionTypeLabelKey(type: string): string {
  return `questionTypes.${isKnownQuestionType(type) ? type : 'other'}`;
}
