import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { VendorConfigModal } from '../VendorConfigModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      const labels: Record<string, string> = {
        'settings:vendor_modal.title_new': '添加供应商',
        'settings:vendor_modal.subtitle': '配置供应商的 API 凭据和基础参数',
        'settings:vendor_modal.name_label': '供应商名称',
        'settings:vendor_modal.name_placeholder': '请输入供应商名称',
        'settings:vendor_modal.provider_label': '供应商类型',
        'settings:vendor_modal.providers.custom': '自定义',
        'settings:vendor_modal.providers.deepseek': 'DeepSeek',
        'common:actions.cancel': '取消',
        'common:actions.save': '保存',
      };
      return labels[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

describe('VendorConfigModal add vendor flow', () => {
  it('starts with the requested title, vendor name field, and provider type dropdown', async () => {
    const user = userEvent.setup();
    const handleSave = vi.fn();

    render(
      <VendorConfigModal
        open
        vendor={null}
        onClose={vi.fn()}
        onSave={handleSave}
      />,
    );

    expect(await screen.findByRole('heading', { name: '添加供应商' })).toBeInTheDocument();

    const nameInput = screen.getByLabelText('供应商名称');
    const providerSelect = screen.getByLabelText('供应商类型');
    expect(providerSelect).toHaveRole('combobox');
    expect(screen.queryByLabelText('接口地址')).not.toBeInTheDocument();

    await user.type(nameInput, 'DeepSeek 镜像');
    await user.selectOptions(providerSelect, 'deepseek');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(handleSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'DeepSeek 镜像',
      providerType: 'deepseek',
      baseUrl: '',
      apiKey: '',
    }));
  });
});
