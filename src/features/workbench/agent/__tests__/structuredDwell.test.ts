import { describe, expect, it } from 'vitest';
import { structuredDwellMs } from '../drivers/noteDriver';
import { PACING_PROFILES } from '../pacing';

describe('structuredDwellMs (block reveal pacing)', () => {
  it('scales with block length inside [5, 40] typing intervals', () => {
    const normal = PACING_PROFILES.normal;
    expect(structuredDwellMs(normal, 2)).toBe(5 * normal.typeIntervalMs);
    expect(structuredDwellMs(normal, 40)).toBe(20 * normal.typeIntervalMs);
    expect(structuredDwellMs(normal, 10_000)).toBe(40 * normal.typeIntervalMs);
  });

  it('is slower in demo and zero when instant', () => {
    expect(structuredDwellMs(PACING_PROFILES.demo, 40)).toBeGreaterThan(structuredDwellMs(PACING_PROFILES.normal, 40));
    const instant = Object.values(PACING_PROFILES).find((p) => p.instant)!;
    expect(structuredDwellMs(instant, 400)).toBe(0);
  });
});
