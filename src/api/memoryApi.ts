import { invoke } from '@tauri-apps/api/core';

export type AutoExtractFrequency = 'off' | 'balanced' | 'aggressive';

export interface MemoryConfig {
  memoryRootFolderId: string | null;
  memoryRootFolderTitle: string | null;
  autoCreateSubfolders: boolean;
  defaultCategory: string;
  privacyMode: boolean;
  autoExtractFrequency: AutoExtractFrequency;
}

export interface MemorySearchResult {
  noteId: string;
  noteTitle: string;
  folderPath: string;
  chunkText: string;
  score: number;
}

export interface MemoryListItem {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: string;
  hits: number;
  isImportant: boolean;
  isStale: boolean;
  /** 已归档（休眠层：已移出检索索引与分类聚合，笔记本体保留，可恢复） */
  isArchived?: boolean;
  /** 待去重复核（去重管线不可用时写入的显式记忆） */
  needsDedupReview?: boolean;
  memoryType: string;
  memoryPurpose: string;
}

export interface MemoryReadOutput {
  noteId: string;
  title: string;
  content: string;
  folderPath: string;
  updatedAt: string;
}

export interface MemoryWriteOutput {
  noteId: string;
  isNew: boolean;
  resourceId: string;
}

export interface SmartWriteOutput {
  noteId: string;
  event: 'ADD' | 'UPDATE' | 'APPEND' | 'DELETE' | 'NONE' | 'FILTERED';
  isNew: boolean;
  confidence: number;
  reason: string;
  resourceId?: string;
  downgraded: boolean;
}

export type MemoryTypeValue = 'fact' | 'study' | 'note';

export interface MemoryBatchWriteItemInput {
  title: string;
  content: string;
  folderPath?: string;
  memoryType?: MemoryTypeValue;
  memoryPurpose?: MemoryPurposeType;
  idempotencyKey?: string;
}

export interface MemoryBatchWriteItemResult {
  title: string;
  noteId: string;
  event: SmartWriteOutput['event'];
  isNew: boolean;
  confidence: number;
  reason: string;
  downgraded: boolean;
}

export interface MemoryBatchWriteOutput {
  total: number;
  succeeded: number;
  failed: number;
  added: number;
  updated: number;
  skipped: number;
  filtered: number;
  results: MemoryBatchWriteItemResult[];
}

export interface FolderTreeNode {
  folder: {
    id: string;
    parentId: string | null;
    title: string;
    sortOrder: number;
    isExpanded: boolean;
    createdAt: string;
    updatedAt: string;
  };
  children: FolderTreeNode[];
  items: Array<{
    id: string;
    folderId: string | null;
    itemType: string;
    itemId: string;
    sortOrder: number;
    createdAt: string;
  }>;
}

export async function getMemoryConfig(): Promise<MemoryConfig> {
  return invoke<MemoryConfig>('memory_get_config');
}

export async function setMemoryRootFolder(folderId: string): Promise<void> {
  return invoke('memory_set_root_folder', { folderId });
}

export async function setMemoryPrivacyMode(enabled: boolean): Promise<void> {
  return invoke('memory_set_privacy_mode', { enabled });
}

export async function setMemoryAutoCreateSubfolders(enabled: boolean): Promise<void> {
  return invoke('memory_set_auto_create_subfolders', { enabled });
}

export async function setMemoryDefaultCategory(category: string): Promise<void> {
  return invoke('memory_set_default_category', { category });
}

export async function setMemoryAutoExtractFrequency(frequency: AutoExtractFrequency): Promise<void> {
  return invoke('memory_set_auto_extract_frequency', { frequency });
}

export async function createMemoryRootFolder(title: string): Promise<string> {
  return invoke<string>('memory_create_root_folder', { title });
}

export async function searchMemory(
  query: string,
  topK?: number
): Promise<MemorySearchResult[]> {
  return invoke<MemorySearchResult[]>('memory_search', { query, topK });
}

export async function readMemory(
  noteId: string
): Promise<MemoryReadOutput | null> {
  return invoke<MemoryReadOutput | null>('memory_read', { noteId });
}

export async function writeMemory(
  title: string,
  content: string,
  folderPath?: string,
  mode?: 'create' | 'update' | 'append'
): Promise<MemoryWriteOutput> {
  return invoke<MemoryWriteOutput>('memory_write', {
    folderPath,
    title,
    content,
    mode,
  });
}

export async function listMemory(
  folderPath?: string,
  limit?: number,
  offset?: number
): Promise<MemoryListItem[]> {
  return invoke<MemoryListItem[]>('memory_list', {
    folderPath,
    limit,
    offset,
  });
}

export async function getMemoryTree(): Promise<FolderTreeNode | null> {
  return invoke<FolderTreeNode | null>('memory_get_tree');
}

export async function addMemoryRelation(noteIdA: string, noteIdB: string): Promise<void> {
  return invoke('memory_add_relation', { noteIdA, noteIdB });
}

export async function removeMemoryRelation(noteIdA: string, noteIdB: string): Promise<void> {
  return invoke('memory_remove_relation', { noteIdA, noteIdB });
}

export async function getRelatedMemories(noteId: string): Promise<string[]> {
  return invoke<string[]>('memory_get_related', { noteId });
}

export async function updateMemoryTags(noteId: string, tags: string[]): Promise<void> {
  return invoke('memory_update_tags', { noteId, tags });
}

/** 恢复过时记忆（摘除 `_stale` 标记）。返回是否实际发生了恢复。 */
export async function restoreStaleMemory(noteId: string): Promise<boolean> {
  return invoke<boolean>('memory_restore_stale', { noteId });
}

/** 恢复已归档记忆（摘除 `_archived` 并重建索引）。返回是否实际发生了恢复。 */
export async function restoreArchivedMemory(noteId: string): Promise<boolean> {
  return invoke<boolean>('memory_restore_archived', { noteId });
}

export async function getMemoryTags(noteId: string): Promise<string[]> {
  return invoke<string[]>('memory_get_tags', { noteId });
}

export interface MemoryAnkiDocument {
  documentContent: string;
  memoryCount: number;
  documentName: string;
}

export async function memoryToAnkiDocument(
  folderPath?: string,
  purposeFilter?: string,
  limit?: number
): Promise<MemoryAnkiDocument> {
  return invoke<MemoryAnkiDocument>('memory_to_anki_document', {
    folderPath,
    purposeFilter,
    limit,
  });
}

export interface BatchOperationResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

export async function batchDeleteMemories(noteIds: string[]): Promise<BatchOperationResult> {
  return invoke<BatchOperationResult>('memory_batch_delete', { noteIds });
}

export async function batchMoveMemories(
  noteIds: string[],
  targetFolderPath: string
): Promise<BatchOperationResult> {
  return invoke<BatchOperationResult>('memory_batch_move', { noteIds, targetFolderPath });
}

export async function moveMemoryToFolder(
  noteId: string,
  targetFolderPath: string
): Promise<void> {
  return invoke('memory_move_to_folder', { noteId, targetFolderPath });
}

// ★ 修复风险2：按 note_id 更新记忆
export async function updateMemoryById(
  noteId: string,
  title?: string,
  content?: string
): Promise<MemoryWriteOutput> {
  return invoke<MemoryWriteOutput>('memory_update_by_id', {
    noteId,
    title,
    content,
  });
}

// ★ 修复风险3：删除记忆
export async function deleteMemory(noteId: string): Promise<void> {
  return invoke('memory_delete', { noteId });
}

export interface MemoryExportItem {
  title: string;
  content: string;
  folder: string;
  updatedAt: string;
}

export interface MemoryProfileSection {
  category: string;
  content: string;
}

export async function getMemoryProfile(): Promise<MemoryProfileSection[]> {
  return invoke<MemoryProfileSection[]>('memory_get_profile');
}

export async function exportAllMemories(): Promise<MemoryExportItem[]> {
  return invoke<MemoryExportItem[]>('memory_export_all');
}

export type MemoryPurposeType = 'internalized' | 'memorized' | 'supplementary' | 'systemic';

export async function writeMemorySmart(
  title: string,
  content: string,
  folderPath?: string,
  memoryType?: MemoryTypeValue,
  memoryPurpose?: MemoryPurposeType,
  idempotencyKey?: string
): Promise<SmartWriteOutput> {
  return invoke<SmartWriteOutput>('memory_write_smart', {
    folderPath,
    title,
    content,
    memoryType,
    memoryPurpose,
    idempotencyKey,
  });
}

export async function writeMemoryBatch(
  items: MemoryBatchWriteItemInput[],
  defaultFolderPath?: string,
  defaultMemoryType?: MemoryTypeValue,
  defaultMemoryPurpose?: MemoryPurposeType
): Promise<MemoryBatchWriteOutput> {
  return invoke<MemoryBatchWriteOutput>('memory_write_batch', {
    items,
    defaultFolderPath,
    defaultMemoryType,
    defaultMemoryPurpose,
  });
}

export interface MemoryAuditLogItem {
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
}

export async function getMemoryAuditLogs(params?: {
  limit?: number;
  offset?: number;
  sourceFilter?: string;
  operationFilter?: string;
  successFilter?: boolean;
}): Promise<MemoryAuditLogItem[]> {
  return invoke<MemoryAuditLogItem[]>('memory_get_audit_logs', params ?? {});
}

// ------------------------------------------------------------------ Memory v2 Kernel API (RFC-001 M1/M3)

export type MemoryHardRuleOrigin = 'user_explicit' | 'chat_correction' | 'dialectic_promoted';

export interface MemoryHardRule {
  id: string;
  instruction: string;
  scope: string;
  origin: MemoryHardRuleOrigin;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryHardRulesDocument {
  version: number;
  updated_at: string;
  rules: MemoryHardRule[];
}

export interface LearnerWeakPoint {
  subject: string;
  knowledge_point: string;
  error_pattern: string;
  evidence_count: number;
  last_seen?: string | null;
  source?: string | null;
}

export interface LearnerProfileView {
  version: number;
  updated_at: string;
  weak_points: LearnerWeakPoint[];
  preferences: {
    explanation_style?: string | null;
    language?: string | null;
    pace?: string | null;
    others: string[];
  };
  goals: Array<{ goal: string; deadline?: string | null }>;
  recent_status?: string | null;
}

export interface MemoryInspectionView {
  providerId: string;
  privacyMode: boolean;
  hardRules: MemoryHardRulesDocument;
  learnerProfile: LearnerProfileView;
  profileHistory: LearnerProfileView[];
  renderedKernelPreview: string;
  budgets: {
    rulesChars: number;
    rulesMaxChars: number;
    profileChars: number;
    profileMaxChars: number;
  };
}

export type MemoryKernelMutation =
  | {
    kind: 'upsert_rule';
    input: {
      id?: string | null;
      instruction: string;
      scope?: string | null;
      origin?: MemoryHardRuleOrigin;
      pinned?: boolean;
    };
  }
  | { kind: 'remove_rule'; idOrInstruction: string }
  | {
    kind: 'update_profile';
    update: {
      weak_points_add: LearnerWeakPoint[];
      weak_points_remove: Array<{ subject: string; knowledge_point: string }>;
      preferences?: {
        explanation_style?: string | null;
        language?: string | null;
        pace?: string | null;
        others_add: string[];
        others_remove: string[];
      } | null;
      goals_add: Array<{ goal: string; deadline?: string | null }>;
      goals_remove: string[];
      recent_status?: string | null;
    };
  }
  | { kind: 'rollback_profile'; targetVersion: number }
  | { kind: 'set_budgets'; rulesMaxChars?: number; profileMaxChars?: number };

export async function inspectMemoryKernel(): Promise<MemoryInspectionView> {
  return invoke<MemoryInspectionView>('plugin:host|call', {
    caller: 'dstu.memory',
    service: 'memoryProvider',
    method: 'inspect',
    args: [],
  });
}

export async function mutateMemoryKernel(mutation: MemoryKernelMutation): Promise<MemoryInspectionView> {
  return invoke<MemoryInspectionView>('plugin:host|call', {
    caller: 'dstu.memory',
    service: 'memoryProvider',
    method: 'mutateFromUser',
    args: [mutation],
  });
}
