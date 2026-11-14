export class SyncError extends Error {
  constructor(message: string) { super(message); this.name = 'SyncError'; }
}

export class ManualResolutionRequiredError extends SyncError {
  readonly count: number;
  constructor(count: number) {
    super(`Manual resolution required: ${count} conflicts`);
    this.count = count;
  }
}

/** sync/mod.rs:400-475 `SyncError::ClockDriftSuspected`。 */
export class ClockDriftSuspectedError extends SyncError {
  readonly table: string;
  readonly recordId: string;
  readonly driftMs: number;
  constructor(table: string, recordId: string, driftMs: number) {
    super(`Clock drift suspected: ${table}.${recordId} timestamp is ${driftMs}ms in the future`);
    this.name = 'ClockDriftSuspectedError';
    this.table = table;
    this.recordId = recordId;
    this.driftMs = driftMs;
  }
}
