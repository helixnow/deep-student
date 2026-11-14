import { describe, expect, it } from 'vitest';
import { featureFlagsResult, rustF64AsF32 } from '../src/feature-flags.ts';
import { loadF3Flags } from './support/f3-feature-flags.ts';

// feature_flags.rs::tests belong to F3 (host/platform/storage/tests/feature-flags.test.ts).
describe('src/cmd/web_search.rs feature flag command shaping', () => {
  it('get_feature_flags groups the F3 manager flags by category', () => {
    const values = new Map<string, string>();
    const manager = loadF3Flags({ get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); } });
    const result = featureFlagsResult(manager);
    expect(result.total_count).toBe(manager.listAllFlags().length);
    expect(result.flags.map(flag => flag.name)).toEqual(manager.listAllFlags().map(flag => flag.name));
    for (const [category, flags] of Object.entries(result.flags_by_category)) {
      expect(flags.every(flag => flag.category === category)).toBe(true);
    }
    expect(Object.values(result.flags_by_category).flat()).toHaveLength(result.total_count);
  });

  it('set_gradual converts the f64 argument with `as f32` and stores the f32 shortest decimal', () => {
    expect(rustF64AsF32(0.3)).toBe(0.3);
    expect(rustF64AsF32(0.30000000000000004)).toBe(0.3);
    expect(rustF64AsF32(0.123456789123)).toBe(0.12345679);
    expect(rustF64AsF32(1)).toBe(1);
    expect(rustF64AsF32(0)).toBe(0);
    expect(rustF64AsF32(1e39)).toBe(Infinity);
    expect(rustF64AsF32(-1e39)).toBe(-Infinity);
  });
});
