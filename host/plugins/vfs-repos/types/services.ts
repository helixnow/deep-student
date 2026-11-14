/** Public service contracts and table-owner maintenance operations. */
import type {} from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  BlobRepository, FolderRepository, IdAliasRepository, PathCacheRepository, TodoItem, TodoRepository,
} from './core.ts';
import type {
  AttachmentProcessingAdapter, AttachmentRepository, EssayRepository, ExamRepository, MediaTranscriptRepository,
  MindmapRepository,
  PomodoroRepository, ReviewPlanRepository, TextbookRepository, TranslationRepository,
} from './content.ts';
import type {
  EmbeddingDimRepository, EmbeddingDimensionRepository, IndexingConfigRepository,
  IndexSegmentRepository, IndexStateRepository, IndexUnitRepository,
} from './indexing.ts';
import type {
  FileRepository, PdfResourceOwner, ResourceLiveReader, ResourceMetadataOwner, ResourceRepository,
} from './files.ts';
import type { QuestionRepository } from './questions.ts';
import type { NoteOwnerWrites } from './note-owner-writes.ts';
import type { StudySpaceRepository } from './study-spaces.ts';

/** Table-owner operations previously implemented inside command plugins (L13b handoff). */
export interface MaintenanceRepository {
  /**
   * indexing.rs:1978-2053: recover indexing text/mm units and resources, in order.
   * Each failed UPDATE warns and contributes zero; returns the sum of changes.
   * Uses only the caller's connection/transaction and millisecond timestamp.
   */
  recoverStuckIndexingWithConn(conn: SqlExecutor, at: number): number;
  /** handlers.rs:1044-1130 `vfs_get_resource_path`. */
  getResourcePath(conn: SqlExecutor, sourceId: string): string;
  /** handlers.rs:1143-1228 `vfs_update_path_cache` (transaction owned here). */
  updatePathCache(conn: SqlExecutor, folderId: string): number;
  /** todo_handlers.rs:1099-1140 `todo_ai_breakdown` DB portion, one savepoint. */
  createTodoSubtasks(conn: SqlExecutor, listId: string, parentId: string, titles: readonly string[]): TodoItem[];
  /** handlers.rs:5855-5880 `vfs_reset_disabled_to_pending`. */
  resetDisabledToPending(conn: SqlExecutor): number;
  /** handlers.rs:5885-5917 `vfs_reset_indexed_without_embeddings`. */
  resetIndexedWithoutEmbeddings(conn: SqlExecutor): number;
  /** handlers.rs:5923-6020 SQLite portion; the caller clears both Lance modalities first. */
  resetAllIndexStateRows(conn: SqlExecutor): VfsIndexResetCounts;
  /**
   * handlers.rs:6976-7309 SQLite/blob portion. `beforeVectorClear` runs after the
   * preview/compressed/OCR branches and before the vector SQL deletes, matching
   * handlers.rs:7161-7178; the caller/L12 owns the Lance file primitive.
   */
  clearMediaCache(conn: SqlExecutor, blobsDir: string, params: ClearMediaCacheParams,
    beforeVectorClear?: BeforeVectorClear): Promise<ClearMediaCacheResult>;
  /** handlers.rs:7793-7827; the caller then marks the resource pending (best-effort, warn on failure). */
  clearResourceOcr(conn: SqlExecutor, resourceId: string): void;
  /**
   * `dstu-sync/backup/mod.rs:2307 reset_rebuildable_vfs_index` 的 SQLite 账本部分：
   * 按现有列把派生索引行恢复到可重建状态（旧 schema 缺列不报错）。调用方负责
   * Lance 目录删除与事务边界；L11 `VfsMaintenanceService.resetRebuildableIndex(targetDir)`
   * 是给 L12/L21 的唯一无连接入口。
   */
  resetRebuildableIndex(conn: SqlExecutor): void;
}
export interface VfsIndexResetCounts {
  deletedSegments: number; deletedUnits: number; updatedResources: number;
  updatedFiles: number; updatedExams: number;
}
export interface ClearMediaCacheParams {
  clearPdfPreview: boolean; clearCompressedImages: boolean; clearOcrText: boolean; clearVectorIndex: boolean;
}
/**
 * Rust handlers.rs:7161-7178 的 Lance 文件阶段结果。`existed` 表示目录存在；
 * `removed` 仅在 `remove_dir_all` 成功后为 true；`bytesFreed` 是删除前目录大小
 * （`calculate_dir_size(...).unwrap_or(0)`）。目录不存在返回 `{existed:false,removed:false,bytesFreed:0}`。
 */
export interface VectorCacheFileClearResult {
  readonly existed: boolean;
  readonly removed: boolean;
  readonly bytesFreed: number;
}
/**
 * L12/命令层的有限文件原语；抛错与 `existed && !removed` 都由 L11 warn 后继续 SQL。
 * 文件系统在移动端只有异步接口，回调按异步约定（同步实现也可返回普通值）。
 */
export type BeforeVectorClear = (lanceDir: string) => VectorCacheFileClearResult | Promise<VectorCacheFileClearResult>;
export interface ClearMediaCacheResult {
  pdfPreviewCleared: number; compressedImagesCleared: number; ocrTextCleared: number;
  vectorIndexCleared: number; totalBytesFreed: number; filesReset: number;
}
export interface VfsReposService {
  /**
   * N5 / L10-V2-01 same-connection owner writes. Production provides this capability;
   * optional at the service boundary for existing implementations. Consumers must check
   * presence once and fail explicitly when missing, never copy its SQL as a fallback.
   */
  readonly noteOwnerWrites?: NoteOwnerWrites;
  readonly idAlias: IdAliasRepository;
  readonly pathCache: PathCacheRepository;
  readonly questions: QuestionRepository;
  readonly todos: TodoRepository;
  readonly folders: FolderRepository;
  readonly blobs: BlobRepository;
  readonly files: FileRepository;
  readonly resources: ResourceRepository & PdfResourceOwner & ResourceLiveReader & ResourceMetadataOwner;
  readonly embeddingDims: EmbeddingDimRepository;
  readonly embeddingSegments: IndexSegmentRepository;
  readonly embeddingUnits: IndexUnitRepository;
  readonly embeddingDimensions: EmbeddingDimensionRepository;
  readonly indexStates: IndexStateRepository;
  readonly indexingConfig: IndexingConfigRepository;
  readonly mediaTranscripts: MediaTranscriptRepository;
  readonly pomodoros: PomodoroRepository;
  readonly textbooks: TextbookRepository;
  readonly translations: TranslationRepository;
  readonly reviewPlans: ReviewPlanRepository;
  readonly essays: EssayRepository;
  readonly exams: ExamRepository;
  readonly attachments: AttachmentRepository;
  /**
   * The production attachment processor used by `attachments` uploads (PDF preview/text,
   * office/text extraction, ZIP manifest), for command lanes that route preview/text the same way.
   */
  readonly attachmentProcessing: AttachmentProcessingAdapter;
  readonly mindmaps: MindmapRepository;
  readonly studySpaces: StudySpaceRepository;
  readonly maintenance: MaintenanceRepository;
}

export const vfsRepoService = { name: 'vfsRepo', version: '1.0.0' } as const;

/** R13-02：L11 所有者业务执行服务的资源搜索类型（notes 由 L10 发布）。 */
export type VfsWorkerSearchType = 'exam' | 'translation' | 'essay';
/**
 * R13v-04：worker 内可执行的 FolderRepository 方法（folder_handlers.rs spawn_blocking）。
 * deleteFolder 会级联到 L10 notes（主线程服务），在其提供 worker 可用入口前不在此列。
 */
export type VfsWorkerFolderOperation = 'createFolder' | 'getFolder' | 'renameFolderIfVersion';
/**
 * R13-02 跨线程执行入口。每个操作在真实 worker_threads 线程里用独立连接执行，
 * 完整执行仓储/事务并回传原业务错误；主线程不共享 `DatabaseHandle`。
 */
export interface VfsWorkerService {
  runTodoOperation<T = unknown>(method: string, args?: readonly unknown[]): Promise<T>;
  runPomodoroOperation<T = unknown>(method: string, args?: readonly unknown[]): Promise<T>;
  /** 参数与 FolderRepository 同名方法相同（去掉 conn）；同一事务/错误/日志在 worker 内执行。 */
  runFolderOperation<T = unknown>(method: VfsWorkerFolderOperation, args?: readonly unknown[]): Promise<T>;
  /** handlers.rs:843-922 的 exam/translation/essay 三类搜索；每次调用使用独立 worker。 */
  runResourceSearch<T = unknown>(type: VfsWorkerSearchType, query: string, limit: number, offset?: number): Promise<T>;
  /** 诊断/测试：worker 的真实 threadId。 */
  workerThreadId(): Promise<number>;
  /**
   * F3 maintenance 暂停接缝：拒绝新操作、等待在途持久/短寿命 worker 完成并关闭连接。
   * 超时后强制终止并抛错；调用方（备份/恢复）不得在超时后继续切换数据库文件。
   */
  pauseAndDrain(timeoutMs?: number): Promise<void>;
  /** 退出 maintenance 后恢复接受新操作（下次调用重新打开 worker 连接）。 */
  resume(): void;
  dispose(): Promise<void>;
}
export const vfsWorkerService = { name: 'vfsWorker', version: '1.0.0' } as const;
/**
 * Table-owner maintenance writes handed over by the command lane (L13b).
 *
 * The provider binds the `vfs` connection and blob directory internally, so
 * command code calls these methods without a connection argument. Only tables
 * owned by L11 are included; Unit/Segment/dimension/Lance maintenance stays
 * with L12 and `memory_config` stays with its owner.
 */
export interface VfsMaintenanceService {
  /** todo_handlers.rs:1099-1140 `todo_ai_breakdown` DB portion, one savepoint. */
  createTodoSubtasks(listId: string, parentId: string, titles: readonly string[]): TodoItem[];
  /** handlers.rs:5855-5880 `vfs_reset_disabled_to_pending`. */
  resetDisabledToPending(): number;
  /** handlers.rs:5885-5917 `vfs_reset_indexed_without_embeddings`. */
  resetIndexedWithoutEmbeddings(): number;
  /** handlers.rs:5923-6020 SQLite portion; the caller clears both Lance modalities first. */
  resetAllIndexStateRows(): VfsIndexResetCounts;
  /** handlers.rs:6976-7309; `beforeVectorClear` is the exact pre-vector file stage. */
  clearMediaCache(params: ClearMediaCacheParams, beforeVectorClear?: BeforeVectorClear): Promise<ClearMediaCacheResult>;
  /** handlers.rs:7793-7827; the caller then best-effort marks the resource pending. */
  clearResourceOcr(resourceId: string): void;
  /** handlers.rs:1044-1130 `vfs_get_resource_path`. */
  getResourcePath(sourceId: string): string;
  /** handlers.rs:1143-1228 `vfs_update_path_cache` (transaction owned here). */
  updatePathCache(folderId: string): number;
  /**
   * `dstu-sync/backup/mod.rs:2307 reset_rebuildable_vfs_index`：恢复候选槽的
   * VFS 派生索引重置唯一入口。先删除 `<targetDir>/databases/lance/vfs`，
   * 再在 `<targetDir>/databases/vfs.db` 的 `BEGIN IMMEDIATE` 内重置 L11 自有表；
   * 文件清理失败时不继续 SQLite 重置。L12 只负责调度与其它派生目录。
   */
  resetRebuildableIndex(targetDir: string): void;
}
export const vfsMaintenanceService = { name: 'vfsMaintenance', version: '1.0.0' } as const;
declare module '@deepseek-ai/cordis' {
  // `vfsMaintenance` stays undeclared here: L13b's provisional
  // `maintenance-needs.ts` already augments Context with the full handoff
  // interface, and declaration merging requires identical property types.
  // Once the coordinator splits that interface, this lane can own the
  // declaration for its subset.
  interface Context { vfsRepo: VfsReposService; vfsWorker: VfsWorkerService }
}
