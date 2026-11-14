import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import { MemoryServiceImpl, shouldDowngradeSmartMutation } from '../src/service.ts';
import { writeMode } from '../index.ts';
import {
  cacheResult, clearCompletedReceiptsWithPrefix, clearReservation, getCachedResult,
  finalizeResult, renewReservation, tryReserve,
} from '../repository/idempotency.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }
function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}

describe('service OCC and idempotency', () => {
  it('test_write_mode_from_str', () => {
    expect(writeMode('create')).toBe('create');
    expect(writeMode('update')).toBe('update');
    expect(writeMode('append')).toBe('append');
    expect(writeMode('CREATE')).toBe('create');
    expect(writeMode('UPDATE')).toBe('update');
    expect(writeMode('APPEND')).toBe('append');
    expect(writeMode('unknown')).toBe('create');
    expect(writeMode('invalid')).toBe('create');
    expect(writeMode(null)).toBe('create');
  });

  it('test_should_downgrade_smart_mutation', () => {
    expect(shouldDowngradeSmartMutation('UPDATE', 0.5)).toBe(true);
    expect(shouldDowngradeSmartMutation('APPEND', 0.64)).toBe(true);
    expect(shouldDowngradeSmartMutation('DELETE', 0.5)).toBe(true);
    expect(shouldDowngradeSmartMutation('UPDATE', 0.8)).toBe(false);
    expect(shouldDowngradeSmartMutation('DELETE', 0.8)).toBe(false);
    expect(shouldDowngradeSmartMutation('ADD', 0.1)).toBe(false);
    expect(shouldDowngradeSmartMutation('NONE', 0.1)).toBe(false);
  });

  it('relation_occ_is_atomic_and_advances_both_versions', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const noteA = service.write(null, 'Relation A', 'alpha', 'create');
    const noteB = service.write(null, 'Relation B', 'beta', 'create');
    const versionA = service.read(noteA.noteId)!.updatedAt;
    const versionB = service.read(noteB.noteId)!.updatedAt;

    const added = service.addRelationWithOcc(noteA.noteId, versionA, noteB.noteId, versionB);
    expect(added.changed).toBe(true);
    expect(added.noteA.updatedAt).not.toBe(versionA);
    expect(added.noteB.updatedAt).not.toBe(versionB);
    expect(service.getRelated(noteA.noteId)).toEqual([noteB.noteId]);
    expect(service.getRelated(noteB.noteId)).toEqual([noteA.noteId]);

    expect(() => service.removeRelationWithOcc(noteA.noteId, versionA,
      noteB.noteId, added.noteB.updatedAt)).toThrow(/CONFLICT\(notes\.conflict\)/);
    expect(service.getRelated(noteA.noteId)).toEqual([noteB.noteId]);

    const removed = service.removeRelationWithOcc(noteA.noteId, added.noteA.updatedAt,
      noteB.noteId, added.noteB.updatedAt);
    expect(removed.changed).toBe(true);
    expect(service.getRelated(noteA.noteId)).toEqual([]);
    expect(service.getRelated(noteB.noteId)).toEqual([]);
  });

  it('tag_and_move_occ_preserve_system_boundary_and_advance_versions', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const output = service.write(null, 'Mutable memory', 'content', 'create');
    const initial = service.read(output.noteId)!;
    const initialFolder = service.read(output.noteId)!.folderPath;

    const [, tagged] = service.updateTagsWithOcc(output.noteId, initial.updatedAt,
      ['exam', '_important']);
    expect(tagged.updatedAt).not.toBe(initial.updatedAt);
    expect(tagged.tags).toEqual(['exam']);

    expect(() => service.updateTagsWithOcc(output.noteId, initial.updatedAt, ['stale']))
      .toThrow(/CONFLICT\(notes\.conflict\)/);

    const [moved, previousFolder] = service.moveToFolderWithOcc(output.noteId,
      tagged.updatedAt, 'Archive/2026');
    expect(previousFolder).toBe(initialFolder);
    expect(moved.updatedAt).not.toBe(tagged.updatedAt);
    expect(service.read(output.noteId)!.folderPath).toBe('Archive/2026');

    expect(() => service.moveToFolderWithOcc(output.noteId, tagged.updatedAt, 'Wrong'))
      .toThrow(/CONFLICT\(notes\.conflict\)/);
    expect(service.read(output.noteId)!.folderPath).toBe('Archive/2026');
  });

  it('stale_idempotency_lease_is_reclaimed_and_fences_previous_owner', async () => {
    const { db } = await setup();
    const key = 'stale-lease-fencing';
    const first = tryReserve(db, key)!;
    expect(first).toBeDefined();
    db.run('UPDATE memory_write_idempotency SET created_at = ?1 WHERE idempotency_key = ?2',
      [Date.now() - 5 * 60 * 1000 - 1, key]);
    const second = tryReserve(db, key)!;
    expect(second).toBeDefined();
    expect(first.ownerToken).not.toBe(second.ownerToken);
    expect(() => renewReservation(db, first)).toThrow(/memory\.idempotency\.lease_lost/);
    clearReservation(db, first);
    renewReservation(db, second);

    const output = { noteId: 'note-fenced', event: 'ADD', isNew: true, confidence: 1,
      reason: 'committed by current owner', resourceId: 'resource-fenced', downgraded: false };
    // Rust service.rs:5062-5068: the fenced owner's finalize is a lease_lost Conflict.
    expect(() => finalizeResult(db, first, output)).toThrow(/CONFLICT\(memory\.idempotency\.lease_lost\)/);
    expect(getCachedResult(db, key)).toBeUndefined();
    finalizeResult(db, second, output);
    expect(getCachedResult(db, key)).toEqual(output);
  });

  it('compaction_receipts_survive_normal_ttl_until_ledger_cleanup', async () => {
    const { db } = await setup();
    const compactionKey = 'compaction_flush:segment-hash:fact:0';
    const ordinaryKey = 'ordinary-expired-receipt';
    const output = { noteId: 'note-retained', event: 'ADD', isNew: true, confidence: 1,
      reason: 'retention test', resourceId: 'resource-retained', downgraded: false };
    for (const key of [compactionKey, ordinaryKey]) {
      const reservation = tryReserve(db, key)!;
      cacheResult(db, reservation, output);
    }
    const expiredAt = Date.now() - 24 * 60 * 60 * 1000 - 1;
    db.run('UPDATE memory_write_idempotency SET created_at = ?1 WHERE idempotency_key IN (?2, ?3)',
      [expiredAt, compactionKey, ordinaryKey]);

    expect(getCachedResult(db, ordinaryKey)).toBeUndefined();
    expect(getCachedResult(db, compactionKey)).toEqual(output);
    expect(clearCompletedReceiptsWithPrefix(db, 'compaction_flush:segment-hash:')).toBe(1);
    expect(getCachedResult(db, compactionKey)).toBeUndefined();
  });
});
