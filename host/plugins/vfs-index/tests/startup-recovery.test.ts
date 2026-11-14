/**
 * V04-03 / V04-04：`lib.rs:3606-3644` 在 build_app_state 里同步执行，顺序为
 * `backfill_missing_previews`（查询同步、渲染后台）→ `recover_stuck_tasks` → `spawn(resume_recovered_tasks)`
 * → `VfsFullIndexingService::recover_stuck_indexing`，每步失败只记 warn；续跑不阻塞启动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import storagePlugin from '../../../platform/storage/index.ts';
import secretsPlugin from '../../../platform/secrets/index.ts';
import settingsPlugin from '../../../platform/settings/index.ts';
// boundary-allow cross-plugin-impl: real L11 owner performs the recovery UPDATEs
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import type { PdfProcessingService } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  VFS_INDEX_STARTUP_RECOVERY_FINALIZER, registerVfsIndexStartupRecovery, resumeRecoveredTasksScoped,
  runVfsIndexStartupRecovery,
} from '../src/startup-recovery.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function host(provide: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-startup-recovery-'));
  const instance = await createTestHost({
    app: { dataDir: root },
    plugins: [secretsPlugin, [storagePlugin, { dataLocalDir: root }], settingsPlugin, reposPlugin,
      [plugin, { indexWorker: { enabled: false } }]],
    provide: {
      paths: { ...pathsServiceDouble(), appDataDir: root,
        os: { home: root, data: root, dataLocal: root, config: root, temp: root } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() { throw new Error('clean test root has no purge marker'); } },
      ...provide,
    },
  });
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; await instance.dispose(); } };
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanup.push(dispose);
  const vfs = instance.ctx.storage.database('vfs');
  const pdf = (instance.ctx.vfsIndex as { pdf: PdfProcessingService }).pdf;
  return { instance, vfs, pdf, dispose };
}

function seedFile(vfs: SqlExecutor, id: string, mime: string, name: string, status: string | null) {
  vfs.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
           VALUES (?1, ?2, 'file', 'external', NULL, 1, 1)`, [`res_${id}`, `h_${id}`]);
  vfs.run(`INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
             status, created_at, updated_at, processing_status)
           VALUES (?1, ?2, NULL, ?3, ?4, 12, 'file', ?5, 'active', 1, 1, ?6)`,
  [id, `res_${id}`, `sha_${id}`, name, mime, status]);
}

function recordingLog() {
  const lines: string[] = [];
  return { lines, log: {
    info: (message: string) => { lines.push(`info ${message}`); },
    warn: (message: string) => { lines.push(`warn ${message}`); },
  } };
}

/** Every intermediate stage in `recover_stuck_tasks` (pdf_processing_service.rs:3043-3047). */
const STUCK_SEEDS: ReadonlyArray<readonly [id: string, mime: string, name: string, status: string]> = [
  ['file_text', 'application/pdf', 'text.pdf', 'text_extraction'],
  ['file_render', 'application/pdf', 'render.pdf', 'page_rendering'],
  ['file_page_zip', 'application/pdf', 'pages.pdf', 'page_compression'],
  ['file_img_zip', 'application/pdf', 'images.pdf', 'image_compression'],
  ['file_ocr', 'application/pdf', 'book.pdf', 'ocr_processing'],
  ['file_vector', 'application/pdf', 'vector.pdf', 'vector_indexing'],
  ['file_queued', 'audio/mpeg', 'queued.mp3', 'queued'],
  ['file_decode', 'audio/wav', 'decode.wav', 'decode'],
  ['file_vad', 'audio/mpeg', 'vad.mp3', 'vad'],
  ['file_asr', 'audio/mpeg', 'talk.mp3', 'asr'],
  ['file_indexing', 'audio/wav', 'indexing.wav', 'indexing'],
];
/** Stable states the Rust query leaves alone. */
const STABLE_SEEDS: ReadonlyArray<readonly [id: string, mime: string, name: string, status: string | null]> = [
  ['file_done', 'application/pdf', 'done.pdf', 'completed'],
  ['file_error', 'application/pdf', 'bad.pdf', 'error'],
  ['file_pending', 'audio/mpeg', 'pending.mp3', 'pending'],
  ['file_issues', 'application/pdf', 'issues.pdf', 'completed_with_issues'],
  ['file_cancelled', 'audio/wav', 'cancelled.wav', 'cancelled'],
  ['file_null', 'application/pdf', 'never.pdf', null],
];

describe('V04-03/04 vfs-index startup recovery (lib.rs:3606-3644)', () => {
  it('resets stuck media files and stuck indexing rows before ready, then resumes the recovered files', async () => {
    const fixture = await host();
    const { vfs, pdf } = fixture;
    for (const [id, mime, name, status] of [...STUCK_SEEDS, ...STABLE_SEEDS]) seedFile(vfs, id, mime, name, status);
    vfs.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at,
               index_state, index_error, index_retry_count, index_next_retry_at,
               mm_index_state, mm_index_error, mm_index_retry_count, mm_index_next_retry_at)
             VALUES ('res_stuck', 'h_stuck', 'note', 'inline', 'x', 1, 1,
               'indexing', NULL, 3, 999, 'indexing', NULL, 2, 888)`);
    vfs.run(`INSERT INTO vfs_index_units
               (id, resource_id, unit_index, text_content, text_required, text_state,
                mm_required, mm_state, created_at, updated_at)
             VALUES ('unit_stuck', 'res_stuck', 0, 'x', 1, 'indexing', 1, 'indexing', 0, 0)`);
    const backfill = vi.spyOn(pdf, 'backfillMissingPreviews');
    const started: Array<[string, unknown]> = [];
    vi.spyOn(pdf, 'startPipeline').mockImplementation(async (fileId, stage) => { started.push([fileId, stage]); });

    expect(fixture.instance.ctx.storage.finalizerNames()).toContain(VFS_INDEX_STARTUP_RECOVERY_FINALIZER);
    await fixture.instance.ctx.storage.runStartupFinalizers();

    expect(backfill).toHaveBeenCalledTimes(1);
    const files = vfs.all<{ id: string; processing_status: string | null; processing_error: string | null }>(
      'SELECT id, processing_status, processing_error FROM files ORDER BY id');
    expect(files).toEqual([
      ...STUCK_SEEDS.map(([id]) => (
        { id, processing_status: 'pending', processing_error: 'recovered: interrupted by app restart' })),
      ...STABLE_SEEDS.map(([id, , , status]) => ({ id, processing_status: status, processing_error: null })),
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(vfs.get(`SELECT index_state, index_error, index_retry_count, index_next_retry_at,
                      mm_index_state, mm_index_error, mm_index_retry_count, mm_index_next_retry_at
                    FROM resources WHERE id = 'res_stuck'`)).toEqual({
      index_state: 'pending', index_error: 'recovered: interrupted by crash', index_retry_count: 0, index_next_retry_at: 0,
      mm_index_state: 'pending', mm_index_error: 'recovered: interrupted by crash', mm_index_retry_count: 0,
      mm_index_next_retry_at: 0,
    });
    expect(vfs.get("SELECT text_state, text_error, mm_state, mm_error FROM vfs_index_units WHERE id = 'unit_stuck'"))
      .toEqual({ text_state: 'pending', text_error: 'recovered: interrupted by crash',
        mm_state: 'pending', mm_error: 'recovered: interrupted by crash' });

    // No startup gate in this host: the resume runs right after the finalizer, in recovery order.
    await vi.waitFor(() => { expect(started).toHaveLength(STUCK_SEEDS.length); });
    expect(started.map(([fileId]) => fileId).sort()).toEqual(STUCK_SEEDS.map(([id]) => id).sort());
    expect(started.every(([, stage]) => stage === null)).toBe(true);
  }, 60_000);

  it('does not resume recovered files until the startup gate is marked ready', async () => {
    let markReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
    const fixture = await host({ startupGate: { waitStartupReady: () => ready } });
    seedFile(fixture.vfs, 'file_ocr', 'application/pdf', 'book.pdf', 'vector_indexing');
    const start = vi.spyOn(fixture.pdf, 'startPipeline').mockResolvedValue(undefined);

    await fixture.instance.ctx.storage.runStartupFinalizers();
    expect(fixture.vfs.pluck("SELECT processing_status FROM files WHERE id = 'file_ocr'")).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();

    markReady(true);
    await vi.waitFor(() => { expect(start).toHaveBeenCalledWith('file_ocr', null); });
  }, 60_000);

  it.each([
    ['times out', async () => false,
      '[AppSetup] startup gate was not marked ready within 120 s; resuming recovered media tasks anyway'],
    ['rejects', async () => { throw new Error('gate torn down'); },
      '[AppSetup] failed while waiting for startup gate: gate torn down; resuming recovered media tasks anyway'],
  ])('resumes the recovered files even when the startup gate %s (Rust spawns the resume unconditionally)',
    async (_case, waitStartupReady, warning) => {
      const fixture = await host({ startupGate: { waitStartupReady } });
      const warnings: unknown[] = [];
      fixture.instance.ctx.logger.exporter({
        levels: { default: 2 },
        export(message) { if (message.type === 'warn') warnings.push(message.args[0]); },
      });
      seedFile(fixture.vfs, 'file_decode', 'audio/wav', 'decode.wav', 'decode');
      const start = vi.spyOn(fixture.pdf, 'startPipeline').mockResolvedValue(undefined);

      await fixture.instance.ctx.storage.runStartupFinalizers();
      expect(fixture.vfs.pluck("SELECT processing_status FROM files WHERE id = 'file_decode'")).toBe('pending');
      await vi.waitFor(() => { expect(start).toHaveBeenCalledWith('file_decode', null); });
      expect(warnings).toContain(warning);
    }, 60_000);

  it('waits for a free slot (2 concurrent) and stops at dispose without starting more pipelines', async () => {
    const fixture = await host();
    seedFile(fixture.vfs, 'file_ocr', 'application/pdf', 'book.pdf', 'page_rendering');
    vi.spyOn(fixture.pdf, 'runningCount').mockReturnValue(2);
    const start = vi.spyOn(fixture.pdf, 'startPipeline').mockResolvedValue(undefined);

    await fixture.instance.ctx.storage.runStartupFinalizers();
    expect(fixture.vfs.pluck("SELECT processing_status FROM files WHERE id = 'file_ocr'")).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();

    const before = Date.now();
    await fixture.dispose();
    // Dispose wakes the 2 s slot wait instead of letting it run out.
    expect(Date.now() - before).toBeLessThan(1_500);
    expect(start).not.toHaveBeenCalled();
  }, 60_000);

  it('a slot freed by the unload itself does not start another resumed pipeline', async () => {
    const fixture = await host();
    seedFile(fixture.vfs, 'file_ocr', 'application/pdf', 'book.pdf', 'page_rendering');
    let busy = 2;
    vi.spyOn(fixture.pdf, 'runningCount').mockImplementation(() => busy);
    // The plugin's unload calls the service class's dispose(), which the public API type does not expose.
    const service = fixture.pdf as PdfProcessingService & { dispose(): Promise<void> };
    const disposePdf = service.dispose.bind(service);
    // pdf.dispose() empties `running`, so the waiting loop wakes up to a free slot.
    vi.spyOn(service, 'dispose').mockImplementation(async () => { busy = 0; await disposePdf(); });
    const start = vi.spyOn(fixture.pdf, 'startPipeline').mockResolvedValue(undefined);

    await fixture.instance.ctx.storage.runStartupFinalizers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();

    await fixture.dispose();
    expect(busy).toBe(0);
    expect(start).not.toHaveBeenCalled();
  }, 60_000);

  it('AL-11 F3: an aborted background-task signal ends the slot wait without starting more pipelines', async () => {
    const shutdown = new AbortController();
    let resume: Promise<unknown> | undefined;
    const fixture = await host({
      backgroundTasks: {
        size: 0,
        spawn: (task: (signal: AbortSignal) => Promise<unknown>) => (resume = task(shutdown.signal)),
        shutdown: async () => undefined,
      },
    });
    seedFile(fixture.vfs, 'file_ocr', 'application/pdf', 'book.pdf', 'page_rendering');
    let busy = 2;
    vi.spyOn(fixture.pdf, 'runningCount').mockImplementation(() => busy);
    const start = vi.spyOn(fixture.pdf, 'startPipeline').mockResolvedValue(undefined);

    await fixture.instance.ctx.storage.runStartupFinalizers();
    expect(resume).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();

    const before = Date.now();
    shutdown.abort();
    busy = 0;
    await resume;
    // The abort wakes the 2 s slot wait instead of letting it run out.
    expect(Date.now() - before).toBeLessThan(1_500);
    expect(start).not.toHaveBeenCalled();
  }, 60_000);

  describe('AL-15 reinstall around the startup finalizers', () => {
    type Instance = Awaited<ReturnType<typeof host>>['instance'];
    const finalizerWarnings = (instance: Instance): unknown[] => {
      const warnings: unknown[] = [];
      instance.ctx.logger.exporter({
        levels: { default: 2 },
        export(message) {
          if (message.type === 'warn' && String(message.args[0]).includes('finalizer not registered')) {
            warnings.push(message.args[0]);
          }
        },
      });
      return warnings;
    };
    const trackedSleep = () => {
      let calls = 0;
      return {
        calls: () => calls,
        sleep: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
          calls += 1;
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      };
    };

    it('an unload before startup withdraws both registrations; only the reinstalled instance runs them', async () => {
      const fixture = await host();
      const warnings = finalizerWarnings(fixture.instance);
      seedFile(fixture.vfs, 'file_ocr', 'application/pdf', 'book.pdf', 'page_rendering');
      await fixture.instance.unload('dstu.vfs-index');
      const worker = trackedSleep();
      await fixture.instance.install([plugin, { indexWorker: { sleep: worker.sleep } }]);
      const pdf = (fixture.instance.ctx.vfsIndex as { pdf: PdfProcessingService }).pdf;
      expect(pdf).not.toBe(fixture.pdf);
      const start = vi.spyOn(pdf, 'startPipeline').mockResolvedValue(undefined);

      await fixture.instance.ctx.storage.runStartupFinalizers();
      await vi.waitFor(() => { expect(start).toHaveBeenCalledWith('file_ocr', null); });
      // The reinstalled instance's maintenance finalizer started its index worker.
      await vi.waitFor(() => { expect(worker.calls()).toBeGreaterThan(0); });
      expect(warnings).toEqual([]);
    }, 60_000);

    it('a reinstall after startup skips both finalizers without a warning or a second recovery', async () => {
      const fixture = await host();
      const warnings = finalizerWarnings(fixture.instance);
      await fixture.instance.ctx.storage.runStartupFinalizers();
      await fixture.instance.unload('dstu.vfs-index');
      seedFile(fixture.vfs, 'file_ocr', 'application/pdf', 'book.pdf', 'page_rendering');

      await fixture.instance.install([plugin, { indexWorker: { enabled: false } }]);
      expect(fixture.vfs.pluck("SELECT processing_status FROM files WHERE id = 'file_ocr'")).toBe('page_rendering');
      expect(warnings).toEqual([]);
    }, 60_000);
  });

  it('a storage without the finalizer API leaves plugin apply intact and only warns', () => {
    const { lines, log } = recordingLog();
    const effects: unknown[] = [];
    const ctx = { storage: {}, effect: (fn: unknown) => { effects.push(fn); } };
    expect(() => registerVfsIndexStartupRecovery(ctx as never, {
      pdf: {} as PdfProcessingService, indexing: { recoverStuckIndexing: () => 0 }, logger: log,
    })).not.toThrow();
    expect(lines).toEqual([expect.stringContaining('warn startup recovery finalizer not registered:')]);
    expect(effects).toEqual([]);
  });

  it('each step only warns on failure and the remaining steps still run (lib.rs:3611-3643)', () => {
    const { lines, log } = recordingLog();
    const calls: string[] = [];
    const spawned: string[][] = [];
    runVfsIndexStartupRecovery({
      pdf: {
        backfillMissingPreviews: () => { calls.push('backfill'); throw new Error('PDF preview backfill requires F7 pdfium'); },
        recoverStuckTasks: () => { calls.push('recover'); throw new Error('database is locked'); },
      },
      indexing: { recoverStuckIndexing: () => { calls.push('indexing'); throw new Error('L11 owner missing'); } },
      logger: log,
      spawnResume: (fileIds) => { spawned.push(fileIds); },
    });
    expect(calls).toEqual(['backfill', 'recover', 'indexing']);
    expect(spawned).toEqual([]);
    expect(lines).toEqual([
      'warn [AppSetup] Failed to schedule PDF preview backfill: PDF preview backfill requires F7 pdfium',
      'warn [AppSetup] Failed to recover stuck tasks: database is locked',
      'warn [AppSetup] Failed to recover stuck indexing records: L11 owner missing',
    ]);

    lines.length = 0;
    runVfsIndexStartupRecovery({
      pdf: { backfillMissingPreviews: () => 0, recoverStuckTasks: () => ['a', 'b'] },
      indexing: { recoverStuckIndexing: () => 3 },
      logger: log,
      spawnResume: (fileIds) => { spawned.push(fileIds); },
    });
    expect(spawned).toEqual([['a', 'b']]);
    expect(lines).toEqual([
      'info [AppSetup] Recovered 2 stuck media processing tasks, scheduling auto-resume',
      'info [AppSetup] Recovered 3 stuck indexing records',
    ]);
  });

  it('resume skips files a user already restarted and keeps going after a failed start (pdf_processing_service.rs:3101-3138)', async () => {
    const { lines, log } = recordingLog();
    const started: string[] = [];
    let busy = 2;
    const sleeps: number[] = [];
    const pdf = {
      runningCount: () => busy,
      isRunning: (id: string) => id === 'b',
      startPipeline: async (id: string, stage?: unknown) => {
        expect(stage).toBeNull();
        started.push(id);
        if (id === 'a') throw new Error('File not found: a');
      },
    };
    await resumeRecoveredTasksScoped(pdf, ['a', 'b', 'c'], {
      stopped: () => false,
      sleep: async (ms) => { sleeps.push(ms); busy = 0; },
    }, log);
    expect(sleeps).toEqual([2_000]);
    expect(started).toEqual(['a', 'c']);
    expect(lines).toEqual([
      'info [MediaProcessingService] Auto-resuming 3 recovered tasks',
      'warn [MediaProcessingService] Failed to auto-resume file a: File not found: a',
      'info [MediaProcessingService] Auto-resumed pipeline for recovered file: c',
    ]);
  });
});
