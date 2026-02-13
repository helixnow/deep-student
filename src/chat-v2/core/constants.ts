/**
 * Chat V2 核心常量定义
 * 
 * 集中管理所有魔法数字和配置常量，避免散落在各处。
 * 修改配置时只需在此文件中调整，无需搜索整个代码库。
 * 
 * ★ SSOT 文档：docs/design/file-format-registry.md
 * 附件格式定义（ATTACHMENT_*_TYPES/EXTENSIONS）请参考上述文档，
 * 修改格式支持时需同步更新文档和其他实现位置。
 */

// ==================== 流式处理配置 ====================

/** Chunk 缓冲窗口时间（毫秒），约 60fps */
export const CHUNK_BUFFER_WINDOW_MS = 16;

/** Chunk 最大缓冲大小（字符数），超过则立即刷新 */
export const CHUNK_MAX_BUFFER_SIZE = 4096;

/** 自动保存节流间隔（毫秒） */
export const AUTO_SAVE_THROTTLE_MS = 500;

/** 流式块防闪退保存防抖时间（毫秒） */
export const STREAMING_BLOCK_SAVE_THROTTLE_MS = 5000;

/** 流式块过期时间（毫秒），超过此时间未活动则清理 */
export const STREAMING_BLOCK_EXPIRY_MS = 5 * 60 * 1000;

/** 流式块清理检查间隔（毫秒） */
export const STREAMING_BLOCK_CLEANUP_INTERVAL_MS = 60 * 1000;

// ==================== 事件桥接配置 ====================

/** 事件乱序缓冲区最大大小 */
export const EVENT_BRIDGE_MAX_BUFFER_SIZE = 100;

/** 已处理事件 ID 最大保留数量 */
export const EVENT_BRIDGE_MAX_PROCESSED_IDS = 200;

// ==================== 会话管理配置 ====================

/** SessionManager 最大缓存会话数 */
export const SESSION_MANAGER_MAX_SESSIONS = 10;

/** 会话列表分页大小 */
export const SESSION_LIST_PAGE_SIZE = 50;

/** 会话状态轮询间隔（毫秒） */
export const SESSION_POLL_INTERVAL_MS = 1000;

// ==================== 日志配置 ====================

/** 日志最大保留条数 */
export const LOG_MAX_ENTRIES = 500;

/** 性能追踪最大保留条数 */
export const PERF_TRACE_MAX_ENTRIES = 50;

// ==================== 上下文配置 ====================

/** 最大上下文资源数量 */
export const CONTEXT_MAX_RESOURCES = 50;

/** 上下文解析超时时间（毫秒） */
export const CONTEXT_RESOLVE_TIMEOUT_MS = 30000;

/** 资源加载超时时间（毫秒） */
export const RESOURCE_LOAD_TIMEOUT_MS = 10000;

/** 最大上下文 Token 数 */
export const CONTEXT_MAX_TOKENS = 100000;

/** 最大重试总时间（毫秒） */
export const CONTEXT_MAX_RETRY_TIME_MS = 5000;

/** 最大退避延迟（毫秒） */
export const CONTEXT_MAX_BACKOFF_DELAY_MS = 5000;

// ==================== UI 配置 ====================

/** 虚拟列表初始化延迟（毫秒） */
export const VIRTUALIZER_INIT_DELAY_MS = 50;

/** 变体预览最大长度 */
export const VARIANT_PREVIEW_MAX_LENGTH = 200;

/** 工具输入预览最大长度 */
export const TOOL_INPUT_MAX_LENGTH = 200;

/** 输入框最大高度（像素） */
export const INPUT_BAR_MAX_HEIGHT_PX = 160;

/** 移动端底部 Dock 间距（像素） */
export const MOBILE_DOCK_GAP_PX = 64;

// ==================== 模型配置 ====================

/** 最大 Token 上限 */
export const MAX_TOKENS_LIMIT = 128000;

/** 默认最大 Token */
export const MAX_TOKENS_DEFAULT = 32768;

/** RAG TopK 最大值 */
export const RAG_TOPK_MAX = 50;

/** 图谱 TopK 最大值 */
export const GRAPH_TOPK_MAX = 50;

// ==================== 文件配置 ====================

/** 文件大小限制（50MB） */
export const FILE_SIZE_LIMIT = 50 * 1024 * 1024;

/** 文本文件最大长度（100KB） */
export const TEXT_FILE_MAX_LENGTH = 100 * 1024;

/** VFS 最大注入项数 */
export const VFS_MAX_INJECTION_ITEMS = 50;

/** VFS 最大路径长度 */
export const VFS_MAX_PATH_LENGTH = 1000;

// ==================== 缓存配置 ====================

/** Blob 缓存最大数量 */
export const BLOB_CACHE_MAX_SIZE = 50;

/** Store Inspector 最大显示项数 */
export const STORE_INSPECTOR_MAX_ITEMS = 50;

/** 单次清理最大数量 */
export const MAX_CLEANUP_PER_CYCLE = 100;

// ==================== 通知配置 ====================

/** 操作锁通知节流时间（毫秒） */
export const OPERATION_LOCK_NOTIFICATION_THROTTLE_MS = 3000;

/** 保存失败通知节流时间（毫秒） */
export const SAVE_FAILURE_NOTIFICATION_THROTTLE_MS = 5000;

// ==================== 扫描配置 ====================

/** 扫描超时时间（毫秒） */
export const SCAN_TIMEOUT_MS = 5000;

/** 最大扫描对象数 */
export const MAX_OBJECTS_TO_SCAN = 10000;

/** 最大扫描长度 */
export const MAX_SCAN_LENGTH = 1000;

// ==================== 附件上传配置 ====================

/** 
 * 单个附件最大大小 (50MB) 
 * ★ 与后端 VFS get_max_size_bytes() 保持一致
 */
export const ATTACHMENT_MAX_SIZE = 50 * 1024 * 1024;

/** 单次会话最大附件数量 */
export const ATTACHMENT_MAX_COUNT = 20;

/** 
 * 允许的图片类型 
 * ★ 2026-01-31 统一：添加 heic/heif 支持，与 UnifiedDragDropZone 保持一致
 * HEIC/HEIF 是 iPhone 照片的默认格式，在 OCR/试卷识别等场景常见
 * 浏览器预览可能需要后端转换为 JPEG/PNG
 */
export const ATTACHMENT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml', 'image/heic', 'image/heif'];

/** 
 * 允许的图片扩展名 
 * ★ 2026-01-31 统一：添加 heic/heif 支持
 */
export const ATTACHMENT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'];

/** 允许的文档类型 - 与 useAttachmentSettings.ts 保持同步 */
export const ATTACHMENT_DOCUMENT_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
  'text/html',
  'application/xml',
  'text/xml',
  // Office 文档
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12', // .xlsb
  'application/vnd.oasis.opendocument.spreadsheet', // .ods
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  // 其他文档
  'application/epub+zip', // .epub
  'application/rtf', // .rtf
  'text/rtf', // .rtf (alternate)
];

/** 允许的文档扩展名 - 与 useAttachmentSettings.ts 保持同步 */
export const ATTACHMENT_DOCUMENT_EXTENSIONS = [
  'pdf', 'txt', 'md', 'json', 'csv', 'html', 'htm', 'xml',
  'docx', 'xlsx', 'xls', 'xlsb', 'ods', 'pptx',
  'epub', 'rtf',
];

/** 允许的音频类型 */
export const ATTACHMENT_AUDIO_TYPES = [
  'audio/mpeg',      // mp3
  'audio/wav',       // wav
  'audio/x-wav',     // wav (alternative)
  'audio/ogg',       // ogg
  'audio/mp4',       // m4a
  'audio/x-m4a',     // m4a (alternative)
  'audio/flac',      // flac
  'audio/aac',       // aac
  'audio/x-ms-wma',  // wma
  'audio/opus',      // opus
];

/** 允许的音频扩展名 */
export const ATTACHMENT_AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'];

/** 允许的视频类型 */
export const ATTACHMENT_VIDEO_TYPES = [
  'video/mp4',        // mp4
  'video/webm',       // webm
  'video/quicktime',  // mov
  'video/x-msvideo',  // avi
  'video/x-matroska', // mkv
  'video/x-m4v',      // m4v
  'video/x-ms-wmv',   // wmv
  'video/x-flv',      // flv
];

/** 允许的视频扩展名 */
export const ATTACHMENT_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'];

/** 所有允许的附件类型 */
export const ATTACHMENT_ALLOWED_TYPES = [
  ...ATTACHMENT_IMAGE_TYPES,
  ...ATTACHMENT_DOCUMENT_TYPES,
  ...ATTACHMENT_AUDIO_TYPES,
  ...ATTACHMENT_VIDEO_TYPES,
];

/** 所有允许的附件扩展名 */
export const ATTACHMENT_ALLOWED_EXTENSIONS = [
  ...ATTACHMENT_IMAGE_EXTENSIONS,
  ...ATTACHMENT_DOCUMENT_EXTENSIONS,
  ...ATTACHMENT_AUDIO_EXTENSIONS,
  ...ATTACHMENT_VIDEO_EXTENSIONS,
];

// ==================== 格式化工具 ====================

/** 格式化文件大小为人类可读字符串 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 获取最大文件大小的人类可读字符串 */
export function getMaxSizeDisplay(): string {
  return formatFileSize(ATTACHMENT_MAX_SIZE);
}
