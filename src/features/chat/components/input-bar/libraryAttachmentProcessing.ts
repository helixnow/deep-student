/**
 * 资源库引用附件的处理状态补齐（issue #449）
 *
 * 资源库「引用到对话」（useReferenceToChat / useVfsContextInject）走的是
 * vfs_get_resource_refs + vfs_create_or_reuse，只拿得到 {resourceId, hash, isNew}，
 * 不像上传路径（vfs_upload_attachment）那样带回 processingStatus / readyModes。
 * 之前附件以 status='ready' + 无 processingStatus 入列：
 * - PDF 的 getEffectiveReadyModes 在 readyModes 为空时返回 undefined，所有选中模式
 *   都被判为缺失，发送被拦死；
 * - 兜底轮询只扫 status='processing' 的附件，ready 附件永远不会被补查。
 *
 * 这里按 VFS 文件 ID（附件 sourceId，形如 file_xxx）向后端查一次真实处理状态，
 * 把 status / processingStatus 写进附件快照；仍在处理中的置为 processing，
 * 交给 InputBarUI 的兜底轮询继续跟进。
 */

import i18n from '@/i18n';
import {
  getBatchPdfProcessingStatus,
  type PdfProcessingStatusResponse,
} from '@/api/vfsPdfProcessingApi';
import {
  usePdfProcessingStore,
  type PdfProcessingStatus as StorePdfProcessingStatus,
} from '@/features/pdf/stores/pdfProcessingStore';
import type { AttachmentMeta, PdfProcessingStatus } from '../../core/types/common';
import {
  getMediaTypeForAttachment,
  type AttachmentMediaType,
  type MediaInjectMode,
} from './injectModeUtils';

/** 后端处理状态表（files.processing_*）接受的 ID 前缀，与 vfs_get_batch_pdf_processing_status 校验一致 */
const PROCESSING_TRACKED_PREFIXES = ['file_', 'tb_', 'att_'] as const;

const VALID_MODES: ReadonlySet<string> = new Set<MediaInjectMode>(['text', 'ocr', 'image']);

export type LibraryAttachmentProcessingPatch = Pick<AttachmentMeta, 'status'> &
  Partial<Pick<AttachmentMeta, 'processingStatus' | 'error'>>;

/** sourceId 是否能在后端处理状态表里查到（其余 ID 前缀后端会直接跳过） */
export function isProcessingTrackedSourceId(sourceId: string | undefined | null): sourceId is string {
  return !!sourceId && PROCESSING_TRACKED_PREFIXES.some((prefix) => sourceId.startsWith(prefix));
}

function isCompletedStage(stage: string | undefined): boolean {
  return stage === 'completed' || stage === 'completed_with_issues';
}

/**
 * 把后端处理状态映射成附件快照字段。
 *
 * - 完成且有可用模式 → ready（带真实 readyModes）
 * - 处理中 → processing（交给轮询继续跟进）
 * - PDF 出错且无可用模式 → error（附件行出现「重试」入口）
 * - 后端查无此文件：PDF → processing（轮询补查，超时转 error 可重试）
 *
 * 图片的原图模式始终可用（与 getEffectiveReadyModes 一致）：查无此文件 / 出错 /
 * 从未启动处理时保持 ready，只有正在处理中才进入 processing 跟进 OCR 等模式。
 */
export function resolveLibraryAttachmentProcessing(
  mediaType: AttachmentMediaType,
  status: PdfProcessingStatusResponse | undefined,
): LibraryAttachmentProcessingPatch {
  if (!status) {
    if (mediaType === 'image') {
      return { status: 'ready' };
    }
    return {
      status: 'processing',
      processingStatus: { stage: 'pending', percent: 0, readyModes: [], mediaType },
    };
  }

  const readyModes = (status.readyModes || []).filter(
    (mode): mode is MediaInjectMode => VALID_MODES.has(mode),
  );
  if (mediaType === 'image' && !readyModes.includes('image')) {
    readyModes.push('image');
  }

  const processingStatus: PdfProcessingStatus = {
    stage: status.stage,
    percent: isCompletedStage(status.stage) ? 100 : (status.percent ?? 0),
    readyModes,
    mediaType,
    ...(status.currentPage != null ? { currentPage: status.currentPage } : {}),
    ...(status.totalPages != null ? { totalPages: status.totalPages } : {}),
    ...(status.error ? { error: status.error } : {}),
  };

  if (isCompletedStage(status.stage)) {
    return {
      status: readyModes.length > 0 ? 'ready' : 'processing',
      processingStatus,
    };
  }

  if (mediaType === 'image' && (status.stage === 'error' || status.stage === 'pending')) {
    // 图片原图恒可用：出错 / 从未启动处理都不应把图片拦下或送进会超时转 error 的轮询
    return { status: 'ready', processingStatus };
  }

  if (status.stage === 'error') {
    if (readyModes.length > 0) {
      // 部分模式已就绪：仍可用，未就绪的模式由附件行提示
      return { status: 'ready', processingStatus };
    }
    const mediaLabel = i18n.t(
      mediaType === 'pdf' ? 'chatV2:inputBar.mediaType.pdf' : 'chatV2:inputBar.mediaType.image',
    );
    return {
      status: 'error',
      error: status.error || i18n.t('chatV2:inputBar.mediaProcessingFailed', { type: mediaLabel }),
      processingStatus,
    };
  }

  return { status: 'processing', processingStatus };
}

function toStoreStatus(
  processingStatus: PdfProcessingStatus,
  mediaType: AttachmentMediaType,
): StorePdfProcessingStatus {
  return {
    stage: processingStatus.stage ?? 'pending',
    percent: processingStatus.percent ?? 0,
    readyModes: processingStatus.readyModes ?? [],
    currentPage: processingStatus.currentPage,
    totalPages: processingStatus.totalPages,
    error: processingStatus.error,
    mediaType,
  };
}

/**
 * 查询资源库附件的真实处理状态。
 *
 * 返回 null 表示无需补齐（非 PDF/图片，或 sourceId 不在后端处理状态表的 ID 体系内），
 * 调用方保持原有字段。查询失败按「后端查无此文件」处理（PDF 进入轮询）。
 *
 * 同时用后端快照覆盖全局处理状态 Store 中同 sourceId 的条目：渲染层优先读 Store，
 * 之前移除附件（取消处理）等动作留下的陈旧条目不能盖过后端真实状态。
 */
export async function fetchLibraryAttachmentProcessing(
  attachment: Pick<AttachmentMeta, 'mimeType' | 'name' | 'sourceId'>,
): Promise<LibraryAttachmentProcessingPatch | null> {
  const mediaType = getMediaTypeForAttachment(attachment);
  if (!mediaType || !isProcessingTrackedSourceId(attachment.sourceId)) {
    return null;
  }
  const sourceId = attachment.sourceId;

  let status: PdfProcessingStatusResponse | undefined;
  try {
    const result = await getBatchPdfProcessingStatus([sourceId]);
    status = result.statuses?.[sourceId];
  } catch {
    status = undefined;
  }

  const patch = resolveLibraryAttachmentProcessing(mediaType, status);
  if (status && patch.processingStatus) {
    usePdfProcessingStore.getState().setFullStatus(
      sourceId,
      toStoreStatus(patch.processingStatus, mediaType),
    );
  }
  return patch;
}

/**
 * 已在输入栏里、却没有任何处理状态的资源库媒体附件（例如本修复之前加入的草稿附件）：
 * status=ready 但 PDF 没有 readyModes，兜底轮询（只扫 processing）永远不会补查，
 * 需要把它转入 processing 让轮询拿到真实状态。
 */
export function needsProcessingStatusHydration(attachment: AttachmentMeta): boolean {
  if (attachment.status !== 'ready') return false;
  if (!isProcessingTrackedSourceId(attachment.sourceId)) return false;
  // 图片原图恒可用，不需要补查也不会被拦
  if (getMediaTypeForAttachment(attachment) !== 'pdf') return false;
  return !(attachment.processingStatus?.readyModes?.length);
}
