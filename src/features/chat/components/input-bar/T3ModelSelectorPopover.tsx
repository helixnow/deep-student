/**
 * T3ModelSelectorPopover - T3 Code 风格三栏统一模型 / 编程 CLI（含二级模型选择）/ 推理强度 / 运行时底栏选择器
 *
 * 布局与自适应策略：
 * 1. 外壳宽高由父级按当前聊天栏宽度与触发器上下可视空间锁定（wide / medium / compact 三档），
 *    切换左侧供应商、收藏、CLI 二级展开或搜索时外框宽高零变化，彻底消除浮层重排与闪烁。
 * 2. wide (>=510px)：标准三栏（48px 图标轨 + 自适应模型/CLI 列表 + 192px 推理强度栏）
 *    medium (388..509px)：紧凑三栏（40px 图标轨 + 自适应模型/CLI 列表 + 148px 推理强度栏）
 *    compact (<388px / 移动端)：双栏（40px 图标轨 + 模型/CLI 列表）+ 底部单行横向可滚推理强度条
 * 3. 本地编程 CLI 二级模型展开：左侧归并为单一终端图标，点击某个 CLI 即在中间栏原位下钻展示其
 *    「跟随默认配置 + 探测/官方模型 + 自定义模型 ID」，右栏联动该 CLI 的推理强度档位。
 * 4. 底栏收敛全局运行时控制：左侧「联网 / 多选 / 参数」，右侧「权限档位（谨慎 / 宽松 / 完全访问）」。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  Globe,
  MagnifyingGlass,
  Shield,
  ShieldCheck,
  ShieldSlash,
  ShieldWarning,
  SlidersHorizontal,
  SquaresFour,
  Star,
  TerminalWindow,
  X,
} from '@phosphor-icons/react';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  formatCompactCliModelName,
  isAgentMeshHostConnected,
  probeAgents,
  resolveCliAvailableModels,
  resolveCliReasoningLevels,
  selectSelectedCliEffortForSession,
  selectSelectedCliModelForSession,
  useAgentMeshStore,
  type CliReasoningEffortLevel,
} from '@/features/agent-mesh';
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
  formatCliModelSelectionId,
  parseCliModelSelectionId,
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

const CLI_EFFORT_FALLBACK_LABELS: Readonly<Record<CliReasoningEffortLevel, string>> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '超高',
};

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
  webSearchEnabled?: boolean;
  onWebSearchEnabledChange?: (enabled: boolean) => void | Promise<void>;
  renderAdvancedPanel?: (options?: { embedded?: boolean; onClose?: () => void }) => React.ReactNode;
  onOpenAdvancedPanel?: () => void;
  initialView?: 'models' | 'params';
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

interface CliSubModelRow {
  key: string;
  label: string;
  modelValue: string | null;
  badge?: string | null;
  isCustom?: boolean;
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

function extractCliAgentId(option: T3ModelSelectorOption): string {
  if (option.cliAgentId?.trim()) return option.cliAgentId.trim();
  const parsed = parseCliModelSelectionId(option.id);
  return parsed?.cliAgentId ?? option.id.trim();
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
  webSearchEnabled,
  onWebSearchEnabledChange,
  renderAdvancedPanel,
  onOpenAdvancedPanel,
  initialView = 'models',
  sessionId,
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

  const storeCliModel = useAgentMeshStore((s) => selectSelectedCliModelForSession(s, sessionId));
  const storeCliEffort = useAgentMeshStore((s) => selectSelectedCliEffortForSession(s, sessionId));

  // 无 sessionId 场景（独立组件单测）下的本地回退状态
  const [fallbackCliModel, setFallbackCliModel] = useState<string | null>(null);
  const [fallbackCliEffort, setFallbackCliEffort] = useState<string | null>(null);

  const effectiveCliModel = sessionId ? storeCliModel : fallbackCliModel;
  const effectiveCliEffort = sessionId ? storeCliEffort : fallbackCliEffort;

  const effectiveTier: T3PopoverLayoutTier =
    layoutTier ?? (isMobile ? 'compact' : 'wide');
  const isCompactTier = effectiveTier === 'compact';
  const isMediumTier = effectiveTier === 'medium';

  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'models' | 'params'>(initialView);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  useEffect(() => {
    setViewMode(initialView);
  }, [initialView]);
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

  const currentCliSelection = useMemo(
    () => (currentModelId ? parseCliModelSelectionId(currentModelId) : null),
    [currentModelId],
  );

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
    if (currentCliSelection) {
      const hasCliGroup = railGroups.some((g) => g.key === CODING_CLI_RAIL_KEY);
      if (hasCliGroup) return CODING_CLI_RAIL_KEY;
    }
    if (currentModelId) {
      const currentOption = sanitizedOptions.find((item) => item.id === currentModelId);
      if (currentOption) {
        return resolveOptionGroupMeta(currentOption, cliGroupLabel, otherProviderLabel).key;
      }
    }
    return railGroups[0]?.key ?? ALL_RAIL_KEY;
  }, [cliGroupLabel, currentCliSelection, currentModelId, otherProviderLabel, railGroups, sanitizedOptions]);

  const [activeRailKey, setActiveRailKey] = useState<string>(defaultRailKey);
  const [drilledCliAgentId, setDrilledCliAgentId] = useState<string | null>(
    () => currentCliSelection?.cliAgentId ?? null,
  );

  useEffect(() => {
    if (activeRailKey === FAVORITES_RAIL_KEY || activeRailKey === ALL_RAIL_KEY) return;
    if (!railGroups.some((g) => g.key === activeRailKey)) {
      setActiveRailKey(defaultRailKey);
    }
  }, [activeRailKey, defaultRailKey, railGroups]);

  useEffect(() => {
    if (!drilledCliAgentId) return;
    const stillExists = sanitizedOptions.some(
      (opt) => isCliOption(opt) && extractCliAgentId(opt) === drilledCliAgentId,
    );
    if (!stillExists) {
      setDrilledCliAgentId(currentCliSelection?.cliAgentId ?? null);
    }
  }, [currentCliSelection?.cliAgentId, drilledCliAgentId, sanitizedOptions]);

  useEffect(() => {
    if (isMobile) return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobile, drilledCliAgentId]);

  useEffect(() => {
    if (activeRailKey !== CODING_CLI_RAIL_KEY || !isAgentMeshHostConnected()) return;
    const storeAgents = useAgentMeshStore.getState().agents;
    const needsCatalogRefresh = storeAgents.some(
      (a) => a.driverKind !== 'builtin' && a.installed && (!a.availableModels || a.availableModels.length === 0),
    );
    if (needsCatalogRefresh) {
      void probeAgents({ forceRefresh: true });
    }
  }, [activeRailKey]);

  const drilledCliOption = useMemo<T3ModelSelectorOption | null>(() => {
    if (!drilledCliAgentId || activeRailKey !== CODING_CLI_RAIL_KEY || multiActive) {
      return null;
    }
    return (
      sanitizedOptions.find(
        (opt) => isCliOption(opt) && extractCliAgentId(opt) === drilledCliAgentId,
      ) ?? null
    );
  }, [activeRailKey, drilledCliAgentId, multiActive, sanitizedOptions]);

  const trimmedSearch = search.trim();
  const keyword = trimmedSearch.toLowerCase();

  // 一级模型 / CLI 列表过滤
  const visibleModels = useMemo<T3ModelSelectorOption[]>(() => {
    const basePool = multiActive
      ? sanitizedOptions.filter((model) => !isCliOption(model))
      : sanitizedOptions;
    if (keyword) {
      return basePool.filter((model) =>
        [model.label, model.providerLabel, model.id]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(' ')
          .toLowerCase()
          .includes(keyword),
      );
    }
    if (activeRailKey === FAVORITES_RAIL_KEY) {
      return basePool.filter(
        (model) => !isCliOption(model) && favoriteIds.has(model.id),
      );
    }
    if (activeRailKey === ALL_RAIL_KEY) {
      return basePool;
    }
    const matchedGroup = railGroups.find((g) => g.key === activeRailKey);
    if (!matchedGroup) return basePool;
    return multiActive
      ? matchedGroup.models.filter((model) => !isCliOption(model))
      : matchedGroup.models;
  }, [activeRailKey, favoriteIds, keyword, multiActive, railGroups, sanitizedOptions]);

  // 二级 CLI 模型列表构建（默认跟随项 + 探测/预设项 + 任意自定义模型 ID）
  const cliSubModelRows = useMemo<CliSubModelRow[]>(() => {
    if (!drilledCliOption) return [];
    const cliAgentId = extractCliAgentId(drilledCliOption);
    const catalog =
      drilledCliOption.cliAvailableModels && drilledCliOption.cliAvailableModels.length > 0
        ? [...drilledCliOption.cliAvailableModels]
        : resolveCliAvailableModels({
            id: cliAgentId,
            driverKind: (drilledCliOption.cliDriverKind as any) || 'custom',
            defaultModel: drilledCliOption.cliDefaultModel ?? null,
          });

    const rows: CliSubModelRow[] = [];
    const followDefaultLabel = t('chatV2:modelPicker.t3.cliFollowDefault', {
      defaultValue: '跟随 CLI 默认配置',
    });
    const defaultBadge =
      drilledCliOption.cliDefaultModel?.trim() ||
      t('chatV2:modelPicker.t3.cliDefaultTag', { defaultValue: '默认' });

    if (
      !keyword ||
      followDefaultLabel.toLowerCase().includes(keyword) ||
      'default'.includes(keyword) ||
      defaultBadge.toLowerCase().includes(keyword)
    ) {
      rows.push({
        key: '__cli_default__',
        label: followDefaultLabel,
        modelValue: null,
        badge: defaultBadge,
      });
    }

    for (const modelId of catalog) {
      if (!keyword || modelId.toLowerCase().includes(keyword)) {
        rows.push({
          key: `preset:${modelId}`,
          label: modelId,
          modelValue: modelId,
          badge:
            drilledCliOption.cliDefaultModel &&
            drilledCliOption.cliDefaultModel.trim() === modelId
              ? t('chatV2:modelPicker.t3.cliDefaultTag', { defaultValue: '默认' })
              : null,
        });
      }
    }

    if (
      trimmedSearch.length > 0 &&
      !catalog.some((m) => m.toLowerCase() === keyword)
    ) {
      rows.push({
        key: `custom:${trimmedSearch}`,
        label: t('chatV2:modelPicker.t3.cliCustomModel', {
          model: trimmedSearch,
          defaultValue: `使用自定义模型 "${trimmedSearch}"`,
        }),
        modelValue: trimmedSearch,
        isCustom: true,
      });
    }

    return rows;
  }, [drilledCliOption, keyword, t, trimmedSearch]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [keyword, activeRailKey, drilledCliAgentId]);

  const commitCliModelSelection = useCallback(
    (cliAgentId: string, cliModel: string | null, shouldClose: boolean) => {
      if (disabled) return;
      if (sessionId) {
        const meshActions = useAgentMeshStore.getState();
        meshActions.setSelectedCliForSession(sessionId, cliAgentId);
        meshActions.setSelectedCliModelForSession(sessionId, cliModel);
      } else {
        setFallbackCliModel(cliModel);
      }
      onSelectModel?.(formatCliModelSelectionId(cliAgentId, cliModel));
      if (shouldClose) {
        onRequestClose?.();
      }
    },
    [disabled, onRequestClose, onSelectModel, sessionId],
  );

  const handlePickRow = useCallback(
    (model: T3ModelSelectorOption) => {
      if (disabled) return;
      if (isCliOption(model)) {
        const cliAgentId = extractCliAgentId(model);
        if (multiActive && multiSelect) {
          multiSelect.onActiveChange(false);
        }
        const preserveModel =
          currentCliSelection?.cliAgentId === cliAgentId ? effectiveCliModel : null;
        // 立即激活该 CLI 引擎，并在中间栏原位下钻展开其二级模型列表（零宽高跳变）
        commitCliModelSelection(cliAgentId, preserveModel, false);
        setSearch('');
        setActiveRailKey(CODING_CLI_RAIL_KEY);
        setDrilledCliAgentId(cliAgentId);
        return;
      }
      if (multiActive && multiSelect) {
        multiSelect.onToggle(model.id);
        return;
      }
      onSelectModel?.(model.id);
      onRequestClose?.();
    },
    [
      commitCliModelSelection,
      currentCliSelection?.cliAgentId,
      disabled,
      effectiveCliModel,
      multiActive,
      multiSelect,
      onRequestClose,
      onSelectModel,
    ],
  );

  const handlePickCliSubModel = useCallback(
    (row: CliSubModelRow) => {
      if (!drilledCliOption || disabled) return;
      const cliAgentId = extractCliAgentId(drilledCliOption);
      commitCliModelSelection(cliAgentId, row.modelValue, true);
    },
    [commitCliModelSelection, disabled, drilledCliOption],
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

  const activeListLength = drilledCliOption ? cliSubModelRows.length : visibleModels.length;

  // ⌘1..⌘9 / Ctrl+1..Ctrl+9、返回上级与上下方向键导航
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (viewMode === 'params') {
        return;
      }

      if (
        event.key === 'Backspace' &&
        drilledCliOption &&
        !search &&
        document.activeElement === searchInputRef.current
      ) {
        event.preventDefault();
        setDrilledCliAgentId(null);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const digit = Number.parseInt(event.key, 10);
        if (digit >= 1 && digit <= 9) {
          if (drilledCliOption) {
            const target = cliSubModelRows[digit - 1];
            if (target) {
              event.preventDefault();
              event.stopPropagation();
              handlePickCliSubModel(target);
            }
            return;
          }
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
        if (activeListLength === 0) return;
        event.preventDefault();
        setHighlightedIndex((prev) => (prev + 1) % activeListLength);
        return;
      }

      if (event.key === 'ArrowUp') {
        if (activeListLength === 0) return;
        event.preventDefault();
        setHighlightedIndex((prev) => (prev - 1 + activeListLength) % activeListLength);
        return;
      }

      if (event.key === 'Enter' && document.activeElement === searchInputRef.current) {
        if (drilledCliOption) {
          const target = cliSubModelRows[highlightedIndex];
          if (target) {
            event.preventDefault();
            event.stopPropagation();
            handlePickCliSubModel(target);
          }
          return;
        }
        const target = visibleModels[highlightedIndex];
        if (target) {
          event.preventDefault();
          event.stopPropagation();
          handlePickRow(target);
        }
      }
    },
    [
      activeListLength,
      cliSubModelRows,
      drilledCliOption,
      handlePickCliSubModel,
      handlePickRow,
      highlightedIndex,
      search,
      viewMode,
      visibleModels,
    ],
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

  // 右栏推理强度状态推导：当前焦点为编程 CLI 时，切换到该 CLI 的推理强度档位
  const activeCliForReasoning = useMemo<string | null>(() => {
    if (drilledCliOption) {
      return extractCliAgentId(drilledCliOption);
    }
    if (isExternalCliEngine && currentCliSelection) {
      return currentCliSelection.cliAgentId;
    }
    return null;
  }, [currentCliSelection, drilledCliOption, isExternalCliEngine]);

  const cliReasoningLevels = useMemo(
    () => resolveCliReasoningLevels(activeCliForReasoning),
    [activeCliForReasoning],
  );

  const handleSetCliEffort = useCallback(
    (effort: CliReasoningEffortLevel | null) => {
      if (!activeCliForReasoning) return;
      if (sessionId) {
        const meshActions = useAgentMeshStore.getState();
        meshActions.setSelectedCliForSession(sessionId, activeCliForReasoning);
        meshActions.setSelectedCliEffortForSession(sessionId, effort);
      } else {
        setFallbackCliEffort(effort);
      }
    },
    [activeCliForReasoning, sessionId],
  );

  const resolveCliEffortLabel = useCallback(
    (level: CliReasoningEffortLevel) =>
      t(`chatV2:inputBar.thinkingDepth.${level}`, {
        defaultValue: CLI_EFFORT_FALLBACK_LABELS[level],
      }),
    [t],
  );

  const hasDepthOptions = Boolean(
    !activeCliForReasoning &&
      !isExternalCliEngine &&
      !thinkingUnsupported &&
      onSetThinkingDepth &&
      thinkingDepthOptions &&
      thinkingDepthOptions.length > 0,
  );
  const hasBinaryToggle = Boolean(
    !activeCliForReasoning &&
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
    if (drilledCliOption) {
      return effectiveCliModel
        ? `${drilledCliOption.label} · ${formatCompactCliModelName(effectiveCliModel)}`
        : drilledCliOption.label;
    }
    if (activeModelLabel) return activeModelLabel;
    if (currentModelId) {
      const found = sanitizedOptions.find((o) => o.id === currentModelId);
      if (found) return found.label;
    }
    return activeModelProviderLabel || '';
  }, [
    activeModelLabel,
    activeModelProviderLabel,
    currentModelId,
    drilledCliOption,
    effectiveCliModel,
    sanitizedOptions,
  ]);

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
    if (activeCliForReasoning) {
      if (cliReasoningLevels.length === 0) {
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

      return (
        <div
          role="group"
          data-testid="t3-cli-reasoning-group"
          aria-label={t('chatV2:inputBar.thinkingDepthTitle', { defaultValue: '推理强度' })}
          className="flex flex-col gap-0.5"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!effectiveCliEffort}
            onClick={() => handleSetCliEffort(null)}
            className={cn(
              'flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
              !effectiveCliEffort
                ? 'bg-primary/12 font-medium text-primary'
                : 'text-foreground/85 hover:bg-muted/70',
            )}
          >
            <span className="truncate">
              {t('chatV2:modelPicker.t3.cliEffortDefault', { defaultValue: '默认' })}
            </span>
            {!effectiveCliEffort && <Check size={13} weight="bold" className="shrink-0" />}
          </button>
          {cliReasoningLevels.map((level) => {
            const isSelected = effectiveCliEffort === level;
            return (
              <button
                key={level}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => handleSetCliEffort(level)}
                className={cn(
                  'flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                  isSelected
                    ? 'bg-primary/12 font-medium text-primary'
                    : 'text-foreground/85 hover:bg-muted/70',
                )}
              >
                <span className="truncate">{resolveCliEffortLabel(level)}</span>
                {isSelected && <Check size={13} weight="bold" className="shrink-0" />}
              </button>
            );
          })}
        </div>
      );
    }

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

  const searchPlaceholderText = drilledCliOption
    ? t('chatV2:modelPicker.t3.cliSearchPlaceholder', {
        defaultValue: '搜索或输入自定义模型 ID...',
      })
    : t('chatV2:modelPicker.t3.searchPlaceholder', {
        defaultValue: '搜索模型...',
      });

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
              aria-pressed={viewMode === 'models' && activeRailKey === FAVORITES_RAIL_KEY && !keyword}
              onClick={() => {
                setSearch('');
                setViewMode('models');
                setDrilledCliAgentId(null);
                setActiveRailKey((prev) =>
                  viewMode === 'params'
                    ? FAVORITES_RAIL_KEY
                    : prev === FAVORITES_RAIL_KEY
                      ? ALL_RAIL_KEY
                      : FAVORITES_RAIL_KEY,
                );
              }}
              className={cn(
                'relative flex h-8 shrink-0 items-center justify-center rounded-lg transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                effectiveTier === 'wide' ? 'w-9' : 'w-8',
                viewMode === 'models' && activeRailKey === FAVORITES_RAIL_KEY && !keyword
                  ? 'bg-muted/45 text-foreground'
                  : 'text-foreground/80',
              )}
            >
              <Star size={17} weight="fill" />
              {viewMode === 'models' && activeRailKey === FAVORITES_RAIL_KEY && !keyword && (
                <span
                  data-testid="t3-rail-active-indicator"
                  className="absolute right-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-primary"
                />
              )}
            </button>

            <div className="my-0.5 h-px w-6 shrink-0 bg-border/70" aria-hidden="true" />

            {railGroups.map((group) => {
              const isActive = viewMode === 'models' && !keyword && activeRailKey === group.key;
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
                    if (viewMode === 'params') {
                      setViewMode('models');
                      setDrilledCliAgentId(null);
                      setActiveRailKey(group.key);
                      return;
                    }
                    if (group.key === CODING_CLI_RAIL_KEY) {
                      if (activeRailKey === CODING_CLI_RAIL_KEY && drilledCliAgentId) {
                        setDrilledCliAgentId(null);
                        return;
                      }
                      setDrilledCliAgentId(null);
                    } else {
                      setDrilledCliAgentId(null);
                    }
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

          {viewMode === 'params' && renderAdvancedPanel ? (
            <div
              data-testid="t3-params-pane"
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs">
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="t3-params-back"
                    onClick={() => setViewMode('models')}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CaretLeft size={12} weight="bold" className="shrink-0" />
                    <span className="truncate">
                      {t('chatV2:modelPicker.t3.backToModels', { defaultValue: '返回模型' })}
                    </span>
                  </button>
                  <span className="text-muted-foreground/50">/</span>
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                    <SlidersHorizontal size={13} weight="bold" className="shrink-0 text-primary" />
                    <span className="truncate">
                      {t('common:chat_controls', { defaultValue: '对话控制' })}
                    </span>
                  </span>
                </div>
                {resolvedActiveModelHeading && (
                  <span
                    className="max-w-[9rem] shrink-0 truncate rounded bg-muted/70 px-1.5 py-0.5 text-2xs text-muted-foreground"
                    title={resolvedActiveModelHeading}
                  >
                    {resolvedActiveModelHeading}
                  </span>
                )}
              </div>

              {(isExternalCliEngine || Boolean(drilledCliOption)) && (
                <div className="shrink-0 border-b border-border/50 bg-muted/35 px-3 py-1.5 text-2xs text-muted-foreground">
                  {t('chatV2:modelPicker.t3.paramsCliNotice', {
                    defaultValue: '本地编程 CLI 使用自身采样策略，以下参数在切回内置模型时生效',
                  })}
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 select-text">
                {renderAdvancedPanel({
                  embedded: true,
                  onClose: () => setViewMode('models'),
                })}
              </div>
            </div>
          ) : (
            <>
          {/* 第二栏：搜索 + 模型 / CLI（含二级模型）列表（min-w-0 保证长文案永远省略号收敛） */}
          <div
            data-testid="t3-model-list-pane"
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
              !isCompactTier && 'border-r border-border/60',
            )}
          >
            {/* CLI 二级导航面包屑（原位切换，外框尺寸恒定） */}
            {drilledCliOption && (
              <div
                data-testid="t3-cli-drilldown-header"
                className="flex shrink-0 items-center gap-1.5 px-3 pt-2 pb-0.5 text-xs"
              >
                <button
                  type="button"
                  data-testid="t3-cli-drilldown-back"
                  onClick={() => {
                    setSearch('');
                    setDrilledCliAgentId(null);
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CaretLeft size={12} weight="bold" className="shrink-0" />
                  <span className="truncate">
                    {t('chatV2:modelPicker.t3.backToCliList', { defaultValue: '返回编程 CLI' })}
                  </span>
                </button>
                <span className="text-muted-foreground/50">/</span>
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                  {renderModelBrandIcon(drilledCliOption, 14)}
                  <span className="truncate">{drilledCliOption.label}</span>
                </span>
              </div>
            )}

            {/* 顶部无框下划线搜索框（固定不随列表滚动） */}
            <div className={cn('shrink-0 px-3 pb-1', drilledCliOption ? 'pt-1.5' : 'pt-2.5')}>
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
                  placeholder={searchPlaceholderText}
                  aria-label={searchPlaceholderText}
                  className="min-w-0 flex-1 bg-transparent text-ui leading-5 text-foreground placeholder:text-muted-foreground/75 outline-none [@media(pointer:coarse)]:text-base"
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

            {/* 模型 / CLI 二级滚动列表 */}
            <div
              role="menu"
              aria-label={t('chatV2:inputBar.runtimeModelTitle', { defaultValue: '模型' })}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 [mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent_100%)]"
            >
              {drilledCliOption ? (
                <div className="flex flex-col gap-0.5 pb-2.5">
                  {cliSubModelRows.map((row, index) => {
                    const drilledCliId = extractCliAgentId(drilledCliOption);
                    const isCurrentCli = currentCliSelection?.cliAgentId === drilledCliId;
                    const isSelectedRow =
                      isCurrentCli &&
                      (row.modelValue === null
                        ? !effectiveCliModel
                        : effectiveCliModel === row.modelValue);
                    const isHighlighted = index === highlightedIndex;
                    const shortcutLabel =
                      !isCompactTier && index < 9
                        ? isMacPlatform
                          ? `⌘${index + 1}`
                          : `^${index + 1}`
                        : null;

                    return (
                      <div
                        key={row.key}
                        className={cn(
                          'group relative flex h-8.5 min-h-[34px] w-full min-w-0 items-center rounded-lg text-left text-ui transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                          isMediumTier || isCompactTier ? 'gap-2 px-2' : 'gap-2.5 px-2.5',
                          isSelectedRow
                            ? 'bg-primary/12 font-medium text-foreground'
                            : isHighlighted
                              ? 'bg-muted/65 text-foreground'
                              : 'text-foreground hover:bg-muted/65',
                        )}
                        onMouseEnter={() => setHighlightedIndex(index)}
                      >
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelectedRow}
                          data-testid={
                            row.modelValue === null
                              ? `t3-cli-model-default-${drilledCliId}`
                              : row.isCustom
                                ? `t3-cli-model-custom-${drilledCliId}`
                                : `t3-cli-model-${drilledCliId}-${row.modelValue}`
                          }
                          disabled={disabled}
                          onClick={() => handlePickCliSubModel(row)}
                          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none"
                        >
                          {renderModelBrandIcon(drilledCliOption, 15)}
                          <span className="min-w-0 flex-1 truncate" title={row.label}>
                            {row.label}
                          </span>
                          {row.badge && (
                            <span className="max-w-[7.5rem] shrink-0 truncate rounded bg-muted px-1.5 py-px font-mono text-2xs font-normal text-muted-foreground">
                              {formatCompactCliModelName(row.badge)}
                            </span>
                          )}
                        </button>
                        {isSelectedRow ? (
                          <Check size={14} weight="bold" className="shrink-0 text-primary" />
                        ) : shortcutLabel ? (
                          <kbd
                            data-testid={`t3-model-shortcut-${index + 1}`}
                            className="pointer-events-none shrink-0 rounded bg-muted/90 px-1.5 py-0.5 font-mono text-2xs font-normal leading-none text-muted-foreground"
                          >
                            {shortcutLabel}
                          </kbd>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : sanitizedOptions.length === 0 && hasModelPanel && onOpenRuntimeModelPanel ? (
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
                    const cliItem = isCliOption(model);
                    const cliId = cliItem ? extractCliAgentId(model) : '';
                    const isCurrent =
                      !multiActive &&
                      (cliItem
                        ? currentCliSelection?.cliAgentId === cliId
                        : model.id === currentModelId);
                    const isChecked = multiActive && selectedIdSet.has(model.id);
                    const isFavorite = !cliItem && favoriteIds.has(model.id);
                    const isHighlighted = index === highlightedIndex;
                    const shortcutLabel =
                      !isCompactTier && index < 9
                        ? isMacPlatform
                          ? `⌘${index + 1}`
                          : `^${index + 1}`
                        : null;
                    const cliSubModelBadge =
                      cliItem && isCurrent && effectiveCliModel
                        ? formatCompactCliModelName(effectiveCliModel)
                        : cliItem && model.cliDefaultModel
                          ? formatCompactCliModelName(model.cliDefaultModel)
                          : null;

                    return (
                      <div
                        key={model.id}
                        className={cn(
                          'group relative flex h-8.5 min-h-[34px] w-full min-w-0 items-center rounded-lg text-left text-ui transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
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
                          data-testid={cliItem ? `t3-cli-agent-row-${cliId}` : undefined}
                          disabled={disabled}
                          onClick={() => handlePickRow(model)}
                          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none"
                        >
                          {renderModelBrandIcon(model, 16)}
                          <span className="min-w-0 flex-1 truncate" title={model.label}>
                            {model.label}
                          </span>
                          {cliSubModelBadge && (
                            <span className="max-w-[6.5rem] shrink-0 truncate rounded bg-muted/80 px-1.5 py-px font-mono text-2xs font-normal text-muted-foreground">
                              {cliSubModelBadge}
                            </span>
                          )}
                          {model.unavailable && (
                            <span className="shrink-0 rounded border border-border/80 bg-background/70 px-1 py-px text-2xs font-normal leading-tight text-muted-foreground">
                              {t('chatV2:modelPicker.t3.unavailable', { defaultValue: '不可用' })}
                            </span>
                          )}
                          {cliItem && effectiveTier === 'wide' && (
                            <span className="shrink-0 rounded bg-muted px-1 py-px text-2xs font-medium text-muted-foreground">
                              {t('agentMesh:picker.cliBadge', { defaultValue: 'CLI' })}
                            </span>
                          )}
                        </button>

                        {!cliItem && (
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
                        ) : cliItem ? (
                          <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                            {shortcutLabel && (
                              <kbd
                                data-testid={`t3-model-shortcut-${index + 1}`}
                                className="pointer-events-none shrink-0 rounded bg-muted/90 px-1.5 py-0.5 font-mono text-2xs font-normal leading-none text-muted-foreground"
                              >
                                {shortcutLabel}
                              </kbd>
                            )}
                            <CaretRight size={12} weight="bold" className="shrink-0 opacity-70" />
                          </span>
                        ) : shortcutLabel ? (
                          <kbd
                            data-testid={`t3-model-shortcut-${index + 1}`}
                            className="pointer-events-none shrink-0 rounded bg-muted/90 px-1.5 py-0.5 font-mono text-2xs font-normal leading-none text-muted-foreground"
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
            </>
          )}
        </div>

        {/* 窄屏 / 移动端紧凑推理强度单行横条（仅模型选择视图展示） */}
        {isCompactTier && viewMode === 'models' && (
          <div
            data-testid="t3-reasoning-pane-mobile"
            className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5"
          >
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {t('chatV2:inputBar.thinkingDepthTitle', { defaultValue: '推理强度' })}
            </span>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none">
              {activeCliForReasoning ? (
                cliReasoningLevels.length === 0 ? (
                  <span
                    data-testid="t3-reasoning-empty"
                    className="truncate text-xs text-muted-foreground"
                  >
                    {t('chatV2:modelPicker.t3.noReasoningEffort', {
                      defaultValue: '没有可选的推理强度',
                    })}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={!effectiveCliEffort}
                      onClick={() => handleSetCliEffort(null)}
                      className={cn(
                        'shrink-0 rounded-md px-2 py-1 text-xs transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                        !effectiveCliEffort
                          ? 'bg-primary/15 font-medium text-primary'
                          : 'bg-muted/60 text-muted-foreground',
                      )}
                    >
                      {t('chatV2:modelPicker.t3.cliEffortDefault', { defaultValue: '默认' })}
                    </button>
                    {cliReasoningLevels.map((level) => {
                      const isSelected = effectiveCliEffort === level;
                      return (
                        <button
                          key={level}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onClick={() => handleSetCliEffort(level)}
                          className={cn(
                            'shrink-0 rounded-md px-2 py-1 text-xs transition-colors [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                            isSelected
                              ? 'bg-primary/15 font-medium text-primary'
                              : 'bg-muted/60 text-muted-foreground',
                          )}
                        >
                          {resolveCliEffortLabel(level)}
                        </button>
                      );
                    })}
                  </>
                )
              ) : !hasDepthOptions && !hasBinaryToggle ? (
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

        {/* 底部运行时控制通栏：左侧「联网 / 多选 / 参数」+ 右侧「权限档位」 */}
        <div
          data-testid="t3-picker-footer"
          className="relative flex shrink-0 items-center justify-between gap-1.5 border-t border-border/60 bg-popover px-2.5 py-1.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none">
            {onWebSearchEnabledChange && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={Boolean(webSearchEnabled)}
                data-testid="t3-footer-web-search"
                title={
                  isExternalCliEngine || Boolean(drilledCliOption)
                    ? t('chatV2:modelPicker.t3.webSearchCliHint', {
                        defaultValue: '本地编程 CLI 使用自身工具链，此开关仅对内置对话模型生效',
                      })
                    : t('chatV2:inputBar.plusMenu.webSearchHint', {
                        defaultValue: '联网搜索',
                      })
                }
                onClick={() => void onWebSearchEnabledChange(!webSearchEnabled)}
                className={cn(
                  'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                  webSearchEnabled && !isExternalCliEngine && !drilledCliOption
                    ? 'bg-primary/12 font-medium text-primary'
                    : webSearchEnabled
                      ? 'bg-muted/60 text-muted-foreground hover:bg-muted/80'
                      : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                )}
              >
                <Globe
                  size={13}
                  weight={webSearchEnabled && !isExternalCliEngine && !drilledCliOption ? 'fill' : 'regular'}
                  className="shrink-0"
                />
                <span className="truncate">
                  {t('chatV2:modelPicker.t3.webSearchShort', { defaultValue: '联网' })}
                </span>
              </button>
            )}

            {multiSelect && viewMode === 'models' && !drilledCliOption && sanitizedOptions.some((o) => !isCliOption(o)) && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={multiActive}
                data-testid="runtime-model-multi-select-switch"
                onClick={() => multiSelect.onActiveChange(!multiActive)}
                className={cn(
                  'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                  multiActive
                    ? 'bg-primary/12 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                )}
              >
                <SquaresFour size={13} weight={multiActive ? 'fill' : 'regular'} className="shrink-0" />
                <span className="truncate">
                  {effectiveTier === 'wide'
                    ? t('chatV2:inputBar.runtimeModelCompareMode', { defaultValue: '多选模式' })
                    : t('chatV2:modelPicker.t3.multiSelectShort', { defaultValue: '多选' })}
                </span>
                {multiActive && multiSelect.selectedIds.length > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-px font-mono text-2xs text-primary-foreground">
                    {multiSelect.selectedIds.length}
                  </span>
                )}
              </button>
            )}

            {(renderAdvancedPanel || onOpenAdvancedPanel) && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={viewMode === 'params'}
                data-testid="t3-footer-advanced"
                title={t('common:chat_controls', { defaultValue: '对话控制' })}
                onClick={() => {
                  if (renderAdvancedPanel) {
                    setViewMode((prev) => (prev === 'params' ? 'models' : 'params'));
                    return;
                  }
                  onRequestClose?.();
                  onOpenAdvancedPanel?.();
                }}
                className={cn(
                  'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                  viewMode === 'params'
                    ? 'bg-primary/12 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                )}
              >
                <SlidersHorizontal
                  size={13}
                  weight={viewMode === 'params' ? 'fill' : 'regular'}
                  className="shrink-0"
                />
                <span className="truncate">
                  {t('chatV2:modelPicker.t3.paramsShort', { defaultValue: '参数' })}
                </span>
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
                      title={t(`chatV2:authority.permissionPreset.hints.${preset}`, {
                        defaultValue: '',
                      })}
                      onClick={() => handleSelectPermissionPreset(preset)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/70 [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
                        isSelected
                          ? 'bg-primary/12 font-medium text-primary'
                          : preset === 'danger_full_access'
                            ? 'text-destructive'
                            : 'text-foreground',
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
        confirmVariant="danger"
        title={t('chatV2:authority.permissionPreset.dangerConfirmTitle')}
        description={t('chatV2:authority.permissionPreset.dangerConfirmDescription')}
        cancelText={t('common:actions.cancel')}
        confirmText={t('chatV2:authority.permissionPreset.dangerConfirmAction')}
        onConfirm={() => {
          setConfirmDangerOpen(false);
          void applyPermissionPreset('danger_full_access', true);
        }}
      />
    </>
  );
};

export default T3ModelSelectorPopover;
