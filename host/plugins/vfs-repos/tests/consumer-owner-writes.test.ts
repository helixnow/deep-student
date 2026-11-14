import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import type { DatabaseHandle, Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { VfsReposService } from '../api.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
let repos: VfsReposService;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-consumer-owner-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble() } });
  db = storage.database('vfs');
  repos = host.ctx.vfsRepo;
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

function resource(id: string): void {
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ocr_text, metadata_json,
      index_state, ref_count, created_at, updated_at)
    VALUES (?1, ?1, 'file', 'inline', 'source', 'ocr', '{"old":true}', 'indexed', 3, 10, 11)`, [id]);
}
function file(id: string, extractedText: string | null = 'old text'): void {
  db.run(`INSERT INTO files (id, resource_id, sha256, file_name, original_path, size, type, extracted_text,
      status, created_at, updated_at, deleted_at)
    VALUES (?1, NULL, ?1, 'book.pdf', '/old/book.pdf', 5, 'textbook', ?2, 'active',
      '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL)`, [id, extractedText]);
}
function resourceRow(id: string, conn: SqlExecutor = db): Row {
  return conn.one('SELECT * FROM resources WHERE id = ?1', [id]);
}
function fileRow(id: string, conn: SqlExecutor = db): Row {
  return conn.one('SELECT * FROM files WHERE id = ?1', [id]);
}
function rejectTrigger(table: string, column: string): void {
  db.exec(`CREATE TRIGGER reject_${column} BEFORE UPDATE OF ${column} ON ${table}
    BEGIN SELECT RAISE(ABORT, '${column} rejected'); END`);
}
function sqlErrorOf(run: () => void): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('expected the owner write to throw');
}

const METADATA = '{"name":"T","title":"T","mimeType":"text/markdown","size":3,"source":"https://e.x/"}';
const RUST_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('consumer owner writes (WP-020)', { timeout: 120_000 }, () => {
  it('updateResourceMetadataWithConn writes metadata_json/updated_at verbatim and nothing else', () => {
    resource('res_web');
    resource('res_other');
    const before = resourceRow('res_web');
    const other = resourceRow('res_other');
    const raw = ' {"z":1, "a":[2]} ';
    expect(repos.resources.updateResourceMetadataWithConn(db, 'res_web', raw, 1_730_000_000_123)).toBeUndefined();
    expect(resourceRow('res_web')).toEqual({ ...before, metadata_json: raw, updated_at: 1_730_000_000_123 });
    expect(resourceRow('res_other')).toEqual(other);
    repos.resources.updateResourceMetadataWithConn(db, 'res_web', METADATA, 1_730_000_000_456);
    expect(repos.resources.getResource(db, 'res_web')).toMatchObject({
      metadata: JSON.parse(METADATA), updatedAt: 1_730_000_000_456, refCount: 3, data: 'source',
    });

    expect(() => repos.resources.updateResourceMetadataWithConn(db, 'res_missing', METADATA, 1)).not.toThrow();
    expect(db.pluck('SELECT COUNT(*) FROM resources')).toBe(2);
    expect(db.pluck("SELECT COUNT(*) FROM resources WHERE id = 'res_missing'")).toBe(0);
  });

  it('setMediaExtractedTextWithConn writes text or NULL as given, without updated_at or a deleted filter', () => {
    file('file_media');
    file('file_other');
    const before = fileRow('file_media');
    const other = fileRow('file_other');
    for (const text of ['[00:01] 第一句\n[00:05] 第二句', '', null] as const) {
      expect(repos.files.setMediaExtractedTextWithConn(db, 'file_media', text)).toBeUndefined();
      expect(fileRow('file_media')).toEqual({ ...before, extracted_text: text });
    }
    expect(fileRow('file_other')).toEqual(other);

    db.run("UPDATE files SET deleted_at = '2001-01-01T00:00:00.000Z' WHERE id = 'file_other'");
    repos.files.setMediaExtractedTextWithConn(db, 'file_other', 'still written');
    expect(fileRow('file_other').extracted_text).toBe('still written');

    expect(() => repos.files.setMediaExtractedTextWithConn(db, 'file_missing', 'x')).not.toThrow();
    expect(() => repos.files.setMediaExtractedTextWithConn(db, 'file_missing', null)).not.toThrow();
    expect(db.pluck('SELECT COUNT(*) FROM files')).toBe(2);
  });

  it('textbooks.setOriginalPathWithConn is the relink entry: original_path + Rust-format updated_at only', () => {
    file('file_tb');
    file('file_other');
    const before = fileRow('file_tb');
    const other = fileRow('file_other');
    expect(repos.textbooks.setOriginalPathWithConn(db, 'file_tb', '/新/路径/book.pdf')).toBe(1);
    const after = fileRow('file_tb');
    expect(after.updated_at).toMatch(RUST_MILLIS);
    expect(after).toEqual({ ...before, original_path: '/新/路径/book.pdf', updated_at: after.updated_at });
    expect(fileRow('file_other')).toEqual(other);

    expect(repos.textbooks.setOriginalPathWithConn(db, 'file_missing', '/x')).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM files')).toBe(2);
  });

  it('all three writes run on the caller isolated transaction and roll back with it', async () => {
    resource('res_web');
    file('file_media');
    file('file_tb');
    const resourcesBefore = db.all('SELECT * FROM resources ORDER BY id');
    const filesBefore = db.all('SELECT * FROM files ORDER BY id');
    const tx = await db.begin();
    try {
      repos.resources.updateResourceMetadataWithConn(tx, 'res_web', METADATA, 99);
      repos.files.setMediaExtractedTextWithConn(tx, 'file_media', null);
      expect(repos.textbooks.setOriginalPathWithConn(tx, 'file_tb', '/new.pdf')).toBe(1);
      expect(resourceRow('res_web', tx)).toMatchObject({ metadata_json: METADATA, updated_at: 99 });
      expect(fileRow('file_media', tx).extracted_text).toBeNull();
      expect(fileRow('file_tb', tx).original_path).toBe('/new.pdf');
      expect(fileRow('file_tb', tx).updated_at).toMatch(RUST_MILLIS);
      expect(db.all('SELECT * FROM resources ORDER BY id')).toEqual(resourcesBefore);
      expect(db.all('SELECT * FROM files ORDER BY id')).toEqual(filesBefore);
    } finally { await tx.rollback(); }
    expect(db.all('SELECT * FROM resources ORDER BY id')).toEqual(resourcesBefore);
    expect(db.all('SELECT * FROM files ORDER BY id')).toEqual(filesBefore);
  });

  it('commits only through the caller transaction; a later failure in it undoes the owner write', () => {
    file('file_media');
    const before = fileRow('file_media');
    // bilibili.rs:1003-1016: the transcript write shares the caller transaction.
    expect(() => db.transaction(tx => {
      repos.files.setMediaExtractedTextWithConn(tx, 'file_media', '[00:00] cue');
      throw new Error('later step failed');
    })).toThrow('later step failed');
    expect(fileRow('file_media')).toEqual(before);

    db.transaction(tx => { repos.files.setMediaExtractedTextWithConn(tx, 'file_media', '[00:00] cue'); });
    expect(fileRow('file_media')).toEqual({ ...before, extracted_text: '[00:00] cue' });
  });

  it.each([
    ['updateResourceMetadataWithConn', 'resources', 'metadata_json'],
    ['setMediaExtractedTextWithConn', 'files', 'extracted_text'],
    ['setOriginalPathWithConn', 'files', 'original_path'],
  ] as const)('%s propagates the original SQL error unwrapped and leaves the row intact', (method, table, column) => {
    resource('target');
    file('target');
    const before = { resource: resourceRow('target'), file: fileRow('target') };
    rejectTrigger(table, column);
    const call = (): void => {
      if (method === 'updateResourceMetadataWithConn') repos.resources[method](db, 'target', METADATA, 5);
      else if (method === 'setMediaExtractedTextWithConn') repos.files[method](db, 'target', 'new');
      else repos.textbooks[method](db, 'target', '/new');
    };
    const error = sqlErrorOf(call);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as Error).message).toBe(`${column} rejected`);
    expect({ resource: resourceRow('target'), file: fileRow('target') }).toEqual(before);
  });
});
