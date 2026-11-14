// @vitest-environment node
/**
 * docs/plugins/SECURITY.md 的证据（社区插件作者视角，经生产装载路径 host/kernel/profile.ts loadProfile）：
 * - 清单筛查在导入之前：不过筛查的包，代码一行都不执行；
 * - 模块检查（meta、服务名、权限）在导入之后：模块顶层代码已经执行过；
 * - 通过装载后，Host 半与应用同进程：没有声明权限也拿得到官方服务和 Node 内置模块（`host/kernel/API.md` §16.4）。
 * 后两条是现状，不是承诺：Host 隔离（host/kernel/SEC-E06-HOST-ISOLATION-PLAN.md K4–K6）落地后会失败，届时连同文档一起改。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_VERSION, loadExample, REPO_ROOT } from './harness';

const OFFICIAL = path.join(REPO_ROOT, 'examples/testing/fixtures/empty-official.profile.json');

/** 官方服务的替身：只看社区插件能不能拿到它。 */
const SETTINGS = { marker: 'official settings service' };

type Json = Record<string, unknown>;
interface Spec {
  id: string;
  /** 覆盖 package.json 字段。 */
  pkg?: Json;
  /** 覆盖模块 meta。 */
  meta?: Json;
  inject?: string[];
}

const g = globalThis as { __w27Security?: unknown[] };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'w27-security-'));
  g.__w27Security = [];
});
afterEach(async () => {
  delete g.__w27Security;
  await rm(root, { recursive: true, force: true });
});

/** 写一个社区插件包：模块顶层记 `evaluated:<id>`，apply 记 `applied:<id>` 和它拿到的东西。 */
async function community(spec: Spec): Promise<{ id: string; module: string }> {
  const dir = path.join(root, spec.id);
  await mkdir(dir, { recursive: true });
  const pkg = {
    name: `deepstudent-plugin-${spec.id.replace(/\./g, '-')}`,
    version: '1.0.0',
    type: 'module',
    engines: { deepStudent: `^${APP_VERSION}` },
    deepStudent: { manifestVersion: 1, id: spec.id, platforms: ['desktop'], host: './index.mjs' },
    ...spec.pkg,
  };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  const meta = { id: spec.id, version: '1.0.0', provides: [], ...spec.meta };
  await writeFile(path.join(dir, 'index.mjs'), [
    `import { execFileSync } from 'node:child_process';`,
    `import { readFileSync } from 'node:fs';`,
    `const record = (...items) => globalThis.__w27Security?.push(...items);`,
    `record(${JSON.stringify(`evaluated:${spec.id}`)});`,
    `const meta = ${JSON.stringify(meta)};`,
    'export default {',
    `  name: meta.id, meta, inject: ${JSON.stringify(spec.inject ?? [])},`,
    '  apply(ctx) {',
    '    record(`applied:${meta.id}`, { settingsMarker: ctx.get("settings").marker, execFileSync: typeof execFileSync, readFileSync: typeof readFileSync });',
    '  },',
    '};',
  ].join('\n'));
  return { id: spec.id, module: path.join(dir, 'index.mjs') };
}

async function load(entries: { id: string; module: string }[]) {
  const profile = path.join(root, 'user.profile.json');
  await writeFile(profile, JSON.stringify({ extends: 'official', plugins: entries }, null, 2));
  return loadExample(profile, { official: OFFICIAL, provide: { settings: SETTINGS } });
}

describe('community Host half: what the manifest and permission checks do and do not stop (docs/plugins/SECURITY.md)', () => {
  it('a package rejected by the manifest screen never runs; one rejected by the module checks has already run its top-level code', async () => {
    const entries = [
      await community({ id: 'dstu.squatter' }),
      await community({ id: 'alice.too-new', pkg: { engines: { deepStudent: '>=99.0.0' } } }),
      await community({ id: 'alice.claims-official', meta: { provides: ['settings'] } }),
      await community({ id: 'alice.undeclared', inject: ['settings'] }),
    ];
    const { host, result } = await load(entries);
    try {
      expect(result.installed).toEqual([]);
      expect(Object.fromEntries(result.degraded.map((d) => [d.id, d.reason.split(':')[0]]))).toEqual({
        'dstu.squatter': 'ID_RESERVED',
        'alice.too-new': 'ENGINE_INCOMPATIBLE',
        'alice.claims-official': 'SERVICE_NAME_INVALID',
        'alice.undeclared': 'PERMISSION_UNDECLARED',
      });
      expect(g.__w27Security).toEqual(['evaluated:alice.claims-official', 'evaluated:alice.undeclared']);
    } finally {
      await host.dispose();
    }
  });

  it('once installed, a plugin that declares no permissions still gets official services via ctx.get and Node built-ins via import', async () => {
    const { host, result } = await load([await community({ id: 'alice.no-permissions' })]);
    try {
      expect(result.degraded).toEqual([]);
      expect(result.installed.map((p) => p.id)).toContain('alice.no-permissions');
      expect(g.__w27Security).toEqual([
        'evaluated:alice.no-permissions',
        'applied:alice.no-permissions',
        { settingsMarker: SETTINGS.marker, execFileSync: 'function', readFileSync: 'function' },
      ]);
    } finally {
      await host.dispose();
    }
  });
});
