/**
 * Cloud lease core shared by `sync_lease.rs` and `backup_lease.rs`.
 *
 * `CloudStorage` is dumb storage without conditional PUT / compare-and-swap, so a
 * lease cannot safely overwrite one fixed key: two devices could each read back
 * their own value and both believe they hold the lock. Both Rust modules use the
 * Joplin-style independent contender protocol implemented here:
 *
 * 1. reclaim expired contenders and reject immediately when an active one exists;
 * 2. write this operation's pending contender (`activation_committed = false`);
 * 3. list every contender and pick the unique winner by `(created_at, operation_id)`;
 * 4. promote the winner to committed, then list once more to confirm ownership.
 *
 * The two namespaces are deliberately isolated: separate prefix, target, format
 * version and stable error code. Truncated listings, unreadable leases and
 * corrupted leases inside their fallback window all fail closed.
 */

import { nowEpochNanos, parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { CloudStorage, FileInfo } from '../api.ts';
import { CloudStorageError } from './errors.ts';
import { defaultLogSink } from './logging.ts';
import { decodeBool, decodeString, decodeStruct, decodeU32, fromSlice } from './serde_struct.ts';
import { millisecondsToNanos } from './time.ts';
import { randomUuid } from './random.ts';
import { utf8Encode } from './bytes.ts';

/** Wire shape shared by both lease records (serde `snake_case`). */
export interface LeaseRecord {
  format_version: number;
  target: string;
  holder_device_id: string;
  operation_id: string;
  created_at: string;
  expires_at: string;
  activation_committed: boolean;
}

/** A lease observed while scanning, plus the provider fallback expiry. */
export interface ActiveLease {
  key: string;
  /** `null` when the object exists but is not a structurally valid lease. */
  lease: LeaseRecord | null;
  /** `last_modified + ttl`, epoch nanoseconds (Rust DateTime precision). */
  fallbackExpiresAt: bigint;
}

/** Everything that differs between the sync and backup lease namespaces. */
export interface LeaseSpec {
  /** Rust derive struct name, used in serde's top-level type/sequence errors. */
  serdeName: string;
  /** Object prefix; keys are `keyFor(operationId)`. */
  prefix: string;
  /** Rust tracing target prefix, for example `[sync-lease]`. */
  logPrefix: string;
  target: string;
  formatVersion: number;
  keyFor(operationId: string): string;
  messages: LeaseMessages;
  /** Builds the stable "held" error, optionally specialised for the local device. */
  heldError(active: ActiveLease, localDeviceId: string): CloudStorageError;
}

export interface LeaseMessages {
  missingDeviceId: string;
  ttlOverflow: string;
  ttlMustBePositive: string;
  serializeFailed(detail: string): string;
  writeFailed(detail: string): string;
  verifyReadFailed(detail: string): string;
  writeInvisible: string;
  verifyParseFailed(detail: string): string;
  changedDuringWrite: string;
  recycleReadFailed(detail: string): string;
  recycleDeleteFailed(detail: string): string;
  listFailed(detail: string): string;
  listTruncated: string;
  readLeaseFailed(key: string, detail: string): string;
  releaseReadFailed(detail: string): string;
  releaseParseFailed(detail: string): string;
  releaseOwnershipChanged: string;
  renewReadFailed(detail: string): string;
  renewMissing: string;
  renewParseFailed(detail: string): string;
  renewOwnershipChanged: string;
  contenderInvisible: string;
  commitUnconfirmed: string;
}

const MAX_CHRONO_DURATION_MS = Number(9_223_372_036_854_775n);
const MIN_HEARTBEAT_INTERVAL_MS = 250;

/** uuid 1.20.0 parser.rs::try_parse: wrappers contain a hyphenated UUID only. */
export function isUuid(value: string): boolean {
  if (value.length === 32) return /^[0-9a-fA-F]{32}$/.test(value);
  let text = value;
  if (value.length === 38 && value.startsWith('{') && value.endsWith('}')) {
    text = value.slice(1, -1);
  } else if (value.length === 45 && value.startsWith('urn:uuid:')) {
    text = value.slice('urn:uuid:'.length);
  } else if (value.length !== 36) {
    return false;
  }
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text);
}

function validateTtl(spec: LeaseSpec, ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs > MAX_CHRONO_DURATION_MS) {
    throw new CloudStorageError('Validation', spec.messages.ttlOverflow);
  }
  if (ttlMs <= 0) {
    throw new CloudStorageError('Validation', spec.messages.ttlMustBePositive);
  }
}

/** `Lease::new`; the operation ID is a fresh v4 UUID. */
export function createLeaseRecord(
  spec: LeaseSpec,
  holderDeviceId: string,
  ttlMs: number,
  nowNanos: bigint,
): LeaseRecord {
  if (rustTrim(holderDeviceId) === '') {
    throw new CloudStorageError('Validation', spec.messages.missingDeviceId);
  }
  validateTtl(spec, ttlMs);
  return {
    format_version: spec.formatVersion,
    target: spec.target,
    holder_device_id: rustTrim(holderDeviceId),
    operation_id: randomUuid(),
    created_at: toRfc3339(nowNanos),
    expires_at: toRfc3339(nowNanos + millisecondsToNanos(ttlMs)),
    activation_committed: false,
  };
}

export function leaseKey(spec: LeaseSpec, operationId: string): string {
  return spec.keyFor(operationId);
}

/** sync_lease.rs:49-59 / backup_lease.rs:56-66: ordinary snake_case derive structs. */
function decodeLease(spec: LeaseSpec, data: Uint8Array): LeaseRecord {
  return fromSlice(data, de => decodeStruct(de, spec.serdeName, {
    format_version: { decode: decodeU32 },
    target: { decode: decodeString },
    holder_device_id: { decode: decodeString },
    operation_id: { decode: decodeString },
    created_at: { decode: decodeString },
    expires_at: { decode: decodeString },
    activation_committed: { decode: decodeBool, default: () => false },
  }));
}

function tryDecodeLease(spec: LeaseSpec, data: Uint8Array): LeaseRecord | null {
  try {
    return decodeLease(spec, data);
  } catch {
    // Invalid JSON / missing fields is exactly what serde `.ok()` turns into None.
    return null;
  }
}

function structurallyValid(spec: LeaseSpec, lease: LeaseRecord): boolean {
  return lease.format_version === spec.formatVersion
    && lease.target === spec.target
    && rustTrim(lease.holder_device_id) !== ''
    && isUuid(lease.operation_id)
    && parseRfc3339(lease.created_at) !== null
    && parseRfc3339(lease.expires_at) !== null;
}

function leaseCreatedAt(lease: LeaseRecord): bigint | null {
  return parseRfc3339(lease.created_at)?.epochNanos ?? null;
}

function leaseExpiresAt(lease: LeaseRecord): bigint | null {
  return parseRfc3339(lease.expires_at)?.epochNanos ?? null;
}

function sameLease(left: LeaseRecord, right: LeaseRecord): boolean {
  return left.format_version === right.format_version
    && left.target === right.target
    && left.holder_device_id === right.holder_device_id
    && left.operation_id === right.operation_id
    && left.created_at === right.created_at
    && left.expires_at === right.expires_at
    && left.activation_committed === right.activation_committed;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function putVerified(
  spec: LeaseSpec,
  storage: CloudStorage,
  key: string,
  lease: LeaseRecord,
): Promise<void> {
  let encoded: Uint8Array;
  try {
    encoded = utf8Encode(JSON.stringify(lease, null, 2));
  } catch (error) {
    throw new CloudStorageError('Unknown', spec.messages.serializeFailed(errorDetail(error)));
  }
  await storage.put(key, encoded).catch(error => {
    throw new CloudStorageError('Network', spec.messages.writeFailed(errorDetail(error)));
  });
  const verified = await storage.get(key).catch(error => {
    throw new CloudStorageError('Network', spec.messages.verifyReadFailed(errorDetail(error)));
  });
  if (verified === null) {
    throw new CloudStorageError('Network', spec.messages.writeInvisible);
  }
  let decoded: LeaseRecord;
  try {
    decoded = decodeLease(spec, verified);
  } catch (error) {
    throw new CloudStorageError('Network', spec.messages.verifyParseFailed(errorDetail(error)));
  }
  if (!sameLease(decoded, lease)) {
    throw new CloudStorageError('Conflict', spec.messages.changedDuringWrite);
  }
}

async function deleteIfUnchanged(
  spec: LeaseSpec,
  storage: CloudStorage,
  key: string,
  expected: Uint8Array,
): Promise<boolean> {
  const current = await storage.get(key).catch(error => {
    throw new CloudStorageError('Network', spec.messages.recycleReadFailed(errorDetail(error)));
  });
  if (current === null || !sameBytes(current, expected)) return false;
  await storage.delete(key).catch(error => {
    throw new CloudStorageError('Network', spec.messages.recycleDeleteFailed(errorDetail(error)));
  });
  return true;
}

function fallbackExpiry(file: FileInfo, ttlMs: number, nowNanos: bigint): bigint {
  const modified = parseRfc3339(file.lastModified)?.epochNanos;
  // Rust's FileInfo.last_modified is a DateTime and cannot be invalid. Treat an
  // unparsable provider timestamp as fresh (fail closed) instead of reclaiming.
  return (modified ?? nowNanos) + millisecondsToNanos(ttlMs);
}

/**
 * Lists active contenders and reclaims expired objects.
 *
 * A corrupted object has no trustworthy `expires_at`, so it degrades to
 * `last_modified + ttl`; inside that window it stays active (fail closed) and
 * outside it may be reclaimed, so the repository cannot stay locked forever.
 */
export async function scanActiveLeases(
  spec: LeaseSpec,
  storage: CloudStorage,
  ttlMs: number,
  nowNanos: bigint,
): Promise<ActiveLease[]> {
  if (!Number.isFinite(ttlMs) || ttlMs > MAX_CHRONO_DURATION_MS) {
    throw new CloudStorageError('Validation', spec.messages.ttlOverflow);
  }
  const listing = await storage.listOutcome(spec.prefix).catch(error => {
    throw new CloudStorageError('Network', spec.messages.listFailed(errorDetail(error)));
  });
  if (listing.truncated) {
    throw new CloudStorageError('Network', spec.messages.listTruncated);
  }

  const active: ActiveLease[] = [];
  for (const file of listing.files) {
    if (!file.key.startsWith(spec.prefix) || !file.key.endsWith('.json')) continue;
    const bytes = await storage.get(file.key).catch(error => {
      throw new CloudStorageError('Network', spec.messages.readLeaseFailed(file.key, errorDetail(error)));
    });
    // Released normally between LIST and GET.
    if (bytes === null) continue;
    const parsed = tryDecodeLease(spec, bytes);
    const lease = parsed !== null && structurallyValid(spec, parsed) ? parsed : null;
    const fallbackExpiresAt = fallbackExpiry(file, ttlMs, nowNanos);
    const expiresAt = lease === null ? fallbackExpiresAt : leaseExpiresAt(lease) ?? fallbackExpiresAt;
    if (expiresAt <= nowNanos) {
      // Narrow the race with heartbeat renewal: only delete when the object still
      // matches exactly what was read.
      if (await deleteIfUnchanged(spec, storage, file.key, bytes)) continue;
      // Content changed between GET and DELETE (a heartbeat renewal landed, or the
      // local clock is slow). We cannot prove the holder gave up: stay fail-closed.
    }
    active.push({ key: file.key, lease, fallbackExpiresAt });
  }
  active.sort((left, right) => compareContenders(left, right));
  return active;
}

function compareContenders(left: ActiveLease, right: ActiveLease): number {
  if (left.lease !== null && right.lease !== null) {
    const leftCreated = leaseCreatedAt(left.lease);
    const rightCreated = leaseCreatedAt(right.lease);
    if (leftCreated !== rightCreated) {
      if (leftCreated === null) return -1;
      if (rightCreated === null) return 1;
      return leftCreated < rightCreated ? -1 : 1;
    }
    return left.lease.operation_id < right.lease.operation_id ? -1
      : left.lease.operation_id > right.lease.operation_id ? 1 : 0;
  }
  // A fresh but corrupted lease must fail closed; a legal contender may not bypass it.
  if (left.lease === null && right.lease !== null) return -1;
  if (left.lease !== null && right.lease === null) return 1;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

async function releaseOwnedCandidate(
  spec: LeaseSpec,
  storage: CloudStorage,
  key: string,
  operationId: string,
): Promise<boolean> {
  const bytes = await storage.get(key).catch(error => {
    throw new CloudStorageError('Network', spec.messages.releaseReadFailed(errorDetail(error)));
  });
  if (bytes === null) return false;
  let lease: LeaseRecord;
  try {
    lease = decodeLease(spec, bytes);
  } catch (error) {
    throw new CloudStorageError('Network', spec.messages.releaseParseFailed(errorDetail(error)));
  }
  if (lease.operation_id !== operationId) {
    throw new CloudStorageError('Conflict', spec.messages.releaseOwnershipChanged);
  }
  await storage.delete(key).catch(error => {
    throw new CloudStorageError('Network', spec.messages.recycleDeleteFailed(errorDetail(error)));
  });
  return true;
}

async function renewOwnedCandidate(
  spec: LeaseSpec,
  storage: CloudStorage,
  key: string,
  operationId: string,
  ttlMs: number,
): Promise<void> {
  const bytes = await storage.get(key).catch(error => {
    throw new CloudStorageError('Network', spec.messages.renewReadFailed(errorDetail(error)));
  });
  if (bytes === null) {
    throw new CloudStorageError('Conflict', spec.messages.renewMissing);
  }
  let lease: LeaseRecord;
  try {
    lease = decodeLease(spec, bytes);
  } catch (error) {
    throw new CloudStorageError('Conflict', spec.messages.renewParseFailed(errorDetail(error)));
  }
  if (lease.operation_id !== operationId || !lease.activation_committed) {
    throw new CloudStorageError('Conflict', spec.messages.renewOwnershipChanged);
  }
  validateTtl(spec, ttlMs);
  lease.expires_at = toRfc3339(nowEpochNanos() + millisecondsToNanos(ttlMs));
  await putVerified(spec, storage, key, lease);
}

/** Cancellable async heartbeat; `stop()` waits for any in-flight renewal. */
class LeaseHeartbeat {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private lastError: unknown = null;
  private readonly done: Promise<void>;

  private readonly intervalMs: number;
  private readonly renew: () => Promise<void>;
  private readonly logPrefix: string;

  constructor(
    intervalMs: number,
    renew: () => Promise<void>,
    logPrefix: string,
  ) {
    this.intervalMs = intervalMs;
    this.renew = renew;
    this.logPrefix = logPrefix;
    this.done = this.run();
  }

  private sleep(): Promise<void> {
    return new Promise(resolve => {
      this.wake = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wake = null;
        resolve();
      }, this.intervalMs);
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.sleep();
      if (this.stopped) break;
      try {
        await this.renew();
      } catch (error) {
        // Same as tracing::error + break in Rust: stop renewing, let the caller
        // observe the failure and finish remote writes promptly.
        this.lastError = error;
        defaultLogSink().error(
          `${this.logPrefix} 心跳续租失败；本轮后续远端写入应尽快结束: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
  }

  failure(): unknown {
    return this.lastError;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const wake = this.wake;
    this.wake = null;
    wake?.();
    await this.done;
  }
}

/**
 * Committed lease guard.
 *
 * Explicit `release()` waits for the delete. Without it, a stopped heartbeat lets
 * the TTL reclaim the object; JavaScript has no reliable async destructor, so
 * callers should release explicitly.
 */
export class LeaseGuard {
  private released = false;

  private readonly spec: LeaseSpec;
  private readonly storage: CloudStorage;
  readonly lease: LeaseRecord;
  readonly key: string;
  private readonly heartbeat: LeaseHeartbeat;

  constructor(
    spec: LeaseSpec,
    storage: CloudStorage,
    lease: LeaseRecord,
    key: string,
    heartbeat: LeaseHeartbeat,
  ) {
    this.spec = spec;
    this.storage = storage;
    this.lease = lease;
    this.key = key;
    this.heartbeat = heartbeat;
  }

  /** Last heartbeat renewal error, or `null` when renewals succeeded. */
  heartbeatFailure(): unknown {
    return this.heartbeat.failure();
  }

  /** Deletes only the object whose operation ID matches this guard. */
  async release(): Promise<void> {
    if (this.released) return;
    await this.heartbeat.stop();
    await releaseOwnedCandidate(this.spec, this.storage, this.key, this.lease.operation_id);
    this.released = true;
  }
}

/** Acquires a lease with the contender protocol. */
export async function acquireLease(
  spec: LeaseSpec,
  storage: CloudStorage,
  holderDeviceId: string,
  ttlMs: number,
): Promise<LeaseGuard> {
  validateTtl(spec, ttlMs);
  let active = await scanActiveLeases(spec, storage, ttlMs, nowEpochNanos());
  const existing = active[0];
  if (existing !== undefined) throw spec.heldError(existing, holderDeviceId);

  const lease = createLeaseRecord(spec, holderDeviceId, ttlMs, nowEpochNanos());
  const key = leaseKey(spec, lease.operation_id);
  await putVerified(spec, storage, key, lease);

  // Concurrent devices may all see an empty directory on the first scan; after
  // writing their contenders they elect one winner from the complete listing.
  active = await scanActiveLeases(spec, storage, ttlMs, nowEpochNanos());
  const winner = active[0];
  if (winner === undefined) {
    throw new CloudStorageError('Network', spec.messages.contenderInvisible);
  }
  const winnerIsSelf = winner.lease !== null && winner.lease.operation_id === lease.operation_id;
  if (!winnerIsSelf) {
    const held = spec.heldError(winner, holderDeviceId);
    await releaseOwnedCandidate(spec, storage, key, lease.operation_id).catch(() => undefined);
    throw held;
  }

  // Two-phase commit: only the deterministic winner may promote pending to committed.
  lease.activation_committed = true;
  await putVerified(spec, storage, key, lease);
  active = await scanActiveLeases(spec, storage, ttlMs, nowEpochNanos());
  const committed = active[0];
  const committedIsSelf = committed !== undefined
    && committed.lease !== null
    && committed.lease.operation_id === lease.operation_id
    && committed.lease.activation_committed;
  if (!committedIsSelf) {
    const held = committed === undefined
      ? new CloudStorageError('Conflict', spec.messages.commitUnconfirmed)
      : spec.heldError(committed, holderDeviceId);
    await releaseOwnedCandidate(spec, storage, key, lease.operation_id).catch(() => undefined);
    throw held;
  }

  const intervalMs = Math.max(ttlMs / 3, MIN_HEARTBEAT_INTERVAL_MS);
  const heartbeat = new LeaseHeartbeat(intervalMs, () => renewOwnedCandidate(
    spec,
    storage,
    key,
    lease.operation_id,
    ttlMs,
  ), spec.logPrefix);
  return new LeaseGuard(spec, storage, lease, key, heartbeat);
}
