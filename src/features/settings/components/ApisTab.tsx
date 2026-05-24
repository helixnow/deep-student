/**
 * API配置管理 Tab 组件
 * 
 * 重构后的薄壳组件：接收 props 并通过 VendorSettingsContext 提供给子组件。
 * 实际渲染逻辑拆分到 VendorSidebar 和 VendorDetailPanel。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { SettingSection } from './SettingsCommon';
import { VendorSettingsProvider, type VendorSettingsContextValue } from './VendorSettingsContext';
import { VendorSidebar } from './VendorSidebar';
import { VendorDetailPanel } from './VendorDetailPanel';
import type { VendorConfig, ModelProfile, ApiConfig } from '@/types';

// 内联编辑状态类型（保持向后兼容）
interface InlineEditState {
  profileId: string;
  api: ApiConfig;
}

interface ApisTabProps {
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
  handleOpenVendorModal: (vendor?: VendorConfig | null) => void;
  handleStartEditVendor: (vendor: VendorConfig) => void;
  handleCancelEditVendor: () => void;
  handleSaveEditVendor: () => void;
  handleDeleteVendor: (vendor: VendorConfig) => void;
  handleSaveVendorBaseUrl: (vendorId: string, baseUrl: string) => void;
  handleSaveVendorApiKey: (vendorId: string, apiKey: string) => void;
  handleClearVendorApiKey: (vendorId: string) => void;
  handleOpenModelEditor: (vendor: VendorConfig, profile?: ModelProfile) => void;
  inlineEditState: InlineEditState | null;
  setInlineEditState: (state: InlineEditState | null) => void;
  handleSaveInlineEdit: (api: ApiConfig) => Promise<void>;
  isAddingNewModel: boolean;
  handleAddModelInline: (vendor: VendorConfig) => void;
  handleCancelAddModel: () => void;
  convertProfileToApiConfig: (profile: ModelProfile, vendor: VendorConfig) => ApiConfig;
  handleToggleModelProfile: (profile: ModelProfile, enabled: boolean) => void;
  handleDeleteModelProfile: (profile: ModelProfile) => void;
  handleToggleFavorite: (profile: ModelProfile) => void;
  testApiConnection: (api: ApiConfig) => Promise<void>;
  handleSiliconFlowConfig: (config: any) => Promise<string | undefined> | void;
  handleBatchCreateConfigs: (configs: any[]) => Promise<any> | void | undefined;
  handleBatchConfigsCreated: (mapping: { [key: string]: string }) => void;
  onReorderVendors: (reorderedVendors: VendorConfig[]) => void;
  onAddVendorModels?: (vendor: VendorConfig, models: Array<{ modelId: string; label: string }>) => Promise<void>;
  isSmallScreen?: boolean;
}

export const ApisTab: React.FC<ApisTabProps> = (props) => {
  const { t } = useTranslation(['settings', 'common']);

  // 将 props 映射为 Context value
  const contextValue: VendorSettingsContextValue = {
    vendors: props.vendors,
    sortedVendors: props.sortedVendors,
    selectedVendor: props.selectedVendor,
    selectedVendorId: props.selectedVendorId,
    setSelectedVendorId: props.setSelectedVendorId,
    selectedVendorModels: props.selectedVendorModels,
    selectedVendorIsSiliconflow: props.selectedVendorIsSiliconflow,
    profileCountByVendor: props.profileCountByVendor,
    vendorBusy: props.vendorBusy,
    vendorSaving: props.vendorSaving,
    isEditingVendor: props.isEditingVendor,
    vendorFormData: props.vendorFormData,
    setVendorFormData: props.setVendorFormData,
    testingApi: props.testingApi,
    inlineEditState: props.inlineEditState,
    setInlineEditState: props.setInlineEditState,
    isAddingNewModel: props.isAddingNewModel,
    isSmallScreen: props.isSmallScreen ?? false,
    handleOpenVendorModal: props.handleOpenVendorModal,
    handleStartEditVendor: props.handleStartEditVendor,
    handleCancelEditVendor: props.handleCancelEditVendor,
    handleSaveEditVendor: props.handleSaveEditVendor,
    handleDeleteVendor: props.handleDeleteVendor,
    handleSaveVendorBaseUrl: props.handleSaveVendorBaseUrl,
    handleSaveVendorApiKey: props.handleSaveVendorApiKey,
    handleClearVendorApiKey: props.handleClearVendorApiKey,
    handleOpenModelEditor: props.handleOpenModelEditor,
    handleSaveInlineEdit: props.handleSaveInlineEdit,
    handleAddModelInline: props.handleAddModelInline,
    handleCancelAddModel: props.handleCancelAddModel,
    handleToggleModelProfile: props.handleToggleModelProfile,
    handleDeleteModelProfile: props.handleDeleteModelProfile,
    handleToggleFavorite: props.handleToggleFavorite,
    testApiConnection: props.testApiConnection,
    handleSiliconFlowConfig: props.handleSiliconFlowConfig,
    handleBatchCreateConfigs: props.handleBatchCreateConfigs,
    handleBatchConfigsCreated: props.handleBatchConfigsCreated,
    onReorderVendors: props.onReorderVendors,
    onAddVendorModels: props.onAddVendorModels,
  };

  return (
    <div className="space-y-4">
      <SettingSection
        dataTourId="settings-api"
        title={t('settings:sections.api_config_title')}
        description={t('settings:sections.api_config_desc')}
        hideHeader
        className="py-0"
        contentClassName="space-y-4"
      >
        <VendorSettingsProvider value={contextValue}>
          <div className="flex flex-col gap-6 md:grid md:grid-cols-[minmax(180px,200px)_1fr]">
            <VendorSidebar />
            <div className="space-y-6 w-full min-w-0">
              <VendorDetailPanel />
            </div>
          </div>
        </VendorSettingsProvider>
      </SettingSection>
    </div>
  );
};

export default ApisTab;
