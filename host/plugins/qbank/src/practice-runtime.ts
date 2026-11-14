/** qbank_practice.rs:733-795: one grading queue and deadline registry per Host. */
import type { Context } from '@deepseek-ai/cordis';
import * as path from '../../../platform/util/path.ts';
import type { PracticeDraft } from '../api.ts';
import type { PracticeServiceHost } from './practice-service.ts';
import * as practice from './practice-service.ts';
import { QbankServiceError } from './question-service.ts';
import { DeadlineScheduler } from './deadline-scheduler.ts';
import { PracticeGradingQueue } from './practice-grading-queue.ts';
import { llmPracticeGrader } from './llm-grader.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { LLMManager, LlmStreamingService } from '../../llm/api.ts';

function errorText(error: unknown): string {
  if (error instanceof QbankServiceError) {
    const appError = error.appError as { message?: unknown };
    if (typeof appError.message === 'string') return appError.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createPracticeRuntime(ctx: Context, loadHost: () => Promise<PracticeServiceHost>) {
  const log = ctx.logger('qbank');
  let disposed = false;
  let scheduler: Promise<DeadlineScheduler> | null = null;
  let gradingQueue: Promise<PracticeGradingQueue> | null = null;

  const ensureScheduler = (): Promise<DeadlineScheduler> => {
    // Publish the in-flight initialization before loadHost can yield (deviceId is asynchronous).
    // Rust DEADLINES is a single registry, not one registry per racing IPC call.
    scheduler ??= loadHost().then(host => new DeadlineScheduler({
      loadDeadlineDrafts: async () => practice.resumeDeadlineDrafts(host),
      submitLatestRevision: async id => practice.submitDraft(host, id, null).attempt,
      emitUpdated: attemptId => ctx.backendEvents.emit('qbank-practice-updated', attemptId),
      startGrading,
      log,
    })).catch(error => {
      scheduler = null;
      throw error;
    });
    return scheduler;
  };

  const ensureGradingQueue = (): Promise<PracticeGradingQueue> => {
    gradingQueue ??= loadHost().then(host => new PracticeGradingQueue({
      ...host,
      emitPracticeUpdated: attemptId => ctx.backendEvents.emit('qbank-practice-updated', attemptId),
    }, llmPracticeGrader({
      llm: () => ctx.get('llm') as LLMManager | undefined,
      streaming: () => ctx.get('llmStreaming') as LlmStreamingService | undefined,
      images: () => {
        const vfsRepo = ctx.get('vfsRepo') as VfsReposService | undefined;
        if (vfsRepo === undefined) return undefined;
        return { db: ctx.storage.database('vfs'),
          blobsDir: path.join(ctx.storage.locations.activeDir, 'vfs_blobs'), vfsRepo };
      },
    }))).catch(error => {
      gradingQueue = null;
      throw error;
    });
    return gradingQueue;
  };

  function startGrading(): void {
    if (disposed) return;
    void ensureGradingQueue().then(queue => {
      if (!disposed) queue.start();
    }).catch(error => log.error(`Practice grading queue: ${errorText(error)}`));
  }

  async function resumeDeadlines(): Promise<void> {
    if (disposed) return;
    const active = await ensureScheduler();
    if (!disposed) await active.resume();
  }

  function scheduleDeadline(draft: PracticeDraft): void {
    if (disposed) return;
    void ensureScheduler().then(active => {
      if (!disposed) active.schedule(draft);
    }).catch(error => log.warn(`[qbank] deadline schedule failed for ${draft.id}: ${errorText(error)}`));
  }

  async function dispose(): Promise<void> {
    disposed = true;
    // A host initialization already in flight must not leave a live timer after plugin unload.
    // Initialization errors have their original log sites in start/resume/schedule.
    const initialized = await Promise.allSettled([scheduler, gradingQueue]);
    for (const result of initialized) {
      if (result.status === 'fulfilled') result.value?.dispose();
    }
  }

  function start(): void {
    void resumeDeadlines().catch(error => log.warn(`[qbank] deadline resume failed: ${errorText(error)}`));
    startGrading();
  }

  return { start, startGrading, resumeDeadlines, scheduleDeadline, dispose };
}
