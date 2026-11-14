// Port of dstu-browser/src/browser/database.rs: lazy browser.db lifecycle.
// StorageService owns the connection pool and applies the browser refinery migration
// on first open, mirroring `BrowserDatabase::ensure_open`.

import { dirname } from 'node:path';
import type { DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import { BrowserFailure, browserNotOpen } from './error.ts';
import { foreignKeysEnabled, readSchemaVersion } from '../repository/schema.ts';

export const DATABASE_FILENAME = 'browser.db';
/** Latest refinery migration (`V20260711__init.sql`); the history table stays authoritative. */
export const CURRENT_SCHEMA_VERSION = 20260711;

export type BrowserStorage = Pick<StorageService, 'database' | 'pathOf'>;

/** Best-effort WAL checkpoint on close; Rust ignores checkpoint failures. */
function tryCheckpoint(handle: DatabaseHandle): boolean {
  try {
    handle.checkpoint('TRUNCATE');
    return true;
  } catch {
    return false;
  }
}

/** Lazily opened browser database. Constructing never touches disk. */
export class BrowserDatabase {
  private readonly storage: BrowserStorage;
  private handle: DatabaseHandle | null = null;
  private opened = false;

  constructor(storage: BrowserStorage) {
    this.storage = storage;
  }

  activeDir(): string {
    return dirname(this.dbPath());
  }

  /** Database file path (may not exist yet). */
  dbPath(): string {
    return this.storage.pathOf('browser');
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** Open on first use; StorageService runs PRAGMAs and the browser migration. */
  ensureOpen(): void {
    if (this.opened) return;
    try {
      this.handle = this.storage.database('browser');
      this.opened = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.name === 'BrowserMigrationError') {
        throw new BrowserFailure({ kind: 'Migration', message });
      }
      throw new BrowserFailure({ kind: 'Database', message });
    }
  }

  /** Connection handle, opening the database first. */
  getConn(): DatabaseHandle {
    this.ensureOpen();
    if (this.handle === null) throw browserNotOpen();
    return this.handle;
  }

  /** Connection only when already opened; never triggers the lazy open. */
  tryGetConn(): DatabaseHandle {
    if (!this.opened || this.handle === null) throw browserNotOpen();
    return this.handle;
  }

  /** `refinery_schema_history` max version; 0 when the database is closed. */
  getSchemaVersion(): number {
    if (!this.opened) return 0;
    return readSchemaVersion(this.tryGetConn());
  }

  isForeignKeysEnabled(): boolean {
    return foreignKeysEnabled(this.getConn());
  }

  /** Release the logical handle (the file stays); a later `ensureOpen` reopens it. */
  close(): void {
    const handle = this.handle;
    this.handle = null;
    this.opened = false;
    if (handle !== null) tryCheckpoint(handle);
  }
}
