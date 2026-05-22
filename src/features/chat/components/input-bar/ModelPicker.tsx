/**
 * ModelPicker - 统一的模型选择面板
 *
 * 业界主流交互（ChatGPT / Claude / Cursor / LobeChat）：
 *   - 默认单选：选中即替换当前会话模型
 *   - 显式「对比模式」开关：开启后变多选，可累积多个模型用于并行/对比
 *   - 重试模式：复用同一面板，单/多选 + 重试按钮
 *
 * 视觉规格：
 *   - 沿用 --composer-panel-* / --menu-shell-* 设计 token
 *   - 由父组件用 ComposerPanelOverlay 包裹，widthMode="anchor" 贴齐输入栏宽度
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  X,
  ArrowCounterClockwise,
  MagnifyingGlass,
  Star,
  PushPin,
  CaretDown,
  CaretRight,
  Check,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { NotionButton } from '@/components/ui/NotionButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { ModelCapabilityIcons } from '@/components/shared/ModelCapabilityIcons';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import type { ModelInfo } from '../../utils/parseModelMentions';
import type { ModelAssignments } from '@/types';

// ============================================================================
// Types
// ============================================================================

export type ModelPickerMode = 'single' | 'compare';

interface ApiModelConfig {
  id: string;
  name: string;
  model: string;
  vendorId?: string;
  vendorName?: string;
  isMultimodal?: boolean;
  isReasoning?: boolean;
  supportsTools?: boolean;
  enabled?: boolean;
  isEmbedding?: boolean;
  is_embedding?: boolean;
  isReranker?: boolean;
  is_reranker?: boolean;
  isFavorite?: boolean;
  is_favorite?: boolean;
}

interface VendorConfigSlim {
  id: string;
  providerType?: string;
  sortOrder?: number;
  name: string;
}

export interface ModelPickerProps {
  /** 当前模式：single 替换会话模型；compare 多选并行 */
  mode: ModelPickerMode;
  /** 模式切换回调；不提供则隐藏 toggle */
  onModeChange?: (mode: ModelPickerMode) => void;
  /** 是否允许显示「对比模式」开关（feature flag / retry 模式可禁用） */
  allowCompareToggle?: boolean;

  /** single 模式当前选中的模型 ID（chatParams.model2OverrideId） */
  singleSelectedId?: string | null;
  /** compare 模式已选模型列表 */
  compareSelected?: ModelInfo[];

  /** 单选模式：选中模型时调用，调用方应替换会话模型并关闭面板 */
  onSelectSingle?: (model: ModelInfo) => void;
  /** 对比模式：勾选/取消模型 */
  onToggleCompare?: (model: ModelInfo) => void;

  /** 关闭面板 */
  onClose: () => void;
  /** 流式生成中禁用交互 */
  disabled?: boolean;
  /** 移动端底部抽屉模式可隐藏头部 */
  hideHeader?: boolean;
  /** 紧凑模式：用于 app menu 子菜单，收窄宽度和高度 */
  compact?: boolean;

  // Retry 模式
  /** 待重试的消息 ID（存在时进入重试模式，强制 compare） */
  retryMessageId?: string | null;
  /** 重试回调（重试模式下点击「重试」按钮时调用） */
  onRetry?: (modelIds: string[]) => void;
}

// ============================================================================
// Component
// ============================================================================

type NormalizedModel = ApiModelConfig & { searchable: string; isFavorite: boolean };

export const ModelPicker: React.FC<ModelPickerProps> = ({
  mode,
  onModeChange,
  allowCompareToggle = true,
  singleSelectedId,
  compareSelected = [],
  onSelectSingle,
  onToggleCompare,
  onClose,
  disabled = false,
  hideHeader,
  compact = false,
  retryMessageId,
  onRetry,
}) => {
  const { t } = useTranslation(['chatV2', 'chat_host', 'common']);
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;
  const shouldHideHeader = hideHeader ?? isMobile;

  const isRetryMode = Boolean(retryMessageId);
  // retry 模式始终走 compare（即便只选一个也通过 compareSelected 传出）
  const effectiveMode: ModelPickerMode = isRetryMode ? 'compare' : mode;
  const showCompareToggle = !isRetryMode && allowCompareToggle && Boolean(onModeChange);

  // ----- state -----
  const [models, setModels] = useState<ApiModelConfig[]>([]);
  const [vendorOrderMap, setVendorOrderMap] = useState<Map<string, number>>(new Map());
  const [vendorNameMap, setVendorNameMap] = useState<Map<string, string>>(new Map());
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [collapsedVendors, setCollapsedVendors] = useState<Set<string>>(new Set());

  // ----- load -----
  const isInitialLoad = useRef(true);
  const loadModels = useCallback(async () => {
    try {
      if (isInitialLoad.current) {
        setLoading(true);
        isInitialLoad.current = false;
      }
      const configs = await invoke<ApiModelConfig[]>('get_api_configurations');
      const chatModels = (configs || []).filter((c) => {
        const isEmbedding = c.isEmbedding === true || c.is_embedding === true;
        const isReranker = c.isReranker === true || c.is_reranker === true;
        const isEnabled = c.enabled !== false;
        return !isEmbedding && !isReranker && isEnabled;
      });
      setModels(chatModels);

      try {
        const vendorConfigs = await invoke<VendorConfigSlim[]>('get_vendor_configs');
        const orderMap = new Map<string, number>();
        const nameMap = new Map<string, string>();
        const sorted = [...(vendorConfigs || [])].sort((a, b) => {
          const aSilicon = (a.providerType ?? '').toLowerCase() === 'siliconflow';
          const bSilicon = (b.providerType ?? '').toLowerCase() === 'siliconflow';
          if (aSilicon !== bSilicon) return aSilicon ? -1 : 1;
          const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.name.localeCompare(b.name);
        });
        sorted.forEach((v, i) => {
          orderMap.set(v.id, i);
          nameMap.set(v.id, v.name);
        });
        setVendorOrderMap(orderMap);
        setVendorNameMap(nameMap);
      } catch {
        setVendorOrderMap(new Map());
        setVendorNameMap(new Map());
      }

      try {
        const assignments = await invoke<Record<string, string | null>>('get_model_assignments');
        setDefaultModelId(assignments?.['model2_config_id'] || null);
      } catch {
        setDefaultModelId(null);
      }
    } catch (error: unknown) {
      console.error('[ModelPicker] Failed to load models:', error);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    const reload = () => { void loadModels(); };
    window.addEventListener('api_configurations_changed', reload as EventListener);
    window.addEventListener('model_assignments_changed', reload as EventListener);
    return () => {
      window.removeEventListener('api_configurations_changed', reload as EventListener);
      window.removeEventListener('model_assignments_changed', reload as EventListener);
    };
  }, [loadModels]);

  // ----- derived -----
  const compareSelectedIds = useMemo(
    () => new Set(compareSelected.map((m) => m.id)),
    [compareSelected]
  );

  const normalizedModels = useMemo<NormalizedModel[]>(() => {
    return models.map((m) => ({
      ...m,
      vendorName: m.vendorName ?? (m.vendorId ? vendorNameMap.get(m.vendorId) : undefined),
      searchable: `${m.name ?? ''} ${m.model ?? ''} ${m.vendorName ?? ''} ${m.vendorId ? (vendorNameMap.get(m.vendorId) ?? '') : ''}`.toLowerCase(),
      isFavorite: m.isFavorite === true || m.is_favorite === true,
    }));
  }, [models, vendorNameMap]);

  const sortedAndFiltered = useMemo<NormalizedModel[]>(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const filtered = keyword
      ? normalizedModels.filter((m) => m.searchable.includes(keyword))
      : normalizedModels;
    return [...filtered].sort((a, b) => {
      const aVendorOrder = a.vendorId ? (vendorOrderMap.get(a.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const bVendorOrder = b.vendorId ? (vendorOrderMap.get(b.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (aVendorOrder !== bVendorOrder) return aVendorOrder - bVendorOrder;
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return 0;
    });
  }, [normalizedModels, searchTerm, vendorOrderMap]);

  const vendorGroups = useMemo(() => {
    const groups: { vendorId: string; vendorName: string; models: NormalizedModel[] }[] = [];
    const groupMap = new Map<string, NormalizedModel[]>();
    const orderList: { vendorId: string; vendorName: string }[] = [];
    for (const m of sortedAndFiltered) {
      const vid = m.vendorId || '__unknown__';
      const vname = m.vendorName || t('chat_host:model_panel.unknown_vendor');
      if (!groupMap.has(vid)) {
        groupMap.set(vid, []);
        orderList.push({ vendorId: vid, vendorName: vname });
      }
      groupMap.get(vid)!.push(m);
    }
    for (const { vendorId, vendorName } of orderList) {
      groups.push({ vendorId, vendorName, models: groupMap.get(vendorId)! });
    }
    return groups;
  }, [sortedAndFiltered, t]);

  useEffect(() => {
    if (!compact || vendorGroups.length === 0) return;
    setCollapsedVendors((prev) => {
      if (prev.size > 0) return prev;
      const selectedVendorId =
        sortedAndFiltered.find((m) => m.id === singleSelectedId)?.vendorId
        ?? compareSelected[0]?.vendorId
        ?? vendorGroups[0]?.vendorId;
      const next = new Set<string>();
      vendorGroups.forEach((group) => {
        if (group.vendorId !== selectedVendorId) {
          next.add(group.vendorId);
        }
      });
      return next;
    });
  }, [compact, compareSelected, singleSelectedId, sortedAndFiltered, vendorGroups]);

  useEffect(() => {
    if (searchTerm.trim()) setCollapsedVendors(new Set());
  }, [searchTerm]);

  const toggleVendorCollapse = useCallback((vendorId: string) => {
    setCollapsedVendors((prev) => {
      const next = new Set(prev);
      if (next.has(vendorId)) next.delete(vendorId);
      else next.add(vendorId);
      return next;
    });
  }, []);

  // ----- actions -----
  const toModelInfo = useCallback((m: ApiModelConfig): ModelInfo => ({
    id: m.id,
    name: m.name,
    model: m.model,
    vendorId: m.vendorId,
    vendorName: m.vendorName,
  }), []);

  const handleRowClick = useCallback((model: ApiModelConfig) => {
    if (disabled) return;
    if (effectiveMode === 'single') {
      onSelectSingle?.(toModelInfo(model));
      onClose();
    } else {
      onToggleCompare?.(toModelInfo(model));
    }
  }, [disabled, effectiveMode, onClose, onSelectSingle, onToggleCompare, toModelInfo]);

  const handleSetAsDefault = useCallback(async (modelId: string) => {
    if (!modelId || modelId === defaultModelId) return;
    setSavingDefault(true);
    try {
      const currentAssignments = await invoke<ModelAssignments>('get_model_assignments');
      const newAssignments: ModelAssignments = {
        ...currentAssignments,
        model2_config_id: modelId,
      };
      await invoke<void>('save_model_assignments', { assignments: newAssignments });
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('model_assignments_changed'));
        }
      } catch (error: unknown) {
        void error;
      }
      setDefaultModelId(modelId);
      const modelName = models.find((m) => m.id === modelId)?.name || modelId;
      showGlobalNotification(
        'success',
        t('chat_host:model_panel.set_default_success', { model: modelName })
      );
    } catch (error: unknown) {
      console.error('[ModelPicker] Failed to set default model:', error);
      showGlobalNotification('error', t('chat_host:model_panel.set_default_error'));
    } finally {
      setSavingDefault(false);
    }
  }, [defaultModelId, models, t]);

  // ----- header -----
  const titleText = isRetryMode
    ? t('chatV2:modelPicker.retryTitle', '选择模型重试')
    : t('chatV2:modelPicker.title', '选择模型');

  const subtitleText = isRetryMode
    ? compareSelected.length === 0
      ? t('chatV2:modelPicker.retryHintEmpty', '选择模型后点击重试')
      : t('chatV2:modelPicker.retryHint', { count: compareSelected.length })
    : effectiveMode === 'compare'
      ? t('chatV2:modelPicker.compareHint', { count: compareSelected.length })
      : t('chatV2:modelPicker.singleHint', '当前会话模型');

  // ----- render -----
  const hasModels = sortedAndFiltered.length > 0;
  const systemBadge = t('chat_host:model_panel.badges.system_default');
  const systemBadgeTooltip = t('chat_host:model_panel.badges.system_default_tooltip');

  const renderRow = (option: NormalizedModel) => {
    const isCompareSelected = compareSelectedIds.has(option.id);
    const isSingleSelected = effectiveMode === 'single' && singleSelectedId === option.id;
    const isHighlighted = effectiveMode === 'compare' ? isCompareSelected : isSingleSelected;
    const isDefault = option.id === defaultModelId;

    return (
      <button
        key={option.id}
        type="button"
        onClick={() => handleRowClick(option)}
        disabled={disabled}
        className={cn(
          'group flex w-full items-start gap-[var(--menu-shell-row-gap)] rounded-[var(--menu-shell-row-radius)] border text-left transition-colors',
          'px-[var(--menu-shell-row-padding-x)] py-[var(--menu-shell-row-padding-y)]',
          isHighlighted
            ? [
                'border-[color:color-mix(in_hsl,var(--menu-shell-border)_60%,var(--button-primary-border)_40%)]',
                'bg-[color:color-mix(in_hsl,var(--menu-shell-surface)_90%,var(--button-primary-surface)_10%)]',
                'text-[color:var(--menu-shell-foreground)]',
                'hover:bg-[color:color-mix(in_hsl,var(--menu-shell-surface)_84%,var(--button-primary-surface)_16%)]',
              ]
            : [
                'border-transparent bg-transparent',
                'hover:bg-[color:var(--menu-shell-row-hover)]',
              ],
          disabled && 'cursor-not-allowed opacity-60'
        )}
        aria-pressed={isHighlighted || undefined}
      >
        {/* 选中标记：compare 用 checkbox，single 用 check icon */}
        {effectiveMode === 'compare' ? (
          <span
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border text-[10px] font-semibold transition',
              isCompareSelected
                ? 'border-[color:var(--menu-shell-border)] bg-[color:var(--menu-shell-foreground)] text-[color:var(--menu-shell-surface)]'
                : 'border-[color:var(--menu-shell-border)] bg-transparent text-transparent'
            )}
            aria-hidden
          >
            {isCompareSelected && <Check size={12} weight="bold" />}
          </span>
        ) : (
          <span
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
              isSingleSelected
                ? 'text-[color:var(--menu-shell-foreground)] opacity-90'
                : 'text-transparent opacity-0'
            )}
            aria-hidden
          >
            {isSingleSelected && <Check size={14} weight="bold" />}
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className={cn('flex w-full min-w-0 items-center', compact ? 'gap-1' : isMobile ? 'gap-1' : 'gap-1.5')}>
            <ProviderIcon
              modelId={option.model || option.name}
              size={14}
              showTooltip={false}
            />
            {option.isFavorite && (
              <Star size={12} weight="fill" className="text-warning" aria-hidden />
            )}
            <ModelCapabilityIcons
              isMultimodal={option.isMultimodal}
              isReasoning={option.isReasoning}
              supportsTools={option.supportsTools}
              size="xs"
              chipClassName="h-4.5 w-4.5 text-[color:var(--menu-shell-muted-foreground)]/70 hover:bg-transparent hover:text-[color:var(--menu-shell-foreground)]"
              iconClassName="h-3 w-3"
              className={cn('gap-0', isMobile ? 'ml-0.5' : 'ml-1')}
            />
            {isDefault && (
              <CommonTooltip content={systemBadgeTooltip} position="top">
                <Badge
                  variant="outline"
                  className="hidden h-[18px] px-1.5 py-0 text-[9px] font-medium shrink-0 border-[color:var(--menu-shell-border)] bg-[color:color-mix(in_hsl,var(--menu-shell-surface)_88%,var(--menu-shell-row-hover)_12%)] text-[color:var(--menu-shell-muted-foreground)] cursor-help sm:inline-flex"
                >
                  {systemBadge}
                </Badge>
              </CommonTooltip>
            )}
          </span>
          <span
            className={cn(
              'mt-0.5 block w-full truncate text-[color:var(--menu-shell-foreground)]',
              compact ? 'text-[12px] leading-4' : isMobile ? 'text-[13px] leading-4' : 'text-[12px] leading-4'
            )}
          >
            {option.model || option.name}
          </span>
        </span>

        {!isDefault && (
          <CommonTooltip content={t('chatV2:modelPicker.setAsDefault', '设为系统默认')} position="left">
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                void handleSetAsDefault(option.id);
              }}
              className={cn(
                'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--menu-shell-row-radius)] text-[color:var(--menu-shell-muted-foreground)] opacity-0 transition group-hover:opacity-100',
                'hover:bg-[color:var(--menu-shell-row-hover)]',
                (disabled || savingDefault) && 'pointer-events-none opacity-25'
              )}
              aria-label={t('chatV2:modelPicker.setAsDefault', '设为系统默认')}
            >
              <PushPin size={12} />
            </span>
          </CommonTooltip>
        )}
      </button>
    );
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col gap-1 text-[color:var(--menu-shell-foreground)]', compact && 'w-full')}>
      {/* 头部 */}
      {!shouldHideHeader && (
        <div className="flex items-start gap-2 px-1 pt-0.5">
          <div className="flex min-w-0 flex-1 items-baseline gap-1">
            {isRetryMode && (
              <ArrowCounterClockwise
                size={12}
                className="shrink-0 self-center text-[color:var(--menu-shell-muted-foreground)]"
              />
            )}
            <span className="shrink-0 text-[12px] font-medium text-[color:var(--menu-shell-foreground)]">
              {titleText}
            </span>
            <span className="truncate text-[10.5px] text-[color:var(--menu-shell-muted-foreground)]">
              · {subtitleText}
            </span>
            {effectiveMode === 'compare' && compareSelected.length >= 2 && !isRetryMode && (
              <Badge
                variant="default"
                className="h-[18px] shrink-0 self-center border-[color:var(--menu-shell-border)] bg-[color:color-mix(in_hsl,var(--menu-shell-surface)_88%,var(--menu-shell-row-hover)_12%)] px-1.5 py-0 text-[9px] font-medium text-[color:var(--menu-shell-muted-foreground)]"
              >
                {t('chatV2:modelPicker.parallelMode', '并行模式')}
              </Badge>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {showCompareToggle && (
              <CompareToggle
                checked={effectiveMode === 'compare'}
                onChange={(next) => onModeChange?.(next ? 'compare' : 'single')}
                label={t('chatV2:modelPicker.compareToggle', '对比模式')}
                hint={t('chatV2:modelPicker.compareToggleHint', '同时使用多个模型回答')}
                disabled={disabled}
              />
            )}
            {isRetryMode && onRetry && (
              <NotionButton
                variant="primary"
                size="sm"
                onClick={() => {
                  onRetry(compareSelected.map((m) => m.id));
                  onClose();
                }}
                disabled={disabled || compareSelected.length === 0}
                title={t('chatV2:modelMention.retry', '重试')}
              >
                <ArrowCounterClockwise size={14} />
                {t('chatV2:modelMention.retry', '重试')}
              </NotionButton>
            )}
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={onClose}
              className="h-7 w-7 rounded-[var(--menu-shell-row-radius)]"
              aria-label={t('common:actions.cancel')}
              title={t('common:actions.cancel')}
            >
              <X size={16} />
            </NotionButton>
          </div>
        </div>
      )}

      {/* 搜索：视觉收敛为 menu search shell，但保留 Input 组件语义 */}
      <div className={cn('shrink-0 px-1', compact && 'pt-1')}>
        <div
          className={cn(
            'relative flex items-center gap-1.5 rounded-[var(--menu-shell-row-radius)] border',
            'bg-[color:color-mix(in_hsl,var(--menu-shell-surface)_88%,var(--menu-shell-row-hover)_12%)]',
            'border-[color:var(--menu-shell-border)] px-2 py-1.5 transition-colors',
            'focus-within:border-[hsl(var(--primary)/0.55)] focus-within:bg-[color:var(--menu-shell-surface)]'
          )}
        >
        <MagnifyingGlass
          size={12}
          className="pointer-events-none shrink-0 text-[color:var(--menu-shell-muted-foreground)]"
        />
        <Input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('chatV2:modelPicker.searchPlaceholder', '搜索名称或模型 ID...')}
          className="h-auto w-full border-0 bg-transparent px-0 py-0 text-[var(--menu-shell-font-size)] text-[color:var(--menu-shell-foreground)] shadow-none hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0"
          disabled={disabled}
        />
        </div>
      </div>

      {/* 列表：flex-1 占满 popover 剩余高度（由 popover heightMode='available' 决定总高）
          + 底部 24px 软渐隐 mask，空间受限时（如空状态输入栏居中）平滑提示"下方有更多内容"
          mask 仅影响视觉绘制，不改变 layout，与 flex-1 不冲突 */}
      <div
        className={cn('min-h-0 flex-1', compact && 'max-h-[320px]')}
        style={{
          maskImage: 'linear-gradient(to bottom, black calc(100% - 24px), transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 24px), transparent)',
        }}
      >
        <CustomScrollArea
          className="h-full"
          viewportClassName="space-y-1 px-1"
          trackOffsetTop={6}
          trackOffsetBottom={6}
        >
          <div className="space-y-0.5">
            {loading ? (
              <div className="px-2 py-4 text-center text-sm text-[color:var(--menu-shell-muted-foreground)]">
                {t('common:loading')}
              </div>
            ) : hasModels ? (
              vendorGroups.map((group) => {
                const isCollapsed = collapsedVendors.has(group.vendorId);
                const groupSelectedCount =
                  effectiveMode === 'compare'
                    ? group.models.filter((m) => compareSelectedIds.has(m.id)).length
                    : 0;
                return (
                  <div key={group.vendorId}>
                    <button
                      type="button"
                      onClick={() => toggleVendorCollapse(group.vendorId)}
                      className={cn(
                        'flex w-full select-none items-center gap-2 rounded-[var(--menu-shell-row-radius)] px-[var(--menu-shell-row-padding-x)] py-1 text-left transition-colors',
                        'hover:bg-[color:var(--menu-shell-row-hover)]'
                      )}
                    >
                      {isCollapsed ? (
                        <CaretRight size={14} className="shrink-0 text-[color:var(--menu-shell-muted-foreground)]" />
                      ) : (
                        <CaretDown size={14} className="shrink-0 text-[color:var(--menu-shell-muted-foreground)]" />
                      )}
                      <span className={cn(
                        'truncate text-[10px] font-medium uppercase tracking-[0.025em] text-[color:var(--menu-shell-muted-foreground)]',
                        compact && 'max-w-[10rem]'
                      )}>
                        {group.vendorName}
                      </span>
                      <span className="text-[11px] tabular-nums text-[color:var(--menu-shell-muted-foreground)] opacity-60">
                        {group.models.length}
                      </span>
                      {groupSelectedCount > 0 && (
                        <Badge
                          variant="default"
                          className="ml-auto h-[16px] border-[color:var(--menu-shell-border)] bg-[color:color-mix(in_hsl,var(--menu-shell-surface)_84%,var(--menu-shell-row-hover)_16%)] px-1 py-0 text-[9px] font-medium text-[color:var(--menu-shell-muted-foreground)]"
                        >
                          {groupSelectedCount}
                        </Badge>
                      )}
                    </button>
                    {!isCollapsed && (
                      <div className="space-y-0.5">{group.models.map(renderRow)}</div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="px-2 py-4 text-center text-sm text-[color:var(--menu-shell-muted-foreground)]">
                {searchTerm
                  ? t('chatV2:modelPicker.noMatches', '未找到匹配的模型')
                  : t('chatV2:modelPicker.empty', '暂无可用模型')}
              </div>
            )}
          </div>
        </CustomScrollArea>
      </div>

      {(showCompareToggle || (isRetryMode && onRetry)) && (
        <div className="mx-1 h-px shrink-0 bg-[color:var(--menu-shell-border)]" />
      )}

      {isRetryMode && onRetry && (
        <div className="flex shrink-0 items-center justify-end px-1 pb-1">
          <NotionButton
            variant="primary"
            size="sm"
            onClick={() => {
              onRetry(compareSelected.map((m) => m.id));
              onClose();
            }}
            disabled={disabled || compareSelected.length === 0}
            title={t('chatV2:modelMention.retry', '重试')}
            className="h-7 rounded-[var(--menu-shell-row-radius)] px-2.5 text-[12px]"
          >
            <ArrowCounterClockwise size={14} />
            {t('chatV2:modelMention.retry', '重试')}
          </NotionButton>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// CompareToggle - 头部右侧的对比开关
// ============================================================================

interface CompareToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const CompareToggle: React.FC<CompareToggleProps> = ({ checked, onChange, label, hint, disabled }) => {
  const button = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[999px] border px-2 py-1 text-[10px] font-medium transition-colors',
        checked
          ? 'border-[color:var(--menu-shell-border)] bg-[color:color-mix(in_hsl,var(--menu-shell-surface)_84%,var(--menu-shell-row-hover)_16%)] text-[color:var(--menu-shell-foreground)]'
          : 'border-[color:var(--menu-shell-border)] bg-transparent text-[color:var(--menu-shell-muted-foreground)] hover:bg-[color:var(--menu-shell-row-hover)]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full transition-colors',
          checked ? 'bg-[color:var(--menu-shell-foreground)]' : 'bg-[color:var(--menu-shell-muted-foreground)] opacity-50'
        )}
        aria-hidden
      />
      <span>{label}</span>
    </button>
  );

  if (!hint) return button;
  return (
    <CommonTooltip content={hint} position="bottom">
      {button}
    </CommonTooltip>
  );
};

export default ModelPicker;
