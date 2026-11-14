/**
 * Task audit manifest assembly (task_audit.rs:1–305) and the tool layer's
 * sensitivity mapping (task_audit_executor.rs:414–501).
 */
import { stripToolNamespace } from './automation-tool-args.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

export const TASK_AUDIT_SCHEMA_VERSION = 1;
const REDACTED = '[REDACTED]';

export interface AuditToolCall {
  callId: string;
  toolName: string;
  arguments: unknown;
  resultHash?: string | null;
}

export interface AuditApproval {
  approvalId: string;
  scopeHash: string;
  decision: string;
}

export interface AuditOutput {
  objectHandleId: string;
  sha256: string;
}

export interface ConnectorAuditTarget {
  operationId: string;
  recipients?: string[];
  aclPrincipals?: string[];
}

export interface ChangeCoverage {
  changesRecorded: boolean;
  rollbackAvailable: boolean;
  rollbackVerified: boolean;
}

export interface TaskObjectHandleLike {
  schemaVersion: number;
  handleId: string;
  displayName: string;
  [key: string]: unknown;
}

export interface AuditExportArgs {
  taskId: string;
  objectHandles?: TaskObjectHandleLike[];
  toolCalls?: AuditToolCall[];
  approvals?: AuditApproval[];
  outputs?: AuditOutput[];
  connectorTargets?: ConnectorAuditTarget[];
  rolePackVersion?: string | null;
  changeCoverage?: ChangeCoverage;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** task_audit.rs:280–305. */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['authorization', 'apikey', 'token', 'accesstoken', 'refreshtoken', 'password',
    'secret', 'clientsecret', 'cookie', 'setcookie'].includes(normalized)
    || normalized.endsWith('token') || normalized.endsWith('secret')
    || normalized.endsWith('password') || normalized.endsWith('apikey')
    || normalized.endsWith('authorization') || normalized.endsWith('cookie')
    || normalized.endsWith('privatekey') || normalized.endsWith('credential');
}

function redactUrlSecrets(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const pairs = [...url.searchParams.entries()];
  const hasSecretQuery = pairs.some(([key]) => isSecretKey(key));
  const hasPassword = url.password !== '';
  if (!hasSecretQuery && !hasPassword) return null;
  if (hasPassword) url.password = REDACTED;
  if (hasSecretQuery) {
    url.search = '';
    for (const [key, value] of pairs) {
      url.searchParams.append(key, isSecretKey(key) ? REDACTED : value);
    }
  }
  return url.toString();
}

/** task_audit.rs:232–278. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'string') return redactUrlSecrets(value) ?? value;
  const object = objectOf(value);
  if (object === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    output[key] = isSecretKey(key) ? REDACTED : redactSecrets(child);
  }
  return output;
}

/** `requested_layers.difference(&represented)` in task_audit_executor.rs:327–333. */
export function missingRequestedLayers(
  requested: Iterable<string>, represented: Iterable<string>,
): string[] {
  const representedSet = new Set(represented);
  return [...new Set(requested)].filter((layer) => !representedSet.has(layer)).sort();
}

function lightHandleValidation(handle: TaskObjectHandleLike): void {
  if (handle.schemaVersion < 1 || handle.schemaVersion > TASK_AUDIT_SCHEMA_VERSION) {
    throw new Error(`unsupported task object schema version: ${handle.schemaVersion}`);
  }
  if (handle.handleId.trim() === '' || handle.displayName.trim() === '') {
    throw new Error('handle_id and display_name are required');
  }
}

/** Rust `String` ordering compares UTF-8 bytes. */
const byteOrder = compareUtf8;

/** `BTreeMap<String, T>` insert (later entries replace earlier ones) followed by `into_values()`. */
function keyedValues<T>(items: readonly T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.keys()].sort(byteOrder).map(id => map.get(id)!);
}

/**
 * task_audit.rs:168–229. `validateHandle` is `TaskObjectHandle::validate`; the tool executor passes the
 * L07 implementation, callers holding loosely typed handles keep the version/identity check.
 */
export function buildTaskAuditManifest(args: AuditExportArgs,
  validateHandle: (handle: TaskObjectHandleLike) => void = lightHandleValidation): Record<string, unknown> {
  const objectHandleInputs = args.objectHandles ?? [];
  for (const handle of objectHandleInputs) validateHandle(handle);
  if (args.taskId.trim() === '') throw new Error('task_id is required');
  const objectHandles = keyedValues(objectHandleInputs, handle => handle.handleId);
  const toolCalls = keyedValues(args.toolCalls ?? [], call => call.callId);
  const approvals = keyedValues(args.approvals ?? [], approval => approval.approvalId);
  const outputs = keyedValues(args.outputs ?? [], output => output.objectHandleId);
  const connectorTargets = keyedValues(args.connectorTargets ?? [], target => target.operationId);
  const changeCoverage: ChangeCoverage = args.changeCoverage
    ?? { changesRecorded: false, rollbackAvailable: false, rollbackVerified: false };

  const missing: string[] = [];
  if (objectHandles.length === 0) missing.push('object_handles');
  if (toolCalls.length === 0) missing.push('tool_calls');
  if (!changeCoverage.changesRecorded) missing.push('change_receipts');
  if (changeCoverage.rollbackAvailable && !changeCoverage.rollbackVerified) {
    missing.push('rollback_verification');
  }
  // The tool-facing export never cross-checks the backend ledger, so the
  // manifest can never claim authority (task_audit.rs:183–190).
  missing.push('backend_session_ledger');

  const coverageComplete = missing.length === 0;
  const manifest: Record<string, unknown> = {
    schemaVersion: TASK_AUDIT_SCHEMA_VERSION,
    taskId: args.taskId,
    evidenceOrigin: 'caller_supplied',
    authoritative: false,
    objectHandles,
    toolCalls,
    approvals,
    outputs,
    connectorTargets,
    ...(args.rolePackVersion !== undefined && args.rolePackVersion !== null ? { rolePackVersion: args.rolePackVersion } : {}),
    changeCoverage,
    coverageComplete,
    missingCoverage: missing,
  };
  return redactSecrets(manifest) as Record<string, unknown>;
}

export function taskAuditSensitivityLevel(toolName: string): 'High' | 'Medium' {
  return stripToolNamespace(toolName) === 'task_audit_export' ? 'Medium' : 'High';
}

export function canHandleTaskAuditTool(toolName: string): boolean {
  const bare = stripToolNamespace(toolName);
  return bare === 'task_audit_export' || bare === 'lineage_forget';
}
