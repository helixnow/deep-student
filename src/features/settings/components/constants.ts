/**
 * Settings 页面常量定义
 * 从 Settings.tsx 提取
 */

export const isWindowsPlatform = () => {
  if (typeof navigator === 'undefined') return false;
  return /windows/i.test(navigator.userAgent);
};

// SECURITY: Restrict default MCP filesystem access to the current user's home
// directory instead of the entire /Users (macOS) or C:\Users (Windows) tree,
// which would expose ALL user home directories on the system.
export const DEFAULT_STDIO_ARGS: string[] = [
  '@modelcontextprotocol/server-filesystem',
  isWindowsPlatform() ? 'C:\\Users\\Default' : '/tmp',
];

// Eagerly resolve the real home directory via Tauri path API and patch the
// mutable fallback above. By the time Settings UI is interacted with the
// promise will have settled.
(async () => {
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    if (home) DEFAULT_STDIO_ARGS[1] = home;
  } catch {
    // Non-Tauri environment or API unavailable – safe fallback remains.
  }
})();

export const DEFAULT_STDIO_ARGS_STORAGE = DEFAULT_STDIO_ARGS.join(',');
export const DEFAULT_STDIO_ARGS_PLACEHOLDER = DEFAULT_STDIO_ARGS.join(', ');

export const DEFAULT_CHAT_STREAM_TIMEOUT_SECONDS = 180;
export const CHAT_STREAM_SETTINGS_EVENT = 'DSTU_CHAT_STREAM_SETTINGS_UPDATED';
export const UI_ZOOM_STORAGE_KEY = 'ui.zoom';
export const DEFAULT_UI_ZOOM = 1;
export const MIN_UI_ZOOM = 0.85;
export const MAX_UI_ZOOM = 1.5;
export const UI_ZOOM_PRESETS = [
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
