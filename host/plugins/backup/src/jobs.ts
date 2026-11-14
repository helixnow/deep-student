import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type {
  BackupJobContext, BackupJobManager, BackupJobParams, BackupJobEvent,
  BackupJobKind, BackupJobPhase, BackupJobStatus, BackupJobResultPayload,
  BackupJobSummary, JobCheckpoint, PersistedJob, ImportProgress,
} from '../api.ts';
import { ioMessage, utcNow } from './io.ts';

export const INCREMENTAL_BACKUP_DISABLED_MESSAGE = 'Incremental backup has been removed; use full backup or cloud sync';
export function defaultJobParams(): BackupJobParams {
  return { backup_type: 'full', include_assets: false, compression_level: 6, include_checksums: true };
}
const terminal = (status: BackupJobStatus) => status === 'completed' || status === 'failed' || status === 'cancelled';
export function canTransitionTo(from: BackupJobStatus, to: BackupJobStatus): boolean {
  if (from === to) return !terminal(from);
  return from === 'queued' ? ['running', 'failed', 'cancelled'].includes(to)
    : from === 'running' && terminal(to);
}

interface JobState {
  event: BackupJobEvent;
  cancelled: boolean;
  startedInstant?: number;
  maxDuration: number | null;
  params?: BackupJobParams;
  checkpoint?: JobCheckpoint;
}

// PersistedJob and nested structs accept serde aliases but discard unknown fields.
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected struct');
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, name: string): unknown {
  const alias = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (alias !== name && name in value && alias in value) throw new Error(`duplicate field \`${name}\``);
  return name in value ? value[name] : value[alias];
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected string');
  return value;
}
function uint(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('expected unsigned integer');
  return value;
}
function date(value: unknown): string {
  const input = text(value);
  if (!Number.isFinite(Date.parse(input))) throw new Error('invalid date');
  return input;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('expected sequence');
  return value.map(text);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('expected boolean');
  return value;
}
export function parseJobParams(value: unknown): BackupJobParams {
  const obj = record(value);
  const result: BackupJobParams = {
    include_assets: field(obj, 'include_assets') === undefined ? false : boolean(field(obj, 'include_assets')),
    include_checksums: field(obj, 'include_checksums') === undefined ? false : boolean(field(obj, 'include_checksums')),
  };
  for (const name of ['backup_type', 'base_version', 'zip_path', 'backup_id', 'output_path'] as const) {
    const v = field(obj, name);
    if (v != null) result[name] = text(v);
  }
  const assets = field(obj, 'asset_types');
  if (assets != null) result.asset_types = strings(assets);
  const level = field(obj, 'compression_level');
  if (level != null) {
    result.compression_level = uint(level);
    if (result.compression_level > 4294967295) throw new Error('expected u32');
  }
  return result;
}
function parseCheckpoint(value: unknown): JobCheckpoint {
  const obj = record(value);
  const checkpoint: JobCheckpoint = {
    processed_items: strings(field(obj, 'processed_items')),
    last_updated: date(field(obj, 'last_updated')),
    current_index: uint(field(obj, 'current_index')),
    total_items: uint(field(obj, 'total_items')),
  };
  const partial = field(obj, 'partial_output');
  if (partial != null) checkpoint.partial_output = text(partial);
  return checkpoint;
}
function parsePersistedJob(value: unknown): PersistedJob {
  const obj = record(value);
  const kind = text(obj.kind);
  const status = text(obj.status);
  const phase = text(obj.phase);
  if (!['export', 'import'].includes(kind) || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(status)
    || !['queued', 'scan', 'checkpoint', 'compress', 'verify', 'extract', 'replace', 'cleanup', 'completed', 'failed', 'cancelled'].includes(phase)) throw new Error('unknown variant');
  if (typeof obj.progress !== 'number' || !Number.isFinite(obj.progress)) throw new Error('expected f32');
  const result: PersistedJob = {
    job_id: text(field(obj, 'job_id')), kind: kind as BackupJobKind, status: status as BackupJobStatus,
    phase: phase as BackupJobPhase, progress: Math.fround(obj.progress), created_at: date(field(obj, 'created_at')),
    params: obj.params ?? null,
  };
  if (field(obj, 'started_at') != null) result.started_at = date(field(obj, 'started_at'));
  if (obj.checkpoint != null) result.checkpoint = parseCheckpoint(obj.checkpoint);
  if (field(obj, 'error_message') != null) result.error_message = text(field(obj, 'error_message'));
  return result;
}

export class Jobs implements BackupJobManager {
  readonly _ctx: Context;
  readonly _states = new Map<string, JobState>();
  readonly _timers = new Set<ReturnType<typeof setTimeout>>();
  readonly _persistDir: string;
  _disposed = false;
  constructor(ctx: Context) {
    this._ctx = ctx;
    this._persistDir = join(ctx.app.dataDir, 'backup_jobs');
    // 卸载即取消在途作业：执行方在下一个检查点走取消路径清理半成品；此后不再发事件、不再起计时器。
    ctx.effect(() => () => {
      this._disposed = true;
      for (const timer of this._timers) clearTimeout(timer);
      this._timers.clear();
      for (const state of this._states.values()) if (!terminal(state.event.status)) state.cancelled = true;
    });
  }
  createJob(kind: BackupJobKind): BackupJobContext { return this.createJobWithId(randomUUID(), kind); }
  createJobWithId(id: string, kind: BackupJobKind): BackupJobContext {
    this._states.set(id, { event: { job_id: id, kind, status: 'queued', phase: 'queued', progress: 0,
      message: null, processed_items: 0, total_items: 0, eta_seconds: null, cancellable: true, created_at: utcNow() },
    cancelled: false, maxDuration: 4 * 60 * 60 * 1000 });
    this._emit(id);
    return new JobContext(this, id);
  }
  requestCancel(id: string): boolean {
    const state = this._states.get(id);
    if (!state || state.cancelled) return false;
    state.cancelled = true;
    return true;
  }
  getJob(id: string): BackupJobSummary | null {
    const state = this._states.get(id);
    if (!state) return null;
    const e = state.event;
    return structuredClone({ job_id: id, kind: e.kind, status: e.status, phase: e.phase,
      progress: Math.min(100, Math.max(0, e.progress)), message: e.message, created_at: e.created_at,
      ...(e.started_at === undefined ? {} : { started_at: e.started_at }),
      ...(e.finished_at === undefined ? {} : { finished_at: e.finished_at }),
      ...(e.result === undefined ? {} : { result: e.result }),
      resumable: e.status === 'failed' && state.checkpoint !== undefined });
  }
  listJobs(): BackupJobSummary[] { return [...this._states.keys()].map(id => this.getJob(id)!); }
  _update(id: string, status: BackupJobStatus, phase: BackupJobPhase, progress: number, message: string | null,
    processed: number, total: number, result?: BackupJobResultPayload): void {
    const state = this._states.get(id);
    if (!state) {
      this._ctx.logger('backup').warn(`[BackupJob] 尝试更新不存在的任务状态，job_id=${id}`);
      return;
    }
    if (!canTransitionTo(state.event.status, status)) {
      this._ctx.logger('backup').warn(
        `[BackupJob] 无效的状态转换: ${state.event.status} -> ${status}, job_id=${id}`,
      );
      return;
    }
    Object.assign(state.event, { status, phase, progress: Math.fround(progress), message, processed_items: processed, total_items: total });
    if (result) state.event.result = structuredClone(result);
    if (status === 'running' && state.event.started_at === undefined) {
      state.event.started_at = utcNow(); state.startedInstant = performance.now();
    } else if (terminal(status) && state.event.finished_at === undefined) state.event.finished_at = utcNow();
    this._emit(id);
  }
  _emit(id: string): void {
    const state = this._states.get(id);
    if (!state || this._disposed) return;
    const event = structuredClone(state.event);
    event.cancellable = !terminal(event.status);
    event.eta_seconds = null;
    if (event.progress > 0 && event.progress < 100 && state.startedInstant !== undefined) {
      const elapsed = Math.fround((performance.now() - state.startedInstant) / 1000);
      if (elapsed > 0) event.eta_seconds = Math.trunc(Math.max(0, Math.fround(elapsed * Math.fround(Math.fround(100 - event.progress) / event.progress))));
    }
    event.progress = Math.min(100, Math.max(0, event.progress));
    this._ctx.backendEvents.emit('backup-job-progress', event);
  }
  emitLegacyProgress(progress: ImportProgress): void { if (!this._disposed) this._ctx.backendEvents.emit('backup-import-progress', structuredClone(progress)); }
  persistJob(id: string): void {
    if (!existsSync(this._persistDir)) {
      try { mkdirSync(this._persistDir, { recursive: true }); }
      catch (e) { throw new CommandError(`创建持久化目录失败: ${ioMessage(e)}`); }
    }
    const state = this._states.get(id);
    if (!state) throw new CommandError(`任务不存在: ${id}`);
    const e = state.event;
    const persisted: PersistedJob = { job_id: id, kind: e.kind, status: e.status, phase: e.phase,
      progress: e.progress, created_at: e.created_at, params: state.params ?? null,
      ...(e.started_at === undefined ? {} : { started_at: e.started_at }),
      ...(state.checkpoint === undefined ? {} : { checkpoint: state.checkpoint }),
      ...(e.result?.error == null ? {} : { error_message: e.result.error }) };
    const path = join(this._persistDir, `${id}.json`);
    const temp = `${path}.tmp`;
    try { writeFileSync(temp, JSON.stringify(persisted, null, 2)); }
    catch (e) { throw new CommandError(`写入临时文件失败: ${ioMessage(e)}`); }
    try { renameSync(temp, path); }
    catch (e) { throw new CommandError(`重命名文件失败: ${ioMessage(e)}`); }
  }
  loadPersistedJobs(): PersistedJob[] {
    if (!existsSync(this._persistDir)) return [];
    let entries: string[];
    try { entries = readdirSync(this._persistDir); }
    catch (e) { throw new CommandError(`读取持久化目录失败: ${ioMessage(e)}`); }
    const jobs: PersistedJob[] = [];
    for (const name of entries) {
      const path = join(this._persistDir, name);
      try {
        if (extname(path) !== '.json' || !statSync(path).isFile()) continue;
        jobs.push(parsePersistedJob(JSON.parse(readFileSync(path, 'utf8'))));
      } catch (e) { this._warn(`读取持久化任务失败 ${path}`, e); }
    }
    return jobs;
  }
  deletePersistedJob(id: string): void {
    const path = join(this._persistDir, `${id}.json`);
    if (!existsSync(path)) return;
    try { unlinkSync(path); }
    catch (e) { throw new CommandError(`删除持久化文件失败: ${ioMessage(e)}`); }
  }
  restoreJobFromPersisted(job: PersistedJob): BackupJobContext {
    const ctx = this.createJobWithId(job.job_id, job.kind);
    try { ctx.setParams(parseJobParams(job.params)); }
    catch (e) { this._warn('恢复任务参数失败', e); }
    if (job.checkpoint) ctx.restoreCheckpoint(job.checkpoint);
    return ctx;
  }
  listResumableJobs(): PersistedJob[] { return this.loadPersistedJobs().filter(job => job.status === 'failed' && job.checkpoint != null); }
  cleanupFinishedPersistedJobs(): number {
    let cleaned = 0;
    for (const job of this.loadPersistedJobs()) {
      if (job.status !== 'completed' && job.status !== 'cancelled') continue;
      try { this.deletePersistedJob(job.job_id); cleaned++; }
      catch (e) { this._warn('清理持久化任务失败', e); }
    }
    return cleaned;
  }
  removeJob(id: string): void { this._states.delete(id); }
  scheduleJobRemoval(id: string): void {
    if (this._disposed) { this.removeJob(id); return; }
    const timer = setTimeout(() => { this.removeJob(id); this._timers.delete(timer); }, 60_000);
    timer.unref(); this._timers.add(timer);
  }
  cleanupCompletedJobs(maxAgeSeconds: number): void {
    const now = Date.now();
    for (const [id, state] of [...this._states]) {
      if (terminal(state.event.status)) {
        if (state.event.finished_at && Math.trunc((now - Date.parse(state.event.finished_at)) / 1000) > maxAgeSeconds) this.removeJob(id);
      } else if (state.event.status === 'running' && state.maxDuration !== null && state.startedInstant !== undefined
        && performance.now() - state.startedInstant > state.maxDuration) {
        this.requestCancel(id); this.markFailure(id, '任务执行超时');
      }
    }
  }
  markFailure(id: string, error: string): void {
    const e = this._states.get(id)?.event;
    this._update(id, 'failed', 'failed', e?.progress ?? 0, error, e?.processed_items ?? 0, e?.total_items ?? 0,
      { success: false, output_path: null, message: null, error, duration_ms: null, requires_restart: false, resumable_job_id: id });
    this._persistQuietly(id);
  }
  markCancelled(id: string, message: string | null): void {
    this._update(id, 'cancelled', 'cancelled', 0, message, 0, 0,
      { success: false, output_path: null, message, error: '任务已取消', duration_ms: null, requires_restart: false });
    this._deleteQuietly(id); this.scheduleJobRemoval(id);
  }
  _warn(message: string, error: unknown): void { this._ctx.logger('backup').warn(`${message}: ${ioMessage(error)}`); }
  _persistQuietly(id: string): void { try { this.persistJob(id); } catch (e) { this._warn('持久化任务时出错', e); } }
  _deleteQuietly(id: string): void { try { this.deletePersistedJob(id); } catch (e) { this._warn('删除持久化任务时出错', e); } }
}

class JobContext implements BackupJobContext {
  readonly _manager: Jobs;
  readonly job_id: string;
  constructor(manager: Jobs, id: string) { this._manager = manager; this.job_id = id; }
  isCancelled(): boolean { return this._manager._states.get(this.job_id)?.cancelled ?? true; }
  checkContinue(): void { if (this.isCancelled()) throw new CommandError('任务已被取消'); }
  markRunning(phase: BackupJobPhase, progress: number, message: string | null, processed: number, total: number): void {
    this._manager._update(this.job_id, 'running', phase, progress, message, processed, total);
  }
  complete(message: string | null, processed: number, total: number, result: BackupJobResultPayload): void {
    this._manager._update(this.job_id, 'completed', 'completed', 100, message, processed, total, result);
    this._manager._deleteQuietly(this.job_id); this._manager.scheduleJobRemoval(this.job_id);
  }
  fail(error: string): void { this._manager.markFailure(this.job_id, error); }
  cancelled(message: string | null): void { this._manager.markCancelled(this.job_id, message); }
  emitLegacyProgress(progress: ImportProgress): void { this._manager.emitLegacyProgress(progress); }
  setParams(params: BackupJobParams): void {
    const state = this._manager._states.get(this.job_id);
    if (state) state.params = structuredClone(params);
    if (params.backup_type === 'incremental') { this._manager.requestCancel(this.job_id); this.fail(INCREMENTAL_BACKUP_DISABLED_MESSAGE); }
  }
  initCheckpoint(total: number): void {
    const state = this._manager._states.get(this.job_id);
    if (state) state.checkpoint = { processed_items: [], last_updated: utcNow(), current_index: 0, total_items: total };
  }
  updateCheckpoint(item: string): void {
    const checkpoint = this._manager._states.get(this.job_id)?.checkpoint;
    if (checkpoint) {
      if (!checkpoint.processed_items.includes(item)) checkpoint.processed_items.push(item);
      checkpoint.current_index = checkpoint.processed_items.length; checkpoint.last_updated = utcNow();
    }
    this._manager._persistQuietly(this.job_id);
  }
  updateZipCheckpoint(current: number, total: number): void {
    const state = this._manager._states.get(this.job_id);
    if (state) {
      if (!state.checkpoint) this.initCheckpoint(total);
      Object.assign(state.checkpoint!, { processed_items: [], current_index: current, total_items: total, last_updated: utcNow() });
    }
    this._manager._persistQuietly(this.job_id);
  }
  setPartialOutput(path: string): void {
    const checkpoint = this._manager._states.get(this.job_id)?.checkpoint;
    if (checkpoint) { checkpoint.partial_output = path; checkpoint.last_updated = utcNow(); }
  }
  getProcessedItems(): string[] { return [...(this._manager._states.get(this.job_id)?.checkpoint?.processed_items ?? [])]; }
  isItemProcessed(item: string): boolean { return this.getProcessedItems().includes(item); }
  getCheckpoint(): JobCheckpoint | null { return structuredClone(this._manager._states.get(this.job_id)?.checkpoint ?? null); }
  restoreCheckpoint(checkpoint: JobCheckpoint): void {
    const state = this._manager._states.get(this.job_id);
    if (state) state.checkpoint = structuredClone(checkpoint);
  }
  setMaxDuration(durationMs: number | null): void {
    const state = this._manager._states.get(this.job_id);
    if (state) state.maxDuration = durationMs;
  }
}
