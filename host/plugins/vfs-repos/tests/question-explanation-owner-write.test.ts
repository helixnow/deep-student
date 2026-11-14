import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import { StorageError, type DatabaseHandle, type Row, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { QuestionRepository } from '../api.ts';
import plugin from '../index.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
let repo: QuestionRepository;
const OLD = '2000-01-01T00:00:00Z';
const SQLITE_NOW = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-explanation-owner-'));
  host = await createTestHost({ plugins: [plugin], provide: {
    storage, paths: pathsServiceDouble(), notes: notesServiceDouble(() => storage.database('vfs')),
  } });
  db = storage.database('vfs');
  repo = host.ctx.vfsRepo.questions;
  db.run(`INSERT INTO resources(id,hash,type,storage_mode,ref_count,created_at,updated_at,index_state)
    VALUES ('res','hash','exam','managed',1,0,0,'indexed')`);
  db.run(`INSERT INTO exam_sheets(id,resource_id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at)
    VALUES ('exam','res','exam','completed','exam','{}','{}',?1,?1)`, [OLD]);
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
  await setImmediate();
}, 120_000);

function insert(id: string, explanation: string | null, deletedAt: string | null = null): void {
  db.run(`INSERT INTO questions(id,exam_id,content,explanation,question_type,tags,status,
    created_at,updated_at,sync_status,content_hash,deleted_at)
    VALUES (?1,'exam','stem',?2,'essay','[]','new',?3,?3,'synced','stale',?4)`, [id, explanation, OLD, deletedAt]);
}
function row(id: string, conn: SqlExecutor = db): Row {
  return conn.one('SELECT * FROM questions WHERE id=?1', [id]);
}

describe('WP-216 fill_explanation_if_empty SQL owner (pipeline.rs:680-688)', () => {
  it('fills NULL/empty/each SQL whitespace without history, mark, hash or index invalidation', () => {
    const resource = db.one("SELECT * FROM resources WHERE id='res'");
    insert('other', null);
    const other = row('other');
    for (const [i, value] of [null, '', ' ', '\t', '\n', '\r', ' \t\n\r \n'].entries()) {
      const id = `q${i}`;
      insert(id, value);
      const before = row(id);
      const explanation = ' \n原样解析\t ';
      expect(repo.fillExplanationIfEmpty(db, id, explanation)).toBe(1);
      // Preserve the real schema trigger: only explanation plus its updated_at side effect.
      expect(row(id)).toEqual({ ...before, explanation, updated_at: expect.stringMatching(SQLITE_NOW) });
      expect(repo.fillExplanationIfEmpty(db, id, 'replacement')).toBe(0);
      expect(row(id).explanation).toBe(explanation);
    }
    expect(row('other')).toEqual(other);
    expect(db.all('SELECT * FROM question_history')).toEqual([]);
    expect(db.one("SELECT * FROM resources WHERE id='res'")).toEqual(resource);
  });

  it('returns zero for nonempty, non-SQL whitespace, deleted and missing rows without changing them', () => {
    for (const [i, value] of ['written', ' \t written\r\n', '\u00a0', '\u3000', '\v', '\f'].entries()) {
      const id = `q${i}`;
      insert(id, value);
      const before = row(id);
      expect(repo.fillExplanationIfEmpty(db, id, 'AI')).toBe(0);
      expect(row(id)).toEqual(before);
    }
    for (const [i, value] of [null, ' \t\r\n'].entries()) {
      const id = `deleted${i}`;
      insert(id, value, OLD);
      const before = row(id);
      expect(repo.fillExplanationIfEmpty(db, id, 'AI')).toBe(0);
      expect(row(id)).toEqual(before);
    }
    expect(repo.fillExplanationIfEmpty(db, 'missing', 'AI')).toBe(0);
  });

  it('leaves the incoming Rust trim guard to L14 and binds even blank input verbatim', () => {
    for (const [i, explanation] of ['', ' \t\n\r', '\u3000'].entries()) {
      const id = `q${i}`;
      insert(id, null);
      expect(repo.fillExplanationIfEmpty(db, id, explanation)).toBe(1);
      expect(row(id).explanation).toBe(explanation);
    }
  });

  it('uses the value at UPDATE time after another connection has supplied an explanation', () => {
    insert('q', null);
    expect(row('q').explanation).toBeNull();
    const editor = storage.openFile(db.path, { profile: 'vfs' });
    try { editor.run("UPDATE questions SET explanation='user edit' WHERE id='q'"); }
    finally { storage.close(editor); }
    const edited = row('q');
    expect(repo.fillExplanationIfEmpty(db, 'q', 'delayed AI')).toBe(0);
    expect(row('q')).toEqual(edited);
  });

  it('uses the caller connection: isolated before commit and restored by outer rollback', async () => {
    insert('q', null);
    const before = row('q');
    const tx = await db.begin();
    try {
      expect(repo.fillExplanationIfEmpty(tx, 'q', 'in transaction')).toBe(1);
      expect(row('q', tx)).toEqual({ ...before, explanation: 'in transaction', updated_at: expect.stringMatching(SQLITE_NOW) });
      expect(row('q')).toEqual(before);
    } finally { await tx.rollback(); }
    expect(row('q')).toEqual(before);
    await db.withTransaction(async committed => {
      expect(repo.fillExplanationIfEmpty(committed, 'q', 'committed')).toBe(1);
      expect(row('q')).toEqual(before);
    });
    expect(row('q').explanation).toBe('committed');
  });

  it('rolls back the explanation and timestamp when a later caller step fails', () => {
    insert('q', null);
    const before = row('q');
    const failure = new Error('later history step failed');
    expect(() => db.transaction(tx => {
      expect(repo.fillExplanationIfEmpty(tx, 'q', 'temporary')).toBe(1);
      expect(row('q', tx).explanation).toBe('temporary');
      throw failure;
    })).toThrow(failure);
    expect(row('q')).toEqual(before);
  });

  it('preserves the trigger SQLite error and cause without Database error wrapping', () => {
    insert('q', null);
    const before = row('q');
    db.exec(`CREATE TRIGGER reject_explanation BEFORE UPDATE OF explanation ON questions
      BEGIN SELECT RAISE(ABORT, 'explanation rejected'); END`);
    let caught: unknown;
    try { repo.fillExplanationIfEmpty(db, 'q', 'AI'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StorageError);
    expect(caught).toMatchObject({ code: 'SQLITE', sqliteCode: 'SQLITE_CONSTRAINT_TRIGGER',
      phase: 'execute', message: 'explanation rejected',
      cause: { code: 'SQLITE_CONSTRAINT_TRIGGER', message: 'explanation rejected' } });
    expect(row('q')).toEqual(before);
    expect(db.all('SELECT * FROM question_history')).toEqual([]);
  });
});
