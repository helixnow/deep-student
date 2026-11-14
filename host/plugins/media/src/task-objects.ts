/**
 * `dstu-core/src/task_objects.rs`: task-object handle subset used by Office
 * delivery (schema v2). Only the builder / provenance / validation needed to
 * describe output lineage is migrated; commands still need VFS delivery.
 *
 * This is a faithful local port because `dstu-core` has no host plugin yet.
 * If a shared core plugin publishes these types later, Office output should
 * import it instead of keeping a second copy.
 */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { rustTrim } from './transcript.ts';

export const TASK_OBJECT_SCHEMA_VERSION = 2;
export const MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION = 1;
export const LEGACY_DERIVED_TRANSFORM_ID = 'legacy_unknown';

export type TaskObjectKind =
  | 'file' | 'folder' | 'message' | 'event' | 'record' | 'page' | 'artifact';

/** `hash_transform_params`：参数 JSON 的确定性 sha256 指纹。 */
export function hashTransformParams(params: unknown): string {
  return sha256HexSync(JSON.stringify(params));
}

export interface ManagedLocator {
  rootId: string;
  relativePath: string;
}

export function validateManagedLocator(locator: ManagedLocator): void {
  const root = rustTrim(locator.rootId);
  if (root === '' || root.includes('/') || root.includes('\\')) {
    throw new Error('root_id must be a non-empty runtime-root identifier');
  }
  const path = rustTrim(locator.relativePath);
  if (path === '' || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error('relative_path must be a non-empty relative path');
  }
  if (path === '.') return;
  if (path.includes('\\')) {
    throw new Error('relative_path must use forward slashes');
  }
  if (path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('relative_path contains an unsafe path segment');
  }
}

export function newManagedLocator(rootId: string, relativePath: string): ManagedLocator {
  const locator = { rootId, relativePath };
  validateManagedLocator(locator);
  return locator;
}

export interface ProviderObjectRef {
  provider: string;
  externalId: string;
  containerId: string | null;
  threadId: string | null;
  version: string | null;
  etag: string | null;
}

export interface ObjectCapabilities {
  readable: boolean;
  materializable: boolean;
  writable: boolean;
  shareable: boolean;
  sendable: boolean;
  deletable: boolean;
}

export function defaultObjectCapabilities(): ObjectCapabilities {
  return {
    readable: false,
    materializable: false,
    writable: false,
    shareable: false,
    sendable: false,
    deletable: false,
  };
}

export interface ObjectAcl {
  access: string;
  ownerId: string | null;
  principalIds: string[];
  observedAt: string | null;
}

/** 一条血缘边：本对象由哪个来源对象经哪次变换而来。 */
export class DerivedEdge {
  readonly sourceHandleId: string;
  readonly transformId: string;
  transformParamsHash: string | null;
  observedAt: string;

  constructor(sourceHandleId: string, transformId: string) {
    this.sourceHandleId = sourceHandleId;
    this.transformId = transformId;
    this.transformParamsHash = null;
    this.observedAt = new Date().toISOString();
  }

  withParamsHash(hash: string): this {
    this.transformParamsHash = hash;
    return this;
  }

  withObservedAt(observedAt: string): this {
    this.observedAt = observedAt;
    return this;
  }
}

export interface ObjectProvenance {
  source: string;
  sourceUri: string | null;
  server: string | null;
  tool: string | null;
  derivedFrom: DerivedEdge[];
  observedAt: string;
}

export class TaskObjectHandle {
  schemaVersion = TASK_OBJECT_SCHEMA_VERSION;
  handleId: string;
  kind: TaskObjectKind;
  displayName: string;
  mediaType: string | null = null;
  sizeBytes: number | null = null;
  sha256: string | null = null;
  locator: ManagedLocator | null = null;
  providerRef: ProviderObjectRef | null = null;
  acl: ObjectAcl | null = null;
  capabilities: ObjectCapabilities = defaultObjectCapabilities();
  expiresAt: string | null = null;
  provenance: ObjectProvenance;

  constructor(
    handleId: string,
    kind: TaskObjectKind,
    displayName: string,
    provenance: ObjectProvenance,
  ) {
    this.handleId = handleId;
    this.kind = kind;
    this.displayName = displayName;
    this.provenance = provenance;
  }

  validate(): void {
    if (this.schemaVersion < MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION
      || this.schemaVersion > TASK_OBJECT_SCHEMA_VERSION) {
      throw new Error(`unsupported task object schema version: ${this.schemaVersion}`);
    }
    if (rustTrim(this.handleId) === '' || rustTrim(this.displayName) === '') {
      throw new Error('handle_id and display_name are required');
    }
    if (this.locator !== null) validateManagedLocator(this.locator);
    if (this.sha256 !== null) {
      if (this.sha256.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(this.sha256)) {
        throw new Error('sha256 must be a 64-character hexadecimal digest');
      }
    }
    if (this.capabilities.materializable && this.locator === null) {
      throw new Error('materializable objects require a managed locator');
    }
  }

  /** serde wire form: camelCase, `None` fields and an empty `derivedFrom` omitted. */
  toWire(): Record<string, unknown> {
    const wire: Record<string, unknown> = {
      schemaVersion: this.schemaVersion,
      handleId: this.handleId,
      kind: this.kind,
      displayName: this.displayName,
    };
    if (this.mediaType !== null) wire.mediaType = this.mediaType;
    if (this.sizeBytes !== null) wire.sizeBytes = this.sizeBytes;
    if (this.sha256 !== null) wire.sha256 = this.sha256;
    if (this.locator !== null) {
      wire.locator = { rootId: this.locator.rootId, relativePath: this.locator.relativePath };
    }
    if (this.providerRef !== null) {
      const ref = this.providerRef;
      wire.providerRef = omitNull({
        provider: ref.provider, externalId: ref.externalId, containerId: ref.containerId,
        threadId: ref.threadId, version: ref.version, etag: ref.etag,
      });
    }
    if (this.acl !== null) {
      const acl: Record<string, unknown> = { access: this.acl.access };
      if (this.acl.ownerId !== null) acl.ownerId = this.acl.ownerId;
      if (this.acl.principalIds.length > 0) acl.principalIds = [...this.acl.principalIds];
      if (this.acl.observedAt !== null) acl.observedAt = this.acl.observedAt;
      wire.acl = acl;
    }
    wire.capabilities = { ...this.capabilities };
    if (this.expiresAt !== null) wire.expiresAt = this.expiresAt;
    const provenance: Record<string, unknown> = { source: this.provenance.source };
    if (this.provenance.sourceUri !== null) provenance.sourceUri = this.provenance.sourceUri;
    if (this.provenance.server !== null) provenance.server = this.provenance.server;
    if (this.provenance.tool !== null) provenance.tool = this.provenance.tool;
    if (this.provenance.derivedFrom.length > 0) {
      provenance.derivedFrom = this.provenance.derivedFrom.map(edge => {
        const value: Record<string, unknown> = {
          sourceHandleId: edge.sourceHandleId, transformId: edge.transformId,
        };
        if (edge.transformParamsHash !== null) value.transformParamsHash = edge.transformParamsHash;
        value.observedAt = edge.observedAt;
        return value;
      });
    }
    provenance.observedAt = this.provenance.observedAt;
    wire.provenance = provenance;
    return wire;
  }
}

function omitNull(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

const TASK_OBJECT_KINDS: readonly TaskObjectKind[] = [
  'file', 'folder', 'message', 'event', 'record', 'page', 'artifact',
];

function wireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid type: expected struct ${what}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (value === undefined) throw new Error(`missing field \`${key}\``);
  if (typeof value !== 'string') throw new Error(`invalid type for \`${key}\`, expected a string`);
  return value;
}

function optionalString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`invalid type for \`${key}\`, expected a string`);
  return value;
}

function requiredBool(object: Record<string, unknown>, key: string): boolean {
  const value = object[key];
  if (value === undefined) throw new Error(`missing field \`${key}\``);
  if (typeof value !== 'boolean') throw new Error(`invalid type for \`${key}\`, expected a boolean`);
  return value;
}

function unsignedInteger(value: unknown, key: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`invalid value for \`${key}\`, expected an unsigned integer`);
  }
  return value;
}

/** `DerivedEdge` deserialisation: v2 object, or a legacy v1 string upgraded to `legacy_unknown`. */
function derivedEdgeFromWire(value: unknown): DerivedEdge {
  if (typeof value === 'string') {
    return new DerivedEdge(value, LEGACY_DERIVED_TRANSFORM_ID).withObservedAt('');
  }
  const object = wireObject(value, 'DerivedEdge');
  const edge = new DerivedEdge(
    requiredString(object, 'sourceHandleId'), requiredString(object, 'transformId'));
  const hash = optionalString(object, 'transformParamsHash');
  if (hash !== null) edge.withParamsHash(hash);
  return edge.withObservedAt(optionalString(object, 'observedAt') ?? '');
}

/**
 * `serde_json::from_value::<TaskObjectHandle>`: required fields are enforced,
 * optional ones accept `null`/absence. Validation is left to the caller, as in Rust.
 */
export function taskObjectHandleFromWire(value: unknown): TaskObjectHandle {
  const object = wireObject(value, 'TaskObjectHandle');
  if (object.schemaVersion === undefined) throw new Error('missing field `schemaVersion`');
  const schemaVersion = unsignedInteger(object.schemaVersion, 'schemaVersion', 0xffff);
  const handleId = requiredString(object, 'handleId');
  const kind = requiredString(object, 'kind');
  if (!(TASK_OBJECT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown variant \`${kind}\`, expected one of ${TASK_OBJECT_KINDS.map(k => `\`${k}\``).join(', ')}`);
  }
  const displayName = requiredString(object, 'displayName');
  if (object.capabilities === undefined) throw new Error('missing field `capabilities`');
  const caps = wireObject(object.capabilities, 'ObjectCapabilities');
  if (object.provenance === undefined) throw new Error('missing field `provenance`');
  const provenanceWire = wireObject(object.provenance, 'ObjectProvenance');
  const derivedWire = provenanceWire.derivedFrom;
  if (derivedWire !== undefined && !Array.isArray(derivedWire)) {
    throw new Error('invalid type for `derivedFrom`, expected a sequence');
  }
  const handle = new TaskObjectHandle(handleId, kind as TaskObjectKind, displayName, {
    source: requiredString(provenanceWire, 'source'),
    sourceUri: optionalString(provenanceWire, 'sourceUri'),
    server: optionalString(provenanceWire, 'server'),
    tool: optionalString(provenanceWire, 'tool'),
    derivedFrom: (derivedWire ?? []).map(derivedEdgeFromWire),
    observedAt: requiredString(provenanceWire, 'observedAt'),
  });
  handle.schemaVersion = schemaVersion;
  handle.mediaType = optionalString(object, 'mediaType');
  if (object.sizeBytes !== undefined && object.sizeBytes !== null) {
    handle.sizeBytes = unsignedInteger(object.sizeBytes, 'sizeBytes', Number.MAX_SAFE_INTEGER);
  }
  handle.sha256 = optionalString(object, 'sha256');
  if (object.locator !== undefined && object.locator !== null) {
    const locator = wireObject(object.locator, 'ManagedLocator');
    handle.locator = {
      rootId: requiredString(locator, 'rootId'), relativePath: requiredString(locator, 'relativePath'),
    };
  }
  if (object.providerRef !== undefined && object.providerRef !== null) {
    const ref = wireObject(object.providerRef, 'ProviderObjectRef');
    handle.providerRef = {
      provider: requiredString(ref, 'provider'), externalId: requiredString(ref, 'externalId'),
      containerId: optionalString(ref, 'containerId'), threadId: optionalString(ref, 'threadId'),
      version: optionalString(ref, 'version'), etag: optionalString(ref, 'etag'),
    };
  }
  if (object.acl !== undefined && object.acl !== null) {
    const acl = wireObject(object.acl, 'ObjectAcl');
    const principals = acl.principalIds ?? [];
    if (!Array.isArray(principals) || principals.some(item => typeof item !== 'string')) {
      throw new Error('invalid type for `principalIds`, expected a sequence of strings');
    }
    handle.acl = {
      access: requiredString(acl, 'access'), ownerId: optionalString(acl, 'ownerId'),
      principalIds: principals as string[], observedAt: optionalString(acl, 'observedAt'),
    };
  }
  handle.capabilities = {
    readable: requiredBool(caps, 'readable'),
    materializable: requiredBool(caps, 'materializable'),
    writable: requiredBool(caps, 'writable'),
    shareable: requiredBool(caps, 'shareable'),
    sendable: requiredBool(caps, 'sendable'),
    deletable: requiredBool(caps, 'deletable'),
  };
  handle.expiresAt = optionalString(object, 'expiresAt');
  return handle;
}

/**
 * `TaskObjectHandleBuilder`：血缘必须显式（`derivedEdge` 或 `originUnknown`），
 * `build()` 内部执行与 Rust 相同的 `validate()`。
 */
export class TaskObjectHandleBuilder {
  private readonly handleId: string;
  private readonly kind: TaskObjectKind;
  private readonly displayName: string;
  private readonly source: string;
  private sourceUriValue: string | null = null;
  private serverValue: string | null = null;
  private toolValue: string | null = null;
  private derivedFrom: DerivedEdge[] | null = null;
  private mediaTypeValue: string | null = null;
  private sizeBytesValue: number | null = null;
  private sha256Value: string | null = null;
  private locatorValue: ManagedLocator | null = null;
  private providerRefValue: ProviderObjectRef | null = null;
  private aclValue: ObjectAcl | null = null;
  private capabilitiesValue: ObjectCapabilities = defaultObjectCapabilities();
  private expiresAtValue: string | null = null;
  private observedAtValue: string | null = null;

  constructor(
    handleId: string,
    kind: TaskObjectKind,
    displayName: string,
    source: string,
  ) {
    this.handleId = handleId;
    this.kind = kind;
    this.displayName = displayName;
    this.source = source;
  }

  sourceUri(value: string | null): this {
    this.sourceUriValue = value;
    return this;
  }

  server(value: string | null): this {
    this.serverValue = value;
    return this;
  }

  tool(value: string | null): this {
    this.toolValue = value;
    return this;
  }

  derivedEdge(edge: DerivedEdge): this {
    if (this.derivedFrom === null) this.derivedFrom = [];
    this.derivedFrom.push(edge);
    return this;
  }

  derivedEdges(edges: DerivedEdge[]): this {
    this.derivedFrom = edges;
    return this;
  }

  /** Rust 在这里落一条 debug log；日志不是交付契约，因此只保留逃生门语义。 */
  originUnknown(_reason: string): this {
    this.derivedFrom = [];
    return this;
  }

  mediaType(value: string | null): this {
    this.mediaTypeValue = value;
    return this;
  }

  sizeBytes(value: number | null): this {
    this.sizeBytesValue = value;
    return this;
  }

  sha256(value: string | null): this {
    this.sha256Value = value;
    return this;
  }

  locator(value: ManagedLocator | null): this {
    this.locatorValue = value;
    return this;
  }

  providerRef(value: ProviderObjectRef | null): this {
    this.providerRefValue = value;
    return this;
  }

  acl(value: ObjectAcl | null): this {
    this.aclValue = value;
    return this;
  }

  capabilities(value: ObjectCapabilities): this {
    this.capabilitiesValue = value;
    return this;
  }

  expiresAt(value: string | null): this {
    this.expiresAtValue = value;
    return this;
  }

  observedAt(value: string): this {
    this.observedAtValue = value;
    return this;
  }

  build(): TaskObjectHandle {
    if (this.derivedFrom === null) {
      throw new Error(
        `derived_from lineage must be explicit for handle ${this.handleId} `
        + '(use derived_edge(s) or origin_unknown)');
    }
    const handle = new TaskObjectHandle(this.handleId, this.kind, this.displayName, {
      source: this.source,
      sourceUri: this.sourceUriValue,
      server: this.serverValue,
      tool: this.toolValue,
      derivedFrom: this.derivedFrom,
      observedAt: this.observedAtValue ?? new Date().toISOString(),
    });
    handle.mediaType = this.mediaTypeValue;
    handle.sizeBytes = this.sizeBytesValue;
    handle.sha256 = this.sha256Value;
    handle.locator = this.locatorValue;
    handle.providerRef = this.providerRefValue;
    handle.acl = this.aclValue;
    handle.capabilities = this.capabilitiesValue;
    handle.expiresAt = this.expiresAtValue;
    handle.validate();
    return handle;
  }
}
