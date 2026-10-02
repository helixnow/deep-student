import { describe, expect, it } from 'vitest';
import { GRADING_PHASE_ORDER, inferGradingPhase } from './gradingPhase';

describe('inferGradingPhase', () => {
  it('follows the backend section order: annotate → polish → model essay → score', () => {
    const annotated = 'Some people <err>believe</err> that';
    const polishing = `${annotated}\n<section-polish>\n<polish-item>`;
    const modelEssay = `${polishing}</section-polish>\n<section-model-essay>Dear`;
    const scoring = `${modelEssay}</section-model-essay>\n<score total="6.5" max="9">\n<dim name="TR"`;

    expect(inferGradingPhase('')).toBe('preparing');
    expect(inferGradingPhase(annotated)).toBe('annotating');
    expect(inferGradingPhase(polishing)).toBe('polishing');
    expect(inferGradingPhase(modelEssay)).toBe('model_essay');
    expect(inferGradingPhase(scoring)).toBe('scoring');
  });

  it('reports scoring once the trailing score tag opens after polishing', () => {
    const content = 'Essay <good>text</good>\n<section-polish></section-polish>\n<score total="6" max="9">';
    expect(inferGradingPhase(content)).toBe('scoring');
  });

  it('orders the progress dots the way phases actually arrive', () => {
    expect(GRADING_PHASE_ORDER).toEqual(['preparing', 'annotating', 'polishing', 'model_essay', 'scoring']);
  });
});
