/**
 * FTP is a desktop-only provider (main-agent decision, W08 round 8): Rust compiles the FTP backend
 * out of Android (`cloud_storage/mod.rs:51,179,271-275`), and the TS transport needs raw TCP/TLS
 * sockets (`node:net` / `node:tls`) that no mobile runtime has.
 *
 * Guarded here:
 * - the declaration (`DESKTOP_ONLY_PROVIDERS`) matches what the desktop entry links and what the
 *   mobile capability matrix disables;
 * - mobile readiness: the shared plugin body and the public `api.ts` never reach `ftp.ts`, so FTP's
 *   Node dependencies are attributed to the desktop entry alone instead of blocking a mobile entry;
 * - an entry without the FTP transport fails closed with the Rust Android platform error before
 *   any I/O, through the real command handler.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSource, checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { definePlugin } from '../../../kernel/api.ts';
import type { RuntimeCloudStorageConfig } from '../api.ts';
import desktopPlugin, { DESKTOP_PLATFORM } from '../index.ts';
import {
  ANDROID_CAPABILITIES,
  DESKTOP_CAPABILITIES,
  DESKTOP_ONLY_PROVIDERS,
  FTP_UNSUPPORTED_ON_ANDROID_CODE,
  FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
} from '../src/config.ts';
import {
  applySyncProviders,
  createPlatformStorage,
  type SyncProvidersPlatform,
  type SyncProvidersPluginConfig,
} from '../src/entry.ts';
import { CloudStorageError } from '../src/errors.ts';
import { spawnFakeFtp, type FakeFtp } from './fake_ftp.ts';
import { createSyncHost } from './host_fixture.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGIN_DIR = 'host/plugins/sync-providers';
const DESKTOP_ENTRY = `${PLUGIN_DIR}/index.ts`;
const SHARED_BODY = `${PLUGIN_DIR}/src/entry.ts`;
const PUBLIC_API = `${PLUGIN_DIR}/api.ts`;
const FTP_TRANSPORT = `${PLUGIN_DIR}/src/ftp.ts`;
/** 桌面平台的传输表：FTP 只能在这里链接。 */
const DESKTOP_PLATFORM_MODULE = `${PLUGIN_DIR}/src/desktop-platform.ts`;
/** 桌面本地文件端口实现（`node:fs/promises` + `platform/zip/node`）。 */
const LOCAL_FS_IMPL = `${PLUGIN_DIR}/src/local-fs.node.ts`;
const AES_GCM_IMPL = `${PLUGIN_DIR}/src/aes-gcm.node.ts`;
const ZIP_FILE_ADAPTER = 'host/platform/zip/node/file.ts';

/** A platform entry that links no desktop-only transport (what a mobile entry declares). */
const MOBILE_LIKE: SyncProvidersPlatform = { capabilities: ANDROID_CAPABILITIES, transports: {} };

const mobileLikePlugin = definePlugin<SyncProvidersPluginConfig>({
  meta: desktopPlugin.meta,
  inject: ['secrets', 'backup', 'paths'],
  apply(ctx, pluginConfig = {}) {
    return applySyncProviders(ctx, pluginConfig, MOBILE_LIKE);
  },
});

/** Public FTP must use TLS; plaintext is only valid on loopback (config.rs FTP validation). */
function ftpConfig(host = 'ftp.example.com', port = 21, useTls = true): RuntimeCloudStorageConfig {
  return { provider: 'ftp', ftp: { host, port, username: 'user', password: 'pass', useTls } };
}

async function storageFailure(run: Promise<unknown>): Promise<CloudStorageError> {
  try { await run; }
  catch (error) {
    if (error instanceof CloudStorageError) return error;
    throw error;
  }
  throw new Error('expected createPlatformStorage to reject');
}

/** Files of `entry`'s runtime closure that carry Node-specific dependencies, with their keys. */
function nodeFindings(entry: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const violation of checkModulesClosure(ROOT, [entry])) {
    const keys = out.get(violation.file) ?? new Set<string>();
    keys.add(violation.key);
    out.set(violation.file, keys);
  }
  return out;
}

function productionFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ['tests', 'equivalence', 'pending'].includes(entry.name) ? [] : productionFiles(rel);
    return entry.name.endsWith('.ts') ? [rel] : [];
  });
}

const servers: FakeFtp[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

describe('FTP is desktop-only: declaration', () => {
  it('declares FTP as the only desktop-only provider', () => {
    expect([...DESKTOP_ONLY_PROVIDERS]).toEqual(['ftp']);
  });

  it('the desktop entry links exactly the desktop-only transports', () => {
    expect(Object.keys(DESKTOP_PLATFORM.transports).sort()).toEqual([...DESKTOP_ONLY_PROVIDERS].sort());
    expect(DESKTOP_PLATFORM.capabilities).toBe(DESKTOP_CAPABILITIES);
    expect(DESKTOP_CAPABILITIES.ftpSupported).toBe(true);
  });

  it('the mobile capability matrix (Rust android_release) disables FTP', () => {
    expect(ANDROID_CAPABILITIES.ftpSupported).toBe(false);
  });
});

describe('FTP is desktop-only: mobile readiness classification', () => {
  it('the shared plugin body never reaches the FTP transport', () => {
    expect([...nodeFindings(SHARED_BODY).keys()]).not.toContain(FTP_TRANSPORT);
  });

  it('the public api.ts (imported by sync and backup) never reaches the FTP transport', () => {
    expect([...nodeFindings(PUBLIC_API).keys()]).not.toContain(FTP_TRANSPORT);
  });

  it('the desktop entry adds only the FTP transport and the local file port, whose Node dependencies have no mobile equivalent', () => {
    const desktop = nodeFindings(DESKTOP_ENTRY);
    const shared = nodeFindings(SHARED_BODY);
    const desktopOnly = [...desktop.keys()].filter(file => !shared.has(file)).sort();
    // 移动端入口换成 `mobile.ts`（不链接 FTP、不注入 `local-fs.node.ts` / `aes-gcm.node.ts`）后，这四处 Node 依赖只属于桌面。
    expect(desktopOnly).toEqual([ZIP_FILE_ADAPTER, AES_GCM_IMPL, FTP_TRANSPORT, LOCAL_FS_IMPL].sort());
    expect([...desktop.get(FTP_TRANSPORT)!]).toEqual(expect.arrayContaining(['node-builtin:net', 'node-builtin:tls']));
    expect([...desktop.get(LOCAL_FS_IMPL)!]).toEqual(expect.arrayContaining(['node-builtin:fs', 'node-builtin:os']));
  });

  it('only the desktop platform table imports the FTP transport at runtime', () => {
    const importers = productionFiles(PLUGIN_DIR).filter(file => {
      const { runtimeSpecifiers } = analyzeSource(file, readFileSync(join(ROOT, file), 'utf8'));
      return runtimeSpecifiers.some(spec => spec.startsWith('.') && posix.join(posix.dirname(file), spec) === FTP_TRANSPORT);
    });
    expect(importers).toEqual([DESKTOP_PLATFORM_MODULE]);
  });

  it('only the desktop entry imports that table (and the node local file port)', () => {
    const importers = productionFiles(PLUGIN_DIR).filter(file => {
      const { runtimeSpecifiers } = analyzeSource(file, readFileSync(join(ROOT, file), 'utf8'));
      return runtimeSpecifiers.some(spec => spec.startsWith('.')
        && [DESKTOP_PLATFORM_MODULE, LOCAL_FS_IMPL].includes(posix.join(posix.dirname(file), spec)));
    });
    expect(importers).toEqual([DESKTOP_ENTRY]);
  });
});

describe('FTP is desktop-only: entries without the transport', () => {
  it('rejects FTP with the platform code even when injected capabilities claim FTP (mod.rs:271-275)', async () => {
    const error = await storageFailure(createPlatformStorage(MOBILE_LIKE, ftpConfig(), DESKTOP_CAPABILITIES));
    expect(error.value).toEqual({
      error_type: 'Configuration',
      message: FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
      details: { code: FTP_UNSUPPORTED_ON_ANDROID_CODE },
    });
  });

  it('rejects FTP at validation under the mobile capability matrix', async () => {
    const error = await storageFailure(createPlatformStorage(MOBILE_LIKE, ftpConfig()));
    expect(error.value).toEqual({
      error_type: 'Configuration',
      message: FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
      details: { code: FTP_UNSUPPORTED_ON_ANDROID_CODE },
    });
  });

  it('desktop builds the FTP transport without network I/O (control group)', async () => {
    const storage = await createPlatformStorage(DESKTOP_PLATFORM, ftpConfig());
    expect(storage.providerName()).toBe('FTP');
  });

  it('cloud_storage_check_connection on an entry without FTP fails closed before connecting', async () => {
    const { server, host, port } = await spawnFakeFtp();
    servers.push(server);
    const fixture = await createSyncHost({ plugin: mobileLikePlugin });
    try {
      await expect(fixture.host.invoke('cloud_storage_check_connection', { config: ftpConfig(host, port, false) }))
        .rejects.toEqual({
          error_type: 'Configuration',
          message: FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
          details: { code: FTP_UNSUPPORTED_ON_ANDROID_CODE },
        });
      expect(fixture.hydrateCalls).toHaveLength(1);
      expect(server.commands).toEqual([]);
      expect(await fixture.host.invoke('cloud_storage_is_s3_enabled')).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it('cloud_storage_check_connection on the desktop entry reaches the FTP server (control group)', async () => {
    const { server, host, port } = await spawnFakeFtp();
    servers.push(server);
    const fixture = await createSyncHost();
    try {
      expect(await fixture.host.invoke('cloud_storage_check_connection', { config: ftpConfig(host, port, false) })).toBe(true);
      expect(server.commands).toEqual(expect.arrayContaining(['USER user']));
      expect(await fixture.host.invoke('cloud_storage_is_s3_enabled')).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
