/**
 * 用户 profile（`docs/plugins/SDK.md` §1、§6）：
 * - `extends: "official"` 解析到官方 profile；
 * - 用户条目按 id 覆盖官方插件并保留位置；
 * - 用户 profile 优先；结构错误才回退官方 profile。社区模块缺失或导入失败按插件隔离；
 * - 显式 profile 的**文件级**失败仍是 HostFatal。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostTransport } from '../connection.ts';
import { serveHost } from '../connection.ts';
import { ContractSet } from '../contracts.ts';
import { HOST_PROTOCOL_VERSION, type Handshake, type HostToMain } from '../protocol.ts';
import { loadStartupProfile, PROFILE_FAILED_EVENT, resolveProfile } from '../profile.ts';
import { HostRuntime } from '../runtime.ts';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const OFFICIAL = `${FIXTURES}e2e.profile.json`;
const SOURCE = { window: 'main', webview: 'main' };
const contracts = () => ContractSet.fromDirectory(`${FIXTURES}contracts`);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-user-profile-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(dataDir: string) {
  return { dataDir, version: '0.0.0-test', platform: 'linux' as const, debug: true };
}

/** 平台核心服务替身：本文件只关心 profile 选择/回退，平台服务的真实行为由 F3/F4 覆盖。 */
function provideCoreServices(runtime: HostRuntime): void {
  runtime.ctx.provide('paths', {});
  runtime.ctx.provide('storage', {});
  runtime.ctx.provide('log', {});
}

async function greet(runtime: HostRuntime, name: string): Promise<unknown> {
  return runtime.dispatchInvoke({ id: 'p', cmd: 'fixture_greet', args: { name }, source: SOURCE });
}

/** 进程内传输：记录 Host 发出的消息，手动投递 main→Host 消息。 */
class MemoryTransport implements HostTransport {
  readonly received: HostToMain[] = [];
  private listener: (message: unknown) => void = () => undefined;
  send(message: HostToMain): void {
    this.received.push(message);
  }
  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }
  onClose(): void {}
  close(): void {}
  deliver(message: unknown): void {
    this.listener(message);
  }
}

const handshake = (appDataDir: string, extra: Partial<Handshake> = {}): Handshake => ({
  kind: 'handshake',
  protocol: HOST_PROTOCOL_VERSION,
  appDataDir,
  appVersion: '0.0.0-test',
  platform: 'linux',
  debug: true,
  ...extra,
});

describe('user profile', () => {
  it('resolves extends "official" and lets user entries override official plugins in place', async () => {
    const dir = tempDir();
    const user = join(dir, 'user.profile.json');
    writeFileSync(user, JSON.stringify({
      extends: ['official'],
      plugins: [{ id: 'fixture.greeter', module: `${FIXTURES}greeter-override.plugin.ts` }],
    }));

    const entries = await resolveProfile(user, { official: OFFICIAL });
    expect(entries.map(entry => [entry.id, entry.specifier.endsWith('greeter-override.plugin.ts')])).toEqual([['fixture.greeter', true]]);
    expect(entries[0]!.declaredIn).toBe(user);

    const runtime = new HostRuntime({ app: app(dir), contracts: contracts() });
    provideCoreServices(runtime);
    try {
      const { installed } = await loadStartupProfile(runtime, { official: OFFICIAL, userProfile: user });
      expect(installed.map(entry => entry.id)).toEqual(['fixture.greeter']);
      await expect(greet(runtime, 'Ada')).resolves.toEqual({ kind: 'ok', value: 'Overridden, Ada' });
    } finally {
      await runtime.dispose();
    }
  });

  it('loads the official profile when no user profile exists', async () => {
    const dir = tempDir();
    const runtime = new HostRuntime({ app: app(dir), contracts: contracts() });
    provideCoreServices(runtime);
    try {
      const { installed } = await loadStartupProfile(runtime, { official: OFFICIAL });
      expect(installed.map(entry => entry.id)).toEqual(['fixture.greeter']);
      await expect(greet(runtime, 'Ada')).resolves.toEqual({ kind: 'ok', value: 'Hi, Ada' });
    } finally {
      await runtime.dispose();
    }
  });

  it('isolates a missing community module without invalidating the user profile', async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'plugins'), { recursive: true });
    const user = join(dataDir, 'plugins', 'user.profile.json');
    writeFileSync(user, JSON.stringify({
      extends: 'official',
      plugins: [{ id: 'fixture.missing', module: './missing.plugin.ts' }],
    }));

    const transport = new MemoryTransport();
    const session = serveHost(transport, {
      officialProfile: OFFICIAL,
      contracts,
      onRuntime(runtime) {
        provideCoreServices(runtime);
      },
    });
    transport.deliver(handshake(dataDir));
    const runtime = await session.ready;
    expect(runtime).not.toBeNull();
    try {
      expect(runtime!.plugins().map(entry => entry.id)).toEqual(['fixture.greeter']);
      await expect(greet(runtime!, 'Ada')).resolves.toEqual({ kind: 'ok', value: 'Hi, Ada' });

      const failed = transport.received.filter(message => message.kind === 'event' && message.event === PROFILE_FAILED_EVENT);
      expect(failed).toHaveLength(0);
      expect(runtime!.degradedPlugins()).toEqual([{ id: 'fixture.missing', reason: expect.stringMatching(/^IMPORT_FAILED:/) }]);
      expect(transport.received.some(message => message.kind === 'ready')).toBe(true);
      expect(transport.received).toContainEqual(expect.objectContaining({ event: 'host://plugins-degraded', payload: runtime!.degradedPlugins() }));
    } finally {
      await session.shutdown();
    }
  });

  it('treats the shell handshake profile at the default user path as a fallback candidate', async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'plugins'), { recursive: true });
    const user = join(dataDir, 'plugins', 'user.profile.json');
    writeFileSync(user, '{ malformed user profile');

    const transport = new MemoryTransport();
    const session = serveHost(transport, {
      officialProfile: OFFICIAL,
      contracts,
      onRuntime(runtime) { provideCoreServices(runtime); },
    });
    // Electron 外壳（host-profile.ts）把用户 profile 路径放进握手字段；Host 仍需回退。
    transport.deliver(handshake(dataDir, { profile: user }));
    const runtime = await session.ready;
    expect(runtime).not.toBeNull();
    try {
      expect(runtime!.plugins().map(entry => entry.id)).toEqual(['fixture.greeter']);
      const failed = transport.received.filter(message => message.kind === 'event' && message.event === PROFILE_FAILED_EVENT);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ payload: { profile: user } });
    } finally {
      await session.shutdown();
    }
  });

  it('requires platform core services when the shell hands over the official profile', async () => {
    const dataDir = tempDir();
    const transport = new MemoryTransport();
    const session = serveHost(transport, { officialProfile: OFFICIAL, contracts });
    transport.deliver(handshake(dataDir, { profile: OFFICIAL }));
    await expect(session.ready).resolves.toBeNull();
    const fatal = transport.received.find((message): message is Extract<HostToMain, { kind: 'fatal' }> => message.kind === 'fatal');
    expect(fatal?.message).toContain('platform core services unavailable: "storage", "paths", "log"');
  });

  it('does not fall back when a valid user profile has a plugin-level apply failure', async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'plugins'), { recursive: true });
    const user = join(dataDir, 'plugins', 'user.profile.json');
    // 文件与模块都有效，只有插件自身 apply 失败 → 按插件隔离，不触发官方 profile 回退。
    writeFileSync(user, JSON.stringify({
      plugins: [{ id: 'fixture.broken', module: `${FIXTURES}broken.plugin.ts` }],
    }));

    const runtime = new HostRuntime({ app: app(dataDir), contracts: contracts() });
    provideCoreServices(runtime);
    const failedEvents: unknown[] = [];
    runtime.backendEvents.listen(PROFILE_FAILED_EVENT, payload => void failedEvents.push(payload));
    try {
      const result = await loadStartupProfile(runtime, { official: OFFICIAL, userProfile: user });
      expect(result.installed).toEqual([]);
      expect(result.degraded).toEqual([{ id: 'fixture.broken', reason: 'APPLY_FAILED: broken plugin failed to start' }]);
      // 未回退官方 profile：fixture.greeter 不会被装载，失败事件也不发。
      expect(runtime.plugins()).toEqual([]);
      expect(failedEvents).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps an explicitly requested profile fatal on file-level failure', async () => {
    const dir = tempDir();
    const runtime = new HostRuntime({ app: app(dir), contracts: contracts() });
    try {
      await expect(loadStartupProfile(runtime, { official: OFFICIAL, profile: `${FIXTURES}invalid.profile.json` }))
        .rejects.toThrow('plugins[0]: "module" must be a non-empty string');
      expect(runtime.plugins()).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});
