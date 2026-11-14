/**
 * L13 VFS 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。
 *
 * 平台差异有两处：
 * - 本地文件系统（blobs、导出临时 ZIP、思维导图导入、附件暂存、静态资源协议）走 `./local-runtime.ts` 端口；
 *   桌面入口注入 `node:fs` 实现（`local-runtime.node.ts`），移动端入口不注入，走磁盘的指令降级，
 *   纯 SQLite 的树/搜索/文件夹/笔记指令不受影响；
 * - `mindmap_edit_nodes` 的前端 ACR 委托走 `./workbench-bridge.ts` 端口；移动端没有前端窗口，双重开关视为关闭。
 */
import { definePlugin } from '../../../kernel/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import type { VfsService } from '../api.ts';
import type { DstuCreateOptions, DstuListOptions } from './dstu-types.ts';
import { createCommand } from './dstu-create.ts';
import { updateCommand, type DstuUpdateArgs } from './dstu-update.ts';
import { deleteCommand } from './dstu-delete.ts';
import { moveCommand, renameCommand } from './dstu-move.ts';
import { setMetadataCommand, type DstuSetMetadataArgs } from './dstu-metadata.ts';
import { setFavoriteCommand, type DstuSetFavoriteArgs } from './dstu-favorite.ts';
import { VfsDatabaseImpl } from './database.ts';
import { parseDstuPath } from './paths.ts';
import { getCommand, getResourceByPathCommand } from './dstu-get.ts';
import { listCommand, listDeletedCommand } from './dstu-list.ts';
import { getContentCommand } from './dstu-content.ts';
import { searchCommand, searchInFolderCommand } from './dstu-search.ts';
import {
  batchMoveCommand,
  buildPathCommand,
  getPathByIdCommand,
  getResourceLocationCommand,
  moveToFolderCommand,
  refreshPathCacheCommand,
  type LocationDeps,
} from './locations.ts';
import {
  addFolderItemCommand,
  createFolderCommand,
  deleteFolderCommand,
  getFolderBreadcrumbsCommand,
  getFolderCommand,
  getFolderItemsCommand,
  getFolderResourcesCommand,
  getFolderTreeCommand,
  listFoldersCommand,
  moveFolderCommand,
  moveFolderItemCommand,
  removeFolderItemCommand,
  renameFolderCommand,
  reorderFolderItemsCommand,
  reorderFoldersCommand,
  setFolderExpandedCommand,
  type FolderCommandDeps,
} from './folders.ts';
import * as repositories from '../repository/index.ts';
import { configureVfsSharedRepositories } from '../repository/services.ts';
import {
  emptyTrashCommand,
  listTrashCommand,
  permanentlyDeleteCommand,
  purgeAllCommand,
  purgeCommand,
  restoreCommand,
  restoreManyCommand,
  softDeleteCommand,
  trashRestoreCommand,
  type DstuTrashDeps,
} from './dstu-trash.ts';
import { deleteManyCommand, moveManyCommand } from './dstu-batch.ts';
import { copyCommand } from './dstu-copy.ts';
import { getExamContentCommand } from './exam-formatter.ts';
import { VfsUnitIndexService } from './unit-index-service.ts';
import * as mediaIndex from './media-index.ts';
import * as ocr from './ocr.ts';
import { UploadSaga } from './upload-saga.ts';
import { AttachmentConfig, requireAttachmentConfigStore, type AttachmentConfigStore } from './attachment-config.ts';
import { uploadSavepoint } from '../repository/upload-saga.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { exportCommand, exportFormatsCommand, type DstuExportDeps } from './export.ts';
import { createResourceCreatedHooks } from './resource-created-hooks.ts';
import { buildNumberedSources } from './tools/retrieval-sources.ts';
import { uploadAttachmentCommand, type VfsUploadAttachmentParamsExt } from './upload-attachment.ts';
import { uploadFileCommand, type FileUploadDeps, type PlainTextCodeExtensions, type SettingsReader,
  type VfsUploadFileParams } from './upload-file.ts';
import { downloadPaperCommand, type VfsDownloadPaperParams } from './download-paper.ts';
import { createPaperLibrary } from './paper-library.ts';
import type { UnitBuilderService } from '../../vfs-index/api.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import { setLocalRuntime, type LocalRuntime } from './local-runtime.ts';
import { setWorkbenchBridge, type WorkbenchBridge } from './workbench-bridge.ts';
import { VfsError } from './error.ts';

function requireUnitBuilder(service: UnitBuilderService | undefined): UnitBuilderService {
  if (!service) throw new VfsError('Other', 'vfsUnitBuilder is required for VFS upload commands');
  return service;
}
import { registerProtocols } from './protocols.ts';
import { AttachmentToolExecutor, type AttachmentErrorPort } from './tools/attachment-executor.ts';
import { GenerativeUiExecutor, type GenerativeResearchPort } from './tools/generative-ui.ts';
import { DstuToolExecutor, type DstuUploadPort } from './tools/dstu-executor.ts';
import { BuiltinRetrievalExecutor, type ChatRetrievalScopePort, type MemoryRetrievalPort } from './tools/retrieval-executor.ts';
import type { RetrievalRerankerPort } from './tools/retrieval-rerank.ts';
import { BuiltinResourceExecutor } from './tools/resource-executor.ts';
import type { MindmapXmlParser } from './tools/mindmap-import-xml.ts';
import {
  addSpaceMountCommand,
  deleteAnchorEdgesBySourceCommand,
  deleteStudySpaceProfileCommand,
  ensureInboxFolderCommand,
  getStudySpaceProfileCommand,
  listSpaceMountsCommand,
  listStudySpaceProfilesCommand,
  queryAnchorEdgesByTargetCommand,
  removeSpaceMountCommand,
  upsertAnchorEdgesCommand,
  upsertStudySpaceProfileCommand,
  type StudySpaceCommandDeps,
} from './study-spaces.ts';
import type {
  AnchorEdgeWireInput,
  CreateSpaceMountInput,
  RemoveSpaceMountInput,
  UpsertStudySpaceProfileInput,
} from '../../vfs-repos/api.ts';

const folderCommands = [
  'dstu_folder_add_item',
  'dstu_folder_create',
  'dstu_folder_delete',
  'dstu_folder_get',
  'dstu_folder_get_all_resources',
  'dstu_folder_get_breadcrumbs',
  'dstu_folder_get_items',
  'dstu_folder_get_tree',
  'dstu_folder_list',
  'dstu_folder_move',
  'dstu_folder_move_item',
  'dstu_folder_remove_item',
  'dstu_folder_rename',
  'dstu_folder_reorder',
  'dstu_folder_reorder_items',
  'dstu_folder_set_expanded',
] as const;

const locationCommands = [
  'dstu_batch_move',
  'dstu_build_path',
  'dstu_get',
  'dstu_get_path_by_id',
  'dstu_get_resource_by_path',
  'dstu_get_resource_location',
  'dstu_move_to_folder',
  'dstu_refresh_path_cache',
] as const;

const listCommands = ['dstu_list', 'dstu_list_deleted'] as const;

const contentCommands = ['dstu_get_content', 'dstu_get_exam_content', 'dstu_search', 'dstu_search_in_folder'] as const;

const crudCommands = [
  'dstu_create', 'dstu_update', 'dstu_delete', 'dstu_move', 'dstu_rename', 'dstu_set_metadata',
  'dstu_set_favorite', 'dstu_copy',
] as const;

const trashCommands = [
  'dstu_soft_delete', 'dstu_trash_restore', 'dstu_list_trash', 'dstu_permanently_delete',
  'dstu_empty_trash', 'dstu_purge_all', 'dstu_restore', 'dstu_restore_many',
  'dstu_purge', 'dstu_delete_many', 'dstu_move_many',
] as const;

const exportCommands = ['dstu_export', 'dstu_export_formats'] as const;

/** 平台差异部分：桌面入口注入本地运行时与工作台桥，移动端入口不注入。 */
export interface VfsPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => port` 在 apply 时求值并安装；缺省用无本地文件系统的端口。 */
  localRuntime?: (ctx: Context) => LocalRuntime;
  /** `() => port` 在 apply 时求值并安装；缺省没有前端 ACR 桥。 */
  workbenchBridge?: () => WorkbenchBridge;
}

export function createVfsPlugin(options: VfsPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.vfs',
    lane: 'L13-vfs-api',
    ...(options.platforms ? { platforms: options.platforms } : {}),
    commands: [
      'dstu_parse_path', 'dstu_watch', 'dstu_unwatch',
      ...folderCommands, ...locationCommands, ...listCommands, ...contentCommands, ...crudCommands,
      ...trashCommands, ...exportCommands,
      'vfs_upload_attachment', 'vfs_upload_file', 'vfs_download_paper',
    ],
    provides: ['vfsDatabase', 'vfs', 'dstu', 'dstuUpload', 'paperLibrary'],
  },
  // vfsUnitBuilder (L12) is resolved per upload-command call, not injected:
  // a hard inject would block every dstu_* command on hosts that compose vfs
  // without the unit-builder service.
  inject: ['storage', 'notes', 'vfsRepo', 'vfsIndex'],
  apply(ctx) {
    setLocalRuntime(options.localRuntime?.(ctx) ?? null);
    setWorkbenchBridge(options.workbenchBridge?.() ?? null);
    ctx.effect(() => () => {
      setLocalRuntime(null);
      setWorkbenchBridge(null);
    });
    configureVfsSharedRepositories({
      notes: ctx.notes.repository,
      leases: ctx.notes.leases,
      repos: ctx.vfsRepo,
      log: ctx.logger,
    });
    const database = new VfsDatabaseImpl(ctx.storage, ctx.logger);
    const unitIndex = new VfsUnitIndexService(database, ctx.logger);
    const attachmentConfig = new AttachmentConfig(database,
      () => requireAttachmentConfigStore(ctx.get('memoryConfig') as AttachmentConfigStore | undefined), ctx.logger);
    const deps: FolderCommandDeps = { database, log: ctx.logger };
    const locationDeps = {
      database,
      log: ctx.logger,
      emit: (event, payload) => ctx.backendEvents.emit(event, payload),
    } satisfies LocationDeps;
    const exportDeps = (): DstuExportDeps => {
      const qbank = ctx.get('qbank') as unknown as {
        exportDocument?: (examId: string) => unknown;
      } | undefined;
      const exportDocument = qbank?.exportDocument;
      return {
        database,
        log: ctx.logger,
        ...(typeof exportDocument !== 'function'
          ? {}
          : { qbank: { exportDocument: (examId: string) => exportDocument.call(qbank, examId) } }),
      };
    };
    const trashDeps = (): DstuTrashDeps => {
      const index = ctx.vfsIndex;
      return {
        database,
        log: ctx.logger,
        emit: (event, payload) => ctx.backendEvents.emit(event, payload),
        index: {
            cleanup: async (resourceId: string) => {
              await unitIndex.deleteResourceIndexFull(resourceId, index.lance);
            },
            cleanupVectors: async (resourceIds: readonly string[]) => {
              for (const resourceId of resourceIds) {
                for (const modality of ['text', 'multimodal']) {
                  try { await index.lance.deleteByResource(modality, resourceId); }
                  catch { // boundary-allow empty-catch: Rust `let _ = lance.delete_by_resource(..)` discards each result
                    continue;
                  }
                }
              }
            },
        },
      };
    };
    ctx.provide('vfsDatabase', database);
    const upload = {
      createSaga: () => new UploadSaga(ctx.logger),
      withSavepoint: <T>(conn: SqlExecutor, name: string, work: () => T) => uploadSavepoint(conn, name, work, ctx.logger),
    };
    const resourceCreatedHooks = createResourceCreatedHooks();
    ctx.provide('vfs', { version: 1, database, repositories, unitIndex, mediaIndex, ocr, upload, attachmentConfig, resourceCreatedHooks,
      buildNumberedSources } satisfies VfsService);
    ctx.provide('dstu', { version: 1, parsePath: parseDstuPath });
    registerProtocols(ctx, database);
    ctx.inject(['agentTools'], scoped => { scoped.agentTools.registerToolExecutors([new BuiltinResourceExecutor()]); });
    ctx.inject(['agentTools', 'chatSession', 'mindmapXml', 'virtualFilePolicy'], scoped => {
      scoped.agentTools.registerToolExecutors([new BuiltinResourceExecutor(scoped.get('mindmapXml') as MindmapXmlParser, true)]);
    });
    ctx.inject(['agentTools', 'hpiasResearch'], scoped => {
      scoped.agentTools.registerToolExecutors([new GenerativeUiExecutor(() => scoped.get('hpiasResearch') as GenerativeResearchPort)]);
    });
    ctx.inject(['agentTools', 'runtimeRoots', 'dstuUpload'], scoped => {
      scoped.agentTools.registerToolExecutors([new DstuToolExecutor({ ...trashDeps(),
        roots: scoped.runtimeRoots, upload: scoped.get('dstuUpload') as DstuUploadPort })]);
    });
    ctx.inject(['agentTools', 'chatAttachmentErrors', 'chatSession', 'docs'], scoped => {
      const errors = scoped.get('chatAttachmentErrors') as AttachmentErrorPort;
      scoped.agentTools.registerToolExecutors([new AttachmentToolExecutor(errors)]);
    });
    ctx.inject(['agentTools', 'llmReranker', 'llm', 'memoryRetrieval',
      'chatRetrievalScope', 'chatPipeline', 'retrievalCancellable'], scoped => {
      const registration = scoped.agentTools.registerToolExecutors([new BuiltinRetrievalExecutor({
        reranker: scoped.get('llmReranker') as RetrievalRerankerPort,
        memory: scoped.get('memoryRetrieval') as MemoryRetrievalPort,
        scope: scoped.get('chatRetrievalScope') as ChatRetrievalScopePort,
      }, false)]);
      return () => registration.dispose();
    });
    // rs:642-825 execute_web reads only the web-search config and settings, never the retriever.
    ctx.inject(['agentTools', 'webSearch'], scoped => {
      const registration = scoped.agentTools.registerToolExecutors([new BuiltinRetrievalExecutor(null)]);
      return () => registration.dispose();
    });
    ctx.commands.register<{ params: VfsUploadAttachmentParamsExt }>('vfs_upload_attachment', ({ params }) => uploadAttachmentCommand({
      conn: () => database.getConnSafe(),
      blobsDir: () => database.blobsDir(),
      repos: ctx.vfsRepo,
      attachmentConfig,
      unitBuilder: requireUnitBuilder(ctx.get('vfsUnitBuilder') as UnitBuilderService | undefined),
      pdf: ctx.vfsIndex.pdf,
      hooks: resourceCreatedHooks,
      log: ctx.logger,
    }, params));
    const fileUploadDeps = (): FileUploadDeps => ({
      conn: () => database.getConnSafe(),
      blobsDir: () => database.blobsDir(),
      repos: ctx.vfsRepo,
      attachmentConfig,
      unitBuilder: requireUnitBuilder(ctx.get('vfsUnitBuilder') as UnitBuilderService | undefined),
      pdf: ctx.vfsIndex.pdf,
      hooks: resourceCreatedHooks,
      createSaga: upload.createSaga,
      withSavepoint: upload.withSavepoint,
      settings: () => {
        const settings = ctx.get('settings') as SettingsReader | undefined;
        if (settings === undefined) throw new Error('F4 settings service is not available: vfs_upload_file reads ocr.* settings');
        return settings;
      },
      docs: () => {
        const docs = ctx.get('docs') as PlainTextCodeExtensions | undefined;
        if (docs === undefined) throw new Error('L18 docs service is not available: is_plain_text_code_extension requires DocumentParser');
        return docs;
      },
      log: ctx.logger,
    });
    ctx.commands.register<{ params: VfsUploadFileParams }>('vfs_upload_file', ({ params }) => uploadFileCommand(fileUploadDeps(), params));
    // dstu_executor.rs:685/363 consult VfsAttachmentRepo statics; :724 calls the same vfs_upload_file handler.
    // The Rust context only locates managed state (window_ref), which this host resolves from ctx.
    ctx.provide('dstuUpload', {
      isSupportedUploadType: (name, mimeType) => ctx.vfsRepo.attachments.isSupportedUploadType(name, mimeType),
      maxUploadSizeBytes: mimeType => ctx.vfsRepo.attachments.maxUploadSizeBytes(mimeType),
      upload: params => uploadFileCommand(fileUploadDeps(), params),
    } satisfies DstuUploadPort);
    ctx.provide('paperLibrary', createPaperLibrary({
      conn: () => database.getConnSafe(),
      blobsDir: () => database.blobsDir(),
      repos: ctx.vfsRepo,
      unitBuilder: () => requireUnitBuilder(ctx.get('vfsUnitBuilder') as UnitBuilderService | undefined),
      pdf: () => ctx.vfsIndex.pdf,
    }));
    ctx.commands.register<{ params: VfsDownloadPaperParams }>('vfs_download_paper', ({ params }) => downloadPaperCommand({
      ...fileUploadDeps(),
      http: (ctx.get('http') as HttpService | undefined) ?? null,
    }, params));
    ctx.commands.register<{ path: string }>('dstu_parse_path', ({ path }) => parseDstuPath(path));
    // Rust handlers.rs:5628-5637 only log and return Ok(()).
    ctx.commands.register<{ path: string }>('dstu_watch', ({ path }) => {
      ctx.logger.info('[DSTU::handlers] dstu_watch: path=%s', path);
      return null;
    });
    ctx.commands.register<{ path: string }>('dstu_unwatch', ({ path }) => {
      ctx.logger.info('[DSTU::handlers] dstu_unwatch: path=%s', path);
      return null;
    });

    ctx.commands.register<{ title: string; parentId?: string | null; icon?: string | null; color?: string | null }>(
      'dstu_folder_create',
      ({ title, parentId, icon, color }) => createFolderCommand(deps, title, parentId, icon, color),
    );
    ctx.commands.register<{ folderId: string }>(
      'dstu_folder_get',
      ({ folderId }) => getFolderCommand(deps, folderId),
    );
    ctx.commands.register<{ folderId: string; title: string }>(
      'dstu_folder_rename',
      ({ folderId, title }) => renameFolderCommand(deps, folderId, title),
    );
    ctx.commands.register<{ folderId: string }>(
      'dstu_folder_delete',
      ({ folderId }) => deleteFolderCommand(deps, folderId),
    );
    ctx.commands.register<{ folderId: string; newParentId?: string | null }>(
      'dstu_folder_move',
      ({ folderId, newParentId }) => moveFolderCommand(deps, folderId, newParentId),
    );
    ctx.commands.register<{ folderId: string; isExpanded: boolean }>(
      'dstu_folder_set_expanded',
      ({ folderId, isExpanded }) => setFolderExpandedCommand(deps, folderId, isExpanded),
    );
    ctx.commands.register<{ folderId?: string | null; itemType: string; itemId: string }>(
      'dstu_folder_add_item',
      ({ folderId, itemType, itemId }) => addFolderItemCommand(deps, folderId, itemType, itemId),
    );
    ctx.commands.register<{ itemType: string; itemId: string }>(
      'dstu_folder_remove_item',
      ({ itemType, itemId }) => removeFolderItemCommand(deps, itemType, itemId),
    );
    ctx.commands.register<{ itemType: string; itemId: string; newFolderId?: string | null }>(
      'dstu_folder_move_item',
      ({ itemType, itemId, newFolderId }) => moveFolderItemCommand(deps, itemType, itemId, newFolderId),
    );
    ctx.commands.register<Record<string, never>>('dstu_folder_list', () => listFoldersCommand(deps));
    ctx.commands.register<Record<string, never>>('dstu_folder_get_tree', () => getFolderTreeCommand(deps));
    ctx.commands.register<{ folderId?: string | null }>(
      'dstu_folder_get_items',
      ({ folderId }) => getFolderItemsCommand(deps, folderId),
    );
    ctx.commands.register<{ folderId: string; includeSubfolders: boolean; includeContent: boolean }>(
      'dstu_folder_get_all_resources',
      ({ folderId, includeSubfolders, includeContent }) => getFolderResourcesCommand(deps, folderId, includeSubfolders, includeContent),
    );
    ctx.commands.register<{ folderIds: string[] }>(
      'dstu_folder_reorder',
      ({ folderIds }) => reorderFoldersCommand(deps, folderIds),
    );
    ctx.commands.register<{ folderId?: string | null; itemIds: string[] }>(
      'dstu_folder_reorder_items',
      ({ folderId, itemIds }) => reorderFolderItemsCommand(deps, folderId, itemIds),
    );
    ctx.commands.register<{ folderId: string }>(
      'dstu_folder_get_breadcrumbs',
      ({ folderId }) => getFolderBreadcrumbsCommand(deps, folderId),
    );

    ctx.commands.register<{ folderId?: string | null; resourceId: string }>(
      'dstu_build_path',
      ({ folderId, resourceId }) => buildPathCommand(locationDeps, folderId, resourceId),
    );
    ctx.commands.register<{ resourceId: string }>(
      'dstu_get_resource_location',
      ({ resourceId }) => getResourceLocationCommand(locationDeps, resourceId),
    );
    ctx.commands.register<{ resourceId: string; targetFolderId?: string | null }>(
      'dstu_move_to_folder',
      ({ resourceId, targetFolderId }) => moveToFolderCommand(locationDeps, resourceId, targetFolderId),
    );
    ctx.commands.register<{ request: { itemIds: string[]; targetFolderId?: string | null } }>(
      'dstu_batch_move',
      ({ request }) => batchMoveCommand(locationDeps, request),
    );
    ctx.commands.register<{ resourceId?: string | null }>(
      'dstu_refresh_path_cache',
      ({ resourceId }) => refreshPathCacheCommand(locationDeps, resourceId),
    );
    ctx.commands.register<{ resourceId: string }>(
      'dstu_get_path_by_id',
      ({ resourceId }) => getPathByIdCommand(locationDeps, resourceId),
    );
    ctx.commands.register<{ path: string }>(
      'dstu_get',
      ({ path }) => getCommand({ database }, path),
    );
    ctx.commands.register<{ path: string }>(
      'dstu_get_resource_by_path',
      ({ path }) => getResourceByPathCommand({ database }, path),
    );
    ctx.commands.register<{ path: string; options?: DstuListOptions | null }>(
      'dstu_list',
      ({ options }) => listCommand({ database, log: ctx.logger }, options),
    );
    ctx.commands.register<{ resourceType: string; limit?: number | null; offset?: number | null }>(
      'dstu_list_deleted',
      ({ resourceType, limit, offset }) => listDeletedCommand({ database, log: ctx.logger }, resourceType, limit, offset),
    );
    ctx.commands.register<{ path: string }>(
      'dstu_get_content',
      ({ path }) => getContentCommand({ database }, path),
    );
    ctx.commands.register<{ examId: string; isMultimodal: boolean }>(
      'dstu_get_exam_content',
      ({ examId, isMultimodal }) => getExamContentCommand({ database, log: ctx.logger }, examId, isMultimodal),
    );
    ctx.commands.register<{ path: string; options: DstuCreateOptions }>(
      'dstu_create',
      ({ path, options }) => createCommand(
        { database, log: ctx.logger, emit: (event, payload) => ctx.backendEvents.emit(event, payload) },
        path,
        options,
      ),
    );
    ctx.commands.register<DstuUpdateArgs>(
      'dstu_update',
      (args, call) => updateCommand(
        { database, log: ctx.logger, emit: (event, payload) => ctx.backendEvents.emit(event, payload) },
        args,
        call.source.webview,
      ),
    );
    ctx.commands.register<{ path: string }>(
      'dstu_delete',
      ({ path }) => deleteCommand(trashDeps(), path),
    );
    ctx.commands.register<{ src: string; dst: string }>(
      'dstu_move',
      ({ src, dst }) => moveCommand(
        { database, log: ctx.logger, emit: (event, payload) => ctx.backendEvents.emit(event, payload) },
        src,
        dst,
      ),
    );
    ctx.commands.register<{ path: string; newName: string }>(
      'dstu_rename',
      ({ path, newName }) => renameCommand(
        { database, log: ctx.logger, emit: (event, payload) => ctx.backendEvents.emit(event, payload) },
        path,
        newName,
      ),
    );
    ctx.commands.register<DstuSetMetadataArgs>(
      'dstu_set_metadata',
      (args, call) => setMetadataCommand(
        {
          database,
          log: ctx.logger,
          emit: (event, payload) => ctx.backendEvents.emit(event, payload),
          emitToWindow: (event, payload) => ctx.backendEvents.emitTo(
            { kind: 'Window', label: call.source.window }, event, payload),
        },
        args,
      ),
    );
    ctx.commands.register<DstuSetFavoriteArgs>(
      'dstu_set_favorite',
      ({ path, favorite }) => setFavoriteCommand(
        { database, log: ctx.logger, emit: (event, payload) => ctx.backendEvents.emit(event, payload) },
        { path, favorite },
      ),
    );
    ctx.commands.register<{ query: string; options?: DstuListOptions | null }>(
      'dstu_search',
      ({ query, options }) => searchCommand({ database, log: ctx.logger }, query, options),
    );
    ctx.commands.register<{
      folderId?: string | null;
      query: string;
      options?: DstuListOptions | null;
    }>(
      'dstu_search_in_folder',
      ({ folderId, query, options }) => searchInFolderCommand({ database, log: ctx.logger }, folderId, query, options),
    );

    ctx.commands.register<{ id: string; itemType: string }>(
      'dstu_soft_delete',
      ({ id, itemType }) => softDeleteCommand(trashDeps(), id, itemType),
    );
    ctx.commands.register<{ id: string; itemType: string }>(
      'dstu_trash_restore',
      ({ id, itemType }) => trashRestoreCommand(trashDeps(), id, itemType),
    );
    ctx.commands.register<{
      limit?: number | null;
      offset?: number | null;
      itemTypes?: string[] | null;
    }>(
      'dstu_list_trash',
      ({ limit, offset, itemTypes }) => listTrashCommand(trashDeps(), limit, offset, itemTypes),
    );
    ctx.commands.register<{ id: string; itemType: string }>(
      'dstu_permanently_delete',
      ({ id, itemType }) => permanentlyDeleteCommand(trashDeps(), id, itemType),
    );
    ctx.commands.register<{ itemTypes?: string[] | null }>(
      'dstu_empty_trash',
      ({ itemTypes }) => emptyTrashCommand(trashDeps(), itemTypes),
    );
    ctx.commands.register<{ resourceType: string }>(
      'dstu_purge_all',
      ({ resourceType }) => purgeAllCommand(trashDeps(), resourceType),
    );
    ctx.commands.register<{ path: string }>(
      'dstu_restore',
      ({ path }) => restoreCommand(trashDeps(), path),
    );
    ctx.commands.register<{ paths: string[] }>(
      'dstu_restore_many',
      ({ paths }) => restoreManyCommand(trashDeps(), paths),
    );
    ctx.commands.register<{ src: string; dst: string }>(
      'dstu_copy',
      ({ src, dst }) => copyCommand(locationDeps, src, dst),
    );
    ctx.commands.register<{ path: string }>(
      'dstu_purge',
      ({ path }) => purgeCommand(trashDeps(), path),
    );
    ctx.commands.register<{ paths: string[] }>(
      'dstu_delete_many',
      ({ paths }) => deleteManyCommand(trashDeps(), paths),
    );
    ctx.commands.register<{ paths: string[]; destFolder: string }>(
      'dstu_move_many',
      ({ paths, destFolder }) => moveManyCommand(trashDeps(), paths, destFolder),
    );
    ctx.commands.register<{ path: string }>(
      'dstu_export_formats',
      ({ path }) => exportFormatsCommand(exportDeps(), path),
    );
    ctx.commands.register<{ path: string; format: string }>(
      'dstu_export',
      ({ path, format }) => exportCommand(exportDeps(), path, format),
    );

    const studySpaceDeps: StudySpaceCommandDeps = { database };
    const registerHostNative = (
      ctx.commands as typeof ctx.commands & {
        _registerKernel: typeof ctx.commands.register;
      }
    )._registerKernel.bind(ctx.commands);

    registerHostNative<{ spaceId?: string }>(
      'vfs_study_space_get_profile',
      (args) => getStudySpaceProfileCommand(studySpaceDeps, args?.spaceId ?? ''),
    );
    registerHostNative<Record<string, never>>(
      'vfs_study_space_list_profiles',
      () => listStudySpaceProfilesCommand(studySpaceDeps),
    );
    registerHostNative<{ input: UpsertStudySpaceProfileInput }>(
      'vfs_study_space_upsert_profile',
      (args) => upsertStudySpaceProfileCommand(studySpaceDeps, args.input),
    );
    registerHostNative<{ spaceId?: string }>(
      'vfs_study_space_delete_profile',
      (args) => deleteStudySpaceProfileCommand(studySpaceDeps, args?.spaceId ?? ''),
    );
    registerHostNative<{
      spaceId?: string | null;
      targetFolderId?: string | null;
      itemType?: string | null;
      itemId?: string | null;
    }>(
      'vfs_space_mount_list',
      (filter) => listSpaceMountsCommand(studySpaceDeps, filter ?? {}),
    );
    registerHostNative<{ input: CreateSpaceMountInput }>(
      'vfs_space_mount_add',
      (args) => addSpaceMountCommand(studySpaceDeps, args.input),
    );
    registerHostNative<{
      mountId?: string | null;
      targetFolderId?: string | null;
      itemType?: string | null;
      itemId?: string | null;
      input?: RemoveSpaceMountInput | null;
    }>(
      'vfs_space_mount_remove',
      (args) => removeSpaceMountCommand(studySpaceDeps, args ?? {}),
    );
    registerHostNative<Record<string, never>>(
      'vfs_ensure_inbox_folder',
      () => ensureInboxFolderCommand(studySpaceDeps),
    );
    registerHostNative<{ edges?: AnchorEdgeWireInput[] }>(
      'vfs_anchor_edges_upsert',
      (args) => upsertAnchorEdgesCommand(studySpaceDeps, args?.edges ?? []),
    );
    registerHostNative<{
      sourceKind?: string;
      sourceResourceId?: string;
      keepEdgeIds?: string[] | null;
    }>(
      'vfs_anchor_edges_delete_by_source',
      (args) =>
        deleteAnchorEdgesBySourceCommand(
          studySpaceDeps,
          args?.sourceKind ?? '',
          args?.sourceResourceId ?? '',
          args?.keepEdgeIds,
        ),
    );
    registerHostNative<{
      targetResourceIds?: string[];
      targetKind?: string | null;
    }>(
      'vfs_anchor_edges_query_by_target',
      (args) =>
        queryAnchorEdgesByTargetCommand(
          studySpaceDeps,
          args?.targetResourceIds ?? [],
          args?.targetKind,
        ),
    );

    ctx.effect(() => () => {
      configureVfsSharedRepositories(undefined);
      database._lease?.release();
    });
  },
  });
}
