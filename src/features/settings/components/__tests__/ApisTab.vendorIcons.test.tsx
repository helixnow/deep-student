import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApisTab } from '../ApisTab';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { SiliconFlowLogo } from '@/components/ui/SiliconFlowLogo';
import type { ApiConfig, ModelProfile, VendorConfig } from '@/types';

const i18nMock = vi.hoisted(() => ({
  language: 'en-US',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      if (key === 'settings:vendor_modal.providers.siliconflow') {
        return i18nMock.language.startsWith('zh') ? '硅基流动' : 'SiliconFlow';
      }
      if (typeof options === 'string') return options;
      return options?.defaultValue ?? key;
    },
    i18n: {
      changeLanguage: (language: string) => {
        i18nMock.language = language;
        return Promise.resolve();
      },
      get language() {
        return i18nMock.language;
      },
    },
  }),
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
}));

const vendor = (overrides: Partial<VendorConfig>): VendorConfig => ({
  id: 'vendor',
  name: 'Vendor',
  providerType: 'openai',
  baseUrl: 'https://example.test/v1',
  apiKey: '',
  ...overrides,
});

interface RenderApisTabOptions {
  selectedVendor?: VendorConfig | null;
}

const renderApisTab = (sortedVendors: VendorConfig[], options: RenderApisTabOptions = {}) => {
  const noop = vi.fn();
  const selectedVendor = options.selectedVendor ?? null;
  return render(
    <ApisTab
      vendors={sortedVendors}
      sortedVendors={sortedVendors}
      selectedVendor={selectedVendor}
      selectedVendorId={selectedVendor?.id ?? null}
      setSelectedVendorId={noop}
      selectedVendorModels={[]}
      selectedVendorIsSiliconflow={(selectedVendor?.providerType ?? '').toLowerCase() === 'siliconflow'}
      profileCountByVendor={new Map()}
      vendorBusy={false}
      vendorSaving={false}
      isEditingVendor={false}
      vendorFormData={{}}
      setVendorFormData={noop}
      testingApi={null}
      handleOpenVendorModal={noop}
      handleStartEditVendor={noop}
      handleCancelEditVendor={noop}
      handleSaveEditVendor={noop}
      handleDeleteVendor={noop}
      handleSaveVendorBaseUrl={noop}
      handleSaveVendorApiKey={noop}
      handleClearVendorApiKey={noop}
      handleOpenModelEditor={noop}
      inlineEditState={null}
      setInlineEditState={noop}
      handleSaveInlineEdit={vi.fn(async (_api: ApiConfig) => undefined)}
      isAddingNewModel={false}
      handleAddModelInline={noop}
      handleCancelAddModel={noop}
      convertProfileToApiConfig={vi.fn((_profile: ModelProfile, _vendor: VendorConfig) => ({} as ApiConfig))}
      handleToggleModelProfile={noop}
      handleDeleteModelProfile={noop}
      handleToggleFavorite={noop}
      testApiConnection={vi.fn(async (_api: ApiConfig) => undefined)}
      handleSiliconFlowConfig={noop}
      handleBatchCreateConfigs={noop}
      handleBatchConfigsCreated={noop}
      onReorderVendors={noop}
    />,
  );
};

describe('ApisTab vendor list icons', () => {
  beforeEach(() => {
    i18nMock.language = 'en-US';
  });

  it('renders SiliconFlow through the Lobe SiliconCloud SVG data', () => {
    const { container } = render(<ProviderIcon modelId="siliconflow" size={16} showTooltip={false} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelector('path')?.getAttribute('d')).toContain('M22.956 6.521');
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders the standalone SiliconFlow logo through the Lobe icon instead of image assets', () => {
    const { container } = render(<SiliconFlowLogo className="h-5" />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('#6E29F6');
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders NVIDIA through the Lobe icon library for colored provider icons', () => {
    const { container } = render(<ProviderIcon modelId="nvidia" size={16} showTooltip={false} variant="color" />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelector('path')).toHaveAttribute('fill', '#74B71B');
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders Xiaomi MiMo through the Lobe icon library instead of local image assets', () => {
    const { container } = render(<ProviderIcon modelId="mimo" size={16} showTooltip={false} variant="color" />);

    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders Together, Replicate, and Kwaipilot through Lobe components instead of local image assets', () => {
    for (const modelId of ['together', 'replicate', 'kwaipilot']) {
      const { container, unmount } = render(<ProviderIcon modelId={modelId} size={16} showTooltip={false} variant="color" />);

      expect(container.querySelector('svg')).toBeInTheDocument();
      expect(container.querySelector('img')).not.toBeInTheDocument();

      unmount();
    }
  });

  it('renders Moonshot and Zhipu on contrast-preserving brand plates in color mode', () => {
    for (const modelId of ['kimi-k2', 'glm-4.5']) {
      const { container, unmount } = render(<ProviderIcon modelId={modelId} size={16} showTooltip={false} variant="color" />);

      const plate = container.firstElementChild?.firstElementChild as HTMLElement | null;
      expect(plate?.tagName).toBe('SPAN');
      expect(plate?.querySelector('svg')).toBeInTheDocument();
      expect(plate).toHaveStyle({ borderRadius: '50%' });
      expect(container.querySelector('img')).not.toBeInTheDocument();

      unmount();
    }
  });

  it('renders the audited Lobe-backed provider set without local image assets', () => {
    const lobeBackedModelIds = [
      'gpt-4o',
      'claude-3-opus',
      'gemini-2.0-flash',
      'grok-2',
      'phi-4',
      'deepseek-v3.1',
      'qwen3-8b',
      'doubao-1.5-pro',
      'hunyuan-pro',
      'kimi-k2',
      'ernie-4.0',
      'spark-v3.5',
      'yi-34b-chat',
      'baichuan-4',
      'step-1v',
      'bge-m3',
      'internlm3-8b-instruct',
      'flux-1-pro',
      'runway/gen-3-alpha',
      'suno-v4',
      'udio-v1.5',
      'ollama/llama3.2',
      'siliconflow',
      'huggingface',
      'perplexity/sonar',
    ];

    for (const modelId of lobeBackedModelIds) {
      const { container, unmount } = render(<ProviderIcon modelId={modelId} size={16} showTooltip={false} variant="color" />);

      const svg = container.querySelector('svg');
      if (!svg) {
        throw new Error(`Expected ${modelId} to render through Lobe without local img`);
      }
      expect(svg).toBeInTheDocument();
      expect(container.querySelector('img')).not.toBeInTheDocument();

      unmount();
    }
  });

  it('keeps local image fallback only for providers with explicit local brand assets', () => {
    const localFallbackModelIds = ['youdao', 'teleai', 'ant-ling'];

    for (const modelId of localFallbackModelIds) {
      const { container, unmount } = render(<ProviderIcon modelId={modelId} size={16} showTooltip={false} variant="color" />);

      expect(container.querySelector('img')).toBeInTheDocument();

      unmount();
    }
  });

  it('renders unknown providers with an inline svg fallback instead of generic image assets', () => {
    const { container } = render(<ProviderIcon modelId="unknown-model-xyz" size={16} showTooltip={false} variant="color" />);

    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('marks only vendors with configured API keys as color icons', () => {
    renderApisTab([
      vendor({
        id: 'builtin-siliconflow',
        name: 'SiliconFlow',
        providerType: 'siliconflow',
        apiKey: 'sk-siliconflow',
      }),
      vendor({
        id: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        apiKey: '',
      }),
      vendor({
        id: 'masked-deepseek',
        name: 'DeepSeek',
        providerType: 'deepseek',
        apiKey: '***',
      }),
    ]);

    expect(screen.getByTestId('vendor-icon-builtin-siliconflow')).toHaveAttribute('data-icon-tone', 'color');
    expect(screen.getByTestId('vendor-icon-openai')).toHaveAttribute('data-icon-tone', 'muted');
    expect(screen.getByTestId('vendor-icon-masked-deepseek')).toHaveAttribute('data-icon-tone', 'color');
  });

  it('wraps every vendor-list provider icon in the same badge container contract', () => {
    renderApisTab([
      vendor({
        id: 'builtin-siliconflow',
        name: 'SiliconFlow',
        providerType: 'siliconflow',
        apiKey: 'sk-siliconflow',
      }),
      vendor({
        id: 'moonshot',
        name: 'Moonshot',
        providerType: 'moonshot',
        apiKey: 'sk-moonshot',
      }),
      vendor({
        id: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        apiKey: '',
      }),
    ]);

    for (const vendorId of ['vendor-icon-builtin-siliconflow', 'vendor-icon-moonshot', 'vendor-icon-openai']) {
      expect(screen.getByTestId(vendorId)).toHaveAttribute('data-icon-chrome', 'badge');
      expect(screen.getByTestId(vendorId)).toHaveStyle({
        width: '20px',
        height: '20px',
        borderRadius: '9999px',
      });
    }
  });

  it('uses the original Lobe color icon as the enabled vendor base and desaturates disabled vendors', () => {
    renderApisTab([
      vendor({
        id: 'builtin-siliconflow',
        name: 'SiliconFlow',
        providerType: 'siliconflow',
        apiKey: 'sk-siliconflow',
      }),
      vendor({
        id: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        apiKey: '',
      }),
    ]);

    const enabledIcon = screen.getByTestId('vendor-icon-builtin-siliconflow');
    const enabledPath = enabledIcon.querySelector('path');
    expect(enabledPath).toHaveAttribute('fill', '#6E29F6');
    expect(enabledIcon).not.toHaveStyle({ color: '#6E29F6' });
    expect(enabledIcon).not.toHaveStyle({ filter: 'grayscale(1)' });

    const disabledIcon = screen.getByTestId('vendor-icon-openai');
    expect(disabledIcon.querySelector('svg')).toBeInTheDocument();
    expect(disabledIcon.querySelector('img')).not.toBeInTheDocument();
    expect(disabledIcon).toHaveStyle({ filter: 'grayscale(1)' });
  });

  it('keeps the SiliconFlow vendor name visible beside the icon', () => {
    renderApisTab([
      vendor({
        id: 'builtin-siliconflow',
        name: 'SiliconFlow',
        providerType: 'siliconflow',
        apiKey: 'sk-siliconflow',
      }),
    ]);

    expect(screen.getByText('SiliconFlow')).toBeInTheDocument();
  });

  it('shows the SiliconFlow vendor as 硅基流动 in Chinese', () => {
    i18nMock.language = 'zh-CN';

    renderApisTab([
      vendor({
        id: 'builtin-siliconflow',
        name: 'SiliconFlow',
        providerType: 'siliconflow',
        apiKey: 'sk-siliconflow',
      }),
    ]);

    expect(screen.getByText('硅基流动')).toBeInTheDocument();
    expect(screen.queryByText('SiliconFlow')).not.toBeInTheDocument();
  });

  it('does not render a delete action for built-in vendors', () => {
    const builtinOpenAiVendor = vendor({
      id: 'builtin-openai',
      name: 'OpenAI',
      providerType: 'openai',
      apiKey: 'sk-openai',
      isBuiltin: true,
    });

    renderApisTab([builtinOpenAiVendor], { selectedVendor: builtinOpenAiVendor });

    expect(screen.getByRole('button', { name: 'common:actions.edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common:actions.delete' })).not.toBeInTheDocument();
  });
});
