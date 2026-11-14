import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { audio } from '../../../platform/native/audio/index.ts';
// boundary-allow cross-plugin-impl: integration installs the actual L18 transcriber provider
import mediaPlugin from '../../media/index.ts';
// boundary-allow cross-plugin-impl: integration installs L13's actual database provider
import vfsPlugin from '../../vfs/index.ts';
// boundary-allow cross-plugin-impl: integration installs L11's actual persistence repositories
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: L13 dstu.vfs injects L10's notes service
import notesPlugin from '../../notes/index.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

it('R12-01 L12 scheduler invokes the real L18 imported-subtitle pipeline and L11 persistence', async () => {
  const root = fs.mkdtempSync('/tmp/opencode/vfs-media-provider-');
  const storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
  try {
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(report.error ?? 'migration failed');
    host = await createTestHost({
      plugins: [reposPlugin, notesPlugin, vfsPlugin, plugin, mediaPlugin],
      provide: {
        storage, nativeAudio: audio,
        paths: { ...pathsServiceDouble(), appDataDir: root },
        // No configuration is consumed by the imported-subtitle path; the L18
        // plugin also registers unrelated settings-backed media commands.
        settings: { get: () => null },
      },
    });
    const db = storage.database('vfs');
    const repos = host.ctx.vfsRepo;
    const file = repos.files.createFileWithDocDataInFolder(
      db, 'sha_imported_audio', 'lecture.wav', 1, 'audio', 'audio/wav',
      null, null, null, null, null, null,
    );
    repos.mediaTranscripts.setImportedSegments(db, file.id, [
      [{ startMs: 0, endMs: 1000 }, '导入字幕'],
      [{ startMs: 1000, endMs: 2000 }, '第二段'],
    ]);
    const finished = new Promise<unknown>((resolve, reject) => {
      host!.ctx.backendEvents.listen('media-processing-completed', resolve);
      host!.ctx.backendEvents.listen('media-processing-error', reject);
    });
    await host.ctx.vfsIndex.pdf.startPipeline(file.id);
    expect(await finished).toMatchObject({
      fileId: file.id, stage: 'completed', mediaType: 'audio',
      readyModes: ['text'], completedSegments: 2, totalSegments: 2,
    });
    expect(db.pluck('SELECT extracted_text FROM files WHERE id = ?1', [file.id]))
      .toBe('[00:00] 导入字幕\n[00:01] 第二段');
    expect(repos.mediaTranscripts.counts(db, file.id)).toMatchObject({ done: 2, total: 2, failed: 0 });
    expect(host.ctx.vfsIndex.pdf.isRunning(file.id)).toBe(false);
    expect(host.eventsNamed('pdf-processing-completed')).toEqual([]);
    const stages = host.eventsNamed('media-processing-progress').map((value) =>
      (value as { status: { stage: string } }).status.stage);
    expect(stages).toEqual(['queued', 'indexing']);
    // V03-03: `MediaTranscriptionProgressEvent` field order with the top-level `stage` (pdf_processing_service.rs:387-398).
    const progressEvents = host.eventsNamed('media-processing-progress') as Array<Record<string, unknown> & { status: { stage: string } }>;
    expect(progressEvents.map((event) => event['stage'])).toEqual(['queued', 'indexing']);
    for (const event of progressEvents) expect(event['stage']).toBe(event.status.stage);
    expect(Object.keys(progressEvents[1]!)).toEqual(['fileId', 'status', 'mediaType', 'stage', 'completedSegments', 'totalSegments']);
    // Scheduler/transcriber/persistence are real. Native Lance indexing and
    // citation enrichment have separate media-index-write/media-retrieval cases.
  } finally {
    await host?.dispose();
    storage.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
