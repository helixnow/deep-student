import * as path from '../../../platform/util/path.ts';
import type { Context } from '@deepseek-ai/cordis';
import { StorageError, type DatabaseHandle, type MaintenanceLease, type StorageService } from '../../../platform/storage/api.ts';
import { CURRENT_SCHEMA_VERSION, type VfsDatabase, type VfsDatabaseStats } from '../portable.ts';
import { VfsError } from './error.ts';
import { foreignKeys, readSchemaVersion, statistics } from '../repository/database.ts';
import { fs, LocalRuntimeUnavailableError } from './local-runtime.ts';

/** vfs/database.rs over the shared F3 connection owner. */
export class VfsDatabaseImpl implements VfsDatabase {
  readonly _storage: StorageService;
  readonly _log: Context['logger'];
  readonly _blobsDir: string;
  _maintenance = false;
  _lease: MaintenanceLease | undefined;
  constructor(storage: StorageService, log: Context['logger']) {
    this._storage = storage;
    this._log = log;
    const databasesDir = path.dirname(storage.pathOf('vfs'));
    this._blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
    for (const [dir, label] of [[databasesDir, 'databases'], [this._blobsDir, 'vfs_blobs']]) {
      try { fs.mkdirSync(dir!, { recursive: true }); }
      catch (error) {
        if (error instanceof LocalRuntimeUnavailableError) continue;
        throw new VfsError('Io', `Failed to create ${label} directory: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.isForeignKeysEnabled();
  }
  getConn(): DatabaseHandle {
    if (this._maintenance) throw new VfsError('Maintenance', { component: 'vfs' });
    try { return this._storage.database('vfs'); }
    catch (error) {
      if (error instanceof StorageError && error.code === 'MAINTENANCE') throw new VfsError('Maintenance', { component: 'vfs' });
      throw new VfsError('Pool', `Failed to get connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // F3 owns connection recovery; Node has no poisoned RwLock or exhausted r2d2 pool.
  getConnSafe(): DatabaseHandle { return this.getConn(); }
  dbPath(): string { return this._storage.pathOf('vfs'); }
  blobsDir(): string { return this._blobsDir; }
  appDataDir(): string { return path.dirname(this._blobsDir); }
  async enterMaintenanceMode(): Promise<void> {
    if (this._maintenance) throw new VfsError('InvalidState', { message: 'VFS 已处于数据治理维护模式' });
    this._maintenance = true;
    try { this._lease = await this._storage.enterMaintenance(['vfs'], { drainTimeoutMs: 5000 }); }
    catch (error) {
      this._maintenance = false;
      if (error instanceof StorageError && error.code === 'MAINTENANCE_DRAIN_TIMEOUT') {
        // F3 permits one active asynchronous transaction per database.
        throw new VfsError('InvalidState', { message: '等待 VFS 活动连接归还超时（仍有 1 个租约）' });
      }
      throw new VfsError('Database', error instanceof Error ? error.message : String(error));
    }
  }
  async exitMaintenanceMode(): Promise<void> {
    this._lease?.release();
    this._lease = undefined;
    // Force the replacement file to be opened before removing the local gate.
    try { this._storage.database('vfs').pluck(foreignKeys); }
    catch (error) { throw new VfsError('Pool', `Failed to create connection pool: ${error instanceof Error ? error.message : String(error)}`); }
    this._maintenance = false;
  }
  isInMaintenanceMode(): boolean { return this._maintenance; }
  async reinitialize(): Promise<void> {
    if (this._maintenance) throw new VfsError('Maintenance', { component: 'vfs' });
    await this.enterMaintenanceMode();
    await this.exitMaintenanceMode();
  }
  isForeignKeysEnabled(): boolean {
    const conn = this.getConn();
    try { return conn.pluck<number>(foreignKeys) === 1; }
    catch (error) { throw new VfsError('Database', error instanceof Error ? error.message : String(error)); }
  }
  getSchemaVersion(): number { return readSchemaVersion(this.getConn()); }
  getStatistics(): VfsDatabaseStats {
    const conn = this.getConn();
    try { return { ...conn.one(statistics), schema_version: CURRENT_SCHEMA_VERSION }; }
    catch (error) {
      this._log.error('[VFS::Database] Failed to query statistics: %s', error);
      return { resource_count: 0, note_count: 0, textbook_count: 0, exam_count: 0, translation_count: 0, essay_count: 0, blob_count: 0, schema_version: CURRENT_SCHEMA_VERSION };
    }
  }
}
