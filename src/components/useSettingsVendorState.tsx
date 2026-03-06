import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { VendorConfig, ModelProfile, ApiConfig, ModelAssignments } from '../types';
import { showGlobalNotification } from './UnifiedNotification';
import { getErrorMessage } from '../utils/errorUtils';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import { NotionButton } from '@/components/ui/NotionButton';
import { GENERAL_DEFAULT_MIN_P, GENERAL_DEFAULT_TOP_K } from './settings/ShadApiEditModal';
import { convertProfileToApiConfig, convertApiConfigToProfile, normalizeBaseUrl, providerTypeFromConfig } from './settings/modelConverters';
import { inferCapabilities, getModelDefaultParameters, applyProviderSpecificAdjustments } from '../utils/modelCapabilities';
import { inferApiCapabilities } from '../utils/apiCapabilityEngine';
import { type UnifiedModelInfo } from './shared/UnifiedModelSelector';
import type { UseSettingsVendorStateDeps } from './settings/hookDepsTypes';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

export function useSettingsVendorState(deps: UseSettingsVendorStateDeps) {
  const { resolvedApiConfigs, vendorLoading, vendorSaving, vendors, modelProfiles, modelAssignments, config, t, loading, upsertVendor, upsertModelProfile, deleteModelProfile, persistAssignments, persistModelProfiles, persistVendors, refreshVendors, refreshProfiles, refreshApiConfigsFromBackend, isSmallScreen, setScreenPosition, setRightPanelType, activeTab, deleteVendorById: deleteVendor } = deps;

  const apiConfigsForApisTab = resolvedApiConfigs;
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [vendorModalOpen, setVendorModalOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<VendorConfig | null>(null);
  const [isEditingVendor, setIsEditingVendor] = useState(false);
  const [vendorFormData, setVendorFormData] = useState<Partial<VendorConfig>>({});
  const [modelEditor, setModelEditor] = useState<{ vendor: VendorConfig; profile?: ModelProfile; api: ApiConfig } | null>(null);
  // 内联编辑状态（用于卡片展开编辑）
  const [inlineEditState, setInlineEditState] = useState<{ profileId: string; api: ApiConfig } | null>(null);
  // 标记当前是否正在内联新增模型
  const [isAddingNewModel, setIsAddingNewModel] = useState(false);
  const [modelDeleteDialog, setModelDeleteDialog] = useState<{
    profile: ModelProfile;
    referencingKeys: Array<keyof ModelAssignments>;
  } | null>(null);
  const [vendorDeleteDialog, setVendorDeleteDialog] = useState<VendorConfig | null>(null);
  const [testingApi, setTestingApi] = useState<string | null>(null);
  const vendorBusy = vendorLoading || vendorSaving;
  const sortedVendors = useMemo(() => {
    const sorted = [...vendors];
    sorted.sort((a, b) => {
      // SiliconFlow 始终置顶
      const aSilicon = (a.providerType ?? '').toLowerCase() === 'siliconflow';
      const bSilicon = (b.providerType ?? '').toLowerCase() === 'siliconflow';
      if (aSilicon !== bSilicon) {
        return aSilicon ? -1 : 1;
      }
      // 按 sortOrder 排序，没有 sortOrder 的放到最后
      const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      // sortOrder 相同则按名称排序
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }, [vendors]);
  const selectedVendor = useMemo(() => {
    if (sortedVendors.length === 0) {
      return null;
    }
    if (!selectedVendorId) {
      return sortedVendors[0];
    }
    return sortedVendors.find(v => v.id === selectedVendorId) ?? sortedVendors[0];
  }, [sortedVendors, selectedVendorId]);
  const selectedVendorProfiles = useMemo(
    () => (selectedVendor ? modelProfiles.filter(mp => mp.vendorId === selectedVendor.id) : []),
    [modelProfiles, selectedVendor]
  );
  const selectedVendorModels = useMemo(
    () =>
      selectedVendor
        ? selectedVendorProfiles
            .map(profile => {
              const api = convertProfileToApiConfig(profile, selectedVendor);
              return api ? { profile, api } : null;
            })
            .filter((row): row is { profile: ModelProfile; api: ApiConfig } => Boolean(row))
            // 收藏的模型置顶
            .sort((a, b) => {
              if (a.profile.isFavorite && !b.profile.isFavorite) return -1;
              if (!a.profile.isFavorite && b.profile.isFavorite) return 1;
              return 0;
            })
        : [],
    [selectedVendorProfiles, selectedVendor]
  );
  const profileCountByVendor = useMemo(() => {
    const map = new Map<string, number>();
    modelProfiles.forEach(profile => {
      map.set(profile.vendorId, (map.get(profile.vendorId) ?? 0) + 1);
    });
    return map;
  }, [modelProfiles]);
  const selectedVendorIsSiliconflow = ((selectedVendor?.providerType ?? '').toLowerCase() === 'siliconflow');
  useEffect(() => {
    if (sortedVendors.length === 0) {
      setSelectedVendorId(null);
      return;
    }
    if (!selectedVendorId || !sortedVendors.some(v => v.id === selectedVendorId)) {
      setSelectedVendorId(sortedVendors[0].id);
    }
  }, [sortedVendors, selectedVendorId]);

  // 切换供应商时退出编辑模式
  useEffect(() => {
    setIsEditingVendor(false);
    setVendorFormData({});
  }, [selectedVendorId]);

  const testApiConnection = async (api: ApiConfig) => {
    if (api.isBuiltin) {
      // 内置模型同样允许测试（后端可通过 vendor_id 从安全存储读取真实密钥）
      showGlobalNotification('info', t('settings:notifications.api_test_start', { name: api.name }));
    }

    // 注意：API 密钥可能是 *** 占位符（安全遮蔽），后端会从安全存储获取真实密钥
    // 前端只检查是否完全没有配置（空字符串且没有 vendorId）
    const apiKeyTrimmed = (api.apiKey || '').trim();
    const hasVendorId = !!api.vendorId;
    
    // 如果 apiKey 是空且没有 vendorId，才报错（占位符如 *** 由后端处理）
    if (!apiKeyTrimmed && !hasVendorId) {
      showGlobalNotification('error', t('settings:notifications.api_key_required'));
      return;
    }

    if (!api.model.trim()) {
      showGlobalNotification('error', t('common:model_name_required'));
      return;
    }

    setTestingApi(api.id);

    try {
      if (invoke) {
        // 使用用户指定的模型名称进行测试
        // 传递 vendor_id 以便后端从安全存储获取真实密钥
        const vendorId = api.vendorId;
        const result = await invoke('test_api_connection', {
          // 双写兼容：后端参数为 snake_case（api_key, api_base），某些桥接层可能校验 camelCase
          api_key: api.apiKey,
          apiKey: api.apiKey,
          api_base: api.baseUrl,
          apiBase: api.baseUrl,
          model: api.model, // 传递用户指定的模型名称
          vendor_id: vendorId, // 传递供应商 ID 以便后端获取真实密钥
          vendorId: vendorId,
        });
        
        if (result) {
          showGlobalNotification('success', t('settings:notifications.api_test_success', { name: api.name, model: api.model }));
        } else {
          showGlobalNotification('error', t('settings:notifications.api_test_failed', { name: api.name, model: api.model }));
        }
      } else {
        // 浏览器环境模拟
        await new Promise(resolve => setTimeout(resolve, 2000));
        showGlobalNotification('success', t('settings:notifications.api_test_success_mock', { name: api.name }));
      }
    } catch (error) {
      console.error('连接测试失败:', error);
      console.log('🔍 [前端调试] API配置:', {
        name: api.name,
        baseUrl: api.baseUrl,
        model: api.model,
        modelAdapter: api.modelAdapter || 'unknown',
        apiKeyLength: api.apiKey.length,
        vendorId: api.vendorId,
      });
      
      // 提取更详细的错误信息
      let errorMessage = '';
      if (typeof error === 'string') {
        errorMessage = error;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        errorMessage = JSON.stringify(error, null, 2);
      } else {
        errorMessage = String(error);
      }
      
      console.error('🔍 [前端调试] 详细错误信息:', errorMessage);
      showGlobalNotification('error', t('settings:notifications.api_test_error', { name: api.name, error: errorMessage }));
    } finally {
      setTestingApi(null);
    }
  };

  const ensureVendorForConfig = useCallback(
    async (configData: Omit<ApiConfig, 'id'>) => {
      const normalizedBase = normalizeBaseUrl(configData.baseUrl || '');
      const normalizedKey = (configData.apiKey || '').trim();
      const providerType = providerTypeFromConfig(configData.providerType, configData.modelAdapter);
      const existing =
        vendors.find(
          vendor =>
            normalizeBaseUrl(vendor.baseUrl || '') === normalizedBase &&
            (vendor.providerType === providerType || (!vendor.providerType && providerType === 'openai'))
        ) ?? null;
      if (existing) {
        let needsUpdate = false;
        const updated: VendorConfig = { ...existing };
        if (normalizedKey && normalizedKey !== (existing.apiKey || '').trim()) {
          updated.apiKey = normalizedKey;
          needsUpdate = true;
        }
        if (configData.vendorName && configData.vendorName !== existing.name) {
          updated.name = configData.vendorName;
          needsUpdate = true;
        }
        if (needsUpdate) {
          return upsertVendor(updated);
        }
        return existing;
      }
      const newVendor: VendorConfig = {
        id: '',
        name: configData.vendorName || configData.name || `${providerType.toUpperCase()} Vendor`,
        providerType,
        baseUrl: configData.baseUrl,
        apiKey: configData.apiKey,
        headers: configData.headers ?? {},
        rateLimitPerMinute: undefined,
        defaultTimeoutMs: undefined,
        notes: undefined,
        isBuiltin: false,
        isReadOnly: false,
      };
      return upsertVendor(newVendor);
    },
    [upsertVendor, vendors]
  );

  const maskApiKey = (key?: string | null) => {
    if (!key) return '***';
    const length = key.length;
    if (length <= 6) {
      return `${'*'.repeat(Math.max(length - 2, 0))}${key.slice(-2)}`;
    }
    return `${key.slice(0, 3)}****${key.slice(-3)}`;
  };

  const getProviderDisplayName = useCallback(
    (providerType?: string | null) =>
      t(`settings:vendor_modal.providers.${providerType ?? 'openai'}`, {
        defaultValue: providerType ?? 'openai',
      }),
    [t]
  );

  const handleOpenVendorModal = (vendor?: VendorConfig | null) => {
    if (!vendor) {
      void (async () => {
        try {
          const created = await upsertVendor({
            id: '',
            name: t('settings:vendor_panel.default_new_vendor_name'),
            providerType: 'custom',
            baseUrl: '',
            apiKey: '',
            headers: {},
            rateLimitPerMinute: undefined,
            defaultTimeoutMs: undefined,
            notes: '',
            isBuiltin: false,
            isReadOnly: false,
            sortOrder: vendors.length,
          });
          setSelectedVendorId(created.id);
          setVendorFormData({
            ...created,
            headers: created.headers || {},
          });
          setIsEditingVendor(true);
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          showGlobalNotification('error', t('settings:notifications.vendor_save_failed', { error: errorMessage }));
        }
      })();
      return;
    }
    setEditingVendor(vendor ?? null);
    setVendorModalOpen(true);
    // 移动端：使用右侧滑动面板
    if (isSmallScreen) {
      setRightPanelType('vendorConfig');
      setScreenPosition('right');
    }
  };

  const handleStartEditVendor = (vendor: VendorConfig) => {
    setVendorFormData({
      ...vendor,
      headers: vendor.headers || {},
    });
    setIsEditingVendor(true);
  };

  const handleCancelEditVendor = () => {
    setIsEditingVendor(false);
    setVendorFormData({});
  };

  const handleSaveEditVendor = async () => {
    try {
      if (!vendorFormData.name?.trim()) {
        showGlobalNotification('error', t('settings:vendor_modal.validation_name'));
        return;
      }
      if (!vendorFormData.baseUrl?.trim()) {
        showGlobalNotification('error', t('settings:vendor_modal.validation_base_url'));
        return;
      }

      const saved = await upsertVendor({
        ...selectedVendor!,
        ...vendorFormData,
        id: selectedVendor!.id,
      } as VendorConfig);
      setIsEditingVendor(false);
      setVendorFormData({});
      setSelectedVendorId(saved.id);
      showGlobalNotification('success', t('common:config_saved'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.vendor_save_failed', { error: errorMessage }));
    }
  };

  const handleSaveVendorModal = async (vendorData: VendorConfig) => {
    try {
      const saved = await upsertVendor(vendorData);
      setVendorModalOpen(false);
      setEditingVendor(null);
      setSelectedVendorId(saved.id);
      // 移动端：关闭右侧面板
      if (isSmallScreen) {
        closeRightPanel();
      }
      showGlobalNotification('success', t('common:config_saved'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.vendor_save_failed', { error: errorMessage }));
    }
  };

  const handleDeleteVendor = (vendor: VendorConfig) => {
    if (vendor.isBuiltin) {
      showGlobalNotification('error', t('settings:vendor_panel.cannot_delete_builtin'));
      return;
    }
    setVendorDeleteDialog(vendor);
  };

  const handleSaveVendorApiKey = async (vendorId: string, apiKey: string) => {
    try {
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor) {
        throw new Error(t('settings:mcp.vendor_not_found'));
      }
      const updated = { ...vendor, apiKey };
      await upsertVendor(updated);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(errorMessage);
    }
  };

  const handleSaveVendorBaseUrl = async (vendorId: string, baseUrl: string) => {
    try {
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor) {
        throw new Error(t('settings:mcp.vendor_not_found'));
      }
      const updated = { ...vendor, baseUrl };
      await upsertVendor(updated);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('保存接口地址失败:', errorMessage);
      showGlobalNotification('error', t('settings:vendor_panel.base_url_save_failed'));
    }
  };

  const handleClearVendorApiKey = async (vendorId: string) => {
    try {
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor) {
        throw new Error(t('settings:mcp.vendor_not_found'));
      }
      const updated = { ...vendor, apiKey: '' };
      await upsertVendor(updated);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(errorMessage);
    }
  };

  const handleReorderVendors = async (reorderedVendors: VendorConfig[]) => {
    try {
      // 更新所有供应商的 sortOrder
      const updatedVendors = reorderedVendors.map((v, index) => ({
        ...v,
        sortOrder: index,
      }));
      await persistVendors?.(updatedVendors);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('保存供应商排序失败:', errorMessage);
      showGlobalNotification('error', t('settings:vendor_panel.reorder_failed'));
    }
  };

  const confirmDeleteVendor = async () => {
    if (!vendorDeleteDialog) return;
    try {
      await deleteVendor(vendorDeleteDialog.id);
      showGlobalNotification('success', t('settings:notifications.vendor_deleted'));
      if (selectedVendorId === vendorDeleteDialog.id) {
        setSelectedVendorId(null);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.vendor_delete_failed', { error: errorMessage }));
    } finally {
      setVendorDeleteDialog(null);
    }
  };

  const handleOpenModelEditor = (vendor: VendorConfig, profile?: ModelProfile) => {
    const baseAdapter = providerTypeFromConfig(vendor.providerType, vendor.providerType);
    const isGeneralAdapter = baseAdapter === 'general';
    const draftApi: ApiConfig = profile
      ? convertProfileToApiConfig(profile, vendor)
      : {
          id: `model_${Date.now()}`,
          name: `${vendor.name} Model`,
          vendorId: vendor.id,
          vendorName: vendor.name,
          providerType: vendor.providerType,
          apiKey: vendor.apiKey ?? '',
          baseUrl: vendor.baseUrl,
          model: '',
          isMultimodal: false,
          isReasoning: false,
          isEmbedding: false,
          isReranker: false,
          enabled: true,
          modelAdapter: baseAdapter,
          maxOutputTokens: 8192,
          temperature: 0.7,
          supportsTools: true,
          geminiApiVersion: 'v1',
          isBuiltin: false,
          isReadOnly: profile?.isBuiltin ?? false,
          reasoningEffort: undefined,
          thinkingEnabled: false,
          thinkingBudget: undefined,
          includeThoughts: false,
          enableThinking: false,
          minP: isGeneralAdapter ? GENERAL_DEFAULT_MIN_P : undefined,
          topK: isGeneralAdapter ? GENERAL_DEFAULT_TOP_K : undefined,
          supportsReasoning: false,
          headers: vendor.headers,
        };
    setModelEditor({ vendor, profile, api: draftApi });
  };

  const handleSaveModelProfile = async (api: ApiConfig) => {
    if (!modelEditor) return;
    const vendor = modelEditor.vendor;
    const toSave = convertApiConfigToProfile(api, vendor.id);
    toSave.enabled = api.enabled;
    toSave.status = api.enabled ? 'enabled' : 'disabled';
    try {
      await upsertModelProfile(toSave);
      showGlobalNotification('success', t('common:config_saved'));
      setModelEditor(null);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  };

  // 内联编辑保存处理（用于卡片展开编辑）
  const handleSaveInlineEdit = async (api: ApiConfig) => {
    if (!selectedVendor) return;
    const toSave = convertApiConfigToProfile(api, selectedVendor.id);
    toSave.enabled = api.enabled;
    toSave.status = api.enabled ? 'enabled' : 'disabled';
    try {
      await upsertModelProfile(toSave);
      showGlobalNotification('success', t('common:config_saved'));
      setInlineEditState(null);
      setIsAddingNewModel(false);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  };

  // 桌面端内联新增模型
  const handleAddModelInline = (vendor: VendorConfig) => {
    const baseAdapter = providerTypeFromConfig(vendor.providerType, vendor.providerType);
    const isGeneralAdapter = baseAdapter === 'general';
    const tempId = `new_model_${Date.now()}`;
    const draftApi: ApiConfig = {
      id: tempId,
      name: `${vendor.name} Model`,
      vendorId: vendor.id,
      vendorName: vendor.name,
      providerType: vendor.providerType,
      apiKey: vendor.apiKey ?? '',
      baseUrl: vendor.baseUrl,
      model: '',
      isMultimodal: false,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
      enabled: true,
      modelAdapter: baseAdapter,
      maxOutputTokens: 8192,
      temperature: 0.7,
      supportsTools: true,
      geminiApiVersion: 'v1',
      isBuiltin: false,
      isReadOnly: false,
      reasoningEffort: undefined,
      thinkingEnabled: false,
      thinkingBudget: undefined,
      includeThoughts: false,
      enableThinking: false,
      minP: isGeneralAdapter ? GENERAL_DEFAULT_MIN_P : undefined,
      topK: isGeneralAdapter ? GENERAL_DEFAULT_TOP_K : undefined,
      supportsReasoning: false,
      headers: vendor.headers,
    };
    setInlineEditState({ profileId: tempId, api: draftApi });
    setIsAddingNewModel(true);
  };

  // ===== 移动端三屏布局相关 hooks =====
  // 关闭右侧面板的通用函数
  const closeRightPanel = useCallback(() => {
    setRightPanelType('none');
    setScreenPosition('center');
  }, []);

  // 当打开编辑器时自动切换到右侧面板
  useEffect(() => {
    if (isSmallScreen && modelEditor) {
      setRightPanelType('modelEditor');
      setScreenPosition('right');
    }
  }, [isSmallScreen, modelEditor]);

  // 关闭编辑器时返回中间视图
  const handleCloseModelEditor = useCallback(() => {
    setModelEditor(null);
    if (isSmallScreen) {
      closeRightPanel();
    }
  }, [isSmallScreen, closeRightPanel]);

  // 保存模型配置后关闭编辑器
  const handleSaveModelProfileAndClose = useCallback(async (api: ApiConfig) => {
    await handleSaveModelProfile(api);
    handleCloseModelEditor();
  }, [handleSaveModelProfile, handleCloseModelEditor]);

  const handleDeleteModelProfile = (profile: ModelProfile) => {
    if (profile.isBuiltin) {
      showGlobalNotification('error', t('settings:common_labels.builtin_cannot_delete'));
      return;
    }
    const referencingKeys = (Object.keys(modelAssignments) as Array<keyof ModelAssignments>).filter(
      key => modelAssignments[key] === profile.id
    );
    setModelDeleteDialog({ profile, referencingKeys });
  };

  const confirmDeleteModelProfile = async () => {
    if (!modelDeleteDialog) return;
    const { profile, referencingKeys } = modelDeleteDialog;
    try {
      if (referencingKeys.length > 0) {
        const clearedAssignments: ModelAssignments = { ...modelAssignments };
        referencingKeys.forEach(key => {
          clearedAssignments[key] = null;
        });
        await persistAssignments(clearedAssignments);
      }
      await deleteModelProfile(profile.id);
      showGlobalNotification('success', t('settings:notifications.api_deleted'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.api_delete_failed', { error: errorMessage }));
    } finally {
      setModelDeleteDialog(null);
    }
  };

  const handleToggleModelProfile = async (profile: ModelProfile, enabled: boolean) => {
    try {
      await upsertModelProfile({
        ...profile,
        enabled,
        status: enabled ? 'enabled' : 'disabled',
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  };

  const handleToggleFavorite = useCallback(async (profile: ModelProfile) => {
    try {
      await upsertModelProfile({
        ...profile,
        isFavorite: !profile.isFavorite,
      });
      // 收藏操作不再显示toast，避免打扰用户
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  }, [upsertModelProfile, t]);

  const handleSiliconFlowConfig = async (configData: Omit<ApiConfig, 'id'>): Promise<string | null> => {
    try {
      const vendor = await ensureVendorForConfig(configData);
      const newProfile = convertApiConfigToProfile(
        { ...configData, id: `sf_${Date.now()}` } as ApiConfig,
        vendor.id
      );
      newProfile.enabled = configData.enabled ?? true;
      newProfile.status = newProfile.enabled ? 'enabled' : 'disabled';
      const saved = await upsertModelProfile(newProfile);
      return saved.id;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
      return null;
    }
  };

  // 通用供应商模型批量添加（由 VendorModelFetcher 调用）
  const handleAddVendorModels = useCallback(async (
    vendor: VendorConfig,
    models: Array<{ modelId: string; label: string }>
  ) => {
    let nextProfiles = [...modelProfiles];
    let changed = false;
    for (const { modelId, label } of models) {
      const normalizedModel = modelId.trim().toLowerCase();
      const existing = nextProfiles.find(
        p => p.vendorId === vendor.id && p.model.trim().toLowerCase() === normalizedModel
      );
      if (existing) continue; // 已存在，跳过

      const caps = inferCapabilities({ id: modelId, providerScope: vendor.providerType, name: label });
      const extCaps = inferApiCapabilities({ id: modelId, name: label, providerScope: vendor.providerType });
      const defaults = getModelDefaultParameters(modelId);

      const effectiveSupportsReasoning =
        caps.supportsReasoning ||
        extCaps.reasoning ||
        extCaps.supportsReasoningEffort ||
        extCaps.supportsThinkingTokens ||
        extCaps.supportsHybridReasoning;

      const enableThinkingDefault = effectiveSupportsReasoning
        ? defaults.enableThinking ?? (extCaps.supportsThinkingTokens || extCaps.supportsHybridReasoning || caps.isReasoning)
        : false;

      const modelAdapter = vendor.providerType?.toLowerCase() === 'gemini' ? 'google' : caps.modelAdapter;
      const geminiApiVersion = vendor.providerType?.toLowerCase() === 'gemini' ? 'v1beta' : undefined;

      const profile: ModelProfile = {
        id: `vm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        vendorId: vendor.id,
        label: label || modelId,
        model: modelId,
        modelAdapter,
        isMultimodal: caps.isMultimodal,
        isReasoning: effectiveSupportsReasoning,
        isEmbedding: caps.isEmbedding,
        isReranker: caps.isReranker,
        supportsTools: caps.supportsTools,
        supportsReasoning: effectiveSupportsReasoning,
        status: 'enabled',
        enabled: true,
        maxOutputTokens: defaults.maxOutputTokens ?? 8192,
        temperature: defaults.temperature ?? 0.7,
        thinkingEnabled: enableThinkingDefault,
        includeThoughts: effectiveSupportsReasoning ? (defaults.includeThoughts ?? extCaps.supportsThinkingTokens) : false,
        enableThinking: enableThinkingDefault,
        thinkingBudget: effectiveSupportsReasoning ? defaults.thinkingBudget : undefined,
        minP: defaults.minP,
        topK: defaults.topK,
        geminiApiVersion,
        isBuiltin: false,
      };

      // 供应商特定调整
      const adjustments = applyProviderSpecificAdjustments({
        modelId,
        supportsTools: caps.supportsTools,
        supportsReasoning: caps.supportsReasoning,
      });
      if (adjustments.enableThinking !== undefined) {
        profile.enableThinking = adjustments.enableThinking;
        profile.thinkingEnabled = adjustments.enableThinking;
      }
      if (adjustments.includeThoughts !== undefined) profile.includeThoughts = adjustments.includeThoughts;
      if (adjustments.thinkingBudget !== undefined) profile.thinkingBudget = adjustments.thinkingBudget;

      nextProfiles.push(profile);
      changed = true;
    }
    if (changed) {
      await persistModelProfiles(nextProfiles);
    }
  }, [modelProfiles, persistModelProfiles]);

  // 获取所有启用的对话模型，支持包含当前已分配但被禁用的模型
  const getAllEnabledApis = (currentValue?: string) => {
    const enabledApis = config.apiConfigs.filter(api => api.enabled && !api.isEmbedding && !api.isReranker);
    if (currentValue && !enabledApis.some(api => api.id === currentValue)) {
      const disabledApi = config.apiConfigs.find(api => api.id === currentValue && !api.isEmbedding && !api.isReranker);
      if (disabledApi) {
        return [...enabledApis, { ...disabledApi, _isDisabledInList: true }];
      }
    }
    return enabledApis;
  };

  // 获取嵌入模型，支持包含当前已分配但被禁用的模型
  const getEmbeddingApis = (currentValue?: string) => {
    // 只返回嵌入模型，不包含重排序模型（优先级：isEmbedding 且非 isReranker）
    const enabledApis = config.apiConfigs.filter(api => api.enabled && api.isEmbedding === true && api.isReranker !== true);
    if (currentValue && !enabledApis.some(api => api.id === currentValue)) {
      const disabledApi = config.apiConfigs.find(api => api.id === currentValue && api.isEmbedding === true && api.isReranker !== true);
      if (disabledApi) {
        return [...enabledApis, { ...disabledApi, _isDisabledInList: true }];
      }
    }
    return enabledApis;
  };

  // 获取重排序模型，支持包含当前已分配但被禁用的模型
  const getRerankerApis = (currentValue?: string) => {
    // 只返回重排序模型（优先级：isReranker）
    const enabledApis = config.apiConfigs.filter(api => api.enabled && api.isReranker === true);
    if (currentValue && !enabledApis.some(api => api.id === currentValue)) {
      const disabledApi = config.apiConfigs.find(api => api.id === currentValue && api.isReranker === true);
      if (disabledApi) {
        return [...enabledApis, { ...disabledApi, _isDisabledInList: true }];
      }
    }
    return enabledApis;
  };

  // 转换 ApiConfig 到 UnifiedModelInfo 格式
  const toUnifiedModelInfo = (apis: (ApiConfig & { _isDisabledInList?: boolean })[]): UnifiedModelInfo[] => {
    return apis.map(api => ({
      id: api.id,
      name: api.name,
      model: api.model,
      isMultimodal: api.isMultimodal,
      isReasoning: api.isReasoning,
      isDisabled: api._isDisabledInList || false,
      isFavorite: api.isFavorite || false,
    }));
  };

  // 批量创建硅基流动配置，一次性保存多条
  const handleBatchCreateConfigs = async (
    configs: Array<Omit<ApiConfig, 'id'> & { tempId: string }>
  ): Promise<{ success: boolean; idMap: { [tempId: string]: string } }> => {
    const idMap: { [tempId: string]: string } = {};
    try {
      let nextProfiles = [...modelProfiles];
      let changed = false;
      for (const configItem of configs) {
        const vendor = await ensureVendorForConfig(configItem);
        const normalizedModel = configItem.model.trim().toLowerCase();
        const existingProfile = nextProfiles.find(
          profile =>
            profile.vendorId === vendor.id && profile.model.trim().toLowerCase() === normalizedModel
        );
        if (existingProfile) {
          idMap[configItem.tempId] = existingProfile.id;
          continue;
        }
        const profile = convertApiConfigToProfile(
          { ...configItem, id: configItem.tempId } as ApiConfig,
          vendor.id
        );
        profile.enabled = configItem.enabled ?? true;
        profile.status = profile.enabled ? 'enabled' : 'disabled';
        nextProfiles = nextProfiles.filter(mp => mp.id !== profile.id);
        nextProfiles.push(profile);
        idMap[configItem.tempId] = profile.id;
        changed = true;
      }
      if (changed) {
        await persistModelProfiles(nextProfiles);
      }
      return { success: true, idMap };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
      return { success: false, idMap };
    }
  };
  // 应用模型分配预设封装逻辑
  const handleApplyPreset = async (assignments: ModelAssignments) => {
    try {
      const merged: ModelAssignments = { ...modelAssignments };
      (Object.keys(assignments) as Array<keyof ModelAssignments>).forEach(key => {
        const value = assignments[key];
        if (value !== null && value !== undefined && value !== '') {
          merged[key] = value;
        }
      });
      await persistAssignments(merged);
      showGlobalNotification('success', t('settings:mcp_descriptions.preset_applied_saved'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('应用预设失败:', error);
      showGlobalNotification('error', t('settings:messages.preset_apply_failed', { error: errorMessage }));
    }
  };

  // 批量创建完成后，自动更新模型分配
  const handleBatchConfigsCreated = (mapping: { [key: string]: string }) => {
    const assignments: ModelAssignments = {
      model2_config_id: mapping[t('settings:mapping_keys.model2_configured')] || null,
      anki_card_model_config_id: mapping[t('settings:mapping_keys.anki_configured')] || null,
      qbank_ai_grading_model_config_id: mapping[t('settings:mapping_keys.qbank_ai_grading_configured')] || null,
      // 嵌入模型通过维度管理设置，不在此处分配
      embedding_model_config_id: null,
      reranker_model_config_id: mapping[t('settings:mapping_keys.reranker_configured')] || null,
      chat_title_model_config_id: mapping[t('settings:mapping_keys.chat_title_configured')] || null,
      exam_sheet_ocr_model_config_id: mapping[t('settings:mapping_keys.exam_sheet_ocr_configured')] || null,
      translation_model_config_id: mapping[t('settings:mapping_keys.translation_configured')] || null,
      // 多模态知识库模型（嵌入模型通过维度管理设置）
      vl_embedding_model_config_id: null,
      vl_reranker_model_config_id: null,
      memory_decision_model_config_id: mapping[t('settings:mapping_keys.memory_decision_configured')] || null,
    };
    handleApplyPreset(assignments);
  };
  // 检查键是否为敏感键
  const isSensitiveKey = (key: string): boolean => {
    const sensitivePatterns = [
      'web_search.api_key.',
      'api_configs',
      'mcp.transport.',
      '.api_key',
      '.secret',
      '.password',
      '.token'
    ];
    return sensitivePatterns.some(pattern => key.includes(pattern));
  };
  // 简易密码输入带明文切换
  const PasswordInputWithToggle: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string; widthClass?: string }>
    = ({ value, onChange, placeholder, widthClass }) => {
    const [show, setShow] = useState(false);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className={`${widthClass || 'w-80'} rounded-lg border border-input bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent`}
            />
        <NotionButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setShow(s => !s)}
          title={show ? t('common:actions.hide') : t('common:actions.show')}
        >{show ? t('common:actions.hide') : t('common:actions.show')}</NotionButton>
      </div>
    );
  };

  return { selectedVendorId, setSelectedVendorId, vendorModalOpen, setVendorModalOpen, editingVendor, setEditingVendor, isEditingVendor, vendorFormData, setVendorFormData, modelEditor, setModelEditor, inlineEditState, setInlineEditState, isAddingNewModel, setIsAddingNewModel, modelDeleteDialog, setModelDeleteDialog, vendorDeleteDialog, setVendorDeleteDialog, testingApi, vendorBusy, sortedVendors, selectedVendor, selectedVendorModels, profileCountByVendor, selectedVendorIsSiliconflow, testApiConnection, handleOpenVendorModal, handleStartEditVendor, handleCancelEditVendor, handleSaveEditVendor, handleSaveVendorModal, handleDeleteVendor, handleSaveVendorApiKey, handleSaveVendorBaseUrl, handleReorderVendors, confirmDeleteVendor, handleOpenModelEditor, handleSaveModelProfile, handleSaveInlineEdit, handleAddModelInline, handleCloseModelEditor, handleSaveModelProfileAndClose, handleDeleteModelProfile, confirmDeleteModelProfile, handleToggleModelProfile, handleToggleFavorite, handleSiliconFlowConfig, handleAddVendorModels, getAllEnabledApis, getEmbeddingApis, getRerankerApis, toUnifiedModelInfo, handleBatchCreateConfigs, handleApplyPreset, handleBatchConfigsCreated, handleClearVendorApiKey, isSensitiveKey, PasswordInputWithToggle, maskApiKey, apiConfigsForApisTab };
}
