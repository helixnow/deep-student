import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { VendorSidebar } from '../VendorSidebar';
import {
  VendorSettingsProvider,
  type VendorSettingsContextValue,
} from '../VendorSettingsContext';
import type { VendorConfig } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      if (typeof options === 'string') return options;
      return options?.defaultValue ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const vendor: VendorConfig = {
  id: 'vendor-1',
  name: 'DeepSeek',
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
};

const renderSidebar = (isSmallScreen: boolean) => {
  const setSelectedVendorId = vi.fn();
  const openMobileVendorDetail = vi.fn();
  const value = {
    vendors: [vendor],
    sortedVendors: [vendor],
    selectedVendor: null,
    selectedVendorId: null,
    setSelectedVendorId,
    selectedVendorModels: [],
    selectedVendorIsSiliconflow: false,
    profileCountByVendor: new Map(),
    vendorBusy: false,
    vendorSaving: false,
    isEditingVendor: false,
    vendorFormData: {},
    setVendorFormData: vi.fn(),
    testingApi: null,
    inlineEditState: null,
    setInlineEditState: vi.fn(),
    isAddingNewModel: false,
    isSmallScreen,
    openMobileVendorDetail,
    closeMobileVendorDetail: vi.fn(),
    handleOpenVendorModal: vi.fn(),
    handleStartEditVendor: vi.fn(),
    handleCancelEditVendor: vi.fn(),
    handleSaveEditVendor: vi.fn(),
    handleDeleteVendor: vi.fn(),
    handleSaveVendorBaseUrl: vi.fn(),
    handleSaveVendorApiKey: vi.fn(),
    handleClearVendorApiKey: vi.fn(),
    handleOpenModelEditor: vi.fn(),
    handleSaveInlineEdit: vi.fn(),
    handleToggleModelProfile: vi.fn(),
    handleDeleteModelProfile: vi.fn(),
    handleToggleFavorite: vi.fn(),
    testApiConnection: vi.fn(),
    handleSiliconFlowConfig: vi.fn(),
    handleBatchCreateConfigs: vi.fn(),
    handleBatchConfigsCreated: vi.fn(),
    onReorderVendors: vi.fn(),
  } as unknown as VendorSettingsContextValue;

  render(
    <VendorSettingsProvider value={value}>
      <VendorSidebar />
    </VendorSettingsProvider>,
  );
  return { setSelectedVendorId, openMobileVendorDetail };
};

describe('VendorSidebar 行 a11y（P2-9）', () => {
  it('移动端（拖拽关闭）：行有 role=button/tabIndex，Enter 与 Space 均可激活并进入详情', () => {
    const { setSelectedVendorId, openMobileVendorDetail } = renderSidebar(true);
    const row = screen.getByRole('button', { name: /DeepSeek/ });

    expect(row.tagName).toBe('DIV');
    expect(row).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(setSelectedVendorId).toHaveBeenCalledWith('vendor-1');
    expect(openMobileVendorDetail).toHaveBeenCalledTimes(1);

    setSelectedVendorId.mockClear();
    openMobileVendorDetail.mockClear();

    fireEvent.keyDown(row, { key: ' ' });
    expect(setSelectedVendorId).toHaveBeenCalledWith('vendor-1');
    expect(openMobileVendorDetail).toHaveBeenCalledTimes(1);
  });

  it('桌面端（拖拽启用）：Enter 激活选中但不进移动端详情；Space 留给 dnd 拖拽不触发激活', () => {
    const { setSelectedVendorId, openMobileVendorDetail } = renderSidebar(false);
    const row = screen.getByRole('button', { name: /DeepSeek/ });

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(setSelectedVendorId).toHaveBeenCalledWith('vendor-1');
    expect(openMobileVendorDetail).not.toHaveBeenCalled();

    setSelectedVendorId.mockClear();

    fireEvent.keyDown(row, { key: ' ' });
    expect(setSelectedVendorId).not.toHaveBeenCalled();
  });
});
