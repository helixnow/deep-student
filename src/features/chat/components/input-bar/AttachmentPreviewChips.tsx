import React, { memo, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { InlineImageViewer } from '../InlineImageViewer';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import type { AttachmentMeta, PdfProcessingStatus } from '../../core/types/common';
import {
  TEXT_FILE_MAX_LENGTH,
  ATTACHMENT_TEXT_INJECT_EXTENSIONS,
} from '../../core/constants';
import {
  type MediaInjectMode,
  getMediaTypeForAttachment,
  getSelectedInjectModes,
  getEffectiveReadyModes,
} from './injectModeUtils';

interface AttachmentPreviewChipsProps {
  attachments: AttachmentMeta[];
  onRemove: (attachmentId: string) => void;
  /** 错误态内联重试（复用附件面板的重试链路） */
  onRetry?: (attachment: AttachmentMeta) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * chip 即仪表盘：上传 → 处理 → 可检索 三段状态
 */
type ChipLifecycle = 'uploading' | 'processing' | 'partial' | 'ready' | 'error' | 'plain';

interface ChipStatusInfo {
  lifecycle: ChipLifecycle;
  /** 统一进度（上传 0-50，处理 50-100），无进度时为 null */
  unifiedPercent: number | null;
  /** 选中的注入模式（仅 PDF/图片） */
  selectedModes: MediaInjectMode[];
  /** 尚未就绪的选中模式 */
  missingModes: MediaInjectMode[];
  /** PDF 总页数（就绪后显示页数徽标） */
  totalPages?: number;
}

function getFileExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.trim().toLowerCase();
  return extension && extension !== fileName.toLowerCase() ? extension : '';
}

function getAttachmentIcon(attachment: AttachmentMeta): React.ElementType {
  const extension = getFileExtension(attachment.name);
  if (isImageAttachment(attachment)) {
    return ImageIcon;
  }
  if (['html', 'htm', 'css', 'js', 'ts', 'tsx', 'json', 'xml'].includes(extension)) {
    return FileCode;
  }
  if (['txt', 'md', 'pdf', 'doc', 'docx'].includes(extension) || attachment.mimeType.startsWith('text/')) {
    return FileText;
  }
  return File;
}

function isImageAttachment(attachment: AttachmentMeta): boolean {
  return attachment.type === 'image' || getMediaTypeForAttachment(attachment) === 'image';
}

/**
 * ★ 截断预判：纯文本注入的文件（字节数 ≈ 注入文本长度）超过 100KB 时，
 * 注入将截断到前 100KB。PDF/图片走独立分页/多模态链路，不在此预判范围。
 */
function willLikelyTruncate(attachment: AttachmentMeta): boolean {
  if (getMediaTypeForAttachment(attachment) !== null) return false;
  const ext = getFileExtension(attachment.name);
  if (!ATTACHMENT_TEXT_INJECT_EXTENSIONS.includes(ext)) return false;
  return (attachment.size ?? 0) > TEXT_FILE_MAX_LENGTH;
}

function computeChipStatus(
  attachment: AttachmentMeta,
  storeStatus: PdfProcessingStatus | undefined
): ChipStatusInfo {
  const mediaType = getMediaTypeForAttachment(attachment);
  const status = storeStatus || attachment.processingStatus;

  const selectedModes = mediaType ? getSelectedInjectModes(attachment, mediaType) : [];
  const readyModes = mediaType ? getEffectiveReadyModes(attachment, mediaType, status) : undefined;
  const readySet = new Set(readyModes ?? []);
  const missingModes = selectedModes.filter((mode) => !readySet.has(mode));
  const totalPages = mediaType === 'pdf'
    ? (status?.totalPages ?? attachment.processingStatus?.totalPages)
    : undefined;

  if (attachment.status === 'error') {
    return { lifecycle: 'error', unifiedPercent: null, selectedModes, missingModes, totalPages };
  }

  if (attachment.status === 'uploading' || attachment.status === 'pending') {
    const percent = attachment.uploadProgress != null
      ? Math.min(50, Math.max(0, Math.round(attachment.uploadProgress)))
      : null;
    return { lifecycle: 'uploading', unifiedPercent: percent, selectedModes, missingModes, totalPages };
  }

  if (attachment.status === 'processing') {
    const rawPercent = status?.percent ?? 0;
    const percent = 50 + Math.round(Math.min(100, Math.max(0, rawPercent)) * 0.5);
    return { lifecycle: 'processing', unifiedPercent: percent, selectedModes, missingModes, totalPages };
  }

  // ready：非媒体附件无模式概念，直接视为可用
  if (!mediaType) {
    return { lifecycle: 'plain', unifiedPercent: null, selectedModes, missingModes, totalPages };
  }

  return {
    lifecycle: missingModes.length > 0 ? 'partial' : 'ready',
    unifiedPercent: null,
    selectedModes,
    missingModes,
    totalPages,
  };
}

/**
 * 微型进度环（chip 图标位内联，token 配色，motion-reduce 降级为静态环）
 */
const ChipProgressRing: React.FC<{ percent: number | null }> = ({ percent }) => {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const clamped = percent == null ? 25 : Math.min(100, Math.max(0, percent));
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn(
        'h-5 w-5 text-info',
        percent == null && 'animate-spin motion-reduce:animate-none'
      )}
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r={radius} stroke="var(--button-utility-hover)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 10 10)"
        className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
      />
    </svg>
  );
};

export const AttachmentPreviewChips: React.FC<AttachmentPreviewChipsProps> = memo(({
  attachments,
  onRemove,
  onRetry,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation(['analysis', 'chatV2', 'common']);
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // 复用附件面板的处理状态数据源（后端事件 + 兜底轮询写入的同一 store）
  const pdfStatusMap = usePdfProcessingStore(state => state.statusMap);

  const modeLabelMap = useMemo<Record<MediaInjectMode, string>>(() => ({
    text: t('chatV2:injectMode.pdf.text'),
    ocr: t('chatV2:injectMode.image.ocr'),
    image: t('chatV2:injectMode.image.image'),
  }), [t]);

  const formatModeSummary = useCallback((modes: MediaInjectMode[]): string => {
    return modes.map((mode) => modeLabelMap[mode]).join(t('chatV2:injectMode.joiner'));
  }, [modeLabelMap, t]);

  const imageAttachments = useMemo(
    () => attachments.filter((a) => isImageAttachment(a) && a.previewUrl),
    [attachments]
  );

  const imageUrls = useMemo(
    () => imageAttachments.map((a) => a.previewUrl!),
    [imageAttachments]
  );

  const handleChipClick = useCallback((attachment: AttachmentMeta) => {
    if (isImageAttachment(attachment) && attachment.previewUrl) {
      const imgIdx = imageAttachments.findIndex((a) => a.id === attachment.id);
      setCurrentImageIndex(imgIdx >= 0 ? imgIdx : 0);
      setImageViewerOpen(true);
      return;
    }

    const sourceId = attachment.sourceId || attachment.resourceId;
    if (!sourceId) return;

    // 附件预览统一走 file 类型（富文档由预览面板内部再分流）
    window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
      detail: {
        id: sourceId,
        type: 'file',
        title: attachment.name,
      },
    }));
  }, [imageAttachments]);

  const handleCloseImageViewer = useCallback(() => {
    setImageViewerOpen(false);
  }, []);

  const handleNextImage = useCallback(() => {
    setCurrentImageIndex((prev) => (prev + 1) % imageUrls.length);
  }, [imageUrls.length]);

  const handlePrevImage = useCallback(() => {
    setCurrentImageIndex((prev) => (prev - 1 + imageUrls.length) % imageUrls.length);
  }, [imageUrls.length]);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <CustomScrollArea
        role="list"
        aria-label={t('analysis:input_bar.attachments.title')}
        orientation="both"
        fullHeight={false}
        className={cn(
          'attachment-preview-chips mb-2 max-h-[76px]',
          className
        )}
        viewportClassName={cn(
          // ★ M6 修复：换行断点从 sm(640) 对齐到 md(768)——与移动端布局断点一致，
          // 避免 640-767px 区间"移动端布局 + 桌面 wrap 行为"的分裂
          'flex max-h-[76px] flex-nowrap items-center gap-2 pr-1 md:flex-wrap md:content-start'
        )}
      >
        {attachments.map((attachment) => {
          const Icon = getAttachmentIcon(attachment);
          const showImagePreview = Boolean(
            attachment.previewUrl
            && isImageAttachment(attachment)
          );

          const storeStatus = attachment.sourceId ? pdfStatusMap.get(attachment.sourceId) : undefined;
          const normalizedStoreStatus = storeStatus
            ? ({
              ...storeStatus,
              stage: storeStatus.stage === 'pending' ? undefined : storeStatus.stage,
            } as PdfProcessingStatus)
            : undefined;
          const chipStatus = computeChipStatus(attachment, normalizedStoreStatus);
          const isBusy = chipStatus.lifecycle === 'uploading' || chipStatus.lifecycle === 'processing';
          const isError = chipStatus.lifecycle === 'error';
          const truncationLikely = !isError && willLikelyTruncate(attachment);
          const modeSummary = chipStatus.selectedModes.length > 0
            ? formatModeSummary(chipStatus.selectedModes)
            : '';

          const statusTitle = isError
            ? (attachment.error || t('chatV2:inputBar.chip.error'))
            : chipStatus.lifecycle === 'uploading'
              ? t('chatV2:inputBar.attachmentsUploading')
              : chipStatus.lifecycle === 'processing'
                ? t('chatV2:inputBar.processingIndicator')
                : chipStatus.lifecycle === 'partial'
                  ? t('chatV2:inputBar.modesNotReady', { modes: formatModeSummary(chipStatus.missingModes) })
                  : chipStatus.lifecycle === 'ready'
                    ? t('chatV2:inputBar.chip.ready')
                    : attachment.name;

          return (
            <div
              key={attachment.id}
              role="listitem"
              aria-label={attachment.name}
              // ui-rise-in：新添加的 chip 挂载入场（150ms fade+rise，reduced-motion 自动降级）
              className="group/attachment-chip ui-rise-in relative inline-flex min-w-0 shrink-0 items-center"
            >
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleChipClick(attachment)}
                className={cn(
                  'attachment-preview-chip h-8 w-max justify-start gap-2 rounded-full border bg-[color:var(--surface-panel-strong)] py-0 pl-1.5 pr-3 text-ui font-semibold text-foreground shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:bg-[color:var(--button-plain-hover-bg)] cursor-pointer motion-reduce:transition-none',
                  isError
                    ? 'border-destructive/40 hover:border-destructive/60'
                    : 'border-[color:var(--input-shell-border)] hover:border-[color:var(--button-plain-border)]',
                  disabled && 'pointer-events-none opacity-60'
                )}
                title={
                  truncationLikely
                    ? t('chatV2:inputBar.chip.titleTruncated', {
                        name: attachment.name,
                        status: statusTitle,
                        truncation: t('chatV2:inputBar.chip.truncatedTitle'),
                      })
                    : t('chatV2:inputBar.chip.title', {
                        name: attachment.name,
                        status: statusTitle,
                      })
                }
              >
                {/* 图标区域：上传/处理中显示进度环；hover 时变为 X 删除按钮 */}
                <span
                  data-testid={`attachment-chip-icon-${attachment.id}`}
                  className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[color:var(--surface-elevated)] text-muted-foreground"
                >
                  {/* 默认：进度环 / 文件图标 / 图片预览 */}
                  <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/attachment-chip:opacity-0 motion-reduce:transition-none">
                    {isBusy ? (
                      <ChipProgressRing percent={chipStatus.unifiedPercent} />
                    ) : showImagePreview ? (
                      <img
                        src={attachment.previewUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <Icon size={12} aria-hidden="true" />
                    )}
                  </span>
                  {/* Hover：X 图标覆盖。P0-3：触屏（pointer:coarse）没有 hover，
                      删除按钮常显，且用透明伪元素把命中区域扩到 ≥44px */}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(attachment.id);
                      }}
                      aria-label={t('chatV2:common.removeNamed', { name: attachment.name })}
                      title={t('chatV2:common.removeNamed', { name: attachment.name })}
                      // ★ L5 修复：命中区只向左/上/下外扩（保持 ~44px 高），不再向右
                      // 延伸压住文件名区域，避免"点 chip 开预览"被误判为删除
                      className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity duration-150 group-hover/attachment-chip:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-left-3 [@media(pointer:coarse)]:after:-top-3 [@media(pointer:coarse)]:after:-bottom-3 [@media(pointer:coarse)]:after:right-0 [@media(pointer:coarse)]:after:content-['']"
                    >
                      <X size={10} weight="bold" aria-hidden="true" />
                    </button>
                  )}
                </span>
                {/* ★ M6：超长文件名截断（完整名在 chip title 中） */}
                <span className="max-w-[10rem] truncate">{attachment.name}</span>
                {/* PDF 页数徽标（页数已知时显示） */}
                {typeof chipStatus.totalPages === 'number' && chipStatus.totalPages > 0 && (
                  <span className="rounded-full border border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-muted)] px-1.5 py-px text-2xs font-medium leading-none tabular-nums text-muted-foreground">
                    {t('chatV2:inputBar.chip.pages', { count: chipStatus.totalPages })}
                  </span>
                )}
                {/* ★ 截断预警角标：纯文本注入超过 100KB 时提示将截断（详情见 tooltip） */}
                {truncationLikely && (
                  <span
                    className="whitespace-nowrap rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-2xs font-medium leading-none text-warning"
                    title={t('chatV2:inputBar.chip.truncatedTitle')}
                  >
                    {t('chatV2:inputBar.chip.truncated')}
                  </span>
                )}
                {/* 注入模式微型摘要（如「文本+图片」），错误态隐藏让位给重试 */}
                {modeSummary && !isError && (
                  <span
                    className={cn(
                      'whitespace-nowrap text-2xs font-medium leading-none',
                      chipStatus.lifecycle === 'partial' ? 'text-warning' : 'text-muted-foreground'
                    )}
                    title={statusTitle}
                  >
                    {modeSummary}
                  </span>
                )}
                {/* 错误态：内联标签 + 重试入口 */}
                {isError && (
                  <span className="whitespace-nowrap text-2xs font-medium leading-none text-destructive">
                    {t('chatV2:inputBar.chip.error')}
                  </span>
                )}
                {/* 状态点：可检索(成功)/部分就绪(警示)/处理中(信息脉冲) */}
                {!isError && chipStatus.selectedModes.length > 0 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      chipStatus.lifecycle === 'ready' && 'bg-success',
                      chipStatus.lifecycle === 'partial' && 'bg-warning',
                      isBusy && 'bg-info animate-pulse motion-reduce:animate-none'
                    )}
                  />
                )}
              </DsButton>
              {/* 错误态内联重试（chip 外侧尾随，44px 触控命中区） */}
              {isError && onRetry && attachment.sourceId && !disabled && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(attachment);
                  }}
                  aria-label={t('chatV2:common.retryNamed', { name: attachment.name })}
                  title={t('common:retry')}
                  className="relative ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-destructive/40 text-destructive transition-colors hover:bg-destructive/10 motion-reduce:transition-none [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']"
                >
                  <ArrowClockwise size={12} weight="bold" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </CustomScrollArea>

      {/* 图片预览器 */}
      {imageUrls.length > 0 && (
        <InlineImageViewer
          images={imageUrls}
          currentIndex={currentImageIndex}
          isOpen={imageViewerOpen}
          onClose={handleCloseImageViewer}
          onNext={handleNextImage}
          onPrev={handlePrevImage}
        />
      )}
    </>
  );
});

AttachmentPreviewChips.displayName = 'AttachmentPreviewChips';

export default AttachmentPreviewChips;
