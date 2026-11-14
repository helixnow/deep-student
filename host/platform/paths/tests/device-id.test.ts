/**
 * R4 P06：`data_space/device_id.rs::get_device_id()` 的底层身份优先级
 * （env → 主 `.device_id` → 旧路径并迁移）与 `commands_sync.rs` 旧根优先包装的区分。
 *
 * 同时验证生产 paths 插件把设备身份日志接到注入的 `ctx.log`，而不是 console。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, definePlugin, type TestHost } from '../../../kernel/testing.ts';
import { orderForProfile } from '../../../kernel/profile.ts';
import logPlugin from '../../log/index.ts';
import pathsPlugin from '../index.ts';
import { createPaths, normalizeDeviceId } from '../index.ts';

const dirs: string[] = [];
const hosts: TestHost[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'f4-device-id-'));
  dirs.push(dir);
  return dir;
}

function write(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function envFor(dir: string): Record<string, string | undefined> {
  return {
    HOME: join(dir, 'home'),
    XDG_DATA_HOME: join(dir, 'xdg-data'),
    XDG_CONFIG_HOME: join(dir, 'xdg-config'),
    XDG_CACHE_HOME: join(dir, 'xdg-cache'),
    HOSTNAME: 'box',
  };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('data_space/device_id.rs::get_device_id', () => {
  it('env takes precedence over primary and legacy and is normalized', async () => {
    const dir = tempDir();
    const injected = { ...envFor(dir), DEVICE_ID: 'env id!' };
    write(join(dir, '.device_id'), 'primary-id');
    write(join(dir, 'device_id'), 'legacy-id');
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: injected, log: () => {} });
    expect(await paths.dataSpaceDeviceId()).toBe(normalizeDeviceId('env id!'));
  });

  it('primary .device_id takes precedence over legacy without env', async () => {
    const dir = tempDir();
    write(join(dir, '.device_id'), 'primary-id');
    write(join(dir, 'device_id'), 'legacy-id');
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: envFor(dir), log: () => {} });
    expect(await paths.dataSpaceDeviceId()).toBe('primary-id');
    expect(readFileSync(join(dir, 'device_id'), 'utf8')).toBe('legacy-id');
  });

  it('legacy device_id is normalized and migrated to primary', async () => {
    const dir = tempDir();
    write(join(dir, 'device_id'), '  ../legacy id \n');
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: envFor(dir), log: () => {} });
    const expected = normalizeDeviceId('../legacy id');
    expect(await paths.dataSpaceDeviceId()).toBe(expected);
    expect(readFileSync(join(dir, '.device_id'), 'utf8').trim()).toBe(expected);
    expect(await paths.dataSpaceDeviceId()).toBe(expected);
  });

  it('generates and persists a hostname-prefixed id when no source exists', async () => {
    const dir = tempDir();
    const logs: Array<{ level: string; message: string }> = [];
    const paths = createPaths({
      dataDir: dir,
      platform: 'linux',
      env: envFor(dir),
      log: (level, message) => logs.push({ level, message }),
    });
    const id = await paths.dataSpaceDeviceId();
    expect(id).toMatch(/^box-[0-9a-f]{8}$/);
    expect(readFileSync(join(dir, '.device_id'), 'utf8').trim()).toBe(id);
    expect(logs.some(entry => entry.level === 'info')).toBe(true);
  });

  it('a primary .device_id that is not valid UTF-8 counts as absent: legacy copy wins and is migrated over it', async () => {
    // device_id.rs:76-77 `read_to_string(path).ok()?`：非法 UTF-8 是读取错误，该候选视为不存在。
    const dir = tempDir();
    writeFileSync(join(dir, '.device_id'), Buffer.from([0x62, 0x6f, 0x78, 0xff, 0x2d, 0x31]));
    write(join(dir, 'home', 'deep-student', '.device_id'), 'global-id');
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: envFor(dir), log: () => {} });
    expect(await paths.dataSpaceDeviceId()).toBe('global-id');
    expect(readFileSync(join(dir, '.device_id'), 'utf8')).toBe('global-id');
  });

  it('with no readable candidate a non-UTF-8 primary is replaced by a fresh hostname id, not a hash of its bytes', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.device_id'), Buffer.from([0xc3, 0x28]));
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: envFor(dir), log: () => {} });
    const id = await paths.dataSpaceDeviceId();
    expect(id).toMatch(/^box-[0-9a-f]{8}$/);
    expect(readFileSync(join(dir, '.device_id'), 'utf8')).toBe(id);
  });

  it('commands_sync wrapper skips a legacy-root device_id that is not valid UTF-8', async () => {
    // commands_sync.rs:1201 `if let Ok(id) = read_to_string(&legacy_path)`：读取失败落到权威实现。
    const dir = tempDir();
    write(join(dir, '.device_id'), 'primary-id');
    writeFileSync(join(dir, 'device_id'), Buffer.from([0x6c, 0x65, 0x67, 0x80]));
    const injected = envFor(dir);
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: injected, log: () => {} });
    expect(await paths.deviceId()).toBe('primary-id');
    expect(injected.DEVICE_ID).toBeUndefined();
  });

  it('commands_sync wrapper keeps legacy-root-first semantics and writes env', async () => {
    const dir = tempDir();
    write(join(dir, '.device_id'), 'primary-id');
    write(join(dir, 'device_id'), 'legacy-id');
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: envFor(dir), log: () => {} });
    expect(await paths.deviceId()).toBe('legacy-id');
    // 包装层已把旧值写回内部 DEVICE_ID，底层入口随后读到同一身份。
    expect(await paths.dataSpaceDeviceId()).toBe('legacy-id');
  });
});

describe('paths plugin device identity logging', () => {
  it('V01-06: log injects paths, so profile ordering always installs paths before log', () => {
    const ordered = orderForProfile([{ plugin: logPlugin }, { plugin: pathsPlugin }]);
    expect(ordered.map(entry => entry.plugin.meta.id)).toEqual(['dstu.platform.paths', 'dstu.platform.log']);
  });

  it('V01-06: log installed after paths (the real profile order) still receives device identity logs', async () => {
    const dir = tempDir();
    const appDir = join(dir, 'app');
    mkdirSync(appDir, { recursive: true });
    const saved = process.env.DEVICE_ID;
    delete process.env.DEVICE_ID;
    const calls: Array<{ level: string; target: string; message: string }> = [];
    const fakeLog = definePlugin({
      meta: { id: 'fixture.log-after-paths', provides: ['log'] },
      inject: ['paths'],
      apply(ctx) {
        ctx.reflect.provide('log', {
          logger(target: string) {
            const push = (level: string) => (message: string) => calls.push({ level, target, message });
            return { target, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'), trace: push('trace') };
          },
        });
      },
    });
    try {
      const host = await createTestHost({ app: { dataDir: appDir, platform: 'linux' }, plugins: [pathsPlugin] });
      hosts.push(host);
      await host.install(fakeLog);
      await host.ctx.paths.dataSpaceDeviceId();
      expect(calls).toContainEqual({ level: 'info', target: 'dstu_storage::data_space::device_id', message: `新设备 ID 已保存到主路径: ${join(appDir, '.device_id')}` });

      await host.unload('fixture.log-after-paths');
      calls.length = 0;
      await expect(host.ctx.paths.rotateDeviceIdAfterRestore()).resolves.toHaveLength(2);
      expect(calls).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.DEVICE_ID;
      else process.env.DEVICE_ID = saved;
    }
  });

  it('V01-06: a log service whose logger() yields nothing falls back to the Cordis logger instead of throwing', async () => {
    const dir = tempDir();
    const appDir = join(dir, 'app');
    mkdirSync(appDir, { recursive: true });
    const saved = process.env.DEVICE_ID;
    delete process.env.DEVICE_ID;
    try {
      const host = await createTestHost({
        app: { dataDir: appDir, platform: 'linux' },
        plugins: [pathsPlugin],
        provide: { log: { logger: () => undefined } },
      });
      hosts.push(host);
      await expect(host.ctx.paths.dataSpaceDeviceId()).resolves.toEqual(expect.any(String));
    } finally {
      if (saved === undefined) delete process.env.DEVICE_ID;
      else process.env.DEVICE_ID = saved;
    }
  });

  it('routes device identity logs through ctx.log instead of console', async () => {
    const dir = tempDir();
    const appDir = join(dir, 'app');
    mkdirSync(appDir, { recursive: true });
    mkdirSync(join(dir, 'tmp'), { recursive: true });

    const saved = new Map<string, string | undefined>();
    for (const key of ['DEVICE_ID', 'HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'HOSTNAME', 'TMPDIR']) {
      saved.set(key, process.env[key]);
    }
    delete process.env.DEVICE_ID;
    process.env.HOME = join(dir, 'home');
    process.env.XDG_DATA_HOME = join(dir, 'xdg-data');
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg-config');
    process.env.XDG_CACHE_HOME = join(dir, 'xdg-cache');
    process.env.HOSTNAME = 'box';
    process.env.TMPDIR = join(dir, 'tmp');

    const calls: Array<{ level: string; target: string; message: string }> = [];
    const logService = {
      logger(target: string) {
        const push = (level: string) => (message: string) => calls.push({ level, target, message });
        return { target, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'), trace: push('trace') };
      },
    };

    try {
      const host = await createTestHost({
        app: { dataDir: appDir, platform: 'linux' },
        provide: { log: logService },
        plugins: [pathsPlugin],
      });
      hosts.push(host);
      const id = await host.ctx.paths.dataSpaceDeviceId();
      expect(id).toMatch(/^box-[0-9a-f]{8}$/);
      expect(calls.some(call => call.level === 'info' && call.target === 'dstu_storage::data_space::device_id')).toBe(true);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
