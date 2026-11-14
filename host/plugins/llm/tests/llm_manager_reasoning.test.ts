import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { ApiConfig } from '../api.ts';
import { applyReasoningConfig, type JsonObject } from '../src/question_authoring.ts';
import { makeConfig } from './support.ts';

type JsonMap = { [key: string]: JsonObject };

/** `deepseek_sampling_body`：全套采样参数（含 penalty 与 logprobs）。 */
function deepseekSamplingBody(model: string): JsonObject {
  return {
    model,
    messages: [],
    temperature: 0.7,
    top_p: 0.9,
    presence_penalty: 0.3,
    frequency_penalty: 0.4,
    logprobs: true,
  };
}

// ---------------------------------------------------------------------------
// reasoning_scope_baseline（Rust 同名 mod 的 C1 黄金基线）
// ---------------------------------------------------------------------------

const REASONING_KEYS = new Set([
  'reasoning_effort',
  'reasoning',
  'thinking',
  'thinking_budget',
  'enable_thinking',
  'thinkingConfig',
  'include_thoughts',
  'effort',
  'output_config',
  'reasoning_mode',
  'verbosity',
  'gemini_api_version',
]);

function nonReasoningFields(body: JsonObject): JsonObject {
  const fields: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (!REASONING_KEYS.has(key)) fields[key] = value;
  }
  return fields;
}

/** 带全套可选参数的请求体：涵盖采样参数、penalty、自定义扩展。 */
function matrixBody(model: string): JsonObject {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
    top_p: 0.9,
    presence_penalty: 0.3,
    frequency_penalty: 0.4,
    logprobs: true,
    top_k: 40,
    min_p: 0.05,
    repetition_penalty: 1.05,
    max_tokens: 4096,
    stream: true,
  };
}

interface Sample {
  label: string;
  model: string;
  effort: string | null;
  budget: number | null;
  enableThinking: boolean | null;
}

function sample(
  label: string,
  model: string,
  effort: string | null,
  budget: number | null = null,
  enableThinking: boolean | null = null,
): Sample {
  return { label, model, effort, budget, enableThinking };
}

function samples(): Sample[] {
  return [
    // OpenAI 家族（含 gpt-6 与 gpt-5.6，协议差异在 Phase 2 接入）
    sample('gpt-6-sol', 'gpt-6-sol', 'max'),
    sample('gpt-6-sol/xhigh', 'gpt-6-sol', 'xhigh'),
    sample('gpt-5.6', 'gpt-5.6', 'max'),
    sample('gpt-5.5', 'gpt-5.5', 'max'),
    sample('o3', 'o3', 'high'),
    // Gemini
    sample('gemini-3.8-flash', 'gemini-3.8-flash', 'low'),
    sample('gemini-3.1-pro', 'gemini-3.1-pro-preview', 'low'),
    // Qwen
    sample('qwen3.8-max', 'qwen3.8-max', 'max'),
    sample('qwen3.8-max/low', 'qwen3.8-max', 'low'),
    // GLM
    sample('glm-5.3', 'glm-5.3', 'none'),
    sample('glm-5.2', 'glm-5.2', 'xhigh'),
    // Kimi
    sample('kimi-k3', 'kimi-k3', 'max'),
    sample('kimi-k3/blank', 'kimi-k3', ''),
    // Grok
    sample('grok-4.7', 'grok-4.7', 'xhigh'),
    sample('grok-4.7/unknown', 'grok-4.7', 'turbo'),
    // DeepSeek
    sample('deepseek-v4-pro', 'deepseek-v4-pro', 'max'),
    sample('deepseek-v4-pro/medium', 'deepseek-v4-pro', 'medium'),
    // 其他
    sample('ernie-5', 'ernie-5', 'xhigh'),
    sample('mistral-medium-3.5', 'mistral-medium-3.5', 'max'),
    sample('minimax-m3.1-flash-preview', 'minimax-m3.1-flash-preview', 'max'),
    sample('claude-opus-5', 'claude-opus-5', 'max'),
    // 关闭思考 + 预算兜底形态
    sample('thinking-off', 'gpt-5.6', null, null, false),
    sample('budget-only', 'qwen3.7-max', null, 8192),
  ];
}

function baseConfig(model: string): ApiConfig {
  return makeConfig({
    model,
    isReasoning: true,
    supportsReasoning: true,
    thinkingEnabled: true,
  });
}

function hostConfig(
  model: string,
  providerType: string,
  modelAdapter: string,
  baseUrl: string,
): ApiConfig {
  return makeConfig({
    ...baseConfig(model),
    providerType,
    providerScope: providerType,
    modelAdapter,
    baseUrl,
  });
}

function applySample(current: Sample, config: ApiConfig): JsonObject {
  const body = matrixBody(config.model);
  const effective: ApiConfig = {
    ...config,
    reasoningEffort: current.effort,
    thinkingBudget: current.budget,
    ...(current.enableThinking === null ? {} : { enableThinking: current.enableThinking }),
  };
  applyReasoningConfig(body, effective, null);
  return body;
}

/** 各宿主的配置构造器：(标签, 构造闭包)。 */
function hosts(): Array<[string, (model: string) => ApiConfig]> {
  return [
    ['official-openai', (model) => hostConfig(model, 'openai', 'openai', 'https://api.openai.com/v1')],
    ['official-openai/responses', (model) => ({
      ...hostConfig(model, 'openai', 'openai', 'https://api.openai.com/v1'),
      apiProtocol: 'openai_responses',
    })],
    ['official-deepseek', (model) => hostConfig(model, 'deepseek', 'deepseek', 'https://api.deepseek.com/v1')],
    ['official-anthropic', (model) => hostConfig(model, 'anthropic', 'anthropic', 'https://api.anthropic.com')],
    ['official-gemini', (model) => hostConfig(model, 'google', 'google', 'https://generativelanguage.googleapis.com')],
    ['official-qwen', (model) => hostConfig(model, 'qwen', 'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1')],
    ['official-zhipu', (model) => hostConfig(model, 'zhipu', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4')],
    ['official-moonshot', (model) => hostConfig(model, 'moonshot', 'moonshot', 'https://api.moonshot.cn/v1')],
    ['official-grok', (model) => hostConfig(model, 'grok', 'grok', 'https://api.x.ai/v1')],
    ['custom-relay', (model) => hostConfig(model, 'custom', 'general', 'https://relay.example.com/v1')],
    ['siliconflow', (model) => hostConfig(model, 'siliconflow', 'general', 'https://api.siliconflow.cn/v1')],
    ['openrouter', (model) => hostConfig(model, 'openrouter', 'general', 'https://openrouter.ai/api/v1')],
  ];
}

function baselinePath(): URL {
  return new URL(
    '../../../../tests/fixtures/reasoning/non_reasoning_fields_baseline.json',
    import.meta.url,
  );
}

function stableJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function describeFieldDiffs(expected: JsonObject, actual: JsonObject): string[] {
  const diffs: string[] = [];
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, field)) {
      diffs.push(`    ${field}: ${stableJson(expectedValue)} -> <removed>`);
    } else if (stableJson(actual[field]) !== stableJson(expectedValue)) {
      diffs.push(
        `    ${field}: ${stableJson(expectedValue)} -> ${stableJson(actual[field])}`,
      );
    }
  }
  for (const [field, actualValue] of Object.entries(actual)) {
    if (!Object.hasOwn(expected, field)) {
      diffs.push(`    ${field}: <absent> -> ${stableJson(actualValue)}`);
    }
  }
  return diffs;
}

describe('llm_manager/mod.rs', () => {
  it('apply_reasoning_config_removes_official_v4_thinking_ignored_sampling_params', () => {
    const body = deepseekSamplingBody('deepseek-v4-pro');
    const config = makeConfig({
      providerType: 'deepseek',
      providerScope: 'deepseek',
      modelAdapter: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1',
      supportsReasoning: true,
      isReasoning: true,
      thinkingEnabled: true,
      enableThinking: true,
    });

    applyReasoningConfig(body, config, null);

    for (const key of ['temperature', 'presence_penalty', 'frequency_penalty']) {
      expect(Object.hasOwn(body, key), `${key} should be removed`).toBe(false);
    }
    expect(body.top_p).toBe(0.95);
    expect(typeof body.thinking === 'object' && body.thinking !== null
      ? (body.thinking as JsonObject).type
      : undefined).toBe('enabled');
  });

  it('apply_reasoning_config_removes_future_siliconflow_v4_thinking_ignored_sampling_params', () => {
    const body = deepseekSamplingBody('deepseek-ai/DeepSeek-V4-Pro');
    const config = makeConfig({
      providerType: 'siliconflow',
      providerScope: 'deepseek',
      modelAdapter: 'deepseek',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      baseUrl: 'https://api.siliconflow.cn/v1',
      supportsReasoning: true,
      isReasoning: true,
      thinkingEnabled: true,
      enableThinking: true,
      reasoningEffort: 'max',
      thinkingBudget: 4096,
    });

    applyReasoningConfig(body, config, null);

    for (const key of [
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
      'logprobs',
    ]) {
      expect(Object.hasOwn(body, key), `${key} should be removed`).toBe(false);
    }
    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBe('max');
    expect(Object.hasOwn(body, 'thinking_budget')).toBe(false);
    expect(Object.hasOwn(body, 'thinking')).toBe(false);
  });

  it('apply_reasoning_config_maps_siliconflow_v32_depth_to_budget', () => {
    const body = deepseekSamplingBody('deepseek-ai/DeepSeek-V3.2');
    const config = makeConfig({
      providerType: 'siliconflow',
      providerScope: 'siliconflow',
      modelAdapter: 'deepseek',
      model: 'deepseek-ai/DeepSeek-V3.2',
      baseUrl: 'https://api.siliconflow.cn/v1',
      supportsReasoning: true,
      isReasoning: true,
      thinkingEnabled: true,
      enableThinking: true,
      reasoningEffort: 'xhigh',
    });

    applyReasoningConfig(body, config, null);

    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(32768);
    expect(Object.hasOwn(body, 'reasoning_effort')).toBe(false);
  });

  it('reasoning_scope_baseline::non_reasoning_fields_stay_byte_identical_across_matrix', () => {
    const current: JsonMap = {};

    for (const [hostLabel, build] of hosts()) {
      for (const currentSample of samples()) {
        const config = build(currentSample.model);
        const body = applySample(currentSample, config);
        current[`${hostLabel}::${currentSample.label}`] = nonReasoningFields(body);
      }
    }

    const raw = readFileSync(baselinePath(), 'utf8');
    const baseline = JSON.parse(raw) as JsonMap;

    const diffs: string[] = [];
    for (const [key, expected] of Object.entries(baseline)) {
      const actual = current[key];
      if (actual === undefined) {
        diffs.push(`${key}: sample missing in current run`);
        continue;
      }
      if (stableJson(actual) !== stableJson(expected)) {
        diffs.push(`${key}:\n${describeFieldDiffs(expected, actual).join('\n')}`);
      }
    }
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(baseline, key)) diffs.push(`${key}: new sample not in baseline`);
    }

    expect(diffs.join('\n'), `C1 violated — non-reasoning request fields changed:\n${diffs.join('\n')}`)
      .toBe('');
  });

  it('apply_reasoning_config_keeps_siliconflow_v32_sampling_params', () => {
    const body = deepseekSamplingBody('deepseek-ai/DeepSeek-V3.2');
    const config = makeConfig({
      providerType: 'siliconflow',
      providerScope: 'deepseek',
      modelAdapter: 'deepseek',
      model: 'deepseek-ai/DeepSeek-V3.2',
      baseUrl: 'https://api.siliconflow.cn/v1',
      supportsReasoning: true,
      isReasoning: true,
      thinkingEnabled: true,
      enableThinking: true,
      thinkingBudget: 4096,
    });

    applyReasoningConfig(body, config, null);

    for (const key of [
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
    ]) {
      expect(Object.hasOwn(body, key), `${key} should be preserved`).toBe(true);
    }
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(4096);
    expect(Object.hasOwn(body, 'thinking')).toBe(false);
    expect(Object.hasOwn(body, 'reasoning_effort')).toBe(false);
  });
});
