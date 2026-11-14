/**
 * The chat-pipeline prompt/persistence calls (Rust prompt.rs `load_user_profile`,
 * prompt_builder.rs `load_learner_profile_block`, persistence.rs cited-note usage) reach the
 * memory owner only through the typed `MemoryService` surface published here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryService } from '../api.ts';
import { emptyProfileUpdate, isProfileContentEmpty, renderLearnerProfile } from '../src/learner-profile.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { vi.useRealTimers(); await current?.dispose(); current = undefined; });

async function setup() {
  current = await setupMemoryHost();
  const memory: MemoryService = current.host.ctx.memory;
  return { ...current, memory, owner: current.host.ctx.memory as unknown as MemoryServiceImpl };
}

function noteRow(db: MemoryHost['db'], id: string) {
  return db.get<{ tags: string; updated_at: string }>('SELECT tags, updated_at FROM notes WHERE id = ?1', [id])!;
}

function seedCategoryNote(db: MemoryHost['db'], folderId: string, id: string, title: string,
  content: string, tags: string[]) {
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
          VALUES (?1, ?2, 'note', 'inline', ?3, 0, 1, 1)`, [`res_${id}`, `hash_${id}`, content]);
  db.run(`INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  [id, `res_${id}`, title, JSON.stringify(tags)]);
  db.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
          VALUES (?1, ?2, 'note', ?3, 0, 1)`, [`fi_${id}`, folderId, id]);
}

describe('memory prompt-runtime surface', () => {
  it('category summaries carry their _member: ids; the plain list is the same sections without them', async () => {
    const { memory, owner, db } = await setup();
    const rootId = owner.getOrCreateRootFolder();
    seedCategoryNote(db, rootId, 'note_cat_a', '__cat_学习偏好__', '偏好图示', ['_system', '_member:note_1', '_member:note_2']);
    seedCategoryNote(db, rootId, 'note_cat_b', '__cat_空分类__', '', ['_system', '_member:note_3']);

    expect(memory.listCategorySummariesWithMembers()).toEqual([
      { category: '学习偏好', content: '偏好图示', memberIds: ['note_1', 'note_2'] },
    ]);
    expect(memory.listCategorySummaries()).toEqual([{ category: '学习偏好', content: '偏好图示' }]);
  });

  it('recordInjectionPresence replaces _last_injected only, keeps _hits/_stale and updated_at, skips deleted notes', async () => {
    const { memory, owner, db } = await setup();
    const written = owner.write(null, '常驻记忆', '内容', 'create');
    const deleted = owner.write(null, '已删记忆', '内容', 'create');
    db.run('UPDATE notes SET tags = ?1 WHERE id = ?2',
      [JSON.stringify(['keep', '_hits:3', '_stale', '_last_injected:1']), written.noteId]);
    db.run("UPDATE notes SET tags = '[]', deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?1", [deleted.noteId]);
    const before = noteRow(db, written.noteId);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_767_000_000_000);
    memory.recordInjectionPresence([written.noteId, deleted.noteId, 'note_missing']);

    const after = noteRow(db, written.noteId);
    expect(JSON.parse(after.tags)).toEqual(['keep', '_hits:3', '_stale', '_last_injected:1767000000000']);
    expect(after.updated_at).toBe(before.updated_at);
    expect(noteRow(db, deleted.noteId).tags).toBe('[]');
  });

  it('recordUsed bumps _used, refreshes _last_hit and drops _stale through the published surface', async () => {
    const { memory, owner, db } = await setup();
    const written = owner.write(null, '被引用记忆', '内容', 'create');
    db.run('UPDATE notes SET tags = ?1 WHERE id = ?2',
      [JSON.stringify(['_used:2', '_stale', '_last_hit:5']), written.noteId]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_767_000_000_000);
    memory.recordUsed([written.noteId]);
    expect(JSON.parse(noteRow(db, written.noteId).tags)).toEqual(['_used:3', '_last_hit:1767000000000']);
  });

  it('learner profile load/render/empty-check are served by the memory owner', async () => {
    const { memory, owner } = await setup();
    expect(memory.loadProfile()).toBeNull();
    const update = emptyProfileUpdate();
    update.weak_points_add.push({ subject: '线性代数', knowledge_point: '特征值分解',
      error_pattern: '特征向量方向弄反', evidence_count: 2, last_seen: null });
    owner.applyProfileUpdate(update, { source: 'test', reason: 'seed', limitPolicy: 'reject' });

    const profile = memory.loadProfile()!;
    expect(memory.isProfileContentEmpty(profile)).toBe(false);
    expect(memory.renderLearnerProfile(profile)).toBe(renderLearnerProfile(profile));
    expect(memory.renderLearnerProfile(profile)).toContain('特征值分解');
    const empty = { ...profile, weak_points: [], goals: [], recent_status: null,
      preferences: { explanation_style: null, language: null, pace: null, others: [] } };
    expect(memory.isProfileContentEmpty(empty)).toBe(isProfileContentEmpty(empty));
    expect(memory.isProfileContentEmpty(empty)).toBe(true);
  });

  it('getProfileSummary is null without the legacy profile note', async () => {
    const { memory, owner, db } = await setup();
    owner.getOrCreateRootFolder();
    db.run("DELETE FROM notes WHERE title = '__user_profile__'");
    expect(memory.getProfileSummary()).toBeNull();
  });
});
