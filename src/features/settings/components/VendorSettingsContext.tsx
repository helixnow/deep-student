/**
 * VendorSettingsContext
 * 
 * 将 vendor 相关的状态和操作通过 Context 提供给子组件，
 * 消除 ApisTab 30+ props 的 prop drilling 问题。
 */

import React, { createContext, useContext } from 'react';
import type { VendorConfig, ModelProfile, ApiConfig } from '@/types';

// 内联编辑状态类型
export interface InlineEditState {
  profileId: string;
  api: ApiConfig;
}

export interface VendorSettingsContextValue {
  // --- 状态 ---
  vendors: VendorConfig[];
  sortedVendors: VendorConfig[];
  selectedVendor: VendorConfig | null;
  selectedVendorId: string | null;
  setSelectedVendorId: (id: string | null) => void;
  selectedVendorModels: Array<{ profile: ModelProfile; api: ApiConfig }>;
  selectedVendorIsSiliconflow: boolean;
  profileCountByVendor: Map<string, number>;
  vendorBusy: boolean;
  vendorSaving: boolean;
  isEditingVendor: boolean;
  vendorFormData: Partial<VendorConfig>;
  setVendorFormData: React.Dispatch<React.SetStateAction<Partial<VendorConfig>>>;
  testingApi: string | null;
  inlineEditState: InlineEditState | null;
  setInlineEditState: (state: InlineEditState | null) => void;
  isAddingNewModel: boolean;
  isSmallScreen: boolean;

  // --- 操作 ---
  handleOpenVendorModal: (vendor?: VendorConfig | null) => void;
  handleStartEditVendor: (vendor: VendorConfig) => void;
  handleCancelEditVendor: () => void;
  handleSaveEditVendor: () => void;
  handleDeleteVendor: (vendor: VendorConfig) => void;
  handleSaveVendorBaseUrl: (vendorId: string, baseUrl: string) => void;
  handleSaveVendorApiKey: (vendorId: string, apiKey: string) => void;
  handleClearVendorApiKey: (vendorId: string) => void;
  handleOpenModelEditor: (vendor: VendorConfig, profile?: ModelProfile) => void;
  handleSaveInlineEdit: (api: ApiConfig) => Promise<void>;
  handleAddModelInline: (vendor: VendorConfig) => void;
  handleCancelAddModel: () => void;
  handleToggleModelProfile: (profile: ModelProfile, enabled: boolean) => void;
  handleDeleteModelProfile: (profile: ModelProfile) => void;
  handleToggleFavorite: (profile: ModelProfile) => void;
  testApiConnection: (api: ApiConfig) => Promise<void>;
  handleSiliconFlowConfig: (config: any) => Promise<string | undefined> | void;
  handleBatchCreateConfigs: (configs: any[]) => Promise<any> | void | undefined;
  handleBatchConfigsCreated: (mapping: { [key: string]: string }) => void;
  onReorderVendors: (reorderedVendors: VendorConfig[]) => void;
  onAddVendorModels?: (vendor: VendorConfig, models: Array<{ modelId: string; label: string }>) => Promise<void>;
}

const VendorSettingsContext = createContext<VendorSettingsContextValue | null>(null);

export const VendorSettingsProvider: React.FC<{
  value: VendorSettingsContextValue;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <VendorSettingsContext.Provider value={value}>
    {children}
  </VendorSettingsContext.Provider>
);

export function useVendorSettings(): VendorSettingsContextValue {
  const ctx = useContext(VendorSettingsContext);
  if (!ctx) {
    throw new Error('useVendorSettings must be used within VendorSettingsProvider');
  }
  return ctx;
}
