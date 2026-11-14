import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-review-plan-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const reviewPlans = () => host.ctx.vfsRepo.reviewPlans;

describe('review_plan_repo.rs', { timeout: 120_000 }, () => {
  it('global_stats_bind_today_without_exam_parameter', () => {
    const stats = reviewPlans().getStats(db, null);
    expect(stats.exam_id).toBeNull();
    expect(stats.total_plans).toBe(0);
    expect(stats.due_today).toBe(0);
    expect(stats.total_reviews).toBe(0);
  });
});
