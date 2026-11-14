/**
 * `ctx.http` 的接口是移动端实现要复用的部分，运行时不得触达 Node 专有依赖。
 */
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

it('http/api.ts never loads Node modules at runtime', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/http/api.ts'])).toEqual([]);
});

it('public-pinned policy never loads Node modules at runtime (pure IP checks from net-policy/ip.ts)', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/http/pinned-policy.ts'])).toEqual([]);
});
