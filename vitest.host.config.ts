import { defineConfig } from 'vitest/config';
import { testBuildNumberEnv } from './scripts/electron-migration/lib/test-build-number.mjs';

// Host / Electron 侧测试。原生模块（better-sqlite3）按 Electron ABI 构建，
// 需要原生模块的测试用 `npm run test:host:electron` 在 Electron 内置 Node 中运行。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['host/**/*.test.ts', 'electron/**/*.test.ts', 'web/**/*.test.ts', 'scripts/electron-migration/**/*.test.ts', 'scripts/contracts/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    // 删除启动 shell 带进来的代理变量，本机与服务器（没有代理变量）一致。
    setupFiles: [
      './scripts/electron-migration/lib/host-test-setup.mjs',
      // 桌面测试统一注入插件的同步本地运行时（直接 new 仓储的跨插件用例不经过插件入口）。
      './host/testing/host-plugin-runtimes.ts',
    ],
    // 浅克隆/源码快照没有构建号基线提交时，给 electron/build-info.ts 一个测试默认值。
    env: testBuildNumberEnv(import.meta.dirname),
  },
});
