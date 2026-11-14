/**
 * `anki.pipeline` 与同步门面（L24 `chatanki_control` / `chatanki_sync` 的 L16 owner 面）。
 *
 * 全部经真实插件装载后的 `ctx.anki`：真实迁移库、真实 F4 settings、真实 L15 review；
 * AnkiConnect 只替换网络边界（端口探测与 fetch），不替换被测的同步实现。
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import type { AnkiService } from '../api.ts';
import { documentRunRegistry } from '../src/enhanced-service.ts';
import { RETRY_ASSIGNMENT_MARK } from '../src/streaming-anki-protocol.ts';
import { registerCancellation } from '../src/streaming-anki-cancel.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const NOW = '2026-11-07T00:00:00+00:00';

function insertTask(
  db: DatabaseHandle,
  id: string,
  documentId: string,
  segmentIndex: number,
  status: string,
  contentSegment = `segment-${segmentIndex}`,
): void {
  db.run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json)
     VALUES (?1, ?2, 'doc.md', ?3, ?4, ?5, ?6, ?6, NULL, '{"deck_name":"D"}')`,
    [id, documentId, segmentIndex, contentSegment, status, NOW],
  );
}

function insertCard(
  db: DatabaseHandle,
  id: string,
  taskId: string,
  error: { content: string } | null = null,
): void {
  db.run(
    `INSERT INTO anki_cards
       (id, task_id, front, back, text, tags_json, images_json,
        is_error_card, error_content, card_order_in_task, created_at, updated_at,
        extra_fields_json, template_id)
     VALUES (?1, ?2, ?3, 'back', NULL, '[]', '[]', ?4, ?5, 0, ?6, ?6, '{}', NULL)`,
    [id, taskId, `front-${id}`, error === null ? 0 : 1, error?.content ?? null, NOW],
  );
}

function statuses(db: DatabaseHandle, documentId: string): Record<string, string> {
  const rows = db.all<{ id: string; status: string }>(
    'SELECT id, status FROM document_tasks WHERE document_id = ?1 ORDER BY segment_index',
    [documentId],
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

function generationEvents(env: AnkiTestEnv): Array<Record<string, unknown>> {
  return env.host.eventsNamed('anki_generation_event') as Array<Record<string, unknown>>;
}

function statusUpdates(events: Array<Record<string, unknown>>): Array<[unknown, unknown]> {
  return events
    .map((event) => event['TaskStatusUpdate'] as Record<string, unknown> | undefined)
    .filter((update): update is Record<string, unknown> => update !== undefined)
    .map((update) => [update['task_id'], update['status']]);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function resetTables(db: DatabaseHandle): void {
  db.run('DELETE FROM fsrs_review_logs');
  db.run('DELETE FROM fsrs_card_states');
  db.run('DELETE FROM anki_cards');
  db.run('DELETE FROM document_tasks');
  db.run('DELETE FROM settings');
}

describe('anki.pipeline (chatanki_control owner seam)', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;
  let anki: AnkiService;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
    anki = env.host.ctx.anki;
  }, 120_000);
  afterAll(async () => { await env.dispose(); });
  beforeEach(() => {
    resetTables(db);
    env.host.events.length = 0;
  });
  afterEach(() => { documentRunRegistry.clear(); });

  it('pause stops running tasks only and emits the Rust event sequence on the backend bus', async () => {
    insertTask(db, 'p-0', 'doc-p', 0, 'Processing');
    insertTask(db, 'p-1', 'doc-p', 1, 'Streaming');
    insertTask(db, 'p-2', 'doc-p', 2, 'Pending');
    insertTask(db, 'p-3', 'doc-p', 3, 'Completed');

    await anki.pipeline.pauseDocumentProcessing('doc-p');

    expect(statuses(db, 'doc-p')).toEqual({ 'p-0': 'Paused', 'p-1': 'Paused', 'p-2': 'Pending', 'p-3': 'Completed' });
    const events = generationEvents(env);
    expect(statusUpdates(events)).toEqual([['p-0', 'Paused'], ['p-1', 'Paused']]);
    expect(events.at(-1)).toEqual({ DocumentProcessingPaused: { document_id: 'doc-p' } });
    expect(documentRunRegistry.get('doc-p')).toMatchObject({ paused: true, running: false, epoch: 1 });
  });

  it('cancel keeps generated cards and marks every unfinished task Cancelled', async () => {
    insertTask(db, 'c-0', 'doc-c', 0, 'Pending');
    insertTask(db, 'c-1', 'doc-c', 1, 'Processing');
    insertTask(db, 'c-2', 'doc-c', 2, 'Paused');
    insertTask(db, 'c-3', 'doc-c', 3, 'Completed');
    insertCard(db, 'card-c3', 'c-3');
    documentRunRegistry.entry('doc-c').running = true;

    await anki.pipeline.cancelDocumentProcessing('doc-c');

    expect(statuses(db, 'doc-c')).toEqual({ 'c-0': 'Cancelled', 'c-1': 'Cancelled', 'c-2': 'Cancelled', 'c-3': 'Completed' });
    expect(db.pluck('SELECT COUNT(*) FROM anki_cards WHERE id = ?1 AND deleted_at IS NULL', ['card-c3'])).toBe(1);
    const events = generationEvents(env);
    expect(statusUpdates(events)).toEqual([['c-0', 'Cancelled'], ['c-1', 'Cancelled'], ['c-2', 'Cancelled']]);
    expect(events.at(-1)).toEqual({ DocumentProcessingCancelled: { document_id: 'doc-c' } });
    expect(documentRunRegistry.get('doc-c')).toBeUndefined();
  });

  it('an explicit event sink receives the events instead of the backend bus', async () => {
    insertTask(db, 's-0', 'doc-s', 0, 'Processing');
    const seen: Array<[string, unknown]> = [];

    await anki.pipeline.pauseDocumentProcessing('doc-s', { emit: (event, payload) => seen.push([event, payload]) });

    expect(seen.map(([event]) => event)).toEqual(['anki_generation_event', 'anki_generation_event']);
    expect(seen[1]![1]).toEqual({ DocumentProcessingPaused: { document_id: 'doc-s' } });
    expect(generationEvents(env)).toEqual([]);
  });

  it('resume with nothing left completes the document; a running document is only unpaused', async () => {
    insertTask(db, 'r-0', 'doc-r', 0, 'Completed');

    await anki.pipeline.resumeDocumentProcessing('doc-r');

    expect(generationEvents(env)).toEqual([{ DocumentProcessingCompleted: { document_id: 'doc-r' } }]);
    expect(documentRunRegistry.get('doc-r')).toBeUndefined();

    env.host.events.length = 0;
    const running = documentRunRegistry.entry('doc-running');
    running.running = true;
    running.paused = true;
    await anki.pipeline.resumeDocumentProcessing('doc-running');
    expect(documentRunRegistry.get('doc-running')).toMatchObject({ paused: false, running: true, epoch: 0 });
    expect(generationEvents(env)).toEqual([]);
  });

  it('resume rejects instead of pretending to reschedule when L02 generation is unavailable', async () => {
    insertTask(db, 'n-0', 'doc-n', 0, 'Paused');

    await expect(anki.pipeline.resumeDocumentProcessing('doc-n'))
      .rejects.toThrow('流式调度服务不可用：resume_document_processing 无法继续生成');

    expect(statuses(db, 'doc-n')).toEqual({ 'n-0': 'Paused' });
    expect(documentRunRegistry.get('doc-n')).toMatchObject({ running: false, paused: false });
  });

  it('buildRetryTaskForDocument inserts one aggregated repair task and marks only repairable error cards', () => {
    insertTask(db, 'e-0', 'doc-e', 0, 'Completed');
    insertTask(db, 'e-1', 'doc-e', 4, 'Failed');
    insertCard(db, 'ok-1', 'e-0');
    insertCard(db, 'err-1', 'e-0', { content: 'truncated {"front":"photosynthesis' });
    insertCard(db, 'err-junk', 'e-1', { content: '<|im_end|>' });
    insertCard(db, 'err-done', 'e-1', { content: `${RETRY_ASSIGNMENT_MARK}\nalready assigned` });

    const retry = anki.pipeline.buildRetryTaskForDocument('doc-e');

    expect(retry).toMatchObject({
      document_id: 'doc-e',
      original_document_name: 'doc.md - 错误卡修复',
      segment_index: 5,
      status: 'Pending',
      error_message: null,
      anki_generation_options_json: '{"deck_name":"D"}',
    });
    expect(retry!.content_segment).toContain('==FIX 1 | 源任务ID:e-0 | 错误卡ID:err-1 ==\ntruncated {"front":"photosynthesis');
    expect(retry!.content_segment).not.toContain('err-junk');
    expect(retry!.content_segment).not.toContain('err-done');
    expect(anki.pipeline.getTask(retry!.id)).toEqual(retry);
    expect(db.pluck('SELECT error_content FROM anki_cards WHERE id = ?1', ['err-1']))
      .toBe(`${RETRY_ASSIGNMENT_MARK}\ntruncated {"front":"photosynthesis`);
    expect(db.pluck('SELECT error_content FROM anki_cards WHERE id = ?1', ['err-junk'])).toBe('<|im_end|>');

    // A pending repair task already exists, and the remaining error cards are assigned or junk.
    expect(anki.pipeline.buildRetryTaskForDocument('doc-e')).toBeNull();
    expect(db.pluck('SELECT COUNT(*) FROM document_tasks WHERE document_id = ?1', ['doc-e'])).toBe(3);
    expect(anki.pipeline.buildRetryTaskForDocument('doc-missing')).toBeNull();
  });

  it('startDocumentProcessingWithId rejects before writing a task when L02 generation is unavailable', async () => {
    await expect(anki.pipeline.startDocumentProcessingWithId({ document_content: '光合作用' }, 'doc-none'))
      .rejects.toEqual({ error_type: 'Configuration', message: 'Anki 生成服务不可用：L02 未提供 llm / llmStreaming 服务', details: null });

    expect(db.pluck('SELECT COUNT(*) FROM document_tasks')).toBe(0);
    expect(generationEvents(env)).toEqual([]);
    expect(documentRunRegistry.get('doc-none')).toBeUndefined();
  });

  it('cancelStreaming aborts a streaming task once and rejects for a task that is not streaming', async () => {
    const signal = registerCancellation('stream-1');

    await anki.pipeline.cancelStreaming('stream-1');

    expect(signal.aborted).toBe(true);
    await expect(anki.pipeline.cancelStreaming('stream-1')).rejects.toThrow('任务 stream-1 未在运行状态');
  });

  it('getTask / updateTaskStatus keep the DocumentProcessingService errors', () => {
    insertTask(db, 't-0', 'doc-t', 0, 'Failed');

    anki.pipeline.updateTaskStatus('t-0', 'Pending', null);
    expect(anki.pipeline.getTask('t-0')).toMatchObject({ id: 't-0', document_id: 'doc-t', status: 'Pending', error_message: null });
    anki.pipeline.updateTaskStatus('t-0', 'Failed', 'boom');
    expect(anki.pipeline.getTask('t-0')).toMatchObject({ status: 'Failed', error_message: 'boom' });

    expect(thrown(() => anki.pipeline.getTask('t-missing'))).toMatchObject({
      error_type: 'Database', message: expect.stringMatching(/^获取任务失败: /),
    });
    expect(thrown(() => anki.pipeline.updateTaskStatus('t-missing', 'Pending', null))).toEqual({
      error_type: 'Database',
      message: '更新任务状态失败: document_task_not_found_or_deleted: t-missing',
      details: null,
    });
  });
});

describe('anki.pipeline resume through the real stream scheduler', () => {
  it('reschedules paused tasks with the production generation deps and completes the document', async () => {
    const env = await createAnkiTestEnv({
      provide: {
        // Model assignment left unset: the real generator fails its config step per task.
        llm: {
          getModelAssignments: async () => ({ anki_card_model_config_id: null }),
          getApiConfigs: async () => [],
        },
        llmStreaming: {},
      },
    });
    try {
      const db = env.storage.database('mistakes');
      insertTask(db, 'g-0', 'doc-g', 0, 'Paused');
      insertTask(db, 'g-1', 'doc-g', 1, 'Completed');

      await env.host.ctx.anki.pipeline.resumeDocumentProcessing('doc-g');
      await vi.waitFor(() => {
        expect(generationEvents(env).at(-1)).toEqual({ DocumentProcessingCompleted: { document_id: 'doc-g' } });
      });

      expect(statuses(db, 'doc-g')).toEqual({ 'g-0': 'Failed', 'g-1': 'Completed' });
      expect(statusUpdates(generationEvents(env))).toEqual([['g-0', 'Processing'], ['g-0', 'Failed']]);
      expect(generationEvents(env)).toContainEqual({
        TaskProcessingError: {
          task_id: 'g-0',
          error_message: 'Anki制卡模型在模型分配中未配置 (anki_card_model_config_id is None)',
          document_id: 'doc-g',
        },
      });
      expect(documentRunRegistry.get('doc-g')).toBeUndefined();
    } finally {
      documentRunRegistry.clear();
      await env.dispose();
    }
  }, 60_000);

  it('startDocumentProcessingWithId writes tasks under the pre-allocated id and runs them with events on the given sink', async () => {
    const env = await createAnkiTestEnv({
      provide: {
        llm: {
          getModelAssignments: async () => ({ anki_card_model_config_id: null }),
          getApiConfigs: async () => [],
        },
        llmStreaming: {},
      },
    });
    try {
      const db = env.storage.database('mistakes');
      const seen: Array<[string, Record<string, unknown>]> = [];
      const sink = { emit: (event: string, payload: unknown) => { seen.push([event, payload as Record<string, unknown>]); } };
      const payloads = () => seen.map(([, payload]) => payload);

      await expect(env.host.ctx.anki.pipeline.startDocumentProcessingWithId({ document_content: '  \n' }, 'doc-blank', sink))
        .rejects.toEqual({ error_type: 'Validation', message: '文档内容不能为空', details: null });
      expect(db.pluck('SELECT COUNT(*) FROM document_tasks')).toBe(0);

      const id = await env.host.ctx.anki.pipeline.startDocumentProcessingWithId({
        document_content: '光合作用把光能转化为化学能。叶绿体是光合作用的场所。',
        original_document_name: '  生物  ',
        options: null,
      }, 'doc-pre', sink);

      expect(id).toBe('doc-pre');
      const tasks = db.all<{ id: string; document_id: string; original_document_name: string; status: string }>(
        'SELECT id, document_id, original_document_name, status FROM document_tasks ORDER BY segment_index',
      );
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((task) => task.document_id === 'doc-pre' && task.original_document_name === '生物')).toBe(true);
      expect(seen[0]).toEqual(['anki_generation_event', { DocumentProcessingStarted: { document_id: 'doc-pre', total_segments: tasks.length } }]);
      await vi.waitFor(() => {
        expect(payloads().at(-1)).toEqual({ DocumentProcessingCompleted: { document_id: 'doc-pre' } });
      });

      // Model assignment left unset: the real generator fails each task's config step.
      expect(statuses(db, 'doc-pre')).toEqual(Object.fromEntries(tasks.map((task) => [task.id, 'Failed'])));
      expect(statusUpdates(payloads())).toEqual(tasks.flatMap((task) => [[task.id, 'Processing'], [task.id, 'Failed']]));
      expect(seen.every(([event]) => event === 'anki_generation_event')).toBe(true);
      expect(generationEvents(env)).toEqual([]);
      expect(documentRunRegistry.get('doc-pre')).toBeUndefined();
    } finally {
      documentRunRegistry.clear();
      await env.dispose();
    }
  }, 60_000);
});

function portProbe(): void {
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => socket;
    setImmediate(() => socket.emit('connect'));
    return socket;
  }) as typeof net.connect);
}

function ankiConnectServer(result: (action: string, params: unknown) => { result: unknown; error: string | null }): string[] {
  const actions: string[] = [];
  portProbe();
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('');
    const request = JSON.parse(String(init.body)) as { action: string; params?: unknown };
    actions.push(request.action);
    return new Response(JSON.stringify(result(request.action, request.params)));
  });
  return actions;
}

function syncCard(id: string, overrides: Partial<AnkiCard> = {}): AnkiCard {
  return {
    id, task_id: 'sync-task', front: `Q ${id}`, back: `A ${id}`, text: null,
    tags: [], images: [], is_error_card: false, error_content: null,
    created_at: NOW, updated_at: NOW, extra_fields: {}, template_id: null,
    ...overrides,
  };
}

describe('anki sync facade (chatanki_sync owner seam)', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;
  let anki: AnkiService;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
    anki = env.host.ctx.anki;
  }, 120_000);
  afterAll(async () => { await env.dispose(); });
  beforeEach(() => { resetTables(db); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('templateModelName is the id + version model identity', () => {
    const template = { id: 'tpl-a', version: '1.2.0' } as Pick<CustomAnkiTemplate, 'id' | 'version'>;
    expect(anki.templateModelName(template)).toBe('Deep Student / tpl-a / v1.2.0');
  });

  it('syncOptionsFromSettings applies the Rust from_setting_strings defaults and caps', () => {
    expect(anki.syncOptionsFromSettings(null, null, null))
      .toEqual({ batchSize: 50, retryTimes: 1, mediaMode: 'upload_media' });
    expect(anki.syncOptionsFromSettings(' 900 ', '3', 'SKIP'))
      .toEqual({ batchSize: 500, retryTimes: 3, mediaMode: 'skip' });
    expect(anki.syncOptionsFromSettings('0', '-1', 'inline'))
      .toEqual({ batchSize: 50, retryTimes: 1, mediaMode: 'inline_base64' });
  });

  it('readSyncOptions reads the mistakes-DB settings and treats unreadable keys as unset', () => {
    expect(anki.readSyncOptions()).toEqual({ batchSize: 50, retryTimes: 1, mediaMode: 'upload_media' });

    const settings = env.host.ctx.get('settings') as SettingsWithConn;
    settings.saveWithConn(db, 'anki_connect_batch_size', '20');
    settings.saveWithConn(db, 'anki_connect_retry_times', '4');
    settings.saveWithConn(db, 'anki_connect_media_mode', 'inline-base64');
    expect(anki.readSyncOptions()).toEqual({ batchSize: 20, retryTimes: 4, mediaMode: 'inline_base64' });

    const read = settings.getWithConn.bind(settings);
    vi.spyOn(settings, 'getWithConn').mockImplementation((conn, key) => {
      if (key === 'anki_connect_retry_times') throw new Error('settings read failed');
      return read(conn, key);
    });
    expect(anki.readSyncOptions()).toEqual({ batchSize: 20, retryTimes: 1, mediaMode: 'inline_base64' });
  });

  it('writeAnkiExportReceipts writes live rows pairwise and skips null note ids, blank ids and tombstones', () => {
    insertTask(db, 'sync-task', 'doc-sync', 0, 'Completed');
    insertTask(db, 'dead-task', 'doc-sync', 1, 'Completed');
    for (const id of ['w-1', 'w-2', 'w-3', 'w-4']) insertCard(db, id, 'sync-task');
    insertCard(db, 'w-dead-task', 'dead-task');
    db.run('UPDATE anki_cards SET deleted_at = ?1 WHERE id = ?2', [NOW, 'w-4']);
    db.run('UPDATE document_tasks SET deleted_at = ?1 WHERE id = ?2', [NOW, 'dead-task']);

    const written = anki.writeAnkiExportReceipts(
      [' w-1 ', 'w-2', '  ', 'w-4', 'w-dead-task', 'w-3'],
      [101, null, 103, 104, 105],
      '2026-11-07T01:02:03+00:00',
    );

    expect(written).toBe(1);
    const rows = db.all<{ id: string; anki_note_id: number | null; export_status: string | null; last_exported_at: string | null }>(
      'SELECT id, anki_note_id, export_status, last_exported_at FROM anki_cards ORDER BY id',
    );
    const untouched = { anki_note_id: null, export_status: null, last_exported_at: null };
    expect(rows).toEqual([
      { id: 'w-1', anki_note_id: 101, export_status: 'synced', last_exported_at: '2026-11-07T01:02:03+00:00' },
      { id: 'w-2', ...untouched },
      { id: 'w-3', ...untouched },
      { id: 'w-4', ...untouched },
      { id: 'w-dead-task', ...untouched },
    ]);
    expect(anki.writeAnkiExportReceipts([], [1], NOW)).toBe(0);
    expect(anki.writeAnkiExportReceipts(['w-3'], [], NOW)).toBe(0);
  });

  it('addNotesToAnkiDetailed syncs through the production client with the service logger', async () => {
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    const actions = ankiConnectServer((action) => {
      if (action === 'version') return { result: 6, error: null };
      if (action === 'modelFieldNames') return { result: ['Front', 'Back'], error: null };
      if (action === 'canAddNotes') return { result: null, error: 'unsupported' };
      if (action === 'addNote') return { result: 7001, error: null };
      return { result: null, error: null };
    });

    const report = await anki.addNotesToAnkiDetailed({
      cards: [syncCard('s-1')],
      deckName: 'Default',
      noteType: 'Basic',
      cardModels: new Map(),
      templatesByModel: new Map(),
      options: anki.syncOptionsFromSettings(null, '0', null),
    });

    expect(report).toMatchObject({ noteIds: [7001], added: 1, duplicates: 0, failed: 0, createdModels: [] });
    expect(report.warnings).toEqual(['canAddNotes 预检不可用，已降级为逐条 addNote: AnkiConnect错误(canAddNotes): unsupported']);
    expect(actions).toEqual(['version', 'modelFieldNames', 'canAddNotes', 'addNote']);
    expect(warn).toHaveBeenCalledWith('⚠️ canAddNotes 预检不可用，降级为逐条 addNote: AnkiConnect错误(canAddNotes): unsupported');
  });

  it('addNotesToAnkiDetailed rejects with the availability error text before sending notes', async () => {
    const actions = ankiConnectServer(() => ({ result: 5, error: null }));

    await expect(anki.addNotesToAnkiDetailed({
      cards: [syncCard('s-2')],
      deckName: 'Default',
      noteType: 'Basic',
      cardModels: new Map(),
      templatesByModel: new Map(),
      options: anki.syncOptionsFromSettings(null, null, null),
    })).rejects.toThrow('AnkiConnect 插件版本过旧（API v5，需要 ≥ v6）。请在 Anki 中更新 AnkiConnect 插件（代码：2055492159）后重试');
    expect(actions).toEqual(['version']);
  });
});
