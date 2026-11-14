/**
 * Web 实现与移动端入口的运行时闭包不得触达 Node 专有依赖（`import type` 不计），
 * 官方 `mobile.json` 中的全部模块同样如此。判定用 `scripts/portability` 扫描器。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure, checkProfileClosure } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('ctx.crypto portability', () => {
  it('web.ts, encoding.ts, api.ts and mobile.ts never load Node modules at runtime', () => {
    expect(checkModulesClosure(ROOT, [
      'host/platform/crypto/web.ts',
      'host/platform/crypto/encoding.ts',
      'host/platform/crypto/api.ts',
      'host/platform/crypto/mobile.ts',
    ])).toEqual([]);
  });

  it('the desktop entry does use node:crypto (sanity check of the scanner)', () => {
    expect(checkModulesClosure(ROOT, ['host/platform/crypto/index.ts']).map((violation) => violation.key)).toContain('node-builtin:crypto');
  });

  it('every module in host/profiles/mobile.json is Node-free at runtime', () => {
    const results = checkProfileClosure(ROOT, 'host/profiles/mobile.json');
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((result) => result.violations.length > 0)).toEqual([]);
  }, 120_000); // scanning 33 module closures takes about 40 s under vitest
});
