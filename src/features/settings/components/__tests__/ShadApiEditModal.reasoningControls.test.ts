import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { clampGeminiThinkingBudget } from '../ShadApiEditModal';

describe('ShadApiEditModal reasoning controls', () => {
  it('clamps Gemini 2.5 budgets to the provider model bounds', () => {
    expect(clampGeminiThinkingBudget('gemini-2.5-pro', -2)).toBe(-1);
    expect(clampGeminiThinkingBudget('gemini-2.5-pro', 0)).toBe(128);
    expect(clampGeminiThinkingBudget('gemini-2.5-pro', 50000)).toBe(32768);
    expect(clampGeminiThinkingBudget('gemini-2.5-flash', -2)).toBe(-1);
    expect(clampGeminiThinkingBudget('gemini-2.5-flash', 0)).toBe(0);
    expect(clampGeminiThinkingBudget('gemini-2.5-flash', 50000)).toBe(24576);
  });

  it('uses the runtime matrix for provider profile effort controls', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
      'utf8'
    );

    expect(source).toContain('resolveDeepSeekRuntimeReasoningControl');
    expect(source).toContain('const profileReasoningOptions = profileReasoningControl.options.map');
    expect(source).toContain("const profileUsesDiscreteEffort = profileReasoningControl.kind !== 'toggle-only'");

    const grokStart = source.indexOf("{formData.modelAdapter === 'grok'");
    const grokEnd = source.indexOf('{/* Doubao', grokStart);
    expect(grokStart).toBeGreaterThan(-1);
    expect(source.slice(grokStart, grokEnd)).toContain('...profileReasoningOptions');
  });

  it('keeps provider capability separate from the Doubao thinking state', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
      'utf8'
    );
    const doubaoStart = source.indexOf("{formData.modelAdapter === 'doubao'");
    const doubaoEnd = source.indexOf('{/* Zhipu', doubaoStart);
    const doubaoPanel = source.slice(doubaoStart, doubaoEnd);

    expect(doubaoPanel).toContain('supportsReasoning: true');
    expect(doubaoPanel).toContain("thinkingEnabled: v !== 'disabled'");
    expect(doubaoPanel).not.toContain("supportsReasoning: v !== 'disabled'");
  });

  it('shows real thinking switches for modern Kimi and MiniMax models', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
      'utf8'
    );

    expect(source).toContain('isModernKimiThinkingModel &&');
    expect(source).toContain('miniMaxModelMajor !== undefined &&');
    expect(source).toContain('disabled={!profileReasoningControl.canDisable}');
  });

  it('materializes a provider default effort when a discrete thinking switch is enabled', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
      'utf8'
    );

    expect(source).toContain('prev.reasoningEffort ?? normalized.reasoningEffort');
    expect(source).toContain('prev.thinkingBudget ?? normalized.thinkingBudget');
  });
});
