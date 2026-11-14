/** L15-V2-S4 / D3：复习 CAS 版本在内部保持 i64 精度，仅 IPC 出站投影为 number。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentReviewStateSnapshot } from '../api.ts';
import { buildAnkiLibraryListResponse } from '../src/library.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const EXACT = 9_007_199_254_740_993n;
const I64_MAX = 9_223_372_036_854_775_807n;
const NOW = '2026-11-04T00:00:00+00:00';

function seed(env: AnkiTestEnv, cardId: string, version: bigint): void {
  const db = env.storage.database('mistakes');
  db.run(`INSERT INTO document_tasks
    (id, document_id, original_document_name, segment_index, content_segment, status,
     source_session_id, created_at, updated_at, anki_generation_options_json)
    VALUES (?1, ?2, 'D', 0, 'S', 'Completed', 'session-i64', ?3, ?3, '{}')`,
  [`task-${cardId}`, `doc-${cardId}`, NOW]);
  db.run(`INSERT INTO anki_cards (id, task_id, front, back, created_at, updated_at)
    VALUES (?1, ?2, ?4, 'A', ?3, ?3)`, [cardId, `task-${cardId}`, NOW, `Q-${cardId}`]);
  db.run(`INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, local_version, created_at, updated_at)
    VALUES (?1, ?2, 0, ?3, ?4, ?4)`, [`state-${cardId}`, cardId, version, NOW]);
}

describe('anki service library/session delete CAS keeps exact i64', () => {
  let env: AnkiTestEnv;
  beforeAll(async () => { env = await createAnkiTestEnv(); });
  afterAll(async () => { await env.dispose(); });

  it.each(['library', 'session'] as const)('%s: adjacent integers above 2^53 conflict, exact token deletes', (kind) => {
    const cardId = `card-${kind}`;
    seed(env, cardId, EXACT);
    const anki = env.host.ctx.anki;
    const remove = (version: number | bigint) => kind === 'library'
      ? anki.deleteAnkiCardForLibrary(cardId, NOW, version)
      : anki.cards.deleteCardForSession(cardId, NOW, version, 'session-i64');
    expect(remove(EXACT - 1n)).toMatchObject({
      ...(kind === 'library' ? { type: 'reviewConflict' } : { kind: 'reviewConflict' }),
      review: { reviewVersion: EXACT },
    });
    expect(env.storage.database('mistakes').pluck('SELECT id FROM anki_cards WHERE id = ?1', [cardId]))
      .toBe(cardId);
    expect(env.storage.database('mistakes').pluck(
      'SELECT CAST(local_version AS TEXT) FROM fsrs_card_states WHERE anki_card_id = ?1', [cardId],
    )).toBe('9007199254740993');
    expect(remove(EXACT)).toMatchObject(kind === 'library' ? { type: 'deleted' } : { kind: 'deleted' });
  });

  it('accepts i64::MAX and integer number inputs above MAX_SAFE, rejects outside i64 before writing', () => {
    seed(env, 'card-max', I64_MAX);
    seed(env, 'card-number', EXACT - 1n);
    const anki = env.host.ctx.anki;
    expect(() => anki.deleteAnkiCardForLibrary('card-max', NOW, I64_MAX + 1n))
      .toThrow('expectedReviewVersion must be a non-negative integer or null');
    expect(() => anki.cards.deleteCardForSession('card-max', NOW, I64_MAX + 1n, 'session-i64'))
      .toThrow('expectedReviewVersion must be a non-negative integer or null');
    expect(anki.deleteAnkiCardForLibrary('card-max', NOW, I64_MAX)).toMatchObject({ type: 'deleted' });
    expect(anki.deleteAnkiCardForLibrary('card-number', NOW, 9_007_199_254_740_992))
      .toMatchObject({ type: 'deleted' });
  });

  it('conflict snapshots preserve signed i64::MIN without clamping', () => {
    const minimum = -(1n << 63n);
    seed(env, 'card-min', minimum);
    expect(env.host.ctx.anki.deleteAnkiCardForLibrary('card-min', NOW, 0)).toMatchObject({
      type: 'reviewConflict', review: { reviewVersion: minimum },
    });
  });
});

it('list_anki_library_cards retains the owner bigint snapshot internally, then kernel projects the IPC result', async () => {
  // L15 的已发布快照协议；只替换外部 owner 读取，不替换 L16 命令或列表/响应构建。
  const snapshot: AgentReviewStateSnapshot = {
    ankiCardId: 'card-wire', cardStateId: 'state-card-wire', state: 0,
    suspended: false, dueMs: 0, lastReviewMs: null, reviewVersion: EXACT, latestReview: null,
  };
  const env = await createAnkiTestEnv({
    withReview: false,
    provide: { review: { getReviewStatesForLibrary: () => [snapshot] } },
  });
  try {
    seed(env, 'card-wire', EXACT);
    const listing = env.host.ctx.anki.listAnkiAgentLibraryCards({ page: 1, pageSize: 12 });
    const internal = buildAnkiLibraryListResponse(listing.items, 1, 12, listing.total, [snapshot]);
    expect(internal.items[0]?.reviewVersion).toBe(EXACT);
    const wire = await env.host.invoke<{ items: { reviewVersion: number }[] }>('list_anki_library_cards', {
      request: { page: 1, pageSize: 12 },
    });
    expect(wire.items[0]?.reviewVersion).toBe(9_007_199_254_740_992);
    expect(typeof wire.items[0]?.reviewVersion).toBe('number');
    expect(snapshot.reviewVersion).toBe(EXACT);
  } finally {
    await env.dispose();
  }
}, 120_000);
