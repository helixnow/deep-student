// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L17-memory-research.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_memory::memory::handlers::BatchOperationResult */
export type BatchOperationResult = {
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
};
/** dstu_memory::memory::handlers::MemoryAnkiDocument */
export type MemoryAnkiDocument = {
  documentContent: string;
  memoryCount: number;
  documentName: string;
};
/** dstu_memory::memory::audit_log::MemoryAuditLogItem */
export type MemoryAuditLogItem = {
  id: number;
  timestamp: string;
  source: string;
  operation: string;
  success: boolean;
  noteId: string | null;
  title: string | null;
  contentPreview: string | null;
  folder: string | null;
  event: string | null;
  confidence: number | null;
  reason: string | null;
  sessionId: string | null;
  durationMs: number | null;
};
/** dstu_memory::memory::handlers::MemoryBatchWriteItemInput */
export type MemoryBatchWriteItemInput = {
  title: string;
  content: string;
  folderPath?: string | null;
  memoryType?: string | null;
  memoryPurpose?: string | null;
  idempotencyKey?: string | null;
};
/** dstu_memory::memory::handlers::MemoryBatchWriteItemResult */
export type MemoryBatchWriteItemResult = {
  title: string;
  noteId: string;
  event: string;
  isNew: boolean;
  confidence: number;
  reason: string;
  resourceId?: string | null;
  downgraded: boolean;
};
/** dstu_memory::memory::handlers::MemoryBatchWriteOutput */
export type MemoryBatchWriteOutput = {
  total: number;
  succeeded: number;
  failed: number;
  added: number;
  updated: number;
  skipped: number;
  filtered: number;
  results: MemoryBatchWriteItemResult[];
};
/** dstu_memory::memory::service::MemoryConfigOutput */
export type MemoryConfigOutput = {
  memoryRootFolderId: string | null;
  memoryRootFolderTitle: string | null;
  autoCreateSubfolders: boolean;
  defaultCategory: string;
  privacyMode: boolean;
  autoExtractFrequency: string;
};
/** dstu_memory::memory::handlers::MemoryExportItem */
export type MemoryExportItem = {
  title: string;
  content: string;
  folder: string;
  updatedAt: string;
};
/** dstu_memory::memory::service::MemoryListItem */
export type MemoryListItem = {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: string;
  hits: number;
  isImportant: boolean;
  isStale: boolean;
  isArchived: boolean;
  needsDedupReview: boolean;
  memoryType: string;
  memoryPurpose: string;
};
/** dstu_memory::memory::handlers::MemoryProfileSection */
export type MemoryProfileSection = {
  category: string;
  content: string;
};
/** dstu_memory::memory::handlers::MemoryReadOutput */
export type MemoryReadOutput = {
  noteId: string;
  title: string;
  content: string;
  folderPath: string;
  updatedAt: string;
};
/** dstu_memory::memory::service::MemorySearchResult */
export type MemorySearchResult = {
  noteId: string;
  noteTitle: string;
  folderPath: string;
  chunkText: string;
  score: number;
  updatedAt?: string | null;
};
/** dstu_memory::memory::service::MemoryWriteOutput */
export type MemoryWriteOutput = {
  noteId: string;
  isNew: boolean;
  resourceId: string;
};
/** dstu_memory::memory::service::SmartWriteOutput */
export type SmartWriteOutput = {
  noteId: string;
  event: string;
  isNew: boolean;
  confidence: number;
  reason: string;
  resourceId?: string | null;
  downgraded: boolean;
};

export interface Commands {
  /** crates/dstu-memory/src/memory/handlers.rs:364 `memory_add_relation` */
  memory_add_relation: {
    args: {
      noteIdA: string;
      noteIdB: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:478 `memory_batch_delete` */
  memory_batch_delete: {
    args: {
      noteIds: string[];
    };
    result: BatchOperationResult;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:522 `memory_batch_move` */
  memory_batch_move: {
    args: {
      noteIds: string[];
      targetFolderPath: string;
    };
    result: BatchOperationResult;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:208 `memory_create_root_folder` */
  memory_create_root_folder: {
    args: {
      title: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:614 `memory_delete` */
  memory_delete: {
    args: {
      noteId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:688 `memory_export_all` */
  memory_export_all: {
    args: Record<string, never>;
    result: MemoryExportItem[];
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:947 `memory_get_audit_logs` */
  memory_get_audit_logs: {
    args: {
      limit?: number | null;
      offset?: number | null;
      sourceFilter?: string | null;
      operationFilter?: string | null;
      successFilter?: boolean | null;
    };
    result: MemoryAuditLogItem[];
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:174 `memory_get_config` */
  memory_get_config: {
    args: Record<string, never>;
    result: MemoryConfigOutput;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:221 `memory_get_or_create_root_folder` */
  memory_get_or_create_root_folder: {
    args: Record<string, never>;
    result: string;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:721 `memory_get_profile` */
  memory_get_profile: {
    args: Record<string, never>;
    result: MemoryProfileSection[];
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:400 `memory_get_related` */
  memory_get_related: {
    args: {
      noteId: string;
    };
    result: string[];
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:466 `memory_get_tags` */
  memory_get_tags: {
    args: {
      noteId: string;
    };
    result: string[];
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:353 `memory_get_tree` */
  memory_get_tree: {
    args: Record<string, never>;
    result: Shared.FolderTreeNode | null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:337 `memory_list` */
  memory_list: {
    args: {
      folderPath?: string | null;
      limit?: number | null;
      offset?: number | null;
    };
    result: MemoryListItem[];
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:566 `memory_move_to_folder` */
  memory_move_to_folder: {
    args: {
      noteId: string;
      targetFolderPath: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:249 `memory_read` */
  memory_read: {
    args: {
      noteId: string;
    };
    result: MemoryReadOutput | null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:382 `memory_remove_relation` */
  memory_remove_relation: {
    args: {
      noteIdA: string;
      noteIdB: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:447 `memory_restore_archived` */
  memory_restore_archived: {
    args: {
      noteId: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:430 `memory_restore_stale` */
  memory_restore_stale: {
    args: {
      noteId: string;
    };
    result: boolean;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:233 `memory_search` */
  memory_search: {
    args: {
      query: string;
      topK?: number | null;
    };
    result: MemorySearchResult[];
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:629 `memory_set_auto_create_subfolders` */
  memory_set_auto_create_subfolders: {
    args: {
      enabled: boolean;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:655 `memory_set_auto_extract_frequency` */
  memory_set_auto_extract_frequency: {
    args: {
      frequency: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:642 `memory_set_default_category` */
  memory_set_default_category: {
    args: {
      category: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:197 `memory_set_privacy_mode` */
  memory_set_privacy_mode: {
    args: {
      enabled: boolean;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:184 `memory_set_root_folder` */
  memory_set_root_folder: {
    args: {
      folderId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:973 `memory_to_anki_document` */
  memory_to_anki_document: {
    args: {
      folderPath?: string | null;
      purposeFilter?: string | null;
      limit?: number | null;
    };
    result: MemoryAnkiDocument;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:584 `memory_update_by_id` */
  memory_update_by_id: {
    args: {
      noteId: string;
      title?: string | null;
      content?: string | null;
    };
    result: MemoryWriteOutput;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:412 `memory_update_tags` */
  memory_update_tags: {
    args: {
      noteId: string;
      tags: string[];
    };
    result: null;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:276 `memory_write` */
  memory_write: {
    args: {
      noteId?: string | null;
      folderPath?: string | null;
      title: string;
      content: string;
      mode?: string | null;
    };
    result: MemoryWriteOutput;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:815 `memory_write_batch` */
  memory_write_batch: {
    args: {
      items: MemoryBatchWriteItemInput[];
      defaultFolderPath?: string | null;
      defaultMemoryType?: string | null;
      defaultMemoryPurpose?: string | null;
    };
    result: MemoryBatchWriteOutput;
    error: string;
  };
  /** crates/dstu-memory/src/memory/handlers.rs:761 `memory_write_smart` */
  memory_write_smart: {
    args: {
      folderPath?: string | null;
      title: string;
      content: string;
      memoryType?: string | null;
      memoryPurpose?: string | null;
      idempotencyKey?: string | null;
    };
    result: SmartWriteOutput;
    error: string;
  };
  /** src/quick_assistant.rs:273 `quick_assistant_apply_enabled` */
  quick_assistant_apply_enabled: {
    args: {
      enabled: boolean;
    };
    result: null;
    error: never;
  };
  /** src/quick_assistant.rs:264 `quick_assistant_hide` */
  quick_assistant_hide: {
    args: Record<string, never>;
    result: null;
    error: never;
  };
  /** src/quick_assistant.rs:256 `quick_assistant_show` */
  quick_assistant_show: {
    args: Record<string, never>;
    result: null;
    error: never;
  };
}

export interface Events {
  "hpias_event": unknown;
  "memory://changed": {
    source: string;
    action: string;
    entityIds: string[];
    runId: string;
  } | {
    source: string;
    action: string;
    entityIds: string[];
  };
  "quick-assistant://shown": null;
}

export type CommandName = keyof Commands;
export type MemoryAddRelationCommandArgs = Commands['memory_add_relation']['args'];
export type MemoryAddRelationCommandResult = Commands['memory_add_relation']['result'];
export type MemoryBatchDeleteCommandArgs = Commands['memory_batch_delete']['args'];
export type MemoryBatchDeleteCommandResult = Commands['memory_batch_delete']['result'];
export type MemoryBatchMoveCommandArgs = Commands['memory_batch_move']['args'];
export type MemoryBatchMoveCommandResult = Commands['memory_batch_move']['result'];
export type MemoryCreateRootFolderCommandArgs = Commands['memory_create_root_folder']['args'];
export type MemoryCreateRootFolderCommandResult = Commands['memory_create_root_folder']['result'];
export type MemoryDeleteCommandArgs = Commands['memory_delete']['args'];
export type MemoryDeleteCommandResult = Commands['memory_delete']['result'];
export type MemoryExportAllCommandArgs = Commands['memory_export_all']['args'];
export type MemoryExportAllCommandResult = Commands['memory_export_all']['result'];
export type MemoryGetAuditLogsCommandArgs = Commands['memory_get_audit_logs']['args'];
export type MemoryGetAuditLogsCommandResult = Commands['memory_get_audit_logs']['result'];
export type MemoryGetConfigCommandArgs = Commands['memory_get_config']['args'];
export type MemoryGetConfigCommandResult = Commands['memory_get_config']['result'];
export type MemoryGetOrCreateRootFolderCommandArgs = Commands['memory_get_or_create_root_folder']['args'];
export type MemoryGetOrCreateRootFolderCommandResult = Commands['memory_get_or_create_root_folder']['result'];
export type MemoryGetProfileCommandArgs = Commands['memory_get_profile']['args'];
export type MemoryGetProfileCommandResult = Commands['memory_get_profile']['result'];
export type MemoryGetRelatedCommandArgs = Commands['memory_get_related']['args'];
export type MemoryGetRelatedCommandResult = Commands['memory_get_related']['result'];
export type MemoryGetTagsCommandArgs = Commands['memory_get_tags']['args'];
export type MemoryGetTagsCommandResult = Commands['memory_get_tags']['result'];
export type MemoryGetTreeCommandArgs = Commands['memory_get_tree']['args'];
export type MemoryGetTreeCommandResult = Commands['memory_get_tree']['result'];
export type MemoryListCommandArgs = Commands['memory_list']['args'];
export type MemoryListCommandResult = Commands['memory_list']['result'];
export type MemoryMoveToFolderCommandArgs = Commands['memory_move_to_folder']['args'];
export type MemoryMoveToFolderCommandResult = Commands['memory_move_to_folder']['result'];
export type MemoryReadCommandArgs = Commands['memory_read']['args'];
export type MemoryReadCommandResult = Commands['memory_read']['result'];
export type MemoryRemoveRelationCommandArgs = Commands['memory_remove_relation']['args'];
export type MemoryRemoveRelationCommandResult = Commands['memory_remove_relation']['result'];
export type MemoryRestoreArchivedCommandArgs = Commands['memory_restore_archived']['args'];
export type MemoryRestoreArchivedCommandResult = Commands['memory_restore_archived']['result'];
export type MemoryRestoreStaleCommandArgs = Commands['memory_restore_stale']['args'];
export type MemoryRestoreStaleCommandResult = Commands['memory_restore_stale']['result'];
export type MemorySearchCommandArgs = Commands['memory_search']['args'];
export type MemorySearchCommandResult = Commands['memory_search']['result'];
export type MemorySetAutoCreateSubfoldersCommandArgs = Commands['memory_set_auto_create_subfolders']['args'];
export type MemorySetAutoCreateSubfoldersCommandResult = Commands['memory_set_auto_create_subfolders']['result'];
export type MemorySetAutoExtractFrequencyCommandArgs = Commands['memory_set_auto_extract_frequency']['args'];
export type MemorySetAutoExtractFrequencyCommandResult = Commands['memory_set_auto_extract_frequency']['result'];
export type MemorySetDefaultCategoryCommandArgs = Commands['memory_set_default_category']['args'];
export type MemorySetDefaultCategoryCommandResult = Commands['memory_set_default_category']['result'];
export type MemorySetPrivacyModeCommandArgs = Commands['memory_set_privacy_mode']['args'];
export type MemorySetPrivacyModeCommandResult = Commands['memory_set_privacy_mode']['result'];
export type MemorySetRootFolderCommandArgs = Commands['memory_set_root_folder']['args'];
export type MemorySetRootFolderCommandResult = Commands['memory_set_root_folder']['result'];
export type MemoryToAnkiDocumentCommandArgs = Commands['memory_to_anki_document']['args'];
export type MemoryToAnkiDocumentCommandResult = Commands['memory_to_anki_document']['result'];
export type MemoryUpdateByIdCommandArgs = Commands['memory_update_by_id']['args'];
export type MemoryUpdateByIdCommandResult = Commands['memory_update_by_id']['result'];
export type MemoryUpdateTagsCommandArgs = Commands['memory_update_tags']['args'];
export type MemoryUpdateTagsCommandResult = Commands['memory_update_tags']['result'];
export type MemoryWriteCommandArgs = Commands['memory_write']['args'];
export type MemoryWriteCommandResult = Commands['memory_write']['result'];
export type MemoryWriteBatchCommandArgs = Commands['memory_write_batch']['args'];
export type MemoryWriteBatchCommandResult = Commands['memory_write_batch']['result'];
export type MemoryWriteSmartCommandArgs = Commands['memory_write_smart']['args'];
export type MemoryWriteSmartCommandResult = Commands['memory_write_smart']['result'];
export type QuickAssistantApplyEnabledCommandArgs = Commands['quick_assistant_apply_enabled']['args'];
export type QuickAssistantApplyEnabledCommandResult = Commands['quick_assistant_apply_enabled']['result'];
export type QuickAssistantHideCommandArgs = Commands['quick_assistant_hide']['args'];
export type QuickAssistantHideCommandResult = Commands['quick_assistant_hide']['result'];
export type QuickAssistantShowCommandArgs = Commands['quick_assistant_show']['args'];
export type QuickAssistantShowCommandResult = Commands['quick_assistant_show']['result'];
