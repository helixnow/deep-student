/**
 * `ctx.files` 的接口与路径模块是移动端实现要复用的部分，运行时不得触达 Node 专有依赖。
 */
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

it('files/api.ts and files/path.ts never load Node modules at runtime', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/files/api.ts', 'host/platform/files/path.ts'])).toEqual([]);
});
