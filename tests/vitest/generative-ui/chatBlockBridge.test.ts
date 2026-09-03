import { describe, it, expect } from 'vitest';
import {
  extractGenerativeUIIntent,
  GENERATIVE_UI_BLOCK_TYPE,
  normalizeGenerativeUIEndIntent,
} from '@/features/generative-ui/bridge/chatBlockBridge';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { validateBlockProps } from '@/features/generative-ui/schema';

import '@/features/generative-ui/blocks';

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

  it('extracts complete intent from block content when toolOutput missing', () => {
    const result = extractGenerativeUIIntent(null, JSON.stringify(LEARNING_DASHBOARD_EXAMPLE));
    expect(result).not.toBeNull();
    expect(result!.isStreaming).toBe(false);
    if (typeof result!.intent !== 'string') {
      expect(result!.intent.blocks.length).toBeGreaterThan(0);
    }
  });

  it('uses block-level partial parse for incomplete streaming content', () => {
    const partial =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"a"}},{"type":"stat-card","props":{"title":"T","value":1';
    const result = extractGenerativeUIIntent(null, partial);
    expect(result).not.toBeNull();
    expect(result!.isStreaming).toBe(true);
    expect(typeof result!.intent).not.toBe('string');
    if (typeof result!.intent !== 'string') {
      expect(result!.intent.blocks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns null for invalid object intent in toolOutput', () => {
    expect(extractGenerativeUIIntent({ intent: { blocks: 'bad' }, isStreaming: false })).toBeNull();
  });

  it('normalizeGenerativeUIEndIntent validates object intent', () => {
    const normalized = normalizeGenerativeUIEndIntent(LEARNING_DASHBOARD_EXAMPLE);
    expect(normalized).not.toBeNull();
    expect(typeof normalized).not.toBe('string');
  });

  it('recovers intent from toolInput when toolOutput lacks intent (history reload)', () => {
    const result = extractGenerativeUIIntent(
      { status: 'rendered', blockCount: 4 },
      null,
      { intent: LEARNING_DASHBOARD_EXAMPLE },
    );
    expect(result).not.toBeNull();
    expect(result!.isStreaming).toBe(false);
    if (typeof result!.intent !== 'string') {
      expect(result!.intent.meta?.title).toBe('本周学习概览');
    }
  });
});
