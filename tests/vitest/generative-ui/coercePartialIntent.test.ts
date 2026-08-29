import { describe, it, expect } from 'vitest';
import { coercePartialIntent } from '@/features/generative-ui/utils/coercePartialIntent';
import { parseGenerativeUIIntentRecovered, MAX_GENERATIVE_UI_BLOCKS } from '@/features/generative-ui/schema';
import { STREAM_BUFFER_CAPPED_WARNING } from '@/features/generative-ui/utils/streamBufferGuard';

describe('coercePartialIntent', () => {
  it('returns empty result for blank input', () => {
    expect(coercePartialIntent('')).toMatchObject({
      intent: null,
      dropped: 0,
      truncated: false,
    });
  });

  it('fails closed before parsing a stream over the character cap', () => {
    const result = coercePartialIntent('x'.repeat(129), 128);
    expect(result).toEqual({
      intent: null,
      dropped: 0,
      truncated: true,
      warnings: [STREAM_BUFFER_CAPPED_WARNING],
    });
  });

  it('extracts closed blocks from truncated JSON', () => {
    const partial =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"keep-me"}},{"type":"stat-card","props":{"title":"T","value":';
    const result = coercePartialIntent(partial);
    expect(result.intent?.blocks).toHaveLength(1);
    expect(result.intent?.blocks[0]?.type).toBe('text');
    expect(result.dropped).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it('drops illegal blocks and keeps legal ones', () => {
    const raw = JSON.stringify({
      version: '1',
      blocks: [
        { type: 'text', props: { body: 'ok' } },
        { type: '', props: {} },
        { props: { body: 'missing-type' } },
        { type: 'stat-card', props: { title: 'Due', value: 2 } },
      ],
    });
    const result = coercePartialIntent(raw);
    expect(result.intent?.blocks.map((b) => b.type)).toEqual(['text', 'stat-card']);
    expect(result.dropped).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('keeps first occurrence when ids are duplicated', () => {
    const raw = JSON.stringify({
      version: '1',
      blocks: [
        { type: 'text', id: 'dup', props: { body: 'first' } },
        { type: 'text', id: 'dup', props: { body: 'second' } },
      ],
    });
    const result = coercePartialIntent(raw);
    expect(result.intent?.blocks).toHaveLength(1);
    expect(result.intent?.blocks[0]?.props?.body).toBe('first');
    expect(result.dropped).toBe(1);
    expect(result.warnings.some((w) => w.startsWith('duplicate-id'))).toBe(true);
  });

  it('truncates blocks beyond the schema max of 32', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => ({
      type: 'text',
      id: `b-${i}`,
      props: { body: `n-${i}` },
    }));
    const result = coercePartialIntent(JSON.stringify({ version: '1', blocks }));
    expect(result.intent?.blocks).toHaveLength(MAX_GENERATIVE_UI_BLOCKS);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain('blocks-truncated');
    expect(result.intent?.blocks[0]?.id).toBe('b-0');
    expect(result.intent?.blocks[31]?.id).toBe('b-31');
  });

  it('keeps unknown types that still satisfy the block schema', () => {
    const result = coercePartialIntent(
      '{"version":"1","blocks":[{"type":"unknown-widget","props":{}}]}',
    );
    expect(result.intent?.blocks).toHaveLength(1);
    expect(result.intent?.blocks[0]?.type).toBe('unknown-widget');
    expect(result.dropped).toBe(0);
  });

  it('strips markdown fences before recovery', () => {
    const fenced = '```json\n{"version":"1","blocks":[{"type":"text","props":{"body":"fenced"}}]}\n```';
    const result = coercePartialIntent(fenced);
    expect(result.intent?.blocks[0]?.props?.body).toBe('fenced');
    expect(result.truncated).toBe(false);
  });
});

describe('parseGenerativeUIIntentRecovered', () => {
  it('recovers valid blocks from a complete but mixed document', () => {
    const result = parseGenerativeUIIntentRecovered({
      version: '1',
      blocks: [{ type: 'text', props: { body: 'ok' } }, { type: '' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.blocks).toHaveLength(1);
      expect(result.dropped).toBe(1);
    }
  });

  it('fails closed when JSON is not parseable', () => {
    const result = parseGenerativeUIIntentRecovered('{ not-json');
    expect(result.ok).toBe(false);
  });
});
