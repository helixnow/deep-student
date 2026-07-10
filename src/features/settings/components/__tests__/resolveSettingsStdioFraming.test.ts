import { describe, expect, it } from 'vitest';
import { DEFAULT_STDIO_ARGS, resolveSettingsStdioFraming } from '../constants';

describe('resolveSettingsStdioFraming', () => {
  it('defaults missing/empty/unknown to jsonl', () => {
    expect(resolveSettingsStdioFraming(undefined)).toBe('jsonl');
    expect(resolveSettingsStdioFraming(null)).toBe('jsonl');
    expect(resolveSettingsStdioFraming('')).toBe('jsonl');
    expect(resolveSettingsStdioFraming('jsonl')).toBe('jsonl');
    expect(resolveSettingsStdioFraming('JSONL')).toBe('jsonl');
    expect(resolveSettingsStdioFraming('weird')).toBe('jsonl');
  });

  it('recognizes explicit content-length variants as CL', () => {
    expect(resolveSettingsStdioFraming('content_length')).toBe('content_length');
    expect(resolveSettingsStdioFraming('content-length')).toBe('content_length');
    expect(resolveSettingsStdioFraming('Content-Length')).toBe('content_length');
    expect(resolveSettingsStdioFraming('contentlength')).toBe('content_length');
  });

  it('keeps DEFAULT_STDIO_ARGS empty so Settings cannot silently inject args', () => {
    expect(DEFAULT_STDIO_ARGS).toEqual([]);
  });
});
