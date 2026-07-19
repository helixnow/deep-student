import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import zhCommon from '@/locales/zh-CN/common.json';
import MultimodalIndexButton from '../MultimodalIndexButton';

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
    t: (key: string) => {
      const bare = key.includes(':') ? key.split(':')[1] : key;
      const value = lookup(zhCommon as Record<string, unknown>, bare);
      return typeof value === 'string' ? value : key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/services/multimodalRagService', () => ({
  MULTIMODAL_INDEX_SUPPORTED: true,
  default: {
    indexResource: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('MultimodalIndexButton i18n', () => {
  it('shows the localized index label', () => {
    render(<MultimodalIndexButton sourceType="attachment" sourceId="res-1" showLabel />);
    expect(screen.getByText('索引到知识库')).toBeInTheDocument();
  });
});
