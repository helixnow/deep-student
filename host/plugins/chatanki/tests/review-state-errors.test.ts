import { expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import { ChatAnkiGetCardsExecutor } from '../src/get-cards-executor.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

function card(id: string, taskId: string): AnkiCard {
  return {
    id, front: 'front', back: 'back', text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {}, template_id: null,
  };
}

function context(
  repo: CardStoreDouble, reviewStates: ToolExecutionContext['reviewStates'],
): ToolExecutionContext {
  return {
    sessionId: 'session-review-error', messageId: 'message-review-error',
    blockId: 'block-review-error',
    cards: repo, reviewStates,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
  };
}

function seededRepo(): CardStoreDouble {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-review-error', 'session-review-error');
  repo.insertCard(card('card-review-error', taskId), 'doc-review-error');
  return repo;
}

it('maps a published L15 NotFound CommandError to the Rust i18n status key', async () => {
  const repo = seededRepo();
  const result = await new ChatAnkiGetCardsExecutor().execute(
    {
      id: 'call-review-not-found', name: 'chatanki_get_cards',
      arguments: { documentId: 'doc-review-error' },
    },
    context(repo, {
      getReviewStatesForSession: () => {
        throw new CommandError(AppError.not_found('anki card not found: card-review-error'));
      },
      enqueueCardsForSession: () => { throw new Error('not used'); },
    }),
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain('blocks.ankiCards.errors.statusNotFound');
});

it('keeps the structured AppError for non-NotFound L15 failures', async () => {
  const repo = seededRepo();
  const result = await new ChatAnkiGetCardsExecutor().execute(
    {
      id: 'call-review-database', name: 'chatanki_get_cards',
      arguments: { documentId: 'doc-review-error' },
    },
    context(repo, {
      getReviewStatesForSession: () => {
        throw new CommandError(AppError.with_details(
          'Database', 'review state query failed', { errorCode: 'review_state_query' },
        ));
      },
      enqueueCardsForSession: () => { throw new Error('not used'); },
    }),
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe('[review_state_query] review state query failed');
  expect(result.output).toEqual({
    error: {
      error_type: 'Database',
      message: 'review state query failed',
      details: { errorCode: 'review_state_query' },
    },
  });
});
