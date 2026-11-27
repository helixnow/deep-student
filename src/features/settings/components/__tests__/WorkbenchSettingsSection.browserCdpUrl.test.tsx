import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addAppEventListener } from '@/events';

const {
  getSettingMock,
  saveSettingMock,
  deleteSettingMock,
  showGlobalNotificationMock,
} = vi.hoisted(() => ({
  getSettingMock: vi.fn(),
  saveSettingMock: vi.fn(),
  deleteSettingMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: getSettingMock,
  saveSetting: saveSettingMock,
  deleteSetting: deleteSettingMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/features/workbench/components/AgentControlCenter', () => ({
  AgentCapabilitySummary: () => <div data-testid="agent-capability-summary" />,
}));

vi.mock('../workbenchMode', () => ({
  resolveWorkbenchModeEnabled: vi.fn(async () => ({ enabled: true, source: 'explicit' })),
}));

vi.mock('react-i18next', () => {
  const translations: Record<string, string> = {
    'workbench:settings.browserAdvanced': 'Advanced',
    'settings:workbenchBrowserCdpUrl.title': 'Remote CDP Endpoint',
    'settings:workbenchBrowserCdpUrl.desc': 'Remote CDP endpoint description',
    'settings:workbenchBrowserCdpUrl.placeholder': 'http://127.0.0.1:9222',
    'settings:workbenchBrowserCdpUrl.save': 'Save',
    'settings:workbenchBrowserCdpUrl.clear': 'Clear',
    'settings:workbenchBrowserCdpUrl.saved': 'Remote CDP endpoint saved',
    'settings:workbenchBrowserCdpUrl.cleared': 'Remote CDP endpoint cleared',
    'settings:workbenchBrowserCdpUrl.invalidUrl':
      'Enter a valid URL starting with http://, https://, ws://, or wss://',
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
      i18n: { resolvedLanguage: 'en-US', language: 'en-US' },
    }),
  };
});

import { WorkbenchSettingsSection, WORKBENCH_SETTING_KEYS } from '../WorkbenchSettingsSection';

describe('WorkbenchSettingsSection Remote CDP URL setting', () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    saveSettingMock.mockReset();
    deleteSettingMock.mockReset();
    showGlobalNotificationMock.mockReset();

    getSettingMock.mockImplementation(async (key: string) => {
      if (key === WORKBENCH_SETTING_KEYS.browserCdpUrl) return 'http://127.0.0.1:9222';
      return null;
    });
    saveSettingMock.mockResolvedValue(undefined);
    deleteSettingMock.mockResolvedValue(undefined);
  });

  it('loads, validates, saves, clears desktop.workbenchBrowserCdpUrl, and dispatches workbench:settings-changed', async () => {
    const events: Array<{ key: string; value: unknown }> = [];
    const unsubscribe = addAppEventListener<{ key: string; value: unknown }>(
      'workbench:settings-changed',
      (detail) => {
        events.push(detail);
      },
    );

    try {
      render(<WorkbenchSettingsSection />);

      const advancedBtn = await screen.findByRole('button', { name: /Advanced/i });
      fireEvent.click(advancedBtn);

      const input = (await screen.findByLabelText('Remote CDP Endpoint')) as HTMLInputElement;
      await waitFor(() => {
        expect(input.value).toBe('http://127.0.0.1:9222');
      });

      // Invalid scheme shows inline validation error and does not persist.
      fireEvent.change(input, { target: { value: 'ftp://127.0.0.1:9222' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Enter a valid URL starting with http://, https://, ws://, or wss://',
      );
      expect(saveSettingMock).not.toHaveBeenCalled();

      // Valid ws:// URL saves trimmed value and dispatches event.
      fireEvent.change(input, { target: { value: '  ws://127.0.0.1:9333/devtools/browser/abc  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(saveSettingMock).toHaveBeenCalledWith(
          'desktop.workbenchBrowserCdpUrl',
          'ws://127.0.0.1:9333/devtools/browser/abc',
        );
      });
      expect(events).toContainEqual({
        key: 'desktop.workbenchBrowserCdpUrl',
        value: 'ws://127.0.0.1:9333/devtools/browser/abc',
      });

      // Clear deletes persisted setting and dispatches empty value.
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await waitFor(() => {
        expect(deleteSettingMock).toHaveBeenCalledWith('desktop.workbenchBrowserCdpUrl');
      });
      expect(events).toContainEqual({
        key: 'desktop.workbenchBrowserCdpUrl',
        value: '',
      });
      expect(input.value).toBe('');
    } finally {
      unsubscribe();
    }
  });
});
