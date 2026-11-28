/**
 * Composer 底部工具栏（从 InputBarUI.tsx 拆出）
 *
 * 左侧：加号菜单（附件/技能/MCP/对话控制）+ 宿主插槽 + 快捷键提示；
 * 右侧：上下文水位环、T3 Code 风格模型与推理强度胶囊选择器、媒体处理指示、
 * 工具插槽与发送/停止按钮。
 *
 * 纯展示组件：交互副作用（面板互斥、发送、停止）全部通过回调上抛。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowUp,
  Square,
  Lightning,
  CircleNotch,
  TerminalWindow,
} from '@phosphor-icons/react';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { TextSwap } from '@/components/ui/TextSwap';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
} from '@/components/ui/app-menu/AppMenu';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { detectProviderBrand, type ProviderBrand } from '@/utils/providerIconEngine';
import type { ContextWindowUsage } from './contextWindowUsage';
import { formatContextTokenAmount } from './contextWindowUsage';
import type { ContextCompactionInfo } from './contextCompactionInfo';
import type { SessionUsageSummary } from '@/api/llmUsageApi';
import type { PermissionPreset } from '../../core/types/store';
import type { ReasoningLevelOption, ReasoningLevel } from '@/utils/reasoning';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import {
  CLI_ENGINE_ID_PREFIX,
  type RuntimeModelMultiSelectConfig,
  type RuntimeModelOption,
} from './RuntimeModelSubmenuBody';
import type { T3PopoverLayoutTier } from './T3ModelSelectorPopover';
import { ContextUsagePopover } from './ContextUsagePopover';
import {
  resolveContextUsageLevel,
  type ContextUsageLevel,
} from '../ContextUsageRing';

const LazyT3ModelSelectorPopover = React.lazy(() => import('./T3ModelSelectorPopover'));

const TRIGGER_MONO_CURRENT_COLOR_BRANDS: ReadonlySet<ProviderBrand> = new Set<ProviderBrand>([
  'openai',
  'opencode',
  'xai',
  'ollama',
  'mimo',
  'baai',
  'pika',
  'flux',
  'ideogram',
  'midjourney',
  'runway',
  'replicate',
  'suno',
]);

function resolveTriggerCliBrandIconId(rawId?: string | null): string {
  const normalized = (rawId ?? '')
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

interface T3PopoverLayoutState {
  width: number;
  height: number;
  tier: T3PopoverLayoutTier;
}

/**
 * 按当前聊天列宽度与触发器上下安全净空计算锁定的弹窗尺寸与断点档位：
 * - 宽度绑定聊天列宽度（避让左侧边栏与右侧分屏工作台），打开期间切换供应商宽度恒定不闪烁；
 * - 高度预留桌面端顶部标题栏（52px）与窗口底边安全边距，空会话居中输入框同样完整展示不裁切。
 */
function computeT3PopoverLayout(
  triggerEl: HTMLElement | null,
  isMobile: boolean,
): T3PopoverLayoutState {
  if (typeof window === 'undefined') {
    return {
      width: isMobile ? 356 : 568,
      height: 360,
      tier: isMobile ? 'compact' : 'wide',
    };
  }

  const vv = window.visualViewport;
  const viewportWidth = vv?.width && vv.width > 0 ? vv.width : window.innerWidth || 1024;
  const viewportHeight = vv?.height && vv.height > 0 ? vv.height : window.innerHeight || 768;

  const chatPaneEl = (triggerEl?.closest('main') ??
    triggerEl?.closest('.unified-input-docked')) as HTMLElement | null;
  const paneRect = chatPaneEl?.getBoundingClientRect();
  const paneWidth =
    paneRect && paneRect.width > 0 ? paneRect.width : viewportWidth;
  const triggerRect = triggerEl?.getBoundingClientRect();

  // align="end" 下浮层右边缘对齐触发器右边缘：左界不得越过聊天列左边缘（避免压住左侧导航栏）
  const rightAnchoredSpan =
    triggerRect && triggerRect.right > 0 && paneRect && paneRect.width > 0
      ? Math.floor(triggerRect.right - paneRect.left - 12)
      : paneWidth - 16;

  const maxAllowedWidth = Math.max(
    268,
    Math.floor(
      Math.min(
        viewportWidth - 16,
        paneWidth - 16,
        rightAnchoredSpan > 240 ? rightAnchoredSpan : paneWidth - 16,
      ),
    ),
  );

  let tier: T3PopoverLayoutTier;
  let width: number;
  if (!isMobile && maxAllowedWidth >= 510) {
    tier = 'wide';
    width = Math.min(568, maxAllowedWidth);
  } else if (!isMobile && maxAllowedWidth >= 388) {
    tier = 'medium';
    width = maxAllowedWidth;
  } else {
    tier = 'compact';
    width = Math.min(392, maxAllowedWidth);
  }

  const idealHeight = tier === 'compact' ? 364 : 356;
  let height = idealHeight;

  if (triggerRect && (triggerRect.width > 0 || triggerRect.height > 0 || triggerRect.top > 0)) {
    const safeTop = isMobile ? 12 : 52;
    const safeBottom = 12;
    const appMenuGap = 6;
    const usableAbove = Math.floor(triggerRect.top - appMenuGap - safeTop);
    const usableBelow = Math.floor(viewportHeight - safeBottom - (triggerRect.bottom + appMenuGap));
    const bestVerticalSpace = Math.max(usableAbove, usableBelow);
    if (bestVerticalSpace > 0) {
      height = Math.max(176, Math.min(idealHeight, bestVerticalSpace));
    }
  }

  return { width, height, tier };
}

// ============================================================================
// 样式常量（P1-3 触控目标：图标视觉尺寸不变，coarse pointer 下控件本体撑成
// ≥44×44 实体 flex box（--touch-target-size），命中区即盒模型，不再用透明
// after:-inset 伪元素外扩——伪元素会越过 gap 与相邻控件的命中区互相重叠）
// ============================================================================

const coarseSolidTouchTargetClass =
  'native-touch-target [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]';
// 宽度由内容决定的触发器（带文字标签）只抬高度，避免 min-w 干扰 truncate
const coarseSolidTouchHeightClass = 'native-touch-target [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';
const iconButtonClass = cn(
  'inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-shell-control)] text-[color:var(--button-utility-foreground)] transition-colors hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)] active:bg-[color:var(--button-utility-active)]',
  coarseSolidTouchTargetClass
);
const studyUiButtonBaseClassName =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-ui font-medium leading-none tracking-[0.01em] transition-[background-color,border-color,color,box-shadow] duration-150 ease-out outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';
const studyUiButtonSizeIconClassName =
  'h-[var(--button-icon-size)] w-[var(--button-icon-size)] rounded-[var(--button-radius)]';
const studyUiSendButtonSizeClass =
  'native-touch-target h-11 w-11 !rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)] [@media(pointer:coarse)]:!h-[var(--touch-target-size)] [@media(pointer:coarse)]:!w-[var(--touch-target-size)]';
const studyUiBlackActionButtonClass =
  '!border-foreground !bg-foreground hover:!bg-foreground/90 active:!bg-foreground/85 !text-background';
const studyUiSendButtonEmptyStateClass =
  '!border-transparent !bg-muted !text-muted-foreground hover:!bg-muted/80 active:!bg-muted/70';

// ============================================================================
// 内部展示组件
// ============================================================================

function getCompactThinkingLabel(label?: string): string | undefined {
  const compact = label?.replace(/^(推理|Reasoning)\s*[:：]\s*/i, '').trim();
  return compact || label;
}

function ResizingThinkingLabel({ text }: { text: string }) {
  const measureRef = useRef<HTMLSpanElement>(null);
  const [labelWidth, setLabelWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const width = Math.ceil(measureRef.current?.getBoundingClientRect().width ?? 0);
    if (width > 0) setLabelWidth(width);
  }, [text]);

  return (
    <span
      data-testid="thinking-runtime-state-label"
      className="relative inline-block max-w-[7.5rem] sm:max-w-[10.5rem] overflow-hidden text-ellipsis whitespace-nowrap text-left font-medium text-[color:var(--text-primary)]"
    >
      <span
        className="t-resize inline-block whitespace-nowrap"
        style={labelWidth ? { width: labelWidth } : undefined}
      >
        <TextSwap text={text} />
      </span>
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
      >
        {text}
      </span>
    </span>
  );
}

function ContextWindowUsageRing({
  usage,
  t,
  disabled,
}: {
  usage: ContextWindowUsage;
  t: TFunction;
  disabled: boolean;
}) {
  const ratio =
    usage.limitTokens > 0
      ? usage.usedTokens / usage.limitTokens
      : usage.usedPercent / 100;
  const usageLevel: ContextUsageLevel = resolveContextUsageLevel(ratio);
  // ★ 1.2 水位分级警示：对齐 ContextUsageRing 三档阈值（ratio > 0.9 danger, ratio > 0.7 warn, 其余 normal；
  //   兼容旧锚点 usage.usedPercent >= 90 / usage.usedPercent >= 75）
  const contextUsageColor =
    usageLevel === 'danger'
      ? 'hsl(var(--danger))'
      : usageLevel === 'warn'
        ? 'hsl(var(--warning))'
        : 'var(--text-primary)';
  const ringRadius = 6.75;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringProgressOffset = ringCircumference * (1 - Math.min(1, Math.max(0, ratio)));
  // hover 只回答"还剩多少"：一行摘要。明细（进度条 / 上限 / 会话累计 /
  // 压缩状态 / 压缩动作）由点击后的 ContextUsagePopover 独占——两处不再
  // 各画一份同构卡片，避免以后改一处漏一处。
  // 内容层用 --tooltip-* 族：tooltip 外壳是反色的，页面语义 token
  // （--text-secondary / --button-utility-hover）落上去会掉到 ~2:1 对比度。
  // 不加 whitespace-nowrap：--font-size-scale 调大时这一行会超过 CommonTooltip
  // 的 300px maxWidth，不可换行就被裁掉；允许换行则退化成两行而不是丢内容。
  const tooltipContent = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[color:var(--tooltip-text-secondary)]">
        {t('chatV2:tokenUsage.contextWindow')}
      </span>
      <span className="font-mono tabular-nums text-[color:var(--tooltip-foreground)]">
        {usage.usedLabel}
        <span className="text-[color:var(--tooltip-text-muted)]">
          {' / '}
          {formatContextTokenAmount(usage.limitTokens)}
        </span>
      </span>
      <span
        data-testid="context-window-usage-hover-percent"
        className="rounded-full border border-[color:var(--tooltip-chip-border)] bg-[color:var(--tooltip-chip-surface)] px-1.5 py-0.5 font-mono text-2xs leading-none tabular-nums text-[color:var(--tooltip-text-secondary)]"
      >
        {usage.usedPercent}%
      </span>
      <span className="text-[color:var(--tooltip-text-muted)]">
        {t('chatV2:contextUsagePopover.viewDetails')}
      </span>
    </div>
  );

  return (
    <CommonTooltip content={tooltipContent} position="top" disabled={disabled}>
      {/* 纯视觉内层：焦点/aria-label/aria-haspopup 与 44×44 实体命中区
          统一由 ContextUsagePopover 的 button 触发器承担，内环不再自带
          tabIndex 与 after:-inset 伪元素命中区（避免与外层触发器双重重叠） */}
      <span
        data-testid="context-window-usage-control"
        data-usage-level={usageLevel}
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-md',
          usageLevel === 'danger'
            ? 'text-destructive'
            : usageLevel === 'warn'
              ? 'text-warning'
              : 'text-[color:var(--text-secondary)]',
        )}
      >
        <svg
          data-testid="context-window-usage-ring"
          data-usage-level={usageLevel}
          className="h-4 w-4 rounded-full"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r={ringRadius}
            stroke="var(--button-utility-hover)"
            strokeWidth="2.5"
          />
          <circle
            cx="8"
            cy="8"
            r={ringRadius}
            stroke={contextUsageColor}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringProgressOffset}
            transform="rotate(-90 8 8)"
            style={{ opacity: ratio > 0 || usage.usedPercent > 0 ? 1 : 0 }}
          />
        </svg>
      </span>
    </CommonTooltip>
  );
}

// ============================================================================
// Props
// ============================================================================

export interface ComposerToolbarProps {
  isMobile: boolean;
  isMobileEnv: boolean;
  isStreaming: boolean;
  sessionId?: string;

  // ── 加号菜单 ──
  isPlusMenuOpen: boolean;
  onPlusMenuOpenChange: (open: boolean) => void;
  attachmentCount: number;
  onAddAttachment: () => void;
  onOpenResourceLibrary: () => void;
  onOpenCamera: () => void;
  onOpenSkillPanel?: () => void;
  onCompactContext?: () => void | Promise<void>;
  isCompactingContext: boolean;
  compactContextStatus: 'success' | 'not-needed' | 'skipped' | 'error' | null;
  authorityMode?: string;
  authorityAskBlockedHint?: boolean;
  permissionPreset: PermissionPreset;
  onPermissionPresetChange?: (
    preset: PermissionPreset,
    confirm?: boolean,
  ) => void | Promise<void>;
  knowledgeBaseProactive: boolean;
  onKnowledgeBaseProactiveChange?: (enabled: boolean) => void | Promise<void>;
  ragEnabled?: boolean;
  onRagEnabledChange?: (enabled: boolean) => void | Promise<void>;
  webSearchEnabled?: boolean;
  onWebSearchEnabledChange?: (enabled: boolean) => void | Promise<void>;
  renderSkillPanelMenuVariant?: () => React.ReactNode;
  activeSkillCount: number;
  hasLoadedSkills: boolean;
  renderMcpPanel?: () => React.ReactNode;
  onOpenMcpPanel?: () => void;
  selectedMcpServerCount: number;
  renderAdvancedPanel?: (options?: { embedded?: boolean; onClose?: () => void }) => React.ReactNode;
  advancedPanelRequested?: boolean;
  onConsumeAdvancedPanelRequest?: () => void;
  onOpenAdvancedPanel?: () => void;
  pluginWorkshopActive?: boolean;
  onTogglePluginWorkshop?: () => void | Promise<void>;

  // ── 宿主插槽 ──
  leftAccessory?: React.ReactNode;
  extraButtonsRight?: React.ReactNode;
  /** 已合成的工具插槽（宿主 inputToolSlot + 语音输入） */
  inputToolSlot?: React.ReactNode;

  // ── 快捷键提示 ──
  sendShortcut: 'enter' | 'mod-enter';
  isComposerEmpty: boolean;
  composerTextareaFocused: boolean;

  // ── 上下文水位 ──
  contextWindowUsage?: ContextWindowUsage | null;
  sessionUsage?: SessionUsageSummary | null;
  getCompactionInfo?: () => ContextCompactionInfo | null;

  // ── 推理强度 / 运行时模型 ──
  /** 父级持有：模型面板 overlay 需要以触发器为锚点 */
  runtimeModelTriggerRef: React.MutableRefObject<HTMLSpanElement | null>;
  onToggleThinking?: () => void;
  enableThinking?: boolean;
  thinkingUnsupported?: boolean;
  thinkingCanDisable: boolean;
  thinkingStateLabel?: string;
  thinkingDepthOptions?: ReasoningLevelOption[];
  thinkingDepthValue?: ReasoningLevel;
  onSetThinkingDepth?: (value: ReasoningLevel | 'off') => void;
  runtimeModelLabel?: string;
  runtimeModelProviderLabel?: string;
  runtimeModelIconId?: string;
  runtimeCurrentModelId?: string | null;
  runtimeModelUnavailable?: boolean;
  runtimeModelOptions: RuntimeModelOption[];
  /** runtime 子菜单内的多选（并行回答）配置；不提供则隐藏多选开关 */
  runtimeModelMultiSelect?: RuntimeModelMultiSelectConfig;
  onSelectRuntimeModel?: (modelId: string) => void;
  /** 是否存在模型选择面板（决定运行时模型菜单是否可用） */
  hasModelPanel: boolean;
  onOpenRuntimeModelPanel: (mode?: 'single' | 'compare') => void;
  /** 推理菜单打开前的父级副作用（关加号菜单/面板/@mention 补全） */
  onThinkingMenuWillOpen: () => void;

  // ── 媒体处理中指示 ──
  hasProcessingMedia: boolean;
  processingIndicatorLabel?: string;

  // ── 发送/停止 ──
  showStop: boolean;
  canAbort: boolean;
  onStop: () => void;
  onSend: () => void;
  disabledSend: boolean;
  sendBlockedReason?: string;
}

// ============================================================================
// 主组件
// ============================================================================

export const ComposerToolbar: React.FC<ComposerToolbarProps> = ({
  isMobile,
  isMobileEnv,
  isStreaming,
  sessionId,
  isPlusMenuOpen,
  onPlusMenuOpenChange,
  attachmentCount,
  onAddAttachment,
  onOpenResourceLibrary,
  onOpenCamera,
  onOpenSkillPanel,
  onCompactContext,
  isCompactingContext,
  compactContextStatus,
  permissionPreset,
  onPermissionPresetChange,
  knowledgeBaseProactive,
  onKnowledgeBaseProactiveChange,
  ragEnabled,
  onRagEnabledChange,
  webSearchEnabled,
  onWebSearchEnabledChange,
  renderSkillPanelMenuVariant,
  activeSkillCount,
  hasLoadedSkills,
  renderMcpPanel,
  onOpenMcpPanel,
  selectedMcpServerCount,
  renderAdvancedPanel,
  advancedPanelRequested = false,
  onConsumeAdvancedPanelRequest,
  onOpenAdvancedPanel,
  pluginWorkshopActive,
  onTogglePluginWorkshop,
  leftAccessory,
  extraButtonsRight,
  inputToolSlot,
  sendShortcut,
  isComposerEmpty,
  composerTextareaFocused,
  contextWindowUsage,
  sessionUsage,
  getCompactionInfo,
  runtimeModelTriggerRef,
  onToggleThinking,
  enableThinking,
  thinkingUnsupported,
  thinkingCanDisable,
  thinkingStateLabel,
  thinkingDepthOptions,
  thinkingDepthValue,
  onSetThinkingDepth,
  runtimeModelLabel,
  runtimeModelProviderLabel,
  runtimeModelIconId,
  runtimeCurrentModelId,
  runtimeModelUnavailable = false,
  runtimeModelOptions: rawRuntimeModelOptions,
  onSelectRuntimeModel,
  runtimeModelMultiSelect,
  hasModelPanel,
  onOpenRuntimeModelPanel,
  onThinkingMenuWillOpen,
  hasProcessingMedia,
  processingIndicatorLabel,
  showStop,
  canAbort,
  onStop,
  onSend,
  disabledSend,
  sendBlockedReason,
}) => {
  const { t } = useTranslation(['analysis', 'common', 'chatV2', 'settings', 'agentMesh']);

  const tooltipPosition = 'top' as const;
  // 🔧 移动端禁用 tooltip（触摸设备没有 hover 交互，tooltip 会干扰）
  const tooltipDisabled = isMobile;
  const studyUiSendButtonAriaLabel = t('chatV2:inputBar.sendMessage');

  // ── 推理/模型选择器派生值（T3 Code 胶囊风格） ──
  const isExternalCliEngine = Boolean(runtimeCurrentModelId?.startsWith(CLI_ENGINE_ID_PREFIX));
  const compactThinkingStateLabel = getCompactThinkingLabel(thinkingStateLabel);
  const resolveThinkingDepthLabel = useCallback(
    (option: ReasoningLevelOption) => t(option.labelKey, option.defaultLabel),
    [t]
  );
  const selectedThinkingDepthOption =
    !isExternalCliEngine && !thinkingUnsupported && enableThinking && thinkingDepthValue && thinkingDepthOptions?.length
      ? thinkingDepthOptions.find((o) => o.value === thinkingDepthValue)
      : undefined;
  const resolvedThinkingTriggerLabel = selectedThinkingDepthOption
    ? resolveThinkingDepthLabel(selectedThinkingDepthOption)
    : compactThinkingStateLabel;
  const runtimeModelTitle = t('chatV2:inputBar.runtimeModelTitle');
  const runtimeModelAccessibleCurrent = runtimeModelLabel
    ? runtimeModelProviderLabel
      ? `${runtimeModelProviderLabel} / ${runtimeModelLabel}`
      : runtimeModelLabel
    : undefined;
  const thinkingRuntimeTitle = [
    runtimeModelAccessibleCurrent ? `${runtimeModelTitle}: ${runtimeModelAccessibleCurrent}` : undefined,
    isExternalCliEngine ? undefined : thinkingStateLabel,
  ].filter(Boolean).join(' · ') || thinkingStateLabel;
  const hasThinkingDepthMenu = !!(
    !isExternalCliEngine &&
    !thinkingUnsupported &&
    compactThinkingStateLabel &&
    onSetThinkingDepth &&
    thinkingDepthOptions &&
    thinkingDepthOptions.length > 0
  );
  const hasThinkingUnsupportedMenu = !!(!isExternalCliEngine && compactThinkingStateLabel && thinkingUnsupported);
  const runtimeModelOptions = useMemo(
    () => rawRuntimeModelOptions.filter((option) => (option.id ?? '').trim() !== '' && (option.label ?? '').trim() !== ''),
    [rawRuntimeModelOptions]
  );
  const hasRuntimeModelMenu = runtimeModelOptions.length > 0 || hasModelPanel;
  const hasThinkingToggleMenu = !!(
    !isExternalCliEngine &&
    !thinkingUnsupported &&
    compactThinkingStateLabel &&
    (onSetThinkingDepth || onToggleThinking)
  );
  const hasThinkingRuntimeMenu =
    hasThinkingDepthMenu ||
    hasThinkingToggleMenu ||
    hasThinkingUnsupportedMenu ||
    hasRuntimeModelMenu ||
    isExternalCliEngine;

  // T3 Code 胶囊优先展示模型 / 编程 CLI 名称；未传模型名称时平滑退回推理档位文案
  const thinkingRuntimeTriggerLabel =
    runtimeModelLabel || resolvedThinkingTriggerLabel || runtimeModelTitle;

  const resolvedTriggerBrandIconId = useMemo(() => {
    if (isExternalCliEngine) {
      return resolveTriggerCliBrandIconId(runtimeCurrentModelId || runtimeModelLabel);
    }
    return runtimeModelIconId || runtimeModelLabel || '';
  }, [isExternalCliEngine, runtimeCurrentModelId, runtimeModelIconId, runtimeModelLabel]);

  const resolvedTriggerBrand = useMemo(
    () => (resolvedTriggerBrandIconId ? detectProviderBrand(resolvedTriggerBrandIconId) : 'generic'),
    [resolvedTriggerBrandIconId]
  );
  const triggerUsesMonoBrand =
    resolvedTriggerBrand === 'anthropic' || TRIGGER_MONO_CURRENT_COLOR_BRANDS.has(resolvedTriggerBrand);

  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelMenuInitialView, setModelMenuInitialView] = useState<'models' | 'params'>('models');
  const [confirmDangerOpen, setConfirmDangerOpen] = useState(false);
  const [dangerConfirmSyncing, setDangerConfirmSyncing] = useState(false);
  const [popoverLayout, setPopoverLayout] = useState<T3PopoverLayoutState>(() =>
    computeT3PopoverLayout(null, isMobile)
  );

  const handleRequestDangerConfirm = useCallback(() => {
    setIsModelMenuOpen(false);
    setConfirmDangerOpen(true);
  }, []);

  const handleConfirmDangerPreset = useCallback(async () => {
    if (!onPermissionPresetChange || dangerConfirmSyncing) {
      setConfirmDangerOpen(false);
      return;
    }
    setDangerConfirmSyncing(true);
    setConfirmDangerOpen(false);
    try {
      await onPermissionPresetChange('danger_full_access', true);
    } finally {
      setDangerConfirmSyncing(false);
    }
  }, [dangerConfirmSyncing, onPermissionPresetChange]);

  const syncPopoverLayout = useCallback(() => {
    const next = computeT3PopoverLayout(runtimeModelTriggerRef.current, isMobile);
    setPopoverLayout((prev) =>
      prev.width === next.width && prev.height === next.height && prev.tier === next.tier
        ? prev
        : next
    );
  }, [isMobile, runtimeModelTriggerRef]);

  const handleThinkingRuntimeMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      syncPopoverLayout();
      onThinkingMenuWillOpen();
    } else {
      setModelMenuInitialView('models');
    }
    setIsModelMenuOpen(open);
  }, [onThinkingMenuWillOpen, syncPopoverLayout]);

  // 接管外部触发的对话参数请求（如快捷键 ⌘⇧K），直接展开模型选择器并原位切入「参数」视图，不再弹出独立面板
  useEffect(() => {
    if (!advancedPanelRequested || !hasThinkingRuntimeMenu || !renderAdvancedPanel) return;
    onConsumeAdvancedPanelRequest?.();
    syncPopoverLayout();
    onThinkingMenuWillOpen();
    setModelMenuInitialView('params');
    setIsModelMenuOpen(true);
  }, [
    advancedPanelRequested,
    hasThinkingRuntimeMenu,
    onConsumeAdvancedPanelRequest,
    onThinkingMenuWillOpen,
    renderAdvancedPanel,
    syncPopoverLayout,
  ]);

  // 菜单展开期间监听窗口与聊天列容器尺寸变化（分屏开合 / 侧栏折叠 / 窗口拖拽），实时收敛自适应宽度与净空高度
  useEffect(() => {
    if (!isModelMenuOpen || typeof window === 'undefined') return undefined;
    syncPopoverLayout();

    const handleResize = () => syncPopoverLayout();
    window.addEventListener('resize', handleResize, { passive: true });
    window.visualViewport?.addEventListener('resize', handleResize, { passive: true });

    const chatPaneEl = runtimeModelTriggerRef.current?.closest('.unified-input-docked') as HTMLElement | null;
    const ro =
      typeof ResizeObserver !== 'undefined' && chatPaneEl
        ? new ResizeObserver(handleResize)
        : null;
    if (chatPaneEl && ro) ro.observe(chatPaneEl);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('resize', handleResize);
      ro?.disconnect();
    };
  }, [isModelMenuOpen, runtimeModelTriggerRef, syncPopoverLayout]);

  return (
    <div className="flex items-center justify-between gap-2">
      {/* 左侧按钮 - 窄屏时可横向滚动 */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-2 scrollbar-none">
        {/* 加号菜单：附件 / 模式 / 技能 / 连接器（AppMenu 次级飞出） */}
        <ComposerPlusMenu
          open={isPlusMenuOpen}
          onOpenChange={onPlusMenuOpenChange}
          attachmentCount={attachmentCount}
          iconButtonClass={iconButtonClass}
          tooltipPosition={tooltipPosition}
          tooltipDisabled={tooltipDisabled}
          isMobile={isMobile}
          isMobileEnv={isMobileEnv}
          onAddAttachment={onAddAttachment}
          onOpenResourceLibrary={onOpenResourceLibrary}
          onOpenCamera={onOpenCamera}
          onOpenSkillPanel={onOpenSkillPanel}
          onCompactContext={onCompactContext}
          isCompactingContext={isCompactingContext}
          compactContextStatus={compactContextStatus}
          compactContextDisabled={isStreaming}
          sessionId={sessionId}
          permissionPreset={permissionPreset}
          onPermissionPresetChange={onPermissionPresetChange}
          knowledgeBaseProactive={knowledgeBaseProactive}
          onKnowledgeBaseProactiveChange={onKnowledgeBaseProactiveChange}
          ragEnabled={ragEnabled}
          onRagEnabledChange={onRagEnabledChange}
          webSearchEnabled={webSearchEnabled}
          onWebSearchEnabledChange={onWebSearchEnabledChange}
          renderSkillPanel={renderSkillPanelMenuVariant}
          activeSkillCount={activeSkillCount}
          hasLoadedSkills={hasLoadedSkills}
          renderMcpPanel={renderMcpPanel}
          onOpenMcpPanel={onOpenMcpPanel}
          selectedMcpServerCount={selectedMcpServerCount}
          onOpenAdvancedPanel={onOpenAdvancedPanel}
          pluginWorkshopActive={pluginWorkshopActive}
          onTogglePluginWorkshop={onTogglePluginWorkshop}
        />

        {leftAccessory}

        {/* 快捷键提示（对齐旧版 InputBar）：桌面 Enter 发送模式下，
            输入框聚焦且为空时在工具行空白区展示，不占额外行、不产生布局抖动 */}
        {!isMobile &&
          (sendShortcut || 'enter') === 'enter' &&
          isComposerEmpty &&
          composerTextareaFocused && (
            <span className="pointer-events-none ml-auto shrink-0 select-none whitespace-nowrap pl-2 text-2xs text-muted-foreground/60">
              {t('chatV2:inputBar.shortcut')}
            </span>
          )}

      </div>

      {/* 右侧按钮 - 固定不滚动 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {extraButtonsRight}

        {contextWindowUsage && (
          /* ★ 点击水位环展开用量明细弹层（逻辑在 ContextUsagePopover，这里只挂载） */
          <ContextUsagePopover
            usage={contextWindowUsage}
            sessionUsage={sessionUsage}
            onCompactContext={onCompactContext}
            isCompactingContext={isCompactingContext}
            compactDisabled={isStreaming}
            getCompactionInfo={getCompactionInfo}
          >
            <ContextWindowUsageRing
              usage={contextWindowUsage}
              t={t}
              disabled={tooltipDisabled}
            />
          </ContextUsagePopover>
        )}

        {/* T3 Code 风格模型与推理强度触发胶囊 */}
        {(onToggleThinking || hasRuntimeModelMenu || isExternalCliEngine) && (
          <span
            ref={runtimeModelTriggerRef}
            className={cn(
              'relative inline-flex h-8 min-w-0 max-w-[11rem] sm:max-w-[15rem] shrink-0 items-center rounded-[var(--radius-shell-control)] text-xs font-medium leading-none',
              // coarse 下外壳随内部触发器抬到 44 高，避免子元素纵向溢出行盒
              coarseSolidTouchHeightClass,
              'text-[color:var(--text-primary)]'
            )}
            data-testid="thinking-runtime-control"
            data-reasoning-effort={
              isExternalCliEngine || !enableThinking || thinkingUnsupported
                ? 'none'
                : (thinkingDepthValue ?? 'medium')
            }
          >
            {hasThinkingRuntimeMenu ? (
              <AppMenu open={isModelMenuOpen} onOpenChange={handleThinkingRuntimeMenuOpenChange}>
                <AppMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="thinking-runtime-menu-trigger"
                    className={cn(
                      'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-[var(--radius-shell-control)] bg-muted/65 px-2.5 text-xs font-medium text-[color:var(--text-primary)] transition-colors hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
                      coarseSolidTouchHeightClass
                    )}
                    title={thinkingRuntimeTitle}
                    aria-label={
                      runtimeModelAccessibleCurrent
                        ? `${runtimeModelTitle}: ${runtimeModelAccessibleCurrent}`
                        : thinkingUnsupported
                          ? t('chatV2:inputBar.thinkingUnsupported')
                          : hasThinkingDepthMenu
                            ? t('chatV2:inputBar.thinkingDepthMenu')
                            : t('chatV2:inputBar.chooseRuntimeModel')
                    }
                  >
                    {isExternalCliEngine && !resolvedTriggerBrandIconId ? (
                      <TerminalWindow
                        size={15}
                        weight="duotone"
                        className="shrink-0 text-primary"
                      />
                    ) : resolvedTriggerBrandIconId ? (
                      <ProviderIcon
                        modelId={resolvedTriggerBrandIconId}
                        size={15}
                        showTooltip={false}
                        variant={triggerUsesMonoBrand ? 'mono' : 'color'}
                        renderMode={triggerUsesMonoBrand ? 'default' : 'glyph'}
                        className="shrink-0 text-foreground"
                      />
                    ) : (
                      <Lightning
                        size={15}
                        weight={enableThinking && !thinkingUnsupported ? 'fill' : 'bold'}
                        className="shrink-0 text-[color:var(--text-primary)] opacity-90"
                      />
                    )}
                    <ResizingThinkingLabel text={thinkingRuntimeTriggerLabel} />
                    {runtimeModelUnavailable && (
                      <span
                        data-testid="thinking-runtime-unavailable-badge"
                        className="shrink-0 rounded border border-border/80 bg-background/80 px-1 py-px text-2xs font-normal leading-tight text-muted-foreground"
                      >
                        {t('chatV2:modelPicker.t3.unavailable', { defaultValue: '不可用' })}
                      </span>
                    )}
                  </button>
                </AppMenuTrigger>
                <AppMenuContent
                  align="end"
                  width={popoverLayout.width}
                  className="!max-w-none !min-w-0 !overflow-hidden !rounded-2xl !border !border-border/80 !bg-popover !p-0 !shadow-xl"
                >
                  <React.Suspense
                    fallback={<div style={{ height: popoverLayout.height }} className="w-full" />}
                  >
                    <LazyT3ModelSelectorPopover
                      options={runtimeModelOptions}
                      currentModelId={runtimeCurrentModelId}
                      activeModelLabel={runtimeModelLabel}
                      activeModelProviderLabel={runtimeModelProviderLabel}
                      isExternalCliEngine={isExternalCliEngine}
                      onSelectModel={onSelectRuntimeModel}
                      hasModelPanel={hasModelPanel}
                      onOpenRuntimeModelPanel={onOpenRuntimeModelPanel}
                      multiSelect={runtimeModelMultiSelect}
                      enableThinking={enableThinking}
                      thinkingUnsupported={thinkingUnsupported}
                      thinkingCanDisable={thinkingCanDisable}
                      thinkingDepthOptions={thinkingDepthOptions}
                      thinkingDepthValue={thinkingDepthValue}
                      onToggleThinking={onToggleThinking}
                      onSetThinkingDepth={onSetThinkingDepth}
                      webSearchEnabled={webSearchEnabled}
                      onWebSearchEnabledChange={onWebSearchEnabledChange}
                      renderAdvancedPanel={renderAdvancedPanel}
                      onOpenAdvancedPanel={onOpenAdvancedPanel}
                      initialView={modelMenuInitialView}
                      sessionId={sessionId}
                      permissionPreset={permissionPreset}
                      onPermissionPresetChange={onPermissionPresetChange}
                      onRequestDangerConfirm={handleRequestDangerConfirm}
                      onRequestClose={() => setIsModelMenuOpen(false)}
                      isMobile={isMobile}
                      layoutTier={popoverLayout.tier}
                      lockedHeight={popoverLayout.height}
                      disabled={isStreaming}
                    />
                  </React.Suspense>
                </AppMenuContent>
              </AppMenu>
            ) : (
              <span className="inline-flex min-w-0 items-center" data-testid="thinking-runtime-minimal-control">
                <button
                  type="button"
                  data-testid="btn-toggle-thinking"
                  onClick={thinkingUnsupported ? undefined : onToggleThinking}
                  disabled={thinkingUnsupported}
                  className={cn(
                    'inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-inherit transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
                    coarseSolidTouchTargetClass,
                    thinkingUnsupported ? 'opacity-55' : enableThinking ? 'opacity-90' : 'opacity-65 hover:opacity-90'
                  )}
                  title={thinkingStateLabel ?? t('chatV2:inputBar.thinking')}
                  aria-label={thinkingStateLabel ?? t('chatV2:inputBar.thinking')}
                  aria-pressed={enableThinking && !thinkingUnsupported}
                >
                  <Lightning size={15} weight={enableThinking && !thinkingUnsupported ? "fill" : "bold"} className="shrink-0" />
                </button>
                {compactThinkingStateLabel ? (
                  <span
                    data-testid="thinking-runtime-state-label"
                    className="inline-flex h-7 min-w-0 max-w-[5.75rem] select-none items-center rounded-md px-1 text-inherit"
                    title={thinkingStateLabel}
                  >
                    <span className="truncate">{compactThinkingStateLabel}</span>
                  </span>
                ) : null}
              </span>
            )}
          </span>
        )}
        {/* 🆕 媒体处理中提示（P1-5：移动端保留 icon + 短文案，不再整体隐藏文字） */}
        {hasProcessingMedia && (
          <div className="text-xs text-muted-foreground flex min-w-0 items-center gap-1 mr-1">
            <CircleNotch className="w-3 h-3 shrink-0 animate-spin motion-reduce:animate-none" weight="bold" />
            <span className="min-w-0 max-w-[7rem] truncate sm:max-w-none">
              {processingIndicatorLabel || t('chatV2:inputBar.processingIndicator')}
            </span>
          </div>
        )}

        {inputToolSlot}

        {/* 发送/停止按钮 - 极简圆形风格 */}
        {showStop ? (
          <DsButton
            data-testid="btn-stop"
            variant="default"
            size="icon"
            iconOnly
            onClick={onStop}
            disabled={!canAbort}
            // 移动端与发送按钮同为 44px 触控目标；桌面保持 32px 视觉
            className={cn(studyUiBlackActionButtonClass, 'native-touch-target !w-8 !h-8 max-md:!w-11 max-md:!h-11 [@media(pointer:coarse)]:!w-[var(--touch-target-size)] [@media(pointer:coarse)]:!h-[var(--touch-target-size)] !rounded-full shadow-sm')}
            aria-label={canAbort
              ? t('analysis:input_bar.actions.stop')
              : t('chatV2:inputBar.stopping')}
            title={canAbort
              ? t('analysis:input_bar.actions.stop')
              : t('chatV2:inputBar.stopping')}
          >
            {/* ★ aborting 中断确认期用 spinner 反馈，避免「点了没反应」错觉 */}
            {canAbort ? (
              <Square size={12} weight="fill" />
            ) : (
              <CircleNotch size={14} weight="bold" className="animate-spin motion-reduce:animate-none" />
            )}
          </DsButton>
        ) : (
          <CommonTooltip
            content={disabledSend ? sendBlockedReason : undefined}
            disabled={!disabledSend || isMobile || !sendBlockedReason}
          >
            <span className="relative inline-flex">
              <button
                data-testid="btn-send"
                type="button"
                onClick={onSend}
                disabled={disabledSend}
                className={cn(
                  studyUiButtonBaseClassName,
                  studyUiButtonSizeIconClassName,
                  studyUiSendButtonSizeClass,
                  isComposerEmpty ? studyUiSendButtonEmptyStateClass : studyUiBlackActionButtonClass
                )}
                aria-label={studyUiSendButtonAriaLabel}
              >
                <ArrowUp size={16} weight="bold" />
              </button>
              {/* C-2: 移动端无 tooltip，点击禁用按钮时用 toast 解释禁用原因 */}
              {disabledSend && isMobile && sendBlockedReason && (
                <button
                  type="button"
                  data-testid="btn-send-disabled-hint"
                  className="absolute inset-0 cursor-not-allowed rounded-full bg-transparent"
                  aria-label={sendBlockedReason}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showGlobalNotification('info', sendBlockedReason);
                  }}
                />
              )}
            </span>
          </CommonTooltip>
        )}
      </div>

      {/* 高风险全自动确认弹窗：挂在 AppMenu 之外，避免关闭模型菜单时弹窗被同步卸载 */}
      <DsAlertDialog
        open={confirmDangerOpen}
        onOpenChange={setConfirmDangerOpen}
        confirmVariant="danger"
        title={t('chatV2:authority.permissionPreset.dangerConfirmTitle')}
        description={t('chatV2:authority.permissionPreset.dangerConfirmDescription')}
        cancelText={t('common:actions.cancel')}
        confirmText={t('chatV2:authority.permissionPreset.dangerConfirmAction')}
        onConfirm={() => {
          void handleConfirmDangerPreset();
        }}
      />
    </div>
  );
};

export default ComposerToolbar;
