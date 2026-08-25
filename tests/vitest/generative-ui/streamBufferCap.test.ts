import { describe, it, expect, beforeEach } from 'vitest';
import {
  GenerativeUIStreamParser,
  tryParsePartialIntent,
} from '@/features/generative-ui/parser';
import {
  appendGenerativeUIStreamContent,
  clearGenerativeUIStreamRegistry,
  finalizeGenerativeUIStream,
  getLastGoodGenerativeUIIntent,
} from '@/features/generative-ui/bridge/generativeUIStreamRegistry';
import {
  MAX_GENERATIVE_UI_STREAM_CHARS,
  STREAM_BUFFER_CAPPED_WARNING,
  guardStreamBufferAppend,
  isSerializedStreamValueOverCap,
  isStreamBufferOverCap,
} from '@/features/generative-ui/utils/streamBufferGuard';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

const LAST_GOOD_PREFIX =
  '{"version":"1","blocks":[{"type":"text","props":{"body":"keep"}}';
/** CI shard 上不要分配 256KiB 大串；parser/registry/schema 走可注入上限。 */
const TEST_STREAM_CAP = 128;

describe('streamBufferGuard', () => {
  it('exposes the 256_000 character hard cap', () => {
    expect(MAX_GENERATIVE_UI_STREAM_CHARS).toBe(256_000);
  });

  it('accepts short chunks under the cap', () => {
    expect(guardStreamBufferAppend(10, 'hello', 100)).toEqual({
      accepted: 'hello',
      capped: false,
    });
  });

  it('accepts a chunk that exactly fills the remaining budget', () => {
    expect(guardStreamBufferAppend(8, 'ab', 10)).toEqual({
      accepted: 'ab',
      capped: false,
    });
  });

  it('rejects a chunk that would exceed the cap without taking a prefix', () => {
    expect(guardStreamBufferAppend(8, 'abc', 10)).toEqual({
      accepted: '',
      capped: true,
    });
  });

  it('rejects further appends once current length is already at the cap', () => {
    expect(guardStreamBufferAppend(10, 'x', 10)).toEqual({
      accepted: '',
      capped: true,
    });
  });

  it('does not treat an empty poll at exactly the cap as overflow', () => {
    expect(guardStreamBufferAppend(10, '', 10)).toEqual({
      accepted: '',
      capped: false,
    });
  });

  it('isStreamBufferOverCap is exclusive of the limit', () => {
    expect(isStreamBufferOverCap(MAX_GENERATIVE_UI_STREAM_CHARS)).toBe(false);
    expect(isStreamBufferOverCap(MAX_GENERATIVE_UI_STREAM_CHARS + 1)).toBe(true);
  });

  it('measures serialized object size without allocating a JSON copy', () => {
    const intent = {
      version: '1',
      blocks: [{ type: 'text', props: { body: 'plain text' } }],
    };
    const serializedLength = JSON.stringify(intent).length;

    expect(isSerializedStreamValueOverCap(intent, serializedLength)).toBe(false);
    expect(isSerializedStreamValueOverCap(intent, serializedLength - 1)).toBe(true);
  });

  it('counts JSON escapes when guarding object payloads', () => {
    const escapedBody = '\u0000'.repeat(Math.ceil(TEST_STREAM_CAP / 6));
    const intent = {
      version: '1',
      blocks: [{ type: 'text', props: { body: escapedBody } }],
    };

    expect(escapedBody.length).toBeLessThan(TEST_STREAM_CAP);
    expect(isSerializedStreamValueOverCap(intent, TEST_STREAM_CAP)).toBe(true);
  });
});

describe('GenerativeUIStreamParser stream-buffer-capped', () => {
  it('leaves existing short streams unchanged', () => {
    const parser = new GenerativeUIStreamParser();
    const snap = parser.appendChunk(
      '{"version":"1","blocks":[{"type":"text","props":{"body":"ok"}}]}',
    );
    expect(snap.warnings).not.toContain(STREAM_BUFFER_CAPPED_WARNING);
    expect(snap.intent?.blocks[0]?.props?.body).toBe('ok');
    expect(snap.phase).toBe('streaming');
  });

  it('stops append, keeps last-good, and records stream-buffer-capped', () => {
    const parser = new GenerativeUIStreamParser(TEST_STREAM_CAP);
    parser.appendChunk(LAST_GOOD_PREFIX);
    const before = parser.getBuffer();

    const snap = parser.appendChunk('x'.repeat(TEST_STREAM_CAP));
    expect(snap.warnings).toContain(STREAM_BUFFER_CAPPED_WARNING);
    expect(snap.phase).toBe('overflow');
    expect(snap.intent?.blocks[0]?.props?.body).toBe('keep');
    expect(parser.getBuffer()).toBe(before);
    expect(snap.bufferLength).toBe(before.length);
    expect(snap.bufferLength).toBeLessThanOrEqual(TEST_STREAM_CAP);
  });

  it('ignores later chunks after the buffer is capped', () => {
    const parser = new GenerativeUIStreamParser(TEST_STREAM_CAP);
    parser.appendChunk(LAST_GOOD_PREFIX);
    parser.appendChunk('x'.repeat(TEST_STREAM_CAP));
    const frozen = parser.getBuffer();

    const snap = parser.appendChunk(',{"type":"stat-card","props":{"title":"T","value":1}}]');
    expect(parser.getBuffer()).toBe(frozen);
    expect(snap.intent?.blocks).toHaveLength(1);
    expect(snap.warnings).toContain(STREAM_BUFFER_CAPPED_WARNING);
  });

  it('does not ingest a first chunk that already exceeds the cap', () => {
    const parser = new GenerativeUIStreamParser(TEST_STREAM_CAP);
    const snap = parser.appendChunk('x'.repeat(TEST_STREAM_CAP + 1));
    expect(snap.warnings).toContain(STREAM_BUFFER_CAPPED_WARNING);
    expect(snap.phase).toBe('overflow');
    expect(snap.intent).toBeNull();
    expect(parser.getBuffer()).toBe('');
    expect(tryParsePartialIntent('x'.repeat(TEST_STREAM_CAP + 1), TEST_STREAM_CAP)).toBeNull();
  });

  it('finalize after cap still returns last-good', () => {
    const parser = new GenerativeUIStreamParser(TEST_STREAM_CAP);
    parser.appendChunk(LAST_GOOD_PREFIX);
    parser.appendChunk('x'.repeat(TEST_STREAM_CAP));
    expect(parser.finalize()?.blocks[0]?.props?.body).toBe('keep');
  });
});

describe('generativeUIStreamRegistry stream-buffer-capped', () => {
  beforeEach(() => {
    clearGenerativeUIStreamRegistry();
  });

  it('caps overflowing fullContent and keeps last-good', () => {
    const blockId = 'blk-stream-cap';
    const options = { maxChars: TEST_STREAM_CAP };
    appendGenerativeUIStreamContent(blockId, LAST_GOOD_PREFIX, options);
    const overflow = LAST_GOOD_PREFIX + 'x'.repeat(TEST_STREAM_CAP);
    const snap = appendGenerativeUIStreamContent(blockId, overflow, options);

    expect(snap.warnings).toContain(STREAM_BUFFER_CAPPED_WARNING);
    expect(snap.phase).toBe('overflow');
    expect(snap.intent?.blocks[0]?.props?.body).toBe('keep');
    expect(snap.bufferLength).toBe(LAST_GOOD_PREFIX.length);
    expect(getLastGoodGenerativeUIIntent(blockId)?.blocks[0]?.props?.body).toBe('keep');
    expect(finalizeGenerativeUIStream(blockId)?.blocks[0]?.props?.body).toBe('keep');
  });

  it('does not grow the parser buffer on subsequent over-cap appends', () => {
    const blockId = 'blk-stream-cap-sticky';
    const options = { maxChars: TEST_STREAM_CAP };
    appendGenerativeUIStreamContent(blockId, LAST_GOOD_PREFIX, options);
    const first = LAST_GOOD_PREFIX + 'x'.repeat(TEST_STREAM_CAP);
    appendGenerativeUIStreamContent(blockId, first, options);
    const second = first + 'yyyy';
    const snap = appendGenerativeUIStreamContent(blockId, second, options);

    expect(snap.bufferLength).toBe(LAST_GOOD_PREFIX.length);
    expect(snap.warnings).toContain(STREAM_BUFFER_CAPPED_WARNING);
    expect(snap.intent?.blocks[0]?.props?.body).toBe('keep');
  });
});

describe('parseGenerativeUIIntent size cap', () => {
  it('rejects a complete JSON string over the stream character cap', () => {
    const raw = `{"version":"1","blocks":[{"type":"text","props":{"body":"${'x'.repeat(TEST_STREAM_CAP)}"}}]}`;
    const parsed = parseGenerativeUIIntent(raw, TEST_STREAM_CAP);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(STREAM_BUFFER_CAPPED_WARNING);
    }
  });
});
