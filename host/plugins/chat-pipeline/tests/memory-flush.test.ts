import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  claimNextPendingMemoryFlushWithConn, completeMemoryFlushWithConn, enqueueMemoryFlushWithConn,
  ensureMemoryFlushLedgerWithConn, hasClaimableMemoryFlushWithConn, MEMORY_FLUSH_LEASE_MS,
  MEMORY_FLUSH_LEDGER_TABLE, MEMORY_FLUSH_SEGMENT_MAX_CHARS, readMemoryFlushPolicyWithConn,
  type PendingMemoryFlush,
} from '../repository/memory-flush.ts';
import { buildMemoryFlushSegmentId, splitMemoryFlushSegment } from '../src/memory-flush.ts';

let storage: StorageServiceImpl | undefined;
let dir: string | undefined;
afterEach(() => {
  storage?.dispose();
  storage = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function openMemory(): DatabaseHandle {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'chat-pipeline-flush-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  return storage.openFile(':memory:', { label: 'memory-flush' });
}

function setupMemoryFlushLedger(): DatabaseHandle {
  const db = openMemory();
  db.exec("CREATE TABLE chat_v2_compactions (id TEXT PRIMARY KEY); INSERT INTO chat_v2_compactions (id) VALUES ('cmp_test');");
  ensureMemoryFlushLedgerWithConn(db);
  return db;
}

function pendingMemoryFlush(): PendingMemoryFlush {
  return {
    segmentId: 'seg_test',
    compactionId: 'cmp_test',
    sessionId: 'session_test',
    segmentOrdinal: 0,
    segmentText: 'A sufficiently long conversation segment for extraction.',
    extractionJson: null,
    factsCompleted: 0,
    activitiesCompleted: 0,
  };
}

it('missing_or_malformed_memory_settings_fail_closed', () => {
  const db = openMemory();
  expect(() => readMemoryFlushPolicyWithConn(db)).toThrow();

  db.exec("CREATE TABLE memory_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n"
    + "INSERT INTO memory_config (key, value) VALUES ('privacy_mode', 'corrupt');");
  expect(() => readMemoryFlushPolicyWithConn(db)).toThrow();
});

it('privacy_and_auto_extract_off_disable_memory_flush', () => {
  const db = openMemory();
  db.exec("CREATE TABLE memory_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n"
    + "INSERT INTO memory_config (key, value) VALUES ('privacy_mode', 'true');\n"
    + "INSERT INTO memory_config (key, value) VALUES ('auto_extract_frequency', 'balanced');");
  expect(readMemoryFlushPolicyWithConn(db)).toEqual({ kind: 'disabled', reason: 'privacy mode' });

  db.run("UPDATE memory_config SET value = 'false' WHERE key = 'privacy_mode'");
  db.run("UPDATE memory_config SET value = 'off' WHERE key = 'auto_extract_frequency'");
  expect(readMemoryFlushPolicyWithConn(db)).toEqual({ kind: 'disabled', reason: 'auto extract off' });
});

it('memory_flush_segment_id_is_stable_and_boundary_scoped', () => {
  const first = buildMemoryFlushSegmentId('s1', 'cmp0', 'm3', 'm9', 0);
  const retry = buildMemoryFlushSegmentId('s1', 'cmp0', 'm3', 'm9', 0);
  const differentEnd = buildMemoryFlushSegmentId('s1', 'cmp0', 'm3', 'm10', 0);
  const nextChunk = buildMemoryFlushSegmentId('s1', 'cmp0', 'm3', 'm9', 1);
  expect(first).toBe(retry);
  expect(first).not.toBe(differentEnd);
  expect(first).not.toBe(nextChunk);
});

it('long_memory_flush_input_is_split_without_omitting_the_middle', () => {
  const input = `${'a'.repeat(MEMORY_FLUSH_SEGMENT_MAX_CHARS + 17)}MIDDLE_SENTINEL${'z'.repeat(MEMORY_FLUSH_SEGMENT_MAX_CHARS + 29)}`;
  const chunks = splitMemoryFlushSegment(input);
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  expect(chunks.every(chunk => [...chunk].length <= MEMORY_FLUSH_SEGMENT_MAX_CHARS)).toBe(true);
  expect(chunks.join('')).toBe(input);
  expect(chunks.join('')).toContain('MIDDLE_SENTINEL');
});

it('memory_flush_split_prefers_rendered_block_boundaries', () => {
  const first = `[#0 USER]\n${'a'.repeat(7_000)}\n\n`;
  const second = `[#1 ASSISTANT]\n${'b'.repeat(7_000)}\n\n`;
  const input = `${first}${second}`;
  const chunks = splitMemoryFlushSegment(input);
  expect(chunks).toEqual([first, second.trimEnd()]);
  expect(chunks.join('')).toBe(input.trim());
});

it('legacy_memory_flush_ledger_backfills_stable_ordinals', () => {
  const db = openMemory();
  db.exec("CREATE TABLE chat_v2_compactions (id TEXT PRIMARY KEY);\n"
    + "INSERT INTO chat_v2_compactions (id) VALUES ('cmp_test');\n"
    + 'CREATE TABLE chat_v2_compaction_memory_flushes ('
    + 'segment_id TEXT PRIMARY KEY, compaction_id TEXT NOT NULL, session_id TEXT NOT NULL,'
    + 'segment_text TEXT NOT NULL, extraction_json TEXT, facts_completed INTEGER NOT NULL DEFAULT 0,'
    + "activities_completed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',"
    + 'lease_owner TEXT, lease_expires_at INTEGER, last_error TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,'
    + 'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);\n'
    + 'INSERT INTO chat_v2_compaction_memory_flushes'
    + ' (segment_id, compaction_id, session_id, segment_text, created_at, updated_at) VALUES'
    + " ('seg_old_0', 'cmp_test', 'session_test', 'zero', 10, 10),"
    + " ('seg_old_1', 'cmp_test', 'session_test', 'one', 10, 10);");

  ensureMemoryFlushLedgerWithConn(db);
  const ordinals = db.all<{ segment_ordinal: number }>(
    'SELECT segment_ordinal FROM chat_v2_compaction_memory_flushes ORDER BY rowid',
  ).map(row => row.segment_ordinal);
  expect(ordinals).toEqual([0, 1]);
});

it('claim_never_overtakes_an_earlier_segment_in_the_same_session', () => {
  const db = setupMemoryFlushLedger();
  const first = pendingMemoryFlush();
  const second = { ...first, segmentId: 'seg_test_1', segmentOrdinal: 1 };
  expect(enqueueMemoryFlushWithConn(db, first, 100)).toBe(true);
  expect(enqueueMemoryFlushWithConn(db, second, 100)).toBe(true);
  expect(hasClaimableMemoryFlushWithConn(db, first.sessionId, 1_000)).toBe(true);

  const claimed = claimNextPendingMemoryFlushWithConn(db, first.sessionId, 'worker_1', 1_000)!;
  expect(claimed.segmentId).toBe(first.segmentId);
  expect(claimed.segmentOrdinal).toBe(0);
  expect(claimNextPendingMemoryFlushWithConn(db, first.sessionId, 'worker_2', 1_001)).toBeNull();
  expect(hasClaimableMemoryFlushWithConn(db, first.sessionId, 1_001)).toBe(false);

  expect(completeMemoryFlushWithConn(db, first.segmentId, 'worker_1', 1_002)).toBe(true);
  const next = claimNextPendingMemoryFlushWithConn(db, first.sessionId, 'worker_2', 1_003)!;
  expect(next.segmentId).toBe(second.segmentId);
  expect(next.segmentOrdinal).toBe(1);
});

it('ledger_enqueue_rolls_back_with_compaction_transaction', () => {
  const db = setupMemoryFlushLedger();
  db.run('DELETE FROM chat_v2_compactions');
  const sentinel = new Error('rollback compaction');
  expect(() => db.transaction(tx => {
    tx.run("INSERT INTO chat_v2_compactions (id) VALUES ('cmp_test')");
    expect(enqueueMemoryFlushWithConn(tx, pendingMemoryFlush(), 10)).toBe(true);
    throw sentinel;
  })).toThrow(sentinel);

  const count = db.pluck<number>(`SELECT COUNT(*) FROM ${MEMORY_FLUSH_LEDGER_TABLE}`);
  expect(count).toBe(0);
});

it('expired_lease_is_recoverable_at_exact_lease_boundary', () => {
  const db = setupMemoryFlushLedger();
  const pending = pendingMemoryFlush();
  expect(enqueueMemoryFlushWithConn(db, pending, 100)).toBe(true);
  expect(claimNextPendingMemoryFlushWithConn(db, pending.sessionId, 'worker_1', 1_000)!.segmentId)
    .toBe(pending.segmentId);
  expect(claimNextPendingMemoryFlushWithConn(db, pending.sessionId, 'worker_2', 1_000 + MEMORY_FLUSH_LEASE_MS - 1))
    .toBeNull();
  const retry = claimNextPendingMemoryFlushWithConn(db, pending.sessionId, 'worker_2', 1_000 + MEMORY_FLUSH_LEASE_MS)!;
  expect(retry.segmentId).toBe(pending.segmentId);
  expect(retry.segmentOrdinal).toBe(0);
});
