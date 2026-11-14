/** task_objects.rs: managed locators, provenance and batch result serialization. */
import type { JsonValue } from '../shared.ts';
import { sha256Hex } from '../../runtime-paths.ts';
import { rustTrim } from '../../../../../platform/util/index.ts';
import { toRfc3339 } from '../../../../../platform/time/index.ts';

export type TaskObjectKind = 'file' | 'folder' | 'message' | 'event' | 'record' | 'page' | 'artifact';
export interface ManagedLocator { rootId: string; relativePath: string }
export function validateManagedLocator(locator: ManagedLocator): void {
  const root = rustTrim(locator.rootId);
  if (root === '' || root.includes('/') || root.includes('\\')) {
    throw new Error('root_id must be a non-empty runtime-root identifier');
  }
  const relative = rustTrim(locator.relativePath);
  if (relative === '' || relative.startsWith('/') || relative.startsWith('\\')) {
    throw new Error('relative_path must be a non-empty relative path');
  }
  if (relative === '.') return;
  if (relative.includes('\\')) throw new Error('relative_path must use forward slashes');
  if (relative.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('relative_path contains an unsafe path segment');
  }
}
export function managedLocator(rootId: string, relativePath: string): ManagedLocator {
  const locator = { rootId, relativePath };
  validateManagedLocator(locator);
  return locator;
}
export interface ObjectCapabilities {
  readable: boolean; materializable: boolean; writable: boolean;
  shareable: boolean; sendable: boolean; deletable: boolean;
}
export function defaultObjectCapabilities(): ObjectCapabilities {
  return { readable: false, materializable: false, writable: false,
    shareable: false, sendable: false, deletable: false };
}
export interface DerivedEdge {
  sourceHandleId: string; transformId: string; transformParamsHash?: string; observedAt: string;
}
export function derivedEdge(sourceHandleId: string, transformId: string): DerivedEdge {
  return { sourceHandleId, transformId, transformParamsHash: undefined, observedAt: toRfc3339() };
}
export function withParamsHash(edge: DerivedEdge, hash: string): DerivedEdge {
  return { ...edge, transformParamsHash: hash };
}
export interface ObjectProvenance {
  source: string; sourceUri?: string; server?: string; tool?: string;
  derivedFrom: DerivedEdge[]; observedAt: string;
}
export interface TaskObjectHandle {
  schemaVersion: number; handleId: string; kind: TaskObjectKind; displayName: string;
  mediaType?: string; sizeBytes?: number; sha256?: string; locator?: ManagedLocator;
  capabilities: ObjectCapabilities; expiresAt?: string; provenance: ObjectProvenance;
}
export function hashTransformParams(params: JsonValue): string {
  return sha256Hex(JSON.stringify(params));
}
const TASK_OBJECT_SCHEMA_VERSION = 2;
const MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION = 1;
export function validateTaskObjectHandle(handle: TaskObjectHandle): void {
  if (handle.schemaVersion < MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION
    || handle.schemaVersion > TASK_OBJECT_SCHEMA_VERSION) {
    throw new Error(`unsupported task object schema version: ${handle.schemaVersion}`);
  }
  if (rustTrim(handle.handleId) === '' || rustTrim(handle.displayName) === '') {
    throw new Error('handle_id and display_name are required');
  }
  if (handle.locator) validateManagedLocator(handle.locator);
  if (handle.sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(handle.sha256)) {
    throw new Error('sha256 must be a 64-character hexadecimal digest');
  }
  if (handle.capabilities.materializable && !handle.locator) {
    throw new Error('materializable objects require a managed locator');
  }
}
export class TaskObjectHandleBuilder {
  private readonly handleId: string;
  private readonly kind: TaskObjectKind;
  private readonly displayName: string;
  private readonly source: string;
  private sourceUriValue: string | undefined;
  private serverValue: string | undefined;
  private toolValue: string | undefined;
  private derivedFrom: DerivedEdge[] | null = null;
  private mediaTypeValue: string | undefined;
  private sizeBytesValue: number | undefined;
  private sha256Value: string | undefined;
  private locatorValue: ManagedLocator | undefined;
  private capabilitiesValue: ObjectCapabilities = defaultObjectCapabilities();
  private expiresAtValue: string | undefined;
  private observedAtValue: string | undefined;
  constructor(handleId: string, kind: TaskObjectKind, displayName: string, source: string) {
    this.handleId = handleId;
    this.kind = kind;
    this.displayName = displayName;
    this.source = source;
  }
  sourceUri(value: string | undefined): this { this.sourceUriValue = value; return this; }
  server(value: string | undefined): this { this.serverValue = value; return this; }
  tool(value: string | undefined): this { this.toolValue = value; return this; }
  derivedEdge(edge: DerivedEdge): this {
    this.derivedFrom = this.derivedFrom ?? [];
    this.derivedFrom.push(edge);
    return this;
  }
  derivedEdges(edges: DerivedEdge[]): this { this.derivedFrom = edges; return this; }
  originUnknown(): this { this.derivedFrom = []; return this; }
  mediaType(value: string | undefined): this { this.mediaTypeValue = value; return this; }
  sizeBytes(value: number | undefined): this { this.sizeBytesValue = value; return this; }
  sha256(value: string | undefined): this { this.sha256Value = value; return this; }
  locator(value: ManagedLocator | undefined): this { this.locatorValue = value; return this; }
  capabilities(value: ObjectCapabilities): this { this.capabilitiesValue = value; return this; }
  expiresAt(value: string | undefined): this { this.expiresAtValue = value; return this; }
  observedAt(value: string): this { this.observedAtValue = value; return this; }
  build(): TaskObjectHandle {
    const derivedFrom = this.derivedFrom;
    if (derivedFrom === null) {
      throw new Error(`derived_from lineage must be explicit for handle ${this.handleId} `
        + '(use derived_edge(s) or origin_unknown)');
    }
    const handle: TaskObjectHandle = {
      schemaVersion: TASK_OBJECT_SCHEMA_VERSION, handleId: this.handleId, kind: this.kind,
      displayName: this.displayName, mediaType: this.mediaTypeValue, sizeBytes: this.sizeBytesValue,
      sha256: this.sha256Value, locator: this.locatorValue, capabilities: this.capabilitiesValue,
      expiresAt: this.expiresAtValue,
      provenance: { source: this.source, sourceUri: this.sourceUriValue, server: this.serverValue,
        tool: this.toolValue, derivedFrom, observedAt: this.observedAtValue ?? toRfc3339() },
    };
    validateTaskObjectHandle(handle);
    return handle;
  }
}
export type BatchItemStatus = 'pending' | 'succeeded' | 'failed' | 'skipped' | 'compensated';
export interface BatchManifestItem {
  itemId: string; objectHandleId?: string; status: BatchItemStatus; attempts: number; error?: string;
}
export interface BatchManifest {
  manifestId: string; expectedItems: number; observedItems: number;
  coverageComplete: boolean; truncated: boolean; items: BatchManifestItem[];
}
export function canClaimCompleteSuccess(manifest: BatchManifest): boolean {
  return manifest.coverageComplete && !manifest.truncated
    && manifest.observedItems === manifest.expectedItems
    && manifest.items.length === manifest.expectedItems
    && manifest.items.every(item => item.status === 'succeeded');
}
function serializeDerivedEdge(edge: DerivedEdge): { [key: string]: JsonValue } {
  const value: { [key: string]: JsonValue } = {
    sourceHandleId: edge.sourceHandleId, transformId: edge.transformId,
  };
  if (edge.transformParamsHash !== undefined) value['transformParamsHash'] = edge.transformParamsHash;
  value['observedAt'] = edge.observedAt;
  return value;
}
export function serializeTaskObjectHandle(handle: TaskObjectHandle): { [key: string]: JsonValue } {
  const value: { [key: string]: JsonValue } = {
    schemaVersion: handle.schemaVersion, handleId: handle.handleId, kind: handle.kind, displayName: handle.displayName,
  };
  if (handle.mediaType !== undefined) value['mediaType'] = handle.mediaType;
  if (handle.sizeBytes !== undefined) value['sizeBytes'] = handle.sizeBytes;
  if (handle.sha256 !== undefined) value['sha256'] = handle.sha256;
  if (handle.locator !== undefined) value['locator'] = { rootId: handle.locator.rootId, relativePath: handle.locator.relativePath };
  value['capabilities'] = {
    readable: handle.capabilities.readable, materializable: handle.capabilities.materializable,
    writable: handle.capabilities.writable, shareable: handle.capabilities.shareable,
    sendable: handle.capabilities.sendable, deletable: handle.capabilities.deletable,
  };
  if (handle.expiresAt !== undefined) value['expiresAt'] = handle.expiresAt;
  value['provenance'] = {
    source: handle.provenance.source,
    ...(handle.provenance.sourceUri !== undefined ? { sourceUri: handle.provenance.sourceUri } : {}),
    ...(handle.provenance.server !== undefined ? { server: handle.provenance.server } : {}),
    ...(handle.provenance.tool !== undefined ? { tool: handle.provenance.tool } : {}),
    derivedFrom: handle.provenance.derivedFrom.map(serializeDerivedEdge), observedAt: handle.provenance.observedAt,
  };
  return value;
}
export function serializeBatchManifest(manifest: BatchManifest): { [key: string]: JsonValue } {
  return {
    manifestId: manifest.manifestId, expectedItems: manifest.expectedItems, observedItems: manifest.observedItems,
    coverageComplete: manifest.coverageComplete, truncated: manifest.truncated,
    items: manifest.items.map(item => {
      const value: { [key: string]: JsonValue } = { itemId: item.itemId };
      if (item.objectHandleId !== undefined) value['objectHandleId'] = item.objectHandleId;
      value['status'] = item.status;
      value['attempts'] = item.attempts;
      if (item.error !== undefined) value['error'] = item.error;
      return value;
    }),
  };
}
