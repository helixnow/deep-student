import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { AnkiAgentLibraryPageRequest } from '../api.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const NOW = '2026-11-05T00:00:00+00:00';

describe('database/mod.rs::list_anki_agent_library_cards via real owner', () => {
  let env: AnkiTestEnv;
  beforeAll(async () => { env = await createAnkiTestEnv(); }, 120_000);
  afterAll(async () => { await env.dispose(); }, 120_000);
  beforeEach(() => {
    const db = env.storage.database('mistakes');
    db.run('DELETE FROM fsrs_review_logs');
    db.run('DELETE FROM fsrs_card_states');
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
  });

  function seed(id: string, session: string | null = null, error = false): AnkiCard {
    const db = env.storage.database('mistakes');
    db.run(`INSERT INTO document_tasks
      (id,document_id,original_document_name,segment_index,content_segment,status,
       created_at,updated_at,anki_generation_options_json,source_session_id)
      VALUES (?1,?2,'agent.md',0,'body','Completed',?3,?3,'{}',?4)`,
    [`task-${id}`, `doc-${id}`, NOW, session]);
    const card: AnkiCard = {
      id, task_id: `task-${id}`, front: `front ${id}`, back: `back ${id}`, text: null,
      tags: ['library-agent'], images: [], is_error_card: error, error_content: error ? 'diagnostic' : null,
      created_at: NOW, updated_at: NOW, extra_fields: {}, template_id: null,
    };
    expect(env.host.ctx.anki.insertAnkiCard(card)).toBe(true);
    return card;
  }

  const page = (request: AnkiAgentLibraryPageRequest = {}, now: number | bigint = Date.now()) =>
    env.host.ctx.anki.listAnkiAgentLibraryPage(request, now);
  const ids = (request: AnkiAgentLibraryPageRequest = {}) =>
    page(request).items.map((record) => record.libraryCard.id);

  it('agent_library_reads_and_content_cas_cover_null_and_foreign_sessions: page locator and read scope do not widen writes', () => {
    seed('card-null');
    const foreign = seed('card-foreign', 'session-foreign');
    const result = page({ search: 'library-agent', pageSize: 100 });
    expect(result).toMatchObject({ page: 1, pageSize: 20, total: 2n });
    expect(result.items).toHaveLength(2);
    expect(result.items.find((r) => r.libraryCard.id === 'card-null')?.locator)
      .toEqual({ documentId: 'doc-card-null', sourceSessionId: null });
    expect(result.items.find((r) => r.libraryCard.id === 'card-foreign')?.locator)
      .toEqual({ documentId: 'doc-card-foreign', sourceSessionId: 'session-foreign' });
    expect(env.host.ctx.anki.cards.updateCardIfVersionForSession(
      { ...foreign, front: 'forbidden' }, NOW, 'session-owner',
    )).toEqual({ kind: 'notFound' });
    expect(page().items.find((r) => r.libraryCard.id === foreign.id)?.libraryCard.front).toBe(foreign.front);
  });

  it('C3 agent due includes live new state while enqueued excludes cards without a live state; UI stays unchanged', () => {
    seed('new'); seed('plain'); seed('error', null, true); seed('suspended'); seed('state-deleted');
    expect(env.host.ctx.review.enqueueCards(['new', 'suspended', 'state-deleted']).enqueued).toBe(3);
    const db = env.storage.database('mistakes');
    db.run('UPDATE fsrs_card_states SET due_ms = 0');
    db.run("UPDATE fsrs_card_states SET suspended = 1 WHERE anki_card_id = 'suspended'");
    db.run("UPDATE fsrs_card_states SET deleted_at = ?1 WHERE anki_card_id = 'state-deleted'", [NOW]);
    expect(ids({ schedule: 'due' })).toEqual(['new']);
    expect(ids({ schedule: 'enqueued' })).toEqual(['suspended', 'new']);
    expect(ids({ schedule: 'suspended' })).toEqual(['suspended']);
    expect(ids({ schedule: 'not_enqueued' })).toEqual(['state-deleted', 'plain', 'error']);
    const due = page({ schedule: 'due' }).items[0]!.libraryCard;
    expect(due).toMatchObject({ state: 0, dueMs: 0n, enqueued: true, isDue: true });
    expect(env.host.ctx.anki.listAnkiAgentLibraryCards({ filter: { status: 'due' } }).items).toEqual([]);
  });

  it('ErrorOnly filters before COUNT and OFFSET with created DESC/id DESC and cap20, preserving old cap200', () => {
    for (let i = 0; i < 25; i++) seed(`normal-${String(i).padStart(2, '0')}`);
    for (let i = 0; i < 3; i++) seed(`error-${i}`, null, true);
    const first = page({ diagnostic: 'error_only', pageSize: 1, page: 0 });
    expect(first).toMatchObject({ total: 3n, page: 1, pageSize: 1 });
    expect(first.items.map((r) => r.libraryCard.id)).toEqual(['error-2']);
    expect(ids({ diagnostic: 'error_only', pageSize: 1, page: 2 })).toEqual(['error-1']);
    env.storage.database('mistakes').run(
      "UPDATE anki_cards SET created_at = '2026-11-06T00:00:00+00:00' WHERE id = 'error-0'",
    );
    expect(ids({ diagnostic: 'error_only' })).toEqual(['error-0', 'error-2', 'error-1']);
    expect(page({ page: 0, pageSize: 0 })).toMatchObject({ page: 1, pageSize: 1, total: 28n });
    expect(page({ pageSize: 0xffff_ffff })).toMatchObject({ pageSize: 20, total: 28n });
    expect(page({ pageSize: 100 }).items).toHaveLength(20);
    expect(page({ page: 0xffff_ffff, pageSize: 20 }).items).toEqual([]);
    expect(env.host.ctx.anki.listAnkiAgentLibraryCards({ pageSize: 200 }).items).toHaveLength(28);
  });

  it('keeps locator raw but filters blank library source fields and excludes card/task tombstones', () => {
    seed('raw', ' \u0085 '); seed('card-deleted'); seed('task-deleted');
    const db = env.storage.database('mistakes');
    db.run("UPDATE anki_cards SET source_type = ?1, source_id = 'not-the-document' WHERE id = 'raw'", ['\u0085']);
    db.run("UPDATE anki_cards SET deleted_at = ?1 WHERE id = 'card-deleted'", [NOW]);
    db.run("UPDATE document_tasks SET deleted_at = ?1 WHERE id = 'task-task-deleted'", [NOW]);
    const result = page();
    expect(result.total).toBe(1n);
    expect(result.items[0]).toMatchObject({
      locator: { documentId: 'doc-raw', sourceSessionId: ' \u0085 ' },
      libraryCard: { sourceSessionId: null, sourceType: null, sourceId: 'not-the-document', sourceRef: null },
    });
  });

  it('trims Rust whitespace and escapes LIKE wildcards before global filtering', () => {
    seed('literal'); seed('other');
    const db = env.storage.database('mistakes');
    db.run("UPDATE anki_cards SET front = 'literal %_\\ term', template_id = 'tpl' WHERE id = 'literal'");
    expect(ids({ search: '\u0085 %_\\ \u0085', templateId: '\u0085 tpl \u0085' })).toEqual(['literal']);
    expect(page({ search: '\u0085', templateId: '\u0085' }).total).toBe(2n);
    expect(ids({ search: '\uFEFFliteral' })).toEqual([]);
  });

  it('reads exact due i64 and COUNT bigint at the storage boundary with no page-time lookup', () => {
    seed('exact');
    expect(env.host.ctx.review.enqueueCards(['exact']).enqueued).toBe(1);
    const db = env.storage.database('mistakes');
    const due = 9_007_199_254_740_993n;
    db.run("UPDATE fsrs_card_states SET due_ms = ?1 WHERE anki_card_id = 'exact'", [due]);
    const count = vi.spyOn(db, 'one');
    const get = vi.spyOn(db, 'get');
    try {
      expect(page({ schedule: 'due' }, due - 1n)).toMatchObject({ total: 0n, items: [] });
      const result = page({ schedule: 'due' }, due);
      expect(result.total).toBe(1n);
      expect(result.items[0]?.libraryCard).toMatchObject({ dueMs: due, isDue: true });
      expect(count.mock.results).toHaveLength(2);
      for (const result of count.mock.results) {
        expect(result.type).toBe('return');
        const value: unknown = result.value;
        if (value === null || typeof value !== 'object' || !('total' in value)) {
          throw new Error('COUNT did not return its real storage row');
        }
        expect(typeof value.total).toBe('bigint');
      }
      expect(get).not.toHaveBeenCalled();
      for (const endpoint of [-(1n << 63n), (1n << 63n) - 1n]) {
        db.run("UPDATE fsrs_card_states SET due_ms = ?1 WHERE anki_card_id = 'exact'", [endpoint]);
        expect(page({ schedule: 'due' }, endpoint).items[0]?.libraryCard.dueMs).toBe(endpoint);
      }
    } finally { count.mockRestore(); get.mockRestore(); }
  });

  it('propagates COUNT failure before page SELECT without emitting events or writing', () => {
    const db = env.storage.database('mistakes');
    const events = env.host.events.length;
    const all = vi.spyOn(db, 'all');
    db.run('ALTER TABLE anki_cards RENAME TO agent_unavailable_cards');
    try {
      expect(() => page()).toThrow('no such table: anki_cards');
      expect(all).not.toHaveBeenCalled();
      expect(env.host.events).toHaveLength(events);
    } finally {
      db.run('ALTER TABLE agent_unavailable_cards RENAME TO anki_cards');
      all.mockRestore();
    }
  });

  it('rejects non-integer due storage with the Rust column error instead of coercing text', () => {
    seed('bad-due');
    expect(env.host.ctx.review.enqueueCards(['bad-due']).enqueued).toBe(1);
    env.storage.database('mistakes').run(
      "UPDATE fsrs_card_states SET due_ms = 'not-an-integer' WHERE anki_card_id = 'bad-due'",
    );
    expect(() => page()).toThrow('Invalid column type Text at index: 17, name: due_ms');
  });
});
