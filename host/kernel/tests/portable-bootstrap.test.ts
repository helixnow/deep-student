/**
 * Host 引导的可移植半：没有文件系统的宿主（移动端 Web Worker）只需这些模块就能运行 Host 会话。
 * 用可移植性扫描器（scripts/portability）的同一闭包分析断言它们的运行时闭包不触达 Node 专有依赖；
 * 读文件的桌面入口（connection.ts / contracts.ts / profile.ts / main.ts）不在此列。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const PORTABLE_ENTRIES = [
  'host/kernel/serve.ts',
  'host/kernel/contract-set.ts',
  'host/kernel/runtime.ts',
  'host/kernel/profile-install.ts',
  'host/kernel/transports.ts',
  'host/kernel/module-origin.ts',
  'host/kernel/manifest.ts',
  'host/kernel/plugin-config.ts',
  'host/kernel/api.ts',
];

describe('portable Host bootstrap', () => {
  it.each(PORTABLE_ENTRIES)('%s has a Node-free runtime closure', (entry) => {
    expect(checkModulesClosure(ROOT, [entry])).toEqual([]);
  });
});
