/**
 * VendorDetailPanel - 供应商详情面板
 * 从 ApisTab 拆分，负责渲染选中供应商的配置和模型列表
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, CaretDown, CaretUp, Check, DotsThree, DownloadSimple, Key, LinkSimple, NotePencil, PencilSimple, Plus, Prohibit, Pulse, Spinner, Star, Trash } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Label } from '@/components/ui/shad/Label';
import { Badge } from '@/components/ui/shad/Badge';
import { Switch } from '@/components/ui/shad/Switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/shad/Dialog';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { openUrl } from '@/utils/urlOpener';
import { SiliconFlowLogo } from '@/components/ui/SiliconFlowLogo';
import { ModelCapabilityIcons } from '@/components/shared/ModelCapabilityIcons';
import {
  settingsQuietActiveSurfaceClassName,
  settingsQuietInteractiveRowClassName,
  settingsQuietRowBaseClassName,
} from './SettingsCommon';
import { SiliconFlowSection } from './SiliconFlowSection';
import { VendorApiKeySection } from './VendorApiKeySection';
import { VendorModelFetcher, supportsModelFetching } from './VendorModelFetcher';
import { ShadApiEditModal } from './ShadApiEditModal';
import { OpenAICodexAccountSection } from './OpenAICodexAccountSection';
import { useVendorSettings } from './VendorSettingsContext';
import { convertProfileToApiConfig } from './modelConverters';
import { groupByModelFamily } from './modelFamily';
import type { VendorConfig } from '@/types';
import { isOpenAICodexOAuthVendor } from '@/utils/vendorAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';

// --- Save Status Indicator ---
type SaveStatus = 'idle' | 'saving' | 'saved';

const SaveIndicator: React.FC<{ status: SaveStatus }> = ({ status }) => {
  if (status === 'idle') return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground ui-rise-in">
      {status === 'saving' && <Spinner className="h-3 w-3 animate-spin" />}
      {status === 'saved' && <Check className="h-3 w-3 text-green-500" />}
    </span>
  );
};

// --- 内联编辑折叠容器 ---
// grid-template-rows 0fr→1fr 做高度动画（样式见 settings.css .settings-inline-editor）。
// 收起时缓存最后一次内容并延迟卸载，保证有完整退场动画；内容仅在打开后挂载，避免列表常驻 N 份表单。
const INLINE_EDITOR_MOTION_MS = 400;

const InlineEditorCollapse: React.FC<{
  open: boolean;
  children: React.ReactNode;
  className?: string;
  fill?: boolean;
}> = ({ open, children, className, fill = false }) => {
  const [shouldRender, setShouldRender] = useState(open);
  const lastChildrenRef = useRef<React.ReactNode>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const hasChildren = children != null && children !== false;
  if (hasChildren) {
    lastChildrenRef.current = children;
  }
  // render-phase update：展开的首帧就挂载内容，让高度动画从第一帧开始
  if (open && !shouldRender) {
    setShouldRender(true);
  }

  useEffect(() => {
    if (open) {
      // 展开完成后若编辑区超出视口，轻推滚动到可见位置
      const timer = setTimeout(() => {
        rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, INLINE_EDITOR_MOTION_MS);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      setShouldRender(false);
      lastChildrenRef.current = null;
    }, INLINE_EDITOR_MOTION_MS);
    return () => clearTimeout(timer);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={cn('settings-inline-editor', className)}
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open}
    >
      <div className={cn('settings-inline-editor-clip', fill && 'h-full')}>
        <div className={cn('settings-inline-editor-body', fill && 'h-full min-h-0')}>
          {shouldRender ? (hasChildren ? children : lastChildrenRef.current) : null}
        </div>
      </div>
    </div>
  );
};

const ResponsiveInlineEditorHost: React.FC<{
  floating: boolean;
  testId: string;
  surfaceTestId: string;
  ariaLabel: string;
  children: React.ReactNode;
}> = ({ floating, testId, surfaceTestId, ariaLabel, children }) => {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const [host] = useState<HTMLDivElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div')
  );

  // Keep one portal target for the lifetime of the form. Moving that target preserves
  // ShadApiEditModal's local draft state while escaping transformed/contained ancestors.
  useLayoutEffect(() => {
    if (!host) return;
    const target = floating ? document.body : placeholderRef.current;
    target?.appendChild(host);
  }, [floating, host]);

  useLayoutEffect(() => () => host?.remove(), [host]);

  const content = (
    <div
      data-testid={testId}
      role={floating ? 'dialog' : undefined}
      aria-modal={floating ? true : undefined}
      aria-label={floating ? ariaLabel : undefined}
      className={cn(
        floating &&
          'fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:py-8'
      )}
    >
      <div
        data-testid={surfaceTestId}
        className={cn(
          floating &&
            'h-[min(760px,calc(100dvh-4rem))] w-full max-w-[672px] overflow-hidden rounded-lg border border-border/60 bg-background shadow-2xl'
        )}
      >
        {children}
      </div>
    </div>
  );

  return (
    <div ref={placeholderRef}>
      {host ? createPortal(content, host) : content}
    </div>
  );
};

// --- Helpers ---

const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, '');

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string;

const getProviderDisplayName = (providerType?: string | null, t?: TranslateFn) => {
  if (!providerType) return 'OpenAI';
  const normalizedProviderType = providerType.toLowerCase();
  const map: Record<string, string> = {
    openai: 'OpenAI',
    openai_codex: 'OpenAI Codex',
    anthropic: 'Anthropic',
    google: 'Google',
    siliconflow: 'SiliconFlow',
    deepseek: 'DeepSeek',
    ollama: 'Ollama',
    nvidia: 'NVIDIA',
    mimo: 'Xiaomi MiMo',
  };
  const fallback = map[normalizedProviderType] || providerType;
  return t?.(`settings:vendor_modal.providers.${normalizedProviderType}`, { defaultValue: fallback }) ?? fallback;
};

const getVendorDisplayName = (vendor: VendorConfig, providerLabel: string) => {
  if ((vendor.providerType ?? '').toLowerCase() === 'siliconflow') {
    return providerLabel;
  }
  return vendor.name || providerLabel;
};

const getProviderWebsiteUrl = (providerType?: string | null): string | null => {
  if (!providerType) return null;
  const map: Record<string, string> = {
    siliconflow: 'https://cloud.siliconflow.cn/i/deadXN1B',
    deepseek: 'https://deepseek.com',
    qwen: 'https://bailian.console.aliyun.com',
    zhipu: 'https://open.bigmodel.cn',
    doubao: 'https://www.volcengine.com/product/doubao',
    minimax: 'https://platform.minimaxi.com',
    moonshot: 'https://platform.moonshot.cn',
    openai: 'https://platform.openai.com',
    openai_codex: 'https://chatgpt.com',
    gemini: 'https://aistudio.google.com',
    anthropic: 'https://console.anthropic.com',
    google: 'https://aistudio.google.com',
    nvidia: 'https://build.nvidia.com/nim',
    mimo: 'https://platform.xiaomimimo.com',
  };
  return map[providerType.toLowerCase()] || null;
};

// --- Component ---

export const VendorDetailPanel: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const { isXl } = useBreakpoint();
  const {
    selectedVendor,
    selectedVendorModels,
    selectedVendorIsSiliconflow,
    vendorBusy,
    vendorSaving,
    isEditingVendor,
    vendorFormData,
    setVendorFormData,
    testingApi,
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
    handleToggleModelProfile,
    handleDeleteModelProfile,
    handleToggleFavorite,
    testApiConnection,
    handleSiliconFlowConfig,
    handleBatchCreateConfigs,
    handleBatchConfigsCreated,
    onAddVendorModels,
    triggerPostSaveAutoFlow,
    isSmallScreen,
  } = useVendorSettings();
  const usePanelModelEditor = isSmallScreen || !isXl;
  const useResponsiveInlineDialog = !isSmallScreen && !isXl;

  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [baseUrlSaveStatus, setBaseUrlSaveStatus] = useState<SaveStatus>('idle');
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<string>>(new Set());
  const [isModelFetcherDialogOpen, setIsModelFetcherDialogOpen] = useState(false);
  // 移动端不使用 Dialog（契约：移动端弹层禁承载列表流程），改为模型列表上方的内联卡片
  const [isMobileFetcherOpen, setIsMobileFetcherOpen] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCodexOAuthVendor = isOpenAICodexOAuthVendor(selectedVendor);

  // 判断连接是否已配置（有 baseUrl 且有 apiKey，或 noApiKey 模式）
  const isConnectionConfigured = useMemo(() => {
    if (!selectedVendor) return false;
    const hasUrl = !!(selectedVendor.baseUrl?.trim());
    if (isCodexOAuthVendor) return true;
    if (selectedVendor.noApiKey || selectedVendor.authMode === 'none') return hasUrl;
    const hasKey = !!(selectedVendor.apiKey?.trim());
    return hasUrl && hasKey;
  }, [selectedVendor, isCodexOAuthVendor]);

  // 模型按家族分组（GPT-4 / Claude Opus / Gemini 2.5 …）
  const familyGroups = useMemo(
    () => groupByModelFamily(selectedVendorModels, ({ api }) => api.model),
    [selectedVendorModels],
  );
  // 仅当存在 2 个及以上家族时才分组渲染；否则维持扁平避免噪声
  const shouldGroupByFamily = familyGroups.length >= 2;

  // 切换供应商时重置状态
  useEffect(() => {
    setBaseUrlDraft(selectedVendor?.baseUrl || '');
    setBaseUrlSaveStatus('idle');
    // 已配置的供应商默认收起连接区，未配置的默认展开
    setConnectionExpanded(!isConnectionConfigured);
    // 切换供应商时折叠状态归零（默认全展开）
    setCollapsedFamilies(new Set());
    setIsMobileFetcherOpen(false);
  }, [selectedVendor?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // baseUrl 变化时同步 draft（外部更新）
  useEffect(() => {
    setBaseUrlDraft(selectedVendor?.baseUrl || '');
  }, [selectedVendor?.baseUrl]);

  // 清理 timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleBaseUrlSave = useCallback(() => {
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
    setBaseUrlSaveStatus('saving');
    handleSaveVendorBaseUrl(selectedVendor.id, normalized);
    // 模拟保存完成（实际保存是同步的 state update）
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setBaseUrlSaveStatus('saved');
      saveTimerRef.current = setTimeout(() => setBaseUrlSaveStatus('idle'), 2000);
    }, 300);
  }, [selectedVendor, baseUrlDraft, handleSaveVendorBaseUrl, t]);

  if (!selectedVendor) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 p-10 text-center text-muted-foreground">
        {t('settings:vendor_panel.create_vendor_cta')}
      </div>
    );
  }

  const providerLabel = getProviderDisplayName(selectedVendor.providerType, t);
  const vendorDisplayName = getVendorDisplayName(selectedVendor, providerLabel);

  const renderModelCard = ({ profile, api }: (typeof selectedVendorModels)[number]) => {
    const isEditing = !isAddingNewModel && inlineEditState?.profileId === profile.id;

    const handleEditClick = () => {
      // 移动端走三屏右侧面板；中等宽度走居中 Dialog，避免双侧栏把内联表单压窄。
      // 只有 >= xl 的宽桌面才在模型卡片内展开编辑器。
      if (usePanelModelEditor) {
        if (isAddingNewModel) handleCancelAddModel();
        setInlineEditState(null);
        handleOpenModelEditor(selectedVendor, profile);
        return;
      }
      if (isEditing) {
        setInlineEditState(null);
      } else {
        if (isAddingNewModel) handleCancelAddModel();
        const editApi = convertProfileToApiConfig(profile, selectedVendor);
        setInlineEditState({ profileId: profile.id, api: editApi });
      }
    };

    const isReadOnly = !!(api.isBuiltin && api.isReadOnly);

    return (
      <div key={profile.id} className={cn(
        "group/card relative border border-transparent",
        isEditing
          ? cn(settingsQuietRowBaseClassName, settingsQuietActiveSurfaceClassName)
          : settingsQuietInteractiveRowClassName
      )}>
        {/* 卡片头部 */}
        <div className="p-3">
          <div className="flex items-center gap-3">
            <ProviderIcon modelId={api.model} size={20} showTooltip={false} />
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground truncate">{profile.label || api.name}</span>
                {!profile.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground whitespace-nowrap shrink-0">{t('settings:status.disabled')}</span>}
                {isReadOnly && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary whitespace-nowrap shrink-0">{t('settings:api_config.badge_builtin_free')}</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs text-muted-foreground truncate">{api.model}</span>
                <ModelCapabilityIcons
                  isMultimodal={profile.isMultimodal}
                  isReasoning={profile.isReasoning}
                  isEmbedding={profile.isEmbedding}
                  isReranker={profile.isReranker}
                  supportsTools={profile.supportsTools}
                  size="xs"
                  className="shrink-0 !flex-nowrap"
                />
              </div>
            </div>

            {/* 操作区域：次要操作 + 编辑 + 开关（开关在最右） */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* 次要操作：桌面 hover 时显示；触屏/窄屏无 hover，常显（否则收藏/删除在移动端不可达）。
                  测试连接在窄屏隐藏以节省宽度——编辑器底部已有「测试连接」入口 */}
              <div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 max-md:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity duration-150">
                <NotionButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  className={cn(profile.isFavorite && "text-yellow-500 opacity-100")}
                  onClick={() => handleToggleFavorite(profile)}
                  disabled={vendorBusy}
                  title={t('settings:api_config.toggle_favorite')}
                >
                  <Star className="h-3.5 w-3.5" weight={profile.isFavorite ? 'fill' : 'regular'} />
                </NotionButton>
                <NotionButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  className="max-md:hidden"
                  onClick={() => void testApiConnection(api)}
                  disabled={testingApi === api.id || vendorBusy}
                  title={t('settings:api_config.test_button')}
                >
                  {testingApi === api.id ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <Pulse className="h-3.5 w-3.5" />}
                </NotionButton>

                {/* 删除：触发全局确认对话框 */}
                {!isReadOnly ? (
                  <NotionButton
                    size="sm"
                    variant="ghost"
                    iconOnly
                    disabled={vendorBusy}
                    title={t('common:actions.delete')}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => handleDeleteModelProfile(profile)}
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </NotionButton>
                ) : (
                  /* 占位：保持对齐（窄屏无需占位） */
                  <div className="h-7 w-7 shrink-0 max-md:hidden" />
                )}
              </div>
              {/* 编辑按钮 */}
              <NotionButton
                size="sm"
                variant={isEditing ? "default" : "ghost"}
                iconOnly
                onClick={handleEditClick}
                disabled={vendorBusy}
                title={isEditing ? t('common:actions.close') : t('common:actions.edit')}
              >
                {isEditing ? <CaretUp className="h-3.5 w-3.5" /> : <PencilSimple className="h-3.5 w-3.5" />}
              </NotionButton>
              {/* 开关：最右 */}
              <Switch
                checked={profile.enabled}
                onCheckedChange={value => handleToggleModelProfile(profile, value)}
                disabled={isReadOnly || vendorBusy}
              />
            </div>
          </div>
        </div>

        {/* 内联编辑区：宽桌面在卡片内展开；编辑过程中缩窗则原地提升为浮层，保留未保存表单状态。 */}
        {!isSmallScreen && (
          <ResponsiveInlineEditorHost
            floating={isEditing && useResponsiveInlineDialog}
            testId={`responsive-inline-model-editor-${profile.id}`}
            surfaceTestId={`responsive-inline-model-editor-surface-${profile.id}`}
            ariaLabel={profile.label || api.name}
          >
            <InlineEditorCollapse
              open={isEditing}
              className={cn(isEditing && useResponsiveInlineDialog && 'h-full')}
              fill={isEditing && useResponsiveInlineDialog}
            >
              {isEditing && inlineEditState && (
                <div className={cn(
                  'px-3 pb-3 pt-1',
                  useResponsiveInlineDialog && 'h-full p-3'
                )}>
                  <ShadApiEditModal
                    api={inlineEditState.api}
                    onSave={async (editedApi) => {
                      await handleSaveInlineEdit(editedApi);
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
              )}
            </InlineEditorCollapse>
          </ResponsiveInlineEditorHost>
        )}
      </div>
    );
  };

  return (
    <>
      {/* 供应商头部 */}
      <div className="w-full">
        <div className="mb-5 flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {selectedVendorIsSiliconflow && <SiliconFlowLogo className="h-5" />}
              {isCodexOAuthVendor && (
                <span
                  data-testid={`vendor-detail-icon-${selectedVendor.id}`}
                  className="inline-flex shrink-0 items-center justify-center"
                >
                  <ProviderIcon
                    modelId={selectedVendor.providerType || selectedVendor.name || ''}
                    size={18}
                    showTooltip={false}
                  />
                </span>
              )}
              <h3 className="text-lg font-medium text-foreground truncate">
                {vendorDisplayName}
              </h3>
              {selectedVendorIsSiliconflow && (
                <Badge variant="default" className="bg-primary/10 text-primary border-primary/20 text-[10px] px-1.5 py-0 shrink-0">
                  {t('settings:api.modal.capabilities.recommended')}
                </Badge>
              )}
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
                    <ArrowSquareOut className="h-3.5 w-3.5" />
                  </NotionButton>
                ) : null;
              })()}
            </div>
            {!isCodexOAuthVendor && <div className="flex flex-wrap gap-2">
              {isEditingVendor ? (
                <>
                  <NotionButton size="sm" variant="ghost" onClick={handleCancelEditVendor}>{t('common:actions.cancel')}</NotionButton>
                  <NotionButton size="sm" variant="primary" onClick={handleSaveEditVendor} disabled={vendorSaving}>{t('common:actions.save')}</NotionButton>
                </>
              ) : (
                <>
                  <NotionButton size="sm" variant="ghost" onClick={() => handleStartEditVendor(selectedVendor)}>{t('common:actions.edit')}</NotionButton>
                  {!selectedVendorIsSiliconflow && !selectedVendor.isBuiltin && !selectedVendor.isReadOnly && (
                    <NotionButton size="sm" variant="danger" onClick={() => handleDeleteVendor(selectedVendor)}>{t('common:actions.delete')}</NotionButton>
                  )}
                </>
              )}
            </div>}
          </div>
        </div>

        {/* 连接配置区 — 可折叠 */}
        {isCodexOAuthVendor ? (
          <OpenAICodexAccountSection />
        ) : isEditingVendor ? (
          /* 编辑模式：始终展开完整表单 */
          <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
            <div className="md:col-span-2 space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">{t('settings:vendor_modal.name_label')}</Label>
              <Input value={vendorFormData.name || ''} onChange={e => setVendorFormData(prev => ({ ...prev, name: e.target.value }))} placeholder={t('settings:vendor_modal.name_placeholder')} />
            </div>
            <div className="md:col-span-2 space-y-2">
              <Label className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <LinkSimple className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('settings:vendor_modal.base_url_label')}</span>
              </Label>
              <Input value={vendorFormData.baseUrl || ''} onChange={e => setVendorFormData(prev => ({ ...prev, baseUrl: e.target.value }))} placeholder="https://api.openai.com/v1" className="font-mono" />
            </div>
            <div className="md:col-span-2 space-y-2">
              <Label className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <NotePencil className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('settings:vendor_modal.notes_label')}</span>
              </Label>
              <Textarea value={vendorFormData.notes || ''} onChange={e => setVendorFormData(prev => ({ ...prev, notes: e.target.value }))} placeholder={t('settings:vendor_modal.notes_placeholder')} rows={3} />
            </div>
          </div>
        ) : (
          /* 查看模式：可折叠连接配置 */
          <div className="rounded-lg border border-border/40 overflow-hidden">
            {/* 折叠头部 / 摘要行 */}
            <button
              type="button"
              onClick={() => setConnectionExpanded(v => !v)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0 text-sm">
                <LinkSimple className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                {isConnectionConfigured ? (
                  <span className="flex items-center gap-2 min-w-0 text-muted-foreground">
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    <span className="truncate font-mono text-xs">{selectedVendor.baseUrl}</span>
                    <span className="text-muted-foreground/60 shrink-0">·</span>
                    {selectedVendor.noApiKey ? (
                      <span className="text-xs shrink-0 text-muted-foreground">
                        {t('settings:vendor_panel.no_api_key_needed_short')}
                      </span>
                    ) : (
                      <span className="text-xs shrink-0">{t('settings:vendor_panel.api_key_configured_short')}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    {t('settings:vendor_panel.connection_not_configured')}
                  </span>
                )}
              </div>
              <span className="text-muted-foreground shrink-0">
                {connectionExpanded ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
              </span>
            </button>

            {/* 可折叠内容 */}
            <div
              className={cn(
                "grid transition-all duration-300 ease-in-out",
                connectionExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              )}
            >
              <div className="overflow-hidden">
                <div className="px-4 pb-4 pt-1 space-y-4 text-sm">
                  {/* Base URL */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <LinkSimple className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{t('settings:vendor_panel.base_url')}</span>
                      </div>
                      <SaveIndicator status={baseUrlSaveStatus} />
                    </div>
                    <Input
                      value={baseUrlDraft}
                      onChange={(e) => setBaseUrlDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      onBlur={handleBaseUrlSave}
                      placeholder="https://api.openai.com/v1"
                      className="font-mono bg-muted/30 border-transparent focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors"
                      disabled={vendorBusy}
                    />
                  </div>

                  {/* API Key */}
                  <div className="space-y-1.5">
                    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <Key className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{t('settings:vendor_panel.api_key')}</span>
                    </div>
                    <div>
                      {selectedVendorIsSiliconflow ? (
                        <SiliconFlowSection
                          variant="inline"
                          onCreateConfig={handleSiliconFlowConfig}
                          onBatchCreateConfigs={handleBatchCreateConfigs}
                          onBatchConfigsCreated={handleBatchConfigsCreated}
                          showMessage={showGlobalNotification}
                          onApiKeySaved={(apiKey) => {
                            triggerPostSaveAutoFlow?.({
                              ...selectedVendor,
                              apiKey,
                            });
                          }}
                        />
                      ) : selectedVendor.noApiKey ? (
                        <div className="flex items-center gap-2 rounded-lg border border-border/40 px-4 py-3 text-sm text-muted-foreground">
                          <Prohibit className="h-4 w-4 shrink-0" />
                          <span>{t('settings:vendor_panel.no_api_key_required_hint')}</span>
                        </div>
                      ) : (
                        <VendorApiKeySection
                          key={selectedVendor.id}
                          vendor={selectedVendor}
                          onSave={(apiKey) => handleSaveVendorApiKey(selectedVendor.id, apiKey)}
                          onClear={() => handleClearVendorApiKey(selectedVendor.id)}
                          showMessage={showGlobalNotification}
                          onApiKeySaved={(apiKey) => {
                            triggerPostSaveAutoFlow?.({
                              ...selectedVendor,
                              apiKey,
                            });
                          }}
                        />
                      )}
                    </div>
                  </div>

                  {/* Notes */}
                  {selectedVendor.notes && (
                    <div className="space-y-1.5">
                      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <NotePencil className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{t('settings:vendor_panel.notes')}</span>
                      </div>
                      <div className="text-sm text-foreground leading-relaxed">{selectedVendor.notes}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 模型管理区 */}
      <div className="w-full pt-4">
        <div className="space-y-6">
          {!selectedVendorIsSiliconflow && (
            <div
              className={cn(
                'sticky top-0 md:top-4 z-10 -mx-1 px-1 py-3',
                'bg-[color:var(--shell-workspace-panel)]/85',
                'supports-[backdrop-filter]:bg-[color:var(--shell-workspace-panel)]/65 supports-[backdrop-filter]:backdrop-blur-md',
                'border-b border-border/40',
                'flex flex-wrap items-center justify-between gap-2'
              )}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="text-lg font-medium text-foreground">{t('settings:vendor_panel.model_list_title')}</h3>
                <p className="text-sm text-muted-foreground">{t('settings:vendor_panel.model_list_desc', { count: selectedVendorModels.length })}</p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {!isCodexOAuthVendor && onAddVendorModels && supportsModelFetching(selectedVendor.providerType) && (
                  <NotionButton
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (isSmallScreen) {
                        setIsMobileFetcherOpen(v => !v);
                      } else {
                        setIsModelFetcherDialogOpen(true);
                      }
                    }}
                  >
                    <DownloadSimple className="h-3.5 w-3.5" />
                    {t('settings:vendor_panel.fetch_models_button')}
                  </NotionButton>
                )}
                <NotionButton size="sm" variant="primary" onClick={() => {
                  if (usePanelModelEditor) {
                    if (isAddingNewModel) handleCancelAddModel();
                    setInlineEditState(null);
                    handleOpenModelEditor(selectedVendor);
                    return;
                  }
                  handleAddModelInline(selectedVendor);
                }}>
                  <Plus className="h-3.5 w-3.5" />{t('settings:vendor_panel.add_model_button')}
                </NotionButton>
              </div>
            </div>
          )}

          <div>
            {selectedVendorIsSiliconflow && (
              <div className="mb-6">
                <SiliconFlowSection variant="models" onCreateConfig={handleSiliconFlowConfig} onBatchCreateConfigs={handleBatchCreateConfigs} onBatchConfigsCreated={handleBatchConfigsCreated} showMessage={showGlobalNotification} />
              </div>
            )}
            {/* 移动端：获取模型列表内联卡片（替代桌面 Dialog，遵循移动端无弹层契约） */}
            {!isCodexOAuthVendor && isSmallScreen && isMobileFetcherOpen && onAddVendorModels && supportsModelFetching(selectedVendor.providerType) && (
              <div className="mb-4">
                <VendorModelFetcher
                  key={selectedVendor.id}
                  vendor={selectedVendor}
                  existingModelIds={selectedVendorModels.map(({ profile }) => profile.model)}
                  onAddModels={onAddVendorModels}
                  embedded="card"
                />
              </div>
            )}
            {/* 内联新增模型：宽桌面在列表顶部展开；缩窗后原地提升为浮层。 */}
            {!isSmallScreen && (
              <ResponsiveInlineEditorHost
                floating={!!(isAddingNewModel && inlineEditState && useResponsiveInlineDialog)}
                testId="responsive-inline-new-model-editor"
                surfaceTestId="responsive-inline-new-model-editor-surface"
                ariaLabel={t('settings:vendor_panel.add_model_button')}
              >
                <InlineEditorCollapse
                  open={!!(isAddingNewModel && inlineEditState)}
                  className={cn(isAddingNewModel && inlineEditState && useResponsiveInlineDialog && 'h-full')}
                  fill={!!(isAddingNewModel && inlineEditState && useResponsiveInlineDialog)}
                >
                  {isAddingNewModel && inlineEditState && (
                    <div className={cn('pb-3', useResponsiveInlineDialog && 'h-full p-3')}>
                      <div className={cn(
                        settingsQuietRowBaseClassName,
                        settingsQuietActiveSurfaceClassName,
                        'border border-primary/20',
                        useResponsiveInlineDialog && 'h-full overflow-hidden'
                      )}>
                        <div className={cn('px-3 pb-3 pt-3', useResponsiveInlineDialog && 'h-full')}>
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
                    </div>
                  )}
                </InlineEditorCollapse>
              </ResponsiveInlineEditorHost>
            )}
            <div className="space-y-3">
              {selectedVendorModels.length === 0 && !isAddingNewModel ? (
                <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground bg-muted/10">{t('settings:vendor_panel.model_empty')}</div>
              ) : shouldGroupByFamily ? (
                <div className="space-y-3">
                  {familyGroups.map((group) => {
                    const isCollapsed = collapsedFamilies.has(group.family.id);
                    const groupId = `vendor-family-${group.family.id}`;
                    return (
                      <section
                        key={group.family.id}
                        className="rounded-lg border border-border/40 overflow-hidden"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setCollapsedFamilies((prev) => {
                              const next = new Set(prev);
                              if (next.has(group.family.id)) next.delete(group.family.id);
                              else next.add(group.family.id);
                              return next;
                            });
                          }}
                          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                          aria-expanded={!isCollapsed}
                          aria-controls={groupId}
                        >
                          <div className="flex items-baseline gap-2 min-w-0">
                            <span className="text-sm font-medium text-foreground truncate">{group.family.label}</span>
                            <span className="text-xs text-muted-foreground/60 shrink-0 tabular-nums">{group.items.length}</span>
                          </div>
                          <span className="text-muted-foreground shrink-0" aria-hidden="true">
                            {isCollapsed ? <CaretDown className="h-4 w-4" /> : <CaretUp className="h-4 w-4" />}
                          </span>
                        </button>
                        <div
                          id={groupId}
                          className={cn(
                            'grid transition-all duration-300 ease-in-out',
                            isCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
                          )}
                        >
                          <div className="overflow-hidden">
                            <div className="px-2 pb-2 pt-1 space-y-2">
                              {group.items.map(renderModelCard)}
                            </div>
                          </div>
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-3">
                  {selectedVendorModels.map(renderModelCard)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 获取模型列表 Dialog（仅桌面端；移动端使用上方内联卡片） */}
      {!isCodexOAuthVendor && !isSmallScreen && onAddVendorModels && supportsModelFetching(selectedVendor.providerType) && (
        <Dialog open={isModelFetcherDialogOpen} onOpenChange={setIsModelFetcherDialogOpen}>
          <DialogContent className="w-full max-w-2xl p-0 overflow-hidden">
            <DialogHeader className="px-5 pt-5 pb-4 border-b border-border/40">
              <DialogTitle>{t('settings:vendor_model_fetcher.dialog_title')}</DialogTitle>
              <DialogDescription>
                {t('settings:vendor_model_fetcher.dialog_description', { vendor: selectedVendor.name || providerLabel })}
              </DialogDescription>
            </DialogHeader>
            <div className="p-4">
              <VendorModelFetcher
                key={selectedVendor.id}
                vendor={selectedVendor}
                existingModelIds={selectedVendorModels.map(({ profile }) => profile.model)}
                onAddModels={onAddVendorModels}
                embedded="dialog"
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};
