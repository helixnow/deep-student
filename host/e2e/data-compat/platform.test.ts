import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../kernel/testing.ts';
import storagePlugin from '../../platform/storage/index.ts';
import { createLogService, type LogServiceHandle } from '../../platform/log/index.ts';
import { services } from './__tests__/host.ts';
import { DATABASES, LARGE, TOKENS, UTC, buildSlot, cleanup, rawSnapshot, snapshot, tempDir } from './__fixtures__/fixtures.ts';

let base: string, host: TestHost, log: LogServiceHandle;
let before: ReturnType<typeof rawSnapshot>[];
// Replaying 132 Rust SQL migrations plus real plugin startup exceeds Vitest's 10s hook default under shared CI CPU load.
beforeAll(async () => {
  base = tempDir(); const active = buildSlot(base);
  writeFileSync(join(base, 'slots/state.json'), '{"active":"slotA","pending":null}');
  before = DATABASES.map(db => rawSnapshot(active, db));
  const { paths, secrets } = services(base);
  log = createLogService({ paths, debug: false, version: 'x3', env: {} });
  host = await createTestHost({ app: { dataDir: base }, provide: { paths, secrets, log },
    plugins: [[storagePlugin, { dataLocalDir: join(base, 'local') }]],
  });
}, 60_000);
afterAll(async () => { try { await host?.dispose(); await log?.close(); } finally { if (base) cleanup(base); } });

it('F3 production storage plugin startup opens the old data-space without altering seeded rows', () => {
  expect(host.ctx.dataSpace.initialized).toBe(true);
  expect(host.ctx.dataSpace.status().recovery_required).toBe(false);
  for (const [i, db] of DATABASES.entries()) expect(snapshot(host.ctx.storage.database(db), db), db).toEqual(before[i]);
});

it('F3 llm_usage_recent public IPC matches Rust UsageRecord serde (including UTC Z)', async () => {
  // Rust: llm_usage/repo.rs:509-510 -> DateTime<Utc>; types.rs:215 -> serde UTC Z.
  // A failure here is an incompatibility, not a known-failure/skip disguised as a pass.
  expect(await host.invoke('llm_usage_recent', { limit: 5 })).toEqual([{
    id: 'usage_old', callerType: 'chat_v2', callerId: 'sess_old', modelId: 'model-old', providerId: '旧提供商📚',
    tokenSource: 'api', promptTokens: TOKENS, completionTokens: 0, totalTokens: TOKENS,
    cachedTokens: 0, estimatedCostUsd: 0.125, durationMs: LARGE, success: true, createdAt: UTC,
  }]);
});
