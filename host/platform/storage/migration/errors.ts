/**
 * `dstu-storage/src/migration/mod.rs::MigrationError`，`message` 与 thiserror Display 完全一致。
 */
export type MigrationErrorKind =
  | { kind: 'Database'; detail: string }
  | { kind: 'Refinery'; detail: string }
  | { kind: 'Io'; detail: string }
  | { kind: 'ChecksumMismatch'; version: number; expected: string; actual: string }
  | { kind: 'MigrationFailed'; version: number; reason: string }
  | { kind: 'VerificationFailed'; version: number; reason: string }
  | { kind: 'DependencyNotSatisfied'; database: string; dependency: string }
  | { kind: 'InsufficientDiskSpace'; availableMb: number; requiredMb: number }
  | { kind: 'RecoveredFromBackup'; originalError: string; restoredCount: number }
  | { kind: 'NotImplemented'; detail: string };

function display(e: MigrationErrorKind): string {
  switch (e.kind) {
    case 'Database':
      return `Database error: ${e.detail}`;
    case 'Refinery':
      return `Refinery error: ${e.detail}`;
    case 'Io':
      return `IO error: ${e.detail}`;
    case 'ChecksumMismatch':
      return `Checksum mismatch for migration ${e.version}: expected ${e.expected}, got ${e.actual}`;
    case 'MigrationFailed':
      return `Migration ${e.version} failed: ${e.reason}`;
    case 'VerificationFailed':
      return `Verification failed for migration ${e.version}: ${e.reason}`;
    case 'DependencyNotSatisfied':
      return `Dependency not satisfied: ${e.database} requires ${e.dependency}`;
    case 'InsufficientDiskSpace':
      return `Insufficient disk space: ${e.availableMb}MB available, need at least ${e.requiredMb}MB. Please free up disk space and retry.`;
    case 'RecoveredFromBackup':
      return `Migration failed but recovered from backup: ${e.originalError} (restored ${e.restoredCount} databases)`;
    case 'NotImplemented':
      return `Not implemented: ${e.detail}`;
  }
}

export class MigrationError extends Error {
  readonly detail: MigrationErrorKind;
  constructor(detail: MigrationErrorKind, options?: { cause?: unknown }) {
    super(display(detail), options);
    this.name = 'MigrationError';
    this.detail = detail;
  }

  static database(detail: string, cause?: unknown): MigrationError {
    return new MigrationError({ kind: 'Database', detail }, { cause });
  }

  static io(error: unknown): MigrationError {
    return new MigrationError({ kind: 'Io', detail: error instanceof Error ? error.message : String(error) }, { cause: error });
  }
}

/** `e.to_string()`：Error 取 message（rusqlite/StorageError 的 Display 即 message）。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
