import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumePendingSettingsRoute,
  openArchivedSessionsSettings,
  setPendingSettingsRoute,
} from '@/utils/pendingSettingsTab';

describe('pending settings route helpers', () => {
  beforeEach(() => {
    delete window.__dsPendingSettingsRoute;
    delete window.__dsPendingSettingsTab;
    vi.restoreAllMocks();
  });

  it('stores and consumes a nested settings route', () => {
    setPendingSettingsRoute({ tab: 'data-governance', dataGovernanceTab: 'archive' });

    expect(consumePendingSettingsRoute()).toEqual({
      tab: 'data-governance',
      dataGovernanceTab: 'archive',
    });
    expect(consumePendingSettingsRoute()).toBeNull();
  });

  it('opens archived sessions through settings and data governance archive events', () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

    openArchivedSessionsSettings();

    expect(window.__dsPendingSettingsRoute).toEqual({
      tab: 'data-governance',
      dataGovernanceTab: 'archive',
    });
    expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'navigate-to-tab',
      detail: { tabName: 'settings' },
    }));
    expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SETTINGS_NAVIGATE_TAB',
      detail: { tab: 'data-governance', dataGovernanceTab: 'archive' },
    }));
  });
});
