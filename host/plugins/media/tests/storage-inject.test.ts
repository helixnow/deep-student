/**
 * WP-279：`media` 声明 `storage` 依赖的生产入口回归。
 *
 * 这里不把 `storage` 直接放在根上下文（`provide`），而是装载 F3 真实 storage 插件，
 * 与桌面 profile 一样让它成为 media 的兄弟插件：只有 media 的 `inject` 列表包含
 * `storage` 时 `ctx.storage` 才可解析。旧代码在此组合下抛
 * `cannot get property "storage" without inject`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { audio as nativeAudio } from '../../../platform/native/audio/index.ts';
import type { StorageService } from '../../../platform/storage/api.ts';
// boundary-allow cross-plugin-impl: 验收装载 F3 真实 storage 入口，storage 只能经 inject 取得。
import storagePlugin from '../../../platform/storage/index.ts';
// boundary-allow cross-plugin-impl: storage 插件以真实 F4 secrets/paths 提供方启动，和官方 profile 一致。
import secretsPlugin from '../../../platform/secrets/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 用 L11 真实仓储驱动生产转写链路；被测对象是本 lane 的用量写入。
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 同上，字幕分段仓储的真实读写。
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
// boundary-allow cross-plugin-impl: 同上，附件内容解析的真实读取。
import { AttachmentRepo } from '../../vfs-repos/repository/attachments.ts';
// boundary-allow cross-plugin-impl: 同上，教材仓储用于构造 VfsReposService 完整依赖。
import { TextbookRepo } from '../../vfs-repos/repository/textbooks.ts';
import media from '../index.ts';
import { lectureWav } from './helpers/wav-fixture.ts';
import { startServer } from './helpers/http-fixture.ts';

interface FakeLlm {
  getModelAssignments(): Promise<{ voice_input_asr_model_config_id?: string }>;
  getApiConfigs(): Promise<unknown[]>;
}

let root: string;
let host: TestHost;
let storage: StorageService;
let currentLlm: FakeLlm | null = null;
const viaLlmHttp: string[] = [];

const LLM_PROXY: FakeLlm = {
  getModelAssignments: () => currentLlm!.getModelAssignments(),
  getApiConfigs: () => currentLlm!.getApiConfigs(),
};

function settings(): { get(): string | null; save(): void } {
  return { get: () => null, save: () => undefined };
}

function asrConfig(baseUrl: string): Record<string, unknown> {
  return {
    id: 'media-asr', vendorName: 'Relay', providerType: 'custom', apiProtocol: null,
    apiKey: 'sk-media', baseUrl: `${baseUrl}/v1`, model: 'Qwen/Qwen3-ASR-1.7B',
    enabled: true, headers: null,
  };
}

function fakeLlm(config: Record<string, unknown>): FakeLlm {
  return {
    getModelAssignments: async () => ({ voice_input_asr_model_config_id: 'media-asr' }),
    getApiConfigs: async () => [config],
  };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-storage-inject-'));
  host = await createTestHost({
    app: { dataDir: root },
    plugins: [pathsPlugin, secretsPlugin, [storagePlugin, { dataLocalDir: root }], media],
    provide: {
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: {
        resetDefaultAfterLocalPurge() { throw new Error('clean test root has no purge marker'); },
      },
      settings: settings(),
      llm: LLM_PROXY,
      llmHttp: {
        fetch: ((input, init) => { viaLlmHttp.push(String(input)); return fetch(input, init); }) as typeof fetch,
      },
      nativeAudio,
      vfsDatabase: {
        getConnSafe: () => host.ctx.storage.database('vfs'),
        blobsDir: () => path.join(root, 'vfs_blobs'),
      } as unknown as VfsDatabase,
      vfsRepo: {
        files: new FileRepo(),
        mediaTranscripts: new MediaTranscriptRepo(),
        attachments: new AttachmentRepo(),
        textbooks: new TextbookRepo(),
      } as unknown as VfsReposService,
    },
  });
  storage = host.ctx.storage;
}, 120_000);

afterAll(async () => {
  await host?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

it('media_study_ledger resolves ctx.storage via inject with non-empty resourceIds', async () => {
  const mistakes = storage.database('mistakes');
  mistakes.run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json, deleted_at)
     VALUES ('wp279_task', 'doc_1', 'ledger.pdf', 0, 'segment', 'Completed',
             '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', NULL,
             '{"source_ref":{"kind":"resource","id":"file_wp279"}}', NULL)`,
  );
  mistakes.run(
    `INSERT INTO anki_cards (id, task_id, front, back, created_at, deleted_at) VALUES
       ('wp279_card_new', 'wp279_task', 'front new', 'back new', '1', NULL),
       ('wp279_card_due', 'wp279_task', 'front due', 'back due', '2', NULL)`,
  );
  mistakes.run(
    `INSERT INTO fsrs_card_states
       (id, anki_card_id, state, due_ms, suspended, deleted_at, created_at, updated_at) VALUES
       ('wp279_fsrs_new', 'wp279_card_new', 0, 0, 0, NULL, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
       ('wp279_fsrs_due', 'wp279_card_due', 2, 0, 0, NULL, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
  );

  const ledgers = await host.invoke('media_study_ledger', {
    resourceIds: ['file_wp279', 'file_wp279_missing'], includeCardIds: true,
  }) as Array<Record<string, unknown>>;
  expect(ledgers).toHaveLength(2);
  expect(ledgers[0]).toMatchObject({
    resourceId: 'file_wp279',
    cardCount: 2,
    cardsNew: 1,
    cardsDue: 1,
    cardIds: ['wp279_card_new', 'wp279_card_due'],
    questionCount: 0,
  });
  expect(ledgers[1]).toMatchObject({ resourceId: 'file_wp279_missing', cardCount: 0 });
});

it('get_recent_document_tasks reads the mistakes database through ctx.storage', async () => {
  storage.database('mistakes').run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json, deleted_at)
     VALUES ('wp279_recent', 'doc_2', 'recent.pdf', 0, 'segment', 'Streaming',
             '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z', NULL, '{}', NULL)`,
  );
  const tasks = await host.invoke('get_recent_document_tasks', { limit: 100 }) as Array<{
    id: string; status: string;
  }>;
  expect(tasks.map(task => task.id)).toContain('wp279_recent');
  expect(tasks.find(task => task.id === 'wp279_recent')?.status).toBe('Streaming');
});

it('get_pdf_ocr_temp_dir resolves under the F3 active-slot temp data dir (commands.rs:876-880)', async () => {
  const slotTemp = (host.ctx as unknown as { fileManagerPaths: { getTempAppDataDir(): string } })
    .fileManagerPaths.getTempAppDataDir();
  expect(slotTemp).not.toBe(root);
  const dir = await host.invoke('get_pdf_ocr_temp_dir') as string;
  expect(dir).toBe(path.join(slotTemp, 'pdf_ocr_temp'));
  expect(fs.statSync(dir).isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(root, 'pdf_ocr_temp'))).toBe(false);
});

it('mediaTranscriber records media_transcription usage through ctx.storage (index.ts:872)', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: '讲到这里' }));
  });
  currentLlm = fakeLlm(asrConfig(server.url));
  viaLlmHttp.length = 0;
  const blobsDir = path.join(root, 'vfs_blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const wavPath = path.join(blobsDir, 'wp279.wav');
  lectureWav(wavPath, [[0.5, false], [2.0, true], [1.5, false], [2.0, true], [1.0, false]], 16_000);
  host.ctx.storage.database('vfs').run(
    `INSERT INTO files (id, sha256, file_name, original_path, size, mime_type, type, status,
                        created_at, updated_at)
     VALUES ('file_wp279_usage', 'sha_wp279_usage', 'wp279.wav', ?1, 1000, 'audio/wav', 'audio',
             'active', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    [wavPath],
  );
  try {
    const result = await host.ctx.mediaTranscriber.transcribe({
      fileId: 'file_wp279_usage',
      tempDir: path.join(root, 'tmp', 'media'),
      imported: false,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(result.totalSegments).toBeGreaterThan(0);
    expect(result.doneSegments).toBe(result.totalSegments);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(viaLlmHttp).toEqual(server.requests.map(request => `${server.url}${request.url}`));
    for (const url of viaLlmHttp) expect(url).toBe(`${server.url}/v1/audio/transcriptions`);
    const rows = host.ctx.storage.database('llm_usage').all<Record<string, unknown>>(
      "SELECT * FROM llm_usage_logs WHERE caller_type = 'media_transcription' ORDER BY rowid ASC");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ status: 'success' });
  } finally {
    currentLlm = null;
    await server.close();
  }
});

it('voice_input_transcribe records voice_input usage through ctx.storage (index.ts:1172)', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: '语音转写', language: 'zh' }));
  });
  currentLlm = fakeLlm(asrConfig(server.url));
  viaLlmHttp.length = 0;
  try {
    const result = await host.invoke('voice_input_transcribe', {
      request: {
        audioBase64: Buffer.from('fake-audio', 'utf8').toString('base64'),
        mimeType: 'audio/webm',
        providerId: 'siliconflow',
        model: 'Qwen/Qwen3-ASR-1.7B',
        configId: 'media-asr',
        language: 'zh',
        prompt: null,
        durationMs: 1500,
      },
    });
    expect(result).toMatchObject({ text: '语音转写', model: 'Qwen/Qwen3-ASR-1.7B' });
    expect(viaLlmHttp).toEqual([`${server.url}/v1/audio/transcriptions`]);
    const rows = host.ctx.storage.database('llm_usage').all<Record<string, unknown>>(
      "SELECT * FROM llm_usage_logs WHERE caller_type = 'voice_input' ORDER BY rowid ASC");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', model: 'Qwen/Qwen3-ASR-1.7B' });
  } finally {
    currentLlm = null;
    await server.close();
  }
});
