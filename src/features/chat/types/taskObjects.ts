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

/** 后端 `chat_v2::task_objects::DerivedEdge` 的 camelCase wire 形态。 */
export interface DerivedEdge {
  sourceHandleId: string;
  transformId: string;
  transformParamsHash?: string;
  observedAt: string;
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
    /**
     * 血缘边（schema v2）：来源标识 + 变换标识 + 可选参数指纹 + 观测时间。
     * 与后端 `chat_v2::task_objects::DerivedEdge` 对齐（serde camelCase）；
     * 后端反序列化兼容 v1 纯字符串格式，前端序列化恒为对象格式。
     */
    derivedFrom?: DerivedEdge[];
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

// —— G11-P2 分页语料清单（CorpusManifest）——
// 超过单次携带上限时产出：totalCount 钉在创建时（验收分母），重复引用按
// handleId 去重并保留 refCount，同名不同内容文件各自独立成条不合并。

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
  /** 去重后的对象总数（= 全页条目数之和），创建时钉定、之后不漂移。 */
  totalCount: number;
  pageSize: number;
  pages: CorpusManifestPage[];
  createdAt: string;
  sourceSessionId: string;
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
