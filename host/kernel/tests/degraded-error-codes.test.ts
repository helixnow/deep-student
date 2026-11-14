import { expect, it } from 'vitest';
import { definePlugin } from '../api.ts';
import { installProfile } from '../profile-install.ts';
import { parseDegradedReason } from '../plugin-load-error.ts';
import { createTestHost } from '../testing.ts';

it('RF-W01-degraded-error-codes: missing service and apply errors have stable codes and preserve details', async () => {
  const host = await createTestHost();
  try {
    const result = await installProfile(host.runtime, [
      { plugin: definePlugin({ meta: { id: 'dstu.missing' }, inject: ['absent'], apply() {} }) },
      { plugin: definePlugin({ meta: { id: 'dstu.broken' }, apply() { throw new Error('original failure'); } }) },
    ]);
    expect(result.degraded.map((item) => parseDegradedReason(item.reason))).toEqual([
      { code: 'SERVICE_MISSING', detail: 'missing service "absent"' },
      { code: 'APPLY_FAILED', detail: 'original failure' },
    ]);
    expect(host.runtime.uiManifestV2().degraded).toEqual(result.degraded);
  } finally { await host.dispose(); }
});
