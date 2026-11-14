import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../../../platform/storage/database.ts';
import { serviceHost } from './service-host.ts';

describe('sync state store (state.rs)', () => {
  it('tombstone_event_sequence_is_monotonic_and_idempotent', async () => {
    const h = await serviceHost();
    try {
      const store = h.service.state;
      const first = store.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation-a', 0n);
      const retry = store.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation-a', 99n);
      const next = store.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation-b', 7n);

      expect(first).toBe(1n);
      expect(retry).toBe(first);
      expect(next).toBe(8n);
    } finally { await h.dispose(); }
  });

  it('tombstone_sequence_waits_for_writer_before_reading [final-sequence only; busy handshake pending]', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-support-state-'));
    const file = path.join(dir, 'sync_state.db');
    const writerDb = new SqliteDatabase({ name: 'writer', path: file, profile: {} });
    const h = await serviceHost(writerDb);
    // 先由 writer 用 BEGIN IMMEDIATE 占住写者槽。
    writerDb.exec('BEGIN IMMEDIATE');
    writerDb.run(
      `INSERT INTO tombstone_event_publish
       (instance_id, device_id, kind, operation_id, seq, created_at)
       VALUES ('instance', 'device', 'assets', 'operation-a', 1, 'now')`,
    );

    const worker = new Worker(new URL('./state-worker.ts', import.meta.url), {
      workerData: { path: file },
    });
    const result = new Promise<{ ok: boolean; seq?: string; error?: string }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    let settled = false;
    void result.then(() => { settled = true; });
    try {
      // Supplemental final-sequence check only: this delay does NOT prove that
      // the contender has entered SQLite's busy handler (R4 S06 / TESTMAP pending).
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      writerDb.exec('COMMIT');
      const message = await result;
      expect(message.ok).toBe(true);
      expect(message.seq).toBe('2');
    } finally {
      await worker.terminate();
      await h.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
