// WP-174: lease cleanup interval. Rust (lib.rs:1347-1353, tokio 1.49 interval) bursts missed ticks;
// the Host deliberately coalesces them into one cleanup (src/lease-lifecycle.ts).
// All ticks come from installing the production plugin; repository spies call through.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import paths from '../../../platform/paths/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteLeaseRepository } from '../repository/leases.ts';
import type { LeaseCancellation, LeaseStatus, ParticipantStatus } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { VfsNote } from '../api.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let storage: ReturnType<typeof createStorageService>;
const warnings: string[] = [];
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const owner = { window: 'burst-owner', webview: 'burst-owner-view' };
const peer = { window: 'burst-peer', webview: 'burst-peer-view' };

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.type === 'warn' && message.name === 'notes') warnings.push(message.args.map(String).join(' '));
    },
  });
  await host.install(paths, vfsRepos);
}, 120000);

afterEach(async () => {
  await host.unload('dstu.notes');
  vi.restoreAllMocks();
  vi.useRealTimers();
  warnings.length = 0;
  host.events.length = 0;
});

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

function clock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'], now: T0,
  });
}

/** Delivers the plugin's deferred first tick (`setTimeout(tick, 0)`, lib.rs:1347-1353). */
async function firstTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Elapse monotonic time without delivering timer callbacks: a stalled event loop. */
function stall(milliseconds: number): void {
  const now = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => now() + milliseconds);
}

function db() { return storage.database('vfs'); }

async function hold(title: string): Promise<{ note: VfsNote; ended: LeaseCancellation }> {
  const note = noteRepository.createNote({ title, content: 'Before', tags: [] }, db());
  const participant = await host.invoke<ParticipantStatus>('notes_editor_register', { noteId: note.id }, owner);
  await host.invoke('notes_editor_register', { noteId: note.id }, peer);
  const lease = await host.invoke<LeaseStatus>('notes_editor_begin', {
    participantId: participant.participant_id, operationId: title, noteIds: [note.id],
  }, owner);
  return { note, ended: { token: lease.token, note_ids: [note.id], reason: 'participant_closed_or_expired' } };
}

describe('WP-174 production lease interval coalesces missed ticks', () => {
  it('a delayed first tick runs one cleanup and the next tick is a full period later', async () => {
    clock();
    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    await host.install(notes);
    expect(cleanup).toHaveBeenCalledTimes(1); // startup reset, before the async first tick
    cleanup.mockClear();
    stall(12_500);
    await firstTick();
    expect(cleanup.mock.calls).toEqual([[db(), T0 / 1000, null, null]]);
    expect(cleanup.mock.results.map((result) => result.value)).toEqual([[]]);
    vi.advanceTimersByTime(4999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.calls[1]).toEqual([db(), T0 / 1000 + 5, null, null]);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
  });

  it('a tick delayed past several periods runs once with current wall time and real cancellation', async () => {
    clock();
    await host.install(notes);
    await firstTick();
    const first = await hold('burst first');
    vi.setSystemTime(T0 + 5000);
    const second = await hold('burst second');
    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    vi.setSystemTime(T0 + 25_000);
    stall(12_500);
    vi.advanceTimersByTime(5000); // one delivered callback, monotonic time = 17.5s
    expect(cleanup.mock.calls).toEqual([[db(), T0 / 1000 + 30, null, null]]);
    expect(cleanup.mock.results.map((result) => result.value)).toEqual([[first.ended]]);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([first.ended]);
    expect(noteLeaseRepository.status(db(), first.ended.token)).toBeNull();
    expect(noteLeaseRepository.status(db(), second.ended.token)?.phase).toBe('pending');
    expect(() => db().run("UPDATE notes SET title='released' WHERE id=?1", [first.note.id])).not.toThrow();
    expect(() => db().run("UPDATE notes SET title='blocked' WHERE id=?1", [second.note.id])).toThrow('notes.lease_conflict');
    vi.advanceTimersByTime(4999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); // a full period after the coalesced cleanup
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.calls[1]).toEqual([db(), T0 / 1000 + 35, null, null]);
    expect(cleanup.mock.results[1]?.value).toEqual([second.ended]);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([first.ended, second.ended]);
    expect(vi.getTimerCount()).toBe(1);
    await host.unload('dstu.notes');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('wall-clock rollback and forward jumps change TTL but never create or postpone interval ticks', async () => {
    clock();
    await host.install(notes);
    await firstTick();
    const lease = await hold('wall clock');
    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    vi.setSystemTime(T0 - 60_000);
    vi.advanceTimersByTime(5000);
    expect(cleanup.mock.calls).toEqual([[db(), T0 / 1000 - 55, null, null]]);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
    expect(noteLeaseRepository.status(db(), lease.ended.token)?.phase).toBe('pending');
    vi.setSystemTime(T0 + 120_000);
    vi.advanceTimersByTime(4999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.calls[1]).toEqual([db(), T0 / 1000 + 125, null, null]);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([lease.ended]);
    expect(db().pluck('SELECT COUNT(*) FROM note_editor_participants')).toBe(0);
  });

  it('a failed coalesced tick warns once and the next tick still expires the real lease', async () => {
    clock();
    await host.install(notes);
    await firstTick();
    const lease = await hold('burst failure');
    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    db().exec(`CREATE TRIGGER reject_burst_cleanup BEFORE DELETE ON note_editor_participants
      BEGIN SELECT RAISE(ABORT,'burst cleanup rejected'); END`);
    try {
      vi.setSystemTime(T0 + 45_000);
      stall(12_500);
      vi.advanceTimersByTime(5000);
      expect(cleanup.mock.results.map((result) => result.type)).toEqual(['throw']);
      expect(warnings).toEqual(['Notes editor lease cleanup: Database error: burst cleanup rejected']);
      expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
      expect(db().pluck('SELECT COUNT(*) FROM note_editor_participants')).toBe(2);
      expect(noteLeaseRepository.status(db(), lease.ended.token)?.phase).toBe('pending');
    } finally {
      db().exec('DROP TRIGGER reject_burst_cleanup');
    }
    vi.advanceTimersByTime(5000);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.results[1]?.value).toEqual([lease.ended]);
    expect(warnings).toHaveLength(1);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([lease.ended]);
    expect(db().pluck('SELECT COUNT(*) FROM note_editor_participants')).toBe(0);
    expect(() => db().run("UPDATE notes SET title='recovered' WHERE id=?1", [lease.note.id])).not.toThrow();
  });

  it('unloading before the first tick cancels both the immediate and future ticks', async () => {
    clock();
    const cleanup = vi.spyOn(noteLeaseRepository, 'cleanup');
    await host.install(notes);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await host.unload('dstu.notes');
    expect(vi.getTimerCount()).toBe(0);
    await firstTick();
    vi.advanceTimersByTime(60_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.eventsNamed('notes:lease-ended')).toEqual([]);
  });
});
