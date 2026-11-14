import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import vectorPlugin from '../../../platform/vector/index.ts';
// boundary-allow cross-plugin-impl: real L13 transcript windows and metadata serialization
import vfsPlugin from '../../vfs/index.ts';
// boundary-allow cross-plugin-impl: real L11 transcript, unit and segment writes
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: L13 requires the real notes owner
import notesPlugin from '../../notes/index.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

it('R12-01/R12-09 indexResource persists primary and additional transcript ranges with real F7 i64 rows', async () => {
  const root = fs.mkdtempSync('/tmp/opencode/vfs-media-write-');
  const storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
  try {
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(report.error ?? 'migration failed');
    const model = { id: 'media-embedding', model: 'media-model', baseUrl: 'https://example.test/v1',
      providerType: null, providerScope: null, apiProtocol: null, modelAdapter: 'openai' };
    host = await createTestHost({ plugins: [reposPlugin, notesPlugin, vfsPlugin, vectorPlugin, plugin],
      provide: { storage, files: createNodeFiles({ roots: [{ name: 'appData', path: root }] }),
        paths: pathsServiceDouble(), settings: { get: () => null },
        llmEmbeddingModels: { getEmbeddingModelConfig: async () => model },
        'embedding@1': { callEmbeddingApi: async (texts: string[]) => texts.map(() => Array<number>(64).fill(0.25)) },
      } });
    const db = storage.database('vfs');
    db.run(`INSERT INTO resources(id, hash, type, source_id, source_table, storage_mode, created_at, updated_at)
      VALUES ('res_media', 'hash_media', 'file', 'file_media', 'files', 'external', 0, 0)`);
    db.run(`INSERT INTO files(id, resource_id, sha256, file_name, size, type, mime_type, created_at, updated_at)
      VALUES ('file_media', 'res_media', 'sha_media', 'lecture.wav', 1, 'audio', 'audio/wav', '0', '0')`);
    host.ctx.vfsRepo.mediaTranscripts.setImportedSegments(db, 'file_media', [
      [{ startMs: 0, endMs: 20_000 }, 'Introduction to quantum mechanics and measurement'],
      [{ startMs: 100_000, endMs: 120_000 }, 'Quantum error correction protects logical qubits'],
    ]);
    const units = host.ctx.vfs.unitIndex.syncResourceUnits({ resourceId: 'res_media', resourceType: 'file' });
    expect(units).toHaveLength(2);
    db.run('UPDATE vfs_index_units SET text_generation = ?1 WHERE resource_id = ?2',
      [9007199254740992n, 'res_media']);
    expect(await host.ctx.vfsIndex.indexing.indexResource('res_media')).toEqual([1, 64]);
    const expectedRanges = [{ startMs: 0, endMs: 20_000 }, { startMs: 100_000, endMs: 120_000 }];
    for (const [index, unit] of units.entries()) {
      const segments = host.ctx.vfsRepo.embeddingSegments.getByUnitAndModality(db, unit.id, 'text');
      expect(segments).toHaveLength(1);
      expect(segments[0]!.generation).toBe(9007199254740993n);
      expect(JSON.parse(segments[0]!.metadataJson!)).toEqual(expectedRanges[index]);
      expect(host.ctx.vfsRepo.embeddingUnits.getById(db, unit.id)?.textGeneration).toBe(9007199254740993n);
    }
    const connection = await host.ctx.vector.connect(path.join(path.dirname(db.path), 'lance', 'vfs'));
    const tables = await connection.tableNames();
    expect(tables).toHaveLength(1);
    const rows = await (await connection.openTable(tables[0]!)).query({ columns: ['unit_id', 'generation'] });
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.generation)).toEqual([9007199254740993n, 9007199254740993n]);
    expect(rows.map(row => row.unit_id).sort()).toEqual(units.map(unit => unit.id).sort());
    const profileId = host.ctx.vfsRepo.embeddingUnits.getById(db, units[0]!.id)!.textProfileId!;
    const hits = await host.ctx.vfsIndex.lance.vectorSearchProfileFull(
      profileId, Array<number>(64).fill(0.25), 10, null, null, null,
    );
    expect(hits).toHaveLength(2);
    expect(hits.map(hit => hit.page_index).sort()).toEqual([0, 1]);
    expect(hits.map(hit => hit.generation)).toEqual([9007199254740993n, 9007199254740993n]);
  } finally {
    await host?.dispose();
    storage.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
