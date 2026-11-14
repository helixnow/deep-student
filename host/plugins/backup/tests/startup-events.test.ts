/**
 * lib.rs setup 事件：`data-governance-migration-status`（:1115-1141）与 `backup-jobs-resumable`（:1437-1449）。
 * 前端监听方：`src/hooks/useMigrationStatusListener.ts`、`DataGovernanceDashboard.tsx:1713`。
 * V03-02 方案 A：两者只派发给 Host 内部监听者，webview 通道为空（Rust 的 setup 期 emit 结构性丢失）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { restoreActivationMarkerPath } from '../src/restore-commands.ts';
import { BACKUP_JOBS_RESUMABLE_EVENT, MIGRATION_STATUS_EVENT } from '../src/startup-events.ts';
import { createBackupHost, createRealStorage } from './helpers.ts';
import { expectNothingSentToWebview, startupEventSink } from './startup-event-sink.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

interface FinalizerStorage {
  runStartupFinalizers(): Promise<{ completed: readonly string[] }>;
}

function persistedJob(id: string, status: string, checkpoint: boolean): Record<string, unknown> {
  return {
    job_id: id, kind: 'import', status, phase: status === 'failed' ? 'failed' : status, progress: 40,
    created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:01Z',
    params: { zip_path: '/tmp/a.zip', backup_id: 'b1', include_assets: false, include_checksums: false },
    ...(checkpoint ? { checkpoint: { processed_items: [], last_updated: '2026-01-01T00:00:02Z', current_index: 3, total_items: 9 } } : {}),
    ...(status === 'failed' ? { error_message: 'disk full' } : {}),
  };
}

function seedJobs(host: TestHost, jobs: Array<Record<string, unknown>>): string {
  const dir = join(host.app.dataDir, 'backup_jobs');
  mkdirSync(dir, { recursive: true });
  for (const job of jobs) writeFileSync(join(dir, `${String(job.job_id)}.json`), JSON.stringify(job, null, 2));
  return dir;
}

async function runFinalizers(host: TestHost): Promise<readonly string[]> {
  return (await (host.ctx.get('storage') as FinalizerStorage).runStartupFinalizers()).completed;
}

it('emits backup-jobs-resumable after restore activation with the persisted jobs, then cleans finished jobs', async () => {
  const { host } = await createBackupHost();
  hosts.push(host);
  const resumable = persistedJob('job-resumable', 'failed', true);
  const dir = seedJobs(host, [
    resumable, persistedJob('job-failed-no-checkpoint', 'failed', false),
    persistedJob('job-done', 'completed', false), persistedJob('job-cancelled', 'cancelled', false),
  ]);
  const sink = startupEventSink(host);
  const completed = await runFinalizers(host);
  expect(completed.indexOf('backup.resumable-jobs')).toBeGreaterThan(completed.indexOf('backup.restore-activation'));
  expect(sink.resumable).toEqual([[resumable]]);
  expectNothingSentToWebview(host, sink);
  expect(existsSync(join(dir, 'job-resumable.json'))).toBe(true);
  expect(existsSync(join(dir, 'job-failed-no-checkpoint.json'))).toBe(true);
  expect(existsSync(join(dir, 'job-done.json'))).toBe(false);
  expect(existsSync(join(dir, 'job-cancelled.json'))).toBe(false);
});

it('does not emit backup-jobs-resumable when nothing is resumable (Rust emits only when non-empty)', async () => {
  const { host } = await createBackupHost();
  hosts.push(host);
  seedJobs(host, [persistedJob('job-done', 'completed', false)]);
  const sink = startupEventSink(host);
  await runFinalizers(host);
  expect(sink.resumable).toEqual([]);
  expectNothingSentToWebview(host, sink);
});

async function governanceHost(extra: Record<string, unknown>): Promise<TestHost> {
  const { host } = await createBackupHost({
    storageFactory: (dataDir, activeDir) => ({ ...createRealStorage(activeDir, dataDir), ...extra }),
  });
  hosts.push(host);
  return host;
}

it('fully successful startup emits the success payload and clears the persisted migration error', async () => {
  const host = await governanceHost({
    startupMigrationReport: () => ({ success: true, totalDurationMs: 42, databases: [{ appliedCount: 2 }, { appliedCount: 1 }] }),
  });
  const activeDir = join(host.app.dataDir, 'slots', 'slotA');
  writeFileSync(join(activeDir, '.last_migration_error'), JSON.stringify({ error: 'old', timestamp: '2026-01-01T00:00:00Z' }));
  const registry = await host.invoke('data_governance_get_schema_registry') as { global_version: number };
  const sink = startupEventSink(host);
  await runFinalizers(host);
  expect(sink.migration).toEqual([{
    success: true, global_version: registry.global_version, migrations_applied: 3, duration_ms: 42, warnings: [],
  }]);
  expectNothingSentToWebview(host, sink);
  expect(existsSync(join(activeDir, '.last_migration_error'))).toBe(false);
});

const DEGRADED_ISSUES = [
  { component: 'chat_v2', status: 'blocked', reason: "Database 'chat_v2' migration failed: boom", dependency: null },
  { component: 'audit', status: 'degraded', reason: 'audit down', dependency: null },
  { component: 'llm_usage', status: 'degraded', reason: null, dependency: null },
];

function degradedHost(): Promise<TestHost> {
  return governanceHost({
    startupMigrationReport: () => ({ success: false, totalDurationMs: 7, databases: [{ appliedCount: 0 }] }),
    componentHealth: { toJSON: () => ({ components: DEGRADED_ISSUES }), issues: () => DEGRADED_ISSUES },
  });
}

it('degraded components produce the has_warnings payload and keep the persisted error', async () => {
  const host = await degradedHost();
  const activeDir = join(host.app.dataDir, 'slots', 'slotA');
  writeFileSync(join(activeDir, '.last_migration_error'), JSON.stringify({ error: 'old', timestamp: '2026-01-01T00:00:00Z' }));
  const sink = startupEventSink(host);
  await runFinalizers(host);
  const [payload] = sink.migration;
  expect(payload).toMatchObject({
    success: true, migrations_applied: 0, duration_ms: 7, has_warnings: true,
    warnings: ["Database 'chat_v2' migration failed: boom", 'llm_usage startup degraded'],
  });
  expectNothingSentToWebview(host, sink);
  expect(existsSync(join(activeDir, '.last_migration_error'))).toBe(true);
});

it('V03-02 scheme A: a startup with migration warnings and resumable jobs sends nothing through ctx.backendEvents; the pull fallback keeps the Rust shape', async () => {
  const host = await degradedHost();
  seedJobs(host, [persistedJob('job-resumable', 'failed', true)]);
  const delivered: Array<{ event: string; payload: unknown }> = [];
  for (const event of [MIGRATION_STATUS_EVENT, BACKUP_JOBS_RESUMABLE_EVENT]) {
    host.ctx.backendEvents.listen(event, payload => { delivered.push({ event, payload }); });
  }
  await runFinalizers(host);
  expect(delivered).toEqual([]);
  expect(host.eventsNamed(MIGRATION_STATUS_EVENT)).toEqual([]);
  expect(host.eventsNamed(BACKUP_JOBS_RESUMABLE_EVENT)).toEqual([]);

  // commands.rs:739-817 / commands_types.rs:92-117：前端兜底拉取的字段与顺序。
  const status = await host.invoke('data_governance_get_migration_status') as Record<string, unknown>;
  expect(Object.keys(status)).toEqual([
    'global_version', 'all_healthy', 'databases', 'pending_migrations_total', 'has_pending_migrations', 'last_error',
  ]);
  const databases = status.databases as Array<Record<string, unknown>>;
  expect(databases.map(db => db.id)).toEqual(['vfs', 'llm_usage', 'chat_v2', 'mistakes']);
  for (const db of databases) {
    expect(Object.keys(db)).toEqual([
      'id', 'current_version', 'target_version', 'is_initialized', 'last_migration_at', 'pending_count', 'has_pending',
    ]);
  }
});

it('migration status is emitted before restore activation runs, even when activation then fails', async () => {
  const host = await governanceHost({
    startupMigrationReport: () => ({ success: true, totalDurationMs: 1, databases: [] }),
  });
  writeFileSync(restoreActivationMarkerPath(join(host.app.dataDir, 'slots', 'slotA')), '{bad json');
  const sink = startupEventSink(host);
  // D2：激活失败不再中止启动；成功载荷先发，随后是 lib.rs:1180-1189 的激活失败载荷。
  await runFinalizers(host);
  const events = sink.migration;
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ success: true });
  expect(events[1]).toMatchObject({ success: false, restore_activation_failed: true, maintenance_mode_forced: true });
  expectNothingSentToWebview(host, sink);
});

it('emits no migration status when storage does not expose the startup report (no fabricated result)', async () => {
  const host = await governanceHost({});
  const sink = startupEventSink(host);
  await runFinalizers(host);
  expect(sink.migration).toEqual([]);
  expectNothingSentToWebview(host, sink);
});
