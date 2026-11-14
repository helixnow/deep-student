import { describe, expect, it } from 'vitest';
import type { ChatMessage, MessageBlock } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import {
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, effectiveUsableTokens, estimateJsonTokens,
  estimateMessageTokens, shouldCompact, shouldCompactAfterTool, TRIGGER_RATIO, usableTokens,
} from '../src/compaction-budget.ts';
import type { CompactionTriggerState } from '../src/compaction-budget.ts';

function makeConfig(contextWindow: number | null, maxOutputTokens: number) {
  return { model: 'test-model', contextWindow, maxOutputTokens, maxTokensLimit: maxOutputTokens };
}
function makeMsg(id: string): ChatMessage {
  return { id, sessionId: 's1', role: 'assistant', blockIds: [], timestamp: 0 };
}
function makeTextBlock(id: string, messageId: string, content: string): MessageBlock {
  return { id, messageId, type: 'content', status: 'success', content };
}
function makeToolBlock(id: string, messageId: string, name: string,
  input: unknown, output: unknown): MessageBlock {
  return { id, messageId, type: 'mcp_tool', status: 'success', toolName: name, toolInput: input, toolOutput: output };
}
function dummyState(): CompactionTriggerState {
  return {
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, lastRoundPromptTokens: null },
    options: { contextLimit: null },
  };
}

describe('compaction/budget.rs::tests', () => {
  it('usable_tokens_normal_model', () => {
    expect(usableTokens(makeConfig(1_000_000, 128_000))).toBe(872_000);
  });

  it('usable_tokens_small_model_clamps_to_max_output', () => {
    expect(usableTokens(makeConfig(16_000, 4_000))).toBe(12_000);
  });

  it('usable_tokens_zero_context_returns_zero', () => {
    expect(usableTokens(makeConfig(0, 8_192))).toBe(0);
  });

  it('should_compact_triggers_near_threshold', () => {
    const config = makeConfig(100_000, 8_000);
    const usable = usableTokens(config);
    expect(usable).toBe(92_000);
    const threshold = Math.trunc(usable * TRIGGER_RATIO);

    const state = dummyState();
    state.tokenUsage.lastRoundPromptTokens = threshold - 1;
    expect(shouldCompact(state, config)).toBe(false);

    state.tokenUsage.lastRoundPromptTokens = threshold + 1;
    expect(shouldCompact(state, config)).toBe(true);
  });

  it('should_compact_after_tool_accounts_for_delta', () => {
    const config = makeConfig(100_000, 8_000);
    const threshold = Math.trunc(usableTokens(config) * TRIGGER_RATIO);

    const state = dummyState();
    state.tokenUsage.lastRoundPromptTokens = Math.floor(threshold / 2);
    expect(shouldCompactAfterTool(state, config, 100)).toBe(false);

    const bigTool = Math.floor(threshold / 2) + 100;
    expect(shouldCompactAfterTool(state, config, bigTool)).toBe(true);
  });

  it('default_context_window_when_no_config', () => {
    expect(usableTokens(null)).toBe(DEFAULT_CONTEXT_WINDOW - DEFAULT_MAX_OUTPUT);
    expect(usableTokens(null)).toBe(24_576);
  });

  it('estimate_message_tokens_includes_tool_payload', () => {
    const msg = makeMsg('m1');
    const blocks = new Map<string, MessageBlock[]>();

    blocks.set('m1', [makeTextBlock('b1', 'm1', 'hi')]);
    const textOnly = estimateMessageTokens(msg, blocks);

    const mediumOutput = 'lorem ipsum dolor sit amet '.repeat(50);
    blocks.set('m1', [
      makeTextBlock('b1', 'm1', 'hi'),
      makeToolBlock('b2', 'm1', 'web_search', { query: 'test' }, { html: mediumOutput }),
    ]);
    const withTool = estimateMessageTokens(msg, blocks);

    expect(withTool).toBeGreaterThan(textOnly + 50);
  });

  it('effective_usable_tokens_respects_context_limit_and_zero', () => {
    const config = makeConfig(100_000, 8_000);
    expect(effectiveUsableTokens(config, 40_000)).toBe(40_000);
    expect(effectiveUsableTokens(config, 200_000)).toBe(92_000);
    expect(effectiveUsableTokens(config, 0)).toBe(0);
    expect(effectiveUsableTokens(config, null)).toBe(92_000);
    expect(shouldCompact(dummyState(), { ...config, contextWindow: 0 })).toBe(false);
  });

  it('zero_configured_context_skips_compaction_even_with_huge_usage', () => {
    const state = dummyState();
    state.tokenUsage.lastRoundPromptTokens = 1_000_000;
    expect(shouldCompact(state, makeConfig(0, 8_192))).toBe(false);
    expect(shouldCompactAfterTool(state, makeConfig(0, 8_192), 1_000_000)).toBe(false);
  });

  it('image_attachments_are_charged_8192_tokens_each', () => {
    const msg: ChatMessage = {
      ...makeMsg('m1'),
      attachments: [
        { id: 'a1', name: 'a.png', type: 'image', mimeType: 'image/png', size: 1, status: 'success' },
        { id: 'a2', name: 'b.pdf', type: 'file', mimeType: 'application/pdf', size: 1, status: 'success' },
      ],
    };
    expect(estimateMessageTokens(msg, new Map())).toBe(8_192);

    const canonical: ChatMessage = {
      ...makeMsg('m1'),
      _meta: { canonicalContent: [
        { type: 'image_ref', image_id: 'i1', mime_type: 'image/png', pinned: false, retrieval_hit: false },
        { type: 'text', text: 'hello' },
      ] },
      attachments: [
        { id: 'a1', name: 'a.png', type: 'image', mimeType: 'image/png', size: 1, status: 'success' },
      ],
    };
    // canonicalContent wins over attachments when present.
    expect(estimateMessageTokens(canonical, new Map())).toBe(8_192);
  });

  it('estimate_json_tokens_serializes_like_serde_json', () => {
    expect(estimateJsonTokens({ query: 'test' })).toBeGreaterThan(0);
    expect(estimateJsonTokens(null)).toBeGreaterThan(0);
  });
});
