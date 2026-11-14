import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { PdfProcessingService, type PdfStageRuntime } from '../src/pdf-service.ts';
import { bindRealOwner } from './support/real-owner.ts';
import { unbindVfsTableOwners } from '../repository/owners.ts';

interface Harness {
  db: DatabaseHandle;
  base: string;
  storage: ReturnType<typeof createStorageService>;
}

const harnesses: Harness[] = [];
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-pdf-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

function freshDb(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-pdf-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const harness = { db: storage.database('vfs'), base, storage };
  bindRealOwner(harness.db);
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.storage.dispose();
    fs.rmSync(harness.base, { recursive: true, force: true });
  }
});

function insertFile(db: DatabaseHandle, id: string, mime: string, name: string): void {
  db.run(
    `INSERT INTO files (id, sha256, file_name, size, created_at, updated_at, mime_type, processing_status)
     VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5, 'pending')`,
    [id, `sha-${id}`, name, new Date().toISOString(), mime],
  );
}

function events() {
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  return {
    emitted,
    sink: { emit(channel: string, payload: unknown) { emitted.push({ channel, payload }); } },
  };
}

function runtime(overrides: Partial<PdfStageRuntime> = {}): PdfStageRuntime {
  return {
    async run(fileId, startStage, signal, callbacks) {
      callbacks.progress(startStage, { stage: startStage, percent: 40, readyModes: [] });
      if (signal.aborted) throw new Error('cancelled');
      return { readyModes: ['text', 'image'] };
    },
    mediaTempDir: () => path.join(os.tmpdir(), 'media'),
    backfillMissingPreviews: () => 0,
    ...overrides,
  };
}

describe('Rust vfs/pdf_processing_service.rs service state', () => {
  it('detects_media_types_from_mime_and_extension', () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    insertFile(db, 'file_img', 'image/png', 'page.png');
    insertFile(db, 'file_bin', 'application/octet-stream', 'mystery.bin');
    const service = new PdfProcessingService({
      db, events: events().sink, appDataDir: base, runtime: runtime(),
    });
    expect(service.detectMediaType('file_pdf')).toBe('pdf');
    expect(service.detectMediaType('file_img')).toBe('image');
    expect(() => service.detectMediaType('file_bin')).toThrow(/Unsupported media type/);
    expect(() => service.detectMediaType('missing')).toThrow(/Failed to get media metadata/);
  });

  it('start_pipeline_emits_progress_and_completed_events', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    const sink = events();
    const service = new PdfProcessingService({
      db, events: sink.sink, appDataDir: base, runtime: runtime(),
    });
    await service.startPipeline('file_pdf');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(sink.emitted.some((entry) => entry.channel === 'pdf-processing-progress')).toBe(true);
    expect(sink.emitted.some((entry) => entry.channel === 'pdf-processing-completed')).toBe(true);
    expect(sink.emitted.some((entry) => entry.channel === 'media-processing-completed')).toBe(true);
    expect(service.getStatus('file_pdf')?.stage).toBe('completed');
    expect(service.getStatus('file_pdf')?.progress.readyModes).toEqual(['text', 'image']);
    expect(service.isRunning('file_pdf')).toBe(false);
  });

  it('start_pipeline_without_native_runtime_reports_an_error_event', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    const sink = events();
    const service = new PdfProcessingService({ db, events: sink.sink, appDataDir: base });
    await service.startPipeline('file_pdf');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(sink.emitted.some((entry) => entry.channel === 'pdf-processing-error')).toBe(true);
    expect(service.getStatus('file_pdf')?.stage).toBe('error');
    expect(service.getStatus('file_pdf')?.error).toContain('F7 pdfium');
  });

  it('cancel_media_marks_queued_statuses_cancelled', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    const service = new PdfProcessingService({
      db, events: events().sink, appDataDir: base,
      runtime: runtime({ async run() { return new Promise(() => undefined); } }),
    });
    db.run("UPDATE files SET processing_status = 'queued' WHERE id = 'file_pdf'");
    expect(service.cancelMedia('file_pdf')).toBe(false);
    expect(service.getStatus('file_pdf')?.stage).toBe('cancelled');

    db.run("UPDATE files SET processing_status = 'pending' WHERE id = 'file_pdf'");
    await service.startPipeline('file_pdf');
    expect(service.isRunning('file_pdf')).toBe(true);
    expect(service.cancel('file_pdf')).toBe(true);
    expect(service.isRunning('file_pdf')).toBe(false);
  });

  it('start_pipeline_emits_pdf_compat_events_only_for_pdf_sources', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_img', 'image/png', 'page.png');
    const sink = events();
    const service = new PdfProcessingService({
      db, events: sink.sink, appDataDir: base, runtime: runtime(),
    });
    await service.startPipeline('file_img');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const channels = sink.emitted.map((entry) => entry.channel);
    expect(channels).toContain('media-processing-progress');
    expect(channels).toContain('media-processing-completed');
    expect(channels).not.toContain('pdf-processing-progress');
    expect(channels).not.toContain('pdf-processing-completed');
    const progress = sink.emitted.find((entry) => entry.channel === 'media-processing-progress');
    expect((progress!.payload as { status: { mediaType: string } }).status.mediaType).toBe('image');
  });

  it('completed_with_issues_keeps_the_rust_stage_and_issue_summary', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    const sink = events();
    const service = new PdfProcessingService({
      db, events: sink.sink, appDataDir: base,
      runtime: runtime({
        async run() {
          return {
            readyModes: ['text'],
            completedWithIssues: true,
            failedStages: [{ stage: 'ocr_processing', message: 'scan skipped', retriable: false }],
          };
        },
      }),
    });
    await service.startPipeline('file_pdf');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const status = service.getStatus('file_pdf');
    expect(status?.stage).toBe('completed_with_issues');
    expect(status?.error).toContain('scan skipped');
    const completed = sink.emitted.find((entry) => entry.channel === 'media-processing-completed');
    expect((completed!.payload as { stage: string }).stage).toBe('completed_with_issues');
  });

  it('get_status_omits_absent_options_and_parses_serde_aliases', () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    const service = new PdfProcessingService({ db, events: events().sink, appDataDir: base });
    expect(service.getStatus('file_pdf')).toEqual({
      fileId: 'file_pdf',
      stage: 'pending',
      progress: { stage: 'pending', percent: 0, readyModes: [] },
    });

    db.run(
      `UPDATE files
       SET processing_status = 'completed_with_issues',
           processing_progress = ?1,
           processing_started_at = 123
       WHERE id = 'file_pdf'`,
      [JSON.stringify({
        stage: 'completed_with_issues',
        current_page: 2,
        total_pages: 9,
        percent: 33.333333333333336,
        ready_modes: ['text'],
        media_type: 'pdf',
        failed_stages: [{ stage: 'ocr_processing', message: 'scan skipped', retriable: true }],
      })],
    );
    const status = service.getStatus('file_pdf')!;
    expect(status.startedAt).toBe(123);
    expect(status).not.toHaveProperty('completedAt');
    expect(status).not.toHaveProperty('error');
    expect(status.progress).toEqual({
      stage: 'completed_with_issues',
      currentPage: 2,
      totalPages: 9,
      percent: 33.333332,
      readyModes: ['text'],
      mediaType: 'pdf',
      failedStages: [{ stage: 'ocr_processing', message: 'scan skipped', retriable: true }],
    });
  });

  it('get_status_falls_back_to_default_progress_for_invalid_serde_values', () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    const service = new PdfProcessingService({ db, events: events().sink, appDataDir: base });
    for (const progress of ['null', '{}', '{"stage":"ocr_processing"}', '{"percent":50}',
      '{"stage":"ocr_processing","percent":50,"readyModes":"text"}', 'not json']) {
      db.run("UPDATE files SET processing_progress = ?1 WHERE id = 'file_pdf'", [progress]);
      expect(service.getStatus('file_pdf')!.progress).toEqual({
        stage: 'pending',
        percent: 0,
        readyModes: [],
      });
    }
  });

  it('retry_warns_and_leaves_non_retriable_stages_untouched', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    db.run("UPDATE files SET processing_status = 'ocr_processing' WHERE id = 'file_pdf'");
    const warnings: string[] = [];
    const service = new PdfProcessingService({
      db, events: events().sink, appDataDir: base,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string) => { warnings.push(message); },
        error: () => undefined,
      },
    });
    await service.retry('file_pdf');
    expect(warnings).toContain('[PdfProcessingService] Cannot retry file file_pdf in stage: ocr_processing');
    expect(service.getStatus('file_pdf')!.stage).toBe('ocr_processing');
  });

  it('recover_stuck_tasks_resets_intermediate_statuses_to_pending', () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    insertFile(db, 'file_ok', 'application/pdf', 'done.pdf');
    db.run("UPDATE files SET processing_status = 'ocr_processing' WHERE id = 'file_pdf'");
    db.run("UPDATE files SET processing_status = 'completed' WHERE id = 'file_ok'");
    const service = new PdfProcessingService({ db, events: events().sink, appDataDir: base });
    expect(service.recoverStuckTasks()).toEqual(['file_pdf']);
    expect(service.getStatus('file_pdf')?.stage).toBe('pending');
    expect(service.getStatus('file_pdf')?.error).toContain('recovered');
    expect(service.getStatus('file_ok')?.stage).toBe('completed');
  });

  it('recover_stuck_tasks keeps resetting after a failed row and logs like pdf_processing_service.rs:3058-3086', () => {
    const { db, base } = freshDb();
    for (const id of ['file_a', 'file_bad', 'file_c']) {
      insertFile(db, id, 'application/pdf', `${id}.pdf`);
      db.run("UPDATE files SET processing_status = 'ocr_processing' WHERE id = ?1", [id]);
    }
    db.exec(`CREATE TRIGGER reject_recover BEFORE UPDATE OF processing_status ON files
      WHEN OLD.id = 'file_bad' AND NEW.processing_status = 'pending' BEGIN SELECT RAISE(ABORT, 'locked'); END;`);
    const info: string[] = [];
    const service = new PdfProcessingService({ db, events: events().sink, appDataDir: base,
      logger: { debug: () => undefined, info: (message) => info.push(message), warn: () => undefined, error: () => undefined } });
    expect(service.recoverStuckTasks()).toEqual(['file_a', 'file_c']);
    expect(service.getStatus('file_bad')?.stage).toBe('ocr_processing');
    expect(service.getStatus('file_c')?.stage).toBe('pending');
    expect(info).toEqual([
      '[MediaProcessingService] Found 3 stuck tasks at startup, resetting to pending',
      '[MediaProcessingService] Reset stuck file file_a to pending',
      '[MediaProcessingService] Reset stuck file file_c to pending',
    ]);
  });

  it('recover_stuck_tasks fails as a whole without the L11 files owner (get_conn_safe()? at :3035), not row by row', () => {
    const { db, base } = freshDb();
    const info: string[] = [];
    const service = new PdfProcessingService({ db, events: events().sink, appDataDir: base,
      logger: { debug: () => undefined, info: (message) => info.push(message), warn: () => undefined, error: () => undefined } });
    unbindVfsTableOwners(db);
    // Rust resolves the connection before the stuck query, so nothing stuck still fails.
    expect(() => service.recoverStuckTasks())
      .toThrow('L11 vfsRepo.files.markProcessingRecovered 未集成（待 ds-mig/L11-vfs-repos 合入）');
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    db.run("UPDATE files SET processing_status = 'ocr_processing' WHERE id = 'file_pdf'");
    expect(() => service.recoverStuckTasks())
      .toThrow('L11 vfsRepo.files.markProcessingRecovered 未集成（待 ds-mig/L11-vfs-repos 合入）');
    expect(service.getStatus('file_pdf')?.stage).toBe('ocr_processing');
    expect(info).toEqual([]);
  });

  it('recover_stuck_tasks fails as a whole when the L11 file owner is missing (pdf_processing_service.rs:3035 get_conn_safe()?)', () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    db.run("UPDATE files SET processing_status = 'decode' WHERE id = 'file_pdf'");
    unbindVfsTableOwners(db);
    const service = new PdfProcessingService({ db, events: events().sink, appDataDir: base });
    expect(() => service.recoverStuckTasks()).toThrow('L11 vfsRepo.files.markProcessingRecovered 未集成');
    expect(service.getStatus('file_pdf')?.stage).toBe('decode');
  });

  it('dispose aborts and awaits the background preview backfill it started', async () => {
    const { db, base } = freshDb();
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const backfill = new Promise<void>((resolve) => { release = resolve; });
    const service = new PdfProcessingService({ db, events: events().sink, appDataDir: base,
      runtime: runtime({ backfillMissingPreviews: (_limit, scope) => { signal = scope!.signal; scope!.track(backfill); return 1; } }) });
    expect(service.backfillMissingPreviews()).toBe(1);
    expect(signal!.aborted).toBe(false);
    let disposed = false;
    const disposing = service.dispose().then(() => { disposed = true; });
    expect(signal!.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    release();
    await disposing;
    expect(disposed).toBe(true);
  });

  it('media_completion_event_carries_transcription_segment_counts', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_audio', 'audio/mpeg', 'clip.mp3');
    const sink = events();
    const service = new PdfProcessingService({
      db, events: sink.sink, appDataDir: base,
      runtime: runtime({
        async run() {
          return {
            readyModes: ['text'],
            completedSegments: 3,
            totalSegments: 4,
          };
        },
      }),
    });
    await service.startPipeline('file_audio');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const completed = sink.emitted.find((entry) => entry.channel === 'media-processing-completed');
    expect(completed?.payload).toMatchObject({
      fileId: 'file_audio',
      stage: 'completed',
      mediaType: 'audio',
      readyModes: ['text'],
      completedSegments: 3,
      totalSegments: 4,
    });
    expect(sink.emitted.some((entry) => entry.channel === 'pdf-processing-completed')).toBe(false);
  });

  it('retry_restarts_error_and_pending_tasks_from_the_media_specific_stage', async () => {
    const { db, base } = freshDb();
    insertFile(db, 'file_pdf', 'application/pdf', 'book.pdf');
    db.run("UPDATE files SET processing_status = 'error', processing_error = 'boom' WHERE id = 'file_pdf'");
    const stages: string[] = [];
    const service = new PdfProcessingService({
      db, events: events().sink, appDataDir: base,
      runtime: runtime({
        async run(_fileId, startStage) {
          stages.push(startStage);
          return { readyModes: [] };
        },
      }),
    });
    await service.retry('file_pdf');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stages).toEqual(['ocr_processing']);
    expect(service.getStatus('file_pdf')?.stage).toBe('completed');
  });
});
