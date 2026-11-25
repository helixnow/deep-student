/**
 * Safe Mode Anti-SPOF fault-injection tests (Lane S01):
 * - SPOF-1: Corrupt `user.profile.json` must never crash `plugin:manager|list`; `plugin:manager|reset-profile`
 *   works in Safe Mode, backs up the corrupt file atomically, and restores a clean official profile.
 * - SPOF-2: Non-core official plugin import failure in Safe Mode degrades as `IMPORT_FAILED` instead of
 *   triggering `HostFatal`, while core platform service failures and normal-mode import failures stay fatal.
 * - SPOF-3: Throwing `storage.runStartupFinalizers()` in Safe Mode logs full diagnostics, records degraded
 *   status, still invokes `startupGate.markStartupReady()`, and reaches `HostReady` (while normal mode stays fatal).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOST_STATUS_COMMAND,
  PLUGINS_DEGRADED_EVENT,
  PLUGIN_MANAGER_INSTALL_COMMAND,
  PLUGIN_MANAGER_LIST_COMMAND,
  type WindowRef,
} from '../api.ts';
import { serveHost, type HostTransport } from '../connection.ts';
import { ContractSet } from '../contracts.ts';
import {
  PLUGIN_MANAGER_RESET_PROFILE_COMMAND,
  type PluginManagerInventoryWithStatus,
  type PluginManagerResetProfileResult,
} from '../plugin-admin.ts';
import { loadProfile, loadStartupProfile, ProfileError } from '../profile.ts';
import { HOST_PROTOCOL_VERSION, type Handshake, type HostToMain, type MainToHostMessage } from '../protocol.ts';
import { HostRuntime } from '../runtime.ts';
import { realStartupStates } from '../__fixtures__/startup-real.plugin.ts';
import { startupFixtureStates } from '../__fixtures__/startup.plugin.ts';
import { MemoryZipSink, ZipWriter } from '../../platform/zip/core/index.ts';
import { nodeZipCodec } from '../../platform/zip/node/file.ts';

const TMP = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const TESTS_DIR = fileURLToPath(new URL('./', import.meta.url));
const LOCAL: WindowRef = { window: 'main', webview: 'main' };

class MemoryTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];

  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

function handshake(appDataDir: string, extra: Partial<Handshake> = {}): Handshake {
  return {
    kind: 'handshake',
    protocol: HOST_PROTOCOL_VERSION,
    appDataDir,
    appVersion: '0.20.9',
    platform: 'linux',
    debug: true,
    ...extra,
  };
}

function provideCoreServices(runtime: HostRuntime): void {
  runtime.ctx.provide('paths', {});
  runtime.ctx.provide('storage', {});
  runtime.ctx.provide('log', {});
}

async function invokeOk<T>(runtime: HostRuntime, cmd: string, args: unknown = {}, source: WindowRef = LOCAL): Promise<T> {
  const outcome = await runtime.dispatchInvoke({ id: `inv-${cmd}-${Math.random()}`, cmd, args, source });
  if (outcome.kind !== 'ok') throw new Error(`expected ok from ${cmd}: ${JSON.stringify(outcome)}`);
  return outcome.value as T;
}

async function invokeErr(runtime: HostRuntime, cmd: string, args: unknown = {}, source: WindowRef = LOCAL): Promise<string> {
  const outcome = await runtime.dispatchInvoke({ id: `inv-${cmd}-${Math.random()}`, cmd, args, source });
  if (outcome.kind !== 'err') throw new Error(`expected err from ${cmd}: ${JSON.stringify(outcome)}`);
  return JSON.stringify(outcome.error);
}

let root: string;
const extraCleanups: string[] = [];

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  root = await mkdtemp(join(TMP, 's01-anti-spof-'));
});

afterEach(async () => {
  for (const target of extraCleanups.splice(0)) {
    await rm(target, { recursive: true, force: true });
  }
  await rm(root, { recursive: true, force: true });
});

async function writeBaseOfficialProfile(dir: string): Promise<string> {
  const path = join(dir, 'official.profile.json');
  await writeFile(path, JSON.stringify({
    plugins: [
      { id: 'dstu.plain', module: join(FIXTURES, 'manager-plain.plugin.ts') },
      { id: 'dstu.configurable', module: join(FIXTURES, 'manager-configurable.plugin.ts') },
    ],
  }));
  return path;
}

describe('SPOF-1: corrupt user.profile.json degrades plugin:manager|list and resets cleanly via plugin:manager|reset-profile', () => {
  it('survives garbage JSON in Safe Mode, exposes running + installed packages, backs up evidence, and resets cleanly', async () => {
    const dataDir = join(root, 'spof1-data');
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    const officialProfile = await writeBaseOfficialProfile(root);
    const userProfilePath = join(dataDir, 'plugins', 'user.profile.json');

    // First install a real community package in normal mode so plugins.lock.json holds a real release record.
    const sink = new MemoryZipSink();
    const zip = new ZipWriter(sink, { codec: nodeZipCodec });
    await zip.addBytes('package.json', JSON.stringify({
      name: 'deepstudent-plugin-alice-rescue',
      version: '1.2.3',
      type: 'module',
      engines: { deepStudent: '^0.20' },
      deepStudent: {
        manifestVersion: 1,
        id: 'alice.rescue-pack',
        platforms: ['desktop'],
        host: './index.mjs',
        displayName: 'Rescue Test Plugin',
      },
    }));
    await zip.addBytes('index.mjs', `export default { name: 'alice.rescue-pack', meta: { id: 'alice.rescue-pack', version: '1.2.3' }, apply() {} };`);
    await zip.finish();
    const archivePath = join(root, 'alice-rescue.dstuplugin');
    await writeFile(archivePath, sink.bytes());

    const normalTransport = new MemoryTransport();
    const normalSession = serveHost(normalTransport, {
      officialProfile,
      contracts: () => ContractSet.empty(),
      onRuntime: provideCoreServices,
    });
    normalTransport.deliver(handshake(dataDir));
    const normalRuntime = await normalSession.ready;
    expect(normalRuntime).not.toBeNull();
    try {
      const initialList = await invokeOk<PluginManagerInventoryWithStatus>(normalRuntime!, PLUGIN_MANAGER_LIST_COMMAND);
      expect(initialList.profileCorrupted).toBeUndefined();
      await invokeOk(normalRuntime!, PLUGIN_MANAGER_INSTALL_COMMAND, { path: archivePath, revision: initialList.revision });
    } finally {
      await normalSession.shutdown();
    }

    // Fault injection: corrupt user.profile.json with unparseable garbage JSON.
    const garbage = '{not valid json!!! corrupt-evidence-payload';
    await writeFile(userProfilePath, garbage, 'utf8');

    // Boot in Safe Mode over the corrupted dataDir.
    const safeTransport = new MemoryTransport();
    const logs: string[] = [];
    const safeSession = serveHost(safeTransport, {
      officialProfile,
      safeMode: true,
      contracts: () => ContractSet.empty(),
      onRuntime: (rt) => {
        provideCoreServices(rt);
        rt.ctx.logger.exporter({
          levels: { default: 4 },
          export(message) { logs.push(`${message.type} [${message.name}] ${format(...(message.args as unknown[]))}`); },
        });
      },
    });
    safeTransport.deliver(handshake(dataDir));
    const safeRuntime = await safeSession.ready;
    expect(safeRuntime).not.toBeNull();
    try {
      // 1. plugin:manager|list must succeed (no PROFILE_READ_FAILED crash) and flag profileCorrupted.
      const degradedList = await invokeOk<PluginManagerInventoryWithStatus>(safeRuntime!, PLUGIN_MANAGER_LIST_COMMAND);
      expect(degradedList.safeMode).toBe(true);
      expect(degradedList.revision).toBe('corrupt');
      expect(degradedList.profileCorrupted).toBe(true);
      expect(typeof degradedList.profileError).toBe('string');
      expect(degradedList.profileError!.length).toBeGreaterThan(0);
      expect(logs.some((line) => line.includes('corrupted or unreadable'))).toBe(true);

      // Running official plugins and installed package records from plugins.lock.json are still visible.
      const ids = degradedList.plugins.map((entry) => entry.id);
      expect(ids).toContain('dstu.plain');
      expect(ids).toContain('dstu.configurable');
      expect(ids).toContain('alice.rescue-pack');
      expect(degradedList.plugins.find((entry) => entry.id === 'dstu.plain')).toMatchObject({
        origin: 'builtin',
        state: 'running',
      });
      expect(degradedList.plugins.find((entry) => entry.id === 'alice.rescue-pack')).toMatchObject({
        origin: 'community',
        version: '1.2.3',
        displayName: 'Rescue Test Plugin',
      });

      // 2. Untrusted sources and unexpected arguments must be rejected by plugin:manager|reset-profile.
      expect(await invokeErr(safeRuntime!, PLUGIN_MANAGER_RESET_PROFILE_COMMAND, {}, { window: 'other', webview: 'other' }))
        .toMatch(/PLUGIN_MANAGER_FORBIDDEN|not allowed by ACL/);
      expect(await invokeErr(safeRuntime!, PLUGIN_MANAGER_RESET_PROFILE_COMMAND, { unexpected: true }))
        .toContain('takes no arguments');

      // 3. Calling plugin:manager|reset-profile in Safe Mode backs up the corrupt file and restores clean default.
      const reset = await invokeOk<PluginManagerResetProfileResult>(safeRuntime!, PLUGIN_MANAGER_RESET_PROFILE_COMMAND, {});
      expect(reset.backedUpTo).not.toBeNull();
      expect(reset.backedUpTo!).toMatch(/user\.profile\.json\.corrupt-\d+-[0-9a-f-]+\.bak$/);
      expect(reset.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(reset.backedUpTo!)).toBe(true);
      expect(await readFile(reset.backedUpTo!, 'utf8')).toBe(garbage);
      expect(JSON.parse(await readFile(userProfilePath, 'utf8'))).toEqual({ extends: 'official', plugins: [] });

      // 4. Subsequent plugin:manager|list returns a clean, non-corrupted inventory with matching revision.
      const recoveredList = await invokeOk<PluginManagerInventoryWithStatus>(safeRuntime!, PLUGIN_MANAGER_LIST_COMMAND);
      expect(recoveredList.profileCorrupted).toBeFalsy();
      expect(recoveredList.profileError).toBeUndefined();
      expect(recoveredList.revision).toBe(reset.revision);
      expect(recoveredList.safeMode).toBe(true);
      expect(recoveredList.plugins.map((entry) => entry.id)).toContain('dstu.plain');
    } finally {
      await safeSession.shutdown();
    }
  });

  it('also degrades on schema-invalid user.profile.json and handles reset-profile when file does not exist', async () => {
    const dataDir = join(root, 'spof1-schema');
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    const officialProfile = await writeBaseOfficialProfile(root);
    const userProfilePath = join(dataDir, 'plugins', 'user.profile.json');
    await writeFile(userProfilePath, JSON.stringify({ extends: 'official', plugins: 'not-an-array' }));

    const transport = new MemoryTransport();
    const session = serveHost(transport, {
      officialProfile,
      safeMode: true,
      contracts: () => ContractSet.empty(),
      onRuntime: provideCoreServices,
    });
    transport.deliver(handshake(dataDir));
    const runtime = await session.ready;
    expect(runtime).not.toBeNull();
    try {
      const list = await invokeOk<PluginManagerInventoryWithStatus>(runtime!, PLUGIN_MANAGER_LIST_COMMAND);
      expect(list.profileCorrupted).toBe(true);
      expect(list.revision).toBe('corrupt');
      expect(list.profileError).toContain('"plugins" must be an array');

      // Remove the profile file to test reset-profile when absent.
      await rm(userProfilePath);
      const resetAbsent = await invokeOk<PluginManagerResetProfileResult>(runtime!, PLUGIN_MANAGER_RESET_PROFILE_COMMAND, {});
      expect(resetAbsent.backedUpTo).toBeNull();
      expect(resetAbsent.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(await readFile(userProfilePath, 'utf8'))).toEqual({ extends: 'official', plugins: [] });
    } finally {
      await session.shutdown();
    }
  });
});

describe('SPOF-2: non-core official plugin import failure degrades in Safe Mode without killing boot', () => {
  it('degrades broken & missing non-core official plugins in Safe Mode while reaching HostReady, and keeps normal mode fatal', async () => {
    // Create a real throwing module inside host/kernel/tests/ so isAppModuleUrl() classifies it as official/builtin.
    const tmpOfficialDir = await mkdtemp(join(TESTS_DIR, '.spof2-official-'));
    extraCleanups.push(tmpOfficialDir);
    const throwingOfficialModule = join(tmpOfficialDir, 'broken-official.plugin.mjs');
    await writeFile(throwingOfficialModule, `throw new Error('simulated non-core official import crash');\n`);
    const missingOfficialModule = join(tmpOfficialDir, 'missing-official.plugin.mjs');

    const officialProfile = join(root, 'spof2-official.profile.json');
    await writeFile(officialProfile, JSON.stringify({
      plugins: [
        { id: 'dstu.plain', module: join(FIXTURES, 'manager-plain.plugin.ts') },
        { id: 'dstu.broken-feature', module: throwingOfficialModule },
        { id: 'dstu.missing-feature', module: missingOfficialModule },
        { id: 'dstu.configurable', module: join(FIXTURES, 'manager-configurable.plugin.ts') },
      ],
    }));

    // 1. Safe Mode: Host boots to HostReady, installs healthy official plugins, degrades broken non-core modules.
    const dataDir = join(root, 'spof2-safe');
    const safeTransport = new MemoryTransport();
    const safeSession = serveHost(safeTransport, {
      officialProfile,
      safeMode: true,
      contracts: () => ContractSet.empty(),
      onRuntime: provideCoreServices,
    });
    safeTransport.deliver(handshake(dataDir));
    const safeRuntime = await safeSession.ready;
    expect(safeRuntime).not.toBeNull();
    try {
      expect(safeTransport.sent.some((message) => message.kind === 'ready')).toBe(true);
      expect(safeTransport.sent.some((message) => message.kind === 'fatal')).toBe(false);
      expect(safeRuntime!.plugins().map((entry) => entry.id)).toEqual(['dstu.plain', 'dstu.configurable']);
      expect(safeRuntime!.degradedPlugins()).toEqual([
        {
          id: 'dstu.broken-feature',
          reason: expect.stringMatching(/^IMPORT_FAILED:.*simulated non-core official import crash/),
        },
        {
          id: 'dstu.missing-feature',
          reason: expect.stringMatching(/^IMPORT_FAILED:/),
        },
      ]);
      expect(safeTransport.sent).toContainEqual(expect.objectContaining({
        kind: 'event',
        event: PLUGINS_DEGRADED_EVENT,
        payload: safeRuntime!.degradedPlugins(),
      }));
    } finally {
      await safeSession.shutdown();
    }

    // 2. Normal Mode control: official module import failure remains fatal (ProfileError -> HostFatal).
    const normalTransport = new MemoryTransport();
    const normalSession = serveHost(normalTransport, {
      officialProfile,
      safeMode: false,
      contracts: () => ContractSet.empty(),
      onRuntime: provideCoreServices,
    });
    normalTransport.deliver(handshake(join(root, 'spof2-normal')));
    await expect(normalSession.ready).resolves.toBeNull();
    expect(normalTransport.sent.some((message) => message.kind === 'ready')).toBe(false);
    const fatal = normalTransport.sent.find((message): message is Extract<HostToMain, { kind: 'fatal' }> => message.kind === 'fatal');
    expect(fatal?.message).toContain('dstu.broken-feature');
  });

  it('keeps core official plugin import failures and missing core services fatal even in Safe Mode', async () => {
    const tmpOfficialDir = await mkdtemp(join(TESTS_DIR, '.spof2-core-'));
    extraCleanups.push(tmpOfficialDir);
    const brokenCoreModule = join(tmpOfficialDir, 'broken-storage.plugin.mjs');
    await writeFile(brokenCoreModule, `throw new Error('storage module corrupt');\n`);

    const coreBrokenProfile = join(root, 'spof2-core-broken.profile.json');
    await writeFile(coreBrokenProfile, JSON.stringify({
      plugins: [
        { id: 'dstu.platform.storage', module: brokenCoreModule },
        { id: 'dstu.plain', module: join(FIXTURES, 'manager-plain.plugin.ts') },
      ],
    }));

    const safeRuntime1 = new HostRuntime({
      app: { dataDir: join(root, 'spof2-core1'), version: '0.20.9', platform: 'linux', debug: true },
      contracts: ContractSet.empty(),
      safeMode: true,
    });
    try {
      await expect(loadProfile(safeRuntime1, coreBrokenProfile)).rejects.toThrow(ProfileError);
    } finally {
      await safeRuntime1.dispose();
    }

    // Even when a non-dstu fixture fails to import, requireCoreServices: true still blocks Safe Mode boot if storage/paths/log are missing.
    const missingServicesProfile = join(root, 'spof2-missing-core-services.profile.json');
    await writeFile(missingServicesProfile, JSON.stringify({
      plugins: [
        { id: 'fixture.storage-provider', module: brokenCoreModule },
        { id: 'dstu.plain', module: join(FIXTURES, 'manager-plain.plugin.ts') },
      ],
    }));
    const safeRuntime2 = new HostRuntime({
      app: { dataDir: join(root, 'spof2-core2'), version: '0.20.9', platform: 'linux', debug: true },
      contracts: ContractSet.empty(),
      safeMode: true,
    });
    try {
      await expect(loadStartupProfile(safeRuntime2, {
        profile: missingServicesProfile,
        official: missingServicesProfile,
        requireCoreServices: true,
      })).rejects.toThrow('platform core services unavailable: "storage", "paths", "log"');
    } finally {
      await safeRuntime2.dispose();
    }
  });
});

describe('SPOF-3: throwing runStartupFinalizers in Safe Mode logs diagnostics, marks gate ready, and keeps Host reachable', () => {
  it('degrades gracefully on real F3 StartupFinalizerError in Safe Mode while keeping normal mode fatal', async () => {
    // 1. Safe Mode: throwing finalizer logs full error, records degraded diagnostic, marks startupGate ready, and emits HostReady.
    const realBefore = realStartupStates.length;
    const transport = new MemoryTransport();
    const logs: string[] = [];
    const exits: number[] = [];
    const session = serveHost(transport, {
      officialProfile: `${FIXTURES}startup-real-failure.profile.json`,
      safeMode: true,
      contracts: () => ContractSet.empty(),
      onRuntime: (rt) => {
        // startup-real.plugin.ts provides storage/dataSpace/startupGate; supply paths & log for requireCoreServices.
        rt.ctx.provide('paths', {});
        rt.ctx.provide('log', {});
        rt.ctx.logger.exporter({
          levels: { default: 4 },
          export(message) { logs.push(`${message.type} [${message.name}] ${format(...(message.args as unknown[]))}`); },
        });
      },
      exit: (code) => { exits.push(code); },
    });
    transport.deliver(handshake(join(root, 'spof3-safe')));
    const runtime = await session.ready;
    expect(runtime).not.toBeNull();
    const state = realStartupStates[realBefore]!;
    try {
      expect(transport.sent.some((message) => message.kind === 'ready')).toBe(true);
      expect(transport.sent.some((message) => message.kind === 'fatal')).toBe(false);
      expect(state.runs).toEqual(['migrate', 'restore']);
      expect(state.gate.isStartupReady()).toBe(true);

      // Full error logged via logStartupFailure including stage, finalizer, completed, and cause.
      expect(logs.some((line) => line.includes('startup finalization failed at runStartupFinalizers'))).toBe(true);
      expect(logs.some((line) => line.includes('continuing in safe mode'))).toBe(true);
      expect(logs.some((line) => line.includes('finalizer: fixture.startup-real.restore'))).toBe(true);
      expect(logs.some((line) => line.includes('completed: fixture.startup-real.migrate'))).toBe(true);
      expect(logs.some((line) => line.includes('real restore finalizer failed'))).toBe(true);

      // Degraded diagnostic recorded & broadcast, and Host stays reachable via IPC.
      expect(runtime!.degradedPlugins()).toEqual([
        expect.objectContaining({
          id: 'dstu.startup-finalizers',
          reason: expect.stringContaining('STARTUP_FINALIZER_FAILED:'),
        }),
      ]);
      expect(transport.sent).toContainEqual(expect.objectContaining({
        kind: 'event',
        event: PLUGINS_DEGRADED_EVENT,
        payload: runtime!.degradedPlugins(),
      }));
      const status = await invokeOk<Array<{ id: string; reason: string }>>(runtime!, HOST_STATUS_COMMAND);
      expect(status).toEqual(runtime!.degradedPlugins());
    } finally {
      await session.shutdown();
    }
    expect(exits).toEqual([0]);

    // 2. Normal Mode control: throwing finalizer stays fatal (no ready, no gate mark, exit 1).
    const normalBefore = startupFixtureStates.length;
    const normalTransport = new MemoryTransport();
    const normalExits: number[] = [];
    let resolveNormalExit!: (code: number) => void;
    const normalExited = new Promise<number>((resolve) => { resolveNormalExit = resolve; });
    const normalSession = serveHost(normalTransport, {
      profile: `${FIXTURES}startup-failure.profile.json`,
      safeMode: false,
      contracts: () => ContractSet.empty(),
      exit: (code) => {
        normalExits.push(code);
        resolveNormalExit(code);
      },
    });
    normalTransport.deliver(handshake(join(root, 'spof3-normal')));
    await expect(normalSession.ready).resolves.toBeNull();
    expect(normalTransport.sent.some((message) => message.kind === 'ready')).toBe(false);
    expect(normalTransport.sent.some((message) => message.kind === 'fatal')).toBe(true);
    expect(startupFixtureStates[normalBefore]!.gateMarked).toBe(false);
    await expect(normalExited).resolves.toBe(1);
    expect(normalExits).toEqual([1]);
  });
});
