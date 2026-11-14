/**
 * 第三方声明的 npm 口径：实际进入产物的包（Electron 运行时闭包 + 前端 bundle 清单），与依赖类型无关。
 * 前端库（react 等）是 devDependencies 但打包进 dist，必须出现；纯构建工具不进产物，不得出现。
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectNpmRecords } from '../../scripts/generate-third-party-notices.mjs';
import {
  electronRuntimeLockPaths,
  lockPathOfModule,
  packageLockHash,
  readFrontendManifest,
  shippedNpmPackages,
} from '../../scripts/licenses/shipped-npm-packages.mjs';

const root = join(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const { collectProductionClosure } = require('../scripts/node-modules-closure.cjs') as {
  collectProductionClosure(projectDir: string, target: { platform: string; arch: string; libc?: string }): Map<string, string>;
};
const hostLibc = process.platform !== 'linux' ? {}
  : { libc: (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? 'glibc' : 'musl' };
const hostTarget = { platform: process.platform, arch: process.arch, ...hostLibc };
const BUILD_ONLY = ['vite', 'typescript', 'rollup', 'vitest', 'electron', 'electron-builder', '@vitejs/plugin-react', 'tailwindcss', 'vite-plugin-static-copy'];

describe('third-party notices list what ships, not what is a production dependency', () => {
  it('frontend libraries bundled into dist are listed although they are devDependencies; build tools are not', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    const ids = new Set(collectNpmRecords().map((record) => record.id.replace(/@[^@]+$/, '')));
    for (const name of ['react', 'react-dom', 'mermaid', 'katex', 'pdfjs-dist']) {
      expect(manifest.devDependencies[name], name).toBeDefined();
      expect(ids.has(name), name).toBe(true);
    }
    // 只经前端库间接进入 bundle 的包同样在内。
    expect(ids.has('echarts')).toBe(true);
    for (const name of BUILD_ONLY) expect(ids.has(name), name).toBe(false);
    // esbuild now ships for the plugin workshop compiler, rather than only running at build time.
    expect(ids.has('esbuild')).toBe(true);
    // Electron 运行时依赖照旧在内，包括后端 Sentry 与它带进 app.asar 的 OpenTelemetry 依赖。
    for (const name of ['better-sqlite3', 'undici', 'tar', '@deepseek-ai/schemastery', '@sentry/node', '@sentry/core', '@sentry/opentelemetry', '@opentelemetry/api', 'import-in-the-middle']) {
      expect(ids.has(name), name).toBe(true);
    }
  });

  it('the committed frontend manifest matches the current lock and records how each package got into dist', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const manifest = readFrontendManifest(root, lock);
    const via = new Map(manifest.packages.map((entry) => [entry.path, entry.via]));
    expect(via.get('node_modules/react')).toContain('bundle');
    // pdf.worker、cmaps、standard_fonts、wasm 由 vite-plugin-static-copy 原样复制。
    expect(via.get('node_modules/pdfjs-dist')).toContain('static-copy');
    for (const name of BUILD_ONLY) expect(via.has(`node_modules/${name}`), name).toBe(false);
  });

  it('a manifest generated for another lock is rejected instead of silently used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-notices-'));
    const lock = { lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/react': { version: '19.0.0', dev: true } } };
    mkdirSync(join(dir, 'legal'));
    writeFileSync(join(dir, 'legal', 'frontend-bundle-packages.json'), JSON.stringify({ packageLockSha256: 'stale', packages: [] }));
    expect(() => readFrontendManifest(dir, lock)).toThrow(/different package-lock\.json/);
    writeFileSync(join(dir, 'legal', 'frontend-bundle-packages.json'), JSON.stringify({ packageLockSha256: packageLockHash(lock), packages: [{ path: 'node_modules/gone' }] }));
    expect(() => readFrontendManifest(dir, lock)).toThrow(/not in package-lock\.json/);
  });

  it('the Electron runtime closure from the lock covers every release platform and agrees with the packaging closure', () => {
    const lock = {
      packages: {
        '': {},
        'node_modules/native': { optionalDependencies: { 'native-darwin-arm64': '1', 'native-linux-x64': '1', 'native-freebsd-x64': '1' } },
        'node_modules/native-darwin-arm64': { os: ['darwin'], cpu: ['arm64'], optional: true },
        'node_modules/native-linux-x64': { os: ['linux'], cpu: ['x64'], optional: true },
        'node_modules/native-freebsd-x64': { os: ['freebsd'], cpu: ['x64'], optional: true },
        'node_modules/tar': { dependencies: { yallist: '^5' } },
        'node_modules/tar/node_modules/yallist': { version: '5.0.0' },
        'node_modules/yallist': { version: '4.0.0', dev: true },
        'node_modules/vite': { dev: true },
      },
    };
    expect([...electronRuntimeLockPaths(lock, { native: '1', tar: '7' })].sort()).toEqual([
      'node_modules/native', 'node_modules/native-darwin-arm64', 'node_modules/native-linux-x64',
      'node_modules/tar', 'node_modules/tar/node_modules/yallist',
    ]);
    expect(() => electronRuntimeLockPaths(lock, { missing: '1' })).toThrow(/missing/);
    const libcLock = {
      packages: {
        '': {},
        'node_modules/native': { optionalDependencies: { 'native-linux-x64-gnu': '1', 'native-linux-x64-musl': '1' } },
        'node_modules/native-linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'], optional: true },
        'node_modules/native-linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'], optional: true },
      },
    };
    expect([...electronRuntimeLockPaths(libcLock, { native: '1' }, [{ platform: 'linux', arch: 'x64', libc: 'glibc' }])].sort())
      .toEqual(['node_modules/native', 'node_modules/native-linux-x64-gnu']);
    expect(electronRuntimeLockPaths(libcLock, { native: '1' }, [{ platform: 'linux', arch: 'x64' }]).size).toBe(3);

    // 打包闭包按已安装的树计算，只能和本机平台（npm 按 os/cpu/libc 装了哪些可选原生包）对照。
    const { lock: realLock, shipped } = shippedNpmPackages(root);
    const rootDependencies = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies;
    const fromLock = electronRuntimeLockPaths(realLock, rootDependencies, [hostTarget]);
    const installed = new Set([...collectProductionClosure(root, hostTarget).keys()].map((key) => `node_modules/${key}`));
    expect(fromLock.size).toBeGreaterThan(200);
    for (const lockPath of fromLock) {
      expect(installed.has(lockPath), lockPath).toBe(true);
      expect(shipped.get(lockPath)?.has('electron'), lockPath).toBe(true);
    }
    // 打包闭包按已安装的树计算。共享 node_modules 尚未按新 lock 重装时会多出 lock 里已删除的包；
    // 多出的只能是这些包本身，或只经它们（按已安装的 package.json）引入的依赖。
    const stale = [...installed].filter((lockPath) => realLock.packages[lockPath] === undefined);
    const reachable = new Set(stale);
    for (const lockPath of reachable) {
      const manifest = JSON.parse(readFileSync(join(root, lockPath, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      for (const name of Object.keys(manifest.dependencies ?? {})) reachable.add(`node_modules/${name}`);
    }
    for (const lockPath of installed) {
      if (!fromLock.has(lockPath)) expect(reachable.has(lockPath), lockPath).toBe(true);
    }
  });

  it('module ids map to the lock path of their package, including scoped and nested packages', () => {
    const base = dirname(root);
    expect(lockPathOfModule(`${base}/node_modules/react/cjs/react.production.js`)).toBe('node_modules/react');
    expect(lockPathOfModule(`${base}/node_modules/@tabler/icons-react/dist/esm/icons/IconX.mjs?commonjs-es-import`)).toBe('node_modules/@tabler/icons-react');
    expect(lockPathOfModule(`\0${base}/node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp/index.js`))
      .toBe('node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp');
    expect(lockPathOfModule(`${root}/src/main.tsx`)).toBeNull();
    expect(lockPathOfModule('\0vite/preload-helper.js')).toBeNull();
  });
});
