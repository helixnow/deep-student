import { describe, expect, it } from 'vitest';
import {
  buildMediaRefMarker,
  formatMediaRefTimestamp,
  formatTranscriptClock,
  parseMediaRefTimestamp,
} from '../mediaRefTime';

describe('media ref time format', () => {
  it('formats mm:ss with zero padding and h:mm:ss past an hour', () => {
    expect(formatMediaRefTimestamp(0)).toBe('00:00');
    expect(formatMediaRefTimestamp(65.9)).toBe('01:05');
    expect(formatMediaRefTimestamp(754)).toBe('12:34');
    expect(formatMediaRefTimestamp(3599)).toBe('59:59');
    expect(formatMediaRefTimestamp(3600)).toBe('1:00:00');
    expect(formatMediaRefTimestamp(3723)).toBe('1:02:03');
  });

  it('clamps invalid input to 00:00', () => {
    expect(formatMediaRefTimestamp(-5)).toBe('00:00');
    expect(formatMediaRefTimestamp(Number.NaN)).toBe('00:00');
  });

  it('parses mm:ss, h:mm:ss and tolerates brackets / long minutes', () => {
    expect(parseMediaRefTimestamp('12:34')).toBe(754);
    expect(parseMediaRefTimestamp('1:02:03')).toBe(3723);
    expect(parseMediaRefTimestamp('[05:07]')).toBe(307);
    expect(parseMediaRefTimestamp('75:00')).toBe(4500);
  });

  it('rejects malformed clocks', () => {
    expect(parseMediaRefTimestamp('12:60')).toBeNull();
    expect(parseMediaRefTimestamp('1:60:00')).toBeNull();
    expect(parseMediaRefTimestamp('12')).toBeNull();
    expect(parseMediaRefTimestamp('a:b')).toBeNull();
    expect(parseMediaRefTimestamp(42)).toBeNull();
  });

  it('round-trips through the citation marker', () => {
    expect(buildMediaRefMarker('file_1', 3723)).toBe('[媒体@file_1:1:02:03]');
    expect(formatTranscriptClock(754_400)).toBe('12:34');
  });
});
