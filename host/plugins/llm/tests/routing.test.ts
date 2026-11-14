import { describe, expect, it } from 'vitest';
import { AppError } from '../../../platform/errors/api.ts';
import type { FailoverPolicy } from '../api.ts';
import { defaultFailoverPolicy } from '../src/policy.ts';
import { makeConfig } from './support.ts';
import {
  attachLlmErrorCode, classifyLlmError, CooldownTable, isKnownUtilityPurpose,
  modelFallbackAllowed, providerBodyIndicatesContextWindow, resolveFallbackChain,
  resolvePurposeModelId, tagEstablishFailure, supportsRequiredModality,
  resolveEnabledTextModel, buildAttemptPlan, keyFingerprint, failoverToNextAllowed,
  runWithFailover, ESTABLISH_RETRIES_WITHOUT_FALLBACK,
  type FailoverRuntime, type ModelKeySet, type PlannedAttempt,
} from '../src/routing.ts';

const err = (status: number | null, message: string) => tagEstablishFailure(AppError.llm(message), status);
describe('routing.rs', () => {
  it('classify_rate_limited', () => { expect(classifyLlmError(err(429, '模型二API请求失败: 速率限制(429)'))).toBe('RateLimited'); });
  it('classify_auth_failed', () => {
    expect(classifyLlmError(err(401, 'API Key 无效或已过期'))).toBe('AuthFailed');
    expect(classifyLlmError(err(403, 'invalid_api_key'))).toBe('AuthFailed');
  });
  it('classify_403_content_moderation_is_non_retryable', () => {
    expect(classifyLlmError(err(403, '请求被内容审核拒绝'))).toBe('NonRetryable');
    expect(classifyLlmError(err(403, 'model access forbidden'))).toBe('NonRetryable');
  });
  it('classify_5xx_and_network_as_transient', () => {
    expect(classifyLlmError(err(502, '服务端错误'))).toBe('RetryableTransient');
    expect(classifyLlmError(err(null, 'connection timed out'))).toBe('RetryableTransient');
  });
  it('classify_400_as_non_retryable', () => { expect(classifyLlmError(err(400, '参数错误'))).toBe('NonRetryable'); });
  it('classify_untagged_error_as_non_retryable', () => { expect(classifyLlmError(AppError.llm('解析模型二响应失败: unexpected EOF'))).toBe('NonRetryable'); });
  it('classify_cancelled', () => {
    expect(classifyLlmError(AppError.llm('请求已被用户取消'))).toBe('Cancelled');
    expect(classifyLlmError(err(429, '请求已被用户取消'))).toBe('Cancelled');
  });
  it('classify_stable_error_codes', () => {
    expect(classifyLlmError(attachLlmErrorCode(AppError.llm('模型返回空响应，请重试'), 'EMPTY_RESPONSE'))).toBe('RetryableTransient');
    expect(classifyLlmError(attachLlmErrorCode(AppError.llm('HTTP 400 - maximum context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED'))).toBe('NonRetryable');
  });
  it('provider_body_context_window_detection', () => {
    for (const text of ["This model's maximum context length is 128000 tokens", '输入超出最大上下文长度', 'prompt is too long: 200000 tokens']) expect(providerBodyIndicatesContextWindow(text)).toBe(true);
    for (const text of ['invalid model name: gpt-nope', '']) expect(providerBodyIndicatesContextWindow(text)).toBe(false);
  });
  it('cooldown_expires', () => {
    const table = new CooldownTable();
    const now = performance.now();
    table.setUntil('k1', now + 60_000);
    expect(table.isCoolingAt('k1', now)).toBe(true);
    expect(table.isCoolingAt('k1', now + 59_000)).toBe(true);
    expect(table.isCoolingAt('k1', now + 61_000)).toBe(false);
    expect(table.isCoolingAt('k2', now)).toBe(false);
  });
  it('fallback_chain_task_specific_overrides_default', () => {
    const policy = defaultFailoverPolicy();
    policy.defaultFallbacks = ['m-b', 'm-c'];
    policy.taskFallbacks.chat_title = ['m-cheap', 'm-a', 'm-cheap'];
    expect(resolveFallbackChain(policy, 'chat_title', 'm-a')).toEqual(['m-cheap']);
    expect(resolveFallbackChain(policy, 'default', 'm-a')).toEqual(['m-b', 'm-c']);
    expect(resolveFallbackChain(policy, 'default', 'm-b')).toEqual(['m-c']);
  });
  it('model_fallback_gating', () => {
    const policy = defaultFailoverPolicy();
    expect(modelFallbackAllowed(policy, 'BackgroundTask')).toBe(true);
    expect(modelFallbackAllowed(policy, 'ChatMain')).toBe(false);
    policy.autoDegradeChat = true;
    expect(modelFallbackAllowed(policy, 'ChatMain')).toBe(true);
    policy.enabled = false;
    expect(modelFallbackAllowed(policy, 'ChatMain')).toBe(false);
    expect(modelFallbackAllowed(policy, 'BackgroundTask')).toBe(false);
  });
  it('purpose_model_resolution', () => {
    const policy = defaultFailoverPolicy();
    policy.purposeModels = { compaction: 'm-cheap', utility: '  ' };
    expect(resolvePurposeModelId(policy, 'compaction')).toBe('m-cheap');
    expect(resolvePurposeModelId(policy, 'utility')).toBe(null);
    expect(resolvePurposeModelId(policy, 'memory_flush')).toBe(null);
    for (const task of ['compaction', 'memory_flush', 'utility']) expect(isKnownUtilityPurpose(task)).toBe(true);
    expect(isKnownUtilityPurpose('some_random_task')).toBe(false);
  });
  it('text_requests_allow_multimodal_fallbacks_but_images_require_them', () => {
    const text = { isMultimodal: false };
    const multimodal = { isMultimodal: true };
    expect(supportsRequiredModality(text, true)).toBe(false);
    expect(supportsRequiredModality(multimodal, true)).toBe(true);
    for (const required of [false, null]) for (const cfg of [text, multimodal]) expect(supportsRequiredModality(cfg, required)).toBe(true);
  });
  it('enabled_model_resolution_skips_disabled_and_non_text_configs', () => {
    const configs = [
      { id: 'disabled', enabled: false, isEmbedding: false, isReranker: false },
      { id: 'embedding', enabled: true, isEmbedding: true, isReranker: false },
      { id: 'enabled', enabled: true, isEmbedding: false, isReranker: false },
    ];
    expect(resolveEnabledTextModel(configs, ['disabled', 'missing', 'embedding', 'enabled'])?.id).toBe('enabled');
    expect(resolveEnabledTextModel(configs, ['disabled', 'embedding'])).toBe(null);
  });

  const model = (configId: string, vendorId: string, keys: string[]): ModelKeySet => ({ configId, vendorId, keys, allowsEmptyKey: false });
  const models = () => [model('m-a', 'v1', ['key-a1', 'key-a2']), model('m-b', 'v2', ['key-b1'])];
  const pairs = (plan: PlannedAttempt[]) => plan.map(a => [a.modelIdx, a.keyIdx]);
  it('attempt_plan_orders_keys_then_models', () => { expect(pairs(buildAttemptPlan(models(), new CooldownTable(), performance.now()))).toEqual([[0, 0], [0, 1], [1, 0]]); });
  it('attempt_plan_skips_cooling_keys', () => {
    const table = new CooldownTable(); const now = performance.now();
    table.setUntil(keyFingerprint('v1', 'key-a1'), now + 60_000);
    expect(pairs(buildAttemptPlan(models(), table, now))).toEqual([[0, 1], [1, 0]]);
  });
  it('attempt_plan_uses_available_fallback_when_primary_is_all_cooling', () => {
    const table = new CooldownTable(); const now = performance.now();
    for (const key of ['key-a1', 'key-a2']) table.setUntil(keyFingerprint('v1', key), now + 60_000);
    expect(pairs(buildAttemptPlan(models(), table, now))).toEqual([[1, 0]]);
  });
  it('attempt_plan_uses_first_candidate_only_when_all_keys_are_cooling', () => {
    const table = new CooldownTable(); const now = performance.now();
    for (const m of models()) for (const key of m.keys) table.setUntil(keyFingerprint(m.vendorId, key), now + 60_000);
    expect(pairs(buildAttemptPlan(models(), table, now))).toEqual([[0, 0]]);
  });
  it('attempt_plan_skips_empty_primary_key', () => { expect(pairs(buildAttemptPlan([model('m-a', 'v1', ['', 'key-a2']), model('m-b', 'v2', ['key-b1'])], new CooldownTable(), performance.now()))).toEqual([[0, 1], [1, 0]]); });
  it('attempt_plan_skips_empty_fallback_keys', () => { expect(pairs(buildAttemptPlan([model('m-a', 'v1', ['key-a1']), model('m-b', 'v2', [''])], new CooldownTable(), performance.now()))).toEqual([[0, 0]]); });
  it('auth_failed_only_rotates_keys_within_same_model', () => {
    const current = { modelIdx: 0, keyIdx: 0, cooldownKey: 'v1:z' };
    const same = { modelIdx: 0, keyIdx: 1, cooldownKey: 'v1:x' };
    const other = { modelIdx: 1, keyIdx: 0, cooldownKey: 'v2:y' };
    expect(failoverToNextAllowed('AuthFailed', current, same)).toBe(true);
    expect(failoverToNextAllowed('AuthFailed', current, other)).toBe(false);
    for (const cls of ['RetryableTransient', 'RateLimited'] as const) expect(failoverToNextAllowed(cls, current, other)).toBe(true);
    for (const cls of ['NonRetryable', 'Cancelled'] as const) expect(failoverToNextAllowed(cls, current, same)).toBe(false);
  });

  // ---------- Failover 驱动 ----------

  function failoverRuntime(policy: FailoverPolicy): FailoverRuntime {
    return {
      getFailoverPolicy: async () => policy,
      getApiConfigs: async () => [],
      candidateApiKeysFor: async (config) => [config.apiKey],
    };
  }

  async function rejection(run: Promise<unknown>): Promise<AppError> {
    try {
      await run;
    } catch (thrown) {
      return thrown as AppError;
    }
    throw new Error('expected the failover run to fail');
  }

  describe('src-tauri/crates/dstu-llm/src/llm_manager/routing.rs', () => {
    it('disabled_policy_bypasses_retry_and_failover_driver', async () => {
      const policy = defaultFailoverPolicy();
      policy.enabled = false;
      const primary = makeConfig({ id: 'primary', enabled: true, apiKey: 'key-primary' });
      let attempts = 0;

      const error = await rejection(runWithFailover(
        failoverRuntime(policy),
        {
          task: 'utility',
          scenario: 'BackgroundTask',
          userPinned: false,
          attemptsHandle429Internally: false,
          requiredIsMultimodal: null,
        },
        primary,
        async (_config, establishRetries) => {
          attempts += 1;
          expect(establishRetries).toBe(ESTABLISH_RETRIES_WITHOUT_FALLBACK);
          throw err(429, 'rate limited');
        },
      ));

      expect(error.message).toBe('rate limited');
      expect(attempts).toBe(1);
    });

    it('multimodal_request_rejects_text_primary_before_any_attempt', async () => {
      const policy = defaultFailoverPolicy();
      const primary = makeConfig({
        id: 'text-primary', enabled: true, isMultimodal: false, apiKey: 'key-primary',
      });
      let attempts = 0;

      const error = await rejection(runWithFailover(
        failoverRuntime(policy),
        {
          task: 'default',
          scenario: 'ChatMain',
          userPinned: true,
          attemptsHandle429Internally: true,
          requiredIsMultimodal: true,
        },
        primary,
        async () => {
          attempts += 1;
          return undefined;
        },
      ));

      expect(error.message).toContain('能力要求');
      expect(error.message).toBe('模型配置 text-primary 不满足已编译请求的 Some(true) 能力要求');
      expect(attempts).toBe(0);
    });

    it('codex_oauth_bypasses_empty_api_key_plan_and_fallback', async () => {
      const policy = defaultFailoverPolicy();
      const primary = makeConfig({
        id: 'builtin-codex', enabled: true, authMode: 'openai_codex_oauth', apiKey: '',
      });
      let attempts = 0;

      const result = await runWithFailover(
        failoverRuntime(policy),
        {
          task: 'default',
          scenario: 'ChatMain',
          userPinned: true,
          attemptsHandle429Internally: true,
          requiredIsMultimodal: null,
        },
        primary,
        async (config, establishRetries) => {
          attempts += 1;
          expect(config.apiKey).toBe('');
          expect(establishRetries).toBe(ESTABLISH_RETRIES_WITHOUT_FALLBACK);
          return 'oauth-attempted';
        },
      );

      expect(result).toBe('oauth-attempted');
      expect(attempts).toBe(1);
    });
  });
});
