/**
 * Port of dstu-core `media_types.rs` (`media_kind` / `is_link_item`), consumed by
 * dstu-vfs `attachment_repo.rs:1444`. Pure: no fs/native imports, safe to publish from api.ts.
 */
export type VfsMediaKind = 'Audio' | 'Video';

export const AUDIO_EXTENSIONS: readonly string[] = [
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'm4b', 'flac', 'aac', 'opus', 'wma', 'aiff', 'aif', 'caf',
  'weba',
];
export const VIDEO_EXTENSIONS: readonly string[] = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts',
];
export const BILIBILI_LINK_MIME = 'video/x-bilibili';
export const BILIBILI_LINK_EXTENSION = 'bilibili';

/** Rust `str::trim` (Unicode White_Space). */
const rustTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
/** Rust `to_ascii_lowercase` / `eq_ignore_ascii_case`: only A-Z change. */
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, char => char.toLowerCase());

/** Unix `Path::new(name).extension()` + `to_ascii_lowercase`. */
function extensionOf(name: string): string | null {
  const parts = name.split('/').filter(part => part !== '' && part !== '.');
  const fileName = parts.at(-1);
  if (fileName === undefined || fileName === '..') return null;
  const dot = fileName.lastIndexOf('.');
  // `.mp3` has no extension; `a.` has an empty one.
  if (dot <= 0) return null;
  return asciiLower(fileName.slice(dot + 1));
}

export function isLinkItem(mimeType: string, fileName: string): boolean {
  return asciiLower(rustTrim(mimeType)) === BILIBILI_LINK_MIME
    || extensionOf(fileName) === BILIBILI_LINK_EXTENSION;
}

/** MIME first, then file extension (e.g. `application/octet-stream`). */
export function mediaKind(mimeType: string, fileName: string): VfsMediaKind | null {
  if (isLinkItem(mimeType, fileName)) return 'Video';
  const mime = asciiLower(rustTrim(mimeType));
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('video/')) return 'Video';
  const ext = extensionOf(fileName);
  if (ext === null) return null;
  if (AUDIO_EXTENSIONS.includes(ext)) return 'Audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'Video';
  return null;
}
