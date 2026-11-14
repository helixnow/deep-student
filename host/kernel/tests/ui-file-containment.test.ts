/**
 * SEC-E12（`reviews/ELECTRON-SHELL-SECURITY.md`）：`meta.ui` 可以用 `../` 或绝对路径指到插件包外，外壳的 `ds-plugin://`
 * 以 UI 文件所在目录为服务根，于是整个上层目录都能被应用页面读取。UI 清单（v1 / v2）现在只收录位于插件包根目录
 * （profile 筛查时找到的 `package.json` 所在目录；直接安装、没有包根时为模块所在目录）之内的 UI 文件。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definePlugin } from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { fileUrlWithin } from '../module-origin.ts';
import { loadProfile } from '../profile.ts';
import { createTestHost, type TestHost } from '../testing.ts';

/** Vitest 只能导入仓库内的模块：社区插件包写到仓库根的 `.tmp/`（已 gitignore，位于 host/、electron/ 之外即社区来源）。 */
const TMP = fileURLToPath(new URL('../../../.tmp/', import.meta.url));

let root: string;
let host: TestHost | null = null;
let warnings: string[] = [];

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  root = await mkdtemp(join(TMP, 'w01-ui-file-'));
  warnings = [];
});
afterEach(async () => {
  await host?.dispose();
  host = null;
  await rm(root, { recursive: true, force: true });
});

async function newHost(): Promise<TestHost> {
  host = await createTestHost({ app: { version: '0.11.0', dataDir: join(root, 'data') }, contracts: ContractSet.empty() });
  host.runtime.ctx.logger.exporter({ levels: { default: 4 }, export: message => { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
  return host;
}

/** 社区插件包：`package.json` 在包根，Host 半在 `src/index.mjs`（与包根不同目录，用来区分“包根”与“模块目录”）。 */
async function communityPackage(id: string, ui: string): Promise<{ id: string; module: string; dir: string }> {
  const dir = join(root, 'packages', id);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `deepstudent-plugin-${id.replace(/\./g, '-')}`,
    version: '1.0.0',
    type: 'module',
    engines: { deepStudent: '^0.11' },
    deepStudent: { manifestVersion: 1, id, platforms: ['desktop'], host: './src/index.mjs', ui: './dist/ui.js' },
  }));
  await writeFile(join(dir, 'src', 'index.mjs'), `export default { name: ${JSON.stringify(id)}, meta: ${JSON.stringify({ id, version: '1.0.0', ui })}, apply() {} };\n`);
  return { id, module: join(dir, 'src', 'index.mjs'), dir };
}

async function loadCommunity(...plugins: { id: string; module: string }[]) {
  const path = join(root, 'user.profile.json');
  await writeFile(path, JSON.stringify({ plugins: plugins.map(({ id, module }) => ({ id, module })) }));
  const result = await loadProfile((await newHost()).runtime, path);
  expect(result.degraded).toEqual([]);
}

const outside = (ui: string, id: string, rootDir: string) =>
  `[host] meta.ui ${JSON.stringify(ui)} of plugin "${id}" resolves outside its package ${rootDir}; its UI half is not listed`;

describe('SEC-E12 meta.ui must stay inside the plugin package', () => {
  it('profile-loaded plugins: the package root (package.json directory) bounds meta.ui, not the module directory', async () => {
    const inside = await communityPackage('example.inside', '../dist/ui.js');
    const escapes = await communityPackage('example.escapes', '../../../ui.js');
    const absolute = await communityPackage('example.absolute', '/etc/ui.js');
    await loadCommunity(inside, escapes, absolute);
    const runtime = host!.runtime;

    expect(runtime.uiManifest()).toEqual([{ id: 'example.inside', file: join(inside.dir, 'dist', 'ui.js'), version: '1.0.0' }]);
    expect(runtime.uiManifestV2().plugins.map(p => [p.id, p.file])).toEqual([
      ['example.inside', join(inside.dir, 'dist', 'ui.js')],
      ['example.escapes', undefined],
      ['example.absolute', undefined],
    ]);
    expect(warnings).toContain(outside('../../../ui.js', 'example.escapes', escapes.dir));
    expect(warnings).toContain(outside('/etc/ui.js', 'example.absolute', absolute.dir));
    expect(warnings.some(w => w.includes('example.inside'))).toBe(false);
  });

  it('a plugin whose meta.ui names the package root itself is not listed', async () => {
    const self = await communityPackage('example.self', '..');
    await loadCommunity(self);
    expect(host!.runtime.uiManifest()).toEqual([]);
    expect(warnings).toContain(outside('..', 'example.self', self.dir));
  });

  it('direct installs without a package root are bounded by the module directory', async () => {
    const runtime = (await newHost()).runtime;
    const moduleDir = join(root, 'direct');
    const source = pathToFileURL(join(moduleDir, 'index.mjs')).href;
    await runtime.installAll([
      { plugin: definePlugin({ meta: { id: 'example.direct-ok', ui: './ui.mjs' }, apply() {} }), source },
      { plugin: definePlugin({ meta: { id: 'example.direct-up', ui: '../ui.mjs' }, apply() {} }), source },
    ]);
    expect(runtime.uiManifest()).toEqual([{ id: 'example.direct-ok', file: join(moduleDir, 'ui.mjs') }]);
    expect(warnings).toContain(outside('../ui.mjs', 'example.direct-up', join(moduleDir, '/')));
  });
});

describe('fileUrlWithin', () => {
  it('compares normalized path components (posix)', () => {
    expect(fileUrlWithin('file:///a/pkg/dist/ui.js', '/a/pkg', false)).toBe(true);
    expect(fileUrlWithin('file:///a/pkg/dist/ui.js', '/a/pkg/', false)).toBe(true);
    expect(fileUrlWithin('file:///a/pkg/dist/ui.js', '/a/x/../pkg', false)).toBe(true);
    expect(fileUrlWithin('file:///a/pkg', '/a/pkg', false)).toBe(false);
    expect(fileUrlWithin('file:///a/pkg-evil/ui.js', '/a/pkg', false)).toBe(false);
    expect(fileUrlWithin('file:///a/ui.js', '/a/pkg', false)).toBe(false);
    expect(fileUrlWithin('file:///A/pkg/ui.js', '/a/pkg', false)).toBe(false);
  });

  it('is case-insensitive on Windows and handles drive roots', () => {
    expect(fileUrlWithin('file:///C:/Users/Me/Pkg/ui.js', 'c:\\users\\me\\pkg', true)).toBe(true);
    expect(fileUrlWithin('file:///C:/Users/Me/Pkg-evil/ui.js', 'C:\\Users\\Me\\Pkg', true)).toBe(false);
    expect(fileUrlWithin('file:///C:/ui.js', 'C:\\', true)).toBe(true);
    expect(fileUrlWithin('file:///D:/ui.js', 'C:\\', true)).toBe(false);
  });
});
