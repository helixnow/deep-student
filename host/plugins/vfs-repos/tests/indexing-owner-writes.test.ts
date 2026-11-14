import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@deepseek-ai/cordis';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { StorageError, type DatabaseHandle, type Row, type SqlExecutor } from '../../../platform/storage/api.ts';
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
let logs: Message[];
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-indexing-owner-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble() } });
  db = storage.database('vfs');
  repos = host.ctx.vfsRepo;
  logs = [];
  host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

function resource(id: string, text: string | null = null): void {
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ocr_text, created_at, updated_at)
    VALUES (?1, ?1, 'file', 'inline', 'source', ?2, 10, 11)`, [id, text]);
}
function resourceRow(id: string, conn: SqlExecutor = db): Row {
  return conn.one('SELECT * FROM resources WHERE id = ?1', [id]);
}
function unitRow(id: string, conn: SqlExecutor = db): Row {
  return conn.one('SELECT * FROM vfs_index_units WHERE id = ?1', [id]);
}
function logMessages(level: string): string[] {
  return logs.filter(message => message.type === level).map(message => message.args.map(String).join(' '));
}
const recovered = 'recovered: interrupted by crash';

// indexing.rs:3777-3785: one resource-id UPDATE on the supplied connection,
// SQLite datetime('now'), raw SQL errors; the L12 caller owns the warning.
describe('WP-201 PDF OCR recovery cache owner', { timeout: 120_000 }, () => {
  it('writes only OCR and SQLite text timestamp by resource id, including deleted rows; missing is successful', () => {
    resource('res_target', 'old');
    resource('res_other', 'keep');
    db.run("UPDATE resources SET source_id = 'file_source', deleted_at = 99 WHERE id = 'res_target'");
    const before = resourceRow('res_target');
    const other = resourceRow('res_other');
    for (const text of ['识别结果\n\n第二页', '', ' \n']) {
      const start = db.pluck<string>("SELECT datetime('now')")!;
      expect(repos.resources.saveOcrTextWithSqlTimestampWithConn(db, 'res_target', text)).toBeUndefined();
      const after = resourceRow('res_target');
      expect(after.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(db.pluck("SELECT typeof(updated_at) FROM resources WHERE id = 'res_target'")).toBe('text');
      expect(db.pluck("SELECT updated_at BETWEEN ?1 AND datetime('now') FROM resources WHERE id = 'res_target'", [start])).toBe(1);
      expect(after).toEqual({ ...before, ocr_text: text, updated_at: after.updated_at });
      expect(resourceRow('res_other')).toEqual(other);
    }
    const rows = db.all('SELECT * FROM resources ORDER BY id');
    expect(repos.resources.saveOcrTextWithSqlTimestampWithConn(db, 'missing', 'ignored')).toBeUndefined();
    expect(repos.resources.saveOcrTextWithSqlTimestampWithConn(db, 'file_source', 'ignored')).toBeUndefined();
    expect(db.all('SELECT * FROM resources ORDER BY id')).toEqual(rows);
    expect(logs).toEqual([]);
  });

  it('uses the isolated caller transaction and rolls back both columns with it', async () => {
    resource('res_tx', 'old');
    const before = resourceRow('res_tx');
    const tx = await db.begin();
    try {
      repos.resources.saveOcrTextWithSqlTimestampWithConn(tx, 'res_tx', 'transaction OCR');
      const inside = resourceRow('res_tx', tx);
      expect(inside.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(inside).toEqual({ ...before, ocr_text: 'transaction OCR', updated_at: inside.updated_at });
      expect(resourceRow('res_tx')).toEqual(before);
    } finally { await tx.rollback(); }
    expect(resourceRow('res_tx')).toEqual(before);
  });

  it('propagates a real SQLite trigger error without a repository prefix or owner log', () => {
    resource('res_blocked', 'old');
    const before = resourceRow('res_blocked');
    db.exec(`CREATE TRIGGER reject_ocr_timestamp BEFORE UPDATE OF ocr_text ON resources
      BEGIN SELECT RAISE(ABORT, 'OCR recovery cache rejected'); END`);
    let failure: unknown;
    try { repos.resources.saveOcrTextWithSqlTimestampWithConn(db, 'res_blocked', 'new'); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({
      message: 'OCR recovery cache rejected', code: 'SQLITE', sqliteCode: 'SQLITE_CONSTRAINT_TRIGGER',
    });
    expect(resourceRow('res_blocked')).toEqual(before);
    expect(logs).toEqual([]);
  });

  it('keeps generic saveOcrText millisecond timestamps and Database error wrapping', () => {
    resource('res_generic', 'old');
    const before = resourceRow('res_generic');
    const start = Date.now();
    repos.resources.saveOcrText(db, 'res_generic', 'generic OCR');
    const after = resourceRow('res_generic');
    expect(after.updated_at).toBeGreaterThanOrEqual(start);
    expect(after.updated_at).toBeLessThanOrEqual(Date.now());
    expect(db.pluck("SELECT typeof(updated_at) FROM resources WHERE id = 'res_generic'")).toBe('integer');
    expect(after).toEqual({ ...before, ocr_text: 'generic OCR', updated_at: after.updated_at });
    db.exec(`CREATE TRIGGER reject_generic_ocr BEFORE UPDATE OF ocr_text ON resources
      BEGIN SELECT RAISE(ABORT, 'generic cache rejected'); END`);
    expect(() => repos.resources.saveOcrText(db, 'res_generic', 'new'))
      .toThrow(/^Database error: generic cache rejected$/);
    expect(resourceRow('res_generic')).toEqual(after);
  });
});

function stuck(id: string, textState: string | null, mmState: string | null): void {
  resource(id);
  db.run(`UPDATE resources SET index_state = ?2, mm_index_state = ?3,
    index_error = 'text-old', index_retry_count = 7, index_next_retry_at = 101,
    mm_index_error = 'mm-old', mm_index_retry_count = 8, mm_index_next_retry_at = 102
    WHERE id = ?1`, [id, textState, mmState]);
  db.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_required, mm_required,
    text_state, mm_state, text_error, mm_error, text_indexed_at, mm_indexed_at,
    text_chunk_count, text_embedding_dim, mm_embedding_dim, text_generation, mm_generation,
    created_at, updated_at)
    VALUES (?1, ?1, 0, 0, 0, ?2, ?3, 'text-old', 'mm-old', 20, 21, 5, 768, 1024, 4, 6, 10, 11)`,
  [id, textState ?? 'disabled', mmState ?? 'disabled']);
}

describe('indexing.rs owner writes (WP-001)', { timeout: 120_000 }, () => {
  it('conditional OCR caches only NULL/empty, preserves whitespace and all other columns', () => {
    for (const [id, text] of [['null', null], ['empty', ''], ['full', 'existing'], ['space', ' \n']] as const) {
      resource(id, text);
      const before = resourceRow(id);
      expect(repos.resources.saveOcrTextIfEmptyWithConn(db, id, '识别结果')).toBeUndefined();
      expect(resourceRow(id)).toEqual({ ...before, ocr_text: text === null || text === '' ? '识别结果' : text });
    }
    expect(() => repos.resources.saveOcrTextIfEmptyWithConn(db, 'missing', 'ignored')).not.toThrow();
    expect(db.pluck('SELECT COUNT(*) FROM resources')).toBe(4);
  });

  it('unconditional OCR overwrites without timestamps, normalization or a missing-row error', () => {
    resource('image', 'old');
    const before = resourceRow('image');
    for (const text of ['新文本', '', ' \n']) {
      expect(repos.resources.saveOcrTextWithoutTimestampWithConn(db, 'image', text)).toBeUndefined();
      expect(resourceRow('image')).toEqual({ ...before, ocr_text: text });
    }
    expect(() => repos.resources.saveOcrTextWithoutTimestampWithConn(db, 'missing', 'ignored')).not.toThrow();
    expect(db.pluck('SELECT COUNT(*) FROM resources')).toBe(1);
  });

  it('both OCR methods use the caller isolated transaction and roll back with it', async () => {
    resource('conditional');
    resource('unconditional', 'old');
    const before = db.all('SELECT * FROM resources ORDER BY id');
    const tx = await db.begin();
    try {
      repos.resources.saveOcrTextIfEmptyWithConn(tx, 'conditional', 'one');
      repos.resources.saveOcrTextWithoutTimestampWithConn(tx, 'unconditional', 'two');
      expect(resourceRow('conditional', tx).ocr_text).toBe('one');
      expect(resourceRow('unconditional', tx).ocr_text).toBe('two');
      expect(db.all('SELECT * FROM resources ORDER BY id')).toEqual(before);
    } finally { await tx.rollback(); }
    expect(db.all('SELECT * FROM resources ORDER BY id')).toEqual(before);
  });

  it.each(['saveOcrTextIfEmptyWithConn', 'saveOcrTextWithoutTimestampWithConn'] as const)(
    '%s propagates the original SQL error for the caller best-effort warning', method => {
      resource('blocked');
      const before = resourceRow('blocked');
      db.exec(`CREATE TRIGGER reject_ocr BEFORE UPDATE OF ocr_text ON resources
        BEGIN SELECT RAISE(ABORT, 'cache rejected'); END`);
      expect(() => repos.resources[method](db, 'blocked', 'new')).toThrow(/^cache rejected$/);
      expect(resourceRow('blocked')).toEqual(before);
      expect(logMessages('warn')).toEqual([]);
    });

  it('recover_stuck_indexing matches each route, preserves unrelated columns and counts both unit routes', () => {
    stuck('text', 'indexing', 'failed');
    stuck('mm', 'indexed', 'indexing');
    stuck('both', 'indexing', 'indexing');
    stuck('text-null', 'indexing', null);
    stuck('null-mm', null, 'indexing');
    for (const state of ['pending', 'indexed', 'failed', 'disabled', null]) stuck(`keep-${state}`, state, state);
    const beforeResources = db.all('SELECT * FROM resources ORDER BY id');
    const beforeUnits = db.all('SELECT * FROM vfs_index_units ORDER BY id');
    // No deleted/required filter exists in Rust.
    db.run("UPDATE resources SET deleted_at = 99 WHERE id = 'both'");
    beforeResources.find(row => row.id === 'both')!.deleted_at = 99;

    expect(repos.maintenance.recoverStuckIndexingWithConn(db, 1234)).toBe(11);
    for (const before of beforeUnits) {
      const expected = { ...before };
      if (before.text_state === 'indexing') Object.assign(expected, { text_state: 'pending', text_error: recovered, updated_at: 1234 });
      if (before.mm_state === 'indexing') Object.assign(expected, { mm_state: 'pending', mm_error: recovered, updated_at: 1234 });
      expect(unitRow(String(before.id))).toEqual(expected);
    }
    for (const before of beforeResources) {
      const expected = { ...before };
      if (before.index_state === 'indexing') Object.assign(expected, {
        index_state: 'pending', index_error: recovered, index_retry_count: 0, index_next_retry_at: 0,
      });
      if (before.mm_index_state === 'indexing') Object.assign(expected, {
        mm_index_state: 'pending', mm_index_error: recovered, mm_index_retry_count: 0, mm_index_next_retry_at: 0,
      });
      expect(resourceRow(String(before.id))).toEqual(expected);
    }
    expect(logMessages('warn')).toEqual([
      '[VfsFullIndexingService] Recovered 11 stuck indexing records at startup (text_units=3, mm_units=3, resources=5)',
    ]);
    expect(repos.maintenance.recoverStuckIndexingWithConn(db, 5678)).toBe(0);
    expect(logMessages('debug')).toContain('[VfsFullIndexingService] No stuck indexing records found at startup');
    expect(unitRow('both').updated_at).toBe(1234);
    expect(resourceRow('both').updated_at).toBe(11);
  });

  it('recover_stuck_indexing uses the supplied connection and leaves commit/rollback to its caller', async () => {
    stuck('both', 'indexing', 'indexing');
    const beforeResource = resourceRow('both');
    const beforeUnit = unitRow('both');
    const tx = await db.begin();
    try {
      expect(repos.maintenance.recoverStuckIndexingWithConn(tx, 1234)).toBe(3);
      expect(unitRow('both', tx)).toEqual({ ...beforeUnit,
        text_state: 'pending', text_error: recovered, mm_state: 'pending', mm_error: recovered, updated_at: 1234 });
      expect(resourceRow('both', tx)).toEqual({ ...beforeResource,
        index_state: 'pending', index_error: recovered, index_retry_count: 0, index_next_retry_at: 0,
        mm_index_state: 'pending', mm_index_error: recovered, mm_index_retry_count: 0, mm_index_next_retry_at: 0 });
      expect(resourceRow('both')).toEqual(beforeResource);
      expect(unitRow('both')).toEqual(beforeUnit);
    } finally { await tx.rollback(); }
    expect(resourceRow('both')).toEqual(beforeResource);
    expect(unitRow('both')).toEqual(beforeUnit);
  });

  it.each([
    ['text', 'vfs_index_units', 'text_state', 0, 1, 1],
    ['mm', 'vfs_index_units', 'mm_state', 1, 0, 1],
    ['resources', 'resources', 'index_state', 1, 1, 0],
  ] as const)('recover_stuck_indexing warns and continues after %s UPDATE fails', (branch, table, column, text, mm, resources) => {
    stuck('both', 'indexing', 'indexing');
    db.exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE OF ${column} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'reject ${branch}'); END`);
    expect(repos.maintenance.recoverStuckIndexingWithConn(db, 1234)).toBe(2);
    expect(unitRow('both').text_state).toBe(text ? 'pending' : 'indexing');
    expect(unitRow('both').mm_state).toBe(mm ? 'pending' : 'indexing');
    expect(resourceRow('both').index_state).toBe(resources ? 'pending' : 'indexing');
    expect(resourceRow('both').mm_index_state).toBe(resources ? 'pending' : 'indexing');
    expect(logMessages('warn')).toEqual([
      `[VfsFullIndexingService] Failed to recover stuck state: reject ${branch}`,
      `[VfsFullIndexingService] Recovered 2 stuck indexing records at startup (text_units=${text}, mm_units=${mm}, resources=${resources})`,
    ]);
  });

  it('recover_stuck_indexing preserves best-effort prepare failures and zero-total debug on old schemas', () => {
    const old = storage.openFile(`${root}/old.db`);
    try {
      expect(repos.maintenance.recoverStuckIndexingWithConn(old, 1234)).toBe(0);
      expect(logMessages('warn')).toEqual([
        '[VfsFullIndexingService] Failed to recover stuck state: no such table: vfs_index_units',
        '[VfsFullIndexingService] Failed to recover stuck state: no such table: vfs_index_units',
        '[VfsFullIndexingService] Failed to recover stuck state: no such table: resources',
      ]);
      expect(logMessages('debug')).toEqual(['[VfsFullIndexingService] No stuck indexing records found at startup']);
    } finally { storage.close(old); }
  });
});
