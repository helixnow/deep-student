// D005-01: lease cleanup reaches production through the notes plugin lifecycle
// (lib.rs:704-712 Destroyed, lib.rs:1338-1354 startup reset + 5s interval,
// cmd/notes.rs:526-553 ended events / warn). No test calls cleanup by hand.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import paths from '../../../platform/paths/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteLeaseRepository } from '../repository/leases.ts';
import { LEASE_STARTUP_RESET_NOW } from '../src/lease-lifecycle.ts';
import type { LeaseStatus, ParticipantStatus } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsNote } from '../api.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
let storage: ReturnType<typeof createStorageService>;
const logs: string[] = [];
const A: WindowRef = { window: 'win-a', webview: 'view-a' };
const B: WindowRef = { window: 'win-b', webview: 'view-b' };
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) { logs.push(`${message.type} [${message.name}] ${message.args.map(String).join(' ')}`); },
  });
  await host.install(paths, vfsRepos);
}, 120000);

afterEach(async () => {
  await host.unload('dstu.notes');
  vi.useRealTimers();
  vi.restoreAllMocks();
  logs.length = 0;
  host.events.length = 0;
});

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

function db(): SqlExecutor {
  return storage.database('vfs');
}

/** Control timer deadlines and both clocks; the first tick is a 0ms timer. */
function useLeaseClock(): void {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'], now: T0,
  });
}

async function installNotes(): Promise<void> {
  useLeaseClock();
  await host.install(notes);
  await flushFirstTick();
}

/** Delivers the plugin's deferred first tick (`setTimeout(tick, 0)`, lib.rs:1347-1353). */
async function flushFirstTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function create(title: string): VfsNote {
  return noteRepository.createNote({ title, content: 'Before', tags: [] }, db());
}

function rawWrite(note: VfsNote): void {
  db().run("UPDATE notes SET title='bypass' WHERE id=?1", [note.id]);
}

async function holdLease(note: VfsNote, owner: WindowRef, peer: WindowRef, op: string): Promise<LeaseStatus> {
  const a = await host.invoke<ParticipantStatus>('notes_editor_register', { noteId: note.id }, owner);
  await host.invoke<ParticipantStatus>('notes_editor_register', { noteId: note.id }, peer);
  return host.invoke<LeaseStatus>('notes_editor_begin', {
    participantId: a.participant_id, operationId: op, noteIds: [note.id],
  }, owner);
}

function rowCounts(): { participants: number; leases: number } {
  return {
    participants: Number(db().pluck('SELECT COUNT(*) FROM note_editor_participants')),
    leases: Number(db().pluck('SELECT COUNT(*) FROM note_editor_leases')),
  };
}

describe('D005-01 note editor lease lifecycle in the production plugin', () => {
  it('startup resets stale membership with i64::MAX, discards events, and releases the write fence', async () => {
    await installNotes();
    const note = create('restart fence');
    // A lease whose participants are far in the future: TTL alone would never free it.
    noteLeaseRepository.register(db(), note.id, 'old-view', 'old-win', 9_000_000_000);
    const pid = String(db().pluck('SELECT id FROM note_editor_participants'));
    noteLeaseRepository.begin(db(), pid, 'old-view', 'old-op', [note.id], 9_000_000_000);
    await host.unload('dstu.notes');
    expect(() => rawWrite(note)).toThrow('notes.lease_conflict');

    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    host.events.length = 0;
    await host.install(notes);
    expect(cleanup.mock.calls[0]).toEqual([db(), LEASE_STARTUP_RESET_NOW, null, null]);
    expect(LEASE_STARTUP_RESET_NOW).toBe(9223372036854775807n);
    expect(rowCounts()).toEqual({ participants: 0, leases: 0 });
    expect(Number(db().pluck('SELECT COUNT(*) FROM note_editor_lease_notes'))).toBe(0);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
    expect(() => rawWrite(note)).not.toThrow();
  });

  it('startup cleanup failure fails plugin setup with the Rust map_err prefix', async () => {
    await installNotes();
    const note = create('startup failure');
    noteLeaseRepository.register(db(), note.id, 'v', 'w', 100);
    await host.unload('dstu.notes');
    db().exec(`CREATE TRIGGER reject_participant_delete BEFORE DELETE ON note_editor_participants
      BEGIN SELECT RAISE(ABORT,'participant delete rejected'); END`);
    try {
      const failure = await host.install(notes).then(() => 'installed', (error: unknown) =>
        (error instanceof Error ? error.message : String(error)));
      expect(failure).toBe('Notes lease startup cleanup: Database error: participant delete rejected');
      expect(host.plugins.some((plugin) => plugin.id === 'dstu.notes')).toBe(false);
    } finally {
      db().exec('DROP TRIGGER reject_participant_delete');
    }
    await host.install(notes);
    expect(rowCounts().participants).toBe(0);
  });

  it('first interval tick runs immediately, then every 5s with the epoch clock, and TTL expiry frees the fence', async () => {
    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    useLeaseClock();
    await host.install(notes);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await flushFirstTick();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.calls[1]).toEqual([db(), T0 / 1000, null, null]);
    vi.advanceTimersByTime(4999);
    expect(cleanup).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(cleanup.mock.calls[2]).toEqual([db(), T0 / 1000 + 5, null, null]);

    const note = create('ttl fence');
    const lease = await holdLease(note, A, B, 'ttl-op');
    expect(lease.expires_at).toBe(T0 / 1000 + 5 + 30);
    expect(() => rawWrite(note)).toThrow('notes.lease_conflict');
    // Pending deadline is 30s, participants 45s; heartbeats never extend pending.
    vi.advanceTimersByTime(25_000);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
    expect(rowCounts().leases).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([
      { token: lease.token, note_ids: [note.id], reason: 'participant_closed_or_expired' },
    ]);
    expect(rowCounts().leases).toBe(0);
    expect(() => rawWrite(note)).not.toThrow();
    vi.advanceTimersByTime(15_000);
    expect(rowCounts().participants).toBe(0);
  });

  it('Destroyed cleans by window label only; close-requested does not end the lease', async () => {
    await installNotes();
    const note = create('destroy fence');
    const lease = await holdLease(note, A, B, 'destroy-op');
    host.events.length = 0;
    host.window(B, 'close-requested');
    host.window(B, 'blurred');
    expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
    expect(() => rawWrite(note)).toThrow('notes.lease_conflict');
    // Rust passes window=Some(label), webview=None: an unrelated webview label is ignored.
    host.window({ window: 'win-b', webview: 'some-other-view' }, 'destroyed');
    expect(host.eventsNamed('notes:lease-ended')).toEqual([
      { token: lease.token, note_ids: [note.id], reason: 'participant_closed_or_expired' },
    ]);
    expect(db().pluck('SELECT COUNT(*) FROM note_editor_participants WHERE window_label=?1', ['win-b'])).toBe(0);
    expect(db().pluck('SELECT COUNT(*) FROM note_editor_participants WHERE window_label=?1', ['win-a'])).toBe(1);
    expect(() => rawWrite(note)).not.toThrow();
    host.window({ window: 'view-a', webview: 'view-a' }, 'destroyed');
    expect(db().pluck('SELECT COUNT(*) FROM note_editor_participants WHERE window_label=?1', ['win-a'])).toBe(1);
  });

  it('V04-08: page-load-started releases the reloading webview and ends the lease it acked (lib.rs:487-491)', async () => {
    await installNotes();
    const note = create('reload fence');
    const lease = await holdLease(note, A, B, 'reload-op');
    host.events.length = 0;
    host.window(B, 'page-load-started');
    const probe = {
      remainingB: Number(db().pluck('SELECT COUNT(*) FROM note_editor_participants WHERE webview_label=?1', [B.webview])),
      ended: host.eventsNamed('notes:lease-ended').length,
    };
    expect(probe).toEqual({ remainingB: 0, ended: 1 });
    expect(host.eventsNamed('notes:lease-ended')).toEqual([
      { token: lease.token, note_ids: [note.id], reason: 'participant_closed_or_expired' },
    ]);
    expect(db().pluck('SELECT COUNT(*) FROM note_editor_participants WHERE webview_label=?1', [A.webview])).toBe(1);
    expect(() => rawWrite(note)).not.toThrow();
  });

  it('V04-08: page-load-started cleans by webview label only, not the other webviews of the same window', async () => {
    await installNotes();
    const note = create('reload sibling');
    const sibling: WindowRef = { window: B.window, webview: 'view-b-sibling' };
    await host.invoke<ParticipantStatus>('notes_editor_register', { noteId: note.id }, sibling);
    await holdLease(note, A, B, 'reload-sibling-op');
    host.window(B, 'page-load-started');
    const byWebview = (label: string) => Number(db().pluck(
      'SELECT COUNT(*) FROM note_editor_participants WHERE webview_label=?1', [label]));
    expect(byWebview(B.webview)).toBe(0);
    expect(byWebview(sibling.webview)).toBe(1);
    expect(byWebview(A.webview)).toBe(1);
    // Rust passes window=None: a window label that happens to match another view is not used.
    host.window({ window: A.webview, webview: 'unrelated-view' }, 'page-load-started');
    expect(byWebview(A.webview)).toBe(1);
  });

  it('cleanup failures only warn `Notes editor lease cleanup: {e}` and keep the lease', async () => {
    await installNotes();
    const note = create('warn fence');
    await holdLease(note, A, B, 'warn-op');
    host.events.length = 0;
    db().exec(`CREATE TRIGGER reject_participant_delete BEFORE DELETE ON note_editor_participants
      BEGIN SELECT RAISE(ABORT,'participant delete rejected'); END`);
    try {
      host.window(B, 'destroyed');
      expect(logs).toContain(
        'warn [notes] Notes editor lease cleanup: Database error: participant delete rejected');
      expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
      expect(rowCounts()).toEqual({ participants: 2, leases: 1 });
    } finally {
      db().exec('DROP TRIGGER reject_participant_delete');
    }
    const maintenance = await storage.enterMaintenance(['vfs']);
    try {
      logs.length = 0;
      vi.advanceTimersByTime(5000);
      expect(logs).toContain(
        'warn [notes] Notes editor lease cleanup: MAINTENANCE_MODE: vfs is temporarily unavailable');
    } finally {
      maintenance.release();
    }
    host.window(B, 'destroyed');
    expect(host.eventsNamed('notes:lease-ended')).toHaveLength(1);
  });

  it('unload releases the timer and Destroyed listener; reinstall restores both', async () => {
    await installNotes();
    const note = create('reinstall fence');
    const lease = await holdLease(note, A, B, 'reinstall-op');
    await host.unload('dstu.notes');
    expect(vi.getTimerCount()).toBe(0);
    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    host.window(B, 'destroyed');
    vi.advanceTimersByTime(60_000);
    expect(cleanup).not.toHaveBeenCalled();
    expect(rowCounts().leases).toBe(1);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([]);

    // Reinstall = restart: the startup reset frees the fence without ended events,
    // then the interval and the Destroyed listener are live again.
    await host.install(notes);
    await flushFirstTick();
    expect(vi.getTimerCount()).toBe(1);
    expect(rowCounts().leases).toBe(0);
    expect(() => rawWrite(note)).not.toThrow();
    expect(lease.token).toBeTruthy();
    const fresh = create('reinstall fence 2');
    const next = await holdLease(fresh, A, B, 'reinstall-op-2');
    host.window(A, 'destroyed');
    expect(host.eventsNamed('notes:lease-ended')).toEqual([
      { token: next.token, note_ids: [fresh.id], reason: 'participant_closed_or_expired' },
    ]);
    const before = cleanup.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(cleanup.mock.calls.length).toBe(before + 1);
  });
});
