import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError, type IpcInteger } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import reviewPlugin from '../../review/index.ts';
import memoryPlugin from '../index.ts';
import type { InsightCommandService } from '../api.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';
import { createLogDouble } from './support.ts';

let cleanup: (() => Promise<void> | void) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup?.();
  cleanup = undefined;
});

async function setup() {
  const { dir, storage, report } = await createMigratedMemoryStorage('insight-pagination-');
  const disposeStorage = () => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); };
  cleanup = disposeStorage;
  expect(report).toEqual({ success: true, error: null });
  const settings = createSettingsService({
    db: () => storage.database('mistakes'), secureStore: () => null,
    secrets: { isSensitiveKey: () => false },
  });
  const host = await createTestHost({
    plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, memoryPlugin, reviewPlugin],
    provide: { storage, settings, log: createLogDouble([]) },
    app: { dataDir: dir },
  });
  cleanup = async () => { try { await host.dispose(); } finally { disposeStorage(); } };
  const insight: InsightCommandService = host.ctx.insight;
  return { host, insight, db: storage.database('vfs') };
}

// Real migrated insights rows, enough to distinguish SQLite's negative LIMIT
// (unbounded) from the positive 500 cap. This only seeds the test's own database.
function seedPages(db: DatabaseHandle): void {
  db.transaction(tx => {
    for (let i = 0; i < 503; i += 1) {
      tx.run(`INSERT INTO insights
        (id,title,ownership,verification_state,status,created_at,updated_at,deleted_at)
        VALUES (?1,?1,'guided','unverified',?2,'2026-01-01',?3,?4)`,
      [`page_${i}`, i === 501 ? 'cold' : 'active', String(i).padStart(4, '0'),
        i === 502 ? '2026-01-02' : null]);
    }
  });
}

describe('WP-158 InsightService::list_insights exact i64 pagination', () => {
  it('ordinary number pages retain real owner revisions, status filtering and ordering', async () => {
    const { insight, db } = await setup();
    const cards = [];
    for (let i = 0; i < 4; i += 1) {
      cards.push(await insight.createDraft({
        title: `card ${i}`, situation: '', stuck_point: '', turning_point: 'turn',
        rule: `rule ${i}`, validity_conditions: '', ownership: 'guided', evidence: [],
      }));
      db.run('UPDATE insights SET updated_at=?2 WHERE id=?1',
        [cards[i]!.id, `2026-01-0${i + 1}`]);
    }
    db.run("UPDATE insights SET status='cold' WHERE id=?1", [cards[2]!.id]);
    await insight.delete(cards[3]!.id);
    expect(await insight.listInsights(null, 1, 1)).toMatchObject([
      { id: cards[1]!.id, current_revision: cards[1]!.current_revision },
    ]);
    expect((await insight.listInsights('active', 10, 0)).map(card => card.id))
      .toEqual([cards[1]!.id, cards[0]!.id]);
    const cold = await insight.listInsights('cold', 1, 0);
    expect(cold[0]).toMatchObject({ id: cards[2]!.id, current_revision: { rule: 'rule 2' } });
    expect(await insight.listInsights('unknown', 10, 0)).toEqual([]);
  });

  it('handler defaults stay 100/0 and explicit zero stays zero', async () => {
    const { host, db } = await setup();
    seedPages(db);
    const all = vi.spyOn(db, 'all'); // Call-through: the production SQL still executes.
    for (const args of [{}, { status: null, limit: null, offset: null }]) {
      const cards = await host.invoke('insight_list', args);
      expect(cards).toHaveLength(100);
      expect(all).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'memory.insight.list' }), [100, 0]);
    }
    await expect(host.invoke('insight_list', { limit: 0, offset: 0 })).resolves.toEqual([]);
    expect(all).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'memory.insight.list' }), [0, 0]);
  });

  it('only caps positive limits at 500 and leaves signed SQLite semantics intact', async () => {
    const { insight, db } = await setup();
    seedPages(db);
    for (const status of [null, 'active']) {
      for (const limit of [500, 501, 500n, 501n, 9007199254740992n, 9007199254740993n, 9223372036854775807n]) {
        expect(await insight.listInsights(status, limit, 0)).toHaveLength(500);
      }
      for (const limit of [-1, -1n, -9007199254740992n, -9007199254740993n, -9223372036854775808n]) {
        expect(await insight.listInsights(status, limit, 0)).toHaveLength(status === null ? 502 : 501);
      }
      for (const offset of [-1, -1n, -9223372036854775808n]) {
        expect(await insight.listInsights(status, 2n, offset)).toEqual(await insight.listInsights(status, 2, 0));
      }
      expect(await insight.listInsights(status, 0n, 0n)).toEqual([]);
      expect(await insight.listInsights(status, 1n, 1n)).toEqual(await insight.listInsights(status, 1, 1));
    }
  });

  it('adjacent large offsets and i64 extrema reach real SQLite without Number conversion', async () => {
    const { insight, db } = await setup();
    seedPages(db);
    const all = vi.spyOn(db, 'all');
    for (const status of [null, 'active']) {
      const queryName = status === null ? 'memory.insight.list' : 'memory.insight.listByStatus';
      const cases: Array<[IpcInteger, IpcInteger, IpcInteger, number]> = [
        [9223372036854775807n, 9007199254740992n, 500, 0],
        [9223372036854775807n, 9007199254740993n, 500, 0],
        [1, 9223372036854775807n, 1, 0],
        [-9007199254740992n, -9007199254740992n, -9007199254740992n, status === null ? 502 : 501],
        [-9007199254740993n, -9007199254740993n, -9007199254740993n, status === null ? 502 : 501],
        [-9223372036854775808n, -9223372036854775808n, -9223372036854775808n, status === null ? 502 : 501],
      ];
      for (const [limit, offset, capped, length] of cases) {
        expect(await insight.listInsights(status, limit, offset)).toHaveLength(length);
        expect(all).toHaveBeenLastCalledWith(expect.objectContaining({ name: queryName }),
          status === null ? [capped, offset] : [status, capped, offset]);
      }
    }
  });

  it('both status branches propagate real SQL failure as Database, never an empty page', async () => {
    const { insight, db } = await setup();
    db.exec('ALTER TABLE insights RENAME TO unavailable_insights');
    for (const status of [null, 'active']) {
      const failure = insight.listInsights(status, 9223372036854775807n, 9007199254740993n);
      await expect(failure).rejects.toBeInstanceOf(CommandError);
      await expect(failure).rejects.toMatchObject({ value: {
        error_type: 'Database', message: 'no such table: insights', details: null,
      } });
    }
  });

  it('a card read failure after the id query rejects the whole page', async () => {
    const { insight, db } = await setup();
    seedPages(db);
    db.exec('ALTER TABLE insights RENAME COLUMN title TO unavailable_title');
    for (const status of [null, 'active']) {
      await expect(insight.listInsights(status, 1, 0)).rejects.toMatchObject({ value: {
        error_type: 'Database', message: 'no such column: title', details: null,
      } });
    }
  });
});
