import type { SyncPhase, SyncProgress } from '../api.ts';
import { isTerminal, progress, withCurrentItem, withOutcome, withSpeed } from './progress.ts';

export const EVENT_NAME = 'data-governance-sync-progress';

export class SyncProgressEmitter {
  private lastEmit: number | null = null;
  private lastPhase: SyncPhase | null = null;
  private lastPercent = 0;
  private operationId = globalThis.crypto.randomUUID();
  lastPhasePlain: SyncPhase = 'preparing';
  private events: { emit(event: string, payload: SyncProgress): void };
  private logError: (message: string) => void;
  constructor(events: { emit(event: string, payload: SyncProgress): void }, logError: (message: string) => void) {
    this.events = events;
    this.logError = logError;
  }
  async emit(value: SyncProgress): Promise<void> {
    const now = performance.now();
    // No await between checking and updating state: equivalent to Rust's mutex scope.
    if (this.lastPhase !== value.phase || isTerminal(value.phase) || this.lastEmit === null || now - this.lastEmit >= 100) {
      this.doEmit(this.normalize(value));
      this.lastEmit = now;
      this.lastPhase = value.phase;
    }
  }
  emitForce(value: SyncProgress): void { this.doEmit(this.normalize(value)); }
  private normalize(value: SyncProgress): SyncProgress {
    const normalized = { ...value };
    normalized.operation_id ??= this.operationId;
    normalized.outcome ??= value.phase === 'completed' ? 'succeeded' : value.phase === 'failed' ? 'failed' : 'in_progress';
    normalized.percent = Math.min(100, Math.max(0, Math.fround(value.percent)));
    if (value.phase === 'preparing') normalized.percent = 0;
    else if (value.phase === 'completed') normalized.percent = 100;
    else normalized.percent = Number.isNaN(normalized.percent) ? this.lastPercent : Math.max(normalized.percent, this.lastPercent);
    this.lastPercent = normalized.percent;
    return normalized;
  }
  private doEmit(value: SyncProgress): void {
    this.lastPhasePlain = value.phase;
    try { this.events.emit(EVENT_NAME, value); }
    catch (error) { this.logError(`[sync_emitter] 发送进度事件失败: ${error instanceof Error ? error.message : String(error)}`); }
  }
  emitPreparing(): Promise<void> { return this.emit(progress.preparing()); }
  emitDetectingChanges(): Promise<void> { return this.emit(progress.detectingChanges()); }
  emitUploading(current: number, total: number, item: string | null): Promise<void> {
    const value = progress.uploading(current, total);
    return this.emit(item === null ? value : withCurrentItem(value, item));
  }
  emitDownloading(current: number, total: number, item: string | null): Promise<void> {
    const value = progress.downloading(current, total);
    return this.emit(item === null ? value : withCurrentItem(value, item));
  }
  emitApplying(current: number, total: number, item: string | null): Promise<void> {
    const value = progress.applying(current, total);
    return this.emit(item === null ? value : withCurrentItem(value, item));
  }
  emitCompleted(): Promise<void> { return this.emit(progress.completed()); }
  emitFailed(error: string): Promise<void> { return this.emit(progress.failed(error)); }
  emitPartial(error: string): Promise<void> { return this.emit(withOutcome(progress.failed(error), 'partial')); }
  emitWithSpeed(value: SyncProgress, speed: number, eta: number | null): Promise<void> {
    return this.emit(withSpeed(value, speed, eta));
  }
  onProgress(value: SyncProgress): Promise<void> { return this.emit(value); }
  onComplete(): Promise<void> { return this.emitCompleted(); }
  onError(error: string): Promise<void> { return this.emitFailed(error); }
}

let statusSink: SyncProgressEmitter | null = null;
export function setStatusSink(emitter: SyncProgressEmitter): void { statusSink = emitter; }
export function clearStatusSink(): void { statusSink = null; }
export function reportSyncStatus(message: string): void {
  const sink = statusSink;
  if (!sink || isTerminal(sink.lastPhasePlain)) return;
  sink.emitForce({ ...progress.preparing(), phase: sink.lastPhasePlain, current_item: message });
}

/** Rust's explicit callback for operations that do not report progress (emitter.rs:327). */
export class NoopProgressCallback {
  onProgress(_value: SyncProgress): Promise<void> { return Promise.resolve(); }
  onComplete(): Promise<void> { return this.onProgress(progress.completed()); }
  onError(error: string): Promise<void> { return this.onProgress(progress.failed(error)); }
}

export class OptionalEmitter {
  private emitter: SyncProgressEmitter | null;
  constructor(emitter: SyncProgressEmitter | null) { this.emitter = emitter; }
  async emit(value: SyncProgress): Promise<void> { if (this.emitter) await this.emitter.emit(value); }
  emitPreparing(): Promise<void> { return this.emit(progress.preparing()); }
  emitDetectingChanges(): Promise<void> { return this.emit(progress.detectingChanges()); }
  emitUploading(current: number, total: number, item: string | null): Promise<void> {
    const value = progress.uploading(current, total);
    return this.emit(item === null ? value : withCurrentItem(value, item));
  }
  emitDownloading(current: number, total: number, item: string | null): Promise<void> {
    const value = progress.downloading(current, total);
    return this.emit(item === null ? value : withCurrentItem(value, item));
  }
  emitApplying(current: number, total: number, item: string | null): Promise<void> {
    const value = progress.applying(current, total);
    return this.emit(item === null ? value : withCurrentItem(value, item));
  }
  emitCompleted(): Promise<void> { return this.emit(progress.completed()); }
  emitFailed(error: string): Promise<void> { return this.emit(progress.failed(error)); }
  hasEmitter(): boolean { return this.emitter !== null; }
  emitForceSync(value: SyncProgress): void { this.emitter?.emitForce(value); }
  clone(): OptionalEmitter { return new OptionalEmitter(this.emitter); }
}
