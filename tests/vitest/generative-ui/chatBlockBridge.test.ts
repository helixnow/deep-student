import { describe, it, expect } from 'vitest';
import { extractGenerativeUIIntent, GENERATIVE_UI_BLOCK_TYPE } from '@/features/generative-ui/bridge/chatBlockBridge';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';

describe('chatBlockBridge', () => {
  it('exports generative_ui block type constant', () => {
    expect(GENERATIVE_UI_BLOCK_TYPE).toBe('generative_ui');
  });

  it('extracts object intent from toolOutput', () => {
    const result = extractGenerativeUIIntent({
      intent: LEARNING_DASHBOARD_EXAMPLE,
      isStreaming: false,
    });
    expect(result).not.toBeNull();
    expect(result!.isStreaming).toBe(false);
    if (typeof result!.intent !== 'string') {
      expect(result!.intent.meta?.title).toBe('本周学习概览');
    }
  });

  it('extracts string intent from toolOutput', () => {
    const result = extractGenerativeUIIntent({
      intent: JSON.stringify(LEARNING_DASHBOARD_EXAMPLE),
    });
    expect(result).not.toBeNull();
    if (typeof result!.intent !== 'string') {
      expect(result!.intent.blocks.length).toBeGreaterThan(0);
    }
  });

  it('returns null for invalid toolOutput', () => {
    expect(extractGenerativeUIIntent(null)).toBeNull();
    expect(extractGenerativeUIIntent({})).toBeNull();
  });

  it('extracts streaming intent from block content when toolOutput missing', () => {
    const result = extractGenerativeUIIntent(null, JSON.stringify(LEARNING_DASHBOARD_EXAMPLE));
    expect(result).not.toBeNull();
    expect(result!.isStreaming).toBe(true);
  });
});
