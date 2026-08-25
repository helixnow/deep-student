/**
 * 附件注入模式/处理进度的展示辅助函数（从 InputBarUI.tsx 拆出）
 *
 * InputBarUI（派生发送可用性）与 AttachmentPanelBody（附件面板行渲染）共用。
 * ★ N3：模式集合计算已统一到 injectModeUtils（SSOT），这里是适配
 * InputBarUI 系调用签名的薄层委托 + 纯展示辅助。
 */

import type { TFunction } from 'i18next';
import type { AttachmentMeta, PdfProcessingStatus } from '../../core/types/common';
import {
  type MediaInjectMode,
  getSelectedInjectModes as ssotGetSelectedModes,
  getEffectiveReadyModes as ssotGetEffectiveReadyModes,
} from './injectModeUtils';

export function clampPercent(value?: number): number {
  const safe = Number.isFinite(value) ? (value as number) : 0;
  return Math.min(100, Math.max(0, Math.round(safe)));
}

export function getStageLabel(
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
      if (isImage) return t('learningHub:processing.ocrRecognizing');
      return current && total
        ? t('chatV2:inputBar.stage.ocrProcessingProgress', { current, total })
        : t('learningHub:processing.ocrRecognizing');
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

export function getDisplayPercent(
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

export function getSelectedModes(
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
export function getEffectiveReadyModes(
  status: PdfProcessingStatus | undefined,
  mediaType: 'pdf' | 'image',
  attachment: AttachmentMeta
): MediaInjectMode[] | undefined {
  return ssotGetEffectiveReadyModes(attachment, mediaType, status);
}

export function getMissingModes(
  selectedModes: MediaInjectMode[],
  readyModes?: MediaInjectMode[]
): MediaInjectMode[] {
  if (!selectedModes.length) return [];
  if (!readyModes) return selectedModes;
  const readySet = new Set(readyModes);
  return selectedModes.filter((mode) => !readySet.has(mode));
}

export function hasAnyReadyMode(
  selectedModes: MediaInjectMode[],
  readyModes?: MediaInjectMode[]
): boolean {
  if (!selectedModes.length) return true;
  if (!readyModes || !readyModes.length) return false;
  const readySet = new Set(readyModes);
  return selectedModes.some((mode) => readySet.has(mode));
}
