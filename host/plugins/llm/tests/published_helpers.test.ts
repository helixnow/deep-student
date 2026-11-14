/** Published pure helpers (llm/api.ts) used by L18: same results as the internal Rust ports. */
import { describe, expect, it } from 'vitest';
import { isRetryableHttpStatus, sanitizeUrlForLog, supportsThinkingStatic } from '../api.ts';
import { ZhipuAdapter } from '../src/adapters/zhipu.ts';

describe('llm/api.ts published helpers', () => {
  it('supportsThinkingStatic mirrors ZhipuAdapter::supports_thinking_static', () => {
    for (const model of ['glm-4.5', 'GLM-4.6V', 'glm-5-plus', 'glm4.7', 'glm-4.5-flash', 'glm-4.1v-thinking', 'gpt-4o', 'deepseek-ocr']) {
      expect(supportsThinkingStatic(model)).toBe(ZhipuAdapter.supportsThinkingStatic(model));
    }
    expect(supportsThinkingStatic('glm-4.6')).toBe(true);
    expect(supportsThinkingStatic('glm-4.5-flash')).toBe(false);
    expect(supportsThinkingStatic('qwen-vl')).toBe(false);
  });

  it('isRetryableHttpStatus keeps the single-shot retry classification', () => {
    expect([408, 429, 500, 502, 503, 504, 524].every(isRetryableHttpStatus)).toBe(true);
    expect([200, 400, 401, 403, 404, 413, 422].some(isRetryableHttpStatus)).toBe(false);
  });

  it('sanitizeUrlForLog redacts query credentials', () => {
    const out = sanitizeUrlForLog('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSECRET&alt=sse');
    expect(out).not.toContain('AIzaSECRET');
    expect(out.startsWith('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?')).toBe(true);
    expect(sanitizeUrlForLog('https://api.example/v1/chat/completions')).toBe('https://api.example/v1/chat/completions');
  });
});
