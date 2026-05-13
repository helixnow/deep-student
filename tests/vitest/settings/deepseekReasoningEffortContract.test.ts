import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DeepSeek V4 reasoning effort settings contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
    'utf-8'
  );
  const blockStart = source.indexOf("{formData.enableThinking && deepSeekReasoningControl.kind !== 'toggle-only' && (");
  const blockEnd = source.indexOf('{isDeepseekV31 && formData.supportsTools', blockStart);
  const deepSeekEffortBlock = source.slice(blockStart, blockEnd);
  const saveBlockStart = source.indexOf("if (sanitized.modelAdapter === 'deepseek') {");
  const saveBlockEnd = source.indexOf('} else if (hasThinkingDefaults)', saveBlockStart);
  const deepSeekSaveBlock = source.slice(saveBlockStart, saveBlockEnd);
  const inferenceBlockStart = source.indexOf('const isDeepSeek = next.modelAdapter ===');
  const inferenceBlockEnd = source.indexOf('return next;', inferenceBlockStart);
  const deepSeekInferenceBlock = source.slice(inferenceBlockStart, inferenceBlockEnd);

  it('shows only official DeepSeek V4 high/max effort choices in the UI', () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);

    expect(deepSeekEffortBlock).toContain('value={deepSeekReasoningSelectValue}');
    expect(deepSeekEffortBlock).toContain('deepSeekReasoningControl.options.map');
    expect(deepSeekEffortBlock).toContain('normalizeDeepSeekV4Effort');

    expect(deepSeekEffortBlock).not.toContain("value: 'unset'");
    expect(deepSeekEffortBlock).not.toContain("value: 'none'");
    expect(deepSeekEffortBlock).not.toContain("v === 'unset'");
  });

  it('preserves DeepSeek reasoning capability even when thinking is disabled', () => {
    expect(saveBlockStart).toBeGreaterThan(-1);
    expect(saveBlockEnd).toBeGreaterThan(saveBlockStart);

    expect(deepSeekSaveBlock).toContain('inferredSupportsReasoning');
    expect(deepSeekSaveBlock).toContain('sanitized.supportsReasoning = true');
  });

  it('offers V3.2 depth presets that map to thinking budget semantics', () => {
    expect(deepSeekEffortBlock).toContain("deepSeekReasoningControl.kind === 'v32-budget-effort'");
    expect(deepSeekEffortBlock).toContain('deepSeekV32EffortToBudget');
  });

  it('auto-enables DeepSeek reasoning defaults when a typed model is inferred as reasoning-capable', () => {
    expect(inferenceBlockStart).toBeGreaterThan(-1);
    expect(inferenceBlockEnd).toBeGreaterThan(inferenceBlockStart);

    expect(deepSeekInferenceBlock).toContain("next.modelAdapter === 'deepseek'");
    expect(deepSeekInferenceBlock).toContain('const deepSeekEnableThinkingDefault = true');
    expect(deepSeekInferenceBlock).toContain('enableThinking: deepSeekEnableThinkingDefault');
    expect(deepSeekInferenceBlock).toContain('thinkingEnabled: deepSeekEnableThinkingDefault');
  });
});
