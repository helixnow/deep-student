/**
 * 预览组件共享工具函数
 * 
 * 提供 Base64 解码、数值限制、缩放常量、偏好持久化等通用功能
 */

// ============================================================================
// Base64 解码工具
// ============================================================================

/**
 * 规范化 Base64 字符串
 * - 处理 data URL 前缀
 * - 移除空白字符
 * - 转换 URL-safe 字符
 * - 补齐 padding
 */
export const normalizeBase64 = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return '';
  
  // 提取 data URL 中的 base64 部分
  const rawBase64 = trimmed.startsWith('data:')
    ? trimmed.split(',')[1] ?? ''
    : trimmed;
  
  // 移除空白字符，转换 URL-safe 字符
  const normalized = rawBase64
    .replace(/[\r\n\s]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  
  if (!normalized) return '';
  
  // 补齐 padding
  const padding = normalized.length % 4;
  return padding ? normalized + '='.repeat(4 - padding) : normalized;
};

/**
 * 解码 Base64 为 ArrayBuffer
 * @throws {Error} 内容为空或解码失败时抛出错误
 */
export const decodeBase64ToArrayBuffer = (normalizedBase64: string): ArrayBuffer => {
  if (!normalizedBase64) {
    throw new Error('内容为空');
  }
  
  let binaryString = '';
  try {
    binaryString = atob(normalizedBase64);
  } catch {
    const preview = normalizedBase64.slice(0, 80);
    console.error('[decodeBase64ToArrayBuffer] atob failed, input preview:', preview, 'length:', normalizedBase64.length);
    throw new Error('内容解码失败');
  }
  
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

// ============================================================================
// 数值工具
// ============================================================================

/**
 * 将数值限制在指定范围内
 */
export const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// ============================================================================
// 缩放常量
// ============================================================================

/** 预览缩放最小值 */
export const ZOOM_MIN = 0.25;
/** 预览缩放最大值 */
export const ZOOM_MAX = 4.0;

/**
 * 缩放档位阶梯（常见 PDF 工具栏习惯）：
 * 加减按钮与 Ctrl+=/− 快捷键沿阶梯跳档，低倍区细、高倍区粗
 */
export const ZOOM_LADDER: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
];

/** 缩放预设档位（工具栏百分比 Popover 菜单展示） */
export const ZOOM_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * 沿缩放阶梯跳到下一档 / 上一档
 *
 * 当前值不在阶梯上时（如滚轮平滑缩放后的 1.37），
 * 取阶梯中最近的相邻档位，保证按钮步进始终有响应
 */
export const stepZoom = (current: number, direction: 1 | -1): number => {
  const EPSILON = 0.001;
  if (direction === 1) {
    for (const level of ZOOM_LADDER) {
      if (level > current + EPSILON) return level;
    }
    return ZOOM_MAX;
  }
  for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
    if (ZOOM_LADDER[i] < current - EPSILON) return ZOOM_LADDER[i];
  }
  return ZOOM_MIN;
};

/** 字号缩放最小值 */
export const FONT_MIN = 0.8;
/** 字号缩放最大值 */
export const FONT_MAX = 1.6;
/** 字号缩放步进 */
export const FONT_STEP = 0.1;

// ============================================================================
// 文件大小格式化
// ============================================================================

/**
 * 格式化文件大小（字节 -> 人类可读格式）
 * 共享工具，供 ImageContentView 等组件使用
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ============================================================================
// 媒体时间格式化
// ============================================================================

/**
 * 格式化时间（秒 -> mm:ss 或 hh:mm:ss）
 * 共享工具，供 AudioPreview / VideoPreview 使用
 */
export const formatMediaTime = (seconds: number): string => {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// ============================================================================
// 动画工具
// ============================================================================

/**
 * 等待下一帧（用于避免渲染阻塞）
 */
export const waitForNextFrame = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(resolve, 0);
  });

// ============================================================================
// 缩放偏好持久化
// ============================================================================

const STORAGE_KEY_PREFIX = 'preview-prefs-';

export interface PreviewPreferences {
  zoomScale: number;
  fontScale?: number;
}

/**
 * 保存预览偏好到 localStorage
 */
export const savePreviewPrefs = (
  type: 'docx' | 'xlsx' | 'pptx',
  prefs: PreviewPreferences
): void => {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${type}`, JSON.stringify(prefs));
  } catch {
    // localStorage 不可用时静默失败
  }
};

/** 偏好写入防抖间隔（毫秒）：滚轮/连点缩放期间合并写入 */
const PREFS_SAVE_DEBOUNCE_MS = 400;

/** 每种预览类型一个防抖定时器 + 待写入值 */
const pendingPrefsSaves = new Map<
  'docx' | 'xlsx' | 'pptx',
  { timer: ReturnType<typeof setTimeout>; prefs: PreviewPreferences }
>();

/**
 * 立即写出所有待持久化的偏好（页面卸载 / Provider 卸载时调用）
 */
export const flushPreviewPrefsSaves = (): void => {
  pendingPrefsSaves.forEach((entry, type) => {
    clearTimeout(entry.timer);
    savePreviewPrefs(type, entry.prefs);
  });
  pendingPrefsSaves.clear();
};

/**
 * 防抖保存预览偏好：连续缩放时只在停顿后写一次 localStorage
 */
export const schedulePreviewPrefsSave = (
  type: 'docx' | 'xlsx' | 'pptx',
  prefs: PreviewPreferences
): void => {
  const existing = pendingPrefsSaves.get(type);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    pendingPrefsSaves.delete(type);
    savePreviewPrefs(type, prefs);
  }, PREFS_SAVE_DEBOUNCE_MS);
  pendingPrefsSaves.set(type, { timer, prefs });
};

// 页面关闭前兜底写出（Tauri WebView 同样触发 beforeunload）
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPreviewPrefsSaves);
}

/**
 * 从 localStorage 读取预览偏好
 */
export const loadPreviewPrefs = (
  type: 'docx' | 'xlsx' | 'pptx'
): PreviewPreferences | null => {
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${type}`);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as PreviewPreferences;
    // 验证数据有效性（越界值 clamp 回范围内，避免历史数据因范围调整而被整体丢弃）
    if (typeof parsed.zoomScale === 'number' && Number.isFinite(parsed.zoomScale)) {
      parsed.zoomScale = clampNumber(parsed.zoomScale, ZOOM_MIN, ZOOM_MAX);
      // 🔒 审计修复: fontScale 也需要范围验证，防止 localStorage 中的极端值导致渲染崩溃
      if (typeof parsed.fontScale === 'number' && Number.isFinite(parsed.fontScale)) {
        parsed.fontScale = clampNumber(parsed.fontScale, FONT_MIN, FONT_MAX);
      } else {
        delete parsed.fontScale;
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};
