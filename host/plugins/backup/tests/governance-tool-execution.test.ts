/** Rust data_governance_executor.rs:71-440：L07真实注册→L04生产registry创建/派发，不伪造全App roster。 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { createMigrationWorker, type MigrationWorker } from '../../../platform/storage/node.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import agentSkillsPlugin from '../../agent-skills/index.ts';
import chatPlugin from '../../chat/index.ts';
import { BackendEventsSink, ChatV2Emitter, type ChatSession } from '../../chat/api.ts';
import { DataGovernanceToolExecutor } from '../src/governance-tool.ts';
import { createBackupHost, hostBackupRoot, installSyncService, partialManifest, waitForJob, writeBackup } from './helpers.ts';

const hosts: TestHost[] = [];
let migrationWorker: MigrationWorker | undefined;
let migrationRoot: string | undefined;
let migrationRun: ReturnType<MigrationWorker['runAll']> | undefined;
afterEach(async () => {
  // 超时/失败也先drain当前真实迁移，避免清理Host目录时worker仍在使用它。
  if (migrationRun !== undefined) await Promise.allSettled([migrationRun]);
  for (const host of hosts.splice(0)) await host.dispose();
});
afterAll(async () => {
  try { await migrationWorker?.close(); }
  finally { if (migrationRoot !== undefined) rmSync(migrationRoot, { recursive: true, force: true }); }
});

async function setup(stage: (name: string) => void = () => undefined) {
  stage('host');
  let storage!: StorageServiceImpl;
  const { host } = await createBackupHost({
    storageFactory: dataDir => {
      storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      return storage;
    },
  });
  hosts.push(host);
  host.ctx.effect(() => () => storage.dispose());
  const root = host.app.dataDir;
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  host.ctx.provide('paths', createPaths({ dataDir: root, platform, env: {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: root,
    APPDATA: join(root, 'config'), XDG_DATA_HOME: root, XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), DEVICE_ID: 'governance-tool-device',
  } }));
  stage('migration');
  // 每例仍对新Host的四个空库执行完整F3迁移；只复用worker模块，不缓存数据库或迁移结果。
  // 懒建发生在用例原30s内，不能用beforeAll把首次加载/迁移移出预算。
  if (migrationWorker === undefined) {
    migrationRoot = mkdtempSync(join(tmpdir(), 'dstu-tool-migration-worker-'));
    migrationWorker = createMigrationWorker({ baseDir: migrationRoot });
  }
  migrationRun = migrationWorker.runAll({ appDataDir: storage.locations.activeDir });
  const migrationReport = await migrationRun;
  expect(migrationReport.success).toBe(true);
  stage('migration-ready');
  // 仅满足不涉及主题目录的L04注入边界；这些用例不调用VFS主题操作，调用即报错。
  host.ctx.provide('vfs', { version: 1, database: { getConnSafe() { throw new Error('topic folder VFS is not part of this tool test'); } } });
  stage('agent-skills');
  await host.install(agentSkillsPlugin);
  stage('chat');
  await host.install(chatPlugin);
  stage('sync');
  await installSyncService(host);
  stage('session');
  const session = await host.invoke<ChatSession>('chat_v2_create_session', { mode: 'chat' });
  const mainDb = storage.database('mistakes');
  const context = () => {
    const value = host.ctx.chatSession.createExecutionContext({
      sessionId: session.id, messageId: `msg_${randomUUID()}`, blockId: `blk_${randomUUID()}`,
      emitter: ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), session.id, false),
      services: host.ctx,
      toolRegistry: {
        async detectToolConflicts() { return []; }, stripMcpNamespace: name => name,
        async callTool() { throw new Error('governance tests must not dispatch an external MCP tool'); },
      },
    });
    value.chat_v2_db = host.ctx.chatSession.database;
    // 与生产ExecutionContext一样复用执行前已持有的主库句柄；job_status期间不另行借用被备份屏障冻结的库。
    value.main_db = mainDb;
    return value;
  };
  // 最小owner宿主不伪造完整App花名册中的其它60余执行器；消费L07真实贡献到L04同一生产registry。
  // 全App assembleExecutorRegistry仍由组合根真实roster探针验证，不绕过/修改其MissingExecutorError门禁。
  const ownExecutors = host.ctx.agentTools.toolExecutors().filter(
    (executor): executor is DataGovernanceToolExecutor => executor instanceof DataGovernanceToolExecutor,
  );
  const registry = host.ctx.chatSession.createExecutorRegistry(ownExecutors, {
    ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false,
  });
  return { host, storage, session, context, registry, migrationReport };
}

it('real L07/L04 roster executes backup_status, emits lifecycle and persists the actual tool block', async () => {
  const { host, session, context, registry } = await setup();
  writeBackup(hostBackupRoot(host), partialManifest('older-tool', { createdAt: '2026-01-01T00:00:00Z' }));
  writeBackup(hostBackupRoot(host), partialManifest('newer-tool', { createdAt: '2026-02-01T00:00:00Z' }));
  const contributed = host.ctx.agentTools.toolExecutors().filter(value => value.name() === 'DataGovernanceToolExecutor');
  expect(contributed).toHaveLength(1);
  expect(typeof contributed[0]!.execute).toBe('function');
  const ctx = context();
  const result = await registry.execute({ id: 'call-status', name: 'builtin-backup_status', arguments: { page_size: 1 } }, ctx);
  expect(result).toMatchObject({ toolCallId: 'call-status', blockId: ctx.block_id, success: true,
    output: { success: true, total: 2, count: 1, page: 1, page_size: 1, has_more: true, backups: [{ backup_id: 'newer-tool' }] } });
  expect(result).not.toHaveProperty('error');
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(host.eventsNamed(`chat_v2_event_${session.id}`)).toMatchObject([
    { type: 'tool_call', phase: 'start', payload: { toolName: 'builtin-backup_status', toolCallId: 'call-status' } },
    { type: 'tool_call', phase: 'end', result: { result: result.output, durationMs: result.durationMs } },
  ]);
  expect(host.ctx.chatSession.getBlock(ctx.block_id)).toMatchObject({ status: 'success', toolOutput: result.output });
});

it('real backup_create returns only an async receipt and job_status distinguishes found, expired and unknown', async () => {
  const { host, context, registry } = await setup();
  const created = await registry.execute({ id: 'call-create', name: 'builtin-backup_create', arguments: {} }, context());
  expect(created.success).toBe(true);
  expect(created.output).toMatchObject({ status: 'queued', job_id: expect.any(String) });
  expect(created.output).not.toHaveProperty('success');
  const jobId = (created.output as { job_id: string }).job_id;
  const found = await registry.execute({ id: 'call-found', name: 'builtin-backup_job_status', arguments: { job_id: jobId } }, context());
  expect(found).toMatchObject({ success: true, output: { success: true, lookup: 'found', job: { job_id: jobId } } });
  await waitForJob(host, jobId);
  host.ctx.backup.jobs.removeJob(jobId);
  const expired = await registry.execute({ id: 'call-expired', name: 'builtin-backup_job_status', arguments: { job_id: jobId } }, context());
  expect(expired.output).toMatchObject({ lookup: 'expired', job_id: jobId, terminal_result_retention_seconds: 60 });
  const unknown = await registry.execute({ id: 'call-unknown', name: 'builtin-backup_job_status', arguments: { job_id: randomUUID() } }, context());
  expect(unknown.output).toMatchObject({ lookup: 'not_found', terminal_result_retention_seconds: 60 });
});

it('argument errors emit start/error and persist ToolResultInfo.failure rather than throwing a handler failure', async () => {
  const { host, session, context, registry } = await setup();
  const ctx = context();
  const result = await registry.execute({ id: 'call-invalid', name: 'builtin-backup_create', arguments: { backup_type: 'incremental' } }, ctx);
  expect(result).toMatchObject({ success: false, output: null, blockId: ctx.block_id, toolCallId: 'call-invalid' });
  expect(JSON.parse(result.error!)).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false });
  expect(host.eventsNamed(`chat_v2_event_${session.id}`)).toMatchObject([
    { type: 'tool_call', phase: 'start' }, { type: 'tool_call', phase: 'error', error: result.error },
  ]);
  expect(host.ctx.chatSession.getBlock(ctx.block_id)).toMatchObject({ status: 'error', error: result.error });
  // Rust execute的未知工具match分支不先解析arguments；正常registry会在派发前拒绝未知名。
  const executor = registry.getExecutor('builtin-backup_status')!;
  const unknown = await executor.execute({ id: 'call-unsupported', name: 'builtin-unsupported-governance', arguments: null }, context());
  expect(unknown.success).toBe(false);
  expect(JSON.parse(unknown.error!)).toMatchObject({ code: 'UNKNOWN_TOOL', retryable: false });
});

it('sync_status uses real L20 local status and sync_run rejects unconfigured SSOT before cloud execution', async ({ task }) => {
  const start = performance.now();
  const stages: Array<{ phase: string; elapsed_ms: number }> = [];
  Object.assign(task.meta, { governance_stages: stages });
  const stage = (phase: string) => { stages.push({ phase, elapsed_ms: performance.now() - start }); };
  const { context, registry, migrationReport } = await setup(stage);
  Object.assign(task.meta, { migration_report: {
    thread_id: migrationReport.threadId, duration_ms: migrationReport.totalDurationMs,
    databases: migrationReport.databases.map(database => ({ id: database.id, success: database.success,
      applied_count: database.appliedCount, duration_ms: database.durationMs })),
  } });
  stage('sync-status');
  const status = await registry.execute({ id: 'call-sync-status', name: 'builtin-sync_status', arguments: {} }, context());
  expect(status).toMatchObject({ success: true, output: { success: true, cloud_probed: false,
    cloud_configured: false, observation_scope: 'local_change_logs_only', databases: expect.any(Array), warnings: expect.any(Array) } });
  stage('sync-run');
  const run = await registry.execute({ id: 'call-sync-run', name: 'builtin-sync_run', arguments: { direction: 'upload' } }, context());
  expect(run).toMatchObject({ success: false, output: null });
  expect(JSON.parse(run.error!)).toMatchObject({ code: 'CLOUD_CONFIG_NOT_CONFIGURED', retryable: false });
  stage('complete');
});

it('actual save_tool_block maintenance failure warns but preserves the successful tool result', async () => {
  const { host, storage, context, registry } = await setup();
  const warnings: string[] = [];
  host.ctx.logger.exporter({ levels: { default: 4 }, export(message) {
    if (message.type === 'warn') warnings.push(String(message.args[0]));
  } });
  const ctx = context();
  const lease = await storage.enterMaintenance(['chat_v2']);
  try {
    const result = await registry.execute({ id: 'call-save-failure', name: 'builtin-backup_status', arguments: {} }, ctx);
    expect(result.success).toBe(true);
    expect(warnings.some(value => value.startsWith('[DataGovernanceToolExecutor] failed to persist tool block: '))).toBe(true);
  } finally { lease.release(); }
  expect(host.ctx.chatSession.getBlock(ctx.block_id)).toBeNull();
});
