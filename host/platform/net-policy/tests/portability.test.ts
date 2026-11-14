/**
 * net-policy 的公开入口（`index.ts`）运行时不触达 Node；需要 DNS 的 `isSafeRemoteUrl` /
 * `fetchBinaryWithCache` 只在桌面入口 `node.ts`。
 */
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import * as entry from '../index.ts';
import * as ip from '../ip.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

it('ip.ts and navigation.ts never load Node modules at runtime', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/net-policy/ip.ts', 'host/platform/net-policy/navigation.ts'])).toEqual([]);
});

it('index.ts is the portable entry: only node.ts reaches node:dns', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/net-policy/index.ts'])).toEqual([]);
  expect(checkModulesClosure(ROOT, ['host/platform/net-policy/node.ts']).map((v) => `${v.file}:${v.key}`))
    .toEqual(['host/platform/net-policy/node.ts:node-builtin:dns']);
});

it('index.ts re-exports the very same IP functions, so existing importers keep one implementation', () => {
  for (const name of ['parseIp', 'isLoopbackIp', 'isLoopbackHost', 'isInternalIp', 'isBlockedInternalIp'] as const) {
    expect(entry[name], name).toBe(ip[name]);
  }
});
