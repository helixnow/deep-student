import { describe, expect, it, vi } from 'vitest';
import { plainCodec } from '../api.ts';
import { createTombstoneSupport } from '../src/tombstones.ts';
import { SqliteSyncStateStore } from '../src/state.ts';
import { compareLwwTimestamps } from '../src/lww.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { openTestDatabase } from './test-db.ts';

describe('F4 platform semantics in syncSupport', () => {
  it('preserves chrono precision, Rust whitespace and UTF-8 rejection through production helpers', () => {
    const db = openTestDatabase();
    const support = createTombstoneSupport(new SqliteSyncStateStore(db), { warn: vi.fn(), info: vi.fn() });
    try {
      expect(support.deletedAtIsNewer('2026-08-01T00:00:00.000000002Z', '2026-08-01T00:00:00.000000001Z'))
        .toBe(true);
      expect(() => support.validateTombstoneTimestamp('2026-08-01T00:00:00+99:99', 'blob/a'))
        .toThrow('tombstone 时间戳无效');
      expect(support.deviceComponent('\u0085')).toBe('unknown-device');
      expect(support.deviceComponent('\ufeff')).toBe('\ufeff');
      const invalidUtf8 = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
      expect(() => support.decodeTombstoneFile(plainCodec, invalidUtf8, 'blob'))
        .toThrow('tombstone 清单损坏');
      expect(toRfc3339(0n)).toBe('1970-01-01T00:00:00+00:00');
      expect(toRfc3339(1_000_000n)).toBe('1970-01-01T00:00:00.001+00:00');
    } finally {
      db.raw.close();
    }
  });

  it('canonical_lww_key uses the Rust internal timestamp parser without numeric fallback', () => {
    expect(compareLwwTimestamps('9999999999999', '', '', '2026-08-01T00:00:00Z', '', '')).toBe(-1);
    expect(compareLwwTimestamps('2026-08-01 00:00:00', '', '', '2026-08-01T00:00:00Z', '', '')).toBe(0);
  });
});
