import { expect, it } from 'vitest';
import type { AnkiCard, ChatAnkiChatBlock, DocumentTask, TaskStatus } from '../api.ts';
import { STALE_RUNNING_ANKI_BLOCK_AFTER_MS } from '../src/executor-helpers.ts';
import {
  reapStaleRunningAnkiBlocks, sessionHasRunningAnkiBlocks, syncTerminalAnkiBlockWithDb,
} from '../src/block-reap.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';

function makeCard(id: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: 'task-1',
    is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {}, template_id: 'design-swiss',
  };
}

function makeTask(status: TaskStatus): DocumentTask {
  return {
    id: 'task-1', document_id: 'doc-sync', original_document_name: 'doc.md',
    segment_index: 0, content_segment: 'content', status,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z',
    error_message: null, anki_generation_options_json: '{}',
  };
}

function runningBlock(
  id: string, sessionId: string, documentId: string, startedAt: number,
): ChatAnkiChatBlock {
  return {
    id, sessionId, type: 'anki_cards', status: 'running',
    messageId: `msg-${id}`, blockIndex: 0,
    startedAt, firstChunkAt: startedAt, endedAt: null,
    toolOutput: { documentId, cards: [] },
  };
}

it('test_reap_stale_running_anki_blocks_marks_zombie_failed', () => {
  const store = new ChatBlockStoreDouble();
  const sessionId = 'session-reap';
  const zombie = store.seedAnkiCardsBlock(
    'block-zombie', sessionId, 'doc-zombie',
  );
  const staleMs = Date.now() - STALE_RUNNING_ANKI_BLOCK_AFTER_MS - 60_000;
  store.updateBlock({
    ...zombie, status: 'running', startedAt: staleMs, firstChunkAt: staleMs, endedAt: null,
  });

  const live = runningBlock('block-live', sessionId, 'doc-live', staleMs);
  store.addBlock(live);

  const activePipelines = new Set<string>([live.id]);
  const reaped = reapStaleRunningAnkiBlocks(
    store, sessionId, (blockId) => activePipelines.has(blockId),
  );
  expect(reaped).toEqual([zombie.id]);

  const zombieBlock = store.getBlock(zombie.id);
  expect(zombieBlock?.status).toBe('error');
  expect(zombieBlock?.error).toBe('blocks.ankiCards.errors.pipelineTimeout');
  expect(zombieBlock?.endedAt).not.toBeNull();
  const zombieOutput = zombieBlock?.toolOutput as Record<string, unknown>;
  const interrupted = zombieOutput.interrupted as Record<string, unknown>;
  expect(interrupted.reason).toBe('stale_running_block');
  expect(zombieOutput.workflowStatus).toBe('failed');

  expect(store.getBlock(live.id)?.status).toBe('running');

  activePipelines.delete(live.id);
  const reapedAfterDrop = reapStaleRunningAnkiBlocks(
    store, sessionId, (blockId) => activePipelines.has(blockId),
  );
  expect(reapedAfterDrop).toEqual([live.id]);
});

it('test_session_has_running_anki_blocks_reaps_stale_zombie_blocks', () => {
  const store = new ChatBlockStoreDouble();
  const sessionId = 'sess_reap_zombie';
  const staleMs = Date.now() - STALE_RUNNING_ANKI_BLOCK_AFTER_MS - 60_000;
  const zombie = runningBlock('block-zombie-delete', sessionId, 'doc-zombie', staleMs);
  store.addBlock(zombie);

  expect(sessionHasRunningAnkiBlocks(store, sessionId, () => false)).toBe(false);
  const reaped = store.getBlock(zombie.id);
  expect(reaped?.status).toBe('error');
  expect(reaped?.endedAt).not.toBeNull();

  const nowMs = Date.now();
  const fresh = runningBlock('block-fresh-delete', sessionId, 'doc-fresh', nowMs);
  store.addBlock(fresh);
  expect(sessionHasRunningAnkiBlocks(store, sessionId, () => false)).toBe(true);
});

it('test_sync_terminal_anki_block_refreshes_stale_snapshot', () => {
  const store = new ChatBlockStoreDouble();
  const sessionId = 'session-sync';
  const documentId = 'doc-sync';
  const block = store.seedAnkiCardsBlock(
    'block-sync', sessionId, documentId, {},
    [{ id: 'card-a', front: 'old', back: 'old' }],
  );
  store.updateBlock({ ...block, status: 'running', endedAt: null });

  const tasks = [makeTask('Completed')];
  const dbCards = [
    makeCard('card-a', 'front-a', 'back-a'),
    makeCard('card-b', 'front-b', 'back-b'),
  ];

  expect(syncTerminalAnkiBlockWithDb(
    store, sessionId, documentId, tasks, dbCards,
  )).toBe(true);

  const refreshed = store.getBlock(block.id);
  expect(refreshed?.status).toBe('success');
  const output = refreshed?.toolOutput as Record<string, unknown>;
  expect((output.cards as Array<Record<string, unknown>>).map((card) => card.id))
    .toEqual(['card-a', 'card-b']);
  expect(output.cardsRefreshedFromDb).toBe(true);
  expect(output.workflowStatus).toBe('completed');

  expect(syncTerminalAnkiBlockWithDb(
    store, sessionId, documentId, tasks, dbCards,
  )).toBe(false);

  const patched = structuredClone(output);
  patched.deletedCardIds = ['card-b'];
  patched.cards = [(patched.cards as unknown[])[0]];
  store.updateBlock({ ...(store.getBlock(block.id) as ChatAnkiChatBlock), toolOutput: patched });

  expect(syncTerminalAnkiBlockWithDb(
    store, sessionId, documentId, tasks, dbCards,
  )).toBe(false);

  expect(syncTerminalAnkiBlockWithDb(
    store, sessionId, documentId, [makeTask('Processing')], dbCards,
  )).toBe(false);
});
