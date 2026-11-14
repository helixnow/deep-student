import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import type { MemorySearchResult, MemoryWriteOutput } from '../api.ts';
import { PROFILE_NOTE_TITLE } from '../src/memory-utils.ts';
import { emptyProfileUpdate, LEARNER_PROFILE_NOTE_TITLE } from '../src/learner-profile.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup(): Promise<MemoryServiceImpl> {
  current = await setupMemoryHost();
  return current.host.ctx.memory as unknown as MemoryServiceImpl;
}

// Cause a real SQLite query failure, not a repository stub returning the desired outcome.
async function withUnavailableNotes(run: () => void | Promise<void>): Promise<void> {
  const db = current!.db;
  db.exec('ALTER TABLE notes RENAME TO notes_query_fault');
  try { await run(); }
  finally { db.exec('ALTER TABLE notes_query_fault RENAME TO notes'); }
}

function seedSystemNotes(service: MemoryServiceImpl): void {
  service.appendDailyLog('2026-07-11', '学习了函数');
  const update = emptyProfileUpdate();
  update.goals_add.push({ goal: '复习函数', deadline: null });
  service.applyProfilePromotionUpdate(update, 'snapshot-fixture', {
    source: 'evolution', reason: 'seed system snapshots', limitPolicy: 'enforce',
  });
}

describe('L17-V2-09 optional memory queries versus strict system snapshots', () => {
  it('memory_search treats a resource-to-note query error as no note, like Rust .ok()', async () => {
    const service = await setup();
    const note: MemoryWriteOutput = service.write(null, '偏好', '我偏好图解', 'create');
    current!.retrieval.responder = request => ({
      capabilitySnapshot: {} as never,
      plan: { queryModality: 'text', topK: request.topK, routes: [], imageFallbackChain: [] },
      result: { hits: [{ hit: {
        identity: { resourceId: note.resourceId, chunkIndex: 0, pageIndex: null, timeRange: null },
        embeddingId: '', text: '我偏好图解', title: null, resourceType: 'note', sourceId: null,
        folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata: null,
      }, rrfScore: 1, normalizedScore: null, rerankScore: null, provenance: [] }], failures: [] },
      queryDerivations: [],
    });
    const result = await current!.host.invoke('memory_search', { query: '图解' }) as MemorySearchResult[];
    expect(result[0]!.noteId).toBe(note.noteId);
    await withUnavailableNotes(async () => {
      // service.rs:3251-3274 discards only this query/row error; retrieval remains successful.
      expect(await current!.host.invoke('memory_search', { query: '图解' })).toEqual([]);
    });
  });

  it('legacy profile-summary title lookup silently returns no note on SQL error', async () => {
    const service = await setup();
    service.write(null, '偏好', '我偏好图解', 'create');
    current!.notes.repository.createNoteInFolder({ title: PROFILE_NOTE_TITLE,
      content: '用户偏好图解', tags: ['_system'] }, service.getRootFolderId(), current!.db);
    expect(service.getProfileSummary()).toBe('用户偏好图解');
    const warnings = [...current!.warnings];
    await withUnavailableNotes(() => {
      // service.rs:3181-3208: ordinary find_note_by_title uses .ok(), with no warn.
      expect(service.getProfileSummary()).toBeNull();
      expect(current!.warnings).toEqual(warnings);
    });
  });

  it('daily-log and learner-profile snapshot SQL failures still propagate', async () => {
    const service = await setup();
    seedSystemNotes(service);
    expect(service.dailyLogSnapshot('2026-07-11')!.content).toContain('学习了函数');
    expect(service.loadProfile()!.goals[0]!.goal).toBe('复习函数');
    await withUnavailableNotes(() => {
      // daily_log.rs:100-127 / learner_profile.rs:658-685 use optional().map_err(..), not .ok().
      expect(() => service.dailyLogSnapshot('2026-07-11')).toThrow(/no such table.*notes/u);
      expect(() => service.loadProfile()).toThrow(/no such table.*notes/u);
      expect(() => service.profileHistorySnapshot()).toThrow(/no such table.*notes/u);
    });
  });

  it('a missing joined resource yields no system snapshot, not a separate content read', async () => {
    const service = await setup();
    seedSystemNotes(service);
    const daily = service.dailyLogSnapshot('2026-07-11')!;
    const resourceIds = current!.db.all<{ resourceId: string }>(
      'SELECT resource_id AS resourceId FROM notes WHERE id=?1 OR title=?2',
      [daily.noteId, LEARNER_PROFILE_NOTE_TITLE]);
    expect(resourceIds).toHaveLength(2);
    current!.db.exec('PRAGMA foreign_keys=OFF');
    try {
      for (const { resourceId } of resourceIds) {
        current!.db.run('DELETE FROM resources WHERE id=?1', [resourceId]);
      }
    } finally { current!.db.exec('PRAGMA foreign_keys=ON'); }
    expect(service.dailyLogSnapshot('2026-07-11')).toBeNull();
    expect(service.loadProfile()).toBeNull();
  });
});
