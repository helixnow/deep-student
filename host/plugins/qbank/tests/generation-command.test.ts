/**
 * `qbank_generation/mod.rs::qbank_ai_generate_questions` 命令层（真实 SQLite + 真实 vfsRepo）：
 * serde 默认值 → create_task → 后台执行 → 任务表终态 + `qbank_generation_task_event`。
 *
 * 命令在 collect_references 接线（L18/L13b）后注册；届时本文件改为 host.invoke 入口。
 * 任务读取已走已注册的 `qbank_get_generation_task` 命令。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { ApiConfig, LLMManager, LlmQuestionAuthoring } from '../../llm/api.ts';
import qbank from '../index.ts';
import type { GenerationTaskView, QbankGenerationRequest } from '../api.ts';
import { GenerationSessions } from '../src/generation-session.ts';
import { cropImageCodecOf } from '../src/native-image.ts';
import {
  QBANK_GENERATION_TASK_EVENT, decodeGenerationRequest, submitGenerationTask, type GenerationCommandHost,
} from '../src/generation-command.ts';
import { getTask } from '../repository/generation-tasks.ts';

const NOW = '2026-01-01T00:00:00+00:00';

const config = {
  id: 'cfg_main', name: '主模型', model: 'main', apiKey: 'enc', baseUrl: 'http://x', enabled: true,
  isEmbedding: false, isReranker: false, isImageGeneration: false, isMultimodal: true,
  maxOutputTokens: 4096, maxTokensLimit: null, contextWindow: null, temperature: 0, modelAdapter: '',
  apiProtocol: null, extraBody: null, topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
} as unknown as ApiConfig;

function question(localId: string) {
  return {
    local_id: localId, group_id: null, original_label: null, section_path: [], content: `题干${localId}`,
    question_type: 'short_answer', options: null, answer: '参考答案', answer_origin: 'missing', explanation: null,
    structured_data: null, difficulty: 'medium', tags: [], source_refs: [{ source_id: 'r1_s1', page: null }],
    answer_source_refs: [], figures: [],
  };
}

async function fixture(modelOutput: string) {
  const { storage, base } = await createMigratedStorage('qbank-gen-cmd-');
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({
        dataDir: base,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' },
      }),
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_1', '出题集', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  const repos = host.ctx.vfsRepo as VfsReposService;
  const bodies: unknown[] = [];
  const llm = {
    getModel2Config: async () => config,
    getApiConfigs: async () => [config],
    decryptApiKey: async () => 'key',
  } as unknown as LLMManager;
  const questionAuthoring: LlmQuestionAuthoring = {
    async runQuestionJson(_config, systemPrompt, userContent) {
      bodies.push({ systemPrompt, userContent });
      return { content: modelOutput, finishReason: 'stop', usage: null, jsonMode: true } as
        Awaited<ReturnType<LlmQuestionAuthoring['runQuestionJson']>>;
    },
    buildDebugPersistConfig: () => null,
  };
  const spawned: Promise<void>[] = [];
  const log = host.ctx.logger('qbank');
  const commandHost: GenerationCommandHost = {
    db, blobsDir: path.join(storage.locations.activeDir, 'vfs_blobs'), repos, llm, questionAuthoring, ocr: undefined,
    nativeImage: cropImageCodecOf(host.ctx),
    ports: { exams: repos.exams, questions: repos.questions, log },
    generationSessions: new GenerationSessions(),
    log: log as GenerationCommandHost['log'],
    collectReferences: async () => ({
      bundle: { sources: [{ source_id: 'r1_s1', name: 'notes.txt', format: 'txt', page_count: null }],
        pages: [], text: '\n\n===== 参考文件 r1：notes.txt =====\n光合作用', format: 'txt' },
      skipped: [], hasMediaAnchors: false,
    }),
    emit: (event, payload) => host.ctx.backendEvents.emit(event, payload),
    spawn: (task) => {
      const promise = task();
      spawned.push(promise);
      return promise;
    },
  };
  return {
    host, db, commandHost, spawned, bodies,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

const coverage = [{ source_id: 'r1_s1', page: null, status: 'processed' }];

describe('qbank_ai_generate_questions command layer', () => {
  it('serde defaults are applied in Rust field order', () => {
    const decoded = decodeGenerationRequest({ exam_id: 'e', stream_session_id: 's', specs: [{ question_type: 'essay' }] } as QbankGenerationRequest);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify({
      exam_id: 'e', stream_session_id: 's', model_config_id: null, max_questions: 10,
      specs: [{ question_type: 'essay', count: 1, difficulty: null }], difficulty: null, topic_hint: null,
      based_on_existing: false, language: null, reference_file_ids: [], reference_files_base64: [], knowledge_points: [],
    }));
  });

  it('returns a queued task, then completes in background with a saved draft and task events', async () => {
    const f = await fixture(JSON.stringify({ schema_version: 2, mode: 'generate', questions: [question('q1'), question('q2')], coverage }));
    try {
      const view = await submitGenerationTask(f.commandHost, { exam_id: 'exam_1', stream_session_id: 'sess1', max_questions: 2 });
      expect(view.status).toBe('queued');
      expect(view.id).toMatch(/^task_[A-Za-z0-9_-]{10}$/);
      const stored = getTask(f.db, view.id)!;
      expect(stored.stream_event).toBe('qbank_generation_stream_sess1');
      expect(JSON.parse(stored.request_json)).toMatchObject({ max_questions: 2, specs: [], knowledge_points: [] });
      await Promise.all(f.spawned);

      const task = await f.host.invoke<GenerationTaskView | null>('qbank_get_generation_task', { taskId: view.id });
      expect(task?.status).toBe('completed');
      expect(task?.drafts.map(draft => draft.local_id)).toEqual(['q1', 'q2']);
      expect(task?.usedReferenceCount).toBe(1);
      const result = getTask(f.db, view.id)!.authoring_result as { job_id: string; document: { mode: string } };
      expect(result.document.mode).toBe('generate');
      const drafts = await f.host.invoke<{ job_id: string }[]>('qbank_list_authoring_drafts', { examId: 'exam_1' });
      expect(drafts.map(draft => draft.job_id)).toContain(result.job_id);

      const statuses = f.host.eventsNamed(QBANK_GENERATION_TASK_EVENT).map(event => (event as GenerationTaskView).status);
      expect(statuses).toEqual(['running', 'completed']);
    } finally {
      await f.dispose();
    }
  });

  it('a count mismatch marks the task failed with the Rust message', async () => {
    const f = await fixture(JSON.stringify({ questions: [question('q1')], coverage }));
    try {
      const view = await submitGenerationTask(f.commandHost, { exam_id: 'exam_1', stream_session_id: 'sess2', max_questions: 3 });
      await Promise.all(f.spawned);
      const task = getTask(f.db, view.id)!;
      expect(task.status).toBe('failed');
      expect(task.error).toBe('出题数量与要求不一致（要求3，返回1），未截取或静默丢弃题目，请重新生成');
      const statuses = f.host.eventsNamed(QBANK_GENERATION_TASK_EVENT).map(event => (event as GenerationTaskView).status);
      expect(statuses).toEqual(['running', 'failed']);
    } finally {
      await f.dispose();
    }
  });

  it('model configuration errors are returned before a task is created', async () => {
    const f = await fixture('{}');
    try {
      (f.commandHost.llm as unknown as { getModel2Config: () => Promise<ApiConfig> }).getModel2Config =
        async () => ({ ...config, enabled: false }) as ApiConfig;
      await expect(submitGenerationTask(f.commandHost, { exam_id: 'exam_1', stream_session_id: 's3' }))
        .rejects.toMatchObject({ appError: { error_type: 'Configuration', message: '解析模型必须是已启用的对话模型' } });
      expect(f.db.all('SELECT id FROM qbank_generation_tasks')).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});
