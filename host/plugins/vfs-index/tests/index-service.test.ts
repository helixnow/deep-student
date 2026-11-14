import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import vectorPlugin from '../../../platform/vector/index.ts';
import indexPlugin from '../index.ts';
import type { DatabaseHandle, Row } from '../../../platform/storage/api.ts';
import type { EmbeddingRuntime, VfsLanceRow } from '../api.ts';
import { VfsRepositoryError, type VfsReposService } from '../../vfs-repos/api.ts';
import { VfsEmbeddingPipeline } from '../src/embedding.ts';
import {
  UnsupportedIndexResourceTypeError, VfsFullIndexingService, VfsIndexingService,
  VfsSearchService, getChunkingConfig, getIndexingConfig, getSearchConfig, hasValidText,
  joinOcrPagesText, parseOcrPagesJson, resolveIndexableContent, resolveIndexablePages,
} from '../src/index-service.ts';
import {
  INDEX_STATE_FAILED, INDEX_STATE_INDEXED, INDEX_STATE_INDEXING, INDEX_STATE_PENDING,
  claimPendingResources, getConfig, getIndexState, getPendingResources,
  markFailed, markIndexed, requeuePagedPdfsOnce, setIndexState,
} from '../repository/index-state.ts';
import {
  getUnitsByResource, insertUnit, purgeIndexArtifactsByResource,
} from '../repository/index-units.ts';
import { bindVfsTableOwners, unbindVfsTableOwners } from '../repository/owners.ts';
import { updateResourceOcrTextIfEmpty } from '../repository/index-content.ts';
import { bindRealOwner } from './support/real-owner.ts';
import { invalidState, other } from '../src/lance-types.ts';

interface Harness {
  db: DatabaseHandle;
  base: string;
  storage: ReturnType<typeof createStorageService>;
}

const harnesses: Harness[] = [];
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

function freshDb(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const harness = { db: storage.database('vfs'), base, storage };
  bindRealOwner(harness.db);
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.storage.dispose();
    fs.rmSync(harness.base, { recursive: true, force: true });
  }
});

function insertResource(
  db: DatabaseHandle,
  id: string,
  data: string | null,
  options: { type?: string; hash?: string; state?: string; sourceId?: string | null } = {},
): void {
  db.run(
    `INSERT INTO resources
       (id, hash, type, source_id, source_table, storage_mode, data, metadata_json,
        ref_count, created_at, updated_at, index_state)
     VALUES (?1, ?2, ?3, ?4, 'notes', 'inline', ?5, '{}', 0, 1, 1, ?6)`,
    [id, options.hash ?? `hash-${id}`, options.type ?? 'note', options.sourceId ?? null, data, options.state ?? 'pending'],
  );
}

function fakeRuntime(vectors = [new Array<number>(128).fill(0.1)]): EmbeddingRuntime {
  return {
    getEmbeddingModelConfig: async () => ({ id: 'config-1', model: 'bge-m3' }),
    callEmbeddingApi: async (texts: string[]) => texts.map((_, index) => vectors[index] ?? vectors[0]!),
    modelFingerprintForConfig: (config) => `fp:${config.id}:${config.model}`,
  };
}

type FakeStore = import('../src/index-service.ts').IndexingLanceStore & {
  rows: VfsLanceRow[];
  deletedModalities: string[];
  guarded: Array<{ unitId: string; keep: readonly string[] }>;
  discarded: string[][];
  sweeps: number;
  deleteShouldFail: boolean;
};

function fakeStore(): FakeStore {
  const store: FakeStore = {
    rows: [],
    deletedModalities: [],
    guarded: [],
    discarded: [],
    sweeps: 0,
    deleteShouldFail: false,
    nextUnitGeneration: () => 3,
    ensureModelProfileWithFingerprint: () => ({ id: 'profile-1' }),
    writeChunks: async (_modality, rows) => { store.rows.push(...rows); },
    deleteByResource: async (modality: string) => { store.deletedModalities.push(modality); return 1; },
    deleteByEmbeddingIds: async () => {
      if (store.deleteShouldFail) throw new Error('lance unavailable');
      return 1;
    },
    deleteByUnitExceptIds: async (_modality, _resourceId, unitId, keep) => {
      store.guarded.push({ unitId, keep });
      return 1;
    },
    discardUncommittedRows: async (_modality, _resourceId, ids) => {
      store.discarded.push([...ids]);
      return ids.length;
    },
    sweepRetiredProfileTables: async () => { store.sweeps += 1; return 0; },
  };
  return store;
}

function service(db: DatabaseHandle, store = fakeStore(), options: {
  unitSync?: import('../src/index-service.ts').IndexUnitSync;
  ocrRecovery?: import('../src/index-service.ts').OcrRecovery;
  events?: import('../src/index-service.ts').IndexEventSink;
  questionRepo?: import('../../vfs-repos/api.ts').QuestionRepository;
  logger?: import('../src/logger.ts').LaneLogger;
} = {}): VfsFullIndexingService {
  // The external Lance test transport returns profile-1. It must represent a
  // real writable owner profile now that setIndexProfile enforces Rust's CAS.
  const ensureProfile = store.ensureModelProfileWithFingerprint.bind(store);
  store.ensureModelProfileWithFingerprint = (...args) => {
  db.run(`INSERT OR IGNORE INTO vfs_index_profiles
    (id, model_fingerprint, model_config_id, model_name, dimension, modality, embedding_protocol,
     schema_version, lance_table_name, active_generation, state, ann_metric, ann_index_version, created_at, updated_at)
    VALUES ('profile-1', 'fp:config-1:bge-m3', 'config-1', 'bge-m3', 128, 'text', 'text-embedding-v1',
            1, 'vfs_emb_text_128', 0, 'active', 'exact', 0, 0, 0)`);
  db.run(`INSERT INTO vfs_embedding_dims
    (dimension, modality, lance_table_name, record_count, created_at, last_used_at, active_profile_id)
    VALUES (128, 'text', 'vfs_emb_text_128', 0, 0, 0, 'profile-1')
    ON CONFLICT(dimension, modality) DO UPDATE SET active_profile_id = 'profile-1'`);
    return ensureProfile(...args);
  };
  return new VfsFullIndexingService({
    db,
    pipeline: new VfsEmbeddingPipeline(fakeRuntime(), store),
    lanceStore: store,
    events: options.events,
    unitSync: options.unitSync,
    ocrRecovery: options.ocrRecovery,
    questionRepo: options.questionRepo,
    logger: options.logger,
  });
}

function captureLogger(): {
  logger: import('../src/logger.ts').LaneLogger; warn: string[]; error: string[];
} {
  const warn: string[] = [];
  const error: string[] = [];
  return {
    warn, error,
    logger: {
      debug: () => undefined, info: () => undefined,
      warn: (message) => { warn.push(message); },
      error: (message) => { error.push(message); },
    },
  };
}

function questionRepo(questions: Array<Record<string, unknown>>): import('../../vfs-repos/api.ts').QuestionRepository {
  return {
    getQuestion: (_conn: unknown, id: string) => (questions.find((question) => question['id'] === id) ?? null) as never,
    listQuestions: () => ({
      questions,
      total: questions.length,
      page: 1,
      page_size: 1000,
      has_more: false,
    }) as never,
  } as unknown as import('../../vfs-repos/api.ts').QuestionRepository;
}

describe('Rust vfs/repos/embedding_repo.rs config and index state', () => {
  it('reads defaults when no configuration rows exist', () => {
    const { db } = freshDb();
    expect(getIndexingConfig(db)).toEqual({
      enabled: true, batchSize: 10, intervalSecs: 5, maxConcurrent: 2,
      retryDelaySecs: 60, maxRetries: 3,
    });
    expect(getChunkingConfig(db)).toEqual({
      strategy: 'fixed_size', chunkSize: 512, chunkOverlap: 50, minChunkSize: 20,
    });
    expect(getSearchConfig(db)).toEqual({
      defaultTopK: 10, enableHybrid: true, enableReranking: false,
    });
  });

  it('validates every published configuration key with Rust messages through the real L11 owner', () => {
    const { db } = freshDb();
    const owner = bindRealOwner(db).indexingConfig;
    const failure = (key: string, value: string): string => {
      try {
        owner.setConfig(db, key, value);
      } catch (error) {
        expect(error).toBeInstanceOf(VfsRepositoryError);
        expect(error).toMatchObject({ code: 'VFS_INVALID_ARGUMENT', data: { param: key } });
        return (error as Error).message;
      }
      throw new Error(`expected ${key}=${value} to fail`);
    };
    expect(failure('indexing.enabled', 'yes')).toBe("Invalid argument 'indexing.enabled': Expected true, false, 0, or 1");
    expect(failure('indexing.batch_size', '0')).toBe("Invalid argument 'indexing.batch_size': Must be between 1 and 1000");
    expect(failure('indexing.interval_secs', '86401')).toBe("Invalid argument 'indexing.interval_secs': Must be between 1 and 86400 seconds");
    expect(failure('indexing.max_concurrent', 'x')).toBe("Invalid argument 'indexing.max_concurrent': Expected an integer, got \"x\"");
    expect(failure('indexing.max_retries', '-1')).toBe("Invalid argument 'indexing.max_retries': Must be between 0 and 20");
    expect(failure('chunking.strategy', 'paragraph')).toBe("Invalid argument 'chunking.strategy': Must be fixed_size or semantic");
    expect(failure('chunking.chunk_overlap', '512')).toBe("Invalid argument 'chunking.chunk_overlap': Must be non-negative and less than chunking.chunk_size (512)");
    expect(failure('search.default_top_k', '501')).toBe("Invalid argument 'search.default_top_k': Must be between 1 and 500");
    expect(failure('search.fts_weight', '1.5')).toBe("Invalid argument 'search.fts_weight': Must be a finite value between 0 and 1");
    expect(failure('unknown.key', '1')).toBe("Invalid argument 'unknown.key': Unknown indexing configuration key");
    owner.setConfig(db, 'indexing.batch_size', '25');
    expect(getConfig(db, 'indexing.batch_size')).toBe('25');
    expect(getIndexingConfig(db).batchSize).toBe(25);
  });

  it('mark_indexed clears retry counters and mark_failed applies exponential backoff', () => {
    const { db } = freshDb();
    insertResource(db, 'res_state', 'content', { state: 'indexed' });
    markFailed(db, 'res_state', 'boom');
    const failed = getIndexState(db, 'res_state')!;
    expect(failed.state).toBe(INDEX_STATE_FAILED);
    expect(failed.retry_count).toBe(1);
    const retryAt = Number(db.pluck<unknown>('SELECT index_next_retry_at FROM resources WHERE id = ?1', ['res_state']));
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(getPendingResources(db, 10, 3)).not.toContain('res_state');
    markIndexed(db, 'res_state', 'hash-res_state');
    const indexed = getIndexState(db, 'res_state')!;
    expect(indexed.state).toBe(INDEX_STATE_INDEXED);
    expect(indexed.retry_count).toBe(0);
    expect(indexed.hash).toBe('hash-res_state');
    expect(indexed.indexed_at).not.toBeNull();
  });

  it('claims pending resources atomically and flips them to indexing', () => {
    const { db } = freshDb();
    insertResource(db, 'res_a', 'a');
    insertResource(db, 'res_b', 'b');
    const claimed = claimPendingResources(db, 10, 3);
    expect(claimed.sort()).toEqual(['res_a', 'res_b']);
    expect(getIndexState(db, 'res_a')!.state).toBe(INDEX_STATE_INDEXING);
    expect(claimPendingResources(db, 10, 3)).toEqual([]);
  });

  it('requeues multi-page PDFs exactly once', () => {
    const { db } = freshDb();
    insertResource(db, 'res_pdf', 'x', { type: 'file', state: 'indexed' });
    insertResource(db, 'res_one', 'x', { type: 'file', state: 'indexed' });
    db.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, page_count, created_at, updated_at)
       VALUES ('file_pdf', 'res_pdf', 'sha1', 'a.pdf', 1, 3, '0', '0')`,
    );
    db.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, page_count, created_at, updated_at)
       VALUES ('file_one', 'res_one', 'sha2', 'b.pdf', 1, 1, '0', '0')`,
    );
    expect(requeuePagedPdfsOnce(db)).toBe(1);
    expect(getIndexState(db, 'res_pdf')!.state).toBe(INDEX_STATE_PENDING);
    expect(requeuePagedPdfsOnce(db)).toBe(0);
  });
});

describe('Rust vfs/indexing.rs VfsIndexingService', () => {
  it('index_resource_creates_placeholder_segments_without_lance', () => {
    const { db } = freshDb();
    insertResource(db, 'res_note', 'Hello world, this is a test string for chunking.');
    const count = new VfsIndexingService(db).indexResource('res_note', 128);
    expect(count).toBeGreaterThan(0);
    const state = getIndexState(db, 'res_note')!;
    expect(state.state).toBe(INDEX_STATE_INDEXED);
    expect(state.hash).toBe('hash-res_note');
    const segments = db.all<Row>(
      `SELECT s.lance_row_id, s.embedding_dim, u.text_state
       FROM vfs_index_segments s JOIN vfs_index_units u ON u.id = s.unit_id
       WHERE u.resource_id = ?1`,
      ['res_note'],
    );
    expect(segments).toHaveLength(count);
    expect(segments.every((row) => String(row['lance_row_id']).startsWith('placeholder_no_lance_'))).toBe(true);
    expect(segments.every((row) => Number(row['embedding_dim']) === 128)).toBe(true);
    expect(segments[0]!['text_state']).toBe('indexed');
  });

  it('index_resource_marks_empty_content_indexed_without_segments', () => {
    const { db } = freshDb();
    insertResource(db, 'res_empty', null);
    const count = new VfsIndexingService(db).indexResource('res_empty', 128);
    expect(count).toBe(0);
    expect(getIndexState(db, 'res_empty')!.state).toBe(INDEX_STATE_INDEXED);
    expect(purgeIndexArtifactsByResource(db, 'res_empty')).toBe(0);
  });

  it('index_resource_reports_not_found_for_missing_resources', () => {
    const { db } = freshDb();
    expect(() => new VfsIndexingService(db).indexResource('res_missing', 128))
      .toThrow('Resource not found: res_missing');
  });

  it('check_needs_reindex_compares_state_and_hash', () => {
    const { db } = freshDb();
    insertResource(db, 'res_check', 'content', { state: 'indexed' });
    const service = new VfsIndexingService(db);
    expect(service.checkNeedsReindex('res_check')).toBe(true);
    setIndexState(db, 'res_check', INDEX_STATE_INDEXED, 'hash-res_check', null);
    expect(service.checkNeedsReindex('res_check')).toBe(false);
    setIndexState(db, 'res_check', INDEX_STATE_INDEXED, 'stale-hash', null);
    expect(service.checkNeedsReindex('res_check')).toBe(true);
    expect(service.checkNeedsReindex('res_missing')).toBe(false);
  });
});

describe('Rust vfs/indexing.rs VfsFullIndexingService', () => {
  it('R12-01 process_pending_batch preserves queued work without Lance and observes a late vector provider', async () => {
    const { db, storage } = freshDb();
    const owner = bindRealOwner(db);
    const host = await createTestHost({ plugins: [indexPlugin], provide: { files: testFiles(storage),  storage, vfsRepo: owner } });
    try {
      insertResource(db, 'res_disabled_batch', 'Pending lexical content for later vector indexing.');
      owner.embeddingSegments.enqueueLanceOrphan(db, 'orphan_disabled_batch', 'res_disabled_batch');
      const before = db.get('SELECT * FROM __lance_orphan_queue WHERE lance_row_id = ?1', ['orphan_disabled_batch']);
      const claim = vi.spyOn(owner.indexStates, 'claimPendingResources');
      expect(await host.ctx.vfsIndex.indexing.processPendingBatch(5)).toEqual([0, 0]);
      expect(claim).not.toHaveBeenCalled();
      expect(getIndexState(db, 'res_disabled_batch')).toMatchObject({ state: 'pending', retry_count: 0 });
      expect(db.get('SELECT * FROM __lance_orphan_queue WHERE lance_row_id = ?1', ['orphan_disabled_batch'])).toEqual(before);

      await host.install(vectorPlugin);
      expect(await host.ctx.vfsIndex.indexing.processPendingBatch(0)).toEqual([0, 0]);
      expect(claim).toHaveBeenCalledWith(db, 0, 3);
      expect(db.pluck('SELECT COUNT(*) FROM __lance_orphan_queue')).toBe(0);
      expect(getIndexState(db, 'res_disabled_batch')?.state).toBe('pending');
    } finally { await host.dispose(); }
  });

  it('R12-01 index_resource without Lance refreshes searchable text without attempting embeddings', async () => {
    const { db, storage } = freshDb();
    const owner = bindRealOwner(db);
    const host = await createTestHost({ plugins: [indexPlugin], provide: { files: testFiles(storage),  storage, vfsRepo: owner } });
    try {
      const text = 'Lexical indexing remains available without a vector provider.';
      insertResource(db, 'res_disabled_text', text);
      expect(await host.ctx.vfsIndex.indexing.indexResource('res_disabled_text')).toEqual([0, 0]);
      expect(getIndexState(db, 'res_disabled_text')).toMatchObject({ state: 'pending', retry_count: 0, error: null });
      const units = owner.embeddingUnits.getByResource(db, 'res_disabled_text');
      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({ textContent: text, textState: 'pending' });
      expect(owner.embeddingSegments.getByUnitAndModality(db, units[0]!.id, 'text')).toEqual([]);
      const response = await host.ctx.retrieval.search({ queryText: 'Lexical', queryImageBase64: null,
        queryImageMediaType: null, queryModality: 'text', topK: 5, folderIds: null,
        resourceIds: ['res_disabled_text'], resourceTypes: null });
      expect(response.result.hits).toHaveLength(1);
      expect(response.result.hits[0]!.hit.identity.resourceId).toBe('res_disabled_text');
    } finally { await host.dispose(); }
  });

  it('R12-01 index_resource without Lance re-syncs the real Unit ledger after PDF OCR', async () => {
    const { db, storage } = freshDb();
    const owner = bindRealOwner(db);
    const recognized = 'Recovered lexical page text from the OCR provider.';
    const host = await createTestHost({ plugins: [indexPlugin], provide: { files: testFiles(storage), 
      storage, vfsRepo: owner,
      llmOcrModels: { inspectFreeTextOcrAvailable: async () => true, getFreeTextOcrCandidatesByPriority: async () => [] },
      llmOcrHedge: { prepareCandidates: async () => [], runPrepared: async () => recognized },
    } });
    try {
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlW8AAAAASUVORK5CYII=', 'base64');
      const blob = owner.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'), image, 'image/png');
      const file = owner.files.createFileWithDocDataInFolder(db, 'disabled-ocr', 'scan.pdf', 100,
        'file', 'application/pdf', null, null, null, null, null, 1);
      owner.files.updatePdfPreviewOnly(db, file.id, JSON.stringify({
        pages: [{ pageIndex: 0, blobHash: blob.hash, width: 1, height: 1, mimeType: 'image/png' }],
        renderDpi: 150, totalPages: 1, renderedAt: 'recorded',
      }));
      const sync = vi.spyOn(owner.embeddingUnits, 'syncUnits');
      expect(await host.ctx.vfsIndex.indexing.indexResource(file.resourceId!)).toEqual([0, 0]);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(owner.embeddingUnits.getByResource(db, file.resourceId!)).toEqual(expect.arrayContaining([
        expect.objectContaining({ textContent: recognized, textState: 'pending' }),
      ]));
      expect(getIndexState(db, file.resourceId!)).toMatchObject({ state: 'pending', error: null, retry_count: 0 });
      expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
      expect(db.pluck('SELECT ocr_pages_json FROM files WHERE id = ?1', [file.id])).toContain(recognized);
    } finally { await host.dispose(); }
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    'R12-06 primary metadata recovery preserves error ordering (retryable=%s, rollbackFailure=%s)', async (retryable, rollbackFailure) => {
      const { db } = freshDb();
      const resourceId = 'res_primary_recovery';
      const text = 'Primary content long enough to produce exactly one text chunk.';
      insertResource(db, resourceId, text);
      const owner = bindRealOwner(db);
      const unit = owner.embeddingUnits.create(db, { resourceId, unitIndex: 0,
        imageBlobHash: null, imageMimeType: null, textContent: text, textSource: 'native' });
      db.exec(`CREATE TRIGGER reject_primary_segment BEFORE INSERT ON vfs_index_segments
        BEGIN SELECT RAISE(ABORT, 'segment rejected'); END`);
      db.exec(`CREATE TRIGGER reject_primary_recovery BEFORE UPDATE OF text_state ON vfs_index_units
        WHEN NEW.resource_id = '${resourceId}' AND NEW.text_state IN ('pending', 'failed')
        BEGIN SELECT RAISE(ABORT, 'recovery marker rejected'); END`);
      const replace = vi.spyOn(owner.embeddingSegments, 'replaceByUnitAndModality');
      const conflict = new VfsRepositoryError('VFS_INVALID_OPERATION', 'INVALID_STATE: profile changed');
      if (retryable) vi.spyOn(owner.embeddingUnits, 'setIndexProfile').mockImplementation(() => { throw conflict; });
      const store = fakeStore();
      store.discardUncommittedRows = async (_modality, _resourceId, ids) => {
        store.discarded.push([...ids]);
        if (rollbackFailure) throw new Error('rollback rejected');
        return ids.length;
      };
      const logs: Array<[string, string]> = [];
      let caught: unknown;
      try {
        await service(db, store, { logger: {
          debug: () => undefined, info: () => undefined,
          warn: message => { logs.push(['warn', message]); },
          error: message => { logs.push(['error', message]); },
        } }).indexResource(resourceId);
      } catch (error) { caught = error; }
      const syncFailure = retryable ? conflict : replace.mock.results.find(result => result.type === 'throw')?.value;
      expect(syncFailure).toBeInstanceOf(VfsRepositoryError);
      if (!retryable) expect(syncFailure).toMatchObject({ code: 'VFS_STORAGE', message: 'Database error: segment rejected' });
      const originalMessage = (syncFailure as Error).message;
      const finalMessage = rollbackFailure && !retryable ? `${originalMessage}; rollback failed: rollback rejected` : originalMessage;
      if (rollbackFailure && !retryable) expect(caught).toMatchObject({ code: 'VFS_INTERNAL', message: finalMessage });
      else expect(caught).toBe(syncFailure);
      expect(store.rows).toHaveLength(1);
      expect(store.discarded).toEqual([store.rows.map(row => row.embedding_id)]);
      expect(owner.embeddingUnits.getById(db, unit.id)).toMatchObject({ textState: 'pending', textProfileId: null, textGeneration: 0 });
      expect(owner.embeddingSegments.getByUnitAndModality(db, unit.id, 'text')).toEqual([]);
      expect(getIndexState(db, resourceId)).toMatchObject({ state: retryable ? 'pending' : 'failed', error: retryable ? null : finalMessage });
      expect(logs).toEqual([
        ['warn', `[VfsIndexing] Failed to update text_state to 'failed' for resource ${resourceId}: recovery marker rejected`],
        ['error', `[VfsFullIndexingService] Metadata sync failed after Lance write for ${resourceId}: ${originalMessage}. Rolling back Lance vectors...`],
        ...(rollbackFailure ? [['error', `[VfsFullIndexingService] Lance rollback failed for ${resourceId}: rollback rejected`]] : []),
      ]);
    },
  );
  it.each(['primary', 'additional'] as const)(
    'R12-06 indexing-state marker failure retains the Rust %s metadata policy', async (role) => {
      const { db } = freshDb();
      const resourceId = 'res_marker_policy';
      const text = 'Primary content long enough to produce exactly one text chunk.';
      insertResource(db, resourceId, text);
      const owner = bindRealOwner(db);
      const units = [0, 1, 2].map(unitIndex => owner.embeddingUnits.create(db, {
        resourceId, unitIndex, imageBlobHash: null, imageMimeType: null,
        textContent: unitIndex === 0 ? text : `Additional unit ${unitIndex} text long enough for a single chunk.`,
        textSource: 'native',
      }));
      const failed = units[role === 'primary' ? 0 : 1]!;
      db.exec(`CREATE TRIGGER reject_indexing_marker BEFORE UPDATE OF text_state ON vfs_index_units
        WHEN NEW.id = '${failed.id}' AND NEW.text_state = 'indexing'
        BEGIN SELECT RAISE(ABORT, 'indexing marker rejected'); END`);
      const warnings: string[] = [];
      const store = fakeStore();
      expect(await service(db, store, { logger: {
        debug: () => undefined, info: () => undefined, error: () => undefined,
        warn: message => { warnings.push(message); },
      } }).indexResource(resourceId)).toEqual([1, 128]);
      expect(owner.embeddingUnits.getById(db, units[0]!.id)?.textState).toBe('indexed');
      expect(owner.embeddingUnits.getById(db, units[2]!.id)?.textState).toBe('indexed');
      expect(getIndexState(db, resourceId)?.state).toBe('indexed');
      if (role === 'primary') {
        expect(owner.embeddingUnits.getById(db, failed.id)).toMatchObject({
          textState: 'indexed', textEmbeddingDim: 128, textGeneration: 3,
        });
        expect(owner.embeddingSegments.getByUnitAndModality(db, failed.id, 'text')).toHaveLength(1);
        expect(store.discarded).toEqual([]);
        expect(warnings).toEqual([
          `[VfsIndexing] Failed to update text_state to 'indexing' for unit ${failed.id}: indexing marker rejected`,
        ]);
      } else {
        expect(owner.embeddingUnits.getById(db, failed.id)).toMatchObject({
          textState: 'failed', textError: 'indexing marker rejected', textProfileId: null, textGeneration: 0,
        });
        expect(owner.embeddingSegments.getByUnitAndModality(db, failed.id, 'text')).toEqual([]);
        const rejectedRows = store.rows.filter(row => row.unit_id === failed.id);
        expect(rejectedRows).toHaveLength(1);
        expect(store.discarded).toEqual([rejectedRows.map(row => row.embedding_id)]);
        expect(warnings).toEqual([]);
      }
    },
  );
  it('X6-SW-0179 additional unit failure uses the owner state setter without clearing indexed metadata', async () => {
    const { db } = freshDb();
    const text = 'Primary content long enough to produce exactly one text chunk.';
    insertResource(db, 'res_additional_owner', text);
    const owner = bindRealOwner(db);
    const setState = vi.spyOn(owner.embeddingUnits, 'setTextState');
    owner.embeddingUnits.create(db, {
      resourceId: 'res_additional_owner', unitIndex: 0, imageBlobHash: null, imageMimeType: null,
      textContent: text, textSource: 'native',
    });
    const secondary = owner.embeddingUnits.create(db, {
      resourceId: 'res_additional_owner', unitIndex: 1, imageBlobHash: null, imageMimeType: null,
      textContent: 'Secondary content with a failing external vector write.', textSource: 'native',
    });
    db.run('UPDATE vfs_index_units SET text_indexed_at = 777, text_embedding_dim = 128 WHERE id = ?1', [secondary.id]);
    const store = fakeStore();
    const write = store.writeChunks.bind(store);
    store.writeChunks = async (modality, rows) => {
      if (rows.some((row) => row.unit_id === secondary.id)) throw new Error('second unit write failed');
      await write(modality, rows);
    };
    expect(await service(db, store).indexResource('res_additional_owner')).toEqual([1, 128]);
    expect(setState).toHaveBeenCalledWith(db, secondary.id, 'failed', 'second unit write failed');
    expect(owner.embeddingUnits.getById(db, secondary.id)).toMatchObject({
      textState: 'failed', textError: 'second unit write failed', textIndexedAt: 777, textEmbeddingDim: 128,
    });
    expect(getIndexState(db, 'res_additional_owner')?.state).toBe('indexed');
    expect(db.pluck("SELECT updated_at FROM resources WHERE id = 'res_additional_owner'")).toBe(1);
  });
  it.each([false, true])('R12-06.additional-unit ignores marker failure without masking the vector result (InvalidState=%s)', async (retryable) => {
    const { db } = freshDb();
    const resourceId = 'res_additional_trigger';
    const text = 'Primary content long enough to produce exactly one text chunk.';
    insertResource(db, resourceId, text);
    const owner = bindRealOwner(db);
    const units = [0, 1, 2].map((unitIndex) => owner.embeddingUnits.create(db, {
      resourceId, unitIndex, imageBlobHash: null, imageMimeType: null,
      textContent: unitIndex === 0 ? text : `Additional unit ${unitIndex} content long enough to index.`, textSource: 'native',
    }));
    const primary = units[0]!, secondary = units[1]!, later = units[2]!;
    db.exec(`CREATE TRIGGER reject_additional_marker BEFORE UPDATE OF text_state ON vfs_index_units
      WHEN NEW.id = '${secondary.id}' BEGIN SELECT RAISE(ABORT, 'unit state rejected'); END`);
    const setState = vi.spyOn(owner.embeddingUnits, 'setTextState');
    const original = retryable ? invalidState('profile changed') : other('upstream reported INVALID_STATE');
    const store = fakeStore();
    const write = store.writeChunks.bind(store);
    store.writeChunks = async (modality, rows) => {
      if (rows.some((row) => row.unit_id === secondary.id)) throw original;
      await write(modality, rows);
    };
    const warnings: string[] = [];
    const result = service(db, store, { logger: {
      debug: () => undefined, info: () => undefined, error: () => undefined,
      warn: (message) => { warnings.push(message); },
    } }).indexResource(resourceId);
    if (retryable) await expect(result).rejects.toBe(original);
    else await expect(result).resolves.toEqual([1, 128]);
    expect(setState).toHaveBeenCalledWith(db, secondary.id, retryable ? 'pending' : 'failed', retryable ? null : original.message);
    expect(setState.mock.results[0]?.type).toBe('throw');
    expect(setState.mock.results[0]?.value).toMatchObject({ message: expect.stringContaining('unit state rejected') });
    expect(owner.embeddingUnits.getById(db, secondary.id)?.textState).toBe('pending');
    expect(owner.embeddingUnits.getById(db, primary.id)?.textState).toBe('indexed');
    expect(owner.embeddingUnits.getById(db, later.id)?.textState).toBe(retryable ? 'pending' : 'indexed');
    expect(getIndexState(db, resourceId)?.state).toBe(retryable ? 'pending' : 'indexed');
    expect(warnings).toEqual(retryable ? [] : [
      `[VfsFullIndexingService] Failed to index additional unit ${secondary.id} for resource ${resourceId}: ${original.message}`,
    ]);
  });
  it('R12-06 OCR cache stores extracted text through the real L11 owner without overwriting or touching updated_at (indexing.rs:782-800,1077-1089)', () => {
    const { db } = freshDb();
    const cases: Array<[string, string | null, string | null, string]> = [
      // [resource, ocr_text before, ocr_text after, resolved content]
      ['res_null', null, 'extracted content', 'extracted content'],
      ['res_empty', '', 'extracted content', 'extracted content'],
      // Rust trims for ocr_len (0) but the UPDATE guard keeps the whitespace value.
      ['res_blank', '   ', '   ', 'extracted content'],
      // indexing.rs:782-800: a non-blank cache is returned first and never rewritten.
      ['res_short', 'abc', 'abc', 'abc'],
    ];
    const logs = captureLogger();
    for (const [id, before, after, resolved] of cases) {
      insertResource(db, id, null, { type: 'file', sourceId: `file_${id}` });
      db.run('UPDATE resources SET ocr_text = ?1 WHERE id = ?2', [before, id]);
      db.run(`INSERT INTO files (id, sha256, file_name, size, created_at, updated_at, extracted_text)
        VALUES (?1, ?2, 'cache.pdf', 1, 'now', 'now', 'extracted content')`, [`file_${id}`, `sha_${id}`]);
      expect(resolveIndexableContent(db, {
        id, hash: `hash-${id}`, resourceType: 'file', sourceId: `file_${id}`,
        sourceTable: 'files', storageMode: 'inline', data: null, metadataJson: null,
      }, logs.logger)).toBe(resolved);
      expect(db.get('SELECT ocr_text, updated_at FROM resources WHERE id = ?1', [id]))
        .toEqual({ ocr_text: after, updated_at: 1 });
    }
    // The owner's conditional WHERE never replaces a value that appeared concurrently.
    updateResourceOcrTextIfEmpty(db, 'res_null', 'later text');
    expect(db.get("SELECT ocr_text, updated_at FROM resources WHERE id = 'res_null'"))
      .toEqual({ ocr_text: 'extracted content', updated_at: 1 });
    expect(logs.warn).toEqual([]);
    expect(logs.error).toEqual([]);
  });
  it('R12-06 failed OCR cache writes warn and preserve extracted content (indexing.rs:1081-1089)', () => {
    const { db } = freshDb();
    insertResource(db, 'res_cache', null, { type: 'file', sourceId: 'file_cache' });
    db.run(`INSERT INTO files (id, sha256, file_name, size, created_at, updated_at, extracted_text)
      VALUES ('file_cache', 'sha_cache', 'cache.pdf', 1, 'now', 'now', 'extracted content')`);
    db.exec(`CREATE TRIGGER reject_ocr_cache BEFORE UPDATE OF ocr_text ON resources
      BEGIN SELECT RAISE(ABORT, 'ocr cache rejected'); END`);
    const logs = captureLogger();
    expect(resolveIndexableContent(db, {
      id: 'res_cache', hash: 'hash-res_cache', resourceType: 'file', sourceId: 'file_cache',
      sourceTable: 'files', storageMode: 'inline', data: null, metadataJson: null,
    }, logs.logger)).toBe('extracted content');
    expect(logs.warn).toEqual([
      '[VfsIndexing] Failed to cache ocr_text for resource res_cache: ocr cache rejected',
    ]);
    expect(logs.error).toEqual([]);
    expect(db.get("SELECT ocr_text, updated_at FROM resources WHERE id = 'res_cache'"))
      .toEqual({ ocr_text: null, updated_at: 1 });
  });
  it('recover_stuck_indexing delegates the reset to the L11 maintenance owner', () => {
    const { db } = freshDb();
    insertResource(db, 'res_stuck', 'content', { state: 'indexing' });
    db.run(
      `INSERT INTO vfs_index_units
         (id, resource_id, unit_index, text_content, text_required, text_state,
          mm_required, mm_state, created_at, updated_at)
       VALUES ('unit_stuck', 'res_stuck', 0, 'x', 1, 'indexing', 1, 'indexing', 0, 0)`,
    );
    const calls: Array<{ conn: unknown; at: number }> = [];
    bindVfsTableOwners(db, {
      maintenance: {
        recoverStuckIndexingWithConn: (conn: unknown, at: number) => {
          calls.push({ conn, at });
          return 3;
        },
      },
    } as unknown as VfsReposService);

    const before = Date.now();
    expect(VfsFullIndexingService.recoverStuckIndexing(db)).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.conn).toBe(db);
    expect(calls[0]!.at).toBeGreaterThanOrEqual(before);
    // L12 scheduled the owner call but did not write the owner's tables itself.
    const unit = getUnitsByResource(db, 'res_stuck')[0]!;
    expect(unit.textState).toBe('indexing');
    expect(unit.mmState).toBe('indexing');
    expect(getIndexState(db, 'res_stuck')!.state).toBe(INDEX_STATE_INDEXING);
  });

  it('recover_stuck_indexing resets only indexing rows through the real L11 owner (indexing.rs:1978-2046)', () => {
    const { db } = freshDb();
    const recovered = 'recovered: interrupted by crash';
    const resource = (id: string, text: string, mm: string) => {
      insertResource(db, id, 'content', { state: text });
      db.run(`UPDATE resources SET index_error = 'old', index_retry_count = 4, index_next_retry_at = 99,
        mm_index_state = ?2, mm_index_error = 'old mm', mm_index_retry_count = 5, mm_index_next_retry_at = 88
        WHERE id = ?1`, [id, mm]);
    };
    resource('res_both', 'indexing', 'indexing');
    resource('res_mm_only', 'indexed', 'indexing');
    resource('res_settled', 'failed', 'pending');
    const unit = (id: string, index: number, text: string, mm: string) => db.run(
      `INSERT INTO vfs_index_units
         (id, resource_id, unit_index, text_content, text_required, text_state, text_error,
          mm_required, mm_state, mm_error, created_at, updated_at)
       VALUES (?1, 'res_both', ?2, 'x', 1, ?3, 'old', 1, ?4, 'old mm', 0, 7)`,
      [id, index, text, mm],
    );
    unit('unit_both', 0, 'indexing', 'indexing');
    unit('unit_text', 1, 'indexing', 'indexed');
    unit('unit_settled', 2, 'failed', 'disabled');

    const before = Date.now();
    // text_units=2 (unit_both, unit_text), mm_units=1 (unit_both), resources=2 (res_both, res_mm_only).
    expect(VfsFullIndexingService.recoverStuckIndexing(db)).toBe(5);
    const after = Date.now();
    const units = db.all(`SELECT id, text_state, text_error, mm_state, mm_error, updated_at
      FROM vfs_index_units ORDER BY id`);
    for (const row of units.filter((r) => r.id !== 'unit_settled')) {
      expect(Number(row.updated_at)).toBeGreaterThanOrEqual(before);
      expect(Number(row.updated_at)).toBeLessThanOrEqual(after);
    }
    expect(units.map(({ updated_at: _ignored, ...rest }) => rest)).toEqual([
      { id: 'unit_both', text_state: 'pending', text_error: recovered, mm_state: 'pending', mm_error: recovered },
      { id: 'unit_settled', text_state: 'failed', text_error: 'old', mm_state: 'disabled', mm_error: 'old mm' },
      { id: 'unit_text', text_state: 'pending', text_error: recovered, mm_state: 'indexed', mm_error: 'old mm' },
    ]);
    expect(units.find((r) => r.id === 'unit_settled')?.updated_at).toBe(7);
    expect(db.all(`SELECT id, index_state, index_error, index_retry_count, index_next_retry_at,
        mm_index_state, mm_index_error, mm_index_retry_count, mm_index_next_retry_at, updated_at
      FROM resources ORDER BY id`)).toEqual([
      { id: 'res_both', index_state: 'pending', index_error: recovered, index_retry_count: 0, index_next_retry_at: 0,
        mm_index_state: 'pending', mm_index_error: recovered, mm_index_retry_count: 0, mm_index_next_retry_at: 0, updated_at: 1 },
      { id: 'res_mm_only', index_state: 'indexed', index_error: 'old', index_retry_count: 4, index_next_retry_at: 99,
        mm_index_state: 'pending', mm_index_error: recovered, mm_index_retry_count: 0, mm_index_next_retry_at: 0, updated_at: 1 },
      { id: 'res_settled', index_state: 'failed', index_error: 'old', index_retry_count: 4, index_next_retry_at: 99,
        mm_index_state: 'pending', mm_index_error: 'old mm', mm_index_retry_count: 5, mm_index_next_retry_at: 88, updated_at: 1 },
    ]);
    // A second startup finds nothing left in the indexing state.
    expect(VfsFullIndexingService.recoverStuckIndexing(db)).toBe(0);
  });

  it('recover_stuck_indexing reports an unbound owner without changing stuck rows', () => {
    const { db } = freshDb();
    insertResource(db, 'res_stuck', 'content', { state: 'indexing' });
    db.run(
      `INSERT INTO vfs_index_units
         (id, resource_id, unit_index, text_content, text_required, text_state,
          mm_required, mm_state, created_at, updated_at)
       VALUES ('unit_stuck', 'res_stuck', 0, 'x', 1, 'indexing', 1, 'indexing', 0, 0)`,
    );
    // Explicitly unbound fixture: freshDb() binds the real L11 owner, so remove it
    // to keep the missing-provider contract (no second local reset SQL).
    unbindVfsTableOwners(db);
    expect(() => VfsFullIndexingService.recoverStuckIndexing(db))
      .toThrow('L11 vfsRepo.maintenance.recoverStuckIndexingWithConn 未集成');
    expect(getUnitsByResource(db, 'res_stuck')[0]!.textState).toBe('indexing');
    expect(getUnitsByResource(db, 'res_stuck')[0]!.mmState).toBe('indexing');
    expect(getIndexState(db, 'res_stuck')!.state).toBe(INDEX_STATE_INDEXING);
  });

  it('index_resource_writes_segments_with_the_lance_embedding_ids', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_full', 'Alpha beta gamma. Delta epsilon zeta.');
    const store = fakeStore();
    const [count, dim] = await service(db, store).indexResource('res_full');
    expect(count).toBeGreaterThan(0);
    expect(dim).toBe(128);
    expect(store.rows).toHaveLength(count);
    const unit = getUnitsByResource(db, 'res_full')[0]!;
    expect(unit.textState).toBe('indexed');
    expect(unit.textProfileId).toBe('profile-1');
    expect(unit.textGeneration).toBe(3);
    const segments = db.all<Row>(
      `SELECT lance_row_id, index_profile_id, generation FROM vfs_index_segments WHERE unit_id = ?1`,
      [unit.id],
    );
    expect(segments.map((row) => row['lance_row_id'])).toEqual(store.rows.map((row) => row.embedding_id));
    expect(segments.every((row) => row['index_profile_id'] === 'profile-1')).toBe(true);
    expect(segments.every((row) => Number(row['generation']) === 3)).toBe(true);
    expect(store.guarded).toEqual([{ unitId: unit.id, keep: store.rows.map((row) => row.embedding_id) }]);
    expect(getIndexState(db, 'res_full')!.state).toBe(INDEX_STATE_INDEXED);
  });

  it('index_resource_marks_empty_content_indexed_and_clears_stale_vectors', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_full_empty', null);
    const store = fakeStore();
    const [count, dim] = await service(db, store).indexResource('res_full_empty');
    expect([count, dim]).toEqual([0, 0]);
    expect(store.deletedModalities).toEqual(['text']);
    expect(getIndexState(db, 'res_full_empty')!.state).toBe(INDEX_STATE_INDEXED);
    expect(getIndexState(db, 'res_full_empty')!.error).toBe('笔记内容为空');
  });

  it('index_resource_uses_ocr_recovery_before_chunking', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_image', null, { type: 'image' });
    const progress: unknown[] = [];
    const [count] = await service(db, fakeStore(), {
      ocrRecovery: {
        async recover(_resource, emit) {
          emit({ type: 'auto_ocr_completed', resourceId: 'res_image', success: true });
          return 'recognized image text';
        },
      },
      events: { emit: (_channel, payload) => { progress.push(payload); } },
    }).indexResource('res_image');
    expect(count).toBeGreaterThan(0);
    expect(progress).toEqual([{ type: 'auto_ocr_completed', resourceId: 'res_image', success: true }]);
  });

  it('index_resource_propagates_unsupported_unit_types_as_zero', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_retrieval', 'content', { type: 'retrieval' });
    const result = await service(db, fakeStore(), {
      unitSync: {
        syncResourceUnits() {
          throw new UnsupportedIndexResourceTypeError();
        },
      },
    }).indexResource('res_retrieval');
    expect(result).toEqual([0, 0]);
    const state = getIndexState(db, 'res_retrieval')!;
    expect(state.state).toBe('disabled');
    expect(state.error).toBe('该类型不建立检索索引');
  });

  it('delete_resource_index_removes_units_and_resets_the_state', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_delete', 'Alpha beta gamma.');
    const store = fakeStore();
    const full = service(db, store);
    await full.indexResource('res_delete');
    await full.deleteResourceIndex('res_delete');
    expect(store.deletedModalities.sort()).toEqual(['multimodal', 'text']);
    expect(getUnitsByResource(db, 'res_delete')).toEqual([]);
    expect(getIndexState(db, 'res_delete')!.state).toBe(INDEX_STATE_PENDING);
  });

  it('prepare_units_without_embedding_tries_each_resource_once', () => {
    const { db } = freshDb();
    insertResource(db, 'res_prepare', 'content');
    let calls = 0;
    const full = service(db, fakeStore(), {
      unitSync: {
        syncResourceUnits() { calls += 1; },
      },
    });
    expect(full.prepareUnitsWithoutEmbedding(10)).toBe(1);
    expect(full.prepareUnitsWithoutEmbedding(10)).toBe(0);
    expect(calls).toBe(1);
  });

  it('process_pending_batch_claims_and_indexes_pending_resources', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_batch', 'Batch indexing content for keyword search.');
    const info: string[] = [];
    const [success, failed] = await service(db, fakeStore(), { logger: {
      info: message => { info.push(message); }, debug: () => undefined, warn: () => undefined, error: () => undefined,
    } }).processPendingBatch(5);
    expect([success, failed]).toEqual([1, 0]);
    expect(getIndexState(db, 'res_batch')!.state).toBe(INDEX_STATE_INDEXED);
    expect(info[0]).toBe('[VfsFullIndexingService] Processing 1 claimed pending resources (max_concurrent=2)');
    expect(info).toContain('[VfsFullIndexingService] Indexed res_batch (1 chunks)');
    expect(info.at(-1)).toBe('[VfsFullIndexingService] Batch complete: 1 success, 0 failed');
  });

  it('drain_lance_orphan_queue_removes_successful_rows_and_backs_off_failures', async () => {
    const { db } = freshDb();
    db.run(
      `INSERT INTO __lance_orphan_queue (lance_row_id, resource_id) VALUES ('row-1', 'res_x')`,
    );
    const store = fakeStore();
    const full = service(db, store);
    expect(await full.drainLanceOrphanQueue(10)).toBe(1);
    expect(store.sweeps).toBe(1);
    expect(db.pluck<unknown>('SELECT COUNT(*) FROM __lance_orphan_queue')).toBe(0);

    db.run(
      `INSERT INTO __lance_orphan_queue (lance_row_id, resource_id) VALUES ('row-2', 'res_x')`,
    );
    store.deleteShouldFail = true;
    expect(await full.drainLanceOrphanQueue(10)).toBe(0);
    const retry = db.get<Row>(
      'SELECT retry_count, next_retry_at FROM __lance_orphan_queue WHERE lance_row_id = ?1',
      ['row-2'],
    )!;
    expect(Number(retry['retry_count'])).toBe(1);
    expect(Number(retry['next_retry_at'])).toBeGreaterThan(Date.now());
  });

  it('index_question_writes_unit_segments_and_index_exam_questions_counts_success', async () => {
    const { db } = freshDb();
    insertResource(db, 'exam_1', null, { type: 'exam', sourceId: 'folder_source' });
    const question = {
      id: 'q_1',
      exam_id: 'exam_1',
      content: 'What is 2 + 2?',
      options: [{ key: 'A', content: '4' }, { key: 'B', content: '5' }],
      answer: 'A',
      explanation: 'Basic arithmetic',
      tags: ['math'],
      user_note: 'remember',
    };
    const store = fakeStore();
    const full = service(db, store, { questionRepo: questionRepo([question, { ...question, id: 'q_2' }]) });
    const [count, dim] = await full.indexQuestion('q_1', 'exam_1');
    expect(count).toBeGreaterThan(0);
    expect(dim).toBe(128);
    const unit = getUnitsByResource(db, 'q_1')[0]!;
    expect(unit.textState).toBe('indexed');
    const segments = db.all<Row>(
      'SELECT lance_row_id FROM vfs_index_segments WHERE unit_id = ?1', [unit.id],
    );
    expect(segments.map((row) => row['lance_row_id'])).toEqual(store.rows.map((row) => row.embedding_id));
    expect(await full.indexExamQuestions('exam_1')).toEqual([2, 0]);
  });

  it('index_resource_records_failures_with_retry_state', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_fail', 'Failure content.');
    const store = fakeStore();
    store.writeChunks = async () => { throw new Error('embedding write failed'); };
    await expect(service(db, store).indexResource('res_fail')).rejects.toThrow('embedding write failed');
    const state = getIndexState(db, 'res_fail')!;
    expect(state.state).toBe(INDEX_STATE_FAILED);
    expect(state.retry_count).toBe(1);
    expect(getUnitsByResource(db, 'res_fail')[0]!.textState).toBe('failed');
  });
});

describe('Rust vfs/indexing.rs content resolution and search', () => {
  it('has_valid_text_counts_trimmed_unicode_characters', () => {
    expect(hasValidText(' 你好 ', 2)).toBe(true);
    expect(hasValidText(' 你好 ', 3)).toBe(false);
    expect(hasValidText(null, 1)).toBe(false);
  });

  it('parse_ocr_pages_json_supports_legacy_and_pipeline_formats', () => {
    expect(parseOcrPagesJson('["a", null, "__OCR_FAILED__"]')).toEqual(['a', null, null]);
    expect(parseOcrPagesJson(JSON.stringify({
      totalPages: 2,
      pages: [
        { pageIndex: 1, blocks: [{ text: 'second' }] },
        { pageIndex: 0, blocks: [], text: 'first' },
      ],
    }))).toEqual(['first', 'second']);
    expect(joinOcrPagesText(['a', null, 'b'])).toContain('--- 第 1 页 ---');
  });

  it('resolve_indexable_content_prefers_cached_ocr_and_file_text', () => {
    const { db } = freshDb();
    insertResource(db, 'res_file', null, { type: 'file', sourceId: 'file_1' });
    db.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, extracted_text, created_at, updated_at)
       VALUES ('file_1', 'res_file', 'sha', 'a.pdf', 1, 'file text longer', '0', '0')`,
    );
    expect(resolveIndexableContent(db, {
      id: 'res_file', hash: 'h', resourceType: 'file', sourceId: 'file_1',
      sourceTable: 'files', storageMode: 'external', data: null, metadataJson: null,
    })).toBe('file text longer');
    // The real L11 conditional cache (indexing.rs:1082) stored it without touching updated_at.
    expect(db.get("SELECT ocr_text, updated_at FROM resources WHERE id = 'res_file'"))
      .toEqual({ ocr_text: 'file text longer', updated_at: 1 });
    db.run("UPDATE resources SET ocr_text = 'cached ocr' WHERE id = 'res_file'");
    expect(resolveIndexableContent(db, {
      id: 'res_file', hash: 'h', resourceType: 'file', sourceId: 'file_1',
      sourceTable: 'files', storageMode: 'external', data: null, metadataJson: null,
    })).toBe('cached ocr');
  });

  it('resolve_indexable_pages_reads_textbook_ocr_pages', () => {
    const { db } = freshDb();
    insertResource(db, 'res_tb', null, { type: 'textbook', sourceId: 'tb_1' });
    db.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, ocr_pages_json, created_at, updated_at)
       VALUES ('tb_1', 'res_tb', 'sha', 'a.pdf', 1, ?1, '0', '0')`,
      [JSON.stringify(['page one', 'page two'])],
    );
    const pages = resolveIndexablePages(db, {
      id: 'res_tb', hash: 'h', resourceType: 'textbook', sourceId: 'tb_1',
      sourceTable: 'files', storageMode: 'external', data: null, metadataJson: null,
    });
    expect(pages).toEqual([
      { page_index: 0, text: 'page one', source_id: 'tb_1' },
      { page_index: 1, text: 'page two', source_id: 'tb_1' },
    ]);
  });

  it('search_service_reads_committed_segments_and_embedding_stats', () => {
    const { db } = freshDb();
    insertResource(db, 'res_search', 'searchable content');
    new VfsIndexingService(db).indexResource('res_search', 128);
    const search = new VfsSearchService(db);
    const hits = search.searchFts('searchable', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.resourceId).toBe('res_search');
    expect(hits[0]!.score).toBe(1);
    const stats = search.getEmbeddingStats();
    expect(stats.totalEmbeddings).toBeGreaterThan(0);
    expect(stats.totalResourcesIndexed).toBe(1);
    expect(stats.dimensions.find((dim) => dim.dimension === 128)?.recordCount).toBeGreaterThan(0);
  });
});

describe('Rust vfs/lance_store_stub.rs', () => {
  it('stub_reads_are_empty_deletes_succeed_and_writes_fail_explicitly', async () => {
    const { VfsLanceDisabled, LANCE_DISABLED_MSG } = await import('../src/lance-disabled.ts');
    const stub = new VfsLanceDisabled();
    expect(await stub.vectorSearchProfileFull('p', [1, 2], 10, null, null, null)).toEqual([]);
    expect(await stub.ftsSearchProfileFull('p', 'query', 10, null, null, null)).toEqual([]);
    expect(await stub.getTableStats('text')).toEqual([]);
    expect(await stub.deleteByResource('text', 'res')).toBe(0);
    expect(await stub.clearAll('text')).toBe(0);
    expect(await stub.optimizeAll('text')).toBe(0);
    expect(await stub.sweepRetiredProfileTables()).toBe(0);
    expect(() => stub.nextUnitGeneration('unit', 'text')).toThrow(LANCE_DISABLED_MSG);
    expect(() => stub.ensureModelProfileWithFingerprint('text', 128, 'c', 'm', 'f'))
      .toThrow(LANCE_DISABLED_MSG);
    await expect(stub.writeChunks('text', [])).rejects.toThrow(LANCE_DISABLED_MSG);
    await expect(stub.writeChunks('text', [])).rejects.toMatchObject({
      code: 'VFS_INVALID_OPERATION', message: `INVALID_STATE: ${LANCE_DISABLED_MSG}`,
    });
  });
});

describe('Rust indexing.rs::index_resource_with_options unit sync and folder routing', () => {
  function canonicalQuestion(): Record<string, unknown> {
    return {
      id: 'q_1', materials: [], group_id: null, group_label: null, group_position: null,
      question_label: '1', content: '2 + 2 = ?', question_type: 'single_choice', options: [],
      answer: '4', explanation: null, structured_data: null, images: [], source_refs: [],
    };
  }

  function insertExamSheet(db: DatabaseHandle, resourceId: string): void {
    insertResource(db, resourceId, '{}', { type: 'exam' });
    db.run(
      `INSERT INTO exam_sheets (id, resource_id, temp_id, status, metadata_json, preview_json, created_at, updated_at)
       VALUES ('exam_rf', ?1, 'tmp_rf', 'completed', '{}', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [resourceId],
    );
  }

  it('RF-W04-exam-unit-canonical-text: exam units carry the canonical question text Rust drops', async () => {
    const { getIndexingUnitSource } = await import('../repository/unit-sync.ts');
    const { UnitBuilderRegistry } = await import('../src/unit-builders.ts');
    const { db } = freshDb();
    insertExamSheet(db, 'res_exam_rf');
    const repositories = {
      questions: {
        canonicalQuestions: () => [canonicalQuestion()],
        canonicalText: () => '1. 2 + 2 = ?',
      },
    } as unknown as VfsReposService;

    const input = getIndexingUnitSource(db, 'res_exam_rf', repositories)!;
    const units = new UnitBuilderRegistry().build(input)!.units;
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ unitIndex: 0, textContent: '1. 2 + 2 = ?', textSource: 'ocr' });
    // Rust indexing.rs:2149 feeds this shape to ExamBuilder; parse_ocr_pages_json rejects it,
    // so the Rust unit text is NULL and unified_retriever's u.text_content route never matches.
    expect(parseOcrPagesJson(JSON.stringify([{ page_index: 0, text: '1. 2 + 2 = ?' }]))).toEqual([]);
  });

  it('note index_resource writes the NoteBuilder unit and returns (count, dim) like Rust (indexing.rs:2238-2966)', async () => {
    const { VfsUnitIndexService } = await import('../src/unit-sync-service.ts');
    const { db } = freshDb();
    const owner = bindRealOwner(db);
    const text = '用户喜欢跑步';
    insertResource(db, 'res_note_parity', text);
    const units = new VfsUnitIndexService({ database: db, repositories: () => owner });
    const store = fakeStore();
    const result = await service(db, store, { unitSync: {
      syncResourceUnits: (id: string) => units.syncResourceUnitsForResource(id).length,
    } }).indexResource('res_note_parity');

    expect(result).toEqual([1, 128]);
    const rows = db.all<Row>(
      `SELECT unit_index, text_content, text_source, content_hash, text_required, text_state,
              text_chunk_count, text_embedding_dim, mm_required, mm_state
         FROM vfs_index_units WHERE resource_id = 'res_note_parity'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      unit_index: 0, text_content: text, text_source: 'native', text_required: 1,
      text_state: 'indexed', text_chunk_count: 1, text_embedding_dim: 128, mm_required: 0, mm_state: 'disabled',
    });
    expect(rows[0]!['content_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(getIndexState(db, 'res_note_parity')).toMatchObject({ state: INDEX_STATE_INDEXED, hash: 'hash-res_note_parity' });
  });

  it('parse_ocr_pages_json_rejects_arrays_with_non_string_elements (ocr_utils.rs:44-85)', () => {
    expect(parseOcrPagesJson('[{"page_index":0,"text":"a"}]')).toEqual([]);
    expect(parseOcrPagesJson('[1, "a"]')).toEqual([]);
    expect(parseOcrPagesJson('[null, "a", " "]')).toEqual([null, 'a', null]);
  });

  it('RF-W04-exam-unit-canonical-text: exam units re-sync on every index like Rust, even when the hash is unchanged', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_exam_sync', 'Exam content long enough to produce one text chunk.', { type: 'exam', state: 'indexed' });
    db.run(`UPDATE resources SET index_hash = hash WHERE id = 'res_exam_sync'`);
    const owner = bindRealOwner(db);
    owner.embeddingUnits.create(db, { resourceId: 'res_exam_sync', unitIndex: 0,
      imageBlobHash: null, imageMimeType: null, textContent: 'stale exam text', textSource: 'ocr' });
    db.run(`UPDATE vfs_index_units SET text_state = 'indexed' WHERE resource_id = 'res_exam_sync'`);
    let syncs = 0;
    await service(db, fakeStore(), { unitSync: { syncResourceUnits() { syncs += 1; } } })
      .indexResource('res_exam_sync');
    expect(syncs).toBe(1);
  });

  it('RF-W04-empty-text-additional-units-folder: additional units of an empty resource keep the folder id', async () => {
    const { db } = freshDb();
    insertResource(db, 'res_empty_main', null, { type: 'translation' });
    const owner = bindRealOwner(db);
    owner.embeddingUnits.create(db, { resourceId: 'res_empty_main', unitIndex: 1,
      imageBlobHash: null, imageMimeType: null,
      textContent: 'Additional OCR text long enough to produce one chunk.', textSource: 'ocr' });
    const store = fakeStore();
    expect(await service(db, store, { unitSync: { syncResourceUnits() { return 0; } } })
      .indexResource('res_empty_main', 'fld_rf')).toEqual([0, 0]);
    expect(store.rows.length).toBeGreaterThan(0);
    // Rust indexing.rs:2535 passes None here, so these rows fail lance `folder_id IN (...)` filters.
    expect(store.rows.every(row => row.folder_id === 'fld_rf')).toBe(true);
  });
});
