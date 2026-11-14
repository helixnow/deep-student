// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L02-llm-manager.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_core::llm_config::ApiConfig */
export type ApiConfig = {
  id: string;
  name: string;
  vendorId: string | null;
  vendorName: string | null;
  providerType: string | null;
  providerScope: string | null;
  authMode: string | null;
  apiProtocol: string | null;
  supportsOpenaiResponses: boolean | null;
  apiKey: string;
  baseUrl: string;
  model: string;
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  isImageGeneration: boolean;
  enabled: boolean;
  modelAdapter: string;
  maxOutputTokens: number;
  temperature: number;
  supportsTools: boolean;
  geminiApiVersion: string;
  isBuiltin: boolean;
  isReadOnly: boolean;
  reasoningEffort: string | null;
  reasoningMode: string | null;
  thinkingEnabled: boolean;
  thinkingBudget: number | null;
  includeThoughts: boolean;
  minP: number | null;
  topK: number | null;
  enableThinking: boolean | null;
  supportsReasoning: boolean;
  headers: { [key: string]: string } | null;
  topPOverride: number | null;
  frequencyPenaltyOverride: number | null;
  presencePenaltyOverride: number | null;
  repetitionPenalty: number | null;
  reasoningSplit: boolean | null;
  effort: string | null;
  verbosity: string | null;
  isFavorite: boolean;
  maxTokensLimit: number | null;
  contextWindow: number | null;
  extraBody: { [key: string]: unknown } | null;
  resolvedAdapterId: string | null;
};
/** dstu_core::llm_config::ApiConfig */
export type ApiConfig__De = {
  id: string;
  name: string;
  vendorId?: string | null;
  vendorName?: string | null;
  providerType?: string | null;
  providerScope?: string | null;
  authMode?: string | null;
  apiProtocol?: string | null;
  supportsOpenaiResponses?: boolean | null;
  apiKey: string;
  baseUrl: string;
  model: string;
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  isImageGeneration?: boolean;
  enabled: boolean;
  modelAdapter?: string;
  maxOutputTokens?: number;
  temperature?: number;
  supports_tools?: boolean;
  supportsTools?: boolean;
  geminiApiVersion?: string;
  isBuiltin?: boolean;
  isReadOnly?: boolean;
  reasoningEffort?: string | null;
  reasoningMode?: string | null;
  thinkingEnabled?: boolean;
  thinkingBudget?: number | null;
  includeThoughts?: boolean;
  minP?: number | null;
  topK?: number | null;
  enableThinking?: boolean | null;
  supportsReasoning?: boolean;
  headers?: { [key: string]: string } | null;
  topPOverride?: number | null;
  frequencyPenaltyOverride?: number | null;
  presencePenaltyOverride?: number | null;
  repetitionPenalty?: number | null;
  reasoningSplit?: boolean | null;
  effort?: string | null;
  verbosity?: string | null;
  isFavorite?: boolean;
  maxTokensLimit?: number | null;
  context_window?: number | null;
  contextWindow?: number | null;
  extraBody?: { [key: string]: unknown } | null;
};
/** dstu_tutor::translation::chat_popover::ChatTranslationEvent */
export type ChatTranslationEvent = {
  type: "chunk";
  delta: string;
  accumulated?: string | null;
} | {
  type: "complete";
} | {
  type: "error";
  message: string;
} | {
  type: "cancelled";
};
/** dstu_tutor::translation::chat_popover::ChatTranslationRequest */
export type ChatTranslationRequest = {
  request_id: string;
  source: string;
  src_lang: string;
  tgt_lang: string;
  context_before?: string | null;
  context_after?: string | null;
};
/** deep_student_lib::commands::ConnectionTestOutcome */
export type ConnectionTestOutcome = {
  ok: boolean;
  latencyMs: number;
  category?: string | null;
  message?: string | null;
  warning?: string | null;
};
/** deep_student_lib::commands::EstimateTokensRequest */
export type EstimateTokensRequest = {
  model?: string | null;
  texts: string[];
};
/** dstu_llm::llm_manager::routing::FailoverPolicy */
export type FailoverPolicy = {
  enabled: boolean;
  autoDegradeChat: boolean;
  defaultFallbacks: string[];
  taskFallbacks: { [key: string]: string[] };
  purposeModels: { [key: string]: string };
  keyCooldownSecs: number;
  rateLimitBackoffMs: number;
};
/** dstu_llm::llm_manager::routing::FailoverPolicy */
export type FailoverPolicy__De = {
  enabled?: boolean;
  autoDegradeChat?: boolean;
  defaultFallbacks?: string[];
  taskFallbacks?: { [key: string]: string[] };
  purposeModels?: { [key: string]: string };
  keyCooldownSecs?: number;
  rateLimitBackoffMs?: number;
};
/** deep_student_lib::commands::FetchedVendorModel */
export type FetchedVendorModel = {
  id: string;
  label: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
};
/** dstu_tutor::essay_grading::types::GradingStreamCancelled */
export type GradingStreamCancelled = {
  type: string;
};
/** dstu_tutor::essay_grading::types::GradingStreamComplete */
export type GradingStreamComplete = {
  type: string;
  round_id: string;
  grading_result: string;
  overall_score: number | null;
  parsed_score: string | null;
  created_at: string;
};
/** dstu_tutor::essay_grading::types::GradingStreamData */
export type GradingStreamData = {
  type: string;
  chunk: string;
  char_count: number;
};
/** dstu_tutor::essay_grading::types::GradingStreamError */
export type GradingStreamError = {
  type: string;
  message: string;
};
/** dstu_tutor::essay_grading::types::GradingStreamProgress */
export type GradingStreamProgress = {
  type: string;
  stage: string;
  char_count: number;
};
/** dstu_core::models::ModelAssignments */
export type ModelAssignments = {
  model2_config_id: string | null;
  review_analysis_model_config_id: string | null;
  anki_card_model_config_id: string | null;
  qbank_ai_grading_model_config_id: string | null;
  qbank_ai_generation_model_config_id: string | null;
  embedding_model_config_id: string | null;
  reranker_model_config_id: string | null;
  chat_title_model_config_id: string | null;
  exam_sheet_ocr_model_config_id: string | null;
  translation_model_config_id: string | null;
  vl_embedding_model_config_id: string | null;
  vl_reranker_model_config_id: string | null;
  memory_decision_model_config_id: string | null;
  voice_input_asr_model_config_id: string | null;
  image_generation_model_config_id: string | null;
  compaction_model_config_id: string | null;
  translation_display_mode: string | null;
};
/** dstu_core::models::ModelAssignments */
export type ModelAssignments__De = {
  model2_config_id?: string | null;
  review_analysis_model_config_id?: string | null;
  anki_card_model_config_id?: string | null;
  qbank_ai_grading_model_config_id?: string | null;
  qbank_ai_generation_model_config_id?: string | null;
  embedding_model_config_id?: string | null;
  reranker_model_config_id?: string | null;
  chat_title_model_config_id?: string | null;
  exam_sheet_ocr_model_config_id?: string | null;
  translation_model_config_id?: string | null;
  vl_embedding_model_config_id?: string | null;
  vl_reranker_model_config_id?: string | null;
  memory_decision_model_config_id?: string | null;
  voice_input_asr_model_config_id?: string | null;
  image_generation_model_config_id?: string | null;
  compaction_model_config_id?: string | null;
  translation_display_mode?: string | null;
};
/** dstu_llm::llm_manager::ModelProfile */
export type ModelProfile = {
  id: string;
  vendorId: string;
  label: string;
  model: string;
  providerScope: string | null;
  apiProtocol: string | null;
  modelAdapter: string;
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  isImageGeneration: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  status: string;
  enabled: boolean;
  maxOutputTokens: number;
  temperature: number;
  reasoningEffort: string | null;
  reasoningMode: string | null;
  thinkingEnabled: boolean;
  thinkingBudget: number | null;
  includeThoughts: boolean;
  enableThinking: boolean | null;
  minP: number | null;
  topK: number | null;
  geminiApiVersion: string | null;
  isBuiltin: boolean;
  repetitionPenalty: number | null;
  reasoningSplit: boolean | null;
  effort: string | null;
  verbosity: string | null;
  isFavorite: boolean;
  maxTokensLimit: number | null;
  contextWindow: number | null;
  extraBody: { [key: string]: unknown } | null;
};
/** dstu_llm::llm_manager::ModelProfile */
export type ModelProfile__De = {
  id: string;
  vendorId: string;
  label: string;
  model: string;
  providerScope?: string | null;
  apiProtocol?: string | null;
  modelAdapter?: string;
  isMultimodal?: boolean;
  isReasoning?: boolean;
  isEmbedding?: boolean;
  isReranker?: boolean;
  isImageGeneration?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  status?: string;
  enabled?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: string | null;
  reasoningMode?: string | null;
  thinkingEnabled?: boolean;
  thinkingBudget?: number | null;
  includeThoughts?: boolean;
  enableThinking?: boolean | null;
  minP?: number | null;
  topK?: number | null;
  geminiApiVersion?: string | null;
  isBuiltin?: boolean;
  repetitionPenalty?: number | null;
  reasoningSplit?: boolean | null;
  effort?: string | null;
  verbosity?: string | null;
  isFavorite?: boolean;
  maxTokensLimit?: number | null;
  context_window?: number | null;
  contextWindow?: number | null;
  extraBody?: { [key: string]: unknown } | null;
};
/** dstu_llm::llm_manager::opencode_go::OpenCodeGoUsage */
export type OpenCodeGoUsage = {
  windows: OpenCodeGoUsageWindow[];
};
/** dstu_llm::llm_manager::opencode_go::OpenCodeGoUsageWindow */
export type OpenCodeGoUsageWindow = {
  window: string;
  usedPercent: number;
  resetsAtMs: number | null;
};
/** dstu_tutor::translation::types::TranslationCandidate */
export type TranslationCandidate = {
  index: number;
  label: string;
  text: string;
  error?: string | null;
};
/** dstu_tutor::translation::types::TranslationCandidatesEvent */
export type TranslationCandidatesEvent = {
  type: "candidate_data";
  candidate_index: number;
  label: string;
  delta: string;
} | {
  type: "candidate_complete";
  candidate_index: number;
  label: string;
  text: string;
} | {
  type: "candidate_error";
  candidate_index: number;
  label: string;
  message: string;
  code?: string | null;
} | {
  type: "complete";
  candidates: TranslationCandidate[];
  detected_lang?: string | null;
} | {
  type: "cancelled";
} | {
  type: "error";
  message: string;
  code?: string | null;
};
/** dstu_tutor::translation::types::TranslationCandidatesResponse */
export type TranslationCandidatesResponse = {
  session_id: string;
  candidates: TranslationCandidate[];
  detected_lang?: string | null;
  cancelled: boolean;
  created_at: string;
};
/** dstu_translation_core::wire::TranslationEvent */
export type TranslationEvent = {
  type: "data";
  chunk: string;
  delta: string;
  char_count: number;
  word_count: number;
  detected_lang?: string | null;
  segment_index?: number | null;
  segment_total?: number | null;
} | {
  type: "complete";
  id: string;
  translated_text: string;
  created_at: string;
  detected_lang?: string | null;
} | {
  type: "error";
  message: string;
  code: string;
  retriable: boolean;
} | {
  type: "cancelled";
};
/** dstu_translation_core::wire::TranslationRequest */
export type TranslationRequest = {
  text: string;
  src_lang: string;
  tgt_lang: string;
  session_id: string;
  prompt_override?: string | null;
  formality?: string | null;
  domain?: string | null;
  glossary?: [string, string][] | null;
};
/** dstu_translation_core::wire::TranslationResponse */
export type TranslationResponse = {
  id: string;
  translated_text: string;
  created_at: string;
  session_id: string;
};
/** dstu_tutor::translation::types::TranslationStreamCancelled */
export type TranslationStreamCancelled = {
  type: string;
};
/** dstu_tutor::translation::types::TranslationStreamComplete */
export type TranslationStreamComplete = {
  type: string;
  id: string;
  translated_text: string;
  created_at: string;
  detected_lang?: string | null;
};
/** dstu_tutor::translation::types::TranslationStreamData */
export type TranslationStreamData = {
  type: string;
  chunk: string;
  delta: string;
  char_count: number;
  word_count: number;
  detected_lang?: string | null;
  segment_index?: number | null;
  segment_total?: number | null;
};
/** dstu_tutor::translation::types::TranslationStreamError */
export type TranslationStreamError = {
  type: string;
  message: string;
  code?: string | null;
  retriable?: boolean | null;
};
/** dstu_llm::llm_manager::VendorConfig */
export type VendorConfig = {
  id: string;
  name: string;
  providerType: string;
  authMode: string | null;
  apiProtocol: string | null;
  supportsOpenaiResponses: boolean | null;
  baseUrl: string;
  apiKey: string;
  apiKeys: string[];
  headers: { [key: string]: string };
  rateLimitPerMinute: number | null;
  defaultTimeoutMs: number | null;
  notes: string | null;
  isBuiltin: boolean;
  isReadOnly: boolean;
  sortOrder: number | null;
  maxTokensLimit: number | null;
  websiteUrl: string | null;
};
/** dstu_llm::llm_manager::VendorConfig */
export type VendorConfig__De = {
  id: string;
  name: string;
  providerType: string;
  authMode?: string | null;
  apiProtocol?: string | null;
  supportsOpenaiResponses?: boolean | null;
  baseUrl: string;
  apiKey: string;
  apiKeys?: string[];
  headers?: { [key: string]: string };
  rateLimitPerMinute?: number | null;
  defaultTimeoutMs?: number | null;
  notes?: string | null;
  isBuiltin?: boolean;
  isReadOnly?: boolean;
  sortOrder?: number | null;
  maxTokensLimit?: number | null;
  websiteUrl?: string | null;
};

export interface Commands {
  /** src/commands.rs:4051 `call_llm_for_boundary` */
  call_llm_for_boundary: {
    args: {
      prompt: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:341 `cancel_stream` */
  cancel_stream: {
    args: {
      streamEventName: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/translation/candidates.rs:33 `cancel_translation_candidates` */
  cancel_translation_candidates: {
    args: {
      sessionId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** crates/dstu-llm/src/config_recovery.rs:192 `check_api_config_status` */
  check_api_config_status: {
    args: Record<string, never>;
    result: unknown;
    error: string;
  };
  /** src/commands.rs:316 `estimate_tokens` */
  estimate_tokens: {
    args: {
      request: EstimateTokensRequest;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:3106 `fetch_vendor_models` */
  fetch_vendor_models: {
    args: {
      vendorId: string;
    };
    result: FetchedVendorModel[];
    error: Shared.AppError;
  };
  /** src/commands.rs:2127 `get_api_configurations` */
  get_api_configurations: {
    args: Record<string, never>;
    result: ApiConfig[];
    error: Shared.AppError;
  };
  /** src/commands.rs:6913 `get_injection_budget_config` */
  get_injection_budget_config: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:2175 `get_model_assignments` */
  get_model_assignments: {
    args: Record<string, never>;
    result: ModelAssignments;
    error: Shared.AppError;
  };
  /** src/commands.rs:2206 `get_model_profiles` */
  get_model_profiles: {
    args: Record<string, never>;
    result: ModelProfile[];
    error: Shared.AppError;
  };
  /** src/commands.rs:2193 `get_vendor_configs` */
  get_vendor_configs: {
    args: Record<string, never>;
    result: VendorConfig[];
    error: Shared.AppError;
  };
  /** crates/dstu-llm/src/llm_manager/routing.rs:781 `llm_get_failover_policy` */
  llm_get_failover_policy: {
    args: Record<string, never>;
    result: FailoverPolicy;
    error: Shared.AppError;
  };
  /** crates/dstu-llm/src/llm_manager/routing.rs:789 `llm_set_failover_policy` */
  llm_set_failover_policy: {
    args: {
      policy: FailoverPolicy__De;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/translation.rs:90 `ocr_extract_text` */
  ocr_extract_text: {
    args: {
      imagePath?: string | null;
      imageBase64?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:3311 `opencode_go_get_usage` */
  opencode_go_get_usage: {
    args: {
      vendorId?: string | null;
    };
    result: OpenCodeGoUsage;
    error: Shared.AppError;
  };
  /** crates/dstu-llm/src/config_recovery.rs:166 `restore_default_api_configs` */
  restore_default_api_configs: {
    args: Record<string, never>;
    result: string;
    error: string;
  };
  /** src/commands.rs:2149 `save_api_configurations` */
  save_api_configurations: {
    args: {
      configs: ApiConfig__De[];
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:2182 `save_model_assignments` */
  save_model_assignments: {
    args: {
      assignments: ModelAssignments__De;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:2211 `save_model_profiles` */
  save_model_profiles: {
    args: {
      profiles: ModelProfile__De[];
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:2198 `save_vendor_configs` */
  save_vendor_configs: {
    args: {
      configs: VendorConfig__De[];
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:6927 `simulate_budget_allocation` */
  simulate_budget_allocation: {
    args: {
      testItems: unknown[];
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/translation/chat_popover.rs:16 `stream_chat_translation_aligned` */
  stream_chat_translation_aligned: {
    args: {
      request: ChatTranslationRequest;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/translation/chat_popover.rs:26 `stream_chat_translation_plain` */
  stream_chat_translation_plain: {
    args: {
      request: ChatTranslationRequest;
    };
    result: null;
    error: Shared.AppError;
  };
  /** host/plugins/llm/src/plugin.ts */
  test_deepseek_capability: {
    args: {
      capability: "chat_search" | "chat_read_url" | "chat_files" | "chat_safety" | "search" | "fetch" | "ocr" | "asr";
      image?: string;
      audio?: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/commands.rs:3321 `test_api_connection` */
  test_api_connection: {
    args: {
      apiKey: string;
      apiBase: string;
      apiProtocol?: string | null;
      supportsOpenaiResponses?: boolean | null;
      providerType?: string | null;
      providerScope?: string | null;
      authMode?: string | null;
      modelAdapter?: string | null;
      model?: string | null;
      vendorId?: string | null;
      headers?: { [key: string]: string } | null;
      isEmbedding?: boolean | null;
      isReranker?: boolean | null;
      isImageGeneration?: boolean | null;
      isReasoning?: boolean | null;
      supportsReasoning?: boolean | null;
      enableThinking?: boolean | null;
      thinkingBudget?: number | null;
      includeThoughts?: boolean | null;
      reasoningEffort?: string | null;
      reasoningMode?: string | null;
      maxOutputTokens?: number | null;
      maxTokensLimit?: number | null;
      geminiApiVersion?: string | null;
    };
    result: ConnectionTestOutcome;
    error: Shared.AppError;
  };
  /** src/translation/candidates.rs:21 `translate_text_candidates` */
  translate_text_candidates: {
    args: {
      request: TranslationRequest;
      numCandidates?: number | null;
    };
    result: TranslationCandidatesResponse;
    error: Shared.AppError;
  };
  /** src/translation/mod.rs:35 `translate_text_stream` */
  translate_text_stream: {
    args: {
      request: TranslationRequest;
    };
    result: TranslationResponse | null;
    error: Shared.AppError;
  };
}

export interface Events {
  [name: `chat_translation_${string}`]: ChatTranslationEvent;
  "chat_v2://model_assignments_changed": {
    action: string;
    slot: string;
  };
  "chat_v2://model_profiles_changed": {
    action: string;
    vendor_id: string;
    profile_id: string;
  };
  "chat_v2://settings_changed": {
    action: string;
    key: string;
  };
  "chat_v2_llm_request_body": {
    streamEvent: string;
    messageId: string | null;
    model: string;
    url: string;
    requestBody: unknown;
    logFilePath: string | null;
  };
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
  "deepseek_ocr_log": {
    level: string;
    stage: string;
    page_index: number;
    message: string;
    data: unknown | null;
  };
  [name: `essay_grading_stream_${string}`]: (GradingStreamCancelled | GradingStreamComplete | GradingStreamData | GradingStreamError | GradingStreamProgress);
  "llm-failover": {
    task: string;
    kind: string;
    from_config_id: string;
    from_model: string;
    to_config_id: string;
    to_model: string;
    reason: string;
    attempt: number;
    total: number;
    user_pinned: boolean;
    temporary: boolean;
  };
  "mcp-bridge-tools-request": {
    correlationId: string;
  };
  "stream_error": {
    error: string;
    stream_event: string;
    timestamp: string;
  };
  [name: `translation_candidates_${string}`]: TranslationCandidatesEvent;
  [name: `translation_stream_${string}`]: (TranslationEvent | TranslationStreamCancelled | TranslationStreamComplete | TranslationStreamData | TranslationStreamError);
  [name: `${string}_cancelled`]: {
    id: string;
    reason: string;
    timestamp: string;
  };
  [name: `${string}_error`]: ({
    error: string;
    stream_event: string;
    timestamp: string;
  } | unknown);
  [name: `${string}_id`]: {
    request_id: string;
    stream_event: string;
    timestamp: string;
  };
  [name: `${string}_memory_sources`]: {
    sources: unknown[];
    tool_name: string;
    timestamp: string;
  } | {
    stage: string;
  };
  [name: `${string}_rag_sources`]: {
    sources: unknown[];
    tool_name: string;
    timestamp: string;
  };
  [name: `${string}_reasoning`]: unknown;
  [name: `${string}_safety_blocked`]: unknown;
  [name: `${string}_start`]: {
    id: string;
    model: string;
    request_bytes: number;
  };
  [name: `${string}_truncated`]: {
    reason: string;
    error: string;
    content_len: number;
    reasoning_len: number;
    chunk_count: number;
    stream_event: string;
    timestamp: string;
  };
  [name: `${string}_usage`]: unknown;
  [name: `${string}_web_search`]: {
    sources: unknown[];
    stage: string;
    tool_name: string;
  } | {
    sources: unknown[];
    tool_name: string;
    timestamp: string;
  } | {
    sources: unknown;
    stage: string;
    tool_name: string;
  };
}

export type CommandName = keyof Commands;
export type CallLlmForBoundaryCommandArgs = Commands['call_llm_for_boundary']['args'];
export type CallLlmForBoundaryCommandResult = Commands['call_llm_for_boundary']['result'];
export type CancelStreamCommandArgs = Commands['cancel_stream']['args'];
export type CancelStreamCommandResult = Commands['cancel_stream']['result'];
export type CancelTranslationCandidatesCommandArgs = Commands['cancel_translation_candidates']['args'];
export type CancelTranslationCandidatesCommandResult = Commands['cancel_translation_candidates']['result'];
export type CheckApiConfigStatusCommandArgs = Commands['check_api_config_status']['args'];
export type CheckApiConfigStatusCommandResult = Commands['check_api_config_status']['result'];
export type EstimateTokensCommandArgs = Commands['estimate_tokens']['args'];
export type EstimateTokensCommandResult = Commands['estimate_tokens']['result'];
export type FetchVendorModelsCommandArgs = Commands['fetch_vendor_models']['args'];
export type FetchVendorModelsCommandResult = Commands['fetch_vendor_models']['result'];
export type GetApiConfigurationsCommandArgs = Commands['get_api_configurations']['args'];
export type GetApiConfigurationsCommandResult = Commands['get_api_configurations']['result'];
export type GetInjectionBudgetConfigCommandArgs = Commands['get_injection_budget_config']['args'];
export type GetInjectionBudgetConfigCommandResult = Commands['get_injection_budget_config']['result'];
export type GetModelAssignmentsCommandArgs = Commands['get_model_assignments']['args'];
export type GetModelAssignmentsCommandResult = Commands['get_model_assignments']['result'];
export type GetModelProfilesCommandArgs = Commands['get_model_profiles']['args'];
export type GetModelProfilesCommandResult = Commands['get_model_profiles']['result'];
export type GetVendorConfigsCommandArgs = Commands['get_vendor_configs']['args'];
export type GetVendorConfigsCommandResult = Commands['get_vendor_configs']['result'];
export type LlmGetFailoverPolicyCommandArgs = Commands['llm_get_failover_policy']['args'];
export type LlmGetFailoverPolicyCommandResult = Commands['llm_get_failover_policy']['result'];
export type LlmSetFailoverPolicyCommandArgs = Commands['llm_set_failover_policy']['args'];
export type LlmSetFailoverPolicyCommandResult = Commands['llm_set_failover_policy']['result'];
export type OcrExtractTextCommandArgs = Commands['ocr_extract_text']['args'];
export type OcrExtractTextCommandResult = Commands['ocr_extract_text']['result'];
export type OpencodeGoGetUsageCommandArgs = Commands['opencode_go_get_usage']['args'];
export type OpencodeGoGetUsageCommandResult = Commands['opencode_go_get_usage']['result'];
export type RestoreDefaultApiConfigsCommandArgs = Commands['restore_default_api_configs']['args'];
export type RestoreDefaultApiConfigsCommandResult = Commands['restore_default_api_configs']['result'];
export type SaveApiConfigurationsCommandArgs = Commands['save_api_configurations']['args'];
export type SaveApiConfigurationsCommandResult = Commands['save_api_configurations']['result'];
export type SaveModelAssignmentsCommandArgs = Commands['save_model_assignments']['args'];
export type SaveModelAssignmentsCommandResult = Commands['save_model_assignments']['result'];
export type SaveModelProfilesCommandArgs = Commands['save_model_profiles']['args'];
export type SaveModelProfilesCommandResult = Commands['save_model_profiles']['result'];
export type SaveVendorConfigsCommandArgs = Commands['save_vendor_configs']['args'];
export type SaveVendorConfigsCommandResult = Commands['save_vendor_configs']['result'];
export type SimulateBudgetAllocationCommandArgs = Commands['simulate_budget_allocation']['args'];
export type SimulateBudgetAllocationCommandResult = Commands['simulate_budget_allocation']['result'];
export type StreamChatTranslationAlignedCommandArgs = Commands['stream_chat_translation_aligned']['args'];
export type StreamChatTranslationAlignedCommandResult = Commands['stream_chat_translation_aligned']['result'];
export type StreamChatTranslationPlainCommandArgs = Commands['stream_chat_translation_plain']['args'];
export type StreamChatTranslationPlainCommandResult = Commands['stream_chat_translation_plain']['result'];
export type TestDeepseekCapabilityCommandArgs = Commands['test_deepseek_capability']['args'];
export type TestDeepseekCapabilityCommandResult = Commands['test_deepseek_capability']['result'];
export type TestApiConnectionCommandArgs = Commands['test_api_connection']['args'];
export type TestApiConnectionCommandResult = Commands['test_api_connection']['result'];
export type TranslateTextCandidatesCommandArgs = Commands['translate_text_candidates']['args'];
export type TranslateTextCandidatesCommandResult = Commands['translate_text_candidates']['result'];
export type TranslateTextStreamCommandArgs = Commands['translate_text_stream']['args'];
export type TranslateTextStreamCommandResult = Commands['translate_text_stream']['result'];
