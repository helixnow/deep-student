/**
 * 音视频预览 MIME 类型解析
 * 避免一律 fallback 到 audio/mpeg / video/mp4 导致 WebView 解码失败。
 */

const AUDIO_EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
  weba: 'audio/webm',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  aifc: 'audio/aiff',
  caf: 'audio/x-caf',
  amr: 'audio/amr',
  mka: 'audio/x-matroska',
  mid: 'audio/midi',
  midi: 'audio/midi',
  ape: 'audio/x-ape',
  au: 'audio/basic',
  snd: 'audio/basic',
  wv: 'audio/x-wavpack',
};

const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  asf: 'video/x-ms-asf',
  vob: 'video/mpeg',
  rm: 'video/vnd.rn-realvideo',
  rmvb: 'video/vnd.rn-realvideo',
};

/**
 * WebView 通常无法原生解码的容器/编码（预览可能失败，需提示保存到本地）。
 *
 * 收录标准：在 WKWebView（macOS）或 WebView2（Windows/Chromium）任一主流
 * WebView 上大概率失败的格式。flac/aiff/caf 在现代 WebView 已广泛支持，
 * 故不收录，避免对可正常播放的文件误报。
 */
const LIKELY_UNSUPPORTED_AUDIO = new Set([
  'wma',
  'amr',
  'ape',
  'mka',
  'mid',
  'midi',
  'au',
  'snd',
  'wv',
  // WKWebView 不支持裸 .opus 容器（仅支持 caf 封装）
  'opus',
]);
const LIKELY_UNSUPPORTED_VIDEO = new Set([
  'mkv',
  'avi',
  'wmv',
  'flv',
  'rm',
  'rmvb',
  'asf',
  'vob',
  'ts',
  'm2ts',
  'mts',
  '3gp',
  '3g2',
]);

/**
 * 音/视频扩展名集合 —— 直接由 MIME 映射表键派生的单一真源。
 * `inferFilePreviewTypeFromName`（learning-hub/types.ts）等推断逻辑一律
 * 引用这里，禁止另行内联扩展名数组：两处漂移会导致"可播放但被判为
 * 不可预览"或反之。注意 'ts' 等与文本扩展名撞车的键由调用方先行判定文本。
 */
export const AUDIO_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(AUDIO_EXT_MIME),
);
export const VIDEO_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(VIDEO_EXT_MIME),
);

function getExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const idx = trimmed.lastIndexOf('.');
  return idx >= 0 ? trimmed.slice(idx + 1).toLowerCase() : '';
}

/** 规范化 MIME：小写并去除首尾空白（保留 codecs 等参数，<source type> 可用） */
function normalizeMime(mimeType: string): string {
  return (mimeType || '').trim().toLowerCase();
}

export function resolveAudioMimeType(mimeType: string, fileName: string): string {
  const normalized = normalizeMime(mimeType);
  // audio/mpeg 是历史上的默认 fallback，可能是错误标注（如 .wav 被存成 audio/mpeg），
  // 因此仅当非 fallback 值时才直接信任
  if (normalized.startsWith('audio/') && normalized !== 'audio/mpeg') {
    return normalized;
  }
  const ext = getExtension(fileName);
  return AUDIO_EXT_MIME[ext] ?? (normalized.startsWith('audio/') ? normalized : 'audio/mpeg');
}

export function resolveVideoMimeType(mimeType: string, fileName: string): string {
  const normalized = normalizeMime(mimeType);
  // video/mp4 同为历史默认 fallback，处理逻辑同上
  if (normalized.startsWith('video/') && normalized !== 'video/mp4') {
    return normalized;
  }
  const ext = getExtension(fileName);
  return VIDEO_EXT_MIME[ext] ?? (normalized.startsWith('video/') ? normalized : 'video/mp4');
}

export function isLikelyUnsupportedMedia(fileName: string, mode: 'audio' | 'video'): boolean {
  const ext = getExtension(fileName);
  return mode === 'audio'
    ? LIKELY_UNSUPPORTED_AUDIO.has(ext)
    : LIKELY_UNSUPPORTED_VIDEO.has(ext);
}
