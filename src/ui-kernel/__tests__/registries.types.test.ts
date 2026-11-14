// @vitest-environment node
/**
 * 登记接口的类型测试：编译 `typetests/registries.typetest.ts`，确认合法写法零诊断、返回撤销句柄，
 * 每个被标注的错误形状恰好在标注行报错。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTypeTest } from './typecheck-helper';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';

describe('registration value types and handles', () => {
  it('accepts the registry value shapes, returns UiDisposer and rejects mis-shaped registrations', async () => {
    const result = await runTypeTest(path.resolve(__dirname, '../typetests/registries.typetest.ts'));
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual(['command-shape', 'command-category', 'app-shape', 'block-component', 'event-shape', 'mode-shape']);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['command-shape']).toMatch(/name|category|execute/);
    expect(result.errors['command-category']).toMatch(/"everywhere"/);
    expect(result.errors['app-shape']).toMatch(/nameKey|instanceMode|render/);
    expect(result.errors['block-component']).toMatch(/ComponentType<BlockComponentProps>/);
    expect(result.errors['event-shape']).toMatch(/\(store: ChatStore, blockId: string, chunk: string\) => void/);
    expect(result.errors['mode-shape']).toMatch(/config/);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
