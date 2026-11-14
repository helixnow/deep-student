import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import review from '../index.ts';
import { DailySprintService } from '../src/dailySprintService.ts';
import { FsrsReviewService } from '../src/review.ts';
import * as repo from '../repository/exam-sprint.ts';
import { mistakesFixture } from './storage.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function setup() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const vfs = fixture.storage.database('vfs');
  for (const name of ['V20260130__init.sql', 'V20260131__add_change_log.sql', 'V20261111__study_space_profiles_and_mounts.sql']) {
    vfs.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  }
  return { ...fixture, vfs };
}

function seedCard(db: ReturnType<typeof mistakesFixture>['db'], id: string, sourceId: string) {
  db.run(`INSERT INTO document_tasks (id, document_id, original_document_name, segment_index,
    content_segment, status, anki_generation_options_json) VALUES (?1, ?2, 'Notes', 0, '', 'Completed', '{}')`, [`task_${id}`, sourceId]);
  db.run(`INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id)
    VALUES (?1, ?2, ?4, 'Answer', 'note', ?3)`, [id, `task_${id}`, sourceId, `Prompt ${id}`]);
  return new FsrsReviewService(db).enqueueCards([id]).states[0]!.id;
}

describe('Sprint SQL against migration schemas', () => {
  it('expands canonical subfolders, nested/cyclic mounts and resource aliases without leaking a missing scope', () => {
    const { vfs } = setup();
    for (const [id, parent] of [['root', null], ['child', 'root'], ['shared', null], ['nested', null]] as const) {
      vfs.run('INSERT INTO folders (id, parent_id, title, created_at, updated_at) VALUES (?1, ?2, ?1, 0, 0)', [id, parent]);
    }
    for (const [id, target, type, item] of [
      ['m1', 'child', 'folder', 'shared'], ['m2', 'shared', 'folder', 'nested'],
      ['m3', 'nested', 'folder', 'root'], ['m4', 'nested', 'exam', 'exam_1'],
    ]) {
      vfs.run(`INSERT INTO vfs_space_mounts (id, space_id, target_folder_id, item_type, item_id)
        VALUES (?1, 'space', ?2, ?3, ?4)`, [id!, target!, type!, item!]);
    }
    vfs.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at)
      VALUES ('fi', 'nested', 'note', 'note_1', 0)`);
    vfs.run(`INSERT INTO resources (id, hash, type, source_id, created_at, updated_at)
      VALUES ('res_1', 'hash_1', 'note', 'note_1', 0, 0)`);
    const scope = repo.readFolderResourceIds(vfs, 'root')!;
    expect([...scope.folderIds].sort()).toEqual(['child', 'nested', 'root', 'shared']);
    expect([...scope.itemIds].sort()).toEqual(['exam_1', 'note_1', 'res_1']);
    expect(repo.readFolderResourceIds(null, 'root')!.itemIds.size).toBe(0);
    expect(repo.readFolderResourceIds(vfs, 'empty')!.itemIds.size).toBe(0);
  });

  it('hydrates real Anki columns, handles empty IDs and keeps unscoped and buried cards out of a space', async () => {
    const { db, storage, vfs } = setup();
    const visible = seedCard(db, 'card_in', 'note_in');
    seedCard(db, 'card_out', 'note_out');
    const buried = seedCard(db, 'card_buried', 'note_in');
    db.run('UPDATE fsrs_card_states SET buried_until_ms = ?1 WHERE id = ?2', [Date.now() + 86400000, buried]);
    vfs.run(`INSERT INTO folders (id, title, created_at, updated_at) VALUES ('root', 'Space', 0, 0)`);
    vfs.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at)
      VALUES ('fi', 'root', 'note', 'note_in', 0)`);
    const host = await createTestHost({ plugins: [review], provide: { storage } });
    hosts.push(host);
    const sprint = new DailySprintService(host.ctx);
    const result = await sprint.buildDailySprintPlan({ spaceId: 'space', rootFolderId: 'root', enableAiVariants: false });
    expect(result.items.map((item) => item.sprintItemId)).toEqual([`fsrs:${visible}`]);
    expect(result.readinessBefore.totalActiveItems).toBe(2);
    expect((await sprint.buildDailySprintPlan({ spaceId: 'empty', rootFolderId: 'missing' })).items).toEqual([]);
    expect(repo.readAnkiCardsForSprint(db, [])).toEqual(new Map());
    expect(repo.readAnkiCardsForSprint(db, [' ', ''])).toEqual(new Map());
    expect(repo.readAnkiCardsForSprint(db, ['card_in']).get('card_in')?.front).toBe('Prompt card_in');
  });

  it('does not treat an empty folder scope as all mistakes or mindmaps and pages past large global backlogs', async () => {
    const { storage } = setup();
    let offsets: number[] = [];
    const repos = {
      reviewPlans: { listDueReviews: (_db: unknown, filter: { offset: number }) => {
        offsets.push(filter.offset);
        return filter.offset === 0
          ? { plans: [{ id: 'p1', exam_id: 'outside', question_id: 'q1' }], has_more: true }
          : { plans: [], has_more: false };
      } },
      mindmaps: { listMindmaps: () => [{ id: 'mm_out', resourceId: 'res_out' }],
        getMindmapContent: () => { throw new Error('Out-of-scope content must not be loaded'); } },
    } as unknown as VfsReposService;
    const host = await createTestHost({ plugins: [review], provide: { storage, vfsRepo: repos } });
    hosts.push(host);
    const plan = await new DailySprintService(host.ctx).buildDailySprintPlan({ spaceId: 'empty', rootFolderId: 'missing' });
    expect(offsets).toEqual([0, 1]);
    expect(plan.readinessBefore.totalActiveItems).toBe(0);
  });

  it('commits compressed intervals and logs together, uses milliseconds, and replays an operation once', () => {
    const { db } = setup();
    const stateId = seedCard(db, 'rated', 'note');
    db.run(`UPDATE fsrs_card_states SET state = 2, reps = 4, stability = 30, difficulty = 5,
      last_review_ms = ?1 WHERE id = ?2`, [Date.now() - 86400000 * 30, stateId]);
    const svc = new FsrsReviewService(db);
    const options = { operationId: 'sprint:session:card', desiredRetention: 0.94, compressInterval: () => 2 };
    const rated = svc.rateWithMasteryBias(stateId, 4, 14000, null, null, options);
    expect(rated.scheduledDays).toBe(2);
    expect(rated.dueMs).toBe(rated.cardState.lastReviewMs! + 2 * 86400000);
    const logged = db.get<{ due: number; days: number }>(
      'SELECT due_after_ms AS due, scheduled_days AS days FROM fsrs_review_logs WHERE id = ?1', [rated.logId]);
    expect(logged).toEqual({ due: rated.dueMs, days: 2 });
    expect(rated.cardState.desiredRetention).toBe(0.94);
    expect(svc.rateWithMasteryBias(stateId, 4, 14000, null, null, options).cardState.reps).toBe(5);
    const before = svc.getCardState(stateId);
    db.exec(`CREATE TRIGGER fail_sprint_log BEFORE INSERT ON fsrs_review_logs BEGIN SELECT RAISE(ABORT, 'log failed'); END`);
    expect(() => svc.rateWithMasteryBias(stateId, 3, 14000, null, null,
      { ...options, operationId: 'sprint:other:card' })).toThrow();
    expect(svc.getCardState(stateId)).toEqual(before);
  });

  it('does not truncate the active population before applying Study Space filters', () => {
    const { db } = setup();
    seedCard(db, 'base', 'note');
    db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2501)
      INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id)
      SELECT 'extra_' || x, 'task_base', 'Question ' || x, 'Answer', 'note', 'note' FROM n;
      INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at)
      SELECT 'state_' || id, id, 0, '2026-01-01', '2026-01-01' FROM anki_cards WHERE id != 'base';`);
    expect(repo.listActiveFsrsSprintRows(db)).toHaveLength(2502);
  });
});
