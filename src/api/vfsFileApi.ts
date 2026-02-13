import { invoke } from '@tauri-apps/api/core';

export type FileType = 'document' | 'image' | 'audio' | 'video';

export interface VfsFile {
  id: string;
  resourceId?: string;
  blobHash?: string;
  sha256: string;
  fileName: string;
  originalPath?: string;
  size: number;
  pageCount?: number;
  fileType: FileType;
  mimeType?: string;
  tags: string[];
  isFavorite: boolean;
  lastOpenedAt?: string;
  lastPage?: number;
  bookmarks: unknown[];
  coverKey?: string;
  extractedText?: string;
  previewJson?: string;
  ocrPagesJson?: string;
  description?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface UploadFileParams {
  name: string;
  mimeType: string;
  base64Content: string;
  fileType?: FileType;
  folderId?: string;
}

/**
 * ★ 2026-01 新增：OCR 处理状态
 */
export interface OcrStatus {
  /** OCR 是否被执行 */
  performed: boolean;
  /** 跳过原因（如果跳过） */
  skipReason?: string;
  /** 成功的页数（PDF） */
  successCount: number;
  /** 失败的页数（PDF） */
  failedCount: number;
  /** Blob 缺失的页数（PDF） */
  blobMissingCount: number;
  /** 总页数（PDF） */
  totalPages: number;
  /** 是否全部成功 */
  allSuccess: boolean;
  /** 用户可见的状态消息 */
  message: string;
}

/**
 * ★ 2026-01 新增：索引处理状态
 */
export interface IndexStatus {
  /** 是否已加入索引队列 */
  queued: boolean;
  /** 创建的索引单元数量 */
  unitsCreated: number;
  /** 用户可见的状态消息 */
  message: string;
}

export interface UploadFileResult {
  file: VfsFile;
  sourceId: string;
  resourceHash: string;
  isNew: boolean;
  /** ★ 2026-01 新增：OCR 处理状态 */
  ocrStatus?: OcrStatus;
  /** ★ 2026-01 新增：索引处理状态 */
  indexStatus?: IndexStatus;
}

export interface FileContentResult {
  content: string | null;
  found: boolean;
}

export const vfsFileApi = {
  async upload(params: UploadFileParams): Promise<UploadFileResult> {
    return invoke('vfs_upload_file', { params });
  },

  async get(fileId: string): Promise<VfsFile | null> {
    return invoke('vfs_get_file', { fileId });
  },

  async list(options?: {
    fileType?: FileType;
    limit?: number;
    offset?: number;
  }): Promise<VfsFile[]> {
    return invoke('vfs_list_files', {
      fileType: options?.fileType,
      limit: options?.limit,
      offset: options?.offset,
    });
  },

  async delete(fileId: string): Promise<void> {
    return invoke('vfs_delete_file', { fileId });
  },

  async getContent(fileId: string): Promise<FileContentResult> {
    return invoke('vfs_get_file_content', { fileId });
  },

  /**
   * 更新文件书签
   * @param fileId 文件 ID（textbook ID）
   * @param bookmarks 书签数组
   */
  async updateBookmarks(fileId: string, bookmarks: Bookmark[]): Promise<boolean> {
    return invoke('textbooks_update_bookmarks', { id: fileId, bookmarks });
  },
};

/** PDF 书签类型 */
export interface Bookmark {
  id: string;
  page: number;
  title: string;
  createdAt: number;
}

export function inferFileType(mimeType: string): FileType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}
