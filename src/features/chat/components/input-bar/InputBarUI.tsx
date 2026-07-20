/**
 * Chat V2 - InputBarUI 纯展示组件
 *
 * 只通过 props 接收数据和回调，不订阅任何 Store。
 * 保留原有 UI/UX/动效，删除所有业务逻辑和旧架构依赖。
 */

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowUp,
  Square,
  Paperclip,
  SlidersHorizontal,
  CheckCircle,
  Warning,
  Clock,
  XCircle,
  UploadSimple,
  Camera,
  Lightning,
  Sparkle,
  CircleNotch,
  FolderOpen,
  CaretDown,
  MagnifyingGlass,
  DotsThree,
  Trash,
  X,
} from '@phosphor-icons/react';
import { usePdfProcessingProgress } from '@/hooks/usePdfProcessingProgress';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
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
import { useTauriDragAndDrop } from '@/hooks/useTauriDragAndDrop';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { getErrorMessage } from '@/utils/errorUtils';
import { cancelPdfProcessing, getBatchPdfProcessingStatus, retryPdfProcessing } from '@/api/vfsPdfProcessingApi';
import type { InputBarUIProps } from './types';
import type { ContextWindowUsage } from './contextWindowUsage';
import { formatContextTokenAmount } from './contextWindowUsage';
import type { SessionUsageSummary } from '@/api/llmUsageApi';
import { vfsRefApi } from '../../context/vfsRefApi';
import { resourceStoreApi, type ContextRef } from '../../resources';
import { IMAGE_TYPE_ID } from '../../context/definitions/image';
import { FILE_TYPE_ID } from '../../context/definitions/file';
import { logAttachment } from '../../debug/chatV2Logger';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { COMPOSER_PANEL_KEYS, type AttachmentMeta, type PanelStates, type PdfProcessingStatus } from '../../core/types/common';
import { ModelMentionPopover, shouldHandleModelMentionKey } from './ModelMentionPopover';
import { SkillSlashPopover, useSkillSlashCommands, shouldHandleSkillSlashKey } from './SkillSlashPopover';
import { ModelMentionChips } from './ModelMentionChip';
import { ContextRefChips } from './ContextRefChips';
import { PageRefChips } from './PageRefChips';
import { AttachmentPreviewChips } from './AttachmentPreviewChips';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BlockingInteractionBar } from './BlockingInteractionBar';
import { AttachmentInjectModeSelector } from './AttachmentInjectModeSelector';
import { ComposerPanelOverlay } from './ComposerPanelOverlay';
import { ComposerInlinePanel } from './ComposerInlinePanel';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { ComposerToolButton } from './ComposerToolButton';
import { ThinkingDepthSlider } from './ThinkingDepthSlider';
import { ContextUsagePopover } from './ContextUsagePopover';
import { ThreadContentShell } from '../ui/ThreadContentShell';
import type { AttachmentInjectModes } from '../../core/types/common';
import {
  type MediaInjectMode,
  getSelectedInjectModes as ssotGetSelectedModes,
  getEffectiveReadyModes as ssotGetEffectiveReadyModes,
  getAttachmentMediaType,
  getMediaTypeForAttachment,
  buildDefaultInjectModes,
} from './injectModeUtils';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { useVoiceInputIntegration } from '@/voice-input';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { DeepSeekReasoningOption } from '@/utils/deepseekReasoningControls';
import { useKeyboardInset, isEditableElement } from '@/hooks/useKeyboardHeight';

// ============================================================================
// 常量
// ============================================================================

import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import {
  ATTACHMENT_MAX_SIZE,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_AUDIO_TYPES,
  ATTACHMENT_AUDIO_EXTENSIONS,
  ATTACHMENT_VIDEO_TYPES,
  ATTACHMENT_VIDEO_EXTENSIONS,
  ATTACHMENT_ARCHIVE_TYPES,
  ATTACHMENT_ARCHIVE_EXTENSIONS,
  ATTACHMENT_MINDMAP_EXTENSIONS,
  ATTACHMENT_MINDMAP_TEXT_EXTENSIONS,
  formatFileSize,
} from '../../core/constants';

/**
 * InputBar 配置常量
 * 集中管理输入栏的各种硬编码值，便于维护和调整
 */
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const INPUT_BAR_CONFIG = {
  /** 延迟时间配置 */
  delays: {
    /** 副作用延迟初始化时间 */
    idle: 100,
    /** 重 UI/重计算延迟挂载时间 */
    heavyUI: 400,
  },
  /** 高度相关配置 */
  heights: {
    /** 首帧固定高度占位，避免布局抖动 */
    placeholder: MOBILE_LAYOUT.inputBar.placeholderHeight,
    /** ResizeObserver 高度变化阈值（小于此值不更新状态） */
    changeThreshold: MOBILE_LAYOUT.inputBar.heightChangeThreshold,
    /** textarea 最小高度 */
    textareaMin: 40,
    /** textarea 最大高度（超出后才允许内部滚动）；220px ≈ 8 行，长草稿编辑不憋屈 */
    textareaMax: 220,
  },
  /** 粘贴策略 */
  paste: {
    /** 超过该字符数时，粘贴后提供「转为附件」内联建议（文本默认进输入框） */
    longTextSuggestChars: 1000,
    /** 超过该字符数时，直接转为 .txt 附件（避免超长文本拖垮输入框） */
    longTextAutoAttachChars: 50000,
  },
  /** 响应式断点 */
  breakpoints: {
    /** 移动端断点 */
    mobile: 768,
  },
  /** 间距配置 */
  gaps: {
    /** 桌面端底部间距 */
    desktop: 0,
    /** 移动端底部间距：应用导航已进入侧边栏，只保留系统安全区 */
    mobile: 0,
  },
};

// 向后兼容：保留原有常量名用于代码中的引用
const DESKTOP_DOCK_GAP_PX = INPUT_BAR_CONFIG.gaps.desktop;
const MOBILE_DOCK_GAP_PX = INPUT_BAR_CONFIG.gaps.mobile;
const MOBILE_BREAKPOINT_PX = INPUT_BAR_CONFIG.breakpoints.mobile;
const INITIAL_PLACEHOLDER_HEIGHT = INPUT_BAR_CONFIG.heights.placeholder;
const HEIGHT_CHANGE_THRESHOLD = INPUT_BAR_CONFIG.heights.changeThreshold;
const IDLE_DELAY_MS = INPUT_BAR_CONFIG.delays.idle;
const HEAVY_UI_DELAY_MS = INPUT_BAR_CONFIG.delays.heavyUI;

/**
 * 调度 idle 回调的工具函数
 * 使用 requestIdleCallback（如不支持则降级到 setTimeout）
 */
function scheduleIdle(callback: () => void, timeout = IDLE_DELAY_MS): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(callback, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(callback, timeout);
  return () => clearTimeout(id);
}

function getFileExtension(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}

function clampPercent(value?: number): number {
  const safe = Number.isFinite(value) ? (value as number) : 0;
  return Math.min(100, Math.max(0, Math.round(safe)));
}

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
  const ariaLabel = t('chatV2:tokenUsage.contextWindow');
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
      <span
        data-testid="context-window-usage-control"
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        title={ariaLabel}
        className="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-[color:var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
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

function getStageLabel(
  t: TFunction,
  status: PdfProcessingStatus | undefined,
  isPdf: boolean,
  isImage: boolean
): string | undefined {
  if (!status?.stage) return undefined;
  const current = status.currentPage;
  const total = status.totalPages;
  switch (status.stage) {
    case 'text_extraction':
      return t('chatV2:inputBar.stage.textExtraction');
    case 'page_rendering':
      return current && total
        ? t('chatV2:inputBar.stage.pageRenderingProgress', { current, total })
        : t('chatV2:inputBar.stage.pageRendering');
    case 'page_compression':
      return current && total
        ? t('chatV2:inputBar.stage.pageCompressionProgress', { current, total })
        : t('chatV2:inputBar.stage.pageCompression');
    case 'image_compression':
      return t('chatV2:inputBar.stage.imageCompression');
    case 'ocr_processing':
      if (isImage) return 'OCR';
      return current && total
        ? t('chatV2:inputBar.stage.ocrProcessingProgress', { current, total })
        : 'OCR';
    case 'vector_indexing':
      return t('chatV2:inputBar.stage.vectorIndexing');
    case 'completed':
      return t('chatV2:inputBar.stage.completed');
    case 'error':
      return t('chatV2:inputBar.stage.error');
    default:
      return isPdf
        ? t('chatV2:inputBar.stage.pdfProcessing')
        : t('chatV2:inputBar.stage.imageProcessing');
  }
}

function getDisplayPercent(
  status: PdfProcessingStatus | undefined,
  isPdf: boolean
): number {
  if (!status) return 0;
  const percent = clampPercent(status.percent);
  if (isPdf) {
    const current = status.currentPage;
    const total = status.totalPages;
    const isPageStage = status.stage === 'page_rendering'
      || status.stage === 'page_compression'
      || status.stage === 'ocr_processing';
    if (isPageStage && current && total && total > 0) {
      return clampPercent((current / total) * 100);
    }
  }
  return percent;
}

// ★ N3 修复：getEffectiveReadyModes / getSelectedModes 等已统一到 injectModeUtils（SSOT）
// 以下为适配 InputBarUI 调用签名的薄层委托函数

function getSelectedModes(
  attachment: AttachmentMeta,
  isPdf: boolean,
  isImage: boolean
): MediaInjectMode[] {
  const mediaType = isPdf ? 'pdf' : isImage ? 'image' : null;
  if (!mediaType) return [];
  return ssotGetSelectedModes(attachment, mediaType);
}

/**
 * InputBarUI 专用适配器：将 (attachment, status, mediaType) 委托给 SSOT
 */
function getEffectiveReadyModes(
  status: PdfProcessingStatus | undefined,
  mediaType: 'pdf' | 'image',
  attachment: AttachmentMeta
): MediaInjectMode[] | undefined {
  return ssotGetEffectiveReadyModes(attachment, mediaType, status);
}

function getMissingModes(
  selectedModes: MediaInjectMode[],
  readyModes?: MediaInjectMode[]
): MediaInjectMode[] {
  if (!selectedModes.length) return [];
  if (!readyModes) return selectedModes;
  const readySet = new Set(readyModes);
  return selectedModes.filter((mode) => !readySet.has(mode));
}

function hasAnyReadyMode(
  selectedModes: MediaInjectMode[],
  readyModes?: MediaInjectMode[]
): boolean {
  if (!selectedModes.length) return true;
  if (!readyModes || !readyModes.length) return false;
  const readySet = new Set(readyModes);
  return selectedModes.some((mode) => readySet.has(mode));
}


// ============================================================================
// 辅助 Hooks
// ============================================================================

/**
 * 延迟打开状态，用于面板动画
 */
type FloatingPanelMotion = 'closed' | 'opening' | 'open' | 'closing';
type DeferredPanelState = { shouldRender: boolean; motionState: FloatingPanelMotion };

const useDeferredOpen = (open: boolean, delay = 220): DeferredPanelState => {
  const [shouldRender, setShouldRender] = useState(open);
  const [motionState, setMotionState] = useState<FloatingPanelMotion>(
    open ? 'open' : 'closed'
  );
  const renderRef = useRef(shouldRender);

  useEffect(() => {
    renderRef.current = shouldRender;
  }, [shouldRender]);

  useEffect(() => {
    let frame1: number | null = null;
    let frame2: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (open) {
      setShouldRender(true);
      setMotionState('opening');
      frame1 = requestAnimationFrame(() => {
        frame2 = requestAnimationFrame(() => setMotionState('open'));
      });
    } else if (renderRef.current) {
      setMotionState('closing');
      timer = setTimeout(() => {
        setMotionState('closed');
        setShouldRender(false);
      }, delay);
    } else {
      setMotionState('closed');
    }

    return () => {
      if (frame1 !== null) cancelAnimationFrame(frame1);
      if (frame2 !== null) cancelAnimationFrame(frame2);
      if (timer) clearTimeout(timer);
    };
  }, [open, delay]);

  return { shouldRender, motionState };
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * InputBarUI - 纯展示输入栏组件
 *
 * ★ 性能：底部以 React.memo 导出。InputBarV2 因 store 订阅（流式 usage 更新、
 * 面板状态等）重渲染而 props 未变时，跳过整棵输入栏子树的重复渲染。
 * 打字路径（inputValue prop 变化）仍会渲染本组件，但内部重型子树
 * （ComposerPlusMenu / ComposerToolButton / 各 chips）已独立 memo。
 */
const InputBarUIInner: React.FC<InputBarUIProps> = ({
  // 状态
  inputValue,
  canSend,
  queueEnabled = false,
  queueFull = false,
  canSubmit,
  canAbort,
  isStreaming,
  contextWindowUsage,
  sessionUsage,
  attachments,
  panelStates,
  disabledReason,
  sessionSwitchKey = 0,
  // 回调
  onInputChange,
  onSend,
  onAbort,
  onAddAttachment,
  onUpdateAttachment,
  onRemoveAttachment,
  onClearAttachments,
  onFilesUpload,
  onSetPanelState,
  onCompactContext,
  isCompactingContext = false,
  compactContextStatus = null,
  getCompactionInfo,
  // UI 配置
  placeholder,
  sendShortcut = 'enter',
  leftAccessory,
  extraButtonsRight,
  inputToolSlot,
  composerInlinePanel,
  className,
  autoFocus = false,
  // 模式插件面板
  // renderRagPanel 已彻底废弃：独立 RAG 面板 UI 删除后无插件注册，快捷键统一走对话控制面板
  renderModelPanel,
  renderAdvancedPanel,
  renderMcpPanel,
  renderSkillPanel,
  onOpenRuntimeModelPanel,
  // 教材侧栏控制
  textbookOpen,
  onTextbookToggle,
  // 模型 @mention 自动完成
  modelMentionState,
  modelMentionActions,
  runtimeModelLabel,
  runtimeModelProviderLabel,
  runtimeModelIconId,
  runtimeCurrentModelId,
  runtimeModelOptions = [],
  onSelectRuntimeModel,
  // 推理模式
  enableThinking,
  thinkingStateLabel,
  thinkingUnsupported,
  thinkingCanDisable = true,
  thinkingDepthOptions,
  thinkingDepthValue,
  onToggleThinking,
  onSetThinkingDepth,
  // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除开关
  // ★ Skills 技能系统（多选模式）
  activeSkillIds,
  hasLoadedSkills,
  onToggleSkill,
  onClearAllSkills,
  // 🔧 MCP 选中状态
  mcpEnabled = false,
  selectedMcpServerCount = 0,
  onClearMcpServers,
  // 🔧 P1-27: 上下文引用可视化
  pendingContextRefs,
  onRemoveContextRef,
  onClearContextRefs,
  onContextRefCreated,
  // 🆕 工具审批请求
  pendingApprovalRequest,
  sessionId,
  authorityMode = 'craft',
  onAuthorityModeChange,
  permissionPreset = 'cautious',
  onPermissionPresetChange,
  authorityAskBlockedHint = false,
  knowledgeBaseProactive = false,
  onKnowledgeBaseProactiveChange,
  // ★ PDF 页码引用
  pdfPageRefs,
  onRemovePdfPageRef,
  onClearPdfPageRefs,
}) => {
  const { t } = useTranslation(['analysis', 'common', 'chatV2', 'settings']);
  const modeLabelMap = useMemo<Record<MediaInjectMode, string>>(() => ({
    text: t('chatV2:injectMode.pdf.text'),
    ocr: t('chatV2:injectMode.image.ocr'),
    image: t('chatV2:injectMode.image.image'),
  }), [t]);

  const formatModeList = useCallback((modes: MediaInjectMode[]): string => {
    const separator = t('chatV2:inputBar.modeSeparator');
    return modes.map((mode) => modeLabelMap[mode]).join(separator);
  }, [modeLabelMap, t]);

  // 🆕 监听 PDF 处理进度事件
  usePdfProcessingProgress();

  // 🆕 获取 PDF 处理状态 store
  const pdfStatusMap = usePdfProcessingStore(state => state.statusMap);

  // 🔧 移动端布局控制：折叠/展开底部导航栏
  const mobileLayout = useMobileLayoutSafe();

  // 🔧 相机拍照功能（移动端）
  // 注意：需要在 processFilesToAttachments 定义后使用，这里先声明 ref
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // ========== Refs ==========
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaScrollViewportRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 🔧 IME 合成态追踪：防止 WKWebView 中文输入法重复追加文本
  const isComposingRef = useRef(false);
  // 🔧 Safari/WebKit 时序修复：compositionend 先于确认 Enter 的 keydown 触发，
  // 该 keydown 的 isComposing 已为 false，会把「确认候选词」误判为「发送」。
  // 标记 compositionend 后的同一轮事件循环，期间的 Enter 一律视为 IME 确认键。
  const compositionJustEndedRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (compositionEndTimerRef.current !== null) {
        clearTimeout(compositionEndTimerRef.current);
      }
    };
  }, []);

  // ========== 本地状态 ==========
  // 🔧 首帧降载：使用固定高度占位，idle 后再测量真实高度
  const [inputContainerHeight, setInputContainerHeight] = useState<number>(INITIAL_PLACEHOLDER_HEIGHT);
  const [textareaViewportHeight, setTextareaViewportHeight] = useState<number>(40);
  const lastMeasuredHeightRef = useRef<number>(INITIAL_PLACEHOLDER_HEIGHT);
  const [bottomGapPx, setBottomGapPx] = useState(DESKTOP_DOCK_GAP_PX);
  // 🔧 A-6/P1-6 语义澄清（两个"移动端"判断有意分裂，勿合并）：
  // - isMobile（MobileLayoutContext，宽度断点驱动）：一切**布局**分支的唯一依据
  //   （内联面板、底部安全区、44px 触控目标、tooltip 禁用等）。
  // - isMobileEnv（pointer: coarse，见下方声明）：仅用于**设备能力**判断
  //   （是否展示拍照入口等），窄窗口桌面端不该出现相机、宽屏触摸设备应保留相机。
  const isMobile = mobileLayout?.isMobile ?? false;
  // ⌨️ P0-2 键盘统一：订阅全局键盘 inset 单例（iOS overlay 检测 + Android
  // adjustResize 自动归零），不再自管 visualViewport 双轨逻辑
  const globalKeyboardInset = useKeyboardInset();
  // 焦点门控：仅当焦点位于 composer 区域内的可编辑元素（输入框 / 面板搜索框等）
  // 时才应用 inset，避免页面其他输入框唤起键盘时输入栏被误抬升
  const [composerEditableFocused, setComposerEditableFocused] = useState(false);
  // 桌面端「Enter 发送 / Shift+Enter 换行」提示：仅在 textarea 聚焦且输入为空时展示
  const [composerTextareaFocused, setComposerTextareaFocused] = useState(false);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  // ★ B9 修复：长文本默认进输入框；这里记录粘贴片段，提供「转为附件」内联建议
  const [longPasteCandidate, setLongPasteCandidate] = useState<{ text: string } | null>(null);
  // ★ 制卡可发现性：附加 pdf/docx/apkg 时展示一条可关闭的制卡/导入提示
  const [flashcardHintDismissed, setFlashcardHintDismissed] = useState(false);
  const flashcardHintKind = useMemo<'apkg' | 'document' | null>(() => {
    let kind: 'apkg' | 'document' | null = null;
    for (const att of attachments) {
      if (att.status === 'error') continue;
      const ext = getFileExtension(att.name);
      if (ext === 'apkg') return 'apkg';
      if (ext === 'pdf' || ext === 'docx') kind = 'document';
    }
    return kind;
  }, [attachments]);
  useEffect(() => {
    // 相关附件全部移除后复位，下次附加时重新提示
    if (!flashcardHintKind) setFlashcardHintDismissed(false);
  }, [flashcardHintKind]);
  // ★ 音视频可见性警示：AI 仅能看到文件名（音频可调用转写工具获取文字）
  const [mediaHintDismissed, setMediaHintDismissed] = useState(false);
  const mediaHintKind = useMemo<'audio' | 'video' | null>(() => {
    let kind: 'audio' | 'video' | null = null;
    for (const att of attachments) {
      if (att.status === 'error') continue;
      if (att.type === 'audio') return 'audio';
      if (att.type === 'video') kind = 'video';
    }
    return kind;
  }, [attachments]);
  useEffect(() => {
    if (!mediaHintKind) setMediaHintDismissed(false);
  }, [mediaHintKind]);
  // ★ 思维导图可发现性：附加 xmind/opml/mm/mmap 时提示可导入为思维导图
  const [mindmapHintDismissed, setMindmapHintDismissed] = useState(false);
  const hasMindmapAttachment = useMemo(() => attachments.some((att) => (
    att.status !== 'error' && ATTACHMENT_MINDMAP_EXTENSIONS.includes(getFileExtension(att.name))
  )), [attachments]);
  useEffect(() => {
    if (!hasMindmapAttachment) setMindmapHintDismissed(false);
  }, [hasMindmapAttachment]);
  // armed=true 表示粘贴内容已落入输入框，可以开始监测「片段被编辑掉」
  const longPasteArmedRef = useRef(false);
  // ★ L2 修复：会话切换后 isReady 前（~0.5s）粘贴的文件先缓存，就绪后自动补投
  const pendingEarlyPasteRef = useRef<File[]>([]);
  // ★ 斜杠命令/@mention 共用的光标位置跟踪（onChange / onSelect / 补全后更新）
  const [composerCaretPos, setComposerCaretPos] = useState(0);

  // 🔧 首帧轻量化：isReady 控制重 UI 延迟挂载
  const [isReady, setIsReady] = useState(false);
  // 🔧 会话切换 key 跟踪
  const prevSessionSwitchKeyRef = useRef(sessionSwitchKey);

  const fileAccept = useMemo(() => {
    const acceptTypes = Array.from(new Set([
      ...ATTACHMENT_ALLOWED_TYPES,
      ...ATTACHMENT_ALLOWED_EXTENSIONS.map((ext) => `.${ext}`),
    ]));
    return acceptTypes.join(',');
  }, []);

  // ========== 文件处理回调 ==========

  // 使用 ref 存储面板状态，避免回调依赖导致不必要的重建
  const panelStatesRef = useRef(panelStates);
  useEffect(() => {
    panelStatesRef.current = panelStates;
  }, [panelStates]);

  // ★ P0 修复（B2）：附件数量校验不再依赖渲染期闭包快照。
  // React 重绘前连续两次拖入/粘贴多文件时，两个批次都会按旧 count 切片而突破上限；
  // 改为同步计数 ref：每次 onAddAttachment 后立即 +1，attachments 提交后再校准。
  const liveAttachmentCountRef = useRef(attachments.length);
  useEffect(() => {
    liveAttachmentCountRef.current = attachments.length;
  }, [attachments.length]);

  // 使用 useRef 追踪 attachments 的引用，避免作为 useEffect 依赖导致频繁触发
  //（声明提前到 processFilesToAttachments 之前：上传完成回调需读取最新注入模式）
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // 处理文件转换为附件元数据并上传
  const processFilesToAttachments = useCallback((files: File[]) => {
    if (!files.length) return;

    // 🆕 维护模式检查：阻止文件上传
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', t('common:maintenance.blocked_file_upload'));
      return;
    }

    // 如果有外部 onFilesUpload 回调，优先使用
    if (onFilesUpload) {
      onFilesUpload(files);
      return;
    }

    // P1-08: 使用统一的附件配置常量
    // 🔧 P2优化：检查附件数量限制（★ B2：读同步计数 ref，而非渲染期快照）
    const currentCount = liveAttachmentCountRef.current;
    const availableSlots = ATTACHMENT_MAX_COUNT - currentCount;
    if (availableSlots <= 0) {
      console.warn(`[InputBarUI] Attachment limit reached (${ATTACHMENT_MAX_COUNT})`);
      showGlobalNotification('warning', t('analysis:input_bar.attachments.limit_reached', { count: ATTACHMENT_MAX_COUNT }));
      return;
    }
    // 只处理可用槽位数量的文件
    const filesToProcess = files.slice(0, availableSlots);
    if (filesToProcess.length < files.length) {
      console.warn(`[InputBarUI] Truncated ${files.length - filesToProcess.length} files due to limit`);
    }

    // 否则使用内部逻辑创建附件元数据
    // 🔧 P0修复：使用 FileReader 读取文件内容，设置 previewUrl
    // 🔧 P2优化：使用 updateAttachment 原地更新，避免闪烁
    filesToProcess.forEach((file) => {
      const fileExt = getFileExtension(file.name);
      // ★ P1 SSOT：媒体类型统一走 getAttachmentMediaType（MIME OR 扩展名），
      // 修复空 mime 的 .png 等文件在部分链路中不进图片流水线的分裂
      const mediaType = getAttachmentMediaType(file.type, file.name);
      const isImage = mediaType === 'image';
      const isAudio = file.type.startsWith('audio/') || ATTACHMENT_AUDIO_TYPES.includes(file.type) || ATTACHMENT_AUDIO_EXTENSIONS.includes(fileExt);
      const isVideo = file.type.startsWith('video/') || ATTACHMENT_VIDEO_TYPES.includes(file.type) || ATTACHMENT_VIDEO_EXTENSIONS.includes(fileExt);
      const isArchive = ATTACHMENT_ARCHIVE_TYPES.includes(file.type) || ATTACHMENT_ARCHIVE_EXTENSIONS.includes(fileExt);
      // ★ 思维导图：xmind/mmap 为二进制容器（不注入文本，归 other）；
      // opml/mm 为 XML 纯文本（按文档/文本注入）
      const isBinaryMindmap = ATTACHMENT_MINDMAP_EXTENSIONS.includes(fileExt)
        && !ATTACHMENT_MINDMAP_TEXT_EXTENSIONS.includes(fileExt);
      const attachmentType: AttachmentMeta['type'] = isImage ? 'image' : isAudio ? 'audio' : isVideo ? 'video' : (isArchive || isBinaryMindmap) ? 'other' : 'document';
      const attachmentId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // 🔧 P2优化：文件大小验证 (P1-08: 使用统一常量)
      if (file.size > ATTACHMENT_MAX_SIZE) {
        console.warn(`[InputBarUI] File too large: ${file.name} (${formatFileSize(file.size)})`);
        const errorAttachment: AttachmentMeta = {
          id: attachmentId,
          name: file.name,
          type: attachmentType,
          resourceType: isImage ? 'image' : 'file',
          mimeType: file.type,
          size: file.size,
          status: 'error',
          error: t('analysis:input_bar.attachments.file_too_large', { size: formatFileSize(ATTACHMENT_MAX_SIZE) }),
        };
        onAddAttachment(errorAttachment);
        liveAttachmentCountRef.current += 1;
        return;
      }

      // 🔧 P2优化：文件类型验证 (P1-08: 使用统一常量)
      const isAllowedType = ATTACHMENT_ALLOWED_TYPES.includes(file.type)
        || ATTACHMENT_ALLOWED_EXTENSIONS.includes(fileExt);
      if (!isAllowedType) {
        console.warn(`[InputBarUI] Unsupported file type: ${file.name} (${file.type || fileExt})`);
        const errorAttachment: AttachmentMeta = {
          id: attachmentId,
          name: file.name,
          type: attachmentType,
          resourceType: isImage ? 'image' : 'file',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          status: 'error',
          error: t('analysis:input_bar.attachments.errors.unsupported_type', {
            name: file.name,
            ext: fileExt || file.type || 'unknown',
          }),
        };
        onAddAttachment(errorAttachment);
        liveAttachmentCountRef.current += 1;
        return;
      }

      // 先添加 pending 状态的附件
      // ★ P0 契约：PDF/图片附件从创建起就显式携带 UI 默认注入模式，
      // 后续 ContextRef 同步与发送快照均以此为准，后端缺省逻辑永不触发
      const pendingAttachment: AttachmentMeta = {
        id: attachmentId,
        name: file.name,
        type: attachmentType,
        resourceType: isImage ? 'image' : 'file',
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        status: 'uploading', // 标记为上传中
        uploadProgress: 0,
        uploadStage: 'reading',
        injectModes: buildDefaultInjectModes(mediaType),
      };
      onAddAttachment(pendingAttachment);
      liveAttachmentCountRef.current += 1;

      // 🔧 P1-25: 移动端内存优化 - 使用 Blob URL 预览，避免 DataURL 常驻内存
      // 创建 Blob URL 用于预览（内存友好，浏览器自动管理）
      const blobPreviewUrl = URL.createObjectURL(file);

      // 异步读取文件内容并上传到 VFS
      const reader = new FileReader();
      let lastReportedPercent = 0;
      reader.onprogress = (e) => {
        if (e.lengthComputable) {
          // 统一进度条：文件读取阶段占 0-20%
          const readPercent = Math.round((e.loaded / e.total) * 20);
          // ★ P2 节流：变化 >= 3% 才更新，避免大文件频繁触发 React 重渲染
          if (readPercent - lastReportedPercent >= 3 || readPercent >= 20) {
            lastReportedPercent = readPercent;
            onUpdateAttachment(attachmentId, {
              uploadProgress: readPercent,
              uploadStage: 'reading',
            });
          }
        }
      };
      reader.onload = async () => {
        const base64Result = reader.result as string;

        logAttachment('ui', 'file_read_complete', {
          fileName: file.name,
          attachmentId,
          isImage,
          size: file.size,
        });

        // ★ VFS 引用模式：上传到 VFS 并创建 ContextRef
        try {
          const typeId = isImage ? IMAGE_TYPE_ID : FILE_TYPE_ID;

          logAttachment('ui', 'vfs_upload_start', {
            fileName: file.name,
            typeId,
          });

          // ★ 统一进度条：文件读取完成 → 进入 VFS 上传阶段 (20-40%)
          onUpdateAttachment(attachmentId, {
            uploadProgress: 20,
            uploadStage: 'uploading',
          });

          // 1. 上传到 VFS
          const uploadResult = await vfsRefApi.uploadAttachment({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            base64Content: base64Result,
            type: isImage ? 'image' : 'file',
          });

          logAttachment('ui', 'vfs_upload_done', {
            sourceId: uploadResult.sourceId,
            resourceHash: uploadResult.resourceHash,
            isNew: uploadResult.isNew,
          }, 'success');

          // ★ 统一进度条：VFS 上传完成 → 进入创建引用阶段 (40-50%)
          onUpdateAttachment(attachmentId, {
            uploadProgress: 40,
            uploadStage: 'creating',
          });

          // 2. 创建资源引用
          const refData = JSON.stringify({
            refs: [{
              sourceId: uploadResult.sourceId,
              resourceHash: uploadResult.resourceHash,
              type: isImage ? 'image' : 'file',
              name: file.name,
            }],
            totalCount: 1,
            truncated: false,
          });

          logAttachment('ui', 'resource_create_start', {
            refData,
            sourceId: uploadResult.sourceId,
          });

          const result = await resourceStoreApi.createOrReuse({
            type: isImage ? 'image' : 'file',
            data: refData,
            sourceId: uploadResult.sourceId,
            metadata: {
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              size: file.size,
            },
          });

          logAttachment('ui', 'resource_created', {
            resourceId: result.resourceId,
            hash: result.hash,
            isNew: result.isNew,
          }, 'success');

          // 3. 添加 ContextRef 到 store
          // 注意：InputBarUI 是纯 UI 组件，通过回调通知上层处理 ContextRef
          // ★ P0 契约修复：创建 ContextRef 时就显式写入注入模式。
          // 优先取用户在上传期间已改过的选择（读同步 ref 中的最新附件），
          // 否则回落到 UI 默认（PDF=['text'] / 图片=['image']），
          // 确保后端「缺省 text+image 双开」的兜底永不触发。
          const liveInjectModes = attachmentsRef.current.find(a => a.id === attachmentId)?.injectModes;
          const explicitInjectModes = liveInjectModes ?? buildDefaultInjectModes(mediaType);
          const contextRef: ContextRef = {
            resourceId: result.resourceId,
            hash: result.hash,
            typeId,
            displayName: file.name,
            ...(explicitInjectModes ? { injectModes: explicitInjectModes } : {}),
          };

          logAttachment('store', 'add_context_ref_event', {
            resourceId: result.resourceId,
            hash: result.hash,
            typeId,
            injectModes: explicitInjectModes,
          });

          // 通过回调交给上层统一注册 ContextRef，避免跨模块散落事件监听
          onContextRefCreated?.({ contextRef, attachmentId });

          // 4. 更新附件状态
          // 🔧 P1-25: 使用 Blob URL 预览，而不是 DataURL
          // Blob URL 由浏览器管理，内存占用更低

          // 🆕 判断文件类型，PDF 和图片需要进入 processing 状态等待预处理完成
          //（复用 SSOT mediaType：MIME OR 扩展名，与上方附件创建口径一致）
          const isPdfFile = mediaType === 'pdf';
          const isImageFile = mediaType === 'image';

          if (isPdfFile) {
            // PDF 上传完成后设为 processing 状态，等待预处理流水线
            // ★ v2.1: 使用后端返回的实际处理状态（从 uploadResult 获取）
            // ★ P0 架构改造：默认 stage 改为 page_compression，默认 readyModes 只有 text
            const stage = uploadResult.processingStatus || 'page_compression';
            const percent = uploadResult.processingPercent ?? 25;
            const VALID_MODES = new Set(['text', 'ocr', 'image']);
            const rawModes = (uploadResult.readyModes || []).filter(m => VALID_MODES.has(m));
            const readyModes = (rawModes.length > 0 ? rawModes : ['text']) as ('text' | 'image' | 'ocr')[];
            const isCompleted = stage === 'completed' || stage === 'completed_with_issues';

            onUpdateAttachment(attachmentId, {
              status: isCompleted ? 'ready' : 'processing',
              previewUrl: blobPreviewUrl,
              resourceId: result.resourceId,
              sourceId: uploadResult.sourceId, // ★ P0 修复：保存 sourceId 用于重试
              uploadProgress: undefined,
              uploadStage: undefined,
              processingStatus: {
                stage: stage as 'page_rendering' | 'page_compression' | 'ocr_processing' | 'vector_indexing' | 'completed' | 'completed_with_issues',
                percent,
                readyModes,
                mediaType: 'pdf',
              },
            });

            // 同时更新 pdfProcessingStore
            // ★ P0 修复：使用 sourceId (file_id) 作为 key，与后端事件保持一致
            usePdfProcessingStore.getState().update(uploadResult.sourceId, {
              stage: stage as 'page_rendering' | 'page_compression' | 'ocr_processing' | 'vector_indexing' | 'completed' | 'completed_with_issues',
              percent,
              readyModes,
              mediaType: 'pdf',
            });
            // ★ 调试日志：记录 Store 初始化
            logAttachment('store', 'processing_store_init', {
              sourceId: uploadResult.sourceId,
              attachmentId,
              mediaType: 'pdf',
              stage,
              percent,
              readyModes,
              fileName: file.name,
            });
          } else if (isImageFile) {
            // 图片上传完成后设为 processing 状态，等待预处理流水线
            // ★ v2.1: 使用后端返回的实际处理状态（从 uploadResult 获取）
            // ★ P0 架构改造：默认 readyModes 为空，image 需要等压缩完成
            const stage = uploadResult.processingStatus || 'image_compression';
            const percent = uploadResult.processingPercent ?? 10;
            const VALID_IMG_MODES = new Set(['text', 'ocr', 'image']);
            const readyModes = (uploadResult.readyModes || []).filter(m => VALID_IMG_MODES.has(m)) as ('text' | 'image' | 'ocr')[];
            const isCompleted = stage === 'completed' || stage === 'completed_with_issues';

            onUpdateAttachment(attachmentId, {
              status: isCompleted ? 'ready' : 'processing',
              previewUrl: blobPreviewUrl,
              resourceId: result.resourceId,
              sourceId: uploadResult.sourceId, // ★ P0 修复：保存 sourceId 用于重试
              uploadProgress: undefined,
              uploadStage: undefined,
              processingStatus: {
                stage: stage as 'image_compression' | 'ocr_processing' | 'vector_indexing' | 'completed',
                percent,
                readyModes,
                mediaType: 'image',
              },
            });

            // 同时更新 pdfProcessingStore
            // ★ P0 修复：使用 sourceId (file_id) 作为 key，与后端事件保持一致
            usePdfProcessingStore.getState().update(uploadResult.sourceId, {
              stage: stage as 'image_compression' | 'ocr_processing' | 'vector_indexing' | 'completed',
              percent,
              readyModes,
              mediaType: 'image',
            });
            // ★ 调试日志：记录 Store 初始化
            logAttachment('store', 'processing_store_init', {
              sourceId: uploadResult.sourceId,
              attachmentId,
              mediaType: 'image',
              stage,
              percent,
              readyModes,
              fileName: file.name,
            });
          } else {
            // 其他文件类型直接 ready
            onUpdateAttachment(attachmentId, {
              status: 'ready',
              previewUrl: blobPreviewUrl,
              resourceId: result.resourceId,
              sourceId: uploadResult.sourceId, // ★ P0 修复：保存 sourceId
              uploadProgress: undefined,
              uploadStage: undefined,
            });
          }



        } catch (error) {
          const errorDetail = getErrorMessage(error);
          logAttachment('ui', 'vfs_upload_error', {
            fileName: file.name,
            error: errorDetail,
          }, 'error');

          // 🔧 P0-15 修复：VFS 上传失败时标记为 error，而不是 ready
          // 原问题：标记为 ready 但没有 ContextRef，用户以为可用但模型看不到
          // 🔧 P1-25: 使用 Blob URL 预览
          onUpdateAttachment(attachmentId, {
            status: 'error',
            previewUrl: blobPreviewUrl,
            error: `${t('chatV2:input.attachmentUploadFailed')}${errorDetail ? ` (${errorDetail})` : ''}`,
            uploadProgress: undefined,
            uploadStage: undefined,
          });
          console.error('[InputBarUI] VFS upload failed:', errorDetail);
        }
      };
      reader.onerror = () => {
        // 🔧 释放 Blob URL，文件读取失败时不再需要预览
        URL.revokeObjectURL(blobPreviewUrl);
        console.error('[InputBarUI] Failed to read file:', file.name);
        logAttachment('ui', 'file_read_error', {
          fileName: file.name,
          attachmentId,
        }, 'error');
        onUpdateAttachment(attachmentId, {
          status: 'error',
          error: t('analysis:input_bar.attachments.load_failed'),
          uploadProgress: undefined,
          uploadStage: undefined,
        });
      };
      reader.readAsDataURL(file);
    });

  }, [onFilesUpload, onAddAttachment, onUpdateAttachment, onContextRefCreated, t]);

  // ========== 相机拍照处理 ==========
  // A-6/P1-6: 拍照入口按指针能力判定（触屏设备≈带摄像头的移动设备），
  // 替代 UA 嗅探，避免与宽度断点产生"桌面布局+移动能力"混合态。
  // 注意：isMobileEnv 只回答"设备能不能"（能力），布局分支一律用 isMobile（断点）。
  const isMobileEnv = useMediaQuery('(pointer: coarse)');

  const handleCameraClick = useCallback(() => {
    if (cameraInputRef.current) {
      cameraInputRef.current.value = '';
      cameraInputRef.current.click();
    }
  }, []);

  const handleCameraChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (!file || !file.type.startsWith('image/')) return;

    // 使用现有的文件处理流程
    processFilesToAttachments([file]);
  }, [processFilesToAttachments]);

  // ========== 拖拽上传（延迟初始化） ==========
  // 🔧 辅助链路：idle 后再启用拖拽功能
  const { isDragging, dropZoneProps } = useTauriDragAndDrop({
    dropZoneRef,
    onDropFiles: processFilesToAttachments,
    isEnabled: isReady, // 首帧禁用，idle 后启用
    debugZoneId: 'input-bar-v2',
    maxFiles: ATTACHMENT_MAX_COUNT,
    maxFileSize: ATTACHMENT_MAX_SIZE,
  });

  // ========== 粘贴附件处理 ==========
  const handlePasteAsAttachment = useCallback((event: React.ClipboardEvent<Element>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pastedFiles: File[] = [];

    // 处理剪贴板文件
    const clipboardFiles = clipboard.files ? Array.from(clipboard.files).filter(file => file && file.size > 0) : [];
    clipboardFiles.forEach((file, index) => {
      if (!file) return;
      if (file.name && file.name.trim().length > 0) {
        pastedFiles.push(file);
        return;
      }
      // 生成默认文件名
      const mime = file.type || 'application/octet-stream';
      const ext = (() => {
        if (!mime) return 'bin';
        const parts = mime.split('/');
        if (parts.length === 2 && parts[1]) return parts[1];
        if (mime.includes('json')) return 'json';
        if (mime.includes('text')) return 'txt';
        return 'bin';
      })();
      const prefix = mime.startsWith('image/') ? 'pasted_image' : 'pasted_file';
      const suffix = clipboardFiles.length > 1 ? `_${index + 1}` : '';
      const fallbackName = `${prefix}_${timestamp}${suffix}.${ext}`;
      pastedFiles.push(new File([file], fallbackName, { type: mime }));
    });

    // ★ B9 修复：长文本粘贴策略对齐竞品——默认进输入框可继续编辑，
    // 仅超长文本（>50k 字符）自动转附件；中等长度（>1k）给出内联「转为附件」建议。
    const text = clipboard.getData('text/plain') ?? '';
    let textConverted = false;
    if (text && text.length > INPUT_BAR_CONFIG.paste.longTextAutoAttachChars) {
      const filename = `pasted_${timestamp}.txt`;
      pastedFiles.push(new File([text], filename, { type: 'text/plain' }));
      textConverted = true;
    }

    if (pastedFiles.length === 0) {
      // 走浏览器默认粘贴（文本进输入框）；中等长度时挂出「转为附件」建议条
      if (text && text.length > INPUT_BAR_CONFIG.paste.longTextSuggestChars) {
        longPasteArmedRef.current = false;
        setLongPasteCandidate({ text });
      }
      return false;
    }

    event.preventDefault();
    event.stopPropagation();

    processFilesToAttachments(pastedFiles);

    if (textConverted) {
      showGlobalNotification(
        'info',
        t('chatV2:inputBar.longPaste.autoConverted', { chars: text.length })
      );
    }

    return true;
  }, [processFilesToAttachments, t]);

  // ★ 长文本粘贴建议条：转为附件（从输入框原位剥离该片段）
  const convertLongPasteToAttachment = useCallback(() => {
    if (!longPasteCandidate) return;
    const { text } = longPasteCandidate;
    setLongPasteCandidate(null);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    processFilesToAttachments([
      new File([text], `pasted_${timestamp}.txt`, { type: 'text/plain' }),
    ]);

    // 输入框中若仍包含该片段，原位剥离（不影响用户后续输入的其他内容）
    const index = inputValue.indexOf(text);
    if (index >= 0) {
      const nextValue = inputValue.slice(0, index) + inputValue.slice(index + text.length);
      onInputChange(nextValue);
      const textarea = textareaRef.current;
      if (textarea) {
        requestAnimationFrame(() => {
          textarea.setSelectionRange(index, index);
          setComposerCaretPos(index);
        });
      }
    }
  }, [longPasteCandidate, processFilesToAttachments, inputValue, onInputChange]);

  // 用户编辑掉粘贴片段 / 清空输入 / 切换会话后自动收起建议条。
  // armed 机制：粘贴默认行为落地（inputValue 首次包含该片段）后才开始监测移除，
  // 避免 onPaste 与 store 更新之间的时序差导致建议条被立即误清除。
  useEffect(() => {
    if (!longPasteCandidate) return;
    const included = inputValue.includes(longPasteCandidate.text);
    if (included) {
      longPasteArmedRef.current = true;
    } else if (longPasteArmedRef.current) {
      setLongPasteCandidate(null);
    }
  }, [inputValue, longPasteCandidate]);

  useEffect(() => {
    setLongPasteCandidate(null);
  }, [sessionSwitchKey]);

  // ========== 技能斜杠命令内联补全 ==========
  // 输入期即时补全 /skill-id（原先仅发送时解析，未知令牌会被原样发出）
  const skillSlash = useSkillSlashCommands({
    inputValue,
    caretPos: composerCaretPos,
    enabled: !(isStreaming && !queueEnabled),
    activeSkillIds,
  });

  // 补全应用：更新输入值并把光标精确落在补全令牌之后
  const applySkillSlashSelection = useCallback((index?: number) => {
    const result = skillSlash.applySelection(index);
    if (!result) return false;
    onInputChange(result.value);
    setComposerCaretPos(result.caret);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      requestAnimationFrame(() => {
        textarea.setSelectionRange(result.caret, result.caret);
      });
    }
    return true;
  }, [skillSlash, onInputChange]);

  // ========== 面板动画状态 ==========
  // 🔧 统一使用 useDeferredOpen 实现所有面板的弹出收起动画
  const attachmentPanelMotion = useDeferredOpen(panelStates.attachment);
  // ★ RAG面板已移至对话控制面板，不再需要独立的动画状态
  const modelPanelMotion = useDeferredOpen(panelStates.model);
  const advancedPanelMotion = useDeferredOpen(panelStates.advanced);
  const mcpPanelMotion = useDeferredOpen(panelStates.mcp);
  const skillPanelMotion = useDeferredOpen(panelStates.skill);

  // ========== 派生值 ==========
  // P1-3 触控目标：36px 视觉尺寸不变，触屏（pointer:coarse）用透明伪元素把
  // 命中区域扩到 ≥44px，避免改变桌面视觉密度
  const coarseHitAreaClass = "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-['']";
  // ★ M5：28px 级小控件（h-7 推理触发器等）需要更大的外扩量才能凑满 ≥44px
  const coarseHitAreaLgClass = "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']";
  const coarseHitAreaXlClass = "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']";
  const iconButtonClass = cn(
    'inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-shell-control)] text-[color:var(--button-utility-foreground)] transition-colors hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)] active:bg-[color:var(--button-utility-active)]',
    coarseHitAreaClass
  );
  const studyUiButtonBaseClassName =
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-ui font-medium leading-none tracking-[0.01em] transition-[background-color,border-color,color,box-shadow] duration-150 ease-out outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';
  const studyUiButtonSizeIconClassName =
    'h-[var(--button-icon-size)] w-[var(--button-icon-size)] rounded-[var(--button-radius)]';
  const studyUiSendButtonSizeClass =
    'h-11 w-11 !rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)]';
  const studyUiBlackActionButtonClass =
    '!border-black !bg-black hover:!bg-black active:!bg-black !text-white';
  const studyUiSendButtonEmptyStateClass =
    '!border-transparent !bg-muted !text-muted-foreground hover:!bg-muted/80 active:!bg-muted/70';
  const studyUiSendButtonAriaLabel = t('chatV2:inputBar.sendMessage');
  const tooltipPosition = 'top' as const;
  // 🔧 移动端禁用 tooltip（触摸设备没有 hover 交互，tooltip 会干扰）
  const tooltipDisabled = isMobile;
  const attachmentCount = attachments.length;
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
  const runtimeModelTitle = t('chatV2:inputBar.runtimeModelTitle', '模型');
  const chooseRuntimeModelLabel = t('chatV2:inputBar.chooseRuntimeModel', '选择模型');
  const runtimeModelSearchPlaceholder = t('chatV2:modelPicker.searchPlaceholder', '搜索名称或模型 ID...');
  const runtimeCompareModeLabel = t('chatV2:inputBar.runtimeModelCompareMode', '进入多选模式...');
  const fallbackRuntimeProviderLabel = t('chatV2:inputBar.runtimeModelOtherProvider', '其他');
  const runtimeModelAccessibleCurrent = runtimeModelLabel
    ? runtimeModelProviderLabel
      ? `${runtimeModelProviderLabel} / ${runtimeModelLabel}`
      : runtimeModelLabel
    : undefined;
  const runtimeModelSwitchLabel = runtimeModelAccessibleCurrent
    ? t('chatV2:inputBar.runtimeModelSwitchCurrent', '{{label}}，当前：{{current}}', {
        label: chooseRuntimeModelLabel,
        current: runtimeModelAccessibleCurrent,
      })
    : chooseRuntimeModelLabel;
  const runtimeModelSwitchTitle = runtimeModelAccessibleCurrent
    ? `${chooseRuntimeModelLabel}: ${runtimeModelAccessibleCurrent}`
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
  const hasRuntimeModelMenu = runtimeModelOptions.length > 0 || !!renderModelPanel;
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
  const hasText = inputValue.trim().length > 0;
  const hasAttachments = attachmentCount > 0;
  const hasContent = hasText || hasAttachments;
  const isComposerEmpty = !hasContent;

  // 🔧 检查是否有任何面板打开
  const hasAnyPanelOpen = COMPOSER_PANEL_KEYS.some((panel) => panelStates[panel]);
  const activeComposerPanel = COMPOSER_PANEL_KEYS.find((panel) => panelStates[panel]) ?? null;

  // 📱 P0-1 内联面板：各面板的动画状态映射 + 收起动画期间保留最后打开的面板，
  // 让移动端内联容器在 closing 阶段仍能渲染内容并播放收起动画
  const composerPanelMotions: Partial<Record<keyof PanelStates, DeferredPanelState>> = {
    attachment: attachmentPanelMotion,
    model: modelPanelMotion,
    advanced: advancedPanelMotion,
    mcp: mcpPanelMotion,
    skill: skillPanelMotion,
  };
  const lastComposerPanelRef = useRef<keyof PanelStates | null>(null);
  if (activeComposerPanel && composerPanelMotions[activeComposerPanel]) {
    lastComposerPanelRef.current = activeComposerPanel;
  }
  const inlineRenderPanel: keyof PanelStates | null = activeComposerPanel && composerPanelMotions[activeComposerPanel]
    ? activeComposerPanel
    : (lastComposerPanelRef.current && composerPanelMotions[lastComposerPanelRef.current]?.shouldRender
        ? lastComposerPanelRef.current
        : null);

  // 🔧 面板容器 ref，用于检测点击是否在面板内
  const panelContainerRef = useRef<HTMLDivElement>(null);
  const composerPanelOverlayRef = useRef<HTMLDivElement | null>(null);
  const runtimeModelTriggerRef = useRef<HTMLSpanElement | null>(null);

  // ⌨️ P0-2 焦点门控：追踪焦点是否落在 composer 区域内的任一可编辑元素上。
  // 判定范围放宽到输入壳 + 面板容器 + 桌面 overlay，保证在组合面板内的
  // 搜索框打字时 inset 不归零（旧实现要求 activeElement === textarea）。
  useEffect(() => {
    if (!isMobile) {
      setComposerEditableFocused(false);
      return;
    }

    const evaluate = () => {
      const active = document.activeElement;
      const withinComposer = !!active && (
        inputContainerRef.current?.contains(active)
        || panelContainerRef.current?.contains(active)
        || composerPanelOverlayRef.current?.contains(active)
        // ★ M3 修复：AppMenu 内容 portal 在 body 上（加号菜单 / 推理菜单里的
        // 模型搜索框），焦点落入其中时同样需要应用键盘 inset
        || !!(active instanceof Element && active.closest('[data-app-menu-id]'))
      );
      setComposerEditableFocused(Boolean(withinComposer && isEditableElement(active)));
    };

    evaluate();
    const handleFocusIn = () => evaluate();
    // blur 后焦点可能立刻移动到面板内的输入框，等下一帧再判定
    const handleFocusOut = () => {
      requestAnimationFrame(evaluate);
    };
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, [isMobile, sessionSwitchKey]);

  // 最终生效的键盘 inset：仅移动端 + composer 内可编辑元素聚焦时抬升
  const keyboardInsetPx = isMobile && composerEditableFocused ? globalKeyboardInset : 0;
  // 🔧 P1修复：检查是否有附件正在上传
  const hasUploadingAttachments = attachments.some(a => a.status === 'uploading' || a.status === 'pending');
  // 允许 ready 或 processing 但选中模式已就绪的附件发送
  const hasSendableAttachments = useMemo(() => {
    return attachments.some(att => {
      const mediaType = getMediaTypeForAttachment(att);
      if (!mediaType) return att.status === 'ready';

      const isPdf = mediaType === 'pdf';
      const isImage = mediaType === 'image';
      const selectedModes = getSelectedModes(att, isPdf, isImage);

      if (att.status !== 'ready' && att.status !== 'processing') return false;
      const status = att.sourceId ? (pdfStatusMap.get(att.sourceId) || att.processingStatus) : att.processingStatus;
      const readyModes = getEffectiveReadyModes(status, mediaType, att);
      return hasAnyReadyMode(selectedModes, readyModes);
    });
  }, [attachments, pdfStatusMap]);
  const canSendWithAttachments = hasText || hasSendableAttachments;

  // 🆕 检查 PDF/图片 附件的选中模式是否就绪
  // ★ P0 修复：传入 mediaType 参数，正确判断图片模式的默认就绪状态
  const hasProcessingMedia = useMemo(() => {
    return attachments.some(att => {
      const mediaType = getMediaTypeForAttachment(att);

      // 只处理 PDF 和图片
      if (!mediaType) return false;

      // ★ 跳过上传中的附件，避免误显示"部分模式未就绪"
      // 上传中的附件由 hasUploadingAttachments 处理
      if (att.status === 'uploading' || att.status === 'pending') return false;

      // 获取选中的注入模式和媒体类型
      const selectedModes = getSelectedModes(att, mediaType === 'pdf', mediaType === 'image');
      const status = att.sourceId ? (pdfStatusMap.get(att.sourceId) || att.processingStatus) : att.processingStatus;
      const readyModes = getEffectiveReadyModes(status, mediaType, att);
      return !hasAnyReadyMode(selectedModes, readyModes);
    });
  }, [attachments, pdfStatusMap]);

  const firstBlockingAttachment = useMemo(() => {
    for (const att of attachments) {
      const mediaType = getMediaTypeForAttachment(att);
      if (!mediaType) continue;
      // ★ 跳过上传中的附件，由 hasUploadingAttachments 处理
      if (att.status === 'uploading' || att.status === 'pending') continue;
      const selectedModes = getSelectedModes(att, mediaType === 'pdf', mediaType === 'image');
      const status = att.sourceId ? (pdfStatusMap.get(att.sourceId) || att.processingStatus) : att.processingStatus;
      const readyModes = getEffectiveReadyModes(status, mediaType, att);
      if (!hasAnyReadyMode(selectedModes, readyModes)) {
        const missingModes = getMissingModes(selectedModes, readyModes);
        return {
          name: att.name,
          missingModes,
          stage: status?.stage,
        };
      }
    }
    return null;
  }, [attachments, pdfStatusMap]);

  const sendBlockedReason = useMemo(() => {
    if (queueFull) return t('chatV2:queue.fullTooltip');
    if (disabledReason) return disabledReason;
    if (hasUploadingAttachments) {
      return t('chatV2:inputBar.attachmentsUploading');
    }
    if (firstBlockingAttachment) {
      const missingLabel = formatModeList(firstBlockingAttachment.missingModes);
      return missingLabel
        ? t('chatV2:inputBar.attachmentNotReady', {
          name: firstBlockingAttachment.name,
          modes: missingLabel,
        })
        : t('chatV2:inputBar.attachmentProcessing', {
          name: firstBlockingAttachment.name,
        });
    }
    return undefined;
  }, [queueFull, disabledReason, hasUploadingAttachments, firstBlockingAttachment, formatModeList, t]);

  const processingIndicatorLabel = useMemo(() => {
    if (!firstBlockingAttachment) return undefined;
    const missingLabel = formatModeList(firstBlockingAttachment.missingModes);
    return missingLabel
      ? t('chatV2:inputBar.processingIndicatorPartial')
      : t('chatV2:inputBar.processingIndicator');
  }, [firstBlockingAttachment, formatModeList, t]);

  // 使用 CSS 变量作为 Android fallback，iOS 正常使用 env()
  // ★ M1 修复：键盘弹出时 inset 已包含覆盖 home indicator 的高度，
  // 与 safe-area 相加会让输入栏悬空 ~34px；改为两者取 max
  const safeAreaExpr = 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))';
  const bottomGapValue = keyboardInsetPx > 0
    ? `calc(max(${safeAreaExpr}, ${keyboardInsetPx}px) + ${bottomGapPx}px)`
    : `calc(${safeAreaExpr} + ${bottomGapPx}px)`;
  // ★ 性能修复：渲染期不再实读 offsetHeight（每次渲染强制 layout），
  // 改读 ResizeObserver / adjustTextareaHeight 维护的缓存高度；
  // 首帧（observer 未回调）回退到初始占位高度或 96
  const measuredInputHeight = inputContainerHeight || 96;
  const dockedHeightWithGap = Math.max(0, Math.round(measuredInputHeight + bottomGapPx + keyboardInsetPx));
  const dockedHeightVarValue = `${dockedHeightWithGap}px`;

  // ========== 发送/停止按钮状态 ==========
  // 流式输出时始终优先展示 Stop，避免队列模式隐藏中断入口。
  const showStop = isStreaming;
  // 🆕 canSubmit 允许在 idle 或 队列模式下放行，未提供时退化到 canSend
  const effectiveCanSubmit = canSubmit ?? canSend;
  // 🔧 P1修复：附件上传中时禁用发送
  // 🆕 增加媒体处理中检查：选中的注入模式未就绪时也禁用发送
  // 🆕 队列模式：队列已满时禁用发送
  const disabledSend = showStop
    ? false
    : !!disabledReason || !canSendWithAttachments || !effectiveCanSubmit || hasUploadingAttachments || hasProcessingMedia || queueFull;

  // ========== 回调函数 ==========

  // ★ M4 修复：textarea 超过最大高度后由外层 wrapper 滚动，而 textarea 自身
  // overflow-hidden，浏览器不会自动把光标滚入可视区；这里用 ghost 元素量出
  // 光标底部 Y 偏移，手动同步 wrapper.scrollTop（等下一帧，等 viewport 高度状态生效）
  const scrollCaretIntoView = useCallback(() => {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      const ghost = ghostRef.current;
      const viewport = textareaScrollViewportRef.current;
      if (!textarea || !ghost || !viewport) return;
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      const caret = textarea.selectionEnd ?? textarea.value.length;
      // ghost 样式已由 adjustTextareaHeight 同步，只替换文本做一次测量后还原
      const prevText = ghost.textContent;
      ghost.textContent = textarea.value.slice(0, caret) + '\u200b';
      const caretBottom = ghost.scrollHeight;
      ghost.textContent = prevText;
      const lineHeight = 24;
      const top = viewport.scrollTop;
      const bottom = top + viewport.clientHeight;
      if (caretBottom > bottom) {
        viewport.scrollTop = caretBottom - viewport.clientHeight;
      } else if (caretBottom - lineHeight < top) {
        viewport.scrollTop = Math.max(0, caretBottom - lineHeight);
      }
    });
  }, []);

  // ★ 性能修复：ghost 的样式（font/padding/border 等）运行期基本不变，只有
  // width 会随窗口/面板尺寸变化。抽出为独立同步函数：首次测量时执行一次，
  // 之后仅在容器 resize 时（挂在下方 ResizeObserver 回调里）重新同步；
  // 按键路径只更新 ghost.textContent + 读 scrollHeight，
  // 不再每次按键 getComputedStyle + 逐条复制样式
  const ghostStylesSyncedRef = useRef(false);
  const syncGhostStyles = useCallback(() => {
    const textarea = textareaRef.current;
    const ghost = ghostRef.current;
    if (!textarea || !ghost) return;
    const styles = window.getComputedStyle(textarea);
    ghost.style.width = styles.width;
    ghost.style.padding = styles.padding;
    ghost.style.border = styles.border;
    ghost.style.boxSizing = styles.boxSizing;
    ghost.style.font = styles.font;
    ghost.style.lineHeight = styles.lineHeight;
    ghost.style.letterSpacing = styles.letterSpacing;
    ghost.style.whiteSpace = 'pre-wrap';
    ghost.style.wordWrap = 'break-word';
    ghostStylesSyncedRef.current = true;
  }, []);

  // 调整 textarea 高度
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    const ghost = ghostRef.current;
    const maxHeight = INPUT_BAR_CONFIG.heights.textareaMax;
    const minHeight = INPUT_BAR_CONFIG.heights.textareaMin;
    if (textarea && ghost) {
      if (!ghostStylesSyncedRef.current) {
        syncGhostStyles();
      }
      ghost.textContent = textarea.value + '\u200b';
      const contentHeight = Math.max(ghost.scrollHeight, minHeight);
      const targetViewportHeight = Math.min(contentHeight, maxHeight);
      textarea.style.height = `${contentHeight}px`;
      setTextareaViewportHeight(targetViewportHeight);
      if (inputContainerRef.current) {
        setInputContainerHeight(inputContainerRef.current.offsetHeight);
      }
    } else if (textarea) {
      textarea.style.height = 'auto';
      const contentHeight = Math.max(textarea.scrollHeight, minHeight);
      const targetViewportHeight = Math.min(contentHeight, maxHeight);
      textarea.style.height = `${contentHeight}px`;
      setTextareaViewportHeight(targetViewportHeight);
      if (inputContainerRef.current) {
        setInputContainerHeight(inputContainerRef.current.offsetHeight);
      }
    } else {
      setTextareaViewportHeight(minHeight);
    }
  }, [syncGhostStyles]);

  const { inputToolSlot: voiceInputToolSlot } = useVoiceInputIntegration({
    targetId: sessionId ? `chat-v2-input:${sessionId}` : 'chat-v2-input',
    textareaRef,
    inputValue,
    onInputChange,
    afterInsert: adjustTextareaHeight,
    disabled: isStreaming || !!disabledReason,
    t,
  });
  const resolvedInputToolSlot =
    inputToolSlot || voiceInputToolSlot ? (
      <>
        {inputToolSlot}
        {voiceInputToolSlot}
      </>
    ) : null;

  // IME 合成态检测
  // 覆盖三类场景：1) 标准 isComposing；2) Windows/旧 WebView 的 keyCode 229；
  // 3) Safari/WebKit 在 compositionend 之后才派发确认 Enter 的 keydown（isComposing 已为 false）
  const isImeComposing = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const anyNative = e.nativeEvent as any;
    return Boolean(
      (e as any).isComposing ||
      (anyNative && anyNative.isComposing) ||
      (e as any).which === 229 ||
      (anyNative && anyNative.keyCode === 229) ||
      isComposingRef.current ||
      compositionJustEndedRef.current
    );
  }, []);

  // 判断是否应该发送
  const shouldSendOnEnter = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // C-11: 移动端软键盘没有 Shift+Enter，Enter 应为换行，发送只走按钮
      //（与微信/Telegram 移动端心智一致）
      if (isMobile) return false;
      const mode = sendShortcut || 'enter';
      if (mode === 'enter') {
        return e.key === 'Enter' && !e.shiftKey && !isImeComposing(e);
      }
      return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isImeComposing(e);
    },
    [isMobile, sendShortcut, isImeComposing]
  );

  // 处理发送
  const handleSend = useCallback(() => {
    if (!canSendWithAttachments) {
      showGlobalNotification('warning', t('common:messages.error.empty_input'));
      return;
    }
    if (disabledSend) {
      // ★ 键盘 Enter 触发时按钮禁用态不可见，给出与 tooltip 一致的原因反馈
      if (sendBlockedReason) {
        showGlobalNotification('info', sendBlockedReason);
      }
      return;
    }
    // 发送即收起长文本粘贴建议条
    setLongPasteCandidate(null);
    // 🔧 P3修复：正确处理异步 onSend 的返回值，避免未捕获的 Promise rejection
    // 错误已在 TauriAdapter 中通过 showGlobalNotification 显示，这里只需要静默处理
    const result = onSend();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        // 错误已在上层处理，这里只是避免未捕获的 rejection 警告
      });
    }
  }, [canSendWithAttachments, disabledSend, sendBlockedReason, onSend, t]);

  // 处理停止
  const handleStop = useCallback(() => {
    if (canAbort) {
      // 🔧 P3修复：正确处理异步 onAbort 的返回值
      const result = onAbort();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          // 错误已在上层处理
        });
      }
    }
  }, [canAbort, onAbort]);

  // 处理文件选择上传
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      processFilesToAttachments(Array.from(files));

      // 清空 input 以便重复选择同一文件
      e.target.value = '';
    },
    [processFilesToAttachments]
  );

  // 🔧 关闭所有面板（点击外部时调用）
  const closeAllPanels = useCallback(() => {
    COMPOSER_PANEL_KEYS.forEach((panel) => {
      if (panelStates[panel]) {
        onSetPanelState(panel, false);
      }
    });
  }, [onSetPanelState, panelStates]);

  // 🔧 点击面板外部关闭面板（使用 document 事件监听，避免层叠上下文问题）
  useEffect(() => {
    if (!hasAnyPanelOpen) return;

    const handleClickOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      // 检查点击是否在面板容器内
      if (panelContainerRef.current?.contains(target)) {
        return; // 点击在面板内，不关闭
      }
      if (composerPanelOverlayRef.current?.contains(target)) {
        return; // Portal 面板内点击，不关闭
      }
      // 检查点击是否在输入栏内（包括按钮）
      if (inputContainerRef.current?.contains(target)) {
        return; // 点击在输入栏内，不关闭
      }
      // 点击在外部，关闭所有面板
      closeAllPanels();
    };

    // Esc 关闭面板：跳过已被内层浮层（菜单/对话框）消费的事件
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      closeAllPanels();
    };

    // pointerdown 同时覆盖鼠标与触摸（触摸场景不依赖合成 mouse 事件），且比 click 更早响应
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [hasAnyPanelOpen, closeAllPanels]);

  // 📱 Android 系统返回键：组合面板（附件/模型/技能/MCP/对话控制）打开时先关闭面板，
  // 与 Radix 浮层、MobileSlidingLayout 的返回键语义保持一致（A-5 体系补全）。
  const closeAllPanelsRef = useRef(closeAllPanels);
  closeAllPanelsRef.current = closeAllPanels;
  useEffect(() => {
    if (!isMobile || !hasAnyPanelOpen) return;
    return registerBackHandler(() => {
      closeAllPanelsRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isMobile, hasAnyPanelOpen]);

  // 组合面板 portal 在 body 上，宿主视图被切走（visibility:hidden）时不会随之隐藏；
  // 监听全局视图切换事件，切离 Chat 时收起所有面板，避免面板悬浮在新视图上方
  useEffect(() => {
    if (!hasAnyPanelOpen) return;
    const handleViewSwitched = () => closeAllPanelsRef.current();
    window.addEventListener('app:view-switched', handleViewSwitched);
    return () => window.removeEventListener('app:view-switched', handleViewSwitched);
  }, [hasAnyPanelOpen]);

  // 统一的面板切换函数，自动处理互斥逻辑
  const togglePanel = useCallback((panelName: keyof PanelStates) => {
    const currentState = panelStates[panelName];
    setIsAttachmentMenuOpen(false);
    modelMentionActions?.closeAutoComplete();

    if (!currentState) {
      COMPOSER_PANEL_KEYS.forEach(p => {
        if (p !== panelName && panelStates[p]) onSetPanelState(p, false);
      });
    }
    onSetPanelState(panelName, !currentState);
  }, [modelMentionActions, panelStates, onSetPanelState]);

  // 切换附件面板（使用统一函数）
  const toggleAttachmentPanel = useCallback(() => {
    togglePanel('attachment');
  }, [togglePanel]);

  const handleOpenRuntimeModelPanel = useCallback((mode: 'single' | 'compare' = 'single') => {
    setIsAttachmentMenuOpen(false);
    modelMentionActions?.closeAutoComplete();

    if (onOpenRuntimeModelPanel) {
      onOpenRuntimeModelPanel(mode);
      return;
    }
    togglePanel('model');
  }, [modelMentionActions, onOpenRuntimeModelPanel, renderModelPanel, togglePanel]);

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

  const handleAttachmentMenuOpenChange = useCallback((open: boolean) => {
    setIsAttachmentMenuOpen(open);
    if (open) {
      modelMentionActions?.closeAutoComplete();
      closeAllPanels();
    }
  }, [closeAllPanels, modelMentionActions]);

  const handleThinkingRuntimeMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      setIsAttachmentMenuOpen(false);
      modelMentionActions?.closeAutoComplete();
      closeAllPanels();
      setRuntimeModelSearch('');
      return;
    }
    setRuntimeModelSearch('');
  }, [closeAllPanels, modelMentionActions]);

  const handleAddAttachmentAction = useCallback(() => {
    setIsAttachmentMenuOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleOpenResourceLibrary = useCallback(() => {
    setIsAttachmentMenuOpen(false);
    window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_TOGGLE_PANEL));
  }, []);

  const handleOpenCameraAction = useCallback(() => {
    setIsAttachmentMenuOpen(false);
    handleCameraClick();
  }, [handleCameraClick]);

  // ★ 性能：以下回调传给已 memo 的 ComposerPlusMenu / ComposerToolButton，
  // 必须保持引用稳定（内联箭头函数会击穿 memo，导致每个按键重渲染整个菜单子树）
  const handleOpenSkillPanelAction = useCallback(() => {
    togglePanel('skill');
  }, [togglePanel]);
  const handleOpenMcpPanelAction = useCallback(() => {
    togglePanel('mcp');
  }, [togglePanel]);
  const handleToggleAdvancedPanel = useCallback(() => {
    togglePanel('advanced');
  }, [togglePanel]);
  const renderSkillPanelMenuVariant = useMemo(() => {
    if (!renderSkillPanel) return undefined;
    return () => renderSkillPanel({ variant: 'menu' });
  }, [renderSkillPanel]);

  // ========== Effects ==========

  // 监听内容变化调整高度
  useEffect(() => {
    adjustTextareaHeight();
  }, [inputValue, adjustTextareaHeight]);

  // 🔧 P2: 全局键盘快捷键支持
  // 注册在 document 上，处理后 stopPropagation 防止与命令系统双重执行
  // ★ B3 修复：togglePanel/onToggleThinking 走 ref，避免 effect deps 缺失导致
  //   用过期 panelStates 做互斥关闭（出现「关不掉 / 多面板同开」边缘态）
  // ★ B4 修复：本输入栏 textarea 聚焦时放行 ⌘⇧* 快捷键（对齐 Cursor/ChatGPT
  //   composer 内快捷键习惯）；其他可编辑区域与对话框内仍然跳过
  const togglePanelRef = useRef<(panel: keyof PanelStates) => void>(() => {});
  const onToggleThinkingRef = useRef(onToggleThinking);
  useEffect(() => {
    togglePanelRef.current = togglePanel;
  }, [togglePanel]);
  useEffect(() => {
    onToggleThinkingRef.current = onToggleThinking;
  }, [onToggleThinking]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 't' && key !== 'k' && key !== 'm' && key !== 's') return;

      const target = e.target;
      const isOwnComposer = target === textareaRef.current;
      const isEditableTarget = target instanceof Element && (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable) ||
        !!target.closest('[contenteditable="true"]')
      );
      const inModal = target instanceof Element && !!target.closest('[role="dialog"], [role="alertdialog"]');
      if ((isEditableTarget && !isOwnComposer) || inModal) return;

      // ⌘⇧T / Ctrl+Shift+T: 切换推理模式（覆盖全局 toggle-theme）
      if (key === 't') {
        e.preventDefault();
        e.stopPropagation();
        onToggleThinkingRef.current?.();
        return;
      }
      // ⌘⇧K / Ctrl+Shift+K: 切换知识库（RAG 设置已并入对话控制面板；
      // 独立 rag 面板 UI 已删除且无 mode 插件再注册 renderRagPanel，死分支已移除）
      if (key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        if (renderAdvancedPanel) {
          togglePanelRef.current('advanced');
        }
        return;
      }
      // ⌘⇧M / Ctrl+Shift+M: 切换 MCP 工具
      if (key === 'm') {
        e.preventDefault();
        e.stopPropagation();
        if (renderMcpPanel) {
          togglePanelRef.current('mcp');
        }
        return;
      }
      // ⌘⇧S / Ctrl+Shift+S: 打开加号菜单（技能已收入次级菜单）
      if (key === 's') {
        e.preventDefault();
        e.stopPropagation();
        if (renderSkillPanel) {
          setIsAttachmentMenuOpen(true);
        }
        return;
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [renderAdvancedPanel, renderMcpPanel, renderSkillPanel]);

  // ★ Bug2 修复：监听资源库注入事件，自动打开附件面板
  useEffect(() => {
    const handleOpenAttachmentPanel = () => {
      if (!panelStatesRef.current.attachment) {
        onSetPanelState('attachment', true);
      }
    };
    window.addEventListener('CHAT_V2_OPEN_ATTACHMENT_PANEL', handleOpenAttachmentPanel);
    return () => window.removeEventListener('CHAT_V2_OPEN_ATTACHMENT_PANEL', handleOpenAttachmentPanel);
  }, [onSetPanelState]);

  // 🔧 首帧轻量化 + 会话切换重置
  // 会话切换时重置 isReady，延迟 HEAVY_UI_DELAY_MS (400ms) 再启动重 UI/计算
  useEffect(() => {
    // 检测会话切换
    if (prevSessionSwitchKeyRef.current !== sessionSwitchKey) {
      prevSessionSwitchKeyRef.current = sessionSwitchKey;
      // 会话切换时重置 isReady，触发重新延迟
      setIsReady(false);
    }

    // idle 后再延迟挂载重 UI/计算（取消时必须同时清 idle + delay，避免 teardown 后 setState）
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const cancelIdle = scheduleIdle(() => {
      if (cancelled) return;
      delayTimer = setTimeout(() => {
        if (!cancelled) setIsReady(true);
      }, HEAVY_UI_DELAY_MS);
    });

    return () => {
      cancelled = true;
      cancelIdle();
      if (delayTimer) clearTimeout(delayTimer);
    };
  }, [sessionSwitchKey]);

  // ★ L2：isReady 后补投未就绪期间缓存的粘贴文件
  useEffect(() => {
    if (!isReady || pendingEarlyPasteRef.current.length === 0) return;
    const files = pendingEarlyPasteRef.current;
    pendingEarlyPasteRef.current = [];
    processFilesToAttachments(files);
  }, [isReady, processFilesToAttachments]);

  // 响应式 bottom gap + 移动端检测
  // ★ L7 修复：依赖 isMobile，避免 resize 闭包捕获初始断点值
  useEffect(() => {
    const handleResize = () => {
      const mobile = mobileLayout?.isMobile ?? (window.innerWidth < MOBILE_BREAKPOINT_PX);
      setBottomGapPx(mobile ? MOBILE_DOCK_GAP_PX : DESKTOP_DOCK_GAP_PX);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [mobileLayout?.isMobile]);

  // ⌨️ P0-2：键盘 inset 检测已统一到 useKeyboardInset 单例（见上方焦点门控），
  // 此处不再自管 visualViewport 监听

  useEffect(() => {
    if (!autoFocus || !isMobile) return;

    let disposed = false;
    const focusTextarea = () => {
      if (disposed) return;
      const textarea = textareaRef.current;
      if (!textarea) return;

      try {
        textarea.focus({ preventScroll: true });
      } catch {
        textarea.focus();
      }

      const selectionEnd = textarea.value.length;
      try {
        textarea.setSelectionRange(selectionEnd, selectionEnd);
      } catch {
        // Some mobile WebViews can reject selection updates during keyboard startup.
      }
    };

    const frame = requestAnimationFrame(focusTextarea);
    const timer = window.setTimeout(focusTextarea, 250);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [autoFocus, isMobile, sessionSwitchKey]);

  useEffect(() => {
    const focusTextarea = () => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      try {
        textarea.focus({ preventScroll: true });
      } catch {
        textarea.focus();
      }

      const selectionEnd = textarea.value.length;
      try {
        textarea.setSelectionRange(selectionEnd, selectionEnd);
      } catch {
        // Ignore selection failures from restrictive WebViews.
      }
    };

    const handleFocusInput = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId && detail.sessionId !== sessionId) {
        return;
      }

      requestAnimationFrame(focusTextarea);
      window.setTimeout(focusTextarea, 0);
    };

    window.addEventListener('CHAT_V2_FOCUS_INPUT', handleFocusInput);
    return () => {
      window.removeEventListener('CHAT_V2_FOCUS_INPUT', handleFocusInput);
    };
  }, [sessionId]);

  // 🔧 P1-25: 组件卸载 / 会话切换时释放所有 Blob URL，避免内存泄漏
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(att => {
        if (att.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl);
        }
      });
    };
  }, []);

  // ★ P2 优化：跟踪已同步的状态，避免重复更新
  const syncedStatusRef = useRef<Map<string, { stage: string; percent: number; readyCount: number }>>(new Map());
  const pollingInFlightRef = useRef(false);

  // ★ 超时保护：跟踪每个附件的累计轮询次数，防止无限轮询
  // key = sourceId, value = 累计轮询次数
  const pollingCountRef = useRef<Map<string, number>>(new Map());
  // 最大轮询次数：150 次 × 2 秒 ≈ 5 分钟
  const MAX_POLL_COUNT = 150;

  // 🆕 兜底轮询：避免事件丢失导致状态卡住
  // ★ 修复：依赖 attachments.length，新增 processing 附件时重新启动轮询
  useEffect(() => {
    let timerId: number | null = null;
    let stopped = false;

    const scheduleNext = (delayMs: number) => {
      if (stopped) return;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      timerId = window.setTimeout(pollStatuses, delayMs);
    };

    const pollStatuses = async () => {
      if (stopped) return;
      if (pollingInFlightRef.current) return;
      const currentAttachments = attachmentsRef.current;
      const processingAttachments = currentAttachments
        .filter(att => att.status === 'processing' && !!att.sourceId)
        .filter(att => getMediaTypeForAttachment(att) !== null);
      const fileIds = processingAttachments.map(att => att.sourceId as string);

      // ★ 修复：没有 processing 附件时完全停止轮询，不再空转
      if (fileIds.length === 0) {
        return;
      }

      // ★ 超时保护：检查是否有附件超过最大轮询次数
      const timedOutAttachments: typeof processingAttachments = [];
      const activeFileIds: string[] = [];

      for (const att of processingAttachments) {
        const sourceId = att.sourceId as string;
        const count = (pollingCountRef.current.get(sourceId) || 0) + 1;
        pollingCountRef.current.set(sourceId, count);

        if (count > MAX_POLL_COUNT) {
          timedOutAttachments.push(att);
        } else {
          activeFileIds.push(sourceId);
        }
      }

      // 将超时的附件标记为 error 状态
      for (const att of timedOutAttachments) {
        const sourceId = att.sourceId as string;
        pollingCountRef.current.delete(sourceId);
        logAttachment('poll', 'polling_timeout', {
          attachmentId: att.id,
          sourceId,
          maxPollCount: MAX_POLL_COUNT,
        }, 'warning');
        onUpdateAttachment(att.id, {
          status: 'error',
          error: t('chatV2:inputBar.processingTimeout'),
          processingStatus: {
            stage: 'error',
            percent: 0,
            readyModes: [],
            error: 'Processing timed out after 5 minutes',
            mediaType: getMediaTypeForAttachment(att) ?? 'image',
          },
        });
      }

      // 如果所有附件都已超时，停止轮询
      if (activeFileIds.length === 0) {
        return;
      }

      pollingInFlightRef.current = true;
      try {
        const result = await getBatchPdfProcessingStatus(activeFileIds);
        const statuses = result.statuses || {};
        Object.entries(statuses).forEach(([fileId, status]) => {
          usePdfProcessingStore.getState().update(fileId, {
            stage: status.stage,
            currentPage: status.currentPage,
            totalPages: status.totalPages,
            percent: status.percent ?? 0,
            readyModes: (status.readyModes || []) as Array<'text' | 'ocr' | 'image'>,
          });
          // 处理完成或出错时清理轮询计数
          if (status.stage === 'completed' || status.stage === 'completed_with_issues' || status.stage === 'error') {
            pollingCountRef.current.delete(fileId);
          }
        });
      } catch {
        // 轮询失败不打断主流程
      } finally {
        pollingInFlightRef.current = false;
        scheduleNext(2000);
      }
    };

    pollStatuses();
    const handleVisibility = () => {
      if (!document.hidden) {
        pollStatuses();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopped = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      document.removeEventListener('visibilitychange', handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments.length]);

  // 🆕 监听媒体处理完成事件，更新附件状态为 ready
  // ★ P1 修复：同时处理 PDF 和图片附件
  // ★ P2 优化：添加值比较，只在状态变化时更新
  // ★ P0 修复：清理已删除附件的同步状态，防止内存泄漏
  useEffect(() => {
    const currentAttachments = attachmentsRef.current;
    const syncedStatus = syncedStatusRef.current;

    // ★ P0 修复：清理已删除附件的同步状态
    const currentAttachmentIds = new Set(currentAttachments.map(a => a.id));
    for (const [attachmentId] of syncedStatus) {
      if (!currentAttachmentIds.has(attachmentId)) {
        syncedStatus.delete(attachmentId);
      }
    }

    currentAttachments.forEach(att => {
      // 只处理 processing 状态的附件
      if (att.status !== 'processing') return;
      // ★ P0 修复：使用 sourceId (file_id) 作为 key，与后端事件保持一致
      if (!att.sourceId) return;

      // ★ P1 修复：同时处理 PDF 和图片（SSOT 媒体识别：MIME OR 扩展名）
      const attMediaType = getMediaTypeForAttachment(att);
      if (!attMediaType) return;
      const isPdf = attMediaType === 'pdf';

      // ★ P0 修复：使用 sourceId 查询 Store
      const status = pdfStatusMap.get(att.sourceId);
      if (!status) return;

      // ★ P2 优化：比较新旧状态，只在变化时更新
      const lastSynced = syncedStatus.get(att.id);
      const currentStage = status.stage;
      const currentPercent = Math.round(status.percent || 0);
      const currentReadyCount = status.readyModes?.length ?? 0;

      // 如果状态未变化，跳过更新（允许 5% 的进度容差，减少中间状态更新频率）
      // ★ 修复：readyModes 数量变更必须同步，否则 UI 会持有过时的就绪状态
      if (lastSynced &&
        lastSynced.stage === currentStage &&
        Math.abs(lastSynced.percent - currentPercent) < 5 &&
        lastSynced.readyCount === currentReadyCount &&
        currentStage !== 'completed' &&
        currentStage !== 'error') {
        return;
      }

      // 更新已同步状态
      syncedStatus.set(att.id, { stage: currentStage, percent: currentPercent, readyCount: currentReadyCount });

      const mediaTypeLabel = isPdf
        ? t('chatV2:inputBar.mediaType.pdf')
        : t('chatV2:inputBar.mediaType.image');

      if (status.stage === 'completed' || status.stage === 'completed_with_issues') {
        // 完成时清理同步状态
        syncedStatus.delete(att.id);
        // ★ 调试日志：状态同步 - 完成
        logAttachment('store', 'status_sync_completed', {
          attachmentId: att.id,
          sourceId: att.sourceId,
          mediaType: isPdf ? 'pdf' : 'image',
          readyModes: status.readyModes,
        });
        onUpdateAttachment(att.id, {
          status: 'ready',
          processingStatus: {
            stage: status.stage,
            percent: 100,
            readyModes: status.readyModes,
            mediaType: isPdf ? 'pdf' : 'image',
          },
        });
      } else if (status.stage === 'error') {
        // 错误时清理同步状态
        syncedStatus.delete(att.id);
        // ★ 调试日志：状态同步 - 错误
        logAttachment('store', 'status_sync_error', {
          attachmentId: att.id,
          sourceId: att.sourceId,
          mediaType: isPdf ? 'pdf' : 'image',
          error: status.error,
        }, 'error');
        onUpdateAttachment(att.id, {
          status: 'error',
          error: status.error || t('chatV2:inputBar.mediaProcessingFailed', { type: mediaTypeLabel }),
          processingStatus: {
            stage: 'error',
            percent: status.percent || 0,
            readyModes: status.readyModes || [],
            error: status.error,
            mediaType: isPdf ? 'pdf' : 'image',
          },
        });
      } else {
        // ★ 调试日志：状态同步 - 进度更新
        logAttachment('store', 'status_sync_progress', {
          attachmentId: att.id,
          sourceId: att.sourceId,
          mediaType: isPdf ? 'pdf' : 'image',
          stage: status.stage,
          percent: Math.round(status.percent || 0),
          readyModes: status.readyModes || [],
        });
        // 中间状态更新
        onUpdateAttachment(att.id, {
          processingStatus: {
            stage: status.stage as 'page_rendering' | 'page_compression' | 'ocr_processing' | 'vector_indexing' | 'image_compression' | 'completed_with_issues',
            percent: status.percent || 0,
            readyModes: status.readyModes || [],
            mediaType: isPdf ? 'pdf' : 'image',
            currentPage: status.currentPage,
            totalPages: status.totalPages,
          },
        });
      }
    });
  }, [pdfStatusMap, onUpdateAttachment, t]); // 移除 attachments 依赖

  // 🔧 测量容器高度（延迟启动 ResizeObserver）
  useEffect(() => {
    const el = inputContainerRef.current;
    if (!el) return;

    let observer: ResizeObserver | null = null;
    let isDisposed = false;

    // 🔧 首帧不触发 ResizeObserver，idle 后才启动
    scheduleIdle(() => {
      if (isDisposed || !el) return;

      // 首次测量
      const initialHeight = el.offsetHeight;
      lastMeasuredHeightRef.current = initialHeight;
      setInputContainerHeight(initialHeight);
      // ★ ghost 样式兜底同步一次（覆盖 observer 启动前窗口已 resize 的窗口期）
      syncGhostStyles();

      // 启动 ResizeObserver
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const h = Math.round(entry?.contentRect?.height || el.offsetHeight);

        // ★ 容器尺寸变化（含宽度变化）时重新同步 ghost 样式，
        // 保证 ghost.width 跟随 textarea 实际宽度（resize 低频，成本可接受）
        syncGhostStyles();

        // 🔧 限频：只有高度变化超过阈值才更新状态
        const delta = Math.abs(h - lastMeasuredHeightRef.current);
        if (delta >= HEIGHT_CHANGE_THRESHOLD) {
          lastMeasuredHeightRef.current = h;
          setInputContainerHeight(h);
        }
      });
      observer.observe(el);
    });

    return () => {
      isDisposed = true;
      if (observer) observer.disconnect();
    };
  }, [syncGhostStyles]);

  // ⌨️ P0-2 键盘统一契约：把输入栏整体停靠高度与键盘 inset 写到 document root，
  // 供消息列表（输入栏的兄弟节点，读不到 inline style 变量）计算底部避让：
  //   --unified-input-docked-height: 输入栏总高（含底部安全区 gap 与键盘 inset）
  //   --unified-input-keyboard-inset: 仅键盘 inset 部分
  //（inline style 上的同名变量仍保留，供输入栏子树内的既有 CSS 消费；
  //  root 变量只影响 var() 消费方的样式重算，不触发全局重排）
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--unified-input-docked-height', dockedHeightVarValue);
    root.style.setProperty('--unified-input-keyboard-inset', `${keyboardInsetPx}px`);
    // ★ 全局契约：输入栏实际停靠高度（含底部 gap 与键盘 inset），
    // 供聊天模块之外的悬浮组件（如全局番茄钟药丸）做底部避让；
    // 高度来源是 inputContainer 的 ResizeObserver 测量（见 inputContainerHeight）
    root.style.setProperty('--composer-dock-height', dockedHeightVarValue);
    return () => {
      root.style.removeProperty('--unified-input-docked-height');
      root.style.removeProperty('--unified-input-keyboard-inset');
      root.style.removeProperty('--composer-dock-height');
    };
  }, [dockedHeightVarValue, keyboardInsetPx]);

  // ========== 附件面板内容（桌面 overlay 与移动端内联共用） ==========

  // ★ 错误态重试：附件面板与预览 chips 共用（chip 上的内联重试入口）
  const handleRetryAttachment = useCallback(async (attachment: AttachmentMeta) => {
    if (!attachment.sourceId) return;
    try {
      const fileId = attachment.sourceId;
      const isPdfRetry = getMediaTypeForAttachment(attachment) === 'pdf';
      logAttachment('ui', 'retry_processing_start', {
        attachmentId: attachment.id,
        sourceId: fileId,
        mediaType: isPdfRetry ? 'pdf' : 'image',
        previousError: attachment.error,
      });
      onUpdateAttachment(attachment.id, {
        status: 'processing',
        error: undefined,
        processingStatus: {
          stage: isPdfRetry ? 'ocr_processing' : 'image_compression',
          percent: isPdfRetry ? 50 : 10,
          readyModes: attachment.processingStatus?.readyModes || [],
          mediaType: isPdfRetry ? 'pdf' : 'image',
        },
      });
      await retryPdfProcessing(fileId);
      logAttachment('ui', 'retry_processing_triggered', {
        attachmentId: attachment.id,
        sourceId: fileId,
      }, 'success');
      showGlobalNotification('success', t('chatV2:inputBar.retryStarted'));
    } catch (error) {
      logAttachment('ui', 'retry_processing_failed', {
        attachmentId: attachment.id,
        error: getErrorMessage(error),
      }, 'error');
      const retryErrorMsg = t('chatV2:inputBar.retryFailed', { error: getErrorMessage(error) });
      onUpdateAttachment(attachment.id, {
        status: 'error',
        error: retryErrorMsg,
      });
      showGlobalNotification('error', retryErrorMsg);
    }
  }, [onUpdateAttachment, t]);

  // ★ 性能修复：memo 子组件（AttachmentPreviewChips / AttachmentInjectModeSelector）
  // 的回调用 useCallback 稳定引用，避免内联箭头每次渲染换新引用击穿 memo
  const handleRetryAttachmentChip = useCallback((attachment: AttachmentMeta) => {
    void handleRetryAttachment(attachment);
  }, [handleRetryAttachment]);

  const handleInjectModesChange = useCallback((attachmentId: string, modes: AttachmentInjectModes) => {
    onUpdateAttachment(attachmentId, { injectModes: modes });
  }, [onUpdateAttachment]);

  const handleClearAllAttachments = () => {
    attachments.forEach(att => {
      if (att.sourceId) {
        void cancelPdfProcessing(att.sourceId).catch((error) => {
          logAttachment('ui', 'cancel_processing_failed', {
            attachmentId: att.id,
            sourceId: att.sourceId,
            error: getErrorMessage(error),
          }, 'warning');
        });
      }
      if (att.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(att.previewUrl);
      }
    });
    onClearAttachments();
  };

  const renderAttachmentPanelBody = () => (
    <>
      {/* 面板头部：桌面横排全部操作；移动端折叠为 标题 + ⋯更多 + 关闭（P1-4） */}
      {isMobile ? (
        <div className="mb-2 flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
            <Paperclip size={16} weight="bold" className="shrink-0" />
            <span className="truncate">{t('analysis:input_bar.attachments.title')} ({attachments.length})</span>
          </div>
          <div className="flex shrink-0 items-center">
            <DsButton
              variant="outline"
              size="sm"
              className="!h-11 min-w-11"
              onClick={() => fileInputRef.current?.click()}
            >
              + {t('analysis:input_bar.attachments.add')}
            </DsButton>
            <AppMenu>
              <AppMenuTrigger asChild>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="!h-11 !w-11"
                  aria-label={t('common:actions.more', '更多')}
                  data-testid="attachment-panel-more"
                >
                  <DotsThree size={20} weight="bold" />
                </DsButton>
              </AppMenuTrigger>
              <AppMenuContent align="end" width={200}>
                <AppMenuItem
                  className="min-h-[44px]"
                  icon={<FolderOpen className="w-4 h-4" weight="bold" />}
                  onClick={handleOpenResourceLibrary}
                >
                  {t('chatV2:inputBar.resourceLibrary')}
                </AppMenuItem>
                {isMobileEnv && (
                  <AppMenuItem
                    className="min-h-[44px]"
                    icon={<Camera className="w-4 h-4" weight="bold" />}
                    onClick={handleCameraClick}
                  >
                    {t('chatV2:inputBar.camera')}
                  </AppMenuItem>
                )}
                {attachments.length > 0 && (
                  <AppMenuItem
                    className="min-h-[44px]"
                    icon={<Trash className="w-4 h-4" weight="bold" />}
                    destructive
                    onClick={handleClearAllAttachments}
                  >
                    {t('analysis:input_bar.attachments.clear_all')}
                  </AppMenuItem>
                )}
              </AppMenuContent>
            </AppMenu>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="!h-11 !w-11"
              onClick={toggleAttachmentPanel}
              aria-label={t('common:actions.close')}
            >
              <X size={16} />
            </DsButton>
          </div>
        </div>
      ) : (
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Paperclip size={16} weight="bold" />
            <span>{t('analysis:input_bar.attachments.title')} ({attachments.length})</span>
          </div>
          <div className="flex items-center gap-2">
            <DsButton variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              + {t('analysis:input_bar.attachments.add')}
            </DsButton>
            {/* 资源库按钮 - 桌面端在右侧打开 Learning Hub 面板，移动端打开右侧滑屏 */}
            <DsButton
              variant="outline"
              size="sm"
              onClick={handleOpenResourceLibrary}
            >
              <FolderOpen size={12} weight="bold" />
              {t('chatV2:inputBar.resourceLibrary')}
            </DsButton>
            {isMobileEnv && (
              <DsButton variant="outline" size="sm" onClick={handleCameraClick}>
                <Camera size={12} weight="bold" />
                {t('chatV2:inputBar.camera')}
              </DsButton>
            )}
            {attachments.length > 0 && (
              <DsButton variant="danger" size="sm" onClick={handleClearAllAttachments}>
                {t('analysis:input_bar.attachments.clear_all')}
              </DsButton>
            )}
            <DsButton variant="ghost" size="sm" onClick={toggleAttachmentPanel}>
              {t('common:actions.close')}
            </DsButton>
          </div>
        </div>
      )}

      {/* 附件列表 */}
      <CustomScrollArea viewportClassName="max-h-56" className="flex flex-col gap-2">
        {attachments.length === 0 ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-[color:var(--composer-panel-control-border)] bg-[color:var(--composer-panel-muted-surface)] px-3 py-6 text-sm text-[color:var(--composer-panel-muted-foreground)]">
            {t('analysis:input_bar.attachments.empty')}
          </div>
        ) : (
          attachments.map((attachment) => {
            const isVfsRef = attachment.id.startsWith('vfs-');
            const sizeLabel = isVfsRef ? t('analysis:input_bar.attachments.reference') : `${(attachment.size / 1024).toFixed(1)} KB`;

            // 判断媒体类型（SSOT：MIME OR 扩展名；type === 'image' 作为兜底）
            const rowMediaType = getMediaTypeForAttachment(attachment)
              ?? (attachment.type === 'image' ? 'image' : null);
            const isPdf = rowMediaType === 'pdf';
            const isImage = rowMediaType === 'image';

            // 🆕 媒体处理中状态显示（PDF + 图片）
            const isPdfProcessing = isPdf && attachment.status === 'processing';
            const isImageProcessing = isImage && attachment.status === 'processing';
            const isMediaProcessing = isPdfProcessing || isImageProcessing;
            // 🔧 优化：优先使用 Store 中的最新状态
            // ★ P0 修复：使用 sourceId (file_id) 作为 key，与后端事件保持一致
            const storeStatus = isMediaProcessing && attachment.sourceId
              ? pdfStatusMap.get(attachment.sourceId)
              : undefined;
            // 类型兼容处理：Store 的 stage 包含 'pending'，需要转换为 common.ts 的类型
            const mediaProgress = storeStatus
              ? {
                ...storeStatus,
                stage: storeStatus.stage === 'pending' ? undefined : storeStatus.stage,
              } as typeof attachment.processingStatus
              : (isMediaProcessing ? attachment.processingStatus : undefined);
            const selectedModes = getSelectedModes(attachment, isPdf, isImage);
            const mediaType = isPdf ? 'pdf' : 'image';
            const statusForModes = attachment.status === 'ready'
              ? attachment.processingStatus
              : mediaProgress;
            const readyModes = getEffectiveReadyModes(statusForModes, mediaType, attachment);
            const missingModes = getMissingModes(selectedModes, readyModes);
            const missingModesLabel = missingModes.length > 0 ? formatModeList(missingModes) : '';
            const displayPercent = getDisplayPercent(mediaProgress, isPdf);
            let stageLabel = getStageLabel(t, mediaProgress, isPdf, isImage);
            if ((mediaProgress?.stage === 'completed' || mediaProgress?.stage === 'completed_with_issues') && missingModesLabel) {
              stageLabel = t('chatV2:inputBar.completedMissingModes', {
                modes: missingModesLabel,
              });
            }
            const isUploading = attachment.status === 'uploading' || attachment.status === 'pending';
            // ★ 视觉统一：状态色改走语义 token（success/warning/destructive/info），
            // 亮暗色由 token 自适应，不再散落 Tailwind 调色板 + dark: 补丁
            const statusIcon =
              attachment.status === 'ready' && missingModes.length > 0
                ? <Warning size={12} weight="bold" className="text-warning" />
                : attachment.status === 'ready' ? <CheckCircle size={12} weight="fill" className="text-success" />
                  : attachment.status === 'error' ? <XCircle size={12} weight="fill" className="text-destructive" />
                    : (isMediaProcessing || isUploading) ? <CircleNotch size={12} weight="bold" className="text-info animate-spin motion-reduce:animate-none" />
                      : <Clock size={12} weight="bold" className="text-muted-foreground" />;
            const toneClass = isVfsRef
              ? 'border-info/25 bg-info/10'
              : attachment.status === 'error' ? 'border-destructive/25 bg-destructive/10'
                : attachment.status === 'ready' && missingModes.length > 0
                  ? 'border-warning/25 bg-warning/10'
                  : attachment.status === 'ready' ? 'border-success/25 bg-success/10'
                    : (isMediaProcessing || isUploading) ? 'border-info/25 bg-info/10'
                      : 'border-[color:var(--composer-panel-control-border)] bg-[color:var(--composer-panel-control-surface)]';

            // 判断是否为图片或 PDF（需要显示注入模式选择器）
            const showInjectModeSelector = isImage || isPdf;

            return (
              <div key={attachment.id} data-wb-blur-surface className={cn('attachment-row flex flex-col gap-1.5 rounded-lg border backdrop-blur p-2 transition-colors duration-200 ease-out hover:bg-[color:var(--composer-panel-control-hover)] focus-within:border-[color:var(--composer-panel-focus-border)] motion-reduce:transition-none', toneClass)}>
                {/* 第一行：文件名、大小、状态、移除按钮 */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-ui text-foreground truncate block">{attachment.name}</span>
                    {attachment.status === 'error' && attachment.error && <span className="text-[11px] text-destructive truncate block">{attachment.error}</span>}
                    {/* 🆕 统一进度条：上传(0-50%) + 处理(50-100%) */}
                    {(() => {
                      // 计算统一进度百分比和阶段标签
                      let unifiedPercent: number | null = null;
                      let unifiedLabel = '';

                      if (isUploading && attachment.uploadProgress != null) {
                        // 上传阶段：直接使用 uploadProgress (0-50%)
                        unifiedPercent = attachment.uploadProgress;
                        unifiedLabel = t(`chatV2:inputBar.uploadStage.${attachment.uploadStage || 'reading'}`);
                      } else if (isMediaProcessing && mediaProgress) {
                        // 处理阶段：后端 0-100% 映射到 50-100%
                        unifiedPercent = 50 + Math.round(displayPercent * 0.5);
                        unifiedLabel = stageLabel || '';
                      }

                      if (unifiedPercent == null) return null;

                      return (
                        <div className="flex items-center gap-2 mt-0.5">
                          <div className="flex-1 h-1 rounded-full bg-[color:var(--composer-panel-muted-surface)] overflow-hidden">
                            <div
                              className="h-full bg-info transition-[width] duration-300 motion-reduce:transition-none"
                              style={{ width: `${unifiedPercent}%` }}
                            />
                          </div>
                          <span className="text-2xs text-info whitespace-nowrap">
                            {unifiedLabel}{unifiedPercent > 0 ? ` · ${unifiedPercent}%` : ''}
                          </span>
                        </div>
                      );
                    })()}
                    {missingModesLabel && !isUploading && (
                      <div className="mt-0.5 text-2xs text-warning">
                        {t('chatV2:inputBar.modesNotReady', { modes: missingModesLabel })}
                      </div>
                    )}
                  </div>
                  <span className={cn("text-[12px]", isVfsRef ? "text-info font-medium" : "text-muted-foreground")}>{sizeLabel}</span>
                  <span className="flex items-center gap-1">{statusIcon}</span>
                  {/* ★ P0 修复：错误状态时显示重试按钮（使用正确的 sourceId） */}
                  {attachment.status === 'error' && attachment.sourceId && (
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => { void handleRetryAttachment(attachment); }}
                      className="text-info"
                    >
                      {t('common:retry')}
                    </DsButton>
                  )}
                  <DsButton variant="danger" size="sm" onClick={() => {
                    logAttachment('ui', 'attachment_remove', {
                      attachmentId: attachment.id,
                      sourceId: attachment.sourceId,
                      fileName: attachment.name,
                      status: attachment.status,
                    });
                    if (attachment.sourceId) {
                      void cancelPdfProcessing(attachment.sourceId).catch((error) => {
                        logAttachment('ui', 'cancel_processing_failed', {
                          attachmentId: attachment.id,
                          sourceId: attachment.sourceId,
                          error: getErrorMessage(error),
                        }, 'warning');
                      });
                    }
                    if (attachment.previewUrl?.startsWith('blob:')) {
                      URL.revokeObjectURL(attachment.previewUrl);
                    }
                    onRemoveAttachment(attachment.id);
                  }}>
                    {t('analysis:input_bar.attachments.remove')}
                  </DsButton>
                </div>
                {/* 第二行：注入模式选择器（仅图片和 PDF 显示，PDF 在处理中也显示） */}
                {showInjectModeSelector && (attachment.status === 'ready' || isMediaProcessing) && (
                  <div className="flex items-center gap-2 pl-1">
                    <span className="text-[11px] text-muted-foreground">{t('chatV2:injectMode.label')}:</span>
                    <AttachmentInjectModeSelector
                      attachment={attachment}
                      onInjectModesChange={handleInjectModesChange}
                      disabled={attachment.status !== 'ready' && !isMediaProcessing}
                      processingStatus={mediaProgress}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </CustomScrollArea>
    </>
  );

  // ========== 📱 P0-1 移动端内联面板节点 ==========
  // 面板在输入壳内部、输入区上方随文档流展开（顶起消息区），
  // 替代桌面端的 createPortal + fixed 浮层；关闭沿用 Android 返回键 +
  // 点输入区外收起（closeAllPanels）。
  let inlineComposerPanelNode: React.ReactNode = null;
  if (isMobile && inlineRenderPanel) {
    const inlineMotion = composerPanelMotions[inlineRenderPanel];
    if (inlineMotion?.shouldRender) {
      let inlineContent: React.ReactNode = null;
      let inlineHeightMode: 'content' | 'available' = 'content';
      let inlineMaxHeight = 420;
      let inlineAriaLabel = '';
      switch (inlineRenderPanel) {
        case 'attachment':
          inlineContent = renderAttachmentPanelBody();
          inlineMaxHeight = 400;
          inlineAriaLabel = t('analysis:input_bar.attachments.title');
          break;
        case 'model':
          inlineContent = renderModelPanel ? renderModelPanel() : null;
          inlineHeightMode = 'available';
          // 📱 模型列表通常较长：上限放宽到 520px（实际仍受 85vh/键盘 clamp 约束），
          // 配合 ModelPicker 紧凑搜索框给列表更多可视空间
          inlineMaxHeight = 520;
          inlineAriaLabel = runtimeModelTitle;
          break;
        case 'mcp':
          inlineContent = renderMcpPanel ? renderMcpPanel() : null;
          inlineHeightMode = 'available';
          inlineMaxHeight = 460;
          inlineAriaLabel = 'MCP';
          break;
        case 'advanced':
          inlineContent = renderAdvancedPanel ? renderAdvancedPanel() : null;
          // AdvancedPanel 移动端内部是 h-full + flex-1 滚动结构，需要确定高度
          inlineHeightMode = 'available';
          inlineMaxHeight = 460;
          inlineAriaLabel = t('common:chat_controls');
          break;
        case 'skill':
          inlineContent = renderSkillPanel ? renderSkillPanel() : null;
          inlineHeightMode = 'available';
          inlineMaxHeight = 480;
          inlineAriaLabel = 'Skills';
          break;
        default:
          break;
      }
      if (inlineContent) {
        inlineComposerPanelNode = (
          // ★ H1 修复：壳体去掉 overflow-hidden 后，内联面板改由自身包装层
          // 负责负 margin 贴边与顶部圆角裁切（rounded-t 继承壳体 22px 圆角）
          <div className="-mx-3 -mt-2.5 overflow-hidden rounded-t-[inherit]">
            <ComposerInlinePanel
              panelKey={inlineRenderPanel}
              motionState={inlineMotion.motionState}
              heightMode={inlineHeightMode}
              maxHeight={inlineMaxHeight}
              ariaLabel={inlineAriaLabel}
              bodyClassName="mb-2.5 border-b border-[color:var(--composer-panel-border)] px-3 pb-3 pt-3"
            >
              {inlineContent}
            </ComposerInlinePanel>
          </div>
        );
      }
    }
  }

  // ========== 渲染 ==========

  return (
    <div
      ref={dropZoneRef}
      data-testid="input-bar-v2-root"
      className={cn(
        // 🎨 布局分离：作为 flex 子项，relative 用于面板定位
        // 🔧 P0修复：移除 ring 样式，避免拖拽时显示难看的实心边框
        // 层级契约：z-[100] = Z_INDEX.inputBar；isolate 建立局部层叠上下文，
        // 内部的 z-[200] 壳体（= inputBarInner，自身又是一层上下文，包着
        // 补全弹层 150 = inputBarPopover 与拖拽遮罩 300 = inputBarDragOverlay）
        // 只在此上下文内比较，对外整体以 100 参与排序（低于移动顶栏 1100，符合设计）。
        // Tailwind 任意值无法引用 TS 常量，改档位时请与 src/config/zIndex.ts 同步。
        'relative isolate z-[100] w-full flex-shrink-0 px-4 pt-2.5 transition-all duration-500 ease-out unified-input-docked md:px-8 md:pb-4',
        className
      )}
      style={{
        // 🎨 和侧边栏 scroll-fade 共用 color-mix 三段式曲线（覆盖在消息列表上方生效，此处仅保留纯色）
        background: `var(--shell-workspace-panel)`,
        // 🎨 移动端底部安全区 + 导航栏间距（使用 bottomGapValue 同时包含安全区域和导航栏高度）
        paddingBottom: isMobile && !mobileLayout?.isFullscreenContent ? bottomGapValue : '8px',
        ['--unified-input-docked-height' as any]: dockedHeightVarValue,
        ['--unified-input-bottom-gap' as any]: bottomGapValue,
        ['--unified-input-keyboard-inset' as any]: `${keyboardInsetPx}px`,
      }}
      {...dropZoneProps}
    >
      <ThreadContentShell>
        {/* study-ui 对齐：输入区回到安静的居中 composer，而不是漂浮玻璃卡片。 */}
        <div
          ref={inputContainerRef}
          data-composer-panel-anchor
          className={cn(
            // ★ H1 修复：壳体不再 overflow-hidden（会把壳内 absolute 定位的
            // 斜杠技能 / @模型提及补全弹层整体裁掉）；内联面板的圆角裁切
            // 已下放到面板自身的包装层（见 inlineComposerPanelNode）
            // z-[200] = Z_INDEX.inputBarInner（根容器 isolate 局部层级，见根节点注释）
            'relative z-[200] border transition-[background-color,border-color,box-shadow] duration-150 ease-out',
            isMobile
              ? 'rounded-[22px] border-[color:var(--composer-panel-border)] bg-[color:var(--surface-root)] px-3 py-2.5 shadow-[0_10px_24px_hsl(var(--shadow-base)/0.05)] focus-within:shadow-[0_14px_28px_hsl(var(--shadow-base)/0.07)]'
              : 'rounded-[var(--radius-shell-toolbar)] border-[color:var(--input-shell-border)] bg-[color:var(--unified-input-shell-surface,var(--shell-inspector-panel))] p-3 pl-4 shadow-[var(--shadow-shell-soft)] focus-within:shadow-[var(--shadow-shell-panel)]'
          )}
        >
        {/* 🔧 P0修复：拖拽遮罩层移到输入容器内部，确保与输入框完全重合 */}
        {/* z-[300] = Z_INDEX.inputBarDragOverlay（壳体局部层级，压过弹层 150） */}
        {isReady && isDragging && (
          <div data-wb-blur-surface className="absolute inset-0 z-[300] flex items-center justify-center rounded-[inherit] border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-primary">
              <UploadSimple size={32} weight="bold" />
              <span className="text-sm font-medium">
                {t('analysis:input_bar.attachments.drop_hint')}
              </span>
            </div>
          </div>
        )}
        {/* 📱 P0-1 移动端组合面板：内联展开，随文档流顶起消息区 */}
        {inlineComposerPanelNode}

        {composerInlinePanel && (
          <div className="mb-2 w-full">
            {composerInlinePanel}
          </div>
        )}

        {pendingApprovalRequest ? (
          <BlockingInteractionBar
            interaction={pendingApprovalRequest}
            sessionId={sessionId || ''}
            restoreFocusRef={textareaRef}
          />
        ) : (
          <>
        {/* 输入区域 */}
        <div className="mb-2 relative">
          {/* ★ 技能斜杠命令内联补全弹层（锚定输入栏上方，非模态） */}
          <SkillSlashPopover
            open={skillSlash.open}
            query={skillSlash.query}
            suggestions={skillSlash.suggestions}
            selectedIndex={skillSlash.selectedIndex}
            onSelect={(index) => applySkillSlashSelection(index)}
            onSelectedIndexChange={skillSlash.setSelectedIndex}
          />

          {/* 模型 @mention 自动完成弹窗 */}
          {modelMentionState && modelMentionActions && (
            <ModelMentionPopover
              open={modelMentionState.showAutoComplete}
              suggestions={modelMentionState.suggestions}
              selectedIndex={modelMentionState.selectedIndex}
              query={modelMentionState.query}
              onSelect={(model) => {
                // 🔧 Chip 模式：添加到 chips，并只移除 `@query` 片段（多行草稿安全）
                const result = modelMentionActions.selectSuggestion(model);
                onInputChange(result.value);
                setComposerCaretPos(result.caret);
                // 聚焦回输入框，光标回到 mention 起点
                const textarea = textareaRef.current;
                if (textarea) {
                  textarea.focus();
                  requestAnimationFrame(() => {
                    textarea.setSelectionRange(result.caret, result.caret);
                    modelMentionActions.updateCursorPosition(result.caret);
                  });
                }
              }}
              onSelectedIndexChange={modelMentionActions.setSelectedIndex}
              onClose={modelMentionActions.closeAutoComplete}
              anchorRef={textareaRef as React.RefObject<HTMLElement>}
            />
          )}

          {/* ★ 长文本粘贴建议条：默认保留为文本，可一键转为附件 */}
          {longPasteCandidate && (
            <div
              data-testid="long-paste-suggestion"
              className="mb-1.5 flex items-center gap-2 rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--composer-panel-muted-surface,var(--muted))] px-2.5 py-1 text-xs text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {t('chatV2:inputBar.longPaste.notice', { chars: longPasteCandidate.text.length })}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-6 shrink-0 !px-2 !text-xs text-primary"
                onClick={convertLongPasteToAttachment}
              >
                {t('chatV2:inputBar.longPaste.convert')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-6 shrink-0 !px-2 !text-xs"
                onClick={() => setLongPasteCandidate(null)}
              >
                {t('chatV2:inputBar.longPaste.dismiss')}
              </DsButton>
            </div>
          )}

          {/* ★ 制卡可发现性提示：pdf/docx 可制卡，apkg 可导入 */}
          {flashcardHintKind && !flashcardHintDismissed && (
            <div
              data-testid="flashcard-hint"
              className="mb-1.5 flex items-center gap-2 rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--composer-panel-muted-surface,var(--muted))] px-2.5 py-1 text-xs text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {flashcardHintKind === 'apkg'
                  ? t('chatV2:inputBar.flashcardHint.apkg')
                  : t('chatV2:inputBar.flashcardHint.document')}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-6 shrink-0 !px-2 !text-xs"
                onClick={() => setFlashcardHintDismissed(true)}
              >
                {t('chatV2:inputBar.flashcardHint.dismiss')}
              </DsButton>
            </div>
          )}

          {/* ★ 音视频可见性警示：AI 仅能看到文件名 */}
          {mediaHintKind && !mediaHintDismissed && (
            <div
              data-testid="media-attachment-hint"
              className="mb-1.5 flex items-center gap-2 rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--composer-panel-muted-surface,var(--muted))] px-2.5 py-1 text-xs text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {mediaHintKind === 'audio'
                  ? t('chatV2:inputBar.mediaHint.audio')
                  : t('chatV2:inputBar.mediaHint.video')}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-6 shrink-0 !px-2 !text-xs"
                onClick={() => setMediaHintDismissed(true)}
              >
                {t('chatV2:inputBar.mediaHint.dismiss')}
              </DsButton>
            </div>
          )}

          {/* ★ 思维导图导入提示：xmind/opml/mm/mmap 可导入为思维导图 */}
          {hasMindmapAttachment && !mindmapHintDismissed && (
            <div
              data-testid="mindmap-hint"
              className="mb-1.5 flex items-center gap-2 rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--composer-panel-muted-surface,var(--muted))] px-2.5 py-1 text-xs text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {t('chatV2:inputBar.mindmapHint.notice')}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-6 shrink-0 !px-2 !text-xs"
                onClick={() => setMindmapHintDismissed(true)}
              >
                {t('chatV2:inputBar.mindmapHint.dismiss')}
              </DsButton>
            </div>
          )}

          {/* 🔧 已选中的模型 Chips */}
          {modelMentionState && modelMentionActions && (
            <ModelMentionChips
              models={modelMentionState.selectedModels}
              onRemove={modelMentionActions.removeSelectedModel}
              disabled={isStreaming}
            />
          )}

          {/* 🔧 P1-27: 待发送的上下文引用 Chips */}
          {pendingContextRefs && onRemoveContextRef && onClearContextRefs && (
            <ContextRefChips
              refs={pendingContextRefs}
              onRemove={onRemoveContextRef}
              onClearAll={onClearContextRefs}
              disabled={isStreaming}
            />
          )}

          {/* ★ PDF 页码引用 Chips */}
          {pdfPageRefs && onRemovePdfPageRef && onClearPdfPageRefs && (
            <PageRefChips
              pageRefs={pdfPageRefs}
              onRemove={onRemovePdfPageRef}
              onClearAll={onClearPdfPageRefs}
              disabled={isStreaming}
            />
          )}

          <AttachmentPreviewChips
            attachments={attachments}
            onRemove={onRemoveAttachment}
            onRetry={handleRetryAttachmentChip}
            disabled={isStreaming}
          />

          <div
            ref={textareaScrollViewportRef}
            className={cn(
              'relative w-full',
              textareaViewportHeight >= INPUT_BAR_CONFIG.heights.textareaMax
                ? 'overflow-y-auto'
                : 'overflow-y-hidden',
            )}
            style={{ height: `${textareaViewportHeight}px` }}
          >
            <textarea
              data-testid="input-bar-v2-textarea"
              ref={textareaRef}
              aria-label={placeholder || t('analysis:input_bar.placeholder')}
              value={inputValue}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false;
                // Safari/WebKit：确认 Enter 的 keydown 会在 compositionend 之后同步派发，
                // 用微小的时间窗标记它属于 IME 确认，避免误触发送
                compositionJustEndedRef.current = true;
                if (compositionEndTimerRef.current !== null) {
                  clearTimeout(compositionEndTimerRef.current);
                }
                compositionEndTimerRef.current = setTimeout(() => {
                  compositionJustEndedRef.current = false;
                  compositionEndTimerRef.current = null;
                }, 0);
                // 合成结束时用最终值同步 store，确保不丢字
                const composedTarget = e.target as HTMLTextAreaElement;
                onInputChange(composedTarget.value);
                setComposerCaretPos(composedTarget.selectionStart);
                setTimeout(() => {
                  adjustTextareaHeight();
                  scrollCaretIntoView();
                }, 0);
              }}
              onChange={(e) => {
                // 🔧 IME 合成期间跳过 store 更新，仅移动端 WKWebView 需要（桌面端受控组件会阻止输入）
                if (!isComposingRef.current || !isMobile) {
                  onInputChange(e.target.value);
                }
                setTimeout(() => {
                  adjustTextareaHeight();
                  scrollCaretIntoView();
                }, 0);
                // 更新光标位置（用于斜杠命令 / 模型提及检测）
                setComposerCaretPos(e.target.selectionStart);
                if (modelMentionActions) {
                  modelMentionActions.updateCursorPosition(e.target.selectionStart);
                }
              }}
              placeholder={placeholder || t('analysis:input_bar.placeholder')}
              onKeyDown={(e) => {
                // ★ 技能斜杠命令补全优先（与 @mention 的触发上下文互斥）
                if (
                  !isImeComposing(e) &&
                  shouldHandleSkillSlashKey(e, skillSlash.open)
                ) {
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    skillSlash.moveSelectionUp();
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    skillSlash.moveSelectionDown();
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    if (applySkillSlashSelection()) {
                      e.preventDefault();
                      return;
                    }
                    // 无可应用项：放行原按键语义（Enter 继续走发送）
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    skillSlash.dismiss();
                    return;
                  }
                }

                if (
                  modelMentionState?.showAutoComplete &&
                  modelMentionActions &&
                  !isImeComposing(e) &&
                  shouldHandleModelMentionKey(e, modelMentionState.showAutoComplete)
                ) {
                  const hasMentionSuggestions = modelMentionState.suggestions.length > 0;
                  if (e.key === 'ArrowUp' && hasMentionSuggestions) {
                    e.preventDefault();
                    modelMentionActions.moveSelectionUp();
                    return;
                  }
                  if (e.key === 'ArrowDown' && hasMentionSuggestions) {
                    e.preventDefault();
                    modelMentionActions.moveSelectionDown();
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    const result = modelMentionActions.confirmSelection();
                    if (result) {
                      e.preventDefault();
                      onInputChange(result.value);
                      setComposerCaretPos(result.caret);
                      // 光标精确回到 mention 起点（不再粗暴移到末尾）
                      const textarea = textareaRef.current;
                      if (textarea) {
                        requestAnimationFrame(() => {
                          textarea.setSelectionRange(result.caret, result.caret);
                          modelMentionActions.updateCursorPosition(result.caret);
                        });
                      }
                      return;
                    }
                    // 无候选（noResults 提示态）：放行 Enter 走正常发送
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    modelMentionActions.closeAutoComplete();
                    return;
                  }
                }

                // 🔧 Chip 模式：输入为空时按 Backspace 删除最后一个 chip
                if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                  const textarea = textareaRef.current;
                  if (
                    textarea &&
                    textarea.selectionStart === 0 &&
                    textarea.selectionEnd === 0 &&
                    inputValue === '' &&
                    modelMentionState?.selectedModels.length
                  ) {
                    e.preventDefault();
                    modelMentionActions?.removeLastSelectedModel();
                    return;
                  }
                }

                // 正常的发送快捷键处理
                if (shouldSendOnEnter(e)) {
                  e.preventDefault();
                  // 队列/引导模式下，流式中的 Enter 语义改成“入队”，
                  // Stop 只保留给按钮显式点击，避免键盘误中断当前回复。
                  if (showStop && !queueEnabled) {
                    handleStop();
                  } else {
                    handleSend();
                  }
                  return;
                }
              }}
              onFocus={() => setComposerTextareaFocused(true)}
              onBlur={() => setComposerTextareaFocused(false)}
              onSelect={(e) => {
                // 光标位置变化时更新（支持点击、选择等操作）
                const selectionStart = (e.target as HTMLTextAreaElement).selectionStart;
                setComposerCaretPos(selectionStart);
                if (modelMentionActions) {
                  modelMentionActions.updateCursorPosition(selectionStart);
                }
                // ★ M4：键盘移动光标（方向键/Home/End）时也保证光标可见
                scrollCaretIntoView();
              }}
              onPaste={(e) => {
                // 🔧 辅助链路：粘贴附件处理延迟到 isReady 后
                if (isReady) {
                  handlePasteAsAttachment(e);
                  return;
                }
                // ★ L2 修复：未就绪时不再直接拒绝——同步读出剪贴板文件缓存起来，
                // isReady 后自动补投（File 对象在事件结束后仍然有效）；
                // 普通短文本直接走浏览器默认粘贴
                const cd = e.clipboardData;
                if (!cd) return;
                const earlyFiles = cd.files
                  ? Array.from(cd.files).filter((file) => file && file.size > 0)
                  : [];
                const text = cd.getData('text/plain') ?? '';
                if (text.length > INPUT_BAR_CONFIG.paste.longTextAutoAttachChars) {
                  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                  earlyFiles.push(new File([text], `pasted_${timestamp}.txt`, { type: 'text/plain' }));
                }
                if (earlyFiles.length > 0) {
                  e.preventDefault();
                  e.stopPropagation();
                  pendingEarlyPasteRef.current.push(...earlyFiles);
                }
              }}
              readOnly={isStreaming && !queueEnabled}
              rows={1}
              className="w-full resize-none border-0 bg-transparent py-1 text-md leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-0 overflow-hidden"
              style={{
                minHeight: '40px',
                background: 'transparent',
              }}
            />
          </div>
          {/* Ghost element for height calculation */}
          <div
            ref={ghostRef}
            aria-hidden="true"
            className="invisible absolute top-0 left-0 -z-50 overflow-hidden whitespace-pre-wrap break-words"
            style={{
              minHeight: '40px',
              lineHeight: '24px',
              visibility: 'hidden',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* 底部按钮栏 */}
        <div className="flex items-center justify-between gap-2">
          {/* 左侧按钮 - 窄屏时可横向滚动 */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-2 scrollbar-none">
            {/* 加号菜单：附件 / 模式 / 技能 / 连接器（AppMenu 次级飞出） */}
            <ComposerPlusMenu
              open={isAttachmentMenuOpen}
              onOpenChange={handleAttachmentMenuOpenChange}
              attachmentCount={attachmentCount}
              iconButtonClass={iconButtonClass}
              tooltipPosition={tooltipPosition}
              tooltipDisabled={tooltipDisabled}
              isMobile={isMobile}
              isMobileEnv={isMobileEnv}
              onAddAttachment={handleAddAttachmentAction}
              onOpenResourceLibrary={handleOpenResourceLibrary}
              onOpenCamera={handleOpenCameraAction}
              onOpenSkillPanel={renderSkillPanel ? handleOpenSkillPanelAction : undefined}
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
              activeSkillCount={activeSkillIds?.length ?? 0}
              hasLoadedSkills={!!hasLoadedSkills}
              renderMcpPanel={renderMcpPanel}
              onOpenMcpPanel={renderMcpPanel ? handleOpenMcpPanelAction : undefined}
              mcpEnabled={mcpEnabled}
              selectedMcpServerCount={selectedMcpServerCount}
            />

            {leftAccessory}

            {/* 对话控制按钮 */}
            {renderAdvancedPanel && (
              <ComposerToolButton
                icon={SlidersHorizontal}
                label={t('common:chat_controls')}
                active={panelStates.advanced}
                onClick={handleToggleAdvancedPanel}
                tooltipDisabled={tooltipDisabled}
              />
            )}

            {/* 📱 P1-2 移动端显式模型入口：模型名不再只埋在推理菜单二级里，
                工具行放可截断的模型 chip，一点直达内联 ModelPicker */}
            {isMobile && hasRuntimeModelMenu && (
              <button
                type="button"
                data-testid="mobile-model-chip"
                onClick={() => handleOpenRuntimeModelPanel('single')}
                aria-label={runtimeModelSwitchLabel}
                aria-expanded={panelStates.model}
                className={cn(
                  'inline-flex h-9 min-w-0 max-w-[10rem] shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
                  coarseHitAreaClass,
                  panelStates.model
                    ? 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)]'
                    : 'border-[color:var(--input-shell-border)] bg-transparent text-[color:var(--button-utility-foreground)] active:bg-[color:var(--button-utility-active)]'
                )}
              >
                {runtimeModelIconId ? (
                  <ProviderIcon
                    modelId={runtimeModelIconId}
                    size={13}
                    showTooltip={false}
                    variant="mono"
                    className="shrink-0 opacity-80"
                  />
                ) : (
                  <Sparkle size={13} weight="bold" className="shrink-0 opacity-80" />
                )}
                <span className="min-w-0 truncate">
                  {runtimeModelLabel ?? chooseRuntimeModelLabel}
                </span>
                <CaretDown size={11} weight="bold" className="shrink-0 opacity-55" />
              </button>
            )}

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
                          coarseHitAreaLgClass
                        )}
                        title={thinkingRuntimeTitle}
                        aria-label={
                          thinkingUnsupported
                            ? t('chatV2:inputBar.thinkingUnsupported', '不支持推理')
                            : hasThinkingDepthMenu
                            ? t('chatV2:inputBar.thinkingDepthMenu', '选择推理深度')
                            : t('chatV2:inputBar.thinking', '推理模式')
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
                        <AppMenuGroup label={t('chatV2:inputBar.thinking', '推理模式')}>
                          <AppMenuItem disabled>
                            {t('chatV2:inputBar.thinkingUnsupportedDescription', '该模型不支持推理')}
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
                              offLabel={t('chatV2:inputBar.thinkingOff', '关闭')}
                              efficientLabel={t('chatV2:inputBar.thinkingDepthEfficient', '更高效')}
                              smartLabel={t('chatV2:inputBar.thinkingDepthSmart', '更智能')}
                              resolveOptionLabel={resolveThinkingDepthLabel}
                              ariaLabel={t('chatV2:inputBar.thinkingDepthMenu', '选择推理深度')}
                            />
                          </AppMenuGroup>
                        ) : (
                          // 不可关闭推理的模型：滑块必带"关闭"档，退回菜单列表以保留 thinkingCanDisable 语义
                          <AppMenuGroup label={t('chatV2:inputBar.thinkingDepthTitle', '推理强度')}>
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
                        <AppMenuGroup label={t('chatV2:inputBar.thinking', '推理模式')}>
                          <AppMenuItem checked={!!enableThinking} onClick={handleTurnThinkingOn}>
                            {t('chatV2:inputBar.thinkingOn', '开启')}
                          </AppMenuItem>
                          {thinkingCanDisable && (
                            <AppMenuItem checked={!enableThinking} onClick={handleTurnThinkingOff}>
                              {t('chatV2:inputBar.thinkingOff', '关闭')}
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
                                    className="app-menu-search-input ds-search-input"
                                    placeholder={runtimeModelSearchPlaceholder}
                                    value={runtimeModelSearch}
                                    onChange={(event) => setRuntimeModelSearch(event.target.value)}
                                    onClick={(event) => event.stopPropagation()}
                                  />
                                </div>
                                <div className="max-h-[220px] overflow-y-auto">
                                  {groupedRuntimeModelOptions.length > 0 ? (
                                    groupedRuntimeModelOptions.map((group) => (
                                      <AppMenuGroup key={group.providerLabel} label={group.providerLabel}>
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
                                      {t('chatV2:inputBar.runtimeModelNoResults', '未找到匹配模型')}
                                    </AppMenuItem>
                                  )}
                                </div>
                                <AppMenuSeparator />
                                <AppMenuItem onClick={() => handleOpenRuntimeModelPanel('compare')}>
                                  {runtimeCompareModeLabel}
                                </AppMenuItem>
                              </AppMenuSubContent>
                            </AppMenuSub>
                          ) : (
                            <AppMenuItem
                              aria-label={runtimeModelSwitchLabel}
                              className={runtimeModelLabel ? '[&_.app-menu-item-content]:whitespace-normal' : undefined}
                              title={runtimeModelSwitchTitle}
                              onClick={() => handleOpenRuntimeModelPanel?.()}
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
                        coarseHitAreaXlClass,
                        thinkingUnsupported ? 'opacity-55' : enableThinking ? 'opacity-90' : 'opacity-65 hover:opacity-90'
                      )}
                      title={thinkingStateLabel ?? t('chatV2:inputBar.thinking', '推理模式')}
                      aria-label={thinkingStateLabel ?? t('chatV2:inputBar.thinking', '推理模式')}
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

            {resolvedInputToolSlot}

            {/* 发送/停止按钮 - 极简圆形风格 */}
            {showStop ? (
              <DsButton
                data-testid="btn-stop"
                variant="default"
                size="icon"
                iconOnly
                onClick={handleStop}
                disabled={!canAbort}
                // 移动端与发送按钮同为 44px 触控目标；桌面保持 32px 视觉
                className={cn(studyUiBlackActionButtonClass, '!w-8 !h-8 max-md:!w-11 max-md:!h-11 !rounded-full shadow-sm')}
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
                    onClick={handleSend}
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
          </>
        )}
      </div>
      </ThreadContentShell>

      {/* 🔧 面板容器 - 用于检测点击是否在面板内 */}
      {/* 🔧 P0修复：stopPropagation 防止面板内点击冒泡到 document 触发 handleClickOutside */}
      {/* 📱 P0-1：以下 ComposerPanelOverlay 浮层仅桌面端渲染；移动端面板走输入壳内的内联插槽 */}
      <div ref={panelContainerRef} onMouseDown={(e) => e.stopPropagation()}>
        {/* 附件面板 - 桌面端锚定浮层（内容与移动端内联面板共用 renderAttachmentPanelBody） */}
        {!isMobile && activeComposerPanel === 'attachment' && attachmentPanelMotion.shouldRender && (
          <ComposerPanelOverlay
            panelKey="attachment"
            anchorRef={inputContainerRef}
            overlayRef={composerPanelOverlayRef}
            motionState={attachmentPanelMotion.motionState}
            maxHeight={400}
            className="overflow-hidden"
          >
            {renderAttachmentPanelBody()}
          </ComposerPanelOverlay>
        )}

        {/* 🔧 P1修复：隐藏的文件选择器移到顶层，确保在任何情况下都可用 */}
        <input ref={fileInputRef} type="file" multiple accept={fileAccept} onChange={handleFileSelect} className="hidden" />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleCameraChange} className="hidden" />

        {/* ★ RAG 知识库面板已移至对话控制面板 */}

        {/* 模型选择面板 - 供命令面板/消息重试等外部入口复用 */}
        {!isMobile && renderModelPanel && (
          activeComposerPanel === 'model' && modelPanelMotion.shouldRender && (
            <ComposerPanelOverlay
              panelKey="model"
              anchorRef={runtimeModelTriggerRef}
              overlayRef={composerPanelOverlayRef}
              motionState={modelPanelMotion.motionState}
              maxHeight={500}
              preferredWidth={560}
              widthMode="wide"
              gap={8}
              heightMode="content"
              className={cn(
                '!border-[color:var(--menu-shell-border)] !bg-[color:var(--menu-shell-surface)] !text-[color:var(--menu-shell-foreground)]',
                '!rounded-[var(--menu-shell-radius)] !p-[var(--menu-shell-padding)] !shadow-[var(--menu-shell-shadow)]'
              )}
            >
              {renderModelPanel()}
            </ComposerPanelOverlay>
          )
        )}

        {/* MCP 工具面板 - 贴齐输入栏宽度 */}
        {!isMobile && renderMcpPanel && (
          activeComposerPanel === 'mcp' && mcpPanelMotion.shouldRender && (
            <ComposerPanelOverlay
              panelKey="mcp"
              anchorRef={inputContainerRef}
              overlayRef={composerPanelOverlayRef}
              motionState={mcpPanelMotion.motionState}
              maxHeight={520}
              widthMode="anchor"
              heightMode="available"
            >
              {renderMcpPanel()}
            </ComposerPanelOverlay>
          )
        )}


        {/* ★ 知识图谱选择面板已废弃（图谱模块已移除） */}

        {/* 对话控制面板 */}
        {!isMobile && renderAdvancedPanel && (
          activeComposerPanel === 'advanced' && advancedPanelMotion.shouldRender && (
            <ComposerPanelOverlay
              panelKey="advanced"
              anchorRef={inputContainerRef}
              overlayRef={composerPanelOverlayRef}
              motionState={advancedPanelMotion.motionState}
              maxHeight={520}
              widthMode="anchor"
            >
              {renderAdvancedPanel()}
            </ComposerPanelOverlay>
          )
        )}

        {/* 技能选择面板 - 贴齐输入栏宽度 */}
        {!isMobile && renderSkillPanel && (
          activeComposerPanel === 'skill' && skillPanelMotion.shouldRender && (
            <ComposerPanelOverlay
              panelKey="skill"
              anchorRef={inputContainerRef}
              overlayRef={composerPanelOverlayRef}
              motionState={skillPanelMotion.motionState}
              maxHeight={580}
              widthMode="anchor"
              heightMode="available"
            >
              {renderSkillPanel()}
            </ComposerPanelOverlay>
          )
        )}

      </div>{/* 🔧 panelContainerRef 结束 */}
    </div>
  );
};

export const InputBarUI = React.memo(InputBarUIInner);
InputBarUI.displayName = 'InputBarUI';

export default InputBarUI;
