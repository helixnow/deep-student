/**
 * saveResourceToDevice — 资源「保存到本地」的共享双通道实现
 *
 * 通道一（优先）：vfs_get_file_blob_path 解析 blob 落盘路径 →
 *   fileManager.saveFromSource（后端直接复制文件，零内存拷贝，不受大小限制）；
 * 通道二（回退）：vfs_get_attachment_content 读 base64 →
 *   fileManager.saveBinaryFile（兼容无 blob 文件的 legacy 内联资源）。
 *
 * 壳层 FilePreviewAppWindow、FileContentView、ImageContentView 统一复用，
 * 禁止在视图内再手写单通道保存逻辑。
 */

import { invoke } from '@tauri-apps/api/core';
import { base64ToUint8Array } from '@/utils/base64FileUtils';
import { fileManager } from '@/utils/fileManager';

export interface SaveResourceOptions {
  nodeId: string;
  fileName: string;
  /** 调用方已解析好的 blob 路径（省一次 invoke）；未传/为 null 时内部解析 */
  sourcePath?: string | null;
  filters?: { name: string; extensions: string[] }[];
  /** 保存对话框标题 */
  title?: string;
  /** blob 与附件内容都不可得（或 base64 解码失败）时抛出的错误文案 */
  notFoundMessage: string;
  /** 保存成功后尝试用系统默认应用打开（失败不阻塞，文件已保存） */
  openAfterSave?: boolean;
}

export interface SaveResourceResult {
  canceled: boolean;
  path?: string;
}

/** 从文件名推断保存对话框的扩展名过滤器 */
export function saveFiltersForFileName(
  fileName: string,
): { name: string; extensions: string[] }[] | undefined {
  const ext = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
  return ext ? [{ name: fileName, extensions: [ext] }] : undefined;
}

export async function saveResourceToDevice(
  options: SaveResourceOptions,
): Promise<SaveResourceResult> {
  const { nodeId, fileName, filters, title, notFoundMessage, openAfterSave } = options;

  let sourcePath = options.sourcePath ?? null;
  if (!sourcePath) {
    try {
      sourcePath = await invoke<string | null>('vfs_get_file_blob_path', { id: nodeId });
    } catch {
      // blob 路径解析失败不视为错误，继续走 base64 回退通道
      sourcePath = null;
    }
  }

  let result: SaveResourceResult;
  if (sourcePath) {
    result = await fileManager.saveFromSource({
      sourcePath,
      defaultFileName: fileName,
      filters,
      title,
    });
  } else {
    // Legacy 内联资源：无 blob 文件，读附件 base64 再落盘
    const attachment = await invoke<{ content: string | null; found: boolean }>(
      'vfs_get_attachment_content',
      { attachmentId: nodeId },
    );
    if (!attachment?.found || !attachment?.content) {
      throw new Error(notFoundMessage);
    }
    const bytes = base64ToUint8Array(attachment.content);
    if (!bytes) {
      throw new Error(notFoundMessage);
    }
    result = await fileManager.saveBinaryFile({
      data: bytes,
      defaultFileName: fileName,
      filters,
      title,
    });
  }

  if (openAfterSave && !result.canceled && result.path) {
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(result.path);
    } catch {
      // 打开失败不阻塞，文件已保存
    }
  }
  return result;
}
