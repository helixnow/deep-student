/**
 * `dstu-core/src/media_types.rs`: audio/video classification, link-item MIME and
 * extension, and the import size caps.
 */
export type MediaKind = 'Audio' | 'Video';

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'm4b', 'flac', 'aac', 'opus', 'wma', 'aiff', 'aif', 'caf', 'weba'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts'];
export const BILIBILI_LINK_MIME = 'video/x-bilibili';
export const BILIBILI_LINK_EXTENSION = 'bilibili';
export const MAX_MEDIA_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function extensionOf(name: string): string | null {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return base.slice(dot + 1).replace(/[A-Z]/g, c => c.toLowerCase());
}

export function isLinkItem(mimeType: string, fileName: string): boolean {
  return mimeType.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').toLowerCase() === BILIBILI_LINK_MIME
    || extensionOf(fileName) === BILIBILI_LINK_EXTENSION;
}

export interface SegmentCounts {
  total: number;
  done: number;
  failed: number;
  pending: number;
}

/**
 * `commands.rs:114`：把运行态 / processing_status / 段计数归一到前端的
 * `none|queued|running|partial|completed|error|cancelled`。
 */
export function deriveStatus(
  running: boolean,
  processingStatus: string | null | undefined,
  counts: SegmentCounts,
): 'none' | 'queued' | 'running' | 'partial' | 'completed' | 'error' | 'cancelled' {
  if (running) {
    return processingStatus === 'queued' || processingStatus === 'pending'
      || processingStatus === null || processingStatus === undefined
      ? 'queued' : 'running';
  }
  if (counts.total === 0) {
    return processingStatus === 'error' ? 'error'
      : processingStatus === 'cancelled' ? 'cancelled' : 'none';
  }
  if (counts.done === counts.total) return 'completed';
  return processingStatus === 'error' ? 'error'
    : processingStatus === 'cancelled' ? 'cancelled' : 'partial';
}

export function mediaKind(mimeType: string, fileName: string): MediaKind | null {
  if (isLinkItem(mimeType, fileName)) return 'Video';
  const mime = mimeType.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').toLowerCase();
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('video/')) return 'Video';
  const ext = extensionOf(fileName);
  if (ext === null) return null;
  if (AUDIO_EXTENSIONS.includes(ext)) return 'Audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'Video';
  return null;
}
