import fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';
import memory from '../index.ts';
import {
  createIndexDouble, createLogDouble, createNotesDouble, createReposDouble, createRetrievalDouble,
  createSettingsDouble,
} from './support.ts';

let host: TestHost | undefined;
let storage: StorageServiceImpl | undefined;
let dir: string | undefined;
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
async function setup() {
  const fixture = await createMigratedMemoryStorage('memory-jobs-');
  ({ dir, storage } = fixture);
  expect(fixture.report.success).toBe(true);
  const db = storage.database('vfs');
  host = await createTestHost({
    plugins: [memory],
    provide: {
      storage, 'notes': createNotesDouble(db),
      'vfsRepo': createReposDouble(),
      'retrieval': createRetrievalDouble(db), 'vfsIndex': createIndexDouble(),
      log: createLogDouble([]),
      settings: createSettingsDouble(db),
    },
  });
  return { queue: host.ctx.memory.insightJobs, db };
}

it('test_job_queue_enqueue_dedupe_and_lease_recovery', async () => {
  const { queue, db } = await setup();
  const first = queue.enqueue('srs_projection', 'srs:ic_x', '{}');
  expect(first).not.toBeNull();
  expect(queue.enqueue('srs_projection', 'srs:ic_x', '{}')).toBeNull();
  const claimed = queue.claimDue('w1', 10);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]![1]).toBe('srs_projection');
  expect(queue.enqueue('srs_projection', 'srs:ic_x', '{}')).toBeNull();
  db.run("UPDATE insight_jobs SET leased_at = datetime('now', '-1 hour') WHERE id = ?1", [claimed[0]![0]]);
  expect(queue.recoverStaleLeases()).toBe(1);
  const reclaimed = queue.claimDue('w2', 10);
  expect(reclaimed).toHaveLength(1);
  queue.complete(reclaimed[0]![0]);
  const again = queue.enqueue('srs_projection', 'srs:ic_x', '{}');
  expect(again).not.toBeNull();
  expect(queue.claimDue('w1', 10)).toHaveLength(1);
  for (let i = 0; i < 3; i++) {
    queue.fail(again!, 'boom');
    db.run('UPDATE insight_jobs SET next_attempt_at = NULL WHERE id = ?1', [again!]);
    queue.claimDue('w1', 10);
  }
  expect(db.pluck('SELECT status FROM insight_jobs WHERE id = ?1', [again!])).toBe('error');
});
it('job queue keeps Rust timestamp comparison, backoff, ID format and unfenced completion', async () => {
  const { queue, db } = await setup();
  const id = queue.enqueue('srs_projection', 'one', '{}')!;
  expect(id).toMatch(/^ijob_[A-Za-z0-9_-]{10}$/);
  expect(db.pluck<string>('SELECT created_at FROM insight_jobs WHERE id = ?1', [id])).toMatch(/\+00:00$/);
  expect(queue.claimDue('worker1', 1)[0]![3]).toBe(1);
  // next_attempt_at is SQLite 'now' + backoff inside fail()'s UPDATE, whole seconds; 'now' in any later
  // statement may already be in the next second, so bracket fail() with SQLite clock reads instead.
  const sqliteSecond = () => db.pluck<number>("SELECT CAST(strftime('%s', 'now') AS INTEGER)")!;
  const before = sqliteSecond();
  queue.fail(id, 'first failure');
  const after = sqliteSecond();
  expect(db.get('SELECT status, lease_owner, leased_at, last_error FROM insight_jobs WHERE id = ?1', [id])).toEqual({
    status: 'queued', lease_owner: null, leased_at: null, last_error: 'first failure',
  });
  const due = db.pluck<number>("SELECT CAST(strftime('%s', next_attempt_at) AS INTEGER) FROM insight_jobs WHERE id = ?1", [id])!;
  expect(due - 60).toBeGreaterThanOrEqual(before);
  expect(due - 60).toBeLessThanOrEqual(after);
  // Rust compares space-form SQLite times against RFC3339 with T; preserve that observable quirk.
  expect(queue.claimDue('worker2', 1)).toHaveLength(1);
  queue.complete(id);
  expect(db.pluck('SELECT status FROM insight_jobs WHERE id = ?1', [id])).toBe('done');
  expect(() => queue.fail('missing', 'err')).toThrow(expect.objectContaining({
    error_type: 'Database', message: 'Query returned no rows', details: null,
  }));
});
