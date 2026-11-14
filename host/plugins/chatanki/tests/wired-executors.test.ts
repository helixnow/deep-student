import { expect, it } from 'vitest';
import type {
  AnkiCard, ChatAnkiApkgImportResult, ChatAnkiChatBlock, ChatAnkiSessionResourceLookup,
  ContextRef, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';
import { ChatAnkiApkgExecutor } from '../src/apkg-executor.ts';
import { ChatAnkiGetCardsExecutor } from '../src/get-cards-executor.ts';
import { ChatAnkiStatusExecutor } from '../src/status-executor.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';
import { ApkgVfsDouble } from './apkg-vfs-double.ts';

const SESSION = 'session-wired';

function makeCard(id: string, taskId: string): AnkiCard {
  return {
    id, front: 'front', back: 'back', text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {}, template_id: null,
  };
}

function context(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    sessionId: SESSION, messageId: 'msg-wired', blockId: 'block-wired',
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
}

function outputOf(result: ToolResultInfo): Record<string, unknown> {
  expect(result.success).toBe(true);
  return result.output as Record<string, unknown>;
}

it('get_cards reads the owned snapshot and attaches L15 review states', async () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-get', SESSION);
  const card = makeCard('card-get', taskId);
  repo.insertCard(card, 'doc-get');
  repo.enqueueReview('card-get', SESSION);

  const result = await new ChatAnkiGetCardsExecutor().execute(
    { id: 'call-get', name: 'builtin-chatanki_get_cards', arguments: { documentId: 'doc-get' } },
    context({ cards: repo, reviewStates: repo }),
  );
  const output = outputOf(result);
  expect(output.documentId).toBe('doc-get');
  expect(output.filter).toBe('all');
  const cards = output.cards as Array<Record<string, unknown>>;
  expect(cards).toHaveLength(1);
  expect((cards[0]?.reviewState as Record<string, unknown>).ankiCardId).toBe('card-get');
});

it('status projects task counts and refreshes an orphan running block from the DB', async () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-status', SESSION);
  const card = makeCard('card-status', taskId);
  repo.insertCard(card, 'doc-status');
  const blocks = new ChatBlockStoreDouble();
  blocks.addBlock({
    id: 'block-status', sessionId: SESSION, type: 'anki_cards', status: 'running',
    messageId: 'msg-status', blockIndex: 0, toolOutput: { documentId: 'doc-status', cards: [] },
    startedAt: Date.now(), firstChunkAt: Date.now(),
  } satisfies ChatAnkiChatBlock);

  const result = await new ChatAnkiStatusExecutor().execute(
    { id: 'call-status', name: 'chatanki_status', arguments: { documentId: 'doc-status' } },
    context({ cards: repo, documents: repo, chatBlocks: blocks }),
  );
  const output = outputOf(result);
  expect(output.status).toBe('completed');
  // chatanki_executor.rs:2282 `"counts": compute_task_counts(&tasks)` keeps the nested value.
  expect(output.counts).toEqual({
    counts: {
      total: 1, pending: 0, processing: 0, streaming: 0, paused: 0,
      completed: 1, failed: 0, truncated: 0, cancelled: 0,
    },
    completedRatio: 1,
  });
  expect(output.usableCards).toBe(1);

  const refreshed = blocks.getBlock('block-status');
  expect(refreshed?.status).toBe('success');
  const toolOutput = refreshed?.toolOutput as Record<string, unknown>;
  expect(toolOutput.cardsRefreshedFromDb).toBe(true);
  expect((toolOutput.cards as unknown[]).length).toBe(1);
});

it('import_apkg resolves owned bytes through VFS and emits the import event', async () => {
  const bytes = new Uint8Array(Buffer.from('apkg-bytes'));
  const vfs = new ApkgVfsDouble();
  vfs.addFile({
    id: 'file_ledger', resourceId: null, fileName: 'ledger.apkg', size: bytes.length,
    sha256: 'sha-ledger', blobHash: 'blob-ledger', originalPath: null,
  }, { blob: bytes });
  const refs: ContextRef[] = [{ resourceId: 'file_ledger', hash: 'hash-ledger', typeId: 'file' }];
  const lookup: ChatAnkiSessionResourceLookup = {
    resolveSessionUserRefs: (sessionId, ids) =>
      sessionId === SESSION ? refs.filter((ref) => ids.includes(ref.resourceId)) : null,
  };
  const imported: ChatAnkiApkgImportResult = {
    documentId: 'doc-import', importedCards: 2, importedTemplates: 1,
    mediaSkipped: 0, mediaImported: 0,
    mediaReport: { declared: 0, imported: 0, skipped: 0, skips: [], mediaDir: null },
    warnings: [], cardIds: ['card-a', 'card-b'], reviewEnqueue: null,
  };
  const calls: Array<{ bytes: Uint8Array; sourceName: string | null; sessionId: string | null }> = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const result = await new ChatAnkiApkgExecutor().execute(
    {
      id: 'call-import', name: 'builtin-chatanki_import_apkg',
      arguments: { resourceId: 'file_ledger' },
    },
    context({
      apkgImporter: {
        importBytes: (raw, sourceName, sessionId) => {
          calls.push({ bytes: raw, sourceName, sessionId });
          return imported;
        },
        importPath: () => { throw new Error('path import must not run'); },
      },
      apkgVfs: vfs,
      sessionResources: lookup,
      runId: 'run-import',
      emitEvent: (event, payload) => { events.push({ event, payload }); },
    }),
  );
  const output = outputOf(result);
  expect(output.documentId).toBe('doc-import');
  expect(output.importedCards).toBe(2);
  expect((output.nextSteps as string[]).length).toBe(2);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.sourceName).toBe('ledger.apkg');
  expect(calls[0]?.sessionId).toBe(SESSION);
  expect(events).toEqual([{
    event: 'fsrs://changed',
    payload: {
      source: 'agent', action: 'import', documentId: 'doc-import',
      entityIds: ['card-a', 'card-b'], runId: 'run-import',
    },
  }]);
});

it('import_apkg rejects unowned resources with the Rust AppError shape', async () => {
  const vfs = new ApkgVfsDouble();
  vfs.addFile({
    id: 'file_other', resourceId: null, fileName: 'other.apkg', size: 1,
    sha256: '', blobHash: 'blob-other', originalPath: null,
  }, { blob: new Uint8Array([1]) });
  const lookup: ChatAnkiSessionResourceLookup = { resolveSessionUserRefs: () => [] };
  const result = await new ChatAnkiApkgExecutor().execute(
    {
      id: 'call-import-other', name: 'chatanki_import_apkg',
      arguments: { resourceId: 'file_other' },
    },
    context({
      apkgImporter: {
        importBytes: () => { throw new Error('must not import'); },
        importPath: () => { throw new Error('must not import'); },
      },
      apkgVfs: vfs,
      sessionResources: lookup,
    }),
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe(
    '[apkg_not_found] APKG resource is not available in the current chat session: file_other',
  );
  const output = result.output as { error: Record<string, unknown> };
  expect(output.error.error_type).toBe('NotFound');
  expect((output.error.details as Record<string, unknown>).errorCode).toBe('apkg_not_found');
});
