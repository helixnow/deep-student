/**
 * 移动端单元 / 差分测试（Node 中运行）：SQLite WASM 用 `@sqlite.org/sqlite-wasm` 的 Node 构建（只装在
 * `mobile/node_modules`），桌面对照与 vitest 本身取根工程依赖。从仓库根目录运行：
 * `npx vitest run -c mobile/vitest.config.ts`。Playwright 用例（`*.spec.ts`）不在此列。
 * `tests/boot/` 要先用 Vite 打包 Host Worker（较重，经 bin/heavy 运行）。
 */
import { defineConfig, type Plugin } from 'vitest/config';
import { mobileProfile } from './vite.config.ts';

export default defineConfig({
  root: import.meta.dirname,
  // `command-acl.ts` 读构建期虚拟模块（profile 与 Rust 允许表）；Node 内建模块在这里用真的，不套 shim。
  // Vitest uses the root Vite install; the app config uses mobile's isolated Vite types.
  plugins: [mobileProfile() as unknown as Plugin],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/boot/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
