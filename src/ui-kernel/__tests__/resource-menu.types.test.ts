// @vitest-environment node
/**
 * `resource.contextMenu` 行的类型测试：编译 `typetests/resource-menu.typetest.ts`，确认合法写法零诊断，
 * 笔记树行拿到的是 `NotesTreeMenuContext`，每个被标注的错误形状恰好在标注行报错。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTypeTest } from './typecheck-helper';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';

describe('resource.contextMenu row types', () => {
  it('types each row against the context of its surfaces and rejects mismatches', async () => {
    const result = await runTypeTest(path.resolve(__dirname, '../typetests/resource-menu.typetest.ts'));
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual(['notes-tree-context', 'scope-name', 'learning-hub-context']);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['notes-tree-context']).toMatch(/resourceItem/);
    expect(result.errors['scope-name']).toMatch(/"notes"/);
    expect(result.errors['learning-hub-context']).toMatch(/item/);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
