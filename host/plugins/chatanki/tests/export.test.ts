import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { AnkiCard, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import { ChatAnkiExecutor } from '../src/chatanki-executor.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

const exportDirs: string[] = [];
afterAll(() => {
  for (const dir of exportDirs) rmSync(dir, { recursive: true, force: true });
});

function makeCard(
  id: string, taskId: string, front: string, back: string, templateId: string | null = null,
): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: templateId,
  };
}

const exportSink = {
  async saveJsonFile(content: string, suggestedName: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'chatanki-export-'));
    exportDirs.push(dir);
    const path = join(dir, suggestedName);
    writeFileSync(path, content, 'utf8');
    return path;
  },
};

function context(repo: CardStoreDouble, sessionId: string): ToolExecutionContext {
  return {
    sessionId, messageId: 'msg-export', blockId: 'block-export', cards: repo, exportSink,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
  };
}

async function runExport(
  repo: CardStoreDouble, sessionId: string, args: Record<string, unknown>,
): Promise<ToolResultInfo> {
  const executor = new ChatAnkiExecutor();
  return executor.execute(
    { id: 'call-export', name: 'builtin-chatanki_export', arguments: args },
    context(repo, sessionId),
  );
}

function exportedCards(result: ToolResultInfo): AnkiCard[] {
  const path = (result.output as Record<string, unknown>).path as string;
  return JSON.parse(readFileSync(path, 'utf8')) as AnkiCard[];
}

it('test_chatanki_export_library_json_writes_full_cards_and_fails_closed', async () => {
  const repo = new CardStoreDouble();
  const foreignTask = repo.seedDocument('doc-foreign', 'session-foreign');
  const otherTask = repo.seedDocument('doc-other', 'session-other');
  const first = makeCard('card-lib-b', otherTask, 'front-b', 'back-b', 'design-swiss');
  first.extra_fields.hint = 'keep-me';
  const second = makeCard('card-lib-a', foreignTask, 'front-a', 'back-a');
  const deleted = makeCard('card-lib-deleted', foreignTask, 'gone', 'gone');
  expect(repo.insertCard(first)).toBe(true);
  expect(repo.insertCard(second)).toBe(true);
  expect(repo.insertCard(deleted)).toBe(true);
  expect(repo.deleteCardForSession(
    'card-lib-deleted', deleted.updated_at, null, 'session-foreign',
  ).kind).toBe('deleted');

  const ok = await runExport(repo, 'session-caller', {
    libraryCardIds: ['card-lib-a', 'card-lib-b'], format: 'json',
  });
  expect(ok.success).toBe(true);
  const output = ok.output as Record<string, unknown>;
  expect(output.status).toBe('ok');
  expect(output.format).toBe('json');
  expect(output.cardsCount).toBe(2);
  expect(output.libraryCardIds).toEqual(['card-lib-a', 'card-lib-b']);
  expect(output.documentId).toBeUndefined();
  expect(output.cards).toBeUndefined();
  const exported = exportedCards(ok);
  expect(exported.map((card) => card.id)).toEqual(['card-lib-a', 'card-lib-b']);
  expect(exported[0]?.front).toBe('front-a');
  expect(exported[1]?.extra_fields.hint).toBe('keep-me');
  expect(exported[1]?.template_id).toBe('design-swiss');

  const missing = await runExport(repo, 'session-caller', {
    libraryCardIds: ['card-lib-a', 'card-lib-deleted'], format: 'json',
  });
  expect(missing.success).toBe(false);
  expect(missing.error).toContain('library_cards_unavailable');
});

it('test_chatanki_export_document_keeps_atomic_ownership', async () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-owned', 'session-owner');
  const card = makeCard('card-owned-export', taskId, 'owned-front', 'owned-back');
  expect(repo.insertCard(card)).toBe(true);

  const foreign = await runExport(repo, 'session-other', {
    documentId: 'doc-owned', format: 'json',
  });
  expect(foreign.success).toBe(false);
  expect(foreign.error).toContain('statusNotFound');

  const owned = await runExport(repo, 'session-owner', {
    documentId: 'doc-owned', format: 'json',
  });
  expect(owned.success).toBe(true);
  const output = owned.output as Record<string, unknown>;
  expect(output.documentId).toBe('doc-owned');
  expect(Object.hasOwn(output, 'hiddenOverLimitCount')).toBe(true);
  const exported = exportedCards(owned);
  expect(exported.length).toBe(1);
  expect(exported[0]?.id).toBe('card-owned-export');
  expect(exported[0]?.front).toBe('owned-front');
});
