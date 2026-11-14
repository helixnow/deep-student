// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/_shared.json
/* eslint-disable */

/** dstu_core::models::AnkiCard */
export type AnkiCard = {
  front: string;
  back: string;
  text: string | null;
  tags: string[];
  images: string[];
  id: string;
  task_id: string;
  is_error_card: boolean;
  error_content: string | null;
  created_at: string;
  updated_at: string;
  extra_fields: { [key: string]: string };
  template_id: string | null;
};
/** dstu_core::models::AppError */
export type AppError = {
  error_type: AppErrorType;
  message: string;
  details: unknown | null;
};
/** dstu_core::models::AppErrorType */
export type AppErrorType = "Validation" | "Database" | "LLM" | "FileSystem" | "NotFound" | "Configuration" | "Network" | "Conflict" | "Unknown";
/** dstu_sync::backup_job_manager::BackupJobKind */
export type BackupJobKind = "export" | "import";
/** dstu_sync::backup_job_manager::BackupJobPhase */
export type BackupJobPhase = "queued" | "scan" | "checkpoint" | "compress" | "verify" | "extract" | "replace" | "cleanup" | "completed" | "failed" | "cancelled";
/** dstu_sync::backup_job_manager::BackupJobStatus */
export type BackupJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
/** dstu_vfs::vfs::retrieval_planner::CapabilitySnapshot */
export type CapabilitySnapshot = {
  textEmbedding: CapabilityState;
  multimodalEmbedding: CapabilityState;
  textModel: CapabilityState;
  multimodalModel: CapabilityState;
  ocr: CapabilityState;
};
/** dstu_vfs::vfs::retrieval_planner::CapabilityState */
export type CapabilityState = {
  configured: boolean;
  healthy: boolean;
  circuitOpen: boolean;
  protocolCompatible: boolean;
  indexCompatible: boolean;
  reason?: string | null;
};
/** dstu_sync::cloud_storage::config::CloudStorageConfig */
export type CloudStorageConfig = {
  provider?: StorageProvider;
  webdav?: WebDavConfig | null;
  s3?: S3Config | null;
  ftp?: FtpConfig | null;
  root?: string | null;
  encryptionPassword?: string | null;
};
/** dstu_security::secure_store::CloudStorageCredentials */
export type CloudStorageCredentials = {
  webdavPassword?: string | null;
  s3SecretAccessKey?: string | null;
  ftpPassword?: string | null;
  encryptionPassword?: string | null;
};
/** dstu_core::error_details::CommandError */
export type CommandError = {
  code: string;
  message: string;
  data?: unknown | null;
  traceId?: string | null;
};
/** dstu_core::resource_types::ContentBlock */
export type ContentBlock__De = {
  type: "text";
  text: string;
} | {
  type: "image";
  mediaType: string;
  base64: string;
};
/** dstu_core::task_objects::DerivedEdge */
export type DerivedEdge = {
  sourceHandleId: string;
  transformId: string;
  transformParamsHash?: string | null;
  observedAt: string;
};
/** dstu_core::models::DocumentTask */
export type DocumentTask = {
  id: string;
  document_id: string;
  original_document_name: string;
  segment_index: number;
  content_segment: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  anki_generation_options_json: string;
};
/** dstu_vfs::dstu::types::DstuNode */
export type DstuNode = {
  id: string;
  path: string;
  name: string;
  type: DstuNodeType;
  size?: number | null;
  createdAt: number;
  updatedAt: number;
  children?: DstuNode[] | null;
  childCount?: number | null;
  resourceId?: string | null;
  sourceId: string;
  resourceHash?: string | null;
  previewType?: string | null;
  metadata?: unknown | null;
};
/** dstu_vfs::dstu::types::DstuNodeType */
export type DstuNodeType = "folder" | "note" | "textbook" | "exam" | "translation" | "essay" | "image" | "file" | "retrieval" | "mindmap";
/** dstu_vfs::dstu::types::DstuWatchEvent */
export type DstuWatchEvent = {
  type: DstuWatchEventType;
  path: string;
  oldPath?: string | null;
  node?: DstuNode | null;
};
/** dstu_vfs::dstu::types::DstuWatchEventType */
export type DstuWatchEventType = "created" | "updated" | "deleted" | "moved" | "restored" | "purged";
/** dstu_core::models::ExamCardBBox */
export type ExamCardBBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
/** dstu_vfs::vfs::types::FolderTreeNode */
export type FolderTreeNode = {
  folder: VfsFolder;
  children: FolderTreeNode[];
  items: VfsFolderItem[];
};
/** dstu_sync::cloud_storage::config::FtpConfig */
export type FtpConfig = {
  host: string;
  port?: number;
  username: string;
  password: string;
  useTls?: boolean;
};
/** dstu_vfs::vfs::types::ImageInjectMode */
export type ImageInjectMode = "image" | "ocr";
/** dstu_vfs::vfs::types::ImageInjectMode */
export type ImageInjectMode__De = ("image" | "ocr") | {
  image: null;
} | {
  ocr: null;
};
/** dstu_sync::backup_job_manager::JobCheckpoint */
export type JobCheckpoint = {
  processed_items: string[];
  partial_output?: string | null;
  last_updated: string;
  current_index: number;
  total_items: number;
};
/** dstu_core::task_objects::ManagedLocator */
export type ManagedLocator = {
  rootId: string;
  relativePath: string;
};
/** dstu_agent::chat_v2::types::McpToolSchema */
export type McpToolSchema__De = {
  name: string;
  serverId?: string | null;
  description?: string | null;
  inputSchema?: unknown | null;
};
/** dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseAuth */
export type NoteLeaseAuth = {
  participant_id: string;
  token: string;
};
/** dstu_core::task_objects::ObjectAcl */
export type ObjectAcl = {
  access: string;
  ownerId?: string | null;
  principalIds?: string[];
  observedAt?: string | null;
};
/** dstu_core::task_objects::ObjectCapabilities */
export type ObjectCapabilities = {
  readable: boolean;
  materializable: boolean;
  writable: boolean;
  shareable: boolean;
  sendable: boolean;
  deletable: boolean;
};
/** dstu_core::task_objects::ObjectProvenance */
export type ObjectProvenance = {
  source: string;
  sourceUri?: string | null;
  server?: string | null;
  tool?: string | null;
  derivedFrom?: DerivedEdge[];
  observedAt: string;
};
/** dstu_vfs::vfs::types::PdfInjectMode */
export type PdfInjectMode = "text" | "ocr" | "image";
/** dstu_vfs::vfs::types::PdfInjectMode */
export type PdfInjectMode__De = ("text" | "ocr" | "image") | {
  text: null;
} | {
  ocr: null;
} | {
  image: null;
};
/** dstu_sync::backup_job_manager::PersistedJob */
export type PersistedJob = {
  job_id: string;
  kind: BackupJobKind;
  status: BackupJobStatus;
  phase: BackupJobPhase;
  progress: number;
  created_at: string;
  started_at?: string | null;
  params: unknown;
  checkpoint?: JobCheckpoint | null;
  error_message?: string | null;
};
/** dstu_vfs::vfs::pdf_processing_service::ProcessingIssue */
export type ProcessingIssue = {
  stage: string;
  message: string;
  retriable: boolean;
};
/** dstu_vfs::vfs::pdf_processing_service::ProcessingProgress */
export type ProcessingProgress = {
  stage: string;
  currentPage?: number | null;
  totalPages?: number | null;
  percent: number | null;
  readyModes: string[];
  mediaType?: string | null;
  failedStages?: ProcessingIssue[] | null;
};
/** dstu_core::task_objects::ProviderObjectRef */
export type ProviderObjectRef = {
  provider: string;
  externalId: string;
  containerId?: string | null;
  threadId?: string | null;
  version?: string | null;
  etag?: string | null;
};
/** dstu_agent::chat_v2::types::ReplayMode */
export type ReplayMode = ("original" | "current") | {
  original: null;
} | {
  current: null;
};
/** dstu_vfs::vfs::types::ResourceInjectModes */
export type ResourceInjectModes = {
  image?: ImageInjectMode[] | null;
  pdf?: PdfInjectMode[] | null;
};
/** dstu_vfs::vfs::types::ResourceInjectModes */
export type ResourceInjectModes__De = {
  image?: ImageInjectMode__De[] | null;
  pdf?: PdfInjectMode__De[] | null;
};
/** dstu_sync::cloud_storage::config::S3Config */
export type S3Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string | null;
  pathStyle?: boolean;
};
/** dstu_sync::cloud_config_commands::SafeCloudStorageConfig */
export type SafeCloudStorageConfig__De = {
  provider: "webdav";
  webdav: SafeWebDavConfig;
  root?: string | null;
  allow_insecure?: boolean;
} | {
  provider: "s3";
  s3: SafeS3Config__De;
  root?: string | null;
  allow_insecure?: boolean;
} | {
  provider: "ftp";
  ftp: SafeFtpConfig__De;
  root?: string | null;
  allow_insecure?: boolean;
};
/** dstu_sync::cloud_config_commands::SafeFtpConfig */
export type SafeFtpConfig__De = {
  host: string;
  port?: number;
  username: string;
  useTls?: boolean;
};
/** dstu_sync::cloud_config_commands::SafeS3Config */
export type SafeS3Config__De = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  region?: string | null;
  pathStyle?: boolean;
};
/** dstu_sync::cloud_config_commands::SafeWebDavConfig */
export type SafeWebDavConfig = {
  endpoint: string;
  username: string;
};
/** dstu_agent::chat_v2::resource_types::SendContextRef */
export type SendContextRef = {
  resourceId: string;
  hash: string;
  typeId: string;
  formattedBlocks: ContentBlock__De[];
  displayName?: string | null;
  injectModes?: ResourceInjectModes__De | null;
};
/** dstu_agent::chat_v2::types::SendOptions */
export type SendOptions = {
  modelId?: string | null;
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  contextLimit?: number | null;
  maxTokens?: number | null;
  enableThinking?: boolean | null;
  reasoningEffort?: string | null;
  thinkingBudget?: number | null;
  replayMode?: ReplayMode | null;
  skillStateVersion?: number | null;
  disableTools?: boolean | null;
  model2OverrideId?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  groupPinnedResourceIds?: string[] | null;
  ragEnabled?: boolean | null;
  ragLibraryIds?: string[] | null;
  ragTopK?: number | null;
  ragEnableReranking?: boolean | null;
  graphRagEnabled?: boolean | null;
  graphIds?: string[] | null;
  graphTopK?: number | null;
  memoryEnabled?: boolean | null;
  autoMemoryExtraction?: boolean | null;
  multimodalRagEnabled?: boolean | null;
  multimodalTopK?: number | null;
  multimodalEnableReranking?: boolean | null;
  multimodalLibraryIds?: string[] | null;
  mcpTools?: string[] | null;
  mcpToolSchemas?: McpToolSchema__De[] | null;
  maxToolRecursion?: number | null;
  webSearchEnabled?: boolean | null;
  searchEngines?: string[] | null;
  ankiEnabled?: boolean | null;
  ankiTemplateId?: string | null;
  ankiOptions?: unknown | null;
  systemPromptOverride?: string | null;
  systemPromptAppend?: string | null;
  skipUserMessageSave?: boolean | null;
  skipAssistantMessageSave?: boolean | null;
  parallelModelIds?: string[] | null;
  maxVariantsPerMessage?: number | null;
  canvasNoteId?: string | null;
  userContextRefs?: SendContextRef[] | null;
  schemaToolIds?: string[] | null;
  contextTypeHints?: string[] | null;
  activeSkillIds?: string[] | null;
  skillContents?: { [key: string]: string } | null;
  replaySkillContents?: { [key: string]: string } | null;
  skillDependencies?: { [key: string]: string[] } | null;
  skillEmbeddedTools?: { [key: string]: McpToolSchema__De[] } | null;
  skillAdmissionErrors?: { [key: string]: string } | null;
  skillPackageRoots?: { [key: string]: string } | null;
  isContinue?: boolean | null;
  continueVariantId?: string | null;
  visionQuality?: string | null;
};
/** dstu_sync::cloud_storage::config::StorageProvider */
export type StorageProvider = ("webdav" | "s3" | "ftp") | {
  webdav: null;
} | {
  s3: null;
} | {
  ftp: null;
};
/** dstu_core::task_objects::TaskObjectHandle */
export type TaskObjectHandle = {
  schemaVersion: number;
  handleId: string;
  kind: TaskObjectKind;
  displayName: string;
  mediaType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  locator?: ManagedLocator | null;
  providerRef?: ProviderObjectRef | null;
  acl?: ObjectAcl | null;
  capabilities: ObjectCapabilities;
  expiresAt?: string | null;
  provenance: ObjectProvenance;
};
/** dstu_core::task_objects::TaskObjectKind */
export type TaskObjectKind = "file" | "folder" | "message" | "event" | "record" | "page" | "artifact";
/** dstu_core::models::TaskStatus */
export type TaskStatus = "Pending" | "Processing" | "Streaming" | "Paused" | "Completed" | "Failed" | "Truncated" | "Cancelled";
/** dstu_vfs::vfs::types::VfsFolder */
export type VfsFolder = {
  id: string;
  parentId?: string | null;
  title: string;
  icon?: string | null;
  color?: string | null;
  isExpanded: boolean;
  isFavorite: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};
/** dstu_vfs::vfs::types::VfsFolderItem */
export type VfsFolderItem = {
  id: string;
  folderId?: string | null;
  itemType: string;
  itemId: string;
  sortOrder: number;
  createdAt: number;
  cachedPath?: string | null;
};
/** dstu_vfs::vfs::types::VfsNote */
export type VfsNote = {
  id: string;
  resourceId: string;
  title: string;
  tags: string[];
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  props?: unknown | null;
};
/** dstu_sync::cloud_storage::config::WebDavConfig */
export type WebDavConfig = {
  endpoint: string;
  username: string;
  password: string;
};
