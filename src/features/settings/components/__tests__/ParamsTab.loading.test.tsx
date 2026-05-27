import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ParamsTab } from '../ParamsTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('../PdfSettingsSection', () => ({
  PdfSettingsSection: () => <div>PdfSettingsSection</div>,
}));

vi.mock('../OcrSettingsSection', () => ({
  OcrSettingsSection: () => <div>OcrSettingsSection</div>,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

describe('ParamsTab loading states', () => {
  it('does not render async-loaded switches until params are loaded', () => {
    render(
      <ParamsTab
        extra={{ paramsLoaded: false }}
        setExtra={vi.fn()}
        invoke={null}
        handleSaveChatStreamTimeout={vi.fn()}
        handleToggleChatStreamAutoCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole('switch', { name: 'common:settings.chat_stream.auto_cancel_label' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'settings:field_labels.semantic_search_fts_filter' })).not.toBeInTheDocument();
  });
});
