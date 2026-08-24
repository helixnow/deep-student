import { describe, expect, it } from 'vitest';
import { MAX_GENERATIVE_UI_BLOCKS, parseGenerativeUIIntent } from '@/features/generative-ui/schema';
import { classifyGenerativeUIParseErrors } from '@/features/generative-ui/utils/classifyGenerativeUIParseErrors';
import { STREAM_BUFFER_CAPPED_WARNING } from '@/features/generative-ui/utils/streamBufferGuard';

describe('classifyGenerativeUIParseErrors', () => {
  it('maps Invalid JSON / JSON.parse strings to invalid-json', () => {
    expect(
      classifyGenerativeUIParseErrors(['Invalid JSON: Unexpected token']),
    ).toEqual([{ code: 'invalid-json', message: 'Invalid JSON: Unexpected token' }]);

    expect(classifyGenerativeUIParseErrors(['JSON.parse failed at position 0'])).toEqual([
      { code: 'invalid-json', message: 'JSON.parse failed at position 0' },
    ]);

    expect(classifyGenerativeUIParseErrors(['invalid json: unexpected end of data'])).toEqual([
      { code: 'invalid-json', message: 'invalid json: unexpected end of data' },
    ]);
  });

  it('maps version + enum strings to unknown-version', () => {
    expect(classifyGenerativeUIParseErrors(['version: Invalid enum value'])).toEqual([
      { code: 'unknown-version', message: 'version: Invalid enum value' },
    ]);

    expect(classifyGenerativeUIParseErrors(['version: invalid_enum'])).toEqual([
      { code: 'unknown-version', message: 'version: invalid_enum' },
    ]);

    expect(
      classifyGenerativeUIParseErrors([
        'version: Invalid option: expected one of "1"|"1.1"',
      ]),
    ).toEqual([
      {
        code: 'unknown-version',
        message: 'version: Invalid option: expected one of "1"|"1.1"',
      },
    ]);
  });

  it('maps blocks + size-limit strings to too-many-blocks', () => {
    expect(
      classifyGenerativeUIParseErrors(['blocks: Array must contain at most 32 element(s)']),
    ).toEqual([
      {
        code: 'too-many-blocks',
        message: 'blocks: Array must contain at most 32 element(s)',
      },
    ]);

    expect(classifyGenerativeUIParseErrors(['blocks: too_big'])).toEqual([
      { code: 'too-many-blocks', message: 'blocks: too_big' },
    ]);
    expect(classifyGenerativeUIParseErrors(['blocks: too big'])).toEqual([
      { code: 'too-many-blocks', message: 'blocks: too big' },
    ]);
  });

  it('maps blocks + array/required strings to invalid-shape', () => {
    expect(classifyGenerativeUIParseErrors(['blocks: Required'])).toEqual([
      { code: 'invalid-shape', message: 'blocks: Required' },
    ]);
    expect(classifyGenerativeUIParseErrors(['blocks: Expected array, received object'])).toEqual([
      { code: 'invalid-shape', message: 'blocks: Expected array, received object' },
    ]);
  });

  it('maps type / span / props strings to invalid-block', () => {
    expect(classifyGenerativeUIParseErrors(['blocks.0.type: String must contain at least 1'])).toEqual(
      [{ code: 'invalid-block', message: 'blocks.0.type: String must contain at least 1' }],
    );
    expect(classifyGenerativeUIParseErrors(['span must be 1|2|3'])).toEqual([
      { code: 'invalid-block', message: 'span must be 1|2|3' },
    ]);
    expect(classifyGenerativeUIParseErrors(['props.title: Required'])).toEqual([
      { code: 'invalid-block', message: 'props.title: Required' },
    ]);
  });

  it('maps unknown strings to unknown and preserves the original message', () => {
    expect(classifyGenerativeUIParseErrors(['completely unrecognized diagnostic'])).toEqual([
      { code: 'unknown', message: 'completely unrecognized diagnostic' },
    ]);
  });

  it('returns [] for null, undefined, and empty input', () => {
    expect(classifyGenerativeUIParseErrors(null)).toEqual([]);
    expect(classifyGenerativeUIParseErrors(undefined)).toEqual([]);
    expect(classifyGenerativeUIParseErrors([])).toEqual([]);
  });

  it('classifies each error independently and never throws', () => {
    const classified = classifyGenerativeUIParseErrors([
      'Invalid JSON: Unexpected token',
      'version: Invalid enum value',
      'completely unrecognized diagnostic',
    ]);
    expect(classified.map((item) => item.code)).toEqual([
      'invalid-json',
      'unknown-version',
      'unknown',
    ]);
    expect(classified.map((item) => item.message)).toEqual([
      'Invalid JSON: Unexpected token',
      'version: Invalid enum value',
      'completely unrecognized diagnostic',
    ]);
  });

  it('classifies real parseGenerativeUIIntent errors', () => {
    const invalidJson = parseGenerativeUIIntent('{ invalid');
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) {
      const classified = classifyGenerativeUIParseErrors(invalidJson.errors);
      expect(classified.length).toBeGreaterThan(0);
      expect(classified[0]?.code).toBe('invalid-json');
      expect(classified[0]?.message).toBe(invalidJson.errors[0]);
    }

    const tooMany = parseGenerativeUIIntent(
      JSON.stringify({
        version: '1',
        blocks: Array.from({ length: MAX_GENERATIVE_UI_BLOCKS + 1 }, () => ({
          type: 'text',
          props: { body: 'x' },
        })),
      }),
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      const classified = classifyGenerativeUIParseErrors(tooMany.errors);
      expect(classified.some((item) => item.code === 'too-many-blocks')).toBe(true);
      expect(classified.every((item, i) => item.message === tooMany.errors[i])).toBe(true);
    }
  });

  it('maps stream-buffer-capped parse errors', () => {
    expect(classifyGenerativeUIParseErrors([STREAM_BUFFER_CAPPED_WARNING])).toEqual([
      { code: 'buffer-capped', message: STREAM_BUFFER_CAPPED_WARNING },
    ]);

    const oversized = parseGenerativeUIIntent(
      `{"version":"1","blocks":[{"type":"text","props":{"body":"${'x'.repeat(128)}"}}]}`,
      128,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(classifyGenerativeUIParseErrors(oversized.errors)[0]?.code).toBe('buffer-capped');
    }
  });
});
