/**
 * `qbank_ai_generate_questions` 生产入口契约测试（host.invoke，真实 SQLite + vfsRepo；
 * LLM 以 L02 发布的 `llm` / `llmStreaming` 服务签名提供）。
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { ApiConfig, LlmQuestionAuthoring } from '../../llm/api.ts';
import qbank from '../index.ts';
import type { GenerationTaskView } from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

const config = {
  id: 'cfg_main', name: '主模型', model: 'main', apiKey: 'enc', baseUrl: 'http://x', enabled: true,
  isEmbedding: false, isReranker: false, isImageGeneration: false, isMultimodal: true,
  maxOutputTokens: 4096, maxTokensLimit: null, contextWindow: null, temperature: 0, modelAdapter: '',
  apiProtocol: null, extraBody: null, topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
} as unknown as ApiConfig;

const question = {
  local_id: 'q1', group_id: null, original_label: null, section_path: [], content: '题干', question_type: 'short_answer',
  options: null, answer: '答', answer_origin: 'missing', explanation: null, structured_data: null, difficulty: 'medium',
  tags: [], source_refs: [{ source_id: 'r1_s1', page: null }], answer_source_refs: [], figures: [],
};

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-gen-invoke-');
  const bodies: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const questionAuthoring: LlmQuestionAuthoring = {
    async runQuestionJson(_config, systemPrompt, userContent) {
      bodies.push({ systemPrompt, userContent });
      await gate;
      return { content: JSON.stringify({ questions: [question], coverage: [{ source_id: 'r1_s1', page: null, status: 'processed' }] }),
        finishReason: 'stop', usage: null, jsonMode: true } as Awaited<ReturnType<LlmQuestionAuthoring['runQuestionJson']>>;
    },
    buildDebugPersistConfig: () => null,
  };
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({
        dataDir: base,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' },
      }),
      llm: { getModel2Config: async () => config, getApiConfigs: async () => [config], decryptApiKey: async () => 'key',
        requestCancelStream: async () => undefined },
      llmQuestionAuthoring: questionAuthoring,
      // L18 / L13b 发布签名的替身（本用例只走纯文本上传）。
      docs: {
        extractTextFromBase64: async (_name: string, content: string) => Buffer.from(content, 'base64').toString('utf8'),
        extractDocxWithImages: async () => ({ text: '', images: [] }),
      },
      pageRasterizer: {
        rasterizePdfCancellable: async () => ({ pages: [], source_format: 'pdf' }),
        rasterizeImages: async () => ({ pages: [], source_format: 'image' }),
      },
      vfsRefText: { extractFileTextWithStrategy: async () => null },
    },
  });
  storage.database('vfs').run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at) VALUES ('exam_1', '出题集', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  return {
    host, bodies, release,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached');
}

describe('qbank_ai_generate_questions (host.invoke)', () => {
  it('returns a queued task immediately and completes in the background', async () => {
    const f = await fixture();
    try {
      const view = await f.host.invoke<GenerationTaskView>('qbank_ai_generate_questions', {
        request: {
          exam_id: 'exam_1', stream_session_id: 'inv1', max_questions: 1,
          reference_files_base64: [{ name: 'notes.txt', base64: Buffer.from('光合作用').toString('base64') }],
        },
      });
      expect(view.status).toBe('queued');
      f.release();
      await until(async () => (await f.host.invoke<GenerationTaskView | null>('qbank_get_generation_task',
        { taskId: view.id }))?.status === 'completed');
      const task = await f.host.invoke<GenerationTaskView>('qbank_get_generation_task', { taskId: view.id });
      expect(task.drafts.map(draft => draft.local_id)).toEqual(['q1']);
      expect(f.host.eventsNamed('qbank_generation_task_event').map(event => (event as GenerationTaskView).status))
        .toEqual(['running', 'completed']);
      // 系统提示与参考正文按 Rust 拼装进入同一请求
      const body = JSON.stringify(f.bodies[0]);
      expect(body).toContain('出题集');
      expect(body).toContain('光合作用');
      expect(body).toContain('\\"mode\\":\\"generate\\"');
    } finally {
      await f.dispose();
    }
  });

  it('cancelling a running task ends it as cancelled', async () => {
    const f = await fixture();
    try {
      const view = await f.host.invoke<GenerationTaskView>('qbank_ai_generate_questions', {
        request: { exam_id: 'exam_1', stream_session_id: 'inv2', max_questions: 1 },
      });
      await until(async () => f.bodies.length > 0);
      await f.host.invoke('qbank_cancel_generation_task', { taskId: view.id });
      f.release();
      await until(async () => f.host.eventsNamed('qbank_generation_task_event').length >= 2);
      const task = await f.host.invoke<GenerationTaskView>('qbank_get_generation_task', { taskId: view.id });
      expect(task.status).toBe('cancelled');
    } finally {
      await f.dispose();
    }
  });
});
