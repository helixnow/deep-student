/**
 * L13 vfs portable entry: every type of the public surface plus the values whose runtime closure loads no Node
 * module. Local file access uses injected runtime ports, so command implementations are portable too.
 * api.ts re-exports this surface unchanged.
 * Other plugins can switch to this file only after boundary-rules publishes it next to api.ts.
 */
import type {} from '@deepseek-ai/cordis';
import type { DatabaseHandle } from '../../platform/storage/api.ts';
import type { NotesService } from '../notes/api.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';

export const vfsService = { name: 'vfs', version: '1.0.0' } as const;
export const vfsDatabaseService = { name: 'vfsDatabase', version: '1.0.0' } as const;
export const dstuService = { name: 'dstu', version: '1.0.0' } as const;

export { listCommand, listDeletedCommand, listResourcesByTypeWithFolderPath, isMemorySystemHiddenName } from './src/dstu-list.ts';
export { formatExamPreviewForRead, getContentByType, getContentCommand } from './src/dstu-content.ts';
export { createCommand } from './src/dstu-create.ts';
export { updateCommand, updateContentByType } from './src/dstu-update.ts';
export { deleteCommand, deleteResourceByType } from './src/dstu-delete.ts';
export { moveCommand, renameCommand } from './src/dstu-move.ts';
export { parseNoteMetadataUpdate, setMetadataCommand } from './src/dstu-metadata.ts';
export { setFavoriteCommand } from './src/dstu-favorite.ts';
export { getResourceByTypeAndId } from './src/dstu-resource.ts';
export { buildSnippet, searchAll, searchByIndex, searchCommand, searchInFolderCommand, searchNotes } from './src/dstu-search.ts';
export * as vfsRepositories from './repository/index.ts';
export { computeHash, computeHashWithSalt, currentDeviceId, nowIso } from './repository/create.ts';
export { UnitBuilderRegistry } from './src/unit-builders.ts';
export { VfsUnitIndexService } from './src/unit-index-service.ts';
export {
  addSpaceMountCommand, deleteAnchorEdgesBySourceCommand, deleteStudySpaceProfileCommand,
  ensureInboxFolderCommand, getStudySpaceProfileCommand, listSpaceMountsCommand,
  listStudySpaceProfilesCommand, queryAnchorEdgesByTargetCommand, removeSpaceMountCommand,
  studySpaceCommands, upsertAnchorEdgesCommand, upsertStudySpaceProfileCommand,
} from './src/study-spaces.ts';
export type {
  AnchorEdgeRecord, AnchorEdgeWireInput, AnchorEdgesDeleteResult, AnchorEdgesUpsertResult,
  CreateSpaceMountInput, InboxFolderInfo, InboxFolderSummary, ListSpaceMountsFilter,
  RemoveSpaceMountInput, ResolvedMountScope, SpaceMountItemType, StudySpaceMemoryScope,
  StudySpaceMount, StudySpaceProfile, UpsertStudySpaceProfileInput, WorkbenchLayoutPreset,
} from '../vfs-repos/api.ts';

// Retain the public owner types for vfs consumers; implementations are provided by L10/L11.
declare module '@deepseek-ai/cordis' {
  interface Context {
    notes: NotesService;
    vfsRepo: VfsReposService;
  }
}

export type * from '../../../contracts/ipc/generated/L13-vfs-api.ts';
export { VfsError } from './src/error.ts';
export type { VfsErrorFields, VfsErrorKind, VfsCommandError } from './src/error.ts';
export { DstuFailure } from './src/dstu-error.ts';
export type { BreadcrumbItem, FolderResourceInfo, FolderResourcesResult, FolderTreeNode, VfsFolder, VfsFolderItem } from './src/folder-types.ts';
export { folderErrors, MAX_FOLDER_DEPTH, MAX_FOLDERS_COUNT, MAX_FOLDER_TITLE_LENGTH, MAX_INJECT_RESOURCES, canonicalFolderItemType } from './src/folder-types.ts';
export { DstuListOptions, createFileOptions, createFolderNode, createFolderOptions, createNoteOptions, createResourceNode,
  createdEvent, deletedEvent, dstuNodeTypeDisplayNameKey, dstuNodeTypeFromString, dstuNodeTypePreviewType,
  dstuNodeTypeToPathSegment, movedEvent, purgedEvent, restoredEvent, updatedEvent, withCreateOptionsMetadata,
  withNodeChildCount, withNodeChildren, withNodeMetadata, withNodePreviewType, withNodeResourceHash,
  withNodeSize, withNodeTimestamps } from './src/dstu-types.ts';
export type { DstuCreateOptions, DstuNode, DstuNodeType, DstuPropFilter, DstuWatchEvent, DstuWatchEventType } from './src/dstu-types.ts';
export { attachmentToDstuNode, createTypeFolder, essayToDstuNode, examToDstuNode, fileToDstuNode,
  generateResourceId, isOpaqueDocumentId, itemTypeToDstuNodeType, mindmapToDstuNode, noteToDstuNode,
  parseTimestamp, previewTypeFromExtension, previewTypeFromFilename, sanitizeTextbookDisplayName,
  sessionToDstuNode, textbookToDstuNode, translationToDstuNode } from './src/node-converters.ts';
export type { VfsEssaySession } from './src/node-converters.ts';
export type { VfsNote } from '../../../contracts/ipc/generated/_shared.ts';
export { ParsedPath, parseDstuPath, parseRealPath, buildRealPath, buildSimpleResourcePath, getResourceTypeFromId,
  isValidPath, isValidResourceId, isParentPath, getParentPath, getPathName, extractResourceId, extractFolderPath } from './src/paths.ts';
export type { RealParsedPath } from './src/paths.ts';
export { extractResourceInfo, extractSimpleId, inferResourceTypeFromId, isUuidFormat } from './src/path-utils.ts';
export type { DstuSetFavoriteArgs, DstuSetFavoriteDeps } from './src/dstu-favorite.ts';
export type { DstuSetMetadataArgs, DstuSetMetadataDeps } from './src/dstu-metadata.ts';
export type { ResourceFetchDeps } from './src/dstu-resource.ts';
export type { DstuDeleteDeps } from './src/dstu-delete.ts';
export type { DstuUpdateArgs, DstuUpdateDeps } from './src/dstu-update.ts';
export { nanoid } from './src/nanoid.ts';
export { parseSerdeJson } from './repository/json.ts';
export { readSchemaVersion } from './repository/database.ts';
/** L14 needs to publish this method on qbank for original exam exports. */
export type { QbankExportHook } from './src/export.ts';
export { contextWithConn, contextText, imageRefs } from './repository/qbank-read.ts';
export type { CanonicalContextDocument } from './repository/qbank-read.ts';
export type { UnitBuildInput, UnitBuildOutput, UnitBuilder } from './src/unit-builders.ts';
export type { DeleteIndexResult } from './src/unit-index-service.ts';
export * as mediaIndex from './src/media-index.ts';
export * as ocr from './src/ocr.ts';
export { UploadSaga } from './src/upload-saga.ts';
export { uploadSavepoint } from './repository/upload-saga.ts';
export { AttachmentConfig } from './src/attachment-config.ts';
export type { AttachmentConfigStore } from './src/attachment-config.ts';
export type { ResourceCreatedHook, ResourceCreatedHooks } from './src/resource-created-hooks.ts';
/** Pending L07/L17 ports; the executor stays unregistered until its runtime dependencies are published. */
export type { GenerativeResearchPort, VfsToolRegistrationPort } from './src/tools/generative-ui.ts';
export type { DstuUploadRoots, DstuUploadPort } from './src/tools/dstu-executor.ts';
/** L04 shared attachment errors are required before L07 can register attachment tools. */
export type { AttachmentErrorPort } from './src/tools/attachment-executor.ts';
/** Rust `builtin_retrieval_executor.rs::build_numbered_sources`, shared with memory's research executors. */
export { buildNumberedSources } from './src/tools/retrieval-sources.ts';
export type { RetrievalToolArgsPort, MemoryRetrievalPort, CompressedRetrievalMemory, ChatRetrievalScopePort,
  CancellableRetrievalPort, CancellableWebSearchPort } from './src/tools/retrieval-executor.ts';
export type { RetrievalRerankerPort, RerankChunk, RerankMultimodalInput } from './src/tools/retrieval-rerank.ts';
export type { MindmapXmlParser, MindmapXmlNode } from './src/tools/mindmap-import-xml.ts';
export type { VirtualFilePolicy } from './src/tools/mindmap-import.ts';
import type * as repositories from './repository/index.ts';
import type { DstuParsedPath } from '../../../contracts/ipc/generated/L13-vfs-api.ts';

/** Rust Result is represented by a returned value or a thrown VfsError. */
export type VfsResult<T> = T;
export type VfsPooledConnection = DatabaseHandle;
/** dstu-storage/src/migration/vfs.rs; verified against the shipped migration set. */
export const CURRENT_SCHEMA_VERSION = 20261111;

export interface VfsDatabaseStats {
  resource_count: number;
  note_count: number;
  textbook_count: number;
  exam_count: number;
  translation_count: number;
  essay_count: number;
  blob_count: number;
  schema_version: number;
}

/** Shared F3-backed handle; callers keep SQL in their own repository/. */
export interface VfsDatabase {
  getConn(): VfsResult<DatabaseHandle>;
  getConnSafe(): VfsResult<DatabaseHandle>;
  dbPath(): string;
  blobsDir(): string;
  appDataDir(): string;
  enterMaintenanceMode(): Promise<void>;
  exitMaintenanceMode(): Promise<void>;
  isInMaintenanceMode(): boolean;
  reinitialize(): Promise<void>;
  isForeignKeysEnabled(): boolean;
  getSchemaVersion(): number;
  getStatistics(): VfsDatabaseStats;
}

export interface VfsService {
  readonly version: 1;
  readonly database: VfsDatabase;
  /** VFS repositories shared by other lanes (Rust `vfs::repos`). */
  readonly repositories: typeof repositories;
  readonly unitIndex: import('./src/unit-index-service.ts').VfsUnitIndexService;
  readonly mediaIndex: typeof import('./src/media-index.ts');
  readonly ocr: typeof import('./src/ocr.ts');
  readonly attachmentConfig: import('./src/attachment-config.ts').AttachmentConfig;
  /** vfs/hooks.rs register_resource_created_hook / notify_resource_created (optional for consumer doubles). */
  readonly resourceCreatedHooks?: import('./src/resource-created-hooks.ts').ResourceCreatedHooks;
  readonly upload: {
    createSaga(): import('./src/upload-saga.ts').UploadSaga;
    withSavepoint<T>(conn: import('../../platform/storage/api.ts').SqlExecutor, name: string, work: () => T): T;
  };
  /**
   * The same function as the `buildNumberedSources` export. Consumers that must stay out of the api.ts runtime
   * closure (memory on mobile) take it from the service and import only types from here.
   */
  readonly buildNumberedSources: typeof import('./src/tools/retrieval-sources.ts').buildNumberedSources;
}

export interface DstuService {
  readonly version: 1;
  parsePath(path: string): DstuParsedPath;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Separate provider prevents a dependency cycle with L11 repositories. */
    vfsDatabase: VfsDatabase;
    vfs: VfsService;
    dstu: DstuService;
    /** memory `paper_save` VFS owner port (`paper_save_executor.rs:582-740`). */
    paperLibrary: import('../memory/api.ts').PaperLibraryPort;
  }
}
