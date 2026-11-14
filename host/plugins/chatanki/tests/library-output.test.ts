import { describe, expect, it } from 'vitest';
import { toWireJson } from '../../../kernel/json.ts';
import type { AnkiCard } from '../api.ts';
import { CHATANKI_CARD_FIELD_LIMIT, convertCardForTool } from '../src/executor-args.ts';
import {
  agentReviewChangedState, attachReviewStates, buildAgentReviewChangedPayload, chatankiLibraryReviewMutationConflictPayload,
  chatankiLibraryVersionConflictPayload, chatankiReviewMutationBlockedPayload,
  chatankiReviewMutationConflictPayload, chatankiReviewMutationOkPayload, convertLibraryRecordForTool,
  type AnkiLibraryCardRecord, type FsrsAgentReviewStateSnapshot,
} from '../src/library-output.ts';

function makeCard(id: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: 'task-1', is_error_card: false,
    error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

function makeLibraryRecord(
  card: AnkiCard, documentId: string, sourceSessionId: string | null,
): AnkiLibraryCardRecord {
  return {
    libraryCard: {
      sourceSessionId: null,
      sourceRef: null,
      card,
      sourceType: 'document',
      sourceId: 'source-1',
      stateId: 'state-library',
      state: 2,
      dueMs: 1_725_000_000_000,
      suspended: false,
      enqueued: true,
      isDue: true,
    },
    locator: { documentId, sourceSessionId },
  };
}

function makeAgentReviewSnapshot(
  cardId: string, cardStateId: string, reviewVersion: number | bigint,
): FsrsAgentReviewStateSnapshot {
  return {
    ankiCardId: cardId,
    cardStateId,
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

describe('chatanki_executor.rs (library output and review payloads)', () => {
  it('D3 keeps full-i64 review tokens in projections and events until the wire boundary', () => {
    for (const token of [9007199254740993n, 9223372036854774785n, 9223372036854775807n]) {
      const state = makeAgentReviewSnapshot('card-exact', 'state-exact', token);
      const record = makeLibraryRecord(makeCard('card-exact', 'front', 'back'), 'doc-exact', null);
      const library = convertLibraryRecordForTool(record, state);
      const ok = chatankiReviewMutationOkPayload('card-exact', state, true);
      const conflict = chatankiReviewMutationConflictPayload('card-exact', state);
      const event = buildAgentReviewChangedPayload('set_suspended', state, 'run-exact');
      expect((library.reviewState as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(token);
      expect((ok.reviewState as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(token);
      expect((conflict.current as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(token);
      expect((event.cards as FsrsAgentReviewStateSnapshot[])[0]?.reviewVersion).toBe(token);
      const wire = JSON.parse(JSON.stringify(toWireJson({ library, ok, conflict, event })));
      expect(wire.library.reviewState.reviewVersion).toBe(Number(token));
      expect(wire.ok.reviewState.reviewVersion).toBe(Number(token));
      expect(wire.conflict.current.reviewVersion).toBe(Number(token));
      expect(wire.event.cards[0].reviewVersion).toBe(Number(token));
      expect(state.reviewVersion).toBe(token);
    }
  });

  it('test_chatanki_get_cards_attaches_review_state_or_null', () => {
    const cards = [
      convertCardForTool(makeCard('card-enqueued', 'front', 'back'), 1),
      convertCardForTool(makeCard('card-not-enqueued', 'front', 'back'), 2),
    ];
    attachReviewStates(cards, [
      makeAgentReviewSnapshot('card-enqueued', 'state-enqueued', 4),
    ]);
    const enqueued = cards[0]?.reviewState as FsrsAgentReviewStateSnapshot;
    expect(enqueued.cardStateId).toBe('state-enqueued');
    expect(enqueued.reviewVersion).toBe(4n);
    expect(enqueued.latestReview?.logId).toBe('log-latest');
    expect(cards[1]?.reviewState).toBeNull();
  });

  it('test_chatanki_library_card_output_includes_locator_versions_and_truncation', () => {
    const card = makeCard('card-library-output', 'x'.repeat(CHATANKI_CARD_FIELD_LIMIT + 1), 'back');
    const expectedVersion = card.updated_at;
    const record = makeLibraryRecord(card, 'doc-library-output', null);
    const reviewState = makeAgentReviewSnapshot(
      'card-library-output', 'state-library-output', 17,
    );
    const output = convertLibraryRecordForTool(record, reviewState);

    expect(output.documentId).toBe('doc-library-output');
    expect(output.version).toBe(expectedVersion);
    expect(output.updatedAt).toBe(expectedVersion);
    expect((output.reviewState as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(17n);
    expect((output.reviewState as FsrsAgentReviewStateSnapshot).latestReview?.logId)
      .toBe('log-latest');
    expect(output.enqueued).toBe(true);
    expect(output.isDue).toBe(true);
    expect(output.truncated).toBe(true);
    expect(output.ratingAvailableToAgent).toBe(false);
    expect([...(output.front as string)].length).toBe(CHATANKI_CARD_FIELD_LIMIT);

    const withoutState = convertLibraryRecordForTool(record, null);
    expect(withoutState.reviewState).toBeNull();
  });

  it('test_chatanki_library_conflicts_route_refresh_to_library_tool', () => {
    const record = makeLibraryRecord(
      makeCard('card-conflict', 'front', 'back'), 'doc-conflict', 'session-source',
    );
    const reviewState = makeAgentReviewSnapshot('card-conflict', 'state-conflict', 23);
    const content = chatankiLibraryVersionConflictPayload(record, reviewState, 'version_conflict');
    expect(content.status).toBe('conflict');
    const current = content.current as Record<string, unknown>;
    expect(current.documentId).toBe('doc-conflict');
    expect((current.reviewState as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(23n);
    expect(String(content.guidance)).toContain('builtin-chatanki_list_library_cards');

    const review = chatankiLibraryReviewMutationConflictPayload('card-conflict', reviewState);
    expect(review.error).toBe('review_state_conflict');
    expect(String(review.guidance)).toContain('builtin-chatanki_list_library_cards');
  });

  it('test_chatanki_agent_review_outcomes_and_event_payload_contract', () => {
    const state = makeAgentReviewSnapshot('card-review', 'state-review', 9);
    const ok = chatankiReviewMutationOkPayload('card-review', state, true);
    expect(ok.status).toBe('ok');
    expect(ok.changed).toBe(true);
    expect((ok.reviewState as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(9n);

    const conflict = chatankiReviewMutationConflictPayload('card-review', state);
    expect(conflict.status).toBe('conflict');
    expect(conflict.error).toBe('review_state_conflict');
    expect((conflict.current as FsrsAgentReviewStateSnapshot).cardStateId).toBe('state-review');
    expect(conflict.mutationApplied).toBe(false);

    const blocked = chatankiReviewMutationBlockedPayload(
      'card-review', 'diagnostic_card', state,
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.error).toBe('diagnostic_card');
    expect(blocked.retryable).toBe(false);

    const changed = { status: 'updated' as const, state, changed: true };
    const noop = { status: 'updated' as const, state, changed: false };
    const stale = { status: 'conflict' as const, current: state };
    expect(agentReviewChangedState(changed)).not.toBeNull();
    expect(agentReviewChangedState(noop)).toBeNull();
    expect(agentReviewChangedState(stale)).toBeNull();

    const event = buildAgentReviewChangedPayload('set_suspended', state, 'run-review');
    expect(event).toEqual({
      source: 'agent',
      action: 'set_suspended',
      entityIds: ['card-review'],
      cardStateIds: ['state-review'],
      cards: [{
        ankiCardId: 'card-review',
        cardStateId: 'state-review',
        state: 2,
        suspended: false,
        dueMs: 1_725_000_000_000,
        lastReviewMs: 1_724_000_000_000,
        reviewVersion: 9n,
        latestReview: {
          logId: 'log-latest',
          rating: 3,
          reviewMs: 1_724_000_000_000,
          undoable: true,
        },
      }],
      runId: 'run-review',
    });
  });
});
