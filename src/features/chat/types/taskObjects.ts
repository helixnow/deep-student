export type TaskObjectKind =
  | 'file'
  | 'folder'
  | 'message'
  | 'event'
  | 'record'
  | 'page'
  | 'artifact';

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
  acl?: {
    access: string;
    ownerId?: string;
    principalIds?: string[];
    observedAt?: string;
  };
  capabilities: ObjectCapabilities;
  expiresAt?: string;
  provenance: {
    source: string;
    sourceUri?: string;
    server?: string;
    tool?: string;
    derivedFrom?: string[];
    observedAt: string;
  };
}

export type BatchItemStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'compensated';

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

export type OperationState = 'draft' | 'confirmed' | 'committed' | 'failed' | 'compensated';

export interface ConnectorOperationReceipt {
  operationId: string;
  idempotencyKey: string;
  provider: string;
  action: string;
  state: OperationState;
  objectHandleIds?: string[];
  recipientIds?: string[];
  destination?: string;
  irreversible: boolean;
  previewSha256: string;
  committedAt?: string;
  error?: string;
}
