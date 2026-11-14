// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L13-vfs-api.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_vfs::vfs::handlers::AttachmentConfigOutput */
export type AttachmentConfigOutput = {
  attachmentRootFolderId: string | null;
  attachmentRootFolderTitle: string | null;
};
/** dstu_vfs::dstu::types::BatchMoveRequest */
export type BatchMoveRequest = {
  itemIds: string[];
  targetFolderId?: string | null;
};
/** dstu_vfs::dstu::types::BatchMoveResult */
export type BatchMoveResult = {
  successes: ResourceLocation[];
  failedItems: FailedMoveItem[];
  totalCount: number;
};
/** dstu_vfs::dstu::folder_handlers::BreadcrumbItem */
export type BreadcrumbItem = {
  id: string;
  name: string;
};
/** dstu_vfs::vfs::handlers::ClearMediaCacheParams */
export type ClearMediaCacheParams = {
  clearPdfPreview: boolean;
  clearCompressedImages: boolean;
  clearOcrText: boolean;
  clearVectorIndex: boolean;
};
/** dstu_vfs::vfs::handlers::ClearMediaCacheResult */
export type ClearMediaCacheResult = {
  pdfPreviewCleared: number;
  compressedImagesCleared: number;
  ocrTextCleared: number;
  vectorIndexCleared: number;
  totalBytesFreed: number;
  filesReset: number;
};
/** dstu_vfs::vfs::handlers::ConsistencyCheck */
export type ConsistencyCheck = {
  checkName: string;
  passed: boolean;
  details: string;
};
/** dstu_core::resource_types::ContentBlock */
export type ContentBlock = {
  type: "text";
  text: string;
} | {
  type: "image";
  mediaType: string;
  base64: string;
};
/** dstu_vfs::vfs::handlers::CreateMindMapInput */
export type CreateMindMapInput = {
  title: string;
  description?: string | null;
  content?: string;
  defaultView?: string;
  theme?: string | null;
  folderId?: string | null;
};
/** dstu_vfs::vfs::handlers::CreateNoteInput */
export type CreateNoteInput = {
  title: string;
  content: string;
  tags?: string[];
};
/** dstu_vfs::vfs::todo_handlers::CreatePomodoroInput */
export type CreatePomodoroInput = {
  todoItemId?: string | null;
  startTime: string;
  endTime?: string | null;
  duration: number;
  actualDuration: number;
  type?: string;
  status?: string;
};
/** dstu_vfs::vfs::handlers::CreateResourceInput */
export type CreateResourceInput = {
  type: string;
  data: string;
  sourceId?: string | null;
  metadata?: VfsResourceMetadata__De | null;
};
/** dstu_vfs::vfs::todo_handlers::CreateTodoItemInput */
export type CreateTodoItemInput = {
  todoListId: string;
  title: string;
  description?: string | null;
  priority?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  reminder?: string | null;
  tags?: string[] | null;
  parentId?: string | null;
  attachments?: string[] | null;
  repeatJson?: string | null;
};
/** dstu_vfs::vfs::todo_handlers::CreateTodoListInput */
export type CreateTodoListInput = {
  title: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
};
/** dstu_vfs::vfs::handlers::DeleteDimensionResult */
export type DeleteDimensionResult = {
  deletedSegments: number;
  dimension: number;
  modality: string;
};
/** dstu_vfs::vfs::index_handlers::DeleteIndexResult */
export type DeleteIndexResult = {
  sqliteOk: boolean;
  lanceTextOk: boolean;
  lanceMmOk: boolean;
  warnings: string[];
  retryable: boolean;
};
/** dstu_vfs::vfs::index_service::DimensionStat */
export type DimensionStat = {
  dimension: number;
  modality: string;
  count: number;
};
/** dstu_vfs::vfs::handlers::DimensionStats */
export type DimensionStats = {
  dimension: number;
  modality: string;
  recordCount: number;
  actualCount: number;
};
/** dstu_vfs::dstu::types::DstuCreateOptions */
export type DstuCreateOptions = {
  type: DstuNodeType__De;
  name: string;
  content?: string | null;
  fileBase64?: string | null;
  stagedUploadId?: string | null;
  metadata?: unknown | null;
};
/** dstu_vfs::dstu::error::DstuError */
export type DstuError = {
  type: "InvalidPath";
  message: string;
} | {
  type: "MissingSegment";
  message: string;
} | {
  type: "InvalidNodeType";
  message: string;
} | {
  type: "NotFound";
  message: string;
} | {
  type: "AlreadyExists";
  message: string;
} | {
  type: "NotSupported";
  message: string;
} | {
  type: "PermissionDenied";
  message: string;
} | {
  type: "VfsError";
  message: string;
} | {
  type: "DatabaseError";
  message: string;
} | {
  type: "SerializationError";
  message: string;
} | {
  type: "IoError";
  message: string;
} | {
  type: "Internal";
  message: string;
};
/** dstu_vfs::dstu::export::DstuExportResult */
export type DstuExportResult = {
  payloadType: string;
  suggestedFilename: string;
  mimeType: string;
  content?: string | null;
  dataBase64?: string | null;
  tempPath?: string | null;
};
/** dstu_vfs::dstu::types::DstuListOptions */
export type DstuListOptions = {
  folderId?: string | null;
  typeFilter?: DstuNodeType__De | null;
  isFavorite?: boolean | null;
  recursive?: boolean | null;
  types?: DstuNodeType__De[] | null;
  search?: string | null;
  tags?: string[] | null;
  propFilters?: DstuPropFilter[] | null;
  sortBy?: string | null;
  sortOrder?: string | null;
  limit?: number | null;
  offset?: number | null;
};
/** dstu_vfs::dstu::types::DstuNodeType */
export type DstuNodeType__De = ("folder" | "note" | "textbook" | "exam" | "translation" | "essay" | "image" | "file" | "retrieval" | "mindmap") | {
  folder: null;
} | {
  note: null;
} | {
  textbook: null;
} | {
  exam: null;
} | {
  translation: null;
} | {
  essay: null;
} | {
  image: null;
} | {
  file: null;
} | {
  retrieval: null;
} | {
  mindmap: null;
};
/** dstu_vfs::dstu::types::DstuParsedPath */
export type DstuParsedPath = {
  fullPath: string;
  folderPath: string | null;
  resourceId: string | null;
  resourceType: string | null;
  isRoot: boolean;
  isVirtual: boolean;
};
/** dstu_vfs::dstu::types::DstuPropFilter */
export type DstuPropFilter = {
  key: string;
  value: string;
};
/** dstu_vfs::vfs::index_handlers::EmbeddingDimInfo */
export type EmbeddingDimInfo = {
  dimension: number;
  modality: string;
  lanceTableName: string;
  recordCount: number;
};
/** dstu_vfs::vfs::handlers::EmbeddingReadiness */
export type EmbeddingReadiness = {
  ready: boolean;
  modelConfigId: string | null;
  modelName: string | null;
  reason: string | null;
  vectorIndexAvailable: boolean;
};
/** dstu_vfs::dstu::types::FailedMoveItem */
export type FailedMoveItem = {
  itemId: string;
  error: string;
};
/** dstu_vfs::vfs::types::FolderResourceInfo */
export type FolderResourceInfo = {
  itemType: string;
  itemId: string;
  resourceId?: string | null;
  title: string;
  path: string;
  content?: string | null;
};
/** dstu_vfs::vfs::types::FolderResourcesResult */
export type FolderResourcesResult = {
  folderId: string;
  folderTitle: string;
  path: string;
  totalCount: number;
  resources: FolderResourceInfo[];
};
/** dstu_vfs::vfs::retrieval_planner::FusedRetrievalHit */
export type FusedRetrievalHit = {
  hit: RetrievalHit;
  rrfScore: number;
  normalizedScore?: number | null;
  rerankScore?: number | null;
  provenance: RetrievalHitProvenance[];
};
/** dstu_vfs::vfs::retrieval_planner::FusedRetrievalResult */
export type FusedRetrievalResult = {
  hits: FusedRetrievalHit[];
  failures: RetrievalRouteFailure[];
};
/** dstu_vfs::vfs::types::GetResourceRefsInput */
export type GetResourceRefsInput = {
  sourceIds: string[];
  includeFolderContents?: boolean;
  maxItems?: number;
};
/** dstu_vfs::vfs::handlers::IndexDiagnosticInfo */
export type IndexDiagnosticInfo = {
  timestamp: string;
  architectureVersion: string;
  totalResources: number;
  stateCounts: IndexStateCounts;
  sampleResources: ResourceDiagnostic[];
  allResources: ResourceDiagnostic[];
  unitsStats: UnitsStats;
  segmentsStats: SegmentsStats;
  dimensionsStats: DimensionStats[];
  consistencyChecks: ConsistencyCheck[];
};
/** dstu_llm::multimodal::types::IndexProgressEvent */
export type IndexProgressEvent = {
  sourceType: string;
  sourceId: string;
  phase: string;
  currentPage: number;
  totalPages: number;
  indexedPages: number;
  skippedPages: number;
  progressPercent: number;
  message: string;
};
/** dstu_vfs::vfs::repos::embedding_repo::IndexState */
export type IndexState = {
  state: string;
  hash: string | null;
  error: string | null;
  indexedAt: number | null;
  retryCount: number;
};
/** dstu_vfs::vfs::handlers::IndexStateCounts */
export type IndexStateCounts = {
  pending: number;
  indexing: number;
  indexed: number;
  failed: number;
  disabled: number;
  nullState: number;
};
/** dstu_vfs::vfs::handlers::IndexStatus */
export type IndexStatus = {
  queued: boolean;
  unitsCreated: number;
  message: string;
};
/** dstu_vfs::vfs::lance_store::LanceTableDiagnostic */
export type LanceTableDiagnostic = {
  tableName: string;
  dimension: number;
  rowCount: number;
  columns: string[];
  hasMetadataColumn: boolean;
  hasEmbeddingIdColumn: boolean;
  hasResourceIdColumn: boolean;
  hasTextColumn: boolean;
  sampleMetadata: (string | null)[];
  metadataWithPageIndex: number;
  metadataNullCount: number;
  schemaValid: boolean;
  issueDescription: string | null;
};
/** dstu_vfs::vfs::handlers::ListInput */
export type ListInput = {
  search?: string | null;
  limit?: number;
  offset?: number;
};
/** dstu_vfs::vfs::handlers::MediaCacheStats */
export type MediaCacheStats = {
  pdfPreviewCount: number;
  pdfPreviewSize: number;
  compressedImageCount: number;
  compressedImageSize: number;
  ocrTextCount: number;
  vectorIndexCount: number;
  vectorIndexSize: number;
  totalSize: number;
};
/** dstu_vfs::vfs::media_index::MediaTimeRange */
export type MediaTimeRange = {
  startMs: number;
  endMs: number;
};
/** dstu_vfs::vfs::todo_handlers::MoveTodoItemInput */
export type MoveTodoItemInput = {
  itemId: string;
  targetListId: string;
};
/** dstu_vfs::vfs::types::MultimodalContentBlock */
export type MultimodalContentBlock = {
  type: string;
  text?: string | null;
  mediaType?: string | null;
  base64?: string | null;
};
/** dstu_vfs::vfs::handlers::OcrPageInfo */
export type OcrPageInfo = {
  pageIndex: number;
  text: string;
  charCount: number;
  isFailed: boolean;
};
/** dstu_vfs::vfs::handlers::OcrStatus */
export type OcrStatus = {
  performed: boolean;
  skipReason?: string | null;
  successCount: number;
  failedCount: number;
  blobMissingCount: number;
  totalPages: number;
  allSuccess: boolean;
  message: string;
};
/** dstu_vfs::vfs::retrieval_planner::PlannedQueryDerivation */
export type PlannedQueryDerivation = {
  kind: QueryDerivationKind;
  conditionalOnImageEmbeddingMiss: boolean;
};
/** dstu_vfs::vfs::retrieval_planner::PlannedRetrievalRoute */
export type PlannedRetrievalRoute = {
  routeId: string;
  kind: RetrievalRouteKind;
  profileId: string | null;
  modelConfigId: string | null;
  expectedModelFingerprint?: string | null;
  dimension: number | null;
  modality: string;
  weight: number;
  fetchLimit: number;
  queryDerivation?: QueryDerivationProvenance | null;
};
/** dstu_vfs::vfs::types::PomodoroDailyStat */
export type PomodoroDailyStat = {
  date: string;
  completedCount: number;
  focusSeconds: number;
  interruptedCount: number;
};
/** dstu_vfs::vfs::repos::pomodoro_repo::PomodoroFocusDay */
export type PomodoroFocusDay = {
  date: string;
  focusSeconds: number;
  completedCount: number;
  interruptedCount: number;
};
/** dstu_vfs::vfs::types::PomodoroHourlyStat */
export type PomodoroHourlyStat = {
  hour: number;
  completedCount: number;
  focusSeconds: number;
};
/** dstu_vfs::vfs::types::PomodoroRecord */
export type PomodoroRecord = {
  id: string;
  todoItemId?: string | null;
  startTime: string;
  endTime?: string | null;
  duration: number;
  actualDuration: number;
  type: string;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  deletedAt?: string | null;
};
/** dstu_vfs::vfs::repos::pomodoro_repo::PomodoroStatsOverview */
export type PomodoroStatsOverview = {
  today: PomodoroTodayStats;
  streak: PomodoroStreakStats;
  daily: PomodoroDailyStat[];
  weekly: PomodoroWeeklyStat[];
};
/** dstu_vfs::vfs::types::PomodoroStreakStats */
export type PomodoroStreakStats = {
  currentStreakDays: number;
  longestStreakDays: number;
};
/** dstu_vfs::vfs::types::PomodoroTodayStats */
export type PomodoroTodayStats = {
  completedCount: number;
  totalFocusSeconds: number;
  interruptedCount: number;
  completedFocusSeconds: number;
};
/** dstu_vfs::vfs::repos::pomodoro_repo::PomodoroTodoFocusSummary */
export type PomodoroTodoFocusSummary = {
  todoItemId: string;
  todoTitle: string | null;
  totalFocusSeconds: number;
  completedCount: number;
  interruptedCount: number;
  firstFocusAt: string | null;
  lastFocusAt: string | null;
  daily: PomodoroFocusDay[];
};
/** dstu_vfs::vfs::types::PomodoroTodoStat */
export type PomodoroTodoStat = {
  todoItemId: string;
  todoTitle: string | null;
  completedCount: number;
  focusSeconds: number;
};
/** dstu_vfs::vfs::repos::pomodoro_repo::PomodoroWeeklyStat */
export type PomodoroWeeklyStat = {
  weekStart: string;
  completedCount: number;
  focusSeconds: number;
  interruptedCount: number;
  activeDays: number;
};
/** dstu_vfs::vfs::types::PreviewType */
export type PreviewType = "markdown" | "pdf" | "card" | "image" | "docx" | "xlsx" | "pptx" | "epub" | "text" | "audio" | "video" | "none";
/** dstu_vfs::vfs::pdf_processing_service::ProcessingStatus */
export type ProcessingStatus = {
  fileId: string;
  stage: string;
  progress: Shared.ProcessingProgress;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
};
/** dstu_vfs::vfs::unified_retriever::QueryDerivationAttempt */
export type QueryDerivationAttempt = {
  provenance: QueryDerivationProvenance;
  succeeded: boolean;
  derivedQuery?: string | null;
  error?: string | null;
  elapsedMs: number;
};
/** dstu_vfs::vfs::retrieval_planner::QueryDerivationKind */
export type QueryDerivationKind = "multimodal_observation" | "ocr";
/** dstu_vfs::vfs::retrieval_planner::QueryDerivationProvenance */
export type QueryDerivationProvenance = {
  kind: QueryDerivationKind;
  modelConfigId?: string | null;
};
/** dstu_vfs::vfs::retrieval_planner::QueryModality */
export type QueryModality = "text" | "image" | "mixed";
/** dstu_vfs::vfs::todo_handlers::ReorderItemsInput */
export type ReorderItemsInput = {
  listId: string;
  itemIds: string[];
  expectedUpdatedAt?: string | null;
};
/** dstu_vfs::vfs::todo_handlers::ReorderListsInput */
export type ReorderListsInput = {
  listIds: string[];
};
/** dstu_vfs::vfs::types::ResolvedResource */
export type ResolvedResource = {
  sourceId: string;
  resourceHash: string;
  type: VfsResourceType;
  name: string;
  path: string;
  content?: string | null;
  found: boolean;
  warning?: string | null;
  multimodalBlocks?: MultimodalContentBlock[] | null;
};
/** dstu_vfs::vfs::handlers::ResourceDiagnostic */
export type ResourceDiagnostic = {
  id: string;
  name: string | null;
  resourceType: string;
  storageMode: string;
  indexState: string | null;
  indexError: string | null;
  dataLen: number;
  hasOcrText: boolean;
  unitCount: number;
  segmentCount: number;
  unitTextState: string | null;
  unitMmState: string | null;
  textEmbeddingDim: number | null;
  textChunkCount: number | null;
  updatedAt: number;
};
/** dstu_vfs::vfs::handlers::ResourceIndexStatus */
export type ResourceIndexStatus = {
  resourceId: string;
  sourceId: string | null;
  resourceType: string;
  name: string;
  hasOcr: boolean;
  ocrCount: number;
  textIndexState: string;
  textIndexedAt: number | null;
  textIndexError: string | null;
  textChunkCount: number;
  nativeTextChunkCount: number;
  ocrTextChunkCount: number;
  textEmbeddingDim: number | null;
  textIndexSource: string | null;
  mmIndexState: string;
  mmIndexedPages: number;
  mmEmbeddingDim: number | null;
  mmIndexingMode: string | null;
  mmIndexError: string | null;
  modality: string | null;
  embeddingDim: number | null;
  updatedAt: number;
  isStale: boolean;
};
/** dstu_vfs::dstu::types::ResourceLocation */
export type ResourceLocation = {
  id: string;
  resourceType: string;
  folderId: string | null;
  folderPath: string;
  fullPath: string;
  hash: string | null;
};
/** dstu_vfs::vfs::handlers::ResourceOcrInfo */
export type ResourceOcrInfo = {
  resourceId: string;
  resourceType: string;
  hasOcr: boolean;
  ocrText: string | null;
  ocrTextLength: number;
  extractedText: string | null;
  extractedTextLength: number;
  activeSource: string;
  ocrPages: OcrPageInfo[] | null;
};
/** dstu_vfs::vfs::retrieval_planner::RetrievalHit */
export type RetrievalHit = {
  identity: RetrievalIdentity;
  embeddingId: string;
  text: string;
  title: string | null;
  resourceType: string | null;
  sourceId: string | null;
  folderId: string | null;
  blobHash: string | null;
  imageUrl: string | null;
  rawScore: number | null;
  metadata: unknown;
};
/** dstu_vfs::vfs::retrieval_planner::RetrievalHitProvenance */
export type RetrievalHitProvenance = {
  routeId: string;
  routeKind: RetrievalRouteKind;
  profileId: string | null;
  dimension: number | null;
  modality: string;
  rawRank: number;
  rawScore: number | null;
  routeWeight: number;
  rrfContribution: number;
  queryDerivation?: QueryDerivationProvenance | null;
};
/** dstu_vfs::vfs::retrieval_planner::RetrievalIdentity */
export type RetrievalIdentity = {
  resourceId: string;
  chunkIndex: number;
  pageIndex: number | null;
  timeRange?: MediaTimeRange | null;
};
/** dstu_vfs::vfs::retrieval_planner::RetrievalPlan */
export type RetrievalPlan = {
  queryModality: QueryModality;
  topK: number;
  routes: PlannedRetrievalRoute[];
  imageFallbackChain: PlannedQueryDerivation[];
  imageFallbackUnavailableReason?: string | null;
};
/** dstu_vfs::vfs::retrieval_planner::RetrievalRouteFailure */
export type RetrievalRouteFailure = {
  routeId: string;
  profileId: string | null;
  dimension: number | null;
  error: string;
  timedOut: boolean;
  queryDerivation?: QueryDerivationProvenance | null;
};
/** dstu_vfs::vfs::retrieval_planner::RetrievalRouteKind */
export type RetrievalRouteKind = "full_text" | "text_embedding" | "multimodal_text" | "multimodal_image";
/** dstu_vfs::vfs::handlers::SearchAllInput */
export type SearchAllInput = {
  query: string;
  types?: string[] | null;
  limit?: number;
  offset?: number;
};
/** dstu_vfs::vfs::handlers::SegmentsStats */
export type SegmentsStats = {
  totalCount: number;
  distinctUnits: number;
  textModalityCount: number;
  mmModalityCount: number;
  avgSegmentsPerUnit: number;
};
/** dstu_vfs::vfs::index_service::StateStats */
export type StateStats = {
  pending: number;
  indexing: number;
  indexed: number;
  failed: number;
  disabled: number;
};
/** dstu_vfs::vfs::types::StorageMode */
export type StorageMode = "inline" | "external";
/** dstu_vfs::vfs::repos::todo_repo::TagCountEntry */
export type TagCountEntry = {
  tag: string;
  count: number;
};
/** dstu_vfs::vfs::handlers::TextChunkInfo */
export type TextChunkInfo = {
  unitId: string;
  unitIndex: number;
  textContent: string | null;
  textSource: string | null;
  textState: string;
  textChunkCount: number;
  charCount: number;
};
/** dstu_vfs::vfs::types::TodoActiveSummary */
export type TodoActiveSummary = {
  todayItems: TodoSummaryItem[];
  overdueItems: TodoSummaryItem[];
  upcomingHighPriority: TodoSummaryItem[];
  stats: TodoStats;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoBatchIdsResult */
export type TodoBatchIdsResult = {
  affectedIds: string[];
  skippedIds: string[];
};
/** dstu_vfs::vfs::repos::todo_repo::TodoBatchItemsResult */
export type TodoBatchItemsResult = {
  items: VfsTodoItem[];
  skippedIds: string[];
};
/** dstu_vfs::vfs::repos::todo_repo::TodoCountsSnapshot */
export type TodoCountsSnapshot = {
  todayCount: number;
  upcomingCount: number;
  inboxCount: number;
  allPendingCount: number;
  perList: TodoListCount[];
};
/** dstu_vfs::vfs::repos::todo_repo::TodoDailyCompletionStat */
export type TodoDailyCompletionStat = {
  date: string;
  completedCount: number;
  createdCount: number;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoItemWithChildStats */
export type TodoItemWithChildStats = {
  id: string;
  todoListId: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  dueDate?: string | null;
  dueTime?: string | null;
  reminder?: string | null;
  tagsJson: string;
  sortOrder: number;
  parentId?: string | null;
  completedAt?: string | null;
  repeatJson?: string | null;
  attachmentsJson: string;
  estimatedPomodoros?: number | null;
  completedPomodoros?: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  subtaskCount: number;
  completedSubtaskCount: number;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoListCount */
export type TodoListCount = {
  listId: string;
  pendingCount: number;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoListDistributionStat */
export type TodoListDistributionStat = {
  listId: string;
  listTitle: string;
  pendingCount: number;
  completedCount: number;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoPriorityDistributionStat */
export type TodoPriorityDistributionStat = {
  priority: string;
  pendingCount: number;
};
/** dstu_vfs::vfs::types::TodoStats */
export type TodoStats = {
  totalPending: number;
  todayDue: number;
  overdueCount: number;
  todayCompleted: number;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoStatsOverview */
export type TodoStatsOverview = {
  totalPending: number;
  totalCompleted: number;
  completedToday: number;
  overdueCount: number;
  completionTrend: TodoDailyCompletionStat[];
  byList: TodoListDistributionStat[];
  byPriority: TodoPriorityDistributionStat[];
  byTag: TodoTagDistributionStat[];
};
/** dstu_vfs::vfs::types::TodoSummaryItem */
export type TodoSummaryItem = {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  dueTime: string | null;
  listTitle: string;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoTagDistributionStat */
export type TodoTagDistributionStat = {
  tag: string;
  pendingCount: number;
  completedCount: number;
};
/** dstu_vfs::vfs::repos::todo_repo::TodoTrashCounts */
export type TodoTrashCounts = {
  deletedItems: number;
  deletedLists: number;
};
/** dstu_vfs::vfs::unified_retriever::UnifiedRetrievalResponse */
export type UnifiedRetrievalResponse = {
  capabilitySnapshot: Shared.CapabilitySnapshot;
  plan: RetrievalPlan;
  result: FusedRetrievalResult;
  queryDerivations: QueryDerivationAttempt[];
};
/** dstu_vfs::vfs::index_service::UnitIndexStatus */
export type UnitIndexStatus = {
  unitId: string;
  resourceId: string;
  unitIndex: number;
  hasImage: boolean;
  hasText: boolean;
  textSource: string | null;
  textRequired: boolean;
  textState: string;
  textError: string | null;
  textChunkCount: number;
  textEmbeddingDim: number | null;
  mmRequired: boolean;
  mmState: string;
  mmError: string | null;
  mmEmbeddingDim: number | null;
  updatedAt: number;
};
/** dstu_vfs::vfs::handlers::UnitsStats */
export type UnitsStats = {
  totalCount: number;
  distinctResources: number;
  textPending: number;
  textIndexing: number;
  textIndexed: number;
  textFailed: number;
  textDisabled: number;
  mmPending: number;
  mmIndexing: number;
  mmIndexed: number;
  mmFailed: number;
  mmDisabled: number;
};
/** dstu_vfs::vfs::handlers::UpdateMindMapInput */
export type UpdateMindMapInput = {
  title?: string | null;
  description?: string | null;
  content?: string | null;
  defaultView?: string | null;
  theme?: string | null;
  settings?: unknown | null;
  expectedUpdatedAt?: string | null;
  versionSource?: string | null;
};
/** dstu_vfs::vfs::handlers::UpdateNoteInput */
export type UpdateNoteInput = {
  content: string;
  title?: string | null;
  tags?: string[] | null;
  expectedUpdatedAt?: string | null;
};
/** dstu_vfs::vfs::todo_handlers::UpdateTodoItemInput */
export type UpdateTodoItemInput = {
  id: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  reminder?: string | null;
  tags?: string[] | null;
  parentId?: string | null;
  attachments?: string[] | null;
  repeatJson?: string | null;
  estimatedPomodoros?: number | null;
  completedPomodoros?: number | null;
  expectedUpdatedAt?: string | null;
};
/** dstu_vfs::vfs::todo_handlers::UpdateTodoListInput */
export type UpdateTodoListInput = {
  id: string;
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
};
/** dstu_vfs::vfs::types::VfsAttachment */
export type VfsAttachment = {
  id: string;
  resourceId?: string | null;
  blobHash?: string | null;
  type: string;
  name: string;
  mimeType: string;
  size: number;
  contentHash: string;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  previewJson?: string | null;
  extractedText?: string | null;
  pageCount?: number | null;
  deletedAt?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsAttachmentContentResult */
export type VfsAttachmentContentResult = {
  content: string | null;
  found: boolean;
  error?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsBlobBase64Result */
export type VfsBlobBase64Result = {
  base64: string;
  mimeType: string;
  size: number;
};
/** dstu_vfs::vfs::types::VfsContextRefData */
export type VfsContextRefData = {
  refs: VfsResourceRef[];
  truncated: boolean;
  totalCount: number;
};
/** dstu_vfs::vfs::types::VfsCreateResourceResult */
export type VfsCreateResourceResult = {
  resourceId: string;
  hash: string;
  isNew: boolean;
};
/** dstu_vfs::vfs::indexing::VfsDimensionStat */
export type VfsDimensionStat = {
  dimension: number;
  modality: string;
  recordCount: number;
  tableName: string;
};
/** dstu_vfs::vfs::handlers::VfsDownloadPaperParams */
export type VfsDownloadPaperParams = {
  url: string;
  title: string;
  folderId?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsDownloadPaperResult */
export type VfsDownloadPaperResult = {
  success: boolean;
  fileId: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  error: string | null;
};
/** dstu_vfs::vfs::repos::embedding_dim_repo::VfsEmbeddingDim */
export type VfsEmbeddingDim = {
  dimension: number;
  modality: string;
  lanceTableName: string;
  recordCount: number;
  createdAt: number;
  lastUsedAt: number;
  modelConfigId: string | null;
  modelName: string | null;
  activeProfileId: string | null;
  modelFingerprint: string | null;
  embeddingProtocol: string;
  activeGeneration: number;
  annMetric: string;
  annIndexVersion: number;
};
/** dstu_vfs::vfs::repos::embedding_repo::VfsEmbeddingDimension */
export type VfsEmbeddingDimension = {
  dimension: number;
  modality: string;
  recordCount: number;
  lanceTableName: string;
  createdAt: number;
  lastUsedAt: number;
  modelConfigId: string | null;
  modelName: string | null;
};
/** dstu_vfs::vfs::indexing::VfsEmbeddingStats */
export type VfsEmbeddingStats = {
  totalEmbeddings: number;
  totalResourcesIndexed: number;
  dimensions: VfsDimensionStat[];
};
/** dstu_vfs::vfs::types::VfsEssay */
export type VfsEssay = {
  id: string;
  resourceId: string;
  title?: string | null;
  essayType?: string | null;
  gradingResult?: unknown | null;
  score?: number | null;
  sessionId?: string | null;
  roundNumber: number;
  gradeLevel?: string | null;
  customPrompt?: string | null;
  isFavorite: boolean;
  dimensionScores?: unknown | null;
  createdAt: string;
  updatedAt: string;
};
/** dstu_vfs::vfs::types::VfsExamSheet */
export type VfsExamSheet = {
  id: string;
  resourceId?: string | null;
  examName?: string | null;
  status: string;
  tempId: string;
  metadataJson: unknown;
  previewJson: unknown;
  linkedMistakeIds?: string[] | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
};
/** dstu_vfs::vfs::types::VfsFile */
export type VfsFile = {
  id: string;
  resourceId?: string | null;
  blobHash?: string | null;
  sha256: string;
  fileName: string;
  originalPath?: string | null;
  size: number;
  pageCount?: number | null;
  fileType: string;
  mimeType?: string | null;
  tags: string[];
  isFavorite: boolean;
  lastOpenedAt?: string | null;
  lastPage?: number | null;
  bookmarks: unknown[];
  coverKey?: string | null;
  extractedText?: string | null;
  previewJson?: string | null;
  ocrPagesJson?: string | null;
  description?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  processingStatus?: string | null;
  processingProgress?: string | null;
  processingError?: string | null;
  processingStartedAt?: number | null;
  processingCompletedAt?: number | null;
  compressedBlobHash?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsFileContentResult */
export type VfsFileContentResult = {
  content: string | null;
  found: boolean;
};
/** dstu_vfs::vfs::types::VfsListItem */
export type VfsListItem = {
  id: string;
  resourceId: string;
  type: VfsResourceType;
  title: string;
  previewType: PreviewType;
  createdAt: number;
  updatedAt?: number | null;
  metadata?: VfsResourceMetadata | null;
};
/** dstu_vfs::vfs::types::VfsMindMap */
export type VfsMindMap = {
  id: string;
  resourceId: string;
  title: string;
  description?: string | null;
  isFavorite: boolean;
  defaultView: string;
  theme?: string | null;
  settings?: unknown | null;
  createdAt: string;
  updatedAt: string;
  contentUpdatedAt: string;
  deletedAt?: string | null;
};
/** dstu_vfs::vfs::types::VfsMindMapVersion */
export type VfsMindMapVersion = {
  versionId: string;
  mindmapId: string;
  resourceId: string;
  title: string;
  label?: string | null;
  source?: string | null;
  createdAt: string;
};
/** dstu_vfs::vfs::handlers::VfsMultimodalIndexInput */
export type VfsMultimodalIndexInput = {
  resourceId: string;
  resourceType: string;
  folderId?: string | null;
  pages: VfsMultimodalIndexPageInput[];
};
/** dstu_vfs::vfs::handlers::VfsMultimodalIndexOutput */
export type VfsMultimodalIndexOutput = {
  indexedPages: number;
  dimension: number;
  failedPages: number[];
};
/** dstu_vfs::vfs::handlers::VfsMultimodalIndexPageInput */
export type VfsMultimodalIndexPageInput = {
  pageIndex: number;
  imageBase64?: string | null;
  imageMime?: string | null;
  textContent?: string | null;
  blobHash?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsMultimodalQueryMode */
export type VfsMultimodalQueryMode = ("text" | "image" | "mixed") | {
  text: null;
} | {
  image: null;
} | {
  mixed: null;
};
/** dstu_vfs::vfs::handlers::VfsMultimodalSearchInput */
export type VfsMultimodalSearchInput = {
  query?: string | null;
  queryText?: string | null;
  queryImageBase64?: string | null;
  queryImageMediaType?: string | null;
  queryMode?: VfsMultimodalQueryMode | null;
  topK?: number;
  folderIds?: string[] | null;
  resourceIds?: string[] | null;
  resourceTypes?: string[] | null;
};
/** dstu_vfs::vfs::handlers::VfsMultimodalSearchOutput */
export type VfsMultimodalSearchOutput = {
  embeddingId: string;
  resourceId: string;
  resourceType: string;
  pageIndex: number;
  textContent: string | null;
  blobHash: string | null;
  score: number;
  folderId: string | null;
  retrievalProvenance: unknown;
};
/** dstu_vfs::vfs::handlers::VfsRagSearchInput */
export type VfsRagSearchInput = {
  query: string;
  folderIds?: string[] | null;
  resourceTypes?: string[] | null;
  topK?: number;
  enableReranking?: boolean;
  modality?: string;
  enableCrossDimension?: boolean;
};
/** dstu_vfs::vfs::handlers::VfsRagSearchOutput */
export type VfsRagSearchOutput = {
  results: VfsSearchResult[];
  count: number;
  elapsedMs: number;
};
/** dstu_vfs::vfs::types::VfsResource */
export type VfsResource = {
  id: string;
  hash: string;
  type: VfsResourceType;
  sourceId?: string | null;
  sourceTable?: string | null;
  storageMode: StorageMode;
  data?: string | null;
  externalHash?: string | null;
  metadata?: VfsResourceMetadata | null;
  refCount: number;
  createdAt: number;
  updatedAt: number;
};
/** dstu_vfs::vfs::types::VfsResourceMetadata */
export type VfsResourceMetadata = {
  name?: string | null;
  title?: string | null;
  mimeType?: string | null;
  size?: number | null;
  source?: string | null;
  extra?: unknown | null;
};
/** dstu_vfs::vfs::types::VfsResourceMetadata */
export type VfsResourceMetadata__De = {
  name?: string | null;
  title?: string | null;
  mimeType?: string | null;
  size?: number | null;
  source?: string | null;
  extra?: unknown | null;
};
/** dstu_vfs::vfs::types::VfsResourceRef */
export type VfsResourceRef = {
  sourceId: string;
  resourceHash: string;
  type: VfsResourceType;
  name: string;
  resourceId?: string | null;
  snippet?: string | null;
  injectModes?: Shared.ResourceInjectModes | null;
};
/** dstu_vfs::vfs::types::VfsResourceRef */
export type VfsResourceRef__De = {
  sourceId: string;
  resourceHash: string;
  type: VfsResourceType__De;
  name: string;
  resourceId?: string | null;
  snippet?: string | null;
  injectModes?: Shared.ResourceInjectModes__De | null;
};
/** dstu_vfs::vfs::types::VfsResourceType */
export type VfsResourceType = "note" | "textbook" | "exam" | "translation" | "essay" | "image" | "file" | "retrieval" | "mindmap" | "insightcard";
/** dstu_vfs::vfs::types::VfsResourceType */
export type VfsResourceType__De = ("note" | "textbook" | "exam" | "translation" | "essay" | "image" | "file" | "retrieval" | "mindmap" | "insightcard") | {
  note: null;
} | {
  textbook: null;
} | {
  exam: null;
} | {
  translation: null;
} | {
  essay: null;
} | {
  image: null;
} | {
  file: null;
} | {
  retrieval: null;
} | {
  mindmap: null;
} | {
  insightcard: null;
};
/** dstu_vfs::vfs::indexing::VfsSearchParams */
export type VfsSearchParams = {
  query: string;
  folderIds?: string[] | null;
  resourceIds?: string[] | null;
  resourceTypes?: string[] | null;
  modality?: string;
  topK?: number;
};
/** dstu_vfs::vfs::indexing::VfsSearchResult */
export type VfsSearchResult = {
  embeddingId: string;
  resourceId: string;
  chunkIndex: number;
  chunkText: string;
  score: number;
  resourceTitle?: string | null;
  resourceType?: string | null;
  pageIndex?: number | null;
  sourceId?: string | null;
};
/** dstu_vfs::vfs::types::VfsTextbook */
export type VfsTextbook = {
  id: string;
  resourceId?: string | null;
  blobHash?: string | null;
  sha256: string;
  fileName: string;
  originalPath?: string | null;
  size: number;
  pageCount?: number | null;
  tags: string[];
  isFavorite: boolean;
  lastOpenedAt?: string | null;
  lastPage?: number | null;
  bookmarks: unknown[];
  highlights: unknown[];
  coverKey?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};
/** dstu_vfs::vfs::types::VfsTodoItem */
export type VfsTodoItem = {
  id: string;
  todoListId: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  dueDate?: string | null;
  dueTime?: string | null;
  reminder?: string | null;
  tagsJson: string;
  sortOrder: number;
  parentId?: string | null;
  completedAt?: string | null;
  repeatJson?: string | null;
  attachmentsJson: string;
  estimatedPomodoros?: number | null;
  completedPomodoros?: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};
/** dstu_vfs::vfs::types::VfsTodoList */
export type VfsTodoList = {
  id: string;
  title: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  sortOrder: number;
  isDefault: boolean;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};
/** dstu_vfs::vfs::types::VfsTranslation */
export type VfsTranslation = {
  id: string;
  resourceId: string;
  title?: string | null;
  srcLang: string;
  tgtLang: string;
  engine?: string | null;
  model?: string | null;
  isFavorite: boolean;
  qualityRating?: number | null;
  createdAt: string;
  updatedAt?: string | null;
  metadata?: unknown | null;
  sourceText?: string | null;
  translatedText?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsUploadAttachmentParamsExt */
export type VfsUploadAttachmentParamsExt = {
  name: string;
  mimeType: string;
  base64Content?: string;
  stagedUploadId?: string | null;
  attachmentType?: string | null;
  folderId?: string | null;
};
/** dstu_vfs::vfs::types::VfsUploadAttachmentResult */
export type VfsUploadAttachmentResult = {
  sourceId: string;
  resourceHash: string;
  isNew: boolean;
  attachment: VfsAttachment;
  processingStatus?: string | null;
  processingPercent?: number | null;
  readyModes?: string[] | null;
  contentKind?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsUploadFileParams */
export type VfsUploadFileParams = {
  name: string;
  mimeType: string;
  base64Content: string;
  fileType?: string | null;
  folderId?: string | null;
};
/** dstu_vfs::vfs::handlers::VfsUploadFileResult */
export type VfsUploadFileResult = {
  file: VfsFile;
  sourceId: string;
  resourceHash: string;
  isNew: boolean;
  ocrStatus?: OcrStatus | null;
  indexStatus?: IndexStatus | null;
};
/** dstu_vfs::vfs::handlers::BatchIndexResult */
export type dstu_vfs__vfs__handlers__BatchIndexResult = {
  successCount: number;
  failCount: number;
  total: number;
};
/** dstu_vfs::vfs::handlers::IndexStatusSummary */
export type dstu_vfs__vfs__handlers__IndexStatusSummary = {
  totalResources: number;
  indexedCount: number;
  pendingCount: number;
  indexingCount: number;
  failedCount: number;
  disabledCount: number;
  staleCount: number;
  mmTotalResources: number;
  mmIndexedCount: number;
  mmPendingCount: number;
  mmIndexingCount: number;
  mmFailedCount: number;
  mmDisabledCount: number;
  resources: ResourceIndexStatus[];
};
/** dstu_vfs::vfs::index_handlers::BatchIndexResult */
export type dstu_vfs__vfs__index_handlers__BatchIndexResult = {
  successCount: number;
  failCount: number;
  total: number;
};
/** dstu_vfs::vfs::index_service::IndexStatusSummary */
export type dstu_vfs__vfs__index_service__IndexStatusSummary = {
  totalUnits: number;
  textStats: StateStats;
  mmStats: StateStats;
  dimensions: DimensionStat[];
};

export interface Commands {
  /** crates/dstu-vfs/src/dstu/handlers.rs:6297 `dstu_batch_move` */
  dstu_batch_move: {
    args: {
      request: BatchMoveRequest;
    };
    result: BatchMoveResult;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5929 `dstu_build_path` */
  dstu_build_path: {
    args: {
      folderId?: string | null;
      resourceId: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:2243 `dstu_copy` */
  dstu_copy: {
    args: {
      src: string;
      dst: string;
    };
    result: Shared.DstuNode;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:726 `dstu_create` */
  dstu_create: {
    args: {
      path: string;
      options: DstuCreateOptions;
    };
    result: Shared.DstuNode;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:1663 `dstu_delete` */
  dstu_delete: {
    args: {
      path: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5264 `dstu_delete_many` */
  dstu_delete_many: {
    args: {
      paths: string[];
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/trash_handlers.rs:641 `dstu_empty_trash` */
  dstu_empty_trash: {
    args: {
      itemTypes?: string[] | null;
    };
    result: number;
    error: DstuError;
  };
  /** crates/dstu-vfs/src/dstu/export/mod.rs:303 `dstu_export` */
  dstu_export: {
    args: {
      path: string;
      format: string;
    };
    result: DstuExportResult;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/export/mod.rs:275 `dstu_export_formats` */
  dstu_export_formats: {
    args: {
      path: string;
    };
    result: string[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:471 `dstu_folder_add_item` */
  dstu_folder_add_item: {
    args: {
      folderId?: string | null;
      itemType: string;
      itemId: string;
    };
    result: Shared.VfsFolderItem;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:135 `dstu_folder_create` */
  dstu_folder_create: {
    args: {
      title: string;
      parentId?: string | null;
      icon?: string | null;
      color?: string | null;
    };
    result: Shared.VfsFolder;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:336 `dstu_folder_delete` */
  dstu_folder_delete: {
    args: {
      folderId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:233 `dstu_folder_get` */
  dstu_folder_get: {
    args: {
      folderId: string;
    };
    result: Shared.VfsFolder | null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:762 `dstu_folder_get_all_resources` */
  dstu_folder_get_all_resources: {
    args: {
      folderId: string;
      includeSubfolders: boolean;
      includeContent: boolean;
    };
    result: FolderResourcesResult;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:910 `dstu_folder_get_breadcrumbs` */
  dstu_folder_get_breadcrumbs: {
    args: {
      folderId: string;
    };
    result: BreadcrumbItem[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:704 `dstu_folder_get_items` */
  dstu_folder_get_items: {
    args: {
      folderId?: string | null;
    };
    result: Shared.VfsFolderItem[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:669 `dstu_folder_get_tree` */
  dstu_folder_get_tree: {
    args: Record<string, never>;
    result: Shared.FolderTreeNode[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:637 `dstu_folder_list` */
  dstu_folder_list: {
    args: Record<string, never>;
    result: Shared.VfsFolder[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:382 `dstu_folder_move` */
  dstu_folder_move: {
    args: {
      folderId: string;
      newParentId?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:588 `dstu_folder_move_item` */
  dstu_folder_move_item: {
    args: {
      itemType: string;
      itemId: string;
      newFolderId?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:553 `dstu_folder_remove_item` */
  dstu_folder_remove_item: {
    args: {
      itemType: string;
      itemId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:273 `dstu_folder_rename` */
  dstu_folder_rename: {
    args: {
      folderId: string;
      title: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:817 `dstu_folder_reorder` */
  dstu_folder_reorder: {
    args: {
      folderIds: string[];
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:858 `dstu_folder_reorder_items` */
  dstu_folder_reorder_items: {
    args: {
      folderId?: string | null;
      itemIds: string[];
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/folder_handlers.rs:424 `dstu_folder_set_expanded` */
  dstu_folder_set_expanded: {
    args: {
      folderId: string;
      isExpanded: boolean;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:467 `dstu_get` */
  dstu_get: {
    args: {
      path: string;
    };
    result: Shared.DstuNode | null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:3289 `dstu_get_content` */
  dstu_get_content: {
    args: {
      path: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:3323 `dstu_get_exam_content` */
  dstu_get_exam_content: {
    args: {
      examId: string;
      isMultimodal: boolean;
    };
    result: ContentBlock[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:6625 `dstu_get_path_by_id` */
  dstu_get_path_by_id: {
    args: {
      resourceId: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:6042 `dstu_get_resource_by_path` */
  dstu_get_resource_by_path: {
    args: {
      path: string;
    };
    result: Shared.DstuNode | null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5973 `dstu_get_resource_location` */
  dstu_get_resource_location: {
    args: {
      resourceId: string;
    };
    result: ResourceLocation;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:171 `dstu_list` */
  dstu_list: {
    args: {
      path: string;
      options?: DstuListOptions | null;
    };
    result: Shared.DstuNode[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:4857 `dstu_list_deleted` */
  dstu_list_deleted: {
    args: {
      resourceType: string;
      limit?: number | null;
      offset?: number | null;
    };
    result: Shared.DstuNode[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/trash_handlers.rs:237 `dstu_list_trash` */
  dstu_list_trash: {
    args: {
      limit?: number | null;
      offset?: number | null;
      itemTypes?: string[] | null;
    };
    result: Shared.DstuNode[];
    error: DstuError;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:1770 `dstu_move` */
  dstu_move: {
    args: {
      src: string;
      dst: string;
    };
    result: Shared.DstuNode;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5530 `dstu_move_many` */
  dstu_move_many: {
    args: {
      paths: string[];
      destFolder: string;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:6137 `dstu_move_to_folder` */
  dstu_move_to_folder: {
    args: {
      resourceId: string;
      targetFolderId?: string | null;
    };
    result: ResourceLocation;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5851 `dstu_parse_path` */
  dstu_parse_path: {
    args: {
      path: string;
    };
    result: DstuParsedPath;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/trash_handlers.rs:798 `dstu_permanently_delete` */
  dstu_permanently_delete: {
    args: {
      id: string;
      itemType: string;
    };
    result: null;
    error: DstuError;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:4459 `dstu_purge` */
  dstu_purge: {
    args: {
      path: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5141 `dstu_purge_all` */
  dstu_purge_all: {
    args: {
      resourceType: string;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:6516 `dstu_refresh_path_cache` */
  dstu_refresh_path_cache: {
    args: {
      resourceId?: string | null;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:1879 `dstu_rename` */
  dstu_rename: {
    args: {
      path: string;
      newName: string;
    };
    result: Shared.DstuNode;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:4234 `dstu_restore` */
  dstu_restore: {
    args: {
      path: string;
    };
    result: Shared.DstuNode;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5427 `dstu_restore_many` */
  dstu_restore_many: {
    args: {
      paths: string[];
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:3269 `dstu_search` */
  dstu_search: {
    args: {
      query: string;
      options?: DstuListOptions | null;
    };
    result: Shared.DstuNode[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5654 `dstu_search_in_folder` */
  dstu_search_in_folder: {
    args: {
      folderId?: string | null;
      query: string;
      options?: DstuListOptions | null;
    };
    result: Shared.DstuNode[];
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:4554 `dstu_set_favorite` */
  dstu_set_favorite: {
    args: {
      path: string;
      favorite: boolean;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:3348 `dstu_set_metadata` */
  dstu_set_metadata: {
    args: {
      path: string;
      metadata: unknown;
      expectedUpdatedAt?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/trash_handlers.rs:113 `dstu_soft_delete` */
  dstu_soft_delete: {
    args: {
      id: string;
      itemType: string;
    };
    result: null;
    error: DstuError;
  };
  /** crates/dstu-vfs/src/dstu/trash_handlers.rs:180 `dstu_trash_restore` */
  dstu_trash_restore: {
    args: {
      id: string;
      itemType: string;
    };
    result: null;
    error: DstuError;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5634 `dstu_unwatch` */
  dstu_unwatch: {
    args: {
      path: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:1438 `dstu_update` */
  dstu_update: {
    args: {
      path: string;
      content: string;
      resourceType: string;
      expectedUpdatedAtMs?: number | null;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: Shared.DstuNode;
    error: string;
  };
  /** crates/dstu-vfs/src/dstu/handlers.rs:5627 `dstu_watch` */
  dstu_watch: {
    args: {
      path: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/file_stream_protocol.rs:718 `filestream_check_access` */
  filestream_check_access: {
    args: {
      path: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:1175 `pomodoro_create_record` */
  pomodoro_create_record: {
    args: {
      input: CreatePomodoroInput;
    };
    result: PomodoroRecord;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:1247 `pomodoro_daily_stats` */
  pomodoro_daily_stats: {
    args: {
      days?: number | null;
    };
    result: PomodoroDailyStat[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:23 `pomodoro_delete_record` */
  pomodoro_delete_record: {
    args: {
      recordId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:1204 `pomodoro_get_record` */
  pomodoro_get_record: {
    args: {
      recordId: string;
    };
    result: PomodoroRecord | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:77 `pomodoro_hourly_stats` */
  pomodoro_hourly_stats: {
    args: {
      days?: number | null;
    };
    result: PomodoroHourlyStat[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:1216 `pomodoro_list_by_todo` */
  pomodoro_list_by_todo: {
    args: {
      todoItemId: string;
    };
    result: PomodoroRecord[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:48 `pomodoro_list_range` */
  pomodoro_list_range: {
    args: {
      startDate: string;
      endDate: string;
    };
    result: PomodoroRecord[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:1237 `pomodoro_list_today` */
  pomodoro_list_today: {
    args: Record<string, never>;
    result: PomodoroRecord[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:93 `pomodoro_stats_by_todo` */
  pomodoro_stats_by_todo: {
    args: {
      startDate?: string | null;
      endDate?: string | null;
      limit?: number | null;
    };
    result: PomodoroTodoStat[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:117 `pomodoro_stats_overview` */
  pomodoro_stats_overview: {
    args: {
      days?: number | null;
    };
    result: PomodoroStatsOverview;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:65 `pomodoro_streak` */
  pomodoro_streak: {
    args: Record<string, never>;
    result: PomodoroStreakStats;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:1228 `pomodoro_today_stats` */
  pomodoro_today_stats: {
    args: Record<string, never>;
    result: PomodoroTodayStats;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:132 `pomodoro_todo_focus_summary` */
  pomodoro_todo_focus_summary: {
    args: {
      todoItemId: string;
    };
    result: PomodoroTodoFocusSummary;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:1007 `todo_ai_breakdown` */
  todo_ai_breakdown: {
    args: {
      itemId: string;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:750 `todo_batch_complete` */
  todo_batch_complete: {
    args: {
      itemIds: string[];
    };
    result: TodoBatchItemsResult;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:831 `todo_batch_delete` */
  todo_batch_delete: {
    args: {
      itemIds: string[];
    };
    result: TodoBatchIdsResult;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:811 `todo_batch_move` */
  todo_batch_move: {
    args: {
      itemIds: string[];
      targetListId: string;
    };
    result: TodoBatchItemsResult;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:868 `todo_batch_purge` */
  todo_batch_purge: {
    args: {
      itemIds: string[];
    };
    result: TodoBatchIdsResult;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:769 `todo_batch_reschedule` */
  todo_batch_reschedule: {
    args: {
      itemIds: string[];
      dueDate?: string | null;
      dueTime?: string | null;
    };
    result: TodoBatchItemsResult;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:849 `todo_batch_restore` */
  todo_batch_restore: {
    args: {
      itemIds: string[];
    };
    result: TodoBatchItemsResult;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:791 `todo_batch_set_priority` */
  todo_batch_set_priority: {
    args: {
      itemIds: string[];
      priority: string;
    };
    result: TodoBatchItemsResult;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:730 `todo_counts_snapshot` */
  todo_counts_snapshot: {
    args: Record<string, never>;
    result: TodoCountsSnapshot;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:452 `todo_create_item` */
  todo_create_item: {
    args: {
      input: CreateTodoItemInput;
    };
    result: VfsTodoItem;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:231 `todo_create_list` */
  todo_create_list: {
    args: {
      input: CreateTodoListInput;
    };
    result: VfsTodoList;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:564 `todo_delete_item` */
  todo_delete_item: {
    args: {
      itemId: string;
    };
    result: null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:293 `todo_delete_list` */
  todo_delete_list: {
    args: {
      listId: string;
    };
    result: null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:317 `todo_ensure_inbox` */
  todo_ensure_inbox: {
    args: {
      title?: string | null;
    };
    result: VfsTodoList;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:717 `todo_get_active_summary` */
  todo_get_active_summary: {
    args: Record<string, never>;
    result: TodoActiveSummary | null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:480 `todo_get_item` */
  todo_get_item: {
    args: {
      itemId: string;
    };
    result: VfsTodoItem | null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:254 `todo_get_list` */
  todo_get_list: {
    args: {
      listId: string;
    };
    result: VfsTodoList | null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:669 `todo_list_all_pending` */
  todo_list_all_pending: {
    args: Record<string, never>;
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:916 `todo_list_all_tags` */
  todo_list_all_tags: {
    args: Record<string, never>;
    result: TagCountEntry[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:679 `todo_list_completed` */
  todo_list_completed: {
    args: {
      listId?: string | null;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:408 `todo_list_deleted_items` */
  todo_list_deleted_items: {
    args: {
      limit?: number | null;
      offset?: number | null;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:344 `todo_list_deleted_lists` */
  todo_list_deleted_lists: {
    args: {
      limit?: number | null;
      offset?: number | null;
    };
    result: VfsTodoList[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:492 `todo_list_items` */
  todo_list_items: {
    args: {
      listId: string;
      includeCompleted: boolean;
      limit?: number | null;
      offset?: number | null;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:927 `todo_list_items_with_stats` */
  todo_list_items_with_stats: {
    args: {
      listId: string;
      includeCompleted: boolean;
      limit?: number | null;
      offset?: number | null;
    };
    result: TodoItemWithChildStats[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:263 `todo_list_lists` */
  todo_list_lists: {
    args: Record<string, never>;
    result: VfsTodoList[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:629 `todo_list_overdue` */
  todo_list_overdue: {
    args: {
      includeCompleted: boolean;
      limit?: number | null;
      offset?: number | null;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:659 `todo_list_reminders` */
  todo_list_reminders: {
    args: Record<string, never>;
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:612 `todo_list_today` */
  todo_list_today: {
    args: {
      includeCompleted: boolean;
      limit?: number | null;
      offset?: number | null;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:644 `todo_list_upcoming` */
  todo_list_upcoming: {
    args: {
      days: number;
      includeCompleted: boolean;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:594 `todo_move_item` */
  todo_move_item: {
    args: {
      input: MoveTodoItemInput;
    };
    result: VfsTodoItem;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:434 `todo_purge_deleted_items` */
  todo_purge_deleted_items: {
    args: Record<string, never>;
    result: number;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:382 `todo_purge_deleted_lists` */
  todo_purge_deleted_lists: {
    args: Record<string, never>;
    result: number;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:422 `todo_purge_item` */
  todo_purge_item: {
    args: {
      itemId: string;
    };
    result: null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:370 `todo_purge_list` */
  todo_purge_list: {
    args: {
      listId: string;
    };
    result: null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:576 `todo_reorder_items` */
  todo_reorder_items: {
    args: {
      input: ReorderItemsInput;
    };
    result: null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:328 `todo_reorder_lists` */
  todo_reorder_lists: {
    args: {
      input: ReorderListsInput;
    };
    result: null;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:396 `todo_restore_item` */
  todo_restore_item: {
    args: {
      itemId: string;
    };
    result: VfsTodoItem;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:358 `todo_restore_list` */
  todo_restore_list: {
    args: {
      listId: string;
    };
    result: VfsTodoList;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:696 `todo_search` */
  todo_search: {
    args: {
      query: string;
      limit?: number | null;
      offset?: number | null;
    };
    result: VfsTodoItem[];
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:901 `todo_stats_overview` */
  todo_stats_overview: {
    args: {
      days?: number | null;
    };
    result: TodoStatsOverview;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:547 `todo_toggle_item` */
  todo_toggle_item: {
    args: {
      itemId: string;
      expectedUpdatedAt?: string | null;
    };
    result: VfsTodoItem;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:305 `todo_toggle_list_favorite` */
  todo_toggle_list_favorite: {
    args: {
      listId: string;
    };
    result: VfsTodoList;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:886 `todo_trash_counts` */
  todo_trash_counts: {
    args: Record<string, never>;
    result: TodoTrashCounts;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:508 `todo_update_item` */
  todo_update_item: {
    args: {
      input: UpdateTodoItemInput;
    };
    result: VfsTodoItem;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/todo_handlers.rs:272 `todo_update_list` */
  todo_update_list: {
    args: {
      input: UpdateTodoListInput;
    };
    result: VfsTodoList;
    error: Shared.CommandError;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3398 `vfs_assign_dimension_model` */
  vfs_assign_dimension_model: {
    args: {
      dimension: number;
      modality: string;
      modelConfigId: string;
      modelName: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3859 `vfs_batch_index_pending` */
  vfs_batch_index_pending: {
    args: {
      batchSize?: number | null;
    };
    result: dstu_vfs__vfs__handlers__BatchIndexResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6533 `vfs_cancel_pdf_processing` */
  vfs_cancel_pdf_processing: {
    args: {
      fileId: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3817 `vfs_clear_default_embedding_dimension` */
  vfs_clear_default_embedding_dimension: {
    args: {
      modality: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6975 `vfs_clear_media_cache` */
  vfs_clear_media_cache: {
    args: {
      params: ClearMediaCacheParams;
    };
    result: ClearMediaCacheResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:7783 `vfs_clear_resource_ocr` */
  vfs_clear_resource_ocr: {
    args: {
      resourceId: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1679 `vfs_create_attachment_root_folder` */
  vfs_create_attachment_root_folder: {
    args: {
      title: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3495 `vfs_create_dimension` */
  vfs_create_dimension: {
    args: {
      dimension: number;
      modality: string;
      modelConfigId?: string | null;
      modelName?: string | null;
    };
    result: VfsEmbeddingDim;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5088 `vfs_create_mindmap` */
  vfs_create_mindmap: {
    args: {
      params: CreateMindMapInput;
    };
    result: VfsMindMap;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:460 `vfs_create_note` */
  vfs_create_note: {
    args: {
      params: CreateNoteInput;
    };
    result: Shared.VfsNote;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:300 `vfs_create_or_reuse` */
  vfs_create_or_reuse: {
    args: {
      params: CreateResourceInput;
    };
    result: VfsCreateResourceResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5472 `vfs_debug_index_status` */
  vfs_debug_index_status: {
    args: {
      resourceId?: string | null;
    };
    result: IndexDiagnosticInfo;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:430 `vfs_decrement_ref` */
  vfs_decrement_ref: {
    args: {
      resourceId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1964 `vfs_delete_attachment` */
  vfs_delete_attachment: {
    args: {
      attachmentId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3581 `vfs_delete_dimension` */
  vfs_delete_dimension: {
    args: {
      dimension: number;
      modality: string;
    };
    result: DeleteDimensionResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:2750 `vfs_delete_file` */
  vfs_delete_file: {
    args: {
      fileId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5302 `vfs_delete_mindmap` */
  vfs_delete_mindmap: {
    args: {
      mindmapId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:646 `vfs_delete_note` */
  vfs_delete_note: {
    args: {
      id: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/index_handlers.rs:201 `vfs_delete_resource_index` */
  vfs_delete_resource_index: {
    args: {
      resourceId: string;
    };
    result: DeleteIndexResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6472 `vfs_diagnose_lance_schema` */
  vfs_diagnose_lance_schema: {
    args: {
      modality?: string | null;
    };
    result: LanceTableDiagnostic[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:7340 `vfs_download_paper` */
  vfs_download_paper: {
    args: {
      params: VfsDownloadPaperParams;
    };
    result: VfsDownloadPaperResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:4225 `vfs_get_all_index_status` */
  vfs_get_all_index_status: {
    args: {
      folderId?: string | null;
      resourceType?: string | null;
      stateFilter?: string | null;
      limit?: number | null;
      offset?: number | null;
    };
    result: dstu_vfs__vfs__handlers__IndexStatusSummary;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1946 `vfs_get_attachment` */
  vfs_get_attachment: {
    args: {
      attachmentId: string;
    };
    result: VfsAttachment | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1648 `vfs_get_attachment_config` */
  vfs_get_attachment_config: {
    args: Record<string, never>;
    result: AttachmentConfigOutput;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1720 `vfs_get_attachment_content` */
  vfs_get_attachment_content: {
    args: {
      attachmentId: string;
      maxBytes?: number | null;
    };
    result: VfsAttachmentContentResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6628 `vfs_get_batch_pdf_processing_status` */
  vfs_get_batch_pdf_processing_status: {
    args: {
      fileIds: string[];
    };
    result: { [key: string]: ProcessingStatus };
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:2858 `vfs_get_blob_base64` */
  vfs_get_blob_base64: {
    args: {
      blobHash: string;
    };
    result: VfsBlobBase64Result;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3763 `vfs_get_default_embedding_dimension` */
  vfs_get_default_embedding_dimension: {
    args: {
      modality: string;
    };
    result: VfsEmbeddingDim | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3675 `vfs_get_dimension_range` */
  vfs_get_dimension_range: {
    args: Record<string, never>;
    result: [number, number];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:4198 `vfs_get_embedding_readiness` */
  vfs_get_embedding_readiness: {
    args: Record<string, never>;
    result: EmbeddingReadiness;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3318 `vfs_get_embedding_stats` */
  vfs_get_embedding_stats: {
    args: Record<string, never>;
    result: VfsEmbeddingStats;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:2714 `vfs_get_file` */
  vfs_get_file: {
    args: {
      fileId: string;
    };
    result: VfsFile | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:2782 `vfs_get_file_content` */
  vfs_get_file_content: {
    args: {
      fileId: string;
    };
    result: VfsFileContentResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3269 `vfs_get_index_status` */
  vfs_get_index_status: {
    args: {
      resourceId: string;
    };
    result: IndexState | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:4053 `vfs_get_indexing_config` */
  vfs_get_indexing_config: {
    args: {
      key: string;
    };
    result: string | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:4970 `vfs_get_lance_stats` */
  vfs_get_lance_stats: {
    args: {
      modality?: string | null;
    };
    result: [string, number][];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6813 `vfs_get_media_cache_stats` */
  vfs_get_media_cache_stats: {
    args: Record<string, never>;
    result: MediaCacheStats;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5115 `vfs_get_mindmap` */
  vfs_get_mindmap: {
    args: {
      mindmapId: string;
    };
    result: VfsMindMap | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5134 `vfs_get_mindmap_content` */
  vfs_get_mindmap_content: {
    args: {
      mindmapId: string;
    };
    result: string | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5231 `vfs_get_mindmap_version` */
  vfs_get_mindmap_version: {
    args: {
      versionId: string;
    };
    result: VfsMindMapVersion | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5209 `vfs_get_mindmap_version_content` */
  vfs_get_mindmap_version_content: {
    args: {
      versionId: string;
    };
    result: string | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5155 `vfs_get_mindmap_versions` */
  vfs_get_mindmap_versions: {
    args: {
      mindmapId: string;
      limit?: number | null;
    };
    result: VfsMindMapVersion[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:567 `vfs_get_note` */
  vfs_get_note: {
    args: {
      id: string;
    };
    result: Shared.VfsNote | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:592 `vfs_get_note_content` */
  vfs_get_note_content: {
    args: {
      id: string;
    };
    result: string | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1688 `vfs_get_or_create_attachment_root_folder` */
  vfs_get_or_create_attachment_root_folder: {
    args: Record<string, never>;
    result: string;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3105 `vfs_get_pdf_page_image` */
  vfs_get_pdf_page_image: {
    args: {
      resourceId: string;
      pageIndex: number;
    };
    result: VfsBlobBase64Result;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6504 `vfs_get_pdf_processing_status` */
  vfs_get_pdf_processing_status: {
    args: {
      fileId: string;
    };
    result: ProcessingStatus | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3353 `vfs_get_pending_resources` */
  vfs_get_pending_resources: {
    args: Record<string, never>;
    result: string[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3670 `vfs_get_preset_dimensions` */
  vfs_get_preset_dimensions: {
    args: Record<string, never>;
    result: number[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:355 `vfs_get_resource` */
  vfs_get_resource: {
    args: {
      resourceId: string;
    };
    result: VfsResource | null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:7621 `vfs_get_resource_ocr_info` */
  vfs_get_resource_ocr_info: {
    args: {
      resourceId: string;
    };
    result: ResourceOcrInfo;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1043 `vfs_get_resource_path` */
  vfs_get_resource_path: {
    args: {
      sourceId: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/ref_handlers.rs:243 `vfs_get_resource_ref_count` */
  vfs_get_resource_ref_count: {
    args: {
      sourceId: string;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/ref_handlers.rs:52 `vfs_get_resource_refs` */
  vfs_get_resource_refs: {
    args: {
      params: GetResourceRefsInput;
    };
    result: VfsContextRefData;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:7860 `vfs_get_resource_text_chunks` */
  vfs_get_resource_text_chunks: {
    args: {
      resourceId: string;
    };
    result: TextChunkInfo[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/index_handlers.rs:27 `vfs_get_resource_units` */
  vfs_get_resource_units: {
    args: {
      resourceId: string;
    };
    result: UnitIndexStatus[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:404 `vfs_increment_ref` */
  vfs_increment_ref: {
    args: {
      resourceId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6354 `vfs_inspect_retrieval_capabilities` */
  vfs_inspect_retrieval_capabilities: {
    args: Record<string, never>;
    result: Shared.CapabilitySnapshot;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3329 `vfs_list_dimensions` */
  vfs_list_dimensions: {
    args: Record<string, never>;
    result: VfsEmbeddingDimension[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/index_handlers.rs:287 `vfs_list_embedding_dims` */
  vfs_list_embedding_dims: {
    args: Record<string, never>;
    result: EmbeddingDimInfo[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:779 `vfs_list_essays` */
  vfs_list_essays: {
    args: {
      params?: ListInput | null;
    };
    result: VfsEssay[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:717 `vfs_list_exam_sheets` */
  vfs_list_exam_sheets: {
    args: {
      params?: ListInput | null;
    };
    result: VfsExamSheet[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:2728 `vfs_list_files` */
  vfs_list_files: {
    args: {
      fileType?: string | null;
      limit?: number | null;
      offset?: number | null;
    };
    result: VfsFile[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5321 `vfs_list_mindmaps` */
  vfs_list_mindmaps: {
    args: Record<string, never>;
    result: VfsMindMap[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:614 `vfs_list_notes` */
  vfs_list_notes: {
    args: {
      params?: ListInput | null;
    };
    result: Shared.VfsNote[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6685 `vfs_list_pending_pdf_processing` */
  vfs_list_pending_pdf_processing: {
    args: {
      limit?: number | null;
    };
    result: VfsFile[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:682 `vfs_list_textbooks` */
  vfs_list_textbooks: {
    args: {
      params?: ListInput | null;
    };
    result: VfsTextbook[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:747 `vfs_list_translations` */
  vfs_list_translations: {
    args: {
      params?: ListInput | null;
    };
    result: VfsTranslation[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6395 `vfs_multimodal_delete` */
  vfs_multimodal_delete: {
    args: {
      resourceId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6080 `vfs_multimodal_index` */
  vfs_multimodal_index: {
    args: {
      params: VfsMultimodalIndexInput;
    };
    result: VfsMultimodalIndexOutput;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6419 `vfs_multimodal_index_resource` */
  vfs_multimodal_index_resource: {
    args: {
      sourceType: string;
      sourceId: string;
      folderId?: string | null;
      forceRebuild?: boolean | null;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6295 `vfs_multimodal_search` */
  vfs_multimodal_search: {
    args: {
      params: VfsMultimodalSearchInput;
    };
    result: VfsMultimodalSearchOutput[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6337 `vfs_multimodal_search_detailed` */
  vfs_multimodal_search_detailed: {
    args: {
      params: VfsMultimodalSearchInput;
    };
    result: UnifiedRetrievalResponse;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6372 `vfs_multimodal_stats` */
  vfs_multimodal_stats: {
    args: Record<string, never>;
    result: unknown;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:4989 `vfs_optimize_lance` */
  vfs_optimize_lance: {
    args: {
      modality?: string | null;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:4889 `vfs_rag_search` */
  vfs_rag_search: {
    args: {
      input: VfsRagSearchInput;
    };
    result: VfsRagSearchOutput;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3153 `vfs_reindex_resource` */
  vfs_reindex_resource: {
    args: {
      resourceId: string;
      embeddingDim?: number | null;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/index_handlers.rs:39 `vfs_reindex_unit` */
  vfs_reindex_unit: {
    args: {
      unitId: string;
      mode: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5922 `vfs_reset_all_index_state` */
  vfs_reset_all_index_state: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5859 `vfs_reset_disabled_to_pending` */
  vfs_reset_disabled_to_pending: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5885 `vfs_reset_indexed_without_embeddings` */
  vfs_reset_indexed_without_embeddings: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/ref_handlers.rs:153 `vfs_resolve_resource_refs` */
  vfs_resolve_resource_refs: {
    args: {
      refs: VfsResourceRef__De[];
    };
    result: ResolvedResource[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:378 `vfs_resource_exists` */
  vfs_resource_exists: {
    args: {
      resourceId: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5187 `vfs_restore_mindmap_version` */
  vfs_restore_mindmap_version: {
    args: {
      versionId: string;
    };
    result: VfsMindMap;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6558 `vfs_retry_pdf_processing` */
  vfs_retry_pdf_processing: {
    args: {
      fileId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3132 `vfs_search` */
  vfs_search: {
    args: {
      params: VfsSearchParams;
    };
    result: VfsSearchResult[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:811 `vfs_search_all` */
  vfs_search_all: {
    args: {
      params: SearchAllInput;
    };
    result: VfsListItem[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1662 `vfs_set_attachment_root_folder` */
  vfs_set_attachment_root_folder: {
    args: {
      folderId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3693 `vfs_set_default_embedding_dimension` */
  vfs_set_default_embedding_dimension: {
    args: {
      dimension: number;
      modality: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:4043 `vfs_set_indexing_config` */
  vfs_set_indexing_config: {
    args: {
      key: string;
      value: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5331 `vfs_set_mindmap_favorite` */
  vfs_set_mindmap_favorite: {
    args: {
      mindmapId: string;
      isFavorite: boolean;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:6592 `vfs_start_pdf_processing` */
  vfs_start_pdf_processing: {
    args: {
      fileId: string;
      startFromStage?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/index_handlers.rs:164 `vfs_sync_resource_units` */
  vfs_sync_resource_units: {
    args: {
      resourceId: string;
      resourceType: string;
      data?: string | null;
      ocrText?: string | null;
      ocrPagesJson?: string | null;
      blobHash?: string | null;
      pageCount?: number | null;
      extractedText?: string | null;
      previewJson?: string | null;
    };
    result: UnitIndexStatus[];
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:3282 `vfs_toggle_index_disabled` */
  vfs_toggle_index_disabled: {
    args: {
      resourceId: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/index_handlers.rs:56 `vfs_unified_batch_index` */
  vfs_unified_batch_index: {
    args: {
      mode: string;
      batchSize?: number | null;
    };
    result: dstu_vfs__vfs__index_handlers__BatchIndexResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/index_handlers.rs:18 `vfs_unified_index_status` */
  vfs_unified_index_status: {
    args: Record<string, never>;
    result: dstu_vfs__vfs__index_service__IndexStatusSummary;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:5250 `vfs_update_mindmap` */
  vfs_update_mindmap: {
    args: {
      mindmapId: string;
      params: UpdateMindMapInput;
    };
    result: VfsMindMap;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:516 `vfs_update_note` */
  vfs_update_note: {
    args: {
      id: string;
      params: UpdateNoteInput;
    };
    result: Shared.VfsNote;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1143 `vfs_update_path_cache` */
  vfs_update_path_cache: {
    args: {
      folderId: string;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:1327 `vfs_upload_attachment` */
  vfs_upload_attachment: {
    args: {
      params: VfsUploadAttachmentParamsExt;
    };
    result: VfsUploadAttachmentResult;
    error: string;
  };
  /** crates/dstu-vfs/src/vfs/handlers.rs:2107 `vfs_upload_file` */
  vfs_upload_file: {
    args: {
      params: VfsUploadFileParams;
    };
    result: VfsUploadFileResult;
    error: string;
  };
}

export interface Events {
  "dstu:change": (Shared.DstuWatchEvent | {
    type: string;
    path: string;
  });
  [name: `dstu:change:${string}`]: (Shared.DstuWatchEvent | {
    type: string;
    path: string;
  });
  "mm_index_progress": IndexProgressEvent;
  "pdf-annotations:changed": {
    textbook_id: string;
    resource_path: string;
    kind: string;
    action: string;
    updated_at: string;
  } | {
    textbook_id: string;
    resource_path: string;
    kind: string;
    updated_at: string;
  };
  "todo://changed": {
    source: string;
    action: string;
    entityIds: string[];
    runId: string;
  } | {
    source: string;
    action: string;
    entityIds: string[];
  } | {
    source: string;
    action: string;
  };
  "vfs-index-progress": {
    type: string;
    resourceId: string;
    blockId: string;
    chunks: number;
    embeddingDim: number;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
    current: unknown /* x-unresolved: json! value `done` type not determinable statically */;
    total: unknown /* x-unresolved: json! value `total` type not determinable statically */;
    progress: number;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
    error: string;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
  } | {
    type: string;
    resourceId: string;
    chunkCount: number;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    chunkCount: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    chunksProcessed: number;
    chunksTotal: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    current: number;
    total: number;
    chunksProcessed: number;
    chunksTotal: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    error: string;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    error: string;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    currentPage: number;
    totalPages: number;
    successCount: number;
    percent: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    success: boolean;
    successCount: number;
    failCount: number;
    totalPages: number;
    textLength: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    success: boolean;
    successCount: number;
    failCount: number;
    totalPages: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    totalPages: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    message: string;
  } | {
    type: string;
    successCount: number;
    failCount: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    total: number;
    message: string;
  };
}

export type CommandName = keyof Commands;
export type DstuBatchMoveCommandArgs = Commands['dstu_batch_move']['args'];
export type DstuBatchMoveCommandResult = Commands['dstu_batch_move']['result'];
export type DstuBuildPathCommandArgs = Commands['dstu_build_path']['args'];
export type DstuBuildPathCommandResult = Commands['dstu_build_path']['result'];
export type DstuCopyCommandArgs = Commands['dstu_copy']['args'];
export type DstuCopyCommandResult = Commands['dstu_copy']['result'];
export type DstuCreateCommandArgs = Commands['dstu_create']['args'];
export type DstuCreateCommandResult = Commands['dstu_create']['result'];
export type DstuDeleteCommandArgs = Commands['dstu_delete']['args'];
export type DstuDeleteCommandResult = Commands['dstu_delete']['result'];
export type DstuDeleteManyCommandArgs = Commands['dstu_delete_many']['args'];
export type DstuDeleteManyCommandResult = Commands['dstu_delete_many']['result'];
export type DstuEmptyTrashCommandArgs = Commands['dstu_empty_trash']['args'];
export type DstuEmptyTrashCommandResult = Commands['dstu_empty_trash']['result'];
export type DstuExportCommandArgs = Commands['dstu_export']['args'];
export type DstuExportCommandResult = Commands['dstu_export']['result'];
export type DstuExportFormatsCommandArgs = Commands['dstu_export_formats']['args'];
export type DstuExportFormatsCommandResult = Commands['dstu_export_formats']['result'];
export type DstuFolderAddItemCommandArgs = Commands['dstu_folder_add_item']['args'];
export type DstuFolderAddItemCommandResult = Commands['dstu_folder_add_item']['result'];
export type DstuFolderCreateCommandArgs = Commands['dstu_folder_create']['args'];
export type DstuFolderCreateCommandResult = Commands['dstu_folder_create']['result'];
export type DstuFolderDeleteCommandArgs = Commands['dstu_folder_delete']['args'];
export type DstuFolderDeleteCommandResult = Commands['dstu_folder_delete']['result'];
export type DstuFolderGetCommandArgs = Commands['dstu_folder_get']['args'];
export type DstuFolderGetCommandResult = Commands['dstu_folder_get']['result'];
export type DstuFolderGetAllResourcesCommandArgs = Commands['dstu_folder_get_all_resources']['args'];
export type DstuFolderGetAllResourcesCommandResult = Commands['dstu_folder_get_all_resources']['result'];
export type DstuFolderGetBreadcrumbsCommandArgs = Commands['dstu_folder_get_breadcrumbs']['args'];
export type DstuFolderGetBreadcrumbsCommandResult = Commands['dstu_folder_get_breadcrumbs']['result'];
export type DstuFolderGetItemsCommandArgs = Commands['dstu_folder_get_items']['args'];
export type DstuFolderGetItemsCommandResult = Commands['dstu_folder_get_items']['result'];
export type DstuFolderGetTreeCommandArgs = Commands['dstu_folder_get_tree']['args'];
export type DstuFolderGetTreeCommandResult = Commands['dstu_folder_get_tree']['result'];
export type DstuFolderListCommandArgs = Commands['dstu_folder_list']['args'];
export type DstuFolderListCommandResult = Commands['dstu_folder_list']['result'];
export type DstuFolderMoveCommandArgs = Commands['dstu_folder_move']['args'];
export type DstuFolderMoveCommandResult = Commands['dstu_folder_move']['result'];
export type DstuFolderMoveItemCommandArgs = Commands['dstu_folder_move_item']['args'];
export type DstuFolderMoveItemCommandResult = Commands['dstu_folder_move_item']['result'];
export type DstuFolderRemoveItemCommandArgs = Commands['dstu_folder_remove_item']['args'];
export type DstuFolderRemoveItemCommandResult = Commands['dstu_folder_remove_item']['result'];
export type DstuFolderRenameCommandArgs = Commands['dstu_folder_rename']['args'];
export type DstuFolderRenameCommandResult = Commands['dstu_folder_rename']['result'];
export type DstuFolderReorderCommandArgs = Commands['dstu_folder_reorder']['args'];
export type DstuFolderReorderCommandResult = Commands['dstu_folder_reorder']['result'];
export type DstuFolderReorderItemsCommandArgs = Commands['dstu_folder_reorder_items']['args'];
export type DstuFolderReorderItemsCommandResult = Commands['dstu_folder_reorder_items']['result'];
export type DstuFolderSetExpandedCommandArgs = Commands['dstu_folder_set_expanded']['args'];
export type DstuFolderSetExpandedCommandResult = Commands['dstu_folder_set_expanded']['result'];
export type DstuGetCommandArgs = Commands['dstu_get']['args'];
export type DstuGetCommandResult = Commands['dstu_get']['result'];
export type DstuGetContentCommandArgs = Commands['dstu_get_content']['args'];
export type DstuGetContentCommandResult = Commands['dstu_get_content']['result'];
export type DstuGetExamContentCommandArgs = Commands['dstu_get_exam_content']['args'];
export type DstuGetExamContentCommandResult = Commands['dstu_get_exam_content']['result'];
export type DstuGetPathByIdCommandArgs = Commands['dstu_get_path_by_id']['args'];
export type DstuGetPathByIdCommandResult = Commands['dstu_get_path_by_id']['result'];
export type DstuGetResourceByPathCommandArgs = Commands['dstu_get_resource_by_path']['args'];
export type DstuGetResourceByPathCommandResult = Commands['dstu_get_resource_by_path']['result'];
export type DstuGetResourceLocationCommandArgs = Commands['dstu_get_resource_location']['args'];
export type DstuGetResourceLocationCommandResult = Commands['dstu_get_resource_location']['result'];
export type DstuListCommandArgs = Commands['dstu_list']['args'];
export type DstuListCommandResult = Commands['dstu_list']['result'];
export type DstuListDeletedCommandArgs = Commands['dstu_list_deleted']['args'];
export type DstuListDeletedCommandResult = Commands['dstu_list_deleted']['result'];
export type DstuListTrashCommandArgs = Commands['dstu_list_trash']['args'];
export type DstuListTrashCommandResult = Commands['dstu_list_trash']['result'];
export type DstuMoveCommandArgs = Commands['dstu_move']['args'];
export type DstuMoveCommandResult = Commands['dstu_move']['result'];
export type DstuMoveManyCommandArgs = Commands['dstu_move_many']['args'];
export type DstuMoveManyCommandResult = Commands['dstu_move_many']['result'];
export type DstuMoveToFolderCommandArgs = Commands['dstu_move_to_folder']['args'];
export type DstuMoveToFolderCommandResult = Commands['dstu_move_to_folder']['result'];
export type DstuParsePathCommandArgs = Commands['dstu_parse_path']['args'];
export type DstuParsePathCommandResult = Commands['dstu_parse_path']['result'];
export type DstuPermanentlyDeleteCommandArgs = Commands['dstu_permanently_delete']['args'];
export type DstuPermanentlyDeleteCommandResult = Commands['dstu_permanently_delete']['result'];
export type DstuPurgeCommandArgs = Commands['dstu_purge']['args'];
export type DstuPurgeCommandResult = Commands['dstu_purge']['result'];
export type DstuPurgeAllCommandArgs = Commands['dstu_purge_all']['args'];
export type DstuPurgeAllCommandResult = Commands['dstu_purge_all']['result'];
export type DstuRefreshPathCacheCommandArgs = Commands['dstu_refresh_path_cache']['args'];
export type DstuRefreshPathCacheCommandResult = Commands['dstu_refresh_path_cache']['result'];
export type DstuRenameCommandArgs = Commands['dstu_rename']['args'];
export type DstuRenameCommandResult = Commands['dstu_rename']['result'];
export type DstuRestoreCommandArgs = Commands['dstu_restore']['args'];
export type DstuRestoreCommandResult = Commands['dstu_restore']['result'];
export type DstuRestoreManyCommandArgs = Commands['dstu_restore_many']['args'];
export type DstuRestoreManyCommandResult = Commands['dstu_restore_many']['result'];
export type DstuSearchCommandArgs = Commands['dstu_search']['args'];
export type DstuSearchCommandResult = Commands['dstu_search']['result'];
export type DstuSearchInFolderCommandArgs = Commands['dstu_search_in_folder']['args'];
export type DstuSearchInFolderCommandResult = Commands['dstu_search_in_folder']['result'];
export type DstuSetFavoriteCommandArgs = Commands['dstu_set_favorite']['args'];
export type DstuSetFavoriteCommandResult = Commands['dstu_set_favorite']['result'];
export type DstuSetMetadataCommandArgs = Commands['dstu_set_metadata']['args'];
export type DstuSetMetadataCommandResult = Commands['dstu_set_metadata']['result'];
export type DstuSoftDeleteCommandArgs = Commands['dstu_soft_delete']['args'];
export type DstuSoftDeleteCommandResult = Commands['dstu_soft_delete']['result'];
export type DstuTrashRestoreCommandArgs = Commands['dstu_trash_restore']['args'];
export type DstuTrashRestoreCommandResult = Commands['dstu_trash_restore']['result'];
export type DstuUnwatchCommandArgs = Commands['dstu_unwatch']['args'];
export type DstuUnwatchCommandResult = Commands['dstu_unwatch']['result'];
export type DstuUpdateCommandArgs = Commands['dstu_update']['args'];
export type DstuUpdateCommandResult = Commands['dstu_update']['result'];
export type DstuWatchCommandArgs = Commands['dstu_watch']['args'];
export type DstuWatchCommandResult = Commands['dstu_watch']['result'];
export type FilestreamCheckAccessCommandArgs = Commands['filestream_check_access']['args'];
export type FilestreamCheckAccessCommandResult = Commands['filestream_check_access']['result'];
export type PomodoroCreateRecordCommandArgs = Commands['pomodoro_create_record']['args'];
export type PomodoroCreateRecordCommandResult = Commands['pomodoro_create_record']['result'];
export type PomodoroDailyStatsCommandArgs = Commands['pomodoro_daily_stats']['args'];
export type PomodoroDailyStatsCommandResult = Commands['pomodoro_daily_stats']['result'];
export type PomodoroDeleteRecordCommandArgs = Commands['pomodoro_delete_record']['args'];
export type PomodoroDeleteRecordCommandResult = Commands['pomodoro_delete_record']['result'];
export type PomodoroGetRecordCommandArgs = Commands['pomodoro_get_record']['args'];
export type PomodoroGetRecordCommandResult = Commands['pomodoro_get_record']['result'];
export type PomodoroHourlyStatsCommandArgs = Commands['pomodoro_hourly_stats']['args'];
export type PomodoroHourlyStatsCommandResult = Commands['pomodoro_hourly_stats']['result'];
export type PomodoroListByTodoCommandArgs = Commands['pomodoro_list_by_todo']['args'];
export type PomodoroListByTodoCommandResult = Commands['pomodoro_list_by_todo']['result'];
export type PomodoroListRangeCommandArgs = Commands['pomodoro_list_range']['args'];
export type PomodoroListRangeCommandResult = Commands['pomodoro_list_range']['result'];
export type PomodoroListTodayCommandArgs = Commands['pomodoro_list_today']['args'];
export type PomodoroListTodayCommandResult = Commands['pomodoro_list_today']['result'];
export type PomodoroStatsByTodoCommandArgs = Commands['pomodoro_stats_by_todo']['args'];
export type PomodoroStatsByTodoCommandResult = Commands['pomodoro_stats_by_todo']['result'];
export type PomodoroStatsOverviewCommandArgs = Commands['pomodoro_stats_overview']['args'];
export type PomodoroStatsOverviewCommandResult = Commands['pomodoro_stats_overview']['result'];
export type PomodoroStreakCommandArgs = Commands['pomodoro_streak']['args'];
export type PomodoroStreakCommandResult = Commands['pomodoro_streak']['result'];
export type PomodoroTodayStatsCommandArgs = Commands['pomodoro_today_stats']['args'];
export type PomodoroTodayStatsCommandResult = Commands['pomodoro_today_stats']['result'];
export type PomodoroTodoFocusSummaryCommandArgs = Commands['pomodoro_todo_focus_summary']['args'];
export type PomodoroTodoFocusSummaryCommandResult = Commands['pomodoro_todo_focus_summary']['result'];
export type TodoAiBreakdownCommandArgs = Commands['todo_ai_breakdown']['args'];
export type TodoAiBreakdownCommandResult = Commands['todo_ai_breakdown']['result'];
export type TodoBatchCompleteCommandArgs = Commands['todo_batch_complete']['args'];
export type TodoBatchCompleteCommandResult = Commands['todo_batch_complete']['result'];
export type TodoBatchDeleteCommandArgs = Commands['todo_batch_delete']['args'];
export type TodoBatchDeleteCommandResult = Commands['todo_batch_delete']['result'];
export type TodoBatchMoveCommandArgs = Commands['todo_batch_move']['args'];
export type TodoBatchMoveCommandResult = Commands['todo_batch_move']['result'];
export type TodoBatchPurgeCommandArgs = Commands['todo_batch_purge']['args'];
export type TodoBatchPurgeCommandResult = Commands['todo_batch_purge']['result'];
export type TodoBatchRescheduleCommandArgs = Commands['todo_batch_reschedule']['args'];
export type TodoBatchRescheduleCommandResult = Commands['todo_batch_reschedule']['result'];
export type TodoBatchRestoreCommandArgs = Commands['todo_batch_restore']['args'];
export type TodoBatchRestoreCommandResult = Commands['todo_batch_restore']['result'];
export type TodoBatchSetPriorityCommandArgs = Commands['todo_batch_set_priority']['args'];
export type TodoBatchSetPriorityCommandResult = Commands['todo_batch_set_priority']['result'];
export type TodoCountsSnapshotCommandArgs = Commands['todo_counts_snapshot']['args'];
export type TodoCountsSnapshotCommandResult = Commands['todo_counts_snapshot']['result'];
export type TodoCreateItemCommandArgs = Commands['todo_create_item']['args'];
export type TodoCreateItemCommandResult = Commands['todo_create_item']['result'];
export type TodoCreateListCommandArgs = Commands['todo_create_list']['args'];
export type TodoCreateListCommandResult = Commands['todo_create_list']['result'];
export type TodoDeleteItemCommandArgs = Commands['todo_delete_item']['args'];
export type TodoDeleteItemCommandResult = Commands['todo_delete_item']['result'];
export type TodoDeleteListCommandArgs = Commands['todo_delete_list']['args'];
export type TodoDeleteListCommandResult = Commands['todo_delete_list']['result'];
export type TodoEnsureInboxCommandArgs = Commands['todo_ensure_inbox']['args'];
export type TodoEnsureInboxCommandResult = Commands['todo_ensure_inbox']['result'];
export type TodoGetActiveSummaryCommandArgs = Commands['todo_get_active_summary']['args'];
export type TodoGetActiveSummaryCommandResult = Commands['todo_get_active_summary']['result'];
export type TodoGetItemCommandArgs = Commands['todo_get_item']['args'];
export type TodoGetItemCommandResult = Commands['todo_get_item']['result'];
export type TodoGetListCommandArgs = Commands['todo_get_list']['args'];
export type TodoGetListCommandResult = Commands['todo_get_list']['result'];
export type TodoListAllPendingCommandArgs = Commands['todo_list_all_pending']['args'];
export type TodoListAllPendingCommandResult = Commands['todo_list_all_pending']['result'];
export type TodoListAllTagsCommandArgs = Commands['todo_list_all_tags']['args'];
export type TodoListAllTagsCommandResult = Commands['todo_list_all_tags']['result'];
export type TodoListCompletedCommandArgs = Commands['todo_list_completed']['args'];
export type TodoListCompletedCommandResult = Commands['todo_list_completed']['result'];
export type TodoListDeletedItemsCommandArgs = Commands['todo_list_deleted_items']['args'];
export type TodoListDeletedItemsCommandResult = Commands['todo_list_deleted_items']['result'];
export type TodoListDeletedListsCommandArgs = Commands['todo_list_deleted_lists']['args'];
export type TodoListDeletedListsCommandResult = Commands['todo_list_deleted_lists']['result'];
export type TodoListItemsCommandArgs = Commands['todo_list_items']['args'];
export type TodoListItemsCommandResult = Commands['todo_list_items']['result'];
export type TodoListItemsWithStatsCommandArgs = Commands['todo_list_items_with_stats']['args'];
export type TodoListItemsWithStatsCommandResult = Commands['todo_list_items_with_stats']['result'];
export type TodoListListsCommandArgs = Commands['todo_list_lists']['args'];
export type TodoListListsCommandResult = Commands['todo_list_lists']['result'];
export type TodoListOverdueCommandArgs = Commands['todo_list_overdue']['args'];
export type TodoListOverdueCommandResult = Commands['todo_list_overdue']['result'];
export type TodoListRemindersCommandArgs = Commands['todo_list_reminders']['args'];
export type TodoListRemindersCommandResult = Commands['todo_list_reminders']['result'];
export type TodoListTodayCommandArgs = Commands['todo_list_today']['args'];
export type TodoListTodayCommandResult = Commands['todo_list_today']['result'];
export type TodoListUpcomingCommandArgs = Commands['todo_list_upcoming']['args'];
export type TodoListUpcomingCommandResult = Commands['todo_list_upcoming']['result'];
export type TodoMoveItemCommandArgs = Commands['todo_move_item']['args'];
export type TodoMoveItemCommandResult = Commands['todo_move_item']['result'];
export type TodoPurgeDeletedItemsCommandArgs = Commands['todo_purge_deleted_items']['args'];
export type TodoPurgeDeletedItemsCommandResult = Commands['todo_purge_deleted_items']['result'];
export type TodoPurgeDeletedListsCommandArgs = Commands['todo_purge_deleted_lists']['args'];
export type TodoPurgeDeletedListsCommandResult = Commands['todo_purge_deleted_lists']['result'];
export type TodoPurgeItemCommandArgs = Commands['todo_purge_item']['args'];
export type TodoPurgeItemCommandResult = Commands['todo_purge_item']['result'];
export type TodoPurgeListCommandArgs = Commands['todo_purge_list']['args'];
export type TodoPurgeListCommandResult = Commands['todo_purge_list']['result'];
export type TodoReorderItemsCommandArgs = Commands['todo_reorder_items']['args'];
export type TodoReorderItemsCommandResult = Commands['todo_reorder_items']['result'];
export type TodoReorderListsCommandArgs = Commands['todo_reorder_lists']['args'];
export type TodoReorderListsCommandResult = Commands['todo_reorder_lists']['result'];
export type TodoRestoreItemCommandArgs = Commands['todo_restore_item']['args'];
export type TodoRestoreItemCommandResult = Commands['todo_restore_item']['result'];
export type TodoRestoreListCommandArgs = Commands['todo_restore_list']['args'];
export type TodoRestoreListCommandResult = Commands['todo_restore_list']['result'];
export type TodoSearchCommandArgs = Commands['todo_search']['args'];
export type TodoSearchCommandResult = Commands['todo_search']['result'];
export type TodoStatsOverviewCommandArgs = Commands['todo_stats_overview']['args'];
export type TodoStatsOverviewCommandResult = Commands['todo_stats_overview']['result'];
export type TodoToggleItemCommandArgs = Commands['todo_toggle_item']['args'];
export type TodoToggleItemCommandResult = Commands['todo_toggle_item']['result'];
export type TodoToggleListFavoriteCommandArgs = Commands['todo_toggle_list_favorite']['args'];
export type TodoToggleListFavoriteCommandResult = Commands['todo_toggle_list_favorite']['result'];
export type TodoTrashCountsCommandArgs = Commands['todo_trash_counts']['args'];
export type TodoTrashCountsCommandResult = Commands['todo_trash_counts']['result'];
export type TodoUpdateItemCommandArgs = Commands['todo_update_item']['args'];
export type TodoUpdateItemCommandResult = Commands['todo_update_item']['result'];
export type TodoUpdateListCommandArgs = Commands['todo_update_list']['args'];
export type TodoUpdateListCommandResult = Commands['todo_update_list']['result'];
export type VfsAssignDimensionModelCommandArgs = Commands['vfs_assign_dimension_model']['args'];
export type VfsAssignDimensionModelCommandResult = Commands['vfs_assign_dimension_model']['result'];
export type VfsBatchIndexPendingCommandArgs = Commands['vfs_batch_index_pending']['args'];
export type VfsBatchIndexPendingCommandResult = Commands['vfs_batch_index_pending']['result'];
export type VfsCancelPdfProcessingCommandArgs = Commands['vfs_cancel_pdf_processing']['args'];
export type VfsCancelPdfProcessingCommandResult = Commands['vfs_cancel_pdf_processing']['result'];
export type VfsClearDefaultEmbeddingDimensionCommandArgs = Commands['vfs_clear_default_embedding_dimension']['args'];
export type VfsClearDefaultEmbeddingDimensionCommandResult = Commands['vfs_clear_default_embedding_dimension']['result'];
export type VfsClearMediaCacheCommandArgs = Commands['vfs_clear_media_cache']['args'];
export type VfsClearMediaCacheCommandResult = Commands['vfs_clear_media_cache']['result'];
export type VfsClearResourceOcrCommandArgs = Commands['vfs_clear_resource_ocr']['args'];
export type VfsClearResourceOcrCommandResult = Commands['vfs_clear_resource_ocr']['result'];
export type VfsCreateAttachmentRootFolderCommandArgs = Commands['vfs_create_attachment_root_folder']['args'];
export type VfsCreateAttachmentRootFolderCommandResult = Commands['vfs_create_attachment_root_folder']['result'];
export type VfsCreateDimensionCommandArgs = Commands['vfs_create_dimension']['args'];
export type VfsCreateDimensionCommandResult = Commands['vfs_create_dimension']['result'];
export type VfsCreateMindmapCommandArgs = Commands['vfs_create_mindmap']['args'];
export type VfsCreateMindmapCommandResult = Commands['vfs_create_mindmap']['result'];
export type VfsCreateNoteCommandArgs = Commands['vfs_create_note']['args'];
export type VfsCreateNoteCommandResult = Commands['vfs_create_note']['result'];
export type VfsCreateOrReuseCommandArgs = Commands['vfs_create_or_reuse']['args'];
export type VfsCreateOrReuseCommandResult = Commands['vfs_create_or_reuse']['result'];
export type VfsDebugIndexStatusCommandArgs = Commands['vfs_debug_index_status']['args'];
export type VfsDebugIndexStatusCommandResult = Commands['vfs_debug_index_status']['result'];
export type VfsDecrementRefCommandArgs = Commands['vfs_decrement_ref']['args'];
export type VfsDecrementRefCommandResult = Commands['vfs_decrement_ref']['result'];
export type VfsDeleteAttachmentCommandArgs = Commands['vfs_delete_attachment']['args'];
export type VfsDeleteAttachmentCommandResult = Commands['vfs_delete_attachment']['result'];
export type VfsDeleteDimensionCommandArgs = Commands['vfs_delete_dimension']['args'];
export type VfsDeleteDimensionCommandResult = Commands['vfs_delete_dimension']['result'];
export type VfsDeleteFileCommandArgs = Commands['vfs_delete_file']['args'];
export type VfsDeleteFileCommandResult = Commands['vfs_delete_file']['result'];
export type VfsDeleteMindmapCommandArgs = Commands['vfs_delete_mindmap']['args'];
export type VfsDeleteMindmapCommandResult = Commands['vfs_delete_mindmap']['result'];
export type VfsDeleteNoteCommandArgs = Commands['vfs_delete_note']['args'];
export type VfsDeleteNoteCommandResult = Commands['vfs_delete_note']['result'];
export type VfsDeleteResourceIndexCommandArgs = Commands['vfs_delete_resource_index']['args'];
export type VfsDeleteResourceIndexCommandResult = Commands['vfs_delete_resource_index']['result'];
export type VfsDiagnoseLanceSchemaCommandArgs = Commands['vfs_diagnose_lance_schema']['args'];
export type VfsDiagnoseLanceSchemaCommandResult = Commands['vfs_diagnose_lance_schema']['result'];
export type VfsDownloadPaperCommandArgs = Commands['vfs_download_paper']['args'];
export type VfsDownloadPaperCommandResult = Commands['vfs_download_paper']['result'];
export type VfsGetAllIndexStatusCommandArgs = Commands['vfs_get_all_index_status']['args'];
export type VfsGetAllIndexStatusCommandResult = Commands['vfs_get_all_index_status']['result'];
export type VfsGetAttachmentCommandArgs = Commands['vfs_get_attachment']['args'];
export type VfsGetAttachmentCommandResult = Commands['vfs_get_attachment']['result'];
export type VfsGetAttachmentConfigCommandArgs = Commands['vfs_get_attachment_config']['args'];
export type VfsGetAttachmentConfigCommandResult = Commands['vfs_get_attachment_config']['result'];
export type VfsGetAttachmentContentCommandArgs = Commands['vfs_get_attachment_content']['args'];
export type VfsGetAttachmentContentCommandResult = Commands['vfs_get_attachment_content']['result'];
export type VfsGetBatchPdfProcessingStatusCommandArgs = Commands['vfs_get_batch_pdf_processing_status']['args'];
export type VfsGetBatchPdfProcessingStatusCommandResult = Commands['vfs_get_batch_pdf_processing_status']['result'];
export type VfsGetBlobBase64CommandArgs = Commands['vfs_get_blob_base64']['args'];
export type VfsGetBlobBase64CommandResult = Commands['vfs_get_blob_base64']['result'];
export type VfsGetDefaultEmbeddingDimensionCommandArgs = Commands['vfs_get_default_embedding_dimension']['args'];
export type VfsGetDefaultEmbeddingDimensionCommandResult = Commands['vfs_get_default_embedding_dimension']['result'];
export type VfsGetDimensionRangeCommandArgs = Commands['vfs_get_dimension_range']['args'];
export type VfsGetDimensionRangeCommandResult = Commands['vfs_get_dimension_range']['result'];
export type VfsGetEmbeddingReadinessCommandArgs = Commands['vfs_get_embedding_readiness']['args'];
export type VfsGetEmbeddingReadinessCommandResult = Commands['vfs_get_embedding_readiness']['result'];
export type VfsGetEmbeddingStatsCommandArgs = Commands['vfs_get_embedding_stats']['args'];
export type VfsGetEmbeddingStatsCommandResult = Commands['vfs_get_embedding_stats']['result'];
export type VfsGetFileCommandArgs = Commands['vfs_get_file']['args'];
export type VfsGetFileCommandResult = Commands['vfs_get_file']['result'];
export type VfsGetFileContentCommandArgs = Commands['vfs_get_file_content']['args'];
export type VfsGetFileContentCommandResult = Commands['vfs_get_file_content']['result'];
export type VfsGetIndexStatusCommandArgs = Commands['vfs_get_index_status']['args'];
export type VfsGetIndexStatusCommandResult = Commands['vfs_get_index_status']['result'];
export type VfsGetIndexingConfigCommandArgs = Commands['vfs_get_indexing_config']['args'];
export type VfsGetIndexingConfigCommandResult = Commands['vfs_get_indexing_config']['result'];
export type VfsGetLanceStatsCommandArgs = Commands['vfs_get_lance_stats']['args'];
export type VfsGetLanceStatsCommandResult = Commands['vfs_get_lance_stats']['result'];
export type VfsGetMediaCacheStatsCommandArgs = Commands['vfs_get_media_cache_stats']['args'];
export type VfsGetMediaCacheStatsCommandResult = Commands['vfs_get_media_cache_stats']['result'];
export type VfsGetMindmapCommandArgs = Commands['vfs_get_mindmap']['args'];
export type VfsGetMindmapCommandResult = Commands['vfs_get_mindmap']['result'];
export type VfsGetMindmapContentCommandArgs = Commands['vfs_get_mindmap_content']['args'];
export type VfsGetMindmapContentCommandResult = Commands['vfs_get_mindmap_content']['result'];
export type VfsGetMindmapVersionCommandArgs = Commands['vfs_get_mindmap_version']['args'];
export type VfsGetMindmapVersionCommandResult = Commands['vfs_get_mindmap_version']['result'];
export type VfsGetMindmapVersionContentCommandArgs = Commands['vfs_get_mindmap_version_content']['args'];
export type VfsGetMindmapVersionContentCommandResult = Commands['vfs_get_mindmap_version_content']['result'];
export type VfsGetMindmapVersionsCommandArgs = Commands['vfs_get_mindmap_versions']['args'];
export type VfsGetMindmapVersionsCommandResult = Commands['vfs_get_mindmap_versions']['result'];
export type VfsGetNoteCommandArgs = Commands['vfs_get_note']['args'];
export type VfsGetNoteCommandResult = Commands['vfs_get_note']['result'];
export type VfsGetNoteContentCommandArgs = Commands['vfs_get_note_content']['args'];
export type VfsGetNoteContentCommandResult = Commands['vfs_get_note_content']['result'];
export type VfsGetOrCreateAttachmentRootFolderCommandArgs = Commands['vfs_get_or_create_attachment_root_folder']['args'];
export type VfsGetOrCreateAttachmentRootFolderCommandResult = Commands['vfs_get_or_create_attachment_root_folder']['result'];
export type VfsGetPdfPageImageCommandArgs = Commands['vfs_get_pdf_page_image']['args'];
export type VfsGetPdfPageImageCommandResult = Commands['vfs_get_pdf_page_image']['result'];
export type VfsGetPdfProcessingStatusCommandArgs = Commands['vfs_get_pdf_processing_status']['args'];
export type VfsGetPdfProcessingStatusCommandResult = Commands['vfs_get_pdf_processing_status']['result'];
export type VfsGetPendingResourcesCommandArgs = Commands['vfs_get_pending_resources']['args'];
export type VfsGetPendingResourcesCommandResult = Commands['vfs_get_pending_resources']['result'];
export type VfsGetPresetDimensionsCommandArgs = Commands['vfs_get_preset_dimensions']['args'];
export type VfsGetPresetDimensionsCommandResult = Commands['vfs_get_preset_dimensions']['result'];
export type VfsGetResourceCommandArgs = Commands['vfs_get_resource']['args'];
export type VfsGetResourceCommandResult = Commands['vfs_get_resource']['result'];
export type VfsGetResourceOcrInfoCommandArgs = Commands['vfs_get_resource_ocr_info']['args'];
export type VfsGetResourceOcrInfoCommandResult = Commands['vfs_get_resource_ocr_info']['result'];
export type VfsGetResourcePathCommandArgs = Commands['vfs_get_resource_path']['args'];
export type VfsGetResourcePathCommandResult = Commands['vfs_get_resource_path']['result'];
export type VfsGetResourceRefCountCommandArgs = Commands['vfs_get_resource_ref_count']['args'];
export type VfsGetResourceRefCountCommandResult = Commands['vfs_get_resource_ref_count']['result'];
export type VfsGetResourceRefsCommandArgs = Commands['vfs_get_resource_refs']['args'];
export type VfsGetResourceRefsCommandResult = Commands['vfs_get_resource_refs']['result'];
export type VfsGetResourceTextChunksCommandArgs = Commands['vfs_get_resource_text_chunks']['args'];
export type VfsGetResourceTextChunksCommandResult = Commands['vfs_get_resource_text_chunks']['result'];
export type VfsGetResourceUnitsCommandArgs = Commands['vfs_get_resource_units']['args'];
export type VfsGetResourceUnitsCommandResult = Commands['vfs_get_resource_units']['result'];
export type VfsIncrementRefCommandArgs = Commands['vfs_increment_ref']['args'];
export type VfsIncrementRefCommandResult = Commands['vfs_increment_ref']['result'];
export type VfsInspectRetrievalCapabilitiesCommandArgs = Commands['vfs_inspect_retrieval_capabilities']['args'];
export type VfsInspectRetrievalCapabilitiesCommandResult = Commands['vfs_inspect_retrieval_capabilities']['result'];
export type VfsListDimensionsCommandArgs = Commands['vfs_list_dimensions']['args'];
export type VfsListDimensionsCommandResult = Commands['vfs_list_dimensions']['result'];
export type VfsListEmbeddingDimsCommandArgs = Commands['vfs_list_embedding_dims']['args'];
export type VfsListEmbeddingDimsCommandResult = Commands['vfs_list_embedding_dims']['result'];
export type VfsListEssaysCommandArgs = Commands['vfs_list_essays']['args'];
export type VfsListEssaysCommandResult = Commands['vfs_list_essays']['result'];
export type VfsListExamSheetsCommandArgs = Commands['vfs_list_exam_sheets']['args'];
export type VfsListExamSheetsCommandResult = Commands['vfs_list_exam_sheets']['result'];
export type VfsListFilesCommandArgs = Commands['vfs_list_files']['args'];
export type VfsListFilesCommandResult = Commands['vfs_list_files']['result'];
export type VfsListMindmapsCommandArgs = Commands['vfs_list_mindmaps']['args'];
export type VfsListMindmapsCommandResult = Commands['vfs_list_mindmaps']['result'];
export type VfsListNotesCommandArgs = Commands['vfs_list_notes']['args'];
export type VfsListNotesCommandResult = Commands['vfs_list_notes']['result'];
export type VfsListPendingPdfProcessingCommandArgs = Commands['vfs_list_pending_pdf_processing']['args'];
export type VfsListPendingPdfProcessingCommandResult = Commands['vfs_list_pending_pdf_processing']['result'];
export type VfsListTextbooksCommandArgs = Commands['vfs_list_textbooks']['args'];
export type VfsListTextbooksCommandResult = Commands['vfs_list_textbooks']['result'];
export type VfsListTranslationsCommandArgs = Commands['vfs_list_translations']['args'];
export type VfsListTranslationsCommandResult = Commands['vfs_list_translations']['result'];
export type VfsMultimodalDeleteCommandArgs = Commands['vfs_multimodal_delete']['args'];
export type VfsMultimodalDeleteCommandResult = Commands['vfs_multimodal_delete']['result'];
export type VfsMultimodalIndexCommandArgs = Commands['vfs_multimodal_index']['args'];
export type VfsMultimodalIndexCommandResult = Commands['vfs_multimodal_index']['result'];
export type VfsMultimodalIndexResourceCommandArgs = Commands['vfs_multimodal_index_resource']['args'];
export type VfsMultimodalIndexResourceCommandResult = Commands['vfs_multimodal_index_resource']['result'];
export type VfsMultimodalSearchCommandArgs = Commands['vfs_multimodal_search']['args'];
export type VfsMultimodalSearchCommandResult = Commands['vfs_multimodal_search']['result'];
export type VfsMultimodalSearchDetailedCommandArgs = Commands['vfs_multimodal_search_detailed']['args'];
export type VfsMultimodalSearchDetailedCommandResult = Commands['vfs_multimodal_search_detailed']['result'];
export type VfsMultimodalStatsCommandArgs = Commands['vfs_multimodal_stats']['args'];
export type VfsMultimodalStatsCommandResult = Commands['vfs_multimodal_stats']['result'];
export type VfsOptimizeLanceCommandArgs = Commands['vfs_optimize_lance']['args'];
export type VfsOptimizeLanceCommandResult = Commands['vfs_optimize_lance']['result'];
export type VfsRagSearchCommandArgs = Commands['vfs_rag_search']['args'];
export type VfsRagSearchCommandResult = Commands['vfs_rag_search']['result'];
export type VfsReindexResourceCommandArgs = Commands['vfs_reindex_resource']['args'];
export type VfsReindexResourceCommandResult = Commands['vfs_reindex_resource']['result'];
export type VfsReindexUnitCommandArgs = Commands['vfs_reindex_unit']['args'];
export type VfsReindexUnitCommandResult = Commands['vfs_reindex_unit']['result'];
export type VfsResetAllIndexStateCommandArgs = Commands['vfs_reset_all_index_state']['args'];
export type VfsResetAllIndexStateCommandResult = Commands['vfs_reset_all_index_state']['result'];
export type VfsResetDisabledToPendingCommandArgs = Commands['vfs_reset_disabled_to_pending']['args'];
export type VfsResetDisabledToPendingCommandResult = Commands['vfs_reset_disabled_to_pending']['result'];
export type VfsResetIndexedWithoutEmbeddingsCommandArgs = Commands['vfs_reset_indexed_without_embeddings']['args'];
export type VfsResetIndexedWithoutEmbeddingsCommandResult = Commands['vfs_reset_indexed_without_embeddings']['result'];
export type VfsResolveResourceRefsCommandArgs = Commands['vfs_resolve_resource_refs']['args'];
export type VfsResolveResourceRefsCommandResult = Commands['vfs_resolve_resource_refs']['result'];
export type VfsResourceExistsCommandArgs = Commands['vfs_resource_exists']['args'];
export type VfsResourceExistsCommandResult = Commands['vfs_resource_exists']['result'];
export type VfsRestoreMindmapVersionCommandArgs = Commands['vfs_restore_mindmap_version']['args'];
export type VfsRestoreMindmapVersionCommandResult = Commands['vfs_restore_mindmap_version']['result'];
export type VfsRetryPdfProcessingCommandArgs = Commands['vfs_retry_pdf_processing']['args'];
export type VfsRetryPdfProcessingCommandResult = Commands['vfs_retry_pdf_processing']['result'];
export type VfsSearchCommandArgs = Commands['vfs_search']['args'];
export type VfsSearchCommandResult = Commands['vfs_search']['result'];
export type VfsSearchAllCommandArgs = Commands['vfs_search_all']['args'];
export type VfsSearchAllCommandResult = Commands['vfs_search_all']['result'];
export type VfsSetAttachmentRootFolderCommandArgs = Commands['vfs_set_attachment_root_folder']['args'];
export type VfsSetAttachmentRootFolderCommandResult = Commands['vfs_set_attachment_root_folder']['result'];
export type VfsSetDefaultEmbeddingDimensionCommandArgs = Commands['vfs_set_default_embedding_dimension']['args'];
export type VfsSetDefaultEmbeddingDimensionCommandResult = Commands['vfs_set_default_embedding_dimension']['result'];
export type VfsSetIndexingConfigCommandArgs = Commands['vfs_set_indexing_config']['args'];
export type VfsSetIndexingConfigCommandResult = Commands['vfs_set_indexing_config']['result'];
export type VfsSetMindmapFavoriteCommandArgs = Commands['vfs_set_mindmap_favorite']['args'];
export type VfsSetMindmapFavoriteCommandResult = Commands['vfs_set_mindmap_favorite']['result'];
export type VfsStartPdfProcessingCommandArgs = Commands['vfs_start_pdf_processing']['args'];
export type VfsStartPdfProcessingCommandResult = Commands['vfs_start_pdf_processing']['result'];
export type VfsSyncResourceUnitsCommandArgs = Commands['vfs_sync_resource_units']['args'];
export type VfsSyncResourceUnitsCommandResult = Commands['vfs_sync_resource_units']['result'];
export type VfsToggleIndexDisabledCommandArgs = Commands['vfs_toggle_index_disabled']['args'];
export type VfsToggleIndexDisabledCommandResult = Commands['vfs_toggle_index_disabled']['result'];
export type VfsUnifiedBatchIndexCommandArgs = Commands['vfs_unified_batch_index']['args'];
export type VfsUnifiedBatchIndexCommandResult = Commands['vfs_unified_batch_index']['result'];
export type VfsUnifiedIndexStatusCommandArgs = Commands['vfs_unified_index_status']['args'];
export type VfsUnifiedIndexStatusCommandResult = Commands['vfs_unified_index_status']['result'];
export type VfsUpdateMindmapCommandArgs = Commands['vfs_update_mindmap']['args'];
export type VfsUpdateMindmapCommandResult = Commands['vfs_update_mindmap']['result'];
export type VfsUpdateNoteCommandArgs = Commands['vfs_update_note']['args'];
export type VfsUpdateNoteCommandResult = Commands['vfs_update_note']['result'];
export type VfsUpdatePathCacheCommandArgs = Commands['vfs_update_path_cache']['args'];
export type VfsUpdatePathCacheCommandResult = Commands['vfs_update_path_cache']['result'];
export type VfsUploadAttachmentCommandArgs = Commands['vfs_upload_attachment']['args'];
export type VfsUploadAttachmentCommandResult = Commands['vfs_upload_attachment']['result'];
export type VfsUploadFileCommandArgs = Commands['vfs_upload_file']['args'];
export type VfsUploadFileCommandResult = Commands['vfs_upload_file']['result'];
