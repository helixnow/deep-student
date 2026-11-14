/**
 * S01-r3 M1：用户 profile（`<dataDir>/plugins/user.profile.json`）的条目只接受文件路径。
 *
 * `data:` / `node:` / `http:` 这类说明符不是文件：`screenEntry` 找不到 package.json 就把条目当官方插件放行，
 * `import()` 在 Host 进程里直接执行它——能写一个 JSON 文件就等于下次启动在沙箱外执行代码。
 * 用户 profile 及其非 official 的 extends 中出现这类条目即 ProfileError，按既有逻辑回退到官方 profile。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serveHost, type HostTransport } from '../connection.ts';
import { ContractSet } from '../contracts.ts';
import { loadStartupProfile, PROFILE_FAILED_EVENT, ProfileError, resolveProfile } from '../profile.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain } from '../protocol.ts';
import { HostRuntime } from '../runtime.ts';

const OFFICIAL = fileURLToPath(new URL('../__fixtures__/e2e.profile.json', import.meta.url));
const GREETER = fileURLToPath(new URL('../__fixtures__/greeter.plugin.ts', import.meta.url));
const FIXTURE_CONTRACTS = fileURLToPath(new URL('../__fixtures__/contracts', import.meta.url));

// S01-security-r3.md M1 的复现，原样保留。
it('a user profile entry cannot run code from a module that is not a file (data: URL)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'profile-data-url-'));
  const marker = `__profile_data_url_${process.pid}`;
  try {
    mkdirSync(join(dataDir, 'plugins'), { recursive: true });
    const source = `globalThis.${marker} = 'executed'; export default { meta: { id: 'x' }, apply() {} };`;
    writeFileSync(join(dataDir, 'plugins', 'user.profile.json'), JSON.stringify({
      extends: 'official',
      plugins: [{ id: 'x', module: `data:text/javascript,${encodeURIComponent(source)}` }],
    }));
    const runtime = new HostRuntime({ app: { dataDir, version: '0.0.0-test', platform: 'linux', debug: true } } as never);
    runtime.ctx.provide('paths', {}); runtime.ctx.provide('storage', {}); runtime.ctx.provide('log', {});
    await loadStartupProfile(runtime, { official: OFFICIAL }).catch(() => undefined);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  } finally {
    delete (globalThis as Record<string, unknown>)[marker];
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('user profile module specifiers (S01-r3 M1)', () => {
  const dirs: string[] = [];
  const write = (name: string, value: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'profile-m1-'));
    dirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const cleanup = () => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); };

  it.each([
    ['data:', 'data:text/javascript,export%20default%201'],
    ['node:', 'node:child_process'],
    ['http:', 'http://127.0.0.1:1/x.mjs'],
    ['bare package name', '@deepseek-ai/cordis'],
  ])('rejects a %s module with ProfileError', async (_kind, module) => {
    try {
      const user = write('user.profile.json', { extends: 'official', plugins: [{ id: 'x', module }] });
      const rejected = resolveProfile(user, { official: OFFICIAL, user: true });
      await expect(rejected).rejects.toBeInstanceOf(ProfileError);
      await expect(rejected).rejects.toThrow(`${user}: plugin "x": module "${module}" is not a file path; a user profile only loads ./ or ../ relative paths, absolute paths or file: URLs`);
    } finally { cleanup(); }
  });

  it('applies to files the user profile extends, but not to the official profile it inherits', async () => {
    try {
      const base = write('base.profile.json', { plugins: [{ id: 'x', module: 'node:child_process' }] });
      const user = write('user.profile.json', { extends: ['official', base], plugins: [] });
      await expect(resolveProfile(user, { official: OFFICIAL, user: true })).rejects.toThrow(`${base}: plugin "x": module "node:child_process" is not a file path`);
      // 官方 profile 与显式 profile（命令行 / 握手）不受此限制。
      const explicit = write('explicit.profile.json', { plugins: [{ id: 'x', module: 'node:child_process' }] });
      await expect(resolveProfile(explicit, { official: OFFICIAL })).resolves.toEqual([
        expect.objectContaining({ id: 'x', specifier: 'node:child_process' }),
      ]);
    } finally { cleanup(); }
  });

  it('keeps relative, absolute and file: modules', async () => {
    try {
      const user = write('user.profile.json', {
        extends: 'official',
        plugins: [
          { id: 'a', module: GREETER },
          { id: 'b', module: pathToFileURL(GREETER).href },
          { id: 'c', module: './local.plugin.ts' },
          { id: 'd', module: '../up.plugin.ts' },
        ],
      });
      const entries = await resolveProfile(user, { official: OFFICIAL, user: true });
      expect(entries.map(entry => [entry.id, entry.specifier.startsWith('file:')])).toEqual([
        ['fixture.greeter', true], ['a', true], ['b', true], ['c', true], ['d', true],
      ]);
    } finally { cleanup(); }
  });

  it('startup falls back to the official profile and reports why', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'profile-m1-startup-'));
    try {
      mkdirSync(join(dataDir, 'plugins'), { recursive: true });
      writeFileSync(join(dataDir, 'plugins', 'user.profile.json'), JSON.stringify({
        extends: 'official', plugins: [{ id: 'x', module: 'node:child_process' }],
      }));
      const runtime = new HostRuntime({ app: { dataDir, version: '0.0.0-test', platform: 'linux', debug: true }, contracts: ContractSet.fromDirectory(FIXTURE_CONTRACTS) } as never);
      const emitted: { event: string; payload: unknown }[] = [];
      const emit = runtime.backendEvents.emit.bind(runtime.backendEvents);
      runtime.backendEvents.emit = ((event: string, payload: unknown) => { emitted.push({ event, payload }); return emit(event, payload); }) as typeof emit;
      runtime.ctx.provide('paths', {}); runtime.ctx.provide('storage', {}); runtime.ctx.provide('log', {});
      const result = await loadStartupProfile(runtime, { official: OFFICIAL });
      expect(result.installed.map(entry => entry.id)).toEqual(['fixture.greeter']);
      expect(emitted).toEqual([{ event: PROFILE_FAILED_EVENT, payload: {
        profile: join(dataDir, 'plugins', 'user.profile.json'),
        error: expect.stringContaining('module "node:child_process" is not a file path'),
      } }]);
      await runtime.dispose();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('covers the Electron launch path: the shell hands the default user profile over in the handshake', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'profile-m1-serve-'));
    const marker = `__profile_m1_serve_${process.pid}`;
    try {
      mkdirSync(join(dataDir, 'plugins'), { recursive: true });
      const userProfile = join(dataDir, 'plugins', 'user.profile.json');
      const source = `globalThis.${marker} = 'executed'; export default { meta: { id: 'x' }, apply() {} };`;
      writeFileSync(userProfile, JSON.stringify({
        extends: 'official', plugins: [{ id: 'x', module: `data:text/javascript,${encodeURIComponent(source)}` }],
      }));
      const sent: HostToMain[] = [];
      const listeners: ((message: unknown) => void)[] = [];
      const transport: HostTransport = {
        send: message => { sent.push(message); }, onMessage: listener => { listeners.push(listener); }, onClose: () => undefined, close: () => undefined,
      };
      const session = serveHost(transport, {
        officialProfile: OFFICIAL,
        contracts: () => ContractSet.fromDirectory(FIXTURE_CONTRACTS),
        onRuntime: runtime => { runtime.ctx.provide('paths', {}); runtime.ctx.provide('storage', {}); runtime.ctx.provide('log', {}); },
      });
      for (const listener of listeners) listener({
        kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: dataDir, appVersion: '0.0.0-test', platform: 'linux', debug: true, profile: userProfile,
      });
      const runtime = await session.ready;
      expect(runtime).not.toBeNull();
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
      expect(runtime!.plugins().map(entry => entry.id)).toEqual(['fixture.greeter']);
      expect(sent).toContainEqual(expect.objectContaining({ kind: 'event', event: PROFILE_FAILED_EVENT }));
      await session.shutdown();
    } finally {
      delete (globalThis as Record<string, unknown>)[marker];
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
