#!/usr/bin/env node
// 生成 legal/frontend-bundle-packages.json：前端产物里实际包含的 npm 包。
//
// 用仓库自己的 vite.config.ts 做一次生产构建（输出到临时目录，不碰 dist/），额外挂一个只读的收集插件：
// - Rollup 渲染进 chunk 的模块（renderedLength > 0，tree-shaking 掉的不算），主构建与 worker 构建都收集；
// - 被加载的非 JS 资源模块（CSS、字体、图片、wasm 等，`?url` / `?raw` 引入的也在内）；
// - vite-plugin-static-copy 原样复制的文件（记录 fs.cp 的源路径）。
// 构建结束后核对输出目录：每个文件都必须来自 Rollup 输出、publicDir 或记录到的复制，否则报错，
// 防止将来新增的复制方式让某个包悄悄漏出声明。
//
// 用法：DEEP_STUDENT_BUILD_NUMBER=… npm run version:generate && node --max-old-space-size=8192 scripts/licenses/collect-frontend-bundle-packages.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_MANIFEST, lockPathOfModule, packageLockHash } from './shipped-npm-packages.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSET_EXTENSIONS = /\.(?:css|scss|sass|less|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|wasm|mp3|wav|ogg|bcmap|pfb|json)$/i;

function listFiles(directory, base = directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

async function main() {
  if (!fs.existsSync(path.join(repoRoot, 'src', 'version.ts'))) {
    throw new Error('src/version.ts is missing: run `npm run version:generate` first (and delete it afterwards).');
  }
  const { build } = await import('vite');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-license-bundle-'));
  const bundled = new Map();
  const note = (lockPath, via) => {
    if (lockPath === null) return;
    const vias = bundled.get(lockPath) ?? new Set();
    vias.add(via);
    bundled.set(lockPath, vias);
  };
  const rollupOutputs = new Set();
  let publicDir = null;

  const collector = (scope) => ({
    name: `ds-license-collector:${scope}`,
    enforce: 'post',
    configResolved(config) {
      if (scope === 'main') publicDir = config.publicDir || null;
    },
    load(id) {
      if (ASSET_EXTENSIONS.test(id.split('?')[0])) note(lockPathOfModule(id), 'asset');
      return null;
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (scope === 'main') rollupOutputs.add(output.fileName);
        if (output.type !== 'chunk') continue;
        for (const [id, info] of Object.entries(output.modules)) {
          if (info.renderedLength > 0) note(lockPathOfModule(id), scope === 'main' ? 'bundle' : 'worker');
        }
      }
    },
  });

  const copies = [];
  const originalCp = fsp.cp;
  fsp.cp = async (source, destination, options) => {
    copies.push({ source: String(source), destination: path.resolve(String(destination)) });
    return originalCp.call(fsp, source, destination, options);
  };
  try {
    await build({
      configFile: path.join(repoRoot, 'vite.config.ts'),
      root: repoRoot,
      mode: 'production',
      logLevel: 'warn',
      build: { outDir, emptyOutDir: true },
      plugins: [collector('main')],
      worker: { plugins: () => [collector('worker')] },
    });
  } finally {
    fsp.cp = originalCp;
  }

  for (const copy of copies) note(lockPathOfModule(fs.realpathSync(copy.source)), 'static-copy');
  const publicFiles = new Set(publicDir ? listFiles(publicDir) : []);
  const copiedPrefixes = copies.map((copy) => path.relative(outDir, copy.destination).split(path.sep).join('/'));
  const unattributed = listFiles(outDir).filter((file) => !rollupOutputs.has(file) && !publicFiles.has(file)
    && !copiedPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
  fs.rmSync(outDir, { recursive: true, force: true });
  if (unattributed.length > 0) {
    throw new Error(`build output files of unknown origin (extend the collector before trusting the manifest):\n  ${unattributed.slice(0, 20).join('\n  ')}`);
  }
  if (copies.length === 0) throw new Error('vite-plugin-static-copy copied nothing through fs.cp; the collector no longer sees static copies');

  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const packages = [...bundled.entries()]
    .map(([lockPath, vias]) => {
      const entry = lock.packages?.[lockPath];
      if (!entry) throw new Error(`bundled module from ${lockPath}, which is not in package-lock.json`);
      return { path: lockPath, version: entry.version, via: [...vias].sort() };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    generatedBy: 'scripts/licenses/collect-frontend-bundle-packages.mjs',
    packageLockSha256: packageLockHash(lock),
    packages,
  };
  fs.writeFileSync(path.join(repoRoot, FRONTEND_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${FRONTEND_MANIFEST} (${packages.length} packages, ${copies.length} static copies).`);
}

await main();
