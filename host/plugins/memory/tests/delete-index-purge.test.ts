/**
 * Rust `MemoryService::delete_with_source` (service.rs:3416-3484) through the
 * real L10/L11/L12 owners: direct Lance delete warns only, the L11 purge runs
 * independently, then disabled state, incoming `_ref` cleanup, the success
 * info, and finally the audit row.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vfsPlugin from '../../vfs/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import vfsIndexPlugin from '../../vfs-index/index.ts';
import mediaPlugin from '../../media/index.ts';
import vfsHandlersPlugin from '../../vfs-handlers/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import memoryPlugin from '../index.ts';
import type { MemoryWriteOutput } from '../api.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';

interface LogEntry {
  level: string;
  target: string;
  message: string;
  deleteAudits: number | null;
  indexState: string | null;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function setup(vector: { connect(path: string): Promise<never> } | undefined) {
  const { dir, storage, report } = await createMigratedMemoryStorage('memory-delete-purge-');
  expect(report.success).toBe(true);
  const settings = createSettingsService({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    secrets: { isSensitiveKey: () => false },
  });
  const logs: LogEntry[] = [];
  const watch: { db?: DatabaseHandle; noteId?: string; resourceId?: string } = {};
  const record = (level: string, target: string, message: string): void => {
    const { db, noteId, resourceId } = watch;
    logs.push({
      level, target, message,
      deleteAudits: db === undefined || noteId === undefined ? null : db.pluck<number>(
        "SELECT COUNT(*) FROM memory_audit_log WHERE note_id = ?1 AND operation = 'delete'", [noteId]) ?? 0,
      indexState: db === undefined || resourceId === undefined ? null : db.pluck<string>(
        'SELECT index_state FROM resources WHERE id = ?1', [resourceId]) ?? null,
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
  cleanup = async () => {
    await host?.dispose();
    storage.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  host = await createTestHost({
    plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, vfsIndexPlugin, vfsPlugin,
      mediaPlugin, vfsHandlersPlugin, memoryPlugin],
    provide: {
      storage, settings, log, ...(vector === undefined ? {} : { vector }),
      files: createNodeFiles({ roots: [{ name: 'appData', path: dir }, { name: 'temp', path: tmpdir() }] }),
      // Post-write category refresh needs the memory-decision model (category_manager.rs:241).
      llmRawPrompt: { callMemoryDecisionRawPrompt: async () => ({ assistant_message: '- 摘要' }) },
    },
    app: { dataDir: dir },
  });
  const db = storage.database('vfs');
  const repos = host.ctx.get('vfsRepo') as VfsReposService;
  return { host, db, repos, logs, watch };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Writes a note, waits for its fire-and-forget immediate index, then seeds one unit + segment. */
async function writeIndexedNote(fx: Fixture, title: string, lanceRowId: string) {
  const written = await fx.host.invoke('memory_write', { title, content: `${title} body` }) as MemoryWriteOutput;
  await vi.waitFor(() => {
    expect(fx.logs.some(entry => entry.message.includes('Immediate index')
      && entry.message.includes(written.resourceId))).toBe(true);
  });
  const unit = fx.repos.embeddingUnits.create(fx.db, {
    resourceId: written.resourceId, unitIndex: 900, imageBlobHash: null, imageMimeType: null,
    textContent: `${title} body`, textSource: 'native',
  });
  fx.repos.embeddingSegments.create(fx.db, {
    unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 4, lanceRowId,
    contentText: `${title} body`, contentHash: null, startPos: 0, endPos: 1, metadataJson: null,
  });
  return written;
}

function counts(db: DatabaseHandle, resourceId: string, lanceRowId: string) {
  return {
    units: db.pluck<number>('SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = ?1', [resourceId]),
    segments: db.pluck<number>(
      `SELECT COUNT(*) FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id = u.id
       WHERE u.resource_id = ?1`, [resourceId]),
    orphanSegments: db.pluck<number>(
      'SELECT COUNT(*) FROM vfs_index_segments WHERE lance_row_id = ?1', [lanceRowId]),
    queued: db.get<{ resource_id: string | null }>(
      'SELECT resource_id FROM __lance_orphan_queue WHERE lance_row_id = ?1', [lanceRowId]),
  };
}

const memoryLogs = (logs: readonly LogEntry[]) => logs.filter(entry => entry.target === 'dstu_memory::memory');

describe('Rust service.rs:3416 delete_with_source index cleanup (D1-L17-M02/M03)', () => {
  it('delete_with_source: Lance delete failure only warns; purge still queues orphans; info precedes audit', async () => {
    const fx = await setup({ connect: async () => { throw new Error('vector engine offline'); } });
    const target = await writeIndexedNote(fx, 'Delete target', 'lance-row-target');
    const referrer = await fx.host.invoke('memory_write', {
      title: 'Referrer', content: 'points at target',
    }) as MemoryWriteOutput;
    fx.db.run('UPDATE notes SET tags = ?1 WHERE id = ?2',
      [JSON.stringify(['keep', `_ref:${target.noteId}`]), referrer.noteId]);
    const seeded = counts(fx.db, target.resourceId, 'lance-row-target');
    expect(seeded.units).toBeGreaterThanOrEqual(1);
    expect(seeded).toMatchObject({ segments: 1, orphanSegments: 1, queued: undefined });

    fx.watch.db = fx.db;
    fx.watch.noteId = target.noteId;
    fx.watch.resourceId = target.resourceId;
    const before = fx.logs.length;
    await expect(fx.host.invoke('memory_delete', { noteId: target.noteId })).resolves.toBeNull();

    expect(fx.db.pluck<string>('SELECT deleted_at FROM notes WHERE id = ?1', [target.noteId])).toBeTruthy();
    expect(counts(fx.db, target.resourceId, 'lance-row-target')).toEqual({
      units: 0, segments: 0, orphanSegments: 0, queued: { resource_id: target.resourceId },
    });
    expect(fx.db.pluck<string>('SELECT index_state FROM resources WHERE id = ?1', [target.resourceId]))
      .toBe('disabled');
    expect(JSON.parse(fx.db.pluck<string>('SELECT tags FROM notes WHERE id = ?1', [referrer.noteId])!))
      .toEqual(['keep']);

    const deleteLogs = memoryLogs(fx.logs.slice(before));
    const lanceWarn = deleteLogs.findIndex(entry => entry.level === 'warn' && entry.message.startsWith(
      `[Memory] Failed to delete lance index for ${target.resourceId} (will rely on disabled state): `));
    expect(lanceWarn).toBeGreaterThanOrEqual(0);
    expect(deleteLogs[lanceWarn]!.message).toContain('vector engine offline');
    // The warn fires before the purge and disabled marker ran.
    expect(deleteLogs[lanceWarn]!.indexState).not.toBe('disabled');
    expect(deleteLogs.some(entry => entry.message.startsWith('[Memory] Failed to purge index artifacts'))).toBe(false);
    const refInfo = deleteLogs.findIndex(entry => entry.level === 'info'
      && entry.message === `[Memory] Removed dangling _ref tags pointing to ${target.noteId} from 1 notes`);
    const deletedInfo = deleteLogs.findIndex(entry => entry.level === 'info'
      && entry.message === `[Memory] Deleted note: ${target.noteId}`);
    expect(refInfo).toBeGreaterThan(lanceWarn);
    expect(deletedInfo).toBeGreaterThan(refInfo);
    expect(deleteLogs[refInfo]!.indexState).toBe('disabled');
    expect(deleteLogs[deletedInfo]!.deleteAudits).toBe(0);
    expect(fx.db.pluck<number>(
      "SELECT COUNT(*) FROM memory_audit_log WHERE note_id = ?1 AND operation = 'delete' AND success = 1",
      [target.noteId])).toBe(1);
  });

  it('delete_with_source: successful delete logs Deleted note before the audit row', async () => {
    const fx = await setup(undefined);
    const target = await writeIndexedNote(fx, 'Plain delete', 'lance-row-plain');
    fx.watch.db = fx.db;
    fx.watch.noteId = target.noteId;
    fx.watch.resourceId = target.resourceId;
    // The write's own background maintenance (and its one-time warnings) must finish outside the slice.
    await (fx.host.ctx.memory as unknown as MemoryServiceImpl).spawnPostWriteMaintenance();
    const before = fx.logs.length;
    await expect(fx.host.invoke('memory_delete', { noteId: target.noteId })).resolves.toBeNull();

    expect(counts(fx.db, target.resourceId, 'lance-row-plain')).toEqual({
      units: 0, segments: 0, orphanSegments: 0, queued: { resource_id: target.resourceId },
    });
    const deleteLogs = memoryLogs(fx.logs.slice(before));
    expect(deleteLogs.filter(entry => entry.level === 'warn')).toEqual([]);
    const deletedInfo = deleteLogs.findIndex(entry => entry.level === 'info'
      && entry.message === `[Memory] Deleted note: ${target.noteId}`);
    expect(deletedInfo).toBeGreaterThanOrEqual(0);
    expect(deleteLogs[deletedInfo]!.deleteAudits).toBe(0);
    expect(deleteLogs[deletedInfo]!.indexState).toBe('disabled');
    expect(fx.db.pluck<number>(
      "SELECT COUNT(*) FROM memory_audit_log WHERE note_id = ?1 AND operation = 'delete'",
      [target.noteId])).toBe(1);
  });

  it('delete_with_source: purge failure only warns; disabled, ref cleanup, info and audit still follow', async () => {
    const fx = await setup(undefined);
    const target = await writeIndexedNote(fx, 'Purge fails', 'lance-row-purge');
    const seeded = counts(fx.db, target.resourceId, 'lance-row-purge');
    expect(seeded).toMatchObject({ segments: 1, orphanSegments: 1 });
    fx.db.exec('ALTER TABLE __lance_orphan_queue RENAME TO __lance_orphan_queue_moved');
    fx.watch.db = fx.db;
    fx.watch.noteId = target.noteId;
    fx.watch.resourceId = target.resourceId;
    const before = fx.logs.length;
    await expect(fx.host.invoke('memory_delete', { noteId: target.noteId })).resolves.toBeNull();

    expect(fx.db.pluck<string>('SELECT deleted_at FROM notes WHERE id = ?1', [target.noteId])).toBeTruthy();
    // The purge statement failed before deleting units, so the artifacts stay for the drain/sweeper.
    expect(fx.db.pluck<number>('SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = ?1',
      [target.resourceId])).toBe(seeded.units);
    expect(fx.db.pluck<number>('SELECT COUNT(*) FROM vfs_index_segments WHERE lance_row_id = ?1',
      ['lance-row-purge'])).toBe(1);
    expect(fx.db.pluck<string>('SELECT index_state FROM resources WHERE id = ?1', [target.resourceId]))
      .toBe('disabled');
    const deleteLogs = memoryLogs(fx.logs.slice(before));
    const purgeWarn = deleteLogs.findIndex(entry => entry.level === 'warn' && entry.message.startsWith(
      `[Memory] Failed to purge index artifacts for ${target.resourceId}: `));
    expect(purgeWarn).toBeGreaterThanOrEqual(0);
    expect(deleteLogs[purgeWarn]!.message).toContain('__lance_orphan_queue');
    expect(deleteLogs[purgeWarn]!.indexState).not.toBe('disabled');
    const deletedInfo = deleteLogs.findIndex(entry => entry.level === 'info'
      && entry.message === `[Memory] Deleted note: ${target.noteId}`);
    expect(deletedInfo).toBeGreaterThan(purgeWarn);
    expect(deleteLogs[deletedInfo]!.deleteAudits).toBe(0);
    expect(fx.db.pluck<number>(
      "SELECT COUNT(*) FROM memory_audit_log WHERE note_id = ?1 AND operation = 'delete'",
      [target.noteId])).toBe(1);
  });
});
