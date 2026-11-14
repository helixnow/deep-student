/**
 * Shared harness for the remaining `sync_realistic_scenarios.rs` ports.
 *
 * The Rust file uses in-memory `SyncDevice`s and an inline
 * `apply_changes_to_db` helper (INSERT OR REPLACE / soft-delete SQL).  The
 * port keeps the scenario setup and assertions but routes every transfer
 * through the published L20 engine (`getPendingChanges` ->
 * `enrichChangesWithData` -> `applyDownloadedChanges`), exactly like the
 * existing S.01-S.15 port.  Devices are real F3 `StorageService` instances
 * with the production migrations applied for vfs / chat_v2 / mistakes.
 *
 * The Rust fixture uses `Utc::now()` (nanoseconds) for row timestamps.  Many
 * concurrent scenarios rely on the later writer winning; the harness keeps a
 * monotonic millisecond/ISO clock so the production LWW comparison observes
 * the same ordering instead of ties inside one millisecond.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../../notes/index.ts';
import syncSupport from '../../sync-support/index.ts';
import review from '../../review/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';

export type SyncDatabaseName = 'vfs' | 'chat_v2' | 'mistakes';

export interface RealisticDevice {
  name: string;
  deviceId: string;
  storage: StorageServiceImpl;
}

export interface HarnessPhaseEvent {
  stage: string;
  status: 'start' | 'end' | 'error';
  atMs: number;
  elapsedMs: number;
  detail: Readonly<Record<string, string | number>>;
  error?: unknown;
}

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

export class RealisticSyncHarness {
  private root = '';
  private hostValue: TestHost | undefined;
  private readonly devices = new Map<string, RealisticDevice>();
  private clock = Date.now();

  constructor(private readonly observe?: (event: HarnessPhaseEvent) => void) {}

  private phase<T>(stage: string, detail: HarnessPhaseEvent['detail'], operation: () => T): T {
    if (this.observe === undefined) return operation();
    const start = performance.now();
    this.observe({ stage, status: 'start', atMs: start, elapsedMs: 0, detail });
    try {
      const result = operation();
      const end = performance.now();
      this.observe({ stage, status: 'end', atMs: end, elapsedMs: end - start, detail });
      return result;
    } catch (error) {
      const end = performance.now();
      this.observe({ stage, status: 'error', atMs: end, elapsedMs: end - start, detail, error });
      throw error;
    }
  }

  private async asyncPhase<T>(stage: string, detail: HarnessPhaseEvent['detail'], operation: () => Promise<T>): Promise<T> {
    if (this.observe === undefined) return operation();
    const start = performance.now();
    this.observe({ stage, status: 'start', atMs: start, elapsedMs: 0, detail });
    try {
      const result = await operation();
      const end = performance.now();
      this.observe({ stage, status: 'end', atMs: end, elapsedMs: end - start, detail });
      return result;
    } catch (error) {
      const end = performance.now();
      this.observe({ stage, status: 'error', atMs: end, elapsedMs: end - start, detail, error });
      throw error;
    }
  }

  async init(): Promise<void> {
    this.root = await mkdtemp(join(tmpdir(), 'l23-realistic-extended-'));
    const templateBase = join(this.root, '_template');
    const templateStorage = this.phase('createStorageService', { device: '_template', base: templateBase },
      () => createStorageService({ baseDir: templateBase, dataLocalDir: templateBase }));
    await this.asyncPhase('migrations.runAll', { device: '_template' }, () => templateStorage.migrations.runAll());
    this.phase('storage.dispose', { device: '_template' }, () => templateStorage.dispose());
    const a = await this.device('A', 'device_a_001');

    const host = await createTestHost();
    this.hostValue = host;
    host.ctx.provide('storage', a.storage);
    host.ctx.provide('paths', {
      deviceId: async () => a.deviceId,
      dataSpaceDeviceId: async () => a.deviceId,
    });
    host.ctx.provide('secrets', { backup: createBackupCrypto() });
    host.ctx.provide('nativeCompression', compression);
    host.ctx.provide('backup', unused('backup'));
    host.ctx.provide('syncProvider', unused('syncProvider'));
    host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
    await host.install(vfsRepos);
    await host.install(notes);
    await host.install(syncSupport);
    await host.install(review);
    await host.install(sync);
  }

  get host(): TestHost {
    if (this.hostValue === undefined) throw new Error('harness not initialized');
    return this.hostValue;
  }

  async device(name: string, deviceId = `device_${name.toLowerCase()}_001`): Promise<RealisticDevice> {
    const cached = this.devices.get(name);
    if (cached !== undefined) return cached;
    const base = join(this.root, `device-${name}`);
    await cp(join(this.root, '_template'), base, { recursive: true });
    const storage = this.phase('createStorageService', { device: name, base },
      () => createStorageService({ baseDir: base, dataLocalDir: base }));
    const device: RealisticDevice = { name, deviceId, storage };
    this.devices.set(name, device);
    return device;
  }

  async disposeDevice(name: string): Promise<void> {
    const device = this.devices.get(name);
    if (device === undefined) return;
    this.devices.delete(name);
    device.storage.dispose();
    await rm(join(this.root, `device-${name}`), { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    await this.asyncPhase('host.dispose', {}, async () => { await this.hostValue?.dispose(); });
    for (const device of this.devices.values()) {
      this.phase('storage.dispose', { device: device.name }, () => device.storage.dispose());
    }
    this.devices.clear();
    if (this.root !== '') {
      await this.asyncPhase('rm', { root: this.root }, () => rm(this.root, { recursive: true, force: true }));
    }
  }

  db(device: RealisticDevice, name: SyncDatabaseName): DatabaseHandle {
    return device.storage.database(name);
  }

  /** Next strictly increasing ISO-8601 timestamp (millisecond precision). */
  nextIso(): string {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return new Date(this.clock).toISOString();
  }

  /** Next strictly increasing millisecond timestamp. */
  nextMs(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  /** `full_sync_cycle_<db>` for a single database: A -> B, then B -> A. */
  fullSyncCycle(from: RealisticDevice, to: RealisticDevice, database: SyncDatabaseName): [number, number] {
    const toTarget = this.applyPending(from, to, database);
    const toSource = this.applyPending(to, from, database);
    return [toTarget, toSource];
  }

  /** `full_sync_cycle_all`: vfs + chat_v2 + mistakes. */
  fullSyncCycleAll(from: RealisticDevice, to: RealisticDevice): [number, number] {
    let toTarget = 0;
    let toSource = 0;
    for (const database of ['vfs', 'chat_v2', 'mistakes'] as const) {
      const [forward, reverse] = this.fullSyncCycle(from, to, database);
      toTarget += forward;
      toSource += reverse;
    }
    return [toTarget, toSource];
  }

  /** `collect_pending_changes` + `enrichChangesWithData` for a database. */
  collectPending(from: RealisticDevice, database: SyncDatabaseName): EngineChange[] {
    const engine = this.host.ctx.sync;
    const pending = engine.getPendingChanges(this.db(from, database), null, null);
    if (pending.total_count === 0) return [];
    const changes = engine.enrichChangesWithData(this.db(from, database), pending.entries, null);
    for (const change of changes) {
      change.database_name = database;
      change.suppress_change_log = true;
    }
    return changes;
  }

  /** `apply_changes_to_db` equivalent for a previously collected batch. */
  applyChanges(to: RealisticDevice, database: SyncDatabaseName, changes: readonly EngineChange[]): number {
    if (changes.length === 0) return 0;
    return this.phase('applyDownloadedChanges', { device: to.name, database, changes: changes.length },
      () => this.host.ctx.sync.applyDownloadedChanges(this.db(to, database), changes, {
        deviceId: to.deviceId,
      }).success_count);
  }

  /** `mark_synced_with_timestamp` after a successful upload/apply. */
  markSynced(from: RealisticDevice, database: SyncDatabaseName, changes: readonly EngineChange[]): void {
    const ids = changes
      .map(change => change.change_log_id)
      .filter((id): id is number => typeof id === 'number');
    if (ids.length > 0) this.host.ctx.sync.markSyncedWithTimestamp(this.db(from, database), ids);
  }

  /** `collect_pending_changes` + `apply_changes_to_db` for one direction. */
  applyPending(from: RealisticDevice, to: RealisticDevice, database: SyncDatabaseName): number {
    return this.phase('applyPending', { from: from.name, to: to.name, database }, () => {
      const changes = this.collectPending(from, database);
      if (changes.length === 0) return 0;
      const applied = this.applyChanges(to, database, changes);
      this.markSynced(from, database, changes);
      return applied;
    });
  }
}

export function column(
  db: DatabaseHandle,
  table: string,
  id: string,
  columnName: string,
  idColumn = 'id',
): string | null {
  return db.pluck<string | null>(
    `SELECT "${columnName}" FROM "${table}" WHERE "${idColumn}"=?1`, [id],
  ) ?? null;
}

export function columnMs(
  db: DatabaseHandle,
  table: string,
  id: string,
  columnName: string,
  idColumn = 'id',
): number | null {
  const value = db.pluck<number | string | null>(
    `SELECT "${columnName}" FROM "${table}" WHERE "${idColumn}"=?1`, [id],
  );
  return value === null || value === undefined ? null : Number(value);
}

export function rowCount(db: DatabaseHandle, table: string): number {
  return Number(db.pluck<number>(`SELECT COUNT(*) FROM "${table}"`) ?? 0);
}

export function scalarNumber(db: DatabaseHandle, sql: string, params: readonly unknown[] = []): number {
  return Number(db.pluck<number>(sql, params as never[]) ?? 0);
}

export function tableExists(db: DatabaseHandle, table: string): boolean {
  return db.pluck<string>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?1", [table],
  ) !== undefined;
}

export function deleteIfExists(db: DatabaseHandle, table: string): void {
  if (!tableExists(db, table)) return;
  db.exec(`DELETE FROM "${table}"`);
}

export function clearBusinessTables(db: DatabaseHandle, tables: readonly string[]): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of tables) deleteIfExists(db, table);
    deleteIfExists(db, '__sync_delete_versions');
    deleteIfExists(db, '__sync_conflicts');
    deleteIfExists(db, '__change_log');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const VFS_TABLES = [
  'note_editor_lease_notes',
  'note_editor_lease_acks',
  'note_editor_leases',
  'note_editor_participants',
  'note_review_save_receipts',
  'note_review_save_operations',
  'note_document_revisions',
  'note_document_formats',
  'note_learning_relations',
  'note_transfer_operations',
  'note_state',
  'note_tags',
  'note_links',
  'pomodoro_records',
  'todo_items',
  'todo_lists',
  'folder_items',
  'folders',
  'review_plans',
  'questions',
  'exam_sheets',
  'mindmaps',
  'translations',
  'essays',
  'notes',
  'answer_submissions',
  'blobs',
  'resources',
] as const;

export const CHAT_V2_TABLES = [
  'chat_v2_attachments',
  'chat_v2_blocks',
  'chat_v2_messages',
  'chat_v2_session_mistakes',
  'chat_v2_sessions',
  'chat_v2_session_groups',
  'workspace_index',
  'resources',
] as const;

export const MISTAKES_TABLES = [
  'chat_messages',
  'review_chat_messages',
  'review_session_mistakes',
  'review_sessions',
  'anki_cards',
  'document_tasks',
  'review_analyses',
  'custom_anki_templates',
  'mistakes',
] as const;
