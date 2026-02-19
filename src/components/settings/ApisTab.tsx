/**
 * API配置管理 Tab 组件
 * 从 Settings.tsx 拆分，包含完整的 Vendor 和模型配置管理功能
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { Plus, Loader2, Edit, Trash2, Activity, GripVertical, Star, ChevronDown, ChevronUp, X, ExternalLink } from 'lucide-react';
import { NotionButton } from '../ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Textarea } from '../ui/shad/Textarea';
import { Label } from '../ui/shad/Label';
import { Badge } from '../ui/shad/Badge';
import { Switch } from '../ui/shad/Switch';
import { SettingSection } from './SettingsCommon';
import { SiliconFlowSection } from './SiliconFlowSection';
import { VendorApiKeySection } from './VendorApiKeySection';
import { VendorModelFetcher, supportsModelFetching } from './VendorModelFetcher';
import { ShadApiEditModal } from './ShadApiEditModal';
import { cn } from '../../lib/utils';
import { showGlobalNotification } from '../UnifiedNotification';
import { getProviderIcon } from '../../utils/providerIconEngine';
import { openUrl } from '../../utils/urlOpener';
import { SiliconFlowLogo } from '../ui/SiliconFlowLogo';
import type { VendorConfig, ModelProfile, ApiConfig } from '../../types';

// 内联编辑状态类型
interface InlineEditState {
  profileId: string;
  api: ApiConfig;
}

const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, '');

/** 根据供应商 providerType 获取图标路径 */
const getVendorIconPath = (providerType?: string | null): string | null => {
  if (!providerType) return null;
  const key = providerType.toLowerCase();
  const iconMap: Record<string, string> = {
    deepseek: 'deepseek',
    qwen: 'qwen',
    zhipu: 'zhipu',
    doubao: 'doubao',
    minimax: 'minimax',
    moonshot: 'moonshot',
    openai: 'openai',
    gemini: 'gemini',
    anthropic: 'anthropic',
    google: 'gemini',
    ollama: 'ollama',
    mistral: 'mistral',
    meta: 'meta',
  };
  const iconName = iconMap[key];
  return iconName ? `/icons/providers/${iconName}.svg` : null;
};

const getProviderDisplayName = (providerType?: string | null) => {
  if (!providerType) return 'OpenAI';
  const map: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    siliconflow: 'SiliconFlow',
    deepseek: 'DeepSeek',
    ollama: 'Ollama',
  };
  return map[providerType.toLowerCase()] || providerType;
};

/** 根据供应商类型获取官网链接（用于内置供应商的 fallback） */
const getProviderWebsiteUrl = (providerType?: string | null): string | null => {
  if (!providerType) return null;
  const map: Record<string, string> = {
    siliconflow: 'https://siliconflow.cn',
    deepseek: 'https://deepseek.com',
    qwen: 'https://bailian.console.aliyun.com',
    zhipu: 'https://open.bigmodel.cn',
    doubao: 'https://www.volcengine.com/product/doubao',
    minimax: 'https://platform.minimaxi.com',
    moonshot: 'https://platform.moonshot.cn',
    openai: 'https://platform.openai.com',
    gemini: 'https://aistudio.google.com',
    anthropic: 'https://console.anthropic.com',
    google: 'https://aistudio.google.com',
  };
  return map[providerType.toLowerCase()] || null;
};

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
  // 内联编辑相关
  inlineEditState: InlineEditState | null;
  setInlineEditState: (state: InlineEditState | null) => void;
  handleSaveInlineEdit: (api: ApiConfig) => Promise<void>;
  // 内联新增模型相关
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
  // 移动端标识：移动端使用右侧滑动面板，桌面端使用内联编辑
  isSmallScreen?: boolean;
}

export const ApisTab: React.FC<ApisTabProps> = ({
  sortedVendors,
  selectedVendor,
  setSelectedVendorId,
  selectedVendorModels,
  selectedVendorIsSiliconflow,
  profileCountByVendor,
  vendorBusy,
  vendorSaving,
  isEditingVendor,
  vendorFormData,
  setVendorFormData,
  testingApi,
  handleOpenVendorModal,
  handleStartEditVendor,
  handleCancelEditVendor,
  handleSaveEditVendor,
  handleDeleteVendor,
  handleSaveVendorBaseUrl,
  handleSaveVendorApiKey,
  handleClearVendorApiKey,
  handleOpenModelEditor,
  inlineEditState,
  setInlineEditState,
  handleSaveInlineEdit,
  isAddingNewModel,
  handleAddModelInline,
  handleCancelAddModel,
  convertProfileToApiConfig,
  handleToggleModelProfile,
  handleDeleteModelProfile,
  handleToggleFavorite,
  testApiConnection,
  handleSiliconFlowConfig,
  handleBatchCreateConfigs,
  handleBatchConfigsCreated,
  onAddVendorModels,
  isSmallScreen = false,
  onReorderVendors,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [baseUrlDraft, setBaseUrlDraft] = useState('');

  useEffect(() => {
    setBaseUrlDraft(selectedVendor?.baseUrl || '');
  }, [selectedVendor?.id, selectedVendor?.baseUrl]);

  // 拖拽结束处理
  const handleDragEnd = useCallback((result: DropResult) => {
    if (!result.destination) return;
    const sourceIndex = result.source.index;
    const destIndex = result.destination.index;
    if (sourceIndex === destIndex) return;

    // 分离 SiliconFlow 和其他供应商
    const siliconVendors = sortedVendors.filter(v => (v.providerType ?? '').toLowerCase() === 'siliconflow');
    const otherVendors = sortedVendors.filter(v => (v.providerType ?? '').toLowerCase() !== 'siliconflow');

    // 只对非 SiliconFlow 供应商进行重排序
    const reordered = [...otherVendors];
    const [removed] = reordered.splice(sourceIndex, 1);
    reordered.splice(destIndex, 0, removed);

    // 合并 SiliconFlow 和重排序后的供应商
    const finalOrder = [...siliconVendors, ...reordered];
    onReorderVendors(finalOrder);
  }, [sortedVendors, onReorderVendors]);

  // 分离 SiliconFlow 和可拖拽的供应商
  const siliconVendors = sortedVendors.filter(v => (v.providerType ?? '').toLowerCase() === 'siliconflow');
  const draggableVendors = sortedVendors.filter(v => (v.providerType ?? '').toLowerCase() !== 'siliconflow');

  return (
    <div className="space-y-6">
      <SettingSection
        dataTourId="settings-api"
        title={t('settings:sections.api_config_title')}
        description={t('settings:sections.api_config_desc')}
        hideHeader
      >
        {vendorBusy && (
          <div className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{t('settings:saving')}</span>
          </div>
        )}

        <div className="flex flex-col gap-8 md:grid md:grid-cols-[minmax(180px,200px)_1fr]">
          <div className="space-y-3 w-full min-w-0 pr-0 md:pr-6 md:border-r border-border/40 md:sticky md:top-6 md:self-start">
            <div className="w-full">
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">
                  {t('settings:vendor_panel.list_title')}
                </div>
                <NotionButton variant="ghost" size="sm" iconOnly onClick={() => handleOpenVendorModal(null)}>
                  <Plus className="h-3.5 w-3.5" />
                </NotionButton>
              </div>
              {sortedVendors.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-sm text-muted-foreground bg-muted/10">
                  <div>{t('settings:vendor_panel.empty_vendors')}</div>
                  <div className="mt-1 text-xs">{t('settings:vendor_panel.empty_vendors_desc')}</div>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {/* SiliconFlow 置顶，不可拖拽 */}
                  {siliconVendors.map(vendor => {
                    const isActive = selectedVendor?.id === vendor.id;
                    const modelCount = profileCountByVendor.get(vendor.id) ?? 0;
                    const providerLabel = getProviderDisplayName(vendor.providerType);
                    return (
                      <NotionButton variant="ghost" size="sm" key={vendor.id} onClick={() => setSelectedVendorId(vendor.id)}
                        className={cn('!rounded-lg !px-3 !py-2 text-left w-full !justify-start group relative',
                          isActive ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')}>
                        <div className="flex flex-wrap items-center justify-between gap-1.5 w-full">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <SiliconFlowLogo className="h-3.5 shrink-0" />
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            {modelCount > 0 && <span className="text-[10px] text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded-full">{modelCount}</span>}
                          </div>
                        </div>
                      </NotionButton>
                    );
                  })}
                  {/* 其他供应商可拖拽排序 */}
                  <DragDropContext onDragEnd={handleDragEnd}>
                    <Droppable droppableId="vendor-list">
                      {(provided) => (
                        <div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col gap-1">
                          {draggableVendors.map((vendor, index) => {
                            const isActive = selectedVendor?.id === vendor.id;
                            const modelCount = profileCountByVendor.get(vendor.id) ?? 0;
                            const providerLabel = getProviderDisplayName(vendor.providerType);
                            const iconPath = getVendorIconPath(vendor.providerType);
                            return (
                              <Draggable key={vendor.id} draggableId={vendor.id} index={index}>
                                {(provided, snapshot) => {
                                  // 修复 CustomScrollArea 内拖拽偏移问题
                                  const style = provided.draggableProps.style;
                                  const draggingStyle = snapshot.isDragging ? {
                                    ...style,
                                    left: 'auto',
                                    top: 'auto',
                                  } : style;
                                  return (
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    {...provided.dragHandleProps}
                                    style={draggingStyle}
                                    onClick={() => setSelectedVendorId(vendor.id)}
                                    className={cn(
                                      'rounded-lg px-3 py-2 text-left transition-all w-full flex items-center gap-2 cursor-grab active:cursor-grabbing group',
                                      isActive ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                                      snapshot.isDragging && 'shadow-lg ring-1 ring-border bg-card z-50'
                                    )}
                                  >
                                    {iconPath && <img src={iconPath} alt="" className="h-4 w-4 shrink-0 object-contain" />}
                                    <div className="flex-1 min-w-0 text-left">
                                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                                        <div className="flex flex-col min-w-0 flex-1">
                                          <span className="truncate">{vendor.name || providerLabel}</span>
                                        </div>
                                        {modelCount > 0 && <span className="text-[10px] text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded-full">{modelCount}</span>}
                                      </div>
                                    </div>
                                  </div>
                                  );
                                }}
                              </Draggable>
                            );
                          })}
                          {provided.placeholder}
                        </div>
                      )}
                    </Droppable>
                  </DragDropContext>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-8 w-full min-w-0">
            {selectedVendor ? (
              <>
                <div className="w-full">
                  <div className="flex flex-col gap-2 mb-6">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        {selectedVendorIsSiliconflow && <SiliconFlowLogo className="h-5" />}
                        <h3 className="text-lg font-medium text-foreground truncate">{selectedVendor.name || getProviderDisplayName(selectedVendor.providerType)}</h3>
                        {(() => {
                          const websiteUrl = selectedVendor.websiteUrl || getProviderWebsiteUrl(selectedVendor.providerType);
                          return websiteUrl ? (
                            <NotionButton
                              size="sm"
                              variant="ghost"
                              iconOnly
                              className="opacity-60 hover:opacity-100"
                              onClick={() => void openUrl(websiteUrl)}
                              title={t('settings:vendor_panel.open_website')}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </NotionButton>
                          ) : null;
                        })()}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {isEditingVendor ? (
                          <>
                            <NotionButton size="sm" variant="ghost" onClick={handleCancelEditVendor}>{t('common:actions.cancel')}</NotionButton>
                            <NotionButton size="sm" variant="primary" onClick={handleSaveEditVendor} disabled={vendorSaving}>{t('common:actions.save')}</NotionButton>
                          </>
                        ) : (
                          <>
                            <NotionButton size="sm" variant="ghost" onClick={() => handleStartEditVendor(selectedVendor)}>{t('common:actions.edit')}</NotionButton>
                            {!selectedVendorIsSiliconflow && <NotionButton size="sm" variant="danger" onClick={() => handleDeleteVendor(selectedVendor)}>{t('common:actions.delete')}</NotionButton>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                    {isEditingVendor ? (
                      <>
                        <div className="md:col-span-2 space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">{t('settings:vendor_modal.name_label')}</Label>
                          <Input value={vendorFormData.name || ''} onChange={e => setVendorFormData(prev => ({ ...prev, name: e.target.value }))} placeholder={t('settings:vendor_modal.name_placeholder')} />
                        </div>
                        <div className="md:col-span-2 space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">{t('settings:vendor_modal.base_url_label')}</Label>
                          <Input value={vendorFormData.baseUrl || ''} onChange={e => setVendorFormData(prev => ({ ...prev, baseUrl: e.target.value }))} placeholder="https://api.openai.com/v1" className="font-mono" />
                        </div>
                        <div className="md:col-span-2 space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">{t('settings:vendor_modal.notes_label')}</Label>
                          <Textarea value={vendorFormData.notes || ''} onChange={e => setVendorFormData(prev => ({ ...prev, notes: e.target.value }))} placeholder={t('settings:vendor_modal.notes_placeholder')} rows={3} />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="md:col-span-2 space-y-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:vendor_panel.base_url')}</div>
                          <Input
                            value={baseUrlDraft}
                            onChange={(e) => setBaseUrlDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                // 让 onBlur 统一处理保存逻辑（避免重复代码与乱序）
                                (e.currentTarget as HTMLInputElement).blur();
                              }
                            }}
                            onBlur={() => {
                              if (!selectedVendor) return;
                              const normalized = normalizeBaseUrl(baseUrlDraft);
                              if (!normalized) {
                                showGlobalNotification('error', t('settings:vendor_modal.validation_base_url'));
                                setBaseUrlDraft(selectedVendor.baseUrl || '');
                                return;
                              }
                              if (normalizeBaseUrl(selectedVendor.baseUrl || '') === normalized) {
                                return;
                              }
                              handleSaveVendorBaseUrl(selectedVendor.id, normalized);
                            }}
                            placeholder="https://api.openai.com/v1"
                            className="font-mono bg-muted/30 border-transparent focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors"
                            disabled={vendorBusy}
                          />
                        </div>
                        <div className="md:col-span-2 space-y-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:vendor_panel.api_key')}</div>
                          <div className="mt-1">
                            {selectedVendorIsSiliconflow ? (
                              <SiliconFlowSection variant="inline" onCreateConfig={handleSiliconFlowConfig} onBatchCreateConfigs={handleBatchCreateConfigs} onBatchConfigsCreated={handleBatchConfigsCreated} showMessage={showGlobalNotification} />
                            ) : (
                              <VendorApiKeySection vendor={selectedVendor} onSave={(apiKey) => handleSaveVendorApiKey(selectedVendor.id, apiKey)} onClear={() => handleClearVendorApiKey(selectedVendor.id)} showMessage={showGlobalNotification} />
                            )}
                          </div>
                        </div>
                        {selectedVendor.notes && (
                          <div className="md:col-span-2 space-y-2">
                            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:vendor_panel.notes')}</div>
                            <div className="text-sm text-foreground leading-relaxed">{selectedVendor.notes}</div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="w-full pt-8 border-t border-border/40">
                  <div className="space-y-6">
                    {!selectedVendorIsSiliconflow && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                          <h3 className="text-lg font-medium text-foreground">{t('settings:vendor_panel.model_list_title')}</h3>
                          <p className="text-sm text-muted-foreground">{t('settings:vendor_panel.model_list_desc', { count: selectedVendorModels.length })}</p>
                        </div>
                        <NotionButton size="sm" variant="primary" className="flex-shrink-0" onClick={() => {
                          if (isSmallScreen) {
                            handleOpenModelEditor(selectedVendor);
                          } else {
                            handleAddModelInline(selectedVendor);
                          }
                        }}>
                          <Plus className="h-3.5 w-3.5" />{t('settings:vendor_panel.add_model_button')}
                        </NotionButton>
                      </div>
                    )}
                    
                    <div>
                      {selectedVendorIsSiliconflow && (
                        <div className="mb-6">
                          <SiliconFlowSection variant="models" onCreateConfig={handleSiliconFlowConfig} onBatchCreateConfigs={handleBatchCreateConfigs} onBatchConfigsCreated={handleBatchConfigsCreated} showMessage={showGlobalNotification} />
                        </div>
                      )}
                      {!selectedVendorIsSiliconflow && onAddVendorModels && supportsModelFetching(selectedVendor.providerType) && (
                        <div className="mb-6">
                          <VendorModelFetcher
                            vendor={selectedVendor}
                            existingModelIds={selectedVendorModels.map(({ profile }) => profile.model)}
                            onAddModels={onAddVendorModels}
                          />
                        </div>
                      )}
                      <div className="space-y-3">
                      {/* 内联新增模型区域：桌面端，在列表顶部显示 */}
                      {!isSmallScreen && isAddingNewModel && inlineEditState && (
                        <div className="group relative rounded-lg border border-primary/30 bg-muted/30 transition-all duration-200">
                          <div className="pt-3 px-3 pb-3">
                            <ShadApiEditModal
                              api={inlineEditState.api}
                              onSave={async (editedApi) => {
                                await handleSaveInlineEdit(editedApi);
                              }}
                              onCancel={handleCancelAddModel}
                              hideConnectionFields
                              lockedVendorInfo={{
                                name: selectedVendor.name,
                                baseUrl: selectedVendor.baseUrl,
                                providerType: selectedVendor.providerType,
                              }}
                              embeddedMode={true}
                            />
                          </div>
                        </div>
                      )}
                      {selectedVendorModels.length === 0 && !isAddingNewModel ? (
                        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground bg-muted/10">{t('settings:vendor_panel.model_empty')}</div>
                      ) : (
                        <>
                        {selectedVendorModels.map(({ profile, api }) => {
                          const providerIconPath = getProviderIcon(api.model);
                          const isEditing = inlineEditState?.profileId === profile.id;
                          // 为动画保持内容：即使收起也保留 api 数据用于动画
                          const editApiForAnimation = isEditing ? inlineEditState.api : convertProfileToApiConfig(profile, selectedVendor);
                          
                          // 点击编辑按钮：移动端使用右侧滑动面板，桌面端使用内联编辑
                          const handleEditClick = () => {
                            if (isSmallScreen) {
                              // 移动端：使用原有的右侧滑动面板
                              handleOpenModelEditor(selectedVendor, profile);
                            } else {
                              // 桌面端：使用内联编辑
                              if (isEditing) {
                                setInlineEditState(null);
                              } else {
                                // 切换到编辑已有模型时，取消新增模式
                                if (isAddingNewModel) handleCancelAddModel();
                                const editApi = convertProfileToApiConfig(profile, selectedVendor);
                                setInlineEditState({ profileId: profile.id, api: editApi });
                              }
                            }
                          };
                          
                          return (
                            <div key={profile.id} className={cn(
                              "group relative rounded-lg border border-transparent hover:bg-muted/30 transition-all duration-200",
                              isEditing ? "bg-muted/30" : ""
                            )}>
                              {/* 卡片头部：始终显示 */}
                              <div className="p-3 space-y-2">
                                <div className="flex items-start gap-3">
                                  <img src={providerIconPath} alt="" className="h-5 w-5 flex-shrink-0 rounded object-contain mt-0.5 opacity-80" style={{ opacity: providerIconPath.includes('generic.svg') ? 0.5 : 0.8 }} />
                                  <div className="flex-1 min-w-0 space-y-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium text-foreground truncate">{profile.label || api.name}</span>
                                      {!profile.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground whitespace-nowrap shrink-0">{t('settings:status.disabled')}</span>}
                                      {api.isBuiltin && api.isReadOnly && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 whitespace-nowrap shrink-0">{t('settings:api_config.badge_builtin_free')}</span>}
                                    </div>
                                    <div className="font-mono text-xs text-muted-foreground truncate">{api.model}</div>
                                    
                                    {(profile.isMultimodal || profile.isReasoning || profile.isEmbedding || profile.isReranker || profile.supportsTools) && (
                                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                        {profile.isMultimodal && <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">{t('common:api_config_section.model_types.multimodal')}</span>}
                                        {profile.isReasoning && <span className="text-[10px] px-1.5 py-0.5 rounded border border-purple-200 text-purple-600 dark:border-purple-900/30 dark:text-purple-400">{t('settings:api_config.badge_reasoning')}</span>}
                                        {profile.isEmbedding && <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">{t('common:api_config_section.model_types.embedding')}</span>}
                                        {profile.isReranker && <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">{t('common:api_config_section.model_types.reranker')}</span>}
                                        {profile.supportsTools && <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-200 text-blue-600 dark:border-blue-900/30 dark:text-blue-400">{t('common:api_config_section.badges.tools')}</span>}
                                      </div>
                                    )}
                                    
                                    {/* 操作按钮区域 - 改为上下布局，始终显示 */}
                                    <div className="flex items-center gap-1 pt-2">
                                      <Switch checked={profile.enabled} onCheckedChange={value => handleToggleModelProfile(profile, value)} disabled={(api.isBuiltin && api.isReadOnly) || vendorBusy} className="scale-75 mr-2" />
                                      <NotionButton size="sm" variant="ghost" iconOnly className={cn(profile.isFavorite && "text-yellow-500")} onClick={() => handleToggleFavorite(profile)} disabled={vendorBusy} title={t('settings:api_config.toggle_favorite')}>
                                        <Star className={cn("h-3.5 w-3.5", profile.isFavorite && "fill-current")} />
                                      </NotionButton>
                                      <NotionButton 
                                        size="sm" 
                                        variant={!isSmallScreen && isEditing ? "default" : "ghost"} 
                                        iconOnly
                                        onClick={handleEditClick} 
                                        disabled={vendorBusy} 
                                        title={!isSmallScreen && isEditing ? t('common:actions.close') : t('common:actions.edit')}
                                      >
                                        {!isSmallScreen && isEditing ? <ChevronUp className="h-3.5 w-3.5" /> : <Edit className="h-3.5 w-3.5" />}
                                      </NotionButton>
                                      <NotionButton size="sm" variant="ghost" iconOnly onClick={() => void testApiConnection(api)} disabled={testingApi === api.id || vendorBusy} title={t('settings:api_config.test_button')}>
                                        {testingApi === api.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
                                      </NotionButton>
                                      <NotionButton size="sm" variant="ghost" iconOnly onClick={() => handleDeleteModelProfile(profile)} disabled={(api.isBuiltin && api.isReadOnly) || vendorBusy} title={t('common:actions.delete')} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></NotionButton>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              
                              {/* 内联编辑区域：仅桌面端显示，带动画 */}
                              {!isSmallScreen && (
                                <div 
                                  className={cn(
                                    "grid transition-all duration-300 ease-in-out",
                                    isEditing ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                                  )}
                                >
                                  <div className="overflow-hidden">
                                    <div className="pt-3 px-3 pb-3">
                                      <ShadApiEditModal
                                        api={editApiForAnimation}
                                        onSave={async (editedApi) => {
                                          await handleSaveInlineEdit(editedApi);
                                          setInlineEditState(null);
                                        }}
                                        onCancel={() => setInlineEditState(null)}
                                        hideConnectionFields
                                        lockedVendorInfo={{
                                          name: selectedVendor.name,
                                          baseUrl: selectedVendor.baseUrl,
                                          providerType: selectedVendor.providerType,
                                        }}
                                        embeddedMode={true}
                                      />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-border/60 p-10 text-center text-muted-foreground">{t('settings:vendor_panel.create_vendor_cta')}</div>
            )}
          </div>
        </div>
      </SettingSection>
    </div>
  );
};

export default ApisTab;
