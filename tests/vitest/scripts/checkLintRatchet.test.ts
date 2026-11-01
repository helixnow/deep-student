/**
 * scripts/check-lint-ratchet.mjs 的行为契约（内存 ESLint 报告，不运行 eslint）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  compareCounts,
  isRatchetedRule,
  moduleOfFile,
  ruleTotals,
  summarizeEslintReport,
  // @ts-expect-error 脚本为无类型声明的 .mjs（与 CLI 共用同一实现）
} from '../../../scripts/check-lint-ratchet.mjs';

const ROOT = 'D:/repo';
const file = (rel: string, messages: Array<Record<string, unknown>>) => ({ filePath: `${ROOT}/${rel}`, messages });
const warn = (ruleId: string) => ({ ruleId, severity: 1, line: 1, message: ruleId });

describe('isRatchetedRule / moduleOfFile', () => {
  it('ratchets ds-components/* and the listed core rules only', () => {
    expect(isRatchetedRule('ds-components/no-hardcoded-color')).toBe(true);
    expect(isRatchetedRule('ds-components/anything-new')).toBe(true);
    expect(isRatchetedRule('no-restricted-syntax')).toBe(true);
    expect(isRatchetedRule('react-hooks/exhaustive-deps')).toBe(true);
    expect(isRatchetedRule('no-console')).toBe(true);
    expect(isRatchetedRule('boundaries/element-types')).toBe(false);
    expect(isRatchetedRule(null)).toBe(false);
  });

  it('uses the layer-check module definition', () => {
    expect(moduleOfFile(`${ROOT}/src/features/chat/a/b.tsx`, ROOT)).toBe('features/chat');
    expect(moduleOfFile(`${ROOT}/src/components/x.tsx`, ROOT)).toBe('components');
    expect(moduleOfFile(`${ROOT}/src/App.tsx`, ROOT)).toBe('App.tsx');
    expect(moduleOfFile(`${ROOT}/tests/a.ts`, ROOT)).toBe('(root)/tests');
  });
});

describe('summarizeEslintReport', () => {
  it('counts ratcheted warnings per (rule, module) and collects errors', () => {
    const summary = summarizeEslintReport([
      file('src/features/chat/a.tsx', [warn('no-console'), warn('no-console'), warn('boundaries/element-types')]),
      file('src/features/chat/b.tsx', [warn('no-console'), warn('ds-components/no-native-button')]),
      file('src/utils/c.ts', [warn('no-console'), { ruleId: 'no-alert', severity: 2, line: 4, message: 'alert' }]),
      file('src/utils/d.ts', [{ ruleId: null, severity: 2, fatal: true, line: 1, message: 'Parsing error' }]),
    ], ROOT);
    expect(summary.counts).toEqual({
      'ds-components/no-native-button': { 'features/chat': 1 },
      'no-console': { 'features/chat': 3, utils: 1 },
    });
    expect(summary.warnings).toBe(6);
    expect(summary.errors.map((e: { ruleId: string }) => e.ruleId)).toEqual(['no-alert', '(fatal)']);
    expect(ruleTotals(summary.counts)).toEqual({ 'ds-components/no-native-button': 1, 'no-console': 4 });
  });
});

describe('compareCounts', () => {
  it('flags increases (including new pairs) and reports decreases', () => {
    const { increased, decreased } = compareCounts(
      { 'no-console': { utils: 3, hooks: 1 }, 'ds-components/x': { components: 1 } },
      { 'no-console': { utils: 2, 'features/chat': 4 }, 'ds-components/x': { components: 1 } },
    );
    expect(increased).toEqual([
      { rule: 'no-console', module: 'hooks', baseline: 0, current: 1 },
      { rule: 'no-console', module: 'utils', baseline: 2, current: 3 },
    ]);
    expect(decreased).toEqual([{ rule: 'no-console', module: 'features/chat', baseline: 4, current: 0 }]);
  });
});

describe('repo baseline', () => {
  it('covers the two new design-system rules and only ratcheted rules', () => {
    const baseline = JSON.parse(readFileSync(resolve(process.cwd(), 'config/lint-ratchet-baseline.json'), 'utf8'));
    expect(Object.keys(baseline.counts)).toEqual(expect.arrayContaining([
      'ds-components/no-hardcoded-color',
      'ds-components/no-arbitrary-z-index',
    ]));
    for (const rule of Object.keys(baseline.counts)) expect(isRatchetedRule(rule)).toBe(true);
    expect(baseline.totals).toEqual(ruleTotals(baseline.counts));
  });
});
