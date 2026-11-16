/**
 * 移动端 `plugin:window|*` 处理（对应 `@tauri-apps/api/window`）。
 */
import { parseJsonArgs, type MobilePluginHandler } from './plugin-args.ts';

function windowScaleFactor(): number {
  if (typeof window === 'undefined') return 1;
  return typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

function windowPhysicalSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  const scale = windowScaleFactor();
  return {
    width: Math.round((window.innerWidth || 0) * scale),
    height: Math.round((window.innerHeight || 0) * scale),
  };
}

function currentMonitorInfo() {
  const size = windowPhysicalSize();
  return {
    name: 'mobile',
    size,
    position: { x: 0, y: 0 },
    workArea: { position: { x: 0, y: 0 }, size },
    scaleFactor: windowScaleFactor(),
  };
}

/** 创建供 `MobileShell` 使用的 `plugin:window|*` 处理器。 */
export function createMobileWindowHandler(windowLabel = 'main'): MobilePluginHandler {
  return ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'window');
    switch (command) {
      case 'get_all_windows':
        return [windowLabel];
      case 'is_visible':
      case 'is_focused':
      case 'is_enabled':
        return true;
      case 'is_minimized':
      case 'is_maximized':
      case 'is_decorated':
      case 'is_resizable':
      case 'is_maximizable':
      case 'is_minimizable':
      case 'is_closable':
      case 'is_always_on_top':
        return false;
      case 'is_fullscreen':
        return typeof document !== 'undefined' && Boolean(document.fullscreenElement);
      case 'title':
        return typeof document !== 'undefined' ? document.title : 'Deep Student';
      case 'set_title':
        if (typeof document !== 'undefined' && typeof args.value === 'string') {
          document.title = args.value;
        }
        return null;
      case 'theme':
        return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      case 'scale_factor':
        return windowScaleFactor();
      case 'inner_size':
      case 'outer_size':
        return windowPhysicalSize();
      case 'inner_position':
      case 'outer_position':
      case 'cursor_position':
        return { x: 0, y: 0 };
      case 'current_monitor':
      case 'primary_monitor':
      case 'monitor_from_point':
        return currentMonitorInfo();
      case 'available_monitors':
        return [currentMonitorInfo()];
      case 'activity_name':
      case 'scene_identifier':
      case 'create':
      case 'set_focus':
      case 'show':
      case 'hide':
      case 'minimize':
      case 'unminimize':
      case 'maximize':
      case 'unmaximize':
      case 'toggle_maximize':
      case 'internal_toggle_maximize':
      case 'close':
      case 'destroy':
      case 'center':
      case 'request_user_attention':
      case 'set_resizable':
      case 'set_enabled':
      case 'set_maximizable':
      case 'set_minimizable':
      case 'set_closable':
      case 'set_decorations':
      case 'set_shadow':
      case 'set_effects':
      case 'set_always_on_top':
      case 'set_always_on_bottom':
      case 'set_content_protected':
      case 'set_size':
      case 'set_min_size':
      case 'set_max_size':
      case 'set_size_constraints':
      case 'set_position':
      case 'set_fullscreen':
      case 'set_simple_fullscreen':
      case 'set_focusable':
      case 'set_icon':
      case 'set_skip_taskbar':
      case 'set_cursor_grab':
      case 'set_cursor_visible':
      case 'set_cursor_icon':
      case 'set_background_color':
      case 'set_cursor_position':
      case 'set_ignore_cursor_events':
      case 'start_dragging':
      case 'start_resize_dragging':
      case 'set_badge_count':
      case 'set_badge_label':
      case 'set_overlay_icon':
      case 'set_progress_bar':
      case 'set_visible_on_all_workspaces':
      case 'set_title_bar_style':
      case 'set_theme':
        return null;
      default:
        throw new Error(`unsupported window command "${command}"`);
    }
  };
}
