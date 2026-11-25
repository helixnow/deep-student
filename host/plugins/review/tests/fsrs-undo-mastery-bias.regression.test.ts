import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import review from '../index.ts';
import {
  FsrsReviewService,
  applyMasteryBiasToOutcome,
  applyMasteryBiasToOutcomes,
  type ScheduleOutcome,
} from '../src/review.ts';
import { FSRS_PARAMS_VERSION, MS_PER_DAY } from '../src/fsrs-types.ts';
import { activeEventConcept } from '../repository/mastery.ts';
import { mistakesFixture } from './storage.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];

async function setupHost() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const vfs = fixture.storage.database('vfs');
  vfs.exec('CREATE TABLE __change_log (table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT)');
  for (const name of [
    'V20260718__add_mastery_tables.sql',
    'V20260719__mastery_events_signal.sql',
    'V20260720__mastery_events_sync.sql',
    'V20260909__mastery_events_insight_source.sql',
  ]) {
    vfs.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  }
  const host = await createTestHost({ plugins: [review], provide: { storage: fixture.storage } });
  hosts.push(host);
  return { ...fixture, vfs, host, service: new FsrsReviewService(fixture.db) };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function insertCard(
  db: ReturnType<typeof mistakesFixture>['db'],
  options: {
    documentId: string;
    taskId: string;
    cardId: string;
    docName?: string;
    tags?: string[];
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO document_tasks (
      id, document_id, original_document_name, segment_index,
      content_segment, status, anki_generation_options_json
    ) VALUES (?1, ?2, ?3, 0, 'segment', 'Completed', '{}')`,
    [options.taskId, options.documentId, options.docName ?? 'test.md'],
  );
  db.run(
    `INSERT INTO anki_cards (
      id, task_id, front, back, source_type, source_id, tags_json
    ) VALUES (?1, ?2, ?3, ?4, 'document', ?5, ?6)`,
    [
      options.cardId,
      options.taskId,
      `front-${options.cardId}`,
      `back-${options.cardId}`,
      options.documentId,
      JSON.stringify(options.tags ?? []),
    ],
  );
}

describe('G16 FSRS undo, mastery rollback, bias floor, and statistics regressions', () => {
  it('emits fsrs://changed only after mastery compensation and rolls back mastery_events cleanly on undo', async () => {
    const { db, vfs, host } = await setupHost();
    insertCard(db, {
      documentId: 'doc-atomic',
      taskId: 'task-atomic',
      cardId: 'card-atomic',
      tags: ['linear-algebra'],
    });
    const enqueued = await host.invoke<{ states: Array<{ id: string }> }>(
      'fsrs_enqueue_cards',
      { ankiCardIds: ['card-atomic'] },
    );
    const stateId = enqueued.states[0]!.id;

    let masteryPresentWhenChangedFired = false;
    const origEmit = host.ctx.backendEvents.emit.bind(host.ctx.backendEvents);
    host.ctx.backendEvents.emit = (event: string, payload: unknown) => {
      if (event === 'fsrs://changed' && (payload as { action?: string })?.action === 'rate') {
        const activeCount = Number(
          vfs.pluck(
            "SELECT COUNT(*) FROM mastery_events WHERE concept_key = 'linear-algebra' AND deleted_at IS NULL",
          ),
        );
        masteryPresentWhenChangedFired = activeCount === 1;
      }
      return origEmit(event, payload);
    };

    const opId = crypto.randomUUID();
    const rated = await host.invoke<{ logId: string }>('fsrs_rate', {
      cardStateId: stateId,
      rating: 3,
      durationMs: 250,
      clientOpId: opId,
    });
    expect(rated.logId).toBe(opId);
    expect(masteryPresentWhenChangedFired).toBe(true);
    expect(activeEventConcept(vfs, `me_fsrs_${opId}`)).toBe('linear-algebra');
    expect(host.ctx.mastery.getState('linear-algebra')).toMatchObject({ total: 1 });

    // Undo atomically reverts both FSRS state and SQLite mastery_events + mastery_states.
    const undone = await host.invoke<{ changed: boolean; undoneLogId: string; state: { reps: number; state: number } }>(
      'fsrs_undo_last_review',
      { expectedLogId: rated.logId, cardStateId: stateId },
    );
    expect(undone.changed).toBe(true);
    expect(undone.undoneLogId).toBe(rated.logId);
    expect(undone.state.reps).toBe(0);
    expect(undone.state.state).toBe(0);

    expect(activeEventConcept(vfs, `me_fsrs_${opId}`)).toBeNull();
    expect(
      Number(vfs.pluck("SELECT COUNT(*) FROM mastery_events WHERE concept_key = 'linear-algebra' AND deleted_at IS NULL")),
    ).toBe(0);
    expect(host.ctx.mastery.getState('linear-algebra')).toMatchObject({
      total: 0,
      wrongCount: 0,
      score: 0.5,
    });
    // Outbox revert flag must be cleared immediately.
    expect(
      Number(db.pluck('SELECT mastery_revert_pending FROM fsrs_review_logs WHERE id = ?1', [opId])),
    ).toBe(0);
  });

  it('keeps active mastery_events count aligned with net ratings (6 ratings minus 1 undo = 5)', async () => {
    const { db, vfs, host } = await setupHost();
    const cardIds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    for (const cardId of cardIds) {
      insertCard(db, {
        documentId: 'doc-net',
        taskId: 'task-net',
        cardId,
        tags: ['calculus'],
      });
    }
    const enqueued = await host.invoke<{ states: Array<{ id: string; ankiCardId: string }> }>(
      'fsrs_enqueue_cards',
      { ankiCardIds: cardIds },
    );
    let lastLogId = '';
    let lastStateId = '';
    for (const st of enqueued.states) {
      const rated = await host.invoke<{ logId: string }>('fsrs_rate', {
        cardStateId: st.id,
        rating: 3,
        durationMs: 120,
      });
      lastLogId = rated.logId;
      lastStateId = st.id;
    }
    expect(
      Number(vfs.pluck("SELECT COUNT(*) FROM mastery_events WHERE concept_key = 'calculus' AND deleted_at IS NULL")),
    ).toBe(6);

    await host.invoke('fsrs_undo_last_review', {
      expectedLogId: lastLogId,
      cardStateId: lastStateId,
    });

    expect(
      Number(vfs.pluck("SELECT COUNT(*) FROM mastery_events WHERE concept_key = 'calculus' AND deleted_at IS NULL")),
    ).toBe(5);
    expect(host.ctx.mastery.getState('calculus')?.total).toBe(5);
  });

  it('skips generic Chat Cards container names as concept tags and clears revert_pending on undo without ghost rows', async () => {
    const { db, vfs, host, service } = await setupHost();
    insertCard(db, {
      documentId: 'doc-chat',
      taskId: 'task-chat-zh',
      cardId: 'card-chat-1',
      docName: 'Chat Cards 未分类',
      tags: [],
    });
    insertCard(db, {
      documentId: 'doc-chat',
      taskId: 'task-chat-zh',
      cardId: 'card-chat-2',
      docName: 'Chat Cards 未分类',
      tags: [],
    });
    insertCard(db, {
      documentId: 'doc-chat-en',
      taskId: 'task-chat-en',
      cardId: 'card-chat-3',
      docName: 'Chat Cards Uncategorized',
      tags: [],
    });

    expect(service.getCardConceptTags('card-chat-1')).toEqual([]);
    expect(service.getCardConceptTags('card-chat-3')).toEqual([]);

    const enqueued = await host.invoke<{ states: Array<{ id: string; ankiCardId: string }> }>(
      'fsrs_enqueue_cards',
      { ankiCardIds: ['card-chat-1', 'card-chat-2'] },
    );
    const state1 = enqueued.states.find((s) => s.ankiCardId === 'card-chat-1')!.id;
    const state2 = enqueued.states.find((s) => s.ankiCardId === 'card-chat-2')!.id;

    // Preview Easy on card-chat-2 before any rating.
    const beforePreview = await host.invoke<{ intervals: Array<{ rating: number; scheduledDays: number }> }>(
      'fsrs_preview_intervals',
      { cardStateId: state2 },
    );
    const easyBefore = beforePreview.intervals.find((i) => i.rating === 4)!.scheduledDays;

    // Rate card-chat-1 Again 3 times; must NOT create shared "Chat Cards 未分类" mastery pollution.
    let lastLog = '';
    for (let i = 0; i < 3; i++) {
      const rated = await host.invoke<{ logId: string }>('fsrs_rate', {
        cardStateId: state1,
        rating: 1,
      });
      lastLog = rated.logId;
    }

    expect(Number(vfs.pluck('SELECT COUNT(*) FROM mastery_events'))).toBe(0);
    const afterPreview = await host.invoke<{ intervals: Array<{ rating: number; scheduledDays: number }> }>(
      'fsrs_preview_intervals',
      { cardStateId: state2 },
    );
    const easyAfter = afterPreview.intervals.find((i) => i.rating === 4)!.scheduledDays;
    expect(easyAfter).toBe(easyBefore);
    expect(easyAfter).toBeGreaterThanOrEqual(1);

    // Undoing the tagless card clears mastery_revert_pending immediately instead of looping forever.
    await host.invoke('fsrs_undo_last_review', { expectedLogId: lastLog, cardStateId: state1 });
    expect(
      Number(db.pluck('SELECT mastery_revert_pending FROM fsrs_review_logs WHERE id = ?1', [lastLog])),
    ).toBe(0);
  });

  it('preserves undoability across ensureMemoryStatesCurrent and fsrsParams recompute while still rejecting post-rating suspend', async () => {
    const { db, service } = await setupHost();
    insertCard(db, { documentId: 'doc-recomp', taskId: 'task-recomp', cardId: 'card-recomp', tags: ['physics'] });
    insertCard(db, { documentId: 'doc-susp', taskId: 'task-susp', cardId: 'card-susp', tags: ['physics'] });
    const [stateRecomp, stateSusp] = service.enqueueCards(['card-recomp', 'card-susp']).states.map((s) => s.id);

    const ratedRecomp = service.rate(stateRecomp!, 3, 100, null);
    const ratedSusp = service.rate(stateSusp!, 3, 100, null);
    service.suspendCard(stateSusp!);

    // Force ensureMemoryStatesCurrent to recompute stability/difficulty and bump updated_at.
    db.run("UPDATE fsrs_card_states SET stability = 99.0 WHERE id = ?1", [stateRecomp!]);
    db.run("UPDATE anki_decks SET config_json = '{}' WHERE id = 'deck_default'");
    expect(service.ensureMemoryStatesCurrent()).toBeGreaterThanOrEqual(1);
    expect(db.pluck<string>("SELECT json_extract(config_json, '$.memory_state_version') FROM anki_decks WHERE id = 'deck_default'"))
      .toBe(FSRS_PARAMS_VERSION);

    // Undo on the recomputed card must still succeed!
    const undone = service.undoLastReview(ratedRecomp.logId, stateRecomp!);
    expect(undone.changed).toBe(true);
    expect(undone.state.reps).toBe(0);

    // Undo on the post-rating suspended card must STILL reject with Conflict!
    expect(() => service.undoLastReview(ratedSusp.logId, stateSusp!)).toThrow();
  });

  it('clears revert_pending immediately when undoing an unsynced rating and never inserts a ghost mastery event later', async () => {
    const { db, vfs, host } = await setupHost();
    insertCard(db, {
      documentId: 'doc-unsynced',
      taskId: 'task-unsynced',
      cardId: 'card-unsynced',
      tags: ['organic-chem'],
    });
    const stateId = (await host.invoke<{ states: Array<{ id: string }> }>(
      'fsrs_enqueue_cards',
      { ankiCardIds: ['card-unsynced'] },
    )).states[0]!.id;

    // Simulate mastery write outage during rate so mastery_synced_at stays NULL.
    vfs.exec('ALTER TABLE mastery_events RENAME TO mastery_events_offline');
    const rated = await host.invoke<{ logId: string }>('fsrs_rate', {
      cardStateId: stateId,
      rating: 3,
    });
    expect(db.pluck('SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = ?1', [rated.logId])).toBeNull();

    // Bring mastery_events back online, then undo before any compensation runs.
    vfs.exec('ALTER TABLE mastery_events_offline RENAME TO mastery_events');
    await host.invoke('fsrs_undo_last_review', { expectedLogId: rated.logId, cardStateId: stateId });

    // Revert pending is cleared immediately and subsequent get_due/rate never writes a ghost event.
    expect(Number(db.pluck('SELECT mastery_revert_pending FROM fsrs_review_logs WHERE id = ?1', [rated.logId]))).toBe(0);
    await host.invoke('fsrs_get_due', {});
    expect(Number(vfs.pluck('SELECT COUNT(*) FROM mastery_events WHERE id = ?1', [`me_fsrs_${rated.logId}`]))).toBe(0);
  });

  it('enforces >= 1d floor on graduated Review outcomes and Again <= Hard <= Good < Easy monotonicity under low mastery', () => {
    const now = 1_700_000_000_000;
    const makeReviewOutcome = (days: number): ScheduleOutcome => ({
      state: 2,
      stability: days,
      difficulty: 5,
      scheduledDays: days,
      elapsedDays: 1,
      dueMs: now + days * MS_PER_DAY,
      reps: 2,
      lapses: 0,
      learningStep: 0,
    });

    // Single graduated outcome of 1d must NOT collapse below 1d (0d) at masteryScore = 0.0
    const oneDay = makeReviewOutcome(1);
    applyMasteryBiasToOutcome(oneDay, 0.0, now);
    expect(oneDay.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(oneDay.dueMs).toBeGreaterThanOrEqual(now + MS_PER_DAY);

    // Monotonicity across [Again(10m learning), Hard(1d), Good(2d), Easy(3d)] at masteryScore = 0.0
    const shortOutcomes: ScheduleOutcome[] = [
      {
        state: 3, stability: 0.5, difficulty: 7, scheduledDays: 0, elapsedDays: 1,
        dueMs: now + 10 * 60_000, reps: 2, lapses: 1, learningStep: 0,
      },
      makeReviewOutcome(1),
      makeReviewOutcome(2),
      makeReviewOutcome(3),
    ];
    applyMasteryBiasToOutcomes(shortOutcomes, 0.0, now);
    expect(shortOutcomes[1]!.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(shortOutcomes[2]!.dueMs).toBeGreaterThanOrEqual(shortOutcomes[1]!.dueMs + MS_PER_DAY);
    expect(shortOutcomes[3]!.dueMs).toBeGreaterThanOrEqual(shortOutcomes[2]!.dueMs + MS_PER_DAY);
    expect(shortOutcomes[3]!.scheduledDays).toBeGreaterThan(shortOutcomes[2]!.scheduledDays);

    // Medium intervals [Again(10m), Hard(5d), Good(6d), Easy(7d)] still advance but stay strictly separated by >= 1d
    const mediumOutcomes: ScheduleOutcome[] = [
      {
        state: 3, stability: 1, difficulty: 6, scheduledDays: 0, elapsedDays: 5,
        dueMs: now + 10 * 60_000, reps: 3, lapses: 1, learningStep: 0,
      },
      makeReviewOutcome(5),
      makeReviewOutcome(6),
      makeReviewOutcome(7),
    ];
    applyMasteryBiasToOutcomes(mediumOutcomes, 0.0, now);
    expect(mediumOutcomes[1]!.scheduledDays).toBe(3);
    expect(mediumOutcomes[2]!.scheduledDays).toBe(4);
    expect(mediumOutcomes[3]!.scheduledDays).toBe(5);
    expect(mediumOutcomes[3]!.dueMs - mediumOutcomes[2]!.dueMs).toBeGreaterThanOrEqual(MS_PER_DAY);
  });

  it('exposes learningReviewsToday in getReviewStatistics to reconcile reviewsToday with empty trueRetention', async () => {
    const { db, service } = await setupHost();
    for (let i = 0; i < 6; i++) {
      insertCard(db, {
        documentId: 'doc-learn',
        taskId: 'task-learn',
        cardId: `card-learn-${i}`,
        tags: ['bio'],
      });
    }
    const states = service.enqueueCards(Array.from({ length: 6 }, (_, i) => `card-learn-${i}`)).states;
    for (const st of states) {
      service.rate(st.id, 3, 1000, null);
    }

    const stats = service.getStats();
    expect(stats.reviewsToday).toBe(6);

    const reviewStats = service.getReviewStatistics(30) as ReturnType<FsrsReviewService['getReviewStatistics']> & {
      learningReviewsToday?: number;
    };
    expect(reviewStats.learningReviewsToday).toBe(6);
    const todayRetention = reviewStats.trueRetention.find((row) => row.period === 'today')!;
    expect(todayRetention.youngReviews + todayRetention.matureReviews).toBe(0);
  });
});
