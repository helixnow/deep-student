// 第三方声明与许可证检查的 npm 口径：只看“实际进入产物的包”，不看依赖类型。
//
// 产物里的 npm 代码有两个来源：
// 1. Electron 运行时（app.asar 的 node_modules）：从根 package.json 的 dependencies 出发，按 lock 文件的
//    Node 解析规则闭包（dependencies、已安装的 peer、匹配任一发行平台的 optionalDependencies）。
//    与 electron/scripts/node-modules-closure.cjs 的打包闭包同一规则，但只读 lock，不依赖本机安装了哪些平台包。
// 2. 前端（dist/）：Vite/Rollup 实际渲染进 bundle 的模块所在的包，加上 vite-plugin-static-copy 原样复制的文件
//    所在的包。由 collect-frontend-bundle-packages.mjs 构建一次生成 legal/frontend-bundle-packages.json。
// 前端库在 package.json 里是 devDependencies（运行时不 import），所以不能按 lock 的 dev 标记取舍。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** electron-builder 发行的平台（electron/electron-builder.config.cjs 的 mac / win / linux）。 */
export const RELEASE_TARGETS = Object.freeze([
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'win32', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
]);

export const FRONTEND_MANIFEST = path.join('legal', 'frontend-bundle-packages.json');

/** 与 generate-third-party-notices.mjs / check-license-compliance.mjs 相同：剔除 release-please 改写的版本号。 */
export function packageLockHash(lock) {
  const data = structuredClone(lock);
  delete data.version;
  if (data.packages && data.packages['']) delete data.packages[''].version;
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function matchesField(values, value) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const denied = values.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));
  if (denied.includes(value)) return false;
  const allowed = values.filter((entry) => !entry.startsWith('!'));
  return allowed.length === 0 || allowed.includes(value);
}

/** `target.libc`（`glibc` / `musl`）省略时不按 libc 过滤。 */
function matchesAnyTarget(entry, targets) {
  return targets.some((target) => matchesField(entry.os, target.platform) && matchesField(entry.cpu, target.arch)
    && (target.libc === undefined || matchesField(entry.libc, target.libc)));
}

/** Node 的 node_modules 查找在 lock 路径上的等价：从 `from` 逐级向外，最后是顶层。 */
function resolveInLock(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (base === '') return null;
    const index = base.lastIndexOf('/node_modules/');
    base = index === -1 ? '' : base.slice(0, index);
  }
}

/**
 * Electron 运行时闭包（lock 路径，如 `node_modules/tar/node_modules/yallist`）。
 * @param {{ packages: Record<string, any> }} lock
 * @param {Record<string, string>} rootDependencies 根 package.json 的 dependencies
 */
export function electronRuntimeLockPaths(lock, rootDependencies, targets = RELEASE_TARGETS) {
  const packages = lock.packages ?? {};
  const shipped = new Set();
  const queue = [{ from: '', entry: { dependencies: rootDependencies }, label: 'package.json' }];
  while (queue.length > 0) {
    const { from, entry, label } = queue.shift();
    const optionalPeers = new Set(Object.entries(entry.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta && meta.optional).map(([name]) => name));
    const wanted = [
      ...Object.keys(entry.dependencies ?? {}).map((name) => ({ name, required: !(name in (entry.optionalDependencies ?? {})) })),
      ...Object.keys(entry.optionalDependencies ?? {}).map((name) => ({ name, required: false })),
      ...Object.keys(entry.peerDependencies ?? {}).map((name) => ({ name, required: false, optionalPeer: optionalPeers.has(name) })),
    ];
    for (const { name, required } of wanted) {
      const resolved = resolveInLock(packages, from, name);
      if (resolved === null) {
        if (required) throw new Error(`production dependency ${name} of ${label} is missing from package-lock.json`);
        continue;
      }
      if (shipped.has(resolved)) continue;
      const dependency = packages[resolved];
      if (!required && !matchesAnyTarget(dependency, targets)) continue;
      shipped.add(resolved);
      queue.push({ from: resolved, entry: dependency, label: resolved });
    }
  }
  return shipped;
}

/**
 * 模块 id（绝对路径，可带查询串）→ 所在包的 lock 路径；不在 node_modules 里返回 null。
 * `/x/node_modules/@scope/a/node_modules/b/lib/c.js?worker` → `node_modules/@scope/a/node_modules/b`。
 */
export function lockPathOfModule(id) {
  const clean = id.replace(/^\0+/, '').split('?')[0].split(path.sep).join('/');
  const start = clean.indexOf('/node_modules/');
  if (start === -1) return null;
  const parts = clean.slice(start + '/node_modules/'.length).split('/');
  const names = [];
  let index = 0;
  for (;;) {
    const head = parts[index];
    if (head === undefined || head === '' || head === '.vite' || head === '.pnpm') return names.length > 0 ? `node_modules/${names.join('/node_modules/')}` : null;
    const scoped = head.startsWith('@');
    if (scoped && parts[index + 1] === undefined) return null;
    names.push(scoped ? `${head}/${parts[index + 1]}` : head);
    index += scoped ? 2 : 1;
    if (parts[index] !== 'node_modules') break;
    index += 1;
  }
  return `node_modules/${names.join('/node_modules/')}`;
}

/** 读取并校验前端清单：缺失或与当前 lock 不一致时报错（重新构建清单）。 */
export function readFrontendManifest(repoRoot, lock) {
  const file = path.join(repoRoot, FRONTEND_MANIFEST);
  const regenerate = 'Run `npm run licenses:frontend-packages` (builds the frontend once and records the bundled packages).';
  if (!fs.existsSync(file)) throw new Error(`Missing ${FRONTEND_MANIFEST}. ${regenerate}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.packageLockSha256 !== packageLockHash(lock)) {
    throw new Error(`${FRONTEND_MANIFEST} was generated for a different package-lock.json. ${regenerate}`);
  }
  for (const entry of manifest.packages) {
    if (!lock.packages?.[entry.path]) throw new Error(`${FRONTEND_MANIFEST} lists ${entry.path}, which is not in package-lock.json. ${regenerate}`);
  }
  return manifest;
}

/**
 * 进入产物的全部 npm 包：lock 路径 → 来源（`electron`、`frontend`，可同时有）。
 * @param {string} repoRoot
 */
export function shippedNpmPackages(repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const shipped = new Map();
  const add = (lockPath, source) => {
    const sources = shipped.get(lockPath) ?? new Set();
    sources.add(source);
    shipped.set(lockPath, sources);
  };
  for (const lockPath of electronRuntimeLockPaths(lock, rootManifest.dependencies ?? {})) add(lockPath, 'electron');
  for (const entry of readFrontendManifest(repoRoot, lock).packages) add(entry.path, 'frontend');
  return { lock, shipped };
}

/**
 * 移动端（Capacitor / Web Worker）实际进入产物的运行时依赖闭包：从 `mobile/package.json` 的
 * `dependencies` 出发按 `mobile/package-lock.json` 解析（不依赖 `mobile/node_modules` 是否已安装）。
 * @param {string} repoRoot
 */
export function mobileRuntimePackages(repoRoot) {
  const mobileDir = path.join(repoRoot, 'mobile');
  const lock = JSON.parse(fs.readFileSync(path.join(mobileDir, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
  const shipped = electronRuntimeLockPaths(lock, manifest.dependencies ?? {});
  return { lock, shipped };
}
