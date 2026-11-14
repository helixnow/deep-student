import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { buildAnkiLibraryListResponse, type AnkiLibraryCard } from '../src/library.ts';
import { rfc3339FromMillis } from '../src/time.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

function libraryItem(id: string, updatedAt: string, enqueued: boolean): AnkiLibraryCard {
  return {
    front: 'front',
    back: 'back',
    text: null,
    tags: [],
    images: [],
    id,
    task_id: 'task-validation',
    is_error_card: false,
    error_content: null,
    created_at: '',
    updated_at: updatedAt,
    extra_fields: {},
    template_id: null,
    sourceType: 'chatanki',
    sourceId: 'document-1',
    sourceSessionId: null,
    sourceRef: null,
    stateId: enqueued ? `state-${id}` : null,
    state: enqueued ? 0 : null,
    dueMs: enqueued ? 1_784_000_000_000 : null,
    suspended: false,
    enqueued,
    isDue: enqueued,
  };
}

describe('src/cmd/enhanced_anki.rs::tests', () => {
  it('library_list_response_exposes_independent_content_and_review_versions', () => {
    const response = buildAnkiLibraryListResponse(
      [
        libraryItem('card-reviewed', 'content-v2', true),
        libraryItem('card-unenqueued', 'content-v1', false),
      ],
      2,
      20,
      22,
      [{
        ankiCardId: 'card-reviewed',
        cardStateId: 'state-card-reviewed',
        state: 0,
        suspended: false,
        dueMs: 1_784_000_000_000,
        lastReviewMs: 1_783_999_000_000,
        reviewVersion: 7n,
        latestReview: {
          logId: 'log-7',
          rating: 3,
          reviewMs: 1_783_999_000_000,
          undoable: true,
        },
      }],
    );

    expect(response.page).toBe(2);
    expect(response.pageSize).toBe(20);
    expect(response.total).toBe(22);
    expect(response.items[0]?.version).toBe('content-v2');
    expect(response.items[0]?.reviewVersion).toBe(7n);
    const latest = response.items[0]?.latestReview as Record<string, unknown>;
    expect(latest.logId).toBe('log-7');
    expect(latest.rating).toBe(3);
    expect(latest.undoable).toBe(true);
    expect(typeof latest.reviewedAt).toBe('string');
    expect(response.items[1]?.version).toBe('content-v1');
    expect(response.items[1]?.reviewVersion).toBeNull();
    expect(response.items[1]?.latestReview).toBeNull();
  });
});

describe('卡片库读取（真实 mistakes 库）', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  });

  beforeEach(() => {
    db.run('DELETE FROM fsrs_review_logs');
    db.run('DELETE FROM fsrs_card_states');
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
  });

  function seedCard(options: {
    id?: string;
    deletedTask?: boolean;
    deletedCard?: boolean;
    tags?: string[] | null;
  } = {}): string {
    const cardId = options.id ?? 'card-1';
    const taskId = `task-${cardId}`;
    db.run(
      `INSERT INTO document_tasks
         (id, document_id, original_document_name, segment_index, content_segment,
          status, created_at, updated_at, error_message, anki_generation_options_json,
          source_session_id, deleted_at)
       VALUES (?1, 'doc-1', 'doc.md', 0, 'segment', 'Completed',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, '{}', 'session-1', ?2)`,
      [taskId, options.deletedTask === true ? '2026-01-02T00:00:00Z' : null],
    );
    db.run(
      `INSERT INTO anki_cards
         (id, task_id, front, back, text, tags_json, images_json,
          is_error_card, error_content, card_order_in_task, created_at, updated_at,
          extra_fields_json, template_id, source_type, source_id, deleted_at)
       VALUES (?1, ?2, 'front', 'back', '{{c1::x}}', ?3, '[]', 0, NULL, 0,
               '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '{"Subject":"Math"}', 'tpl-1',
               'document', 'doc-1', ?4)`,
      [
        cardId,
        taskId,
        options.tags === null ? null : JSON.stringify(options.tags ?? ['tag-a']),
        options.deletedCard === true ? '2026-01-03T00:00:00Z' : null,
      ],
    );
    return cardId;
  }

  it('returns the flattened library card shape with camelCase schedule fields', async () => {
    seedCard();
    const card = await env.host.invoke<Record<string, unknown>>('get_anki_library_card_content', {
      cardId: ' card-1 ',
    });
    expect(card).toEqual({
      front: 'front',
      back: 'back',
      text: '{{c1::x}}',
      tags: ['tag-a'],
      images: [],
      id: 'card-1',
      task_id: 'task-card-1',
      is_error_card: false,
      error_content: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      extra_fields: { Subject: 'Math' },
      template_id: 'tpl-1',
      sourceType: 'document',
      sourceId: 'doc-1',
      sourceSessionId: 'session-1',
      sourceRef: null,
      stateId: null,
      state: null,
      dueMs: null,
      suspended: false,
      enqueued: false,
      isDue: false,
    });
  });

  it('merges the FSRS state and computes isDue against the current clock', async () => {
    seedCard();
    db.run(
      `INSERT INTO fsrs_card_states
         (id, anki_card_id, due_ms, suspended, created_at, updated_at)
       VALUES ('state-1', 'card-1', 1000, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    const due = await env.host.invoke<Record<string, unknown>>('get_anki_library_card_content', {
      cardId: 'card-1',
    });
    expect(due.stateId).toBe('state-1');
    expect(due.state).toBe(0);
    expect(due.dueMs).toBe(1000);
    expect(due.enqueued).toBe(true);
    expect(due.isDue).toBe(true);

    db.run("UPDATE fsrs_card_states SET suspended = 1 WHERE id = 'state-1'");
    const suspended = await env.host.invoke<Record<string, unknown>>('get_anki_library_card_content', {
      cardId: 'card-1',
    });
    expect(suspended.suspended).toBe(true);
    expect(suspended.isDue).toBe(false);

    db.run("UPDATE fsrs_card_states SET suspended = 0, deleted_at = '2026-01-04T00:00:00Z'");
    const deletedState = await env.host.invoke<Record<string, unknown>>('get_anki_library_card_content', {
      cardId: 'card-1',
    });
    expect(deletedState.stateId).toBeNull();
    expect(deletedState.enqueued).toBe(false);
  });

  it('returns null for missing or tombstoned rows and rejects a blank card id', async () => {
    seedCard({ id: 'card-gone', deletedCard: true });
    await expect(env.host.invoke('get_anki_library_card_content', { cardId: 'missing' }))
      .resolves.toBeNull();
    await expect(env.host.invoke('get_anki_library_card_content', { cardId: 'card-gone' }))
      .resolves.toBeNull();
    await expect(env.host.invoke('get_anki_library_card_content', { cardId: '   ' }))
      .rejects.toMatchObject({
        error_type: 'Database',
        message: '读取库卡片失败: cardId is required',
      });

    seedCard({ id: 'card-task-gone', deletedTask: true });
    await expect(env.host.invoke('get_anki_library_card_content', { cardId: 'card-task-gone' }))
      .resolves.toBeNull();
  });

  it('decodes NULL tag arrays as an empty list', async () => {
    seedCard({ tags: null });
    const card = await env.host.invoke<Record<string, unknown>>('get_anki_library_card_content', {
      cardId: 'card-1',
    });
    expect(card.tags).toEqual([]);
  });

  it('formats review timestamps like chrono to_rfc3339', () => {
    expect(rfc3339FromMillis(1_783_999_000_000)).toBe('2026-07-14T03:16:40+00:00');
    expect(rfc3339FromMillis(1_784_000_000_123)).toBe('2026-07-14T03:33:20.123+00:00');
  });
});
