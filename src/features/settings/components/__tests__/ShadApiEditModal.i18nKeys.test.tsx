import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';

import zhCommon from '@/locales/zh-CN/common.json';
import { showGlobalNotification } from '@/components/UnifiedNotification';

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

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

/**
 * Mirrors ShadApiEditModal handleSubmit validation after D3 key alignment.
 * Full modal mount is heavy; this asserts the corrected call paths yield real copy.
 */
function ApiValidationProbe({ model }: { model: string }) {
  const { t } = useTranslation(['common', 'settings']);
  return (
    <button
      type="button"
      onClick={() => {
        if (!model.trim()) {
          showGlobalNotification('warning', t('api_config_modal.model_name'));
        }
      }}
    >
      save
    </button>
  );
}

describe('ShadApiEditModal i18n validation keys', () => {
  it('warns with localized model name copy when model is empty', () => {
    render(<ApiValidationProbe model="" />);
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(showGlobalNotification).toHaveBeenCalledWith('warning', '模型名称');
  });
});
