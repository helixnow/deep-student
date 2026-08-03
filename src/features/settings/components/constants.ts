/**
 * Settings 页面常量定义
 * 从 Settings.tsx 提取
 */

export const isWindowsPlatform = () => {
  if (typeof navigator === 'undefined') return false;
  return /windows/i.test(navigator.userAgent);
};

/**
 * MCP stdio args 示例（仅 UI placeholder）。
 * 禁止静默写入配置：空 args 应保持为空，由用户显式填写。
 * 示例仍限制为用户主目录示意，避免暗示开放整个 Users 树。
 */
const STDIO_ARGS_PLACEHOLDER_PARTS: string[] = [
  '@modelcontextprotocol/server-filesystem',
  isWindowsPlatform() ? 'C:\\Users\\Default' : '/tmp',
];

(async () => {
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    if (home) STDIO_ARGS_PLACEHOLDER_PARTS[1] = home;
  } catch {
    // Non-Tauri environment or API unavailable – safe fallback remains.
  }
})();

/** @deprecated 勿再用于注入；保留空数组以兼容旧 import。 */
export const DEFAULT_STDIO_ARGS: string[] = [];
export const DEFAULT_STDIO_ARGS_STORAGE = '';
export const DEFAULT_STDIO_ARGS_PLACEHOLDER = STDIO_ARGS_PLACEHOLDER_PARTS.join(', ');

/** 解析 Settings 草稿/已存 framing：仅显式 CL 变体保留 content_length，缺省/未知 → jsonl。 */
export function resolveSettingsStdioFraming(
  framing?: string | null,
): 'jsonl' | 'content_length' {
  if (!framing) return 'jsonl';
  const normalized = String(framing).toLowerCase().replace(/-/g, '');
  if (normalized === 'content_length' || normalized === 'contentlength') {
    return 'content_length';
  }
  return 'jsonl';
}

// 与 Rust 端 chat_v2 pipeline 的默认空闲超时（LLM_STREAM_TIMEOUT_SECS=600）保持一致
export const DEFAULT_CHAT_STREAM_TIMEOUT_SECONDS = 600;
export const UI_ZOOM_STORAGE_KEY = 'ui.zoom';
export const DEFAULT_UI_ZOOM = 1;
// 下限与 AppearanceTab 的 80% 预设保持一致，避免选中 80% 被 clamp 回其他值
export const MIN_UI_ZOOM = 0.8;
export const MAX_UI_ZOOM = 1.5;
export const UI_ZOOM_PRESETS = [
  { value: 0.8, label: '80%' },
  { value: 0.85, label: '85%' },
  { value: 0.9, label: '90%' },
  { value: 1, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.25, label: '125%' },
  { value: 1.35, label: '135%' },
  { value: 1.5, label: '150%' },
];

export const clampZoom = (value: number) => {
  if (!Number.isFinite(value)) return DEFAULT_UI_ZOOM;
  return Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, value));
};

export const formatZoomLabel = (value: number) => `${Math.round(value * 100)}%`;

export type ZoomStatusState = {
  type: 'idle' | 'success' | 'error';
  message?: string;
};

export const formatTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};
