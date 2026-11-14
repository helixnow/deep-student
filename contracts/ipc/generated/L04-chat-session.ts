// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L04-chat-session.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_vfs::vfs::retrieval_planner::ActiveGenerationModel */
export type ActiveGenerationModel = "text" | "multimodal";
/** dstu_agent::chat_v2::handlers::workspace_handlers::AgentCompletionEnvelope */
export type AgentCompletionEnvelope = {
  type: string;
  workspace_id: string;
  agent_session_id: string;
  parent_session_id?: string | null;
  task_id?: string | null;
  run_id: string;
  correlation_id?: string | null;
  status: AgentCompletionStatus;
  final_output?: string | null;
  error?: string | null;
  completed_at: string;
  token_usage?: TokenUsage | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::AgentCompletionStatus */
export type AgentCompletionStatus = "completed" | "failed" | "cancelled";
/** dstu_agent::chat_v2::handlers::workspace_handlers::AgentInfo */
export type AgentInfo = {
  session_id: string;
  role: string;
  status: string;
  skill_id: string | null;
  agent_profile_id: string | null;
  pending_inbox_count: number;
  joined_at: string;
  last_active_at: string;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::AgentProfileFileResponse */
export type AgentProfileFileResponse = {
  fileName: string;
  content: string;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::AgentProfileSummary */
export type AgentProfileSummary = {
  id: string;
  description: string | null;
  model: string | null;
  toolCount: number;
};
/** dstu_agent::chat_v2::types::AttachmentMeta */
export type AttachmentMeta = {
  id: string;
  name: string;
  type: string;
  mimeType: string;
  size: number;
  previewUrl?: string | null;
  status: string;
  error?: string | null;
};
/** dstu_agent::chat_v2::tools::attachment_stage_executor::AutoStageContextAttachmentFailure */
export type AutoStageContextAttachmentFailure = {
  resourceId: string;
  sourceId: string;
  error: string;
};
/** dstu_agent::chat_v2::tools::attachment_stage_executor::AutoStageContextAttachmentInput */
export type AutoStageContextAttachmentInput = {
  resourceId: string;
  sourceId: string;
  displayName: string;
};
/** dstu_agent::chat_v2::tools::attachment_stage_executor::AutoStageContextAttachmentsResult */
export type AutoStageContextAttachmentsResult = {
  expectedItems: number;
  observedItems: number;
  coverageComplete: boolean;
  truncated: boolean;
  attachments: AutoStagedContextAttachment[];
  failures: AutoStageContextAttachmentFailure[];
  corpusManifest?: CorpusManifestPayload | null;
};
/** dstu_agent::chat_v2::tools::attachment_stage_executor::AutoStagedContextAttachment */
export type AutoStagedContextAttachment = {
  resourceId: string;
  sourceId: string;
  rootId: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  reused: boolean;
  mediaType?: string | null;
  objectHandle: Shared.TaskObjectHandle;
};
/** dstu_agent::chat_v2::types::CanonicalContentPart */
export type CanonicalContentPart = {
  type: "text";
  text: string;
} | {
  type: "image_ref";
  image_id: string;
  name?: string | null;
  resource_id?: string | null;
  source_id?: string | null;
  blob_hash?: string | null;
  content_hash?: string | null;
  mime_type: string;
  pinned: boolean;
  retrieval_hit: boolean;
} | {
  type: "file_ref";
  deepseek_file_id?: string | null;
  deepseek_config_id?: string | null;
  file_id: string;
  resource_id?: string | null;
  blob_hash?: string | null;
  content_hash?: string | null;
  mime_type: string;
  name?: string | null;
} | {
  type: "citation_ref";
  citation_id: string;
  resource_id?: string | null;
  label?: string | null;
} | {
  type: "derived_artifact_ref";
  artifact_id: string;
  artifact_type: string;
  source_image_ids: string[];
  producer_model_id?: string | null;
  content: string;
  created_at: number;
};
/** dstu_agent::chat_v2::types::ChatGenerationPlan */
export type ChatGenerationPlan = {
  planner: GenerationPlan;
  auxiliaryMultimodalConfigId?: string | null;
  imageBudget: number;
  historyImageBudget: number;
};
/** dstu_agent::chat_v2::types::ChatMessage */
export type ChatMessage = {
  id: string;
  sessionId: string;
  role: MessageRole;
  blockIds: string[];
  timestamp: number;
  persistentStableId?: string | null;
  parentId?: string | null;
  supersedes?: string | null;
  _meta?: MessageMeta | null;
  attachments?: AttachmentMeta[] | null;
  activeVariantId?: string | null;
  variants?: Variant[] | null;
  sharedContext?: SharedContext | null;
};
/** dstu_agent::chat_v2::types::ChatParams */
export type ChatParams = {
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
  disableTools?: boolean | null;
  model2OverrideId?: string | null;
  ragTopK?: number | null;
  ragLibraryIds?: string[] | null;
  learnModePrompt?: string | null;
  selectedMcpServers?: string[] | null;
  selectedSearchEngines?: string[] | null;
  graphIds?: string[] | null;
  graphTopK?: number | null;
  modelDisplayName?: string | null;
  ragEnableReranking?: boolean | null;
  maxToolRecursion?: number | null;
  multimodalRagEnabled?: boolean | null;
  multimodalTopK?: number | null;
  multimodalEnableReranking?: boolean | null;
  multimodalLibraryIds?: string[] | null;
  visionQuality?: string | null;
};
/** dstu_agent::chat_v2::types::ChatParams */
export type ChatParams__De = {
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
  disableTools?: boolean | null;
  model2OverrideId?: string | null;
  ragTopK?: number | null;
  ragLibraryIds?: string[] | null;
  learnModePrompt?: string | null;
  selectedMcpServers?: string[] | null;
  selectedSearchEngines?: string[] | null;
  graphIds?: string[] | null;
  graphTopK?: number | null;
  modelDisplayName?: string | null;
  ragEnableReranking?: boolean | null;
  maxToolRecursion?: number | null;
  multimodalRagEnabled?: boolean | null;
  multimodalTopK?: number | null;
  multimodalEnableReranking?: boolean | null;
  multimodalLibraryIds?: string[] | null;
  visionQuality?: string | null;
};
/** dstu_agent::chat_v2::types::ChatSession */
export type ChatSession = {
  id: string;
  mode: string;
  title?: string | null;
  description?: string | null;
  summaryHash?: string | null;
  titleLocked: boolean;
  persistStatus: PersistStatus;
  createdAt: string;
  updatedAt: string;
  metadata?: unknown | null;
  groupId?: string | null;
  tagsHash?: string | null;
  tags?: string[] | null;
};
/** dstu_core::agent::Citation */
export type Citation = {
  type: string;
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  score?: number | null;
};
/** dstu_agent::chat_v2::handlers::block_actions::CompactSessionResponse */
export type CompactSessionResponse = {
  status: string;
  reason: string | null;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
};
/** dstu_agent::chat_v2::types::ContentSearchResult */
export type ContentSearchResult = {
  sessionId: string;
  sessionTitle: string | null;
  messageId: string;
  blockId: string;
  role: string;
  snippet: string;
  updatedAt: string;
};
/** dstu_agent::chat_v2::resource_types::ContextRef */
export type ContextRef = {
  resourceId: string;
  hash: string;
  typeId: string;
  displayName?: string | null;
  injectModes?: Shared.ResourceInjectModes | null;
};
/** dstu_agent::chat_v2::resource_types::ContextSnapshot */
export type ContextSnapshot = {
  userRefs?: ContextRef[];
  retrievalRefs?: ContextRef[];
  pathMap?: { [key: string]: string };
};
/** dstu_agent::chat_v2::handlers::block_actions::CopyBlockContentResponse */
export type CopyBlockContentResponse = {
  content: string;
  contentType: string;
};
/** dstu_core::task_objects::CorpusManifest */
export type CorpusManifest = {
  schemaVersion: number;
  manifestId: string;
  totalCount: number;
  pageSize: number;
  pages: CorpusManifestPage[];
  createdAt: string;
  sourceSessionId: string;
};
/** dstu_core::task_objects::CorpusManifestEntry */
export type CorpusManifestEntry = {
  handle: Shared.TaskObjectHandle;
  refCount: number;
};
/** dstu_core::task_objects::CorpusManifestPage */
export type CorpusManifestPage = {
  pageNo: number;
  objectHandles: CorpusManifestEntry[];
};
/** dstu_agent::chat_v2::tools::attachment_stage_executor::CorpusManifestPayload */
export type CorpusManifestPayload = {
  manifest: CorpusManifest;
  objectHandle: Shared.TaskObjectHandle;
  modelNotice: string;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::CreateAgentRequest */
export type CreateAgentRequest = {
  workspace_id: string;
  requester_session_id: string;
  skill_id?: string | null;
  role?: string | null;
  initial_task?: string | null;
  system_prompt?: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::CreateAgentResponse */
export type CreateAgentResponse = {
  agent_session_id: string;
  workspace_id: string;
  role: string;
  skill_id: string | null;
  status: string;
};
/** dstu_agent::chat_v2::types::CreateGroupRequest */
export type CreateGroupRequest = {
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  systemPrompt?: string | null;
  defaultSkillIds?: string[] | null;
  pinnedResourceIds?: string[] | null;
  workspaceId?: string | null;
  defaultRuntimeRootId?: string | null;
  preferredProjectRootPath?: string | null;
  rootFolderId?: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::CreateWorkspaceRequest */
export type CreateWorkspaceRequest = {
  name?: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::CreateWorkspaceResponse */
export type CreateWorkspaceResponse = {
  workspace_id: string;
  name: string | null;
  status: string;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::CustomAgentFileSummary */
export type CustomAgentFileSummary = {
  fileName: string;
  bytes: number;
  modifiedAt: string | null;
  name: string | null;
  description: string | null;
  base: string | null;
  model: string | null;
  toolCount: number | null;
  valid: boolean;
  active: boolean;
};
/** dstu_agent::chat_v2::handlers::variant_handlers::DeleteVariantResult */
export type DeleteVariantResult = {
  deletedVariantId: string;
  remainingCount: number;
  newActiveVariantId: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::DocumentInfo */
export type DocumentInfo = {
  id: string;
  doc_type: string;
  title: string;
  version: number;
  updated_by: string;
  updated_at: string;
};
/** dstu_agent::chat_v2::handlers::send_message::EditAndResendResult */
export type EditAndResendResult = {
  new_message_id: string;
  deleted_message_ids?: string[];
  new_variant_id?: string | null;
};
/** dstu_agent::chat_v2::handlers::snapshot_handlers::ExportMessagesChunk */
export type ExportMessagesChunk = {
  messages: ChatMessage[];
  blocks: MessageBlock[];
  nextOffset: number | null;
};
/** dstu_agent::chat_v2::handlers::snapshot_handlers::ExportSessionMeta */
export type ExportSessionMeta = {
  format: string;
  version: number;
  exportedAt: string;
  appVersion: string;
  session: ChatSession;
  sessionState: SessionState | null;
  messageCount: number;
  pageSize: number;
};
/** dstu_agent::chat_v2::handlers::export_handlers::ExportSessionResponse */
export type ExportSessionResponse = {
  sessionId: string;
  format: string;
  content: string;
  messageCount: number;
};
/** dstu_vfs::vfs::retrieval_planner::GenerationPlan */
export type GenerationPlan = {
  route: GenerationRoute;
  activeModel: ActiveGenerationModel | null;
  fallbackFrom: ActiveGenerationModel | null;
  sendsOriginalImages: boolean;
  usesOcr: boolean;
  degraded: boolean;
};
/** dstu_vfs::vfs::retrieval_planner::GenerationRoute */
export type GenerationRoute = "text_model_direct" | "multimodal_model_direct" | "multimodal_observation_then_text_model" | "ocr_then_text_model" | "text_model_without_image" | "unavailable";
/** dstu_agent::chat_v2::repo::GoalRecord */
export type GoalRecord = {
  sessionId: string;
  goalId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationCount: number;
  createdAtMs: number;
  updatedAtMs: number;
};
/** dstu_agent::chat_v2::handlers::snapshot_handlers::ImportSessionResult */
export type ImportSessionResult = {
  sessionId: string;
  messageCount: number;
  blockCount: number;
  warnings: string[];
};
/** dstu_agent::chat_v2::kill_switch::KillSwitchStatus */
export type KillSwitchStatus = {
  tripped: boolean;
  killSwitchTripped: boolean;
  trippedAtMs: number | null;
  reason: string | null;
  automationsPaused: boolean;
  cancelledStreams?: number;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::ListAgentProfilesResponse */
export type ListAgentProfilesResponse = {
  builtin: AgentProfileSummary[];
  customFiles: CustomAgentFileSummary[];
  agentsDir: string;
};
/** dstu_agent::chat_v2::types::LoadMessagesPageResponse */
export type LoadMessagesPageResponse = {
  messages: ChatMessage[];
  blocks: MessageBlock[];
  totalMessageCount: number;
  offset: number;
  limit: number;
  nextOffset?: number | null;
};
/** dstu_agent::chat_v2::types::LoadSessionResponse */
export type LoadSessionResponse = {
  session: ChatSession;
  messages: ChatMessage[];
  blocks: MessageBlock[];
  state?: SessionState | null;
  totalMessageCount?: number | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::ManualWakeRequest */
export type ManualWakeRequest = {
  workspace_id: string;
  requester_session_id: string;
  sleep_id: string;
  message?: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::ManualWakeResponse */
export type ManualWakeResponse = {
  success: boolean;
  sleep_id: string;
};
/** dstu_agent::chat_v2::types::McpToolSchema */
export type McpToolSchema = {
  name: string;
  serverId?: string | null;
  description?: string | null;
  inputSchema?: unknown | null;
};
/** dstu_core::agent::MessageBlock */
export type MessageBlock = {
  id: string;
  messageId: string;
  type: string;
  status: string;
  content?: string | null;
  toolName?: string | null;
  toolInput?: unknown | null;
  toolOutput?: unknown | null;
  citations?: Citation[] | null;
  error?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  firstChunkAt?: number | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::MessageInfo */
export type MessageInfo = {
  id: string;
  sender_session_id: string;
  target_session_id: string | null;
  message_type: string;
  content: string;
  status: string;
  created_at: string;
};
/** dstu_agent::chat_v2::types::MessageMeta */
export type MessageMeta = {
  modelId?: string | null;
  executionSnapshot?: ModelExecutionSnapshot | null;
  canonicalContent?: CanonicalContentPart[] | null;
  chatParams?: unknown | null;
  sources?: MessageSources | null;
  toolResults?: ToolResultInfo[] | null;
  ankiCards?: unknown[] | null;
  usage?: TokenUsage | null;
  contextSnapshot?: ContextSnapshot | null;
  skillSnapshotBefore?: SkillStateSnapshot | null;
  skillSnapshotAfter?: SkillStateSnapshot | null;
  skillRuntimeBefore?: ReplaySkillPayloadSnapshot | null;
  skillRuntimeAfter?: ReplaySkillPayloadSnapshot | null;
  replaySource?: string | null;
  responseReasoningItems?: { [key: string]: unknown } | null;
  skillInjectionAnchors?: SkillInjectionAnchors | null;
  openai_responses_web_search_items?: unknown[] | null;
  inboundOrigin?: unknown | null;
};
/** dstu_agent::chat_v2::types::MessageRole */
export type MessageRole = "user" | "assistant";
/** dstu_agent::chat_v2::types::MessageSources */
export type MessageSources = {
  rag?: SourceInfo[] | null;
  memory?: SourceInfo[] | null;
  graph?: SourceInfo[] | null;
  webSearch?: SourceInfo[] | null;
  multimodal?: SourceInfo[] | null;
};
/** dstu_agent::chat_v2::handlers::manage_session::MessageSummary */
export type MessageSummary = {
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
};
/** dstu_agent::chat_v2::migration::types::MigrationCheckResult */
export type MigrationCheckResult = {
  needsMigration: boolean;
  pendingMessages: number;
  pendingSessions: number;
  migratedMessages: number;
  canRollback: boolean;
  lastMigrationAt: number | null;
};
/** dstu_agent::chat_v2::migration::types::MigrationEvent */
export type MigrationEvent = {
  eventType: MigrationEventType;
  progress: MigrationProgress;
  message: string;
};
/** dstu_agent::chat_v2::migration::types::MigrationEventType */
export type MigrationEventType = "started" | "progress" | "step_changed" | "completed" | "failed" | "rollback_started" | "rollback_completed" | "rollback_failed";
/** dstu_agent::chat_v2::migration::types::MigrationProgress */
export type MigrationProgress = {
  status: MigrationStatus;
  currentStep: MigrationStep;
  totalMessages: number;
  migratedMessages: number;
  totalSessions: number;
  createdSessions: number;
  percent: number;
  currentMistakeId: string | null;
  error: string | null;
};
/** dstu_agent::chat_v2::migration::types::MigrationReport */
export type MigrationReport = {
  status: MigrationStatus;
  sessionsCreated: number;
  messagesMigrated: number;
  blocksCreated: number;
  attachmentsCreated: number;
  messagesSkipped: number;
  errors: string[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
};
/** dstu_agent::chat_v2::migration::types::MigrationStatus */
export type MigrationStatus = "not_started" | "in_progress" | "completed" | "rolled_back" | "failed";
/** dstu_agent::chat_v2::migration::types::MigrationStep */
export type MigrationStep = "check_legacy_data" | "group_by_mistake_id" | "create_session" | "migrate_messages" | "create_blocks" | "create_attachments" | "mark_migrated" | "finished";
/** dstu_agent::chat_v2::types::ModelExecutionSnapshot */
export type ModelExecutionSnapshot = {
  requestedModelId?: string | null;
  resolvedModelId: string;
  resolvedModelName: string;
  resolvedModelIsMultimodal: boolean;
  capabilitySnapshot: Shared.CapabilitySnapshot;
  generationPlan: ChatGenerationPlan;
  executionRoute?: GenerationRoute | null;
  frozenAt: number;
};
/** dstu_agent::chat_v2::handlers::ocr::OcrRequest */
export type OcrRequest = {
  images: string[];
};
/** dstu_agent::chat_v2::handlers::ocr::OcrResponse */
export type OcrResponse = {
  ocr_text: string;
  tags: string[];
  mistake_type: string;
};
/** dstu_agent::chat_v2::types::PanelStates */
export type PanelStates = {
  rag?: boolean | null;
  mcp?: boolean | null;
  search?: boolean | null;
  learn?: boolean | null;
  model?: boolean | null;
  advanced?: boolean | null;
  attachment?: boolean | null;
  skill?: boolean | null;
};
/** dstu_agent::chat_v2::types::PanelStates */
export type PanelStates__De = {
  rag?: boolean | null;
  mcp?: boolean | null;
  search?: boolean | null;
  learn?: boolean | null;
  model?: boolean | null;
  advanced?: boolean | null;
  attachment?: boolean | null;
  skill?: boolean | null;
};
/** dstu_agent::chat_v2::types::PersistStatus */
export type PersistStatus = "active" | "archived" | "deleted";
/** dstu_agent::chat_v2::types::PersistStatus */
export type PersistStatus__De = ("active" | "archived" | "deleted") | {
  active: null;
} | {
  archived: null;
} | {
  deleted: null;
};
/** dstu_agent::chat_v2::types::ReplaySkillPayloadSnapshot */
export type ReplaySkillPayloadSnapshot = {
  activeSkillIds?: string[];
  executionAllowedTools?: string[] | null;
  skillContents?: { [key: string]: string };
  skillDependencies?: { [key: string]: string[] };
  skillEmbeddedTools?: { [key: string]: McpToolSchema[] };
  mcpToolSchemas?: McpToolSchema[];
  selectedMcpServers?: string[];
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::RestoreExecutionsResponse */
export type RestoreExecutionsResponse = {
  subagent_tasks_restored: number;
  restored_agent_ids: string[];
  has_active_sleeps: boolean;
  active_sleep_ids: string[];
  unknown_tasks: UnknownSubagentTaskInfo[];
};
/** dstu_agent::chat_v2::handlers::send_message::RetryMessageResult */
export type RetryMessageResult = {
  message_id: string;
  deleted_message_ids?: string[];
  deleted_variant_ids?: string[];
  new_variant_id?: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::RunAgentRequest */
export type RunAgentRequest = {
  workspace_id: string;
  agent_session_id: string;
  requester_session_id: string;
  reminder?: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::RunAgentResponse */
export type RunAgentResponse = {
  agent_session_id: string;
  message_id: string;
  status: string;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::SaveAgentProfileFileResponse */
export type SaveAgentProfileFileResponse = {
  fileName: string;
  agentName: string;
  bytes: number;
  warnings: unknown[];
};
/** dstu_agent::chat_v2::types::SendMessageRequest */
export type SendMessageRequest = {
  sessionId: string;
  content: string;
  options?: Shared.SendOptions | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  userContextRefs?: Shared.SendContextRef[] | null;
  pathMap?: { [key: string]: string } | null;
  workspaceId?: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::SendMessageResponse */
export type SendMessageResponse = {
  message_id: string;
  is_broadcast: boolean;
};
/** dstu_agent::chat_v2::session_export::SessionExportOptions */
export type SessionExportOptions = {
  includeAllVariants?: boolean;
  includeSessionState?: boolean;
  includeCompactions?: boolean;
  redactSecrets?: boolean;
};
/** dstu_agent::chat_v2::session_export::SessionExportSummary */
export type SessionExportSummary = {
  sessionId: string;
  schemaVersion: number;
  messageCount: number;
  blockCount: number;
  compactionCount: number;
  bytesWritten: number;
  truncated: boolean;
};
/** dstu_agent::chat_v2::types::SessionGroup */
export type SessionGroup = {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  systemPrompt?: string | null;
  defaultSkillIds: string[];
  pinnedResourceIds: string[];
  workspaceId?: string | null;
  defaultRuntimeRootId?: string | null;
  preferredProjectRootPath?: string | null;
  sortOrder: number;
  persistStatus: PersistStatus;
  createdAt: string;
  updatedAt: string;
  rootFolderId?: string | null;
};
/** dstu_agent::chat_v2::handlers::manage_session::SessionReferencingResource */
export type SessionReferencingResource = {
  sessionId: string;
  title: string | null;
  messageId: string;
  lastReferencedAt: number;
};
/** dstu_agent::chat_v2::types::SessionSettings */
export type SessionSettings = {
  title?: string | null;
  metadata?: unknown | null;
};
/** dstu_agent::chat_v2::types::SessionState */
export type SessionState = {
  sessionId: string;
  chatParams?: ChatParams | null;
  features?: { [key: string]: boolean } | null;
  modeState?: unknown | null;
  inputValue?: string | null;
  panelStates?: PanelStates | null;
  updatedAt: string;
  pendingContextRefsJson?: string | null;
  loadedSkillIdsJson?: string | null;
  activeSkillIdsJson?: string | null;
  skillStateJson?: string | null;
};
/** dstu_agent::chat_v2::types::SessionState */
export type SessionState__De = {
  sessionId: string;
  chatParams?: ChatParams__De | null;
  features?: { [key: string]: boolean } | null;
  modeState?: unknown | null;
  inputValue?: string | null;
  panelStates?: PanelStates__De | null;
  updatedAt: string;
  pendingContextRefsJson?: string | null;
  loadedSkillIdsJson?: string | null;
  activeSkillIdsJson?: string | null;
  skillStateJson?: string | null;
};
/** dstu_agent::chat_v2::types::SharedContext */
export type SharedContext = {
  ragSources?: SourceInfo[] | null;
  memorySources?: SourceInfo[] | null;
  graphSources?: SourceInfo[] | null;
  webSearchSources?: SourceInfo[] | null;
  multimodalSources?: SourceInfo[] | null;
  ragBlockId?: string | null;
  memoryBlockId?: string | null;
  graphBlockId?: string | null;
  webSearchBlockId?: string | null;
  multimodalBlockId?: string | null;
};
/** dstu_agent::chat_v2::types::SkillInjectionAnchors */
export type SkillInjectionAnchors = {
  turnSkillIds?: string[];
  beforeTurnUser: boolean;
  toolAnchored?: ToolAnchoredSkills[];
  skillContentDigests?: { [key: string]: string };
  skillContentRev?: number | null;
};
/** dstu_agent::chat_v2::types::SkillStateSnapshot */
export type SkillStateSnapshot = {
  manualPinnedSkillIds?: string[];
  modeRequiredBundleIds?: string[];
  agenticSessionSkillIds?: string[];
  branchLocalSkillIds?: string[];
  effectiveAllowedExternalServers?: string[];
  version: number;
};
/** dstu_agent::chat_v2::types::SourceInfo */
export type SourceInfo = {
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  score?: number | null;
  metadata?: unknown | null;
};
/** dstu_core::token_source::TokenSource */
export type TokenSource = "api" | "tiktoken" | "heuristic" | "mixed";
/** dstu_agent::chat_v2::types::TokenUsage */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: TokenSource;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  lastRoundPromptTokens?: number | null;
  lastRoundInputTokens?: number | null;
};
/** dstu_agent::chat_v2::types::ToolAnchoredSkills */
export type ToolAnchoredSkills = {
  toolCallId: string;
  skillIds?: string[];
  roundLastToolCallId?: string | null;
};
/** dstu_agent::chat_v2::types::ToolFacePrefixSnapshot */
export type ToolFacePrefixSnapshot = {
  generation: number;
  order: string[];
  schemaDigest?: string | null;
};
/** dstu_core::agent::ToolResultInfo */
export type ToolResultInfo = {
  toolCallId?: string | null;
  blockId?: string | null;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string | null;
  durationMs?: number | null;
  reasoningContent?: string | null;
  thoughtSignature?: string | null;
};
/** dstu_agent::chat_v2::handlers::block_actions::UndoCompactionResponse */
export type UndoCompactionResponse = {
  activeCompactionId: string | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::UnknownSubagentTaskInfo */
export type UnknownSubagentTaskInfo = {
  task_id: string;
  agent_session_id: string;
  skill_id: string | null;
  initial_task: string | null;
  started_at: string | null;
  created_at: string;
};
/** dstu_agent::chat_v2::types::UpdateGroupRequest */
export type UpdateGroupRequest = {
  name?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  systemPrompt?: string | null;
  defaultSkillIds?: string[] | null;
  pinnedResourceIds?: string[] | null;
  workspaceId?: string | null;
  defaultRuntimeRootId?: string | null;
  preferredProjectRootPath?: string | null;
  sortOrder?: number | null;
  persistStatus?: PersistStatus__De | null;
  rootFolderId?: string | null;
};
/** dstu_agent::chat_v2::types::Variant */
export type Variant = {
  id: string;
  modelId: string;
  configId?: string | null;
  blockIds: string[];
  status: string;
  error?: string | null;
  createdAt: number;
  usage?: TokenUsage | null;
  meta?: VariantMeta | null;
};
/** dstu_agent::chat_v2::types::VariantMeta */
export type VariantMeta = {
  executionSnapshot?: ModelExecutionSnapshot | null;
  canonicalArtifacts?: CanonicalContentPart[] | null;
  skillSnapshotBefore?: SkillStateSnapshot | null;
  skillSnapshotAfter?: SkillStateSnapshot | null;
  skillRuntimeBefore?: ReplaySkillPayloadSnapshot | null;
  skillRuntimeAfter?: ReplaySkillPayloadSnapshot | null;
  toolFacePrefix?: ToolFacePrefixSnapshot | null;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::WorkspaceInfo */
export type WorkspaceInfo = {
  id: string;
  name: string | null;
  status: string;
  creator_session_id: string;
  created_at: string;
  updated_at: string;
};
/** dstu_agent::chat_v2::handlers::workspace_handlers::WorkspaceSendMessageRequest */
export type WorkspaceSendMessageRequest = {
  workspace_id: string;
  content: string;
  target_session_id?: string | null;
  message_type?: string | null;
};

export interface Commands {
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:117 `chat_v2_add_tag` */
  chat_v2_add_tag: {
    args: {
      sessionId: string;
      tag: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:330 `chat_v2_archive_group` */
  chat_v2_archive_group: {
    args: {
      groupId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:522 `chat_v2_archive_session` */
  chat_v2_archive_session: {
    args: {
      sessionId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/ask_user_handlers.rs:44 `chat_v2_ask_user_respond` */
  chat_v2_ask_user_respond: {
    args: {
      toolCallId: string;
      selectedTexts: string[];
      selectedIndices: number[];
      customText?: string | null;
      source: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:710 `chat_v2_branch_session` */
  chat_v2_branch_session: {
    args: {
      sourceSessionId: string;
      upToMessageId: string;
    };
    result: ChatSession;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/send_message.rs:859 `chat_v2_cancel_stream` */
  chat_v2_cancel_stream: {
    args: {
      sessionId: string;
      messageId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:1085 `chat_v2_cancel_variant` */
  chat_v2_cancel_variant: {
    args: {
      sessionId: string;
      variantId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/migration.rs:18 `chat_v2_check_migration_status` */
  chat_v2_check_migration_status: {
    args: Record<string, never>;
    result: MigrationCheckResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:178 `chat_v2_clear_approval_history` */
  chat_v2_clear_approval_history: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:56 `chat_v2_compact_session` */
  chat_v2_compact_session: {
    args: {
      sessionId: string;
      modelConfigId: string;
      contextLimit?: number | null;
    };
    result: CompactSessionResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/send_message.rs:2010 `chat_v2_continue_message` */
  chat_v2_continue_message: {
    args: {
      sessionId: string;
      messageId: string;
      variantId?: string | null;
      options?: Shared.SendOptions | null;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:258 `chat_v2_copy_block_content` */
  chat_v2_copy_block_content: {
    args: {
      blockId: string;
      format?: string | null;
    };
    result: CopyBlockContentResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:641 `chat_v2_count_sessions` */
  chat_v2_count_sessions: {
    args: {
      status?: string | null;
      groupId?: string | null;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:145 `chat_v2_create_group` */
  chat_v2_create_group: {
    args: {
      request: CreateGroupRequest;
    };
    result: SessionGroup;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:329 `chat_v2_create_session` */
  chat_v2_create_session: {
    args: {
      mode: string;
      title?: string | null;
      metadata?: unknown | null;
      groupId?: string | null;
    };
    result: ChatSession;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:285 `chat_v2_delete_group` */
  chat_v2_delete_group: {
    args: {
      groupId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:195 `chat_v2_delete_message` */
  chat_v2_delete_message: {
    args: {
      sessionId: string;
      messageId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:892 `chat_v2_delete_session` */
  chat_v2_delete_session: {
    args: {
      sessionId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:224 `chat_v2_delete_variant` */
  chat_v2_delete_variant: {
    args: {
      sessionId: string;
      messageId: string;
      variantId: string;
    };
    result: DeleteVariantResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/send_message.rs:1267 `chat_v2_edit_and_resend` */
  chat_v2_edit_and_resend: {
    args: {
      sessionId: string;
      messageId: string;
      newContent: string;
      newContextRefs?: Shared.SendContextRef[] | null;
      newPathMap?: { [key: string]: string } | null;
      options?: Shared.SendOptions | null;
    };
    result: EditAndResendResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/kill_switch.rs:194 `chat_v2_emergency_stop` */
  chat_v2_emergency_stop: {
    args: {
      reason?: string | null;
    };
    result: KillSwitchStatus;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:979 `chat_v2_empty_deleted_sessions` */
  chat_v2_empty_deleted_sessions: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/export_handlers.rs:56 `chat_v2_export_session` */
  chat_v2_export_session: {
    args: {
      sessionId: string;
      format?: string | null;
      includeThinking?: boolean | null;
    };
    result: ExportSessionResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/export_handlers.rs:130 `chat_v2_export_session_jsonl` */
  chat_v2_export_session_jsonl: {
    args: {
      sessionId: string;
      targetPath: string;
      options?: SessionExportOptions | null;
    };
    result: SessionExportSummary;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:116 `chat_v2_export_session_messages` */
  chat_v2_export_session_messages: {
    args: {
      sessionId: string;
      offset: number;
      limit?: number | null;
    };
    result: ExportMessagesChunk;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:82 `chat_v2_export_session_meta` */
  chat_v2_export_session_meta: {
    args: {
      sessionId: string;
    };
    result: ExportSessionMeta;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:488 `chat_v2_freeze_available_skills_snapshot` */
  chat_v2_freeze_available_skills_snapshot: {
    args: {
      sessionId: string;
      snapshot: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:552 `chat_v2_get_anki_cards_from_block_by_document_id` */
  chat_v2_get_anki_cards_from_block_by_document_id: {
    args: {
      documentId: string;
    };
    result: Shared.AnkiCard[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/events.rs:827 `chat_v2_get_emit_failure_count` */
  chat_v2_get_emit_failure_count: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:368 `chat_v2_get_group` */
  chat_v2_get_group: {
    args: {
      groupId: string;
    };
    result: SessionGroup | null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1109 `chat_v2_get_message_summary` */
  chat_v2_get_message_summary: {
    args: Record<string, never>;
    result: MessageSummary;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2980 `chat_v2_get_rag_scope` */
  chat_v2_get_rag_scope: {
    args: {
      sessionId: string;
    };
    result: string[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:413 `chat_v2_get_session` */
  chat_v2_get_session: {
    args: {
      sessionId: string;
    };
    result: ChatSession | null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:96 `chat_v2_get_session_tags` */
  chat_v2_get_session_tags: {
    args: {
      sessionId: string;
    };
    result: string[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:107 `chat_v2_get_tags_batch` */
  chat_v2_get_tags_batch: {
    args: {
      sessionIds: string[];
    };
    result: { [key: string]: string[] };
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:231 `chat_v2_goal_clear` */
  chat_v2_goal_clear: {
    args: {
      sessionId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:174 `chat_v2_goal_edit` */
  chat_v2_goal_edit: {
    args: {
      sessionId: string;
      objective: string;
      tokenBudget?: number | null;
    };
    result: GoalRecord;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:75 `chat_v2_goal_get` */
  chat_v2_goal_get: {
    args: {
      sessionId: string;
    };
    result: GoalRecord | null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:85 `chat_v2_goal_pause` */
  chat_v2_goal_pause: {
    args: {
      sessionId: string;
    };
    result: GoalRecord;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:126 `chat_v2_goal_resume` */
  chat_v2_goal_resume: {
    args: {
      sessionId: string;
    };
    result: GoalRecord;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/send_message.rs:890 `chat_v2_has_active_stream` */
  chat_v2_has_active_stream: {
    args: {
      sessionId: string;
    };
    result: boolean;
    error: never;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:189 `chat_v2_import_session` */
  chat_v2_import_session: {
    args: {
      snapshotJson: string;
    };
    result: ImportSessionResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/kill_switch.rs:290 `chat_v2_kill_switch_status` */
  chat_v2_kill_switch_status: {
    args: Record<string, never>;
    result: KillSwitchStatus;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:671 `chat_v2_list_agent_sessions` */
  chat_v2_list_agent_sessions: {
    args: {
      workspaceId?: string | null;
      limit?: number | null;
    };
    result: ChatSession[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:147 `chat_v2_list_all_tags` */
  chat_v2_list_all_tags: {
    args: Record<string, never>;
    result: [string, number][];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:398 `chat_v2_list_groups` */
  chat_v2_list_groups: {
    args: {
      status?: string | null;
      workspaceId?: string | null;
    };
    result: SessionGroup[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:597 `chat_v2_list_sessions` */
  chat_v2_list_sessions: {
    args: {
      status?: string | null;
      groupId?: string | null;
      limit?: number | null;
      offset?: number | null;
    };
    result: ChatSession[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2938 `chat_v2_list_sessions_referencing` */
  chat_v2_list_sessions_referencing: {
    args: {
      sourceIds: string[];
      limit?: number | null;
    };
    result: SessionReferencingResource[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/load_messages_page.rs:32 `chat_v2_load_messages_page` */
  chat_v2_load_messages_page: {
    args: {
      sessionId: string;
      offset?: number | null;
      limit?: number | null;
    };
    result: LoadMessagesPageResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/load_session.rs:37 `chat_v2_load_session` */
  chat_v2_load_session: {
    args: {
      sessionId: string;
      tailLimit?: number | null;
    };
    result: LoadSessionResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/migration.rs:35 `chat_v2_migrate_legacy_chat` */
  chat_v2_migrate_legacy_chat: {
    args: Record<string, never>;
    result: MigrationReport;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:438 `chat_v2_move_session_to_group` */
  chat_v2_move_session_to_group: {
    args: {
      sessionId: string;
      groupId?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/ocr.rs:44 `chat_v2_perform_ocr` */
  chat_v2_perform_ocr: {
    args: {
      request: OcrRequest;
    };
    result: OcrResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2185 `chat_v2_plan_gate_respond` */
  chat_v2_plan_gate_respond: {
    args: {
      sessionId: string;
      planId: string;
      toolCallId: string;
      approved: boolean;
      reason?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:132 `chat_v2_remove_tag` */
  chat_v2_remove_tag: {
    args: {
      sessionId: string;
      tag: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:427 `chat_v2_reorder_groups` */
  chat_v2_reorder_groups: {
    args: {
      groupIds: string[];
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:341 `chat_v2_restore_group` */
  chat_v2_restore_group: {
    args: {
      groupId: string;
    };
    result: SessionGroup;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:845 `chat_v2_restore_session` */
  chat_v2_restore_session: {
    args: {
      sessionId: string;
    };
    result: ChatSession;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/kill_switch.rs:255 `chat_v2_resume_agents` */
  chat_v2_resume_agents: {
    args: Record<string, never>;
    result: KillSwitchStatus;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/kill_switch.rs:272 `chat_v2_resume_automations` */
  chat_v2_resume_automations: {
    args: Record<string, never>;
    result: KillSwitchStatus;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/send_message.rs:918 `chat_v2_retry_message` */
  chat_v2_retry_message: {
    args: {
      sessionId: string;
      messageId: string;
      options?: Shared.SendOptions | null;
    };
    result: RetryMessageResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:401 `chat_v2_retry_variant` */
  chat_v2_retry_variant: {
    args: {
      sessionId: string;
      messageId: string;
      variantId: string;
      modelOverride?: string | null;
      options?: Shared.SendOptions | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:446 `chat_v2_retry_variants` */
  chat_v2_retry_variants: {
    args: {
      sessionId: string;
      messageId: string;
      variantIds: string[];
      options?: Shared.SendOptions | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/migration.rs:52 `chat_v2_rollback_migration` */
  chat_v2_rollback_migration: {
    args: Record<string, never>;
    result: MigrationReport;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:562 `chat_v2_save_session` */
  chat_v2_save_session: {
    args: {
      sessionId: string;
      sessionState: SessionState__De;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:30 `chat_v2_search_content` */
  chat_v2_search_content: {
    args: {
      query: string;
      limit?: number | null;
      dateFrom?: string | null;
      dateTo?: string | null;
      sessionId?: string | null;
      includeArchived?: boolean | null;
    };
    result: ContentSearchResult[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:71 `chat_v2_search_sessions` */
  chat_v2_search_sessions: {
    args: {
      query: string;
      limit?: number | null;
      includeArchived?: boolean | null;
    };
    result: ChatSession[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/send_message.rs:461 `chat_v2_send_message` */
  chat_v2_send_message: {
    args: {
      request: SendMessageRequest;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1079 `chat_v2_session_message_count` */
  chat_v2_session_message_count: {
    args: {
      sessionId: string;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2127 `chat_v2_set_authority_mode` */
  chat_v2_set_authority_mode: {
    args: {
      sessionId: string;
      mode: string;
    };
    result: ChatSession;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2153 `chat_v2_set_permission_preset` */
  chat_v2_set_permission_preset: {
    args: {
      sessionId: string;
      preset: string;
      confirm?: boolean | null;
    };
    result: ChatSession;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2988 `chat_v2_set_rag_scope` */
  chat_v2_set_rag_scope: {
    args: {
      sessionId: string;
      folderIds: string[];
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:771 `chat_v2_soft_delete_session` */
  chat_v2_soft_delete_session: {
    args: {
      sessionId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1848 `chat_v2_stage_context_attachments` */
  chat_v2_stage_context_attachments: {
    args: {
      sessionId: string;
      items: AutoStageContextAttachmentInput[];
    };
    result: AutoStageContextAttachmentsResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:153 `chat_v2_switch_variant` */
  chat_v2_switch_variant: {
    args: {
      sessionId: string;
      messageId: string;
      variantId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:153 `chat_v2_tool_approval_cancel` */
  chat_v2_tool_approval_cancel: {
    args: {
      toolCallId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:39 `chat_v2_tool_approval_respond` */
  chat_v2_tool_approval_respond: {
    args: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      approved: boolean;
      reason?: string | null;
      remember: boolean;
      rememberSession?: boolean | null;
      arguments?: unknown | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:118 `chat_v2_undo_compaction` */
  chat_v2_undo_compaction: {
    args: {
      sessionId: string;
      compactionId: string;
    };
    result: UndoCompactionResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:441 `chat_v2_update_block_content` */
  chat_v2_update_block_content: {
    args: {
      blockId: string;
      content: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:499 `chat_v2_update_block_tool_output` */
  chat_v2_update_block_tool_output: {
    args: {
      blockId: string;
      toolOutputJson: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:197 `chat_v2_update_group` */
  chat_v2_update_group: {
    args: {
      groupId: string;
      request: UpdateGroupRequest;
    };
    result: SessionGroup;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:448 `chat_v2_update_session_settings` */
  chat_v2_update_session_settings: {
    args: {
      sessionId: string;
      settings: SessionSettings;
    };
    result: ChatSession;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:689 `chat_v2_upsert_streaming_block` */
  chat_v2_upsert_streaming_block: {
    args: {
      blockId: string;
      messageId: string;
      sessionId?: string | null;
      blockType: string;
      content: string;
      status?: string | null;
      toolName?: string | null;
      toolInputJson?: string | null;
      toolOutputJson?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/send_message.rs:717 `chat_v2_wake_session` */
  chat_v2_wake_session: {
    args: {
      sessionId: string;
      content: string;
      assistantMessageId?: string | null;
      options?: Shared.SendOptions | null;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:89 `rebuild_chat_fts` */
  rebuild_chat_fts: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2139 `workspace_cancel_agent` */
  workspace_cancel_agent: {
    args: {
      sessionId: string;
      workspaceId: string;
      agentSessionId: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2308 `workspace_cancel_sleep` */
  workspace_cancel_sleep: {
    args: {
      sessionId: string;
      workspaceId: string;
      sleepId: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:642 `workspace_close` */
  workspace_close: {
    args: {
      sessionId: string;
      workspaceId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:606 `workspace_create` */
  workspace_create: {
    args: {
      sessionId: string;
      request: CreateWorkspaceRequest;
    };
    result: CreateWorkspaceResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:680 `workspace_create_agent` */
  workspace_create_agent: {
    args: {
      request: CreateAgentRequest;
    };
    result: CreateAgentResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:661 `workspace_delete` */
  workspace_delete: {
    args: {
      sessionId: string;
      workspaceId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2789 `workspace_delete_agent_profile_file` */
  workspace_delete_agent_profile_file: {
    args: {
      fileName: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:622 `workspace_get` */
  workspace_get: {
    args: {
      sessionId: string;
      workspaceId: string;
    };
    result: WorkspaceInfo | null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:972 `workspace_get_context` */
  workspace_get_context: {
    args: {
      sessionId: string;
      workspaceId: string;
      key: string;
    };
    result: unknown | null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1008 `workspace_get_document` */
  workspace_get_document: {
    args: {
      sessionId: string;
      workspaceId: string;
      documentId: string;
    };
    result: string | null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2638 `workspace_list_agent_profiles` */
  workspace_list_agent_profiles: {
    args: Record<string, never>;
    result: ListAgentProfilesResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:866 `workspace_list_agents` */
  workspace_list_agents: {
    args: {
      sessionId: string;
      workspaceId: string;
    };
    result: AgentInfo[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1021 `workspace_list_all` */
  workspace_list_all: {
    args: {
      sessionId: string;
    };
    result: WorkspaceInfo[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:985 `workspace_list_documents` */
  workspace_list_documents: {
    args: {
      sessionId: string;
      workspaceId: string;
    };
    result: DocumentInfo[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:935 `workspace_list_messages` */
  workspace_list_messages: {
    args: {
      sessionId: string;
      workspaceId: string;
      limit?: number | null;
    };
    result: MessageInfo[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2274 `workspace_manual_wake` */
  workspace_manual_wake: {
    args: {
      request: ManualWakeRequest;
    };
    result: ManualWakeResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2709 `workspace_read_agent_profile_file` */
  workspace_read_agent_profile_file: {
    args: {
      fileName: string;
    };
    result: AgentProfileFileResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2413 `workspace_restore_executions` */
  workspace_restore_executions: {
    args: {
      sessionId: string;
      workspaceId: string;
    };
    result: RestoreExecutionsResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1075 `workspace_run_agent` */
  workspace_run_agent: {
    args: {
      request: RunAgentRequest;
    };
    result: RunAgentResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2742 `workspace_save_agent_profile_file` */
  workspace_save_agent_profile_file: {
    args: {
      fileName: string;
      content: string;
      overwrite: boolean;
    };
    result: SaveAgentProfileFileResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:902 `workspace_send_message` */
  workspace_send_message: {
    args: {
      sessionId: string;
      request: WorkspaceSendMessageRequest;
    };
    result: SendMessageResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:960 `workspace_set_context` */
  workspace_set_context: {
    args: {
      sessionId: string;
      workspaceId: string;
      key: string;
      value: unknown;
    };
    result: null;
    error: string;
  };
}

export interface Events {
  "chat_v2://kill_switch_changed": KillSwitchStatus;
  "chat_v2_migration": MigrationEvent;
  "chat_v2_request_audit": unknown;
  [name: `chat_v2_session_${string}`]: ({
    eventType: string;
    messageId: string;
    variantId: string;
    remainingCount: number;
    newActiveVariantId: string | null;
  } | {
    sessionId: string;
    eventType: string;
    messageId: string;
    retryAttempt: number;
    retryMax: number;
    timestamp: number;
  } | unknown);
  "workspace_agent_completion": (AgentCompletionEnvelope | unknown /* x-unresolved: payload type of `payload` not determinable statically */);
  "workspace_worker_ready": {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
    restored: boolean;
    reminder: string | null;
    runtime_managed: boolean;
  } | {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
    run_id: string;
    runtime_managed: boolean;
  } | {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
    runtime_managed: boolean;
  } | {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
  };
}

export type CommandName = keyof Commands;
export type ChatV2AddTagCommandArgs = Commands['chat_v2_add_tag']['args'];
export type ChatV2AddTagCommandResult = Commands['chat_v2_add_tag']['result'];
export type ChatV2ArchiveGroupCommandArgs = Commands['chat_v2_archive_group']['args'];
export type ChatV2ArchiveGroupCommandResult = Commands['chat_v2_archive_group']['result'];
export type ChatV2ArchiveSessionCommandArgs = Commands['chat_v2_archive_session']['args'];
export type ChatV2ArchiveSessionCommandResult = Commands['chat_v2_archive_session']['result'];
export type ChatV2AskUserRespondCommandArgs = Commands['chat_v2_ask_user_respond']['args'];
export type ChatV2AskUserRespondCommandResult = Commands['chat_v2_ask_user_respond']['result'];
export type ChatV2BranchSessionCommandArgs = Commands['chat_v2_branch_session']['args'];
export type ChatV2BranchSessionCommandResult = Commands['chat_v2_branch_session']['result'];
export type ChatV2CancelStreamCommandArgs = Commands['chat_v2_cancel_stream']['args'];
export type ChatV2CancelStreamCommandResult = Commands['chat_v2_cancel_stream']['result'];
export type ChatV2CancelVariantCommandArgs = Commands['chat_v2_cancel_variant']['args'];
export type ChatV2CancelVariantCommandResult = Commands['chat_v2_cancel_variant']['result'];
export type ChatV2CheckMigrationStatusCommandArgs = Commands['chat_v2_check_migration_status']['args'];
export type ChatV2CheckMigrationStatusCommandResult = Commands['chat_v2_check_migration_status']['result'];
export type ChatV2ClearApprovalHistoryCommandArgs = Commands['chat_v2_clear_approval_history']['args'];
export type ChatV2ClearApprovalHistoryCommandResult = Commands['chat_v2_clear_approval_history']['result'];
export type ChatV2CompactSessionCommandArgs = Commands['chat_v2_compact_session']['args'];
export type ChatV2CompactSessionCommandResult = Commands['chat_v2_compact_session']['result'];
export type ChatV2ContinueMessageCommandArgs = Commands['chat_v2_continue_message']['args'];
export type ChatV2ContinueMessageCommandResult = Commands['chat_v2_continue_message']['result'];
export type ChatV2CopyBlockContentCommandArgs = Commands['chat_v2_copy_block_content']['args'];
export type ChatV2CopyBlockContentCommandResult = Commands['chat_v2_copy_block_content']['result'];
export type ChatV2CountSessionsCommandArgs = Commands['chat_v2_count_sessions']['args'];
export type ChatV2CountSessionsCommandResult = Commands['chat_v2_count_sessions']['result'];
export type ChatV2CreateGroupCommandArgs = Commands['chat_v2_create_group']['args'];
export type ChatV2CreateGroupCommandResult = Commands['chat_v2_create_group']['result'];
export type ChatV2CreateSessionCommandArgs = Commands['chat_v2_create_session']['args'];
export type ChatV2CreateSessionCommandResult = Commands['chat_v2_create_session']['result'];
export type ChatV2DeleteGroupCommandArgs = Commands['chat_v2_delete_group']['args'];
export type ChatV2DeleteGroupCommandResult = Commands['chat_v2_delete_group']['result'];
export type ChatV2DeleteMessageCommandArgs = Commands['chat_v2_delete_message']['args'];
export type ChatV2DeleteMessageCommandResult = Commands['chat_v2_delete_message']['result'];
export type ChatV2DeleteSessionCommandArgs = Commands['chat_v2_delete_session']['args'];
export type ChatV2DeleteSessionCommandResult = Commands['chat_v2_delete_session']['result'];
export type ChatV2DeleteVariantCommandArgs = Commands['chat_v2_delete_variant']['args'];
export type ChatV2DeleteVariantCommandResult = Commands['chat_v2_delete_variant']['result'];
export type ChatV2EditAndResendCommandArgs = Commands['chat_v2_edit_and_resend']['args'];
export type ChatV2EditAndResendCommandResult = Commands['chat_v2_edit_and_resend']['result'];
export type ChatV2EmergencyStopCommandArgs = Commands['chat_v2_emergency_stop']['args'];
export type ChatV2EmergencyStopCommandResult = Commands['chat_v2_emergency_stop']['result'];
export type ChatV2EmptyDeletedSessionsCommandArgs = Commands['chat_v2_empty_deleted_sessions']['args'];
export type ChatV2EmptyDeletedSessionsCommandResult = Commands['chat_v2_empty_deleted_sessions']['result'];
export type ChatV2ExportSessionCommandArgs = Commands['chat_v2_export_session']['args'];
export type ChatV2ExportSessionCommandResult = Commands['chat_v2_export_session']['result'];
export type ChatV2ExportSessionJsonlCommandArgs = Commands['chat_v2_export_session_jsonl']['args'];
export type ChatV2ExportSessionJsonlCommandResult = Commands['chat_v2_export_session_jsonl']['result'];
export type ChatV2ExportSessionMessagesCommandArgs = Commands['chat_v2_export_session_messages']['args'];
export type ChatV2ExportSessionMessagesCommandResult = Commands['chat_v2_export_session_messages']['result'];
export type ChatV2ExportSessionMetaCommandArgs = Commands['chat_v2_export_session_meta']['args'];
export type ChatV2ExportSessionMetaCommandResult = Commands['chat_v2_export_session_meta']['result'];
export type ChatV2FreezeAvailableSkillsSnapshotCommandArgs = Commands['chat_v2_freeze_available_skills_snapshot']['args'];
export type ChatV2FreezeAvailableSkillsSnapshotCommandResult = Commands['chat_v2_freeze_available_skills_snapshot']['result'];
export type ChatV2GetAnkiCardsFromBlockByDocumentIdCommandArgs = Commands['chat_v2_get_anki_cards_from_block_by_document_id']['args'];
export type ChatV2GetAnkiCardsFromBlockByDocumentIdCommandResult = Commands['chat_v2_get_anki_cards_from_block_by_document_id']['result'];
export type ChatV2GetEmitFailureCountCommandArgs = Commands['chat_v2_get_emit_failure_count']['args'];
export type ChatV2GetEmitFailureCountCommandResult = Commands['chat_v2_get_emit_failure_count']['result'];
export type ChatV2GetGroupCommandArgs = Commands['chat_v2_get_group']['args'];
export type ChatV2GetGroupCommandResult = Commands['chat_v2_get_group']['result'];
export type ChatV2GetMessageSummaryCommandArgs = Commands['chat_v2_get_message_summary']['args'];
export type ChatV2GetMessageSummaryCommandResult = Commands['chat_v2_get_message_summary']['result'];
export type ChatV2GetRagScopeCommandArgs = Commands['chat_v2_get_rag_scope']['args'];
export type ChatV2GetRagScopeCommandResult = Commands['chat_v2_get_rag_scope']['result'];
export type ChatV2GetSessionCommandArgs = Commands['chat_v2_get_session']['args'];
export type ChatV2GetSessionCommandResult = Commands['chat_v2_get_session']['result'];
export type ChatV2GetSessionTagsCommandArgs = Commands['chat_v2_get_session_tags']['args'];
export type ChatV2GetSessionTagsCommandResult = Commands['chat_v2_get_session_tags']['result'];
export type ChatV2GetTagsBatchCommandArgs = Commands['chat_v2_get_tags_batch']['args'];
export type ChatV2GetTagsBatchCommandResult = Commands['chat_v2_get_tags_batch']['result'];
export type ChatV2GoalClearCommandArgs = Commands['chat_v2_goal_clear']['args'];
export type ChatV2GoalClearCommandResult = Commands['chat_v2_goal_clear']['result'];
export type ChatV2GoalEditCommandArgs = Commands['chat_v2_goal_edit']['args'];
export type ChatV2GoalEditCommandResult = Commands['chat_v2_goal_edit']['result'];
export type ChatV2GoalGetCommandArgs = Commands['chat_v2_goal_get']['args'];
export type ChatV2GoalGetCommandResult = Commands['chat_v2_goal_get']['result'];
export type ChatV2GoalPauseCommandArgs = Commands['chat_v2_goal_pause']['args'];
export type ChatV2GoalPauseCommandResult = Commands['chat_v2_goal_pause']['result'];
export type ChatV2GoalResumeCommandArgs = Commands['chat_v2_goal_resume']['args'];
export type ChatV2GoalResumeCommandResult = Commands['chat_v2_goal_resume']['result'];
export type ChatV2HasActiveStreamCommandArgs = Commands['chat_v2_has_active_stream']['args'];
export type ChatV2HasActiveStreamCommandResult = Commands['chat_v2_has_active_stream']['result'];
export type ChatV2ImportSessionCommandArgs = Commands['chat_v2_import_session']['args'];
export type ChatV2ImportSessionCommandResult = Commands['chat_v2_import_session']['result'];
export type ChatV2KillSwitchStatusCommandArgs = Commands['chat_v2_kill_switch_status']['args'];
export type ChatV2KillSwitchStatusCommandResult = Commands['chat_v2_kill_switch_status']['result'];
export type ChatV2ListAgentSessionsCommandArgs = Commands['chat_v2_list_agent_sessions']['args'];
export type ChatV2ListAgentSessionsCommandResult = Commands['chat_v2_list_agent_sessions']['result'];
export type ChatV2ListAllTagsCommandArgs = Commands['chat_v2_list_all_tags']['args'];
export type ChatV2ListAllTagsCommandResult = Commands['chat_v2_list_all_tags']['result'];
export type ChatV2ListGroupsCommandArgs = Commands['chat_v2_list_groups']['args'];
export type ChatV2ListGroupsCommandResult = Commands['chat_v2_list_groups']['result'];
export type ChatV2ListSessionsCommandArgs = Commands['chat_v2_list_sessions']['args'];
export type ChatV2ListSessionsCommandResult = Commands['chat_v2_list_sessions']['result'];
export type ChatV2ListSessionsReferencingCommandArgs = Commands['chat_v2_list_sessions_referencing']['args'];
export type ChatV2ListSessionsReferencingCommandResult = Commands['chat_v2_list_sessions_referencing']['result'];
export type ChatV2LoadMessagesPageCommandArgs = Commands['chat_v2_load_messages_page']['args'];
export type ChatV2LoadMessagesPageCommandResult = Commands['chat_v2_load_messages_page']['result'];
export type ChatV2LoadSessionCommandArgs = Commands['chat_v2_load_session']['args'];
export type ChatV2LoadSessionCommandResult = Commands['chat_v2_load_session']['result'];
export type ChatV2MigrateLegacyChatCommandArgs = Commands['chat_v2_migrate_legacy_chat']['args'];
export type ChatV2MigrateLegacyChatCommandResult = Commands['chat_v2_migrate_legacy_chat']['result'];
export type ChatV2MoveSessionToGroupCommandArgs = Commands['chat_v2_move_session_to_group']['args'];
export type ChatV2MoveSessionToGroupCommandResult = Commands['chat_v2_move_session_to_group']['result'];
export type ChatV2PerformOcrCommandArgs = Commands['chat_v2_perform_ocr']['args'];
export type ChatV2PerformOcrCommandResult = Commands['chat_v2_perform_ocr']['result'];
export type ChatV2PlanGateRespondCommandArgs = Commands['chat_v2_plan_gate_respond']['args'];
export type ChatV2PlanGateRespondCommandResult = Commands['chat_v2_plan_gate_respond']['result'];
export type ChatV2RemoveTagCommandArgs = Commands['chat_v2_remove_tag']['args'];
export type ChatV2RemoveTagCommandResult = Commands['chat_v2_remove_tag']['result'];
export type ChatV2ReorderGroupsCommandArgs = Commands['chat_v2_reorder_groups']['args'];
export type ChatV2ReorderGroupsCommandResult = Commands['chat_v2_reorder_groups']['result'];
export type ChatV2RestoreGroupCommandArgs = Commands['chat_v2_restore_group']['args'];
export type ChatV2RestoreGroupCommandResult = Commands['chat_v2_restore_group']['result'];
export type ChatV2RestoreSessionCommandArgs = Commands['chat_v2_restore_session']['args'];
export type ChatV2RestoreSessionCommandResult = Commands['chat_v2_restore_session']['result'];
export type ChatV2ResumeAgentsCommandArgs = Commands['chat_v2_resume_agents']['args'];
export type ChatV2ResumeAgentsCommandResult = Commands['chat_v2_resume_agents']['result'];
export type ChatV2ResumeAutomationsCommandArgs = Commands['chat_v2_resume_automations']['args'];
export type ChatV2ResumeAutomationsCommandResult = Commands['chat_v2_resume_automations']['result'];
export type ChatV2RetryMessageCommandArgs = Commands['chat_v2_retry_message']['args'];
export type ChatV2RetryMessageCommandResult = Commands['chat_v2_retry_message']['result'];
export type ChatV2RetryVariantCommandArgs = Commands['chat_v2_retry_variant']['args'];
export type ChatV2RetryVariantCommandResult = Commands['chat_v2_retry_variant']['result'];
export type ChatV2RetryVariantsCommandArgs = Commands['chat_v2_retry_variants']['args'];
export type ChatV2RetryVariantsCommandResult = Commands['chat_v2_retry_variants']['result'];
export type ChatV2RollbackMigrationCommandArgs = Commands['chat_v2_rollback_migration']['args'];
export type ChatV2RollbackMigrationCommandResult = Commands['chat_v2_rollback_migration']['result'];
export type ChatV2SaveSessionCommandArgs = Commands['chat_v2_save_session']['args'];
export type ChatV2SaveSessionCommandResult = Commands['chat_v2_save_session']['result'];
export type ChatV2SearchContentCommandArgs = Commands['chat_v2_search_content']['args'];
export type ChatV2SearchContentCommandResult = Commands['chat_v2_search_content']['result'];
export type ChatV2SearchSessionsCommandArgs = Commands['chat_v2_search_sessions']['args'];
export type ChatV2SearchSessionsCommandResult = Commands['chat_v2_search_sessions']['result'];
export type ChatV2SendMessageCommandArgs = Commands['chat_v2_send_message']['args'];
export type ChatV2SendMessageCommandResult = Commands['chat_v2_send_message']['result'];
export type ChatV2SessionMessageCountCommandArgs = Commands['chat_v2_session_message_count']['args'];
export type ChatV2SessionMessageCountCommandResult = Commands['chat_v2_session_message_count']['result'];
export type ChatV2SetAuthorityModeCommandArgs = Commands['chat_v2_set_authority_mode']['args'];
export type ChatV2SetAuthorityModeCommandResult = Commands['chat_v2_set_authority_mode']['result'];
export type ChatV2SetPermissionPresetCommandArgs = Commands['chat_v2_set_permission_preset']['args'];
export type ChatV2SetPermissionPresetCommandResult = Commands['chat_v2_set_permission_preset']['result'];
export type ChatV2SetRagScopeCommandArgs = Commands['chat_v2_set_rag_scope']['args'];
export type ChatV2SetRagScopeCommandResult = Commands['chat_v2_set_rag_scope']['result'];
export type ChatV2SoftDeleteSessionCommandArgs = Commands['chat_v2_soft_delete_session']['args'];
export type ChatV2SoftDeleteSessionCommandResult = Commands['chat_v2_soft_delete_session']['result'];
export type ChatV2StageContextAttachmentsCommandArgs = Commands['chat_v2_stage_context_attachments']['args'];
export type ChatV2StageContextAttachmentsCommandResult = Commands['chat_v2_stage_context_attachments']['result'];
export type ChatV2SwitchVariantCommandArgs = Commands['chat_v2_switch_variant']['args'];
export type ChatV2SwitchVariantCommandResult = Commands['chat_v2_switch_variant']['result'];
export type ChatV2ToolApprovalCancelCommandArgs = Commands['chat_v2_tool_approval_cancel']['args'];
export type ChatV2ToolApprovalCancelCommandResult = Commands['chat_v2_tool_approval_cancel']['result'];
export type ChatV2ToolApprovalRespondCommandArgs = Commands['chat_v2_tool_approval_respond']['args'];
export type ChatV2ToolApprovalRespondCommandResult = Commands['chat_v2_tool_approval_respond']['result'];
export type ChatV2UndoCompactionCommandArgs = Commands['chat_v2_undo_compaction']['args'];
export type ChatV2UndoCompactionCommandResult = Commands['chat_v2_undo_compaction']['result'];
export type ChatV2UpdateBlockContentCommandArgs = Commands['chat_v2_update_block_content']['args'];
export type ChatV2UpdateBlockContentCommandResult = Commands['chat_v2_update_block_content']['result'];
export type ChatV2UpdateBlockToolOutputCommandArgs = Commands['chat_v2_update_block_tool_output']['args'];
export type ChatV2UpdateBlockToolOutputCommandResult = Commands['chat_v2_update_block_tool_output']['result'];
export type ChatV2UpdateGroupCommandArgs = Commands['chat_v2_update_group']['args'];
export type ChatV2UpdateGroupCommandResult = Commands['chat_v2_update_group']['result'];
export type ChatV2UpdateSessionSettingsCommandArgs = Commands['chat_v2_update_session_settings']['args'];
export type ChatV2UpdateSessionSettingsCommandResult = Commands['chat_v2_update_session_settings']['result'];
export type ChatV2UpsertStreamingBlockCommandArgs = Commands['chat_v2_upsert_streaming_block']['args'];
export type ChatV2UpsertStreamingBlockCommandResult = Commands['chat_v2_upsert_streaming_block']['result'];
export type ChatV2WakeSessionCommandArgs = Commands['chat_v2_wake_session']['args'];
export type ChatV2WakeSessionCommandResult = Commands['chat_v2_wake_session']['result'];
export type RebuildChatFtsCommandArgs = Commands['rebuild_chat_fts']['args'];
export type RebuildChatFtsCommandResult = Commands['rebuild_chat_fts']['result'];
export type WorkspaceCancelAgentCommandArgs = Commands['workspace_cancel_agent']['args'];
export type WorkspaceCancelAgentCommandResult = Commands['workspace_cancel_agent']['result'];
export type WorkspaceCancelSleepCommandArgs = Commands['workspace_cancel_sleep']['args'];
export type WorkspaceCancelSleepCommandResult = Commands['workspace_cancel_sleep']['result'];
export type WorkspaceCloseCommandArgs = Commands['workspace_close']['args'];
export type WorkspaceCloseCommandResult = Commands['workspace_close']['result'];
export type WorkspaceCreateCommandArgs = Commands['workspace_create']['args'];
export type WorkspaceCreateCommandResult = Commands['workspace_create']['result'];
export type WorkspaceCreateAgentCommandArgs = Commands['workspace_create_agent']['args'];
export type WorkspaceCreateAgentCommandResult = Commands['workspace_create_agent']['result'];
export type WorkspaceDeleteCommandArgs = Commands['workspace_delete']['args'];
export type WorkspaceDeleteCommandResult = Commands['workspace_delete']['result'];
export type WorkspaceDeleteAgentProfileFileCommandArgs = Commands['workspace_delete_agent_profile_file']['args'];
export type WorkspaceDeleteAgentProfileFileCommandResult = Commands['workspace_delete_agent_profile_file']['result'];
export type WorkspaceGetCommandArgs = Commands['workspace_get']['args'];
export type WorkspaceGetCommandResult = Commands['workspace_get']['result'];
export type WorkspaceGetContextCommandArgs = Commands['workspace_get_context']['args'];
export type WorkspaceGetContextCommandResult = Commands['workspace_get_context']['result'];
export type WorkspaceGetDocumentCommandArgs = Commands['workspace_get_document']['args'];
export type WorkspaceGetDocumentCommandResult = Commands['workspace_get_document']['result'];
export type WorkspaceListAgentProfilesCommandArgs = Commands['workspace_list_agent_profiles']['args'];
export type WorkspaceListAgentProfilesCommandResult = Commands['workspace_list_agent_profiles']['result'];
export type WorkspaceListAgentsCommandArgs = Commands['workspace_list_agents']['args'];
export type WorkspaceListAgentsCommandResult = Commands['workspace_list_agents']['result'];
export type WorkspaceListAllCommandArgs = Commands['workspace_list_all']['args'];
export type WorkspaceListAllCommandResult = Commands['workspace_list_all']['result'];
export type WorkspaceListDocumentsCommandArgs = Commands['workspace_list_documents']['args'];
export type WorkspaceListDocumentsCommandResult = Commands['workspace_list_documents']['result'];
export type WorkspaceListMessagesCommandArgs = Commands['workspace_list_messages']['args'];
export type WorkspaceListMessagesCommandResult = Commands['workspace_list_messages']['result'];
export type WorkspaceManualWakeCommandArgs = Commands['workspace_manual_wake']['args'];
export type WorkspaceManualWakeCommandResult = Commands['workspace_manual_wake']['result'];
export type WorkspaceReadAgentProfileFileCommandArgs = Commands['workspace_read_agent_profile_file']['args'];
export type WorkspaceReadAgentProfileFileCommandResult = Commands['workspace_read_agent_profile_file']['result'];
export type WorkspaceRestoreExecutionsCommandArgs = Commands['workspace_restore_executions']['args'];
export type WorkspaceRestoreExecutionsCommandResult = Commands['workspace_restore_executions']['result'];
export type WorkspaceRunAgentCommandArgs = Commands['workspace_run_agent']['args'];
export type WorkspaceRunAgentCommandResult = Commands['workspace_run_agent']['result'];
export type WorkspaceSaveAgentProfileFileCommandArgs = Commands['workspace_save_agent_profile_file']['args'];
export type WorkspaceSaveAgentProfileFileCommandResult = Commands['workspace_save_agent_profile_file']['result'];
export type WorkspaceSendMessageCommandArgs = Commands['workspace_send_message']['args'];
export type WorkspaceSendMessageCommandResult = Commands['workspace_send_message']['result'];
export type WorkspaceSetContextCommandArgs = Commands['workspace_set_context']['args'];
export type WorkspaceSetContextCommandResult = Commands['workspace_set_context']['result'];
