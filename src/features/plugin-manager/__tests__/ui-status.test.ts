import { describe, expect, it } from 'vitest';

import { CONSENT_REQUIRED_CODE, pluginUiStatus } from '../ui-status';
import { FakePluginUiHostStatus } from './fixtures';

describe('pluginUiStatus', () => {
  it('returns undefined without a host status handle so the Host snapshot stays authoritative', () => {
    expect(pluginUiStatus(null, 'dstu.ui.chat')).toBeUndefined();
    expect(pluginUiStatus(undefined, 'dstu.ui.chat')).toBeUndefined();
  });

  it('projects state, safe mode and consent-required from the W17 handle', () => {
    const status = new FakePluginUiHostStatus(['dstu.ui.chat']);
    status.setSafeMode(true);
    status.setDegraded('community.exporter', {
      code: CONSENT_REQUIRED_CODE,
      detail: 'consent record missing',
      consentRequired: true,
    });

    expect(pluginUiStatus(status, 'dstu.ui.chat')).toEqual({
      known: true,
      safeMode: true,
      hostState: 'online',
      degraded: undefined,
      consentRequired: false,
    });
    expect(pluginUiStatus(status, 'community.exporter')).toMatchObject({
      hostState: 'degraded',
      consentRequired: true,
      degraded: { code: 'CONSENT_REQUIRED', detail: 'consent record missing' },
    });
  });

  it('reports unknown before the v2 manifest arrives', () => {
    const status = new FakePluginUiHostStatus();
    status.known = false;

    expect(pluginUiStatus(status, 'dstu.ui.chat')?.hostState).toBe('unknown');
  });
});
