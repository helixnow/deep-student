// @vitest-environment node
/**
 * W17 第二批契约的类型测试：编译 `typetests/w17-contracts.typetest.ts`，确认合法写法零诊断，
 * 每个被标注的错误形状恰好在标注行报错（浮条项、块菜单行、EditorPurpose、views 懒加载、resource.types）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTypeTest } from './typecheck-helper';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';

describe('W17 plugin contracts', () => {
  it('types editor slots, editor purpose, lazy views and resource.types', async () => {
    const result = await runTypeTest(path.resolve(__dirname, '../typetests/w17-contracts.typetest.ts'));
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual([
      'toolbar-item-icon',
      'editor-purpose',
      'block-menu-row',
      'block-menu-run',
      'lazy-view-component',
      'lazy-view-load',
      'resource-operation',
      'resource-preview',
      'resource-missing-operations',
    ]);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['toolbar-item-icon']).toMatch(/icon/);
    expect(result.errors['editor-purpose']).toMatch(/"preview"/);
    expect(result.errors['block-menu-row']).toMatch(/id/);
    expect(result.errors['block-menu-run']).toMatch(/EditorView|not assignable/);
    expect(result.errors['lazy-view-component']).toMatch(/never/);
    expect(result.errors['lazy-view-load']).toMatch(/load/);
    expect(result.errors['resource-operation']).toMatch(/"burn"/);
    expect(result.errors['resource-preview']).toMatch(/"webview"/);
    expect(result.errors['resource-missing-operations']).toMatch(/operations/);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
