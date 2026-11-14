import * as path from '../../platform/util/path.ts';
import { definePlugin } from '../../kernel/api.ts';
import type { NativePdfium } from '../../platform/native/pdfium/api.ts';
import type { SettingsWithConn } from '../../platform/settings/api.ts';
import type { StartupFinalizerRegistration } from '../../platform/storage/startup-finalizers.ts';
import { createChatCommands, optimizeLanceDatabase } from './src/commands.ts';
import { VfsLanceStore } from './src/lance-store.ts';
import { createLifecycleLanceStore, VfsLanceDisabled } from './src/lance-disabled.ts';
import { LegacyKbStore } from './src/legacy-kb-store.ts';
import { LifecycleLanceEngine } from './src/lance-engine.ts';
import {
  createIndexingServices, createPdfRuntime, createRetrievalService, optionalService, resolveVfsLanceBase,
} from './src/runtime-adapter.ts';
import { PdfProcessingService } from './src/pdf-service.ts';
import { VfsUnitIndexService } from './src/unit-sync-service.ts';
import {
  requeuePagedPdfsAtWorkerStart, runStartupLanceMaintenance, STARTUP_LANCE_MAINTENANCE_DELAY_MS,
} from './src/startup-maintenance.ts';
import { registerVfsIndexStartupRecovery } from './src/startup-recovery.ts';
import { VfsIndexWorker, type IndexWorkerSleep } from './src/index-worker.ts';
import { getIndexingConfig } from './src/indexing-content.ts';
import type { BackgroundTasks } from '../../platform/diagnostics/api.ts';
import { bindVfsTableOwners, unbindVfsTableOwners } from './repository/owners.ts';
import { reviveConfigBlocked } from './repository/index-state.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';
import type { CancellableRetrievalService, VfsIndexService } from './api.ts';
import type { LlmEmbeddingModels } from '../llm/api.ts';
import type { FilesService } from '../../platform/files/api.ts';

export interface VfsIndexPluginConfig {
  /** Resident index consumer (`start_vfs_index_worker`); tests may disable it or inject the sleep. */
  indexWorker?: { enabled?: boolean; sleep?: IndexWorkerSleep };
}

/** F2 `startupGate` consumer surface. */
interface StartupGateReader {
  waitStartupReady(timeout: number): Promise<boolean>;
}
const STARTUP_READY_TIMEOUT_MS = 120_000;

/**
 * builtin_retrieval_executor.rs:299-321 drops the search future when the token fires. The
 * retriever takes no signal, so an abort settles the caller now and discards the result;
 * routes already started finish under ROUTE_TIMEOUT_MS and still record their circuit outcome.
 */
function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal | null): Promise<T> {
  const aborted = () => Object.assign(new Error('retrieval cancelled'), { name: 'AbortError' });
  if (signal === null) return start();
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    const settle = <V>(done: (value: V) => void) => (value: V) => { signal.removeEventListener('abort', onAbort); done(value); };
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try { pending = start(); }
    catch (error) { settle(reject)(error); return; }
    pending.then(settle(resolve), settle(reject));
  });
}

export default definePlugin<VfsIndexPluginConfig>({
  meta: {
    id: 'dstu.vfs-index',
    lane: 'L12-vfs-index',
    commands: ['clear_message_embeddings', 'optimize_chat_embeddings_table', 'optimize_lance_database'],
    platforms: ['desktop', 'mobile'],
    provides: ['lanceEngine', 'retrieval', 'retrievalCancellable', 'vfsIndex', 'vfsUnitBuilder', 'vfsIndexMaintenance'],
  },
  inject: ['storage'],
  apply(ctx, config) {
    const logger = ctx.logger('vfs-index');
    /**
     * `ctx.files` 只在需要读写文件字节的路径上取（W14：桌面与移动端同一套异步接口）。
     * 不放进 `inject`：只装置检索/命令层的最小宿主没有 files，仍应能启动。
     */
    const filesService = (): FilesService => {
      const service = ctx.reflect.get('files', false) as FilesService | undefined;
      if (service === undefined) throw new Error('待接线：files（ctx.files 文件服务）');
      return service;
    };
    // F7's `vector` provider is optional so lexical retrieval still starts.
    // Both the engine and store are lifecycle delegates: a late provider is
    // picked up without caching `undefined` at apply time.
    const lanceEngine = new LifecycleLanceEngine();
    const lanceLifecycle = createLifecycleLanceStore();
    const lanceEnabled = (): boolean => lanceLifecycle.enabled();
    ctx.provide('lanceEngine', lanceEngine);

    const commands = createChatCommands(ctx, lanceEngine, lanceEnabled);
    ctx.commands.register('clear_message_embeddings', commands.clearMessageEmbeddings);
    ctx.commands.register('optimize_chat_embeddings_table', commands.optimizeChatEmbeddingsTable);

    // `retrieval`: lexical routes work without F7; vector routes report an
    // explicit failure when the Lance engine or L02 embedding service is absent.
    const storage = ctx.storage;
    const vfsDb = storage.database('vfs');
    // Stop fire-and-forget media tasks and the index worker before the L11 owner binding goes away.
    const beforeUnbind: Array<() => Promise<void>> = [];
    // Bind the table owner for the exact handle every L12 service uses.
    ctx.inject(['vfsRepo'], (linked) => {
      const repos = linked.get('vfsRepo') as VfsReposService | undefined;
      if (repos === undefined) return;
      bindVfsTableOwners(vfsDb, repos);
      return async () => {
        for (const stop of beforeUnbind) await stop();
        unbindVfsTableOwners(vfsDb);
      };
    });
    // `lance_store_stub.rs`: without the F7 Lance feature reads stay empty
    // (lexical retrieval still works) and writes fail explicitly. The stable
    // delegate switches to the real store once `vector` is provided.
    const indexLance = lanceLifecycle.store;
    let vectorLinked = false;
    let legacyKb: LegacyKbStore | undefined;
    ctx.inject(['vector'], (linked) => {
      lanceEngine.setVector(linked.vector);
      const lanceBase = resolveVfsLanceBase(vfsDb.path);
      lanceLifecycle.set(new VfsLanceStore(vfsDb, {
        basePath: lanceBase,
        adapter: lanceEngine,
        ensureBaseDir: () => filesService().mkdir(lanceBase, { recursive: true }),
        logger,
      }));
      vectorLinked = true;
      return () => {
        lanceEngine.setVector(undefined);
        lanceLifecycle.set(new VfsLanceDisabled());
        vectorLinked = false;
        legacyKb = undefined;
      };
    });
    // Rust builds `LanceVectorStore::new` (base RAG schema in mistakes.db) only at its
    // call sites and in the 6 s delayed startup task, never on link or in chat.
    const getLegacyKb = (): LegacyKbStore | undefined => {
      if (!vectorLinked) return undefined;
      legacyKb ??= LegacyKbStore.create(ctx.storage.database('mistakes'), lanceEngine, filesService,
        logger, optionalService<SettingsWithConn>(ctx, 'settings'));
      return legacyKb;
    };
    const retrieval = createRetrievalService(ctx, storage, indexLance);
    // Table-owner unit sync/maintenance handed over by L13b. The L11 repositories
    // are resolved lazily so plugin load order does not matter.
    const unitIndex = new VfsUnitIndexService({
      database: vfsDb,
      repositories: () => {
        const repos = optionalService<VfsReposService>(ctx, 'vfsRepo');
        if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
        return repos;
      },
      blobsDir: path.join(storage.locations.activeDir, 'vfs_blobs'),
      pdfium: () => optionalService<NativePdfium>(ctx, 'nativePdfium'),
      readBytes: file => ctx.files.readBytes(file),
      logger,
    });
    ctx.provide('vfsUnitBuilder', unitIndex);
    ctx.provide('vfsIndexMaintenance', unitIndex);
    const indexing = createIndexingServices(ctx, storage, indexLance, retrieval, unitIndex, lanceEnabled);
    // The PDF/image stage runtime is L12's own pipeline over F7 `nativePdfium`
    // and L02 OCR; `pdf@1` is not a `PdfStageRuntime` provider.
    const pdf = new PdfProcessingService({
      db: vfsDb,
      events: ctx.backendEvents,
      appDataDir: storage.locations.activeDir,
      logger,
    });
    beforeUnbind.push(() => pdf.dispose());
    ctx.effect(() => () => pdf.dispose());
    pdf.setRuntime(createPdfRuntime(ctx, storage, () => indexing.indexing));
    ctx.provide('retrieval', retrieval);
    ctx.provide('retrievalCancellable', {
      search: (request, signal) => untilAborted(() => retrieval.search(request), signal),
      searchMultimodal: (request, signal) => untilAborted(() => retrieval.searchMultimodal(request), signal),
    } satisfies CancellableRetrievalService);
    const vfsIndexService: VfsIndexService = {
      lance: indexLance,
      pdf,
      indexing: indexing.indexing,
      search: indexing.search,
      fullSearch: indexing.fullSearch,
      multimodal: indexing.multimodal,
      getStatusSummary: () => unitIndex.getStatusSummary(),
    };
    // Optional legacy KB view follows the same vector lifecycle.
    Object.defineProperty(vfsIndexService, 'legacyKb', {
      enumerable: true,
      get: getLegacyKb,
    });
    ctx.provide('vfsIndex', vfsIndexService);

    ctx.commands.register('optimize_lance_database', optimizeLanceDatabase);

    const worker = new VfsIndexWorker({
      getConfig: () => getIndexingConfig(vfsDb),
      lanceEnabled,
      startupMaintenance: () => {
        const probe = (storage as { startupMaintenance?: () => unknown }).startupMaintenance;
        return typeof probe === 'function' && probe.call(storage) !== null;
      },
      textEmbeddingConfigured: async () => {
        const models = optionalService<LlmEmbeddingModels>(ctx, 'llmEmbeddingModels');
        if (models === undefined) return false;
        try { await models.getEmbeddingModelConfig(); return true; }
        catch { return false; }
      },
      reviveConfigBlocked: () => reviveConfigBlocked(vfsDb),
      processTextBatch: (batchSize) => indexing.indexing.processPendingBatch(batchSize),
      prepareUnitsWithoutEmbedding: (limit) => indexing.indexing.prepareUnitsWithoutEmbedding(limit),
      drainLanceOrphanQueue: (limit) => indexing.indexing.drainLanceOrphanQueue(limit),
      multimodalConfigured: () => indexing.multimodal.isConfigured(),
      processMultimodalBatch: (batchSize) => indexing.multimodal.processPendingBatch(batchSize),
      maybeOptimizeAll: () => indexLance.maybeOptimizeAll(),
      logger,
      ...(config?.indexWorker?.sleep === undefined ? {} : { sleep: config.indexWorker.sleep }),
    });
    const workerEnabled = config?.indexWorker?.enabled !== false;
    beforeUnbind.push(() => worker.stop());
    ctx.effect(() => () => worker.stop());
    try {
      const unregister = storage.registerMaintenanceParticipant('vfs-index.worker', {
        databases: ['vfs', 'mistakes'],
        enterMaintenance: (deadline = Date.now() + 30_000) => worker.pause(deadline),
        exitMaintenance: () => worker.resume(),
      });
      ctx.effect(() => unregister);
    } catch (error) {
      logger.warn(`index worker maintenance participant not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
    const startWorkerAfterReady = (): void => {
      if (!workerEnabled || disposed) return;
      let gate: Partial<StartupGateReader> | undefined;
      try { gate = ctx.get('startupGate' as never) as Partial<StartupGateReader> | undefined; }
      catch { gate = undefined; }
      if (typeof gate?.waitStartupReady !== 'function') { worker.start(); return; }
      // Rust starts the worker during setup and waits for nothing (lib.rs:3535). Waiting for the gate only
      // keeps the first batch off the startup path; a gate that never opens must not leave indexing off.
      void gate.waitStartupReady(STARTUP_READY_TIMEOUT_MS).then((ready) => {
        if (!ready && !disposed) {
          logger.warn('[VfsIndexWorker] startup gate was not marked ready within 120 s; starting the worker anyway');
        }
      }, (error: unknown) => {
        logger.warn(`[VfsIndexWorker] failed while waiting for startup gate: ${error instanceof Error ? error.message : String(error)}; starting the worker anyway`);
      }).then(() => {
        if (!disposed) worker.start();
      });
    };

    // Rust spawns this work in the background during setup; it never gates ready.
    let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
    let maintenance: Promise<void> | undefined;
    let disposed = false;
    ctx.effect(() => async () => {
      disposed = true;
      if (maintenanceTimer !== undefined) clearTimeout(maintenanceTimer);
      maintenanceTimer = undefined;
      await maintenance;
    });
    const startStartupMaintenance = (): void => {
      if (lanceEnabled()) requeuePagedPdfsAtWorkerStart(vfsDb, logger);
      startWorkerAfterReady();
      maintenanceTimer = setTimeout(() => {
        maintenanceTimer = undefined;
        if (disposed) return;
        const run = () => runStartupLanceMaintenance({
          db: ctx.storage.database('mistakes'),
          engine: lanceEngine,
          files: filesService(),
          lanceEnabled,
          logger,
          settings: optionalService<SettingsWithConn>(ctx, 'settings'),
        });
        const background = optionalService<BackgroundTasks>(ctx, 'backgroundTasks');
        const task = background === undefined ? run() : background.spawn(run);
        maintenance = task?.catch((error: unknown) => {
          logger.warn(`[Lance优化] startup maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, STARTUP_LANCE_MAINTENANCE_DELAY_MS);
      maintenanceTimer.unref?.();
    };
    // Maintenance is only needed once per startup: a reinstall after the finalizers ran skips it, so that
    // instance's worker stays off until the next start. Unloading withdraws a registration that has not run.
    const finalizer = new AbortController();
    const once: StartupFinalizerRegistration = { late: 'skip', signal: finalizer.signal };
    try {
      ctx.storage.registerFinalizer('vfs-index.startup-maintenance', startStartupMaintenance, once);
      ctx.effect(() => () => finalizer.abort());
    } catch (error) {
      logger.warn(`startup maintenance finalizer not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
    registerVfsIndexStartupRecovery(ctx, { pdf, indexing: indexing.indexing, logger, beforeUnbind });
  },
});
