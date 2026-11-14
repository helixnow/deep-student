/**
 * 限时练习截止提交（qbank_practice.rs:762-795）。
 *
 * Rust 用 `DateTime::parse_from_rfc3339` 解析截止时间，按整秒 `timestamp()` 计算
 * `deadline - now + 3` 秒；同一草稿只注册一次。提交成功后发事件并启动批改队列。
 */
import { parseRfc3339 } from '../../../platform/time/index.ts';
import type { PracticeAttempt, PracticeDraft } from '../api.ts';
import type { QbankLogger } from './ports.ts';

export interface DeadlineSchedulerHost {
  loadDeadlineDrafts(): Promise<PracticeDraft[]>;
  submitLatestRevision(id: string): Promise<PracticeAttempt>;
  emitUpdated(attemptId: string): void;
  startGrading(): void;
  readonly log?: QbankLogger;
}

export class DeadlineScheduler {
  private readonly scheduled = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly host: DeadlineSchedulerHost;

  constructor(host: DeadlineSchedulerHost) {
    this.host = host;
  }

  async resume(): Promise<void> {
    for (const draft of await this.host.loadDeadlineDrafts()) this.schedule(draft);
  }

  schedule(draft: PracticeDraft): void {
    if (draft.deadline === null || this.scheduled.has(draft.id)) return;
    const deadline = parseRfc3339(draft.deadline);
    if (deadline === null) return;
    const deadlineSeconds = Math.floor(deadline.millis / 1000);
    this.scheduled.add(draft.id);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const delay = Math.max(0, deadlineSeconds - nowSeconds + 3) * 1000;
    const timer = setTimeout(() => {
      this.timers.delete(draft.id);
      void this.fire(draft.id);
    }, delay);
    timer.unref?.();
    this.timers.set(draft.id, timer);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.scheduled.clear();
  }

  private async fire(id: string): Promise<void> {
    try {
      const attempt = await this.host.submitLatestRevision(id);
      this.host.emitUpdated(attempt.id);
      this.host.startGrading();
    } catch (error) {
      this.host.log?.warn(`[qbank] deadline submit failed for ${id}: ${errorText(error)}`);
    } finally {
      // Rust removes the id from DEADLINES after the task finishes (success or failure).
      this.scheduled.delete(id);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
