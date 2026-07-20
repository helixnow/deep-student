import type {
  AttachmentMeta,
  AttachmentInjectModes,
  ImageInjectMode,
  PdfInjectMode,
  PdfProcessingStatus,
} from '../../core/types/common';
import {
  DEFAULT_IMAGE_INJECT_MODES,
  DEFAULT_PDF_INJECT_MODES,
} from '../../core/types/common';
import { ATTACHMENT_IMAGE_EXTENSIONS } from '../../core/constants';

export type AttachmentMediaType = 'pdf' | 'image';
export type MediaInjectMode = 'text' | 'ocr' | 'image';

const VALID_INJECT_MODES: ReadonlySet<string> = new Set(['text', 'ocr', 'image']);

function getFileExtension(fileName: string | null | undefined): string {
  if (!fileName) return '';
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop()!.trim().toLowerCase() : '';
}

/**
 * ★ P1 SSOT：统一的附件媒体类型识别。
 *
 * PDF 与图片均按「MIME OR 扩展名」双通道判定，修复历史上
 * 「空 mime 的 .png 不进 OCR/向量流水线」的识别分裂
 * （旧实现部分调用点只看 mimeType.startsWith('image/')）。
 */
export function getAttachmentMediaType(
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): AttachmentMediaType | null {
  const ext = getFileExtension(fileName);

  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return 'pdf';
  }

  if (mimeType?.startsWith('image/') || ATTACHMENT_IMAGE_EXTENSIONS.includes(ext)) {
    return 'image';
  }

  return null;
}

/**
 * 附件对象便捷版（内部与调用方均可用）。
 */
export function getMediaTypeForAttachment(
  attachment: Pick<AttachmentMeta, 'mimeType' | 'name'>
): AttachmentMediaType | null {
  return getAttachmentMediaType(attachment.mimeType, attachment.name);
}

/**
 * ★ P0 SSOT：UI 默认注入模式（创建 ContextRef / 附件时必须显式写入）。
 *
 * 契约：ContextRef.injectModes 永远显式携带，后端「缺省按 text+image 双开」
 * 的兜底逻辑不应再被触发。默认值与 common.ts 的 DEFAULT_* 保持一致：
 * - PDF: ['text']
 * - 图片: ['image']
 */
export function buildDefaultInjectModes(
  mediaType: AttachmentMediaType | null
): AttachmentInjectModes | undefined {
  if (mediaType === 'pdf') {
    return { pdf: [...DEFAULT_PDF_INJECT_MODES] };
  }
  if (mediaType === 'image') {
    return { image: [...DEFAULT_IMAGE_INJECT_MODES] };
  }
  return undefined;
}

/**
 * 解析附件当前生效的注入模式：已有显式选择则原样返回，
 * 否则补全 UI 默认值（用于创建/上传完成/资源库引用三条路径的显式写入）。
 */
export function resolveExplicitInjectModes(
  attachment: Pick<AttachmentMeta, 'mimeType' | 'name' | 'injectModes'>
): AttachmentInjectModes | undefined {
  const mediaType = getMediaTypeForAttachment(attachment);
  if (!mediaType) {
    return attachment.injectModes;
  }
  if (mediaType === 'pdf') {
    if (attachment.injectModes?.pdf?.length) {
      return attachment.injectModes;
    }
    return { ...attachment.injectModes, pdf: [...DEFAULT_PDF_INJECT_MODES] };
  }
  if (attachment.injectModes?.image?.length) {
    return attachment.injectModes;
  }
  return { ...attachment.injectModes, image: [...DEFAULT_IMAGE_INJECT_MODES] };
}

export function getSelectedInjectModes(
  attachment: AttachmentMeta,
  mediaType: AttachmentMediaType
): MediaInjectMode[] {
  if (mediaType === 'pdf') {
    return (attachment.injectModes?.pdf || DEFAULT_PDF_INJECT_MODES) as MediaInjectMode[];
  }
  return (attachment.injectModes?.image || DEFAULT_IMAGE_INJECT_MODES) as MediaInjectMode[];
}

export function getEffectiveReadyModes(
  attachment: AttachmentMeta,
  mediaType: AttachmentMediaType,
  status?: PdfProcessingStatus
): MediaInjectMode[] | undefined {
  const effectiveStatus = status || attachment.processingStatus;

  // 后端图片管线上传完成后立即将 image 加入 readyModes，
  // 不再需要前端虚拟补充。直接使用后端报告的 readyModes。

  if (effectiveStatus?.readyModes?.length) {
    const filtered = effectiveStatus.readyModes.filter(m => VALID_INJECT_MODES.has(m)) as MediaInjectMode[];
    if (filtered.length) {
      return filtered;
    }
  }

  if (effectiveStatus?.stage === 'completed' || effectiveStatus?.stage === 'completed_with_issues') {
    return mediaType === 'pdf' ? ['text'] : ['image'];
  }

  if (attachment.status === 'ready' && !effectiveStatus) {
    return mediaType === 'pdf' ? ['text'] : ['image'];
  }

  // ★ P1 收紧：处理中的图片不再乐观补 'image'。
  // 后端初始 ready_modes=[]，就绪与否一律以后端报告的 readyModes 为准，
  // 避免「UI 放行发送但后端图片压缩尚未完成」的竞态。
  return undefined;
}

export function getMissingInjectModesForAttachment(
  attachment: AttachmentMeta,
  status?: PdfProcessingStatus
): MediaInjectMode[] {
  const mediaType = getMediaTypeForAttachment(attachment);
  if (!mediaType) {
    return [];
  }

  const selectedModes = getSelectedInjectModes(attachment, mediaType);
  if (selectedModes.length === 0) {
    return [];
  }

  const readyModes = getEffectiveReadyModes(attachment, mediaType, status);
  if (!readyModes) {
    return selectedModes;
  }

  const readySet = new Set(readyModes);
  return selectedModes.filter((mode) => !readySet.has(mode));
}

export function areAttachmentInjectModesReady(
  attachment: AttachmentMeta,
  status?: PdfProcessingStatus
): boolean {
  return getMissingInjectModesForAttachment(attachment, status).length === 0;
}

export function hasAnySelectedInjectModeReady(
  attachment: AttachmentMeta,
  status?: PdfProcessingStatus
): boolean {
  const mediaType = getMediaTypeForAttachment(attachment);
  if (!mediaType) {
    return true;
  }

  const selectedModes = getSelectedInjectModes(attachment, mediaType);
  if (selectedModes.length === 0) {
    return true;
  }

  const readyModes = getEffectiveReadyModes(attachment, mediaType, status);
  if (!readyModes || readyModes.length === 0) {
    return false;
  }

  const readySet = new Set(readyModes);
  return selectedModes.some((mode) => readySet.has(mode));
}

export function downgradeInjectModesForNonMultimodal(
  attachment: AttachmentMeta
): AttachmentInjectModes | null {
  const mediaType = getMediaTypeForAttachment(attachment);

  if (!mediaType) {
    return null;
  }

  if (mediaType === 'pdf') {
    const currentModes = (attachment.injectModes?.pdf || DEFAULT_PDF_INJECT_MODES) as PdfInjectMode[];
    if (!currentModes.includes('image')) {
      return null;
    }

    const nextModes = currentModes.filter((mode): mode is PdfInjectMode => mode !== 'image');
    const safeModes: PdfInjectMode[] = nextModes.length > 0 ? nextModes : ['text'];
    return {
      ...attachment.injectModes,
      pdf: safeModes,
    };
  }

  const currentModes = (attachment.injectModes?.image || DEFAULT_IMAGE_INJECT_MODES) as ImageInjectMode[];
  if (!currentModes.includes('image')) {
    return null;
  }

  const nextModes = currentModes.filter((mode): mode is ImageInjectMode => mode !== 'image');
  const safeModes: ImageInjectMode[] = nextModes.length > 0 ? nextModes : ['ocr'];

  return {
    ...attachment.injectModes,
    image: safeModes,
  };
}
