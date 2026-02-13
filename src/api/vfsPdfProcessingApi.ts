/**
 * VFS PDF 预处理 API
 * 
 * 提供与后端 PDF 预处理流水线交互的 API：
 * - 查询处理状态
 * - 取消处理
 * - 重试处理
 */

import { invoke } from '@tauri-apps/api/core';

// ========== 类型定义 ==========

/**
 * PDF 处理状态响应
 */
export interface PdfProcessingStatusResponse {
  /** 当前处理阶段 */
  stage: 'pending' | 'text_extraction' | 'page_rendering' | 'page_compression' | 'image_compression' | 'ocr_processing' | 'vector_indexing' | 'completed' | 'error';
  /** 当前处理的页码 */
  currentPage?: number;
  /** 总页数 */
  totalPages?: number;
  /** 进度百分比 (0-100) */
  percent: number;
  /** 已就绪的注入模式 */
  readyModes: string[];
  /** 媒体类型 */
  mediaType?: string;
  /** 错误信息（error 状态时存在） */
  error?: string;
}

/**
 * 批量状态查询响应
 */
export interface BatchPdfProcessingStatusResponse {
  /** 文件 ID 到状态的映射 */
  statuses: Record<string, PdfProcessingStatusResponse>;
}

type BackendProgressShape = {
  stage?: string;
  currentPage?: number;
  current_page?: number;
  totalPages?: number;
  total_pages?: number;
  percent?: number;
  readyModes?: string[];
  ready_modes?: string[];
  mediaType?: string;
  media_type?: string;
};

type BackendStatusShape = {
  stage?: string;
  percent?: number;
  currentPage?: number;
  current_page?: number;
  totalPages?: number;
  total_pages?: number;
  readyModes?: string[];
  ready_modes?: string[];
  mediaType?: string;
  media_type?: string;
  error?: string | null;
  progress?: BackendProgressShape;
};

const FALLBACK_STATUS: PdfProcessingStatusResponse = {
  stage: 'pending',
  percent: 0,
  readyModes: [],
};

function normalizeStatus(raw: BackendStatusShape | null | undefined): PdfProcessingStatusResponse {
  if (!raw) {
    return FALLBACK_STATUS;
  }

  const progress = raw.progress || {};
  const stage = (progress.stage || raw.stage || 'pending') as PdfProcessingStatusResponse['stage'];

  return {
    stage,
    currentPage: progress.currentPage ?? progress.current_page ?? raw.currentPage ?? raw.current_page,
    totalPages: progress.totalPages ?? progress.total_pages ?? raw.totalPages ?? raw.total_pages,
    percent: progress.percent ?? raw.percent ?? 0,
    readyModes: progress.readyModes ?? progress.ready_modes ?? raw.readyModes ?? raw.ready_modes ?? [],
    mediaType: progress.mediaType ?? progress.media_type ?? raw.mediaType ?? raw.media_type,
    error: raw.error ?? undefined,
  };
}

function normalizeBatch(
  raw: Record<string, BackendStatusShape> | { statuses?: Record<string, BackendStatusShape> } | null | undefined
): BatchPdfProcessingStatusResponse {
  const source = raw && 'statuses' in raw ? raw.statuses || {} : (raw || {});
  const normalizedStatuses: Record<string, PdfProcessingStatusResponse> = {};

  Object.entries(source).forEach(([fileId, status]) => {
    normalizedStatuses[fileId] = normalizeStatus(status);
  });

  return { statuses: normalizedStatuses };
}

// ========== API 函数 ==========

/**
 * 获取单个 PDF 文件的处理状态
 * 
 * @param fileId - 文件 ID
 * @returns 处理状态
 * 
 * @example
 * ```typescript
 * const status = await getPdfProcessingStatus('file-123');
 * console.log(`当前阶段: ${status.stage}, 进度: ${status.percent}%`);
 * ```
 */
export async function getPdfProcessingStatus(fileId: string): Promise<PdfProcessingStatusResponse> {
  const raw = await invoke<BackendStatusShape | null>('vfs_get_pdf_processing_status', { fileId });
  return normalizeStatus(raw);
}

/**
 * 批量获取多个 PDF 文件的处理状态
 * 
 * @param fileIds - 文件 ID 列表
 * @returns 批量状态响应
 * 
 * @example
 * ```typescript
 * const result = await getBatchPdfProcessingStatus(['file-1', 'file-2', 'file-3']);
 * for (const [fileId, status] of Object.entries(result.statuses)) {
 *   console.log(`${fileId}: ${status.stage}`);
 * }
 * ```
 */
export async function getBatchPdfProcessingStatus(fileIds: string[]): Promise<BatchPdfProcessingStatusResponse> {
  const raw = await invoke<Record<string, BackendStatusShape> | { statuses?: Record<string, BackendStatusShape> }>(
    'vfs_get_batch_pdf_processing_status',
    { fileIds }
  );
  return normalizeBatch(raw);
}

/**
 * 取消 PDF 处理
 * 
 * @param fileId - 文件 ID
 * @returns 是否成功取消
 * 
 * @example
 * ```typescript
 * const cancelled = await cancelPdfProcessing('file-123');
 * if (cancelled) {
 *   console.log('处理已取消');
 * }
 * ```
 */
export async function cancelPdfProcessing(fileId: string): Promise<boolean> {
  return invoke<boolean>('vfs_cancel_pdf_processing', { fileId });
}

/**
 * 重试失败的 PDF 处理
 * 
 * @param fileId - 文件 ID
 * @returns 无返回值
 * @throws 如果文件不存在或状态不允许重试
 * 
 * @example
 * ```typescript
 * try {
 *   await retryPdfProcessing('file-123');
 *   console.log('已重新启动处理');
 * } catch (error) {
 *   console.error('重试失败:', error);
 * }
 * ```
 */
export async function retryPdfProcessing(fileId: string): Promise<void> {
  return invoke<void>('vfs_retry_pdf_processing', { fileId });
}

/**
 * 手动触发 PDF 预处理流水线
 * 通常由上传逻辑自动触发，此 API 用于手动重新处理
 * 
 * @param fileId - 文件 ID
 * @returns 无返回值
 * 
 * @example
 * ```typescript
 * await startPdfProcessing('file-123');
 * console.log('已启动处理');
 * ```
 */
export async function startPdfProcessing(fileId: string): Promise<void> {
  return invoke<void>('vfs_start_pdf_processing', { fileId });
}

// ========== 便捷对象导出 ==========

/**
 * VFS PDF 处理 API 对象
 * 
 * @example
 * ```typescript
 * import { vfsPdfProcessingApi } from '@/api/vfsPdfProcessingApi';
 * 
 * const status = await vfsPdfProcessingApi.getStatus('file-123');
 * await vfsPdfProcessingApi.cancel('file-123');
 * await vfsPdfProcessingApi.retry('file-123');
 * ```
 */
export const vfsPdfProcessingApi = {
  /** 获取单个文件的处理状态 */
  getStatus: getPdfProcessingStatus,
  /** 批量获取文件的处理状态 */
  getBatchStatus: getBatchPdfProcessingStatus,
  /** 取消处理 */
  cancel: cancelPdfProcessing,
  /** 重试处理 */
  retry: retryPdfProcessing,
  /** 手动启动处理 */
  start: startPdfProcessing,
};
