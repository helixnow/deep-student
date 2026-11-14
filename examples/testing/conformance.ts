/**
 * 社区插件包的一致性检查（按发布给用户的标准）：W09 manifest 门禁、Host 的启动期与安装期清单检查、导入后的模块检查、
 * profile 条目 id、UI 半的元数据，以及按 package.json 的 build:ui 实际构建出的 UI 模块只依赖宿主共享的模块。
 * examples/testing/conformance.test.ts 对仓库里的每个示例调用，examples/scripts/__tests__/create-plugin.test.ts 对脚手架生成的插件调用。
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { checkManifest as gateCheckManifest } from '../../scripts/electron-migration/gate-checks/plugin-manifest.mjs';
import type { HostPlugin } from '../../host/kernel/api.ts';
import { assertInstallable, checkManifest, checkPluginModule } from '../../host/kernel/manifest.ts';
import { pluginNamespaces } from '../../host/kernel/plugin-id.ts';
import { BUILD_UI_SCRIPT, buildUi, SHARED_MODULES } from '../scripts/build-ui.mjs';
import { APP_VERSION, type ExampleManifest } from './harness';

export interface ConformanceTarget {
  /** 插件包目录（真实路径）。 */
  dir: string;
  pkg: ExampleManifest;
  /** 交给 W09 门禁的文件标签（`examples/plugins/<目录>/package.json`）；门禁只认示例与官方插件，其他来源不给。 */
  gateFile?: string;
}

function profilesOf(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.profile.json')).map((f) => path.join(dir, f));
}

export function bareImports(code: string): string[] {
  const specs = [...code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  return [...new Set(specs.filter((s) => !s.startsWith('.') && !s.startsWith('/')))].sort();
}

/** 在当前 describe 里登记一个插件包的全部一致性用例。 */
export function describeConformance({ dir, pkg, gateFile }: ConformanceTarget): void {
  const id = pkg.deepStudent.id;
  const text = readFileSync(path.join(dir, 'package.json'), 'utf8');

  if (gateFile) {
    it('passes the W09 plugin-manifest gate', () => {
      expect(gateCheckManifest({ file: gateFile, kind: 'example', text, appVersion: APP_VERSION })).toEqual([]);
    });
  }

  it('passes the Host manifest checks at startup and at install time', () => {
    const startup = checkManifest(pkg, { appVersion: APP_VERSION, context: 'community-startup', platform: 'desktop', expectedId: id });
    expect(startup.ok ? null : startup.error.message).toBeNull();
    expect(assertInstallable(pkg, { appVersion: APP_VERSION, platform: 'desktop', installed: new Map() })).toMatchObject({ id, version: pkg.version });
  });

  it('exports a Host module that matches the manifest', async () => {
    const startup = checkManifest(pkg, { appVersion: APP_VERSION, context: 'community-startup' });
    if (!startup.ok) throw startup.error;
    const plugin = (await import(pathToFileURL(path.join(dir, pkg.deepStudent.host!)).href)).default as HostPlugin<any>;
    expect(checkPluginModule(startup.manifest, plugin)).toBeNull();
    expect(plugin.meta.platforms).toEqual(pkg.deepStudent.platforms);
    expect(plugin.meta.provides).toEqual([pluginNamespaces(id).service]);
    expect(plugin.meta.ui).toBe(pkg.deepStudent.ui);
  });

  it('only has profile entries for its own id', () => {
    const ids = profilesOf(dir).flatMap((file) => (JSON.parse(readFileSync(file, 'utf8')).plugins as { id: string }[]).map((e) => e.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([id]));
  });

  // 首次导入 SDK 要转换整个 UI 内核的模块图（机器忙时数秒），这是共享准备，不属于下面用例检查的内容。
  if (pkg.deepStudent.ui) beforeAll(() => import('@deepstudent/ui'));

  it('has a UI half only if the manifest declares one, and it follows the community rules', async () => {
    const script = (pkg as { scripts?: Record<string, string> }).scripts?.['build:ui'];
    const files = readdirSync(dir);
    if (!pkg.deepStudent.ui) {
      expect(files).not.toContain('ui.tsx');
      expect(script).toBeUndefined();
      return;
    }
    const ui = (await import(pathToFileURL(path.join(dir, 'ui.tsx')).href)).default;
    expect(ui.meta).toMatchObject({ id, version: pkg.version, apiVersion: 2, host: true });
    expect(ui.meta.i18n?.namespace ?? id).toBe(pluginNamespaces(id).i18nNamespace);

    // build:ui 就是在插件目录里运行应用仓库的构建脚本（产物路径取自清单的 deepStudent.ui）。
    const [node, scriptPath, ...rest] = script?.split(/\s+/) ?? [];
    expect([node, rest]).toEqual(['node', []]);
    expect(realpathSync(path.resolve(dir, scriptPath!))).toBe(BUILD_UI_SCRIPT);
    const { outfile, code: bundle } = await buildUi({ dir, write: false });
    expect(outfile).toBe(path.resolve(dir, pkg.deepStudent.ui!));
    expect(bareImports(bundle).every((s) => SHARED_MODULES.includes(s)), bareImports(bundle).join(', ')).toBe(true);
    expect(bundle).not.toContain('react/jsx-runtime');
    expect(bundle).toContain('React.createElement');
  });
}
