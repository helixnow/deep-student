import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  SaveAnkiCardPayload,
  SaveAnkiCardsRequest,
  SaveAnkiCardsResponse,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  buildSaveAnkiCardsChangedPayload,
  saveAnkiCardsOutcomeIsAcceptable,
} from '../src/save-cards.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cardPayload(id: string | null, front: string, back: string): SaveAnkiCardPayload {
  return { id, front, back, text: null, tags: null, images: null, fields: null, template_id: null };
}

function saveRequest(documentId: string, cards: SaveAnkiCardPayload[]): SaveAnkiCardsRequest {
  return {
    document_id: documentId,
    business_session_id: null,
    message_stable_id: null,
    block_id: null,
    template_id: null,
    cards,
    options: null,
  };
}

describe('src/cmd/anki_connect.rs::save_anki_cards_semantics_tests', () => {
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

  async function save(request: SaveAnkiCardsRequest): Promise<SaveAnkiCardsResponse> {
    return env.host.invoke<SaveAnkiCardsResponse>('save_anki_cards', { request });
  }

  function liveCardCountForDocument(documentId: string, cardId: string): number {
    return db.pluck<number>(
      `SELECT COUNT(*)
       FROM anki_cards ac
       INNER JOIN document_tasks dt ON dt.id = ac.task_id
       WHERE ac.id = ?1
         AND ac.source_type = 'document'
         AND ac.source_id = ?2
         AND ac.deleted_at IS NULL
         AND dt.document_id = ?2
         AND dt.deleted_at IS NULL`,
      [cardId, documentId],
    ) ?? 0;
  }

  it('temporary_and_missing_ids_are_replaced_and_mapped_in_input_order', async () => {
    const response = await save(saveRequest('doc-durable-ids', [
      cardPayload(null, 'missing', 'a'),
      cardPayload('anki_synthetic_msg-1-0', 'synthetic', 'b'),
      cardPayload('chat-batch-block-1-0', 'batch', 'c'),
      cardPayload('real-card-id', 'real', 'd'),
    ]));

    expect(response.cardIdMappings.map((mapping) => mapping.inputIndex)).toEqual([0, 1, 2, 3]);
    expect(response.cardIdMappings[0]?.inputId).toBeNull();
    expect(response.cardIdMappings[1]?.inputId).toBe('anki_synthetic_msg-1-0');
    expect(response.cardIdMappings[2]?.inputId).toBe('chat-batch-block-1-0');
    for (const mapping of response.cardIdMappings.slice(0, 3)) {
      expect(mapping.persistedId).toMatch(UUID);
    }
    expect(response.cardIdMappings[3]?.persistedId).toBe('real-card-id');

    for (const mapping of response.cardIdMappings) {
      expect(liveCardCountForDocument('doc-durable-ids', mapping.persistedId)).toBe(1);
    }
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM anki_cards WHERE id LIKE 'anki_synthetic_%' OR id LIKE 'chat-batch-%'",
    )).toBe(0);
  });

  it('existing_real_id_updates_idempotently_and_maps_to_itself', async () => {
    await save(saveRequest('doc-real-update', [cardPayload('real-update-id', 'question', 'old')]));
    const response = await save(saveRequest('doc-real-update', [cardPayload('real-update-id', 'question', 'new')]));
    expect(response.duplicatedIds).toEqual(['real-update-id']);
    expect(response.cardIdMappings).toHaveLength(1);
    expect(response.cardIdMappings[0]?.persistedId).toBe('real-update-id');
    expect(db.pluck<string>("SELECT back FROM anki_cards WHERE id = 'real-update-id'")).toBe('new');
  });

  it('real_id_collision_cannot_overwrite_card_from_another_document', async () => {
    await save(saveRequest('doc-owner', [cardPayload('shared-real-id', 'owner question', 'owner answer')]));
    await expect(save(saveRequest('doc-attacker', [cardPayload('shared-real-id', 'attacker question', 'attacker answer')])))
      .rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('卡片 ID 不属于当前文档') });

    const row = db.one<{ front: string; back: string; source_id: string; document_id: string }>(
      `SELECT ac.front, ac.back, ac.source_id, dt.document_id
       FROM anki_cards ac
       INNER JOIN document_tasks dt ON dt.id = ac.task_id
       WHERE ac.id = 'shared-real-id'`,
    );
    expect(row).toEqual({
      front: 'owner question',
      back: 'owner answer',
      source_id: 'doc-owner',
      document_id: 'doc-owner',
    });
  });

  it('duplicate_durable_ids_fail_before_any_task_or_card_is_persisted', async () => {
    await expect(save(saveRequest('doc-duplicate-input', [
      cardPayload('same-real-id', 'first question', 'first answer'),
      cardPayload('same-real-id', 'second question', 'second answer'),
    ]))).rejects.toMatchObject({
      error_type: 'Validation',
      message: 'duplicate_card_id_in_request: id=same-real-id, firstInputIndex=0, duplicateInputIndex=1',
    });
    expect(db.pluck<number>("SELECT COUNT(*) FROM document_tasks WHERE document_id = 'doc-duplicate-input'")).toBe(0);
    expect(db.pluck<number>("SELECT COUNT(*) FROM anki_cards WHERE id = 'same-real-id'")).toBe(0);
  });

  it('fully_failed_save_does_not_claim_existing_document_tasks', async () => {
    await save(saveRequest('doc-unowned-target', [cardPayload('target-card', 'target', 'answer')]));
    await save(saveRequest('doc-id-owner', [cardPayload('foreign-id', 'foreign', 'answer')]));

    const request = saveRequest('doc-unowned-target', [
      cardPayload('foreign-id', 'collision without a local content match', 'answer'),
    ]);
    request.business_session_id = 'session-must-not-claim';
    await expect(save(request)).rejects.toMatchObject({
      error_type: 'Validation',
      message: expect.stringContaining('不属于当前文档'),
    });

    const row = db.one<{ task_count: number; claimed_count: number | null }>(
      `SELECT COUNT(*) AS task_count,
              SUM(CASE WHEN source_session_id IS NOT NULL THEN 1 ELSE 0 END) AS claimed_count
       FROM document_tasks
       WHERE document_id = 'doc-unowned-target'
         AND deleted_at IS NULL`,
    );
    expect(row.task_count).toBe(1);
    expect(row.claimed_count ?? 0).toBe(0);
  });

  it('tombstoned_real_id_is_a_full_failure_without_a_mapping', async () => {
    await save(saveRequest('doc-ghost', [cardPayload('deleted-real-id', 'old question', 'old answer')]));
    db.run("UPDATE anki_cards SET deleted_at = '2026-07-14T00:00:00Z' WHERE id = 'deleted-real-id'");

    await expect(save(saveRequest('doc-ghost', [cardPayload('deleted-real-id', 'new question', 'new answer')])))
      .rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('卡片 ID 不属于当前文档') });
    expect(liveCardCountForDocument('doc-ghost', 'deleted-real-id')).toBe(0);

    const row = db.one<{ front: string; back: string; deleted_at: string | null }>(
      "SELECT front, back, deleted_at FROM anki_cards WHERE id = 'deleted-real-id'",
    );
    expect(row.front).toBe('old question');
    expect(row.back).toBe('old answer');
    expect(row.deleted_at).not.toBeNull();
  });

  it('partial_save_returns_only_scoped_success_mappings_and_explicit_failures', async () => {
    await save(saveRequest('doc-other', [cardPayload('other-doc-id', 'other question', 'other answer')]));
    const response = await save(saveRequest('doc-partial', [
      cardPayload('partial-success-id', 'saved question', 'saved answer'),
      cardPayload('other-doc-id', 'collision question', 'collision answer'),
    ]));

    expect(response.savedIds).toEqual(['partial-success-id']);
    expect(response.duplicatedIds).toEqual([]);
    expect(response.skippedIds).toEqual([]);
    expect(response.failed).toHaveLength(1);
    expect(response.failed[0]?.id).toBe('other-doc-id');
    expect(response.failed[0]?.error).toContain('不属于当前文档');
    expect(response.cardIdMappings).toHaveLength(1);
    expect(response.cardIdMappings[0]?.inputIndex).toBe(0);
    expect(response.cardIdMappings[0]?.persistedId).toBe('partial-success-id');
    expect(liveCardCountForDocument('doc-partial', 'partial-success-id')).toBe(1);
    expect(liveCardCountForDocument('doc-partial', 'other-doc-id')).toBe(0);
    expect(liveCardCountForDocument('doc-other', 'other-doc-id')).toBe(1);
  });

  it('temporary_content_duplicate_maps_to_existing_persisted_id', async () => {
    await save(saveRequest('doc-content-dedup', [cardPayload('existing-real-id', 'same', 'content')]));
    const response = await save(saveRequest('doc-content-dedup', [
      cardPayload('anki_synthetic_duplicate', 'same', 'content'),
    ]));
    expect(response.cardIdMappings).toHaveLength(1);
    expect(response.cardIdMappings[0]?.persistedId).toBe('existing-real-id');
    expect(response.skippedIds).toHaveLength(1);
    expect(db.pluck<number>("SELECT COUNT(*) FROM anki_cards WHERE source_id = 'doc-content-dedup'")).toBe(1);
    expect(db.pluck<number>(
      `SELECT COUNT(*)
       FROM anki_cards ac
       INNER JOIN document_tasks dt ON dt.id = ac.task_id
       WHERE ac.id = ?1
         AND ac.deleted_at IS NULL
         AND dt.deleted_at IS NULL`,
      [response.cardIdMappings[0]!.persistedId],
    )).toBe(1);
  });

  it('save_outcome_accepts_all_skipped_without_failures', () => {
    expect(saveAnkiCardsOutcomeIsAcceptable({
      savedIds: [],
      taskId: 't1',
      cardIdMappings: [],
      skippedIds: ['ghost-1'],
      duplicatedIds: [],
      failed: [],
    })).toBe(true);
  });

  it('save_outcome_rejects_empty_with_failures_only', () => {
    expect(saveAnkiCardsOutcomeIsAcceptable({
      savedIds: [],
      taskId: 't1',
      cardIdMappings: [],
      skippedIds: [],
      duplicatedIds: [],
      failed: [{ id: 'x', error: 'boom' }],
    })).toBe(false);
  });

  it('save_response_serde_defaults_new_fields', async () => {
    const response = await save(saveRequest('doc-defaults', [cardPayload('defaults-id', 'front', 'back')]));
    expect(response.savedIds).toEqual(['defaults-id']);
    expect(typeof response.taskId).toBe('string');
    expect(response.skippedIds).toEqual([]);
    expect(response.duplicatedIds).toEqual([]);
    expect(response.failed).toEqual([]);
    expect(response.cardIdMappings).toEqual([
      { inputIndex: 0, inputId: 'defaults-id', persistedId: 'defaults-id' },
    ]);
  });

  it('save_response_serializes_camel_case', async () => {
    const response = await save(saveRequest('doc-camel', [cardPayload('anki_synthetic_1', 'f', 'b')]));
    expect(Object.keys(response).sort()).toEqual([
      'cardIdMappings',
      'duplicatedIds',
      'failed',
      'savedIds',
      'skippedIds',
      'taskId',
    ]);
    const value = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
    expect(Array.isArray(value.savedIds)).toBe(true);
    expect(typeof value.taskId).toBe('string');
    const mapping = (value.cardIdMappings as Record<string, unknown>[])[0]!;
    expect(mapping.inputIndex).toBe(0);
    expect(mapping.inputId).toBe('anki_synthetic_1');
    expect(typeof mapping.persistedId).toBe('string');
  });

  it('save_changed_payload_uses_persisted_ids_in_stable_deduplicated_order', () => {
    const payload = buildSaveAnkiCardsChangedPayload({
      savedIds: ['saved-1', 'shared', ''],
      taskId: 't1',
      cardIdMappings: [],
      skippedIds: ['skipped-1'],
      duplicatedIds: ['shared', 'duplicated-1'],
      failed: [{ id: 'failed-1', error: 'boom' }],
    });
    expect(payload).toEqual({
      source: 'user',
      action: 'cards_persisted',
      entityIds: ['saved-1', 'shared', 'duplicated-1'],
    });
  });

  it('save_changed_payload_skips_non_persisted_outcomes', () => {
    expect(buildSaveAnkiCardsChangedPayload({
      savedIds: [],
      taskId: 't1',
      cardIdMappings: [],
      skippedIds: ['skipped-1'],
      duplicatedIds: [],
      failed: [{ id: 'failed-1', error: 'boom' }],
    })).toBeNull();
  });
});
