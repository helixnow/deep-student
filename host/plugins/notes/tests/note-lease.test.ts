import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository as revisions } from '../repository/revisions.ts';
import { noteRelationRepository as relations } from '../repository/relations.ts';
import { noteLeaseRepository as leases } from '../repository/leases.ts';
import type { VfsNote } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';


type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  // R5 N4: real L11 vfsRepo wired by the production notes plugin, not a test copy of L11 SQL.
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  storage.database('vfs').exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions;
    DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations;
    DELETE FROM note_editor_lease_acks;
    DELETE FROM note_editor_write_grants;
    DELETE FROM note_editor_lease_notes;
    DELETE FROM note_editor_leases;
    DELETE FROM note_editor_participants;
    DELETE FROM note_links;
    DELETE FROM note_tags;
    DELETE FROM folder_items;
    DELETE FROM notes;
    DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log;
    DELETE FROM resources;
    PRAGMA foreign_keys=ON;`);
}, 30000);

function db(): SqlExecutor {
  return storage.database('vfs');
}

function create(): VfsNote {
  return noteRepository.createNote({ title: 'Lease test', content: 'Before', tags: [] }, db());
}

function register(note: VfsNote, view: string): string {
  return leases.register(db(), note.id, view, view, 100).participant_id;
}

function begin(note: VfsNote, owner: string) {
  const lease = leases.begin(db(), owner, 'a', 'op', [note.id], 100);
  return { participant_id: owner, token: lease.token };
}

function draft(note: VfsNote, markdown: string) {
  return { markdown, expected_updated_at: note.updatedAt };
}

function edit(note: VfsNote, markdown: string): VfsNote {
  return noteRepository.updateNote(note.id, { content: markdown, expectedUpdatedAt: note.updatedAt }, db());
}

describe('note_lease_tests', () => {
  it('pending_fences_repo_raw_sql_and_other_connection_and_preserves_history', () => {
    const note = create();
    const owner = register(note, 'a');
    const auth = begin(note, owner);
    expect(() => edit(note, 'stale')).toThrow();
    expect(() => db().run("UPDATE resources SET data='bypass' WHERE id=?1", [note.resourceId])).toThrow();
    expect(() => db().run("UPDATE notes SET title='bypass' WHERE id=?1", [note.id])).toThrow();
    expect(() => noteRepository.deleteNote(note.id, db())).toThrow();
    expect(() => noteRepository.purgeNote(note.id, db())).toThrow();
    expect(() => leases.flush(db(), auth, 'a', note.id, [], 100)).toThrow();
    expect(revisions.current(db(), note.id).content_md).toBe('Before');
    expect(revisions.list(db(), note.id, null, 100).items).toHaveLength(1);
    leases.release(db(), auth, 'a', true, 101);
    expect(() => leases.authorized(db(), auth, 'a', 101, true, () => edit(note, 'late'))).toThrow();
    expect(edit(note, 'normal').id).toBe(note.id);
  });

  it('soft_delete_requires_the_active_edit_lease_barrier_like_saves', () => {
    const note = create();
    const owner = register(note, 'a');
    const auth = begin(note, owner);
    const blocked = (work: () => void) => {
      try {
        work();
      } catch (error) {
        return error;
      }
      throw new Error('expected the lease barrier to reject the write');
    };
    for (const work of [
      () => noteRepository.deleteNote(note.id, db()),
      () => noteRepository.deleteNoteWithFolderItem(note.id, db()),
    ]) {
      expect(blocked(work)).toMatchObject({ kind: 'conflict', key: 'notes.lease_conflict' });
      expect(noteRepository.getNote(note.id, db())?.deletedAt).toBeNull();
    }
    // The same barrier must still let the lease's own authorized write through.
    leases.ack(db(), auth, 'a', draft(note, 'Before'), 100);
    leases.authorized(db(), auth, 'a', 100, false, () => noteRepository.deleteNote(note.id, db()));
    expect(noteRepository.getNote(note.id, db())).toBeNull();
    expect(noteRepository.getNoteIncludingDeleted(note.id, db())?.deletedAt).not.toBeNull();
  });

  it('unanimous_drafts_flush_once_commit_and_hold_until_all_refresh', () => {
    const note = create();
    const a = register(note, 'a');
    const b = register(note, 'b');
    const auth = begin(note, a);
    expect(leases.ack(db(), auth, 'a', draft(note, 'Draft'), 100).phase).toBe('pending');
    const peer = { participant_id: b, token: auth.token };
    expect(leases.ack(db(), peer, 'b', draft(note, 'Draft'), 100).phase).toBe('ready');
    expect(() => leases.authorized(db(), auth, 'a', 100, true, () => undefined)).toThrow();
    expect(() => leases.flush(db(), peer, 'b', note.id, [], 100)).toThrow();
    const flushed = leases.flush(db(), auth, 'a', note.id, [], 100);
    const again = leases.flush(db(), auth, 'a', note.id, [], 100);
    expect(again.updated_at).toBe(flushed.updated_at);
    const live = noteRepository.getNote(note.id, db())!;
    const committed = leases.authorized(db(), auth, 'a', 100, true, () => edit(live, 'Committed'));
    expect(() => edit(committed, 'uncoordinated')).toThrow();
    expect(() => leases.release(db(), auth, 'a', false, 100)).toThrow();
    leases.finish(db(), auth, 'a', 100);
    expect(() => leases.refreshAck(db(), peer, 'b', note.updatedAt, 100)).toThrow();
    leases.refreshAck(db(), auth, 'a', committed.updatedAt, 100);
    leases.refreshAck(db(), peer, 'b', committed.updatedAt, 100);
    leases.release(db(), auth, 'a', false, 100);
    edit(committed, 'After release');
  });

  it('late_registration_reopens_barrier_and_divergent_or_stale_ack_cannot_authorize', () => {
    const note = create();
    const a = register(note, 'a');
    const auth = begin(note, a);
    leases.ack(db(), auth, 'a', draft(note, 'Draft'), 100);
    const late = leases.register(db(), note.id, 'b', 'b', 101);
    expect(late.active_lease!.phase).toBe('pending');
    expect(() => leases.flush(db(), auth, 'a', note.id, [], 101)).toThrow();
    const peer = { participant_id: late.participant_id, token: auth.token };
    expect(() => leases.ack(db(), peer, 'a', draft(note, 'Draft'), 101)).toThrow();
    expect(() => leases.ack(db(), peer, 'b', draft(note, 'Different'), 101)).toThrow();
    expect(() => leases.ack(db(), peer, 'b', { markdown: 'Draft', expected_updated_at: 'stale' }, 101)).toThrow();
    expect(() => leases.authorized(db(), auth, 'a', 101, true, () => undefined)).toThrow();
    expect(revisions.current(db(), note.id).content_md).toBe('Before');
  });

  it('heartbeat_does_not_extend_pending_deadline_and_close_cancels_whole_lease', () => {
    const note = create();
    const a = register(note, 'a');
    const b = register(note, 'b');
    const auth = begin(note, a);
    leases.heartbeat(db(), a, 'a', 125);
    expect(leases.cleanup(db(), 131, null, null)).toHaveLength(1);
    expect(leases.status(db(), auth.token)).toBeNull();
    const second = begin(note, a);
    expect(leases.cleanup(db(), 101, 'b', null)).toHaveLength(1);
    expect(() => leases.heartbeat(db(), b, 'b', 101)).toThrow();
    expect(leases.status(db(), second.token)).toBeNull();
    const third = begin(note, a);
    expect(leases.cleanup(db(), 101, null, 'a')).toHaveLength(1);
    expect(leases.status(db(), third.token)).toBeNull();
  });

  it('sorted_multi_note_acquisition_rolls_back_on_overlap_and_grants_rollback_on_failure', () => {
    const first = create();
    const second = create();
    const a = register(first, 'a');
    const b = register(second, 'b');
    const auth = begin(first, a);
    expect(() => leases.begin(db(), b, 'b', 'other', [second.id, first.id], 100)).toThrow();
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_editor_lease_notes')?.count ?? 0)).toBe(1);
    leases.ack(db(), auth, 'a', draft(first, 'Before'), 100);
    expect(() => leases.authorized(db(), auth, 'a', 100, true, () => edit(second, 'outside scope'))).toThrow();
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_editor_write_grants')?.count ?? 0)).toBe(0);
    expect(leases.status(db(), auth.token)!.phase).toBe('ready');
    expect(revisions.current(db(), second.id).content_md).toBe('Before');
  });

  it('authorized_multi_step_writes_advance_the_frozen_baseline', () => {
    const note = create();
    const owner = register(note, 'a');
    const auth = begin(note, owner);
    leases.ack(db(), auth, 'a', draft(note, 'Before'), 100);
    const first = leases.authorized(db(), auth, 'a', 100, true, () => edit(note, 'Step one'));
    const second = leases.authorized(db(), auth, 'a', 100, true, () => edit(first, 'Step two'));
    expect(revisions.current(db(), note.id).content_md).toBe('Step two');
    leases.finish(db(), auth, 'a', 100);
    leases.refreshAck(db(), auth, 'a', second.updatedAt, 100);
    leases.release(db(), auth, 'a', false, 100);
  });

  it('relationship_logs_and_pin_backfill_use_row_sync_identity_and_replay_suppression', () => {
    const note = create();
    relations.put(db(), null, {
      id: 'rel', note_id: note.id, block_id: null, type: 'source',
      resource_id: note.resourceId, locator: { type: 'whole' }, expected_revision: null,
    });
    relations.invalidateResource(db(), note.resourceId);
    const version = revisions.list(db(), note.id, null, 1).items[0]!.version_id;
    db().run('UPDATE __change_log SET sync_version=1');
    const max = Number(db().get<{ max: number | null }>('SELECT MAX(id) AS max FROM __change_log')?.max ?? 0);
    revisions.setPinned(db(), note.id, version, true);
    expect(Number(db().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM __change_log WHERE table_name='note_document_revisions'
        AND record_id=?1 AND operation='UPDATE' AND sync_version=0`, [version])?.count ?? 0)).toBe(1);
    // Exact existing ChangeLog replay suppression: no new flag or global switch.
    db().run(`UPDATE __change_log SET sync_version=1 WHERE id>?1
      AND table_name='note_document_revisions' AND record_id=?2`, [max, version]);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM __change_log WHERE sync_version=0')?.count ?? 0)).toBe(0);
    const sql = readFileSync(new URL('../../../../resources/app/migrations/vfs/V20260924__note_editor_leases.sql', import.meta.url), 'utf8');
    db().exec(sql);
    db().exec(sql);
    expect(Number(db().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM __change_log WHERE table_name='note_learning_relations'
        AND record_id='rel' AND sync_version=0`)?.count ?? 0)).toBe(1);
    expect(Number(db().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM __change_log WHERE table_name='note_document_revisions'
        AND record_id=?1 AND sync_version=0`, [version])?.count ?? 0)).toBe(1);
    relations.delete(db(), 'rel', 2);
    expect(Number(db().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM __change_log WHERE table_name='note_learning_relations'
        AND record_id='rel' AND operation='DELETE'`)?.count ?? 0)).toBe(1);
  });
});
