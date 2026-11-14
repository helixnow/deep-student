/**
 * notes 的跨插件门面 `api.ts`（vfs、chat、sync 等从这里取值）在移动端也要能加载：
 * 运行时闭包（`import type` 不计）不得触达 Node 专有依赖。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('notes api.ts portability', () => {
  it('the runtime closure of host/plugins/notes/api.ts is free of Node-specific deps', () => {
    expect(checkModulesClosure(ROOT, ['host/plugins/notes/api.ts'])).toEqual([]);
  });
});
