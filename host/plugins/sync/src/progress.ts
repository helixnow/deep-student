import type { SyncPhase, SyncProgress, SyncOutcome } from '../api.ts';

const phaseNames: Record<SyncPhase, string> = {
  preparing: '准备中', detecting_changes: '检测变更', uploading: '上传中', downloading: '下载中',
  applying: '应用变更', completed: '已完成', failed: '失败',
};
export const displayName = (phase: SyncPhase): string => phaseNames[phase];
export const isTerminal = (phase: SyncPhase): boolean => phase === 'completed' || phase === 'failed';

function base(phase: SyncPhase, percent: number, current = 0, total = 0): SyncProgress {
  return { outcome: 'in_progress', phase, percent, current, total,
    current_item: null, speed_bytes_per_sec: null, eta_seconds: null, error: null };
}

function itemProgress(phase: SyncPhase, start: number, span: number, current: number, total: number): SyncProgress {
  const f = Math.fround;
  const percent = total > 0 ? f(start + f(f(f(current) / f(total)) * span)) : start;
  return base(phase, percent, current, total);
}

/** progress.rs:86-261. Plain objects are directly serializable by Host. */
export const progress = {
  preparing: (): SyncProgress => base('preparing', 0),
  detectingChanges: (): SyncProgress => base('detecting_changes', 5),
  uploading: (current: number, total: number): SyncProgress => itemProgress('uploading', 60, 25, current, total),
  downloading: (current: number, total: number): SyncProgress => itemProgress('downloading', 10, 30, current, total),
  applying: (current: number, total: number): SyncProgress => itemProgress('applying', 40, 20, current, total),
  completed: (): SyncProgress => ({ ...base('completed', 100), outcome: 'succeeded' }),
  failed: (error: string): SyncProgress => ({ ...base('failed', 0), outcome: 'failed', error }),
};
export const withCurrentItem = (value: SyncProgress, item: string): SyncProgress => ({ ...value, current_item: item });
export const withSpeed = (value: SyncProgress, speed: number, eta: number | null): SyncProgress =>
  ({ ...value, speed_bytes_per_sec: speed, eta_seconds: eta });
export const withPercent = (value: SyncProgress, percent: number): SyncProgress =>
  ({ ...value, percent: Math.min(100, Math.max(0, Math.fround(percent))) });
export const withOperationId = (value: SyncProgress, id: string): SyncProgress => ({ ...value, operation_id: id });
export const withOutcome = (value: SyncProgress, outcome: SyncOutcome): SyncProgress => ({ ...value, outcome });

export class SpeedCalculator {
  private samples: Array<[number, number]> = [];
  private windowSize: number;
  constructor(windowSize = 10) { this.windowSize = Math.max(2, windowSize); }
  addSample(bytes: number): void {
    const now = performance.now();
    if (this.samples.length >= this.windowSize) this.samples.shift();
    this.samples.push([now, bytes]);
  }
  calculateSpeed(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const duration = last[0] - first[0];
    if (duration === 0) return null;
    return Math.min(Number(0xffffffffffffffffn), Math.trunc(Math.max(0, last[1] - first[1]) / (duration / 1000)));
  }
  calculateEta(remaining: number): number | null {
    const speed = this.calculateSpeed();
    return speed === null || speed === 0 ? null : Math.trunc(remaining / speed);
  }
  reset(): void { this.samples.length = 0; }
  sampleCount(): number { return this.samples.length; }
}

export class ProgressTracker {
  private progress = progress.preparing();
  private speedCalculator = new SpeedCalculator();
  private startTime = performance.now();
  private totalBytes = 0;
  private transferredBytes = 0;
  setTotalBytes(total: number): void { this.totalBytes = total; }
  updateTransferred(bytes: number): void { this.transferredBytes = bytes; this.speedCalculator.addSample(bytes); }
  setPhase(phase: SyncPhase): void { this.progress.phase = phase; }
  updateItems(current: number, total: number): void { this.progress.current = current; this.progress.total = total; }
  setCurrentItem(item: string): void { this.progress.current_item = item; }
  getProgress(): SyncProgress {
    const value = { ...this.progress };
    const speed = this.speedCalculator.calculateSpeed();
    if (speed !== null) {
      value.speed_bytes_per_sec = speed;
      value.eta_seconds = this.speedCalculator.calculateEta(Math.max(0, this.totalBytes - this.transferredBytes));
    }
    return value;
  }
  elapsed(): number { return performance.now() - this.startTime; }
  complete(): void { this.progress = progress.completed(); }
  fail(error: string): void { this.progress = progress.failed(error); }
}
