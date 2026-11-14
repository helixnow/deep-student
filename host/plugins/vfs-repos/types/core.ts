/** Core VFS contracts: path cache, aliases, todos, folders and blobs. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface PathCacheEntry { itemType: string; itemId: string; fullPath: string; folderPath: string; updatedAt: string }
export interface PathCacheStats { totalCount: number; folderCount: number; resourceCount: number }
/** Explicit connection keeps a caller's VFS transaction on that same connection. */
export interface IdAliasRepository {
  tableExists(conn: SqlExecutor, tableName: string): boolean;
  resolvePersistedIdAlias(conn: SqlExecutor, tableName: string, recordId: string): string;
  resolveAliasWithLookup(tableName: string, recordId: string, lookup: (id: string) => string | null): string;
}
export interface PathCacheRepository {
  ensureTableExists(conn: SqlExecutor): void;
  getPath(conn: SqlExecutor, itemType: string, itemId: string): PathCacheEntry | null;
  getByFullPath(conn: SqlExecutor, fullPath: string): PathCacheEntry | null;
  setPath(conn: SqlExecutor, entry: PathCacheEntry): void;
  setPathsBatch(conn: SqlExecutor, entries: readonly PathCacheEntry[]): number;
  invalidate(conn: SqlExecutor, itemType: string, itemId: string): boolean;
  invalidateByFolder(conn: SqlExecutor, folderId: string): number;
  invalidateByFoldersBatch(conn: SqlExecutor, folderIds: readonly string[]): number;
  invalidateByPathPrefix(conn: SqlExecutor, pathPrefix: string): number;
  rebuildAll(conn: SqlExecutor): number;
  rebuildFolder(conn: SqlExecutor, folderId: string): number;
  getOrComputePath(conn: SqlExecutor, itemType: string, itemId: string): PathCacheEntry;
  getStats(conn: SqlExecutor): PathCacheStats;
}
/** VfsTodoList types mirror todo_repo.rs serde output (camelCase, `skip_serializing_if` fields omitted). */
export interface TodoList {
  id: string; title: string; description?: string; icon?: string; color?: string;
  sortOrder: number; isDefault: boolean; isFavorite: boolean;
  createdAt: string; updatedAt: string; deletedAt?: string;
}
export interface TodoItem {
  id: string; todoListId: string; title: string; description?: string;
  status: string; priority: string; dueDate?: string; dueTime?: string; reminder?: string;
  tagsJson: string; sortOrder: number; parentId?: string; completedAt?: string;
  repeatJson?: string; attachmentsJson: string; estimatedPomodoros?: number;
  completedPomodoros?: number; createdAt: string; updatedAt: string; deletedAt?: string;
}
export interface CreateTodoListParams {
  title: string; description?: string | null; icon?: string | null; color?: string | null; isDefault?: boolean;
}
export interface UpdateTodoListParams {
  title?: string | null; description?: string | null; icon?: string | null; color?: string | null;
}
export interface CreateTodoItemParams {
  todoListId: string; title: string; description?: string | null; priority?: string;
  dueDate?: string | null; dueTime?: string | null; reminder?: string | null;
  tags?: readonly string[] | null; parentId?: string | null;
  attachments?: readonly string[] | null; repeatJson?: string | null;
}
export interface UpdateTodoItemParams {
  title?: string | null; description?: string | null; status?: string | null;
  priority?: string | null; dueDate?: string | null; dueTime?: string | null;
  reminder?: string | null; tags?: readonly string[] | null; parentId?: string | null;
  attachments?: readonly string[] | null; repeatJson?: string | null;
  estimatedPomodoros?: number | null; expectedUpdatedAt?: string | null;
}
export interface TodoListCount { listId: string; pendingCount: number }
export interface TodoCountsSnapshot {
  todayCount: number; upcomingCount: number; inboxCount: number; allPendingCount: number; perList: TodoListCount[];
}
export interface TodoBatchItemsResult { items: TodoItem[]; skippedIds: string[] }
export interface TodoBatchIdsResult { affectedIds: string[]; skippedIds: string[] }
export interface TodoTrashCounts { deletedItems: number; deletedLists: number }
export interface TodoDailyCompletionStat { date: string; completedCount: number; createdCount: number }
export interface TodoListDistributionStat {
  listId: string; listTitle: string; pendingCount: number; completedCount: number;
}
export interface TodoTagDistributionStat { tag: string; pendingCount: number; completedCount: number }
export interface TodoPriorityDistributionStat { priority: string; pendingCount: number }
export interface TodoStatsOverview {
  totalPending: number; totalCompleted: number; completedToday: number; overdueCount: number;
  completionTrend: TodoDailyCompletionStat[]; byList: TodoListDistributionStat[];
  byPriority: TodoPriorityDistributionStat[]; byTag: TodoTagDistributionStat[];
}
export interface TagCountEntry { tag: string; count: number }
export interface TodoItemWithChildStats extends TodoItem { subtaskCount: number; completedSubtaskCount: number }
export interface TodoSummaryItem {
  id: string; title: string; priority: string; dueDate: string | null; dueTime: string | null; listTitle: string;
}
export interface TodoStats { totalPending: number; todayDue: number; overdueCount: number; todayCompleted: number }
export interface TodoActiveSummary {
  todayItems: TodoSummaryItem[]; overdueItems: TodoSummaryItem[];
  upcomingHighPriority: TodoSummaryItem[]; stats: TodoStats;
}
/** Connection-bound VfsTodoRepo operations. */
export interface TodoRepository {
  createTodoList(conn: SqlExecutor, params: CreateTodoListParams): TodoList;
  getTodoList(conn: SqlExecutor, id: string): TodoList | null;
  listTodoLists(conn: SqlExecutor): TodoList[];
  updateTodoList(conn: SqlExecutor, id: string, params: UpdateTodoListParams): TodoList;
  updateTodoListIfVersion(conn: SqlExecutor, id: string, params: UpdateTodoListParams, expectedUpdatedAt: string): [TodoList, TodoList];
  deleteTodoList(conn: SqlExecutor, id: string): void;
  deleteTodoListIfVersion(conn: SqlExecutor, id: string, expectedUpdatedAt: string): TodoList;
  restoreTodoList(conn: SqlExecutor, id: string): TodoList;
  toggleTodoListFavorite(conn: SqlExecutor, id: string): TodoList;
  reorderTodoLists(conn: SqlExecutor, listIds: readonly string[]): void;
  ensureDefaultInbox(conn: SqlExecutor, title?: string | null): TodoList;
  listDeletedTodoLists(conn: SqlExecutor, limit: number, offset: number): TodoList[];
  countDeletedTodoLists(conn: SqlExecutor): number;
  purgeTodoList(conn: SqlExecutor, id: string): void;
  purgeDeletedTodoLists(conn: SqlExecutor): number;
  createTodoItem(conn: SqlExecutor, params: CreateTodoItemParams): TodoItem;
  getTodoItem(conn: SqlExecutor, id: string): TodoItem | null;
  listItemsByList(conn: SqlExecutor, listId: string, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItem[];
  updateTodoItem(conn: SqlExecutor, id: string, params: UpdateTodoItemParams): TodoItem;
  toggleTodoItem(conn: SqlExecutor, id: string, expectedUpdatedAt?: string | null): TodoItem;
  deleteTodoItem(conn: SqlExecutor, id: string): void;
  deleteTodoItemIfVersion(conn: SqlExecutor, id: string, expectedUpdatedAt: string): TodoItem;
  restoreTodoItem(conn: SqlExecutor, id: string): TodoItem;
  reorderItems(conn: SqlExecutor, listId: string, itemIds: readonly string[], expectedUpdatedAt?: string | null): void;
  moveTodoItem(conn: SqlExecutor, id: string, targetListId: string): TodoItem;
  listTodayItems(conn: SqlExecutor, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItem[];
  listOverdueItems(conn: SqlExecutor, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItem[];
  listAllPendingItems(conn: SqlExecutor): TodoItem[];
  listReminderItems(conn: SqlExecutor): TodoItem[];
  listUpcomingItems(conn: SqlExecutor, days: number, includeCompleted: boolean): TodoItem[];
  listCompletedItems(conn: SqlExecutor, listId?: string | null): TodoItem[];
  searchItems(conn: SqlExecutor, query: string): TodoItem[];
  searchItemsPaginated(conn: SqlExecutor, query: string, limit: number, offset: number): [TodoItem[], number];
  countsSnapshot(conn: SqlExecutor): TodoCountsSnapshot;
  getActiveTodoSummary(conn: SqlExecutor): TodoActiveSummary | null;
  formatActiveSummaryForPrompt(summary: TodoActiveSummary): string;
  listDeletedTodoItems(conn: SqlExecutor, limit: number, offset: number): TodoItem[];
  countDeletedTodoItems(conn: SqlExecutor): number;
  purgeTodoItem(conn: SqlExecutor, id: string): void;
  purgeDeletedTodoItems(conn: SqlExecutor): number;
  trashCounts(conn: SqlExecutor): TodoTrashCounts;
  batchCompleteItems(conn: SqlExecutor, itemIds: readonly string[]): [TodoBatchItemsResult, string[]];
  batchRescheduleItems(conn: SqlExecutor, itemIds: readonly string[], dueDate?: string | null, dueTime?: string | null): TodoBatchItemsResult;
  batchSetPriorityItems(conn: SqlExecutor, itemIds: readonly string[], priority: string): TodoBatchItemsResult;
  batchMoveItems(conn: SqlExecutor, itemIds: readonly string[], targetListId: string): TodoBatchItemsResult;
  batchDeleteItems(conn: SqlExecutor, itemIds: readonly string[]): TodoBatchIdsResult;
  batchRestoreItems(conn: SqlExecutor, itemIds: readonly string[]): TodoBatchItemsResult;
  batchPurgeItems(conn: SqlExecutor, itemIds: readonly string[]): TodoBatchIdsResult;
  statsOverview(conn: SqlExecutor, days: number): TodoStatsOverview;
  listAllTags(conn: SqlExecutor): TagCountEntry[];
  listItemsWithChildStats(conn: SqlExecutor, listId: string, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItemWithChildStats[];
}
/** VfsFolder mirrors folder_repo.rs serde output (camelCase, absent optional fields). */
export interface VfsFolder {
  id: string; parentId?: string; title: string; icon?: string; color?: string;
  isExpanded: boolean; isFavorite: boolean; sortOrder: number; createdAt: number; updatedAt: number;
}
/** VfsFolderItem mirrors folder_repo.rs serde output. */
export interface VfsFolderItem {
  id: string; folderId?: string; itemType: string; itemId: string;
  sortOrder: number; createdAt: number; cachedPath?: string;
}
/** dstu folder_handlers.rs `BreadcrumbItem`. */
export interface VfsBreadcrumbItem { id: string; name: string }
export interface FolderTreeNode { folder: VfsFolder; children: FolderTreeNode[]; items: VfsFolderItem[] }
export interface FolderResourceInfo {
  itemType: string; itemId: string; resourceId?: string; title: string; path: string; content?: string;
}
export interface FolderResourcesResult {
  folderId: string; folderTitle: string; path: string; totalCount: number; resources: FolderResourceInfo[];
}
export interface ResourceLocation {
  id: string; resourceType: string; folderId?: string; folderPath: string; fullPath: string; hash?: string;
}
/** VfsBlob mirrors blob_repo.rs serde output. */
export interface VfsBlob {
  hash: string; relativePath: string; size: number; mimeType?: string; refCount: number; createdAt: number;
}
export interface StagedBlob { readonly hash: string; readonly size: number; path: string | null }
export interface BlobRepository {
  storeBlob(conn: SqlExecutor, blobsDir: string, data: Uint8Array, mimeType?: string | null, extension?: string | null): VfsBlob;
  stageStream(blobsDir: string, chunks: Iterable<Uint8Array>, maxBytes: number): StagedBlob;
  storeStagedBlob(conn: SqlExecutor, blobsDir: string, staged: StagedBlob, mimeType?: string | null, extension?: string | null): VfsBlob;
  getBlob(conn: SqlExecutor, hash: string): VfsBlob | null;
  blobExists(conn: SqlExecutor, hash: string): boolean;
  getBlobPath(conn: SqlExecutor, blobsDir: string, hash: string): string | null;
  /** Null when a stored relative_path would leave vfs_blobs (absolute, `..`, or a symlinked directory). */
  resolveBlobPath(blobsDir: string, relativePath: string): string | null;
  incrementRef(conn: SqlExecutor, hash: string): number;
  decrementRef(conn: SqlExecutor, hash: string): number;
  cleanupBlob(conn: SqlExecutor, blobsDir: string, hash: string): boolean;
  prepareBlobDeletion(conn: SqlExecutor, blobsDir: string, blob: VfsBlob): { operationId: string } | null;
  recoverPreparedBlobDeletions(conn: SqlExecutor, blobsDir: string): number;
  removeUnregisteredBlobFile(conn: SqlExecutor, blobsDir: string, hash: string): boolean;
  cleanupUnreferenced(conn: SqlExecutor, blobsDir: string): number;
}
/** Entity operations the folder cascade delegates to sibling repositories. */
export interface FolderEntityAdapter {
  softDelete(conn: SqlExecutor, itemId: string): void;
  restore(conn: SqlExecutor, itemId: string): void;
  purge(conn: SqlExecutor, itemId: string, blobsDir?: string): void;
}
export type FolderEntityAdapters = Partial<Record<string, FolderEntityAdapter>>;
export interface FolderCascadeDependencies {
  adapters?: FolderEntityAdapters;
  cleanupUnreferencedBlobs?(conn: SqlExecutor, blobsDir?: string): void;
}
export interface FolderRepository {
  createFolder(conn: SqlExecutor, folder: VfsFolder): void;
  getFolder(conn: SqlExecutor, folderId: string): VfsFolder | null;
  folderExists(conn: SqlExecutor, folderId: string): boolean;
  getFolderDepth(conn: SqlExecutor, folderId: string): number;
  countAllFolders(conn: SqlExecutor): number;
  listAllFolders(conn: SqlExecutor): VfsFolder[];
  listFoldersByParent(conn: SqlExecutor, parentId: string | null): VfsFolder[];
  getResourceLocation(conn: SqlExecutor, itemType: string, itemId: string): ResourceLocation | null;
  getFolderItemByItemId(conn: SqlExecutor, itemType: string, itemId: string): VfsFolderItem | null;
  getFolderItemByCachedPath(conn: SqlExecutor, cachedPath: string): VfsFolderItem | null;
  removeItemByItemId(conn: SqlExecutor, itemType: string, itemId: string): boolean;
  listItemsByFolder(conn: SqlExecutor, folderId: string | null): VfsFolderItem[];
  listAllAssignedItemIds(conn: SqlExecutor): Set<string>;
  addItemToFolder(conn: SqlExecutor, item: VfsFolderItem): void;
  moveItemByItemId(conn: SqlExecutor, itemType: string, itemId: string, newFolderId: string | null): void;
  moveItemsBatch(conn: SqlExecutor, items: readonly (readonly [string, string])[], newFolderId: string | null): number;
  updateFolder(conn: SqlExecutor, folder: VfsFolder): void;
  renameFolderIfVersion(conn: SqlExecutor, folderId: string, title: string, expectedUpdatedAt: number): void;
  deleteFolder(conn: SqlExecutor, folderId: string): void;
  purgeFolder(conn: SqlExecutor, folderId: string, blobsDir?: string): void;
  restoreFolder(conn: SqlExecutor, folderId: string): void;
  generateUniqueFolderTitle(conn: SqlExecutor, baseTitle: string, parentId: string | null, excludeId: string | null): string;
  listDeletedFolders(conn: SqlExecutor, limit: number, offset: number): VfsFolder[];
  purgeDeletedFolders(conn: SqlExecutor, blobsDir?: string): number;
  setFolderExpanded(conn: SqlExecutor, folderId: string, isExpanded: boolean): void;
  setFavorite(conn: SqlExecutor, folderId: string, favorite: boolean): void;
  moveFolder(conn: SqlExecutor, folderId: string, newParentId: string | null): void;
  getFolderIdsRecursive(conn: SqlExecutor, folderId: string): string[];
  getItemsByFolders(conn: SqlExecutor, folderIds: readonly string[]): VfsFolderItem[];
  buildFolderPath(conn: SqlExecutor, folderId: string): string;
  buildResourcePath(conn: SqlExecutor, item: VfsFolderItem): string;
  getFolderTree(conn: SqlExecutor): FolderTreeNode[];
  /**
   * dstu_folder_get_breadcrumbs query (root → leaf, max 11 levels, deleted not filtered).
   * Throws plain `Error` with the Rust command text: '数据库查询失败' (prepare, error-logged),
   * 'Query failed: …' (bind), 'Collect failed: …' (step/row decode, error-logged); success info-logged.
   * Optional capability for existing implementations; callers must check for it and fail explicitly
   * when unavailable. The production FolderRepo implements it; do not substitute consumer SQL.
   */
  getBreadcrumbs?(conn: SqlExecutor, folderId: string): VfsBreadcrumbItem[];
  getFolderTreeAll(conn: SqlExecutor): FolderTreeNode[];
  getFolderItemsAll(conn: SqlExecutor, folderId: string | null): VfsFolderItem[];
  removeItemFromFolder(conn: SqlExecutor, itemType: string, itemId: string): void;
  moveItemToFolder(conn: SqlExecutor, itemType: string, itemId: string, newFolderId: string | null): void;
  reorderFolders(conn: SqlExecutor, folderIds: readonly string[]): void;
  reorderItems(conn: SqlExecutor, folderId: string | null, itemIds: readonly string[]): void;
  countItemsInFolder(conn: SqlExecutor, folderId: string | null): number;
  getAllResources(conn: SqlExecutor, folderId: string, includeSubfolders: boolean, includeContent: boolean): FolderResourcesResult;
}
