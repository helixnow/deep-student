// @vitest-environment node
/**
 * `chat.toolResults` 的类型测试：编译 `typetests/chat-slots.typetest.ts`，确认合法写法零诊断、
 * 每个被标注的错误形状恰好在标注行报错。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTypeTest } from './typecheck-helper';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';

describe('chat.toolResults compile-time contract', () => {
  it('accepts the contract and v1 bare components, rejects mis-shaped contributions', async () => {
    const result = await runTypeTest(path.resolve(__dirname, '../typetests/chat-slots.typetest.ts'));
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual([
      'tool-result-placement', 'tool-result-component', 'tool-result-match', 'tool-result-typed-read',
    ]);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['tool-result-placement']).toMatch(/"inline"/);
    expect(result.errors['tool-result-component']).toMatch(/component/);
    expect(result.errors['tool-result-match']).toMatch(/"prefix"/);
    expect(result.errors['tool-result-typed-read']).toMatch(/Property 'render' does not exist/);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
