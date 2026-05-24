import { describe, expect, it } from 'vitest';

import { formatToolDurationShort } from '../toolDuration';

describe('toolDuration', () => {
  it('formats sub-second durations in milliseconds', () => {
    expect(formatToolDurationShort(842)).toBe('842ms');
  });

  it('formats short durations in seconds', () => {
    expect(formatToolDurationShort(1200)).toBe('1.2s');
    expect(formatToolDurationShort(1000)).toBe('1s');
  });

  it('formats long durations in minutes and seconds', () => {
    expect(formatToolDurationShort(65000)).toBe('1m 5s');
    expect(formatToolDurationShort(60000)).toBe('1m 0s');
  });
});
