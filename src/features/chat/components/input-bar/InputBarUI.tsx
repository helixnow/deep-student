/**
 * Chat V2 - InputBarUI 纯展示组件
 *
 * 只通过 props 接收数据和回调，不订阅任何 Store。
 * 保留原有 UI/UX/动效，删除所有业务逻辑和旧架构依赖。
 */

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowUp,
  Square,
  Paperclip,
  StackSimple,
  SlidersHorizontal,
  GraduationCap,
  Wrench,
  BookOpen,
  CheckCircle,
  Warning,
  Clock,
  XCircle,
  UploadSimple,
  Network,
  Plus,
  Camera,
  Lightning,
  Sparkle,
  CircleNotch,
  FolderOpen,
  CaretDown,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { usePdfProcessingProgress } from '@/hooks/usePdfProcessingProgress';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
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
  AppMenuSwitchItem,
} from '@/components/ui/app-menu/AppMenu';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTauriDragAndDrop } from '@/hooks/useTauriDragAndDrop';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { getErrorMessage } from '@/utils/errorUtils';
import { cancelPdfProcessing, getBatchPdfProcessingStatus, retryPdfProcessing } from '@/api/vfsPdfProcessingApi';
import type { InputBarUIProps } from './types';
import type { ContextWindowUsage } from './contextWindowUsage';
import { vfsRefApi } from '../../context/vfsRefApi';
import { resourceStoreApi, type ContextRef } from '../../resources';
import { IMAGE_TYPE_ID } from '../../context/definitions/image';
import { FILE_TYPE_ID } from '../../context/definitions/file';
import { logAttachment } from '../../debug/chatV2Logger';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { COMPOSER_PANEL_KEYS, type AttachmentMeta, type PanelStates, type PdfProcessingStatus } from '../../core/types/common';
import { ModelMentionPopover, shouldHandleModelMentionKey } from './ModelMentionPopover';
import { ModelMentionChips } from './ModelMentionChip';
import { ContextRefChips } from './ContextRefChips';
import { PageRefChips } from './PageRefChips';
import { AttachmentPreviewChips } from './AttachmentPreviewChips';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { BlockingInteractionBar } from './BlockingInteractionBar';
import { MobileBottomSheet } from './MobileBottomSheet';
import { MobileSheetHeader } from './MobileSheetHeader';
import { AttachmentInjectModeSelector } from './AttachmentInjectModeSelector';
import { ComposerPanelOverlay } from './ComposerPanelOverlay';
import { ComposerPanel } from './ComposerPanel';
import { ComposerToolButton } from './ComposerToolButton';
import { ThreadContentShell } from '../ui/ThreadContentShell';
import type { AttachmentInjectModes } from '../../core/types/common';
import {
  type MediaInjectMode,
  getAttachmentMediaType,
  getSelectedInjectModes as ssotGetSelectedModes,
  getEffectiveReadyModes as ssotGetEffectiveReadyModes,
} from './injectModeUtils';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { useVoiceInputIntegration } from '@/voice-input';

// ============================================================================
// 常量
// ============================================================================

import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import {
  ATTACHMENT_MAX_SIZE,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_DOCUMENT_TYPES,
  ATTACHMENT_DOCUMENT_EXTENSIONS,
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_ALLOWED_EXTENSIONS,
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
    /** textarea 最大高度（超出后才允许内部滚动） */
    textareaMax: 160,
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
function scheduleIdle(callback: () => void, timeout = IDLE_DELAY_MS): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(callback, { timeout });
  } else {
    setTimeout(callback, timeout);
  }
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

function ContextWindowUsageRing({
  usage,
  t,
  disabled,
}: {
  usage: ContextWindowUsage;
  t: TFunction;
  disabled: boolean;
}) {
  const contextUsageColor = 'var(--text-primary)';
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
        <span className="rounded-full border border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-muted)] px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-[color:var(--text-secondary)]">
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
 */
export const InputBarUI: React.FC<InputBarUIProps> = ({
  // 状态
  inputValue,
  canSend,
  queueEnabled = false,
  queueFull = false,
  canSubmit,
  canAbort,
  isStreaming,
  contextWindowUsage,
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
  renderRagPanel,
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

  // ========== 本地状态 ==========
  // 🔧 首帧降载：使用固定高度占位，idle 后再测量真实高度
  const [inputContainerHeight, setInputContainerHeight] = useState<number>(INITIAL_PLACEHOLDER_HEIGHT);
  const [textareaViewportHeight, setTextareaViewportHeight] = useState<number>(40);
  const lastMeasuredHeightRef = useRef<number>(INITIAL_PLACEHOLDER_HEIGHT);
  const [bottomGapPx, setBottomGapPx] = useState(DESKTOP_DOCK_GAP_PX);
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0);
  // 🔧 统一使用 MobileLayoutContext 的移动端判断
  const isMobile = mobileLayout?.isMobile ?? false;
  const [showEmptyTip, setShowEmptyTip] = useState(false);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const emptyTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

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
    // 🔧 P2优化：检查附件数量限制
    const currentCount = attachments.length;
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
      const isImage = file.type.startsWith('image/') || ATTACHMENT_IMAGE_EXTENSIONS.includes(fileExt);
      const attachmentId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // 🔧 P2优化：文件大小验证 (P1-08: 使用统一常量)
      if (file.size > ATTACHMENT_MAX_SIZE) {
        console.warn(`[InputBarUI] File too large: ${file.name} (${formatFileSize(file.size)})`);
        const errorAttachment: AttachmentMeta = {
          id: attachmentId,
          name: file.name,
          type: isImage ? 'image' : 'document',
          mimeType: file.type,
          size: file.size,
          status: 'error',
          error: t('analysis:input_bar.attachments.file_too_large', { size: formatFileSize(ATTACHMENT_MAX_SIZE) }),
        };
        onAddAttachment(errorAttachment);
        return;
      }

      // 🔧 P2优化：文件类型验证 (P1-08: 使用统一常量)
      const isAllowedType = isImage
        ? ATTACHMENT_IMAGE_TYPES.includes(file.type) || ATTACHMENT_IMAGE_EXTENSIONS.includes(fileExt)
        : ATTACHMENT_DOCUMENT_TYPES.includes(file.type) || ATTACHMENT_DOCUMENT_EXTENSIONS.includes(fileExt);
      if (!isAllowedType) {
        console.warn(`[InputBarUI] Unsupported file type: ${file.name} (${file.type || fileExt})`);
        const errorAttachment: AttachmentMeta = {
          id: attachmentId,
          name: file.name,
          type: isImage ? 'image' : 'document',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          status: 'error',
          error: t('analysis:input_bar.attachments.errors.unsupported_type', {
            name: file.name,
            ext: fileExt || file.type || 'unknown',
          }),
        };
        onAddAttachment(errorAttachment);
        return;
      }

      // 先添加 pending 状态的附件
      const pendingAttachment: AttachmentMeta = {
        id: attachmentId,
        name: file.name,
        type: isImage ? 'image' : 'document',
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        status: 'uploading', // 标记为上传中
        uploadProgress: 0,
        uploadStage: 'reading',
      };
      onAddAttachment(pendingAttachment);

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
          const contextRef: ContextRef = {
            resourceId: result.resourceId,
            hash: result.hash,
            typeId,
          };

          logAttachment('store', 'add_context_ref_event', {
            resourceId: result.resourceId,
            hash: result.hash,
            typeId,
          });

          // 通过回调交给上层统一注册 ContextRef，避免跨模块散落事件监听
          onContextRefCreated?.({ contextRef, attachmentId });

          // 4. 更新附件状态
          // 🔧 P1-25: 使用 Blob URL 预览，而不是 DataURL
          // Blob URL 由浏览器管理，内存占用更低

          // 🆕 判断文件类型，PDF 和图片需要进入 processing 状态等待预处理完成
          const isPdfFile = file.type === 'application/pdf'
            || file.name.toLowerCase().endsWith('.pdf');
          const isImageFile = file.type.startsWith('image/');

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
            console.log('[MediaProcessing] PDF init store:', { sourceId: uploadResult.sourceId, stage, percent, readyModes });
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
            console.log('[MediaProcessing] Image init store:', { sourceId: uploadResult.sourceId, stage, percent, readyModes });
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

  }, [onFilesUpload, onAddAttachment, onUpdateAttachment, onContextRefCreated, attachments.length, t]);

  // ========== 相机拍照处理 ==========
  // 检测是否在移动端环境
  const isMobileEnv = useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent.toLowerCase();
    return /android|iphone|ipad|ipod|mobile/.test(ua);
  }, []);

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

    // 长文本转为附件
    const text = clipboard.getData('text/plain') ?? '';
    let textConverted = false;
    if (text && text.length > 800) {
      const filename = `pasted_${timestamp}.txt`;
      pastedFiles.push(new File([text], filename, { type: 'text/plain' }));
      textConverted = true;
    }

    if (pastedFiles.length === 0) return false;

    event.preventDefault();
    event.stopPropagation();

    processFilesToAttachments(pastedFiles);

    if (textConverted) {
      showGlobalNotification('success', t('analysis:input_bar.attachments.doc_parsing_complete'), t('analysis:input_bar.attachments.document'));
    }

    return true;
  }, [processFilesToAttachments, t]);

  // ========== 面板动画状态 ==========
  // 🔧 统一使用 useDeferredOpen 实现所有面板的弹出收起动画
  const attachmentPanelMotion = useDeferredOpen(panelStates.attachment);
  // ★ RAG面板已移至对话控制面板，不再需要独立的动画状态
  const modelPanelMotion = useDeferredOpen(panelStates.model);
  const advancedPanelMotion = useDeferredOpen(panelStates.advanced);
  const mcpPanelMotion = useDeferredOpen(panelStates.mcp);
  const skillPanelMotion = useDeferredOpen(panelStates.skill);

  // ========== 派生值 ==========
  const iconButtonClass = 'inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-shell-control)] text-[color:var(--button-utility-foreground)] transition-colors hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)] active:bg-[color:var(--button-utility-active)]';
  const studyUiButtonBaseClassName =
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-[13px] font-medium leading-none tracking-[0.01em] transition-[background-color,border-color,color,box-shadow] duration-150 ease-out outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';
  const studyUiButtonSizeIconClassName =
    'h-[var(--button-icon-size)] w-[var(--button-icon-size)] rounded-[var(--button-radius)]';
  const studyUiSendButtonSizeClass =
    'h-11 w-11 !rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)]';
  const studyUiBlackActionButtonClass =
    '!border-black !bg-black hover:!bg-black active:!bg-black !text-white';
  const studyUiSendButtonEmptyStateClass =
    '!border-transparent !bg-muted !text-muted-foreground hover:!bg-muted/80 active:!bg-muted/70';
  const studyUiSendButtonAriaLabel = '发送消息';
  const tooltipPosition = 'top' as const;
  // 🔧 移动端禁用 tooltip（触摸设备没有 hover 交互，tooltip 会干扰）
  const tooltipDisabled = isMobile;
  const attachmentCount = attachments.length;
  const compactThinkingStateLabel = getCompactThinkingLabel(thinkingStateLabel);
  const runtimeModelTitle = t('chatV2:inputBar.runtimeModelTitle', '模型');
  const chooseRuntimeModelLabel = t('chatV2:inputBar.chooseRuntimeModel', '选择模型');
  const runtimeModelSearchPlaceholder = t('app_menu.search.placeholder', '搜索名称或模型 ID...');
  const runtimeCompareModeLabel = t('chatV2:inputBar.runtimeModelCompareMode', '进入多选模式...');
  const fallbackRuntimeProviderLabel = t('chatV2:inputBar.runtimeModelOtherProvider', '其他');
  const runtimeModelAccessibleCurrent = runtimeModelLabel
    ? runtimeModelProviderLabel
      ? `${runtimeModelProviderLabel} / ${runtimeModelLabel}`
      : runtimeModelLabel
    : undefined;
  const runtimeModelSwitchLabel = runtimeModelAccessibleCurrent
    ? `${chooseRuntimeModelLabel}，当前：${runtimeModelAccessibleCurrent}`
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
  const thinkingRuntimeTriggerLabel = compactThinkingStateLabel || runtimeModelLabel || runtimeModelTitle;
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

  // 🔧 面板容器 ref，用于检测点击是否在面板内
  const panelContainerRef = useRef<HTMLDivElement>(null);
  const composerPanelOverlayRef = useRef<HTMLDivElement | null>(null);
  const runtimeModelTriggerRef = useRef<HTMLSpanElement | null>(null);
  // 🔧 P1修复：检查是否有附件正在上传
  const hasUploadingAttachments = attachments.some(a => a.status === 'uploading' || a.status === 'pending');
  // 允许 ready 或 processing 但选中模式已就绪的附件发送
  const hasSendableAttachments = useMemo(() => {
    return attachments.some(att => {
      const isPdf = att.mimeType === 'application/pdf' || att.name.toLowerCase().endsWith('.pdf');
      const isImage = att.mimeType?.startsWith('image/') || false;
      if (!isPdf && !isImage) return att.status === 'ready';

      const selectedModes = getSelectedModes(att, isPdf, isImage);
      const mediaType = isPdf ? 'pdf' : 'image';

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
      const isPdf = att.mimeType === 'application/pdf' || att.name.toLowerCase().endsWith('.pdf');
      const isImage = att.mimeType?.startsWith('image/') || false;

      // 只处理 PDF 和图片
      if (!isPdf && !isImage) return false;

      // ★ 跳过上传中的附件，避免误显示"部分模式未就绪"
      // 上传中的附件由 hasUploadingAttachments 处理
      if (att.status === 'uploading' || att.status === 'pending') return false;

      // 获取选中的注入模式和媒体类型
      const selectedModes = getSelectedModes(att, isPdf, isImage);
      const mediaType = isPdf ? 'pdf' : 'image';
      const status = att.sourceId ? (pdfStatusMap.get(att.sourceId) || att.processingStatus) : att.processingStatus;
      const readyModes = getEffectiveReadyModes(status, mediaType, att);
      return !hasAnyReadyMode(selectedModes, readyModes);
    });
  }, [attachments, pdfStatusMap]);

  const firstBlockingAttachment = useMemo(() => {
    for (const att of attachments) {
      const isPdf = att.mimeType === 'application/pdf' || att.name.toLowerCase().endsWith('.pdf');
      const isImage = att.mimeType?.startsWith('image/') || false;
      if (!isPdf && !isImage) continue;
      // ★ 跳过上传中的附件，由 hasUploadingAttachments 处理
      if (att.status === 'uploading' || att.status === 'pending') continue;
      const selectedModes = getSelectedModes(att, isPdf, isImage);
      const mediaType = isPdf ? 'pdf' : 'image';
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
  const bottomGapValue = `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${bottomGapPx}px + ${keyboardInsetPx}px)`;
  const measuredInputHeight = inputContainerRef.current?.offsetHeight || inputContainerHeight || 96;
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

  // 调整 textarea 高度
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    const ghost = ghostRef.current;
    const maxHeight = INPUT_BAR_CONFIG.heights.textareaMax;
    const minHeight = INPUT_BAR_CONFIG.heights.textareaMin;
    if (textarea && ghost) {
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
  }, []);

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

  // 空文本提示
  const triggerEmptyTip = useCallback(() => {
    if (emptyTipTimerRef.current) clearTimeout(emptyTipTimerRef.current);
    setShowEmptyTip(true);
    emptyTipTimerRef.current = setTimeout(() => setShowEmptyTip(false), 1800);
  }, []);

  // IME 合成态检测
  const isImeComposing = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const anyNative = e.nativeEvent as any;
    return Boolean(
      (e as any).isComposing ||
      (anyNative && anyNative.isComposing) ||
      (e as any).which === 229
    );
  }, []);

  // 判断是否应该发送
  const shouldSendOnEnter = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const mode = sendShortcut || 'enter';
      if (mode === 'enter') {
        return e.key === 'Enter' && !e.shiftKey && !isImeComposing(e);
      }
      return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isImeComposing(e);
    },
    [sendShortcut, isImeComposing]
  );

  // 处理发送
  const handleSend = useCallback(() => {
    if (!canSendWithAttachments) {
      triggerEmptyTip();
      return;
    }
    if (disabledSend) return;
    // 🔧 P3修复：正确处理异步 onSend 的返回值，避免未捕获的 Promise rejection
    // 错误已在 TauriAdapter 中通过 showGlobalNotification 显示，这里只需要静默处理
    const result = onSend();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        // 错误已在上层处理，这里只是避免未捕获的 rejection 警告
      });
    }
  }, [canSendWithAttachments, disabledSend, onSend, triggerEmptyTip]);

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

    const handleClickOutside = (e: MouseEvent) => {
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

    // 使用 mousedown 而不是 click，更早响应
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [hasAnyPanelOpen, closeAllPanels]);

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
    if (!enableThinking) return;
    if (onSetThinkingDepth) {
      onSetThinkingDepth('off');
      return;
    }
    onToggleThinking?.();
  }, [enableThinking, onSetThinkingDepth, onToggleThinking]);

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

  // 🔧 P2: 工具开关渲染函数（支持快捷键显示）
  const renderToolToggleSwitch = (
    key: string,
    label: string,
    icon: React.ReactNode,
    checked: boolean,
    onToggle?: () => void,
    shortcut?: string
  ) => {
    if (!onToggle) return null;
    return (
      <AppMenuSwitchItem
        key={key}
        icon={icon}
        checked={checked}
        onCheckedChange={onToggle}
      >
        <span className="flex items-center justify-between w-full">
          <span className="app-menu-tool-label">{label}</span>
          {shortcut && (
            <kbd className="ml-2 px-1.5 py-0.5 text-[10px] font-mono bg-muted/50 rounded border border-border/50 text-muted-foreground">{shortcut}</kbd>
          )}
        </span>
      </AppMenuSwitchItem>
    );
  };

  // ★ 2026-01 改造：移除加号菜单，统一桌面端和移动端样式

  // ========== Effects ==========

  // 监听内容变化调整高度
  useEffect(() => {
    adjustTextareaHeight();
  }, [inputValue, adjustTextareaHeight]);

  // 清理 timer
  useEffect(() => {
    return () => {
      if (emptyTipTimerRef.current) clearTimeout(emptyTipTimerRef.current);
    };
  }, []);

  // 🔧 P2: 全局键盘快捷键支持
  // 注册在 document 上，处理后 stopPropagation 防止与命令系统双重执行
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditableTarget = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        !!target.closest('[contenteditable="true"]')
      );
      const inModal = !!target?.closest('[role="dialog"], [role="alertdialog"]');
      if (isEditableTarget || inModal) return;

      // ⌘⇧T / Ctrl+Shift+T: 切换推理模式（覆盖全局 toggle-theme）
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        e.stopPropagation();
        onToggleThinking?.();
        return;
      }
      // ⌘⇧K / Ctrl+Shift+K: 切换知识库
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        if (renderRagPanel) {
          togglePanel('rag');
        }
        return;
      }
      // ⌘⇧M / Ctrl+Shift+M: 切换 MCP 工具
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        e.stopPropagation();
        if (renderMcpPanel) {
          togglePanel('mcp');
        }
        return;
      }
      // ⌘⇧S / Ctrl+Shift+S: 切换技能面板
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        if (renderSkillPanel) {
          if (panelStates.skill) {
            togglePanel('skill');
          } else if (activeSkillIds && activeSkillIds.length > 0) {
            onClearAllSkills?.();
          } else {
            togglePanel('skill');
          }
        }
        return;
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [onToggleThinking, renderRagPanel, renderMcpPanel, renderSkillPanel, panelStates.skill, activeSkillIds, onClearAllSkills, togglePanel]);

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

    // idle 后再延迟挂载重 UI/计算
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    scheduleIdle(() => {
      delayTimer = setTimeout(() => setIsReady(true), HEAVY_UI_DELAY_MS);
    });

    return () => {
      if (delayTimer) clearTimeout(delayTimer);
    };
  }, [sessionSwitchKey]);

  // 响应式 bottom gap + 移动端检测
  useEffect(() => {
    const handleResize = () => {
      const mobile = mobileLayout?.isMobile ?? (window.innerWidth <= MOBILE_BREAKPOINT_PX);
      setBottomGapPx(mobile ? MOBILE_DOCK_GAP_PX : DESKTOP_DOCK_GAP_PX);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setKeyboardInsetPx(0);
      return;
    }

    const updateKeyboardInset = () => {
      const visualViewport = window.visualViewport;
      const textarea = textareaRef.current;
      if (!visualViewport || document.activeElement !== textarea) {
        setKeyboardInsetPx(0);
        return;
      }

      const rawInset = window.innerHeight - visualViewport.height - visualViewport.offsetTop;
      const nextInset = rawInset > 80 ? Math.round(rawInset) : 0;
      setKeyboardInsetPx(nextInset);
    };

    updateKeyboardInset();

    const visualViewport = window.visualViewport;
    const textarea = textareaRef.current;
    visualViewport?.addEventListener('resize', updateKeyboardInset);
    visualViewport?.addEventListener('scroll', updateKeyboardInset);
    window.addEventListener('resize', updateKeyboardInset);
    textarea?.addEventListener('focus', updateKeyboardInset);
    textarea?.addEventListener('blur', updateKeyboardInset);

    return () => {
      visualViewport?.removeEventListener('resize', updateKeyboardInset);
      visualViewport?.removeEventListener('scroll', updateKeyboardInset);
      window.removeEventListener('resize', updateKeyboardInset);
      textarea?.removeEventListener('focus', updateKeyboardInset);
      textarea?.removeEventListener('blur', updateKeyboardInset);
    };
  }, [isMobile, sessionSwitchKey]);

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

  // 使用 useRef 追踪 attachments 的引用，避免作为 useEffect 依赖导致频繁触发
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

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
        .filter(att => att.mimeType === 'application/pdf' || att.mimeType?.startsWith('image/'));
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
            mediaType: att.mimeType === 'application/pdf' ? 'pdf' : 'image',
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

      // ★ P1 修复：同时处理 PDF 和图片
      const isPdf = att.mimeType === 'application/pdf' || att.name.toLowerCase().endsWith('.pdf');
      const isImage = att.mimeType?.startsWith('image/') || false;
      if (!isPdf && !isImage) return;

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

      // 启动 ResizeObserver
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const h = Math.round(entry?.contentRect?.height || el.offsetHeight);

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
  }, []);

  // 🔧 P0 优化：移除全局 CSS 变量写入
  // 高度传递改为仅使用 inline style（见下方 render），不触发全局重排
  // MessageList 底部 padding 改为使用固定值或通过 props 传递

  // ========== 渲染 ==========

  return (
    <div
      ref={dropZoneRef}
      data-testid="input-bar-v2-root"
      className={cn(
        // 🎨 布局分离：作为 flex 子项，relative 用于面板定位
        // 🔧 P0修复：移除 ring 样式，避免拖拽时显示难看的实心边框
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
            'relative z-[200] overflow-hidden border transition-[background-color,border-color,box-shadow] duration-150 ease-out',
            isMobile
              ? 'rounded-[22px] border-[color:var(--composer-panel-border)] bg-[color:var(--surface-root)] px-3 py-2.5 shadow-[0_10px_24px_hsl(var(--shadow-base)/0.05)] focus-within:shadow-[0_14px_28px_hsl(var(--shadow-base)/0.07)]'
              : 'rounded-[var(--radius-shell-toolbar)] border-[color:var(--input-shell-border)] bg-[color:var(--unified-input-shell-surface,var(--shell-inspector-panel))] p-3 pl-4 shadow-[var(--shadow-shell-soft)] focus-within:shadow-[var(--shadow-shell-panel)]'
          )}
        >
        {/* 🔧 P0修复：拖拽遮罩层移到输入容器内部，确保与输入框完全重合 */}
        {isReady && isDragging && (
          <div className="absolute inset-0 z-[300] flex items-center justify-center rounded-[inherit] border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-primary">
              <UploadSimple size={32} weight="bold" />
              <span className="text-sm font-medium">
                {t('analysis:input_bar.attachments.drop_hint')}
              </span>
            </div>
          </div>
        )}
        {/* 空输入提示 */}
        {showEmptyTip && (
          <div className="input-empty-tip" role="status" aria-live="polite">
            {t('common:messages.error.empty_input')}
          </div>
        )}

        {composerInlinePanel && (
          <div className="mb-2 w-full">
            {composerInlinePanel}
          </div>
        )}

        {pendingApprovalRequest ? (
          <BlockingInteractionBar
            interaction={pendingApprovalRequest}
            sessionId={sessionId || ''}
          />
        ) : (
          <>
        {/* 输入区域 */}
        <div className="mb-2 relative">
          {/* 模型 @mention 自动完成弹窗 */}
          {modelMentionState && modelMentionActions && (
            <ModelMentionPopover
              open={modelMentionState.showAutoComplete}
              suggestions={modelMentionState.suggestions}
              selectedIndex={modelMentionState.selectedIndex}
              query={modelMentionState.query}
              onSelect={(model) => {
                // 🔧 Chip 模式：添加到 chips 并清理输入
                const newValue = modelMentionActions.selectSuggestion(model);
                onInputChange(newValue);
                // 聚焦回输入框
                const textarea = textareaRef.current;
                if (textarea) {
                  textarea.focus();
                  requestAnimationFrame(() => {
                    // 光标移到末尾
                    textarea.setSelectionRange(newValue.length, newValue.length);
                    modelMentionActions.updateCursorPosition(newValue.length);
                  });
                }
              }}
              onSelectedIndexChange={modelMentionActions.setSelectedIndex}
              onClose={modelMentionActions.closeAutoComplete}
              anchorRef={textareaRef as React.RefObject<HTMLElement>}
            />
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
                // 合成结束时用最终值同步 store，确保不丢字
                onInputChange((e.target as HTMLTextAreaElement).value);
                setTimeout(adjustTextareaHeight, 0);
              }}
              onChange={(e) => {
                // 🔧 IME 合成期间跳过 store 更新，仅移动端 WKWebView 需要（桌面端受控组件会阻止输入）
                if (!isComposingRef.current || !isMobile) {
                  onInputChange(e.target.value);
                }
                setTimeout(adjustTextareaHeight, 0);
                // 更新光标位置（用于模型提及检测）
                if (modelMentionActions) {
                  modelMentionActions.updateCursorPosition(e.target.selectionStart);
                }
              }}
              placeholder={placeholder || t('analysis:input_bar.placeholder')}
              onKeyDown={(e) => {
                if (
                  modelMentionState?.showAutoComplete &&
                  modelMentionActions &&
                  shouldHandleModelMentionKey(e, modelMentionState.showAutoComplete)
                ) {
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    modelMentionActions.moveSelectionUp();
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    modelMentionActions.moveSelectionDown();
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    const newValue = modelMentionActions.confirmSelection();
                    if (newValue) {
                      onInputChange(newValue);
                      // 将光标移到正确位置
                      const textarea = textareaRef.current;
                      if (textarea) {
                        requestAnimationFrame(() => {
                          // 光标移到输入值末尾（简化处理，因为此时没有 model 信息）
                          textarea.setSelectionRange(newValue.length, newValue.length);
                          modelMentionActions.updateCursorPosition(newValue.length);
                        });
                      }
                    }
                    return;
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
              onSelect={(e) => {
                // 光标位置变化时更新（支持点击、选择等操作）
                if (modelMentionActions) {
                  modelMentionActions.updateCursorPosition(
                    (e.target as HTMLTextAreaElement).selectionStart
                  );
                }
              }}
              onPaste={(e) => {
                // 🔧 辅助链路：粘贴附件处理延迟到 isReady 后
                if (isReady) {
                  handlePasteAsAttachment(e);
                  return;
                }
                // 未就绪：仅当剪贴板包含文件或超长文本（会被转成附件）时才警告并阻断；
                // 普通短文本直接走浏览器默认粘贴，避免每次会话切换都弹"正在初始化"
                const cd = e.clipboardData;
                if (!cd) return;
                const hasFiles =
                  (cd.files && cd.files.length > 0) ||
                  (cd.items && Array.from(cd.items).some((it) => it.kind === 'file'));
                const longText = (cd.getData('text/plain') ?? '').length > 800;
                if (hasFiles || longText) {
                  e.preventDefault();
                  e.stopPropagation();
                  showGlobalNotification('warning', t('chatV2:inputBar.pasteNotReady'));
                }
              }}
              readOnly={isStreaming && !queueEnabled}
              rows={1}
              className="w-full resize-none border-0 bg-transparent py-1 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-0 overflow-hidden"
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
            {/* 附件按钮 - 左侧首位，方便先添加上下文 */}
            <AppMenu open={isAttachmentMenuOpen} onOpenChange={handleAttachmentMenuOpenChange}>
              <AppMenuTrigger asChild>
                <span className="inline-flex rounded-[var(--radius-shell-control)]">
                  <CommonTooltip
                    content={
                      attachmentCount > 0
                        ? `${t('analysis:input_bar.attachments.title')} (${attachmentCount})`
                        : t('analysis:input_bar.attachments.title')
                    }
                    position={tooltipPosition}
                    disabled={tooltipDisabled || isAttachmentMenuOpen}
                  >
                    <NotionButton
                      data-testid="btn-toggle-attachments"
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className={cn(
                        iconButtonClass,
                        'relative transition-colors disabled:opacity-60'
                      )}
                      aria-label={t('analysis:input_bar.attachments.title')}
                    >
                      <Plus size={18} weight="bold" />
                    </NotionButton>
                  </CommonTooltip>
                </span>
              </AppMenuTrigger>
              <AppMenuContent
                align="start"
                width={180}
                style={{ zIndex: 320 }}
              >
                <AppMenuGroup>
                  <AppMenuItem
                    icon={<Paperclip className="w-4 h-4" weight="bold" />}
                    onClick={handleAddAttachmentAction}
                  >
                    {t('analysis:input_bar.attachments.add')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<FolderOpen className="w-4 h-4" weight="bold" />}
                    onClick={handleOpenResourceLibrary}
                  >
                    {t('chatV2:inputBar.resourceLibrary')}
                  </AppMenuItem>
                  {isMobileEnv && (
                    <AppMenuItem
                      icon={<Camera className="w-4 h-4" weight="bold" />}
                      onClick={handleOpenCameraAction}
                    >
                      {t('chatV2:inputBar.camera')}
                    </AppMenuItem>
                  )}
                </AppMenuGroup>
              </AppMenuContent>
            </AppMenu>

            {leftAccessory}

            {/* ★ 加号菜单已移除，统一桌面端和移动端样式 */}

            {/* 🔧 P0: 技能选择独立按钮 */}
            {renderSkillPanel && (
              <ComposerToolButton
                data-testid="btn-toggle-skill"
                icon={Lightning}
                label={t('skills:title')}
                tooltipContent={
                  activeSkillIds && activeSkillIds.length > 0
                    ? t('skills:active')
                    : hasLoadedSkills
                      ? t('skills:toolLoaded')
                      : t('skills:title')
                }
                active={panelStates.skill || !!(activeSkillIds && activeSkillIds.length > 0)}
                ariaPressed={panelStates.skill || !!(activeSkillIds && activeSkillIds.length > 0) || !!hasLoadedSkills}
                onClick={() => {
                  if (panelStates.skill) {
                    togglePanel('skill');
                  } else if (activeSkillIds && activeSkillIds.length > 0) {
                    onClearAllSkills?.();
                  } else {
                    togglePanel('skill');
                  }
                }}
                tooltipDisabled={tooltipDisabled}
                indicator={
                  activeSkillIds && activeSkillIds.length > 0
                    ? 'active'
                    : hasLoadedSkills
                      ? 'loaded'
                      : null
                }
              />
            )}

            {/* 🔧 P0: MCP 工具独立按钮 */}
            {renderMcpPanel && (
              <ComposerToolButton
                data-testid="btn-toggle-mcp"
                icon={Wrench}
                label={t('analysis:input_bar.mcp.title')}
                tooltipContent={
                  <span className="flex items-center gap-2">
                    <span>{t('analysis:input_bar.mcp.title')}</span>
                    <kbd className="px-1 py-0.5 text-[10px] font-mono bg-muted/50 rounded border border-border/50">⌘⇧M</kbd>
                  </span>
                }
                active={panelStates.mcp || mcpEnabled}
                onClick={() => togglePanel('mcp')}
                tooltipDisabled={tooltipDisabled}
                badge={selectedMcpServerCount}
              />
            )}

            {/* 对话控制按钮 */}
            {renderAdvancedPanel && (
              <ComposerToolButton
                icon={SlidersHorizontal}
                label={t('common:chat_controls')}
                active={panelStates.advanced}
                onClick={() => togglePanel('advanced')}
                tooltipDisabled={tooltipDisabled}
              />
            )}

          </div>

          {/* 右侧按钮 - 固定不滚动 */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {extraButtonsRight}

            {contextWindowUsage && (
              <ContextWindowUsageRing
                usage={contextWindowUsage}
                t={t}
                disabled={tooltipDisabled}
              />
            )}

            {/* 推理强度 - 放在原附件按钮位置，靠近发送动作 */}
            {onToggleThinking && (
              <span
                ref={runtimeModelTriggerRef}
                className={cn(
                  'relative inline-flex h-8 min-w-0 max-w-[8rem] shrink-0 items-center rounded-[var(--radius-shell-control)] px-1 text-[13px] font-semibold leading-none',
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
                        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1 text-inherit transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
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
                            className="shrink-0 opacity-80"
                          />
                        ) : (
                          <Lightning size={15} weight={enableThinking && !thinkingUnsupported ? "fill" : "bold"} className="shrink-0 opacity-90" />
                        )}
                        <span data-testid="thinking-runtime-state-label" className="min-w-0 max-w-[5.75rem] truncate">
                          {thinkingRuntimeTriggerLabel}
                        </span>
                        <CaretDown size={13} weight="bold" className="shrink-0 opacity-55" />
                      </button>
                    </AppMenuTrigger>
                    <AppMenuContent align="start" width={hasRuntimeModelMenu ? 232 : 176}>
                      {hasThinkingUnsupportedMenu ? (
                        <AppMenuGroup label={t('chatV2:inputBar.thinking', '推理模式')}>
                          <AppMenuItem disabled>
                            {t('chatV2:inputBar.thinkingUnsupportedDescription', '该模型不支持推理')}
                          </AppMenuItem>
                        </AppMenuGroup>
                      ) : hasThinkingDepthMenu ? (
                        <AppMenuGroup label={t('chatV2:inputBar.thinkingDepthTitle', '推理强度')}>
                          {thinkingDepthOptions.map((option) => (
                            <AppMenuItem
                              key={option.value}
                              checked={!!enableThinking && thinkingDepthValue === option.value}
                              onClick={() => onSetThinkingDepth(option.value)}
                            >
                              {t(option.labelKey, option.defaultLabel)}
                            </AppMenuItem>
                          ))}
                          <AppMenuSeparator />
                          <AppMenuItem checked={!enableThinking} onClick={() => onSetThinkingDepth('off')}>
                            {t('chatV2:inputBar.thinkingOff', '关闭')}
                          </AppMenuItem>
                        </AppMenuGroup>
                      ) : hasThinkingToggleMenu ? (
                        <AppMenuGroup label={t('chatV2:inputBar.thinking', '推理模式')}>
                          <AppMenuItem checked={!!enableThinking} onClick={handleTurnThinkingOn}>
                            {t('chatV2:inputBar.thinkingOn', '开启')}
                          </AppMenuItem>
                          <AppMenuItem checked={!enableThinking} onClick={handleTurnThinkingOff}>
                            {t('chatV2:inputBar.thinkingOff', '关闭')}
                          </AppMenuItem>
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
                                        className="block min-w-0 max-w-full truncate text-[10.5px] text-muted-foreground"
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
                                    type="text"
                                    className="app-menu-search-input"
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
                                                <span className="block min-w-0 max-w-full truncate text-[10.5px] text-muted-foreground">
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
                                      className="block min-w-0 max-w-full truncate text-[10.5px] text-muted-foreground"
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
            {/* 🆕 媒体处理中提示 */}
            {hasProcessingMedia && (
              <div className="text-xs text-muted-foreground flex items-center gap-1 mr-1">
                <CircleNotch className="w-3 h-3 animate-spin" weight="bold" />
                <span className="hidden sm:inline">
                  {processingIndicatorLabel || t('chatV2:inputBar.processingIndicator')}
                </span>
              </div>
            )}

            {resolvedInputToolSlot}

            {/* 发送/停止按钮 - 极简圆形风格 */}
            {showStop ? (
              <NotionButton
                data-testid="btn-stop"
                variant="default"
                size="icon"
                iconOnly
                onClick={handleStop}
                disabled={!canAbort}
                className={cn(studyUiBlackActionButtonClass, '!w-8 !h-8 !rounded-full shadow-sm')}
                aria-label={t('analysis:input_bar.actions.stop')}
              >
                <Square size={12} weight="fill" />
              </NotionButton>
            ) : (
              <CommonTooltip
                content={disabledSend ? sendBlockedReason : undefined}
                disabled={!disabledSend || isMobile || !sendBlockedReason}
              >
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
      <div ref={panelContainerRef} onMouseDown={(e) => e.stopPropagation()}>
        {/* 附件面板 - ★ 统一桌面端和移动端样式 */}
        {activeComposerPanel === 'attachment' && attachmentPanelMotion.shouldRender && (
          <ComposerPanelOverlay
            panelKey="attachment"
            anchorRef={inputContainerRef}
            overlayRef={composerPanelOverlayRef}
            motionState={attachmentPanelMotion.motionState}
            maxHeight={400}
            className="overflow-hidden"
          >
              {/* 面板头部 */}
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Paperclip size={16} weight="bold" />
                  <span>{t('analysis:input_bar.attachments.title')} ({attachments.length})</span>
                </div>
                <div className="flex items-center gap-2">
                  <NotionButton variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                    + {t('analysis:input_bar.attachments.add')}
                  </NotionButton>
                  {/* 资源库按钮 - 桌面端在右侧打开 Learning Hub 面板，移动端打开右侧滑屏 */}
                  <NotionButton
                    variant="outline"
                    size="sm"
                    onClick={handleOpenResourceLibrary}
                  >
                    <FolderOpen size={12} weight="bold" />
                    {t('chatV2:inputBar.resourceLibrary')}
                  </NotionButton>
                  {isMobileEnv && (
                    <NotionButton variant="outline" size="sm" onClick={handleCameraClick}>
                      <Camera size={12} weight="bold" />
                      {t('chatV2:inputBar.camera')}
                    </NotionButton>
                  )}
                  {attachments.length > 0 && (
                    <NotionButton variant="danger" size="sm" onClick={() => {
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
                    }}>
                      {t('analysis:input_bar.attachments.clear_all')}
                    </NotionButton>
                  )}
                  <NotionButton variant="ghost" size="sm" onClick={toggleAttachmentPanel}>
                    {t('common:actions.close')}
                  </NotionButton>
                </div>
              </div>

              {/* 附件列表 */}
              <CustomScrollArea viewportClassName="max-h-56" className="flex flex-col gap-2">
                {attachments.length === 0 ? (
                  <div className="flex items-center justify-center rounded-lg border border-dashed bg-card/70 px-3 py-6 text-sm text-muted-foreground">
                    {t('analysis:input_bar.attachments.empty')}
                  </div>
                ) : (
                  attachments.map((attachment) => {
                    const isVfsRef = attachment.id.startsWith('vfs-');
                    const sizeLabel = isVfsRef ? t('analysis:input_bar.attachments.reference') : `${(attachment.size / 1024).toFixed(1)} KB`;

                    // 判断是否为 PDF
                    const isPdf = attachment.mimeType === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');
                    const isImage = attachment.type === 'image' || attachment.mimeType.startsWith('image/');

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
                    const progressLabel = stageLabel
                      ? (displayPercent > 0 ? `${stageLabel} · ${displayPercent}%` : stageLabel)
                      : `${displayPercent}%`;

                    const isUploading = attachment.status === 'uploading' || attachment.status === 'pending';
                    const statusIcon =
                      attachment.status === 'ready' && missingModes.length > 0
                        ? <Warning size={12} weight="bold" className="text-amber-600" />
                        : attachment.status === 'ready' ? <CheckCircle size={12} weight="fill" className="text-green-600" />
                          : attachment.status === 'error' ? <XCircle size={12} weight="fill" className="text-red-600" />
                            : (isMediaProcessing || isUploading) ? <CircleNotch size={12} weight="bold" className="text-blue-500 animate-spin" />
                              : <Clock size={12} weight="bold" className="text-muted-foreground" />;
                    const toneClass = isVfsRef
                      ? 'border-blue-200/60 bg-blue-50/70 dark:border-blue-800/50 dark:bg-blue-900/20'
                      : attachment.status === 'error' ? 'border-red-200/70 bg-red-50/70 dark:border-red-800/50 dark:bg-red-900/20'
                        : attachment.status === 'ready' && missingModes.length > 0
                          ? 'border-amber-200/60 bg-amber-50/70 dark:border-amber-800/50 dark:bg-amber-900/20'
                          : attachment.status === 'ready' ? 'border-emerald-200/60 bg-emerald-50/70 dark:border-emerald-800/50 dark:bg-emerald-900/20'
                            : (isMediaProcessing || isUploading) ? 'border-blue-200/60 bg-blue-50/70 dark:border-blue-800/50 dark:bg-blue-900/20'
                              : 'border-slate-200/70 bg-card/90 dark:border-slate-700/50';

                    // 判断是否为图片或 PDF（需要显示注入模式选择器）
                    const showInjectModeSelector = isImage || isPdf;

                    return (
                      <div key={attachment.id} className={cn('attachment-row flex flex-col gap-1.5 rounded-lg border backdrop-blur p-2 transition-colors duration-200 ease-out motion-reduce:transition-none', toneClass)}>
                        {/* 第一行：文件名、大小、状态、移除按钮 */}
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <span className="text-[13px] text-foreground truncate block">{attachment.name}</span>
                            {attachment.status === 'error' && attachment.error && <span className="text-[11px] text-red-600 truncate block">{attachment.error}</span>}
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
                                  <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-blue-500 transition-all duration-300"
                                      style={{ width: `${unifiedPercent}%` }}
                                    />
                                  </div>
                                  <span className="text-[10px] text-blue-600 dark:text-blue-400 whitespace-nowrap">
                                    {unifiedLabel}{unifiedPercent > 0 ? ` · ${unifiedPercent}%` : ''}
                                  </span>
                                </div>
                              );
                            })()}
                            {missingModesLabel && !isUploading && (
                              <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                                {t('chatV2:inputBar.modesNotReady', { modes: missingModesLabel })}
                              </div>
                            )}
                          </div>
                          <span className={cn("text-[12px]", isVfsRef ? "text-blue-600 dark:text-blue-400 font-medium" : "text-muted-foreground")}>{sizeLabel}</span>
                          <span className="flex items-center gap-1">{statusIcon}</span>
                          {/* ★ P0 修复：错误状态时显示重试按钮（使用正确的 sourceId） */}
                          {attachment.status === 'error' && attachment.sourceId && (
                            <NotionButton
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                try {
                                  const fileId = attachment.sourceId!;
                                  const isPdf = attachment.mimeType === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');
                                  logAttachment('ui', 'retry_processing_start', {
                                    attachmentId: attachment.id,
                                    sourceId: fileId,
                                    mediaType: isPdf ? 'pdf' : 'image',
                                    previousError: attachment.error,
                                  });
                                  onUpdateAttachment(attachment.id, {
                                    status: 'processing',
                                    error: undefined,
                                    processingStatus: {
                                      stage: isPdf ? 'ocr_processing' : 'image_compression',
                                      percent: isPdf ? 50 : 10,
                                      readyModes: attachment.processingStatus?.readyModes || [],
                                      mediaType: isPdf ? 'pdf' : 'image',
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
                              }}
                              className="text-blue-600"
                            >
                              {t('common:retry')}
                            </NotionButton>
                          )}
                          <NotionButton variant="danger" size="sm" onClick={() => {
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
                          </NotionButton>
                        </div>
                        {/* 第二行：注入模式选择器（仅图片和 PDF 显示，PDF 在处理中也显示） */}
                        {showInjectModeSelector && (attachment.status === 'ready' || isMediaProcessing) && (
                          <div className="flex items-center gap-2 pl-1">
                            <span className="text-[11px] text-muted-foreground">{t('chatV2:injectMode.label')}:</span>
                            <AttachmentInjectModeSelector
                              attachment={attachment}
                              onInjectModesChange={(attachmentId: string, modes: AttachmentInjectModes) => {
                                onUpdateAttachment(attachmentId, { injectModes: modes });
                              }}
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

          </ComposerPanelOverlay>
        )}

        {/* 🔧 P1修复：隐藏的文件选择器移到顶层，确保在任何情况下都可用 */}
        <input ref={fileInputRef} type="file" multiple accept={fileAccept} onChange={handleFileSelect} className="hidden" />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleCameraChange} className="hidden" />

        {/* ★ RAG 知识库面板已移至对话控制面板 */}

        {/* 模型选择面板 - 供命令面板/消息重试等外部入口复用 */}
        {renderModelPanel && (
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
        {renderMcpPanel && (
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
        {renderAdvancedPanel && (
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
        {renderSkillPanel && (
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

export default InputBarUI;
