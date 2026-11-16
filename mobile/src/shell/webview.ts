/**
 * 移动端 `plugin:webview|*` 处理（对应 `@tauri-apps/api/webview`）。
 */
import { parseJsonArgs, reqNumber, type MobilePluginHandler } from './plugin-args.ts';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function viewportPhysicalSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  const scale = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return {
    width: Math.round((window.innerWidth || 0) * scale),
    height: Math.round((window.innerHeight || 0) * scale),
  };
}

/** 创建供 `MobileShell` 使用的 `plugin:webview|*` 处理器。 */
export function createMobileWebviewHandler(windowLabel = 'main', webviewLabel = 'main'): MobilePluginHandler {
  return ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'webview');
    switch (command) {
      case 'get_all_webviews':
        return [{ windowLabel, label: webviewLabel }];
      case 'set_webview_zoom': {
        const zoom = clampZoom(reqNumber(args, 'value', command));
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.style.zoom = String(zoom);
        }
        return null;
      }
      case 'webview_size':
        return viewportPhysicalSize();
      case 'webview_position':
        return { x: 0, y: 0 };
      case 'print':
        if (typeof globalThis.print === 'function') globalThis.print();
        return null;
      case 'set_webview_size':
      case 'set_webview_position':
      case 'set_webview_auto_resize':
      case 'set_webview_focus':
      case 'webview_show':
      case 'webview_hide':
      case 'webview_close':
      case 'set_webview_background_color':
      case 'clear_all_browsing_data':
      case 'reparent':
      case 'create_webview':
      case 'create_webview_window':
        return null;
      default:
        throw new Error(`unsupported webview command "${command}"`);
    }
  };
}
