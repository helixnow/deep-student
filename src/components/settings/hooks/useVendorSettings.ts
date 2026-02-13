/**
 * Vendor/API 配置相关状态 Hook
 * 从 Settings.tsx 拆分
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { VendorConfig, ModelProfile, ApiConfig } from '../../../types';
import { useVendorModels } from '../../../hooks/useVendorModels';
// ★ 图谱模块已废弃 - IrecConstants 已移除
const convertProfileToApiConfig = (_profile: unknown): unknown => ({});

export interface VendorSettingsState {
  selectedVendorId: string | null;
  setSelectedVendorId: (id: string | null) => void;
  vendorModalOpen: boolean;
  setVendorModalOpen: (open: boolean) => void;
  editingVendor: VendorConfig | null;
  setEditingVendor: (vendor: VendorConfig | null) => void;
  isEditingVendor: boolean;
  setIsEditingVendor: (editing: boolean) => void;
  vendorFormData: Partial<VendorConfig>;
  setVendorFormData: (data: Partial<VendorConfig>) => void;
  modelEditor: { vendor: VendorConfig; profile?: ModelProfile; api: ApiConfig } | null;
  setModelEditor: (editor: { vendor: VendorConfig; profile?: ModelProfile; api: ApiConfig } | null) => void;
  modelDeleteDialog: { api: ApiConfig; vendor: VendorConfig } | null;
  setModelDeleteDialog: (dialog: { api: ApiConfig; vendor: VendorConfig } | null) => void;
  vendorDeleteDialog: VendorConfig | null;
  setVendorDeleteDialog: (vendor: VendorConfig | null) => void;
  testingApi: string | null;
  setTestingApi: (id: string | null) => void;
  
  // 计算属性
  vendors: VendorConfig[];
  selectedVendor: VendorConfig | undefined;
  resolvedApiConfigs: ApiConfig[];
  vendorBusy: boolean;
  
  // 操作函数
  handleOpenVendorModal: (vendor: VendorConfig | null) => void;
  handleCloseVendorModal: () => void;
}

export function useVendorSettings(): VendorSettingsState {
  const { t } = useTranslation(['settings', 'common']);
  
  // 状态
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [vendorModalOpen, setVendorModalOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<VendorConfig | null>(null);
  const [isEditingVendor, setIsEditingVendor] = useState(false);
  const [vendorFormData, setVendorFormData] = useState<Partial<VendorConfig>>({});
  const [modelEditor, setModelEditor] = useState<{ vendor: VendorConfig; profile?: ModelProfile; api: ApiConfig } | null>(null);
  const [modelDeleteDialog, setModelDeleteDialog] = useState<{ api: ApiConfig; vendor: VendorConfig } | null>(null);
  const [vendorDeleteDialog, setVendorDeleteDialog] = useState<VendorConfig | null>(null);
  const [testingApi, setTestingApi] = useState<string | null>(null);
  
  // 使用 vendor models hook
  const {
    vendors,
    modelProfiles,
    resolvedApiConfigs: hookResolvedApiConfigs,
    loading: vendorLoading,
    saving: vendorSaving,
  } = useVendorModels();
  
  // 计算属性
  const selectedVendor = useMemo(() => 
    vendors.find(v => v.id === selectedVendorId),
    [vendors, selectedVendorId]
  );
  
  const resolvedApiConfigs = hookResolvedApiConfigs;
  
  const vendorBusy = vendorLoading || vendorSaving;
  
  // 操作函数
  const handleOpenVendorModal = useCallback((vendor: VendorConfig | null) => {
    if (vendor) {
      setEditingVendor(vendor);
      setIsEditingVendor(true);
      setVendorFormData(vendor);
    } else {
      setEditingVendor(null);
      setIsEditingVendor(false);
      setVendorFormData({});
    }
    setVendorModalOpen(true);
  }, []);
  
  const handleCloseVendorModal = useCallback(() => {
    setVendorModalOpen(false);
    setEditingVendor(null);
    setIsEditingVendor(false);
    setVendorFormData({});
  }, []);
  
  return {
    selectedVendorId,
    setSelectedVendorId,
    vendorModalOpen,
    setVendorModalOpen,
    editingVendor,
    setEditingVendor,
    isEditingVendor,
    setIsEditingVendor,
    vendorFormData,
    setVendorFormData,
    modelEditor,
    setModelEditor,
    modelDeleteDialog,
    setModelDeleteDialog,
    vendorDeleteDialog,
    setVendorDeleteDialog,
    testingApi,
    setTestingApi,
    vendors,
    selectedVendor,
    resolvedApiConfigs,
    vendorBusy,
    handleOpenVendorModal,
    handleCloseVendorModal,
  };
}
