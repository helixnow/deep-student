/**
 * T3ModelSelectorPopover - T3 Code 风格三栏统一模型 / 编程 CLI / 推理强度 / 权限档位选择器
 *
 * 布局与自适应策略：
 * 1. 外壳宽高由父级按当前聊天栏宽度与触发器上下可视空间锁定（wide / medium / compact 三档），
 *    切换左侧供应商、收藏或搜索时外框宽高零变化，彻底消除浮层重排与闪烁。
 * 2. wide (>=560px)：标准三栏（48px 图标轨 + 自适应模型列表 + 192px 推理强度栏）
 *    medium (420..559px)：紧凑三栏（40px 图标轨 + 自适应模型列表 + 146px 推理强度栏）
 *    compact (<420px / 移动端)：双栏（40px 图标轨 + 模型列表）+ 底部单行横向可滚推理强度条
 * 3. 深浅色品牌图标自适应：多色品牌保留原色，单色深底品牌（OpenAI / OpenCode / xAI / Ollama）跟随前景色，
 *    Anthropic / Claude 使用高辨识度陶土橙品牌色（#D97757），避免深色主题下黑底黑字。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretUp,
  Check,
  MagnifyingGlass,
  Shield,
  ShieldCheck,
  ShieldSlash,
  ShieldWarning,
  SquaresFour,
  Star,
  TerminalWindow,
  X,
} from '@phosphor-icons/react';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/lib/utils';
import {
  detectProviderBrand,
  getProviderDisplayName,
  type ProviderBrand,
} from '@/utils/providerIconEngine';
import type { ReasoningLevel, ReasoningLevelOption } from '@/utils/reasoning';
import type { PermissionPreset } from '../../core/types/store';
import { useFavoriteChatModels } from '../../hooks/useFavoriteChatModels';
import {
  CLI_ENGINE_ID_PREFIX,
  type RuntimeModelMultiSelectConfig,
  type RuntimeModelOption,
} from './RuntimeModelSubmenuBody';

const PERMISSION_PRESET_ORDER: PermissionPreset[] = [
  'cautious',
  'relaxed',
  'full_access',
  'danger_full_access',
];

const FAVORITES_RAIL_KEY = '__favorites__';
const ALL_RAIL_KEY = '__all__';
const CODING_CLI_RAIL_KEY = '__coding_cli__';

/** 单色黑标品牌在深色背景上使用 currentColor 才能保持清晰对比度 */
const MONO_CURRENT_COLOR_BRANDS: ReadonlySet<ProviderBrand> = new Set<ProviderBrand>([
  'openai',
  'opencode',
  'xai',
  'ollama',
  'flux',
  'ideogram',
  'midjourney',
  'runway',
  'replicate',
  'suno',
]);

const ANTHROPIC_BRAND_HEX = '#D97757';

export type T3PopoverLayoutTier = 'wide' | 'medium' | 'compact';

export interface T3ModelSelectorOption extends RuntimeModelOption {
  unavailable?: boolean;
}

export interface T3ModelSelectorPopoverProps {
  options: T3ModelSelectorOption[];
  currentModelId?: string | null;
  activeModelLabel?: string;
  activeModelProviderLabel?: string;
  isExternalCliEngine?: boolean;
  onSelectModel?: (modelId: string) => void;
  hasModelPanel?: boolean;
  onOpenRuntimeModelPanel?: (mode?: 'single' | 'compare') => void;
  multiSelect?: RuntimeModelMultiSelectConfig;
  enableThinking?: boolean;
  thinkingUnsupported?: boolean;
  thinkingCanDisable: boolean;
  thinkingDepthOptions?: ReasoningLevelOption[];
  thinkingDepthValue?: ReasoningLevel;
  onToggleThinking?: () => void;
  onSetThinkingDepth?: (value: ReasoningLevel | 'off') => void;
  sessionId?: string;
  permissionPreset: PermissionPreset;
  onPermissionPresetChange?: (
    preset: PermissionPreset,
    confirm?: boolean,
  ) => void | Promise<void>;
  onRequestClose?: () => void;
  isMobile?: boolean;
  layoutTier?: T3PopoverLayoutTier;
  lockedHeight?: number;
  disabled?: boolean;
}

interface RailGroup {
  key: string;
  label: string;
  iconModelId?: string;
  isCodingCli?: boolean;
  models: T3ModelSelectorOption[];
}

/**
 * 将本地编程 CLI id 映射为对应品牌图标标识；无对应品牌时返回空字符串回退终端图标
 */
export function resolveCliBrandIconModelId(rawIdOrLabel?: string): string {
  const normalized = (rawIdOrLabel ?? '')
    .replace(new RegExp(`^${CLI_ENGINE_ID_PREFIX}`), '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('codex') || normalized === 'openai') return 'openai';
  if (normalized.includes('claude') || normalized === 'anthropic') return 'anthropic';
  if (normalized.includes('opencode')) return 'opencode';
  if (normalized === 'agy' || normalized.includes('antigravity') || normalized.includes('gemini')) {
    return 'google';
  }
  if (normalized === 'dsh' || normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('qwen')) return 'qwen';
  return '';
}

/**
 * 渲染深浅色主题均清晰可辨的品牌字形图标
 */
export function renderAdaptiveBrandGlyph(modelId: string, size: number): React.ReactNode {
  const brand = detectProviderBrand(modelId);
  if (brand === 'anthropic') {
    return (
      <ProviderIcon
        modelId={modelId}
        size={size}
        showTooltip={false}
        variant="mono"
        className="shrink-0"
        style={{ color: ANTHROPIC_BRAND_HEX }}
      />
    );
  }
  if (MONO_CURRENT_COLOR_BRANDS.has(brand)) {
    return (
      <ProviderIcon
        modelId={modelId}
        size={size}
        showTooltip={false}
        variant="mono"
        className="shrink-0 text-foreground"
      />
    );
  }
  return (
    <ProviderIcon
      modelId={modelId}
      size={size}
      showTooltip={false}
      variant="color"
      renderMode="glyph"
      className="shrink-0"
    />
  );
}

function isCliOption(option: T3ModelSelectorOption): boolean {
  return Boolean(option.isExternalCli || option.id.startsWith(CLI_ENGINE_ID_PREFIX));
}

function resolveOptionBrand(option: T3ModelSelectorOption): ProviderBrand {
  if (isCliOption(option)) {
    const mapped = resolveCliBrandIconModelId(option.iconId || option.id || option.label);
    return mapped ? detectProviderBrand(mapped) : 'generic';
  }
  const providerSignal = `${option.providerId ?? ''} ${option.providerLabel ?? ''}`.trim();
  if (/opencode/i.test(providerSignal)) {
    return 'opencode';
  }
  const byModel = detectProviderBrand(option.iconId || option.label || option.id);
  if (byModel !== 'generic') return byModel;
  return detectProviderBrand(providerSignal);
}

function resolveOptionGroupMeta(
  option: T3ModelSelectorOption,
  cliGroupLabel: string,
  otherProviderLabel: string,
): { key: string; label: string; iconModelId?: string; isCodingCli?: boolean } {
  if (isCliOption(option)) {
    return {
      key: CODING_CLI_RAIL_KEY,
      label: cliGroupLabel,
      isCodingCli: true,
    };
  }
  const brand = resolveOptionBrand(option);
  if (brand !== 'generic') {
    const sampleId =
      brand === 'opencode' ? 'opencode' : option.iconId || option.label || brand;
    return {
      key: `brand:${brand}`,
      label: brand === 'opencode' ? 'OpenCode' : getProviderDisplayName(sampleId),
      iconModelId: sampleId,
    };
  }
  const fallbackLabel = option.providerLabel?.trim() || otherProviderLabel;
  const fallbackId = option.providerId?.trim() || fallbackLabel.toLowerCase();
  return {
    key: `provider:${fallbackId}`,
    label: fallbackLabel,
    iconModelId: option.iconId || option.label || option.id,
  };
}

function renderPermissionIcon(preset: PermissionPreset) {
  switch (preset) {
    case 'cautious':
      return <Shield size={14} weight="regular" className="shrink-0" />;
    case 'relaxed':
      return <ShieldCheck size={14} weight="regular" className="shrink-0" />;
    case 'full_access':
      return <ShieldSlash size={14} weight="regular" className="shrink-0" />;
    case 'danger_full_access':
      return <ShieldWarning size={14} weight="regular" className="shrink-0 text-warning" />;
    default:
      return <Shield size={14} weight="regular" className="shrink-0" />;
  }
}

export const T3ModelSelectorPopover: React.FC<T3ModelSelectorPopoverProps> = ({
  options,
  currentModelId,
  activeModelLabel,
  activeModelProviderLabel,
  isExternalCliEngine = false,
  onSelectModel,
  hasModelPanel = false,
  onOpenRuntimeModelPanel,
  multiSelect,
  enableThinking = false,
  thinkingUnsupported = false,
  thinkingCanDisable,
  thinkingDepthOptions,
  thinkingDepthValue,
  onToggleThinking,
  onSetThinkingDepth,
  permissionPreset,
  onPermissionPresetChange,
  onRequestClose,
  isMobile = false,
  layoutTier,
  lockedHeight = 360,
  disabled = false,
}) => {
  const { t } = useTranslation(['chatV2', 'agentMesh', 'settings', 'common']);
  const { favoriteIds, toggleFavorite } = useFavoriteChatModels();

  const effectiveTier: T3PopoverLayoutTier =
    layoutTier ?? (isMobile ? 'compact' : 'wide');
  const isCompactTier = effectiveTier === 'compact';
  const isMediumTier = effectiveTier === 'medium';

  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [confirmDangerOpen, setConfirmDangerOpen] = useState(false);
  const [permissionSyncing, setPermissionSyncing] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const permissionContainerRef = useRef<HTMLDivElement>(null);

  const multiActive = Boolean(multiSelect?.active);
  const selectedIdSet = useMemo(
    () => new Set(multiSelect?.selectedIds ?? []),
    [multiSelect?.selectedIds],
  );

  const isMacPlatform = useMemo(() => {
    if (typeof navigator === 'undefined') return true;
    const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
    return /Mac|iPhone|iPad|iPod/i.test(platform);
  }, []);

  const otherProviderLabel = t('chatV2:inputBar.runtimeModelOtherProvider', {
    defaultValue: '其他',
  });
  const cliGroupLabel = t('agentMesh:picker.localCodingCli', {
    defaultValue: '本地编程 CLI',
  });

  // 清洗与去重（保持与 RuntimeModelSubmenuBody 一致的幂等去重规则）
  const sanitizedOptions = useMemo<T3ModelSelectorOption[]>(() => {
    const result: T3ModelSelectorOption[] = [];
    const indexById = new Map<string, number>();
    const indexByKey = new Map<string, number>();

    for (const option of options) {
      const id = (option.id ?? '').trim();
      const label = (option.label ?? '').trim();
      if (!id || !label) continue;
      if (indexById.has(id)) continue;

      const providerScope = (option.providerId ?? option.providerLabel ?? '').trim().toLowerCase();
      const dedupeKey = `${providerScope}\u0000${label.toLowerCase()}`;
      const existingIndex = indexByKey.get(dedupeKey);
      if (existingIndex !== undefined) {
        const previous = result[existingIndex];
        const prevPriority =
          (previous.id === currentModelId ? 4 : 0) +
          (selectedIdSet.has(previous.id) ? 2 : 0) +
          (favoriteIds.has(previous.id) ? 1 : 0);
        const nextPriority =
          (id === currentModelId ? 4 : 0) +
          (selectedIdSet.has(id) ? 2 : 0) +
          (favoriteIds.has(id) ? 1 : 0);
        if (nextPriority > prevPriority) {
          indexById.delete(previous.id);
          result[existingIndex] = { ...option, id, label };
          indexById.set(id, existingIndex);
        }
        continue;
      }

      const nextIndex = result.length;
      result.push({ ...option, id, label });
      indexById.set(id, nextIndex);
      indexByKey.set(dedupeKey, nextIndex);
    }

    return result;
  }, [currentModelId, favoriteIds, options, selectedIdSet]);

  const railGroups = useMemo<RailGroup[]>(() => {
    const map = new Map<string, RailGroup>();
    for (const option of sanitizedOptions) {
      const meta = resolveOptionGroupMeta(option, cliGroupLabel, otherProviderLabel);
      const existing = map.get(meta.key);
      if (existing) {
        existing.models.push(option);
      } else {
        map.set(meta.key, {
          key: meta.key,
          label: meta.label,
          iconModelId: meta.iconModelId,
          isCodingCli: meta.isCodingCli,
          models: [option],
        });
      }
    }
    return Array.from(map.values());
  }, [cliGroupLabel, otherProviderLabel, sanitizedOptions]);

  const defaultRailKey = useMemo(() => {
    if (currentModelId) {
      const currentOption = sanitizedOptions.find((item) => item.id === currentModelId);
      if (currentOption) {
        return resolveOptionGroupMeta(currentOption, cliGroupLabel, otherProviderLabel).key;
      }
    }
    return railGroups[0]?.key ?? ALL_RAIL_KEY;
  }, [cliGroupLabel, currentModelId, otherProviderLabel, railGroups, sanitizedOptions]);

  const [activeRailKey, setActiveRailKey] = useState<string>(defaultRailKey);

  useEffect(() => {
    if (activeRailKey === FAVORITES_RAIL_KEY || activeRailKey === ALL_RAIL_KEY) return;
    if (!railGroups.some((g) => g.key === activeRailKey)) {
      setActiveRailKey(defaultRailKey);
    }
  }, [activeRailKey, defaultRailKey, railGroups]);

  useEffect(() => {
    if (isMobile) return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobile]);

  const keyword = search.trim().toLowerCase();

  const visibleModels = useMemo<T3ModelSelectorOption[]>(() => {
    if (keyword) {
      return sanitizedOptions.filter((model) =>
        [model.label, model.providerLabel, model.id]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(' ')
          .toLowerCase()
          .includes(keyword),
      );
    }
    if (activeRailKey === FAVORITES_RAIL_KEY) {
      return sanitizedOptions.filter(
        (model) => !isCliOption(model) && favoriteIds.has(model.id),
      );
    }
    if (activeRailKey === ALL_RAIL_KEY) {
      return sanitizedOptions;
    }
    const matchedGroup = railGroups.find((g) => g.key === activeRailKey);
    return matchedGroup ? matchedGroup.models : sanitizedOptions;
  }, [activeRailKey, favoriteIds, keyword, railGroups, sanitizedOptions]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [keyword, activeRailKey]);

  const handlePickRow = useCallback(
    (model: T3ModelSelectorOption) => {
      if (disabled) return;
      if (multiActive && multiSelect) {
        if (isCliOption(model)) {
          multiSelect.onActiveChange(false);
          onSelectModel?.(model.id);
          onRequestClose?.();
          return;
        }
        multiSelect.onToggle(model.id);
        return;
      }
      onSelectModel?.(model.id);
      onRequestClose?.();
    },
    [disabled, multiActive, multiSelect, onRequestClose, onSelectModel],
  );

  const handleToggleFavorite = useCallback(
    (modelId: string) => {
      void toggleFavorite(modelId).then((res) => {
        if (res === 'failed') {
          showGlobalNotification('error', t('chatV2:modelPicker.favoriteFailed'));
        }
      });
    },
    [t, toggleFavorite],
  );

  // ⌘1..⌘9 / Ctrl+1..Ctrl+9 与上下方向键导航
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const digit = Number.parseInt(event.key, 10);
        if (digit >= 1 && digit <= 9) {
          const target = visibleModels[digit - 1];
          if (target) {
            event.preventDefault();
            event.stopPropagation();
            handlePickRow(target);
          }
          return;
        }
      }

      if (event.key === 'ArrowDown') {
        if (visibleModels.length === 0) return;
        event.preventDefault();
        setHighlightedIndex((prev) => (prev + 1) % visibleModels.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        if (visibleModels.length === 0) return;
        event.preventDefault();
        setHighlightedIndex((prev) => (prev - 1 + visibleModels.length) % visibleModels.length);
        return;
      }

      if (event.key === 'Enter' && document.activeElement === searchInputRef.current) {
        const target = visibleModels[highlightedIndex];
        if (target) {
          event.preventDefault();
          event.stopPropagation();
          handlePickRow(target);
        }
      }
    },
    [handlePickRow, highlightedIndex, visibleModels],
  );

  // 点击权限弹层外部收起二级弹层
  useEffect(() => {
    if (!permissionMenuOpen) return;
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && permissionContainerRef.current && !permissionContainerRef.current.contains(target)) {
        setPermissionMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [permissionMenuOpen]);

  const applyPermissionPreset = useCallback(
    async (preset: PermissionPreset, confirm?: boolean) => {
      if (!onPermissionPresetChange || preset === permissionPreset || permissionSyncing) {
        setPermissionMenuOpen(false);
        return;
      }
      setPermissionSyncing(true);
      try {
        await onPermissionPresetChange(preset, confirm);
      } finally {
        setPermissionSyncing(false);
        setPermissionMenuOpen(false);
      }
    },
    [onPermissionPresetChange, permissionPreset, permissionSyncing],
  );

  const handleSelectPermissionPreset = useCallback(
    (preset: PermissionPreset) => {
      if (preset === permissionPreset) {
        setPermissionMenuOpen(false);
        return;
      }
      if (preset === 'danger_full_access') {
        setPermissionMenuOpen(false);
        setConfirmDangerOpen(true);
        return;
      }
      void applyPermissionPreset(preset);
    },
    [applyPermissionPreset, permissionPreset],
  );

  // 右栏推理强度状态推导
  const hasDepthOptions = Boolean(
    !isExternalCliEngine &&
      !thinkingUnsupported &&
      onSetThinkingDepth &&
      thinkingDepthOptions &&
      thinkingDepthOptions.length > 0,
  );
  const hasBinaryToggle = Boolean(
    !isExternalCliEngine &&
      !thinkingUnsupported &&
      !hasDepthOptions &&
      (onSetThinkingDepth || onToggleThinking),
  );

  const resolveDepthLabel = useCallback(
    (option: ReasoningLevelOption) => t(option.labelKey, option.defaultLabel),
    [t],
  );

  const handleTurnOffThinking = useCallback(() => {
    if (!thinkingCanDisable || !enableThinking) return;
    if (onSetThinkingDepth) {
      onSetThinkingDepth('off');
      return;
    }
    onToggleThinking?.();
  }, [enableThinking, onSetThinkingDepth, onToggleThinking, thinkingCanDisable]);

  const handleTurnOnThinking = useCallback(() => {
    if (enableThinking) return;
    onToggleThinking?.();
  }, [enableThinking, onToggleThinking]);

  const resolvedActiveModelHeading = useMemo(() => {
    if (activeModelLabel) return activeModelLabel;
    if (currentModelId) {
      const found = sanitizedOptions.find((o) => o.id === currentModelId);
      if (found) return found.label;
    }
    return activeModelProviderLabel || '';
  }, [activeModelLabel, activeModelProviderLabel, currentModelId, sanitizedOptions]);

  const renderModelBrandIcon = (model: T3ModelSelectorOption, size = 16) => {
    if (isCliOption(model)) {
      const cliBrandId = resolveCliBrandIconModelId(model.iconId || model.id || model.label);
      if (cliBrandId) {
        return renderAdaptiveBrandGlyph(cliBrandId, size);
      }
      return <TerminalWindow size={size} weight="duotone" className="shrink-0 text-primary" />;
    }
    return renderAdaptiveBrandGlyph(model.iconId || model.label || model.id, size);
  };

  const renderReasoningBody = () => {
    if (!hasDepthOptions && !hasBinaryToggle) {
      return (
        <div
          data-testid="t3-reasoning-empty"
          className="pt-0.5 text-xs leading-relaxed text-muted-foreground"
        >
          {t('chatV2:modelPicker.t3.noReasoningEffort', {
            defaultValue: '没有可选的推理强度',
          })}
        </div>
      );
    }

    if (hasDepthOptions && thinkingDepthOptions) {
      return (
        <div
          role="group"
          aria-label={t('chatV2:inputBar.thinkingDepthTitle', { defaultValue: '推理强度' })}
          className="flex flex-col gap-0.5"
        >
          {thinkingCanDisable && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!enableThinking}
              onClick={handleTurnOffThinking}
              className={cn(
                'flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                !enableThinking
                  ? 'bg-primary/12 font-medium text-primary'
                  : 'text-foreground/85 hover:bg-muted/70',
              )}
            >
              <span className="truncate">
                {t('chatV2:inputBar.thinkingOff', { defaultValue: '关闭' })}
              </span>
              {!enableThinking && <Check size={13} weight="bold" className="shrink-0" />}
            </button>
          )}
          {thinkingDepthOptions.map((option) => {
            const isSelected = Boolean(enableThinking) && thinkingDepthValue === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => onSetThinkingDepth?.(option.value)}
                className={cn(
                  'flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                  isSelected
                    ? 'bg-primary/12 font-medium text-primary'
                    : 'text-foreground/85 hover:bg-muted/70',
                )}
              >
                <span className="truncate">{resolveDepthLabel(option)}</span>
                {isSelected && <Check size={13} weight="bold" className="shrink-0" />}
              </button>
            );
          })}
        </div>
      );
    }

    return (
      <div
        role="group"
        aria-label={t('chatV2:inputBar.thinking', { defaultValue: '推理模式' })}
        className="flex flex-col gap-0.5"
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked={Boolean(enableThinking)}
          onClick={handleTurnOnThinking}
          className={cn(
            'flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
            enableThinking
              ? 'bg-primary/12 font-medium text-primary'
              : 'text-foreground/85 hover:bg-muted/70',
          )}
        >
          <span className="truncate">
            {t('chatV2:inputBar.thinkingOn', { defaultValue: '开启' })}
          </span>
          {enableThinking && <Check size={13} weight="bold" className="shrink-0" />}
        </button>
        {thinkingCanDisable && (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!enableThinking}
            onClick={handleTurnOffThinking}
            className={cn(
              'flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
              !enableThinking
                ? 'bg-primary/12 font-medium text-primary'
                : 'text-foreground/85 hover:bg-muted/70',
            )}
          >
            <span className="truncate">
              {t('chatV2:inputBar.thinkingOff', { defaultValue: '关闭' })}
            </span>
            {!enableThinking && <Check size={13} weight="bold" className="shrink-0" />}
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <div
        data-testid="t3-model-selector"
        data-layout-tier={effectiveTier}
        onKeyDown={handleKeyDown}
        style={{ height: lockedHeight }}
        className="flex w-full min-w-0 flex-col overflow-hidden bg-popover text-popover-foreground select-none"
      >
        {/* 主体区域：flex-1 min-h-0 严格服从外层锁定高度，顶栏与底栏永不被裁切 */}
        <div className="flex min-h-0 w-full flex-1 overflow-hidden">
          {/* 第一栏：左侧收藏 + 品牌供应商图标轨（纯原生按钮，零重排闪烁） */}
          <div
            data-testid="t3-provider-rail"
            className={cn(
              'flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border/60 py-2 scrollbar-none',
              effectiveTier === 'wide' ? 'w-12' : 'w-10',
            )}
          >
            <button
              type="button"
              data-testid="t3-rail-favorites"
              title={t('chatV2:modelPicker.favorites', { defaultValue: '收藏' })}
              aria-label={t('chatV2:modelPicker.favorites', { defaultValue: '收藏' })}
              aria-pressed={activeRailKey === FAVORITES_RAIL_KEY && !keyword}
              onClick={() => {
                setSearch('');
                setActiveRailKey((prev) =>
                  prev === FAVORITES_RAIL_KEY ? ALL_RAIL_KEY : FAVORITES_RAIL_KEY,
                );
              }}
              className={cn(
                'relative flex h-8 shrink-0 items-center justify-center rounded-lg transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                effectiveTier === 'wide' ? 'w-9' : 'w-8',
                activeRailKey === FAVORITES_RAIL_KEY && !keyword
                  ? 'bg-muted/45 text-foreground'
                  : 'text-foreground/80',
              )}
            >
              <Star size={17} weight="fill" />
              {activeRailKey === FAVORITES_RAIL_KEY && !keyword && (
                <span
                  data-testid="t3-rail-active-indicator"
                  className="absolute right-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-primary"
                />
              )}
            </button>

            <div className="my-0.5 h-px w-6 shrink-0 bg-border/70" aria-hidden="true" />

            {railGroups.map((group) => {
              const isActive = !keyword && activeRailKey === group.key;
              return (
                <button
                  key={group.key}
                  type="button"
                  data-testid={`t3-rail-group-${group.key}`}
                  title={group.label}
                  aria-label={group.label}
                  aria-pressed={isActive}
                  onClick={() => {
                    setSearch('');
                    setActiveRailKey((prev) => (prev === group.key ? ALL_RAIL_KEY : group.key));
                  }}
                  className={cn(
                    'relative flex h-8 shrink-0 items-center justify-center rounded-lg transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                    effectiveTier === 'wide' ? 'w-9' : 'w-8',
                    isActive
                      ? 'bg-muted/45 text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {group.isCodingCli ? (
                    <TerminalWindow size={17} weight="duotone" className="text-foreground/85" />
                  ) : (
                    renderAdaptiveBrandGlyph(group.iconModelId || group.label, 17)
                  )}
                  {isActive && (
                    <span
                      data-testid="t3-rail-active-indicator"
                      className="absolute right-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-primary"
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* 第二栏：搜索 + 模型 / CLI 列表（min-w-0 保证长文案永远省略号收敛，不撑宽父容器） */}
          <div
            data-testid="t3-model-list-pane"
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
              !isCompactTier && 'border-r border-border/60',
            )}
          >
            {/* 顶部无框下划线搜索框（固定不随列表滚动） */}
            <div className="shrink-0 px-3 pt-2.5 pb-1">
              <div className="flex items-center gap-2 border-b border-primary/45 pb-1.5 transition-colors focus-within:border-primary">
                <MagnifyingGlass
                  size={14}
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  ref={searchInputRef}
                  type="text"
                  data-testid="t3-model-search-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('chatV2:modelPicker.t3.searchPlaceholder', {
                    defaultValue: '搜索模型...',
                  })}
                  aria-label={t('chatV2:modelPicker.t3.searchPlaceholder', {
                    defaultValue: '搜索模型...',
                  })}
                  className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-foreground placeholder:text-muted-foreground/75 outline-none [@media(pointer:coarse)]:text-base"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label={t('chatV2:common.clearSearch', { defaultValue: '清除搜索' })}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X size={12} weight="bold" />
                  </button>
                )}
              </div>
            </div>

            {/* 模型滚动列表 */}
            <div
              role="menu"
              aria-label={t('chatV2:inputBar.runtimeModelTitle', { defaultValue: '模型' })}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 [mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent_100%)]"
            >
              {sanitizedOptions.length === 0 && hasModelPanel && onOpenRuntimeModelPanel ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onRequestClose?.();
                      onOpenRuntimeModelPanel('single');
                    }}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    {t('chatV2:inputBar.chooseRuntimeModel', { defaultValue: '选择模型' })}
                  </button>
                </div>
              ) : visibleModels.length === 0 ? (
                <div className="flex h-full items-center justify-center px-3 text-center text-xs leading-relaxed text-muted-foreground">
                  <span className="max-w-full break-words">
                    {activeRailKey === FAVORITES_RAIL_KEY && !keyword
                      ? t('chatV2:modelPicker.t3.emptyFavorites', {
                          defaultValue: '暂无收藏模型，悬停模型右侧点击星标即可收藏',
                        })
                      : t('chatV2:inputBar.runtimeModelNoResults', {
                          defaultValue: '未找到匹配模型',
                        })}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 pb-2.5">
                  {visibleModels.map((model, index) => {
                    const isCurrent = !multiActive && model.id === currentModelId;
                    const isChecked = multiActive && selectedIdSet.has(model.id);
                    const isFavorite = !isCliOption(model) && favoriteIds.has(model.id);
                    const isHighlighted = index === highlightedIndex;
                    const shortcutLabel =
                      !isCompactTier && index < 9
                        ? isMacPlatform
                          ? `⌘${index + 1}`
                          : `^${index + 1}`
                        : null;

                    return (
                      <div
                        key={model.id}
                        className={cn(
                          'group relative flex h-8.5 min-h-[34px] w-full min-w-0 items-center rounded-lg text-left text-[13px] transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                          isMediumTier || isCompactTier ? 'gap-2 px-2' : 'gap-2.5 px-2.5',
                          isCurrent || isChecked
                            ? 'bg-primary/12 font-medium text-foreground'
                            : isHighlighted
                              ? 'bg-muted/65 text-foreground'
                              : 'text-foreground hover:bg-muted/65',
                        )}
                        onMouseEnter={() => setHighlightedIndex(index)}
                      >
                        <button
                          type="button"
                          role={multiActive ? 'menuitemcheckbox' : 'menuitem'}
                          aria-checked={multiActive ? isChecked : undefined}
                          disabled={disabled}
                          onClick={() => handlePickRow(model)}
                          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none"
                        >
                          {renderModelBrandIcon(model, 16)}
                          <span className="min-w-0 flex-1 truncate" title={model.label}>
                            {model.label}
                          </span>
                          {model.unavailable && (
                            <span className="shrink-0 rounded border border-border/80 bg-background/70 px-1 py-px text-2xs font-normal leading-tight text-muted-foreground">
                              {t('chatV2:modelPicker.t3.unavailable', { defaultValue: '不可用' })}
                            </span>
                          )}
                          {isCliOption(model) && effectiveTier === 'wide' && (
                            <span className="shrink-0 rounded bg-muted px-1 py-px text-2xs font-medium text-muted-foreground">
                              {t('agentMesh:picker.cliBadge', { defaultValue: 'CLI' })}
                            </span>
                          )}
                        </button>

                        {!isCliOption(model) && (
                          <button
                            type="button"
                            data-testid={`t3-favorite-toggle-${model.id}`}
                            aria-label={
                              isFavorite
                                ? t('chatV2:modelPicker.unfavoriteModel', {
                                    name: model.label,
                                    defaultValue: `取消收藏 ${model.label}`,
                                  })
                                : t('chatV2:modelPicker.favoriteModel', {
                                    name: model.label,
                                    defaultValue: `收藏 ${model.label}`,
                                  })
                            }
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleToggleFavorite(model.id);
                            }}
                            className={cn(
                              'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground',
                              isFavorite
                                ? 'opacity-100 text-amber-500'
                                : 'hidden group-hover:flex focus-visible:flex [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:opacity-70',
                            )}
                          >
                            <Star size={13} weight={isFavorite ? 'fill' : 'regular'} />
                          </button>
                        )}

                        {multiActive ? (
                          <span
                            aria-hidden="true"
                            className={cn(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                              isChecked
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background',
                            )}
                          >
                            {isChecked && <Check size={11} weight="bold" />}
                          </span>
                        ) : shortcutLabel ? (
                          <kbd
                            data-testid={`t3-model-shortcut-${index + 1}`}
                            className="pointer-events-none shrink-0 rounded bg-muted/90 px-1.5 py-0.5 font-mono text-[11px] font-normal leading-none text-muted-foreground"
                          >
                            {shortcutLabel}
                          </kbd>
                        ) : isCurrent ? (
                          <Check size={14} weight="bold" className="shrink-0 text-primary" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 第三栏：桌面宽屏 / 中屏推理强度面板 */}
          {!isCompactTier && (
            <div
              data-testid="t3-reasoning-pane"
              className={cn(
                'flex min-h-0 shrink-0 flex-col overflow-hidden',
                isMediumTier ? 'w-[148px] p-2.5' : 'w-[192px] p-3',
              )}
            >
              <div className="flex shrink-0 items-baseline justify-between gap-1.5 pb-2.5">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t('chatV2:inputBar.thinkingDepthTitle', { defaultValue: '推理强度' })}
                </span>
                {resolvedActiveModelHeading && (
                  <span
                    data-testid="t3-reasoning-active-model"
                    className="min-w-0 truncate text-xs text-muted-foreground/90"
                    title={resolvedActiveModelHeading}
                  >
                    {resolvedActiveModelHeading}
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
                {renderReasoningBody()}
              </div>
            </div>
          )}
        </div>

        {/* 窄屏 / 移动端紧凑推理强度单行横条 */}
        {isCompactTier && (
          <div
            data-testid="t3-reasoning-pane-mobile"
            className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5"
          >
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {t('chatV2:inputBar.thinkingDepthTitle', { defaultValue: '推理强度' })}
            </span>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none">
              {!hasDepthOptions && !hasBinaryToggle ? (
                <span
                  data-testid="t3-reasoning-empty"
                  className="truncate text-xs text-muted-foreground"
                >
                  {t('chatV2:modelPicker.t3.noReasoningEffort', {
                    defaultValue: '没有可选的推理强度',
                  })}
                </span>
              ) : hasDepthOptions && thinkingDepthOptions ? (
                <>
                  {thinkingCanDisable && (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={!enableThinking}
                      onClick={handleTurnOffThinking}
                      className={cn(
                        'shrink-0 rounded-md px-2 py-1 text-xs transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                        !enableThinking
                          ? 'bg-primary/15 font-medium text-primary'
                          : 'bg-muted/60 text-muted-foreground',
                      )}
                    >
                      {t('chatV2:inputBar.thinkingOff', { defaultValue: '关闭' })}
                    </button>
                  )}
                  {thinkingDepthOptions.map((option) => {
                    const isSelected =
                      Boolean(enableThinking) && thinkingDepthValue === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => onSetThinkingDepth?.(option.value)}
                        className={cn(
                          'shrink-0 rounded-md px-2 py-1 text-xs transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                          isSelected
                            ? 'bg-primary/15 font-medium text-primary'
                            : 'bg-muted/60 text-muted-foreground',
                        )}
                      >
                        {resolveDepthLabel(option)}
                      </button>
                    );
                  })}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={Boolean(enableThinking)}
                    onClick={handleTurnOnThinking}
                    className={cn(
                      'shrink-0 rounded-md px-2 py-1 text-xs transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                      enableThinking
                        ? 'bg-primary/15 font-medium text-primary'
                        : 'bg-muted/60 text-muted-foreground',
                    )}
                  >
                    {t('chatV2:inputBar.thinkingOn', { defaultValue: '开启' })}
                  </button>
                  {thinkingCanDisable && (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={!enableThinking}
                      onClick={handleTurnOffThinking}
                      className={cn(
                        'shrink-0 rounded-md px-2 py-1 text-xs transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                        !enableThinking
                          ? 'bg-primary/15 font-medium text-primary'
                          : 'bg-muted/60 text-muted-foreground',
                      )}
                    >
                      {t('chatV2:inputBar.thinkingOff', { defaultValue: '关闭' })}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 底部通栏：左侧多选对比开关（可选）+ 右侧权限预设快速切换 */}
        <div
          data-testid="t3-picker-footer"
          className="relative flex shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-popover px-3 py-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            {multiSelect && sanitizedOptions.some((o) => !isCliOption(o)) && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={multiActive}
                data-testid="runtime-model-multi-select-switch"
                onClick={() => multiSelect.onActiveChange(!multiActive)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                  multiActive
                    ? 'bg-primary/12 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                )}
              >
                <SquaresFour size={13} weight={multiActive ? 'fill' : 'regular'} />
                <span className="truncate">
                  {t('chatV2:inputBar.runtimeModelCompareMode', { defaultValue: '多选模式' })}
                </span>
                {multiActive && multiSelect.selectedIds.length > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-px font-mono text-2xs text-primary-foreground">
                    {multiSelect.selectedIds.length}
                  </span>
                )}
              </button>
            )}
          </div>

          {/* 右下角权限预设选择器 */}
          <div ref={permissionContainerRef} className="relative flex shrink-0 items-center">
            <button
              type="button"
              data-testid="t3-permission-trigger"
              disabled={!onPermissionPresetChange || permissionSyncing}
              aria-expanded={permissionMenuOpen}
              onClick={() => {
                if (!onPermissionPresetChange) return;
                setPermissionMenuOpen((prev) => !prev);
              }}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                onPermissionPresetChange
                  ? 'hover:bg-muted/70 hover:text-foreground cursor-pointer'
                  : 'opacity-75 cursor-default',
              )}
            >
              {renderPermissionIcon(permissionPreset)}
              <span className="truncate">
                {t(`chatV2:authority.permissionPreset.modes.${permissionPreset}`, {
                  defaultValue: permissionPreset,
                })}
              </span>
              {onPermissionPresetChange && (
                <CaretUp
                  size={12}
                  weight="bold"
                  className={cn(
                    'shrink-0 opacity-70 transition-transform duration-150',
                    permissionMenuOpen && 'rotate-180',
                  )}
                />
              )}
            </button>

            {permissionMenuOpen && onPermissionPresetChange && (
              <div
                role="menu"
                data-testid="t3-permission-menu"
                className="absolute bottom-full right-0 z-20 mb-1.5 w-48 max-w-[calc(100vw-32px)] rounded-xl border border-border/80 bg-popover p-1 shadow-lg"
              >
                {PERMISSION_PRESET_ORDER.map((preset) => {
                  const isSelected = preset === permissionPreset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      disabled={permissionSyncing}
                      data-testid={`t3-permission-option-${preset}`}
                      onClick={() => handleSelectPermissionPreset(preset)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/70 [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                        isSelected ? 'bg-primary/12 font-medium text-primary' : 'text-foreground',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {renderPermissionIcon(preset)}
                        <span className="truncate">
                          {t(`chatV2:authority.permissionPreset.modes.${preset}`, {
                            defaultValue: preset,
                          })}
                        </span>
                      </span>
                      {isSelected && <Check size={13} weight="bold" className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 高风险全自动确认弹窗（复用统一 DsAlertDialog，不使用浏览器原生确认框） */}
      <DsAlertDialog
        open={confirmDangerOpen}
        onOpenChange={setConfirmDangerOpen}
        tone="destructive"
        title={t('chatV2:authority.permissionPreset.confirmDangerTitle')}
        description={t('chatV2:authority.permissionPreset.confirmDangerBody')}
        cancelText={t('common:actions.cancel')}
        confirmText={t('chatV2:authority.permissionPreset.confirmDangerAction')}
        onConfirm={() => {
          void applyPermissionPreset('danger_full_access', true);
        }}
      />
    </>
  );
};

export default T3ModelSelectorPopover;
