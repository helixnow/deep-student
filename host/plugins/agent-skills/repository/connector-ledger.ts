/**
 * Connector operation ledger, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/connector_ledger.rs`.
 *
 * The authoritative state machine lives in the chat_v2 `connector_operations`
 * table (migration V20260907). The core invariant is that `submitting` is
 * persisted before the provider call: a process that dies mid-call leaves a
 * `submitting` row that startup reconciliation converges to `outcome_unknown`
 * instead of silently retrying an external side effect.
 *
 * Every transition is a single atomic `UPDATE ... WHERE state IN (legal
 * predecessors)`, so a read-judge-write race cannot smuggle in an illegal
 * transition. `changes() == 0` means the transition was rejected.
 */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { defineQuery, type SqlExecutor, type SqlParam } from '../../../platform/storage/api.ts';

export type ConnectorOperationState =
  | 'draft' | 'confirmed' | 'submitting' | 'committed' | 'outcome_unknown' | 'failed';

export const CONNECTOR_OPERATION_STATES: readonly ConnectorOperationState[] = [
  'draft', 'confirmed', 'submitting', 'committed', 'outcome_unknown', 'failed',
];

export function parseConnectorOperationState(raw: string): ConnectorOperationState | undefined {
  return CONNECTOR_OPERATION_STATES.find(state => state === raw);
}

/**
 * Legal transitions (no self-loops; duplicate confirm/submit is a caller bug).
 * Commit idempotency is implemented by replaying the stored committed result,
 * not by relying on a transition.
 */
export function canTransitionConnectorOperation(
  from: ConnectorOperationState,
  to: ConnectorOperationState,
): boolean {
  return (from === 'draft' && to === 'confirmed')
    || (from === 'confirmed' && to === 'submitting')
    || (from === 'submitting' && to === 'committed')
    || (from === 'submitting' && to === 'failed')
    || (from === 'submitting' && to === 'outcome_unknown')
    || (from === 'outcome_unknown' && to === 'committed')
    || (from === 'outcome_unknown' && to === 'failed');
}

/** Values come from trusted constants only; safe to interpolate into SQL. */
function predecessorsSql(to: ConnectorOperationState): string {
  return CONNECTOR_OPERATION_STATES
    .filter(from => canTransitionConnectorOperation(from, to))
    .map(state => `'${state}'`)
    .join(', ');
}

/** `sha256(operation_id || preview_sha256)`, generated at draft time. */
export function systemIdempotencyKey(operationId: string, previewSha256: string): string {
  return sha256HexSync(`${operationId}${previewSha256}`);
}

export interface ConnectorOperation {
  operationId: string;
  sessionId: string;
  providerId: string;
  capability: string | null;
  action: string;
  previewSha256: string | null;
  requestPayloadHash: string | null;
  idempotencyKey: string;
  state: ConnectorOperationState;
  externalOperationId: string | null;
  accountId: string | null;
  capabilityFingerprint: string | null;
  previewJson: string | null;
  /** Exact i64 (D3); convert only at the JSON/IPC boundary. */
  expiresAtMs: bigint | null;
  createdAt: string;
  confirmedAt: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  error: string | null;
  evidenceJson: string | null;
}

export interface NewConnectorOperation {
  operationId: string;
  sessionId: string;
  providerId: string;
  capability: string | null;
  action: string;
  previewSha256: string;
  idempotencyKey: string;
  accountId: string | null;
  capabilityFingerprint: string | null;
  previewJson: string;
  /** Full i64 accepted as bigint; exact safe numbers remain source-compatible. */
  expiresAtMs: number | bigint | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

function sqlTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint' || typeof value === 'number') {
    return typeof value === 'number' && !Number.isInteger(value) ? 'REAL' : 'INTEGER';
  }
  if (typeof value === 'string') return 'TEXT';
  if (value instanceof Uint8Array) return 'BLOB';
  return typeof value;
}

function invalidColumn(column: string, expected: string, value: unknown): Error {
  return new Error(`Invalid column type for ${column}: expected ${expected}, got ${sqlTypeName(value)}`);
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** rusqlite `row.get::<_, String>()`: TEXT only, no coercion. */
function requiredString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw invalidColumn(column, 'TEXT', value);
  return value;
}

/** rusqlite `row.get::<_, Option<String>>()`: NULL or TEXT. */
function optionalString(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalidColumn(column, 'TEXT', value);
  return value;
}

/**
 * rusqlite `row.get::<_, Option<i64>>()`: NULL or INTEGER.
 * Reads use `safeIntegers`, so the exact i64 is a bigint (D3). A plain number
 * is accepted only when it is already an exact safe integer; silently rounding
 * an unsafe number would corrupt the ledger.
 */
function optionalI64(row: Row, column: string): bigint | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) {
      throw new Error(`Invalid column type for ${column}: value outside i64 range`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Invalid column type for ${column}: INTEGER number is not an exact safe integer; `
        + 'read it with safeIntegers (bigint)',
      );
    }
    return BigInt(value);
  }
  throw invalidColumn(column, 'INTEGER', value);
}

function rowToOperation(row: Row): ConnectorOperation {
  const rawState = requiredString(row, 'state');
  const state = parseConnectorOperationState(rawState);
  if (state === undefined) throw new Error(`invalid connector operation state: ${rawState}`);
  return {
    operationId: requiredString(row, 'operation_id'),
    sessionId: requiredString(row, 'session_id'),
    providerId: requiredString(row, 'provider_id'),
    capability: optionalString(row, 'capability'),
    action: requiredString(row, 'action'),
    previewSha256: optionalString(row, 'preview_sha256'),
    requestPayloadHash: optionalString(row, 'request_payload_hash'),
    idempotencyKey: requiredString(row, 'idempotency_key'),
    state,
    externalOperationId: optionalString(row, 'external_operation_id'),
    accountId: optionalString(row, 'account_id'),
    capabilityFingerprint: optionalString(row, 'capability_fingerprint'),
    previewJson: optionalString(row, 'preview_json'),
    expiresAtMs: optionalI64(row, 'expires_at_ms'),
    createdAt: requiredString(row, 'created_at'),
    confirmedAt: optionalString(row, 'confirmed_at'),
    submittedAt: optionalString(row, 'submitted_at'),
    resolvedAt: optionalString(row, 'resolved_at'),
    error: optionalString(row, 'error'),
    evidenceJson: optionalString(row, 'evidence_json'),
  };
}

function parseRows(rows: readonly Row[]): ConnectorOperation[] {
  return rows.map(row => {
    try { return rowToOperation(row); }
    catch (error) { throw new Error(`failed to parse connector operation: ${errorText(error)}`); }
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Write-side i64: bigint keeps the full Rust `Option<i64>` range. A number is
 * accepted only when it is an exact safe integer; an unsafe number has already
 * lost precision before the call, so it cannot be stored faithfully.
 */
function normalizeExpiresAtMs(value: number | bigint | null): bigint | null {
  if (value === null) return null;
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) {
      throw new Error('expires_at_ms is outside the i64 range');
    }
    return value;
  }
  if (Number.isInteger(value) && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error('expires_at_ms must be an exact i64 (pass bigint when outside 2^53-1)');
}

/** draft persistence (the start of the operation lifecycle). */
export function insertConnectorDraft(db: SqlExecutor, op: NewConnectorOperation): void {
  try {
    const expiresAtMs = normalizeExpiresAtMs(op.expiresAtMs);
    db.run(
      `INSERT INTO connector_operations (
         operation_id, session_id, provider_id, capability, action,
         preview_sha256, idempotency_key, state,
         account_id, capability_fingerprint,
         preview_json, expires_at_ms, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?10, ?11, ?12)`,
      [
        op.operationId, op.sessionId, op.providerId, op.capability, op.action,
        op.previewSha256, op.idempotencyKey, op.accountId, op.capabilityFingerprint,
        op.previewJson, expiresAtMs, op.createdAt,
      ],
    );
  } catch (error) {
    throw new Error(`failed to insert connector operation: ${errorText(error)}`);
  }
}

const getByIdQuery = defineQuery<[string], Row>(
  'SELECT * FROM connector_operations WHERE operation_id = ?1',
  { name: 'agentSkills.connector.getById', options: { safeIntegers: true } },
);
const getByIdempotencyKeyQuery = defineQuery<[string, string], Row>(
  'SELECT * FROM connector_operations WHERE session_id = ?1 AND idempotency_key = ?2',
  { name: 'agentSkills.connector.getByIdempotencyKey', options: { safeIntegers: true } },
);
const listBySessionQuery = defineQuery<[string], Row>(
  'SELECT * FROM connector_operations WHERE session_id = ?1 ORDER BY created_at, operation_id',
  { name: 'agentSkills.connector.listBySession', options: { safeIntegers: true } },
);
const listPendingReconcileQuery = defineQuery<void, Row>(
  "SELECT * FROM connector_operations WHERE state IN ('submitting', 'outcome_unknown') "
  + 'ORDER BY created_at, operation_id',
  { name: 'agentSkills.connector.listPendingReconcile', options: { safeIntegers: true } },
);

export function getConnectorOperation(
  db: SqlExecutor,
  operationId: string,
): ConnectorOperation | undefined {
  try {
    const row = db.get(getByIdQuery, [operationId]);
    return row === undefined ? undefined : rowToOperation(row);
  } catch (error) {
    throw new Error(`failed to read connector operation: ${errorText(error)}`);
  }
}

export function getConnectorOperationByIdempotencyKey(
  db: SqlExecutor,
  sessionId: string,
  idempotencyKey: string,
): ConnectorOperation | undefined {
  try {
    const row = db.get(getByIdempotencyKeyQuery, [sessionId, idempotencyKey]);
    return row === undefined ? undefined : rowToOperation(row);
  } catch (error) {
    throw new Error(`failed to read connector operation by idempotency key: ${errorText(error)}`);
  }
}

export function listConnectorOperationsBySession(
  db: SqlExecutor,
  sessionId: string,
): ConnectorOperation[] {
  let rows: Row[];
  try {
    rows = db.all(listBySessionQuery, [sessionId]);
  } catch (error) {
    throw new Error(`failed to list connector operations: ${errorText(error)}`);
  }
  return parseRows(rows);
}

function transition(
  db: SqlExecutor,
  operationId: string,
  to: ConnectorOperationState,
  assignments: string,
  params: readonly SqlParam[],
  failMessage: string,
  errorPrefix: string,
): void {
  const sql = `UPDATE connector_operations SET ${assignments} `
    + `WHERE operation_id = ?1 AND state IN (${predecessorsSql(to)})`;
  let changes: number;
  try { changes = db.run(sql, params).changes; }
  catch (error) { throw new Error(`${errorPrefix}: ${errorText(error)}`); }
  if (changes === 0) throw new Error(failMessage);
}

/** `draft → confirmed` guarded by both predecessor and preview hash. */
export function markConnectorConfirmed(
  db: SqlExecutor,
  operationId: string,
  previewSha256: string,
  confirmedAt: string,
): void {
  const sql = 'UPDATE connector_operations '
    + 'SET state = ?2, confirmed_at = ?3 '
    + `WHERE operation_id = ?1 AND preview_sha256 = ?4 `
    + `AND state IN (${predecessorsSql('confirmed')})`;
  let changes: number;
  try {
    changes = db.run(sql, [operationId, 'confirmed', confirmedAt, previewSha256]).changes;
  } catch (error) {
    throw new Error(`failed to confirm connector operation: ${errorText(error)}`);
  }
  if (changes === 0) {
    throw new Error('connector operation is not a confirmable draft or preview hash mismatch');
  }
}

/** `confirmed → submitting`; must be persisted before the provider call. */
export function markConnectorSubmitting(
  db: SqlExecutor,
  operationId: string,
  submittedAt: string,
  requestPayloadHash: string,
): void {
  const sql = 'UPDATE connector_operations '
    + 'SET state = ?2, submitted_at = ?3, request_payload_hash = ?4 '
    + `WHERE operation_id = ?1 AND state IN (${predecessorsSql('submitting')})`;
  let changes: number;
  try {
    changes = db.run(sql, [operationId, 'submitting', submittedAt, requestPayloadHash]).changes;
  } catch (error) {
    throw new Error(`failed to mark connector operation submitting: ${errorText(error)}`);
  }
  if (changes === 0) throw new Error('connector operation is not in a submittable state');
}

/** `submitting → committed` / `outcome_unknown → committed` (lookup). */
export function markConnectorCommitted(
  db: SqlExecutor,
  operationId: string,
  resolvedAt: string,
  externalOperationId: string | null,
  evidenceJson: string,
): void {
  const sql = 'UPDATE connector_operations '
    + 'SET state = ?2, resolved_at = ?3, external_operation_id = ?4, '
    + 'evidence_json = ?5, error = NULL '
    + `WHERE operation_id = ?1 AND state IN (${predecessorsSql('committed')})`;
  let changes: number;
  try {
    changes = db.run(sql, [
      operationId, 'committed', resolvedAt, externalOperationId, evidenceJson,
    ]).changes;
  } catch (error) {
    throw new Error(`failed to mark connector operation committed: ${errorText(error)}`);
  }
  if (changes === 0) throw new Error('connector operation is not in a committable state');
}

/** `submitting → failed` / `outcome_unknown → failed` (lookup). */
export function markConnectorFailed(
  db: SqlExecutor,
  operationId: string,
  resolvedAt: string,
  errorMessage: string,
): void {
  const sql = 'UPDATE connector_operations '
    + 'SET state = ?2, resolved_at = ?3, error = ?4 '
    + `WHERE operation_id = ?1 AND state IN (${predecessorsSql('failed')})`;
  let changes: number;
  try {
    changes = db.run(sql, [operationId, 'failed', resolvedAt, errorMessage]).changes;
  } catch (error) {
    throw new Error(`failed to mark connector operation failed: ${errorText(error)}`);
  }
  if (changes === 0) throw new Error('connector operation is not in a failable state');
}

/** Startup convergence: leftover `submitting` → `outcome_unknown`. */
export function reconcileSubmittingOnStartup(db: SqlExecutor): number {
  const sql = 'UPDATE connector_operations SET state = ?1 '
    + `WHERE state IN (${predecessorsSql('outcome_unknown')})`;
  try { return db.run(sql, ['outcome_unknown']).changes; }
  catch (error) { throw new Error(`failed to reconcile connector operations: ${errorText(error)}`); }
}

export function listPendingConnectorReconcile(db: SqlExecutor): ConnectorOperation[] {
  let rows: Row[];
  try {
    rows = db.all(listPendingReconcileQuery);
  } catch (error) {
    throw new Error(`failed to list pending reconcile operations: ${errorText(error)}`);
  }
  return parseRows(rows);
}

/** Single-row `submitting → outcome_unknown` with an audit note. */
export function markConnectorOutcomeUnknown(
  db: SqlExecutor,
  operationId: string,
  note: string,
): void {
  const sql = 'UPDATE connector_operations SET state = ?2, error = ?3 '
    + `WHERE operation_id = ?1 AND state IN (${predecessorsSql('outcome_unknown')})`;
  let changes: number;
  try { changes = db.run(sql, [operationId, 'outcome_unknown', note]).changes; }
  catch (error) {
    throw new Error(`failed to mark connector operation outcome_unknown: ${errorText(error)}`);
  }
  if (changes === 0) {
    throw new Error(
      'connector operation is not in a submitting state; cannot mark outcome_unknown',
    );
  }
}

/** Startup recovery entry point (G04-P0 convergence step). */
export function reconcileConnectorOnStartup(db: SqlExecutor): number {
  return reconcileSubmittingOnStartup(db);
}

export interface SessionSideEffectSummary {
  totalOperations: number;
  /** Operations in `submitting` / `outcome_unknown`, ascending by creation. */
  pending: ConnectorOperation[];
}

/** Session-scoped side-effect summary for the task finalizer (read-only). */
export function sessionSideEffectSummary(
  db: SqlExecutor,
  sessionId: string,
): SessionSideEffectSummary {
  let rows: Row[];
  try {
    rows = db.all(listBySessionQuery, [sessionId]);
  } catch (error) {
    throw new Error(`failed to list session connector operations: ${errorText(error)}`);
  }
  const operations = parseRows(rows);
  return {
    totalOperations: operations.length,
    pending: operations.filter(op => op.state === 'submitting' || op.state === 'outcome_unknown'),
  };
}
