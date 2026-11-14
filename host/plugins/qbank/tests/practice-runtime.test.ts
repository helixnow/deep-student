import fs from 'node:fs';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import type { Message } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importProfile, installProfile, OFFICIAL_PROFILE_PATH, resolveProfile } from '../../../kernel/profile.ts';
import { createTestHost, definePlugin } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createMigratedStorage } from './support/storage.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { PracticeAttempt, PracticeDraft, Question } from '../api.ts';

afterEach(() => vi.useRealTimers());

/** L02 llm/llmStreaming 的服务替身：只到 HTTP 边界，qbank 侧走真实 llmPracticeGrader。 */
function gradingLlm(complete: (...args: any[]) => Promise<unknown>) {
  const config = {
    id: 'cfg-test', model: 'test-model', apiKey: 'test-key',
    isMultimodal: false, maxOutputTokens: 1024, maxTokensLimit: null,
    baseUrl: 'https://api.openai.com/v1', name: 'test', vendorId: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    isReasoning: false, isEmbedding: false, isReranker: false, isImageGeneration: false,
    enabled: true, modelAdapter: '', supportsTools: false, geminiApiVersion: '',
    isBuiltin: false, isReadOnly: false, reasoningEffort: null, reasoningMode: null,
    thinkingEnabled: false, thinkingBudget: null, includeThoughts: false, minP: null,
    topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: false, temperature: 0.7,
  };
  return {
    llm: {
      getModelAssignments: async () => ({ qbank_ai_grading_model_config_id: null }),
      getModel2Config: async () => config,
      decryptApiKey: async (key: string) => key,
      consumePendingCancel: async () => false,
      subscribeCancelStream: async () => new AbortController().signal,
      clearCancelStream: async () => undefined,
    },
    llmStreaming: { singleShotCompletion: complete },
  };
}

describe('Q7 / qbank_practice.rs runtime through registered commands', () => {
  it('concurrent_resume_preserves_the_single_DEADLINES_registration_across_async_host_initialization', async () => {
    const { storage, base } = await createMigratedStorage('qbank-runtime-');
    const paths = createPaths({ dataDir: base, platform: 'linux',
      env: { ...process.env, DEVICE_ID: 'qbank-test-device' } });
    const provide = { storage, paths };
    let host = await createTestHost({ plugins: [vfsRepos, qbank], provide });
    let release: (() => void) | undefined;
    try {
      storage.database('vfs').run(`INSERT INTO exam_sheets
        (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
        VALUES ('exam_runtime', 'runtime', 'completed', 't', '{}', '{}', '2026-01-01', '2026-01-01')`);
      const question = await host.invoke('qbank_create_question', { params: {
        exam_id: 'exam_runtime', content: 'unanswered', question_type: 'short_answer',
      } }) as Question;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const draft = await host.invoke('qbank_create_practice', { request: {
        id: 'runtime_deadline', scope_id: 'exam_runtime', title: 'runtime', mode: 'timed',
        question_ids: [question.id], duration_seconds: 10,
      } }) as PracticeDraft;
      expect(draft.deadline).not.toBeNull();
      await host.dispose();

      const deviceReady = new Promise<void>(resolve => { release = resolve; });
      const delayedPaths = new Proxy(paths, {
        get(target, property, receiver) {
          if (property === 'deviceId') return async () => {
            await deviceReady;
            return paths.deviceId();
          };
          return Reflect.get(target, property, receiver);
        },
      });
      host = await createTestHost({ plugins: [vfsRepos, qbank],
        provide: { storage, paths: delayedPaths } });
      const updates: unknown[] = [];
      host.ctx.backendEvents.listen('qbank-practice-updated', payload => updates.push(payload));
      const first = host.invoke('qbank_resume_practice_grading', {});
      const second = host.invoke('qbank_resume_practice_grading', {});
      // Both IPC calls are waiting on the same asynchronous platform service.
      await Promise.resolve();
      release!();
      await Promise.all([first, second]);
      await vi.advanceTimersByTimeAsync(13_000);

      // Rust qbank_practice.rs:770-775 inserts into one process-wide DEADLINES set;
      // duplicate resumes must not spawn multiple timers or emit multiple submit events.
      expect(updates).toEqual(['runtime_deadline']);
      const attempt = await host.invoke('qbank_get_practice', {
        id: 'runtime_deadline', submitted: true,
      });
      expect(attempt).toMatchObject({ id: 'runtime_deadline', status: 'completed' });
    } finally {
      release?.();
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('official_profile_order_starts_resume_practice_grading_and_schedule_deadline_after_vfsRepo_and_llm', async () => {
    const { storage, base } = await createMigratedStorage('qbank-runtime-official-');
    const paths = createPaths({ dataDir: base, platform: 'linux',
      env: { ...process.env, DEVICE_ID: 'qbank-test-device' } });
    const settle = async (until: () => boolean = () => false, rounds = 200) => {
      for (let i = 0; i < rounds && !until(); i++) await nextMacrotask();
    };
    const db = storage.database('vfs');
    const jobStatus = (attemptId: string) =>
      db.pluck<string>('SELECT status FROM qbank_practice_jobs WHERE attempt_id = ?1', [attemptId]);
    const draftExists = (id: string) =>
      db.pluck<number>('SELECT COUNT(*) FROM qbank_practice_drafts WHERE id = ?1', [id]) === 1;

    // Session 1: leave one expired timed draft and one subjective job interrupted while running.
    const hanging = gradingLlm(() => new Promise<never>(() => undefined));
    let host = await createTestHost({ plugins: [vfsRepos, qbank], provide: { storage, paths, ...hanging } });
    let essay: PracticeAttempt;
    try {
      db.run(`INSERT INTO exam_sheets
        (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
        VALUES ('exam_runtime', 'runtime', 'completed', 't', '{}', '{}', '2026-01-01', '2026-01-01')`);
      const question = await host.invoke('qbank_create_question', { params: {
        exam_id: 'exam_runtime', content: '论述题', question_type: 'essay',
      } }) as Question;
      // Keep the clock an hour behind until session 1 is gone, so its own timer cannot fire.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3_600_000 });
      await host.invoke('qbank_create_practice', { request: {
        id: 'expired_deadline', scope_id: 'exam_runtime', title: 'timed', mode: 'timed',
        question_ids: [question.id], duration_seconds: 10,
      } });
      const draft = await host.invoke('qbank_create_practice', { request: {
        id: 'essay_practice', scope_id: 'exam_runtime', title: 'essay', mode: 'sequential',
        question_ids: [question.id],
      } }) as PracticeDraft;
      await host.invoke('qbank_save_practice', { request: {
        id: draft.id, revision: draft.revision, answers: { [question.id]: '我的论述' },
        marked_ids: [], current_index: 0, elapsed_seconds: 3,
      } });
      essay = await host.invoke('qbank_submit_practice', { id: draft.id, revision: 2 }) as PracticeAttempt;
      await settle(() => jobStatus(essay.id) === 'running');
      expect(jobStatus(essay.id)).toBe('running');
    } finally {
      await host.dispose();
      vi.useRealTimers();
    }
    expect(draftExists('expired_deadline')).toBe(true);

    // Session 2: the generated official profile entries in their real relative order.
    host = await createTestHost({ provide: { storage, paths } });
    const logs: Message[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    const qbankErrors = () => logs.filter(message => message.name === 'qbank'
      && (message.type === 'error' || message.type === 'warn')).map(message => String(message.args[0]));
    try {
      const entries = (await resolveProfile(OFFICIAL_PROFILE_PATH))
        .filter(entry => ['dstu.qbank', 'dstu.review', 'dstu.vfs-repos'].includes(entry.id));
      const installed = await installProfile(host.runtime, await importProfile(entries));
      expect(installed.degraded).toEqual([]);
      expect(installed.installed.map(entry => entry.id)).toEqual(['dstu.qbank', 'dstu.review', 'dstu.vfs-repos']);
      await settle();
      // vfsRepo is now present but L02 (official position after vfs-repos) is not: the queue
      // must neither fail on a missing VFS service nor fail the interrupted job for a missing LLM.
      expect(qbankErrors()).toEqual([]);
      expect(jobStatus(essay.id)).toBe('running');
      expect(draftExists('expired_deadline')).toBe(true);

      const graded: string[] = [];
      const llmProvider = definePlugin({
        meta: { id: 'test.l02-llm', provides: ['llm', 'llmStreaming'] },
        // Mirrors the real dstu.llm dependency on vfsRepo, which places it after vfs-repos.
        inject: ['vfsRepo'],
        apply(ctx) {
          const services = gradingLlm(async (...args: unknown[]) => {
            graded.push('call');
            const content = '回答正确 <verdict>correct</verdict> <score value="100" />';
            (args[6] as (delta: string) => boolean)(content);
            return { content, reasoningBytes: 0,
              finishReason: 'stop', usage: null, mode: 'stream', attempts: 1, interrupted: null, aborted: false };
          });
          ctx.provide('llm', services.llm);
          ctx.provide('llmStreaming', services.llmStreaming);
        },
      });
      await host.install(llmProvider);
      await settle(() => jobStatus(essay.id) === 'done' && !draftExists('expired_deadline'), 2000);

      // qbank_practice.rs:744-757 resume + 790 start_grading: running → queued → graded once.
      expect(jobStatus(essay.id)).toBe('done');
      expect(graded).toEqual(['call']);
      const gradedAttempt = await host.invoke('qbank_get_practice', { id: essay.id, submitted: true }) as PracticeAttempt;
      expect(gradedAttempt.status).toBe('completed');
      expect(gradedAttempt.results[0]).toMatchObject({ status: 'correct', is_correct: true, score: 100 });
      // qbank_practice.rs:762-795: the expired deadline submits the latest revision.
      expect(draftExists('expired_deadline')).toBe(false);
      const expired = await host.invoke('qbank_get_practice', { id: 'expired_deadline', submitted: true }) as PracticeAttempt;
      expect(expired.status).toBe('completed');
      expect(host.eventsNamed('qbank-practice-updated')).toEqual(expect.arrayContaining(['expired_deadline', essay.id]));
      expect(qbankErrors()).toEqual([]);

      // Unload: a pending deadline timer and a queued grading start must not outlive the plugin.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const question = await host.invoke('qbank_create_question', { params: {
        exam_id: 'exam_runtime', content: '第二道论述题', question_type: 'essay',
      } }) as Question;
      await host.invoke('qbank_create_practice', { request: {
        id: 'future_deadline', scope_id: 'exam_runtime', title: 'timed', mode: 'timed',
        question_ids: [question.id], duration_seconds: 600,
      } });
      const second = await host.invoke('qbank_create_practice', { request: {
        id: 'essay_second', scope_id: 'exam_runtime', title: 'essay', mode: 'sequential',
        question_ids: [question.id],
      } }) as PracticeDraft;
      await host.invoke('qbank_save_practice', { request: {
        id: second.id, revision: second.revision, answers: { [question.id]: '第二次论述' },
        marked_ids: [], current_index: 0, elapsed_seconds: 1,
      } });
      const queued = await host.invoke('qbank_submit_practice', { id: second.id, revision: 2 }) as PracticeAttempt;
      await settle(undefined, 20);
      expect(vi.getTimerCount()).toBe(2);
      await host.unload('dstu.qbank');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(700_000);
      expect(draftExists('future_deadline')).toBe(true);
      expect(jobStatus(queued.id)).toBe('queued');
      expect(graded).toEqual(['call']);
    } finally {
      vi.useRealTimers();
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
