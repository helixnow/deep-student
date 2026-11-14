// 把沙箱 preload（electron/preload/preload.ts 及其依赖）打包为单个 CommonJS 文件 electron/.build/preload.cjs。
// 沙箱 preload 不能 require 本地模块，必须是单文件；只依赖仓库已有的 esbuild（vite 的依赖）。
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPreload() {
  const outfile = join(electronDir, '.build', 'preload.cjs');
  await build({
    entryPoints: [join(electronDir, 'preload', 'preload.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'chrome140',
    external: ['electron'],
    // executeInMainWorld 序列化 installTauriBridge：禁止 keepNames 注入的 __name 辅助函数。
    keepNames: false,
    minify: false,
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  return outfile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = await buildPreload();
  process.stdout.write(`[build-preload] ${out}\n`);
}
