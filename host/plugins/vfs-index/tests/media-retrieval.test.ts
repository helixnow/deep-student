import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
// boundary-allow cross-plugin-impl: real L13 media enrichment and unit construction
import vfsPlugin from '../../vfs/index.ts';
// boundary-allow cross-plugin-impl: real L11 transcript and segment owners
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: L13 requires the real notes owner
import notesPlugin from '../../notes/index.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
let unitId: string;

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-media-retrieval-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
  host = await createTestHost({ plugins: [reposPlugin, notesPlugin, vfsPlugin, plugin],
    provide: { storage, paths: pathsServiceDouble(), settings: { get: () => null } } });
  const db = storage.database('vfs');
  db.run(`INSERT INTO resources(id, hash, type, storage_mode, created_at, updated_at)
    VALUES ('res_media', 'hash_media', 'file', 'external', 0, 0)`);
  db.run(`INSERT INTO files(id, resource_id, sha256, file_name, size, type, mime_type, created_at, updated_at)
    VALUES ('file_media', 'res_media', 'sha_media', 'lecture.wav', 1, 'audio', 'audio/wav', '0', '0')`);
  host.ctx.vfsRepo.mediaTranscripts.setImportedSegments(db, 'file_media', [
    [{ startMs: 0, endMs: 20_000 }, 'introduction'],
    [{ startMs: 100_000, endMs: 120_000 }, 'quantum mechanics'],
  ]);
  const units = host.ctx.vfs.unitIndex.syncResourceUnits({ resourceId: 'res_media', resourceType: 'file' });
  expect(units).toHaveLength(2);
  unitId = units[1]!.id;
}, 180_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

async function search() {
  return host.ctx.retrieval.search({ queryText: 'quantum', queryImageBase64: null,
    queryImageMediaType: null, queryModality: 'text', topK: 10, folderIds: null,
    resourceIds: ['res_media'], resourceTypes: null });
}

it('R12-01 attach_media_time_ranges enriches the public retrieval result from real transcript windows', async () => {
  const response = await search();
  expect(response.result.failures).toEqual([]);
  expect(response.result.hits).toHaveLength(1);
  expect(response.result.hits[0]!.hit).toMatchObject({ sourceId: 'file_media',
    identity: { resourceId: 'res_media', pageIndex: 1, timeRange: { startMs: 100_000, endMs: 120_000 } } });
});

it('R12-01 attach_media_time_ranges prefers segment metadata over the transcript window', async () => {
  host.ctx.vfsRepo.embeddingSegments.create(storage.database('vfs'), { unitId, segmentIndex: 0,
    modality: 'text', embeddingDim: 128, lanceRowId: 'media_row', contentText: 'quantum mechanics',
    startPos: null, endPos: null, contentHash: null, metadataJson: '{"startMs":101000,"endMs":105000}' });
  const response = await search();
  expect(response.result.hits).toHaveLength(1);
  expect(response.result.hits[0]!.hit).toMatchObject({ sourceId: 'file_media',
    identity: { pageIndex: 1, timeRange: { startMs: 101_000, endMs: 105_000 } } });
});

it('R12-01 attach_media_time_ranges logs a real transcript read failure and preserves lexical hits', async () => {
  const logs: Array<{ type: string; args: unknown[] }> = [];
  host.ctx.logger.exporter({ levels: { default: 4 }, export: entry => { logs.push(entry); } });
  const db = storage.database('vfs');
  db.run('ALTER TABLE media_transcript_segments RENAME TO unavailable_transcript_segments');
  try {
    const response = await search();
    expect(response.result.failures).toEqual([]);
    expect(response.result.hits).toHaveLength(1);
    expect(response.result.hits[0]!.hit).toMatchObject({ sourceId: null,
      identity: { resourceId: 'res_media', pageIndex: 1, timeRange: null } });
    expect(logs.some(entry => entry.type === 'debug'
      && entry.args.map(String).join(' ').includes('[MediaIndex] time range enrichment skipped:')
      && entry.args.map(String).join(' ').includes('media_transcript_segments'))).toBe(true);
  } finally {
    db.run('ALTER TABLE unavailable_transcript_segments RENAME TO media_transcript_segments');
  }
});
