/**
 * W06 `--safe-mode` 的 Host 半（BRIEF 第 4 条）：安全模式只允许官方（应用内）插件。
 * 外壳负责强制官方 profile 与原生对话框；Host 侧必须同样拒绝社区插件装载，不能只依赖外壳，
 * 并在 UI 清单 v2 里暴露 `safeMode` 供 W17 在装载前消费（含乐观引导）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definePlugin, UI_MANIFEST_COMMAND, type WindowRef } from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { pathToFileHref } from '../module-origin.ts';
import { loadProfile } from '../profile.ts';
import { HostRuntime } from '../runtime.ts';

const TMP = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
const SOURCE: WindowRef = { window: 'main', webview: 'main' };

let root: string;

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  root = await mkdtemp(join(TMP, 'w01-safe-mode-'));
  (globalThis as { __w01SafeModeApplied?: string[] }).__w01SafeModeApplied = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete (globalThis as { __w01SafeModeApplied?: string[] }).__w01SafeModeApplied;
});

function runtime(safeMode: boolean): HostRuntime {
  return new HostRuntime({
    app: { dataDir: join(root, 'data'), version: '0.11.0', platform: 'linux', debug: true },
    contracts: ContractSet.empty(),
    safeMode,
  });
}

/** 应用目录之外的社区插件包（`.tmp/` 在 host/ 与 electron/ 之外）。 */
async function community(id: string): Promise<{ id: string; module: string }> {
  const dir = join(root, 'packages', id.replace(/\./g, '-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `deepstudent-plugin-${id.replace(/\./g, '-')}`,
    version: '1.0.0',
    type: 'module',
    engines: { deepStudent: '^0.11' },
    deepStudent: { manifestVersion: 1, id, platforms: ['desktop'], host: './index.mjs' },
  }, null, 2));
  await writeFile(join(dir, 'index.mjs'), [
    `globalThis.__w01SafeModeApplied?.push(${JSON.stringify(id)});`,
    `export default { name: ${JSON.stringify(id)}, meta: { id: ${JSON.stringify(id)}, version: '1.0.0' }, apply() {} };`,
  ].join('\n'));
  return { id, module: join(dir, 'index.mjs') };
}

const applied = () => (globalThis as { __w01SafeModeApplied?: string[] }).__w01SafeModeApplied ?? [];

const SAFE = 'SAFE_MODE_ACTIVE: plugin "alice.safe-mode" is a community plugin; safe mode loads official plugins only';

describe('safe mode on the Host', () => {
  it('RF-W01-safe-mode-official-only: reports safeMode in the v2 manifest and still loads builtin plugins', async () => {
    const rt = runtime(true);
    try {
      await rt.install(definePlugin({ meta: { id: 'dstu.fixture' }, apply() {} }));
      const manifest = rt.uiManifestV2();
      expect(manifest).toEqual({ version: 2, plugins: [{ id: 'dstu.fixture', origin: 'builtin', platforms: ['desktop'] }], degraded: [], safeMode: true });
      await expect(rt.dispatchInvoke({ id: 'm', cmd: UI_MANIFEST_COMMAND, args: { version: 2 }, source: SOURCE }))
        .resolves.toEqual({ kind: 'ok', value: manifest });
    } finally {
      await rt.dispose();
    }
  });

  it('RF-W01-safe-mode-official-only: keeps safeMode false outside safe mode', async () => {
    const rt = runtime(false);
    try {
      expect(rt.uiManifestV2().safeMode).toBe(false);
    } finally {
      await rt.dispose();
    }
  });

  it('RF-W01-safe-mode-official-only: rejects community plugins from a profile with SAFE_MODE_ACTIVE before importing them', async () => {
    const demo = await community('alice.safe-mode');
    const rt = runtime(true);
    try {
      const profile = join(root, 'user.profile.json');
      await writeFile(profile, JSON.stringify({ plugins: [demo] }));
      const result = await loadProfile(rt, profile, { platform: 'desktop' });
      expect(result.installed).toEqual([]);
      expect(result.degraded).toEqual([{ id: 'alice.safe-mode', reason: SAFE }]);
      expect(applied()).toEqual([]);
      expect(rt.uiManifestV2()).toEqual({ version: 2, plugins: [], degraded: [{ id: 'alice.safe-mode', reason: SAFE }], safeMode: true });
    } finally {
      await rt.dispose();
    }
  });

  it('RF-W01-safe-mode-official-only: loads the same community plugin outside safe mode as a control', async () => {
    const demo = await community('alice.safe-mode');
    const rt = runtime(false);
    try {
      const profile = join(root, 'user.profile.json');
      await writeFile(profile, JSON.stringify({ plugins: [demo] }));
      const result = await loadProfile(rt, profile, { platform: 'desktop' });
      expect(result.degraded).toEqual([]);
      expect(result.installed.map((entry) => entry.id)).toEqual(['alice.safe-mode']);
      expect(applied()).toEqual(['alice.safe-mode']);
    } finally {
      await rt.dispose();
    }
  });

  it('RF-W01-safe-mode-official-only: rejects a direct community install (source outside the app) while official installs keep working', async () => {
    const demo = await community('alice.safe-mode');
    const rt = runtime(true);
    try {
      const installed = await rt.installIsolated({
        plugin: definePlugin({ meta: { id: 'alice.safe-mode' }, apply() {} }),
        source: pathToFileHref(demo.module),
      });
      expect(installed).toEqual({ ok: false, reason: SAFE });
      await expect(rt.installIsolated({ plugin: definePlugin({ meta: { id: 'alice.safe-mode' }, apply() {} }), packageRoot: join(root, 'packages') }))
        .resolves.toEqual({ ok: false, reason: SAFE });
      await rt.install(definePlugin({ meta: { id: 'dstu.fixture' }, apply() {} }));
      expect(rt.plugins().map((entry) => entry.id)).toEqual(['dstu.fixture']);
    } finally {
      await rt.dispose();
    }
  });
});
