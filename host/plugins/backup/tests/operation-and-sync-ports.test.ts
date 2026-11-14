/**
 * 新增共享协调器业务面的生产入口测试：
 * - `backup`/`governance` 的 snake_case kind、立即失败/带超时等待、显式 release；
 * - L20 `SyncCommandPorts` 的 limiter / loadHydratedCloudConfig / saveSyncAudit；
 * - L07 `agentTools.registerToolExecutors` 的生产注册。
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { TestHost } from '../../../kernel/testing.ts';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import { OperationGuardError } from '../api.ts';
import { CLOUD_CONFIG_SSOT_SETTING_KEY } from '../src/cloud-config.ts';
import { createBackupHost, createRealStorage, type BackupTestHostOptions } from './helpers.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

async function setup(
  options: BackupTestHostOptions = {},
): Promise<Awaited<ReturnType<typeof createBackupHost>>> {
  const created = await createBackupHost({
    storageFactory: (dataDir, activeDir) => createRealStorage(activeDir, dataDir),
    ...options,
  });
  hosts.push(created.host);
  return created;
}

function webdavSsot(): string {
  return JSON.stringify({
    provider: 'webdav',
    webdav: { endpoint: 'https://dav.example.com/root', username: 'user' },
    root: null,
    allow_insecure: false,
  });
}

it('operation kinds stay serde snake_case and never collapse to prune', async () => {
  const { host } = await setup();
  for (const kind of [
    'backup', 'auto_backup', 'verify', 'zip_export', 'zip_import', 'restore', 'sync',
    'delete_propagation', 'prune',
  ] as const) {
    const guard = host.ctx.backup.tryAcquireOperation(kind);
    expect(guard.snapshot.kind).toBe(kind);
    expect(guard.operationId()).toBe(guard.snapshot.operation_id);
    guard.release();
  }
});

it('governance guard shares the same limiter and uses try-acquire for delete propagation', async () => {
  const { host } = await setup();
  const held = host.ctx.backup.tryAcquireOperation('backup');
  expect(() => host.ctx.governance.acquireOperationGuard('delete_propagation'))
    .toThrow('已有数据治理操作正在运行（当前 Backup');
  held.release();

  const guard = host.ctx.governance.acquireOperationGuard('delete_propagation');
  expect(guard.snapshot.kind).toBe('delete_propagation');
  expect(() => host.ctx.backup.tryAcquireOperation('restore')).toThrow('已有数据治理操作正在运行');
  guard.release();

  const alias = host.ctx.governance.tryAcquireOperationGuard('prune');
  expect(alias.snapshot.kind).toBe('prune');
  alias.release();
});

it('busy and lock IO expose stable structured reasons instead of message-prefix guessing', async () => {
  const { host } = await setup();

  const held = host.ctx.backup.tryAcquireOperation('backup');
  let busy: unknown;
  try { host.ctx.backup.tryAcquireOperation('restore'); }
  catch (error) { busy = error; }
  expect(busy).toBeInstanceOf(OperationGuardError);
  const busyError = busy as OperationGuardError;
  expect(busyError.reason).toBe('busy');
  expect(busyError.code).toBe('E_DATA_GOVERNANCE_BUSY');
  expect(busyError.app_error).toMatchObject({ error_type: 'Validation' });
  expect(busyError.app_error.message).toBe(busyError.message);
  expect(busyError.value).toBe(busyError.app_error);
  held.release();

  // 让锁目录不可创建：生产入口必须报 FileSystem，而不是把 IO 伪装成忙锁。
  const recovery = join(host.app.dataDir, 'recovery');
  rmSync(recovery, { recursive: true, force: true });
  writeFileSync(recovery, 'not a directory');
  try {
    let lockIo: unknown;
    try { host.ctx.backup.tryAcquireOperation('restore'); }
    catch (error) { lockIo = error; }
    expect(lockIo).toBeInstanceOf(OperationGuardError);
    const ioError = lockIo as OperationGuardError;
    expect(ioError.reason).toBe('lock_io');
    expect(ioError.code).toBe('E_DATA_GOVERNANCE_LOCK_IO');
    expect(ioError.app_error).toMatchObject({ error_type: 'FileSystem' });
    expect(ioError.value).toBe(ioError.app_error);

    // L20 的同步端口不能把锁 IO 当成“忙锁”（null）：tryAcquire 抛字符串
    // CommandError（L20 契约），等待入口用既有 `closed` 哨兵收口。
    let portError: unknown;
    try { host.ctx.backup.syncCommandPorts().limiter.tryAcquire(); }
    catch (error) { portError = error; }
    expect(portError).toBeInstanceOf(CommandError);
    expect(typeof (portError as CommandError).value).toBe('string');
    expect((portError as CommandError).value).toContain('创建数据治理跨进程锁目录失败');
    expect(await host.ctx.backup.syncCommandPorts().limiter.acquire(1_000)).toBe('closed');
  } finally {
    rmSync(recovery, { force: true });
  }
});

it('timed acquire waits for the holder and releases through the same queue', async () => {
  const { host } = await setup();
  const held = host.ctx.backup.tryAcquireOperation('backup');
  const pending = host.ctx.backup.acquireOperation('restore', 5_000);
  held.release();
  const acquired = await pending;
  expect(acquired.snapshot.kind).toBe('restore');
  acquired.release();
});

it('timed acquire reports the Rust timeout text and never grants the waiter later', async () => {
  const { host } = await setup();
  const held = host.ctx.backup.tryAcquireOperation('backup');
  const started = Date.now();
  await expect(host.ctx.backup.acquireOperation('restore', 1_000)).rejects.toThrow(
    '等待全局数据治理锁超时（1秒），可能有其他数据治理操作正在执行，请稍后再试。',
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  held.release();

  // 超时等待者已从队列移除：释放后可以立即 tryAcquire，而不是被补授旧许可。
  const next = host.ctx.backup.tryAcquireOperation('prune');
  expect(next.snapshot.kind).toBe('prune');
  next.release();
});

it('sync limiter exposes tryAcquire and timed acquire on the shared permit', async () => {
  const { host } = await setup();
  const ports = host.ctx.backup.syncCommandPorts();
  expect(host.ctx.governance.syncCommandPorts()).toBe(ports);

  const first = ports.limiter.tryAcquire();
  expect(first).not.toBeNull();
  expect(ports.limiter.tryAcquire()).toBeNull();
  expect(await ports.limiter.acquire(50)).toBe('timeout');

  first!.release();
  const second = await ports.limiter.acquire(1_000);
  expect(second).not.toBe('timeout');
  expect(second).not.toBe('closed');
  (second as { release(): void }).release();

  // 同一许可也阻挡备份命令，证明没有第二把局部锁。
  const permit = ports.limiter.tryAcquire();
  expect(permit).not.toBeNull();
  expect(() => host.ctx.backup.tryAcquireOperation('backup')).toThrow('已有数据治理操作正在运行');
  permit!.release();
});

it('loadHydratedCloudConfig returns null for NotConfigured and hydrates secure-store credentials', async () => {
  const notConfigured = await setup();
  expect(await notConfigured.host.ctx.backup.syncCommandPorts().loadHydratedCloudConfig()).toBeNull();

  const configured = await setup({
    secrets: true,
    credentials: { webdavPassword: 'stored-password' },
  });
  configured.settings.set(CLOUD_CONFIG_SSOT_SETTING_KEY, webdavSsot());
  const loaded = await configured.host.ctx.backup.syncCommandPorts().loadHydratedCloudConfig();
  expect(loaded).not.toBeNull();
  expect(loaded!.provider).toBe('webdav');
  expect(loaded!.webdav?.endpoint).toBe('https://dav.example.com/root');
  expect(loaded!.webdav?.password).toBe('stored-password');
});

it('loadHydratedCloudConfig maps missing credentials to E_CLOUD_CREDENTIALS_UNAVAILABLE', async () => {
  const { host, settings } = await setup();
  settings.set(CLOUD_CONFIG_SSOT_SETTING_KEY, webdavSsot());
  await expect(host.ctx.backup.syncCommandPorts().loadHydratedCloudConfig())
    .rejects.toMatchObject({ code: 'E_CLOUD_CREDENTIALS_UNAVAILABLE' });
});

it('saveSyncAudit writes started/complete/failed Sync rows without blocking callers', async () => {
  const { host } = await setup();
  const ports = host.ctx.backup.syncCommandPorts();
  ports.saveSyncAudit({
    direction: 'Upload',
    recordsAffected: 0,
    target: 'cloud_sync/upload',
    details: { device_id: 'device-1', direction: 'Upload' },
    outcome: { kind: 'started' },
  });
  ports.saveSyncAudit({
    direction: 'Upload',
    recordsAffected: 7,
    target: 'cloud_sync/upload',
    details: { device_id: 'device-1', changes_uploaded: 7 },
    outcome: { kind: 'complete', durationMs: 42 },
  });
  ports.saveSyncAudit({
    direction: 'Download',
    recordsAffected: 0,
    target: 'cloud_sync/download',
    details: { device_id: 'device-1' },
    outcome: { kind: 'failed', error: 'network down' },
  });

  const rows = host.ctx.storage.database('audit').all<{
    operation_type: string; status: string; duration_ms: number | null;
    error_message: string | null; operation_data: string;
  }>('SELECT operation_type, status, duration_ms, error_message, operation_data FROM __audit_log ORDER BY timestamp, rowid');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ operation_type: 'Sync', status: 'Completed', duration_ms: 42 });
  expect(JSON.parse(rows[0]!.operation_data)).toMatchObject({ direction: 'Upload', records_affected: 7 });
  expect(rows[1]).toMatchObject({
    operation_type: 'Sync', status: 'Failed', error_message: 'network down',
  });
});

it('registers DataGovernanceToolExecutor through the L07 agentTools registry', async () => {
  const registry = new AgentToolExecutorRegistry();
  const agentTools = {
    registerToolExecutors: registry.register.bind(registry),
  };
  await setup({ agentTools });
  const registered = registry.all();
  expect(registered.map(executor => executor.name())).toEqual(['DataGovernanceToolExecutor']);
  expect(registered[0]!.canHandle('backup_status')).toBe(true);
  expect(registered[0]!.canHandle('sync_run')).toBe(true);
  expect(registered[0]!.canHandle('unrelated_tool')).toBe(false);
});

it('registers when agentTools is provided after plugin apply', async () => {
  const { host } = await setup();
  const registry = new AgentToolExecutorRegistry();
  host.ctx.provide('agentTools', {
    registerToolExecutors: registry.register.bind(registry),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const registered = registry.all();
  expect(registered.map(executor => executor.name())).toEqual(['DataGovernanceToolExecutor']);
});
