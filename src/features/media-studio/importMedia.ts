/**
 * 导入音视频 → 资源库根目录的 VFS File 资源（与资源库「导入资料」/ 拖放同一条暂存链路）。
 *
 * - 桌面：系统对话框 / 拖放给出本地路径 → staged_upload_from_path（Rust 流式复制，WebView 不经手字节）。
 * - 手机：系统选择器经 `<input type=file>`（accept 由 buildFileAccept 组装，MIME 在前，规避 wry
 *   Android 纯扩展名 accept 的坑）拿到带真实文件名 / MIME 的 File，分块暂存并回报字节进度。
 *   不走对话框路径：Android 媒体提供方的 content:// 只给不透明 ID（如 `video:1234`），
 *   文件名与扩展名都会丢失，导入后既认不出类型也没有可读的名字。
 * - 后端创建时把暂存文件取走；失败时清理暂存文件。
 */
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import type { DstuNode } from '@/dstu/types';
import {
  ATTACHMENT_AUDIO_EXTENSIONS,
  ATTACHMENT_VIDEO_EXTENSIONS,
} from '@/features/chat/core/constants';
import { mimeTypeFromFileName } from '@/hooks/useTauriDragAndDrop';
import { buildFileAccept } from '@/utils/fileAccept';
import { extractFileName } from '@/utils/fileManager';
import { abortStagedUpload, stageBlobUpload, stagePathUpload } from '@/utils/stagedUpload';
import { getErrorMessage } from '@/utils/errorUtils';

export const MEDIA_IMPORT_EXTENSIONS: readonly string[] = [
  ...ATTACHMENT_AUDIO_EXTENSIONS,
  ...ATTACHMENT_VIDEO_EXTENSIONS,
];

export const MEDIA_IMPORT_MIME_TYPES = ['audio/*', 'video/*'] as const;

/** `<input accept>`：MIME 在前（wry Android 要求首项非扩展名），桌面附带扩展名精确过滤 */
export function mediaFileAccept(android?: boolean): string {
  return buildFileAccept(MEDIA_IMPORT_MIME_TYPES, MEDIA_IMPORT_EXTENSIONS, { android });
}

const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** 是否可作为音视频导入（扩展名或 MIME 任一命中） */
export function isImportableMedia(name: string, mimeType?: string | null): boolean {
  if (mimeType && /^(audio|video)\//i.test(mimeType)) return true;
  return MEDIA_IMPORT_EXTENSIONS.includes(extensionOf(name));
}

export function resolveMediaMimeType(name: string, mimeType?: string | null): string {
  if (mimeType && /^(audio|video)\//i.test(mimeType)) return mimeType;
  return mimeTypeFromFileName(name)
    ?? (ATTACHMENT_AUDIO_EXTENSIONS.includes(extensionOf(name)) ? 'audio/mpeg' : 'video/mp4');
}

/** 桌面系统对话框（多选），取消返回 [] */
export async function pickMediaPaths(filterName: string): Promise<string[]> {
  const selected = await dialogOpen({
    multiple: true,
    filters: [{ name: filterName, extensions: [...MEDIA_IMPORT_EXTENSIONS] }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** 导入源：本地路径（桌面对话框 / 拖放）或 File（手机选择器 / 浏览器拖放） */
export type MediaImportSource = { kind: 'path'; path: string } | { kind: 'file'; file: File };

export interface MediaImportProgress {
  /** 1-based 当前文件序号 */
  index: number;
  total: number;
  name: string;
  /** 0..1；路径复制（无字节回调）时为 null */
  fraction: number | null;
}

export interface MediaImportResult {
  imported: DstuNode[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
}

export function sourceName(source: MediaImportSource): string {
  return source.kind === 'path' ? extractFileName(source.path) : source.file.name;
}

/**
 * 逐个导入（媒体文件大，后端创建时会整份读入暂存文件，串行最稳）。
 * 非音视频文件跳过（记入 skipped）。
 */
export async function importMediaSources(
  sources: readonly MediaImportSource[],
  onProgress?: (progress: MediaImportProgress) => void,
): Promise<MediaImportResult> {
  const result: MediaImportResult = { imported: [], skipped: [], failed: [] };
  const accepted = sources.filter((source) => {
    const name = sourceName(source);
    const ok = isImportableMedia(name, source.kind === 'file' ? source.file.type : null);
    if (!ok) result.skipped.push(name);
    return ok;
  });

  for (let i = 0; i < accepted.length; i += 1) {
    const source = accepted[i];
    const name = sourceName(source);
    const report = (fraction: number | null) =>
      onProgress?.({ index: i + 1, total: accepted.length, name, fraction });
    report(source.kind === 'file' ? 0 : null);

    let uploadId: string | null = null;
    try {
      let size: number;
      if (source.kind === 'path') {
        const staged = await stagePathUpload(source.path);
        uploadId = staged.uploadId;
        size = staged.size;
      } else {
        uploadId = await stageBlobUpload(source.file, {
          name,
          onProgress: (loaded, total) => report(total > 0 ? loaded / total : null),
        });
        size = source.file.size;
      }
      const created = await attachmentDstuAdapter.createFromStagedUpload(
        {
          uploadId,
          name,
          mimeType: resolveMediaMimeType(name, source.kind === 'file' ? source.file.type : null),
          size,
        },
        'file',
      );
      if (!created.ok) {
        void abortStagedUpload(uploadId);
        result.failed.push({ name, reason: created.error.toUserMessage() });
        continue;
      }
      result.imported.push(created.value);
    } catch (error: unknown) {
      if (uploadId) void abortStagedUpload(uploadId);
      result.failed.push({ name, reason: getErrorMessage(error) });
    }
  }
  return result;
}
