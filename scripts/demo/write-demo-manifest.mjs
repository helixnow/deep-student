#!/usr/bin/env node
/**
 * 给 dist-demo/ 写 manifest.json：官网（ds-web scripts/sync-demo.mjs）按它整包同步演示镜像，
 * 并从 apps 里读出每章演示的 id / 标题 / 高度——官网嵌入跟着这里走，新增章节不用改官网。
 *
 * 用法：node scripts/demo/write-demo-manifest.mjs --version <标签> [--commit <sha>] [--dir dist-demo]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const root = path.resolve(opt('dir', 'dist-demo'));
const version = opt('version');
if (!version) {
  console.error('--version is required');
  process.exit(2);
}

/** 官网只用得到这几个入口；hero.html 是演示服务器自己的落地页，镜像不要 */
const SKIP = new Set(['hero.html', 'manifest.json']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root)
  .map((full) => path.relative(root, full).split(path.sep).join('/'))
  .filter((rel) => !SKIP.has(rel) && !rel.startsWith('.'))
  .sort()
  .map((rel) => {
    const body = fs.readFileSync(path.join(root, rel));
    return { path: rel, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  });

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const registry = fs.readFileSync(path.join(repoRoot, 'src/demo/app/registry.ts'), 'utf8');
const shellStart = registry.indexOf('SHELL_DEMOS');
const apps = [...registry.slice(0, shellStart).matchAll(/\{\s*id:\s*'([^']+)',\s*height:\s*(\d+)/g)].map(([, id, height]) => {
  let title = id;
  for (const candidate of [`${id}.ts`, `${id}.tsx`, `${id}/index.ts`, `${id}/index.tsx`]) {
    const file = path.join(repoRoot, 'src/demo/app/packs', candidate);
    if (!fs.existsSync(file)) continue;
    title = fs.readFileSync(file, 'utf8').match(/^  title:\s*'([^']+)'/m)?.[1] ?? id;
    break;
  }
  const posters = ['light', 'dark'].filter((theme) => files.some((f) => f.path === `posters/${id}-${theme}.webp`));
  return { id, title, height: Number(height), posters };
});
// 演示整个壳的章节（学习桌面、移动端）：官网嵌 entry，width 给了就用手机尺寸的框
for (const m of registry.slice(shellStart).matchAll(
  /\{\s*id:\s*'([^']+)',\s*title:\s*'([^']+)',\s*height:\s*(\d+)(?:,\s*width:\s*(\d+))?,\s*entry:\s*'([^']+)'/g,
)) {
  const [, id, title, height, width, entry] = m;
  const posters = ['light', 'dark'].filter((theme) => files.some((f) => f.path === `posters/${id}-${theme}.webp`));
  apps.push({ id, title, height: Number(height), ...(width ? { width: Number(width) } : {}), entry, posters });
}

const manifest = {
  version,
  commit: opt('commit', null),
  builtAt: new Date().toISOString(),
  entries: { classic: 'demo.html', app: 'demo-app.html' },
  apps,
  files,
};
fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const bytes = files.reduce((sum, f) => sum + f.size, 0);
console.log(`manifest: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB, ${apps.length} app demos`);
