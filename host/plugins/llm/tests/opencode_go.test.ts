import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_BASE_URL, BUILTIN_MODELS, GOOGLE_BASE_URL, OPENAI_BASE_URL, OpenCodeGoUsageError,
  SESSION_HEADER, baseUrlForProtocol, identityHeaders, isKeyExpiredBody, isOpencodeGoConfig,
  parseUsage, sessionHeaderValue, userAgent,
} from '../src/opencode_go.ts';

describe('opencode_go.rs', () => {
  it('detects_go_by_vendor_provider_or_endpoint', () => {
    const config = (vendorId: string | null, providerType: string | null, baseUrl: string) => ({
      vendorId,
      providerType,
      baseUrl,
    });
    expect(isOpencodeGoConfig(config('builtin-opencode-go', null, 'https://example.com/v1'))).toBe(true);
    expect(isOpencodeGoConfig(config(null, 'opencode_go', 'https://example.com/v1'))).toBe(true);
    expect(
      isOpencodeGoConfig(config('custom-1', 'openai', 'https://opencode.ai/inference/go/openai/v1/')),
    ).toBe(true);
    expect(isOpencodeGoConfig(config(null, null, 'https://OpenCode.ai/zen/go/v1'))).toBe(true);
    expect(isOpencodeGoConfig(config('builtin-deepseek', 'deepseek', 'https://api.deepseek.com/v1'))).toBe(false);
    expect(isOpencodeGoConfig(config(null, 'openai', 'https://opencode.ai/zen/v1'))).toBe(false);
  });

  it('maps_base_url_by_protocol_only_for_go_roots', () => {
    expect(baseUrlForProtocol(OPENAI_BASE_URL, 'anthropic_messages')).toBe(ANTHROPIC_BASE_URL);
    expect(baseUrlForProtocol(OPENAI_BASE_URL, 'google_generate_content')).toBe(GOOGLE_BASE_URL);
    expect(baseUrlForProtocol(ANTHROPIC_BASE_URL, 'openai_responses')).toBe(OPENAI_BASE_URL);
    expect(baseUrlForProtocol(OPENAI_BASE_URL, 'openai_chat_completions')).toBe(OPENAI_BASE_URL);
    expect(baseUrlForProtocol('https://proxy.example.com/v1', 'anthropic_messages')).toBe(
      'https://proxy.example.com/v1',
    );
  });

  it('identity_headers_use_own_user_agent_and_session', () => {
    const headers = identityHeaders('sess_01HX-abc', '0.11.0');
    expect(headers[0]).toEqual(['User-Agent', userAgent('0.11.0')]);
    expect(headers[0]?.[1]).toBe('DeepStudent/0.11.0');
    expect(headers[1]).toEqual([SESSION_HEADER, 'sess_01HX-abc']);
    expect(headers[0]?.[1]).not.toContain('Mozilla');
  });

  it('session_header_is_sanitized_and_bounded', () => {
    expect(sessionHeaderValue(' a b\r\nc/d ')).toBe('abcd');
    expect(sessionHeaderValue('  ')).toBeNull();
    expect(sessionHeaderValue('x'.repeat(500))?.length).toBe(128);
  });

  it('builtin_models_keep_official_ids_and_protocols', () => {
    for (const model of BUILTIN_MODELS) {
      expect(model.id.startsWith('builtin-opencode-go-')).toBe(true);
      expect([
        'openai_chat_completions', 'openai_responses', 'anthropic_messages', 'google_generate_content',
      ]).toContain(model.protocol);
      expect(model.model).not.toContain('contributor');
    }
    const ids = new Set(BUILTIN_MODELS.map((model) => model.id));
    expect(ids.size).toBe(BUILTIN_MODELS.length);
    expect(BUILTIN_MODELS.some((model) => model.model === 'deepseek-v4.1-flash' && model.protocol === 'openai_chat_completions')).toBe(true);
    expect(BUILTIN_MODELS.some((model) => model.model === 'qwen3.8-max' && model.protocol === 'anthropic_messages')).toBe(true);
  });

  it('builtin_models_match_official_plans_table', () => {
    const plans = JSON.parse(readFileSync('scripts/opencode-go-plans.json', 'utf8')) as {
      models: { id: string; protocol: string; training_permitted: boolean; monthly_limit_usd: { go?: unknown } }[];
    };
    for (const builtin of BUILTIN_MODELS) {
      const official = plans.models.find((model) => model.id === builtin.model);
      expect(official, `${builtin.model} 不在官方额度表中`).toBeDefined();
      expect(official!.protocol, builtin.model).toBe(builtin.protocol);
      expect(official!.training_permitted, `${builtin.model} 允许训练，不应内置`).toBe(false);
      expect(typeof official!.monthly_limit_usd.go, `${builtin.model} 应为付费额度型号`).toBe('number');
    }
  });

  it('parses_usage_windows', () => {
    const usage = parseUsage({
      usage: {
        rolling: { percent: 12, resetsAt: '2026-10-31T12:00:00Z' },
        weekly: { percent: '40.5', resetsAt: 1_793_000_000 },
        monthly: { percent: 140, resetsAt: 1_793_000_000_000 },
      },
    });
    expect(usage.windows.length).toBe(3);
    expect(usage.windows[0]?.window).toBe('five_hour');
    expect(usage.windows[0]?.usedPercent).toBe(12);
    expect(usage.windows[0]?.resetsAtMs).toBe(Date.parse('2026-10-31T12:00:00Z'));
    expect(usage.windows[1]?.usedPercent).toBe(40.5);
    expect(usage.windows[1]?.resetsAtMs).toBe(1_793_000_000_000);
    expect(usage.windows[2]?.usedPercent).toBe(100);
    expect(usage.windows[2]?.resetsAtMs).toBe(1_793_000_000_000);
  });

  it('usage_drops_only_broken_windows', () => {
    const usage = parseUsage({ usage: { rolling: { percent: 'n/a' }, weekly: { percent: 3 } } });
    expect(usage.windows.length).toBe(1);
    expect(usage.windows[0]?.window).toBe('weekly');
    expect(usage.windows[0]?.resetsAtMs).toBeNull();
    expect(() => parseUsage({ usage: {} })).toThrow(OpenCodeGoUsageError);
    expect(() => parseUsage({})).toThrow(OpenCodeGoUsageError);
  });

  it('recognizes_expired_key_body', () => {
    expect(isKeyExpiredBody({ error: { code: 'api_key_expired' } })).toBe(true);
    expect(isKeyExpiredBody({ error: { code: 'invalid' } })).toBe(false);
  });
});
