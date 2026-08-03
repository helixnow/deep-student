import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';

import zhSettings from '@/locales/zh-CN/settings.json';

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
      const value = lookup(zhSettings as Record<string, unknown>, bare);
      return typeof value === 'string' ? value : key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

/** Same key paths used by McpEditorSection policy modal after D3 fix. */
function McpPolicyLabels() {
  const { t } = useTranslation('settings');
  return (
    <div>
      <h2>{t('sections.policy_title')}</h2>
      <label htmlFor="advertiseAll">{t('sections.advertise_all')}</label>
      <p>{t('mcp_descriptions.advertise_all_hint')}</p>
    </div>
  );
}

describe('McpEditorSection i18n keys', () => {
  it('resolves policy title and advertise-all label to localized copy', () => {
    render(<McpPolicyLabels />);

    expect(screen.getByRole('heading', { name: 'MCP 工具权限' })).toBeInTheDocument();
    expect(screen.getByText('公开全部工具')).toBeInTheDocument();
    expect(screen.getByText('启用后所有工具对 AI 可见')).toBeInTheDocument();
  });
});
