import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { SqliteDatabase } from '../database.ts';
import { PROFILES } from '../profiles.ts';
import { registerNoteAssetRetention } from '../node.ts';
import { SlotOccupied } from '../../../kernel/api.ts';
import {
  DeletionJournalError,
  deleteAssetWithJournal,
  finishAssetDeletionWithConn,
  hashFile,
  insertPreparedIntent,
  prepareAssetDeletionWithConn,
  recoverAssetDeletions,
} from '../file-deletion-queue.ts';

const dirs: string[] = [];
const JOURNAL_SQL = fs.readFileSync('resources/app/migrations/vfs/V20260808__file_deletion_intent_journal.sql', 'utf8');

function setupVfsJournal(): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-deletion-'));
  dirs.push(temp);
  const activeDir = path.join(temp, 'active');
  fs.mkdirSync(path.join(activeDir, 'databases'), { recursive: true });
  const conn = new BetterSqlite3(path.join(activeDir, 'databases', 'vfs.db'));
  conn.exec(
    `CREATE TABLE __blob_deletion_queue (
       hash TEXT PRIMARY KEY,
       relative_path TEXT,
       size INTEGER,
       deleted_at TEXT NOT NULL,
       retry_count INTEGER NOT NULL DEFAULT 0
     );
     CREATE TABLE __asset_deletion_queue (
       key TEXT PRIMARY KEY,
       size INTEGER,
       deleted_at TEXT NOT NULL,
       retry_count INTEGER NOT NULL DEFAULT 0
     );`,
  );
  conn.exec(JOURNAL_SQL);
  conn.close();
  return activeDir;
}

function openVfs(activeDir: string): SqliteDatabase {
  return new SqliteDatabase({
    name: 'vfs',
    path: path.join(activeDir, 'databases', 'vfs.db'),
    profile: PROFILES.vfs,
  });
}

function prepareAsset(activeDir: string, operationId: string, key: string, localPath: string): void {
  const file = path.join(activeDir, localPath);
  const conn = openVfs(activeDir);
  insertPreparedIntent(conn, 'asset', key, localPath, hashFile(file), fs.statSync(file).size, operationId);
  conn.close();
}

function journalState(activeDir: string, operationId: string): string {
  const db = openVfs(activeDir);
  try {
    return db.pluck<string>('SELECT state FROM __file_deletion_journal WHERE operation_id = ?', [operationId])!;
  } finally { db.close(); }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('recovers_crash_after_prepare', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  const file = path.join(activeDir, 'notes_assets/a.bin');
  fs.writeFileSync(file, 'baseline');
  prepareAsset(activeDir, 'op-prepared-crash', 'active/notes_assets/a.bin', 'notes_assets/a.bin');

  expect(recoverAssetDeletions(activeDir)).toBe(1);
  expect(fs.existsSync(file)).toBe(false);
  expect(journalState(activeDir, 'op-prepared-crash')).toBe('ready');
});

it('recovers_crash_after_file_delete', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  const file = path.join(activeDir, 'notes_assets/a.bin');
  fs.writeFileSync(file, 'baseline');
  prepareAsset(activeDir, 'op-delete-crash', 'active/notes_assets/a.bin', 'notes_assets/a.bin');
  fs.unlinkSync(file);

  expect(recoverAssetDeletions(activeDir)).toBe(1);
  const db = openVfs(activeDir);
  try {
    const queued = db.pluck<number>("SELECT COUNT(*) FROM __asset_deletion_queue WHERE key = 'active/notes_assets/a.bin'");
    expect(queued).toBe(1);
  } finally { db.close(); }
});

it('ready_outbox_failure_is_visible_and_recoverable', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  const file = path.join(activeDir, 'notes_assets/a.bin');
  fs.writeFileSync(file, 'baseline');
  const db = openVfs(activeDir);
  db.exec(
    `CREATE TRIGGER fail_asset_outbox
     BEFORE INSERT ON __asset_deletion_queue
     BEGIN
         SELECT RAISE(FAIL, 'injected outbox failure');
     END;`,
  );
  db.close();

  expect(() => deleteAssetWithJournal(activeDir, 'active/notes_assets/a.bin', 'notes_assets/a.bin'))
    .toThrow(/injected outbox failure/);
  expect(fs.existsSync(file)).toBe(false);

  const cleanup = openVfs(activeDir);
  cleanup.exec('DROP TRIGGER fail_asset_outbox');
  cleanup.close();
  expect(recoverAssetDeletions(activeDir)).toBe(1);
});

it('changed_content_cancels_recovery', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  const file = path.join(activeDir, 'notes_assets/a.bin');
  fs.writeFileSync(file, 'baseline');
  prepareAsset(activeDir, 'op-conflict', 'active/notes_assets/a.bin', 'notes_assets/a.bin');
  fs.writeFileSync(file, 'changed');

  let caught: unknown;
  try { recoverAssetDeletions(activeDir); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(DeletionJournalError);
  expect((caught as DeletionJournalError).code).toBe('Conflict');
  expect(fs.readFileSync(file, 'utf8')).toBe('changed');
  expect(journalState(activeDir, 'op-conflict')).toBe('cancelled');
});

it('duplicate_operation_id_is_idempotent_only_for_same_intent', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  fs.writeFileSync(path.join(activeDir, 'notes_assets/a.bin'), 'baseline');
  prepareAsset(activeDir, 'op-duplicate', 'active/notes_assets/a.bin', 'notes_assets/a.bin');

  const db = openVfs(activeDir);
  try {
    const first = db.get<{ operation_id: string; entity_key: string; local_path: string; expected_hash: string; size: number }>(
      'SELECT operation_id, entity_key, local_path, expected_hash, size FROM __file_deletion_journal WHERE operation_id = ?',
      ['op-duplicate'],
    )!;
    const repeated = insertPreparedIntent(db, 'asset', first.entity_key, first.local_path, first.expected_hash, first.size, first.operation_id);
    expect(repeated.operation_id).toBe('op-duplicate');

    let caught: unknown;
    try {
      insertPreparedIntent(db, 'asset', 'active/notes_assets/other.bin', 'notes_assets/other.bin', 'different', 1, 'op-duplicate');
    } catch (error) { caught = error; }
    expect((caught as DeletionJournalError).code).toBe('DuplicateOperation');
    const count = db.pluck<number>("SELECT COUNT(*) FROM __file_deletion_journal WHERE operation_id = 'op-duplicate'");
    expect(count).toBe(1);
  } finally { db.close(); }
});

it('prepared_asset_intent_rolls_back_with_business_metadata', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  const file = path.join(activeDir, 'notes_assets/a.bin');
  fs.writeFileSync(file, 'baseline');
  const db = openVfs(activeDir);
  try {
    db.exec(
      `CREATE TABLE note_asset_metadata (key TEXT PRIMARY KEY);
       INSERT INTO note_asset_metadata(key) VALUES ('active/notes_assets/a.bin');
       SAVEPOINT metadata_and_deletion_intent;`,
    );

    prepareAssetDeletionWithConn(db, activeDir, 'active/notes_assets/a.bin', 'notes_assets/a.bin');
    db.run('DELETE FROM note_asset_metadata WHERE key = ?', ['active/notes_assets/a.bin']);
    db.exec('ROLLBACK TO SAVEPOINT metadata_and_deletion_intent; RELEASE SAVEPOINT metadata_and_deletion_intent;');

    expect(db.pluck('SELECT COUNT(*) FROM note_asset_metadata')).toBe(1);
    expect(db.pluck('SELECT COUNT(*) FROM __file_deletion_journal')).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  } finally { db.close(); }
});

it('missing_local_asset_still_produces_ready_remote_deletion', () => {
  const activeDir = setupVfsJournal();
  const db = openVfs(activeDir);
  try {
    const intent = prepareAssetDeletionWithConn(db, activeDir, 'active/notes_assets/missing.bin', 'notes_assets/missing.bin');
    expect(intent.expected_hash).toBeNull();

    finishAssetDeletionWithConn(db, activeDir, intent);
    const queued = db.pluck<number>("SELECT COUNT(*) FROM __asset_deletion_queue WHERE key = 'active/notes_assets/missing.bin'");
    expect(queued).toBe(1);
  } finally { db.close(); }
});

it('prepare_participates_in_the_caller_transaction_and_rolls_back_with_it', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  const file = path.join(activeDir, 'notes_assets/a.bin');
  fs.writeFileSync(file, 'baseline');
  const db = openVfs(activeDir);
  try {
    db.exec(`CREATE TABLE note_asset_metadata (key TEXT PRIMARY KEY);
             INSERT INTO note_asset_metadata(key) VALUES ('active/notes_assets/a.bin')`);
    expect(() => db.transaction((tx) => {
      prepareAssetDeletionWithConn(tx, activeDir, 'active/notes_assets/a.bin', 'notes_assets/a.bin');
      tx.run('DELETE FROM note_asset_metadata WHERE key = ?', ['active/notes_assets/a.bin']);
      throw new Error('metadata write failed');
    })).toThrow('metadata write failed');

    expect(db.pluck<number>('SELECT COUNT(*) FROM note_asset_metadata')).toBe(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM __file_deletion_journal')).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  } finally { db.close(); }
});

it('committed_intent_finishes_off_transaction_and_outbox_delete_publishes_it', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'), { recursive: true });
  const file = path.join(activeDir, 'notes_assets/a.bin');
  fs.writeFileSync(file, 'baseline');
  const db = openVfs(activeDir);
  try {
    db.exec(`CREATE TABLE note_asset_metadata (key TEXT PRIMARY KEY);
             INSERT INTO note_asset_metadata(key) VALUES ('active/notes_assets/a.bin')`);
    const intent = db.transaction((tx) => {
      const prepared = prepareAssetDeletionWithConn(tx, activeDir, 'active/notes_assets/a.bin', 'notes_assets/a.bin');
      tx.run('DELETE FROM note_asset_metadata WHERE key = ?', ['active/notes_assets/a.bin']);
      return prepared;
    });

    // Physical deletion runs only after COMMIT; a failed business transaction never reaches it.
    finishAssetDeletionWithConn(db, activeDir, intent);
    expect(fs.existsSync(file)).toBe(false);
    expect(journalState(activeDir, intent.operation_id)).toBe('ready');

    db.run('DELETE FROM __asset_deletion_queue WHERE key = ?', ['active/notes_assets/a.bin']);
    expect(journalState(activeDir, intent.operation_id)).toBe('published');
  } finally { db.close(); }
});

it('autocommit_only_workspace_boundary_rejects_a_transaction_executor', async () => {
  const { recoverWorkspaceDeletions, prepareWorkspaceDeletion } = await import('../file-deletion-queue.ts');
  const activeDir = setupVfsJournal();
  const db = openVfs(activeDir);
  try {
    const boundary = db.transaction((tx) => {
      expect(() => recoverWorkspaceDeletions(tx, activeDir)).toThrow(expect.objectContaining({ code: 'TransactionBoundary' }));
      expect(() => prepareWorkspaceDeletion(tx, activeDir, 'w1')).toThrow(expect.objectContaining({ code: 'TransactionBoundary' }));
      return 'checked';
    });
    expect(boundary).toBe('checked');
  } finally { db.close(); }
});

it('register_note_asset_retention holds the first owner until its disposer releases it', () => {
  const activeDir = setupVfsJournal();
  fs.mkdirSync(path.join(activeDir, 'notes_assets'));
  fs.writeFileSync(path.join(activeDir, 'notes_assets/a.bin'), 'retained');
  const db = openVfs(activeDir);
  // Rust :509-527 only consults the callback when the history table exists.
  db.exec('CREATE TABLE note_document_revisions (id TEXT PRIMARY KEY)');
  const first = registerNoteAssetRetention({ assetIsReferenced: () => true });
  try {
    expect(() => registerNoteAssetRetention({ assetIsReferenced: () => false })).toThrow(SlotOccupied);
    expect(() => prepareAssetDeletionWithConn(db, activeDir, 'active/notes_assets/a.bin', 'notes_assets/a.bin'))
      .toThrow(expect.objectContaining({ code: 'ReferencedNoteAsset' }));
    expect(db.pluck('SELECT COUNT(*) FROM __file_deletion_journal')).toBe(0);
    first.dispose(); first.dispose();
    const second = registerNoteAssetRetention({ assetIsReferenced: () => true });
    try {
      first.dispose();
      expect(() => prepareAssetDeletionWithConn(db, activeDir, 'active/notes_assets/a.bin', 'notes_assets/a.bin'))
        .toThrow(expect.objectContaining({ code: 'ReferencedNoteAsset' }));
    } finally { second.dispose(); }
    const intent = prepareAssetDeletionWithConn(db, activeDir, 'active/notes_assets/a.bin', 'notes_assets/a.bin');
    expect(journalState(activeDir, intent.operation_id)).toBe('prepared');
    expect(fs.readFileSync(path.join(activeDir, 'notes_assets/a.bin'), 'utf8')).toBe('retained');
  } finally { first.dispose(); db.close(); }
});
