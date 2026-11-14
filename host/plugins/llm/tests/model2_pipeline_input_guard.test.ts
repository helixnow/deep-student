import { describe, expect, it } from 'vitest';
import {
  checkRequestInputBudget, chatMessagesRequireMultimodal, deepseekV41ImageTokens,
  effectiveRequestInputLimit, estimateRequestInputTokens, inlineImageTokenBudget,
  awaitVisualObservationOrCancel,
  type CancellableFuture, type LegacyChatMessageLike,
} from '../src/input_guard.ts';
import { llmErrorCode, classifyLlmError, LLM_ERROR_CODE_COMPACTION_REQUIRED,
  LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED } from '../src/routing.ts';
import { makeConfig } from './support.ts';
import { imageDataUrl } from './png_fixture.ts';

const baseConfig = () => makeConfig();
const errorOf = (result: ReturnType<typeof checkRequestInputBudget>) => {
  if (result === null) throw new Error('expected an AppError');
  return result;
};
const budgetOf = (error: ReturnType<typeof errorOf>) =>
  (error.details as { budget: { stage: string } }).budget;
const detailsOf = (error: ReturnType<typeof errorOf>) =>
  error.details as Record<string, unknown>;

function messageWithModalFields(
  imagePaths: string[] | null,
  imageBase64: string[] | null,
  multimodal: LegacyChatMessageLike['multimodal_content'],
): LegacyChatMessageLike {
  return {
    role: 'user', content: 'hi',
    image_paths: imagePaths, image_base64: imageBase64, multimodal_content: multimodal,
  };
}

describe('llm_manager/model2_pipeline.rs', () => {
  it('request_preflight_compacts_at_eighty_five_percent_without_mutation', () => {
    const config = baseConfig();
    const request = {
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'input '.repeat(1000) },
      ],
    };
    const original = structuredClone(request);
    const used = estimateRequestInputTokens(request, config);
    const limit = Math.trunc(used * 100 / 85);
    const error = errorOf(checkRequestInputBudget(request, limit, config, true));
    expect(llmErrorCode(error)).toBe(LLM_ERROR_CODE_COMPACTION_REQUIRED);
    expect(classifyLlmError(error)).toBe('NonRetryable');
    expect(checkRequestInputBudget(request, limit, config, false)).toBeNull();
    expect(checkRequestInputBudget(request, used * 2, config, true)).toBeNull();
    expect(request).toEqual(original);
  });

  it('request_preflight_counts_tools_system_and_current_attachment', () => {
    const config = baseConfig();
    const history = { messages: [{ role: 'user', content: 'short history' }] };
    expect(checkRequestInputBudget(history, 10_000, config, true)).toBeNull();
    const requests = [
      {
        messages: [
          { role: 'system', content: 'system '.repeat(12_000) },
          { role: 'user', content: 'short history' },
        ],
      },
      {
        messages: history.messages,
        tools: [{ description: 'schema '.repeat(12_000) }],
      },
      {
        messages: [
          { role: 'user', content: 'short history' },
          { role: 'user', content: 'attachment '.repeat(12_000) },
        ],
      },
    ];
    for (const request of requests) {
      const original = structuredClone(request);
      const compact = errorOf(checkRequestInputBudget(request, 10_000, config, true));
      expect(llmErrorCode(compact)).toBe(LLM_ERROR_CODE_COMPACTION_REQUIRED);
      const overflow = errorOf(checkRequestInputBudget(request, 10_000, config, false));
      expect(llmErrorCode(overflow)).toBe(LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED);
      expect(request).toEqual(original);
    }
  });

  it('request_preflight_stops_instead_of_dropping_turns_or_tool_payloads', () => {
    const config = baseConfig();
    const request = {
      messages: [
        { role: 'user', content: '<compacted_context>anchor</compacted_context>' },
        { role: 'user', content: 'old '.repeat(2_000) },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'middle '.repeat(2_000) },
        { role: 'assistant', content: 'middle answer' },
        { role: 'user', content: 'current' },
        { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'fetch', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'tool output '.repeat(4_000) },
        {
          role: 'user',
          content: [
            { type: 'text', text: '<retrieval_page_images>pages</retrieval_page_images>' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          ],
        },
      ],
    };
    const original = structuredClone(request);
    const error = errorOf(checkRequestInputBudget(request, 2_000, config, false));
    expect(llmErrorCode(error)).toBe(LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED);
    expect(request).toEqual(original);
  });

  it('request_preflight_respects_model_downsize_and_input_override', () => {
    let config = makeConfig({
      id: 'actual-small-model', contextWindow: 100_000, maxOutputTokens: 8_000,
    });
    const request = { messages: [{ role: 'user', content: 'input '.repeat(10_000) }] };
    expect(checkRequestInputBudget(
      request, effectiveRequestInputLimit(config, null), config, true,
    )).toBeNull();
    config = { ...config, contextWindow: 16_000 };
    const error = errorOf(checkRequestInputBudget(
      request, effectiveRequestInputLimit(config, 1_000_448), config, true,
    ));
    expect(detailsOf(error).compaction_model_id).toBe('actual-small-model');
    expect(detailsOf(error).input_limit).toBe(8_000);
    expect(checkRequestInputBudget(request, 0, config, false)).not.toBeNull();
  });

  it('input_limit_never_zero_when_output_reserve_fills_window', () => {
    const unknownWindow = makeConfig({ maxOutputTokens: 32_768 });
    expect(effectiveRequestInputLimit(unknownWindow, null)).toBe(16_384);
    expect(effectiveRequestInputLimit(unknownWindow, 90_000)).toBe(16_384);

    const outputExceedsWindow = makeConfig({ contextWindow: 32_000, maxOutputTokens: 65_536 });
    expect(effectiveRequestInputLimit(outputExceedsWindow, null)).toBe(16_000);

    const normal = makeConfig({ contextWindow: 128_000, maxOutputTokens: 8_192 });
    expect(effectiveRequestInputLimit(normal, null)).toBe(119_808);
    expect(effectiveRequestInputLimit(normal, 50_000)).toBe(50_000);
  });

  it('modality_detection_covers_all_supported_image_fields', () => {
    expect(chatMessagesRequireMultimodal([messageWithModalFields(null, null, null)])).toBe(false);
    expect(chatMessagesRequireMultimodal([messageWithModalFields(['image.png'], null, null)])).toBe(true);
    expect(chatMessagesRequireMultimodal([messageWithModalFields(null, ['bytes'], null)])).toBe(true);
    expect(chatMessagesRequireMultimodal([messageWithModalFields(null, null, [
      { type: 'image_url', mediaType: 'image/png', base64: 'bytes' },
    ])])).toBe(true);
  });

  it('deepseek_v41_image_projection_matches_published_grid_examples', () => {
    expect(deepseekV41ImageTokens(544, 544)).toBe(184);
    expect(deepseekV41ImageTokens(1_000, 1_000)).toBe(602);
    expect(deepseekV41ImageTokens(8_000, 6_000)).toBeLessThanOrEqual(1_024);
  });

  it('input_guard_preserves_history_images_until_compaction', () => {
    const current = {
      role: 'user',
      content: [
        { type: 'text', text: 'current question' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } },
      ],
    };
    const body = {
      messages: [
        { role: 'system', content: 'rules' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,old' } }],
        },
        { role: 'assistant', content: 'old answer' },
        current,
      ],
    };
    const original = structuredClone(body);
    const error = errorOf(checkRequestInputBudget(body, 9_000, baseConfig(), true));
    expect(body).toEqual(original);
    expect(llmErrorCode(error)).toBe(LLM_ERROR_CODE_COMPACTION_REQUIRED);
    expect(body.messages[3]).toEqual(current);
    expect((body.messages[1]!.content as { type: string }[])[0]!.type).toBe('image_url');
  });

  it('chat_input_guard_reports_overflow_without_truncating_current_text_or_tools', () => {
    const body = {
      messages: [
        { role: 'user', content: 'current question '.repeat(3_000) },
        {
          role: 'tool', tool_call_id: 'call_1',
          content: JSON.stringify({ source: 'abc'.repeat(10_000) }),
        },
      ],
    };
    const original = structuredClone(body);
    const error = errorOf(checkRequestInputBudget(body, 1_000, baseConfig(), false));
    expect(body).toEqual(original);
    expect(llmErrorCode(error)).toBe(LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED);
    expect(budgetOf(error).stage).toBe('input_guard');
  });

  it('deepseek_v41_image_budget_is_scoped_to_official_vision_models', () => {
    const cases: Array<[string, string, boolean]> = [
      ['https://api.deepseek.com/v1', 'deepseek-flash', true],
      ['https://api.deepseek.com/v1', 'deepseek-v4-flash-vision-exp', true],
      ['https://api.deepseek.com/v1', 'deepseek-v4-flash', false],
      ['https://api.deepseek.com/v1', 'deepseek-v4-pro', false],
      ['https://api.siliconflow.cn/v1', 'deepseek-flash', false],
      ['https://proxy.example/api.deepseek.com', 'deepseek-flash', false],
      ['https://api.openai.com/v1', 'gpt-4o', false],
    ];
    const url = imageDataUrl(544, 544);
    for (const [baseUrl, model, usesProjection] of cases) {
      const config = makeConfig({ baseUrl, model, providerType: 'deepseek' });
      const request = {
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url } }],
        }],
      };
      const result = checkRequestInputBudget(request, 2_000, config, false);
      expect(result === null, `${baseUrl}: ${model}`).toBe(usesProjection);
    }
  });

  it('deepseek_v41_budget_uses_decoded_image_geometry_and_keeps_bad_data_conservative', () => {
    const request = {
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: imageDataUrl(1, 1) } }],
      }],
    };
    expect(inlineImageTokenBudget(request)).toEqual([184, 0]);
    expect(inlineImageTokenBudget('data:image/png;base64,not-base64')).toEqual([0, 1]);
  });

  it('visual_observation_cancellation_drops_the_provider_future', async () => {
    const controller = new AbortController();
    let droppedByCancel = false;
    const future: CancellableFuture<string> = {
      promise: new Promise<string>(() => { /* 永不 settle：只能靠 cancel 丢弃 */ }),
      cancel: () => { droppedByCancel = true; },
    };
    const pending = awaitVisualObservationOrCancel(controller.signal, future);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('cancelled') });
    expect(droppedByCancel).toBe(true);
  });
});
