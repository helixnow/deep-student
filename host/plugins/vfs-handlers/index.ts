/**
 * L13b：VFS 命令层（非 DSTU）。薄层：参数/契约、错误映射、事件、调用 L10/L11/L12/L13 服务。
 * Rust: dstu-vfs/src/vfs/{handlers,index_handlers,ref_handlers,todo_handlers,pomodoro_handlers,
 * question_sync_service}.rs 与 file_stream_protocol.rs 的 filestream_check_access。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FilesService } from '../../platform/files/api.ts';
import type {} from './src/dependency-needs.ts';
import { definePlugin } from '../../kernel/api.ts';
import type { VfsDatabase } from '../vfs/api.ts';
import type { JsonValue } from '../vfs-repos/api.ts';
import type { VfsIndexService } from '../vfs-index/api.ts';
import type { RawPromptLlm } from './src/llm-needs.ts';
import type { TodoDeps } from './src/todo.ts';
import * as todo from './src/todo.ts';
import * as pomodoro from './src/pomodoro.ts';
import * as notes from './src/notes.ts';
import * as resources from './src/resources.ts';
import * as paths from './src/paths.ts';
import { NoteDeleteHookSet } from './src/hooks.ts';
import * as files from './src/files.ts';
import * as pdf from './src/pdf.ts';
import * as embedding from './src/embedding.ts';
import * as search from './src/search.ts';
import * as refs from './src/refs.ts';
import * as indexAdmin from './src/index-admin.ts';
import * as mediaCache from './src/media-cache.ts';
import { filestreamCheckAccess } from './src/filestream.ts';
import * as mindmaps from './src/mindmaps.ts';
import * as attachments from './src/attachments.ts';
import type { VfsRefTextService } from './api.ts';

const todoCommands = [
  'todo_ai_breakdown',
  'todo_batch_complete',
  'todo_batch_delete',
  'todo_batch_move',
  'todo_batch_purge',
  'todo_batch_reschedule',
  'todo_batch_restore',
  'todo_batch_set_priority',
  'todo_counts_snapshot',
  'todo_create_item',
  'todo_create_list',
  'todo_delete_item',
  'todo_delete_list',
  'todo_ensure_inbox',
  'todo_get_active_summary',
  'todo_get_item',
  'todo_get_list',
  'todo_list_all_pending',
  'todo_list_all_tags',
  'todo_list_completed',
  'todo_list_deleted_items',
  'todo_list_deleted_lists',
  'todo_list_items',
  'todo_list_items_with_stats',
  'todo_list_lists',
  'todo_list_overdue',
  'todo_list_reminders',
  'todo_list_today',
  'todo_list_upcoming',
  'todo_move_item',
  'todo_purge_deleted_items',
  'todo_purge_deleted_lists',
  'todo_purge_item',
  'todo_purge_list',
  'todo_reorder_items',
  'todo_reorder_lists',
  'todo_restore_item',
  'todo_restore_list',
  'todo_search',
  'todo_stats_overview',
  'todo_toggle_item',
  'todo_toggle_list_favorite',
  'todo_trash_counts',
  'todo_update_item',
  'todo_update_list',
] as const;

const resourceCommands = [
  'vfs_create_or_reuse',
  'vfs_decrement_ref',
  'vfs_get_resource',
  'vfs_increment_ref',
  'vfs_resource_exists',
] as const;

const noteCommands = [
  'vfs_create_note',
  'vfs_delete_note',
  'vfs_get_note',
  'vfs_get_note_content',
  'vfs_list_notes',
  'vfs_update_note',
] as const;

const listCommands = [
  'vfs_list_essays',
  'vfs_list_exam_sheets',
  'vfs_list_textbooks',
  'vfs_list_translations',
  'vfs_search_all',
] as const;

const pathCommands = ['vfs_get_resource_path', 'vfs_update_path_cache'] as const;
const refCommands = ['vfs_get_resource_refs', 'vfs_resolve_resource_refs', 'vfs_get_resource_ref_count'] as const;
const indexCommands = ['vfs_unified_index_status', 'vfs_get_resource_units', 'vfs_list_embedding_dims',
  'vfs_reindex_unit', 'vfs_sync_resource_units', 'vfs_unified_batch_index', 'vfs_delete_resource_index',
  'vfs_get_all_index_status', 'vfs_debug_index_status'] as const;
const mediaCommands = ['vfs_get_media_cache_stats', 'vfs_clear_media_cache', 'vfs_get_resource_ocr_info',
  'vfs_clear_resource_ocr', 'vfs_get_resource_text_chunks'] as const;
const mindmapCommands = ['vfs_create_mindmap', 'vfs_get_mindmap', 'vfs_get_mindmap_content', 'vfs_get_mindmap_versions',
  'vfs_restore_mindmap_version', 'vfs_get_mindmap_version_content', 'vfs_get_mindmap_version', 'vfs_update_mindmap',
  'vfs_delete_mindmap', 'vfs_list_mindmaps', 'vfs_set_mindmap_favorite'] as const;
const attachmentCommands = ['vfs_get_attachment_config', 'vfs_set_attachment_root_folder', 'vfs_create_attachment_root_folder',
  'vfs_get_or_create_attachment_root_folder', 'vfs_get_attachment', 'vfs_get_attachment_content', 'vfs_delete_attachment'] as const;

const pdfCommands = [
  'vfs_cancel_pdf_processing',
  'vfs_get_batch_pdf_processing_status',
  'vfs_get_pdf_page_image',
  'vfs_get_pdf_processing_status',
  'vfs_list_pending_pdf_processing',
  'vfs_retry_pdf_processing',
  'vfs_start_pdf_processing',
] as const;

const embeddingCommands = [
  'vfs_assign_dimension_model',
  'vfs_batch_index_pending',
  'vfs_clear_default_embedding_dimension',
  'vfs_create_dimension',
  'vfs_delete_dimension',
  'vfs_get_default_embedding_dimension',
  'vfs_get_dimension_range',
  'vfs_get_embedding_readiness',
  'vfs_get_embedding_stats',
  'vfs_get_index_status',
  'vfs_get_indexing_config',
  'vfs_get_pending_resources',
  'vfs_get_preset_dimensions',
  'vfs_list_dimensions',
  'vfs_reindex_resource',
  'vfs_reset_all_index_state',
  'vfs_reset_disabled_to_pending',
  'vfs_reset_indexed_without_embeddings',
  'vfs_set_default_embedding_dimension',
  'vfs_set_indexing_config',
  'vfs_toggle_index_disabled',
] as const;

const searchCommands = [
  'vfs_diagnose_lance_schema',
  'vfs_get_lance_stats',
  'vfs_inspect_retrieval_capabilities',
  'vfs_multimodal_delete',
  'vfs_multimodal_index',
  'vfs_multimodal_index_resource',
  'vfs_multimodal_search',
  'vfs_multimodal_search_detailed',
  'vfs_multimodal_stats',
  'vfs_optimize_lance',
  'vfs_rag_search',
  'vfs_search',
] as const;

const fileCommands = [
  'vfs_delete_file',
  'vfs_get_blob_base64',
  'vfs_get_file',
  'vfs_get_file_content',
  'vfs_list_files',
] as const;

const pomodoroCommands = [
  'pomodoro_create_record',
  'pomodoro_daily_stats',
  'pomodoro_delete_record',
  'pomodoro_get_record',
  'pomodoro_hourly_stats',
  'pomodoro_list_by_todo',
  'pomodoro_list_range',
  'pomodoro_list_today',
  'pomodoro_stats_by_todo',
  'pomodoro_stats_overview',
  'pomodoro_streak',
  'pomodoro_today_stats',
  'pomodoro_todo_focus_summary',
] as const;

export default definePlugin({
  meta: {
    id: 'dstu.vfs-handlers',
    lane: 'L13-vfs-api',
    commands: [...todoCommands, ...pomodoroCommands, ...resourceCommands, ...noteCommands, ...listCommands, ...pathCommands, ...fileCommands, ...pdfCommands, ...embeddingCommands, ...searchCommands, ...refCommands, ...indexCommands, ...mediaCommands, ...mindmapCommands, ...attachmentCommands, 'filestream_check_access'],
    platforms: ['desktop', 'mobile'],
    provides: ['vfsHooks', 'vfsRefText'],
  },
  inject: ['vfsDatabase', 'vfs', 'vfsRepo', 'vfsMaintenance', 'notes', 'vfsIndex', 'vfsIndexMaintenance', 'vfsUnitBuilder', 'retrieval', 'settings'],
  apply(ctx: Context) {
    const database = ctx.vfsDatabase as VfsDatabase;
    const maintenance = ctx.vfsMaintenance;
    /**
     * `ctx.files` 只在需要读写文件字节的命令里取（W14：桌面与移动端同一套异步接口）。
     * 不放进 `inject`：只装置命令层的最小宿主（例如别的 lane 的测试）没有 files，仍应能启动。
     */
    const filesService = (): FilesService => {
      const service = ctx.reflect.get('files', false) as FilesService | undefined;
      if (service === undefined) throw new Error('待接线：files（ctx.files 文件服务）');
      return service;
    };
    let optionalLlm: unknown;
    let embeddingModels: import('../llm/api.ts').LlmEmbeddingModels | undefined;
    ctx.inject(['llmEmbeddingModels'], scoped => {
      embeddingModels = scoped.llmEmbeddingModels;
      scoped.effect(() => () => { embeddingModels = undefined; });
    });
    ctx.inject(['llm'], scoped => {
      optionalLlm = scoped.llm;
      scoped.effect(() => () => { optionalLlm = undefined; });
    });
    const repos = ctx.vfsRepo;
    const conn = () => database.getConnSafe();
    const mindmapDeps: mindmaps.MindmapDeps = { log: ctx.logger, service: {
      createMindmapInFolder: (params, folder) => repos.mindmaps.createMindmapInFolder(conn(), params, folder),
      getMindmap: id => repos.mindmaps.getMindmap(conn(), id),
      getMindmapContent: id => repos.mindmaps.getMindmapContent(conn(), id),
      getVersionsPaged: (id, limit) => repos.mindmaps.getVersionsPaged(conn(), id, limit),
      restoreVersion: id => repos.mindmaps.restoreVersion(conn(), id),
      getVersionContent: id => repos.mindmaps.getVersionContent(conn(), id),
      getVersion: id => repos.mindmaps.getVersion(conn(), id),
      updateMindmap: (id, params) => repos.mindmaps.updateMindmap(conn(), id, {
        ...params, settings: params.settings as JsonValue | undefined,
      }),
      deleteMindmap: id => repos.mindmaps.deleteMindmap(conn(), id),
      listMindmaps: () => repos.mindmaps.listMindmaps(conn()),
      setFavorite: (id, favorite) => repos.mindmaps.setFavorite(conn(), id, favorite),
    } };
    ctx.commands.register<{ params: mindmaps.CreateMindMapInput }>('vfs_create_mindmap', ({ params }) => mindmaps.create(mindmapDeps, params));
    ctx.commands.register<{ mindmapId: string }>('vfs_get_mindmap', ({ mindmapId }) => mindmaps.get(mindmapDeps, mindmapId));
    ctx.commands.register<{ mindmapId: string }>('vfs_get_mindmap_content', ({ mindmapId }) => mindmaps.content(mindmapDeps, mindmapId));
    ctx.commands.register<{ mindmapId: string; limit?: number | null }>('vfs_get_mindmap_versions', ({ mindmapId, limit }) => mindmaps.versions(mindmapDeps, mindmapId, limit ?? null));
    ctx.commands.register<{ versionId: string }>('vfs_restore_mindmap_version', ({ versionId }) => mindmaps.restore(mindmapDeps, versionId));
    ctx.commands.register<{ versionId: string }>('vfs_get_mindmap_version_content', ({ versionId }) => mindmaps.versionContent(mindmapDeps, versionId));
    ctx.commands.register<{ versionId: string }>('vfs_get_mindmap_version', ({ versionId }) => mindmaps.version(mindmapDeps, versionId));
    ctx.commands.register<{ mindmapId: string; params: mindmaps.UpdateMindMapInput }>('vfs_update_mindmap', ({ mindmapId, params }) => mindmaps.update(mindmapDeps, mindmapId, params));
    ctx.commands.register<{ mindmapId: string }>('vfs_delete_mindmap', ({ mindmapId }) => mindmaps.remove(mindmapDeps, mindmapId));
    ctx.commands.register('vfs_list_mindmaps', () => mindmaps.list(mindmapDeps));
    ctx.commands.register<{ mindmapId: string; isFavorite: boolean }>('vfs_set_mindmap_favorite', ({ mindmapId, isFavorite }) => mindmaps.favorite(mindmapDeps, mindmapId, isFavorite));
    ctx.commands.register<{ path: string }>('filestream_check_access', ({ path }) =>
      path === '' ? false : filestreamCheckAccess(ctx, path, database.blobsDir(), filesService()));
    const attachmentDeps: attachments.AttachmentDeps = { conn: () => database.getConnSafe(), blobsDir: () => database.blobsDir(),
      blobScope: () => filesService().scope(database.blobsDir()),
      config: ctx.vfs.attachmentConfig,
      folders: repos.folders, files: repos.files, log: ctx.logger, service: {
        getById: id => repos.attachments.getById(conn(), id),
        resolveFileId: id => repos.attachments.resolveFileId(conn(), id),
        getContent: id => repos.attachments.getContent(conn(), database.blobsDir(), id),
        getContentBounded: (id, limit) => repos.attachments.getContentBounded(conn(), database.blobsDir(), id, limit),
        deleteAttachment: id => repos.attachments.deleteAttachment(conn(), id),
      } };
    ctx.commands.register('vfs_get_attachment_config', () => attachments.getConfig(attachmentDeps));
    ctx.commands.register<{ folderId: string }>('vfs_set_attachment_root_folder', ({ folderId }) => attachments.setRootFolder(attachmentDeps, folderId));
    ctx.commands.register<{ title: string }>('vfs_create_attachment_root_folder', ({ title }) => attachments.createRootFolder(attachmentDeps, title));
    ctx.commands.register('vfs_get_or_create_attachment_root_folder', () => attachments.getOrCreateRootFolder(attachmentDeps));
    ctx.commands.register<{ attachmentId: string }>('vfs_get_attachment', ({ attachmentId }) => attachments.get(attachmentDeps, attachmentId));
    ctx.commands.register<{ attachmentId: string; maxBytes?: number | null }>('vfs_get_attachment_content', ({ attachmentId, maxBytes }) => attachments.content(attachmentDeps, attachmentId, maxBytes ?? null));
    ctx.commands.register<{ attachmentId: string }>('vfs_delete_attachment', ({ attachmentId }) => attachments.remove(attachmentDeps, attachmentId));
    const mediaDeps: mediaCache.MediaCacheDeps = {
      get maintenance() { return maintenance; },
      conn: () => database.getConnSafe(), blobsDir: () => database.blobsDir(), repos, get files() { return filesService(); }, log: ctx.logger,
    };
    ctx.commands.register('vfs_get_media_cache_stats', () => mediaCache.stats(mediaDeps));
    ctx.commands.register<{ params: mediaCache.ClearMediaCacheParams }>('vfs_clear_media_cache', ({ params }) => mediaCache.clear(mediaDeps, params));
    ctx.commands.register<{ resourceId: string }>('vfs_get_resource_ocr_info', ({ resourceId }) => mediaCache.ocrInfo(mediaDeps, resourceId));
    ctx.commands.register<{ resourceId: string }>('vfs_clear_resource_ocr', ({ resourceId }) => mediaCache.clearOcr(mediaDeps, resourceId));
    ctx.commands.register<{ resourceId: string }>('vfs_get_resource_text_chunks', ({ resourceId }) => mediaCache.textChunks(mediaDeps, resourceId));
    const refDeps: refs.RefDeps = {
      conn: () => database.getConnSafe(), blobsDir: () => database.blobsDir(), repos, log: ctx.logger,
      readBytes: path => filesService().readBytes(path),
      get docs() {
        const d = ctx.reflect.get('docs', false) as refs.RefDeps['docs'] | undefined;
        if (!d) throw new Error('docs service unavailable on this platform');
        return d;
      },
    };
    ctx.inject(['qbank'], scoped => {
      refDeps.qbank = scoped.qbank as unknown as refs.RefDeps['qbank'];
      scoped.effect(() => () => { refDeps.qbank = undefined; });
    });
    ctx.commands.register<{ params: refs.GetResourceRefsInput }>('vfs_get_resource_refs',
      ({ params }) => refs.getResourceRefs(refDeps, params));
    ctx.commands.register<{ refs: refs.VfsResourceRef__De[] }>('vfs_resolve_resource_refs',
      args => refs.resolveResourceRefs(refDeps, args.refs));
    ctx.commands.register<{ sourceId: string }>('vfs_get_resource_ref_count',
      ({ sourceId }) => refs.getResourceRefCount(refDeps, sourceId));
    const refText: VfsRefTextService = {
      version: 1,
      extractFileTextWithStrategy: (refConn, sourceId, fileName, base64Content) =>
        refs.extractFileTextWithConn(refDeps, refConn, sourceId, fileName, base64Content),
    };
    ctx.provide('vfsRefText', refText);
    const hooks = new NoteDeleteHookSet();
    ctx.provide('vfsHooks', hooks);
    const noteDeps: notes.NoteDeps = {
      conn: () => database.getConn(),
      notes: ctx.notes.repository,
      hooks,
      log: ctx.logger,
    };
    const resourceDeps: resources.ResourceDeps = {
      conn: () => database.getConn(),
      resources: repos.resources,
      textbooks: repos.textbooks,
      exams: repos.exams,
      translations: repos.translations,
      essays: repos.essays,
      log: ctx.logger,
    };
    const pathDeps: paths.PathDeps = {
      get maintenance() { return maintenance; },
      log: ctx.logger,
    };
    const indexService = ctx.vfsIndex as VfsIndexService;
    const indexDeps: indexAdmin.IndexAdminDeps = {
      maintenance: ctx.vfsIndexMaintenance,
      conn: () => database.getConn(), repos, index: indexService, log: ctx.logger,
      vectorAvailable: false,
      multimodalBatch: indexService.multimodal,
      unitBuilder: ctx.vfsUnitBuilder,
    };
    ctx.inject(['vector'], scoped => {
      indexDeps.vectorAvailable = scoped.vector !== undefined;
      scoped.effect(() => () => { indexDeps.vectorAvailable = false; });
    });
    ctx.commands.register('vfs_unified_index_status', () => indexAdmin.getStatus(indexDeps));
    ctx.commands.register<indexAdmin.IndexStatusArgs>('vfs_get_all_index_status', args => indexAdmin.getAllIndexStatus(indexDeps, args));
    ctx.commands.register<{ resourceId?: string | null }>('vfs_debug_index_status', ({ resourceId }) => indexAdmin.debugIndexStatus(indexDeps, resourceId ?? null));
    ctx.commands.register<{ resourceId: string }>('vfs_get_resource_units', ({ resourceId }) => indexAdmin.getResourceUnits(indexDeps, resourceId));
    ctx.commands.register('vfs_list_embedding_dims', () => indexAdmin.listDimensions(indexDeps));
    ctx.commands.register<{ unitId: string; mode: string }>('vfs_reindex_unit', ({ unitId, mode }) => indexAdmin.reindexUnit(indexDeps, unitId, mode));
    ctx.commands.register<indexAdmin.SyncUnitInput>('vfs_sync_resource_units', args => indexAdmin.syncResourceUnits(indexDeps, args));
    ctx.commands.register<{ mode: string; batchSize?: number | null }>('vfs_unified_batch_index', ({ mode, batchSize }) => indexAdmin.batchIndex(indexDeps, mode, batchSize ?? null));
    ctx.commands.register<{ resourceId: string }>('vfs_delete_resource_index', ({ resourceId }) => indexAdmin.deleteResourceIndex(indexDeps, resourceId));
    const pdfDeps: pdf.PdfDeps = {
      conn: () => database.getConn(),
      files: repos.files,
      blobs: repos.blobs,
      resources: repos.resources,
      pdf: indexService.pdf,
      blobsDir: () => database.blobsDir(),
      hostFiles: () => ctx.get('files') as FilesService,
      log: ctx.logger,
    };
    const fileDeps: files.FileDeps = {
      conn: () => database.getConn(),
      files: repos.files,
      blobs: repos.blobs,
      resources: repos.resources,
      blobsDir: () => database.blobsDir(),
      readBytes: path => filesService().readBytes(path),
      deleteIndex: resourceId => files.deleteIndexFull(ctx.vfsIndexMaintenance, indexService.lance, ctx.logger, resourceId),
      log: ctx.logger,
    };
    const embeddingDeps: embedding.EmbeddingDeps = {
      get maintenance() { return maintenance; },
      get vectorAvailable() { return indexDeps.vectorAvailable; },
      conn: () => database.getConn(),
      repos,
      indexing: indexService.indexing,
      search: indexService.search,
      lance: indexService.lance,
      settings: ctx.settings,
      get llm() { return optionalLlm as embedding.EmbeddingLlm | undefined; },
      get embeddingModels() { return embeddingModels; },
      emit: (event, payload) => ctx.backendEvents.emit(event, payload),
      log: ctx.logger,
    };
    const searchDeps: search.SearchDeps = {
      get vectorAvailable() { return indexDeps.vectorAvailable; },
      conn: () => database.getConn(),
      index: indexService,
      retrieval: ctx.retrieval,
      log: ctx.logger,
    };
    const deps: TodoDeps = {
      get maintenance() { return maintenance; },
      conn: () => database.getConn(),
      repos: repos.todos,
      log: ctx.logger,
      emit: (event, payload) => ctx.backendEvents.emit(event, payload),
      get llm() { return optionalLlm as RawPromptLlm | undefined; },
    };
    const pomodoroDeps: pomodoro.PomodoroDeps = {
      conn: deps.conn,
      repos: repos.pomodoros,
      log: deps.log,
      emit: deps.emit,
    };

    ctx.commands.register<{ input: todo.TodoListInput }>('todo_create_list', ({ input }) => todo.createList(deps, input));
    ctx.commands.register<{ listId: string }>('todo_get_list', ({ listId }) => todo.getList(deps, listId));
    ctx.commands.register<Record<string, never>>('todo_list_lists', () => todo.listLists(deps));
    ctx.commands.register<{ input: todo.UpdateTodoListInput }>('todo_update_list', ({ input }) => todo.updateList(deps, input));
    ctx.commands.register<{ listId: string }>('todo_delete_list', ({ listId }) => todo.deleteList(deps, listId));
    ctx.commands.register<{ listId: string }>('todo_toggle_list_favorite', ({ listId }) => todo.toggleListFavorite(deps, listId));
    ctx.commands.register<{ title?: string | null }>('todo_ensure_inbox', ({ title }) => todo.ensureInbox(deps, title ?? null));
    ctx.commands.register<{ input: todo.ReorderListsInput }>('todo_reorder_lists', ({ input }) => todo.reorderLists(deps, input));
    ctx.commands.register<{ limit?: number | null; offset?: number | null }>(
      'todo_list_deleted_lists',
      ({ limit, offset }) => todo.listDeletedLists(deps, limit ?? null, offset ?? null),
    );
    ctx.commands.register<{ listId: string }>('todo_restore_list', ({ listId }) => todo.restoreList(deps, listId));
    ctx.commands.register<{ listId: string }>('todo_purge_list', ({ listId }) => todo.purgeList(deps, listId));
    ctx.commands.register<Record<string, never>>('todo_purge_deleted_lists', () => todo.purgeDeletedLists(deps));
    ctx.commands.register<{ itemId: string }>('todo_restore_item', ({ itemId }) => todo.restoreItem(deps, itemId));
    ctx.commands.register<{ limit?: number | null; offset?: number | null }>(
      'todo_list_deleted_items',
      ({ limit, offset }) => todo.listDeletedItems(deps, limit ?? null, offset ?? null),
    );
    ctx.commands.register<{ itemId: string }>('todo_purge_item', ({ itemId }) => todo.purgeItem(deps, itemId));
    ctx.commands.register<Record<string, never>>('todo_purge_deleted_items', () => todo.purgeDeletedItems(deps));
    ctx.commands.register<{ input: todo.CreateTodoItemInput }>('todo_create_item', ({ input }) => todo.createItem(deps, input));
    ctx.commands.register<{ itemId: string }>('todo_get_item', ({ itemId }) => todo.getItem(deps, itemId));
    ctx.commands.register<{ listId: string; includeCompleted: boolean; limit?: number | null; offset?: number | null }>(
      'todo_list_items',
      ({ listId, includeCompleted, limit, offset }) => todo.listItems(deps, listId, includeCompleted, limit ?? null, offset ?? null),
    );
    ctx.commands.register<{ input: todo.UpdateTodoItemInput }>('todo_update_item', ({ input }) => todo.updateItem(deps, input));
    ctx.commands.register<{ itemId: string; expectedUpdatedAt?: string | null }>(
      'todo_toggle_item',
      ({ itemId, expectedUpdatedAt }) => todo.toggleItem(deps, itemId, expectedUpdatedAt ?? null),
    );
    ctx.commands.register<{ itemId: string }>('todo_delete_item', ({ itemId }) => todo.deleteItem(deps, itemId));
    ctx.commands.register<{ input: todo.ReorderItemsInput }>('todo_reorder_items', ({ input }) => todo.reorderItems(deps, input));
    ctx.commands.register<{ input: todo.MoveTodoItemInput }>('todo_move_item', ({ input }) => todo.moveItem(deps, input));
    ctx.commands.register<{ includeCompleted: boolean; limit?: number | null; offset?: number | null }>(
      'todo_list_today',
      ({ includeCompleted, limit, offset }) => todo.listToday(deps, includeCompleted, limit ?? null, offset ?? null),
    );
    ctx.commands.register<{ includeCompleted: boolean; limit?: number | null; offset?: number | null }>(
      'todo_list_overdue',
      ({ includeCompleted, limit, offset }) => todo.listOverdue(deps, includeCompleted, limit ?? null, offset ?? null),
    );
    ctx.commands.register<{ days: number; includeCompleted: boolean }>(
      'todo_list_upcoming',
      ({ days, includeCompleted }) => todo.listUpcoming(deps, days, includeCompleted),
    );
    ctx.commands.register<Record<string, never>>('todo_list_reminders', () => todo.listReminders(deps));
    ctx.commands.register<Record<string, never>>('todo_list_all_pending', () => todo.listAllPending(deps));
    ctx.commands.register<{ listId?: string | null }>('todo_list_completed', ({ listId }) => todo.listCompleted(deps, listId ?? null));
    ctx.commands.register<{ query: string; limit?: number | null; offset?: number | null }>(
      'todo_search',
      ({ query, limit, offset }) => todo.search(deps, query, limit ?? null, offset ?? null),
    );
    ctx.commands.register<Record<string, never>>('todo_get_active_summary', () => todo.getActiveSummary(deps));
    ctx.commands.register<Record<string, never>>('todo_counts_snapshot', () => todo.countsSnapshot(deps));
    ctx.commands.register<{ itemIds: string[] }>('todo_batch_complete', ({ itemIds }) => todo.batchComplete(deps, itemIds));
    ctx.commands.register<{ itemIds: string[]; dueDate?: string | null; dueTime?: string | null }>(
      'todo_batch_reschedule',
      ({ itemIds, dueDate, dueTime }) => todo.batchReschedule(deps, itemIds, dueDate ?? null, dueTime ?? null),
    );
    ctx.commands.register<{ itemIds: string[]; priority: string }>(
      'todo_batch_set_priority',
      ({ itemIds, priority }) => todo.batchSetPriority(deps, itemIds, priority),
    );
    ctx.commands.register<{ itemIds: string[]; targetListId: string }>(
      'todo_batch_move',
      ({ itemIds, targetListId }) => todo.batchMove(deps, itemIds, targetListId),
    );
    ctx.commands.register<{ itemIds: string[] }>('todo_batch_delete', ({ itemIds }) => todo.batchDelete(deps, itemIds));
    ctx.commands.register<{ itemIds: string[] }>('todo_batch_restore', ({ itemIds }) => todo.batchRestore(deps, itemIds));
    ctx.commands.register<{ itemIds: string[] }>('todo_batch_purge', ({ itemIds }) => todo.batchPurge(deps, itemIds));
    ctx.commands.register<Record<string, never>>('todo_trash_counts', () => todo.trashCounts(deps));
    ctx.commands.register<{ days?: number | null }>('todo_stats_overview', ({ days }) => todo.statsOverview(deps, days ?? null));
    ctx.commands.register<Record<string, never>>('todo_list_all_tags', () => todo.listAllTags(deps));
    ctx.commands.register<{ listId: string; includeCompleted: boolean; limit?: number | null; offset?: number | null }>(
      'todo_list_items_with_stats',
      ({ listId, includeCompleted, limit, offset }) => todo.listItemsWithStats(deps, listId, includeCompleted, limit ?? null, offset ?? null),
    );
    ctx.commands.register<{ itemId: string }>('todo_ai_breakdown', ({ itemId }) => todo.aiBreakdown(deps, itemId));

    ctx.commands.register<{ input: pomodoro.CreatePomodoroInput }>('pomodoro_create_record', ({ input }) => pomodoro.createRecord(pomodoroDeps, input));
    ctx.commands.register<{ recordId: string }>('pomodoro_get_record', ({ recordId }) => pomodoro.getRecord(pomodoroDeps, recordId));
    ctx.commands.register<{ todoItemId: string }>('pomodoro_list_by_todo', ({ todoItemId }) => pomodoro.listByTodo(pomodoroDeps, todoItemId));
    ctx.commands.register<Record<string, never>>('pomodoro_today_stats', () => pomodoro.todayStats(pomodoroDeps));
    ctx.commands.register<Record<string, never>>('pomodoro_list_today', () => pomodoro.listToday(pomodoroDeps));
    ctx.commands.register<{ days?: number | null }>('pomodoro_daily_stats', ({ days }) => pomodoro.dailyStats(pomodoroDeps, days ?? null));
    ctx.commands.register<{ recordId: string }>('pomodoro_delete_record', ({ recordId }) => pomodoro.deleteRecord(pomodoroDeps, recordId));
    ctx.commands.register<{ startDate: string; endDate: string }>(
      'pomodoro_list_range',
      ({ startDate, endDate }) => pomodoro.listRange(pomodoroDeps, startDate, endDate),
    );
    ctx.commands.register<Record<string, never>>('pomodoro_streak', () => pomodoro.streak(pomodoroDeps));
    ctx.commands.register<{ days?: number | null }>('pomodoro_hourly_stats', ({ days }) => pomodoro.hourlyStats(pomodoroDeps, days ?? null));
    ctx.commands.register<{ startDate?: string | null; endDate?: string | null; limit?: number | null }>(
      'pomodoro_stats_by_todo',
      ({ startDate, endDate, limit }) => pomodoro.statsByTodo(pomodoroDeps, startDate ?? null, endDate ?? null, limit ?? null),
    );
    ctx.commands.register<{ days?: number | null }>('pomodoro_stats_overview', ({ days }) => pomodoro.statsOverview(pomodoroDeps, days ?? null));
    ctx.commands.register<{ todoItemId: string }>(
      'pomodoro_todo_focus_summary',
      ({ todoItemId }) => pomodoro.todoFocusSummary(pomodoroDeps, todoItemId),
    );

    ctx.commands.register<{ params: resources.CreateResourceInput }>('vfs_create_or_reuse', ({ params }) => resources.createOrReuse(resourceDeps, params));
    ctx.commands.register<{ resourceId: string }>('vfs_get_resource', ({ resourceId }) => resources.getResource(resourceDeps, resourceId));
    ctx.commands.register<{ resourceId: string }>('vfs_resource_exists', ({ resourceId }) => resources.resourceExists(resourceDeps, resourceId));
    ctx.commands.register<{ resourceId: string }>('vfs_increment_ref', ({ resourceId }) => resources.incrementRef(resourceDeps, resourceId));
    ctx.commands.register<{ resourceId: string }>('vfs_decrement_ref', ({ resourceId }) => resources.decrementRef(resourceDeps, resourceId));

    ctx.commands.register<{ params: notes.CreateNoteInput }>('vfs_create_note', ({ params }) => notes.createNote(noteDeps, params));
    ctx.commands.register<{ id: string; params: notes.UpdateNoteInput }>('vfs_update_note', ({ id, params }) => notes.updateNote(noteDeps, id, params));
    ctx.commands.register<{ id: string }>('vfs_get_note', ({ id }) => notes.getNote(noteDeps, id));
    ctx.commands.register<{ id: string }>('vfs_get_note_content', ({ id }) => notes.getNoteContent(noteDeps, id));
    ctx.commands.register<{ params?: notes.ListNotesInput | null }>('vfs_list_notes', ({ params }) => notes.listNotes(noteDeps, params ?? null));
    ctx.commands.register<{ id: string }>('vfs_delete_note', ({ id }) => notes.deleteNote(noteDeps, id));

    ctx.commands.register<{ params?: resources.ListInput | null }>('vfs_list_textbooks', ({ params }) => resources.listTextbooks(resourceDeps, params ?? null));
    ctx.commands.register<{ params?: resources.ListInput | null }>('vfs_list_exam_sheets', ({ params }) => resources.listExamSheets(resourceDeps, params ?? null));
    ctx.commands.register<{ params?: resources.ListInput | null }>('vfs_list_translations', ({ params }) => resources.listTranslations(resourceDeps, params ?? null));
    ctx.commands.register<{ params?: resources.ListInput | null }>('vfs_list_essays', ({ params }) => resources.listEssays(resourceDeps, params ?? null));
    ctx.commands.register<{ params: resources.SearchAllInput }>('vfs_search_all', ({ params }) => resources.searchAll({
      ...resourceDeps,
      listNotes: (search, limit, offset) => notes.listNotes(noteDeps, { search, limit, offset }),
    }, params));

    ctx.commands.register<{ sourceId: string }>('vfs_get_resource_path', ({ sourceId }) => paths.getResourcePath(pathDeps, sourceId));
    ctx.commands.register<{ folderId: string }>('vfs_update_path_cache', ({ folderId }) => paths.updatePathCache(pathDeps, folderId));

    ctx.commands.register<{ fileId: string }>('vfs_get_file', ({ fileId }) => files.getFile(fileDeps, fileId));
    ctx.commands.register<{ fileType?: string | null; limit?: number | null; offset?: number | null }>(
      'vfs_list_files',
      ({ fileType, limit, offset }) => files.listFiles(fileDeps, fileType ?? null, limit ?? null, offset ?? null),
    );
    ctx.commands.register<{ fileId: string }>('vfs_get_file_content', ({ fileId }) => files.getFileContent(fileDeps, fileId));
    ctx.commands.register<{ blobHash: string }>('vfs_get_blob_base64', ({ blobHash }) => files.getBlobBase64(fileDeps, blobHash));
    ctx.commands.register<{ fileId: string }>('vfs_delete_file', ({ fileId }) => files.deleteFile(fileDeps, fileId));

    ctx.commands.register<{ fileId: string }>('vfs_get_pdf_processing_status', ({ fileId }) => pdf.getPdfProcessingStatus(pdfDeps, fileId));
    ctx.commands.register<{ fileId: string }>('vfs_cancel_pdf_processing', ({ fileId }) => pdf.cancelPdfProcessing(pdfDeps, fileId));
    ctx.commands.register<{ fileId: string }>('vfs_retry_pdf_processing', ({ fileId }) => pdf.retryPdfProcessing(pdfDeps, fileId));
    ctx.commands.register<{ fileId: string; startFromStage?: string | null }>(
      'vfs_start_pdf_processing',
      ({ fileId, startFromStage }) => pdf.startPdfProcessing(pdfDeps, fileId, startFromStage ?? null),
    );
    ctx.commands.register<{ fileIds: string[] }>(
      'vfs_get_batch_pdf_processing_status',
      ({ fileIds }) => pdf.getBatchPdfProcessingStatus(pdfDeps, fileIds),
    );
    ctx.commands.register<{ limit?: number | null }>(
      'vfs_list_pending_pdf_processing',
      ({ limit }) => pdf.listPendingPdfProcessing(pdfDeps, limit ?? null),
    );
    ctx.commands.register<{ resourceId: string; pageIndex: number }>(
      'vfs_get_pdf_page_image',
      ({ resourceId, pageIndex }) => pdf.getPdfPageImage(pdfDeps, resourceId, pageIndex),
    );

    ctx.commands.register<{ resourceId: string }>('vfs_get_index_status', ({ resourceId }) => embedding.getIndexStatus(embeddingDeps, resourceId));
    ctx.commands.register<{ resourceId: string }>('vfs_toggle_index_disabled', ({ resourceId }) => embedding.toggleIndexDisabled(embeddingDeps, resourceId));
    ctx.commands.register<Record<string, never>>('vfs_get_embedding_stats', () => embedding.getEmbeddingStats(embeddingDeps));
    ctx.commands.register<Record<string, never>>('vfs_list_dimensions', () => embedding.listDimensions(embeddingDeps));
    ctx.commands.register<Record<string, never>>('vfs_get_pending_resources', () => embedding.getPendingResources(embeddingDeps));
    ctx.commands.register<{
      dimension: number; modality: string; modelConfigId: string; modelName: string;
    }>('vfs_assign_dimension_model', ({ dimension, modality, modelConfigId, modelName }) =>
      embedding.assignDimensionModel(embeddingDeps, dimension, modality, modelConfigId, modelName));
    ctx.commands.register<{
      dimension: number; modality: string; modelConfigId?: string | null; modelName?: string | null;
    }>('vfs_create_dimension', ({ dimension, modality, modelConfigId, modelName }) =>
      embedding.createDimension(embeddingDeps, dimension, modality, modelConfigId ?? null, modelName ?? null));
    ctx.commands.register<{ dimension: number; modality: string }>('vfs_delete_dimension', ({ dimension, modality }) =>
      embedding.deleteDimension(embeddingDeps, dimension, modality));
    ctx.commands.register<Record<string, never>>('vfs_get_preset_dimensions', () => embedding.getPresetDimensions());
    ctx.commands.register<Record<string, never>>('vfs_get_dimension_range', () => embedding.getDimensionRange());
    ctx.commands.register<{ dimension: number; modality: string }>('vfs_set_default_embedding_dimension', ({ dimension, modality }) =>
      embedding.setDefaultEmbeddingDimension(embeddingDeps, dimension, modality));
    ctx.commands.register<{ modality: string }>('vfs_get_default_embedding_dimension', ({ modality }) =>
      embedding.getDefaultEmbeddingDimension(embeddingDeps, modality));
    ctx.commands.register<{ modality: string }>('vfs_clear_default_embedding_dimension', ({ modality }) =>
      embedding.clearDefaultEmbeddingDimension(embeddingDeps, modality));
    ctx.commands.register<{ batchSize?: number | null }>('vfs_batch_index_pending', ({ batchSize }) =>
      embedding.batchIndexPending(embeddingDeps, batchSize ?? null));
    ctx.commands.register<{ resourceId: string; embeddingDim?: number | null }>('vfs_reindex_resource', ({ resourceId, embeddingDim }) =>
      embedding.reindexResource(embeddingDeps, resourceId, embeddingDim ?? null));
    ctx.commands.register<{ key: string }>('vfs_get_indexing_config', ({ key }) => embedding.getIndexingConfig(embeddingDeps, key));
    ctx.commands.register<{ key: string; value: string }>('vfs_set_indexing_config', ({ key, value }) =>
      embedding.setIndexingConfig(embeddingDeps, key, value));
    ctx.commands.register<Record<string, never>>('vfs_get_embedding_readiness', () => embedding.getEmbeddingReadiness(embeddingDeps));
    ctx.commands.register<Record<string, never>>('vfs_reset_disabled_to_pending', () => embedding.resetDisabledToPending(embeddingDeps));
    ctx.commands.register<Record<string, never>>('vfs_reset_indexed_without_embeddings', () =>
      embedding.resetIndexedWithoutEmbeddings(embeddingDeps));
    ctx.commands.register<Record<string, never>>('vfs_reset_all_index_state', () => embedding.resetAllIndexState(embeddingDeps));

    ctx.commands.register<{ params: search.VfsSearchParams }>('vfs_search', ({ params }) => search.search(searchDeps, params));
    ctx.commands.register<{ input: search.VfsRagSearchInput }>('vfs_rag_search', ({ input }) => search.ragSearch(searchDeps, input));
    ctx.commands.register<{ modality?: string | null }>('vfs_get_lance_stats', ({ modality }) =>
      search.getLanceStats(searchDeps, modality ?? null));
    ctx.commands.register<{ modality?: string | null }>('vfs_optimize_lance', ({ modality }) =>
      search.optimizeLance(searchDeps, modality ?? null));
    ctx.commands.register<{ modality?: string | null }>('vfs_diagnose_lance_schema', ({ modality }) =>
      search.diagnoseLanceSchema(searchDeps, modality ?? null));
    ctx.commands.register<Record<string, never>>('vfs_inspect_retrieval_capabilities', () =>
      search.inspectRetrievalCapabilities(searchDeps));
    ctx.commands.register<{ params: search.VfsMultimodalSearchInput }>('vfs_multimodal_search', ({ params }) =>
      search.multimodalSearch(searchDeps, params));
    ctx.commands.register<{ params: search.VfsMultimodalSearchInput }>('vfs_multimodal_search_detailed', ({ params }) =>
      search.multimodalSearchDetailed(searchDeps, params));
    ctx.commands.register<Record<string, never>>('vfs_multimodal_stats', () => search.multimodalStats(searchDeps));
    ctx.commands.register<{ resourceId: string }>('vfs_multimodal_delete', ({ resourceId }) =>
      search.multimodalDelete(searchDeps, resourceId));
    ctx.commands.register<{ params: import('../../../contracts/ipc/generated/L13-vfs-api.ts').VfsMultimodalIndexInput }>(
      'vfs_multimodal_index',
      ({ params }) => search.multimodalIndex(searchDeps, params),
    );
    ctx.commands.register<{
      sourceType: string; sourceId: string; folderId?: string | null; forceRebuild?: boolean | null;
    }>('vfs_multimodal_index_resource', ({ sourceType, sourceId, folderId, forceRebuild }) =>
      search.multimodalIndexResource(searchDeps, sourceType, sourceId, folderId ?? null, forceRebuild ?? false));
  },
});
