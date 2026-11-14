/**
 * Agent review mutation orchestration. The L15 service below is a *boundary*
 * double for outcome mapping only: production CAS/transactions live in L15 and
 * are not exercised here. `real-review-enqueue.test.ts` covers the published
 * main-branch L15 enqueue path end to end.
 */
import { expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type {
  AnkiCard, ChatAnkiReviewStateService, FsrsAgentReviewMutationOutcome,
  FsrsAgentReviewStateSnapshot, ToolCall, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';
import { ChatAnkiReviewExecutor } from '../src/review-executor.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

const SESSION = 'session-review-executor';

function makeCard(id: string, taskId: string): AnkiCard {
  return {
    id, front: 'front', back: 'back', text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {}, template_id: null,
  };
}

function state(cardId: string, reviewVersion: number | bigint): FsrsAgentReviewStateSnapshot {
  return {
    ankiCardId: cardId,
    cardStateId: `state-${cardId}`,
    state: 2,
    suspended: false,
    dueMs: 1_725_000_000_000,
    lastReviewMs: 1_724_000_000_000,
    reviewVersion: BigInt(reviewVersion),
    latestReview: {
      logId: 'log-latest', rating: 3, reviewMs: 1_724_000_000_000, undoable: true,
    },
  };
}

class ReviewBoundaryDouble implements ChatAnkiReviewStateService {
  readonly calls: unknown[][] = [];
  outcome: FsrsAgentReviewMutationOutcome = { status: 'not_found' };
  failure: unknown = null;

  getReviewStatesForSession(): FsrsAgentReviewStateSnapshot[] { return []; }

  setSuspendedForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, suspended: boolean,
  ): FsrsAgentReviewMutationOutcome {
    this.calls.push(['setSuspendedForSession', cardId, sessionId, expectedReviewVersion, suspended]);
    if (this.failure !== null) throw this.failure;
    return this.outcome;
  }

  undoLastReviewForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, expectedLogId: string,
  ): FsrsAgentReviewMutationOutcome {
    this.calls.push([
      'undoLastReviewForSession', cardId, sessionId, expectedReviewVersion, expectedLogId,
    ]);
    if (this.failure !== null) throw this.failure;
    return this.outcome;
  }
}

function seededRepo(): CardStoreDouble {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-review-executor', SESSION);
  repo.insertCard(makeCard('card-review-executor', taskId), 'doc-review-executor');
  return repo;
}

function context(
  repo: CardStoreDouble,
  reviewStates: ToolExecutionContext['reviewStates'],
  events: Array<[string, unknown]> = [],
): ToolExecutionContext {
  return {
    sessionId: SESSION,
    messageId: 'message-review-executor',
    blockId: 'block-review-executor',
    cards: repo,
    reviewStates,
    runId: 'run-review-executor',
    emitEvent: (event, payload) => { events.push([event, payload]); },
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

async function execute(
  name: string, args: Record<string, unknown>,
  reviewStates: ToolExecutionContext['reviewStates'],
  repo = seededRepo(),
): Promise<{ result: ToolResultInfo; repo: CardStoreDouble; events: Array<[string, unknown]> }> {
  const events: Array<[string, unknown]> = [];
  const result = await new ChatAnkiReviewExecutor().execute(
    call(name, args), context(repo, reviewStates, events),
  );
  return { result, repo, events };
}

it('chatanki_set_suspended passes the exact version to L15 and emits the changed state', async () => {
  const review = new ReviewBoundaryDouble();
  review.outcome = { status: 'updated', state: state('card-review-executor', 9), changed: true };

  const { result, events } = await execute(
    'chatanki_set_suspended',
    { cardId: ' card-review-executor ', expectedReviewVersion: 8, suspended: true },
    review,
  );

  expect(result.success).toBe(true);
  expect(review.calls).toEqual([
    ['setSuspendedForSession', 'card-review-executor', SESSION, 8, true],
  ]);
  expect(result.output).toMatchObject({
    status: 'ok',
    cardId: 'card-review-executor',
    changed: true,
    mutationApplied: true,
    retryable: false,
    reviewState: { reviewVersion: 9n },
  });
  expect(events).toHaveLength(1);
  expect(events[0]?.[0]).toBe('fsrs://changed');
  expect(events[0]?.[1]).toMatchObject({
    source: 'agent',
    action: 'set_suspended',
    entityIds: ['card-review-executor'],
    cardStateIds: ['state-card-review-executor'],
    runId: 'run-review-executor',
  });
});

it('chatanki_undo_last_review maps conflict without emitting fsrs://changed', async () => {
  const review = new ReviewBoundaryDouble();
  review.outcome = { status: 'conflict', current: state('card-review-executor', 10) };

  const { result, events } = await execute(
    'chatanki_undo_last_review',
    { cardId: 'card-review-executor', expectedReviewVersion: 9, expectedLogId: ' log-9 ' },
    review,
  );

  expect(review.calls).toEqual([
    ['undoLastReviewForSession', 'card-review-executor', SESSION, 9, 'log-9'],
  ]);
  expect(result.success).toBe(true);
  expect(result.output).toMatchObject({
    status: 'conflict',
    error: 'review_state_conflict',
    mutationApplied: false,
    current: { reviewVersion: 10n },
  });
  expect(events).toHaveLength(0);
});

it('chatanki_undo_last_review maps L15 not_found to the Rust status key', async () => {
  const review = new ReviewBoundaryDouble();
  review.outcome = { status: 'not_found' };

  const { result } = await execute(
    'chatanki_undo_last_review',
    { cardId: 'card-review-executor', expectedReviewVersion: 1, expectedLogId: 'log-1' },
    review,
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain('blocks.ankiCards.errors.statusNotFound');
});

it('keeps structured L15 AppErrors from review mutations', async () => {
  const review = new ReviewBoundaryDouble();
  review.failure = new CommandError(AppError.with_details(
    'Database', 'review mutation failed', { errorCode: 'review_cas' },
  ));

  const { result } = await execute(
    'chatanki_set_suspended',
    { cardId: 'card-review-executor', expectedReviewVersion: 4, suspended: false },
    review,
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe('[review_cas] review mutation failed');
  expect(result.output).toEqual({
    error: {
      error_type: 'Database',
      message: 'review mutation failed',
      details: { errorCode: 'review_cas' },
    },
  });
});

it('rejects ownership before touching the L15 mutation service', async () => {
  const review = new ReviewBoundaryDouble();
  const { result } = await execute(
    'chatanki_set_suspended',
    { cardId: 'card-review-executor', expectedReviewVersion: 4, suspended: false },
    review,
    new CardStoreDouble(),
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain('blocks.ankiCards.errors.statusNotFound');
  expect(review.calls).toEqual([]);
});

it('passes a valid large i64 review version to L15 without a safe-integer gate', async () => {
  const review = new ReviewBoundaryDouble();
  // 2^63 - 1024 is a valid i64 and exactly representable in IEEE-754.
  const large = 2 ** 63 - 1024;
  review.outcome = { status: 'updated', state: state('card-review-executor', large), changed: true };

  const { result } = await execute(
    'chatanki_set_suspended',
    {
      cardId: 'card-review-executor',
      expectedReviewVersion: large,
      suspended: false,
    },
    review,
  );

  expect(result.success).toBe(true);
  expect(review.calls).toEqual([
    ['setSuspendedForSession', 'card-review-executor', SESSION, large, false],
  ]);
  expect(result.output).toMatchObject({
    status: 'ok',
    mutationApplied: true,
    reviewState: { reviewVersion: BigInt(large) },
  });
});

it('passes an exact bigint snapshot token through suspend/undo orchestration without Number conversion', async () => {
  const review = new ReviewBoundaryDouble();
  const token = 9223372036854774785n;
  review.outcome = { status: 'updated', state: state('card-review-executor', token + 1n), changed: true };
  for (const name of ['chatanki_set_suspended', 'chatanki_undo_last_review']) {
    const args = name === 'chatanki_set_suspended'
      ? { cardId: 'card-review-executor', expectedReviewVersion: token, suspended: true }
      : { cardId: 'card-review-executor', expectedReviewVersion: token, expectedLogId: 'log-exact' };
    const { result } = await execute(name, args, review);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ reviewState: { reviewVersion: token + 1n } });
  }
  expect(review.calls).toEqual([
    ['setSuspendedForSession', 'card-review-executor', SESSION, token, true],
    ['undoLastReviewForSession', 'card-review-executor', SESSION, token, 'log-exact'],
  ]);
});

it('fails closed when the published L15 service lacks a CAS mutation method', async () => {
  const result = await new ChatAnkiReviewExecutor().execute(
    call('chatanki_set_suspended', {
      cardId: 'card-review-executor', expectedReviewVersion: 4, suspended: false,
    }),
    context(seededRepo(), { getReviewStatesForSession: () => [] }),
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain('requires the L15 review service (setSuspendedForSession)');
});
