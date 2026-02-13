/**
 * 媒体处理状态 Store（PDF + 图片）
 * 
 * 用于跟踪媒体文件（PDF/图片）预处理流水线的进度状态。
 * 使用 Zustand 管理全局状态，支持多个文件同时处理。
 * 
 * @version 2.0 扩展支持图片处理
 */

import { create } from 'zustand';
import i18n from '@/i18n';

/** 媒体类型 */
export type MediaType = 'pdf' | 'image';

/** 处理阶段 */
export type ProcessingStage = 
  | 'pending'
  | 'text_extraction'     // PDF 专用
  | 'page_rendering'      // PDF 专用
  | 'page_compression'    // PDF 专用
  | 'image_compression'   // 图片专用
  | 'ocr_processing'      // 共享
  | 'vector_indexing'     // 共享
  | 'completed'
  | 'error';

/**
 * 媒体处理状态（兼容 PDF 和图片）
 */
export interface PdfProcessingStatus {
  /** 当前处理阶段 */
  stage: ProcessingStage;
  /** 当前处理的页码（PDF 渲染/OCR 时使用，图片始终为 1） */
  currentPage?: number;
  /** 总页数（PDF 专用，图片始终为 1） */
  totalPages?: number;
  /** 总进度百分比 (0-100) */
  percent: number;
  /** 已就绪的注入模式 */
  readyModes: Array<'text' | 'ocr' | 'image'>;
  /** 错误信息（error 状态时填充） */
  error?: string;
  /** 媒体类型（v2.0 新增） */
  mediaType?: MediaType;
}

// 类型别名，用于兼容
export type MediaProcessingStatus = PdfProcessingStatus;

interface PdfProcessingStoreState {
  /** 文件 ID -> 处理状态 的映射 */
  statusMap: Map<string, PdfProcessingStatus>;
}

interface PdfProcessingStoreActions {
  /**
   * 更新文件的处理状态
   * @param fileId 文件 ID（resourceId）
   * @param status 部分状态更新
   */
  update: (fileId: string, status: Partial<PdfProcessingStatus>) => void;
  
  /**
   * 设置文件处理完成
   * @param fileId 文件 ID
   * @param readyModes 就绪的注入模式
   */
  setCompleted: (fileId: string, readyModes: Array<'text' | 'ocr' | 'image'>) => void;
  
  /**
   * 设置文件处理错误
   * @param fileId 文件 ID
   * @param error 错误信息
   * @param stage 出错的阶段
   */
  setError: (fileId: string, error: string, stage?: string) => void;
  
  /**
   * 移除文件的处理状态
   * @param fileId 文件 ID
   */
  remove: (fileId: string) => void;
  
  /**
   * 清空所有状态
   */
  clear: () => void;
  
  /**
   * 获取文件的处理状态
   * @param fileId 文件 ID
   */
  get: (fileId: string) => PdfProcessingStatus | undefined;
}

type PdfProcessingStore = PdfProcessingStoreState & PdfProcessingStoreActions;

/** Maximum number of entries allowed in the statusMap before eviction kicks in */
const MAX_ENTRIES = 100;

/** Delay (ms) before auto-removing completed/error entries */
const AUTO_CLEANUP_DELAY = 60_000;

/**
 * Evict oldest completed/error entries when the map exceeds MAX_ENTRIES.
 * Entries inserted first in the Map iteration order are considered "oldest".
 */
function enforceMaxEntries(map: Map<string, PdfProcessingStatus>): void {
  if (map.size <= MAX_ENTRIES) return;

  const toRemove: string[] = [];
  // First pass: collect completed/error entries (oldest first via Map insertion order)
  for (const [id, entry] of map) {
    if (entry.stage === 'completed' || entry.stage === 'error') {
      toRemove.push(id);
    }
    if (map.size - toRemove.length <= MAX_ENTRIES) break;
  }
  for (const id of toRemove) {
    map.delete(id);
  }
}

/**
 * PDF 处理状态 Store
 */
export const usePdfProcessingStore = create<PdfProcessingStore>((set, get) => ({
  statusMap: new Map(),
  
  update: (fileId, status) => {
    set(state => {
      const newMap = new Map(state.statusMap);
      const existing = newMap.get(fileId);
      const updated: PdfProcessingStatus = {
        stage: status.stage ?? existing?.stage ?? 'pending',
        percent: status.percent ?? existing?.percent ?? 0,
        readyModes: status.readyModes ?? existing?.readyModes ?? [],
        currentPage: status.currentPage ?? existing?.currentPage,
        totalPages: status.totalPages ?? existing?.totalPages,
        error: status.error ?? existing?.error,
        mediaType: status.mediaType ?? existing?.mediaType,
      };
      newMap.set(fileId, updated);
      enforceMaxEntries(newMap);
      return { statusMap: newMap };
    });
  },
  
  setCompleted: (fileId, readyModes) => {
    set(state => {
      const newMap = new Map(state.statusMap);
      const existing = newMap.get(fileId);
      newMap.set(fileId, {
        stage: 'completed',
        percent: 100,
        readyModes,
        // 保留现有状态
        currentPage: existing?.currentPage,
        totalPages: existing?.totalPages,
        error: undefined, // 清除错误
        mediaType: existing?.mediaType,
      });
      enforceMaxEntries(newMap);
      return { statusMap: newMap };
    });
    // Auto-cleanup completed entries after 60 seconds
    setTimeout(() => {
      const { statusMap } = get();
      const entry = statusMap.get(fileId);
      if (entry?.stage === 'completed') {
        get().remove(fileId);
      }
    }, AUTO_CLEANUP_DELAY);
  },
  
  setError: (fileId, error, stage) => {
    set(state => {
      const newMap = new Map(state.statusMap);
      const existing = newMap.get(fileId);
      newMap.set(fileId, {
        stage: 'error',
        percent: existing?.percent ?? 0,
        readyModes: existing?.readyModes ?? [],
        error,
        mediaType: existing?.mediaType,
      });
      enforceMaxEntries(newMap);
      return { statusMap: newMap };
    });
    // Auto-cleanup error entries after 60 seconds
    setTimeout(() => {
      const { statusMap } = get();
      const entry = statusMap.get(fileId);
      if (entry?.stage === 'error') {
        get().remove(fileId);
      }
    }, AUTO_CLEANUP_DELAY);
  },
  
  remove: (fileId) => {
    set(state => {
      const newMap = new Map(state.statusMap);
      newMap.delete(fileId);
      return { statusMap: newMap };
    });
  },
  
  clear: () => {
    set({ statusMap: new Map() });
  },
  
  get: (fileId) => {
    return get().statusMap.get(fileId);
  },
}));

/**
 * 获取处理中的提示文本
 */
export function getProcessingHint(status: PdfProcessingStatus | undefined): string {
  const t = i18n.t.bind(i18n);
  if (!status) return t('learningHub:processing.inProgress');
  
  const isImage = status.mediaType === 'image';
  
  switch (status.stage) {
    case 'text_extraction':
      return t('learningHub:processing.extractingText');
    case 'page_rendering':
      return status.currentPage && status.totalPages
        ? t('learningHub:processing.renderingPageProgress', { current: status.currentPage, total: status.totalPages })
        : t('learningHub:processing.renderingPage');
    case 'page_compression':
      return status.currentPage && status.totalPages
        ? t('learningHub:processing.compressingPageProgress', { current: status.currentPage, total: status.totalPages })
        : t('learningHub:processing.compressingPage');
    case 'image_compression':
      return t('learningHub:processing.compressingImage');
    case 'ocr_processing':
      if (isImage) {
        return t('learningHub:processing.ocrRecognizing');
      }
      return status.currentPage && status.totalPages
        ? t('learningHub:processing.ocrRecognizingProgress', { current: status.currentPage, total: status.totalPages })
        : t('learningHub:processing.ocrRecognizing');
    case 'vector_indexing':
      return t('learningHub:processing.buildingIndex');
    case 'completed':
      return t('learningHub:processing.completed');
    case 'error':
      return status.error || t('learningHub:processing.failed');
    default:
      return isImage ? t('learningHub:processing.imageProcessing') : t('learningHub:processing.pdfProcessing');
  }
}

