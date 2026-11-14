import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../../../../scripts/portability/lib/portability.mjs';
import { randomHex, randomUuid } from '../src/random.ts';

describe('random identifiers (Web Crypto)', () => {
  it('randomHex(n) has the randomBytes(n).toString("hex") shape and varies', () => {
    for (const n of [4, 6, 8, 16]) expect(randomHex(n)).toMatch(new RegExp(`^[0-9a-f]{${2 * n}}$`));
    expect(new Set(Array.from({ length: 64 }, () => randomHex(8))).size).toBe(64);
  });

  it('randomUuid() is a lowercase RFC 4122 v4 UUID', () => {
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('random.ts depends on no Node module or global', () => {
    const path = join(import.meta.dirname, '..', 'src', 'random.ts');
    expect(analyzeSource('host/plugins/sync-providers/src/random.ts', readFileSync(path, 'utf8')).findings).toEqual([]);
  });
});
