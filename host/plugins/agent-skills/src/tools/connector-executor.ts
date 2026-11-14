/**
 * First-class connector registry and object-operation bridge, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`.
 *
 * Drafts and confirmations are persisted in the chat_v2 `connector_operations`
 * ledger; the system idempotency key is generated at draft time and model
 * supplied keys are ignored. `commit` persists `submitting` before touching the
 * provider, replays committed evidence idempotently, and converges failures or
 * unknown outcomes without ever auto-retrying an external side effect.
 *
 * Non-webhook providers go through the MCP tool bridge; webhook providers are
 * resolved through an injected `ConnectorProvider` factory so the HTTP/HMAC
 * adapter stays in its own module (mirroring Rust's provider split).
 */
import { sha256HexSync } from '../../../../platform/crypto/sync.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import { now } from '../../../../platform/time/index.ts';
import {
  confirmConnectorReceipt, commitConnectorReceipt, deserializeTaskObjectHandle,
  validateTaskObjectHandle, type ConnectorOperationReceipt, type DerivedEdge,
  type ObjectCapabilities, type OperationState, type TaskObjectHandle, type TaskObjectKind,
} from './task-objects.ts';
import {
  getConnectorOperation, insertConnectorDraft,
  markConnectorCommitted, markConnectorConfirmed, markConnectorFailed,
  markConnectorOutcomeUnknown, markConnectorSubmitting,
  systemIdempotencyKey, type ConnectorOperation, type NewConnectorOperation,
} from '../../repository/connector-ledger.ts';

export const CONNECTOR_REGISTRY_KEY = 'connectors.registry.v1';
export const DEFAULT_CONFIRM_TTL_SECS = 600;
export const MAX_CONFIRM_TTL_SECS = 3600;
export const WEBHOOK_SUBMIT_MAX_ATTEMPTS = 3;
export const WEBHOOK_PROVIDER_KIND = 'webhook';

export const CONNECTOR_REGISTRY_TOOL = 'connector_registry';
export const CONNECTOR_DRAFT_TOOL = 'connector_operation_draft';
export const CONNECTOR_CONFIRM_TOOL = 'connector_operation_confirm';
export const CONNECTOR_COMMIT_TOOL = 'connector_operation_commit';

export const SUPPORTED_CAPABILITIES: readonly string[] = [
  'mail', 'calendar', 'meeting', 'drive', 'comments', 'share',
];

export interface OAuthSnapshot {
  connected: boolean;
  grantedScopes: string[];
  accountId?: string;
  expiresAt?: string;
}

export interface CapabilitySnapshot {
  version: string;
  observedAt: string;
  permissions: string[];
  objectVersion?: string;
}

export interface CapabilityConfig {
  name: string;
  requiredScopes: string[];
  mcpServerId: string;
  mcpTools: Record<string, string>;
  snapshot: CapabilitySnapshot;
}

export interface WebhookConfig {
  endpoint: string;
  secretSettingKey: string;
}

export interface ConnectorConfig {
  id: string;
  provider: string;
  oauth: OAuthSnapshot;
  capabilities: CapabilityConfig[];
  webhook?: WebhookConfig;
}

/** Snake_case on the wire, matching Rust `DraftPreview`'s serde field names. */
export interface DraftPreview {
  provider_id: string;
  capability: string;
  action: string;
  recipients: string[];
  timezone: string;
  conflicts: unknown[];
  destination: string | null;
  acl: Record<string, unknown>;
  attachments: TaskObjectHandle[];
  payload: Record<string, unknown>;
}

export { systemIdempotencyKey } from '../../repository/connector-ledger.ts';

export type ProviderErrorKind = 'transient' | 'permanent' | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }

  static transient(message: string): ProviderError { return new ProviderError('transient', message); }
  static permanent(message: string): ProviderError { return new ProviderError('permanent', message); }
  static unknown(message: string): ProviderError { return new ProviderError('unknown', message); }
}

export interface ProviderOperation {
  operationId: string;
  idempotencyKey: string;
  action: string;
  body: Record<string, unknown>;
}

export interface ProviderReceipt {
  externalOperationId: string | null;
  result: unknown;
}

export interface ProviderOutcome {
  externalOperationId: string | null;
  receipt: unknown;
}

/** The `ConnectorProvider` contract (webhook is one implementation). */
export interface ConnectorProvider {
  name(): string;
  submit(op: ProviderOperation): Promise<ProviderReceipt>;
  lookup(idempotencyKey: string): Promise<ProviderOutcome | null>;
}

export interface ConnectorSettings {
  getSecret(key: string): string | null;
  getSetting(key: string): string | null;
}

export interface ConnectorToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ConnectorLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface ConnectorExecutionContext {
  sessionId: string;
  mainDb?: ConnectorSettings;
  chatV2Db?: SqlExecutor;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<ConnectorToolCallResult>;
  createWebhookProvider?: (config: WebhookConfig, mainDb: ConnectorSettings) => ConnectorProvider;
  logger?: ConnectorLogger;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function nowMs(): number {
  return Date.now();
}


export function requireSameSession(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error('connector operation belongs to a different session');
  }
}

function requireLedger(ctx: ConnectorExecutionContext): SqlExecutor {
  if (ctx.chatV2Db === undefined) {
    throw new Error(
      'connector operation ledger is unavailable (chat_v2 database not attached)',
    );
  }
  return ctx.chatV2Db;
}

export function sha256Json(value: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new Error(`failed to serialize connector preview: ${errorText(error)}`); }
  return sha256HexSync(serialized);
}

function sortedObject(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

/**
 * Fingerprint only permission-semantics fields. Token refresh timestamps and
 * observation timestamps are excluded; scope/permission lists are sorted
 * because they are sets.
 */
export function capabilityFingerprint(
  config: ConnectorConfig,
  capability: CapabilityConfig,
): string {
  const grantedScopes = [...config.oauth.grantedScopes].sort();
  const requiredScopes = [...capability.requiredScopes].sort();
  const permissions = [...capability.snapshot.permissions].sort();
  return sha256Json([
    config.id,
    config.oauth.connected,
    grantedScopes,
    config.oauth.accountId ?? null,
    capability.name,
    requiredScopes,
    capability.mcpServerId,
    sortedObject(capability.mcpTools),
    capability.snapshot.version,
    permissions,
    capability.snapshot.objectVersion ?? null,
  ]);
}

export function parseRegistry(raw: string | null | undefined): ConnectorConfig[] {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch (error) { throw new Error(`invalid connector registry JSON: ${errorText(error)}`); }
  if (!Array.isArray(parsed)) throw new Error('invalid connector registry JSON: expected an array');
  const registry = parsed.map(parseConnectorConfig);
  validateRegistry(registry);
  return registry;
}

function optionalStringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function parseConnectorConfig(value: unknown): ConnectorConfig {
  const record = asRecord(value);
  const oauthRaw = asRecord(record.oauth);
  const snapshot = (input: unknown): CapabilitySnapshot => {
    const item = asRecord(input);
    const result: CapabilitySnapshot = {
      version: String(item.version ?? ''),
      observedAt: String(item.observedAt ?? ''),
      permissions: asStringArray(item.permissions).map(String),
    };
    const objectVersion = optionalStringField(item, 'objectVersion');
    if (objectVersion !== undefined) result.objectVersion = objectVersion;
    return result;
  };
  const config: ConnectorConfig = {
    id: String(record.id ?? ''),
    provider: String(record.provider ?? ''),
    oauth: {
      connected: oauthRaw.connected === true,
      grantedScopes: asStringArray(oauthRaw.grantedScopes).map(String),
      ...(optionalStringField(oauthRaw, 'accountId') === undefined
        ? {} : { accountId: optionalStringField(oauthRaw, 'accountId')! }),
      ...(optionalStringField(oauthRaw, 'expiresAt') === undefined
        ? {} : { expiresAt: optionalStringField(oauthRaw, 'expiresAt')! }),
    },
    capabilities: asStringArray(record.capabilities).map((entry) => {
      const item = asRecord(entry);
      const tools: Record<string, string> = {};
      for (const [key, tool] of Object.entries(asRecord(item.mcpTools))) {
        tools[key] = String(tool);
      }
      return {
        name: String(item.name ?? ''),
        requiredScopes: asStringArray(item.requiredScopes).map(String),
        mcpServerId: String(item.mcpServerId ?? ''),
        mcpTools: tools,
        snapshot: snapshot(item.snapshot),
      };
    }),
  };
  if (record.webhook !== undefined && record.webhook !== null) {
    const webhook = asRecord(record.webhook);
    config.webhook = {
      endpoint: String(webhook.endpoint ?? ''),
      secretSettingKey: String(webhook.secretSettingKey ?? ''),
    };
  }
  return config;
}

export function validateRegistry(registry: readonly ConnectorConfig[]): void {
  const ids = new Set<string>();
  for (const connector of registry) {
    if (connector.id.trim() === '' || connector.provider.trim() === '') {
      throw new Error('connector id and provider are required');
    }
    if (ids.has(connector.id)) throw new Error(`duplicate connector id '${connector.id}'`);
    ids.add(connector.id);
    const isWebhook = connector.provider === WEBHOOK_PROVIDER_KIND;
    if (isWebhook) {
      if (connector.webhook === undefined) {
        throw new Error(
          `webhook connector '${connector.id}' requires a 'webhook' config section`,
        );
      }
      if (connector.webhook.endpoint.trim() === '') {
        throw new Error(`webhook connector '${connector.id}' has an empty endpoint`);
      }
      if (connector.webhook.secretSettingKey.trim() === '') {
        throw new Error(`webhook connector '${connector.id}' has an empty secretSettingKey`);
      }
    } else if (connector.webhook !== undefined) {
      throw new Error(
        `connector '${connector.id}' carries a webhook section but provider is not 'webhook'`,
      );
    }
    for (const capability of connector.capabilities) {
      if (!SUPPORTED_CAPABILITIES.includes(capability.name)) {
        throw new Error(`unsupported connector capability '${capability.name}'`);
      }
      if (!isWebhook && capability.mcpServerId.trim() === '') {
        throw new Error(`connector capability '${capability.name}' lacks mcpServerId`);
      }
      for (const tool of Object.values(capability.mcpTools)) {
        if (tool.trim() === '') {
          throw new Error('connector MCP tool mapping must not be empty');
        }
      }
    }
  }
}

export function capabilityAvailable(
  config: ConnectorConfig,
  capability: CapabilityConfig,
): boolean {
  const channelReady = config.provider === WEBHOOK_PROVIDER_KIND
    ? config.webhook !== undefined : true;
  return config.oauth.connected
    && capability.requiredScopes.every(scope => config.oauth.grantedScopes.includes(scope))
    && Object.keys(capability.mcpTools).length > 0
    && channelReady;
}

export function findCapability(
  registry: readonly ConnectorConfig[],
  providerId: string,
  capabilityName: string,
): [ConnectorConfig, CapabilityConfig] {
  const connector = registry.find(entry => entry.id === providerId);
  if (connector === undefined) {
    throw new Error(`capability_unavailable: connector '${providerId}' is not configured`);
  }
  const capability = connector.capabilities.find(entry => entry.name === capabilityName);
  if (capability === undefined) {
    throw new Error(
      `capability_unavailable: '${providerId}' does not provide '${capabilityName}'`,
    );
  }
  if (!capabilityAvailable(connector, capability)) {
    throw new Error(
      `capability_unavailable: '${providerId}' lacks OAuth scopes or an MCP tool mapping `
      + `for '${capabilityName}'`,
    );
  }
  return [connector, capability];
}

function requiredValue(args: Record<string, unknown>, key: string): unknown {
  if (!(key in args)) throw new Error(`draft field '${key}' is required`);
  return args[key];
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${field} entries must be non-empty strings`);
    }
    return entry.trim();
  });
}

/** Deserialize + validate a `TaskObjectHandle` (serde parity for attachments). */
export function parseAttachmentHandle(value: unknown): TaskObjectHandle {
  try {
    return deserializeTaskObjectHandle(value);
  } catch (error) {
    throw new Error(
      `invalid attachment TaskObjectHandle: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseAttachments(value: unknown): TaskObjectHandle[] {
  if (!Array.isArray(value)) throw new Error('attachments must be an array');
  return value.map(parseAttachmentHandle);
}

export function parseDraft(args: Record<string, unknown>): DraftPreview {
  const providerRaw = requiredValue(args, 'provider_id');
  if (typeof providerRaw !== 'string') throw new Error('provider_id must be a string');
  const capabilityRaw = requiredValue(args, 'capability');
  if (typeof capabilityRaw !== 'string') throw new Error('capability must be a string');
  const capability = capabilityRaw.trim();
  if (!SUPPORTED_CAPABILITIES.includes(capability)) {
    throw new Error(`unsupported connector capability '${capability}'`);
  }
  const actionRaw = requiredValue(args, 'action');
  if (typeof actionRaw !== 'string') throw new Error('action must be a string');
  const timezoneRaw = requiredValue(args, 'timezone');
  if (typeof timezoneRaw !== 'string') throw new Error('timezone must be a string');
  const timezone = timezoneRaw.trim();
  if (timezone === '') {
    throw new Error("timezone must not be empty; use 'not_applicable' when appropriate");
  }
  const conflictsRaw = requiredValue(args, 'conflicts');
  if (!Array.isArray(conflictsRaw)) throw new Error('conflicts must be an array');
  const destinationRaw = requiredValue(args, 'destination');
  let destination: string | null;
  if (destinationRaw === null) destination = null;
  else if (typeof destinationRaw === 'string' && destinationRaw.trim() !== '') {
    destination = destinationRaw.trim();
  } else throw new Error('destination must be a non-empty string or null');
  const aclRaw = requiredValue(args, 'acl');
  if (typeof aclRaw !== 'object' || aclRaw === null || Array.isArray(aclRaw)) {
    throw new Error('acl must be an object');
  }
  const payloadRaw = requiredValue(args, 'payload');
  if (typeof payloadRaw !== 'object' || payloadRaw === null || Array.isArray(payloadRaw)) {
    throw new Error('payload must be an object');
  }
  return {
    provider_id: providerRaw.trim(),
    capability,
    action: actionRaw.trim(),
    recipients: parseStringArray(requiredValue(args, 'recipients'), 'recipients'),
    timezone,
    conflicts: [...conflictsRaw],
    destination,
    acl: aclRaw as Record<string, unknown>,
    attachments: parseAttachments(requiredValue(args, 'attachments')),
    payload: payloadRaw as Record<string, unknown>,
  };
}

function receiptState(state: ConnectorOperation['state']): OperationState {
  switch (state) {
    case 'draft': return 'draft';
    case 'confirmed': case 'submitting': return 'confirmed';
    case 'committed': return 'committed';
    case 'outcome_unknown': case 'failed': return 'failed';
  }
}

export function receiptOf(
  row: ConnectorOperation,
  preview: DraftPreview,
): ConnectorOperationReceipt {
  return {
    operationId: row.operationId,
    idempotencyKey: row.idempotencyKey,
    provider: row.providerId,
    action: `${preview.capability}:${preview.action}`,
    state: receiptState(row.state),
    objectHandleIds: [],
    recipientIds: [...preview.recipients],
    ...(preview.destination === null ? {} : { destination: preview.destination }),
    irreversible: true,
    previewSha256: row.previewSha256 ?? '',
    ...(row.state === 'committed' && row.resolvedAt !== null
      ? { committedAt: row.resolvedAt } : {}),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

export function parseStoredPreview(row: ConnectorOperation): DraftPreview {
  if (row.previewJson === null) {
    throw new Error('connector operation is missing its stored preview');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.previewJson); }
  catch (error) {
    throw new Error(`failed to parse stored connector preview: ${errorText(error)}`);
  }
  return parsed as DraftPreview;
}

export function operationExpired(row: ConnectorOperation, now: number | bigint): boolean {
  if (row.expiresAtMs === null || row.expiresAtMs < 0n) return false;
  const nowMs = typeof now === 'bigint' ? now : BigInt(Math.trunc(now));
  return row.expiresAtMs <= nowMs;
}

/** D3 IPC boundary: Rust serde emits the i64 as a JSON number. */
function i64ToIpcNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

export function registryOutput(registry: readonly ConnectorConfig[]): Record<string, unknown> {
  return {
    success: true,
    supported_capabilities: SUPPORTED_CAPABILITIES,
    providers: registry.map(connector => ({
      id: connector.id,
      provider: connector.provider,
      oauth: {
        connected: connector.oauth.connected,
        grantedScopes: [...connector.oauth.grantedScopes],
        ...(connector.oauth.accountId === undefined
          ? {} : { accountId: connector.oauth.accountId }),
        ...(connector.oauth.expiresAt === undefined
          ? {} : { expiresAt: connector.oauth.expiresAt }),
      },
      capabilities: connector.capabilities.map(capability => ({
        name: capability.name,
        available: capabilityAvailable(connector, capability),
        required_scopes: [...capability.requiredScopes],
        mcp_server_id: capability.mcpServerId,
        mapped_actions: Object.keys(sortedObject(capability.mcpTools)),
        snapshot: {
          version: capability.snapshot.version,
          observedAt: capability.snapshot.observedAt,
          permissions: [...capability.snapshot.permissions],
          ...(capability.snapshot.objectVersion === undefined
            ? {} : { objectVersion: capability.snapshot.objectVersion }),
        },
      })),
    })),
    configured: registry.length > 0,
    unavailable_code: 'capability_unavailable',
  };
}

export function readRegistry(ctx: ConnectorExecutionContext): ConnectorConfig[] {
  if (ctx.mainDb === undefined) throw new Error('Main database not available');
  let raw: string | null;
  try { raw = ctx.mainDb.getSecret(CONNECTOR_REGISTRY_KEY); }
  catch (error) { throw new Error(`failed to read connector registry: ${errorText(error)}`); }
  return parseRegistry(raw);
}

const EXTERNAL_ID_KEYS = [
  'id', 'object_id', 'objectId', 'event_id', 'eventId', 'message_id', 'messageId',
];

export function extractExternalOperationId(providerResult: unknown): string | null {
  const record = asRecord(providerResult);
  for (const key of EXTERNAL_ID_KEYS) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return null;
}

function previewBody(preview: DraftPreview, capability: CapabilityConfig): Record<string, unknown> {
  return {
    recipients: [...preview.recipients],
    timezone: preview.timezone,
    conflicts: [...preview.conflicts],
    destination: preview.destination,
    acl: preview.acl,
    attachments: preview.attachments,
    payload: preview.payload,
    expected_object_version: capability.snapshot.objectVersion ?? null,
  };
}

export function providerObjectHandle(
  connector: ConnectorConfig,
  capability: CapabilityConfig,
  preview: DraftPreview,
  operationId: string,
  providerResult: unknown,
): TaskObjectHandle {
  const result = asRecord(providerResult);
  const externalId = extractExternalOperationId(providerResult);
  const displayName = ['name', 'title', 'subject']
    .map(key => result[key])
    .find((value): value is string => typeof value === 'string') ?? preview.action;
  const kind: TaskObjectKind = preview.capability === 'mail' ? 'message'
    : preview.capability === 'calendar' || preview.capability === 'meeting' ? 'event'
      : preview.capability === 'drive' ? 'file' : 'record';
  const sourceUriRaw = typeof result.uri === 'string' ? result.uri
    : typeof result.url === 'string' ? result.url : undefined;
  const threadRaw = typeof result.thread_id === 'string' ? result.thread_id
    : typeof result.threadId === 'string' ? result.threadId : undefined;
  const etag = typeof result.etag === 'string' ? result.etag : undefined;
  const derivedFrom: DerivedEdge[] = preview.attachments.map(attachment => ({
    sourceHandleId: attachment.handleId,
    transformId: 'connector.deliver',
    observedAt: now().rfc3339,
  }));
  const capabilities: ObjectCapabilities = {
    readable: true,
    materializable: false,
    writable: capability.snapshot.permissions.includes('write'),
    shareable: capability.snapshot.permissions.includes('share'),
    sendable: capability.snapshot.permissions.includes('send'),
    deletable: capability.snapshot.permissions.includes('delete'),
  };
  const handle: TaskObjectHandle = {
    schemaVersion: 2,
    handleId: externalId === null
      ? `connector-operation:${operationId}`
      : `connector:${connector.id}:${externalId}`,
    kind,
    displayName,
    capabilities,
    provenance: {
      source: connector.provider,
      ...(sourceUriRaw === undefined ? {} : { sourceUri: sourceUriRaw }),
      server: capability.mcpServerId,
      ...(capability.mcpTools[preview.action] === undefined
        ? {} : { tool: capability.mcpTools[preview.action]! }),
      derivedFrom,
      observedAt: now().rfc3339,
    },
  };
  if (externalId !== null) {
    handle.providerRef = {
      provider: connector.id,
      externalId,
      ...(preview.destination === null ? {} : { containerId: preview.destination }),
      ...(threadRaw === undefined ? {} : { threadId: threadRaw }),
      ...(capability.snapshot.objectVersion === undefined
        ? {} : { version: capability.snapshot.objectVersion }),
      ...(etag === undefined ? {} : { etag }),
    };
  }
  validateTaskObjectHandle(handle);
  return handle;
}

function providerFailureMessage(error: unknown): string {
  return error === undefined || error === null || error === ''
    ? 'unknown provider error' : String(error);
}

async function submitWebhookWithRetry(
  provider: ConnectorProvider,
  op: ProviderOperation,
  logger: ConnectorLogger = {},
): Promise<ProviderReceipt> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await provider.submit(op);
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error : ProviderError.unknown(errorText(error));
      if (providerError.kind !== 'transient' || attempt >= WEBHOOK_SUBMIT_MAX_ATTEMPTS) {
        throw providerError;
      }
      logger.info?.(
        `[ConnectorToolExecutor] webhook submit for ${op.operationId} hit a transient error `
        + `(attempt ${attempt}/${WEBHOOK_SUBMIT_MAX_ATTEMPTS}); retrying with the same `
        + 'idempotency key',
      );
      await new Promise(resolve => setTimeout(resolve, 200 * (1 << (attempt - 1))));
    }
  }
}

function classifySubmitFailure(
  db: SqlExecutor,
  operationId: string,
  error: ProviderError,
  logger: ConnectorLogger = {},
): string {
  if (error.kind === 'permanent') {
    const message = `connector provider commit failed: ${error.message}`;
    try { markConnectorFailed(db, operationId, now().rfc3339, message); }
    catch (ledgerError) {
      logger.warn?.(
        `[ConnectorToolExecutor] failed to persist failed state for ${operationId}: `
        + errorText(ledgerError),
      );
    }
    return message;
  }
  const note = `submit outcome unknown (${error.kind}): ${error.message}`;
  try { markConnectorOutcomeUnknown(db, operationId, note); }
  catch (ledgerError) {
    logger.warn?.(
      `[ConnectorToolExecutor] failed to persist outcome_unknown for ${operationId}: `
      + errorText(ledgerError),
    );
  }
  return `connector operation outcome is unknown (${error.message}); `
    + 'it must be reconciled via provider lookup before any retry';
}

function webhookProviderFactory(ctx: ConnectorExecutionContext) {
  return ctx.createWebhookProvider;
}

export class ConnectorToolExecutor {
  static stripNamespace(toolName: string): string {
    if (toolName.startsWith('builtin-')) return toolName.slice(8);
    if (toolName.startsWith('mcp_')) return toolName.slice(4);
    return toolName;
  }

  canHandle(toolName: string): boolean {
    const short = ConnectorToolExecutor.stripNamespace(toolName);
    return short === CONNECTOR_REGISTRY_TOOL || short === CONNECTOR_DRAFT_TOOL
      || short === CONNECTOR_CONFIRM_TOOL || short === CONNECTOR_COMMIT_TOOL;
  }

  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' {
    switch (ConnectorToolExecutor.stripNamespace(toolName)) {
      case CONNECTOR_REGISTRY_TOOL: return 'low';
      case CONNECTOR_DRAFT_TOOL: return 'medium';
      case CONNECTOR_CONFIRM_TOOL: case CONNECTOR_COMMIT_TOOL: return 'high';
      default: return 'high';
    }
  }

  name(): string { return 'ConnectorToolExecutor'; }

  executeRegistry(ctx: ConnectorExecutionContext): Record<string, unknown> {
    return registryOutput(readRegistry(ctx));
  }

  executeDraft(
    args: Record<string, unknown>,
    ctx: ConnectorExecutionContext,
  ): Record<string, unknown> {
    const db = requireLedger(ctx);
    let registry: ConnectorConfig[];
    try { registry = readRegistry(ctx); }
    catch (error) { throw new Error(`capability_unavailable: ${errorText(error)}`); }
    const preview = parseDraft(args);
    const [connector, capability] = findCapability(
      registry, preview.provider_id, preview.capability,
    );
    const mappedTool = capability.mcpTools[preview.action];
    if (mappedTool === undefined) {
      throw new Error(
        `capability_unavailable: action '${preview.action}' is not mapped for `
        + `'${preview.capability}'`,
      );
    }
    if (mappedTool.trim() === '') {
      throw new Error('capability_unavailable: mapped MCP tool is empty');
    }
    const previewSha256 = sha256Json(preview);
    const operationId = `connector-op-${globalThis.crypto.randomUUID()}`;
    const idempotencyKey = systemIdempotencyKey(operationId, previewSha256);
    const ttlRaw = args.confirm_ttl_seconds;
    const ttl = typeof ttlRaw === 'number' && Number.isInteger(ttlRaw) && ttlRaw >= 0
      ? Math.min(Math.max(ttlRaw, 30), MAX_CONFIRM_TTL_SECS) : DEFAULT_CONFIRM_TTL_SECS;
    const expiresAtMs = BigInt(nowMs()) + BigInt(ttl * 1000);
    const previewJson = JSON.stringify(preview);
    const newOperation: NewConnectorOperation = {
      operationId,
      sessionId: ctx.sessionId,
      providerId: connector.id,
      capability: preview.capability,
      action: preview.action,
      previewSha256,
      idempotencyKey,
      accountId: connector.oauth.accountId ?? null,
      capabilityFingerprint: capabilityFingerprint(connector, capability),
      previewJson,
      expiresAtMs,
      createdAt: now().rfc3339,
    };
    insertConnectorDraft(db, newOperation);
    const receipt: ConnectorOperationReceipt = {
      operationId,
      idempotencyKey,
      provider: connector.id,
      action: `${preview.capability}:${preview.action}`,
      state: 'draft',
      objectHandleIds: preview.attachments.map(handle => handle.handleId),
      recipientIds: [...preview.recipients],
      ...(preview.destination === null ? {} : { destination: preview.destination }),
      irreversible: true,
      previewSha256,
    };
    return {
      success: true,
      state: 'draft',
      operation_id: operationId,
      preview_sha256: previewSha256,
      expires_at_ms: Number(expiresAtMs),
      preview,
      receipt,
      requires_confirmation: true,
    };
  }

  executeConfirm(
    args: Record<string, unknown>,
    ctx: ConnectorExecutionContext,
  ): Record<string, unknown> {
    const operationId = args.operation_id;
    if (typeof operationId !== 'string') throw new Error('operation_id is required');
    const previewSha256 = args.preview_sha256;
    if (typeof previewSha256 !== 'string') throw new Error('preview_sha256 is required');
    const db = requireLedger(ctx);
    const row = getConnectorOperation(db, operationId);
    if (row === undefined) throw new Error('connector draft is missing or expired');
    requireSameSession(row.sessionId, ctx.sessionId);
    if (operationExpired(row, nowMs())) {
      throw new Error('connector draft is missing or expired');
    }
    const preview = parseStoredPreview(row);
    const receipt = receiptOf(row, preview);
    confirmConnectorReceipt(receipt, previewSha256);
    markConnectorConfirmed(db, operationId, previewSha256, now().rfc3339);
    return {
      success: true,
      state: 'confirmed',
      operation_id: operationId,
      preview_sha256: previewSha256,
      expires_at_ms: i64ToIpcNumber(row.expiresAtMs),
      receipt,
    };
  }

  async executeCommit(
    args: Record<string, unknown>,
    ctx: ConnectorExecutionContext,
  ): Promise<Record<string, unknown>> {
    const operationId = args.operation_id;
    if (typeof operationId !== 'string') throw new Error('operation_id is required');
    const previewSha256 = args.preview_sha256;
    if (typeof previewSha256 !== 'string') throw new Error('preview_sha256 is required');
    if (typeof args.idempotency_key === 'string' && args.idempotency_key.trim() !== '') {
      ctx.logger?.warn?.(
        `[ConnectorToolExecutor] ignoring model-provided idempotency_key `
        + `'${args.idempotency_key.trim()}' for ${operationId}; the system-generated key `
        + 'from draft is authoritative',
      );
    }

    const db = requireLedger(ctx);
    const row = getConnectorOperation(db, operationId);
    if (row === undefined) throw new Error('connector draft is missing or expired');
    requireSameSession(row.sessionId, ctx.sessionId);
    if (row.previewSha256 !== previewSha256) {
      throw new Error('preview_sha256 does not match the confirmed operation');
    }

    switch (row.state) {
      case 'committed': {
        if (row.evidenceJson === null) {
          throw new Error('committed connector operation is missing its evidence');
        }
        let output: Record<string, unknown>;
        try { output = asRecord(JSON.parse(row.evidenceJson)); }
        catch (error) {
          throw new Error(
            `failed to parse committed operation evidence: ${errorText(error)}`,
          );
        }
        output.idempotent_replay = true;
        return output;
      }
      case 'submitting':
        throw new Error(
          'connector operation with this idempotency_key is already in progress',
        );
      case 'outcome_unknown':
        throw new Error(
          'connector operation outcome is unknown after a restart; it must be reconciled '
          + 'before any retry',
        );
      case 'failed':
        throw new Error(
          `connector operation already failed: `
          + (row.error ?? 'unknown provider error'),
        );
      case 'draft':
        throw new Error('connector operation must be confirmed before commit');
      case 'confirmed':
        break;
    }

    if (operationExpired(row, nowMs())) {
      throw new Error('connector draft is missing or expired');
    }
    const preview = parseStoredPreview(row);

    let registry: ConnectorConfig[];
    try { registry = readRegistry(ctx); }
    catch (error) { throw new Error(`capability_unavailable: ${errorText(error)}`); }
    const [connector, capability] = findCapability(
      registry, preview.provider_id, preview.capability,
    );
    if (row.capabilityFingerprint !== capabilityFingerprint(connector, capability)) {
      throw new Error(
        'capability snapshot changed; create and confirm a new operation draft',
      );
    }
    if (capability.mcpTools[preview.action] === undefined) {
      throw new Error('capability_unavailable: action mapping was removed');
    }

    let channel: McpChannel | WebhookChannel;
    if (connector.provider === WEBHOOK_PROVIDER_KIND) {
      const webhook = connector.webhook;
      if (webhook === undefined) {
        throw new Error(
          'capability_unavailable: webhook connector is missing its webhook config',
        );
      }
      if (ctx.mainDb === undefined) throw new Error('Main database not available');
      const factory = webhookProviderFactory(ctx);
      if (factory === undefined) {
        throw new Error(
          'connector provider is not ready: webhook provider transport is not configured',
        );
      }
      let provider: ConnectorProvider;
      try { provider = factory(webhook, ctx.mainDb); }
      catch (error) { throw new Error(`connector provider is not ready: ${errorText(error)}`); }
      const body: Record<string, unknown> = {
        operation_id: operationId,
        idempotency_key: row.idempotencyKey,
        action: `${preview.capability}:${preview.action}`,
        ...previewBody(preview, capability),
      };
      channel = {
        kind: 'webhook',
        provider,
        op: {
          operationId,
          idempotencyKey: row.idempotencyKey,
          action: `${preview.capability}:${preview.action}`,
          body,
        },
      };
    } else {
      const mappedTool = capability.mcpTools[preview.action]!;
      const externalTool = mappedTool.startsWith('mcp_') ? mappedTool : `mcp_${mappedTool}`;
      channel = {
        kind: 'mcp',
        externalTool,
        providerArgs: {
          _serverId: capability.mcpServerId,
          idempotency_key: row.idempotencyKey,
          ...previewBody(preview, capability),
        },
      };
    }
    const requestPayloadHash = sha256Json(
      channel.kind === 'mcp' ? channel.providerArgs : channel.op.body,
    );

    try { markConnectorSubmitting(db, operationId, now().rfc3339, requestPayloadHash); }
    catch {
      throw new Error(
        'connector operation with this idempotency_key is already in progress',
      );
    }

    let providerResult: unknown;
    if (channel.kind === 'mcp') {
      if (ctx.callTool === undefined) {
        const message = 'connector provider commit failed: tool registry is unavailable';
        try { markConnectorFailed(db, operationId, now().rfc3339, message); }
        catch (ledgerError) {
          ctx.logger?.warn?.(
            `[ConnectorToolExecutor] failed to persist failed state for ${operationId}: `
            + errorText(ledgerError),
          );
        }
        throw new Error(message);
      }
      const call = await ctx.callTool(channel.externalTool, channel.providerArgs);
      if (!call.ok) {
        const message = 'connector provider commit failed: '
          + providerFailureMessage(call.error);
        try { markConnectorFailed(db, operationId, now().rfc3339, message); }
        catch (ledgerError) {
          ctx.logger?.warn?.(
            `[ConnectorToolExecutor] failed to persist failed state for ${operationId}: `
            + errorText(ledgerError),
          );
        }
        throw new Error(message);
      }
      providerResult = call.data ?? null;
    } else {
      try {
        const receipt = await submitWebhookWithRetry(channel.provider, channel.op, ctx.logger);
        providerResult = receipt.result;
      } catch (error) {
        const providerError = error instanceof ProviderError
          ? error : ProviderError.unknown(errorText(error));
        throw new Error(classifySubmitFailure(db, operationId, providerError, ctx.logger));
      }
    }

    let objectHandle: TaskObjectHandle;
    try {
      objectHandle = providerObjectHandle(
        connector, capability, preview, operationId, providerResult,
      );
    } catch (error) {
      try { markConnectorFailed(db, operationId, now().rfc3339, errorText(error)); }
      catch (ledgerError) {
        ctx.logger?.warn?.(
          `[ConnectorToolExecutor] failed to persist failed state for ${operationId}: `
          + errorText(ledgerError),
        );
      }
      throw error;
    }
    const externalOperationId = extractExternalOperationId(providerResult);
    const resolvedAt = now().rfc3339;
    const receipt = receiptOf(row, preview);
    receipt.objectHandleIds.push(objectHandle.handleId);
    commitConnectorReceipt(receipt, resolvedAt);
    const output: Record<string, unknown> = {
      success: true,
      state: 'committed',
      operation_id: operationId,
      preview_sha256: previewSha256,
      object_handle: objectHandle,
      receipt,
      provider_result: providerResult,
      idempotent_replay: false,
    };
    let evidence: string;
    try { evidence = JSON.stringify(output); }
    catch (error) {
      throw new Error(`failed to persist connector evidence: ${errorText(error)}`);
    }
    markConnectorCommitted(db, operationId, resolvedAt, externalOperationId, evidence);
    return output;
  }
}

interface McpChannel {
  kind: 'mcp';
  externalTool: string;
  providerArgs: Record<string, unknown>;
}

interface WebhookChannel {
  kind: 'webhook';
  provider: ConnectorProvider;
  op: ProviderOperation;
}
