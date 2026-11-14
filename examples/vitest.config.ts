/**
 * 示例插件的测试配置：沿用根目录前端测试配置（vitest.config.ts 的 React 插件、setup、别名），只把范围换成 examples/，
 * 并把 `@deepstudent/ui` 指到仓库内的 SDK 入口（运行时由宿主经 import map 提供同一个模块）。
 *
 *   DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c examples/vitest.config.ts [文件…]
 *
 * 仓库外的插件目录（examples/scripts/create-plugin.mjs 生成的）：`DS_PLUGIN_DIR=<目录>` 时只收该目录下的测试。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import base, { fsAllow } from '../vitest.config';

const root = path.resolve(import.meta.dirname, '..');
const pluginDir = process.env.DS_PLUGIN_DIR ? fs.realpathSync(path.resolve(process.env.DS_PLUGIN_DIR)) : null;
const setupFiles = [...[base.test?.setupFiles ?? []].flat(), path.join(root, 'examples/testing/setup.ts')];

export default defineConfig({
  ...base,
  root,
  // 脚手架测试把插件生成在系统临时目录里再导入它。
  server: { ...base.server, fs: { allow: [...fsAllow(root), fs.realpathSync(os.tmpdir()), ...(pluginDir ? [pluginDir] : [])] } },
  resolve: {
    ...base.resolve,
    alias: { ...(base.resolve?.alias as Record<string, string>), '@deepstudent/ui': path.join(root, 'src/ui-sdk/index.ts') },
    // 仓库外的插件目录没有 node_modules：共享依赖一律按应用仓库解析。
    dedupe: ['react', 'react-dom', 'i18next', 'vitest', 'jsdom'],
  },
  test: pluginDir
    ? { ...base.test, setupFiles, dir: pluginDir, include: ['**/*.test.{ts,tsx}'], exclude: ['**/node_modules/**', '**/dist/**'] }
    : { ...base.test, setupFiles, include: ['examples/**/*.test.{ts,tsx}'] },
});
