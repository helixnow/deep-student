import { expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: install the production sync plugin to catch stale cross-lane fixture APIs
import sync from '../../sync/index.ts';
import { createTestHost, openTestDatabase } from './sync-fixture.ts';

it('installs real paths and VFS owner before applying through the published sync service', async () => {
  const host = await createTestHost({ plugins: [sync] });
  try {
    expect(await host.ctx.paths.dataSpaceDeviceId()).toBe('l22-sync-device');
    expect(await host.ctx.paths.deviceId()).toBe('l22-sync-device');
    const db = openTestDatabase();
    db.exec('CREATE TABLE resources (id TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
    const result = host.ctx.sync.applyDownloadedChanges(db, [{
      table_name: 'resources', record_id: 'fixture-regression', operation: 'Insert',
      data: { id: 'fixture-regression', content: 'real production apply', updated_at: '2026-07-10T12:00:00Z' },
      changed_at: '2026-07-10T12:00:00Z', database_name: 'vfs', suppress_change_log: true,
    }], { deviceId: 'l22-sync-device' });
    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(db.pluck('SELECT content FROM resources WHERE id = ?1', ['fixture-regression']))
      .toBe('real production apply');
  } finally {
    await host.dispose();
  }
});
