// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L16-anki.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_core::models::AnkiCard */
export type AnkiCard__De = {
  front?: string;
  back?: string;
  text?: string | null;
  tags?: string[];
  images?: string[];
  id?: string;
  task_id?: string;
  is_error_card?: boolean;
  error_content?: string | null;
  created_at?: string;
  updated_at?: string;
  extra_fields?: { [key: string]: string };
  template_id?: string | null;
};
/** dstu_core::models::AnkiDocumentGenerationRequest */
export type AnkiDocumentGenerationRequest = {
  document_content: string;
  original_document_name?: string | null;
  options?: AnkiGenerationOptions | null;
};
/** dstu_core::models::AnkiDocumentGenerationResponse */
export type AnkiDocumentGenerationResponse = {
  success: boolean;
  cards: Shared.AnkiCard[];
  error_message: string | null;
};
/** dstu_core::models::AnkiGenerationOptions */
export type AnkiGenerationOptions = {
  source_ref?: unknown | null;
  deck_name: string;
  note_type: string;
  enable_images: boolean;
  max_cards_per_mistake: number;
  max_cards_total?: number | null;
  max_tokens?: number | null;
  temperature?: number | null;
  max_output_tokens_override?: number | null;
  temperature_override?: number | null;
  template_id?: string | null;
  custom_anki_prompt?: string | null;
  template_fields?: string[] | null;
  field_extraction_rules?: { [key: string]: FieldExtractionRule__De } | null;
  template_fields_by_id?: { [key: string]: string[] } | null;
  field_extraction_rules_by_id?: { [key: string]: { [key: string]: FieldExtractionRule__De } } | null;
  custom_requirements?: string | null;
  segment_overlap_size?: number;
  system_prompt?: string | null;
  template_ids?: string[] | null;
  template_descriptions?: TemplateDescription[] | null;
  enable_llm_boundary_detection?: boolean | null;
  fsrs_feedback?: boolean | null;
  user_review_profile?: string | null;
  output_protocol?: string | null;
  enable_qa_pass?: boolean | null;
  enable_critic_pass?: boolean | null;
  enable_llm_critic?: boolean | null;
  critic_token_budget?: number | null;
  sidekick_model_routing?: string | null;
};
/** dstu_anki::anki_connect_service::AnkiSyncModelError */
export type AnkiSyncModelError = {
  model: string;
  error: string;
};
/** dstu_anki::anki_connect_service::AnkiSyncReport */
export type AnkiSyncReport = {
  noteIds: (number | null)[];
  added: number;
  duplicates: number;
  failed: number;
  createdModels: string[];
  modelErrors?: AnkiSyncModelError[];
  warnings?: string[];
};
/** dstu_anki::apkg_exporter_service::ApkgExportReport */
export type ApkgExportReport = {
  exportedMedia: number;
  missingMedia?: string[];
  warnings?: string[];
};
/** dstu_anki::apkg_importer_service::ApkgImportResult */
export type ApkgImportResult = {
  documentId: string;
  importedCards: number;
  importedTemplates: number;
  mediaSkipped: number;
  mediaImported: number;
  mediaReport?: ApkgMediaReport;
  warnings?: string[];
  reviewEnqueue?: ApkgReviewEnqueueReport | null;
};
/** dstu_anki::apkg_importer_service::ApkgMediaReport */
export type ApkgMediaReport = {
  declared: number;
  imported: number;
  skipped: number;
  skips?: ApkgMediaSkip[];
  mediaDir?: string | null;
};
/** dstu_anki::apkg_importer_service::ApkgMediaSkip */
export type ApkgMediaSkip = {
  reason: string;
  count: number;
  filenames?: string[];
};
/** dstu_anki::apkg_importer_service::ApkgReviewEnqueueReport */
export type ApkgReviewEnqueueReport = {
  enqueued: number;
  withHistory: number;
  suspended: number;
};
/** deep_student_lib::cmd::anki_connect::BatchExportNote */
export type BatchExportNote = {
  fields: { [key: string]: string };
  tags?: string[];
  images?: string[];
};
/** deep_student_lib::cmd::anki_connect::BatchExportOptions */
export type BatchExportOptions = {
  deckName?: string | null;
  deck_name?: string | null;
  noteType?: string | null;
  note_type?: string | null;
  templateId?: string | null;
  template_id?: string | null;
};
/** dstu_core::models::CreateTemplateRequest */
export type CreateTemplateRequest = {
  name: string;
  description: string;
  author?: string | null;
  version?: string | null;
  preview_front: string;
  preview_back: string;
  note_type: string;
  fields: string[];
  generation_prompt: string;
  front_template: string;
  back_template: string;
  css_style: string;
  field_extraction_rules: { [key: string]: FieldExtractionRule__De };
  preview_data_json?: string | null;
  is_active?: boolean | null;
  is_built_in?: boolean | null;
};
/** dstu_core::models::CustomAnkiTemplate */
export type CustomAnkiTemplate = {
  id: string;
  name: string;
  description: string;
  author: string | null;
  version: string;
  preview_front: string;
  preview_back: string;
  note_type: string;
  fields: string[];
  generation_prompt: string;
  front_template: string;
  back_template: string;
  css_style: string;
  field_extraction_rules: { [key: string]: FieldExtractionRule };
  created_at: string;
  updated_at: string;
  is_active: boolean;
  is_built_in: boolean;
  preview_data_json: string | null;
};
/** dstu_anki::enhanced_anki_service::DocumentStateDto */
export type DocumentStateDto = {
  paused: boolean;
  current_task_id: string | null;
};
/** dstu_anki::enhanced_anki_service::DocumentTaskCountsDto */
export type DocumentTaskCountsDto = {
  pending: number;
  processing: number;
  streaming: number;
  paused: number;
  completed: number;
  failed: number;
  truncated: number;
  cancelled: number;
  total: number;
};
/** dstu_core::models::ExportAnkiCardsRequest */
export type ExportAnkiCardsRequest = {
  ids: string[];
  format: string;
  deckName?: string | null;
  noteType?: string | null;
  templateId?: string | null;
};
/** dstu_core::models::ExportAnkiCardsResponse */
export type ExportAnkiCardsResponse = {
  filePath: string;
  sizeBytes: number;
  format: string;
};
/** deep_student_lib::cmd::anki_connect::ExportMultiTemplateApkgResult */
export type ExportMultiTemplateApkgResult = {
  path: string;
  report: ApkgExportReport;
};
/** dstu_core::models::FieldExtractionRule */
export type FieldExtractionRule = {
  field_type: FieldType;
  is_required: boolean;
  default_value: string | null;
  validation_pattern: string | null;
  description: string;
  validation?: ValidationRule | null;
  transform?: TransformRule | null;
  schema?: ObjectSchema | null;
  item_schema?: ObjectSchema | null;
  display_format?: string | null;
  ai_hint?: string | null;
  max_length?: number | null;
  min_length?: number | null;
  allowed_values?: unknown[] | null;
  depends_on?: string | null;
  compute_function?: string | null;
};
/** dstu_core::models::FieldExtractionRule */
export type FieldExtractionRule__De = {
  field_type: FieldType__De;
  is_required: boolean;
  default_value?: string | null;
  validation_pattern?: string | null;
  description: string;
  validation?: ValidationRule__De | null;
  transform?: TransformRule__De | null;
  schema?: ObjectSchema__De | null;
  item_schema?: ObjectSchema__De | null;
  display_format?: string | null;
  ai_hint?: string | null;
  max_length?: number | null;
  min_length?: number | null;
  allowed_values?: unknown[] | null;
  depends_on?: string | null;
  compute_function?: string | null;
};
/** dstu_core::models::FieldType */
export type FieldType = "Text" | "Array" | "Number" | "Boolean" | "Date" | "RichText" | "Formula";
/** dstu_core::models::FieldType */
export type FieldType__De = ("Text" | "Array" | "Number" | "Boolean" | "Date" | "RichText" | "Formula") | {
  Text: null;
} | {
  Array: null;
} | {
  Number: null;
} | {
  Boolean: null;
} | {
  Date: null;
} | {
  RichText: null;
} | {
  Formula: null;
};
/** dstu_core::models::ListAnkiCardsRequest */
export type ListAnkiCardsRequest = {
  templateId?: string | null;
  search?: string | null;
  page?: number | null;
  pageSize?: number | null;
  status?: string | null;
  sort?: string | null;
  sortDesc?: boolean | null;
  deck?: string | null;
  includeDecks?: boolean | null;
};
/** dstu_core::models::MemoryCandidate */
export type MemoryCandidate = {
  content: string;
  category: string;
};
/** dstu_core::models::ObjectSchema */
export type ObjectSchema = {
  properties: { [key: string]: FieldExtractionRule };
  required: string[] | null;
};
/** dstu_core::models::ObjectSchema */
export type ObjectSchema__De = {
  properties: { [key: string]: FieldExtractionRule__De };
  required?: string[] | null;
};
/** deep_student_lib::cmd::enhanced_anki::PendingMemoryCandidatesResponse */
export type PendingMemoryCandidatesResponse = {
  conversation_id: string;
  subject: string;
  candidates: MemoryCandidate[];
  created_at: string;
};
/** deep_student_lib::cmd::anki_connect::SaveAnkiCardFailure */
export type SaveAnkiCardFailure = {
  id: string;
  error: string;
};
/** deep_student_lib::cmd::anki_connect::SaveAnkiCardIdMapping */
export type SaveAnkiCardIdMapping = {
  inputIndex: number;
  inputId: string | null;
  persistedId: string;
};
/** deep_student_lib::cmd::anki_connect::SaveAnkiCardPayload */
export type SaveAnkiCardPayload = {
  id?: string | null;
  front?: string | null;
  back?: string | null;
  text?: string | null;
  tags?: string[] | null;
  images?: string[] | null;
  fields?: { [key: string]: string } | null;
  template_id?: string | null;
};
/** deep_student_lib::cmd::anki_connect::SaveAnkiCardsRequest */
export type SaveAnkiCardsRequest = {
  document_id?: string | null;
  business_session_id?: string | null;
  message_stable_id?: string | null;
  block_id?: string | null;
  template_id?: string | null;
  cards: SaveAnkiCardPayload[];
  options?: AnkiGenerationOptions | null;
};
/** deep_student_lib::cmd::anki_connect::SaveAnkiCardsResponse */
export type SaveAnkiCardsResponse = {
  savedIds: string[];
  taskId: string;
  cardIdMappings: SaveAnkiCardIdMapping[];
  skippedIds: string[];
  duplicatedIds: string[];
  failed: SaveAnkiCardFailure[];
};
/** dstu_core::models::StreamedCardPayload */
export type StreamedCardPayload = {
  NewCard: {
    card: Shared.AnkiCard;
    document_id: string;
  };
} | {
  NewErrorCard: {
    card: Shared.AnkiCard;
    document_id: string;
  };
} | {
  TaskStatusUpdate: {
    task_id: string;
    status: Shared.TaskStatus;
    message: string | null;
    segment_index: number | null;
    document_id: string | null;
  };
} | {
  TaskProcessingError: {
    task_id: string;
    error_message: string;
    document_id: string | null;
  };
} | {
  TaskCompleted: {
    task_id: string;
    final_status: Shared.TaskStatus;
    total_cards_generated: number;
    document_id: string | null;
  };
} | {
  DocumentProcessingStarted: {
    document_id: string;
    total_segments: number;
  };
} | {
  DocumentProcessingPaused: {
    document_id: string;
  };
} | {
  DocumentProcessingCompleted: {
    document_id: string;
  };
} | {
  DocumentProcessingCancelled: {
    document_id: string;
  };
} | {
  RateLimitWarning: {
    message: string;
    retry_after_seconds: number | null;
  };
} | {
  WorkflowFailed: {
    workflow_type: string;
    error_message: string;
    fallback_used: boolean;
  };
};
/** dstu_core::models::TemplateBulkImportRequest */
export type TemplateBulkImportRequest = (unknown | unknown) & (unknown | unknown);
/** dstu_core::models::TemplateDescription */
export type TemplateDescription = {
  id: string;
  name: string;
  description: string;
  fields: string[];
  generation_prompt?: string | null;
};
/** dstu_core::models::TemplateExportResponse */
export type TemplateExportResponse = {
  template_data: string;
};
/** dstu_core::models::TemplateImportRequest */
export type TemplateImportRequest = {
  template_data: string;
  overwrite_existing: boolean;
};
/** dstu_core::models::TransformRule */
export type TransformRule = {
  transform_type: string;
  format: string | null;
  custom_function: string | null;
};
/** dstu_core::models::TransformRule */
export type TransformRule__De = {
  transform_type: string;
  format?: string | null;
  custom_function?: string | null;
};
/** dstu_core::models::UpdateTemplateRequest */
export type UpdateTemplateRequest = {
  name?: string | null;
  description?: string | null;
  author?: string | null;
  version?: string | null;
  expected_version?: string | null;
  preview_front?: string | null;
  preview_back?: string | null;
  note_type?: string | null;
  fields?: string[] | null;
  generation_prompt?: string | null;
  front_template?: string | null;
  back_template?: string | null;
  css_style?: string | null;
  field_extraction_rules?: { [key: string]: FieldExtractionRule__De } | null;
  is_active?: boolean | null;
  preview_data_json?: string | null;
  is_built_in?: boolean | null;
};
/** dstu_core::models::ValidationRule */
export type ValidationRule = {
  pattern: string | null;
  min: number | null;
  max: number | null;
  enum_values: unknown[] | null;
  custom: string | null;
  error_message: string | null;
};
/** dstu_core::models::ValidationRule */
export type ValidationRule__De = {
  pattern?: string | null;
  min?: number | null;
  max?: number | null;
  enum_values?: unknown[] | null;
  custom?: string | null;
  error_message?: string | null;
};

export interface Commands {
  /** src/cmd/anki_connect.rs:226 `add_cards_to_anki_connect` */
  add_cards_to_anki_connect: {
    args: {
      selectedCards: AnkiCard__De[];
      deckName: string;
      noteType: string;
    };
    result: AnkiSyncReport;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:198 `anki_get_deck_names` */
  anki_get_deck_names: {
    args: Record<string, never>;
    result: string[];
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:1323 `batch_export_cards` */
  batch_export_cards: {
    args: {
      notes: BatchExportNote[];
      format: string;
      options: BatchExportOptions;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:140 `cancel_document_processing` */
  cancel_document_processing: {
    args: {
      documentId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** crates/dstu-anki/src/anki_connect_service.rs:308 `check_anki_connect_availability` */
  check_anki_connect_availability: {
    args: Record<string, never>;
    result: boolean;
    error: string;
  };
  /** src/cmd/anki_connect.rs:180 `check_anki_connect_status` */
  check_anki_connect_status: {
    args: Record<string, never>;
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:4465 `count_custom_template_references` */
  count_custom_template_references: {
    args: {
      templateId: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:213 `create_anki_deck` */
  create_anki_deck: {
    args: {
      deckName: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:4303 `create_custom_template` */
  create_custom_template: {
    args: {
      request: CreateTemplateRequest;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:287 `delete_anki_card` */
  delete_anki_card: {
    args: {
      cardId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:4402 `delete_custom_template` */
  delete_custom_template: {
    args: {
      templateId: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:325 `delete_document_session` */
  delete_document_session: {
    args: {
      documentId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:306 `delete_document_task` */
  delete_document_task: {
    args: {
      taskId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:786 `dismiss_pending_memory_candidates` */
  dismiss_pending_memory_candidates: {
    args: {
      conversationId: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:646 `export_anki_cards` */
  export_anki_cards: {
    args: {
      request: ExportAnkiCardsRequest;
    };
    result: ExportAnkiCardsResponse;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:347 `export_apkg_for_selection` */
  export_apkg_for_selection: {
    args: {
      documentId?: string | null;
      taskIds?: string[] | null;
      cardIds?: string[] | null;
      options: AnkiGenerationOptions;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:947 `export_cards_as_apkg` */
  export_cards_as_apkg: {
    args: {
      selectedCards: AnkiCard__De[];
      deckName: string;
      noteType: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:977 `export_cards_as_apkg_with_template` */
  export_cards_as_apkg_with_template: {
    args: {
      selectedCards: AnkiCard__De[];
      deckName: string;
      noteType: string;
      templateId?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:1123 `export_multi_template_apkg` */
  export_multi_template_apkg: {
    args: {
      cards: AnkiCard__De[];
      deckName: string;
      outputPath?: string | null;
    };
    result: ExportMultiTemplateApkgResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:4476 `export_template` */
  export_template: {
    args: {
      templateId: string;
    };
    result: TemplateExportResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:3911 `generate_anki_cards_from_document` */
  generate_anki_cards_from_document: {
    args: {
      request: AnkiDocumentGenerationRequest;
    };
    result: AnkiDocumentGenerationResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:3998 `generate_anki_cards_from_document_base64` */
  generate_anki_cards_from_document_base64: {
    args: {
      fileName: string;
      base64Content: string;
      options?: AnkiGenerationOptions | null;
    };
    result: AnkiDocumentGenerationResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:3950 `generate_anki_cards_from_document_file` */
  generate_anki_cards_from_document_file: {
    args: {
      filePath: string;
      options?: AnkiGenerationOptions | null;
    };
    result: AnkiDocumentGenerationResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:4279 `get_all_custom_templates` */
  get_all_custom_templates: {
    args: Record<string, never>;
    result: CustomAnkiTemplate[];
    error: Shared.AppError;
  };
  /** src/commands.rs:7075 `get_all_recent_cards` */
  get_all_recent_cards: {
    args: {
      limit?: number | null;
    };
    result: Shared.AnkiCard[];
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:189 `get_anki_deck_names` */
  get_anki_deck_names: {
    args: Record<string, never>;
    result: string[];
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:460 `get_anki_library_card_content` */
  get_anki_library_card_content: {
    args: {
      cardId: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:204 `get_anki_model_names` */
  get_anki_model_names: {
    args: Record<string, never>;
    result: string[];
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:612 `get_anki_stats` */
  get_anki_stats: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:4291 `get_custom_template_by_id` */
  get_custom_template_by_id: {
    args: {
      templateId: string;
    };
    result: CustomAnkiTemplate | null;
    error: Shared.AppError;
  };
  /** src/commands.rs:6239 `get_default_template_id` */
  get_default_template_id: {
    args: Record<string, never>;
    result: string | null;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:379 `get_document_cards` */
  get_document_cards: {
    args: {
      documentId: string;
    };
    result: Shared.AnkiCard[];
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:181 `get_document_processing_state` */
  get_document_processing_state: {
    args: {
      documentId: string;
    };
    result: DocumentStateDto;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:195 `get_document_task_counts` */
  get_document_task_counts: {
    args: {
      documentId: string;
    };
    result: DocumentTaskCountsDto;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:229 `get_document_tasks` */
  get_document_tasks: {
    args: {
      documentId: string;
    };
    result: Shared.DocumentTask[];
    error: Shared.AppError;
  };
  /** src/cmd/anki_cards.rs:19 `get_model_adapter_options` */
  get_model_adapter_options: {
    args: Record<string, never>;
    result: unknown[];
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:725 `get_pending_memory_candidates` */
  get_pending_memory_candidates: {
    args: {
      conversationId: string;
    };
    result: PendingMemoryCandidatesResponse | null;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:247 `get_task_cards` */
  get_task_cards: {
    args: {
      taskId: string;
    };
    result: Shared.AnkiCard[];
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:413 `import_anki_package` */
  import_anki_package: {
    args: {
      path: string;
      deleteAfter?: boolean | null;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/apkg_import.rs:81 `import_apkg_to_library` */
  import_apkg_to_library: {
    args: {
      path: string;
    };
    result: ApkgImportResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:4898 `import_builtin_templates` */
  import_builtin_templates: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:4579 `import_custom_templates_bulk` */
  import_custom_templates_bulk: {
    args: {
      request: TemplateBulkImportRequest;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:4504 `import_template` */
  import_template: {
    args: {
      request: TemplateImportRequest;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:477 `list_anki_library_cards` */
  list_anki_library_cards: {
    args: {
      request: ListAnkiCardsRequest;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:559 `list_document_sessions` */
  list_document_sessions: {
    args: {
      limit?: number | null;
    };
    result: unknown[];
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:814 `mark_pending_memory_candidates_saved` */
  mark_pending_memory_candidates_saved: {
    args: {
      conversationId: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:121 `pause_document_processing` */
  pause_document_processing: {
    args: {
      documentId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/apkg_import.rs:306 `read_anki_media` */
  read_anki_media: {
    args: {
      path: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:547 `recover_stuck_document_tasks` */
  recover_stuck_document_tasks: {
    args: Record<string, never>;
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/anki_cards.rs:57 `reset_model_adapter_options` */
  reset_model_adapter_options: {
    args: Record<string, never>;
    result: unknown[];
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:162 `resume_document_processing` */
  resume_document_processing: {
    args: {
      documentId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:925 `save_anki_cards` */
  save_anki_cards: {
    args: {
      request: SaveAnkiCardsRequest;
    };
    result: SaveAnkiCardsResponse;
    error: Shared.AppError;
  };
  /** src/cmd/anki_connect.rs:2145 `save_json_file` */
  save_json_file: {
    args: {
      content: string;
      suggestedName: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/anki_cards.rs:28 `save_model_adapter_options` */
  save_model_adapter_options: {
    args: {
      options: unknown[];
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:6856 `save_template_debug_data` */
  save_template_debug_data: {
    args: {
      debugData: unknown;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:6230 `set_default_template` */
  set_default_template: {
    args: {
      templateId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:623 `set_document_session_source` */
  set_document_session_source: {
    args: {
      documentId: string;
      sessionId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:85 `start_enhanced_document_processing` */
  start_enhanced_document_processing: {
    args: {
      documentContent: string;
      originalDocumentName: string;
      options: AnkiGenerationOptions;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:209 `trigger_task_processing` */
  trigger_task_processing: {
    args: {
      taskId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/enhanced_anki.rs:266 `update_anki_card` */
  update_anki_card: {
    args: {
      card: AnkiCard__De;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:4320 `update_custom_template` */
  update_custom_template: {
    args: {
      templateId: string;
      request: UpdateTemplateRequest;
    };
    result: null;
    error: Shared.AppError;
  };
}

export interface Events {
  "anki_generation_event": (StreamedCardPayload | {
    GenerationStats: {
      task_id: string;
      document_id: string;
      cards_generated: number;
      failed_cards: number;
      duplicate_cards: number;
      dropped_fragments: number;
      flagged_cards: number;
    };
  } | {
    GenerationWarning: {
      task_id: string;
      document_id: string;
      reason: string;
      fragment_preview: string;
    };
  } | unknown);
  "fsrs://changed": ({
    source: string;
    action: string;
    entityIds: string[];
    runId: string;
  } | unknown);
}

export type CommandName = keyof Commands;
export type AddCardsToAnkiConnectCommandArgs = Commands['add_cards_to_anki_connect']['args'];
export type AddCardsToAnkiConnectCommandResult = Commands['add_cards_to_anki_connect']['result'];
export type AnkiGetDeckNamesCommandArgs = Commands['anki_get_deck_names']['args'];
export type AnkiGetDeckNamesCommandResult = Commands['anki_get_deck_names']['result'];
export type BatchExportCardsCommandArgs = Commands['batch_export_cards']['args'];
export type BatchExportCardsCommandResult = Commands['batch_export_cards']['result'];
export type CancelDocumentProcessingCommandArgs = Commands['cancel_document_processing']['args'];
export type CancelDocumentProcessingCommandResult = Commands['cancel_document_processing']['result'];
export type CheckAnkiConnectAvailabilityCommandArgs = Commands['check_anki_connect_availability']['args'];
export type CheckAnkiConnectAvailabilityCommandResult = Commands['check_anki_connect_availability']['result'];
export type CheckAnkiConnectStatusCommandArgs = Commands['check_anki_connect_status']['args'];
export type CheckAnkiConnectStatusCommandResult = Commands['check_anki_connect_status']['result'];
export type CountCustomTemplateReferencesCommandArgs = Commands['count_custom_template_references']['args'];
export type CountCustomTemplateReferencesCommandResult = Commands['count_custom_template_references']['result'];
export type CreateAnkiDeckCommandArgs = Commands['create_anki_deck']['args'];
export type CreateAnkiDeckCommandResult = Commands['create_anki_deck']['result'];
export type CreateCustomTemplateCommandArgs = Commands['create_custom_template']['args'];
export type CreateCustomTemplateCommandResult = Commands['create_custom_template']['result'];
export type DeleteAnkiCardCommandArgs = Commands['delete_anki_card']['args'];
export type DeleteAnkiCardCommandResult = Commands['delete_anki_card']['result'];
export type DeleteCustomTemplateCommandArgs = Commands['delete_custom_template']['args'];
export type DeleteCustomTemplateCommandResult = Commands['delete_custom_template']['result'];
export type DeleteDocumentSessionCommandArgs = Commands['delete_document_session']['args'];
export type DeleteDocumentSessionCommandResult = Commands['delete_document_session']['result'];
export type DeleteDocumentTaskCommandArgs = Commands['delete_document_task']['args'];
export type DeleteDocumentTaskCommandResult = Commands['delete_document_task']['result'];
export type DismissPendingMemoryCandidatesCommandArgs = Commands['dismiss_pending_memory_candidates']['args'];
export type DismissPendingMemoryCandidatesCommandResult = Commands['dismiss_pending_memory_candidates']['result'];
export type ExportAnkiCardsCommandArgs = Commands['export_anki_cards']['args'];
export type ExportAnkiCardsCommandResult = Commands['export_anki_cards']['result'];
export type ExportApkgForSelectionCommandArgs = Commands['export_apkg_for_selection']['args'];
export type ExportApkgForSelectionCommandResult = Commands['export_apkg_for_selection']['result'];
export type ExportCardsAsApkgCommandArgs = Commands['export_cards_as_apkg']['args'];
export type ExportCardsAsApkgCommandResult = Commands['export_cards_as_apkg']['result'];
export type ExportCardsAsApkgWithTemplateCommandArgs = Commands['export_cards_as_apkg_with_template']['args'];
export type ExportCardsAsApkgWithTemplateCommandResult = Commands['export_cards_as_apkg_with_template']['result'];
export type ExportMultiTemplateApkgCommandArgs = Commands['export_multi_template_apkg']['args'];
export type ExportMultiTemplateApkgCommandResult = Commands['export_multi_template_apkg']['result'];
export type ExportTemplateCommandArgs = Commands['export_template']['args'];
export type ExportTemplateCommandResult = Commands['export_template']['result'];
export type GenerateAnkiCardsFromDocumentCommandArgs = Commands['generate_anki_cards_from_document']['args'];
export type GenerateAnkiCardsFromDocumentCommandResult = Commands['generate_anki_cards_from_document']['result'];
export type GenerateAnkiCardsFromDocumentBase64CommandArgs = Commands['generate_anki_cards_from_document_base64']['args'];
export type GenerateAnkiCardsFromDocumentBase64CommandResult = Commands['generate_anki_cards_from_document_base64']['result'];
export type GenerateAnkiCardsFromDocumentFileCommandArgs = Commands['generate_anki_cards_from_document_file']['args'];
export type GenerateAnkiCardsFromDocumentFileCommandResult = Commands['generate_anki_cards_from_document_file']['result'];
export type GetAllCustomTemplatesCommandArgs = Commands['get_all_custom_templates']['args'];
export type GetAllCustomTemplatesCommandResult = Commands['get_all_custom_templates']['result'];
export type GetAllRecentCardsCommandArgs = Commands['get_all_recent_cards']['args'];
export type GetAllRecentCardsCommandResult = Commands['get_all_recent_cards']['result'];
export type GetAnkiDeckNamesCommandArgs = Commands['get_anki_deck_names']['args'];
export type GetAnkiDeckNamesCommandResult = Commands['get_anki_deck_names']['result'];
export type GetAnkiLibraryCardContentCommandArgs = Commands['get_anki_library_card_content']['args'];
export type GetAnkiLibraryCardContentCommandResult = Commands['get_anki_library_card_content']['result'];
export type GetAnkiModelNamesCommandArgs = Commands['get_anki_model_names']['args'];
export type GetAnkiModelNamesCommandResult = Commands['get_anki_model_names']['result'];
export type GetAnkiStatsCommandArgs = Commands['get_anki_stats']['args'];
export type GetAnkiStatsCommandResult = Commands['get_anki_stats']['result'];
export type GetCustomTemplateByIdCommandArgs = Commands['get_custom_template_by_id']['args'];
export type GetCustomTemplateByIdCommandResult = Commands['get_custom_template_by_id']['result'];
export type GetDefaultTemplateIdCommandArgs = Commands['get_default_template_id']['args'];
export type GetDefaultTemplateIdCommandResult = Commands['get_default_template_id']['result'];
export type GetDocumentCardsCommandArgs = Commands['get_document_cards']['args'];
export type GetDocumentCardsCommandResult = Commands['get_document_cards']['result'];
export type GetDocumentProcessingStateCommandArgs = Commands['get_document_processing_state']['args'];
export type GetDocumentProcessingStateCommandResult = Commands['get_document_processing_state']['result'];
export type GetDocumentTaskCountsCommandArgs = Commands['get_document_task_counts']['args'];
export type GetDocumentTaskCountsCommandResult = Commands['get_document_task_counts']['result'];
export type GetDocumentTasksCommandArgs = Commands['get_document_tasks']['args'];
export type GetDocumentTasksCommandResult = Commands['get_document_tasks']['result'];
export type GetModelAdapterOptionsCommandArgs = Commands['get_model_adapter_options']['args'];
export type GetModelAdapterOptionsCommandResult = Commands['get_model_adapter_options']['result'];
export type GetPendingMemoryCandidatesCommandArgs = Commands['get_pending_memory_candidates']['args'];
export type GetPendingMemoryCandidatesCommandResult = Commands['get_pending_memory_candidates']['result'];
export type GetTaskCardsCommandArgs = Commands['get_task_cards']['args'];
export type GetTaskCardsCommandResult = Commands['get_task_cards']['result'];
export type ImportAnkiPackageCommandArgs = Commands['import_anki_package']['args'];
export type ImportAnkiPackageCommandResult = Commands['import_anki_package']['result'];
export type ImportApkgToLibraryCommandArgs = Commands['import_apkg_to_library']['args'];
export type ImportApkgToLibraryCommandResult = Commands['import_apkg_to_library']['result'];
export type ImportBuiltinTemplatesCommandArgs = Commands['import_builtin_templates']['args'];
export type ImportBuiltinTemplatesCommandResult = Commands['import_builtin_templates']['result'];
export type ImportCustomTemplatesBulkCommandArgs = Commands['import_custom_templates_bulk']['args'];
export type ImportCustomTemplatesBulkCommandResult = Commands['import_custom_templates_bulk']['result'];
export type ImportTemplateCommandArgs = Commands['import_template']['args'];
export type ImportTemplateCommandResult = Commands['import_template']['result'];
export type ListAnkiLibraryCardsCommandArgs = Commands['list_anki_library_cards']['args'];
export type ListAnkiLibraryCardsCommandResult = Commands['list_anki_library_cards']['result'];
export type ListDocumentSessionsCommandArgs = Commands['list_document_sessions']['args'];
export type ListDocumentSessionsCommandResult = Commands['list_document_sessions']['result'];
export type MarkPendingMemoryCandidatesSavedCommandArgs = Commands['mark_pending_memory_candidates_saved']['args'];
export type MarkPendingMemoryCandidatesSavedCommandResult = Commands['mark_pending_memory_candidates_saved']['result'];
export type PauseDocumentProcessingCommandArgs = Commands['pause_document_processing']['args'];
export type PauseDocumentProcessingCommandResult = Commands['pause_document_processing']['result'];
export type ReadAnkiMediaCommandArgs = Commands['read_anki_media']['args'];
export type ReadAnkiMediaCommandResult = Commands['read_anki_media']['result'];
export type RecoverStuckDocumentTasksCommandArgs = Commands['recover_stuck_document_tasks']['args'];
export type RecoverStuckDocumentTasksCommandResult = Commands['recover_stuck_document_tasks']['result'];
export type ResetModelAdapterOptionsCommandArgs = Commands['reset_model_adapter_options']['args'];
export type ResetModelAdapterOptionsCommandResult = Commands['reset_model_adapter_options']['result'];
export type ResumeDocumentProcessingCommandArgs = Commands['resume_document_processing']['args'];
export type ResumeDocumentProcessingCommandResult = Commands['resume_document_processing']['result'];
export type SaveAnkiCardsCommandArgs = Commands['save_anki_cards']['args'];
export type SaveAnkiCardsCommandResult = Commands['save_anki_cards']['result'];
export type SaveJsonFileCommandArgs = Commands['save_json_file']['args'];
export type SaveJsonFileCommandResult = Commands['save_json_file']['result'];
export type SaveModelAdapterOptionsCommandArgs = Commands['save_model_adapter_options']['args'];
export type SaveModelAdapterOptionsCommandResult = Commands['save_model_adapter_options']['result'];
export type SaveTemplateDebugDataCommandArgs = Commands['save_template_debug_data']['args'];
export type SaveTemplateDebugDataCommandResult = Commands['save_template_debug_data']['result'];
export type SetDefaultTemplateCommandArgs = Commands['set_default_template']['args'];
export type SetDefaultTemplateCommandResult = Commands['set_default_template']['result'];
export type SetDocumentSessionSourceCommandArgs = Commands['set_document_session_source']['args'];
export type SetDocumentSessionSourceCommandResult = Commands['set_document_session_source']['result'];
export type StartEnhancedDocumentProcessingCommandArgs = Commands['start_enhanced_document_processing']['args'];
export type StartEnhancedDocumentProcessingCommandResult = Commands['start_enhanced_document_processing']['result'];
export type TriggerTaskProcessingCommandArgs = Commands['trigger_task_processing']['args'];
export type TriggerTaskProcessingCommandResult = Commands['trigger_task_processing']['result'];
export type UpdateAnkiCardCommandArgs = Commands['update_anki_card']['args'];
export type UpdateAnkiCardCommandResult = Commands['update_anki_card']['result'];
export type UpdateCustomTemplateCommandArgs = Commands['update_custom_template']['args'];
export type UpdateCustomTemplateCommandResult = Commands['update_custom_template']['result'];
