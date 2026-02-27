import type {
  AttachmentMeta,
  AttachmentInjectModes,
  ImageInjectMode,
  PdfInjectMode,
  PdfProcessingStatus,
} from '../../core/types/common';

export type AttachmentMediaType = 'pdf' | 'image';
export type MediaInjectMode = 'text' | 'ocr' | 'image';

export function getAttachmentMediaType(attachment: AttachmentMeta): AttachmentMediaType | null {
  const isPdf = attachment.mimeType === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    return 'pdf';
  }

  const isImage = attachment.mimeType?.startsWith('image/') || false;
  if (isImage) {
    return 'image';
  }

  return null;
}

export function getSelectedInjectModes(
  attachment: AttachmentMeta,
  mediaType: AttachmentMediaType
): MediaInjectMode[] {
  if (mediaType === 'pdf') {
    return (attachment.injectModes?.pdf || ['text']) as MediaInjectMode[];
  }
  return (attachment.injectModes?.image || ['image']) as MediaInjectMode[];
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
    const VALID_INJECT_MODES: Set<string> = new Set(['text', 'ocr', 'image']);
    const filtered = effectiveStatus.readyModes.filter(m => VALID_INJECT_MODES.has(m)) as MediaInjectMode[];
    if (filtered.length) {
      return filtered;
    }
  }

  if (effectiveStatus?.stage === 'completed') {
    return mediaType === 'pdf' ? ['text'] : ['image'];
  }

  if (attachment.status === 'ready' && !effectiveStatus) {
    return mediaType === 'pdf' ? ['text'] : ['image'];
  }

  // 图片 processing 但首次 poll 尚未返回：后端已立即标记 image ready，
  // 这里乐观返回 ['image'] 避免发送按钮短暂闪烁禁用
  if (mediaType === 'image' && attachment.status === 'processing' && !effectiveStatus) {
    return ['image'];
  }

  return undefined;
}

export function getMissingInjectModesForAttachment(
  attachment: AttachmentMeta,
  status?: PdfProcessingStatus
): MediaInjectMode[] {
  const mediaType = getAttachmentMediaType(attachment);
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
  const mediaType = getAttachmentMediaType(attachment);
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
  const mediaType = getAttachmentMediaType(attachment);

  if (!mediaType) {
    return null;
  }

  if (mediaType === 'pdf') {
    const currentModes = (attachment.injectModes?.pdf || ['text']) as PdfInjectMode[];
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

  const currentModes = (attachment.injectModes?.image || ['image']) as ImageInjectMode[];
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
