/**
 * Chat V2 - InputBarUI 纯展示组件
 *
 * 只通过 props 接收数据和回调，不订阅任何 Store。
 * 保留原有 UI/UX/动效，删除所有业务逻辑和旧架构依赖。
 */

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Send,
  Square,
  Paperclip,
  Layers,
  SlidersHorizontal,
  GraduationCap,
  Wrench,
  BookOpen,
  CheckCircle2,
  AlertTriangle,
  Clock,
  XCircle,
  Upload,
  Atom,
  Network,
  Plus,
  Camera,
  Zap,
  ArrowUp,
  Loader2,
  FolderOpen,
} from 'lucide-react';
import { usePdfProcessingProgress } from '@/hooks/usePdfProcessingProgress';
import { usePdfProcessingStore } from '@/stores/pdfProcessingStore';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import DsAnalysisIconMuted from '@/components/icons/DsAnalysisIconMuted';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuGroup,
  AppMenuSeparator,
  AppMenuSwitchItem,
} from '@/components/ui/app-menu/AppMenu';
import { cn } from '@/lib/utils';
import { useTauriDragAndDrop } from '@/hooks/useTauriDragAndDrop';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { getErrorMessage } from '@/utils/errorUtils';
import { getBatchPdfProcessingStatus, retryPdfProcessing } from '@/api/vfsPdfProcessingApi';
import type { InputBarUIProps } from './types';
import { vfsRefApi } from '../../context/vfsRefApi';
import { resourceStoreApi, type ContextRef } from '../../resources';
import { IMAGE_TYPE_ID } from '../../context/definitions/image';
import { FILE_TYPE_ID } from '../../context/definitions/file';
import { logAttachment } from '../../debug/chatV2Logger';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import type { AttachmentMeta, PanelStates, PdfProcessingStatus } from '../../core/types/common';
import { ModelMentionPopover, shouldHandleModelMentionKey } from './ModelMentionPopover';
import { ModelMentionChips } from './ModelMentionChip';
import { InputTokenEstimate } from '../TokenUsageDisplay';
import { ContextRefChips } from './ContextRefChips';
import { PageRefChips } from './PageRefChips';
import { estimateTokenCount } from '../../utils/tokenUtils';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { ActiveFeatureChips, useActiveFeatureChips } from './ActiveFeatureChips';
import { ToolApprovalCard } from '../ToolApprovalCard';
import { MobileBottomSheet } from './MobileBottomSheet';
import { MobileSheetHeader } from './MobileSheetHeader';
import { AttachmentInjectModeSelector } from './AttachmentInjectModeSelector';
import type { AttachmentInjectModes } from '../../core/types/common';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';

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
    /** Token 估算防抖延迟 */
    tokenDebounce: 300,
  },
  /** 高度相关配置 */
  heights: {
    /** 首帧固定高度占位，避免布局抖动 */
    placeholder: MOBILE_LAYOUT.inputBar.placeholderHeight,
    /** ResizeObserver 高度变化阈值（小于此值不更新状态） */
    changeThreshold: MOBILE_LAYOUT.inputBar.heightChangeThreshold,
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
    /** 移动端底部间距（使用共享配置，确保与 BottomTabBar 高度一致） */
    mobile: MOBILE_LAYOUT.bottomTabBar.defaultHeight,
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

type MediaInjectMode = 'text' | 'ocr' | 'image';

function getSelectedModes(
  attachment: AttachmentMeta,
  isPdf: boolean,
  isImage: boolean
): MediaInjectMode[] {
  if (isPdf) {
    return (attachment.injectModes?.pdf || ['text']) as MediaInjectMode[];
  }
  if (isImage) {
    return (attachment.injectModes?.image || ['image']) as MediaInjectMode[];
  }
  return [];
}

function getEffectiveReadyModes(
  status: PdfProcessingStatus | undefined,
  mediaType: 'pdf' | 'image',
  allowSafeDefaults: boolean
): MediaInjectMode[] | undefined {
  // 图片在处理中时，默认允许 image 模式发送；
  // OCR/向量索引继续后台执行，不阻塞发送按钮。
  if (
    mediaType === 'image' &&
    status &&
    (status.stage === 'pending'
      || status.stage === 'image_compression'
      || status.stage === 'ocr_processing'
      || status.stage === 'vector_indexing')
  ) {
    const merged = new Set<MediaInjectMode>(['image']);
    for (const mode of (status.readyModes || []) as MediaInjectMode[]) {
      merged.add(mode);
    }
    return Array.from(merged);
  }

  if (status?.readyModes?.length) {
    return status.readyModes as MediaInjectMode[];
  }
  if (status?.stage === 'completed') {
    return mediaType === 'pdf' ? ['text'] : ['image'];
  }
  if (allowSafeDefaults && !status) {
    return mediaType === 'pdf' ? ['text'] : ['image'];
  }
  return undefined;
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
  canAbort,
  isStreaming,
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
  className,
  // 模式插件面板
  renderRagPanel,
  renderModelPanel,
  // renderAdvancedPanel 已移除（对话控制已移至侧栏）
  renderMcpPanel,
  renderSkillPanel,
  // 教材侧栏控制
  textbookOpen,
  onTextbookToggle,
  // 模型 @mention 自动完成
  modelMentionState,
  modelMentionActions,
  // 推理模式
  enableThinking,
  onToggleThinking,
  // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除开关
  // ★ Skills 技能系统（多选模式）
  activeSkillIds,
  hasLoadedSkills,
  onToggleSkill,
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
  const { t } = useTranslation(['analysis', 'common', 'chatV2']);

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

  // ========== 本地状态 ==========
  // 🔧 首帧降载：使用固定高度占位，idle 后再测量真实高度
  const [inputContainerHeight, setInputContainerHeight] = useState<number>(INITIAL_PLACEHOLDER_HEIGHT);
  const [textareaViewportHeight, setTextareaViewportHeight] = useState<number>(40);
  const lastMeasuredHeightRef = useRef<number>(INITIAL_PLACEHOLDER_HEIGHT);
  const [bottomGapPx, setBottomGapPx] = useState(DESKTOP_DOCK_GAP_PX);
  // 🔧 统一使用 MobileLayoutContext 的移动端判断
  const isMobile = mobileLayout?.isMobile ?? false;
  const [showEmptyTip, setShowEmptyTip] = useState(false);
  const emptyTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 🔧 首帧轻量化：isReady 控制重 UI 延迟挂载
  const [isReady, setIsReady] = useState(false);
  // 🔧 Token 估算防抖
  const [debouncedTokenCount, setDebouncedTokenCount] = useState(0);
  const tokenDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      // 打开附件面板（使用 ref 获取最新状态）
      if (!panelStatesRef.current.attachment) {
        onSetPanelState('attachment', true);
      }
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
      };
      onAddAttachment(pendingAttachment);

      // 🔧 P1-25: 移动端内存优化 - 使用 Blob URL 预览，避免 DataURL 常驻内存
      // 创建 Blob URL 用于预览（内存友好，浏览器自动管理）
      const blobPreviewUrl = URL.createObjectURL(file);

      // 异步读取文件内容并上传到 VFS
      const reader = new FileReader();
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
            const readyModes = (uploadResult.readyModes || ['text']) as ('text' | 'image' | 'ocr')[];
            const isCompleted = stage === 'completed';

            onUpdateAttachment(attachmentId, {
              status: isCompleted ? 'ready' : 'processing',
              previewUrl: blobPreviewUrl,
              resourceId: result.resourceId,
              sourceId: uploadResult.sourceId, // ★ P0 修复：保存 sourceId 用于重试
              processingStatus: {
                stage: stage as 'page_rendering' | 'page_compression' | 'ocr_processing' | 'vector_indexing' | 'completed',
                percent,
                readyModes,
                mediaType: 'pdf',
              },
            });

            // 同时更新 pdfProcessingStore
            // ★ P0 修复：使用 sourceId (file_id) 作为 key，与后端事件保持一致
            usePdfProcessingStore.getState().update(uploadResult.sourceId, {
              stage: stage as 'page_rendering' | 'page_compression' | 'ocr_processing' | 'vector_indexing' | 'completed',
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
            const readyModes = (uploadResult.readyModes || []) as ('text' | 'image' | 'ocr')[];
            const isCompleted = stage === 'completed';

            onUpdateAttachment(attachmentId, {
              status: isCompleted ? 'ready' : 'processing',
              previewUrl: blobPreviewUrl,
              resourceId: result.resourceId,
              sourceId: uploadResult.sourceId, // ★ P0 修复：保存 sourceId 用于重试
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
            });
          }



        } catch (error) {
          logAttachment('ui', 'vfs_upload_error', {
            fileName: file.name,
            error: getErrorMessage(error),
          }, 'error');

          // 🔧 P0-15 修复：VFS 上传失败时标记为 error，而不是 ready
          // 原问题：标记为 ready 但没有 ContextRef，用户以为可用但模型看不到
          // 🔧 P1-25: 使用 Blob URL 预览
          onUpdateAttachment(attachmentId, {
            status: 'error',
            previewUrl: blobPreviewUrl,
            error: t('chatV2:input.attachmentUploadFailed'),
          });
          console.error('[InputBarUI] VFS upload failed:', getErrorMessage(error));
        }
      };
      reader.onerror = () => {
        console.error('[InputBarUI] Failed to read file:', file.name);
        logAttachment('ui', 'file_read_error', {
          fileName: file.name,
          attachmentId,
        }, 'error');
        onUpdateAttachment(attachmentId, {
          status: 'error',
          error: t('analysis:input_bar.attachments.load_failed'),
        });
      };
      reader.readAsDataURL(file);
    });

    // 打开附件面板（使用 ref 获取最新状态）
    if (!panelStatesRef.current.attachment) {
      onSetPanelState('attachment', true);
    }
  }, [onFilesUpload, onAddAttachment, onUpdateAttachment, onSetPanelState, onContextRefCreated, attachments.length, t]);

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
  // 🔧 P2清理：advancedPanelMotion 已移除（对话控制已移至侧栏）
  const mcpPanelMotion = useDeferredOpen(panelStates.mcp);
  const skillPanelMotion = useDeferredOpen(panelStates.skill);

  // ========== 派生值 ==========
  const iconButtonClass = 'inline-flex items-center justify-center h-9 w-9 rounded-full transition-colors hover:bg-muted/50 text-muted-foreground hover:text-foreground active:bg-muted';
  const tooltipPosition = 'top' as const;
  // 🔧 移动端禁用 tooltip（触摸设备没有 hover 交互，tooltip 会干扰）
  const tooltipDisabled = isMobile;
  const attachmentCount = attachments.length;
  const attachmentBadgeLabel = attachmentCount > 99 ? '99+' : String(attachmentCount);
  const hasText = inputValue.trim().length > 0;
  const hasAttachments = attachmentCount > 0;
  const hasContent = hasText || hasAttachments;

  // 🔧 检查是否有任何面板打开
  const hasAnyPanelOpen = panelStates.attachment || panelStates.rag || panelStates.model ||
    panelStates.advanced || panelStates.learn || panelStates.mcp || panelStates.search || panelStates.skill;

  // 🔧 P3: 构建激活功能 Chips
  // 注意：只显示真正"启用"的功能，而不是仅仅"打开面板"的功能
  // - 面板状态（panelStates.rag/search）只表示面板是否打开，不代表功能启用
  // - 真正的启用状态需要有独立的 boolean 标志（如 enableThinking、enableLearnMode）
  const activeFeatures = useActiveFeatureChips({
    // 🔧 移除推理模式 Chip：用户反馈不需要此气泡
    // enableThinking,
    // onToggleThinking,
    // 🔧 移除基于面板状态的 Chip：打开面板 ≠ 启用功能
    // ragEnabled: panelStates.rag,  // 知识库面板打开不代表启用
    // searchEnabled: panelStates.search,  // 网络搜索面板打开不代表启用
    textbookOpen,
    onTextbookToggle,
    // 🔧 MCP Chip 的关闭按钮应该清除选中的服务器，而不是关闭面板
    onToggleMcp: onClearMcpServers,
    selectedMcpServerCount,
    // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除开关
    // 技能 Chips 已通过 ContextRefChips 显示，这里不再重复
    activeSkillIds,
    onDeactivateSkill: onToggleSkill,
  });

  // 🔧 P1: 计算激活功能数量（用于 Pill Badge）
  const activeFeatureCount = activeFeatures.length;

  // 🔧 面板容器 ref，用于检测点击是否在面板内
  const panelContainerRef = useRef<HTMLDivElement>(null);
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

      if (att.status === 'ready') {
        const readyModes = getEffectiveReadyModes(att.processingStatus, mediaType, true);
        return hasAnyReadyMode(selectedModes, readyModes);
      }

      if (att.status !== 'processing') return false;
      const status = att.sourceId ? (pdfStatusMap.get(att.sourceId) || att.processingStatus) : att.processingStatus;
      const readyModes = getEffectiveReadyModes(status, mediaType, false);
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

      // 获取选中的注入模式和媒体类型
      const selectedModes = getSelectedModes(att, isPdf, isImage);
      const mediaType = isPdf ? 'pdf' : 'image';
      const status = att.status === 'ready'
        ? att.processingStatus
        : (att.sourceId ? (pdfStatusMap.get(att.sourceId) || att.processingStatus) : att.processingStatus);
      const readyModes = getEffectiveReadyModes(status, mediaType, att.status === 'ready');
      return !hasAnyReadyMode(selectedModes, readyModes);
    });
  }, [attachments, pdfStatusMap]);

  const firstBlockingAttachment = useMemo(() => {
    for (const att of attachments) {
      const isPdf = att.mimeType === 'application/pdf' || att.name.toLowerCase().endsWith('.pdf');
      const isImage = att.mimeType?.startsWith('image/') || false;
      if (!isPdf && !isImage) continue;
      const selectedModes = getSelectedModes(att, isPdf, isImage);
      const mediaType = isPdf ? 'pdf' : 'image';
      const status = att.status === 'ready'
        ? att.processingStatus
        : (att.sourceId ? (pdfStatusMap.get(att.sourceId) || att.processingStatus) : att.processingStatus);
      const readyModes = getEffectiveReadyModes(status, mediaType, att.status === 'ready');
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
  }, [disabledReason, hasUploadingAttachments, firstBlockingAttachment, formatModeList, t]);

  const processingIndicatorLabel = useMemo(() => {
    if (!firstBlockingAttachment) return undefined;
    const missingLabel = formatModeList(firstBlockingAttachment.missingModes);
    return missingLabel
      ? t('chatV2:inputBar.processingIndicatorPartial')
      : t('chatV2:inputBar.processingIndicator');
  }, [firstBlockingAttachment, formatModeList, t]);

  // 使用 CSS 变量作为 Android fallback，iOS 正常使用 env()
  const bottomGapValue = `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${bottomGapPx}px)`;
  const measuredInputHeight = inputContainerRef.current?.offsetHeight || inputContainerHeight || 96;
  const dockedHeightWithGap = Math.max(0, Math.round(measuredInputHeight + bottomGapPx));
  const dockedHeightVarValue = `${dockedHeightWithGap}px`;

  // ========== 发送/停止按钮状态 ==========
  const showStop = isStreaming;
  // 🔧 P1修复：附件上传中时禁用发送
  // 🆕 增加媒体处理中检查：选中的注入模式未就绪时也禁用发送
  const disabledSend = showStop ? false : !!disabledReason || !canSendWithAttachments || !canSend || hasUploadingAttachments || hasProcessingMedia;

  // ========== 回调函数 ==========

  // 调整 textarea 高度
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    const ghost = ghostRef.current;
    const maxHeight = 160;
    const minHeight = 40;
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
    onSetPanelState('attachment', false);
    onSetPanelState('rag', false);
    onSetPanelState('mcp', false);
    onSetPanelState('search', false);
    onSetPanelState('learn', false);
    onSetPanelState('model', false);
    onSetPanelState('advanced', false);
    onSetPanelState('skill', false);
  }, [onSetPanelState]);

  // 🔧 点击面板外部关闭面板（使用 document 事件监听，避免层叠上下文问题）
  useEffect(() => {
    if (!hasAnyPanelOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // 检查点击是否在面板容器内
      if (panelContainerRef.current?.contains(target)) {
        return; // 点击在面板内，不关闭
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
    // 关闭所有其他面板
    const allPanels: (keyof PanelStates)[] = ['attachment', 'rag', 'model', 'advanced', 'learn', 'mcp', 'search', 'skill'];
    if (!currentState) {
      allPanels.forEach(p => {
        if (p !== panelName) onSetPanelState(p, false);
      });
    }
    onSetPanelState(panelName, !currentState);
  }, [panelStates, onSetPanelState]);

  // 切换附件面板（使用统一函数）
  const toggleAttachmentPanel = useCallback(() => {
    togglePanel('attachment');
  }, [togglePanel]);

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
      if (tokenDebounceRef.current) clearTimeout(tokenDebounceRef.current);
    };
  }, []);

  // 🔧 P2: 全局键盘快捷键支持
  // 注册在 document 上，处理后 stopPropagation 防止与命令系统双重执行
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
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
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [onToggleThinking, renderRagPanel, renderMcpPanel, togglePanel]);

  // 🔧 首帧轻量化 + 会话切换重置
  // 会话切换时重置 isReady，延迟 HEAVY_UI_DELAY_MS (400ms) 再启动重 UI/计算
  useEffect(() => {
    // 检测会话切换
    if (prevSessionSwitchKeyRef.current !== sessionSwitchKey) {
      prevSessionSwitchKeyRef.current = sessionSwitchKey;
      // 会话切换时重置 isReady，触发重新延迟
      setIsReady(false);
      setDebouncedTokenCount(0);
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

  // 🔧 Token 估算防抖
  useEffect(() => {
    // 首帧跳过 token 计算
    if (!isReady) return;

    if (tokenDebounceRef.current) {
      clearTimeout(tokenDebounceRef.current);
    }
    tokenDebounceRef.current = setTimeout(() => {
      setDebouncedTokenCount(estimateTokenCount(inputValue));
    }, INPUT_BAR_CONFIG.delays.tokenDebounce);
  }, [inputValue, isReady]);

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
  const syncedStatusRef = useRef<Map<string, { stage: string; percent: number }>>(new Map());
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
          if (status.stage === 'completed' || status.stage === 'error') {
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

      // 如果状态未变化，跳过更新（允许 5% 的进度容差，减少中间状态更新频率）
      if (lastSynced &&
        lastSynced.stage === currentStage &&
        Math.abs(lastSynced.percent - currentPercent) < 5 &&
        currentStage !== 'completed' &&
        currentStage !== 'error') {
        return;
      }

      // 更新已同步状态
      syncedStatus.set(att.id, { stage: currentStage, percent: currentPercent });

      const mediaTypeLabel = isPdf
        ? t('chatV2:inputBar.mediaType.pdf')
        : t('chatV2:inputBar.mediaType.image');

      if (status.stage === 'completed') {
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
            stage: 'completed',
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
            stage: status.stage as 'page_rendering' | 'page_compression' | 'ocr_processing' | 'vector_indexing' | 'image_compression',
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
      className={cn(
        // 🎨 布局分离：作为 flex 子项，relative 用于面板定位
        // 🔧 P0修复：移除 ring 样式，避免拖拽时显示难看的实心边框
        'w-full flex-shrink-0 relative z-[100] transition-all duration-500 ease-out unified-input-docked',
        className
      )}
      style={{
        // 🎨 移动端底部安全区 + 导航栏间距（使用 bottomGapValue 同时包含安全区域和导航栏高度）
        paddingBottom: isMobile && !mobileLayout?.isFullscreenContent ? bottomGapValue : '8px',
        ['--unified-input-docked-height' as any]: dockedHeightVarValue,
        ['--unified-input-bottom-gap' as any]: bottomGapValue,
      }}
      {...dropZoneProps}
    >
      {/* 🎨 输入容器 - 统一全圆角悬浮卡片样式，z-[200] 确保在面板之上 */}
      <div
        ref={inputContainerRef}
        className="relative z-[200] rounded-[26px] mx-2 sm:mx-4 bg-background/80 supports-[backdrop-filter]:bg-background/60 backdrop-blur-xl backdrop-saturate-150 border border-border/40 shadow-sm transition-all duration-300 p-3 pl-4 ring-1 ring-border/5"
      >
        {/* 🔧 P0修复：拖拽遮罩层移到输入容器内部，确保与输入框完全重合 */}
        {isReady && isDragging && (
          <div className="absolute inset-0 z-[300] flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary backdrop-blur-sm rounded-[26px] pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-primary">
              <Upload size={32} />
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

          {/* 🔧 P3: 激活功能 Chips - 已禁用：用户反馈不需要此功能 */}
          {/* <ActiveFeatureChips
            features={activeFeatures}
            disabled={isStreaming}
          /> */}

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

          <CustomScrollArea
            fullHeight={false}
            className="relative w-full"
            viewportRef={textareaScrollViewportRef}
            viewportClassName={textareaViewportHeight <= 40 ? '!overflow-hidden' : undefined}
            data-hide-scrollbar={textareaViewportHeight <= 40 ? 'true' : undefined}
            style={{ height: `${textareaViewportHeight}px` }}
          >
            <textarea
              data-testid="input-bar-v2-textarea"
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => {
                onInputChange(e.target.value);
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
                  if (showStop) {
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
                } else {
                  // 未就绪时提示用户，避免静默丢弃粘贴事件
                  showGlobalNotification('warning', t('chatV2:inputBar.pasteNotReady'));
                }
              }}
              readOnly={isStreaming}
              rows={1}
              className="w-full bg-transparent border-0 outline-none text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:ring-0 resize-none leading-relaxed py-1 overflow-hidden"
              style={{
                minHeight: '40px',
                background: 'transparent',
              }}
            />
          </CustomScrollArea>
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
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-none min-w-0 flex-1 md:flex-none md:overflow-visible">
            {leftAccessory}

            {/* ★ 加号菜单已移除，统一桌面端和移动端样式 */}

            {/* 🔧 P0: 推理模式独立按钮（高频功能提升） */}
            {onToggleThinking && (
              <CommonTooltip
                content={
                  <span className="flex items-center gap-2">
                    <span>{t('chatV2:inputBar.thinking')}</span>
                    <kbd className="px-1 py-0.5 text-[10px] font-mono bg-muted/50 rounded border border-border/50">⌘⇧T</kbd>
                  </span>
                }
                position={tooltipPosition}
                disabled={tooltipDisabled}
              >
                <button
                  data-testid="btn-toggle-thinking"
                  onClick={onToggleThinking}
                  className={cn(
                    iconButtonClass,
                    'relative transition-colors',
                    enableThinking
                      ? 'text-purple-500 hover:text-purple-600 dark:text-purple-400 dark:hover:text-purple-300'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-label={t('chatV2:inputBar.thinking')}
                  aria-pressed={enableThinking}
                >
                  <span className="relative inline-flex items-center justify-center">
                    <Atom size={18} />
                    {/* 激活时显示小圆点 */}
                    {enableThinking && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
                    )}
                  </span>
                </button>
              </CommonTooltip>
            )}

            {/* 模型选择按钮 */}
            <CommonTooltip content={t('chat_host:model_panel.title')} position={tooltipPosition} disabled={tooltipDisabled}>
              <button
                data-testid="btn-toggle-model"
                onClick={() => togglePanel('model')}
                className={cn(
                  iconButtonClass,
                  'transition-colors',
                  panelStates.model
                    ? 'text-primary hover:text-primary/80'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                aria-label={t('chatV2:inputBar.toggleModelPanel')}
              >
                <span className="relative inline-flex items-center justify-center">
                  <DsAnalysisIconMuted className="w-[18px] h-[18px]" />
                </span>
              </button>
            </CommonTooltip>

            {/* 🔧 P0: 技能选择独立按钮 */}
            {renderSkillPanel && (
              <CommonTooltip
                content={
                  activeSkillIds && activeSkillIds.length > 0
                    ? t('skills:active')
                    : hasLoadedSkills
                      ? t('skills:toolLoaded')
                      : t('skills:title')
                }
                position={tooltipPosition}
                disabled={tooltipDisabled}
              >
                <button
                  data-testid="btn-toggle-skill"
                  onClick={() => togglePanel('skill')}
                  className={cn(
                    iconButtonClass,
                    'relative transition-colors',
                    (panelStates.skill || (activeSkillIds && activeSkillIds.length > 0))
                      ? 'text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300'
                      : hasLoadedSkills
                        ? 'text-amber-400/70 hover:text-amber-500 dark:text-amber-500/70 dark:hover:text-amber-400'
                        : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-label={t('skills:title')}
                  aria-pressed={panelStates.skill || (activeSkillIds && activeSkillIds.length > 0) || !!hasLoadedSkills}
                >
                  <span className="relative inline-flex items-center justify-center">
                    <Zap size={18} />
                    {activeSkillIds && activeSkillIds.length > 0 ? (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                    ) : hasLoadedSkills ? (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-amber-400/70 rounded-full" />
                    ) : null}
                  </span>
                </button>
              </CommonTooltip>
            )}

            {/* 🔧 P0: MCP 工具独立按钮 */}
            {renderMcpPanel && (
              <CommonTooltip
                content={
                  <span className="flex items-center gap-2">
                    <span>{t('analysis:input_bar.mcp.title')}</span>
                    <kbd className="px-1 py-0.5 text-[10px] font-mono bg-muted/50 rounded border border-border/50">⌘⇧M</kbd>
                  </span>
                }
                position={tooltipPosition}
                disabled={tooltipDisabled}
              >
                <button
                  data-testid="btn-toggle-mcp"
                  onClick={() => togglePanel('mcp')}
                  className={cn(
                    iconButtonClass,
                    'relative transition-colors',
                    (panelStates.mcp || mcpEnabled)
                      ? 'text-emerald-500 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-label={t('analysis:input_bar.mcp.title')}
                  aria-pressed={panelStates.mcp || mcpEnabled}
                >
                  <span className="relative inline-flex items-center justify-center">
                    <Wrench size={18} />
                    {/* 🔧 有选中的非内置 MCP 服务器时才显示数量徽章 */}
                    {selectedMcpServerCount > 0 && (
                      <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold bg-emerald-500 text-white rounded-full shadow-sm">
                        {selectedMcpServerCount > 9 ? '9+' : selectedMcpServerCount}
                      </span>
                    )}
                  </span>
                </button>
              </CommonTooltip>
            )}

          </div>

          {/* 右侧按钮 - 固定不滚动 */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {extraButtonsRight}

            {/* Token 估算（防抖后） */}
            {isReady && <InputTokenEstimate tokenCount={debouncedTokenCount} />}

            {/* 附件按钮 - 移到发送按钮左侧 */}
            <CommonTooltip
              content={
                attachmentCount > 0
                  ? `${t('analysis:input_bar.attachments.title')} (${attachmentCount})`
                  : t('analysis:input_bar.attachments.title')
              }
              position={tooltipPosition}
              disabled={tooltipDisabled}
            >
              <button
                data-testid="btn-toggle-attachments"
                onClick={toggleAttachmentPanel}
                className={cn(
                  iconButtonClass,
                  'relative text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60'
                )}
                aria-label={t('analysis:input_bar.attachments.title')}
              >
                <span className="relative inline-flex items-center justify-center">
                  <Paperclip size={18} />
                  {attachmentCount > 0 && (
                    <span className="pointer-events-none absolute -right-1 -bottom-1 flex h-4 min-w-[1.1rem] items-center justify-center rounded-full border bg-primary px-[0.25rem] text-[10px] font-semibold text-primary-foreground shadow-sm">
                      {attachmentBadgeLabel}
                    </span>
                  )}
                </span>
              </button>
            </CommonTooltip>

            {/* 🆕 媒体处理中提示 */}
            {hasProcessingMedia && (
              <div className="text-xs text-muted-foreground flex items-center gap-1 mr-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="hidden sm:inline">
                  {processingIndicatorLabel || t('chatV2:inputBar.processingIndicator')}
                </span>
              </div>
            )}

            {/* 发送/停止按钮 - 极简圆形风格 */}
            {showStop ? (
              <button
                data-testid="btn-stop"
                onClick={handleStop}
                disabled={!canAbort}
                className={cn(
                  'flex items-center justify-center w-8 h-8 rounded-full',
                  'bg-destructive text-destructive-foreground',
                  'hover:opacity-90 transition-all duration-200 shadow-sm',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
                aria-label={t('analysis:input_bar.actions.stop')}
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <CommonTooltip
                content={disabledSend ? sendBlockedReason : undefined}
                disabled={!disabledSend || isMobile || !sendBlockedReason}
              >
                <button
                  data-testid="btn-send"
                  onClick={handleSend}
                  disabled={disabledSend}
                  className={cn(
                    'flex items-center justify-center w-8 h-8 rounded-full',
                    'transition-all duration-200 shadow-sm',
                    // 不可发送状态：灰色背景
                    disabledSend
                      ? 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                      : 'bg-primary text-primary-foreground hover:scale-105 active:scale-95 shadow-md shadow-primary/20'
                  )}
                  aria-label={t('analysis:input_bar.actions.send')}
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              </CommonTooltip>
            )}
          </div>
        </div>
      </div>

      {/* 🔧 面板容器 - 用于检测点击是否在面板内 */}
      <div ref={panelContainerRef}>
        {/* 附件面板 - ★ 统一桌面端和移动端样式 */}
        {attachmentPanelMotion.shouldRender && (
          <div
            className={cn(
              'absolute left-0 right-0 overflow-hidden pointer-events-none z-[100]',
              'bottom-full -mb-3 pb-4'
            )}
            style={{ height: 'clamp(200px, 40vh, 400px)' }}
          >
            <div
              className={cn(
                'absolute left-3 right-3 rounded-2xl glass-panel border border-[hsl(var(--border))] p-3 transition-transform duration-200 ease-out will-change-transform motion-reduce:transition-none motion-reduce:duration-0 z-[100]',
                'bottom-4 origin-bottom',
                attachmentPanelMotion.motionState === 'open' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
              )}
              aria-hidden={attachmentPanelMotion.motionState !== 'open'}
              data-panel-motion={attachmentPanelMotion.motionState}
            >
              {/* 面板头部 */}
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Paperclip size={16} />
                  <span>{t('analysis:input_bar.attachments.title')} ({attachments.length})</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => fileInputRef.current?.click()} className="rounded-md px-2 py-1 text-xs text-primary hover:bg-accent/40 border">
                    + {t('analysis:input_bar.attachments.add')}
                  </button>
                  {/* 资源库按钮 - 桌面端在右侧打开 Learning Hub 面板，移动端打开右侧滑屏 */}
                  <button
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_TOGGLE_PANEL));
                    }}
                    className="rounded-md px-2 py-1 text-xs text-primary hover:bg-accent/40 border flex items-center gap-1"
                  >
                    <FolderOpen size={12} />
                    {t('chatV2:inputBar.resourceLibrary')}
                  </button>
                  {isMobileEnv && (
                    <button onClick={handleCameraClick} className="rounded-md px-2 py-1 text-xs text-primary hover:bg-accent/40 border flex items-center gap-1">
                      <Camera size={12} />
                      {t('chatV2:inputBar.camera')}
                    </button>
                  )}
                  {attachments.length > 0 && (
                    <button onClick={() => {
                      // 🔧 P1-25: 释放所有 Blob URL，避免内存泄漏
                      attachments.forEach(att => {
                        if (att.previewUrl?.startsWith('blob:')) {
                          URL.revokeObjectURL(att.previewUrl);
                        }
                      });
                      onClearAttachments();
                    }} className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10">
                      {t('analysis:input_bar.attachments.clear_all')}
                    </button>
                  )}
                  <button onClick={toggleAttachmentPanel} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40">
                    {t('common:actions.close')}
                  </button>
                </div>
              </div>

              {/* 附件列表 */}
              <div className="flex flex-col gap-2 max-h-56 overflow-auto">
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
                    const readyModes = getEffectiveReadyModes(statusForModes, mediaType, attachment.status === 'ready');
                    const missingModes = getMissingModes(selectedModes, readyModes);
                    const missingModesLabel = missingModes.length > 0 ? formatModeList(missingModes) : '';
                    const displayPercent = getDisplayPercent(mediaProgress, isPdf);
                    let stageLabel = getStageLabel(t, mediaProgress, isPdf, isImage);
                    if (mediaProgress?.stage === 'completed' && missingModesLabel) {
                      stageLabel = t('chatV2:inputBar.completedMissingModes', {
                        modes: missingModesLabel,
                      });
                    }
                    const progressLabel = stageLabel
                      ? (displayPercent > 0 ? `${stageLabel} · ${displayPercent}%` : stageLabel)
                      : `${displayPercent}%`;

                    const statusIcon =
                      attachment.status === 'ready' && missingModes.length > 0
                        ? <AlertTriangle size={12} className="text-amber-600" />
                        : attachment.status === 'ready' ? <CheckCircle2 size={12} className="text-green-600" />
                          : attachment.status === 'error' ? <XCircle size={12} className="text-red-600" />
                            : isMediaProcessing ? <Loader2 size={12} className="text-blue-500 animate-spin" />
                              : <Clock size={12} className="text-muted-foreground" />;
                    const toneClass = isVfsRef
                      ? 'border-blue-200/60 bg-blue-50/70 dark:border-blue-800/50 dark:bg-blue-900/20'
                      : attachment.status === 'error' ? 'border-red-200/70 bg-red-50/70 dark:border-red-800/50 dark:bg-red-900/20'
                        : attachment.status === 'ready' && missingModes.length > 0
                          ? 'border-amber-200/60 bg-amber-50/70 dark:border-amber-800/50 dark:bg-amber-900/20'
                          : attachment.status === 'ready' ? 'border-emerald-200/60 bg-emerald-50/70 dark:border-emerald-800/50 dark:bg-emerald-900/20'
                            : isMediaProcessing ? 'border-blue-200/60 bg-blue-50/70 dark:border-blue-800/50 dark:bg-blue-900/20'
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
                            {/* 🆕 PDF 处理进度显示 */}
                            {isMediaProcessing && mediaProgress && (
                              <div className="flex items-center gap-2 mt-0.5">
                                <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-blue-500 transition-all duration-300"
                                    style={{ width: `${displayPercent}%` }}
                                  />
                                </div>
                                <span className="text-[10px] text-blue-600 dark:text-blue-400 whitespace-nowrap">
                                  {progressLabel}
                                </span>
                              </div>
                            )}
                            {missingModesLabel && (
                              <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                                {t('chatV2:inputBar.modesNotReady', { modes: missingModesLabel })}
                              </div>
                            )}
                          </div>
                          <span className={cn("text-[12px]", isVfsRef ? "text-blue-600 dark:text-blue-400 font-medium" : "text-muted-foreground")}>{sizeLabel}</span>
                          <span className="flex items-center gap-1">{statusIcon}</span>
                          {/* ★ P0 修复：错误状态时显示重试按钮（使用正确的 sourceId） */}
                          {attachment.status === 'error' && attachment.sourceId && (
                            <button
                              onClick={async () => {
                                try {
                                  // ★ P0 修复：使用 sourceId (att_xxx) 而不是 resourceId (res_xxx)
                                  const fileId = attachment.sourceId!;
                                  const isPdf = attachment.mimeType === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');

                                  // ★ 调试日志：记录重试操作
                                  logAttachment('ui', 'retry_processing_start', {
                                    attachmentId: attachment.id,
                                    sourceId: fileId,
                                    mediaType: isPdf ? 'pdf' : 'image',
                                    previousError: attachment.error,
                                  });

                                  // 先更新状态为 processing
                                  onUpdateAttachment(attachment.id, {
                                    status: 'processing',
                                    error: undefined,
                                    processingStatus: {
                                      stage: isPdf ? 'ocr_processing' : 'image_compression',
                                      percent: isPdf ? 50 : 10,
                                      readyModes: attachment.processingStatus?.readyModes || (isPdf ? ['text', 'image'] : ['image']),
                                      mediaType: isPdf ? 'pdf' : 'image',
                                    },
                                  });
                                  await retryPdfProcessing(fileId);

                                  // ★ 调试日志：重试成功
                                  logAttachment('ui', 'retry_processing_triggered', {
                                    attachmentId: attachment.id,
                                    sourceId: fileId,
                                  }, 'success');
                                  showGlobalNotification('success', t('chatV2:inputBar.retryStarted'));
                                } catch (error) {
                                  // ★ 调试日志：重试失败
                                  logAttachment('ui', 'retry_processing_failed', {
                                    attachmentId: attachment.id,
                                    error: getErrorMessage(error),
                                  }, 'error');
                                  // 重试失败，恢复错误状态
                                  const retryErrorMsg = t('chatV2:inputBar.retryFailed', { error: getErrorMessage(error) });
                                  onUpdateAttachment(attachment.id, {
                                    status: 'error',
                                    error: retryErrorMsg,
                                  });
                                  showGlobalNotification('error', retryErrorMsg);
                                }
                              }}
                              className="rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                            >
                              {t('common:retry')}
                            </button>
                          )}
                          <button onClick={() => {
                            // ★ 调试日志：记录移除操作
                            logAttachment('ui', 'attachment_remove', {
                              attachmentId: attachment.id,
                              sourceId: attachment.sourceId,
                              fileName: attachment.name,
                              status: attachment.status,
                            });
                            // 🔧 P1-25: 释放 Blob URL，避免内存泄漏
                            if (attachment.previewUrl?.startsWith('blob:')) {
                              URL.revokeObjectURL(attachment.previewUrl);
                            }
                            onRemoveAttachment(attachment.id);
                          }} className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30">
                            {t('analysis:input_bar.attachments.remove')}
                          </button>
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
              </div>

            </div>
          </div>
        )}

        {/* 🔧 P1修复：隐藏的文件选择器移到顶层，确保在任何情况下都可用 */}
        <input ref={fileInputRef} type="file" multiple accept={fileAccept} onChange={handleFileSelect} className="hidden" />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleCameraChange} className="hidden" />

        {/* ★ RAG 知识库面板已移至对话控制面板 */}

        {/* 模型选择面板 - ★ 统一桌面端和移动端样式 */}
        {renderModelPanel && (
          modelPanelMotion.shouldRender && (
            <div
              className={cn(
                'absolute left-0 right-0 overflow-hidden pointer-events-none z-[100]',
                'bottom-full -mb-3 pb-4'
              )}
              style={{ height: 'clamp(380px, 50vh, 500px)' }}
            >
              <div
                className={cn(
                  'absolute left-3 right-3 rounded-2xl glass-panel border border-[hsl(var(--border))] p-3 transition-transform duration-200 ease-out will-change-transform motion-reduce:transition-none motion-reduce:duration-0 z-[100]',
                  'bottom-4 origin-bottom',
                  modelPanelMotion.motionState === 'open' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
                )}
                aria-hidden={modelPanelMotion.motionState !== 'open'}
                data-panel-motion={modelPanelMotion.motionState}
                style={{ maxHeight: 'clamp(360px, 48vh, 480px)' }}
              >
                {renderModelPanel()}
              </div>
            </div>
          )
        )}

        {/* MCP 工具面板 - ★ 统一桌面端和移动端样式 */}
        {renderMcpPanel && (
          mcpPanelMotion.shouldRender && (
            <div
              className={cn(
                'absolute left-0 right-0 overflow-hidden pointer-events-none z-[100]',
                'bottom-full -mb-3 pb-4'
              )}
              style={{ height: 'clamp(300px, 45vh, 450px)' }}
            >
              <div
                className={cn(
                  'absolute left-3 right-3 rounded-2xl glass-panel border border-[hsl(var(--border))] p-3 transition-transform duration-200 ease-out will-change-transform motion-reduce:transition-none motion-reduce:duration-0 z-[100]',
                  'bottom-4 origin-bottom',
                  mcpPanelMotion.motionState === 'open' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
                )}
                aria-hidden={mcpPanelMotion.motionState !== 'open'}
                data-panel-motion={mcpPanelMotion.motionState}
                style={{ maxHeight: 'clamp(280px, 43vh, 430px)' }}
              >
                {renderMcpPanel()}
              </div>
            </div>
          )
        )}


        {/* ★ 知识图谱选择面板已废弃（图谱模块已移除） */}

        {/* 技能选择面板 - ★ 统一桌面端和移动端样式 */}
        {renderSkillPanel && (
          skillPanelMotion.shouldRender && (
            <div
              className={cn(
                'absolute left-2 right-2 z-[100]',
                'bottom-full mb-2',
                'rounded-2xl glass-panel border border-[hsl(var(--border))] p-3',
                'flex flex-col overflow-hidden',
                'transition-all duration-200 ease-out will-change-transform motion-reduce:transition-none motion-reduce:duration-0',
                skillPanelMotion.motionState === 'open'
                  ? 'translate-y-0 opacity-100 pointer-events-auto'
                  : 'translate-y-4 opacity-0 pointer-events-none'
              )}
              aria-hidden={skillPanelMotion.motionState !== 'open'}
              data-panel-motion={skillPanelMotion.motionState}
              style={{ maxHeight: 'min(400px, calc(100vh - 280px))' }}
            >
              {renderSkillPanel()}
            </div>
          )
        )}

        {/* 🆕 工具审批卡片面板 - 始终显示在输入栏上方，不与其他面板互斥 */}
        {pendingApprovalRequest && sessionId && (
          <div
            className={cn(
              'absolute left-0 right-0 pointer-events-none z-[110]',
              'bottom-full -mb-3 pb-4'
            )}
          >
            <div
              className={cn(
                'absolute left-2 right-2 pointer-events-auto',
                'bottom-4 origin-bottom',
                'animate-in slide-in-from-bottom-4 duration-200'
              )}
            >
              <ToolApprovalCard
                request={pendingApprovalRequest}
                sessionId={sessionId}
                className="shadow-lg"
              />
            </div>
          </div>
        )}
      </div>{/* 🔧 panelContainerRef 结束 */}
    </div>
  );
};

export default InputBarUI;
