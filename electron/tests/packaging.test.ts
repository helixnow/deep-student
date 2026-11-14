/**
 * 三平台打包配置（macOS 签名方式、按平台翻转的 fuses）与 migrations 资源逐字节校验。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyMigrations } from '../migrations-integrity.ts';
import { builderFilter } from './builder-filter.ts';

const require = createRequire(import.meta.url);
interface FileSet { from: string; to: string; filter: string[] }
const config = require('../electron-builder.config.cjs') as {
  appId: string;
  productName: string;
  asar: boolean;
  asarUnpack: string[];
  npmRebuild: boolean;
  beforeBuild: (context: unknown) => Promise<boolean>;
  extraMetadata: { main: string };
  files: string[];
  extraResources: Array<{ from: string; to: string }>;
  mac: { target: string[]; files: FileSet[]; extendInfo: Record<string, string> } & Record<string, unknown>;
  win: { signExecutable: boolean; target: string[]; files: FileSet[] } & Record<string, unknown>;
  linux: { target: string[]; maintainer: string; files: FileSet[] };
  afterPack: (context: unknown) => Promise<void>;
  afterExtract: (context: unknown) => Promise<void>;
};
const { fuseConfig, isReleaseSigning, macSigning } = require('../scripts/app-hardening.cjs') as {
  fuseConfig(platform: string, options: { signed: boolean }): Record<string | number, unknown>;
  isReleaseSigning(env: NodeJS.ProcessEnv): boolean;
  macSigning(env: NodeJS.ProcessEnv, projectDir: string): { signed: boolean; mac: Record<string, unknown> };
};
const plist = require('plist') as { parse(xml: string): Record<string, unknown> };
const { packageFilter, collectProductionClosure } = require('../scripts/node-modules-closure.cjs') as {
  packageFilter(name: string, target: { platform: string; arch: string }): string[];
  collectProductionClosure(projectDir: string, target: { platform: string; arch: string }): Map<string, string>;
};
const root = resolve(import.meta.dirname, '..', '..');
const macMain = require('../scripts/mac-main-stub.cjs');
const buildSystemOcrId = require.resolve('../scripts/build-system-ocr.cjs');
require(buildSystemOcrId);
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('supports an external package output directory without changing the default release path', () => {
  const output = (value: string) => execFileSync(process.execPath, ['-e',
    'process.stdout.write(require(process.argv[1]).directories.output)',
    join(root, 'electron/electron-builder.config.cjs')], {
    env: { ...process.env, DS_ELECTRON_PACKAGE_OUTPUT: value }, encoding: 'utf8',
  });
  expect(output('')).toBe('release');
  expect(output('/Volumes/DSWork/new-package')).toBe('/Volumes/DSWork/new-package');
});

it('electron_builder_config_packages_all_three_platforms_mac_ad_hoc_signed_win_linux_unsigned', async () => {
  expect(config.appId).toBe('com.deepstudent.app');
  expect(config.productName).toBe('Deep Student');
  expect(config.extraMetadata.main).toBe('electron/main.ts');
  expect(config.asar).toBe(true);
  // 依赖已在工作区安装：beforeBuild 解析为 false 时 electron-builder 既不重编译也不自己收集 node_modules
  // （npmRebuild 必须为 true，beforeBuild 才会被调用）。
  expect(config.npmRebuild).toBe(true);
  await expect(config.beforeBuild({})).resolves.toBe(false);
  // fuses 因平台而异，由 afterPack 翻转（见下一个用例）；electron-builder 自己的 electronFuses 不能再翻一遍。
  expect(config).not.toHaveProperty('electronFuses');
  expect(config.mac).toMatchObject(macSigning(process.env, root).mac);
  if (!isReleaseSigning(process.env)) expect(config.mac.identity).toBe('-');
  const tauriInfo = plist.parse(readFileSync(join(root, 'resources/app', 'Info.plist'), 'utf8'));
  expect(config.mac.extendInfo).toEqual({ NSMicrophoneUsageDescription: tauriInfo.NSMicrophoneUsageDescription });
  expect(config.mac.target).toEqual(expect.arrayContaining(['dmg', 'zip']));
  // 不签名，但 exe 的图标与版本信息照常写入（win-asar-integrity.test.ts）。
  expect(config.win.signExecutable).toBe(false);
  expect(config.win).not.toHaveProperty('signAndEditExecutable');
  expect(config.win.target).toEqual(expect.arrayContaining(['nsis', 'zip']));
  expect(config.linux.target).toEqual(expect.arrayContaining(['AppImage', 'deb']));
  expect(config.linux.maintainer).toContain('@');
  expect(typeof config.afterPack).toBe('function');
});

it('electron_builder_config_ships_host_electron_contracts_and_migrations', () => {
  for (const pattern of [
    'electron/**/*', 'host/**/*', 'contracts/ipc/**/*',
    'resources/app/tauri.conf.json', 'resources/app/capabilities/**/*', 'resources/app/permissions/**/*',
    'dist/**/*',
  ]) {
    expect(config.files).toContain(pattern);
  }
  // Host 以 --tauri-dir=<app>/src-tauri 读取 ACL；这些文件必须真的存在，不能只写在 glob 里。
  for (const relative of [
    'resources/app/tauri.conf.json',
    'resources/app/capabilities/browser-content.json',
    'resources/app/permissions/application-commands.toml',
  ]) {
    expect(existsSync(join(root, relative))).toBe(true);
  }
  expect(config.extraResources).toContainEqual({ from: 'resources/app/migrations', to: 'migrations' });
  // undici 已是直接依赖，由 electron-builder 自动收集，不再手工复制。
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  expect(manifest.dependencies?.undici).toBeDefined();
  expect(config.extraResources).not.toContainEqual({ from: 'node_modules/undici', to: 'app/node_modules/undici' });
  // asar 打包后 extraResources 不能再往 Resources/app 里放 node_modules；tar 及其依赖经闭包进入 app.asar。
  expect(config.extraResources.filter((entry) => entry.to.startsWith('app/'))).toEqual([]);
  const shipped = (sets: FileSet[]) => new Map(sets.map((set) => [set.to, set]));
  const mac = shipped(config.mac.files);
  for (const name of ['undici', 'tar', '@isaacs/fs-minipass', 'chownr', 'minipass', 'minizlib', 'tough-cookie', '@deepseek-ai/cosmokit']) {
    expect(mac.get(`node_modules/${name}`)?.filter).toEqual(packageFilter(name, { platform: 'darwin', arch: process.arch }));
  }
  // 嵌套版本（tar@7 的 yallist@5、mdast-util-find-and-replace 的 ESM escape-string-regexp@5 …）不会随父目录进包：
  // electron-builder 丢弃相对 from 恰为 node_modules 的目录。每个嵌套版本必须有自己的 FileSet，位置不变。
  expect(builderFilter(packageFilter('tar', { platform: 'darwin', arch: process.arch }))('node_modules/yallist/package.json')).toBe(false);
  const closure = collectProductionClosure(root, { platform: 'darwin', arch: process.arch });
  const nested = [...closure.keys()].filter((key) => key.includes('/node_modules/'));
  expect(nested).toEqual(expect.arrayContaining(['tar/node_modules/yallist', 'mdast-util-find-and-replace/node_modules/escape-string-regexp']));
  for (const key of nested) {
    expect(mac.get(`node_modules/${key}`)?.from, key).toBe(closure.get(key));
    expect(existsSync(join(closure.get(key)!, 'package.json')), key).toBe(true);
  }
  expect(mac.get('node_modules/tar/node_modules/yallist')?.filter).toEqual(packageFilter('yallist', { platform: 'darwin', arch: process.arch }));
  expect(mac.has('node_modules/vite')).toBe(false);
  if (process.platform === 'darwin') {
    expect(mac.has(`node_modules/@koromix/koffi-darwin-${process.arch}`)).toBe(true);
    expect(shipped(config.win.files).has(`node_modules/@koromix/koffi-darwin-${process.arch}`)).toBe(false);
    expect(shipped(config.linux.files).has(`node_modules/@koromix/koffi-darwin-${process.arch}`)).toBe(false);
  }
});

it('drops Electron\'s default_app.asar after extracting a local electronDist (electron-builder only cleans downloaded dists)', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const out = mkdtempSync(join(tmpdir(), 'ds-extract-'));
    dirs.push(out);
    const resources = platform === 'darwin' ? join(out, 'Electron.app', 'Contents', 'Resources') : join(out, 'resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, 'default_app.asar'), 'demo');
    writeFileSync(join(resources, 'electron.icns'), 'icon');
    await config.afterExtract({ appOutDir: out, electronPlatformName: platform, packager: { info: { framework: { distMacOsAppName: 'Electron.app' } } } });
    expect(existsSync(join(resources, 'default_app.asar'))).toBe(false);
    expect(existsSync(join(resources, 'electron.icns'))).toBe(true);
  }
});

it('afterPack copies migrations byte for byte and flips the platform\'s fuses (macOS by signing mode)', async () => {
  const install = vi.spyOn(macMain, 'installMacMainEntry').mockImplementation(() => {});
  const ocrModule = process.platform !== 'darwin' ? require.cache[buildSystemOcrId] : undefined;
  const originalOcrExport = ocrModule?.exports;
  const buildOcr = ocrModule ? vi.fn() : undefined;
  if (ocrModule && buildOcr) ocrModule.exports = buildOcr;
  try {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const out = mkdtempSync(join(tmpdir(), 'ds-after-pack-'));
      dirs.push(out);
      const resources = platform === 'darwin' ? join(out, 'Deep Student.app', 'Contents', 'Resources') : join(out, 'resources');
      mkdirSync(join(resources, 'migrations'), { recursive: true });
      writeFileSync(join(resources, 'migrations', 'stale.sql'), 'stale');
      const flipped: unknown[][] = [];
      const context = {
        appOutDir: out,
        electronPlatformName: platform,
        packager: { projectDir: root, appInfo: { productFilename: 'Deep Student' }, addElectronFuses: async (...args: unknown[]) => { flipped.push(args); } },
      };
      await config.afterPack(context);
      expect(verifyMigrations(join(root, 'resources/app', 'migrations'), join(resources, 'migrations'))).toEqual([]);
      expect(flipped).toEqual([[context, fuseConfig(platform, { signed: macSigning(process.env, root).signed })]]);
      expect(install).toHaveBeenCalledWith(context);
      if (buildOcr && platform === 'darwin') {
        expect(buildOcr).toHaveBeenCalledWith(join(out, 'Deep Student.app', 'Contents', 'MacOS', 'dstu-system-ocr'), 'x86_64');
      }
    }
  } finally {
    if (ocrModule && originalOcrExport !== undefined) ocrModule.exports = originalOcrExport;
  }
});

it('unpacks native binaries from app.asar; .ts entries and .wasm stay inside', () => {
  expect(config.asarUnpack).toEqual(['**/*.{node,dylib,so,dll,exe}', '**/*.so.*', '**/node_modules/@esbuild/*/bin/*']);
});

it('does not ship frontend-only or build-only packages (vite bundles the renderer; images use the F7 WASI encoder)', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const mac = new Set(config.mac.files.map((set) => set.to));
  for (const name of ['react', 'mermaid', 'echarts', '@tabler/icons-react', 'lucide-react', 'pdfjs-dist', 'typescript', 'sharp', '@napi-rs/canvas']) {
    expect(manifest.dependencies[name], name).toBeUndefined();
    expect(mac.has(`node_modules/${name}`), name).toBe(false);
  }
  for (const name of ['react', 'mermaid', 'sharp', 'pdfjs-dist']) expect(manifest.devDependencies[name], name).toBeDefined();
});

it('the files patterns keep every asset the Host reads at runtime and drop tests, fixtures and work-package evidence', () => {
  const ships = builderFilter(config.files);
  const runtime = [
    'host/profiles/desktop.json',
    'host/kernel/core.ts',
    'host/platform/native/wasm/f7-native-wasm.wasm',
    'host/platform/native/wasm/worker.mjs',
    'host/platform/native/sqlite-busy/index.ts',
    'host/platform/storage/migration/worker-tasks.ts',
    'host/plugins/anki/data/builtin-templates.json',
    'host/plugins/media/assets/bilibili/pair.html',
    'host/plugins/browser/src/browser-bridge.js',
    'contracts/ipc/F1-kernel.json',
    'contracts/plugin-manifest/v1.schema.json',
    'electron/main.ts',
    'electron/preload/preload.ts',
  ];
  for (const relative of runtime) {
    expect(existsSync(join(root, relative)), relative).toBe(true);
    expect(ships(relative), relative).toBe(true);
  }
  expect(ships('electron/.build/preload.cjs')).toBe(true);
  for (const relative of [
    'host/plugins/vfs/equivalence/dstu-crud-limits.json',
    'host/e2e/smoke/README.md',
    'host/kernel/__fixtures__/x.ts',
    'host/plugins/vfs/SPEC.md',
    'host/platform/native/wp280/probe.json',
    'host/platform/native/wasm/toolchain.txt',
    // 只供测试的原生 busy handler：每个平台的预编译、校验和与源码都不进产品。
    'host/platform/native/sqlite-busy/prebuilds',
    'host/platform/native/sqlite-busy/prebuilds/f7-sqlite-busy.linux-x64.node',
    'host/platform/native/sqlite-busy/prebuilds/f7-sqlite-busy.darwin-arm64.node',
    'host/platform/native/sqlite-busy/prebuilds/f7-sqlite-busy.darwin-arm64.node.sha256',
    'host/platform/native/sqlite-busy/busy_handler.c',
    'host/platform/native/sqlite-busy/build.sh',
    'host/plugins/browser/tests/policy.test.ts',
    'electron/storage-migration/tests/fixtures.ts',
    'electron/tests/electron-process.ts',
    'electron/scripts/__tests__/packaged-smoke.mjs',
    'electron/signing/entitlements.mac.plist',
    'electron/signing/entitlements.mac.adhoc.plist',
    'electron/native/mac-main-45.2.1.cc',
    'electron/native/LICENSE.electron',
    'electron/W06-PROGRESS.md',
    // 打包图标由 electron-builder 放进 .app / exe 资源 / hicolor，运行时不读。
    'electron/resources/icons/icon.icns',
    'electron/resources/icons/png/512x512.png',
  ]) {
    expect(ships(relative), relative).toBe(false);
  }
});

it('node_modules file sets drop source maps, typings and other platforms\' prebuilds but keep the runtime entry points', () => {
  const target = { platform: 'darwin', arch: process.arch };
  const sqlite = builderFilter(packageFilter('better-sqlite3', target));
  expect(sqlite('lib/binding.js')).toBe(true);
  expect(sqlite('LICENSE')).toBe(true);
  expect(sqlite(`prebuilds/darwin-${process.arch}.node`)).toBe(true);
  for (const other of ['linux-x64', 'linuxmusl-arm64', 'win32-x64', `darwin-${process.arch === 'arm64' ? 'x64' : 'arm64'}`]) {
    expect(sqlite(`prebuilds/${other}.node`), other).toBe(false);
  }
  expect(sqlite('build/Release/better_sqlite3.node')).toBe(true);
  expect(sqlite('build/Release/obj.target/x.o')).toBe(false);
  expect(sqlite('deps/sqlite3/sqlite3.c')).toBe(false);
  expect(sqlite('src/better_sqlite3.cpp')).toBe(false);

  const tiktoken = builderFilter(packageFilter('tiktoken', target));
  for (const file of ['tiktoken.cjs', 'tiktoken_bg.cjs', 'tiktoken_bg.wasm', 'init.cjs', 'package.json']) expect(tiktoken(file), file).toBe(true);
  for (const file of ['encoders/o200k_base.json', 'lite/tiktoken_bg.wasm', 'tiktoken.d.ts', 'README.md']) expect(tiktoken(file), file).toBe(false);

  const exceljs = builderFilter(packageFilter('exceljs', target));
  expect(exceljs('excel.js')).toBe(true);
  expect(exceljs('lib/exceljs.nodejs.js')).toBe(true);
  expect(exceljs('dist/exceljs.min.js')).toBe(false);

  const docx = builderFilter(packageFilter('docx', target));
  expect(docx('dist/index.cjs')).toBe(true);
  expect(docx('dist/index.mjs')).toBe(true);
  expect(docx('dist/index.iife.js')).toBe(false);
  expect(docx('dist/index.umd.cjs')).toBe(false);

  const any = builderFilter(packageFilter('undici', target));
  for (const file of ['index.js', 'lib/web/fetch/index.js', 'LICENSE', 'LICENSE.md', 'package.json', 'nested/node_modules/x/index.js']) expect(any(file), file).toBe(true);
  for (const file of ['index.js.map', 'index.d.ts', 'types/fetch.d.mts', 'src/index.ts', 'README.md', 'CHANGELOG.md', 'test/a.js', 'binding.gyp', '.github/x.yml']) {
    expect(any(file), file).toBe(false);
  }
});

it('the documented Node entry points of trimmed packages still exist in the installed tree', () => {
  const resolveFrom = (spec: string) => require.resolve(spec, { paths: [root] });
  const toPosix = (file: string) => file.split(sep).join('/');
  expect(toPosix(resolveFrom('tiktoken'))).toMatch(/tiktoken\.cjs$/);
  expect(toPosix(resolveFrom('docx'))).toMatch(/dist\/index\.cjs$/);
  expect(toPosix(resolveFrom('exceljs'))).toMatch(/exceljs\/excel\.js$/);
  expect(existsSync(join(dirname(resolveFrom('tiktoken')), 'tiktoken_bg.wasm'))).toBe(true);
  expect(existsSync(join(dirname(resolveFrom('better-sqlite3/package.json')), 'prebuilds', `${process.platform}-${process.arch}.node`))).toBe(true);
});

it('migrations_resource_check_accepts_the_repository_tree', () => {
  const source = join(root, 'resources/app', 'migrations');
  expect(verifyMigrations(source, source)).toEqual([]);
});

it('migrations_resource_check_detects_changed_missing_and_extra_files', () => {
  const tree = () => {
    const dir = mkdtempSync(join(tmpdir(), 'f2-migrations-'));
    dirs.push(dir);
    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(join(source, 'vfs'), { recursive: true });
    mkdirSync(join(target, 'vfs'), { recursive: true });
    writeFileSync(join(source, 'vfs', 'V1__a.sql'), 'CREATE TABLE a;\n');
    writeFileSync(join(target, 'vfs', 'V1__a.sql'), 'CREATE TABLE a;\n');
    writeFileSync(join(source, 'V2__b.sql'), 'SELECT 1;\r\n');
    copyFileSync(join(source, 'V2__b.sql'), join(target, 'V2__b.sql'));
    return { source, target };
  };

  const identical = tree();
  expect(verifyMigrations(identical.source, identical.target)).toEqual([]);

  const changed = tree();
  writeFileSync(join(changed.target, 'V2__b.sql'), 'SELECT 2;\r\n');
  expect(verifyMigrations(changed.source, changed.target)).toEqual(['content mismatch: V2__b.sql']);

  const missing = tree();
  rmSync(join(missing.target, 'vfs', 'V1__a.sql'));
  expect(verifyMigrations(missing.source, missing.target)).toEqual(['missing: vfs/V1__a.sql']);

  const extra = tree();
  writeFileSync(join(extra.target, 'V3__c.sql'), '');
  expect(verifyMigrations(extra.source, extra.target)).toEqual(['unexpected: V3__c.sql']);
});
