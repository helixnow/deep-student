/**
 * L16 owner seam for L17 `execute_srs_projection`
 * (`dstu-research/src/insight/jobs.rs:646-729`), exercised through the real
 * `ctx.anki` service on a migrated `mistakes` database.
 */
import { afterEach, expect, it } from 'vitest';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

let env: AnkiTestEnv | undefined;
afterEach(async () => {
  await env?.dispose();
  env = undefined;
});

const taskId = 'task_insight_ins1';
const cardId = 'ac_insight_ins1';

it('execute_srs_projection: owner seam upserts the synthetic task and inserts then updates the card in place', async () => {
  env = await createAnkiTestEnv();
  const anki = env.host.ctx.anki;
  const db = env.storage.database('mistakes');

  anki.upsertInsightProjectionTaskWithConn(db, {
    taskId, documentId: 'insight:ins1', originalDocumentName: 'T1', contentSegment: 'rule-1', now: 'N1',
  });
  expect(anki.writeInsightProjectionCardWithConn(db, {
    cardId, taskId, front: 'F1', back: 'B1', sourceId: 'ins1', now: 'N1',
  })).toBe('inserted');

  expect(db.get<{ document_id: string; original_document_name: string; content_segment: string; status: string;
    segment_index: number; created_at: string; updated_at: string; anki_generation_options_json: string }>(
    'SELECT * FROM document_tasks WHERE id = ?1', [taskId],
  )).toMatchObject({
    document_id: 'insight:ins1', original_document_name: 'T1', content_segment: 'rule-1', status: 'Completed',
    segment_index: 0, created_at: 'N1', updated_at: 'N1', anki_generation_options_json: '{}',
  });
  expect(db.get<Record<string, unknown>>('SELECT * FROM anki_cards WHERE id = ?1', [cardId])).toMatchObject({
    task_id: taskId, front: 'F1', back: 'B1', tags_json: '[]', source_type: 'inspiration', source_id: 'ins1',
    created_at: 'N1', updated_at: 'N1', deleted_at: null,
  });

  // Tombstone then re-project: update clears deleted_at, keeps created_at and FSRS state.
  anki.tombstoneInsightProjectionCardWithConn(db, cardId, 'N2');
  expect(db.get<{ deleted_at: string; updated_at: string }>(
    'SELECT deleted_at, updated_at FROM anki_cards WHERE id = ?1', [cardId],
  )).toEqual({ deleted_at: 'N2', updated_at: 'N2' });

  db.run(
    `INSERT INTO fsrs_card_states (id, anki_card_id, state, due_ms, created_at, updated_at)
     VALUES ('fsrs-ins1', ?1, 2, 1, 'N2', 'N2')`,
    [cardId],
  );
  anki.upsertInsightProjectionTaskWithConn(db, {
    taskId, documentId: 'insight:ins1', originalDocumentName: 'T2', contentSegment: 'rule-2', now: 'N3',
  });
  expect(anki.writeInsightProjectionCardWithConn(db, {
    cardId, taskId, front: 'F2', back: 'B2', sourceId: 'ins1', now: 'N3',
  })).toBe('updated');

  expect(db.get<Record<string, unknown>>(
    'SELECT original_document_name, content_segment, created_at, updated_at FROM document_tasks WHERE id = ?1',
    [taskId],
  )).toEqual({ original_document_name: 'T2', content_segment: 'rule-2', created_at: 'N1', updated_at: 'N3' });
  expect(db.get<Record<string, unknown>>(
    'SELECT front, back, created_at, updated_at, deleted_at FROM anki_cards WHERE id = ?1', [cardId],
  )).toEqual({ front: 'F2', back: 'B2', created_at: 'N1', updated_at: 'N3', deleted_at: null });
  expect(db.get<{ state: number }>('SELECT state FROM fsrs_card_states WHERE anki_card_id = ?1', [cardId]))
    .toEqual({ state: 2 });
}, 60_000);

it('execute_srs_projection: tombstone of a never-projected card is a no-op update', async () => {
  env = await createAnkiTestEnv();
  const db = env.storage.database('mistakes');
  env.host.ctx.anki.tombstoneInsightProjectionCardWithConn(db, 'ac_insight_missing', 'N1');
  expect(db.get('SELECT 1 FROM anki_cards WHERE id = ?1', ['ac_insight_missing'])).toBeUndefined();
}, 60_000);
