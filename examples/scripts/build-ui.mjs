#!/usr/bin/env node
/**
 * 社区插件 UI 半的构建：在插件目录里运行（插件的 `npm run build:ui` 就是 `node <应用仓库>/examples/scripts/build-ui.mjs`），
 * 把 `ui.tsx` 打成 `package.json#deepStudent.ui` 指向的单个 ESM 文件。
 *
 * - 宿主经 import map 只共享四个模块（src/ui-kernel/community.ts installCommunitySharedModules），它们设为 external，
 *   其余依赖打进产物。
 * - 宿主不提供 react/jsx-runtime：按经典 JSX 编译成 React.createElement；tsconfigRaw 为空，不读外层 tsconfig
 *   （应用仓库根 tsconfig 的 "jsx": "react-jsx" 会盖过 jsx 设置）。
 * - esbuild 用应用仓库里的那份：仓库外的插件目录没有 node_modules，`esbuild` 也不在 PATH 上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** 宿主共享给社区 UI 模块的裸模块名。 */
export const SHARED_MODULES = ['react', 'react-dom', '@deepstudent/ui', 'i18next'];
export const UI_ENTRY = 'ui.tsx';
export const BUILD_UI_SCRIPT = fileURLToPath(import.meta.url);

export class BuildUiError extends Error {}

/**
 * 构建 `dir` 里插件的 UI 半。`write: false` 时不写文件，只返回产物文本。
 * 清单没有 `deepStudent.ui` 时抛 {@link BuildUiError}；esbuild 的编译错误原样抛出。
 */
export async function buildUi({ dir = process.cwd(), write = true, logLevel = 'silent' } = {}) {
  const manifest = path.join(dir, 'package.json');
  const ui = JSON.parse(fs.readFileSync(manifest, 'utf8')).deepStudent?.ui;
  if (typeof ui !== 'string') throw new BuildUiError(`${manifest} declares no deepStudent.ui`);
  const outfile = path.resolve(dir, ui);
  const result = await build({
    absWorkingDir: path.resolve(dir),
    entryPoints: [UI_ENTRY],
    outfile,
    bundle: true,
    format: 'esm',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    tsconfigRaw: {},
    external: SHARED_MODULES,
    write,
    logLevel,
  });
  return { outfile, code: write ? fs.readFileSync(outfile, 'utf8') : result.outputFiles[0].text };
}

// import.meta.url 是真实路径；命令行给的路径可能经过软链（macOS 的 /tmp、软链出来的仓库目录）。
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === BUILD_UI_SCRIPT) {
  try {
    if (process.argv.length > 2) throw new BuildUiError('usage: node <app repo>/examples/scripts/build-ui.mjs (run it in the plugin directory)');
    await buildUi({ logLevel: 'info' });
  } catch (error) {
    // esbuild 的编译错误（带 errors 数组）已经按 logLevel 打印过。
    if (!Array.isArray(error?.errors)) console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
