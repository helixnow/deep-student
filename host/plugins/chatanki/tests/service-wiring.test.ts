import { expect, it } from 'vitest';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import { ChatAnkiMutationExecutor } from '../src/mutation-executor.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';
import { PreferenceMemoryDouble } from './preference-memory-double.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

function makeCard(id: string, taskId: string): AnkiCard {
  return {
    id, front: 'front', back: 'back', text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

function context(
  repos: Pick<ToolExecutionContext, 'cards' | 'documents' | 'chatBlocks' | 'settings' | 'preferenceMemory'>,
): ToolExecutionContext {
  return {
    sessionId: 'session-wiring', messageId: 'msg-wiring', blockId: 'block-wiring',
    ...repos,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
  };
}

/**
 * Mutation + UI-sync behaviour with the repository boundary supplied directly.
 * The real L16 card/document repository is not published yet, so this remains a
 * unit test of the executor; `real-host-wiring.test.ts` covers the published
 * L16/L15/L07 service graph.
 */
it('test_chatanki_update_card_persists_through_injected_repositories', async () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-wiring', 'session-wiring');
  const card = makeCard('card-wiring', taskId);
  expect(repo.insertCard(card)).toBe(true);
  const blocks = new ChatBlockStoreDouble();
  blocks.seedAnkiCardsBlock('block-wiring', 'session-wiring', 'doc-wiring');

  const executor = new ChatAnkiMutationExecutor();
  const result = await executor.execute({
    id: 'call-wiring',
    name: 'chatanki_update_card',
    arguments: {
      cardId: 'card-wiring',
      patch: { front: 'updated front' },
      expectedVersion: card.updated_at,
    },
  }, context({
    cards: repo,
    documents: repo,
    chatBlocks: blocks,
    settings: repo,
    preferenceMemory: new PreferenceMemoryDouble(),
  }));

  expect(result.success).toBe(true);
  expect((result.output as Record<string, unknown>).status).toBe('ok');
  expect(repo.getCardWithDocument('card-wiring')?.card.front).toBe('updated front');
});
