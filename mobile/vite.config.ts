/**
 * 移动端原型（Web 形态）构建：主线程页面 + Web Worker 中的 Host。
 *
 * - Host 源码直接取自 `host/`（不复制）。profile 中的插件运行时闭包不含 Node 依赖
 *   （`scripts/portability/scan.mjs --profile host/profiles/mobile.json` 守护）；剩下的 `node:path` / `node:fs`（含 `/promises`）/
 *   `node:url` 只来自 kernel 的 Host 引导模块（`acl.ts`、`connection.ts`、`contracts.ts`、`profile.ts`；`mobile/tests/boot/worker-boot.test.ts` 守护），
 *   按 `src/shims/` 映射，用到未实现的部分会在运行时抛错而不是静默返回空值。
 * - `virtual:dstu-profile/mobile` 按 `host/profiles/mobile.json` 生成静态 import 表（Worker 中没有
 *   文件系统 profile，不能动态 `import(path)`）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type Plugin } from 'vite';

const MOBILE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(MOBILE_DIR, '..');
const ROOT_APP_VERSION = (JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8')) as { version: string }).version;
const HOST_PROFILES_DIR = join(REPO_DIR, 'host/profiles');
const shim = (name: string) => join(MOBILE_DIR, 'src/shims', name);

const PROFILE_ID = 'virtual:dstu-profile/mobile';
const RUST_APP_COMMANDS_ID = 'virtual:dstu-rust-app-commands';
const APP_PERMISSIONS_DIR = join(REPO_DIR, 'resources/app/permissions');

/** `resources/app/permissions/*.toml` 中 `identifier` 的 `commands.allow`（与 kernel `CapabilityAcl.fromDirectory` 同一读法）。 */
export function rustPermissionAllows(identifier: string, watch?: (file: string) => void): string[] {
  for (const file of readdirSync(APP_PERMISSIONS_DIR).filter(name => name.endsWith('.toml')).sort()) {
    const path = join(APP_PERMISSIONS_DIR, file);
    watch?.(path);
    for (const block of readFileSync(path, 'utf8').split('[[permission]]').slice(1)) {
      if (block.match(/^identifier\s*=\s*"([^"]+)"/m)?.[1] !== identifier) continue;
      const body = block.match(/commands\.allow\s*=\s*\[([^\]]*)\]/s)?.[1] ?? '';
      return [...new Set([...body.matchAll(/"([^"\n]+)"/g)].map(m => m[1]!))].sort();
    }
  }
  throw new Error(`no permission ${identifier} under resources/app/permissions`);
}

/**
 * 两个虚拟模块：
 * - `virtual:dstu-profile/mobile`：`host/profiles/mobile.json` 的静态 import 表；
 * - `virtual:dstu-rust-app-commands`：Rust `allow-application-commands` 的命令名（构建期读出，`command-acl.ts` 用它与插件
 *   `meta.commands` 求交集）。
 */
export function mobileProfile(): Plugin {
  return {
    name: 'dstu-mobile-profile',
    resolveId(id) {
      return id === PROFILE_ID || id === RUST_APP_COMMANDS_ID ? `\0${id}` : null;
    },
    load(id) {
      if (id === `\0${RUST_APP_COMMANDS_ID}`) {
        return `export default ${JSON.stringify(rustPermissionAllows('allow-application-commands', file => this.addWatchFile(file)))};\n`;
      }
      if (id !== `\0${PROFILE_ID}`) return null;
      const file = join(HOST_PROFILES_DIR, 'mobile.json');
      this.addWatchFile(file);
      const profile = JSON.parse(readFileSync(file, 'utf8')) as { plugins: { id: string; module: string; config?: unknown }[] };
      const imports = profile.plugins.map((entry, i) => `import p${i} from ${JSON.stringify(resolve(HOST_PROFILES_DIR, entry.module))};`);
      const entries = profile.plugins.map((entry, i) =>
        `{ id: ${JSON.stringify(entry.id)}, module: ${JSON.stringify(entry.module)}, plugin: p${i}${entry.config === undefined ? '' : `, config: ${JSON.stringify(entry.config)}`} }`);
      return `${imports.join('\n')}\nexport default [${entries.join(', ')}];\n`;
    },
  };
}

/** 未被上面的 shim 别名接住的 Node 内建模块直接让构建失败（Vite 默认会外部化成运行时才抛错的空壳）。 */
export function rejectNodeBuiltins(): Plugin {
  return {
    name: 'dstu-reject-node-builtins',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id.startsWith('node:')) this.error(`${id} imported by ${importer ?? '?'} has no mobile shim; the mobile Host must not load Node built-ins`);
      return null;
    },
  };
}

const CONTRACT_FILE = /\/contracts\/ipc\/[^/]+\.json$/;

/**
 * `contracts/ipc/*.json?raw` 去掉格式空白后再打进 Worker（约 2.4 MB → 1.3 MB，占 Worker 包的三分之一；
 * 这些原文是模块级常量，在 Worker 堆里常驻，V8 字符串约少 1.5 MB）：
 * 原文只交给 `JSON.parse`（`host/kernel/contract-set.ts` `parseContractSource`），解析结果不变。
 * 迁移 SQL 不能这样处理：refinery 的 checksum 按原文计算。
 */
export function compactContracts(): Plugin {
  return {
    name: 'dstu-compact-contracts',
    enforce: 'pre',
    load(id) {
      const [file, query] = id.split('?', 2);
      if (query !== 'raw' || !CONTRACT_FILE.test(file!)) return null;
      this.addWatchFile(file!);
      return `export default ${JSON.stringify(JSON.stringify(JSON.parse(readFileSync(file!, 'utf8'))))};\n`;
    },
  };
}

/** 带 `node:` 前缀与不带前缀的写法都映射（业务插件与前端依赖两种都用）。 */
const builtin = (name: string, file: string) => ({ find: new RegExp(`^(?:node:)?${name.replace('/', '\\/')}$`), replacement: shim(file) });

export const NODE_SHIM_ALIASES = [
  { find: /^node:path$/, replacement: shim('path.ts') },
  { find: /^node:url$/, replacement: shim('url.ts') },
  { find: /^node:fs$/, replacement: shim('fs.ts') },
  { find: /^node:fs\/promises$/, replacement: shim('fs-promises.ts') },
  builtin('crypto', 'crypto.ts'),
  builtin('events', 'events.ts'),
  builtin('buffer', 'buffer.ts'),
  builtin('os', 'os.ts'),
  builtin('util', 'util.ts'),
  builtin('child_process', 'child-process.ts'),
  { find: /^node:async_hooks$/, replacement: shim('async-hooks.ts') },
  { find: /^node:stream$/, replacement: shim('stream.ts') },
  { find: /^node:zlib$/, replacement: shim('zlib.ts') },
  { find: /^decode-named-character-reference$/, replacement: join(REPO_DIR, 'node_modules/decode-named-character-reference/index.js') },
];

/**
 * `--mode app`：外壳 + 完整 React 前端（`app.html` → 产物 index.html，见 `vite.app.ts`），Capacitor 打包用这份。
 * 其余模式（production / diagnostics / development）是最小验证页（index.html + spike.html），Playwright 用例与启动测试测的是它们。
 */
export const APP_MODE = 'app';

const base = defineConfig({
  root: MOBILE_DIR,
  appType: 'mpa',
  plugins: [rejectNodeBuiltins(), mobileProfile()],
  define: {
    'import.meta.env.VITE_DSTU_APP_VERSION': JSON.stringify(ROOT_APP_VERSION),
  },
  resolve: {
    alias: NODE_SHIM_ALIASES,
  },
  server: {
    port: 5317,
    strictPort: true,
    fs: { allow: [REPO_DIR] },
  },
  preview: { port: 5318, strictPort: true },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    format: 'es',
    plugins: () => [rejectNodeBuiltins(), mobileProfile(), compactContracts()],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        main: join(MOBILE_DIR, 'index.html'),
        spike: join(MOBILE_DIR, 'spike.html'),
      },
    },
  },
});

export default defineConfig(async ({ mode }) => {
  if (mode !== APP_MODE) return base;
  const { appConfig } = await import('./vite.app.ts');
  const merged = mergeConfig(base, appConfig(MOBILE_DIR, REPO_DIR));
  // input 整体替换（mergeConfig 会把 spike 合并进来）；构建产物的 base 用相对路径，Capacitor 从 https://localhost/ 加载。
  merged.build.rollupOptions.input = { main: join(MOBILE_DIR, 'app.html') };
  merged.base = './';
  return merged;
});
