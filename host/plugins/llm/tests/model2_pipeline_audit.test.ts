import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PROMPT_CACHE_KEY, providerAcceptsPromptCacheKey, stablePromptCacheKey,
} from '../src/prompt_cache.ts';
import {
  redactSkillInstructionBlocksInText, redactUserProfileBlocksInText,
  sanitizeRequestBodyForAudit, sanitizeUrlForLog,
} from '../src/audit.ts';
import { makeConfig } from './support.ts';

describe('llm_manager/model2_pipeline.rs', () => {
  it('prompt_cache_key_is_stable_and_never_random', () => {
    expect(stablePromptCacheKey('sess_123')).toBe('sess_123');
    expect(stablePromptCacheKey('  sess_123  ')).toBe('sess_123');
    expect(stablePromptCacheKey('translation')).toBe('translation');
    expect(stablePromptCacheKey(null)).toBe(FALLBACK_PROMPT_CACHE_KEY);
    expect(stablePromptCacheKey('   ')).toBe(FALLBACK_PROMPT_CACHE_KEY);
    expect(stablePromptCacheKey(null)).toBe(stablePromptCacheKey(null));
  });

  it('prompt_cache_key_only_targets_openai_affinity_endpoints', () => {
    const openaiOfficial = makeConfig({
      providerType: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    });
    expect(providerAcceptsPromptCacheKey(openaiOfficial)).toBe(true);

    const responsesGateway = makeConfig({
      modelAdapter: 'general', model: 'gpt-4o-mini', supportsOpenaiResponses: true,
    });
    expect(providerAcceptsPromptCacheKey(responsesGateway)).toBe(true);

    const deepseekOfficial = makeConfig({
      providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash',
    });
    expect(providerAcceptsPromptCacheKey(deepseekOfficial)).toBe(false);

    const thirdPartyCc = makeConfig({
      baseUrl: 'https://gateway.example.com/v1', model: 'some-model',
    });
    expect(providerAcceptsPromptCacheKey(thirdPartyCc)).toBe(false);
  });

  it('test_redact_user_profile_blocks_in_text', () => {
    const input = 'A<user_profile>\nsecret\n</user_profile>B';
    const redacted = redactUserProfileBlocksInText(input);
    expect(redacted).toContain('<user_profile>[REDACTED]</user_profile>');
    expect(redacted.includes('secret')).toBe(false);
  });

  it('redacts unterminated profile and skill blocks conservatively', () => {
    expect(redactUserProfileBlocksInText('A<user_profile>secret')).toBe(
      'A[REDACTED:user_profile]',
    );
    expect(redactSkillInstructionBlocksInText('A<skill_instructions id="x">secret')).toBe(
      'A[REDACTED:skill_instructions]',
    );
  });

  it('test_sanitize_url_for_log_redacts_query_keys', () => {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse&key=AIzaSySECRET123';
    const sanitized = sanitizeUrlForLog(url);
    expect(sanitized.includes('AIzaSySECRET123')).toBe(false);
    expect(sanitized).toContain('key=[REDACTED]');
    expect(sanitized).toContain('alt=sse');

    const plain = 'https://api.openai.com/v1/chat/completions';
    expect(sanitizeUrlForLog(plain)).toBe(plain);

    const mixed = 'https://x.example/api?API_KEY=abc&access_token=tok&foo=bar';
    const s = sanitizeUrlForLog(mixed);
    expect(s.includes('API_KEY=abc')).toBe(false);
    expect(s.includes('access_token=tok')).toBe(false);
    expect(s).toContain('API_KEY=[REDACTED]');
    expect(s).toContain('access_token=[REDACTED]');
    expect(s).toContain('foo=bar');
  });

  it('test_sanitize_request_body_for_audit_redacts_user_profile', () => {
    const body = {
      messages: [{
        role: 'system',
        content: 'prefix <user_profile>very sensitive</user_profile> suffix',
      }],
    };
    const sanitized = sanitizeRequestBodyForAudit(body);
    const content = (sanitized as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(content).toContain('[REDACTED]');
    expect(content.includes('very sensitive')).toBe(false);
  });

  it('test_sanitize_request_body_for_audit_redacts_skill_instructions', () => {
    const body = {
      messages: [{
        role: 'user',
        content: 'prefix <skill_instructions id="secret-skill">private skill text</skill_instructions> suffix',
      }],
    };
    const sanitized = sanitizeRequestBodyForAudit(body);
    const content = (sanitized as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(content).toContain(
      '<skill_instructions id="secret-skill">[REDACTED]</skill_instructions>',
    );
    expect(content.includes('private skill text')).toBe(false);
  });

  it('audit_sanitizer_redacts_responses_images_and_encrypted_reasoning', () => {
    const body = {
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,c2VjcmV0' }],
      }],
      include: ['reasoning.encrypted_content'],
      encrypted_content: 'provider-secret-state',
    };
    const sanitized = JSON.stringify(sanitizeRequestBodyForAudit(body));
    expect(sanitized.includes('c2VjcmV0')).toBe(false);
    expect(sanitized.includes('provider-secret-state')).toBe(false);
    expect(sanitized).toContain('embedded_binary');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('audit_sanitizer_redacts_base64_data_urls_and_secret_fields', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Bearer abcdefghijklmnop and sk-1234567890abcdef' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }],
      payload: 'data:image/png;base64,AAAA',
      api_key: 'sk-secret',
      tools: [{ type: 'function', function: { name: 'alpha' } }],
    };
    const sanitized = sanitizeRequestBodyForAudit(body) as Record<string, unknown>;
    const serialized = JSON.stringify(sanitized);
    expect(serialized.includes('abcdefghijklmnop')).toBe(false);
    expect(serialized.includes('sk-1234567890abcdef')).toBe(false);
    expect(sanitized.api_key).toBe('[REDACTED]');
    expect(serialized).toContain('base64 data:');
    expect((sanitized.tools as Array<Record<string, unknown>>)[0]!._summary)
      .toBe('1 tools: [alpha]');
  });
});
