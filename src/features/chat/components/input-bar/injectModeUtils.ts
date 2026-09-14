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
 * 的兜底逻辑不应再被触发。
 *
 * ★ P1（2026-09-07）：默认值由当前会话模型能力驱动：
 * - PDF + 多模态模型 → ['image']（页图就绪即秒过门控，不 OCR）
 * - PDF + 非多模态模型 → ['text', 'ocr']（扫描件也能注入文本）
 * - 未提供 context 或拿不到模型能力时回落旧默认（PDF=['text']），行为不变。
 * - 图片不受模型能力影响：始终 ['image']（非多模态场景由发送链路降级）。
 */
export type PdfContentKind = 'text' | 'scanned';

export interface DefaultInjectModesContext {
  /** 当前会话默认对话模型（model2）是否支持图片输入 */
  multimodal?: boolean;
  /** PDF 内容分类；文本 PDF 默认 text，扫描 PDF 按模型选择 */
  contentKind?: PdfContentKind;
  /** 后端报告的真实就绪模式 */
  readyModes?: MediaInjectMode[];
}

export function buildDefaultInjectModes(
  mediaType: AttachmentMediaType | null,
  context?: DefaultInjectModesContext
): AttachmentInjectModes | undefined {
  if (mediaType === 'pdf') {
    if (context?.contentKind === 'text') {
      return { pdf: ['text'] };
    }
    if (context?.multimodal === true) {
      return { pdf: ['image'] };
    }
    return { pdf: ['text', 'ocr'] };
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

  const fromStatus = (effectiveStatus?.readyModes || [])
    .filter((m): m is MediaInjectMode => VALID_INJECT_MODES.has(m));

  // 图片：上传成功后原图已可用。后端流水线也在启动时立即把 image 标为就绪；
  // 前端门闩与之对齐，避免「进度 100% / status=ready 但 readyModes 为空」卡死发送。
  if (mediaType === 'image' && (attachment.status === 'ready' || attachment.status === 'processing')) {
    const modes = new Set<MediaInjectMode>(fromStatus);
    modes.add('image');
    return Array.from(modes);
  }

  if (fromStatus.length) {
    return fromStatus;
  }

  // PDF 等：完成状态也必须以真实 readyModes 为准；空列表不可伪装为 text/image。
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
