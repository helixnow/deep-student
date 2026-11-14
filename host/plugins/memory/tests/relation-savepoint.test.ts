/**
 * Rust `add_relation_with_occ` / `remove_relation_with_occ` (service.rs:3605-3705,
 * 3723-3833) through the real L10 notes owner: both endpoints are read and
 * version-checked before `SAVEPOINT memory_*_relation`, a failing second write rolls
 * back the first, and the success info precedes the audit row (D1-L17-M04/M03).
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vfsPlugin from '../../vfs/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import vfsIndexPlugin from '../../vfs-index/index.ts';
import mediaPlugin from '../../media/index.ts';
import vfsHandlersPlugin from '../../vfs-handlers/index.ts';
import memoryPlugin from '../index.ts';
import type { MemoryWriteOutput } from '../api.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';

interface LogEntry { level: string; message: string; audits: number | null }

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function setup() {
  const { dir, storage, report } = await createMigratedMemoryStorage('memory-relation-sp-');
  expect(report.success).toBe(true);
  const settings = createSettingsService({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    secrets: { isSensitiveKey: () => false },
  });
  const logs: LogEntry[] = [];
  const watch: { db?: DatabaseHandle; operation?: string } = {};
  const record = (level: string, target: string, message: string): void => {
    if (target !== 'dstu_memory::memory') return;
    const { db, operation } = watch;
    logs.push({
      level, message,
      audits: db === undefined || operation === undefined ? null : db.pluck<number>(
        'SELECT COUNT(*) FROM memory_audit_log WHERE operation = ?1', [operation]) ?? 0,
    });
  };
  const log = {
    logger: (target: string) => ({
      target,
      error: (message: string) => record('error', target, String(message)),
      warn: (message: string) => record('warn', target, String(message)),
      info: (message: string) => record('info', target, String(message)),
      debug: () => undefined,
      trace: () => undefined,
    }),
    write: () => undefined,
  };
  let host: TestHost | undefined;
  const competitors: DatabaseHandle[] = [];
  cleanup = async () => {
    for (const handle of competitors) storage.close(handle);
    await host?.dispose();
    storage.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  host = await createTestHost({
    plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, vfsIndexPlugin, vfsPlugin,
      mediaPlugin, vfsHandlersPlugin, memoryPlugin],
    provide: { storage, settings, log },
    app: { dataDir: dir },
  });
  const db = storage.database('vfs');
  const service = host.ctx.memory as unknown as MemoryServiceImpl;
  const openCompetitor = (): DatabaseHandle => {
    const handle = storage.openFile(storage.pathOf('vfs'), {
      label: 'relation-competitor', profile: 'vfs', mustExist: true,
    });
    competitors.push(handle);
    return handle;
  };
  return { host, db, service, logs, watch, openCompetitor };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function writePair(fx: Fixture) {
  const a = await fx.host.invoke('memory_write', { title: 'Relation A', content: 'alpha' }) as MemoryWriteOutput;
  const b = await fx.host.invoke('memory_write', { title: 'Relation B', content: 'beta' }) as MemoryWriteOutput;
  return { a: a.noteId, b: b.noteId };
}

function snapshot(db: DatabaseHandle, noteId: string) {
  return {
    tags: JSON.parse(db.pluck<string>('SELECT tags FROM notes WHERE id = ?1', [noteId]) ?? 'null') as unknown,
    updatedAt: db.pluck<string>('SELECT updated_at FROM notes WHERE id = ?1', [noteId]),
    revisions: db.pluck<number>('SELECT COUNT(*) FROM note_document_revisions WHERE note_id = ?1', [noteId]),
  };
}

function auditCount(db: DatabaseHandle, operation: string): number {
  return db.pluck<number>('SELECT COUNT(*) FROM memory_audit_log WHERE operation = ?1', [operation]) ?? 0;
}

/** Real SQLite failure on the second endpoint's UPDATE (after the first endpoint wrote). */
function failUpdatesOf(db: DatabaseHandle, noteId: string): void {
  db.exec(`CREATE TRIGGER relation_second_write_fails BEFORE UPDATE OF tags ON notes
    WHEN NEW.id = '${noteId}' BEGIN SELECT RAISE(ABORT, 'relation endpoint B locked'); END`);
}

describe('Rust service.rs relation OCC then same-connection SAVEPOINT (D1-L17-M04/M03)', () => {
  it('add_relation_with_occ: stale version under a held write lock fails as conflict before any savepoint', async () => {
    const fx = await setup();
    const { a, b } = await writePair(fx);
    const before = { a: snapshot(fx.db, a), b: snapshot(fx.db, b) };
    const competitor = fx.openCompetitor();
    // Another connection owns the RESERVED lock, like a concurrent Rust writer.
    competitor.exec('BEGIN IMMEDIATE');
    const startedAt = Date.now();
    let caught: unknown;
    try {
      fx.service.addRelationWithOcc(a, before.a.updatedAt!, b, 'stale-version');
    } catch (error) {
      caught = error;
    } finally {
      competitor.exec('ROLLBACK');
    }
    const elapsedMs = Date.now() - startedAt;
    // OCC is checked with plain reads (WAL readers ignore the held lock), so the result is the
    // version conflict, not SQLITE_BUSY after the vfs profile's 5000 ms busy_timeout.
    expect(String(caught)).toMatch(/CONFLICT\(notes\.conflict\)/);
    expect(String(caught)).not.toMatch(/busy|locked/i);
    expect(elapsedMs).toBeLessThan(2500);
    expect(fx.db.inTransaction).toBe(false);
    expect({ a: snapshot(fx.db, a), b: snapshot(fx.db, b) }).toEqual(before);
    expect(auditCount(fx.db, 'add_relation')).toBe(0);
    expect(fx.logs.some(entry => entry.message.startsWith('[Memory] Added relation'))).toBe(false);
  });

  it('memory_add_relation: success and duplicate both log Added relation before the audit row', async () => {
    const fx = await setup();
    const { a, b } = await writePair(fx);
    const initial = { a: snapshot(fx.db, a), b: snapshot(fx.db, b) };
    fx.watch.db = fx.db;
    fx.watch.operation = 'add_relation';
    const expected = `[Memory] Added relation: ${a} <-> ${b}`;

    await expect(fx.host.invoke('memory_add_relation', { noteIdA: a, noteIdB: b })).resolves.toBeNull();
    const added = { a: snapshot(fx.db, a), b: snapshot(fx.db, b) };
    expect(added.a.tags).toEqual([...(initial.a.tags as string[]), `_ref:${b}`]);
    expect(added.b.tags).toEqual([...(initial.b.tags as string[]), `_ref:${a}`]);
    expect(added.a.updatedAt).not.toBe(initial.a.updatedAt);
    expect(added.b.updatedAt).not.toBe(initial.b.updatedAt);
    expect(fx.logs.filter(entry => entry.message === expected)).toEqual([
      { level: 'info', message: expected, audits: 0 },
    ]);
    expect(auditCount(fx.db, 'add_relation')).toBe(1);

    // Duplicate: no write, versions unchanged, but Rust still logs info then audits.
    await expect(fx.host.invoke('memory_add_relation', { noteIdA: a, noteIdB: b })).resolves.toBeNull();
    expect({ a: snapshot(fx.db, a), b: snapshot(fx.db, b) }).toEqual(added);
    expect(fx.logs.filter(entry => entry.message === expected)).toEqual([
      { level: 'info', message: expected, audits: 0 },
      { level: 'info', message: expected, audits: 1 },
    ]);
    expect(auditCount(fx.db, 'add_relation')).toBe(2);
    expect(fx.db.inTransaction).toBe(false);
  });

  it('memory_add_relation: second endpoint write failure rolls back the first endpoint', async () => {
    const fx = await setup();
    const { a, b } = await writePair(fx);
    const before = { a: snapshot(fx.db, a), b: snapshot(fx.db, b) };
    failUpdatesOf(fx.db, b);

    await expect(fx.host.invoke('memory_add_relation', { noteIdA: a, noteIdB: b }))
      .rejects.toThrow(/relation endpoint B locked/);
    expect(fx.db.inTransaction).toBe(false);
    // A's tags, version and the owner's revision snapshots are all undone.
    expect({ a: snapshot(fx.db, a), b: snapshot(fx.db, b) }).toEqual(before);
    expect(auditCount(fx.db, 'add_relation')).toBe(0);
    expect(fx.logs.some(entry => entry.message.startsWith('[Memory] Added relation'))).toBe(false);

    fx.db.exec('DROP TRIGGER relation_second_write_fails');
    await expect(fx.host.invoke('memory_add_relation', { noteIdA: a, noteIdB: b })).resolves.toBeNull();
    expect(fx.service.getRelated(a)).toEqual([b]);
    expect(fx.service.getRelated(b)).toEqual([a]);
  });

  it('add_relation_with_occ: existing one-way ref only writes the missing endpoint; empty version is invalid', async () => {
    const fx = await setup();
    const { a, b } = await writePair(fx);
    fx.db.run('UPDATE notes SET tags = ?1 WHERE id = ?2', [JSON.stringify(['keep', `_ref:${b}`]), a]);
    const before = { a: snapshot(fx.db, a), b: snapshot(fx.db, b) };

    expect(() => fx.service.addRelationWithOcc(a, '  ', b, before.b.updatedAt!))
      .toThrow("Invalid argument 'expected_updated_at': expected_updated_at must not be empty");
    expect({ a: snapshot(fx.db, a), b: snapshot(fx.db, b) }).toEqual(before);

    const result = fx.service.addRelationWithOcc(a, before.a.updatedAt!, b, before.b.updatedAt!);
    expect(result.changed).toBe(true);
    expect(result.noteA.updatedAt).toBe(before.a.updatedAt);
    expect(result.noteB.updatedAt).not.toBe(before.b.updatedAt);
    expect(snapshot(fx.db, a)).toEqual(before.a);
    expect(snapshot(fx.db, b).tags).toEqual([...(before.b.tags as string[]), `_ref:${a}`]);
    expect(snapshot(fx.db, b).updatedAt).toBe(result.noteB.updatedAt);
  });

  it('memory_remove_relation: info before audit; second endpoint failure rolls back the first', async () => {
    const fx = await setup();
    const { a, b } = await writePair(fx);
    await fx.host.invoke('memory_add_relation', { noteIdA: a, noteIdB: b });
    const linked = { a: snapshot(fx.db, a), b: snapshot(fx.db, b) };
    fx.watch.db = fx.db;
    fx.watch.operation = 'remove_relation';
    const expected = `[Memory] Removed relation: ${a} <-> ${b}`;

    failUpdatesOf(fx.db, b);
    await expect(fx.host.invoke('memory_remove_relation', { noteIdA: a, noteIdB: b }))
      .rejects.toThrow(/relation endpoint B locked/);
    expect(fx.db.inTransaction).toBe(false);
    expect({ a: snapshot(fx.db, a), b: snapshot(fx.db, b) }).toEqual(linked);
    expect(fx.logs.some(entry => entry.message === expected)).toBe(false);
    expect(auditCount(fx.db, 'remove_relation')).toBe(0);

    fx.db.exec('DROP TRIGGER relation_second_write_fails');
    await expect(fx.host.invoke('memory_remove_relation', { noteIdA: a, noteIdB: b })).resolves.toBeNull();
    expect(fx.service.getRelated(a)).toEqual([]);
    expect(fx.service.getRelated(b)).toEqual([]);
    expect(fx.logs.filter(entry => entry.message === expected)).toEqual([
      { level: 'info', message: expected, audits: 0 },
    ]);
    expect(auditCount(fx.db, 'remove_relation')).toBe(1);
  });
});
