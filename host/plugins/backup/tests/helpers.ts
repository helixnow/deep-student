import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TestHost } from '../../../kernel/testing.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import syncPlugin from '../../sync/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import {
  markFull, newCoverageLedger, newManifest, persistentDomainRegistry, saveManifest, updateCoverage,
  type BackupFile, type BackupManifest,
} from '../src/manifest.ts';
import { backupDir } from '../src/paths.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { createStartupGate } from '../../../../electron/startup-gate.ts';
import type { StartupGate } from '../../../../electron/api.ts';
import { StartupFinalizerRegistry } from '../../../platform/storage/startup-finalizers.ts';
import { createNodeFiles, type FilesService } from '../../../platform/files/index.ts';

export interface BackupTestHostOptions {
  secrets?: boolean;
  shell?: (op: string, args: unknown) => unknown;
  syncProvider?: unknown;
  secretsService?: unknown;
  credentials?: Record<string, string>;
  generation?: bigint;
  storage?: unknown;
  storageFactory?: (dataDir: string, activeDir: string) => unknown;
  dataSpace?: unknown;
  paths?: unknown;
  /** 使用真实 F2 gate；省略时测试宿主模拟已完成启动。 */
  startupGate?: StartupGate;
  /** 已安装的 L07 `agentTools` 服务（或结构替身），用于验证执行器注册。 */
  agentTools?: unknown;
  /** 省略时装真实桌面 `files`（唯一允许根 appData = dataDir）；`false` 不装；函数按 dataDir 构造。 */
  files?: false | ((dataDir: string) => FilesService);
}

export interface FakeSecrets {
  readonly encrypted: string[];
  readonly decrypted: string[];
}

const FAKE_SEAL_PREFIX = 'FAKE-DSBK:';

/** 测试替身：只验证 ZIP 层的密封/解封编排，不复制 DSBK 加密实现。 */
function fakeSecrets(
  credentials: Record<string, string> | null,
  generation: bigint,
): { service: Record<string, unknown>; state: FakeSecrets } {
  const state: FakeSecrets = { encrypted: [], decrypted: [] };
  let activeCredentials: Record<string, string> | null = credentials === null ? null : { ...credentials };
  let activeGeneration = generation;
  let staged: { generation: bigint; credentials: Record<string, string> } | null = null;
  const service = {
    async resolveSeedFilePlaintext(seedFile: string): Promise<string> {
      return readFileSync(seedFile, 'utf8');
    },
    async validateBackupSeedFile(): Promise<void> {},
    async resealSeedFileForCurrentPlatform(): Promise<boolean> { return false; },
    openStore(): unknown {
      return {
        async getCloudCredentials() { return activeCredentials; },
        async cloudCredentialsActiveGeneration() { return activeGeneration; },
        async writeStagedCloudCredentials(update: Record<string, string>) {
          staged = { generation: activeGeneration + 1n, credentials: { ...update } };
          return staged.generation;
        },
        async commitStagedCloudCredentials(expected: bigint) {
          if (staged === null || staged.generation !== expected) throw new Error('staged generation conflict');
          activeCredentials = staged.credentials;
          activeGeneration = expected;
          staged = null;
        },
        async abortStagedCloudCredentials(expected: bigint) {
          if (staged !== null && staged.generation === expected) staged = null;
        },
        async deleteCloudCredentialsTransactional() {
          activeCredentials = null;
          activeGeneration = 0n;
          staged = null;
        },
        async saveCloudCredentials(value: Record<string, string>) {
          activeCredentials = { ...value };
          activeGeneration = 0n;
        },
      };
    },
    cloudEncryptionPasswordTooShort(password: string | null | undefined): boolean {
      if (password === null || password === undefined) return false;
      const text = password.trim();
      return text !== '' && Array.from(text).length < 8;
    },
    backup: {
      async encryptBackupFile(input: string, output: string, password: string): Promise<void> {
        state.encrypted.push(password);
        writeFileSync(output, Buffer.concat([Buffer.from(`${FAKE_SEAL_PREFIX}${password}\n`), readFileSync(input)]));
      },
      async decryptBackupFile(input: string, output: string, password: string): Promise<void> {
        state.decrypted.push(password);
        const data = readFileSync(input);
        const header = Buffer.from(`${FAKE_SEAL_PREFIX}${password}\n`);
        if (data.subarray(0, header.length).compare(header) !== 0) throw new Error('wrong password');
        writeFileSync(output, data.subarray(header.length));
      },
    },
  };
  return { service, state };
}

function baseSecrets(): Record<string, unknown> {
  return {
    openStore(): unknown {
      return {
        async getCloudCredentials() { return null; },
        async cloudCredentialsActiveGeneration() { return 0n; },
      };
    },
    cloudEncryptionPasswordTooShort(password: string | null | undefined): boolean {
      if (password === null || password === undefined) return false;
      const text = password.trim();
      return text !== '' && Array.from(text).length < 8;
    },
  };
}

function fakeSettings(values: Map<string, string>): Record<string, unknown> {
  return {
    get(key: string): string | null { return values.get(key) ?? null; },
    save(key: string, value: string): void { values.set(key, value); },
    delete(key: string): boolean { return values.delete(key); },
    listByPrefix(prefix: string) {
      return [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00+00:00' }));
    },
    deleteByPrefix(prefix: string): number {
      let removed = 0;
      for (const key of [...values.keys()]) {
        if (key.startsWith(prefix)) { values.delete(key); removed += 1; }
      }
      return removed;
    },
  };
}

export async function createBackupHost(
  options: BackupTestHostOptions = {},
): Promise<{ host: TestHost; secrets: FakeSecrets | null; settings: Map<string, string> }> {
  const host = await createTestHost({ ...(options.shell ? { shell: options.shell } : {}) });
  const dataDir = host.app.dataDir;
  const activeDir = join(dataDir, 'slots', 'slotA');
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(join(dataDir, 'slots', 'slotB'), { recursive: true });
  const startupGate = options.startupGate ?? createStartupGate();
  if (options.startupGate === undefined) startupGate.markStartupReady();
  host.ctx.provide('startupGate', startupGate);
  const storage = options.storageFactory?.(dataDir, activeDir) ?? options.storage ?? {
    locations: { activeDir, activeSlot: 'slotA', dataLocalDir: dataDir },
    openFile: () => ({ pluck: () => 'ok' }),
    close: () => undefined,
    enterMaintenance: async () => ({
      databases: ['mistakes', 'vfs', 'chat_v2', 'llm_usage'],
      release: () => undefined,
    }),
  };
  if (typeof storage !== 'object' || storage === null) throw new Error('storage test fixture must be an object');
  if (!('registerFinalizer' in storage)) {
    // 旧 SQL/路径 fixture 也使用真正的 F3 registry，不提供本地 no-op finalizer。
    // 维护屏障等真实性仍由各测试自己的 storage 选择决定；启动组合用例使用完整真实 F3 服务。
    const finalizers = new StartupFinalizerRegistry();
    Object.assign(storage, {
      registerFinalizer: finalizers.register.bind(finalizers),
      runStartupFinalizers: finalizers.run.bind(finalizers),
      finalizerNames: finalizers.names.bind(finalizers),
    });
  }
  host.ctx.provide('storage', storage);
  if (options.dataSpace !== undefined) host.ctx.provide('dataSpace', options.dataSpace);
  if (options.paths !== undefined) host.ctx.provide('paths', options.paths);
  const settings = new Map<string, string>();
  host.ctx.provide('settings', fakeSettings(settings));
  let secrets: FakeSecrets | null = null;
  if (options.secretsService !== undefined) {
    host.ctx.provide('secrets', options.secretsService);
  } else if (options.secrets) {
    const fake = fakeSecrets(options.credentials ?? null, options.generation ?? 0n);
    secrets = fake.state;
    host.ctx.provide('secrets', fake.service);
  } else {
    host.ctx.provide('secrets', baseSecrets());
  }
  if (options.syncProvider !== undefined) host.ctx.provide('syncProvider', options.syncProvider);
  if (options.agentTools !== undefined) host.ctx.provide('agentTools', options.agentTools);
  if (options.files !== false) {
    host.ctx.provide('files', options.files?.(dataDir) ?? createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] }));
  }
  await host.install(plugin);
  return { host, secrets, settings };
}

/**
 * D7：恢复后的同步基线由 L20 `sync@1` 拥有。需要真实恢复完成的集成测试
 * 安装 L20 插件，经 `ctx.get('sync')` 消费公开服务，而不是在 L21 复制实现。
 */
export async function installSyncService(host: TestHost): Promise<void> {
  await installVfsRestoreOwner(host);
  host.ctx.provide('notes', {});
  host.ctx.provide('syncProvider', {});
  host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
  host.ctx.provide('syncSupport', { state: { setCursor() {} } });
  host.ctx.provide('nativeCompression', {});
  host.ctx.provide('mastery', {
    recomputeAllStatesWithConn: () => 0,
    syncAllLearnerProfiles: () => 0,
  });
  await host.install(syncPlugin);
}

/** B05：恢复测试使用正式表所有者插件，不提供本地重置 SQL 或 no-op owner。 */
export async function installVfsRestoreOwner(host: TestHost): Promise<void> {
  if (host.ctx.get('paths') === undefined) {
    host.ctx.provide('paths', {
      deviceId: async () => 'backup-test-device',
      dataSpaceDeviceId: async () => 'backup-test-device',
    });
  }
  await host.install(vfsReposPlugin);
}

export function hostBackupRoot(host: TestHost): string {
  return backupDir(host.app.dataDir);
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface PartialBackupOptions {
  createdAt?: string;
  files?: Record<string, string | Uint8Array>;
  databaseIds?: Record<string, string>;
  keyPolicy?: BackupManifest['key_policy'];
  cryptoPaths?: string[];
}

/** 构造一个可通过 `validate_untrusted` 的部分归档清单（不伪造完整快照）。 */
export function partialManifest(backupId: string, options: PartialBackupOptions = {}): BackupManifest {
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = backupId;
  manifest.created_at = options.createdAt ?? '2026-01-01T00:00:00.000Z';
  manifest.snapshot_kind = 'partial_overlay';
  manifest.key_policy = options.keyPolicy ?? 'excluded_portable';
  manifest.coverage = newCoverageLedger();
  manifest.files = Object.entries(options.files ?? {}).map(([path, data]) => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    const file: BackupFile = { path, size: bytes.length, sha256: sha256(bytes) };
    const databaseId = options.databaseIds?.[path];
    if (databaseId !== undefined) file.database_id = databaseId;
    return file;
  });
  for (const path of options.cryptoPaths ?? []) {
    if (!manifest.files.some(file => file.path === path)) throw new Error(`crypto 文件未纳入清单: ${path}`);
  }
  if ((options.cryptoPaths?.length ?? 0) > 0) {
    updateCoverage(manifest, 'crypto', 'complete', options.cryptoPaths!);
  }
  return manifest;
}

/** 构造可通过 `validate_for_slot_restore` 的完整快照：四个核心库 + 空域 absent。 */
export function fullManifest(backupId: string, options: { createdAt?: string } = {}): BackupManifest {
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = backupId;
  manifest.created_at = options.createdAt ?? '2026-01-01T00:00:00.000Z';
  manifest.key_policy = 'not_present';
  manifest.files = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'].map(id => {
    const bytes = Buffer.from(`sqlite:${id}`);
    return { path: `${id}.db`, size: bytes.length, sha256: sha256(bytes), database_id: id };
  });
  for (const spec of persistentDomainRegistry()) {
    if (spec.id.startsWith('database:')) {
      const id = spec.id.slice('database:'.length);
      updateCoverage(manifest, spec.id, 'complete', [`${id}.db`]);
    } else {
      updateCoverage(manifest, spec.id, 'absent', []);
    }
  }
  markFull(manifest);
  return manifest;
}

export function fullBackupFiles(manifest: BackupManifest): Record<string, string> {
  return Object.fromEntries(manifest.files.map(file => [file.path, `sqlite:${file.database_id}`]));
}

export function writeBackup(
  root: string,
  manifest: BackupManifest,
  files: Record<string, string | Uint8Array> = {},
): string {
  const dir = join(root, manifest.backup_id);
  mkdirSync(dir, { recursive: true });
  for (const [relative, data] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof data === 'string' ? Buffer.from(data) : data);
  }
  saveManifest(join(dir, 'manifest.json'), manifest);
  return dir;
}

/** 长任务可传 Vitest 的 signal，使用用例既有预算；未传时保留原 10s 轮询上限。 */
export async function waitForJob(host: TestHost, jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const deadline = signal === undefined ? Date.now() + 10_000 : null;
  for (;;) {
    signal?.throwIfAborted();
    const job = await host.invoke('data_governance_get_backup_job', { jobId }) as Record<string, unknown>;
    const status = job.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return job;
    if (deadline !== null && Date.now() > deadline) throw new Error(`任务超时: ${jobId} status=${String(status)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}


/** 真实平台存储替身：数据库句柄包装 Connection，供备份/恢复集成测试使用。 */
export function createRealStorage(activeDir: string, dataDir: string): Record<string, unknown> {
  const open = (
    path: string,
    options?: {
      label?: string;
      mustExist?: boolean;
      profile?: string | { readonly?: boolean; busyTimeoutMs?: number };
    },
  ) => {
    const custom = typeof options?.profile === 'object' ? options.profile : undefined;
    const conn = new Connection(path, {
      label: options?.label ?? basename(path),
      profile: custom === undefined
        ? PROFILES.plain
        : { ...PROFILES.plain, ...custom },
      mustExist: options?.mustExist === true || custom?.readonly === true,
    });
    const handle = {
      name: basename(path),
      pluck: (query: string) => conn.pluck(query),
      get: (query: string, params?: unknown[]) => conn.get(query, params as never),
      one: (query: string, params?: unknown[]) => {
        const row = conn.get(query, params as never);
        if (row === undefined) throw new Error('Query returned no rows');
        return row;
      },
      all: (query: string, params?: unknown[]) => conn.all(query, params as never),
      iterate: (query: string, params?: unknown[]) => conn.iterate(query, params as never),
      run: (query: string, params?: unknown[]) => conn.run(query, params as never),
      exec: (sql: string) => conn.exec(sql),
      checkpoint: (mode?: string) => conn.raw.pragma(`wal_checkpoint(${mode ?? 'PASSIVE'})`),
      backupTo: (destination: string) => conn.raw.backup(destination),
      close: () => conn.close(),
    };
    return handle;
  };
  const database = (name: string) => {
    const path = name === 'vfs' || name === 'audit'
      ? join(activeDir, 'databases', `${name}.db`)
      : join(activeDir, `${name}.db`);
    mkdirSync(dirname(path), { recursive: true });
    return open(path);
  };
  return {
    locations: { activeDir, activeSlot: 'slotA', dataLocalDir: dataDir },
    pathOf: (name: string) => name === 'vfs' || name === 'audit'
      ? join(activeDir, 'databases', `${name}.db`) : join(activeDir, `${name}.db`),
    openFile: open,
    close: (handle: { close(): void }) => handle.close(),
    database,
    enterMaintenance: async () => ({
      databases: ['mistakes', 'vfs', 'chat_v2', 'llm_usage'],
      release: () => undefined,
    }),
  };
}

/** 创建带 probe 表的真实 SQLite 数据库文件。 */
export function createDatabaseFile(path: string, sql = 'CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT)'): void {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Connection(path, { label: basename(path), profile: PROFILES.plain });
  try { conn.exec(sql); } finally { conn.close(); }
}
