// @vitest-environment node
/**
 * SlotMap 的类型测试：用项目 tsconfig 编译 `typetests/slot-map.typetest.ts`。
 * 1. 原文零诊断：每个 `@ts-expect-error` 都被真实错误消耗，合法写法全部通过；
 * 2. 去掉这些指令后，错误恰好出现在被标注的那些行上，且错误来自贡献形状（而不是别的原因）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTypeTest } from './typecheck-helper';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';

describe('SlotMap compile-time contracts', () => {
  it('accepts well-shaped contributions and rejects each mis-shaped one at the annotated line', async () => {
    const result = await runTypeTest(path.resolve(__dirname, '../typetests/slot-map.typetest.ts'));
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual([
      'missing-field', 'wrong-field-type', 'excess-field', 'builtin-nav-shape', 'builtin-views-shape',
      'contribution-envelope', 'typed-read', 'typed-hook',
    ]);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['missing-field']).toMatch(/Property 'size' is missing/);
    expect(result.errors['wrong-field-type']).toMatch(/Type 'number' is not assignable to type 'string'/);
    expect(result.errors['excess-field']).toMatch(/'color' does not exist/);
    expect(result.errors['builtin-nav-shape']).toMatch(/'labelKey' is missing/);
    expect(result.errors['builtin-views-shape']).toMatch(/component/);
    expect(result.errors['contribution-envelope']).toMatch(/Property 'id' is missing/);
    expect(result.errors['typed-read']).toMatch(/Property 'color' does not exist/);
    expect(result.errors['typed-hook']).toMatch(/Property 'title' does not exist on type 'ShellNavItem'/);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
