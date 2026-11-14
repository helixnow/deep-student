import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { serviceHost } from './service-host.ts';

it('withSync installs a real mastery provider on the supplied database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-support-mastery-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  let host: Awaited<ReturnType<typeof serviceHost>> | undefined;
  try {
    await storage.migrations.migrateSingle('vfs');
    const db = storage.database('vfs');
    host = await serviceHost(db, true);
    expect(host.sync).toBeDefined();
    expect(host.mastery).toBeDefined();
    const mastery = host.mastery!;
    db.transaction(tx => {
      mastery.recordQbankAnswerWithConn(tx, 'submission-1', 'question-1', ['sync-concept'], false);
      expect(mastery.recomputeAllStatesWithConn(tx)).toBe(1);
    });
    expect(mastery.getState('sync-concept')).toMatchObject({
      conceptKey: 'sync-concept', total: 1, wrongCount: 1, streak: 0,
    });
    expect(mastery.listEvents('sync-concept', 10)).toMatchObject([
      { id: 'me_qbank_submission-1', itemId: 'question-1', outcome: 'wrong' },
    ]);
    expect(mastery.syncAllLearnerProfiles()).toBe(1);
    await expect(host.invoke('mastery_get_overview', { limit: 6 })).resolves.toMatchObject({
      conceptCount: 1, weakCount: 0, weakest: [], todayPriorityReview: [],
    });
  } finally {
    try { await host?.dispose(); }
    finally {
      storage.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
