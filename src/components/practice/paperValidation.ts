/**
 * 组卷配置校验（纯函数，便于单测）
 *
 * 题库余量校验：题型请求数 > 题库中该题型实际数量时生成缺口清单，
 * 由 PaperGenerator 在生成前阻断并提示用户调整重试（后端随机抽取在
 * 池不足时会静默少抽，必须在提交前拦住）。
 */

export interface TypeShortage {
  /** 题型（snake_case，与后端 question_type 一致） */
  questionType: string;
  /** 用户请求的数量 */
  requested: number;
  /** 题库中该题型的实际数量 */
  available: number;
}

/**
 * 找出请求数超过题库余量的题型。
 *
 * - 忽略 0 / 非有限数的请求项；
 * - 题库中不存在该题型时按 0 计。
 */
export function findTypeShortages(
  typeSelection: Record<string, number>,
  availableByType: Record<string, number>,
): TypeShortage[] {
  return Object.entries(typeSelection)
    .map(([questionType, requested]) => ({
      questionType,
      requested: Number.isFinite(requested) ? requested : 0,
      available: availableByType[questionType] ?? 0,
    }))
    .filter(({ requested, available }) => requested > 0 && requested > available);
}
