import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }), initReactI18next: { type: '3rdParty', init: () => {} } };
});
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/api/tauriClient', () => ({ parseCommandErrorEnvelope: () => null }));
vi.mock('@/utils/tauriApi', () => ({ TauriAPI: {} }));
vi.mock('@/api/dataGovernance', () => ({ DataGovernanceApi: {} }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: true }) }));
vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => false }));
vi.mock('../DevicePairingSection', () => ({ DevicePairingSection: () => null }));
vi.mock('@/utils/cloudStorageApi', () => ({
  CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY: 'cloud_storage_config_v2',
  CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY: 'cloud_storage_ssot_migrated',
  isS3Enabled: vi.fn(async () => true),
  resolveCloudStorageConfig: vi.fn(async () => null),
  getCredentialStatus: vi.fn(async () => ({ webdavPasswordConfigured: true })),
  getDeviceId: vi.fn(async () => 'device-test'),
  publishCloudConfig: vi.fn(),
  getSyncStatus: vi.fn(async () => null),
  listVersions: vi.fn(async () => []),
  requiresInsecureTransportOptIn: () => false,
  isPublicHttpEndpoint: () => false,
  getCloudPlatformErrorI18nKey: () => undefined,
  findCloudBackupVersion: () => undefined,
  isKnownPortableCloudBackup: () => false,
}));

import { CloudStorageSection } from '../CloudStorageSection';
import * as cloudApi from '@/utils/cloudStorageApi';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function editEndpoint(value: string) {
  fireEvent.change(screen.getByPlaceholderText('cloudStorage:webdav.endpointPlaceholder'), {
    target: { value },
  });
}
async function fillForm() {
  await waitFor(() => expect(cloudApi.getCredentialStatus).toHaveBeenCalled());
  editEndpoint('https://new.example.test');
  fireEvent.change(screen.getByPlaceholderText('cloudStorage:webdav.usernamePlaceholder'), {
    target: { value: 'student' },
  });
  fireEvent.change(screen.getByPlaceholderText('cloudStorage:webdav.passwordPlaceholder'), {
    target: { value: 'secret' },
  });
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);

test('slow initial config does not replace an edited cloud draft', async () => {
  const load = deferred<cloudApi.CloudStorageConfig | null>();
  vi.mocked(cloudApi.resolveCloudStorageConfig).mockReturnValueOnce(load.promise);
  render(<CloudStorageSection />);
  await waitFor(() => expect(cloudApi.resolveCloudStorageConfig).toHaveBeenCalledTimes(1));
  editEndpoint('https://edited.example.test');
  fireEvent.change(screen.getByPlaceholderText('cloudStorage:webdav.usernamePlaceholder'), {
    target: { value: 'student' },
  });
  fireEvent.change(screen.getByPlaceholderText('cloudStorage:webdav.passwordPlaceholder'), {
    target: { value: 'secret' },
  });
  await act(async () => load.resolve({
    provider: 'webdav', webdav: { endpoint: 'https://old.example.test', username: 'old', password: '' },
  }));
  expect(screen.getByPlaceholderText('cloudStorage:webdav.endpointPlaceholder')).toHaveValue('https://edited.example.test');
  expect(screen.getByTestId('cloud-config-phase')).toHaveTextContent('cloudStorage:phase.draftUntested');
});

test.each([false, true])('pending publish preserves newer edits (repeat click: %s)', async (repeatClick) => {
  const publish = deferred<cloudApi.CloudConfigPublishResponse>();
  vi.mocked(cloudApi.publishCloudConfig).mockReturnValue(publish.promise);
  render(<CloudStorageSection />);
  await fillForm();
  const save = screen.getByRole('button', { name: 'cloudStorage:actions.save' });
  fireEvent.click(save);
  if (repeatClick) {
    fireEvent.click(save);
    expect(cloudApi.publishCloudConfig).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
  }
  editEndpoint('https://edited-during-save.example.test');
  await act(async () => publish.resolve({
    ok: true, generation: 1, provider: 'webdav',
    config: { provider: 'webdav', webdav: { endpoint: 'https://new.example.test', username: 'student' } },
  }));
  expect(screen.getByTestId('cloud-config-phase')).toHaveTextContent('cloudStorage:phase.draftUntested');
  expect(save).toBeEnabled();
  expect(screen.getByPlaceholderText('cloudStorage:webdav.endpointPlaceholder')).toHaveValue('https://edited-during-save.example.test');
});

test('failed publication releases the save button for retry without losing edits', async () => {
  vi.mocked(cloudApi.publishCloudConfig).mockRejectedValue(new Error('offline'));
  render(<CloudStorageSection />);
  await fillForm();
  const save = screen.getByRole('button', { name: 'cloudStorage:actions.save' });
  fireEvent.click(save);
  await waitFor(() => expect(save).toBeEnabled());
  expect(screen.getByPlaceholderText('cloudStorage:webdav.endpointPlaceholder')).toHaveValue('https://new.example.test');
  fireEvent.click(save);
  await waitFor(() => expect(cloudApi.publishCloudConfig).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(save).toBeEnabled());
});

test('editing during a slow post-publish status read does not load obsolete versions', async () => {
  const status = deferred<cloudApi.SyncStatus>();
  vi.mocked(cloudApi.getSyncStatus).mockReturnValueOnce(status.promise);
  vi.mocked(cloudApi.publishCloudConfig).mockResolvedValueOnce({
    ok: true, generation: 1, provider: 'webdav',
    config: { provider: 'webdav', webdav: { endpoint: 'https://new.example.test', username: 'student' } },
  });
  render(<CloudStorageSection />);
  await fillForm();
  fireEvent.click(screen.getByRole('button', { name: 'cloudStorage:actions.save' }));
  await waitFor(() => expect(cloudApi.getSyncStatus).toHaveBeenCalledTimes(1));
  editEndpoint('https://different.example.test');
  await act(async () => status.resolve({} as cloudApi.SyncStatus));
  expect(cloudApi.listVersions).not.toHaveBeenCalled();
  expect(screen.getByTestId('cloud-config-phase')).toHaveTextContent('cloudStorage:phase.draftUntested');
});
