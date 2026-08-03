export type GradingPhase = 'preparing' | 'annotating' | 'scoring' | 'polishing' | 'model_essay';

/** 后端 progress 事件的阶段标识（含前端不单独展示的 saving） */
export type BackendGradingStage = GradingPhase | 'saving';

/** 根据已生成内容推断当前批改阶段（批注 → 评分 → 润色 → 范文）。
 * 后端 progress 事件可用时应优先使用事件中的 stage，本函数作为兜底推断。 */
export function inferGradingPhase(content: string): GradingPhase {
  if (!content) return 'preparing';
  if (/<section-model-essay/i.test(content)) return 'model_essay';
  if (/<section-polish/i.test(content)) return 'polishing';
  if (/<score\b/i.test(content)) return 'scoring';
  return 'annotating';
}

/** 将后端 progress 事件 stage 归一到前端展示阶段 */
export function normalizeBackendStage(stage: string): GradingPhase | null {
  switch (stage) {
    case 'preparing':
    case 'annotating':
    case 'scoring':
    case 'polishing':
    case 'model_essay':
      return stage;
    case 'saving':
      return 'model_essay';
    default:
      return null;
  }
}
