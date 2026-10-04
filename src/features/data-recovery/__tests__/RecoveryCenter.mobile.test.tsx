import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const platform = vi.hoisted(() => ({ mobile: false }));
const api = vi.hoisted(() => ({
  exportStartupRecoveryIncident: vi.fn(async () => 'content://exported.zip'),
  openStartupRecoveryIncidentFolder: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/utils/platform', () => ({
  isMobilePlatform: () => platform.mobile,
}));

vi.mock('@/api/dataGovernance', () => ({
  getMaintenanceStatus: vi.fn(async () => null),
}));

vi.mock('../dataRecoveryApi', () => ({
  getStartupRecoveryStatus: vi.fn(async () => ({ recovery_required: false, incident: null })),
  listStartupRecoveryIncidents: vi.fn(async () => [
    {
      id: 'incident-1',
      kind: 'timeline_conflict',
      created_at: '2026-10-01T00:00:00Z',
      status: 'resolved',
      reason: '',
      quarantined_entry_count: 1,
      candidates: [],
      selected_candidate: 'slotA',
      resolved_at: '2026-10-01T00:01:00Z',
      recovery_error: null,
      failed_operation: null,
      retry_requires_restart: false,
    },
  ]),
  exportStartupRecoveryIncident: api.exportStartupRecoveryIncident,
  exportStartupRecoveryReport: vi.fn(async () => null),
  openStartupRecoveryIncidentFolder: api.openStartupRecoveryIncidentFolder,
  resolveStartupRecovery: vi.fn(),
  retryRecoveryStartup: vi.fn(),
  retryStartupRecoveryPreflight: vi.fn(),
  restartAfterRecovery: vi.fn(),
}));

import { RecoveryCenter } from '../RecoveryCenter';

afterEach(() => {
  platform.mobile = false;
  vi.clearAllMocks();
});

describe('RecoveryCenter incident actions', () => {
  it('keeps the open-folder action on desktop', async () => {
    render(<RecoveryCenter mode="settings" />);
    expect(
      await screen.findByRole('button', { name: /open_incident_folder/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export_incident/ })).toBeInTheDocument();
  });

  it('hides open-folder on mobile and keeps export as the way to get data out', async () => {
    platform.mobile = true;
    render(<RecoveryCenter mode="settings" />);
    const exportButton = await screen.findByRole('button', { name: /export_incident/ });
    expect(screen.queryByRole('button', { name: /open_incident_folder/ })).toBeNull();

    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(api.exportStartupRecoveryIncident).toHaveBeenCalledWith('incident-1'),
    );
    expect(api.openStartupRecoveryIncidentFolder).not.toHaveBeenCalled();
  });
});
