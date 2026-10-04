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

    // 方案 D：设置页改走渠道并行注册表（adapterId=modelAdapter）
    expect(source).toContain('resolveReasoningControl');
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

  it('keeps user-selected effort and budget untouched when toggling thinking on', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
      'utf8'
    );

    // 统一五档（方案 F）：开启思考时保留用户已选的档位与预算原值，
    // 不再经家族特定 resolver 重算（映射只在后端进行）。
    expect(source).toContain('reasoningEffort: enabled ? prev.reasoningEffort : undefined');
    expect(source).toContain('thinkingBudget: enabled ? prev.thinkingBudget : undefined');
  });

  it('renders the unified depth select in the Moonshot and MiniMax panels (K3/M3.1 locked-on still selectable)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
      'utf8'
    );

    // 回归：Moonshot/Kimi 专用面板在统一五档后必须提供档位选择器，
    // 否则 K3（canDisable=false）在编辑器里没有任何可改档位的入口。
    const moonshotStart = source.indexOf("{formData.modelAdapter === 'moonshot'");
    const moonshotEnd = source.indexOf("{/* MiniMax", moonshotStart);
    expect(moonshotStart).toBeGreaterThan(-1);
    const moonshotPanel = source.slice(moonshotStart, moonshotEnd);
    expect(moonshotPanel).toContain('profileUsesDiscreteEffort &&');
    expect(moonshotPanel).toContain('profileReasoningOptions');

    // MiniMax 同款：M3.1（强制思考）同样需要档位选择器。
    const minimaxStart = source.indexOf("{formData.modelAdapter === 'minimax'");
    const minimaxEnd = source.indexOf('</CardContent>', minimaxStart);
    expect(minimaxStart).toBeGreaterThan(-1);
    const minimaxPanel = source.slice(minimaxStart, minimaxEnd);
    expect(minimaxPanel).toContain('profileUsesDiscreteEffort &&');
    expect(minimaxPanel).toContain('profileReasoningOptions');
  });
});
