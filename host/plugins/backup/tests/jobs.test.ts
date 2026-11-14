import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createBackupHost } from './helpers.ts';
import { canTransitionTo, defaultJobParams, INCREMENTAL_BACKUP_DISABLED_MESSAGE } from '../src/jobs.ts';
import { INCREMENTAL_BACKUP_REMOVED_MESSAGE } from '../src/manifest.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
async function setup() {
  const { host } = await createBackupHost();
  hosts.push(host);
  return host;
}

it('zip_checkpoint_retains_resume_path_and_scalar_progress_without_names', async () => {
  const host = await setup();
  const job = host.ctx.backup.jobs.createJob('import');
  job.initCheckpoint(5000);
  job.updateCheckpoint('assets/previous.bin');
  job.setPartialOutput('/tmp/zip-import-resume');
  job.restoreCheckpoint(job.getCheckpoint()!);
  job.updateZipCheckpoint(4000, 5000);
  const restored = JSON.parse(JSON.stringify(job.getCheckpoint()));
  expect(restored.processed_items).toEqual([]);
  expect(restored.current_index).toBe(4000);
  expect(restored.total_items).toBe(5000);
  expect(restored.partial_output).toBe('/tmp/zip-import-resume');
});

it('database_checkpoint_still_retains_processed_items', async () => {
  const host = await setup();
  const job = host.ctx.backup.jobs.createJob('import');
  job.initCheckpoint(2);
  job.updateCheckpoint('chat_v2');
  job.updateCheckpoint('vfs');
  expect(job.getProcessedItems()).toEqual(['chat_v2', 'vfs']);
  expect(job.isItemProcessed('chat_v2')).toBe(true);
});

it('terminal_state_reentry_is_rejected_to_deduplicate_notifications', () => {
  expect(canTransitionTo('completed', 'completed')).toBe(false);
  expect(canTransitionTo('failed', 'failed')).toBe(false);
  expect(canTransitionTo('cancelled', 'cancelled')).toBe(false);
  expect(canTransitionTo('running', 'running')).toBe(true);
});

it('incremental_disabled_message_is_english_and_aligned', () => {
  expect(INCREMENTAL_BACKUP_DISABLED_MESSAGE).toBe('Incremental backup has been removed; use full backup or cloud sync');
  expect(/[\u0080-\uffff]/.test(INCREMENTAL_BACKUP_DISABLED_MESSAGE)).toBe(false);
  // Rust 1431-1435 cfg(data_governance)：桌面构建启用该 feature。
  expect(INCREMENTAL_BACKUP_DISABLED_MESSAGE).toBe(INCREMENTAL_BACKUP_REMOVED_MESSAGE);
});

it('set_params_rejects_incremental_job_with_english_removed_message', async () => {
  const host = await setup();
  const job = host.ctx.backup.jobs.createJob('export');
  job.setParams({ ...defaultJobParams(), backup_type: 'incremental' });
  const summary = host.ctx.backup.jobs.getJob(job.job_id)!;
  expect(summary.status).toBe('failed');
  expect(summary.phase).toBe('failed');
  expect(summary.message).toBe(INCREMENTAL_BACKUP_DISABLED_MESSAGE);
  expect(summary.message).toContain('Incremental backup has been removed');
  expect(summary.message!.includes('full backup') || summary.message!.includes('cloud sync')).toBe(true);
  expect(summary.result?.error).toBe(INCREMENTAL_BACKUP_DISABLED_MESSAGE);
  expect(job.isCancelled()).toBe(true);
});

it('set_params_allows_full_backup_type', async () => {
  const host = await setup();
  const job = host.ctx.backup.jobs.createJob('export');
  job.setParams({ ...defaultJobParams(), backup_type: 'full' });
  expect(host.ctx.backup.jobs.getJob(job.job_id)?.status).toBe('queued');
  expect(job.isCancelled()).toBe(false);
});

it('job commands use the shared manager, preserve progress, and reject terminal reentry', async () => {
  const host = await setup();
  const job = host.ctx.backup.jobs.createJob('import');
  expect(await host.invoke('data_governance_get_backup_job', { jobId: 'missing' })).toBeNull();
  expect(await host.invoke('data_governance_cancel_backup', { jobId: 'missing' })).toBe(false);
  expect(await host.invoke('data_governance_cancel_backup', { jobId: job.job_id })).toBe(true);
  expect(await host.invoke('data_governance_cancel_backup', { jobId: job.job_id })).toBe(false);
  expect(() => job.checkContinue()).toThrow('任务已被取消');
  job.markRunning('extract', 37.1, 'extracting', 3, 8);
  job.initCheckpoint(8);
  job.fail('failure');
  const summary = await host.invoke('data_governance_get_backup_job', { jobId: job.job_id });
  expect(summary).toMatchObject({ status: 'failed', progress: Math.fround(37.1), resumable: true });
  expect(await host.invoke('data_governance_list_backup_jobs')).toEqual([summary]);
  const events = host.eventsNamed('backup-job-progress');
  expect(events).toHaveLength(3);
  expect(events[2]).toMatchObject({ processed_items: 3, total_items: 8, cancellable: false });
  job.fail('second failure');
  expect(host.eventsNamed('backup-job-progress')).toHaveLength(3);
  expect(host.ctx.backup.jobs.loadPersistedJobs()[0]).toMatchObject({ error_message: 'failure', progress: Math.fround(37.1) });
});

it('V09 P2-4: unloading backup cancels running and queued jobs; their cancel path then emits nothing and leaves no timer', async () => {
  const host = await setup();
  const jobs = host.ctx.backup.jobs;
  const running = jobs.createJob('export');
  running.markRunning('compress', 40, null, 2, 5);
  const queued = jobs.createJob('import');
  const failed = jobs.createJob('import');
  failed.fail('earlier failure');
  const emitted = host.eventsNamed('backup-job-progress').length;

  await host.unload('dstu.backup');
  expect(running.isCancelled()).toBe(true);
  expect(queued.isCancelled()).toBe(true);
  expect(() => running.checkContinue()).toThrow('任务已被取消');
  expect(jobs.getJob(failed.job_id)?.status).toBe('failed');

  running.cancelled('用户取消 ZIP 导出');
  queued.cancelled('用户取消导入');
  expect(host.eventsNamed('backup-job-progress')).toHaveLength(emitted);
  expect(jobs.getJob(running.job_id)).toBeNull();
  expect(jobs.getJob(queued.job_id)).toBeNull();
});

it('data_governance_cleanup_persisted_jobs removes only terminal completed/cancelled records', async () => {
  const host = await setup();
  const jobs = host.ctx.backup.jobs;
  const done = jobs.createJob('export');
  done.markRunning('scan', 0, null, 0, 0);
  done.complete(null, 1, 1, { success: true, output_path: null, message: null, error: null, duration_ms: null, requires_restart: false });
  jobs.persistJob(done.job_id);
  const failed = jobs.createJob('import');
  failed.initCheckpoint(1);
  failed.fail('keep');
  expect(await host.invoke('data_governance_cleanup_persisted_jobs')).toBe(1);
  expect(jobs.loadPersistedJobs().map(job => job.job_id)).toEqual([failed.job_id]);
});
