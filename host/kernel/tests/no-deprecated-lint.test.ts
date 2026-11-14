/**
 * `@typescript-eslint/no-deprecated`（插件生态 v1 P0）：kernel 自身不使用任何 `@deprecated` 接口；
 * host / electron 全量的棘轮需要完整类型程序（约 3 分钟），由
 *   bin/heavy node eslint-rules/no-deprecated.baseline.mjs
 * 守门（基线 eslint-rules/no-deprecated.baseline.json）。这里只验证 kernel 与棘轮的比较逻辑。
 */
import { describe, expect, it } from 'vitest';
import { compareWithBaseline, lintDeprecated, readBaseline } from '../../../eslint-rules/no-deprecated.baseline.mjs';

describe('no-deprecated lint', () => {
  it('host/kernel uses no @deprecated API', async () => {
    const { files, fatal } = await lintDeprecated({ patterns: ['host/kernel/**/*.ts'] });
    expect(fatal).toEqual([]);
    expect(files).toEqual({});
  }, 180_000);

  it('the ratchet reports files above the baseline and files that can be tightened', () => {
    const files = { 'a.ts': ['1: x', '2: y'], 'b.ts': ['3: z'] };
    const { over, stale } = compareWithBaseline(files, { 'a.ts': 1, 'b.ts': 1, 'c.ts': 2 });
    expect(over).toEqual([{ file: 'a.ts', count: 2, baseline: 1, uses: ['1: x', '2: y'] }]);
    expect(stale).toEqual([{ file: 'c.ts', count: 0, baseline: 2 }]);
  });

  it('the committed baseline is a per-file count map', () => {
    const baseline = readBaseline();
    for (const [file, count] of Object.entries(baseline)) {
      expect(file).toMatch(/^(host|electron)\/.+\.ts$/);
      expect(Number.isInteger(count) && count > 0, file).toBe(true);
    }
  });
});
