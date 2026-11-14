/**
 * L10-notes 插件本体（可移植）：命令接线与平台差异注入。
 *
 * 笔记 CRUD、历史/修订、租约、关系、画布、检索与同步基于 SQLite，两端一致。桌面专有的同步文件
 * 访问、附件删除队列、数据库 worker 线程池与 ACR 前端委托经两个端口注入（见 `local-runtime.ts` /
 * `agent-bridge.ts`）；入口按平台选择：`index.ts`（桌面，注入 Node 实现）与 `mobile.ts`（移动端，
 * 不注入——资源落盘/导入导出写盘等按“不可用”降级，画布委托走数据面）。
 */
import { definePlugin } from '../../../kernel/api.ts';
import type { CallContext } from '../../../kernel/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import { registerDeletionJournal, type SqlExecutor } from '../../../platform/storage/api.ts';
import type {} from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { TransferContext } from './transfer-commands.ts';
import type { AgentToolsService } from '../../agent-skills/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { ExactNoteRelation, ExactNoteState, NotesService } from '../api.ts';
import { noteStateRepository as state, noteStateWire } from '../repository/state.ts';
import {
  databaseStorage, NoteDocumentError, noteStorage, noteUpdateStorage,
} from '../repository/errors.ts';
import {
  configureNotesRepository, noteRepository,
} from '../repository/notes.ts';
import { listNotesAdvanced, listNotesMeta } from '../repository/notes-manager.ts';
import { handleEditAck, handleEditResult } from '../repository/canvas-edits.ts';
import { configureNoteResourceRepos } from '../repository/resource-deps.ts';
import { configureNotesLogger, notesLog } from '../repository/log.ts';
import { CanvasToolExecutor, executionWindow } from '../src/canvas-tool.ts';
import { backendEventBridge, canvasGateEnvironment } from '../src/canvas-bridge.ts';
import type { FeatureFlagsService } from '../../../platform/storage/api.ts';
import { NotesImportExecutor } from '../src/notes-import-tool.ts';
import { UserTodoExecutor } from '../src/user-todo-tool.ts';
import {
  canvasAppend, canvasRead, canvasReplace, canvasSet,
} from '../src/canvas-commands.ts';
import {
  errorMessage, formatStatus, settingsService, u32,
} from '../src/command-utils.ts';
import {
  backlinks, createNote, dbStats, deleteNote, getNote, listDeletedNotes, listNotes,
  outgoingLinks, rebuildLinks, restoreNote, searchNotes, setFavorite,
  unlinkedMentions, updateNote, updateNoteWithCapabilities,
} from '../src/note-commands.ts';
import {
  assetsIndexScan, listAssets, removeAsset, removeAssets, resolveAsset, saveAsset, scanOrphans,
} from '../src/asset-commands.ts';
import { emptyTrash, hardDelete } from '../src/trash-commands.ts';
import { registerNotesStartupSweep } from '../src/startup-sweep.ts';
import { withDeletePropagation } from '../src/deletion-permit.ts';
import { importMarkdown, importMarkdownBatch } from '../src/import-commands.ts';
import { exportAll, exportOne, importAll } from '../src/transfer-commands.ts';
import {
  getPref, getSubjectConfig, setPref, updateSubjectConfig,
} from '../src/settings-commands.ts';
import { mentionSearch } from '../src/mention-search.ts';
import { registerNotesAssetRetention } from '../repository/asset-retention.ts';
import { noteRelationRepository, listNotesReferencing } from '../repository/relations.ts';
import { noteRevisionRepository } from '../repository/revisions.ts';
import { noteSyncRepository } from '../repository/sync.ts';
import { noteTransferRepository } from '../repository/transfer.ts';
import { noteReviewRepository } from '../repository/review.ts';
import { noteLeaseRepository } from '../repository/leases.ts';
import { resetNoteEditorLeasesOnStartup, scheduleNoteEditorLeaseCleanup } from '../src/lease-lifecycle.ts';
import { blobDeletionJournalRepository, deletionJournalRepository } from '../repository/deletion-journal.ts';
import { noteFormatRepository } from '../repository/format.ts';
import { noteToDstuNode } from '../src/dstu-node.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { NOTES_WORKER_TASKS, runNotesTaskInline, type NotesWorkerReply } from '../src/worker-tasks.ts';
import { notesLocalRuntime, setNotesLocalRuntime, type NotesLocalRuntime } from '../src/local-runtime.ts';
import { setNotesAgentBridge, type NotesAgentBridge } from '../src/agent-bridge.ts';

/** 平台差异部分：桌面入口注入本地运行时与 ACR 桥，移动端入口不注入。 */
export interface NotesPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => port` 在 apply 时求值并安装；缺省没有本地文件系统与 worker 线程。 */
  localRuntime?: (ctx: Context) => NotesLocalRuntime;
  /** `() => port` 在 apply 时求值并安装；缺省没有 ACR 前端委托（画布走数据面）。 */
  agentBridge?: () => NotesAgentBridge;
  exportRecoveryTool?: (ctx: Context, transfer: () => TransferContext) => AgentToolExecutor;
}

export function createNotesPlugin(options: NotesPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.notes',
    lane: 'L10-notes',
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
    commands: [
      'notes_state_get', 'notes_state_list', 'notes_state_put', 'notes_state_delete',
      'notes_create', 'notes_get', 'notes_update', 'notes_delete', 'notes_restore',
      'notes_set_favorite', 'notes_list', 'notes_list_meta', 'notes_list_advanced',
      'notes_list_deleted', 'notes_list_tags', 'notes_search', 'notes_get_backlinks',
      'notes_get_outgoing_links', 'notes_rebuild_links', 'notes_unlinked_mentions',
      'notes_db_stats', 'notes_db_vacuum',
      'notes_relation_get', 'notes_relation_list', 'notes_relation_put', 'notes_relation_delete',
      'notes_reference_status', 'notes_invalidate_resource_refs', 'notes_list_referencing_resource',
      'notes_get_format', 'notes_enable_columns', 'notes_migrate_blocks',
      'notes_history_current', 'notes_history_list', 'notes_history_get', 'notes_history_set_pinned',
      'notes_history_get_retention', 'notes_history_set_retention',
      'notes_history_restore_copy', 'notes_history_restore_selection_copy', 'notes_history_restore_current',
      'notes_transfer_blocks', 'notes_undo_transfer', 'notes_review_save_as',
      'notes_editor_register', 'notes_editor_heartbeat', 'notes_editor_unregister', 'notes_editor_begin',
      'notes_editor_lease_status', 'notes_editor_freeze_ack', 'notes_editor_flush', 'notes_editor_finish',
      'notes_editor_refresh_ack', 'notes_editor_release',
      'notes_set_pref', 'notes_get_pref', 'notes_mentions_search',
      'canvas_note_read', 'canvas_note_append', 'canvas_note_replace', 'canvas_note_set',
      'notes_save_asset', 'notes_list_assets', 'notes_assets_index_scan', 'notes_delete_asset',
      'notes_assets_bulk_delete', 'notes_resolve_asset_path', 'notes_assets_scan_orphans',
      'notes_hard_delete', 'notes_empty_trash',
      'notes_import_markdown', 'notes_import_markdown_batch',
      'rag_rebuild_fts_index', 'notes_rag_rebuild_fts_index',
      'notes_get_subject_rag_config', 'notes_update_subject_rag_config',
      'notes_export', 'notes_export_single', 'notes_import',
      'chat_v2_canvas_edit_ack', 'chat_v2_canvas_edit_result',
    ],
    provides: ['notes'],
  },
  inject: ['storage', 'vfsRepo'],
  apply(ctx) {
    setNotesLocalRuntime(options.localRuntime?.(ctx) ?? null);
    ctx.effect(() => () => setNotesLocalRuntime(null));
    setNotesAgentBridge(options.agentBridge?.() ?? null);
    ctx.effect(() => () => setNotesAgentBridge(null));
    const vfs = (): SqlExecutor => ctx.storage.database('vfs');
    // Rust tracing target: [VFS::NoteRepo] / [CanvasToolExecutor] etc. all go
    // through the host log file, never console.*.
    configureNotesLogger(ctx.logger('notes'));
    configureNotesRepository(vfs());
    // L11 is the single writer for resources and index artifacts.
    const repos = ctx.get('vfsRepo') as VfsReposService;
    configureNoteResourceRepos({
      noteOwnerWrites: repos.noteOwnerWrites,
      resources: repos.resources,
      indexStates: repos.indexStates,
      embeddingUnits: repos.embeddingUnits,
      folders: repos.folders,
    });
    // lib.rs:1338-1354: reset process-local editor membership after restart,
    // then expire lost heartbeats without relying on a renderer staying alive.
    resetNoteEditorLeasesOnStartup(ctx);
    scheduleNoteEditorLeaseCleanup(ctx);
    // cmd/notes.rs runs VACUUM and the full-table tags scan in spawn_blocking (P2-3):
    // here they run on an F3 worker thread with its own connection. 移动端没有 worker 线程：
    // 端口返回 null，同一份任务实现在调用线程上执行。
    const workerPool = notesLocalRuntime().createWorkerPool({
      baseDir: ctx.storage.locations.baseDir,
      dataLocalDir: ctx.storage.locations.dataLocalDir,
      taskModule: new URL('./worker-tasks.ts', import.meta.url),
      tasks: NOTES_WORKER_TASKS,
    });
    if (workerPool !== null) {
      const pool = workerPool;
      const unregisterWorker = ctx.storage.registerMaintenanceParticipant('notes-worker', {
        databases: ['vfs'],
        enterMaintenance: async () => {
          try {
            await pool.pause();
          } catch (error) {
            // F3 does not call exit for a failed participant.
            pool.resume();
            throw error;
          }
        },
        exitMaintenance: () => { pool.resume(); },
      });
      ctx.effect(() => () => {
        unregisterWorker();
        void pool.close();
      });
    }
    const notesLogger = ctx.logger('notes');
    const blocking = async <T>(task: (typeof NOTES_WORKER_TASKS)[number], joinPrefix: string): Promise<T> => {
      if (workerPool === null) return runNotesTaskInline<T>(task, vfs());
      let reply: NotesWorkerReply;
      try {
        reply = await workerPool.run<NotesWorkerReply>(task, null, { database: 'vfs' });
      } catch (error) {
        // Rust JoinError: AppError::internal("<task> 任务失败: {e}").
        throw new CommandError(AppError.internal(`${joinPrefix}: ${errorMessage(error)}`));
      }
      for (const [level, message] of reply.logs) notesLogger[level](message);
      if (!reply.ok) throw new CommandError(reply.error);
      return reply.value as T;
    };
    const tools = {
      canvas: new CanvasToolExecutor({
        conn: vfs,
        nativeRegex: () => ctx.get('nativeRegex'),
        acr: {
          // The static fallback cannot know a window; real calls build the bus
          // from the execution context's `window_ref` once L04 publishes it.
          events: backendEventBridge(ctx.backendEvents, () => null),
          eventsForCall: (execCtx) => {
            const window = executionWindow(execCtx);
            if (window === null) return null;
            return backendEventBridge(ctx.backendEvents, () => window);
          },
          gates: () => canvasGateEnvironment({
            settings: ctx.get('settings'),
            featureFlags: ctx.get('featureFlags') as FeatureFlagsService | undefined,
            app: ctx.app,
          }),
          logger: {
            debug: (message) => notesLog.debug(message),
            info: (message) => notesLog.info(message),
            warn: (message) => notesLog.warn(message),
          },
        },
      }),
      userTodo: new UserTodoExecutor({ conn: vfs, todos: repos.todos }),
      notesImport: new NotesImportExecutor({
        conn: vfs,
        settings: () => settingsService(ctx),
        baseDir: ctx.storage.locations.activeDir,
      }),
    };
    const service: NotesService = {
      version: 1,
      repository: noteRepository,
      format: noteFormatRepository,
      revisions: noteRevisionRepository,
      sync: noteSyncRepository,
      state,
      leases: noteLeaseRepository,
      deletionJournal: deletionJournalRepository,
      blobDeletionJournal: blobDeletionJournalRepository,
      tools,
    };
    ctx.provide('notes', service);
    const transferContext = (): TransferContext => ({
      conn: vfs(),
      settings: settingsService(ctx),
      baseDir: ctx.storage.locations.activeDir,
      appDataDir: ctx.storage.locations.baseDir,
      appVersion: ctx.app.version,
    });

    // L07 `agentTools` (contract for L04's ToolExecutorRegistry). Optional: test
    // hosts and older assemblies may not install agent-skills. The registration
    // lives in the inject scope, so it follows both notes and agentTools reloads.
    ctx.inject(['agentTools'], (agentCtx) => {
      const agentTools = agentCtx.get('agentTools') as Partial<AgentToolsService> | undefined;
      if (typeof agentTools?.registerToolExecutors !== 'function') return;
      const recovery = options.exportRecoveryTool?.(ctx, transferContext);
      const registration = agentTools.registerToolExecutors([tools.canvas, tools.userTodo, tools.notesImport, ...(recovery ? [recovery] : [])]);
      agentCtx.effect(() => () => registration.dispose());
    });
    // D1: F3 owns orchestration; L10 supplies journal SQL and the note-history
    // retention guard. Register each disposer immediately so a later apply
    // failure also releases the earlier slot during scope rollback.
    ctx.effect(() => {
      const registration = registerDeletionJournal(deletionJournalRepository);
      return () => registration.dispose();
    });
    ctx.effect(() => {
      const registration = registerNotesAssetRetention();
      return () => registration.dispose();
    });

    // cmd/notes.rs::note_write_storage: lease holders act inside the barrier.
    const writeStorage = <T>(
      call: CallContext,
      lease: import('../../../../contracts/ipc/generated/_shared.ts').NoteLeaseAuth | null | undefined,
      work: (conn: SqlExecutor) => T,
    ): T => {
      const conn = vfs();
      if (lease == null) return work(conn);
      return noteLeaseRepository.authorized(
        conn, lease, call.source.webview, noteLeaseRepository.now(), true, () => work(conn));
    };

    // dstu handler_utils::emit_watch_event: path-specific event plus the
    // generic `dstu:change` broadcast.
    const emitWatchEvent = (
      event: { type: string; path: string; node: unknown },
      windowLabel: string,
    ): void => {
      // Rust `window.emit` scopes the event to the invoking window.
      const target = { kind: 'Window' as const, label: windowLabel };
      ctx.backendEvents.emitTo(target, `dstu:change:${event.path}`, event);
      ctx.backendEvents.emitTo(target, 'dstu:change', event);
    };

    // D3: exact revisions/values may hold bigint; the kernel emits them as JSON numbers on the wire.
    // Floats leave the exact JsonFloat form here, like serde_json printing a Value.
    const wireState = <T>(value: ExactNoteState | ExactNoteState[] | null): T => (value === null ? null
      : Array.isArray(value) ? value.map(noteStateWire) : noteStateWire(value)) as T;
    ctx.commands.register<Commands['notes_state_get']['args'], Commands['notes_state_get']['result']>(
      'notes_state_get', ({ request }) => wireState(noteStorage(() => state.get(vfs(), request))));
    ctx.commands.register<Commands['notes_state_list']['args'], Commands['notes_state_list']['result']>(
      'notes_state_list', ({ request }) => wireState(noteStorage(() => state.list(vfs(), request))));
    ctx.commands.register<Commands['notes_state_put']['args'], Commands['notes_state_put']['result']>(
      'notes_state_put', ({ request }) => {
        const row = noteStateWire(noteStorage(() => state.put(vfs(), request)));
        ctx.backendEvents.emit('notes:state-changed', row);
        return wireState(row);
      });
    ctx.commands.register<Commands['notes_state_delete']['args'], Commands['notes_state_delete']['result']>(
      'notes_state_delete', ({ request }) => {
        const row = noteStateWire(noteStorage(() => state.delete(vfs(), request)));
        ctx.backendEvents.emit('notes:state-changed', row);
        return wireState(row);
      });

    ctx.commands.register<Commands['notes_create']['args'], Commands['notes_create']['result']>(
      'notes_create', ({ note: payload }) => createNote(vfs(), payload));

    ctx.commands.register<Commands['notes_get']['args'], Commands['notes_get']['result']>(
      'notes_get', ({ id }) => getNote(vfs(), id));

    ctx.commands.register<Commands['notes_update']['args'], Commands['notes_update']['result']>(
      'notes_update', ({ note: payload, lease }, call) => {
        if (payload.capabilities != null || lease != null) {
          return noteStorage(() => writeStorage(call, lease,
            (conn) => updateNoteWithCapabilities(conn, payload)));
        }
        try {
          return updateNote(vfs(), payload);
        } catch (error) {
          throw noteUpdateStorage(() => { throw error; });
        }
      });

    ctx.commands.register<Commands['notes_set_favorite']['args'], Commands['notes_set_favorite']['result']>(
      'notes_set_favorite', ({ id, favorite }) => setFavorite(vfs(), id, favorite));

    ctx.commands.register<Commands['notes_delete']['args'], Commands['notes_delete']['result']>(
      'notes_delete', ({ id }) => deleteNote(vfs(), id));

    ctx.commands.register<Commands['notes_restore']['args'], Commands['notes_restore']['result']>(
      'notes_restore', ({ id }) => restoreNote(vfs(), id));

    ctx.commands.register<Commands['notes_list']['args'], Commands['notes_list']['result']>(
      'notes_list', ({ limit, offset }) => listNotes(vfs(), limit, offset));

    ctx.commands.register<Commands['notes_list_meta']['args'], Commands['notes_list_meta']['result']>(
      'notes_list_meta', () => noteStorage(() => listNotesMeta(vfs())));

    ctx.commands.register<Commands['notes_list_advanced']['args'], Commands['notes_list_advanced']['result']>(
      'notes_list_advanced', ({ options }) => {
        const page = options.page ?? 0;
        const pageSize = options.page_size ?? 20;
        return noteStorage(() => {
          const result = listNotesAdvanced(vfs(), {
            tags: options.tags,
            date_start: options.date_start,
            date_end: options.date_end,
            has_assets: options.has_assets,
            sort_by: options.sort_by,
            sort_dir: options.sort_dir,
            page,
            page_size: pageSize,
            keyword: options.keyword,
            include_deleted: options.include_deleted ?? false,
            only_deleted: options.only_deleted ?? false,
          });
          return { items: result.items, total: result.total, page, page_size: pageSize };
        });
      });

    ctx.commands.register<Commands['notes_list_deleted']['args'], Commands['notes_list_deleted']['result']>(
      'notes_list_deleted', ({ page, pageSize }) => listDeletedNotes(vfs(), page, pageSize));

    ctx.commands.register<Commands['notes_list_tags']['args'], Commands['notes_list_tags']['result']>(
      'notes_list_tags', () => blocking<string[]>('listTags', '获取标签任务失败'));

    ctx.commands.register<Commands['notes_search']['args'], Commands['notes_search']['result']>(
      'notes_search', ({ keyword, limit }) => searchNotes(vfs(), keyword, limit));

    ctx.commands.register<Commands['notes_get_backlinks']['args'], Commands['notes_get_backlinks']['result']>(
      'notes_get_backlinks', ({ noteId }) => backlinks(vfs(), noteId));

    ctx.commands.register<Commands['notes_get_outgoing_links']['args'], Commands['notes_get_outgoing_links']['result']>(
      'notes_get_outgoing_links', ({ noteId }) => outgoingLinks(vfs(), noteId));

    ctx.commands.register<Commands['notes_rebuild_links']['args'], Commands['notes_rebuild_links']['result']>(
      'notes_rebuild_links', ({ batchSize }) => rebuildLinks(vfs(), batchSize));

    ctx.commands.register<Commands['notes_unlinked_mentions']['args'], Commands['notes_unlinked_mentions']['result']>(
      'notes_unlinked_mentions', ({ noteId, limit }) => unlinkedMentions(vfs(), noteId, limit));

    // D3: internal results can carry bigint; the kernel's toWireJson performs
    // the Rust/Tauri JSON-number conversion, not the relation repository.
    ctx.commands.register<Commands['notes_relation_get']['args'], ExactNoteRelation | null>(
      'notes_relation_get', ({ id }) => noteStorage(() =>
        noteRelationRepository.get(vfs(), ctx.storage.database('mistakes'), id)));

    ctx.commands.register<Commands['notes_relation_list']['args'], ExactNoteRelation[]>(
      'notes_relation_list', ({ noteId }) => noteStorage(() =>
        noteRelationRepository.list(vfs(), ctx.storage.database('mistakes'), noteId)));

    ctx.commands.register<Commands['notes_relation_put']['args'], ExactNoteRelation>(
      'notes_relation_put', ({ request }) => noteStorage(() =>
        noteRelationRepository.put(vfs(), ctx.storage.database('mistakes'), request)));

    ctx.commands.register<Commands['notes_relation_delete']['args'], Commands['notes_relation_delete']['result']>(
      'notes_relation_delete', ({ id, expectedRevision }) => noteStorage(() =>
        noteRelationRepository.delete(vfs(), id, expectedRevision)));

    ctx.commands.register<Commands['notes_reference_status']['args'], Commands['notes_reference_status']['result']>(
      'notes_reference_status', ({ resourceId, locator }) => noteStorage(() =>
        noteRelationRepository.referenceStatus(vfs(), ctx.storage.database('mistakes'), resourceId, locator)));

    ctx.commands.register<Commands['notes_invalidate_resource_refs']['args'], Commands['notes_invalidate_resource_refs']['result']>(
      'notes_invalidate_resource_refs', ({ resourceId }) => noteStorage(() =>
        noteRelationRepository.invalidateResource(vfs(), resourceId)));

    ctx.commands.register<Commands['notes_list_referencing_resource']['args'], Commands['notes_list_referencing_resource']['result']>(
      'notes_list_referencing_resource', ({ resourceIds }) => noteStorage(() =>
        listNotesReferencing(vfs(), resourceIds)));

    ctx.commands.register<Commands['notes_get_format']['args'], Commands['notes_get_format']['result']>(
      'notes_get_format', ({ noteId }) => noteStorage(() =>
        noteRevisionRepository.transaction(vfs(), () => formatStatus(vfs(), noteId))));

    ctx.commands.register<Commands['notes_enable_columns']['args'], Commands['notes_enable_columns']['result']>(
      'notes_enable_columns', ({ noteId, expectedUpdatedAt, lease }, call) => {
        const result = noteStorage(() => writeStorage(call, lease, (conn) =>
          noteRevisionRepository.transaction(conn, () => {
            noteFormatRepository.enableColumns(conn, noteId, expectedUpdatedAt);
            return formatStatus(conn, noteId);
          })));
        ctx.backendEvents.emit('notes:format-changed', result);
        return result;
      });

    ctx.commands.register<Commands['notes_migrate_blocks']['args'], Commands['notes_migrate_blocks']['result']>(
      'notes_migrate_blocks', ({ noteId, expectedUpdatedAt, content, lease }, call) => {
        const note = noteStorage(() => writeStorage(call, lease, (conn) =>
          noteFormatRepository.migrate(conn, noteId, expectedUpdatedAt, content)));
        ctx.backendEvents.emit('notes:format-changed', note);
        return note;
      });

    ctx.commands.register<Commands['notes_history_current']['args'], Commands['notes_history_current']['result']>(
      'notes_history_current', ({ noteId }) => noteStorage(() => noteRevisionRepository.current(vfs(), noteId)));

    ctx.commands.register<Commands['notes_history_list']['args'], import('../api.ts').ExactNoteHistoryPage>(
      'notes_history_list', ({ noteId, cursor, limit, pinnedOnly }) => databaseStorage(() =>
        noteRevisionRepository.listFiltered(vfs(), noteId, cursor ?? null, limit ?? 30, pinnedOnly ?? false)));

    ctx.commands.register<Commands['notes_history_get']['args'], Commands['notes_history_get']['result']>(
      'notes_history_get', ({ noteId, versionId }) => databaseStorage(() =>
        noteRevisionRepository.getExact(vfs(), noteId, versionId)));

    ctx.commands.register<Commands['notes_history_set_pinned']['args'], Commands['notes_history_set_pinned']['result']>(
      'notes_history_set_pinned', ({ noteId, versionId, pinned }) => databaseStorage(() =>
        noteRevisionRepository.setPinned(vfs(), noteId, versionId, pinned)));

    ctx.commands.register<Commands['notes_history_get_retention']['args'], Commands['notes_history_get_retention']['result']>(
      'notes_history_get_retention', () => noteStorage(() => noteRevisionRepository.getRetention(vfs())));

    ctx.commands.register<Commands['notes_history_set_retention']['args'], Commands['notes_history_set_retention']['result']>(
      'notes_history_set_retention', ({ policy }) => noteStorage(() =>
        noteRevisionRepository.setRetention(vfs(), {
          edit_bucket_seconds: policy.edit_bucket_seconds,
          max_edit_versions: policy.max_edit_versions ?? null,
        })));

    ctx.commands.register<Commands['notes_history_restore_copy']['args'], Commands['notes_history_restore_copy']['result']>(
      'notes_history_restore_copy', ({ noteId, versionId }, call) => {
        const node = databaseStorage(() => noteToDstuNode(
          noteRevisionRepository.restoreCopy(vfs(), noteId, versionId)));
        emitWatchEvent({ type: 'created', path: node.path, node }, call.source.window);
        return node;
      });

    ctx.commands.register<Commands['notes_history_restore_selection_copy']['args'], Commands['notes_history_restore_selection_copy']['result']>(
      'notes_history_restore_selection_copy', ({ noteId, versionId, selection }, call) => {
        const node = noteStorage(() => noteToDstuNode(
          noteRevisionRepository.restoreSelectionCopy(vfs(), noteId, versionId, selection)));
        emitWatchEvent({ type: 'created', path: node.path, node }, call.source.window);
        return node;
      });

    ctx.commands.register<Commands['notes_history_restore_current']['args'], Commands['notes_history_restore_current']['result']>(
      'notes_history_restore_current', ({ noteId, versionId, expectedUpdatedAt, selection, lease }, call) => {
        const node = noteStorage(() => writeStorage(call, lease, (conn) => noteToDstuNode(
          noteRevisionRepository.restoreCurrent(conn, noteId, versionId, expectedUpdatedAt, selection ?? null))));
        emitWatchEvent({ type: 'updated', path: node.path, node }, call.source.window);
        return node;
      });

    ctx.commands.register<Commands['notes_transfer_blocks']['args'], Commands['notes_transfer_blocks']['result']>(
      'notes_transfer_blocks', ({ request, lease }, call) => {
        const result = noteStorage(() => writeStorage(call, lease, (conn) =>
          noteTransferRepository.transfer(conn, request)));
        ctx.backendEvents.emit('notes:transfer-completed', result);
        return result;
      });

    ctx.commands.register<Commands['notes_undo_transfer']['args'], Commands['notes_undo_transfer']['result']>(
      'notes_undo_transfer', ({ operationId, expectedSourceUpdatedAt, expectedTargetUpdatedAt, lease }, call) => {
        const result = noteStorage(() => writeStorage(call, lease, (conn) =>
          noteTransferRepository.undo(conn, operationId, expectedSourceUpdatedAt, expectedTargetUpdatedAt)));
        ctx.backendEvents.emit('notes:transfer-completed', result);
        return result;
      });

    ctx.commands.register<Commands['notes_review_save_as']['args'], Commands['notes_review_save_as']['result']>(
      'notes_review_save_as', ({ operationId, sourceNoteId, markdown, expectedUpdatedAt, capabilities, lease }, call) => {
        const result = noteStorage(() => writeStorage(call, lease, (conn) => noteReviewRepository.saveAs(conn, {
          operationId, sourceNoteId, markdown,
          expectedUpdatedAt: expectedUpdatedAt ?? null,
          capabilities: capabilities ?? [],
        }))) as Commands['notes_review_save_as']['result'];
        ctx.backendEvents.emit('notes:review-saved', result);
        return result;
      });

    ctx.commands.register<Commands['notes_editor_register']['args'], Commands['notes_editor_register']['result']>(
      'notes_editor_register', ({ noteId }, call) => noteStorage(() => {
        const result = noteLeaseRepository.register(
          vfs(), noteId, call.source.webview, call.source.window, noteLeaseRepository.now());
        if (result.active_lease !== null) ctx.backendEvents.emit('notes:lease-changed', result.active_lease);
        return result;
      }));

    ctx.commands.register<Commands['notes_editor_heartbeat']['args'], Commands['notes_editor_heartbeat']['result']>(
      'notes_editor_heartbeat', ({ participantId }, call) => noteStorage(() =>
        noteLeaseRepository.heartbeat(vfs(), participantId, call.source.webview, noteLeaseRepository.now())));

    ctx.commands.register<Commands['notes_editor_unregister']['args'], Commands['notes_editor_unregister']['result']>(
      'notes_editor_unregister', ({ participantId }, call) => noteStorage(() => {
        const result = noteLeaseRepository.unregister(
          vfs(), participantId, call.source.webview, noteLeaseRepository.now());
        for (const event of result) ctx.backendEvents.emit('notes:lease-ended', event);
        return result;
      }));

    ctx.commands.register<Commands['notes_editor_begin']['args'], Commands['notes_editor_begin']['result']>(
      'notes_editor_begin', ({ participantId, operationId, noteIds }, call) => noteStorage(() => {
        const result = noteLeaseRepository.begin(
          vfs(), participantId, call.source.webview, operationId, noteIds, noteLeaseRepository.now());
        ctx.backendEvents.emit('notes:lease-changed', result);
        return result;
      }));

    ctx.commands.register<Commands['notes_editor_lease_status']['args'], Commands['notes_editor_lease_status']['result']>(
      'notes_editor_lease_status', ({ token }) => noteStorage(() =>
        noteLeaseRepository.status(vfs(), token)));

    ctx.commands.register<Commands['notes_editor_freeze_ack']['args'], Commands['notes_editor_freeze_ack']['result']>(
      'notes_editor_freeze_ack', ({ lease, draft }, call) => noteStorage(() => {
        try {
          const result = noteLeaseRepository.ack(
            vfs(), lease, call.source.webview, draft, noteLeaseRepository.now());
          ctx.backendEvents.emit('notes:lease-changed', result);
          return result;
        } catch (error) {
          if (error instanceof NoteDocumentError && error.kind === 'conflict'
            && (error.key === 'notes.lease_stale_draft' || error.key === 'notes.lease_divergent_drafts')) {
            const event = noteRevisionRepository.transaction(vfs(), () =>
              noteLeaseRepository.remove(vfs(), lease.token, error.key));
            ctx.backendEvents.emit('notes:lease-ended', event);
          }
          throw error;
        }
      }));

    ctx.commands.register<Commands['notes_editor_flush']['args'], Commands['notes_editor_flush']['result']>(
      'notes_editor_flush', ({ lease, noteId, capabilities }, call) => noteStorage(() =>
        noteLeaseRepository.flush(
          vfs(), lease, call.source.webview, noteId, capabilities ?? [], noteLeaseRepository.now())));

    ctx.commands.register<Commands['notes_editor_finish']['args'], Commands['notes_editor_finish']['result']>(
      'notes_editor_finish', ({ lease }, call) => noteStorage(() => {
        const result = noteLeaseRepository.finish(
          vfs(), lease, call.source.webview, noteLeaseRepository.now());
        ctx.backendEvents.emit('notes:lease-changed', result);
        return result;
      }));

    ctx.commands.register<Commands['notes_editor_refresh_ack']['args'], Commands['notes_editor_refresh_ack']['result']>(
      'notes_editor_refresh_ack', ({ lease, updatedAt }, call) => noteStorage(() => {
        const result = noteLeaseRepository.refreshAck(
          vfs(), lease, call.source.webview, updatedAt, noteLeaseRepository.now());
        ctx.backendEvents.emit('notes:lease-changed', result);
        return result;
      }));

    ctx.commands.register<Commands['notes_editor_release']['args'], Commands['notes_editor_release']['result']>(
      'notes_editor_release', ({ lease, cancel }, call) => noteStorage(() => {
        const result = noteLeaseRepository.release(
          vfs(), lease, call.source.webview, cancel, noteLeaseRepository.now());
        ctx.backendEvents.emit('notes:lease-ended', result);
        return result;
      }));

    // ---------------- Canvas AI tools ----------------
    ctx.commands.register<Commands['canvas_note_read']['args'], Commands['canvas_note_read']['result']>(
      'canvas_note_read', ({ noteId, section }) => canvasRead(vfs(), noteId, section));

    ctx.commands.register<Commands['canvas_note_append']['args'], Commands['canvas_note_append']['result']>(
      'canvas_note_append', ({ noteId, content, section }) =>
        canvasAppend(vfs(), noteId, content, section));

    ctx.commands.register<Commands['canvas_note_replace']['args'], Commands['canvas_note_replace']['result']>(
      'canvas_note_replace', async ({ noteId, search, replace, isRegex }) =>
        u32(await canvasReplace(vfs(), noteId, search, replace, isRegex === true, ctx.get('nativeRegex'))));

    ctx.commands.register<Commands['canvas_note_set']['args'], Commands['canvas_note_set']['result']>(
      'canvas_note_set', ({ noteId, content }) => canvasSet(vfs(), noteId, content));

    // ---------------- Assets ----------------
    ctx.commands.register<Commands['notes_save_asset']['args'], Commands['notes_save_asset']['result']>(
      'notes_save_asset', ({ subject, noteId, base64Data, defaultExt }) =>
        saveAsset(ctx.storage.locations.activeDir, subject, noteId, base64Data, defaultExt));

    ctx.commands.register<Commands['notes_list_assets']['args'], Commands['notes_list_assets']['result']>(
      'notes_list_assets', ({ subject, noteId }) =>
        listAssets(ctx.storage.locations.activeDir, subject, noteId));

    ctx.commands.register<Commands['notes_assets_index_scan']['args'], Commands['notes_assets_index_scan']['result']>(
      'notes_assets_index_scan', ({ subject, noteId }) =>
        assetsIndexScan(ctx.storage.locations.activeDir, subject, noteId));

    ctx.commands.register<Commands['notes_delete_asset']['args'], Commands['notes_delete_asset']['result']>(
      'notes_delete_asset', ({ relativePath }) => withDeletePropagation(ctx, () =>
        removeAsset(ctx.storage.locations.activeDir, relativePath)));

    ctx.commands.register<Commands['notes_assets_bulk_delete']['args'], Commands['notes_assets_bulk_delete']['result']>(
      'notes_assets_bulk_delete', ({ paths }) => withDeletePropagation(ctx, () =>
        removeAssets(ctx.storage.locations.activeDir, paths)));

    ctx.commands.register<Commands['notes_resolve_asset_path']['args'], Commands['notes_resolve_asset_path']['result']>(
      'notes_resolve_asset_path', ({ relativePath }) =>
        resolveAsset(ctx.storage.locations.activeDir, relativePath));

    ctx.commands.register<Commands['notes_assets_scan_orphans']['args'], Commands['notes_assets_scan_orphans']['result']>(
      'notes_assets_scan_orphans', ({ subject }) =>
        scanOrphans(ctx.storage.locations.activeDir, subject, vfs()));

    // ---------------- Trash ----------------
    ctx.commands.register<Commands['notes_hard_delete']['args'], Commands['notes_hard_delete']['result']>(
      'notes_hard_delete', ({ subject, id }) => withDeletePropagation(ctx, () =>
        hardDelete(ctx.storage.locations.activeDir, vfs(), id, subject)));

    ctx.commands.register<Commands['notes_empty_trash']['args'], Commands['notes_empty_trash']['result']>(
      'notes_empty_trash', () => withDeletePropagation(ctx, () =>
        emptyTrash(ctx.storage.locations.activeDir, vfs())));

    // ---------------- Markdown import ----------------
    ctx.commands.register<Commands['notes_import_markdown']['args'], Commands['notes_import_markdown']['result']>(
      'notes_import_markdown', ({ request }) => importMarkdown(vfs(), request));

    ctx.commands.register<Commands['notes_import_markdown_batch']['args'], Commands['notes_import_markdown_batch']['result']>(
      'notes_import_markdown_batch', ({ request }) => importMarkdownBatch(vfs(), request));

    // ---------------- RAG helpers ----------------
    ctx.commands.register<Commands['rag_rebuild_fts_index']['args'], Commands['rag_rebuild_fts_index']['result']>(
      'rag_rebuild_fts_index', () => {
        notesLog.info('[deprecated] rag_rebuild_fts_index：Lance RAG 使用原生 FTS，无需重建，恒返回 0');
        return 0;
      });

    ctx.commands.register<Commands['notes_rag_rebuild_fts_index']['args'], Commands['notes_rag_rebuild_fts_index']['result']>(
      'notes_rag_rebuild_fts_index', () => {
        notesLog.info('[deprecated] notes_rag_rebuild_fts_index：Notes RAG 使用 Lance 内置 FTS，无索引可重建，恒返回 0');
        return 0;
      });

    ctx.commands.register<Commands['notes_get_subject_rag_config']['args'], Commands['notes_get_subject_rag_config']['result']>(
      'notes_get_subject_rag_config', ({ subject }) =>
        getSubjectConfig(settingsService(ctx), ctx.storage.database('mistakes'), subject));

    ctx.commands.register<Commands['notes_update_subject_rag_config']['args'], Commands['notes_update_subject_rag_config']['result']>(
      'notes_update_subject_rag_config', ({ subject, cfg }) =>
        updateSubjectConfig(settingsService(ctx), ctx.storage.database('mistakes'), subject, cfg));

    ctx.commands.register<Commands['notes_set_pref']['args'], Commands['notes_set_pref']['result']>(
      'notes_set_pref', ({ key, value }) => setPref(settingsService(ctx), key, value));

    ctx.commands.register<Commands['notes_get_pref']['args'], Commands['notes_get_pref']['result']>(
      'notes_get_pref', ({ key }) => getPref(settingsService(ctx), key));

    ctx.commands.register<Commands['notes_mentions_search']['args'], Commands['notes_mentions_search']['result']>(
      'notes_mentions_search', ({ subject, keyword, limit }) => {
        if (rustTrim(keyword).length === 0) return { notes: [], mistakes: [], irec_cards: [] };
        const normalizedSubject = subject === null || subject === undefined || rustTrim(subject).length === 0
          ? null : rustTrim(subject);
        let mistakes;
        try {
          mistakes = ctx.storage.database('mistakes');
        } catch (error) {
          throw new CommandError(AppError.database(`获取错题数据库连接失败: ${errorMessage(error)}`));
        }
        return mentionSearch(vfs(), mistakes, keyword, normalizedSubject, limit);
      });

    // ---------------- Canvas frontend callbacks ----------------
    ctx.commands.register<Commands['chat_v2_canvas_edit_ack']['args'], Commands['chat_v2_canvas_edit_ack']['result']>(
      'chat_v2_canvas_edit_ack', ({ requestId }) => {
        if (rustTrim(requestId).length === 0) {
          throw new CommandError(JSON.stringify({
            code: 'INVALID_INPUT', message: 'Invalid input: request_id must not be empty',
          }));
        }
        handleEditAck(requestId);
        return null;
      });

    ctx.commands.register<Commands['chat_v2_canvas_edit_result']['args'], Commands['chat_v2_canvas_edit_result']['result']>(
      'chat_v2_canvas_edit_result', ({ result }) => {
        if (rustTrim(result.requestId).length === 0) {
          throw new CommandError(JSON.stringify({
            code: 'INVALID_INPUT', message: 'Invalid input: request_id must not be empty',
          }));
        }
        handleEditResult(result);
        return null;
      });

    // ---------------- Export / import ----------------
    ctx.commands.register<Commands['notes_export']['args'], Commands['notes_export']['result']>(
      'notes_export', ({ request }) => exportAll(transferContext(), request));

    ctx.commands.register<Commands['notes_export_single']['args'], Commands['notes_export_single']['result']>(
      'notes_export_single', ({ request }) => exportOne(transferContext(), request));

    ctx.commands.register<Commands['notes_import']['args'], Commands['notes_import']['result']>(
      'notes_import', ({ request }, call) => importAll({
        ...transferContext(),
        // Rust sends progress through the invoking `Window`, not app-wide.
        onProgress: (progress) => ctx.backendEvents.emitTo(
          { kind: 'Window', label: call.source.window }, 'notes-import-progress', progress),
      }, request));

    ctx.commands.register<Commands['notes_db_stats']['args'], Commands['notes_db_stats']['result']>(
      'notes_db_stats', () => dbStats(ctx.storage.database('vfs'), ctx.storage.locations.activeDir));

    ctx.commands.register<Commands['notes_db_vacuum']['args'], Commands['notes_db_vacuum']['result']>(
      'notes_db_vacuum', () => blocking<boolean>('vacuum', 'VACUUM 任务失败'));

    registerNotesStartupSweep(ctx);
  },
  });
}
