import { CommandError, definePlugin } from '../../kernel/api.ts';
import { StorageError } from '../../platform/storage/errors.ts';
import type { HttpService } from '../../platform/http/api.ts';
import type { Commands, MemoryBatchWriteOutput } from '../../../contracts/ipc/generated/L17-memory-research.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';
import type {} from '../vfs-handlers/api.ts';
import { createInsightCommandService } from './src/insight-api.ts';
import { InsightService } from './src/insight-service.ts';
import { createMasteryProfileSink } from './src/mastery-sink.ts';
import { createQuickAssistantService } from './src/quick-assistant.ts';
import { createHpiasResearchService } from './src/hpias-service.ts';
import { cryptoOf } from './src/crypto.ts';
import { createMemoryToolMetadata } from './src/tool-metadata.ts';
import { MemoryToolExecutor } from './src/memory-tool-executor.ts';
import { LearningOverviewExecutor } from './src/learning-overview-executor.ts';
import { InsightRecallExecutor } from './src/insight-recall-executor.ts';
import type { InsightRecallModel } from './src/insight-recall.ts';
import { AcademicSearchExecutor, type AcademicFetch } from './src/academic-search-executor.ts';
import { PaperSaveExecutor, type PaperLibraryPort } from './src/paper-save-executor.ts';
import {
  KnowledgeExecutor, type KnowledgeModelPort, type PendingMemoryCandidateWriter,
} from './src/knowledge-executor.ts';
import type {} from '../chat-pipeline/api.ts';
import type {} from '../agent-skills/api.ts';
import type {} from '../review/api.ts';
import type {} from '../media/api.ts';
import { existenceHints } from './src/insight-hints.ts';
import type { InsightHintsService } from './api.ts';
import {
  MemoryServiceImpl, ctxGet, parseMemoryPurpose, parseMemoryType, type WriteMode,
} from './src/service.ts';

function commandFailure(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof StorageError) throw new CommandError(`Database error: ${error.message}`);
  throw new CommandError(error instanceof Error ? error.message : String(error));
}

function commandResult<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    return commandFailure(error);
  }
}

async function commandResultAsync<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    return commandFailure(error);
  }
}

export function writeMode(value: string | null | undefined,
  warn: (message: string) => void = () => undefined): WriteMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'update') return 'update';
  if (normalized === 'append') return 'append';
  if (value !== null && value !== undefined && normalized !== 'create') {
    warn(`[Memory] Unknown WriteMode '${value}', defaulting to Create`);
  }
  return 'create';
}

const MEMORY_COMMANDS = [
  'memory_get_config', 'memory_set_root_folder', 'memory_create_root_folder',
  'memory_get_or_create_root_folder', 'memory_read', 'memory_write', 'memory_list',
  'memory_get_tree', 'memory_add_relation', 'memory_remove_relation', 'memory_get_related',
  'memory_update_tags', 'memory_get_tags', 'memory_restore_stale', 'memory_restore_archived',
  'memory_batch_delete', 'memory_batch_move', 'memory_move_to_folder', 'memory_update_by_id',
  'memory_delete', 'memory_export_all', 'memory_get_profile', 'memory_write_smart',
  'memory_write_batch', 'memory_to_anki_document', 'memory_set_privacy_mode',
  'memory_set_auto_create_subfolders', 'memory_set_default_category',
  'memory_set_auto_extract_frequency', 'memory_get_audit_logs', 'memory_search',
  'quick_assistant_show', 'quick_assistant_hide', 'quick_assistant_apply_enabled',
] as const;

export interface MemoryPluginConfig {
  /**
   * HPIAS 后端（Rust 环境变量 `DEEP_STUDENT_HPIAS_BACKEND`，dstu-research hpias/service.rs:26）：
   * `stub` / `retrieval` / 缺省或 `disabled`。每次 startFromIntent 时读取。
   */
  hpiasBackend?: string | null;
}

export default definePlugin<MemoryPluginConfig | undefined>({
  meta: {
    id: 'dstu.memory', lane: 'L17-memory-research',
    provides: ['memory', 'insight', 'masteryProfileSink', 'memoryRetrieval', 'hpiasResearch', 'memoryConfig',
      'memoryToolMetadata', 'insightHints'],
    commands: [...MEMORY_COMMANDS],
    platforms: ['desktop', 'mobile'],
  },
  // 提供方尚未按 ARCHITECTURE 附录 A 更名；这里暂用其现有 key 保证 profile 可启动，
  // 业务代码仍按“新名优先、旧名兜底”解析（见 service.ts / resolveRepos）。
  inject: ['storage', 'settings', 'notes', 'vfsRepo', 'log'],
  apply(ctx, config) {
    const service = new MemoryServiceImpl(ctx);
    const toolMetadata = createMemoryToolMetadata();
    ctx.provide('memoryToolMetadata', toolMetadata);
    const hintLog = ctx.log.logger('dstu_agent::chat_v2::pipeline');
    ctx.provide('insightHints', {
      existenceHints: request => existenceHints({
        vfsDb: () => ctx.storage.database('vfs'),
        mainDb: () => ctx.storage.database('mistakes'),
        warn: message => hintLog.warn(message),
      }, request),
    } satisfies InsightHintsService);
    const memoryTools = new MemoryToolExecutor({
      service: () => service,
      llmAvailable: () => ctx.get('llm') !== undefined,
      emit: (event, payload) => ctx.backendEvents.emit(event, payload),
      log: ctx.log.logger('dstu_memory::memory'),
    });
    const researchLog = ctx.log.logger('dstu_research::tools');
    const learningOverview = new LearningOverviewExecutor({
      vfsDb: () => ctx.storage.database('vfs'),
      ankiActivityDb: () => ctx.storage.database('mistakes'),
      pomodoros: () => {
        const repos = ctxGet(ctx, 'vfsRepo') as VfsReposService | undefined;
        if (repos?.pomodoros === undefined) throw new Error('vfsRepo pomodoro repository is not available');
        return repos.pomodoros;
      },
      reviewStats: () => {
        const reviewPlan = ctx.get('reviewPlan');
        if (reviewPlan === undefined) throw new Error('reviewPlan service is not available');
        return reviewPlan.getReviewStats(null);
      },
      fsrs: () => ctx.get('review') ?? null,
      masterySummary: limit => {
        const mastery = ctx.get('mastery');
        if (mastery === undefined) throw new Error('mastery service is not available');
        return mastery.overviewSummary(limit);
      },
      mediaSummary: (conn, limit) => {
        const media = ctx.get('media');
        if (media === undefined) throw new Error('media service is not available');
        return media.mediaLearningSummary(conn, limit);
      },
      log: researchLog,
    });
    const insightRecall = new InsightRecallExecutor({
      vfsDb: () => ctx.storage.database('vfs'),
      mainDb: () => ctx.storage.database('mistakes'),
      llm: () => {
        const llm = ctxGet(ctx, 'llmRawPrompt') as Partial<InsightRecallModel> | undefined;
        return llm?.callMemoryDecisionRawPrompt === undefined ? null : llm as InsightRecallModel;
      },
      numberSources: () => ctx.get('vfs')?.buildNumberedSources ?? null,
      ledgerForReply: (sessionId, messageId, variantId) =>
        ctx.get('chatPipeline')?.citationLedgerForReply(sessionId, messageId, variantId) ?? null,
      log: researchLog,
    });
    const academicSearch = new AcademicSearchExecutor({
      http: () => (ctxGet(ctx, 'llmHttp') as { fetch: AcademicFetch } | undefined) ?? null,
      numberSources: () => ctx.get('vfs')?.buildNumberedSources ?? null,
      ledgerForReply: (sessionId, messageId, variantId) =>
        ctx.get('chatPipeline')?.citationLedgerForReply(sessionId, messageId, variantId) ?? null,
      log: researchLog,
    });
    const paperSave = new PaperSaveExecutor({
      http: () => (ctxGet(ctx, 'llmHttp') as { fetch: AcademicFetch } | undefined) ?? null,
      publicHttp: () => (ctxGet(ctx, 'http') as HttpService | undefined) ?? null,
      library: () => (ctxGet(ctx, 'paperLibrary') as PaperLibraryPort | undefined) ?? null,
      crypto: () => cryptoOf(ctx),
      log: researchLog,
    });
    const knowledge = new KnowledgeExecutor({
      llm: () => (ctxGet(ctx, 'llm') as Partial<KnowledgeModelPort> | undefined) ?? null,
      candidates: () => (ctxGet(ctx, 'pendingMemoryCandidates') as PendingMemoryCandidateWriter | undefined) ?? null,
      log: researchLog,
    });
    ctx.inject(['agentTools'], scoped => {
      const registration = scoped.agentTools.registerToolExecutors([
        memoryTools, academicSearch, paperSave, learningOverview, insightRecall, knowledge,
      ]);
      scoped.effect(() => () => registration.dispose());
    });
    const quickAssistant = createQuickAssistantService(ctx);
    /**
     * Resolve the VFS repository through the ARCHITECTURE name first and the
     * legacy key second. The insight facade is lazy so it is only constructed
     * when the first `insight_*` command arrives (after all services are up).
     */
    const resolveRepos = (): VfsReposService => {
      const repos = ctxGet(ctx, 'vfsRepo') as
        VfsReposService | undefined;
      if (repos === undefined) throw new Error('vfsRepo service is not available');
      return repos;
    };
    ctx.provide('insight', createInsightCommandService({
      service: () => {
        const repos = resolveRepos();
        return new InsightService(ctx.storage.database('vfs'), repos.resources);
      },
      runJobs: batchSize => service.runInsightJobs(batchSize),
    }));
    ctx.provide('masteryProfileSink', createMasteryProfileSink(service));
    ctx.provide('memoryRetrieval', {
      getRootFolderId: () => service.getRootFolderId(),
      search: (query: string, topK: number, signal: AbortSignal | null) =>
        service.search(query, topK, signal),
      compress: (query: string, results: Parameters<typeof service.compress>[1]) =>
        service.compress(query, results),
    });
    ctx.provide('hpiasResearch', createHpiasResearchService(ctx, { backend: () => config?.hpiasBackend }));
    ctx.provide('memoryConfig', {
      get: (key: string) => service.config.get(key),
      set: (key: string, value: string) => service.config.set(key, value),
    });
    /**
     * Rust `install_vfs_hooks` registers the memory note-delete hook when the
     * VFS extension is present. `vfsHooks` is optional so minimal profiles and
     * unit hosts still start; the hook owns no command surface.
     */
    ctx.inject(['vfsHooks'], scoped => {
      const dispose = scoped.vfsHooks.registerNoteDeleteHook({
        captureDelete: noteId => service.captureNoteDelete(noteId),
      });
      scoped.effect(() => dispose);
    });
    const changed = (action: string, entityIds: string[]) =>
      ctx.backendEvents.emit('memory://changed', { source: 'user', action, entityIds });

    ctx.commands.register<Commands['memory_get_config']['args']>('memory_get_config', () =>
      commandResult(() => service.getConfig()));
    ctx.commands.register<Commands['memory_set_root_folder']['args']>('memory_set_root_folder', ({ folderId }) =>
      commandResult(() => service.setRootFolder(folderId)));
    ctx.commands.register<Commands['memory_create_root_folder']['args']>('memory_create_root_folder', ({ title }) =>
      commandResult(() => service.createRootFolder(title)));
    ctx.commands.register<Commands['memory_get_or_create_root_folder']['args']>('memory_get_or_create_root_folder', () =>
      commandResult(() => service.getOrCreateRootFolder()));
    ctx.commands.register<Commands['memory_read']['args']>('memory_read', ({ noteId }) =>
      commandResult(() => service.readWithAbsoluteFolderPath(noteId)));
    ctx.commands.register<Commands['memory_write']['args']>('memory_write', args =>
      commandResultAsync(async () => {
        if (args.title.trim().length === 0 && args.content.trim().length === 0) {
          throw new CommandError('标题与内容不能同时为空');
        }
        const mode = writeMode(args.mode,
          message => ctx.log.logger('dstu_memory::memory').warn(message));
        const result = args.noteId === null || args.noteId === undefined
          ? service.write(args.folderPath ?? null, args.title, args.content, mode)
          : mode === 'append'
            ? service.appendById(args.noteId, args.title, args.content)
            : service.updateById(args.noteId, args.title, args.content);
        service.scheduleAfterWrite([result.resourceId]);
        changed('write', [result.noteId]);
        return result;
      }));
    ctx.commands.register<Commands['memory_list']['args']>('memory_list', args =>
      commandResult(() => service.list(args.folderPath ?? null,
        Math.min(500, Math.max(1, args.limit ?? 100)), args.offset ?? 0)));
    ctx.commands.register<Commands['memory_get_tree']['args']>('memory_get_tree', () =>
      commandResult(() => service.getTree()));
    ctx.commands.register<Commands['memory_add_relation']['args']>('memory_add_relation', ({ noteIdA, noteIdB }) =>
      commandResult(() => {
        service.addRelation(noteIdA, noteIdB);
        changed('add_relation', [noteIdA, noteIdB]);
        return null;
      }));
    ctx.commands.register<Commands['memory_remove_relation']['args']>('memory_remove_relation', ({ noteIdA, noteIdB }) =>
      commandResult(() => {
        service.removeRelation(noteIdA, noteIdB);
        changed('remove_relation', [noteIdA, noteIdB]);
        return null;
      }));
    ctx.commands.register<Commands['memory_get_related']['args']>('memory_get_related', ({ noteId }) =>
      commandResult(() => service.getRelated(noteId)));
    ctx.commands.register<Commands['memory_update_tags']['args']>('memory_update_tags', ({ noteId, tags }) =>
      commandResult(() => {
        service.updateTags(noteId, tags);
        changed('update_tags', [noteId]);
        return null;
      }));
    ctx.commands.register<Commands['memory_get_tags']['args']>('memory_get_tags', ({ noteId }) =>
      commandResult(() => service.getTags(noteId)));
    ctx.commands.register<Commands['memory_restore_stale']['args']>('memory_restore_stale', ({ noteId }) =>
      commandResult(() => {
        const restored = service.restoreStale(noteId);
        if (restored) changed('restore_stale', [noteId]);
        return restored;
      }));
    ctx.commands.register<Commands['memory_restore_archived']['args']>('memory_restore_archived', ({ noteId }) =>
      commandResult(() => {
        const restored = service.restoreArchived(noteId);
        if (restored) changed('restore_archived', [noteId]);
        return restored;
      }));
    ctx.commands.register<Commands['memory_batch_delete']['args']>('memory_batch_delete', ({ noteIds }) =>
      commandResultAsync(async () => {
        const result = await service.batchDelete(noteIds);
        if (result.succeeded > 0) {
          void service.spawnPostWriteMaintenance();
          changed('batch_delete', result.changedIds);
        }
        const { changedIds, ...wire } = result;
        void changedIds;
        return wire;
      }));
    ctx.commands.register<Commands['memory_batch_move']['args']>('memory_batch_move', ({ noteIds, targetFolderPath }) =>
      commandResult(() => {
        const result = service.batchMove(noteIds, targetFolderPath);
        if (result.succeeded > 0) changed('batch_move', result.changedIds);
        const { changedIds, ...wire } = result;
        void changedIds;
        return wire;
      }));
    ctx.commands.register<Commands['memory_move_to_folder']['args']>('memory_move_to_folder', ({ noteId, targetFolderPath }) =>
      commandResult(() => {
        service.moveToFolder(noteId, targetFolderPath);
        changed('move', [noteId]);
        return null;
      }));
    ctx.commands.register<Commands['memory_update_by_id']['args']>('memory_update_by_id', args =>
      commandResultAsync(async () => {
        const result = service.updateById(args.noteId, args.title ?? null, args.content ?? null);
        service.scheduleAfterWrite([result.resourceId]);
        changed('update', [result.noteId]);
        return result;
      }));
    ctx.commands.register<Commands['memory_delete']['args']>('memory_delete', ({ noteId }) =>
      commandResultAsync(async () => {
        await service.delete(noteId);
        void service.spawnPostWriteMaintenance();
        changed('delete', [noteId]);
        return null;
      }));
    ctx.commands.register<Commands['memory_export_all']['args']>('memory_export_all', () =>
      commandResult(() => service.exportAll()));
    ctx.commands.register<Commands['memory_get_profile']['args']>('memory_get_profile', () =>
      commandResult(() => service.getProfile()));
    ctx.commands.register<Commands['memory_to_anki_document']['args']>('memory_to_anki_document', args =>
      commandResult(() => service.toAnkiDocument(args.folderPath ?? null,
        args.purposeFilter ?? null, Math.min(1000, Math.max(1, args.limit ?? 200)))));
    ctx.commands.register<Commands['memory_write_smart']['args']>('memory_write_smart', args =>
      commandResultAsync(async () => {
        // Rust handlers.rs:774-779 checks title/content before service and type parsing.
        if (args.title.trim().length === 0) throw new Error('标题不能为空');
        if (args.content.trim().length === 0) throw new Error('内容不能为空');
        const memoryType = parseMemoryType(args.memoryType);
        const memoryPurpose = parseMemoryPurpose(args.memoryPurpose);
        const result = await service.writeSmart(args.folderPath ?? null, args.title, args.content,
          memoryType, memoryPurpose, args.idempotencyKey ?? null);
        if (result.event !== 'NONE' && result.event !== 'FILTERED') {
          service.scheduleAfterWrite([result.resourceId]);
          changed('write_smart', [result.noteId]);
        }
        return result;
      }));
    ctx.commands.register<Commands['memory_write_batch']['args']>('memory_write_batch', args =>
      commandResultAsync(async (): Promise<MemoryBatchWriteOutput> => {
        const output = await service.writeBatch(args.items, args.defaultFolderPath ?? null,
          args.defaultMemoryType ?? null, args.defaultMemoryPurpose ?? null);
        const resourceIds = output.results.map(item => item.resourceId);
        if (resourceIds.some(id => id !== null && id !== '')) {
          service.scheduleAfterWrite(resourceIds);
        }
        if (output.noteIds.length > 0) changed('write_batch', output.noteIds);
        const { noteIds, ...wire } = output;
        void noteIds;
        return wire;
      }));
    ctx.commands.register<Commands['memory_set_privacy_mode']['args']>('memory_set_privacy_mode', ({ enabled }) =>
      commandResult(() => { service.setPrivacyMode(enabled); return null; }));
    ctx.commands.register<Commands['memory_set_auto_create_subfolders']['args']>('memory_set_auto_create_subfolders', ({ enabled }) =>
      commandResult(() => { service.setAutoCreateSubfolders(enabled); return null; }));
    ctx.commands.register<Commands['memory_set_default_category']['args']>('memory_set_default_category', ({ category }) =>
      commandResult(() => { service.setDefaultCategory(category); return null; }));
    ctx.commands.register<Commands['memory_set_auto_extract_frequency']['args']>('memory_set_auto_extract_frequency', ({ frequency }) => {
      const value = frequency.trim().toLowerCase();
      if (value !== 'off' && value !== 'balanced' && value !== 'aggressive') {
        throw new CommandError(`Invalid auto extract frequency '${value}', expected one of: off, balanced, aggressive`);
      }
      commandResult(() => { service.setAutoExtractFrequency(value); return null; });
    });
    ctx.commands.register<Commands['memory_get_audit_logs']['args']>('memory_get_audit_logs', args =>
      commandResult(() => service.queryAuditLogs(Math.min(200, Math.max(1, args.limit ?? 50)),
        args.offset ?? 0, args.sourceFilter ?? null, args.operationFilter ?? null, args.successFilter ?? null)));
    ctx.commands.register<Commands['memory_search']['args']>('memory_search', args =>
      commandResultAsync(async () => {
        const topK = Math.min(100, Math.max(1, args.topK ?? 5));
        return service.searchWithRerank(args.query, topK, false);
      }));
    ctx.commands.register<Commands['quick_assistant_show']['args']>('quick_assistant_show', () =>
      quickAssistant.show());
    ctx.commands.register<Commands['quick_assistant_hide']['args']>('quick_assistant_hide', () =>
      quickAssistant.hide());
    ctx.commands.register<Commands['quick_assistant_apply_enabled']['args']>('quick_assistant_apply_enabled',
      ({ enabled }) => quickAssistant.applyEnabled(enabled));
  },
});
