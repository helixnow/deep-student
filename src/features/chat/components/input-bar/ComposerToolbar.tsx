/**
 * Composer 底部工具栏（从 InputBarUI.tsx 拆出）
 *
 * 左侧：加号菜单（附件/技能/MCP/对话控制）+ 宿主插槽 + 快捷键提示；
 * 右侧：上下文水位环、推理强度/运行时模型菜单、媒体处理指示、
 * 工具插槽与发送/停止按钮。
 *
 * 纯展示组件：交互副作用（面板互斥、发送、停止）全部通过回调上抛。
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowUp,
  Square,
  Lightning,
  CircleNotch,
  CaretDown,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { TextSwap } from '@/components/ui/TextSwap';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuGroup,
  AppMenuSub,
  AppMenuSubTrigger,
  AppMenuSubContent,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ContextWindowUsage } from './contextWindowUsage';
import { formatContextTokenAmount } from './contextWindowUsage';
import type { ContextCompactionInfo } from './contextCompactionInfo';
import type { SessionUsageSummary } from '@/api/llmUsageApi';
import type { PermissionPreset } from '../../core/types/store';
import type { DeepSeekReasoningOption, DeepSeekReasoningOptionValue } from '@/utils/deepseekReasoningControls';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { ThinkingDepthSlider } from './ThinkingDepthSlider';
import { ContextUsagePopover } from './ContextUsagePopover';

// ============================================================================
// 样式常量（P1-3 触控目标：图标视觉尺寸不变，coarse pointer 下控件本体撑成
// ≥44×44 实体 flex box（--touch-target-size），命中区即盒模型，不再用透明
// after:-inset 伪元素外扩——伪元素会越过 gap 与相邻控件的命中区互相重叠）
// ============================================================================

const coarseSolidTouchTargetClass =
  '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]';
// 宽度由内容决定的触发器（带文字标签）只抬高度，避免 min-w 干扰 truncate
const coarseSolidTouchHeightClass = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';
const iconButtonClass = cn(
  'inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-shell-control)] text-[color:var(--button-utility-foreground)] transition-colors hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)] active:bg-[color:var(--button-utility-active)]',
  coarseSolidTouchTargetClass
);
const studyUiButtonBaseClassName =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-ui font-medium leading-none tracking-[0.01em] transition-[background-color,border-color,color,box-shadow] duration-150 ease-out outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';
const studyUiButtonSizeIconClassName =
  'h-[var(--button-icon-size)] w-[var(--button-icon-size)] rounded-[var(--button-radius)]';
const studyUiSendButtonSizeClass =
  'h-11 w-11 !rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)] [@media(pointer:coarse)]:!h-[var(--touch-target-size)] [@media(pointer:coarse)]:!w-[var(--touch-target-size)]';
const studyUiBlackActionButtonClass =
  '!border-black !bg-black hover:!bg-black active:!bg-black !text-white';
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
      className="relative inline-block whitespace-nowrap text-left text-[color:var(--text-muted)] opacity-70"
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
  sessionUsage,
  t,
  disabled,
}: {
  usage: ContextWindowUsage;
  sessionUsage?: SessionUsageSummary | null;
  t: TFunction;
  disabled: boolean;
}) {
  // ★ 1.2 水位分级警示：<75% 默认，75-90% warning，>90% danger
  const contextUsageColor =
    usage.usedPercent >= 90
      ? 'hsl(var(--danger))'
      : usage.usedPercent >= 75
        ? 'hsl(var(--warning))'
        : 'var(--text-primary)';
  const ringRadius = 6.75;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringProgressOffset = ringCircumference * (1 - usage.usedPercent / 100);
  const tooltipContent = (
    <div className="w-48 p-1.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-[color:var(--text-primary)]">
          {t('chatV2:tokenUsage.contextWindow')}
        </span>
        <span className="rounded-full border border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-muted)] px-1.5 py-0.5 font-mono text-2xs leading-none tabular-nums text-[color:var(--text-secondary)]">
          {usage.usedPercent}%
        </span>
      </div>
      <div
        data-testid="context-window-usage-tooltip-bar"
        className="mb-2.5 mt-2 h-1.5 overflow-hidden rounded-full bg-[color:var(--button-utility-hover)] ring-1 ring-[color:var(--input-shell-border)]"
      >
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{ width: `${usage.usedPercent}%`, background: contextUsageColor }}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[color:var(--text-secondary)]">
            {t('chatV2:tokenUsage.contextUsedPercent', { percent: usage.usedPercent })}
          </span>
          <span className="font-mono tabular-nums text-[color:var(--text-primary)]">
            {t('chatV2:tokenUsage.contextUsedTokens', { tokens: usage.usedLabel })}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[color:var(--text-secondary)]">
            {t('chatV2:tokenUsage.contextRemainingPercent', { percent: usage.remainingPercent })}
          </span>
          <span className="font-mono tabular-nums text-[color:var(--text-primary)]">
            {t('chatV2:tokenUsage.contextRemainingTokens', { tokens: usage.remainingLabel })}
          </span>
        </div>
      </div>
      {usage.usedPercent >= 75 && (
        <p className="mt-2 border-t border-[color:var(--input-shell-border)] pt-2 text-[11px] leading-snug text-[color:var(--text-secondary)]">
          {t('chatV2:tokenUsage.contextHighWaterHint')}
        </p>
      )}
      {/* ★ 1.2 本会话累计（token / 费用） */}
      {sessionUsage && sessionUsage.totalTokens > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-[color:var(--input-shell-border)] pt-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[color:var(--text-secondary)]">
              {t('chatV2:tokenUsage.sessionTotal')}
            </span>
            <span className="font-mono tabular-nums text-[color:var(--text-primary)]">
              {formatContextTokenAmount(sessionUsage.totalTokens)}
            </span>
          </div>
          {typeof sessionUsage.estimatedCostUsd === 'number' && sessionUsage.estimatedCostUsd > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[color:var(--text-secondary)]">
                {t('chatV2:tokenUsage.sessionCost')}
              </span>
              <span className="font-mono tabular-nums text-[color:var(--text-primary)]">
                ${sessionUsage.estimatedCostUsd.toFixed(sessionUsage.estimatedCostUsd < 0.1 ? 4 : 2)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <CommonTooltip content={tooltipContent} position="top" disabled={disabled}>
      {/* 纯视觉内层：焦点/aria-label/aria-haspopup 与 44×44 实体命中区
          统一由 ContextUsagePopover 的 button 触发器承担，内环不再自带
          tabIndex 与 after:-inset 伪元素命中区（避免与外层触发器双重重叠） */}
      <span
        data-testid="context-window-usage-control"
        aria-hidden="true"
        className="relative inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-[color:var(--text-secondary)]"
      >
        <svg
          data-testid="context-window-usage-ring"
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
            style={{ opacity: usage.usedPercent > 0 ? 1 : 0 }}
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
  authorityMode: 'ask' | 'plan' | 'craft';
  onAuthorityModeChange?: (mode: 'ask' | 'plan' | 'craft') => void | Promise<void>;
  permissionPreset: PermissionPreset;
  onPermissionPresetChange?: (preset: PermissionPreset) => void | Promise<void>;
  authorityAskBlockedHint: boolean;
  knowledgeBaseProactive: boolean;
  onKnowledgeBaseProactiveChange?: (enabled: boolean) => void | Promise<void>;
  renderSkillPanelMenuVariant?: () => React.ReactNode;
  activeSkillCount: number;
  hasLoadedSkills: boolean;
  renderMcpPanel?: () => React.ReactNode;
  onOpenMcpPanel?: () => void;
  mcpEnabled: boolean;
  selectedMcpServerCount: number;
  onOpenAdvancedPanel?: () => void;

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
  thinkingDepthOptions?: DeepSeekReasoningOption[];
  thinkingDepthValue?: DeepSeekReasoningOptionValue;
  onSetThinkingDepth?: (value: DeepSeekReasoningOptionValue | 'off') => void;
  runtimeModelLabel?: string;
  runtimeModelProviderLabel?: string;
  runtimeModelIconId?: string;
  runtimeCurrentModelId?: string | null;
  runtimeModelOptions: Array<{ id: string; label: string; providerLabel?: string; iconId?: string }>;
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
  authorityMode,
  onAuthorityModeChange,
  permissionPreset,
  onPermissionPresetChange,
  authorityAskBlockedHint,
  knowledgeBaseProactive,
  onKnowledgeBaseProactiveChange,
  renderSkillPanelMenuVariant,
  activeSkillCount,
  hasLoadedSkills,
  renderMcpPanel,
  onOpenMcpPanel,
  mcpEnabled,
  selectedMcpServerCount,
  onOpenAdvancedPanel,
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
  runtimeModelOptions,
  onSelectRuntimeModel,
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
  const { t } = useTranslation(['analysis', 'common', 'chatV2', 'settings']);

  const tooltipPosition = 'top' as const;
  // 🔧 移动端禁用 tooltip（触摸设备没有 hover 交互，tooltip 会干扰）
  const tooltipDisabled = isMobile;
  const studyUiSendButtonAriaLabel = t('chatV2:inputBar.sendMessage');

  // ── 推理/模型菜单派生值 ──
  const compactThinkingStateLabel = getCompactThinkingLabel(thinkingStateLabel);
  const resolveThinkingDepthLabel = useCallback(
    (option: DeepSeekReasoningOption) => t(option.labelKey, option.defaultLabel),
    [t]
  );
  const selectedThinkingDepthOption =
    !thinkingUnsupported && enableThinking && thinkingDepthValue && thinkingDepthOptions?.length
      ? thinkingDepthOptions.find((o) => o.value === thinkingDepthValue)
      : undefined;
  const resolvedThinkingTriggerLabel = selectedThinkingDepthOption
    ? resolveThinkingDepthLabel(selectedThinkingDepthOption)
    : compactThinkingStateLabel;
  const runtimeModelTitle = t('chatV2:inputBar.runtimeModelTitle');
  const chooseRuntimeModelLabel = t('chatV2:inputBar.chooseRuntimeModel');
  const runtimeModelSearchPlaceholder = t('chatV2:modelPicker.searchPlaceholder');
  const runtimeCompareModeLabel = t('chatV2:inputBar.runtimeModelCompareMode');
  const fallbackRuntimeProviderLabel = t('chatV2:inputBar.runtimeModelOtherProvider');
  const runtimeModelAccessibleCurrent = runtimeModelLabel
    ? runtimeModelProviderLabel
      ? `${runtimeModelProviderLabel} / ${runtimeModelLabel}`
      : runtimeModelLabel
    : undefined;
  const runtimeModelSwitchLabel = runtimeModelAccessibleCurrent
    ? t('chatV2:inputBar.runtimeModelSwitchCurrent', {
        label: chooseRuntimeModelLabel,
        current: runtimeModelAccessibleCurrent,
      })
    : chooseRuntimeModelLabel;
  const runtimeModelSwitchTitle = runtimeModelAccessibleCurrent
    ? t('chatV2:inputBar.runtimeModelSwitchCurrent', {
        label: chooseRuntimeModelLabel,
        current: runtimeModelAccessibleCurrent,
      })
    : chooseRuntimeModelLabel;
  const thinkingRuntimeTitle = [
    runtimeModelAccessibleCurrent ? `${runtimeModelTitle}: ${runtimeModelAccessibleCurrent}` : undefined,
    thinkingStateLabel,
  ].filter(Boolean).join(' · ') || thinkingStateLabel;
  const hasThinkingDepthMenu = !!(
    !thinkingUnsupported &&
    compactThinkingStateLabel &&
    onSetThinkingDepth &&
    thinkingDepthOptions &&
    thinkingDepthOptions.length > 0
  );
  const hasThinkingUnsupportedMenu = !!(compactThinkingStateLabel && thinkingUnsupported);
  const hasRuntimeModelMenu = runtimeModelOptions.length > 0 || hasModelPanel;
  const hasThinkingRuntimeMenu = hasThinkingDepthMenu || hasThinkingUnsupportedMenu || hasRuntimeModelMenu;
  const hasThinkingToggleMenu = !!(!thinkingUnsupported && compactThinkingStateLabel && (onSetThinkingDepth || onToggleThinking));
  const thinkingRuntimeTriggerLabel = resolvedThinkingTriggerLabel || runtimeModelLabel || runtimeModelTitle;

  const [runtimeModelSearch, setRuntimeModelSearch] = useState('');
  const normalizedRuntimeModelSearch = runtimeModelSearch.trim().toLowerCase();
  const groupedRuntimeModelOptions = useMemo(() => {
    if (runtimeModelOptions.length === 0) return [];

    const filteredOptions = normalizedRuntimeModelSearch.length === 0
      ? runtimeModelOptions
      : runtimeModelOptions.filter((model) => {
          const haystack = [model.label, model.providerLabel, model.id]
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .join(' ')
            .toLowerCase();
          return haystack.includes(normalizedRuntimeModelSearch);
        });

    const groups = new Map<string, typeof runtimeModelOptions>();
    filteredOptions.forEach((model) => {
      const providerLabel = model.providerLabel?.trim() || fallbackRuntimeProviderLabel;
      const existing = groups.get(providerLabel);
      if (existing) {
        existing.push(model);
        return;
      }
      groups.set(providerLabel, [model]);
    });

    return Array.from(groups.entries()).map(([providerLabel, models]) => ({
      providerLabel,
      models,
    }));
  }, [fallbackRuntimeProviderLabel, normalizedRuntimeModelSearch, runtimeModelOptions]);

  const handleTurnThinkingOn = useCallback(() => {
    if (enableThinking) return;
    onToggleThinking?.();
  }, [enableThinking, onToggleThinking]);

  const handleTurnThinkingOff = useCallback(() => {
    if (!thinkingCanDisable) return;
    if (!enableThinking) return;
    if (onSetThinkingDepth) {
      onSetThinkingDepth('off');
      return;
    }
    onToggleThinking?.();
  }, [enableThinking, onSetThinkingDepth, onToggleThinking, thinkingCanDisable]);

  const handleThinkingRuntimeMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      onThinkingMenuWillOpen();
      setRuntimeModelSearch('');
      return;
    }
    setRuntimeModelSearch('');
  }, [onThinkingMenuWillOpen]);

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
          authorityMode={authorityMode}
          onAuthorityModeChange={onAuthorityModeChange}
          permissionPreset={permissionPreset}
          onPermissionPresetChange={onPermissionPresetChange}
          authorityAskBlockedHint={authorityAskBlockedHint}
          knowledgeBaseProactive={knowledgeBaseProactive}
          onKnowledgeBaseProactiveChange={onKnowledgeBaseProactiveChange}
          renderSkillPanel={renderSkillPanelMenuVariant}
          activeSkillCount={activeSkillCount}
          hasLoadedSkills={hasLoadedSkills}
          renderMcpPanel={renderMcpPanel}
          onOpenMcpPanel={onOpenMcpPanel}
          mcpEnabled={mcpEnabled}
          selectedMcpServerCount={selectedMcpServerCount}
          onOpenAdvancedPanel={onOpenAdvancedPanel}
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
              sessionUsage={sessionUsage}
              t={t}
              disabled={tooltipDisabled}
            />
          </ContextUsagePopover>
        )}

        {/* 推理强度 - 放在原附件按钮位置，靠近发送动作 */}
        {onToggleThinking && (
          <span
            ref={runtimeModelTriggerRef}
            className={cn(
              'relative inline-flex h-8 min-w-0 max-w-[8rem] shrink-0 items-center rounded-[var(--radius-shell-control)] px-1 text-ui font-semibold leading-none',
              // coarse 下外壳随内部触发器抬到 44 高，避免子元素纵向溢出行盒
              coarseSolidTouchHeightClass,
              enableThinking && !thinkingUnsupported
                ? 'text-[color:var(--text-primary)]'
                : 'text-[color:var(--text-muted)]'
            )}
            data-testid="thinking-runtime-control"
          >
            {hasThinkingRuntimeMenu ? (
              <AppMenu onOpenChange={handleThinkingRuntimeMenuOpenChange}>
                <AppMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="thinking-runtime-menu-trigger"
                    className={cn(
                      'inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1 text-inherit transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
                      coarseSolidTouchHeightClass
                    )}
                    title={thinkingRuntimeTitle}
                    aria-label={
                      thinkingUnsupported
                        ? t('chatV2:inputBar.thinkingUnsupported')
                        : hasThinkingDepthMenu
                        ? t('chatV2:inputBar.thinkingDepthMenu')
                        : t('chatV2:inputBar.thinking')
                    }
                  >
                    {runtimeModelIconId ? (
                      <ProviderIcon
                        modelId={runtimeModelIconId}
                        size={15}
                        showTooltip={false}
                        variant="mono"
                        className="shrink-0 text-[color:var(--text-primary)] opacity-90"
                      />
                    ) : (
                      <Lightning size={15} weight={enableThinking && !thinkingUnsupported ? "fill" : "bold"} className="shrink-0 text-[color:var(--text-primary)] opacity-90" />
                    )}
                    <ResizingThinkingLabel text={thinkingRuntimeTriggerLabel} />
                    <CaretDown size={13} weight="bold" className="shrink-0 opacity-55" />
                  </button>
                </AppMenuTrigger>
                <AppMenuContent align="end" width={hasRuntimeModelMenu ? 232 : 176}>
                  {hasThinkingUnsupportedMenu ? (
                    <AppMenuGroup label={t('chatV2:inputBar.thinking')}>
                      <AppMenuItem disabled>
                        {t('chatV2:inputBar.thinkingUnsupportedDescription')}
                      </AppMenuItem>
                    </AppMenuGroup>
                  ) : hasThinkingDepthMenu ? (
                    thinkingCanDisable ? (
                      <AppMenuGroup>
                        <ThinkingDepthSlider
                          options={thinkingDepthOptions}
                          value={thinkingDepthValue}
                          enabled={!!enableThinking}
                          onChange={(next) => onSetThinkingDepth(next)}
                          offLabel={t('chatV2:inputBar.thinkingOff')}
                          efficientLabel={t('chatV2:inputBar.thinkingDepthEfficient')}
                          smartLabel={t('chatV2:inputBar.thinkingDepthSmart')}
                          resolveOptionLabel={resolveThinkingDepthLabel}
                          ariaLabel={t('chatV2:inputBar.thinkingDepthMenu')}
                        />
                      </AppMenuGroup>
                    ) : (
                      // 不可关闭推理的模型：滑块必带"关闭"档，退回菜单列表以保留 thinkingCanDisable 语义
                      <AppMenuGroup label={t('chatV2:inputBar.thinkingDepthTitle')}>
                        {thinkingDepthOptions.map((option) => (
                          <AppMenuItem
                            key={option.value}
                            checked={!!enableThinking && thinkingDepthValue === option.value}
                            onClick={() => onSetThinkingDepth(option.value)}
                          >
                            {resolveThinkingDepthLabel(option)}
                          </AppMenuItem>
                        ))}
                      </AppMenuGroup>
                    )
                  ) : hasThinkingToggleMenu ? (
                    <AppMenuGroup label={t('chatV2:inputBar.thinking')}>
                      <AppMenuItem checked={!!enableThinking} onClick={handleTurnThinkingOn}>
                        {t('chatV2:inputBar.thinkingOn')}
                      </AppMenuItem>
                      {thinkingCanDisable && (
                        <AppMenuItem checked={!enableThinking} onClick={handleTurnThinkingOff}>
                          {t('chatV2:inputBar.thinkingOff')}
                        </AppMenuItem>
                      )}
                    </AppMenuGroup>
                  ) : null}
                  {(hasThinkingToggleMenu || hasThinkingUnsupportedMenu) && hasRuntimeModelMenu && (
                    <AppMenuSeparator />
                  )}
                  {hasRuntimeModelMenu && (
                    <AppMenuGroup label={runtimeModelTitle}>
                      {runtimeModelOptions.length > 0 ? (
                        <AppMenuSub openOnClick>
                          <AppMenuSubTrigger
                            aria-label={runtimeModelSwitchLabel}
                            className={runtimeModelLabel ? '[&_.app-menu-item-content]:whitespace-normal' : undefined}
                            title={runtimeModelSwitchTitle}
                          >
                            {runtimeModelLabel ? (
                              <span className="flex min-w-0 max-w-full flex-col gap-0.5 leading-tight">
                                <span
                                  className="block min-w-0 max-w-full truncate text-[12px] font-medium text-foreground"
                                  title={runtimeModelLabel}
                                >
                                  {runtimeModelLabel}
                                </span>
                                {runtimeModelProviderLabel && (
                                  <span
                                    className="block min-w-0 max-w-full truncate text-2xs text-muted-foreground"
                                    title={runtimeModelProviderLabel}
                                  >
                                    {runtimeModelProviderLabel}
                                  </span>
                                )}
                              </span>
                            ) : (
                              chooseRuntimeModelLabel
                            )}
                          </AppMenuSubTrigger>
                          <AppMenuSubContent className="w-[min(240px,calc(100vw-24px))] max-w-[min(240px,calc(100vw-24px))] p-1">
                            <div className="app-menu-search">
                              <MagnifyingGlass className="app-menu-search-icon" />
                              <input
                                type="search"
                                // 📱 触控目标 + 16px 输入契约：.ds-search-input 的 coarse 规则挂在
                                // enhanced-pdf.css（仅 PDF 视图加载），此处内联补齐防 iOS 聚焦缩放
                                className="app-menu-search-input ds-search-input [@media(pointer:coarse)]:!h-[var(--touch-target-size)] [@media(pointer:coarse)]:!text-base"
                                placeholder={runtimeModelSearchPlaceholder}
                                value={runtimeModelSearch}
                                onChange={(event) => setRuntimeModelSearch(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                              />
                            </div>
                            <CustomScrollArea
                              fullHeight={false}
                              className="max-h-[220px]"
                              viewportClassName="max-h-[220px]"
                            >
                              {groupedRuntimeModelOptions.length > 0 ? (
                                groupedRuntimeModelOptions.map((group) => (
                                  <AppMenuGroup
                                    key={group.providerLabel}
                                    label={group.providerLabel}
                                    className="app-menu-group--natural-case"
                                  >
                                    {group.models.map((model) => (
                                      <AppMenuItem
                                        key={model.id}
                                        icon={model.iconId ? (
                                          <ProviderIcon
                                            modelId={model.iconId}
                                            size={14}
                                            showTooltip={false}
                                            variant="mono"
                                          />
                                        ) : undefined}
                                        checked={model.id === runtimeCurrentModelId}
                                        onClick={() => onSelectRuntimeModel?.(model.id)}
                                      >
                                        <span className="flex min-w-0 max-w-full flex-col gap-0.5 leading-tight">
                                          <span className="block min-w-0 max-w-full truncate text-[12px] font-medium text-foreground">
                                            {model.label}
                                          </span>
                                          {model.providerLabel && (
                                            <span className="block min-w-0 max-w-full truncate text-2xs text-muted-foreground">
                                              {model.providerLabel}
                                            </span>
                                          )}
                                        </span>
                                      </AppMenuItem>
                                    ))}
                                  </AppMenuGroup>
                                ))
                              ) : (
                                <AppMenuItem disabled>
                                  {t('chatV2:inputBar.runtimeModelNoResults')}
                                </AppMenuItem>
                              )}
                            </CustomScrollArea>
                            <AppMenuSeparator />
                            <AppMenuItem onClick={() => onOpenRuntimeModelPanel('compare')}>
                              {runtimeCompareModeLabel}
                            </AppMenuItem>
                          </AppMenuSubContent>
                        </AppMenuSub>
                      ) : (
                        <AppMenuItem
                          aria-label={runtimeModelSwitchLabel}
                          className={runtimeModelLabel ? '[&_.app-menu-item-content]:whitespace-normal' : undefined}
                          title={runtimeModelSwitchTitle}
                          onClick={() => onOpenRuntimeModelPanel()}
                        >
                          {runtimeModelLabel ? (
                            <span className="flex min-w-0 max-w-full flex-col gap-0.5 leading-tight">
                              <span
                                className="block min-w-0 max-w-full truncate text-[12px] font-medium text-foreground"
                                title={runtimeModelLabel}
                              >
                                {runtimeModelLabel}
                              </span>
                              {runtimeModelProviderLabel && (
                                <span
                                  className="block min-w-0 max-w-full truncate text-2xs text-muted-foreground"
                                  title={runtimeModelProviderLabel}
                                >
                                  {runtimeModelProviderLabel}
                                </span>
                              )}
                            </span>
                          ) : (
                            chooseRuntimeModelLabel
                          )}
                        </AppMenuItem>
                      )}
                    </AppMenuGroup>
                  )}
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
            className={cn(studyUiBlackActionButtonClass, '!w-8 !h-8 max-md:!w-11 max-md:!h-11 [@media(pointer:coarse)]:!w-[var(--touch-target-size)] [@media(pointer:coarse)]:!h-[var(--touch-target-size)] !rounded-full shadow-sm')}
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
    </div>
  );
};

export default ComposerToolbar;
