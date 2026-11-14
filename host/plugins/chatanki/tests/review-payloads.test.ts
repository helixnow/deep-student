import { describe, expect, it } from 'vitest';
import type {
  FsrsCardState, FsrsEnqueueResult, FsrsEnqueuedCard, FsrsStats,
} from '../../review/api.ts';
import {
  buildEnqueueReviewChangedPayload, chatankiReviewStatsOutput, parseChatAnkiReviewStatsArgs,
} from '../src/review-payloads.ts';

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function makeCardState(id: string, ankiCardId: string): FsrsCardState {
  return {
    id,
    ankiCardId,
    deckId: 'deck_default',
    state: 0,
    stability: null,
    difficulty: null,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    dueMs: 0,
    lastReviewMs: null,
    suspended: false,
    fsrsParamsVersion: 'test',
    desiredRetention: 0.9,
    createdAt: 'created',
    updatedAt: 'updated',
    leech: false,
    buriedUntilMs: null,
    learningStep: 0,
  };
}

function makeEnqueuedCard(id: string, ankiCardId: string, front: string, back: string): FsrsEnqueuedCard {
  return {
    id,
    ankiCardId,
    front,
    back,
    tags: [front],
    text: null,
    templateId: null,
    extraFields: {},
    images: [],
    isErrorCard: false,
  };
}

describe('chatanki_executor.rs (review stats and enqueue payload)', () => {
  it('test_chatanki_review_stats_contract_and_enqueue_event_payload', () => {
    const stats: FsrsStats = {
      total: 8,
      due: 7,
      newCount: 6,
      learning: 5,
      review: 4,
      relearning: 3,
      suspended: 2,
      reviewsToday: 1,
      buried: 0,
      leech: 0,
      newRemainingToday: 0,
      reviewsRemainingToday: 0,
      backlog: 0,
      backlogReview: 0,
      backlogNew: 0,
      learningWaiting: 0,
    };
    expect(chatankiReviewStatsOutput(stats)).toEqual({
      status: 'ok',
      total: 8,
      due: 7,
      new: 6,
      learning: 5,
      review: 4,
      relearning: 3,
      suspended: 2,
      reviews_today: 1,
    });
    expect(parseChatAnkiReviewStatsArgs({})).toEqual({});
    expect(captureError(() => parseChatAnkiReviewStatsArgs({ scope: 'chat' }))).not.toBeNull();

    expect(buildEnqueueReviewChangedPayload({
      enqueued: 0,
      skipped: 1,
      enqueuedStateIds: [],
      states: [],
      reviewCards: [],
    }, [], 'run-skipped')).toBeNull();

    const state = makeCardState('state-new', 'anki-new');
    const skippedState = makeCardState('state-skipped', 'anki-skipped');
    const loadedCards = [
      makeEnqueuedCard('state-skipped', 'anki-skipped', 'skipped', 'skipped back'),
      makeEnqueuedCard('state-new', 'anki-new', 'new', 'new back'),
    ];
    const payload = buildEnqueueReviewChangedPayload({
      enqueued: 1,
      skipped: 1,
      enqueuedStateIds: ['state-new'],
      states: [skippedState, state],
      reviewCards: loadedCards,
    }, loadedCards, 'run-enqueue');
    expect(payload).toEqual({
      source: 'agent',
      action: 'enqueue',
      entityIds: ['anki-new'],
      cardStateIds: ['state-new'],
      cards: [{
        id: 'state-new',
        ankiCardId: 'anki-new',
        front: 'new',
        back: 'new back',
        tags: ['new'],
        extraFields: {},
        images: [],
        isErrorCard: false,
      }],
      runId: 'run-enqueue',
    });
    const cards = payload?.cards as Array<Record<string, unknown>>;
    expect(String(cards[0]?.front).length).toBeGreaterThan(0);
    expect(String(cards[0]?.back).length).toBeGreaterThan(0);

    expect(buildEnqueueReviewChangedPayload({
      enqueued: 0,
      skipped: 0,
      enqueuedStateIds: [],
      states: [],
      reviewCards: [],
    }, [], 'run-empty')).toBeNull();
  });
});
