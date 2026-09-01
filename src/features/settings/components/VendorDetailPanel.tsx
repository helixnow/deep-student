/**
 * VendorDetailPanel - 供应商详情面板
 * 从 ApisTab 拆分，负责渲染选中供应商的配置和模型列表
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, CaretDown, CaretUp, Check, DotsThree, DownloadSimple, Key, LinkSimple, NotePencil, PencilSimple, Plus, Prohibit, Pulse, Spinner, Star, Trash } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
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
import { DeepSeekBalanceSection } from './DeepSeekBalanceSection';
import { isOfficialDeepSeekVendor } from './deepSeekBalance';
import { VendorModelFetcher, supportsModelFetching } from './VendorModelFetcher';
import { ShadApiEditModal } from './ShadApiEditModal';
import { OpenAICodexAccountSection } from './OpenAICodexAccountSection';
import { useVendorSettings } from './VendorSettingsContext';
import { convertProfileToApiConfig } from './modelConverters';
import { groupByModelFamily } from './modelFamily';
import type { VendorConfig } from '@/types';
import { isOpenAICodexOAuthVendor } from '@/utils/vendorAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { SettingsVirtualList, type SettingsVirtualItem } from './SettingsVirtualList';

// --- Save Status Indicator ---
type SaveStatus = 'idle' | 'saving' | 'saved';

const SaveIndicator: React.FC<{ status: SaveStatus }> = ({ status }) => {
  if (status === 'idle') return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground ui-rise-in">
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
  // 首帧以 open=true 挂载时（编辑器宿主按需挂载的场景），先渲染收起态，
  // 下一帧再翻开 data-open，让 0fr→1fr 高度动画照常播放。
  const [entered, setEntered] = useState(!open);
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

  useLayoutEffect(() => {
    if (!entered) {
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [entered]);

  const visualOpen = open && entered;

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
      data-open={visualOpen ? 'true' : 'false'}
      aria-hidden={!visualOpen}
    >
      <div className={cn('settings-inline-editor-clip', fill && 'h-full')}>
        <div className={cn('settings-inline-editor-body', fill && 'h-full min-h-0')}>
          {shouldRender ? (hasChildren ? children : lastChildrenRef.current) : null}
        </div>
      </div>
    </div>
  );
};

// floating 态自绘 fixed 遮罩 dialog 的 Escape 栈（与 DsDialog/shad Dialog 同语义：
// 仅栈顶实例响应，多层浮层一次只关最上层）
const floatingEditorEscapeStack: symbol[] = [];

const ResponsiveInlineEditorHost: React.FC<{
  floating: boolean;
  testId: string;
  surfaceTestId: string;
  ariaLabel: string;
  onDismiss?: () => void;
  children: React.ReactNode;
}> = ({ floating, testId, surfaceTestId, ariaLabel, onDismiss, children }) => {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const [host] = useState<HTMLDivElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div')
  );
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Keep one portal target for the lifetime of the form. Moving that target preserves
  // ShadApiEditModal's local draft state while escaping transformed/contained ancestors.
  useLayoutEffect(() => {
    if (!host) return;
    const target = floating ? document.body : placeholderRef.current;
    target?.appendChild(host);
  }, [floating, host]);

  useLayoutEffect(() => () => host?.remove(), [host]);

  // floating 态是自绘 role="dialog"（非 Radix，无 data-state="open"），
  // androidBackCoordinator 的 Radix Escape 兜底匹配不到——必须显式注册
  // overlay 级返回 handler + Escape，否则中屏按返回键会穿透到底层导航。
  useEffect(() => {
    if (!floating) return;
    const token = Symbol('responsive-inline-editor-esc');
    floatingEditorEscapeStack.push(token);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (floatingEditorEscapeStack[floatingEditorEscapeStack.length - 1] !== token) return;
      onDismissRef.current?.();
    };
    document.addEventListener('keydown', onKeyDown);
    const unregisterBack = registerBackHandler(() => {
      onDismissRef.current?.();
      return true;
    }, BACK_PRIORITY.overlay);
    return () => {
      const index = floatingEditorEscapeStack.indexOf(token);
      if (index >= 0) floatingEditorEscapeStack.splice(index, 1);
      document.removeEventListener('keydown', onKeyDown);
      unregisterBack();
    };
  }, [floating]);

  const content = (
    <div
      data-testid={testId}
      role={floating ? 'dialog' : undefined}
      aria-modal={floating ? true : undefined}
      aria-label={floating ? ariaLabel : undefined}
      className={cn(
        floating &&
          'fixed inset-0 z-overlay flex min-h-0 items-start justify-center bg-black/40 p-4 sm:py-8'
      )}
    >
      <div
        data-testid={surfaceTestId}
        className={cn(
          floating &&
            'relative z-modal h-[min(760px,calc(100dvh-2rem))] min-h-0 w-full max-w-[672px] overflow-hidden rounded-lg border border-border/60 bg-background shadow-2xl sm:h-[min(760px,calc(100dvh-4rem))]'
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

export const getProviderWebsiteUrl = (providerType?: string | null): string | null => {
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

interface VendorDetailPanelProps {
  scrollElement?: HTMLElement | null;
}

export const VendorDetailPanel: React.FC<VendorDetailPanelProps> = ({ scrollElement = null }) => {
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
    isSmallScreen,
    closeMobileVendorDetail,
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
  // P0-5 移动端删除行内二次确认：记录当前处于「再点一次确认」态的目标（供应商 / 模型）
  const [confirmingDelete, setConfirmingDelete] = useState<
    { type: 'vendor' } | { type: 'model'; profileId: string } | null
  >(null);
  const confirmingDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 性能（AX 每帧税 ∝ 挂载节点数）：次要操作按钮（收藏/测试/删除）在悬停
  // 桌面上本就 opacity-0 直到卡片 hover，因此推迟到首次 hover/聚焦再挂载，
  // 视觉无差；触屏/窄屏这些按钮常显，不推迟。
  const [warmActionCards, setWarmActionCards] = useState<Set<string>>(() => new Set());
  const warmCardActions = useCallback((profileId: string) => {
    setWarmActionCards((prev) => {
      if (prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.add(profileId);
      return next;
    });
  }, []);
  const deferHoverActions = useMemo(() => {
    if (isSmallScreen) return false;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 768px)').matches;
  }, [isSmallScreen]);
  // 内联编辑宿主按需挂载：编辑关闭后保留一个动画周期再卸载，退场动画不丢
  const [lingeringEditorId, setLingeringEditorId] = useState<string | null>(null);
  const prevInlineEditIdRef = useRef<string | null>(null);
  useEffect(() => {
    const current = !isAddingNewModel ? inlineEditState?.profileId ?? null : null;
    const prev = prevInlineEditIdRef.current;
    prevInlineEditIdRef.current = current;
    if (prev && prev !== current) {
      // 关闭或切换到别的卡：旧宿主保留一个动画周期播完退场
      setLingeringEditorId(prev);
      const timer = setTimeout(() => setLingeringEditorId(null), INLINE_EDITOR_MOTION_MS + 80);
      return () => clearTimeout(timer);
    }
  }, [inlineEditState?.profileId, isAddingNewModel]);
  const isCodexOAuthVendor = isOpenAICodexOAuthVendor(selectedVendor);
  const usesNoApiKey =
    selectedVendor?.authMode === 'none' || selectedVendor?.noApiKey === true;

  // 进入确认态后 4 秒未再次点击则自动复位，避免误触残留
  const armConfirmingDelete = (target: { type: 'vendor' } | { type: 'model'; profileId: string }) => {
    setConfirmingDelete(target);
    if (confirmingDeleteTimerRef.current) clearTimeout(confirmingDeleteTimerRef.current);
    confirmingDeleteTimerRef.current = setTimeout(() => setConfirmingDelete(null), 4000);
  };

  const resetConfirmingDelete = () => {
    setConfirmingDelete(null);
    if (confirmingDeleteTimerRef.current) {
      clearTimeout(confirmingDeleteTimerRef.current);
      confirmingDeleteTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (confirmingDeleteTimerRef.current) clearTimeout(confirmingDeleteTimerRef.current);
    };
  }, []);

  // 判断连接是否已配置（有 baseUrl 且有 apiKey，或 noApiKey 模式）
  const isConnectionConfigured = useMemo(() => {
    if (!selectedVendor) return false;
    const hasUrl = !!(selectedVendor.baseUrl?.trim());
    if (isCodexOAuthVendor) return true;
    if (usesNoApiKey) return hasUrl;
    const hasKey = Boolean(
      selectedVendor.apiKey?.trim()
      || selectedVendor.apiKeys?.some(key => key.trim())
    );
    return hasUrl && hasKey;
  }, [selectedVendor, isCodexOAuthVendor, usesNoApiKey]);

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
    setConfirmingDelete(null);
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
      <div className="rounded-2xl border border-dashed border-border/60 p-10 text-muted-foreground">
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
    const secondaryActionsMounted = !deferHoverActions || warmActionCards.has(profile.id);
    const warmThisCard = deferHoverActions && !secondaryActionsMounted
      ? () => warmCardActions(profile.id)
      : undefined;

    return (
      <div
        key={profile.id}
        onPointerEnter={warmThisCard}
        onFocusCapture={warmThisCard}
        className={cn(
          "group/card relative border border-transparent",
          isEditing
            ? cn(settingsQuietRowBaseClassName, settingsQuietActiveSurfaceClassName)
            : settingsQuietInteractiveRowClassName
        )}>
        {/* 卡片头部 */}
        <div className="p-3">
          <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
            <ProviderIcon modelId={api.model} size={20} showTooltip={false} />
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground truncate">{profile.label || api.name}</span>
                {!profile.enabled && <span className="text-2xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground whitespace-nowrap shrink-0">{t('settings:status.disabled')}</span>}
                {isReadOnly && <span className="text-2xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary whitespace-nowrap shrink-0">{t('settings:api_config.badge_builtin_free')}</span>}
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
            <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
              {/* 次要操作：桌面 hover 时显示；触屏/窄屏无 hover，常显（否则收藏/删除在移动端不可达）。
                  测试连接与收藏/删除/编辑平级常显——移动端编辑器已无底栏，测试入口只在卡片上 */}
              <div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 max-md:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity duration-150">
                {!secondaryActionsMounted ? (
                  /* 冷态占位：宽度 = 3 个 w-7 按钮 + 2 个 gap-0.5，首次 hover 挂载真身，无布局跳动 */
                  <div className="h-7 w-[88px]" aria-hidden="true" />
                ) : (
                <>
                <DsButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  className={cn('max-sm:!h-11 max-sm:!w-11', profile.isFavorite && "text-yellow-500 opacity-100")}
                  onClick={() => handleToggleFavorite(profile)}
                  disabled={vendorBusy}
                  title={t('settings:api_config.toggle_favorite')}
                >
                  <Star className="h-3.5 w-3.5" weight={profile.isFavorite ? 'fill' : 'regular'} />
                </DsButton>
                <DsButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  className="max-sm:!h-11 max-sm:!w-11"
                  onClick={() => void testApiConnection(api)}
                  disabled={testingApi === api.id || vendorBusy}
                  title={t('settings:api_config.test_button')}
                  aria-label={t('settings:api_config.test_button')}
                >
                  {testingApi === api.id ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <Pulse className="h-3.5 w-3.5" />}
                </DsButton>

                {/* 删除：桌面触发全局确认对话框；移动端改行内二次确认（P0-5，弹层契约） */}
                {!isReadOnly ? (
                  isSmallScreen && confirmingDelete?.type === 'model' && confirmingDelete.profileId === profile.id ? (
                    <DsButton
                      size="sm"
                      variant="danger"
                      disabled={vendorBusy}
                      className="min-h-11 shrink-0 whitespace-nowrap sm:min-h-0"
                      onClick={() => {
                        resetConfirmingDelete();
                        handleDeleteModelProfile(profile, { skipConfirm: true });
                      }}
                    >
                      <Trash className="h-3.5 w-3.5" />
                      {t('common:actions.confirm_delete')}
                    </DsButton>
                  ) : (
                    <DsButton
                      size="sm"
                      variant="ghost"
                      iconOnly
                      disabled={vendorBusy}
                      title={t('common:actions.delete')}
                      aria-label={t('common:actions.delete')}
                      className="text-muted-foreground hover:text-destructive max-sm:!h-11 max-sm:!w-11"
                      onClick={() => {
                        if (isSmallScreen) {
                          armConfirmingDelete({ type: 'model', profileId: profile.id });
                          return;
                        }
                        handleDeleteModelProfile(profile);
                      }}
                    >
                      <Trash className="h-3.5 w-3.5" />
                    </DsButton>
                  )
                ) : (
                  /* 占位：保持对齐（窄屏无需占位） */
                  <div className="h-7 w-7 shrink-0 max-md:hidden" />
                )}
                </>
                )}
              </div>
              {/* 编辑按钮 */}
              <DsButton
                size="sm"
                variant={isEditing ? "outline" : "ghost"}
                iconOnly
                onClick={handleEditClick}
                disabled={vendorBusy}
                title={isEditing ? t('common:actions.close') : t('common:actions.edit')}
                className="max-sm:!h-11 max-sm:!w-11"
              >
                {isEditing ? <CaretUp className="h-3.5 w-3.5" /> : <PencilSimple className="h-3.5 w-3.5" />}
              </DsButton>
              {/* 开关：最右 */}
              <Switch
                checked={profile.enabled}
                onCheckedChange={value => handleToggleModelProfile(profile, value)}
                disabled={isReadOnly || vendorBusy}
              />
            </div>
          </div>
        </div>

        {/* 内联编辑区：宿主按需挂载（编辑中/退场动画期），列表静止时不为每卡常驻编辑器骨架 */}
        {!isSmallScreen && (isEditing || lingeringEditorId === profile.id) && (
          <ResponsiveInlineEditorHost
            floating={isEditing && useResponsiveInlineDialog}
            testId={`responsive-inline-model-editor-${profile.id}`}
            surfaceTestId={`responsive-inline-model-editor-surface-${profile.id}`}
            ariaLabel={profile.label || api.name}
            onDismiss={() => setInlineEditState(null)}
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

  const shouldVirtualizeModels = (
    selectedVendorModels.length > 8
    && Boolean(scrollElement)
    && !inlineEditState
    && !isAddingNewModel
  );
  const virtualModelItems: SettingsVirtualItem[] = [];

  if (shouldVirtualizeModels) {
    if (shouldGroupByFamily) {
      familyGroups.forEach((group) => {
        const isCollapsed = collapsedFamilies.has(group.family.id);
        const groupId = `vendor-family-${group.family.id}`;
        virtualModelItems.push({
          key: `family:${group.family.id}`,
          estimateSize: 56,
          render: () => (
            <button
              key={`family:${group.family.id}`}
              type="button"
              onClick={() => {
                setCollapsedFamilies((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.family.id)) next.delete(group.family.id);
                  else next.add(group.family.id);
                  return next;
                });
              }}
              className={cn(
                'mt-3 flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30',
                isCollapsed ? 'rounded-2xl bg-muted' : 'rounded-t-2xl bg-muted',
              )}
              aria-expanded={!isCollapsed}
              aria-controls={groupId}
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm font-medium text-foreground">{group.family.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">{group.items.length}</span>
              </div>
              <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                {isCollapsed ? <CaretDown className="h-4 w-4" /> : <CaretUp className="h-4 w-4" />}
              </span>
            </button>
          ),
        });

        if (!isCollapsed) {
          group.items.forEach((item, index) => {
            const isLast = index === group.items.length - 1;
            virtualModelItems.push({
              key: `model:${item.profile.id}`,
              estimateSize: 78,
              render: () => (
                <div
                  key={`model:${item.profile.id}`}
                  id={index === 0 ? groupId : undefined}
                  role="listitem"
                  aria-posinset={index + 1}
                  aria-setsize={group.items.length}
                  className={cn(
                    'bg-muted px-2 pt-1',
                    isLast && 'mb-3 rounded-b-2xl pb-2',
                  )}
                >
                  {renderModelCard(item)}
                </div>
              ),
            });
          });
        }
      });
    } else {
      selectedVendorModels.forEach((item, index) => {
        virtualModelItems.push({
          key: `model:${item.profile.id}`,
          estimateSize: 78,
          render: () => (
            <div
              key={`model:${item.profile.id}`}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={selectedVendorModels.length}
              className="pb-3"
            >
              {renderModelCard(item)}
            </div>
          ),
        });
      });
    }
  }

  return (
    <>
      {/* 供应商头部 */}
      <div className="w-full">
        <div className="mb-5 flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {/* 移动端顶栏已显示供应商名（Settings.tsx 面包屑），页内名称行不再重复 */}
            {!isSmallScreen && (
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
                <Badge variant="default" className="bg-primary/10 text-primary border-primary/20 text-2xs px-1.5 py-0 shrink-0">
                  {t('settings:api.modal.capabilities.recommended')}
                </Badge>
              )}
              {(() => {
                const websiteUrl = selectedVendor.websiteUrl || getProviderWebsiteUrl(selectedVendor.providerType);
                return websiteUrl ? (
                  <DsButton
                    size="sm"
                    variant="ghost"
                    iconOnly
                    className="opacity-60 hover:opacity-100 max-sm:!h-11 max-sm:!w-11"
                    onClick={() => void openUrl(websiteUrl)}
                    title={t('settings:vendor_panel.open_website')}
                  >
                    <ArrowSquareOut className="h-3.5 w-3.5" />
                  </DsButton>
                ) : null;
              })()}
            </div>
            )}
            {!isCodexOAuthVendor && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              {/* 移动端：官网入口在统一顶栏右侧（Settings.tsx rightActions） */}
              {isEditingVendor ? (
                <>
                  <DsButton size="sm" variant="ghost" className="min-h-11 flex-1 sm:min-h-0 sm:flex-none" onClick={handleCancelEditVendor}>{t('common:actions.cancel')}</DsButton>
                  {/* 移动端去纯色大按钮：描边+主色文字，桌面保持实心 primary */}
                  <DsButton size="sm" variant={isSmallScreen ? 'outline' : 'primary'} className={cn('min-h-11 flex-1 sm:min-h-0 sm:flex-none', isSmallScreen && 'text-primary')} onClick={handleSaveEditVendor} disabled={vendorSaving}>{t('common:actions.save')}</DsButton>
                </>
              ) : (
                <>
                  <DsButton size="sm" variant={isSmallScreen ? 'outline' : 'ghost'} className="min-h-11 flex-1 sm:min-h-0 sm:flex-none" onClick={() => handleStartEditVendor(selectedVendor)}>{t('common:actions.edit')}</DsButton>
                  {!selectedVendorIsSiliconflow && !selectedVendor.isBuiltin && !selectedVendor.isReadOnly && (
                    // 桌面：确认对话框；移动端：行内二次确认（P0-5），删除后回到供应商列表屏
                    // 移动端去纯色大按钮：待命态描边+危险色文字，armed（确认删除）态保持实心红强调最终破坏动作
                    <DsButton
                      size="sm"
                      variant={isSmallScreen && confirmingDelete?.type !== 'vendor' ? 'outline' : 'danger'}
                      className={cn('min-h-11 flex-1 sm:min-h-0 sm:flex-none', isSmallScreen && confirmingDelete?.type !== 'vendor' && '!text-destructive', isSmallScreen && confirmingDelete?.type === 'vendor' && 'whitespace-nowrap')}
                      onClick={() => {
                        if (!isSmallScreen) {
                          handleDeleteVendor(selectedVendor);
                          return;
                        }
                        if (confirmingDelete?.type === 'vendor') {
                          resetConfirmingDelete();
                          handleDeleteVendor(selectedVendor, { skipConfirm: true });
                          closeMobileVendorDetail?.();
                        } else {
                          armConfirmingDelete({ type: 'vendor' });
                        }
                      }}
                    >
                      {isSmallScreen && confirmingDelete?.type === 'vendor'
                        ? t('common:actions.confirm_delete')
                        : t('common:actions.delete')}
                    </DsButton>
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
          <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2 rounded-2xl bg-muted p-4">
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
              <Textarea className="scroll-area--native" value={vendorFormData.notes || ''} onChange={e => setVendorFormData(prev => ({ ...prev, notes: e.target.value }))} placeholder={t('settings:vendor_modal.notes_placeholder')} rows={3} />
            </div>
            {/* P3-10：编辑表单无 key 字段是死胡同——用户想改 key 会本能点「编辑」。
                加一行指引，说明 key 在详情页「连接配置」折叠区录入/修改 */}
            {!usesNoApiKey && (
              <p className="md:col-span-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Key className="h-3.5 w-3.5 mt-px shrink-0" aria-hidden="true" />
                <span>{t('settings:vendor_panel.edit_form_api_key_hint')}</span>
              </p>
            )}
          </div>
        ) : (
          /* 查看模式：可折叠连接配置 */
          <div className="rounded-2xl bg-muted overflow-hidden">
            {/* 折叠头部 / 摘要行 */}
            <button
              type="button"
              onClick={() => setConnectionExpanded(v => !v)}
              aria-expanded={connectionExpanded}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0 text-sm">
                <LinkSimple className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                {isConnectionConfigured ? (
                  <span className="flex items-center gap-2 min-w-0 text-muted-foreground">
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    <span className="truncate font-mono text-xs">{selectedVendor.baseUrl}</span>
                    <span className="text-muted-foreground/60 shrink-0">·</span>
                    {usesNoApiKey ? (
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
              {/* P3-10：折叠态补「点按修改」文字提示，状态文案本身不传达可点 */}
              <span className="flex items-center gap-1.5 shrink-0">
                {!connectionExpanded && (
                  <span className="text-xs text-primary">{t('settings:vendor_panel.connection_summary_tap_to_edit')}</span>
                )}
                <span className="text-muted-foreground">
                  {connectionExpanded ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                </span>
              </span>
            </button>

            {/* 可折叠内容：退场动画完成后卸载，避免隐藏表单常驻 DOM/AX 树。 */}
            <InlineEditorCollapse open={connectionExpanded}>
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
                        />
                      ) : usesNoApiKey ? (
                        <div className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
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

                  {/* DeepSeek 官方余额查询：仅官方域名供应商显示 */}
                  {isOfficialDeepSeekVendor(selectedVendor) && (
                    <DeepSeekBalanceSection
                      key={selectedVendor.id}
                      vendor={selectedVendor}
                      active={connectionExpanded}
                    />
                  )}
              </div>
            </InlineEditorCollapse>
          </div>
        )}
      </div>

      {/* 模型管理区 */}
      <div className="w-full pt-4">
        <div className="space-y-6">
          {!selectedVendorIsSiliconflow && (
            <div
              data-wb-blur-surface
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
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-shrink-0">
                {!isCodexOAuthVendor && onAddVendorModels && supportsModelFetching(selectedVendor.providerType) && (
                  <DsButton
                    size="sm"
                    variant="outline"
                    className="min-h-11 flex-1 sm:min-h-0 sm:flex-none"
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
                  </DsButton>
                )}
                {/* 移动端去纯色大按钮：描边+主色文字，桌面保持实心 primary */}
                <DsButton size="sm" variant={isSmallScreen ? 'outline' : 'primary'} className={cn('min-h-11 flex-1 sm:min-h-0 sm:flex-none', isSmallScreen && 'text-primary')} onClick={() => {
                  if (usePanelModelEditor) {
                    if (isAddingNewModel) handleCancelAddModel();
                    setInlineEditState(null);
                    handleOpenModelEditor(selectedVendor);
                    return;
                  }
                  handleAddModelInline(selectedVendor);
                }}>
                  <Plus className="h-3.5 w-3.5" />{t('settings:vendor_panel.add_model_button')}
                </DsButton>
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
                onDismiss={handleCancelAddModel}
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
            <div
              className="space-y-3"
              data-wb-settings-model-count={selectedVendorModels.length}
            >
              {selectedVendorModels.length === 0 && !isAddingNewModel ? (
                <div className="rounded-2xl bg-muted p-8 text-sm text-muted-foreground">{t('settings:vendor_panel.model_empty')}</div>
              ) : shouldVirtualizeModels ? (
                <SettingsVirtualList
                  items={virtualModelItems}
                  scrollElement={scrollElement}
                  threshold={0}
                  overscan={1}
                />
              ) : shouldGroupByFamily ? (
                <div className="space-y-3">
                  {familyGroups.map((group) => {
                    const isCollapsed = collapsedFamilies.has(group.family.id);
                    const groupId = `vendor-family-${group.family.id}`;
                    return (
                      <section
                        key={group.family.id}
                        className="rounded-2xl bg-muted overflow-hidden"
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
          <DialogContent
            className="flex h-[min(85dvh,720px)] max-h-[min(85dvh,720px)] min-h-0 w-full max-w-2xl flex-col overflow-hidden p-0"
            onWheel={(event) => event.stopPropagation()}
          >
            <DialogHeader className="px-5 pt-5 pb-4 border-b border-border/40">
              <DialogTitle>{t('settings:vendor_model_fetcher.dialog_title')}</DialogTitle>
              <DialogDescription>
                {t('settings:vendor_model_fetcher.dialog_description', { vendor: selectedVendor.name || providerLabel })}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 p-4">
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
