// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L10-notes.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** deep_student_lib::chat_v2::tools::canvas_executor::CanvasAIEditRequest */
export type CanvasAIEditRequest = {
  requestId: string;
  noteId: string;
  operation: CanvasEditOperation;
  content?: string | null;
  search?: string | null;
  replace?: string | null;
  isRegex?: boolean | null;
  section?: string | null;
};
/** deep_student_lib::chat_v2::tools::canvas_executor::CanvasAIEditResult */
export type CanvasAIEditResult = {
  requestId: string;
  success: boolean;
  error?: string | null;
  affectedCount?: number | null;
  replaceCount?: number | null;
  beforePreview?: string | null;
  afterPreview?: string | null;
  addedContent?: string | null;
};
/** deep_student_lib::chat_v2::tools::canvas_executor::CanvasEditOperation */
export type CanvasEditOperation = "append" | "replace" | "set";
/** dstu_vfs::vfs::repos::note_lease_repo::FrozenDraft */
export type FrozenDraft = {
  markdown: string;
  expected_updated_at: string;
};
/** dstu_notes::notes_exporter::ImportStage */
export type ImportStage = "parsing" | "importing_notes" | "importing_attachments" | "importing_preferences" | "done";
/** dstu_vfs::vfs::repos::note_lease_repo::LeaseCancellation */
export type LeaseCancellation = {
  token: string;
  note_ids: string[];
  reason: string;
};
/** dstu_vfs::vfs::repos::note_lease_repo::LeaseNote */
export type LeaseNote = {
  note_id: string;
  updated_at: string;
};
/** dstu_vfs::vfs::repos::note_lease_repo::LeaseStatus */
export type LeaseStatus = {
  token: string;
  operation_id: string;
  owner_id: string;
  phase: string;
  expires_at: number;
  notes: LeaseNote[];
  waiting_for: string[];
};
/** deep_student_lib::cmd::notes::MentionIrecCardHit */
export type MentionIrecCardHit = {
  id: string;
  title: string;
  insight: string;
  subject: string | null;
  tags: string[];
  mistake_id: string | null;
};
/** deep_student_lib::cmd::notes::MentionMistakeHit */
export type MentionMistakeHit = {
  id: string;
  subject: string;
  title: string;
  summary: string | null;
  tags: string[];
};
/** deep_student_lib::cmd::notes::MentionNoteHit */
export type MentionNoteHit = {
  id: string;
  title: string;
  snippet: string | null;
  tags: string[];
};
/** deep_student_lib::cmd::notes::NewNotePayload */
export type NewNotePayload = {
  title: string;
  content_md: string;
  tags?: string[] | null;
};
/** dstu_vfs::vfs::repos::note_revision_repo::NoteAssetRef */
export type NoteAssetRef = {
  kind: string;
  value: string;
};
/** dstu_vfs::vfs::repos::note_repo::NoteBacklink */
export type NoteBacklink = {
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  alias: string | null;
  position: number;
  sourceUpdatedAt: string;
};
/** deep_student_lib::cmd::notes::NoteFormatStatus */
export type NoteFormatStatus = {
  note_id: string;
  content_format: string;
  format_version: number;
  serializer_version: string;
  baseline_version_id: string | null;
  required_capabilities: string[];
  updated_at: string;
};
/** dstu_vfs::vfs::repos::note_history_restore::NoteHistoryCurrent */
export type NoteHistoryCurrent = {
  content_md: string;
  updated_at: string;
  title: string;
};
/** dstu_vfs::vfs::repos::note_revision_repo::NoteHistoryPage */
export type NoteHistoryPage = {
  items: NoteRevisionSummary[];
  next_cursor: number | null;
};
/** dstu_vfs::vfs::repos::note_history_restore::NoteHistoryRetention */
export type NoteHistoryRetention = {
  edit_bucket_seconds: number;
  max_edit_versions: number | null;
};
/** dstu_vfs::vfs::repos::note_history_restore::NoteHistoryRetention */
export type NoteHistoryRetention__De = {
  edit_bucket_seconds: number;
  max_edit_versions?: number | null;
};
/** dstu_vfs::vfs::repos::note_history_restore::NoteHistorySelection */
export type NoteHistorySelection = {
  start_line: number;
  end_line: number;
};
/** dstu_notes::notes_manager::NoteItem */
export type NoteItem = {
  id: string;
  title: string;
  content_md: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
};
/** dstu_vfs::vfs::repos::note_relation_repo::NoteLocator */
export type NoteLocator = {
  type: "whole";
} | {
  type: "block";
  value: string;
} | {
  type: "page";
  value: number;
} | {
  type: "card";
  value: string;
} | {
  type: "question";
  value: string;
};
/** dstu_vfs::vfs::repos::note_relation_repo::NoteLocator */
export type NoteLocator__De = {
  type: "whole";
} | {
  type: "block";
  value: string;
} | {
  type: "page";
  value: number;
} | {
  type: "card";
  value: string;
} | {
  type: "question";
  value: string;
};
/** dstu_vfs::vfs::repos::note_repo::NoteOutgoingLink */
export type NoteOutgoingLink = {
  targetId: string | null;
  targetTitle: string;
  heading: string | null;
  alias: string | null;
  position: number;
  linkType: string;
  resolved: boolean;
};
/** dstu_vfs::vfs::repos::note_relation_repo::NoteReferenceStatus */
export type NoteReferenceStatus = {
  resource_exists: boolean;
  locator_exists: boolean;
};
/** deep_student_lib::cmd::notes::NoteReferencingResource */
export type NoteReferencingResource = {
  noteId: string;
  title: string;
  updatedAt: string;
  via: string;
};
/** dstu_vfs::vfs::repos::note_relation_repo::NoteRelation */
export type NoteRelation = {
  id: string;
  note_id: string;
  block_id: string | null;
  type: NoteRelationType;
  resource_id: string;
  locator: NoteLocator;
  revision: number;
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
  reference: NoteReferenceStatus;
};
/** dstu_vfs::vfs::repos::note_relation_repo::NoteRelationPut */
export type NoteRelationPut = {
  id: string;
  note_id: string;
  block_id?: string | null;
  type: NoteRelationType__De;
  resource_id: string;
  locator: NoteLocator__De;
  expected_revision?: number | null;
};
/** dstu_vfs::vfs::repos::note_relation_repo::NoteRelationType */
export type NoteRelationType = "source" | "card" | "mistake";
/** dstu_vfs::vfs::repos::note_relation_repo::NoteRelationType */
export type NoteRelationType__De = ("source" | "card" | "mistake") | {
  source: null;
} | {
  card: null;
} | {
  mistake: null;
};
/** dstu_vfs::vfs::repos::note_revision_repo::NoteRevision */
export type NoteRevision = {
  version_id: string;
  note_id: string;
  parent_version_id: string | null;
  restored_from_version_id: string | null;
  title: string;
  source: string;
  created_at: string;
  pinned: boolean;
  content_bytes: number;
  content_md: string;
  tags: string[];
  props: unknown | null;
  asset_refs: NoteAssetRef[];
  content_format: string;
  format_version: number;
  serializer_version: string;
};
/** dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionSummary */
export type NoteRevisionSummary = {
  version_id: string;
  note_id: string;
  parent_version_id: string | null;
  restored_from_version_id: string | null;
  title: string;
  source: string;
  created_at: string;
  pinned: boolean;
  content_bytes: number;
};
/** dstu_vfs::vfs::repos::note_state_repo::NoteState */
export type NoteState = {
  note_id: string;
  type: NoteStateType;
  key: string;
  value: unknown;
  revision: number;
  deleted: boolean;
  updated_at: string;
};
/** dstu_vfs::vfs::repos::note_state_repo::NoteStateDelete */
export type NoteStateDelete = {
  note_id: string;
  type: NoteStateType__De;
  key: string;
  expected_revision: number;
};
/** dstu_vfs::vfs::repos::note_state_repo::NoteStateKey */
export type NoteStateKey = {
  note_id: string;
  type: NoteStateType__De;
  key: string;
};
/** dstu_vfs::vfs::repos::note_state_repo::NoteStateList */
export type NoteStateList = {
  note_id: string;
  type: NoteStateType__De;
  include_deleted?: boolean;
};
/** dstu_vfs::vfs::repos::note_state_repo::NoteStatePut */
export type NoteStatePut = {
  note_id: string;
  type: NoteStateType__De;
  key: string;
  expected_revision?: number | null;
  value: unknown;
};
/** dstu_vfs::vfs::repos::note_state_repo::NoteStateType */
export type NoteStateType = "review" | "draft";
/** dstu_vfs::vfs::repos::note_state_repo::NoteStateType */
export type NoteStateType__De = ("review" | "draft") | {
  review: null;
} | {
  draft: null;
};
/** deep_student_lib::cmd::notes::NotesDbStats */
export type NotesDbStats = {
  db_path: string;
  file_size_bytes: number;
  total_notes: number;
  total_versions: number;
  total_assets: number;
  total_asset_bytes: number;
};
/** deep_student_lib::cmd::notes::NotesExportCommandRequest */
export type NotesExportCommandRequest = {
  subjects?: string[] | null;
  output_path?: string | null;
  include_versions?: boolean | null;
};
/** deep_student_lib::cmd::notes::NotesExportCommandResponse */
export type NotesExportCommandResponse = {
  output_path: string;
  note_count: number;
  attachment_count: number;
};
/** deep_student_lib::cmd::notes::NotesExportSingleCommandRequest */
export type NotesExportSingleCommandRequest = {
  subject?: string | null;
  note_id: string;
  output_path?: string | null;
  include_versions?: boolean | null;
};
/** deep_student_lib::cmd::notes::NotesImportCommandRequest */
export type NotesImportCommandRequest = {
  file_path: string;
  conflict_strategy?: string | null;
};
/** deep_student_lib::cmd::notes::NotesImportCommandResponse */
export type NotesImportCommandResponse = {
  subject_count: number;
  note_count: number;
  attachment_count: number;
  skipped_count: number;
  overwritten_count: number;
};
/** deep_student_lib::cmd::notes::NotesImportMarkdownBatchFailure */
export type NotesImportMarkdownBatchFailure = {
  file_path: string;
  message: string;
};
/** deep_student_lib::cmd::notes::NotesImportMarkdownBatchItem */
export type NotesImportMarkdownBatchItem = {
  filePath: string;
  titleHint?: string | null;
};
/** deep_student_lib::cmd::notes::NotesImportMarkdownBatchRequest */
export type NotesImportMarkdownBatchRequest = {
  items: NotesImportMarkdownBatchItem[];
  folderId?: string | null;
};
/** deep_student_lib::cmd::notes::NotesImportMarkdownBatchResponse */
export type NotesImportMarkdownBatchResponse = {
  imported: Shared.DstuNode[];
  failed: NotesImportMarkdownBatchFailure[];
};
/** deep_student_lib::cmd::notes::NotesImportMarkdownRequest */
export type NotesImportMarkdownRequest = {
  filePath: string;
  titleHint?: string | null;
  folderId?: string | null;
};
/** deep_student_lib::cmd::notes::NotesListAdvancedOptions */
export type NotesListAdvancedOptions = {
  tags?: string[] | null;
  date_start?: string | null;
  date_end?: string | null;
  has_assets?: boolean | null;
  sort_by?: string | null;
  sort_dir?: string | null;
  page?: number | null;
  page_size?: number | null;
  keyword?: string | null;
  include_deleted?: boolean | null;
  only_deleted?: boolean | null;
};
/** deep_student_lib::cmd::notes::NotesListAdvancedResponse */
export type NotesListAdvancedResponse = {
  items: NoteItem[];
  total: number;
  page: number;
  page_size: number;
};
/** deep_student_lib::cmd::notes::NotesMentionSearchResponse */
export type NotesMentionSearchResponse = {
  notes: MentionNoteHit[];
  mistakes: MentionMistakeHit[];
  irec_cards: MentionIrecCardHit[];
};
/** deep_student_lib::cmd::notes::NotesRebuildLinksResponse */
export type NotesRebuildLinksResponse = {
  noteCount: number;
  linkCount: number;
};
/** deep_student_lib::cmd::notes::NotesSearchHit */
export type NotesSearchHit = {
  id: string;
  title: string;
  snippet: string | null;
};
/** deep_student_lib::cmd::notes::NotesSubjectRagConfig */
export type NotesSubjectRagConfig = {
  chunk_size: number;
  chunk_overlap: number;
  min_chunk_size: number;
  rerank_enabled: boolean;
};
/** deep_student_lib::cmd::notes::NotesSubjectRagConfig */
export type NotesSubjectRagConfig__De = {
  chunk_size: number;
  chunk_overlap: number;
  min_chunk_size: number;
  rerank_enabled: boolean;
};
/** dstu_vfs::vfs::repos::note_lease_repo::ParticipantStatus */
export type ParticipantStatus = {
  participant_id: string;
  expires_at: number;
  active_lease: LeaseStatus | null;
};
/** dstu_vfs::vfs::repos::note_review_repo::ReviewSaveResult */
export type ReviewSaveResult = {
  noteId: string;
  revision: number;
  markdown: string;
  updatedAt: string;
};
/** dstu_vfs::vfs::repos::note_transfer_repo::TransferBlocksRequest */
export type TransferBlocksRequest = {
  operation_id: string;
  source_note_id: string;
  target_note_id: string;
  expected_source_updated_at: string;
  expected_target_updated_at: string;
  source_content: string;
  target_content: string;
  block_ids: string[];
};
/** dstu_vfs::vfs::repos::note_transfer_repo::TransferResult */
export type TransferResult = {
  operation_id: string;
  source_note_id: string;
  target_note_id: string;
  source_updated_at: string;
  target_updated_at: string;
  source_version_id: string;
  target_version_id: string;
  undone: boolean;
};
/** deep_student_lib::cmd::notes::UpdateNotePayload */
export type UpdateNotePayload = {
  id: string;
  title?: string | null;
  content_md?: string | null;
  tags?: string[] | null;
  should_reindex?: boolean | null;
  content_hash?: string | null;
  force_reindex?: boolean | null;
  expected_updated_at?: string | null;
  capabilities?: string[] | null;
};
/** dstu_notes::notes_exporter::ImportProgress */
export type dstu_notes__notes_exporter__ImportProgress = {
  stage: ImportStage;
  progress: number;
  current_item: string | null;
  processed: number;
  total: number;
};

/* ---------- 历史导出名（兼容既有 import，勿删） ---------- */
/** 兼容导出：保留旧名 NoteFormat */
export type NoteFormat = Omit<NoteFormatStatus, 'required_capabilities' | 'updated_at'>;
/** 兼容导出：保留旧名 VfsError */
export type VfsError = unknown /* x-unresolved: dstu_vfs::vfs::error::VfsError has no serde Serialize */;

export interface Commands {
  /** src/cmd/notes.rs:1385 `canvas_note_append` */
  canvas_note_append: {
    args: {
      subject?: string | null;
      noteId: string;
      content: string;
      section?: string | null;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1363 `canvas_note_read` */
  canvas_note_read: {
    args: {
      subject?: string | null;
      noteId: string;
      section?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1410 `canvas_note_replace` */
  canvas_note_replace: {
    args: {
      subject?: string | null;
      noteId: string;
      search: string;
      replace: string;
      isRegex?: boolean | null;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1437 `canvas_note_set` */
  canvas_note_set: {
    args: {
      subject?: string | null;
      noteId: string;
      content: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/chat_v2/handlers/canvas_handlers.rs:49 `chat_v2_canvas_edit_ack` */
  chat_v2_canvas_edit_ack: {
    args: {
      requestId: string;
    };
    result: null;
    error: string;
  };
  /** src/chat_v2/handlers/canvas_handlers.rs:28 `chat_v2_canvas_edit_result` */
  chat_v2_canvas_edit_result: {
    args: {
      result: CanvasAIEditResult;
    };
    result: null;
    error: string;
  };
  /** src/cmd/notes.rs:2167 `notes_assets_bulk_delete` */
  notes_assets_bulk_delete: {
    args: {
      paths: string[];
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1972 `notes_assets_index_scan` */
  notes_assets_index_scan: {
    args: {
      subject?: string | null;
      noteId: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2004 `notes_assets_scan_orphans` */
  notes_assets_scan_orphans: {
    args: {
      subject?: string | null;
    };
    result: string[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1206 `notes_create` */
  notes_create: {
    args: {
      subject?: string | null;
      note: NewNotePayload;
    };
    result: NoteItem;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2960 `notes_db_stats` */
  notes_db_stats: {
    args: Record<string, never>;
    result: NotesDbStats;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3020 `notes_db_vacuum` */
  notes_db_vacuum: {
    args: Record<string, never>;
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1342 `notes_delete` */
  notes_delete: {
    args: {
      subject?: string | null;
      id: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1898 `notes_delete_asset` */
  notes_delete_asset: {
    args: {
      relativePath: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:397 `notes_editor_begin` */
  notes_editor_begin: {
    args: {
      participantId: string;
      operationId: string;
      noteIds: string[];
    };
    result: LeaseStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:478 `notes_editor_finish` */
  notes_editor_finish: {
    args: {
      lease: Shared.NoteLeaseAuth;
    };
    result: LeaseStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:457 `notes_editor_flush` */
  notes_editor_flush: {
    args: {
      lease: Shared.NoteLeaseAuth;
      noteId: string;
      capabilities?: string[] | null;
    };
    result: LeaseNote;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:428 `notes_editor_freeze_ack` */
  notes_editor_freeze_ack: {
    args: {
      lease: Shared.NoteLeaseAuth;
      draft: FrozenDraft;
    };
    result: LeaseStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:368 `notes_editor_heartbeat` */
  notes_editor_heartbeat: {
    args: {
      participantId: string;
    };
    result: ParticipantStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:421 `notes_editor_lease_status` */
  notes_editor_lease_status: {
    args: {
      token: string;
    };
    result: LeaseStatus | null;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:493 `notes_editor_refresh_ack` */
  notes_editor_refresh_ack: {
    args: {
      lease: Shared.NoteLeaseAuth;
      updatedAt: string;
    };
    result: LeaseStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:350 `notes_editor_register` */
  notes_editor_register: {
    args: {
      noteId: string;
    };
    result: ParticipantStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:509 `notes_editor_release` */
  notes_editor_release: {
    args: {
      lease: Shared.NoteLeaseAuth;
      cancel: boolean;
    };
    result: LeaseCancellation;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:380 `notes_editor_unregister` */
  notes_editor_unregister: {
    args: {
      participantId: string;
    };
    result: LeaseCancellation[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1595 `notes_empty_trash` */
  notes_empty_trash: {
    args: {
      subject?: string | null;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:628 `notes_enable_columns` */
  notes_enable_columns: {
    args: {
      noteId: string;
      expectedUpdatedAt: string;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: NoteFormatStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2363 `notes_export` */
  notes_export: {
    args: {
      request: NotesExportCommandRequest;
    };
    result: NotesExportCommandResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2447 `notes_export_single` */
  notes_export_single: {
    args: {
      request: NotesExportSingleCommandRequest;
    };
    result: NotesExportCommandResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1327 `notes_get` */
  notes_get: {
    args: {
      subject?: string | null;
      id: string;
    };
    result: NoteItem;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3384 `notes_get_backlinks` */
  notes_get_backlinks: {
    args: {
      subject?: string | null;
      noteId: string;
    };
    result: NoteBacklink[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:595 `notes_get_format` */
  notes_get_format: {
    args: {
      noteId: string;
    };
    result: NoteFormatStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3403 `notes_get_outgoing_links` */
  notes_get_outgoing_links: {
    args: {
      subject?: string | null;
      noteId: string;
    };
    result: NoteOutgoingLink[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2326 `notes_get_pref` */
  notes_get_pref: {
    args: {
      key: string;
    };
    result: string | null;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2230 `notes_get_subject_rag_config` */
  notes_get_subject_rag_config: {
    args: {
      subject: string;
    };
    result: NotesSubjectRagConfig;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1462 `notes_hard_delete` */
  notes_hard_delete: {
    args: {
      subject?: string | null;
      id: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:926 `notes_history_current` */
  notes_history_current: {
    args: {
      noteId: string;
    };
    result: NoteHistoryCurrent;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1032 `notes_history_get` */
  notes_history_get: {
    args: {
      noteId: string;
      versionId: string;
    };
    result: NoteRevision;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:934 `notes_history_get_retention` */
  notes_history_get_retention: {
    args: Record<string, never>;
    result: NoteHistoryRetention;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1002 `notes_history_list` */
  notes_history_list: {
    args: {
      noteId: string;
      cursor?: number | null;
      limit?: number | null;
      pinnedOnly?: boolean | null;
    };
    result: NoteHistoryPage;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1077 `notes_history_restore_copy` */
  notes_history_restore_copy: {
    args: {
      noteId: string;
      versionId: string;
    };
    result: Shared.DstuNode;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:972 `notes_history_restore_current` */
  notes_history_restore_current: {
    args: {
      noteId: string;
      versionId: string;
      expectedUpdatedAt: string;
      selection?: NoteHistorySelection | null;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: Shared.DstuNode;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:952 `notes_history_restore_selection_copy` */
  notes_history_restore_selection_copy: {
    args: {
      noteId: string;
      versionId: string;
      selection: NoteHistorySelection;
    };
    result: Shared.DstuNode;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1054 `notes_history_set_pinned` */
  notes_history_set_pinned: {
    args: {
      noteId: string;
      versionId: string;
      pinned: boolean;
    };
    result: NoteRevisionSummary;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:941 `notes_history_set_retention` */
  notes_history_set_retention: {
    args: {
      policy: NoteHistoryRetention__De;
    };
    result: NoteHistoryRetention;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2544 `notes_import` */
  notes_import: {
    args: {
      request: NotesImportCommandRequest;
    };
    result: NotesImportCommandResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2668 `notes_import_markdown` */
  notes_import_markdown: {
    args: {
      request: NotesImportMarkdownRequest;
    };
    result: Shared.DstuNode;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2722 `notes_import_markdown_batch` */
  notes_import_markdown_batch: {
    args: {
      request: NotesImportMarkdownBatchRequest;
    };
    result: NotesImportMarkdownBatchResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:914 `notes_invalidate_resource_refs` */
  notes_invalidate_resource_refs: {
    args: {
      resourceId: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1110 `notes_list` */
  notes_list: {
    args: {
      subject?: string | null;
      limit?: number | null;
      offset?: number | null;
    };
    result: NoteItem[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1162 `notes_list_advanced` */
  notes_list_advanced: {
    args: {
      subject?: string | null;
      options: NotesListAdvancedOptions;
    };
    result: NotesListAdvancedResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1879 `notes_list_assets` */
  notes_list_assets: {
    args: {
      subject?: string | null;
      noteId: string;
    };
    result: unknown[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1782 `notes_list_deleted` */
  notes_list_deleted: {
    args: {
      subject?: string | null;
      page?: number | null;
      pageSize?: number | null;
    };
    result: NotesListAdvancedResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1128 `notes_list_meta` */
  notes_list_meta: {
    args: {
      subject?: string | null;
    };
    result: NoteItem[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:835 `notes_list_referencing_resource` */
  notes_list_referencing_resource: {
    args: {
      resourceIds: string[];
    };
    result: NoteReferencingResource[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3040 `notes_list_tags` */
  notes_list_tags: {
    args: {
      subject?: string | null;
    };
    result: string[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3202 `notes_mentions_search` */
  notes_mentions_search: {
    args: {
      subject?: string | null;
      keyword: string;
      limit?: number | null;
    };
    result: NotesMentionSearchResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:677 `notes_migrate_blocks` */
  notes_migrate_blocks: {
    args: {
      noteId: string;
      expectedUpdatedAt: string;
      content: string;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: Shared.VfsNote;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2212 `notes_rag_rebuild_fts_index` */
  notes_rag_rebuild_fts_index: {
    args: Record<string, never>;
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3435 `notes_rebuild_links` */
  notes_rebuild_links: {
    args: {
      subject?: string | null;
      batchSize?: number | null;
    };
    result: NotesRebuildLinksResponse;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:899 `notes_reference_status` */
  notes_reference_status: {
    args: {
      resourceId: string;
      locator: NoteLocator__De;
    };
    result: NoteReferenceStatus;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:888 `notes_relation_delete` */
  notes_relation_delete: {
    args: {
      id: string;
      expectedRevision: number;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:730 `notes_relation_get` */
  notes_relation_get: {
    args: {
      id: string;
    };
    result: NoteRelation | null;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:744 `notes_relation_list` */
  notes_relation_list: {
    args: {
      noteId: string;
    };
    result: NoteRelation[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:874 `notes_relation_put` */
  notes_relation_put: {
    args: {
      request: NoteRelationPut;
    };
    result: NoteRelation;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1926 `notes_resolve_asset_path` */
  notes_resolve_asset_path: {
    args: {
      relativePath: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1836 `notes_restore` */
  notes_restore: {
    args: {
      subject?: string | null;
      id: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:648 `notes_review_save_as` */
  notes_review_save_as: {
    args: {
      operationId: string;
      sourceNoteId: string;
      markdown: string;
      expectedUpdatedAt?: string | null;
      capabilities?: string[] | null;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: ReviewSaveResult;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1858 `notes_save_asset` */
  notes_save_asset: {
    args: {
      subject?: string | null;
      noteId: string;
      base64Data: string;
      defaultExt?: string | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3129 `notes_search` */
  notes_search: {
    args: {
      subject?: string | null;
      keyword: string;
      limit?: number | null;
    };
    result: NotesSearchHit[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1310 `notes_set_favorite` */
  notes_set_favorite: {
    args: {
      subject?: string | null;
      id: string;
      favorite: boolean;
    };
    result: NoteItem;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2313 `notes_set_pref` */
  notes_set_pref: {
    args: {
      key: string;
      value: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:720 `notes_state_delete` */
  notes_state_delete: {
    args: {
      request: NoteStateDelete;
    };
    result: NoteState;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:696 `notes_state_get` */
  notes_state_get: {
    args: {
      request: NoteStateKey;
    };
    result: NoteState | null;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:703 `notes_state_list` */
  notes_state_list: {
    args: {
      request: NoteStateList;
    };
    result: NoteState[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:710 `notes_state_put` */
  notes_state_put: {
    args: {
      request: NoteStatePut;
    };
    result: NoteState;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:556 `notes_transfer_blocks` */
  notes_transfer_blocks: {
    args: {
      request: TransferBlocksRequest;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: TransferResult;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:572 `notes_undo_transfer` */
  notes_undo_transfer: {
    args: {
      operationId: string;
      expectedSourceUpdatedAt: string;
      expectedTargetUpdatedAt: string;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: TransferResult;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:3469 `notes_unlinked_mentions` */
  notes_unlinked_mentions: {
    args: {
      subject?: string | null;
      noteId: string;
      limit?: number | null;
    };
    result: NotesSearchHit[];
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:1245 `notes_update` */
  notes_update: {
    args: {
      subject?: string | null;
      note: UpdateNotePayload;
      lease?: Shared.NoteLeaseAuth | null;
    };
    result: NoteItem;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2260 `notes_update_subject_rag_config` */
  notes_update_subject_rag_config: {
    args: {
      subject: string;
      cfg: NotesSubjectRagConfig__De;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/notes.rs:2203 `rag_rebuild_fts_index` */
  rag_rebuild_fts_index: {
    args: Record<string, never>;
    result: number;
    error: Shared.AppError;
  };
}

export interface Events {
  "canvas:ai-edit-request": CanvasAIEditRequest;
  "notes-import-progress": dstu_notes__notes_exporter__ImportProgress;
  "notes:format-changed": (NoteFormatStatus | Shared.VfsNote);
  "notes:lease-changed": LeaseStatus;
  "notes:lease-ended": (LeaseCancellation | unknown /* x-unresolved: payload type of `event` not determinable statically */);
  "notes:review-saved": ReviewSaveResult;
  "notes:state-changed": NoteState;
  "notes:transfer-completed": TransferResult;
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
}

export type CommandName = keyof Commands;
export type CanvasNoteAppendCommandArgs = Commands['canvas_note_append']['args'];
export type CanvasNoteAppendCommandResult = Commands['canvas_note_append']['result'];
export type CanvasNoteReadCommandArgs = Commands['canvas_note_read']['args'];
export type CanvasNoteReadCommandResult = Commands['canvas_note_read']['result'];
export type CanvasNoteReplaceCommandArgs = Commands['canvas_note_replace']['args'];
export type CanvasNoteReplaceCommandResult = Commands['canvas_note_replace']['result'];
export type CanvasNoteSetCommandArgs = Commands['canvas_note_set']['args'];
export type CanvasNoteSetCommandResult = Commands['canvas_note_set']['result'];
export type ChatV2CanvasEditAckCommandArgs = Commands['chat_v2_canvas_edit_ack']['args'];
export type ChatV2CanvasEditAckCommandResult = Commands['chat_v2_canvas_edit_ack']['result'];
export type ChatV2CanvasEditResultCommandArgs = Commands['chat_v2_canvas_edit_result']['args'];
export type ChatV2CanvasEditResultCommandResult = Commands['chat_v2_canvas_edit_result']['result'];
export type NotesAssetsBulkDeleteCommandArgs = Commands['notes_assets_bulk_delete']['args'];
export type NotesAssetsBulkDeleteCommandResult = Commands['notes_assets_bulk_delete']['result'];
export type NotesAssetsIndexScanCommandArgs = Commands['notes_assets_index_scan']['args'];
export type NotesAssetsIndexScanCommandResult = Commands['notes_assets_index_scan']['result'];
export type NotesAssetsScanOrphansCommandArgs = Commands['notes_assets_scan_orphans']['args'];
export type NotesAssetsScanOrphansCommandResult = Commands['notes_assets_scan_orphans']['result'];
export type NotesCreateCommandArgs = Commands['notes_create']['args'];
export type NotesCreateCommandResult = Commands['notes_create']['result'];
export type NotesDbStatsCommandArgs = Commands['notes_db_stats']['args'];
export type NotesDbStatsCommandResult = Commands['notes_db_stats']['result'];
export type NotesDbVacuumCommandArgs = Commands['notes_db_vacuum']['args'];
export type NotesDbVacuumCommandResult = Commands['notes_db_vacuum']['result'];
export type NotesDeleteCommandArgs = Commands['notes_delete']['args'];
export type NotesDeleteCommandResult = Commands['notes_delete']['result'];
export type NotesDeleteAssetCommandArgs = Commands['notes_delete_asset']['args'];
export type NotesDeleteAssetCommandResult = Commands['notes_delete_asset']['result'];
export type NotesEditorBeginCommandArgs = Commands['notes_editor_begin']['args'];
export type NotesEditorBeginCommandResult = Commands['notes_editor_begin']['result'];
export type NotesEditorFinishCommandArgs = Commands['notes_editor_finish']['args'];
export type NotesEditorFinishCommandResult = Commands['notes_editor_finish']['result'];
export type NotesEditorFlushCommandArgs = Commands['notes_editor_flush']['args'];
export type NotesEditorFlushCommandResult = Commands['notes_editor_flush']['result'];
export type NotesEditorFreezeAckCommandArgs = Commands['notes_editor_freeze_ack']['args'];
export type NotesEditorFreezeAckCommandResult = Commands['notes_editor_freeze_ack']['result'];
export type NotesEditorHeartbeatCommandArgs = Commands['notes_editor_heartbeat']['args'];
export type NotesEditorHeartbeatCommandResult = Commands['notes_editor_heartbeat']['result'];
export type NotesEditorLeaseStatusCommandArgs = Commands['notes_editor_lease_status']['args'];
export type NotesEditorLeaseStatusCommandResult = Commands['notes_editor_lease_status']['result'];
export type NotesEditorRefreshAckCommandArgs = Commands['notes_editor_refresh_ack']['args'];
export type NotesEditorRefreshAckCommandResult = Commands['notes_editor_refresh_ack']['result'];
export type NotesEditorRegisterCommandArgs = Commands['notes_editor_register']['args'];
export type NotesEditorRegisterCommandResult = Commands['notes_editor_register']['result'];
export type NotesEditorReleaseCommandArgs = Commands['notes_editor_release']['args'];
export type NotesEditorReleaseCommandResult = Commands['notes_editor_release']['result'];
export type NotesEditorUnregisterCommandArgs = Commands['notes_editor_unregister']['args'];
export type NotesEditorUnregisterCommandResult = Commands['notes_editor_unregister']['result'];
export type NotesEmptyTrashCommandArgs = Commands['notes_empty_trash']['args'];
export type NotesEmptyTrashCommandResult = Commands['notes_empty_trash']['result'];
export type NotesEnableColumnsCommandArgs = Commands['notes_enable_columns']['args'];
export type NotesEnableColumnsCommandResult = Commands['notes_enable_columns']['result'];
export type NotesExportCommandArgs = Commands['notes_export']['args'];
export type NotesExportCommandResult = Commands['notes_export']['result'];
export type NotesExportSingleCommandArgs = Commands['notes_export_single']['args'];
export type NotesExportSingleCommandResult = Commands['notes_export_single']['result'];
export type NotesGetCommandArgs = Commands['notes_get']['args'];
export type NotesGetCommandResult = Commands['notes_get']['result'];
export type NotesGetBacklinksCommandArgs = Commands['notes_get_backlinks']['args'];
export type NotesGetBacklinksCommandResult = Commands['notes_get_backlinks']['result'];
export type NotesGetFormatCommandArgs = Commands['notes_get_format']['args'];
export type NotesGetFormatCommandResult = Commands['notes_get_format']['result'];
export type NotesGetOutgoingLinksCommandArgs = Commands['notes_get_outgoing_links']['args'];
export type NotesGetOutgoingLinksCommandResult = Commands['notes_get_outgoing_links']['result'];
export type NotesGetPrefCommandArgs = Commands['notes_get_pref']['args'];
export type NotesGetPrefCommandResult = Commands['notes_get_pref']['result'];
export type NotesGetSubjectRagConfigCommandArgs = Commands['notes_get_subject_rag_config']['args'];
export type NotesGetSubjectRagConfigCommandResult = Commands['notes_get_subject_rag_config']['result'];
export type NotesHardDeleteCommandArgs = Commands['notes_hard_delete']['args'];
export type NotesHardDeleteCommandResult = Commands['notes_hard_delete']['result'];
export type NotesHistoryCurrentCommandArgs = Commands['notes_history_current']['args'];
export type NotesHistoryCurrentCommandResult = Commands['notes_history_current']['result'];
export type NotesHistoryGetCommandArgs = Commands['notes_history_get']['args'];
export type NotesHistoryGetCommandResult = Commands['notes_history_get']['result'];
export type NotesHistoryGetRetentionCommandArgs = Commands['notes_history_get_retention']['args'];
export type NotesHistoryGetRetentionCommandResult = Commands['notes_history_get_retention']['result'];
export type NotesHistoryListCommandArgs = Commands['notes_history_list']['args'];
export type NotesHistoryListCommandResult = Commands['notes_history_list']['result'];
export type NotesHistoryRestoreCopyCommandArgs = Commands['notes_history_restore_copy']['args'];
export type NotesHistoryRestoreCopyCommandResult = Commands['notes_history_restore_copy']['result'];
export type NotesHistoryRestoreCurrentCommandArgs = Commands['notes_history_restore_current']['args'];
export type NotesHistoryRestoreCurrentCommandResult = Commands['notes_history_restore_current']['result'];
export type NotesHistoryRestoreSelectionCopyCommandArgs = Commands['notes_history_restore_selection_copy']['args'];
export type NotesHistoryRestoreSelectionCopyCommandResult = Commands['notes_history_restore_selection_copy']['result'];
export type NotesHistorySetPinnedCommandArgs = Commands['notes_history_set_pinned']['args'];
export type NotesHistorySetPinnedCommandResult = Commands['notes_history_set_pinned']['result'];
export type NotesHistorySetRetentionCommandArgs = Commands['notes_history_set_retention']['args'];
export type NotesHistorySetRetentionCommandResult = Commands['notes_history_set_retention']['result'];
export type NotesImportCommandArgs = Commands['notes_import']['args'];
export type NotesImportCommandResult = Commands['notes_import']['result'];
export type NotesImportMarkdownCommandArgs = Commands['notes_import_markdown']['args'];
export type NotesImportMarkdownCommandResult = Commands['notes_import_markdown']['result'];
export type NotesImportMarkdownBatchCommandArgs = Commands['notes_import_markdown_batch']['args'];
export type NotesImportMarkdownBatchCommandResult = Commands['notes_import_markdown_batch']['result'];
export type NotesInvalidateResourceRefsCommandArgs = Commands['notes_invalidate_resource_refs']['args'];
export type NotesInvalidateResourceRefsCommandResult = Commands['notes_invalidate_resource_refs']['result'];
export type NotesListCommandArgs = Commands['notes_list']['args'];
export type NotesListCommandResult = Commands['notes_list']['result'];
export type NotesListAdvancedCommandArgs = Commands['notes_list_advanced']['args'];
export type NotesListAdvancedCommandResult = Commands['notes_list_advanced']['result'];
export type NotesListAssetsCommandArgs = Commands['notes_list_assets']['args'];
export type NotesListAssetsCommandResult = Commands['notes_list_assets']['result'];
export type NotesListDeletedCommandArgs = Commands['notes_list_deleted']['args'];
export type NotesListDeletedCommandResult = Commands['notes_list_deleted']['result'];
export type NotesListMetaCommandArgs = Commands['notes_list_meta']['args'];
export type NotesListMetaCommandResult = Commands['notes_list_meta']['result'];
export type NotesListReferencingResourceCommandArgs = Commands['notes_list_referencing_resource']['args'];
export type NotesListReferencingResourceCommandResult = Commands['notes_list_referencing_resource']['result'];
export type NotesListTagsCommandArgs = Commands['notes_list_tags']['args'];
export type NotesListTagsCommandResult = Commands['notes_list_tags']['result'];
export type NotesMentionsSearchCommandArgs = Commands['notes_mentions_search']['args'];
export type NotesMentionsSearchCommandResult = Commands['notes_mentions_search']['result'];
export type NotesMigrateBlocksCommandArgs = Commands['notes_migrate_blocks']['args'];
export type NotesMigrateBlocksCommandResult = Commands['notes_migrate_blocks']['result'];
export type NotesRagRebuildFtsIndexCommandArgs = Commands['notes_rag_rebuild_fts_index']['args'];
export type NotesRagRebuildFtsIndexCommandResult = Commands['notes_rag_rebuild_fts_index']['result'];
export type NotesRebuildLinksCommandArgs = Commands['notes_rebuild_links']['args'];
export type NotesRebuildLinksCommandResult = Commands['notes_rebuild_links']['result'];
export type NotesReferenceStatusCommandArgs = Commands['notes_reference_status']['args'];
export type NotesReferenceStatusCommandResult = Commands['notes_reference_status']['result'];
export type NotesRelationDeleteCommandArgs = Commands['notes_relation_delete']['args'];
export type NotesRelationDeleteCommandResult = Commands['notes_relation_delete']['result'];
export type NotesRelationGetCommandArgs = Commands['notes_relation_get']['args'];
export type NotesRelationGetCommandResult = Commands['notes_relation_get']['result'];
export type NotesRelationListCommandArgs = Commands['notes_relation_list']['args'];
export type NotesRelationListCommandResult = Commands['notes_relation_list']['result'];
export type NotesRelationPutCommandArgs = Commands['notes_relation_put']['args'];
export type NotesRelationPutCommandResult = Commands['notes_relation_put']['result'];
export type NotesResolveAssetPathCommandArgs = Commands['notes_resolve_asset_path']['args'];
export type NotesResolveAssetPathCommandResult = Commands['notes_resolve_asset_path']['result'];
export type NotesRestoreCommandArgs = Commands['notes_restore']['args'];
export type NotesRestoreCommandResult = Commands['notes_restore']['result'];
export type NotesReviewSaveAsCommandArgs = Commands['notes_review_save_as']['args'];
export type NotesReviewSaveAsCommandResult = Commands['notes_review_save_as']['result'];
export type NotesSaveAssetCommandArgs = Commands['notes_save_asset']['args'];
export type NotesSaveAssetCommandResult = Commands['notes_save_asset']['result'];
export type NotesSearchCommandArgs = Commands['notes_search']['args'];
export type NotesSearchCommandResult = Commands['notes_search']['result'];
export type NotesSetFavoriteCommandArgs = Commands['notes_set_favorite']['args'];
export type NotesSetFavoriteCommandResult = Commands['notes_set_favorite']['result'];
export type NotesSetPrefCommandArgs = Commands['notes_set_pref']['args'];
export type NotesSetPrefCommandResult = Commands['notes_set_pref']['result'];
export type NotesStateDeleteCommandArgs = Commands['notes_state_delete']['args'];
export type NotesStateDeleteCommandResult = Commands['notes_state_delete']['result'];
export type NotesStateGetCommandArgs = Commands['notes_state_get']['args'];
export type NotesStateGetCommandResult = Commands['notes_state_get']['result'];
export type NotesStateListCommandArgs = Commands['notes_state_list']['args'];
export type NotesStateListCommandResult = Commands['notes_state_list']['result'];
export type NotesStatePutCommandArgs = Commands['notes_state_put']['args'];
export type NotesStatePutCommandResult = Commands['notes_state_put']['result'];
export type NotesTransferBlocksCommandArgs = Commands['notes_transfer_blocks']['args'];
export type NotesTransferBlocksCommandResult = Commands['notes_transfer_blocks']['result'];
export type NotesUndoTransferCommandArgs = Commands['notes_undo_transfer']['args'];
export type NotesUndoTransferCommandResult = Commands['notes_undo_transfer']['result'];
export type NotesUnlinkedMentionsCommandArgs = Commands['notes_unlinked_mentions']['args'];
export type NotesUnlinkedMentionsCommandResult = Commands['notes_unlinked_mentions']['result'];
export type NotesUpdateCommandArgs = Commands['notes_update']['args'];
export type NotesUpdateCommandResult = Commands['notes_update']['result'];
export type NotesUpdateSubjectRagConfigCommandArgs = Commands['notes_update_subject_rag_config']['args'];
export type NotesUpdateSubjectRagConfigCommandResult = Commands['notes_update_subject_rag_config']['result'];
export type RagRebuildFtsIndexCommandArgs = Commands['rag_rebuild_fts_index']['args'];
export type RagRebuildFtsIndexCommandResult = Commands['rag_rebuild_fts_index']['result'];
