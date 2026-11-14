/**
 * Candidate-only evidence: drive this lane's production `chatanki_delete_card`
 * through the *real* L16 `anki.cards` repository and the real L15 transaction
 * owner exposed by the `ds-mig/L16-anki` candidate.
 *
 * `host/plugins/anki/src/chatanki-service-adapters.ts` does not exist on main,
 * so the suite skips there. The temp-worktree recipe is in
 * `tests/candidates/README.md`; the provider commit/blob hashes are pinned
 * there. This is not a TESTMAP `ported` row: main owns the final integration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../../kernel/testing.ts';
import { createStorageService } from '../../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../../platform/storage/api.ts';
import anki from '../../../anki/index.ts';
import review from '../../../review/index.ts';
import chatanki from '../../index.ts';
import type {
  ChatAnkiChatBlockStore, ToolCall, ToolExecutionContext, ToolResultInfo,
} from '../../api.ts';

const candidateAvailable = existsSync(
  path.join(process.cwd(), 'host/plugins/anki/src/chatanki-service-adapters.ts'),
);

const SESSION = 'session-l16-cas';
const DOCUMENT = 'doc-l16-cas';
const TASK = 'task-l16-cas';
const CARD = 'card-l16-cas';
const LARGE = 2 ** 63 - 1024;

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

/** Minimal UI-sync double: the candidate proves the L16 card transaction. */
function emptyBlocks(): ChatAnkiChatBlockStore {
  return {
    listSessionBlocks: () => [],
    getBlock: () => null,
    updateBlock: () => undefined,
    upsertBlock: () => undefined,
  };
}

function makeCard(id: string): Record<string, unknown> {
  return {
    id,
    front: 'front',
    back: 'back',
    text: null,
    tags: [],
    images: [],
    task_id: TASK,
    is_error_card: false,
    error_content: null,
    created_at: '2026-11-04T00:00:00Z',
    updated_at: '2026-11-04T00:00:00Z',
    extra_fields: {},
    template_id: null,
  };
}

describe.skipIf(!candidateAvailable)('L16 real deleteCard CAS through chatanki_delete_card (candidate)', () => {
  let dir: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let db: DatabaseHandle;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-l16-cas-'));
    storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
    const migration = await storage.migrations.runAll();
    expect(migration.success).toBe(true);
    host = await createTestHost({
      app: { dataDir: dir },
      plugins: [review, anki, chatanki],
      provide: {
        paths: {
          appDataDir: dir,
          os: { home: dir, data: dir, temp: os.tmpdir() },
        },
        settings: {
          get: () => null,
          save: () => undefined,
          getSetting: () => null,
          saveSetting: () => undefined,
        },
        llm: {},
        storage,
      },
    });
    db = storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    if (host !== undefined) await host.dispose();
    storage?.dispose();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.run('DELETE FROM fsrs_review_logs');
    db.run('DELETE FROM fsrs_card_states');
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
    db.run('DELETE FROM settings');
    db.run(
      `INSERT INTO document_tasks
         (id, document_id, original_document_name, segment_index, content_segment,
          status, created_at, updated_at, error_message, anki_generation_options_json,
          source_session_id)
       VALUES (?1, ?2, 'l16.md', 0, 'segment', 'Completed',
               '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z', NULL, '{}', ?3)`,
      [TASK, DOCUMENT, SESSION],
    );
    const cards = (host.ctx.anki as unknown as {
      cards: {
        insertCardsForDocument(
          documentId: string, sessionId: string, cards: readonly Record<string, unknown>[],
        ): Array<{ id: string; updated_at: string }>;
        getCardWithDocument(cardId: string): { card: { id: string; updated_at: string } } | null;
      };
    }).cards;
    const inserted = cards.insertCardsForDocument(DOCUMENT, SESSION, [makeCard(CARD)]);
    expect(inserted.map((card) => card.id)).toEqual([CARD]);
  });

  function context(): ToolExecutionContext {
    return {
      sessionId: SESSION,
      messageId: 'message-l16-cas',
      blockId: 'block-l16-cas',
      chatBlocks: emptyBlocks(),
      runId: 'run-l16-cas',
      emitToolCallStart: () => undefined,
      emitToolCallEnd: () => undefined,
      emitToolCallError: () => undefined,
      saveToolBlock: () => undefined,
      warn: () => undefined,
    };
  }

  function currentVersion(): string {
    const cards = (host.ctx.anki as unknown as {
      cards: {
        getCardWithDocument(cardId: string): { card: { id: string; updated_at: string } } | null;
      };
    }).cards;
    const located = cards.getCardWithDocument(CARD);
    if (located === null) throw new Error('candidate L16 card missing');
    return located.card.updated_at;
  }

  async function executeDelete(args: Record<string, unknown>): Promise<ToolResultInfo> {
    // Go through the published service so `hydrate` wires the real L16 `cards` /
    // `documents` and L15 `reviewStates` instead of a context double.
    return host.ctx.chatankiTools.execute(
      call('chatanki_delete_card', args), context(),
    );
  }

  it('deletes the live card and its FSRS rows through the real L16 repository', async () => {
    const result = await executeDelete({
      cardId: CARD, expectedVersion: currentVersion(), expectedReviewVersion: null,
    });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.deleted).toBe(true);
    expect(output.mutationApplied).toBe(true);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', [CARD])).toBe(0);
  });

  it('returns a content-version conflict without deleting the L16 row', async () => {
    const stale = currentVersion();
    const cards = (host.ctx.anki as unknown as {
      cards: {
        updateCardIfVersionForSession(
          card: Record<string, unknown>, expectedVersion: string, sessionId: string,
        ): { kind: string; card?: { updated_at: string } };
        getCardWithDocument(cardId: string): { card: Record<string, unknown> } | null;
      };
    }).cards;
    const current = cards.getCardWithDocument(CARD)!.card;
    const updated = cards.updateCardIfVersionForSession(
      { ...current, front: 'changed' }, stale, SESSION,
    );
    expect(updated.kind).toBe('updated');

    const result = await executeDelete({
      cardId: CARD, expectedVersion: stale, expectedReviewVersion: null,
    });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('conflict');
    expect(output.error).toBe('version_conflict');
    // Rust `chatanki_version_conflict_payload` has no mutationApplied key;
    // the card row is the source of truth for the failed write.
    expect(output.retryable).toBe(true);
    expect(db.pluck<string>('SELECT front FROM anki_cards WHERE id = ?1', [CARD])).toBe('changed');
  });

  it('blocks delete on a missing/stale review version and deletes with the current token', async () => {
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at, local_version)
       VALUES ('state-l16-cas', ?1, 0, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z', 1)`,
      [CARD],
    );
    const blocked = await executeDelete({
      cardId: CARD, expectedVersion: currentVersion(), expectedReviewVersion: 0,
    });
    expect(blocked.success).toBe(true);
    const blockedOutput = blocked.output as Record<string, unknown>;
    expect(blockedOutput.status).toBe('conflict');
    expect(blockedOutput.error).toBe('review_state_conflict');
    expect(blockedOutput.mutationApplied).toBe(false);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', [CARD])).toBe(1);

    const deleted = await executeDelete({
      cardId: CARD, expectedVersion: currentVersion(), expectedReviewVersion: 1,
    });
    expect(deleted.success).toBe(true);
    expect((deleted.output as Record<string, unknown>).deleted).toBe(true);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', [CARD])).toBe(0);
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', [CARD],
    )).toBe(0);
  });

  it('accepts an exactly representable large i64 review version without a safe-integer gate', async () => {
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at, local_version)
       VALUES ('state-l16-large', ?1, 0, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z', ?2)`,
      [CARD, LARGE],
    );
    const result = await executeDelete({
      cardId: CARD, expectedVersion: currentVersion(), expectedReviewVersion: LARGE,
    });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.deleted).toBe(true);
    expect(output.mutationApplied).toBe(true);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', [CARD])).toBe(0);
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', [CARD],
    )).toBe(0);
  });
});
