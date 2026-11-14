/**
 * `qbank_generation/pipeline.rs::run_qbank_generation_with_config` 编排分支
 * （Rust 无对应测试；命令注册后改由 host.invoke 契约测试覆盖）。
 */
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
import type { QbankGenerationRequest, QuestionDocument } from '../api.ts';
import { GenerationSessions } from '../src/generation-session.ts';
import {
  executeGenerationTask, runQbankGeneration, type GenerationRunnerPorts, type GenerationTaskPorts,
} from '../src/generation-runner.ts';

const config = { id: 'cfg', name: 'M', model: 'm', isMultimodal: true, maxOutputTokens: 4096,
  maxTokensLimit: null, contextWindow: null } as unknown as ApiConfig;

const request: QbankGenerationRequest = { exam_id: 'exam_1', stream_session_id: 'sess', max_questions: 1, specs: [] };

const question = { local_id: 'q1', group_id: null, original_label: null, section_path: [], content: '题干',
  question_type: 'short_answer', options: null, answer: '答', answer_origin: 'missing', explanation: null,
  structured_data: null, difficulty: 'medium', tags: [], source_refs: [{ source_id: 'r1_s1', page: null }],
  answer_source_refs: [], figures: [] };

function ports(output: () => Promise<string>): { ports: GenerationRunnerPorts; saved: QuestionDocument[]; meta: Record<string, unknown>[] } {
  const saved: QuestionDocument[] = [];
  const meta: Record<string, unknown>[] = [];
  return {
    saved, meta,
    ports: {
      sessions: new GenerationSessions(),
      collectExamContext: () => ({ examName: '集', samples: [] }),
      resolveAuthoringConfig: async () => config,
      resolveVisualFallback: async () => { throw new Error('unused'); },
      collectReferences: async () => ({
        bundle: { sources: [{ source_id: 'r1_s1', name: 'a.txt', format: 'txt', page_count: null }], pages: [], text: '正文', format: 'txt' },
        skipped: [], hasMediaAnchors: false,
      }),
      loadPageImageBytes: () => new Uint8Array(),
      runQuestionJson: async () => ({ content: await output(), finishReason: 'stop', usage: null, jsonMode: true }),
      attachFigures: async (raw) => {
        for (const item of raw.questions as Record<string, unknown>[]) item.images = [];
      },
      saveDraft: (_exam, document, metadata) => { saved.push(document); meta.push(metadata); return 'qjob_1'; },
      getDraft: (jobId) => ({ job_id: jobId, exam_id: 'exam_1', document: saved[0]!, status: 'ready', version: 1, metadata: {} }),
    },
  };
}

describe('run_qbank_generation_with_config', () => {
  it('saves a generate-mode draft with idempotency key and legacy projection', async () => {
    const { ports: p, saved, meta } = ports(async () => JSON.stringify({
      schema_version: 2, mode: 'generate', questions: [question],
      coverage: [{ source_id: 'r1_s1', page: null, status: 'processed' }],
    }));
    const response = await runQbankGeneration(request, p, null);
    expect(response).not.toBeNull();
    expect(saved[0]!.questions[0]!.answer_origin).toBe('generated');
    expect(meta[0]!.idempotency_key).toBe('ai_generation:sess');
    expect(response!.job_id).toBe('qjob_1');
    expect(response!.drafts[0]!.local_id).toBe('q1');
    expect(response!.used_reference_count).toBe(1);
  });

  it('rejects a question count different from the request', async () => {
    const { ports: p } = ports(async () => JSON.stringify({
      questions: [question, { ...question, local_id: 'q2' }],
      coverage: [{ source_id: 'r1_s1', page: null, status: 'processed' }],
    }));
    await expect(runQbankGeneration(request, p, null)).rejects.toMatchObject({
      appError: { error_type: 'Validation', message: '出题数量与要求不一致（要求1，返回2），未截取或静默丢弃题目，请重新生成' },
    });
  });

  it('returns null when the generation session is cancelled', async () => {
    const { ports: p } = ports(async () => {
      p.sessions.cancel('qbank_generation_stream_sess');
      return '{}';
    });
    await expect(runQbankGeneration(request, p, null)).resolves.toBeNull();
  });

  it('skipped references fail before calling the model', async () => {
    const { ports: p } = ports(async () => { throw new Error('model must not be called'); });
    p.collectReferences = async () => ({ bundle: { sources: [], pages: [], text: '', format: 'none' },
      skipped: [{ name: 'f1', reason: 'file_not_found', detail: 'f1' }], hasMediaAnchors: false });
    await expect(runQbankGeneration(request, p, null)).rejects.toMatchObject({
      appError: { error_type: 'Validation', message: '参考资料未完整准备，未生成题目: f1: f1' },
    });
  });
});

const validOutput = async () => JSON.stringify({
  schema_version: 2, mode: 'generate', questions: [question],
  coverage: [{ source_id: 'r1_s1', page: null, status: 'processed' }],
});

function taskPorts(overrides: Partial<GenerationTaskPorts> = {}): { tasks: GenerationTaskPorts; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tasks: {
      getTask: () => null,
      markRunning: () => { calls.push('markRunning'); },
      saveAuthoringResult: () => { calls.push('saveAuthoringResult'); },
      markCompleted: () => { calls.push('markCompleted'); },
      markFailed: (_id, message) => { calls.push(`markFailed:${message}`); },
      markCancelled: () => { calls.push('markCancelled'); },
      emitCurrentTask: () => { calls.push('emitCurrentTask'); },
      ...overrides,
    },
  };
}

/** `qbank_generation/mod.rs:135-218` execute_generation_task：开头 running 事件、写任务表、收尾事件。 */
describe('execute_generation_task', () => {
  it('a saved result marks the task completed and emits the closing event', async () => {
    const { tasks, calls } = taskPorts();
    await executeGenerationTask('t1', request, tasks, ports(validOutput).ports, null);
    expect(calls).toEqual(['markRunning', 'emitCurrentTask', 'saveAuthoringResult', 'markCompleted', 'emitCurrentTask']);
  });

  it('a pipeline error marks the task failed with the AppError message and emits the closing event', async () => {
    const { tasks, calls } = taskPorts();
    const { ports: p } = ports(async () => JSON.stringify({
      questions: [question, { ...question, local_id: 'q2' }],
      coverage: [{ source_id: 'r1_s1', page: null, status: 'processed' }],
    }));
    await executeGenerationTask('t1', request, tasks, p, null);
    expect(calls).toEqual(['markRunning', 'emitCurrentTask',
      'markFailed:出题数量与要求不一致（要求1，返回2），未截取或静默丢弃题目，请重新生成', 'emitCurrentTask']);
  });

  it('RF-W03-qbank-generation-save-failure-terminal-event: a failed result save still emits the closing event', async () => {
    const { tasks, calls } = taskPorts({
      saveAuthoringResult: () => { calls.push('saveAuthoringResult'); throw new Error('disk full'); },
    });
    await executeGenerationTask('t1', request, tasks, ports(validOutput).ports, null);
    expect(calls).toEqual(['markRunning', 'emitCurrentTask', 'saveAuthoringResult', 'markFailed:disk full', 'emitCurrentTask']);
  });

  it('a task already in a terminal state is not re-run', async () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const { tasks, calls } = taskPorts({ getTask: () => ({ status }) as never });
      await executeGenerationTask('t1', request, tasks, ports(validOutput).ports, null);
      expect(calls).toEqual([]);
    }
  });
});
