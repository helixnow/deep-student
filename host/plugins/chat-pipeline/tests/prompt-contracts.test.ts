import { describe, expect, it } from 'vitest';
import { LATEX_RULES } from '../api.ts';
import { LATEX_OUTPUT_BRIEF, LATEX_OUTPUT_BRIEF_EN } from '../../llm-providers/api.ts';
import { createPipelineHost } from './chat-host.ts';

describe('dstu-core/prompt_contracts.rs::tests (F4 migration evidence)', () => {
  it('latex_rules_contains_core_constraints', async () => {
    expect(LATEX_RULES).toContain('禁止裸露 LaTeX');
    expect(LATEX_RULES).toContain('priority="highest"');
    expect(LATEX_RULES).toContain('\\boxed{} 命令必须用 $...$ 包裹');
    expect(LATEX_RULES).toContain('禁止使用 \\(...\\) 与 \\[...\\]');
    const host = await createPipelineHost();
    try {
      const prompt = host.ctx.chatPipeline.buildSystemPrompt({ options: {}, sources: {},
        canvasNote: null, userProfile: null });
      expect(prompt.stableSystem).toContain(LATEX_RULES);
    } finally { await host.dispose(); }
  });
  it('latex_output_brief_is_consistent_with_full_rules', () => {
    expect(LATEX_OUTPUT_BRIEF).toContain('$...$');
    expect(LATEX_OUTPUT_BRIEF).toContain('禁止裸写');
    expect(LATEX_OUTPUT_BRIEF_EN).toContain('$...$');
    expect(LATEX_OUTPUT_BRIEF_EN).toContain('bare LaTeX');
  });
});
