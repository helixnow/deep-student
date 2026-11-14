/**
 * Task-object handles, provenance and lineage, ported from the subset of
 * `src-tauri/crates/dstu-core/src/task_objects.rs` used by tool executors.
 *
 * A model being able to see content is not the same as an executor being able
 * to operate on it, so every materialized object carries an explicit handle
 * with a managed locator and an explicit lineage edge.
 */
import { sha256HexSync } from '../../../../platform/crypto/sync.ts';
import { now } from '../../../../platform/time/index.ts';

export const TASK_OBJECT_SCHEMA_VERSION = 2;
export const LEGACY_DERIVED_TRANSFORM_ID = 'legacy_unknown';

export type TaskObjectKind =
  | 'file' | 'folder' | 'message' | 'event' | 'record' | 'page' | 'artifact';

export interface ManagedLocator {
  rootId: string;
  relativePath: string;
}

export interface ProviderObjectRef {
  provider: string;
  externalId: string;
  containerId?: string;
  threadId?: string;
  version?: string;
  etag?: string;
}

export interface ObjectCapabilities {
  readable: boolean;
  materializable: boolean;
  writable: boolean;
  shareable: boolean;
  sendable: boolean;
  deletable: boolean;
}

export interface ObjectAcl {
  access: string;
  ownerId?: string;
  principalIds?: string[];
  observedAt?: string;
}

export interface DerivedEdge {
  sourceHandleId: string;
  transformId: string;
  transformParamsHash?: string;
  observedAt: string;
}

export interface ObjectProvenance {
  source: string;
  sourceUri?: string;
  server?: string;
  tool?: string;
  derivedFrom: DerivedEdge[];
  observedAt: string;
}

export type OperationState =
  | 'draft' | 'confirmed' | 'committed' | 'failed' | 'compensated';

export interface ConnectorOperationReceipt {
  operationId: string;
  idempotencyKey: string;
  provider: string;
  action: string;
  state: OperationState;
  objectHandleIds: string[];
  recipientIds: string[];
  destination?: string;
  irreversible: boolean;
  previewSha256: string;
  committedAt?: string;
  error?: string;
}

/** Confirm only from `draft` and only when the observed hash matches. */
export function confirmConnectorReceipt(
  receipt: ConnectorOperationReceipt,
  observedPreviewSha256: string,
): void {
  if (receipt.state !== 'draft') {
    throw new Error('only a draft operation can be confirmed');
  }
  if (observedPreviewSha256 !== receipt.previewSha256) {
    throw new Error('operation preview changed; review the latest target and payload');
  }
  receipt.state = 'confirmed';
}

/** Commit only from `confirmed` (never from a bare draft). */
export function commitConnectorReceipt(
  receipt: ConnectorOperationReceipt,
  committedAt: string,
): void {
  if (receipt.state !== 'confirmed') {
    throw new Error('operation must be confirmed before commit');
  }
  receipt.state = 'committed';
  receipt.committedAt = committedAt;
}

export interface TaskObjectHandle {
  schemaVersion: number;
  handleId: string;
  kind: TaskObjectKind;
  displayName: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  locator?: ManagedLocator;
  providerRef?: ProviderObjectRef;
  acl?: ObjectAcl;
  capabilities: ObjectCapabilities;
  expiresAt?: string;
  provenance: ObjectProvenance;
}

export type BatchItemStatus = 'pending' | 'succeeded' | 'failed' | 'skipped' | 'compensated';

export interface BatchManifestItem {
  itemId: string;
  objectHandleId?: string;
  status: BatchItemStatus;
  attempts: number;
  error?: string;
}

export interface BatchManifest {
  manifestId: string;
  expectedItems: number;
  observedItems: number;
  coverageComplete: boolean;
  truncated: boolean;
  items: BatchManifestItem[];
}

/** Rust `BatchManifest` serde (camelCase, snake_case status). */
export function deserializeBatchManifest(value: unknown): BatchManifest {
  const record = recordOf(value, 'BatchManifest');
  const expectedItems = optionalNumber(record, 'expectedItems', 'BatchManifest');
  const observedItems = optionalNumber(record, 'observedItems', 'BatchManifest');
  if (expectedItems === undefined || observedItems === undefined) {
    throw new Error('BatchManifest.expectedItems/observedItems are required');
  }
  if (!Array.isArray(record.items)) throw new Error('BatchManifest.items must be an array');
  const statuses: readonly BatchItemStatus[] = [
    'pending', 'succeeded', 'failed', 'skipped', 'compensated',
  ];
  const items = record.items.map((raw, index) => {
    const item = recordOf(raw, `BatchManifest.items[${index}]`);
    const status = requiredString(item, 'status', `BatchManifest.items[${index}]`);
    if (!statuses.includes(status as BatchItemStatus)) {
      throw new Error(`BatchManifest.items[${index}].status is unknown: ${status}`);
    }
    const attempts = optionalNumber(item, 'attempts', `BatchManifest.items[${index}]`);
    if (attempts === undefined) throw new Error(`BatchManifest.items[${index}].attempts is required`);
    return {
      itemId: requiredString(item, 'itemId', `BatchManifest.items[${index}]`),
      ...(optionalString(item, 'objectHandleId', `BatchManifest.items[${index}]`) === undefined
        ? {}
        : { objectHandleId: optionalString(item, 'objectHandleId', `BatchManifest.items[${index}]`)! }),
      status: status as BatchItemStatus,
      attempts,
      ...(optionalString(item, 'error', `BatchManifest.items[${index}]`) === undefined
        ? {}
        : { error: optionalString(item, 'error', `BatchManifest.items[${index}]`)! }),
    };
  });
  return {
    manifestId: requiredString(record, 'manifestId', 'BatchManifest'),
    expectedItems,
    observedItems,
    coverageComplete: requiredBoolean(record, 'coverageComplete', 'BatchManifest'),
    truncated: requiredBoolean(record, 'truncated', 'BatchManifest'),
    items,
  };
}

/** Rust `BatchManifest::can_claim_complete_success`. */
export function canClaimCompleteSuccess(manifest: BatchManifest): boolean {
  return manifest.coverageComplete
    && !manifest.truncated
    && manifest.observedItems === manifest.expectedItems
    && manifest.items.length === manifest.expectedItems
    && manifest.items.every(item => item.status === 'succeeded');
}

export const CORPUS_MANIFEST_SCHEMA_VERSION = 1;

export interface CorpusManifestEntry {
  handle: TaskObjectHandle;
  refCount: number;
}

export interface CorpusManifestPage {
  pageNo: number;
  objectHandles: CorpusManifestEntry[];
}

export interface CorpusManifest {
  schemaVersion: number;
  manifestId: string;
  totalCount: number;
  pageSize: number;
  pages: CorpusManifestPage[];
  createdAt: string;
  sourceSessionId: string;
}

/** Rust `CorpusManifest` serde (parse only; callers validate explicitly). */
export function deserializeCorpusManifest(value: unknown): CorpusManifest {
  const record = recordOf(value, 'CorpusManifest');
  const schemaVersion = optionalNumber(record, 'schemaVersion', 'CorpusManifest');
  const totalCount = optionalNumber(record, 'totalCount', 'CorpusManifest');
  const pageSize = optionalNumber(record, 'pageSize', 'CorpusManifest');
  if (schemaVersion === undefined || totalCount === undefined || pageSize === undefined) {
    throw new Error('CorpusManifest.schemaVersion/totalCount/pageSize are required');
  }
  if (!Array.isArray(record.pages)) throw new Error('CorpusManifest.pages must be an array');
  const pages = record.pages.map((rawPage, pageIndex) => {
    const page = recordOf(rawPage, `CorpusManifest.pages[${pageIndex}]`);
    const pageNo = optionalNumber(page, 'pageNo', `CorpusManifest.pages[${pageIndex}]`);
    if (pageNo === undefined) {
      throw new Error(`CorpusManifest.pages[${pageIndex}].pageNo is required`);
    }
    if (!Array.isArray(page.objectHandles)) {
      throw new Error(`CorpusManifest.pages[${pageIndex}].objectHandles must be an array`);
    }
    const objectHandles = page.objectHandles.map((rawEntry, entryIndex) => {
      const label = `CorpusManifest.pages[${pageIndex}].objectHandles[${entryIndex}]`;
      const entry = recordOf(rawEntry, label);
      const refCount = optionalNumber(entry, 'refCount', label);
      if (refCount === undefined) throw new Error(`${label}.refCount is required`);
      return { handle: deserializeTaskObjectHandle(entry.handle), refCount };
    });
    return { pageNo, objectHandles };
  });
  return {
    schemaVersion,
    manifestId: requiredString(record, 'manifestId', 'CorpusManifest'),
    totalCount,
    pageSize,
    pages,
    createdAt: requiredString(record, 'createdAt', 'CorpusManifest'),
    sourceSessionId: requiredString(record, 'sourceSessionId', 'CorpusManifest'),
  };
}

/**
 * Rust `CorpusManifest::build`: dedupe by handle_id (first occurrence order,
 * ref_count retained), slice into pages, then validate the result.
 */
export function buildCorpusManifest(
  manifestId: string,
  sourceSessionId: string,
  handles: readonly TaskObjectHandle[],
  pageSize: number,
): CorpusManifest {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error('page_size must be positive');
  }
  const indexByHandleId = new Map<string, number>();
  const entries: CorpusManifestEntry[] = [];
  for (const handle of handles) {
    validateTaskObjectHandle(handle);
    const index = indexByHandleId.get(handle.handleId);
    if (index !== undefined) {
      const next = entries[index]!.refCount + 1;
      if (next > 0xffff_ffff) {
        throw new Error(`ref_count overflow for handle '${handle.handleId}'`);
      }
      entries[index]!.refCount = next;
      continue;
    }
    indexByHandleId.set(handle.handleId, entries.length);
    entries.push({ handle, refCount: 1 });
  }
  const pages: CorpusManifestPage[] = [];
  for (let offset = 0; offset < entries.length; offset += pageSize) {
    pages.push({
      pageNo: pages.length + 1,
      objectHandles: entries.slice(offset, offset + pageSize),
    });
  }
  const manifest: CorpusManifest = {
    schemaVersion: CORPUS_MANIFEST_SCHEMA_VERSION,
    manifestId,
    totalCount: entries.length,
    pageSize,
    pages,
    createdAt: now().rfc3339,
    sourceSessionId,
  };
  validateCorpusManifest(manifest);
  return manifest;
}

/** Rust `CorpusManifest::validate`. */
export function validateCorpusManifest(manifest: CorpusManifest): void {
  if (manifest.schemaVersion !== CORPUS_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported corpus manifest schema version: ${manifest.schemaVersion}`);
  }
  if (manifest.manifestId.trim() === '') throw new Error('manifest_id is required');
  if (!Number.isInteger(manifest.pageSize) || manifest.pageSize <= 0) {
    throw new Error('page_size must be positive');
  }
  let counted = 0;
  const seen = new Set<string>();
  for (const [index, page] of manifest.pages.entries()) {
    if (page.pageNo !== index + 1) {
      throw new Error(
        `page_no must be sequential from 1 (page index ${index} has page_no ${page.pageNo})`,
      );
    }
    if (page.objectHandles.length === 0) throw new Error(`page ${page.pageNo} is empty`);
    if (page.objectHandles.length > manifest.pageSize) {
      throw new Error(`page ${page.pageNo} exceeds page_size ${manifest.pageSize}`);
    }
    if (index + 1 !== manifest.pages.length && page.objectHandles.length !== manifest.pageSize) {
      throw new Error(`non-final page ${page.pageNo} must be full`);
    }
    for (const entry of page.objectHandles) {
      if (entry.refCount === 0) {
        throw new Error(`entry '${entry.handle.handleId}' has ref_count 0`);
      }
      if (seen.has(entry.handle.handleId)) {
        throw new Error(`duplicate handle '${entry.handle.handleId}' across pages`);
      }
      seen.add(entry.handle.handleId);
      counted += 1;
    }
  }
  if (counted !== manifest.totalCount) {
    throw new Error(
      `total_count ${manifest.totalCount} does not match ${counted} listed entries`,
    );
  }
}

/** Rust `CorpusManifest::model_notice`. */
export function corpusManifestModelNotice(
  manifest: CorpusManifest,
  carriedCount: number,
  locator: ManagedLocator,
): string {
  return `本次接受 ${manifest.totalCount} 个文件对象（重复引用已按 handle 去重并保留 refCount），`
    + `超出单次携带上限 ${manifest.pageSize}，已启用分页语料清单：\n`
    + `- 第 1 页 ${carriedCount} 个对象已物化并随 <attachment_metadata> 进入上下文，可直接处理；\n`
    + `- 完整清单 ${manifest.manifestId} 共 ${manifest.pages.length} 页`
    + `（每页 ≤ ${manifest.pageSize} 项），物化于 ${locator.rootId}:${locator.relativePath}；\n`
    + '用 object_read 分页回读清单可获得任意成员的 rootId/relativePath/sha256；\n'
    + '- 全部成员已物化到会话受管 root（locator 见清单条目），取得路径后可用 '
    + 'workspace_file_read 或 local_shell_execute 按需处理；\n'
    + `- 「处理全部文件」的验收分母固定为 totalCount=${manifest.totalCount}（接受时钉定），`
    + '逐项核对，不得遗漏，不得因同名或重复引用而错误合并。';
}

export { now as utcRfc3339Now };

/** Deterministic sha256 over compact JSON; callers must use a fixed key order. */
export function hashTransformParams(params: unknown): string {
  return sha256HexSync(JSON.stringify(params));
}

export function managedLocator(rootId: string, relativePath: string): ManagedLocator {
  validateLocator({ rootId, relativePath });
  return { rootId, relativePath };
}

export function validateLocator(locator: ManagedLocator): void {
  const root = locator.rootId.trim();
  if (root === '' || root.includes('/') || root.includes('\\')) {
    throw new Error('root_id must be a non-empty runtime-root identifier');
  }
  const path = locator.relativePath.trim();
  if (path === '' || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error('relative_path must be a non-empty relative path');
  }
  if (path === '.') return;
  if (path.includes('\\')) throw new Error('relative_path must use forward slashes');
  if (path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('relative_path contains an unsafe path segment');
  }
}

export function derivedEdge(sourceHandleId: string, transformId: string): DerivedEdge {
  return { sourceHandleId, transformId, observedAt: now().rfc3339 };
}

export function withParamsHash(edge: DerivedEdge, hash: string): DerivedEdge {
  return { ...edge, transformParamsHash: hash };
}

export function taskObjectHandle(
  handleId: string,
  kind: TaskObjectKind,
  displayName: string,
  provenance: ObjectProvenance,
): TaskObjectHandle {
  return {
    schemaVersion: TASK_OBJECT_SCHEMA_VERSION,
    handleId,
    kind,
    displayName,
    capabilities: defaultCapabilities(),
    provenance,
  };
}

function defaultCapabilities(): ObjectCapabilities {
  return {
    readable: false,
    materializable: false,
    writable: false,
    shareable: false,
    sendable: false,
    deletable: false,
  };
}

export function validateTaskObjectHandle(handle: TaskObjectHandle): void {
  if (handle.schemaVersion < 1 || handle.schemaVersion > TASK_OBJECT_SCHEMA_VERSION) {
    throw new Error(`unsupported task object schema version: ${handle.schemaVersion}`);
  }
  if (handle.handleId.trim() === '' || handle.displayName.trim() === '') {
    throw new Error('handle_id and display_name are required');
  }
  if (handle.locator !== undefined) validateLocator(handle.locator);
  if (handle.sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(handle.sha256)) {
    throw new Error('sha256 must be a 64-character hexadecimal digest');
  }
  if (handle.capabilities.materializable && handle.locator === undefined) {
    throw new Error('materializable objects require a managed locator');
  }
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string`);
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`${label}.${key} must be a boolean`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}.${key} must be a non-negative safe integer`);
  }
  return value;
}

/** Rust `DerivedEdge` serde: v2 object, with v1 bare-string lineage upgraded. */
export function deserializeDerivedEdge(value: unknown): DerivedEdge {
  if (typeof value === 'string') {
    return {
      sourceHandleId: value,
      transformId: LEGACY_DERIVED_TRANSFORM_ID,
      observedAt: '',
    };
  }
  const record = recordOf(value, 'derived edge');
  return {
    sourceHandleId: requiredString(record, 'sourceHandleId', 'derived edge'),
    transformId: requiredString(record, 'transformId', 'derived edge'),
    ...(optionalString(record, 'transformParamsHash', 'derived edge') === undefined
      ? {}
      : { transformParamsHash: optionalString(record, 'transformParamsHash', 'derived edge')! }),
    observedAt: optionalString(record, 'observedAt', 'derived edge') ?? '',
  };
}

/** Rust `TaskObjectHandle` serde: v1 string lineage and v2 edges both validate. */
export function deserializeTaskObjectHandle(value: unknown): TaskObjectHandle {
  const record = recordOf(value, 'TaskObjectHandle');
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new Error('TaskObjectHandle.schemaVersion must be an integer');
  }
  const kind = requiredString(record, 'kind', 'TaskObjectHandle');
  const kinds: readonly TaskObjectKind[] = [
    'file', 'folder', 'message', 'event', 'record', 'page', 'artifact',
  ];
  if (!kinds.includes(kind as TaskObjectKind)) {
    throw new Error(`TaskObjectHandle.kind is unknown: ${kind}`);
  }
  const capabilitiesRecord = recordOf(record.capabilities, 'TaskObjectHandle.capabilities');
  const capabilities: ObjectCapabilities = {
    readable: requiredBoolean(capabilitiesRecord, 'readable', 'TaskObjectHandle.capabilities'),
    materializable: requiredBoolean(capabilitiesRecord, 'materializable', 'TaskObjectHandle.capabilities'),
    writable: requiredBoolean(capabilitiesRecord, 'writable', 'TaskObjectHandle.capabilities'),
    shareable: requiredBoolean(capabilitiesRecord, 'shareable', 'TaskObjectHandle.capabilities'),
    sendable: requiredBoolean(capabilitiesRecord, 'sendable', 'TaskObjectHandle.capabilities'),
    deletable: requiredBoolean(capabilitiesRecord, 'deletable', 'TaskObjectHandle.capabilities'),
  };
  const provenanceRecord = recordOf(record.provenance, 'TaskObjectHandle.provenance');
  const derivedRaw = provenanceRecord.derivedFrom;
  if (derivedRaw !== undefined && !Array.isArray(derivedRaw)) {
    throw new Error('TaskObjectHandle.provenance.derivedFrom must be an array');
  }
  const provenance: ObjectProvenance = {
    source: requiredString(provenanceRecord, 'source', 'TaskObjectHandle.provenance'),
    ...(optionalString(provenanceRecord, 'sourceUri', 'TaskObjectHandle.provenance') === undefined
      ? {}
      : { sourceUri: optionalString(provenanceRecord, 'sourceUri', 'TaskObjectHandle.provenance')! }),
    ...(optionalString(provenanceRecord, 'server', 'TaskObjectHandle.provenance') === undefined
      ? {}
      : { server: optionalString(provenanceRecord, 'server', 'TaskObjectHandle.provenance')! }),
    ...(optionalString(provenanceRecord, 'tool', 'TaskObjectHandle.provenance') === undefined
      ? {}
      : { tool: optionalString(provenanceRecord, 'tool', 'TaskObjectHandle.provenance')! }),
    derivedFrom: Array.isArray(derivedRaw) ? derivedRaw.map(deserializeDerivedEdge) : [],
    observedAt: requiredString(provenanceRecord, 'observedAt', 'TaskObjectHandle.provenance'),
  };
  const handle: TaskObjectHandle = {
    schemaVersion,
    handleId: requiredString(record, 'handleId', 'TaskObjectHandle'),
    kind: kind as TaskObjectKind,
    displayName: requiredString(record, 'displayName', 'TaskObjectHandle'),
    capabilities,
    provenance,
  };
  const mediaType = optionalString(record, 'mediaType', 'TaskObjectHandle');
  if (mediaType !== undefined) handle.mediaType = mediaType;
  const sizeBytes = optionalNumber(record, 'sizeBytes', 'TaskObjectHandle');
  if (sizeBytes !== undefined) handle.sizeBytes = sizeBytes;
  const sha256 = optionalString(record, 'sha256', 'TaskObjectHandle');
  if (sha256 !== undefined) handle.sha256 = sha256;
  if (record.locator !== undefined && record.locator !== null) {
    const locator = recordOf(record.locator, 'TaskObjectHandle.locator');
    handle.locator = {
      rootId: requiredString(locator, 'rootId', 'TaskObjectHandle.locator'),
      relativePath: requiredString(locator, 'relativePath', 'TaskObjectHandle.locator'),
    };
  }
  if (record.providerRef !== undefined && record.providerRef !== null) {
    const ref = recordOf(record.providerRef, 'TaskObjectHandle.providerRef');
    handle.providerRef = {
      provider: requiredString(ref, 'provider', 'TaskObjectHandle.providerRef'),
      externalId: requiredString(ref, 'externalId', 'TaskObjectHandle.providerRef'),
      ...(optionalString(ref, 'containerId', 'TaskObjectHandle.providerRef') === undefined
        ? {}
        : { containerId: optionalString(ref, 'containerId', 'TaskObjectHandle.providerRef')! }),
      ...(optionalString(ref, 'threadId', 'TaskObjectHandle.providerRef') === undefined
        ? {}
        : { threadId: optionalString(ref, 'threadId', 'TaskObjectHandle.providerRef')! }),
      ...(optionalString(ref, 'version', 'TaskObjectHandle.providerRef') === undefined
        ? {}
        : { version: optionalString(ref, 'version', 'TaskObjectHandle.providerRef')! }),
      ...(optionalString(ref, 'etag', 'TaskObjectHandle.providerRef') === undefined
        ? {}
        : { etag: optionalString(ref, 'etag', 'TaskObjectHandle.providerRef')! }),
    };
  }
  if (record.acl !== undefined && record.acl !== null) {
    const acl = recordOf(record.acl, 'TaskObjectHandle.acl');
    const principals = acl.principalIds;
    if (principals !== undefined && (!Array.isArray(principals)
      || principals.some(principal => typeof principal !== 'string'))) {
      throw new Error('TaskObjectHandle.acl.principalIds must be a string array');
    }
    handle.acl = {
      access: requiredString(acl, 'access', 'TaskObjectHandle.acl'),
      ...(optionalString(acl, 'ownerId', 'TaskObjectHandle.acl') === undefined
        ? {}
        : { ownerId: optionalString(acl, 'ownerId', 'TaskObjectHandle.acl')! }),
      ...(Array.isArray(principals) ? { principalIds: [...principals] as string[] } : {}),
      ...(optionalString(acl, 'observedAt', 'TaskObjectHandle.acl') === undefined
        ? {}
        : { observedAt: optionalString(acl, 'observedAt', 'TaskObjectHandle.acl')! }),
    };
  }
  const expiresAt = optionalString(record, 'expiresAt', 'TaskObjectHandle');
  if (expiresAt !== undefined) handle.expiresAt = expiresAt;
  validateTaskObjectHandle(handle);
  return handle;
}

/**
 * `TaskObjectHandleBuilder`: lineage must be explicit (`derivedEdge(s)` or
 * `originUnknown`), otherwise `build()` fails.
 */
export interface TaskObjectLogger {
  debug?(message: string): void;
}

export class TaskObjectHandleBuilder {
  private readonly handleIdValue: string;
  private readonly kindValue: TaskObjectKind;
  private readonly displayNameValue: string;
  private readonly sourceValue: string;
  private sourceUriValue: string | undefined;
  private serverValue: string | undefined;
  private toolValue: string | undefined;
  private derivedFromValue: DerivedEdge[] | undefined;
  private originUnknownReason: string | undefined;
  private mediaTypeValue: string | undefined;
  private sizeBytesValue: number | undefined;
  private sha256Value: string | undefined;
  private locatorValue: ManagedLocator | undefined;
  private providerRefValue: ProviderObjectRef | undefined;
  private aclValue: ObjectAcl | undefined;
  private capabilitiesValue: ObjectCapabilities = defaultCapabilities();
  private expiresAtValue: string | undefined;
  private observedAtValue: string | undefined;
  private readonly logger: TaskObjectLogger;

  constructor(
    handleId: string,
    kind: TaskObjectKind,
    displayName: string,
    source: string,
    logger: TaskObjectLogger = {},
  ) {
    this.logger = logger;
    this.handleIdValue = handleId;
    this.kindValue = kind;
    this.displayNameValue = displayName;
    this.sourceValue = source;
  }

  sourceUri(value: string | undefined): this { this.sourceUriValue = value; return this; }
  server(value: string | undefined): this { this.serverValue = value; return this; }
  tool(value: string | undefined): this { this.toolValue = value; return this; }

  derivedEdge(edge: DerivedEdge): this {
    (this.derivedFromValue ??= []).push(edge);
    return this;
  }

  derivedEdges(edges: readonly DerivedEdge[]): this {
    this.derivedFromValue = [...edges];
    return this;
  }

  originUnknown(reason: string): this {
    this.originUnknownReason = reason;
    this.derivedFromValue = [];
    return this;
  }

  mediaType(value: string | undefined): this { this.mediaTypeValue = value; return this; }
  sizeBytes(value: number | undefined): this { this.sizeBytesValue = value; return this; }
  sha256(value: string | undefined): this { this.sha256Value = value; return this; }
  locator(value: ManagedLocator | undefined): this { this.locatorValue = value; return this; }
  providerRef(value: ProviderObjectRef | undefined): this { this.providerRefValue = value; return this; }
  acl(value: ObjectAcl | undefined): this { this.aclValue = value; return this; }
  capabilities(value: ObjectCapabilities): this { this.capabilitiesValue = value; return this; }
  expiresAt(value: string | undefined): this { this.expiresAtValue = value; return this; }
  observedAt(value: string): this { this.observedAtValue = value; return this; }

  build(): TaskObjectHandle {
    if (this.derivedFromValue === undefined) {
      throw new Error(
        `derived_from lineage must be explicit for handle ${this.handleIdValue} `
        + '(use derived_edge(s) or origin_unknown)',
      );
    }
    if (this.originUnknownReason !== undefined) {
      this.logger.debug?.(
        `[task_objects] handle ${this.handleIdValue} built with origin_unknown lineage: `
        + this.originUnknownReason,
      );
    }
    const handle = taskObjectHandle(
      this.handleIdValue,
      this.kindValue,
      this.displayNameValue,
      {
        source: this.sourceValue,
        ...(this.sourceUriValue === undefined ? {} : { sourceUri: this.sourceUriValue }),
        ...(this.serverValue === undefined ? {} : { server: this.serverValue }),
        ...(this.toolValue === undefined ? {} : { tool: this.toolValue }),
        derivedFrom: [...this.derivedFromValue],
        observedAt: this.observedAtValue ?? now().rfc3339,
      },
    );
    if (this.mediaTypeValue !== undefined) handle.mediaType = this.mediaTypeValue;
    if (this.sizeBytesValue !== undefined) handle.sizeBytes = this.sizeBytesValue;
    if (this.sha256Value !== undefined) handle.sha256 = this.sha256Value;
    if (this.locatorValue !== undefined) handle.locator = this.locatorValue;
    if (this.providerRefValue !== undefined) handle.providerRef = this.providerRefValue;
    if (this.aclValue !== undefined) handle.acl = this.aclValue;
    handle.capabilities = this.capabilitiesValue;
    if (this.expiresAtValue !== undefined) handle.expiresAt = this.expiresAtValue;
    validateTaskObjectHandle(handle);
    return handle;
  }
}
