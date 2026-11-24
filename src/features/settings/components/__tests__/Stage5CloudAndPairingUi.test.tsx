import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import enSync from '@/locales/en-US/sync.json';

const mockNotify = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());
const mockCreatePairingCode = vi.hoisted(() => vi.fn());
const mockListQuarantine = vi.hoisted(() => vi.fn());
const mockListConflicts = vi.hoisted(() => vi.fn());
const mockCountConflicts = vi.hoisted(() => vi.fn());
const mockListSnapshots = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockNotify,
}));

vi.mock('@/utils/unifiedDialogs', () => ({
  unifiedConfirm: vi.fn(() => true),
}));

vi.mock('@/stores/systemStatusStore', () => ({
  useSystemStatusStore: (selector: (s: {
    enterMaintenanceMode: () => void;
    requireMaintenanceRestart: () => void;
    exitMaintenanceMode: () => void;
  }) => unknown) =>
    selector({
      enterMaintenanceMode: vi.fn(),
      requireMaintenanceRestart: vi.fn(),
      exitMaintenanceMode: vi.fn(),
    }),
}));

vi.mock('@/utils/cloudStorageApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/cloudStorageApi')>();
  return {
    ...actual,
    resolveCloudStorageConfig: vi.fn(async () => null),
    loadStoredCloudStorageConfigSafe: vi.fn(() => null),
    getCredentialStatus: vi.fn(async () => ({
      webdavPasswordConfigured: false,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    })),
    testConnectionDraft: vi.fn(),
    publishCloudConfig: vi.fn(),
  };
});

vi.mock('@/api/dataGovernance', () => ({
  listQuarantine: mockListQuarantine,
  retryQuarantineItem: vi.fn(),
  discardQuarantineItem: vi.fn(),
  retryAllQuarantine: vi.fn(),
  discardAllQuarantine: vi.fn(),
  listRecordConflicts: mockListConflicts,
  countRecordConflicts: mockCountConflicts,
  resolveRecordConflict: vi.fn(),
  purgeResolvedConflicts: vi.fn(),
  listSyncSnapshotBatches: mockListSnapshots,
}));

vi.mock('../../../../../host/plugins/sync/src/device-pairing', () => ({
  createPairingCode: mockCreatePairingCode,
  applyPairingCode: vi.fn(),
}));

const stableT = (key: string, opts?: Record<string, unknown>) => {
  if (key.startsWith('sync:')) {
    const sub = key.slice('sync:'.length).split('.');
    let cur: unknown = enSync;
    for (const p of sub) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
    }
    if (typeof cur === 'string') {
      return opts?.summary ? cur.replace('{{summary}}', String(opts.summary)) : cur;
    }
  }
  if (opts && 'error' in opts) return `${key}:${String(opts.error)}`;
  if (opts && 'reason' in opts) return `${key}:${String(opts.reason)}`;
  return key;
};
const stableI18n = { language: 'en-US', changeLanguage: () => Promise.resolve() };
const stableTranslation = { t: stableT, i18n: stableI18n };

vi.mock('react-i18next', () => ({
  useTranslation: () => stableTranslation,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { CloudStorageSection } from '@/features/settings/components/CloudStorageSection';
import { DevicePairingSection } from '@/features/settings/components/DevicePairingSection';
import { SyncQuarantinePanel } from '@/features/settings/components/data-governance/SyncQuarantinePanel';
import { RecordConflictsPanel } from '@/features/settings/components/data-governance/RecordConflictsPanel';
import * as cloudApi from '@/utils/cloudStorageApi';

describe('Stage 5 CloudStorage, DevicePairing & ACL Sanitization UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockInvoke.mockResolvedValue('true');
    mockCreatePairingCode.mockResolvedValue({
      pairingCode: 'DSPAIR1:stable-generated-code',
      summary: { cloudProvider: null, llmProviders: 1, includeSkills: true, includePlugins: true },
    });
    mockListQuarantine.mockResolvedValue([]);
    mockListConflicts.mockResolvedValue([]);
    mockCountConflicts.mockResolvedValue({ per_database: {}, total_groups: 0, total_rows: 0 });
    mockListSnapshots.mockResolvedValue([]);
  });

  it('CloudStorageSection preserves draftTestFailed with concrete reason when saved config exists, and blocks invalid credentials/HTTP/root traversal', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockResolvedValueOnce({
      provider: 'webdav',
      webdav: { endpoint: 'https://saved.example.com/dav', username: 'saved-user' },
      root: 'sync',
      allowInsecure: false,
    });
    vi.mocked(cloudApi.getCredentialStatus).mockResolvedValueOnce({
      webdavPasswordConfigured: true,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    });
    vi.mocked(cloudApi.testConnectionDraft).mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'));

    render(<CloudStorageSection />);

    const endpointInput = await screen.findByPlaceholderText('cloudStorage:webdav.endpointPlaceholder');
    fireEvent.change(endpointInput, { target: { value: 'https://draft.example.com/dav' } });
    fireEvent.click(screen.getByRole('button', { name: 'cloudStorage:actions.testConnection' }));

    await waitFor(() => {
      expect(screen.getByTestId('cloud-draft-test-error-banner')).toHaveTextContent('HTTP 503 Service Unavailable');
    });
    expect(screen.getByTestId('cloud-config-phase')).toHaveTextContent('cloudStorage:phase.draftTestFailed');
    expect(screen.getByTestId('cloud-config-phase')).toHaveTextContent('HTTP 503 Service Unavailable');
    expect(mockNotify).toHaveBeenCalledWith('error', expect.stringContaining('HTTP 503 Service Unavailable'));

    // Embedded credentials in URL shows persistent validation alert and disables save
    fireEvent.change(endpointInput, { target: { value: 'https://user:pass@draft.example.com/dav' } });
    expect(screen.getByTestId('cloud-validation-errors')).toHaveTextContent(
      'cloudStorage:validation.embeddedCredentials',
    );
    expect(screen.getByRole('button', { name: 'cloudStorage:actions.save' })).toBeDisabled();

    // Traversal `..` in root path shows persistent validation alert and disables save
    fireEvent.change(endpointInput, { target: { value: 'https://draft.example.com/dav' } });
    const rootInput = screen.getByPlaceholderText('cloudStorage:root.placeholder');
    fireEvent.change(rootInput, { target: { value: 'sync/../escape' } });
    expect(screen.getByTestId('cloud-validation-errors')).toHaveTextContent(
      'cloudStorage:validation.rootPathTraversal',
    );
    expect(screen.getByRole('button', { name: 'cloudStorage:actions.save' })).toBeDisabled();
  });

  it('DevicePairingSection localizes into en-US, warns when includeCloud checked while unconfigured, and keeps code on refresh', async () => {
    const { rerender } = render(<DevicePairingSection cloudConfigured={false} />);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    // English localized headings/buttons render cleanly
    expect(screen.getByText('QR Sync & Cross-Device One-Tap Pairing')).toBeInTheDocument();
    expect(screen.getByTestId('pairing-cloud-not-configured-warning')).toHaveTextContent(
      enSync.pairing.cloudNotConfiguredWarning,
    );

    const pinInput = screen.getByPlaceholderText(enSync.pairing.pinPlaceholder);
    fireEvent.change(pinInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('generate-pairing-qr-btn'));

    expect(await screen.findByTestId('device-pairing-qr-panel')).toBeInTheDocument();
    expect(screen.getByLabelText(enSync.pairing.encryptedCodeAria)).toHaveValue('DSPAIR1:stable-generated-code');

    // Prop refresh / state update does not silently regenerate pairing code
    rerender(<DevicePairingSection cloudConfigured={true} />);
    expect(mockCreatePairingCode).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(enSync.pairing.encryptedCodeAria)).toHaveValue('DSPAIR1:stable-generated-code');
  });

  it('SyncQuarantinePanel and RecordConflictsPanel sanitize ACL errors without leaking command names', async () => {
    mockListQuarantine.mockRejectedValueOnce(new Error('Command sync_quarantine_list not allowed by ACL'));
    mockListConflicts.mockRejectedValueOnce(new Error('Command list_record_conflicts not allowed by ACL'));

    render(
      <>
        <SyncQuarantinePanel />
        <RecordConflictsPanel />
      </>,
    );

    await waitFor(() => {
      expect(mockNotify).toHaveBeenCalledWith(
        'error',
        'data:governance.quarantine_load_failed:data:governance.acl_permission_denied',
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'error',
        'data:governance.conflict_load_failed:data:governance.acl_permission_denied',
      );
    });
    expect(mockNotify).not.toHaveBeenCalledWith('error', expect.stringContaining('sync_quarantine_list'));
    expect(mockNotify).not.toHaveBeenCalledWith('error', expect.stringContaining('list_record_conflicts'));
  });
});
