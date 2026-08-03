import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import zhCommon from '@/locales/zh-CN/common.json';
import { AnkiConnectSettingsSection } from '../AnkiConnectSettingsSection';

const loadSettingsMock = vi.fn();

function lookup(obj: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as object)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      const bare = key.includes(':') ? key.split(':')[1] : key;
      const value = lookup(zhCommon as Record<string, unknown>, bare);
      if (typeof value === 'string') return value;
      if (typeof options === 'string') return options;
      if (typeof options === 'object' && typeof options.defaultValue === 'string') return options.defaultValue;
      return key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/services/ankiConnectClient', () => ({
  ankiConnectClient: {
    loadSettings: (...args: unknown[]) => loadSettingsMock(...args),
    saveSettings: vi.fn(),
    check: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

describe('AnkiConnectSettingsSection i18n', () => {
  beforeEach(() => {
    loadSettingsMock.mockReset();
    loadSettingsMock.mockResolvedValue({
      anki_connect_enabled: true,
      anki_connect_auto_import_enabled: false,
      anki_connect_delete_apkg_after_import: false,
      anki_connect_open_folder_on_failure: false,
      anki_connect_export_deck_name: '',
    });
  });

  it('renders the short test-connection label in compact mode', async () => {
    render(<AnkiConnectSettingsSection compact />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
    });
  });
});
