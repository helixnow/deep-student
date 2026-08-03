/**
 * 统计侧百分比换算统一工具
 *
 * 后端两种量纲并存，所有换算必须收敛到这里，使用方不要自行 ×100：
 * - `qbank_get_stats`（useQuestionBankSession 的 stats.correctRate）是 0-1 比例
 *   （见 src-tauri/src/vfs/repos/question_repo.rs 的 refresh_stats）
 * - `LearningTrendPoint` / `KnowledgePoint` / `MockExamScoreCard` 的 *_rate
 *   是 0-100 百分比（见 src-tauri/src/question_bank_service.rs）
 *
 * 直接展示后端 0-100 值用 normalizePercent；0-1 比例用 ratioToPercent；
 * 由计数现算用 percentOf。混用会产生 0.87% / 8700% 一类双重换算 bug。
 */

/** NaN/Infinity 守卫 + 0-100 截断（不取整，供 SVG 几何等需要精度的场景） */
export function clampPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

/** 后端已是 0-100 的百分比 → 取整后的展示值 */
export function normalizePercent(value: number | null | undefined): number {
  return Math.round(clampPercent(value));
}

/** 0-1 比例（如 stats.correctRate）→ 0-100 取整百分比 */
export function ratioToPercent(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio)) return 0;
  return normalizePercent(ratio * 100);
}

/** 计数 → 百分比；total <= 0 或非法输入返回 0（规避除零 NaN） */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return normalizePercent((part / total) * 100);
}
