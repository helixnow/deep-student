import { describe, expect, it } from 'vitest';
import { detectByokProvider, sanitizeRawApiKey } from '../keyDetector';

describe('keyDetector', () => {
  it('strips Bearer prefix, whitespace, and clipboard zero-width artifacts', () => {
    expect(sanitizeRawApiKey('  Bearer   sk-ant-api03-abcdef1234567890  \n')).toBe(
      'sk-ant-api03-abcdef1234567890',
    );
    expect(sanitizeRawApiKey('\uFEFFbearer\tsk-proj-xyz9876543210abcdef\u200B')).toBe(
      'sk-proj-xyz9876543210abcdef',
    );
  });

  it('detects unambiguous provider prefixes accurately', () => {
    const anthropic = detectByokProvider({
      rawApiKey: 'sk-ant-api03-testkey1234567890abcdef',
    });
    expect(anthropic.preset?.id).toBe('anthropic');
    expect(anthropic.preset?.providerType).toBe('anthropic');
    expect(anthropic.preset?.builtinVendorId).toBe('builtin-anthropic');
    expect(anthropic.effectiveBaseUrl).toBe('https://api.anthropic.com');
    expect(anthropic.isAmbiguous).toBe(false);

    const openrouter = detectByokProvider({
      rawApiKey: 'sk-or-v1-0123456789abcdef0123456789abcdef',
    });
    expect(openrouter.preset?.id).toBe('openrouter');
    expect(openrouter.preset?.providerType).toBe('openai-compatible');
    expect(openrouter.preset?.builtinVendorId).toBe('builtin-openrouter');
    expect(openrouter.effectiveBaseUrl).toBe('https://openrouter.ai/api/v1');
    expect(openrouter.isAmbiguous).toBe(false);

    // 39-char standard Google AI Studio key
    const gemini = detectByokProvider({
      rawApiKey: 'AIzaSyD1234567890abcdefABCDEF1234567890',
    });
    expect(gemini.preset?.id).toBe('gemini');
    expect(gemini.preset?.providerType).toBe('gemini');
    expect(gemini.preset?.builtinVendorId).toBe('builtin-gemini');
    expect(gemini.effectiveBaseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(gemini.isAmbiguous).toBe(false);

    const groq = detectByokProvider({
      rawApiKey: 'gsk_1234567890abcdefghijklmnopqrstuvwx',
    });
    expect(groq.preset?.id).toBe('groq');
    expect(groq.preset?.providerType).toBe('openai-compatible');
    expect(groq.effectiveBaseUrl).toBe('https://api.groq.com/openai/v1');
    expect(groq.preset?.supportsEmbeddingsByDefault).toBe(false);
    expect(groq.isAmbiguous).toBe(false);

    const xai = detectByokProvider({
      rawApiKey: 'xai-1234567890abcdefghijklmnopqrstuvwx',
    });
    expect(xai.preset?.id).toBe('xai');
    expect(xai.effectiveBaseUrl).toBe('https://api.x.ai/v1');
    expect(xai.isAmbiguous).toBe(false);

    const zhipu = detectByokProvider({
      rawApiKey: '0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp',
    });
    expect(zhipu.preset?.id).toBe('zhipu');
    expect(zhipu.preset?.builtinVendorId).toBe('builtin-zhipu');
    expect(zhipu.effectiveBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(zhipu.isAmbiguous).toBe(false);

    const openaiProj = detectByokProvider({
      rawApiKey: 'sk-proj-1234567890abcdefghijklmnopqrstuvwx',
    });
    expect(openaiProj.preset?.id).toBe('openai');
    expect(openaiProj.preset?.builtinVendorId).toBe('builtin-openai');
    expect(openaiProj.effectiveBaseUrl).toBe('https://api.openai.com/v1');
    expect(openaiProj.isAmbiguous).toBe(false);

    const openaiSvc = detectByokProvider({
      rawApiKey: 'sk-svcacct-1234567890abcdefghijklmnopqrstuvwx',
    });
    expect(openaiSvc.preset?.id).toBe('openai');
    expect(openaiSvc.isAmbiguous).toBe(false);
  });

  it('marks generic sk-* keys as ambiguous with top 5 candidate providers and resolves manual selection', () => {
    const genericKey = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const result = detectByokProvider({ rawApiKey: `Bearer ${genericKey}` });

    expect(result.sanitizedApiKey).toBe(genericKey);
    expect(result.isAmbiguous).toBe(true);
    expect(result.candidates.map((c) => c.id)).toEqual([
      'siliconflow',
      'deepseek',
      'openai',
      'dashscope',
      'moonshot',
    ]);

    const manuallyPicked = detectByokProvider({
      rawApiKey: genericKey,
      selectedPresetId: 'deepseek',
    });
    expect(manuallyPicked.isAmbiguous).toBe(false);
    expect(manuallyPicked.preset?.id).toBe('deepseek');
    expect(manuallyPicked.effectiveBaseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('honors customBaseUrl override and normalizes trailing slashes', () => {
    const overridden = detectByokProvider({
      rawApiKey: 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      customBaseUrl: 'https://gateway.internal.example/v1///',
    });

    expect(overridden.usedCustomBaseUrl).toBe(true);
    expect(overridden.isAmbiguous).toBe(false);
    expect(overridden.effectiveBaseUrl).toBe('https://gateway.internal.example/v1');
    expect(overridden.preset?.providerType).toBe('openai-compatible');
  });
});
