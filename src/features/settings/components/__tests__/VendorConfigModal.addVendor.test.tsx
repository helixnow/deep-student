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
        'settings:vendor_modal.protocol_label': 'API 协议',
        'settings:vendor_modal.providers.custom': '自定义',
        'settings:vendor_modal.providers.deepseek': 'DeepSeek',
        'settings:vendor_modal.protocols.openai_chat_completions': 'OpenAI Chat Completions',
        'settings:vendor_modal.protocols.openai_responses': 'OpenAI Responses',
        'settings:vendor_modal.base_url_label': '接口地址',
        'common:actions.cancel': '取消',
        'common:actions.save': '保存',
      };
      return labels[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/components/ui/shad/Select', async () => {
  const React = await import('react');

  type SelectContextValue = {
    value?: string;
    onValueChange?: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  };

  const SelectContext = React.createContext<SelectContextValue | null>(null);

  const collectOptions = (children: React.ReactNode): Array<{ value: string; label: string }> => {
    const options: Array<{ value: string; label: string }> = [];
    React.Children.forEach(children, child => {
      if (!React.isValidElement(child)) {
        return;
      }
      if ((child.type as any).__mockSelectItem) {
        options.push({
          value: child.props.value,
          label: typeof child.props.children === 'string' ? child.props.children : String(child.props.children),
        });
        return;
      }
      if (child.props?.children) {
        options.push(...collectOptions(child.props.children));
      }
    });
    return options;
  };

  const Select = ({ value, onValueChange, children }: any) => {
    const options = collectOptions(children);
    return (
      <SelectContext.Provider value={{ value, onValueChange, options }}>
        <div>{children}</div>
      </SelectContext.Provider>
    );
  };

  const SelectTrigger = ({ children, ...props }: any) => {
    const ctx = React.useContext(SelectContext);
    return (
      <select
        aria-label={props['aria-label']}
        className={props.className}
        value={ctx?.value ?? ''}
        onChange={e => ctx?.onValueChange?.(e.target.value)}
      >
        {ctx?.options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  };

  const SelectValue = () => null;
  const SelectContent = ({ children }: any) => <>{children}</>;
  const SelectItem = ({ children }: any) => <>{children}</>;
  (SelectItem as any).__mockSelectItem = true;

  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  };
});

describe('VendorConfigModal add vendor flow', () => {
  it('starts with vendor name and provider type, and saves provider-scoped protocol defaults', async () => {
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
    const [providerSelect, protocolSelect] = screen.getAllByRole('combobox');
    const baseUrlInput = screen.getByLabelText('接口地址');

    await user.type(nameInput, 'DeepSeek 镜像');
    await user.type(baseUrlInput, 'https://api.deepseek.com/v1');
    expect(protocolSelect).toHaveValue('openai_chat_completions');
    const responsesCheckbox = screen.getByLabelText('Supports OpenAI Responses');
    await user.click(responsesCheckbox);
    expect(protocolSelect).toHaveValue('openai_responses');
    await user.selectOptions(providerSelect, 'deepseek');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(handleSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'DeepSeek 镜像',
      providerType: 'deepseek',
      apiProtocol: 'openai_responses',
      supportsOpenAIResponses: true,
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
    }));
  }, 15000);
});
