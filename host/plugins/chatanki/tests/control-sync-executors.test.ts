/**
 * W22 chatanki_control / chatanki_sync failure mapping on the owner seams (Rust
 * chatanki_executor.rs:6141–6759): which failures stay inline, which are the `?` path,
 * and the serde argument contract. The real-host files cover the success paths.
 */
import { expect, it } from 'vitest';
import type {
  ChatAnkiConnectSync, ChatAnkiDocumentPipeline, ToolExecutionContext,
} from '../api.ts';
import { ChatAnkiControlExecutor } from '../src/control-executor.ts';
import { parseChatAnkiControlArgs, parseChatAnkiSyncArgs } from '../src/executor-args.ts';
import { ChatAnkiSyncExecutor } from '../src/sync-executor.ts';

const APP_ERROR = { error_type: 'Database', message: 'database is locked', details: null };

function card(id: string, patch: Record<string, unknown> = {}) {
  return {
    id, task_id: 'task', front: `front ${id}`, back: 'back', text: null, tags: [], images: [],
    is_error_card: false, error_content: null, created_at: 't', updated_at: 't', extra_fields: {},
    template_id: null, ...patch,
  };
}

function harness(overrides: Partial<ToolExecutionContext> = {}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ctx = {
    sessionId: 'session', messageId: 'message', blockId: 'block',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: (error: string) => { errors.push(error); },
    saveToolBlock: () => undefined,
    warn: (message: string) => { warnings.push(message); },
    cards: { isDocumentOwnedBySession: () => true, getCardsForDocument: () => [card('c-1')] },
    documents: { getTasksForDocument: () => [] },
    llmManagerPresent: true,
    templateLookup: { getCustomTemplateById: () => null },
    ...overrides,
  } as unknown as ToolExecutionContext;
  return { ctx, errors, warnings };
}

function pipeline(overrides: Partial<ChatAnkiDocumentPipeline> = {}): ChatAnkiDocumentPipeline {
  return {
    startDocumentProcessingWithId: async () => { throw APP_ERROR; },
    cancelStreaming: async () => { throw APP_ERROR; },
    pauseDocumentProcessing: async () => undefined,
    resumeDocumentProcessing: async () => undefined,
    cancelDocumentProcessing: async () => undefined,
    buildRetryTaskForDocument: () => null,
    getTask: () => { throw APP_ERROR; },
    updateTaskStatus: () => undefined,
    ...overrides,
  };
}

function syncFacade(overrides: Partial<ChatAnkiConnectSync> = {}): ChatAnkiConnectSync {
  return {
    checkAnkiConnectAvailability: async () => true,
    createDeckIfNotExists: async () => undefined,
    templateModelName: (template) => `Deep Student / ${template.id} / v${template.version}`,
    readSyncOptions: () => ({ batchSize: 50, retryTimes: 1, mediaMode: 'upload_media' }),
    addNotesToAnkiDetailed: async () => ({ noteIds: [1], added: 1, duplicates: 0, failed: 0, createdModels: [] }),
    writeAnkiExportReceipts: () => 1,
    ...overrides,
  };
}

const control = new ChatAnkiControlExecutor(() => true);
const sync = new ChatAnkiSyncExecutor(() => true);
const controlCall = (args: unknown) => ({ id: 'call', name: 'builtin-chatanki_control', arguments: args });
const syncCall = (args: unknown) => ({ id: 'call', name: 'builtin-chatanki_sync', arguments: args });

it('W22 control/sync claim their tool only while the owner facade is published, with the Rust metadata', () => {
  let published = false;
  const gatedControl = new ChatAnkiControlExecutor(() => published);
  const gatedSync = new ChatAnkiSyncExecutor(() => published);
  for (const name of ['chatanki_control', 'builtin-chatanki_control']) expect(gatedControl.canHandle(name)).toBe(false);
  for (const name of ['chatanki_sync', 'builtin-chatanki_sync']) expect(gatedSync.canHandle(name)).toBe(false);
  published = true;
  for (const name of ['chatanki_control', 'builtin-chatanki_control']) expect(gatedControl.canHandle(name)).toBe(true);
  for (const name of ['chatanki_sync', 'builtin-chatanki_sync']) expect(gatedSync.canHandle(name)).toBe(true);
  expect(gatedControl.canHandle('builtin-chatanki_sync')).toBe(false);
  expect(gatedSync.canHandle('builtin-chatanki_control')).toBe(false);
  expect(control.sensitivityLevel('builtin-chatanki_control')).toBe('low');
  expect(sync.sensitivityLevel('builtin-chatanki_sync')).toBe('medium');
  expect(control.concurrencyClass('chatanki_control')).toBe('serial');
  expect(sync.concurrencyClass('chatanki_sync')).toBe('serial');
});

it('W22 control: run-control failures are inline `<Action> failed: <AppError Display>`; preconditions follow Rust order', async () => {
  const cases: Array<[string, Partial<ChatAnkiDocumentPipeline>, string]> = [
    ['pause', { pauseDocumentProcessing: async () => { throw APP_ERROR; } }, 'Pause failed: database is locked'],
    ['resume', { resumeDocumentProcessing: async () => { throw new Error('流式调度服务不可用'); } }, 'Resume failed: 流式调度服务不可用'],
    ['cancel', { cancelDocumentProcessing: async () => { throw APP_ERROR; } }, 'Cancel failed: database is locked'],
  ];
  for (const [action, override, error] of cases) {
    const { ctx, errors } = harness({ pipeline: pipeline(override) });
    const result = await control.execute(controlCall({ action, documentId: 'doc' }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe(error);
    expect(errors).toEqual([error]);
  }

  const missingLlm = harness({ pipeline: pipeline(), llmManagerPresent: false });
  expect((await control.execute(controlCall({ action: 'pause', documentId: 'doc' }), missingLlm.ctx)).error)
    .toBe('LLM manager not available');
  const missingPipeline = harness({ pipeline: null, llmManagerPresent: false });
  expect((await control.execute(controlCall({ action: 'pause', documentId: 'doc' }), missingPipeline.ctx)).error)
    .toBe('Anki database not available');
  const notOwned = harness({
    pipeline: pipeline(),
    cards: { isDocumentOwnedBySession: () => { throw new Error('io'); } } as never,
  });
  expect((await control.execute(controlCall({ action: 'bogus', documentId: 'doc' }), notOwned.ctx)).error)
    .toBe('blocks.ankiCards.errors.statusNotFound');
  expect(notOwned.warnings).toEqual(['[ChatAnkiToolExecutor] verify_document_ownership failed for document doc: io']);
});

it('W22 control: retry and the task reload are the `?` path (thrown AppError Display, no inline result)', async () => {
  const { ctx, errors } = harness({ pipeline: pipeline() });
  await expect(control.execute(controlCall({ action: 'retry', documentId: 'doc', taskId: 't' }), ctx))
    .rejects.toThrow('database is locked');
  const noRetry = harness({ pipeline: pipeline({ buildRetryTaskForDocument: () => { throw APP_ERROR; } }) });
  await expect(control.execute(controlCall({ action: 'retry', documentId: 'doc' }), noRetry.ctx))
    .rejects.toThrow('database is locked');
  const reload = harness({
    pipeline: pipeline(), documents: { getTasksForDocument: () => { throw APP_ERROR; } } as never,
  });
  await expect(control.execute(controlCall({ action: 'pause', documentId: 'doc' }), reload.ctx))
    .rejects.toThrow('database is locked');
  expect(errors).toEqual([]);
});

it('W22 sync: owner failures map to the Rust inline texts, receipts are best-effort and template reads are the `?` path', async () => {
  const noFacade = harness({ ankiConnectSync: null });
  expect((await sync.execute(syncCall({ documentId: 'doc' }), noFacade.ctx)).error)
    .toBe('AnkiConnect sync service unavailable');
  const noDb = harness({ cards: null, ankiConnectSync: syncFacade() });
  expect((await sync.execute(syncCall({ documentId: 'doc' }), noDb.ctx)).error).toBe('Anki database not available');
  const noTemplates = harness({ templateLookup: null, ankiConnectSync: syncFacade() });
  expect((await sync.execute(syncCall({ documentId: 'doc' }), noTemplates.ctx)).error).toBe('Anki database not available');
  const unreadable = harness({
    cards: { isDocumentOwnedBySession: () => true, getCardsForDocument: () => { throw APP_ERROR; } } as never,
    ankiConnectSync: syncFacade(),
  });
  expect((await sync.execute(syncCall({ documentId: 'doc' }), unreadable.ctx)).error)
    .toBe('Failed to load cards for document: database is locked');

  const rejected = harness({
    ankiConnectSync: syncFacade({ addNotesToAnkiDetailed: async () => { throw new Error('无法核对 Anki 模型，发送尚未开始: x'); } }),
  });
  const pushFailed = await sync.execute(syncCall({ documentId: 'doc', noteType: 'Basic' }), rejected.ctx);
  expect(pushFailed.output).toBeNull();
  expect(pushFailed.error).toBe('无法核对 Anki 模型，发送尚未开始: x');

  const receiptFails = harness({
    ankiConnectSync: syncFacade({ writeAnkiExportReceipts: () => { throw APP_ERROR; } }),
  });
  const synced = await sync.execute(syncCall({ documentId: 'doc', noteType: 'Basic' }), receiptFails.ctx);
  expect(synced.success).toBe(true);
  expect(synced.output).toMatchObject({ status: 'ok', added: 1, receiptWritten: 0 });
  expect(receiptFails.warnings).toEqual(['[ChatAnkiToolExecutor] export receipt writeback failed: database is locked']);

  let deckCalls = 0;
  const templateRead = harness({
    cards: {
      isDocumentOwnedBySession: () => true, getCardsForDocument: () => [card('c-1', { template_id: 'tpl' })],
    } as never,
    templateLookup: { getCustomTemplateById: () => { throw APP_ERROR; } },
    ankiConnectSync: syncFacade({ createDeckIfNotExists: async () => { deckCalls += 1; throw new Error('deck'); } }),
  });
  await expect(sync.execute(syncCall({ documentId: 'doc' }), templateRead.ctx))
    .rejects.toThrow('读取模板失败: database is locked');
  expect(deckCalls).toBe(1);
  expect(templateRead.errors).toEqual([]);
});

it('W22 control/sync arguments decode like serde_json::from_value of the Rust structs', () => {
  expect(parseChatAnkiControlArgs({ action: 'pause', documentId: 'd', extra: 1 }))
    .toEqual({ action: 'pause', documentId: 'd', taskId: null });
  expect(parseChatAnkiControlArgs(['retry', 'd', 't'])).toEqual({ action: 'retry', documentId: 'd', taskId: 't' });
  expect(() => parseChatAnkiControlArgs({ action: 'pause', document_id: 'd' })).toThrow('missing field `documentId`');
  expect(() => parseChatAnkiControlArgs(null)).toThrow('invalid type: null, expected struct ChatAnkiControlArgs');

  expect(parseChatAnkiSyncArgs({ documentId: 'd', templateIds: ['b', 'a'], templateMode: 'all' })).toEqual({
    documentId: 'd', deckName: null, noteType: null, templateId: null, templateIds: ['b', 'a'],
  });
  expect(parseChatAnkiSyncArgs({ documentId: 'd', templateMode: { multiple: null } }).documentId).toBe('d');
  expect(parseChatAnkiSyncArgs(['d', 'Deck', null, null, null, null]).deckName).toBe('Deck');
  expect(() => parseChatAnkiSyncArgs({ documentId: 'd', templateMode: {} }))
    .toThrow('invalid value: map, expected map with a single key');
  expect(() => parseChatAnkiSyncArgs({ documentId: 'd', templateMode: 3 }))
    .toThrow('invalid type: number, expected string or map');
  expect(() => parseChatAnkiSyncArgs({ documentId: 'd', templateMode: 'Single' }))
    .toThrow('unknown variant `Single`, expected one of `single`, `multiple`, `all`');
  expect(() => parseChatAnkiSyncArgs({ documentId: 'd', templateIds: [1] }))
    .toThrow('invalid type: number, expected a string');
});
