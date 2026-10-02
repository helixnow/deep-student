export type GradingPhase = 'preparing' | 'annotating' | 'scoring' | 'polishing' | 'model_essay';

/** 后端 progress 事件的阶段标识（含前端不单独展示的 saving） */
export type BackendGradingStage = GradingPhase | 'saving';

/** 与后端输出顺序一致（pipeline.rs GradingStage）：批注 → 润色 → 范文 → 评分（<score> 在最末尾） */
export const GRADING_PHASE_ORDER: readonly GradingPhase[] = [
  'preparing',
  'annotating',
  'polishing',
  'model_essay',
  'scoring',
];

const SECTION_OPENERS: ReadonlyArray<[GradingPhase, RegExp]> = [
  ['polishing', /<section-polish/i],
  ['model_essay', /<section-model-essay/i],
  ['scoring', /<score\b/i],
];

/** 根据已生成内容推断当前批改阶段：最后出现的段落开标签决定阶段。
 * 后端 progress 事件可用时应优先使用事件中的 stage，本函数作为兜底推断。 */
export function inferGradingPhase(content: string): GradingPhase {
  if (!content) return 'preparing';
  let phase: GradingPhase = 'annotating';
  let openedAt = -1;
  for (const [candidate, opener] of SECTION_OPENERS) {
    const index = content.search(opener);
    if (index > openedAt) {
      openedAt = index;
      phase = candidate;
    }
  }
  return phase;
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
