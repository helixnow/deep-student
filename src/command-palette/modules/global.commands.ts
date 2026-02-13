/**
 * 全局命令 - SOTA 版本
 * 覆盖应用级别的通用操作
 */

import i18next from 'i18next';
import {
  Command as CommandIcon,
  Search,
  RefreshCw,
  Maximize,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Keyboard,
  HelpCircle,
  Info,
  Bug,
  Download,
  Upload,
  Copy,
  Clipboard,
  Bell,
  BellOff,
  Moon,
  Sun,
  Monitor,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  Lock,
  Unlock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader,
} from 'lucide-react';
import type { Command } from '../registry/types';
import { isGlobalCommandEnabled } from '../registry/capabilityRegistry';

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

/**
 * 全局命令工厂函数
 * 使用 i18next.t() 进行运行时国际化
 *
 * 注：未实现的幽灵命令通过 capabilityRegistry 标记为 hidden，
 * 保留定义以便未来实现。
 */
function createRawGlobalCommands(): Command[] {
  return [
    // ==================== 命令面板 ====================
    {
      id: 'global.command-palette',
      name: i18next.t('command_palette:commands.global.command-palette', 'Open Command Palette'),
      description: i18next.t('command_palette:descriptions.global.command-palette', 'Quick access to all commands'),
      category: 'global',
      shortcut: 'mod+k',
      icon: CommandIcon,
      keywords: kw('global.command-palette'),
      priority: 100,
      execute: (deps) => {
        deps.openCommandPalette();
      },
    },
    {
      id: 'global.quick-search',
      name: i18next.t('command_palette:commands.global.quick-search', 'Global Search'),
      description: i18next.t('command_palette:descriptions.global.quick-search', 'Search notes, conversations, documents'),
      category: 'global',
      shortcut: 'mod+p',
      icon: Search,
      keywords: kw('global.quick-search'),
      priority: 99,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_QUICK_SEARCH'));
      },
    },
    {
      id: 'global.shortcut-settings',
      name: i18next.t('command_palette:commands.global.shortcut-settings', 'Shortcut Settings'),
      description: i18next.t('command_palette:descriptions.global.shortcut-settings', 'Customize keyboard shortcuts'),
      category: 'global',
      icon: Keyboard,
      keywords: kw('global.shortcut-settings'),
      priority: 90,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_SHORTCUT_SETTINGS'));
      },
    },

    // ==================== 应用控制 ====================
    {
      id: 'global.reload',
      name: i18next.t('command_palette:commands.global.reload', 'Reload App'),
      description: i18next.t('command_palette:descriptions.global.reload', 'Reload application page'),
      category: 'global',
      shortcut: 'mod+alt+r',
      icon: RefreshCw,
      keywords: kw('global.reload'),
      priority: 50,
      execute: () => {
        window.location.reload();
      },
    },
    {
      id: 'global.toggle-fullscreen',
      name: i18next.t('command_palette:commands.global.toggle-fullscreen', 'Toggle Fullscreen'),
      description: i18next.t('command_palette:descriptions.global.toggle-fullscreen', 'Toggle fullscreen display mode'),
      category: 'global',
      shortcut: 'f11',
      icon: Maximize,
      keywords: kw('global.toggle-fullscreen'),
      priority: 49,
      execute: async () => {
        try {
          // Tauri 全屏切换
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const appWindow = getCurrentWindow();
          const isFullscreen = await appWindow.isFullscreen();
          await appWindow.setFullscreen(!isFullscreen);
        } catch {
          // Web fallback
          if (document.fullscreenElement) {
            document.exitFullscreen?.();
          } else {
            document.documentElement.requestFullscreen?.();
          }
        }
      },
    },

    // ==================== 缩放控制 ====================
    {
      id: 'global.zoom-in',
      name: i18next.t('command_palette:commands.global.zoom-in', 'Zoom In'),
      description: i18next.t('command_palette:descriptions.global.zoom-in', 'Increase interface zoom level'),
      category: 'global',
      shortcut: 'mod+=',
      icon: ZoomIn,
      keywords: kw('global.zoom-in'),
      priority: 48,
      execute: () => {
        const currentZoom = parseFloat(document.body.style.zoom || '1');
        document.body.style.zoom = String(Math.min(currentZoom + 0.1, 2));
      },
    },
    {
      id: 'global.zoom-out',
      name: i18next.t('command_palette:commands.global.zoom-out', 'Zoom Out'),
      description: i18next.t('command_palette:descriptions.global.zoom-out', 'Decrease interface zoom level'),
      category: 'global',
      shortcut: 'mod+-',
      icon: ZoomOut,
      keywords: kw('global.zoom-out'),
      priority: 47,
      execute: () => {
        const currentZoom = parseFloat(document.body.style.zoom || '1');
        document.body.style.zoom = String(Math.max(currentZoom - 0.1, 0.5));
      },
    },
    {
      id: 'global.zoom-reset',
      name: i18next.t('command_palette:commands.global.zoom-reset', 'Reset Zoom'),
      description: i18next.t('command_palette:descriptions.global.zoom-reset', 'Restore default zoom level'),
      category: 'global',
      shortcut: 'mod+0',
      icon: RotateCcw,
      keywords: kw('global.zoom-reset'),
      priority: 46,
      execute: () => {
        document.body.style.zoom = '1';
      },
    },

    // ==================== 主题与显示 ====================
    {
      id: 'global.toggle-theme',
      name: i18next.t('command_palette:commands.global.toggle-theme', 'Toggle Theme'),
      description: i18next.t('command_palette:descriptions.global.toggle-theme', 'Toggle light/dark theme'),
      category: 'global',
      shortcut: 'mod+shift+t',
      icon: Moon,
      keywords: kw('global.toggle-theme'),
      priority: 80,
      execute: (deps) => {
        deps.toggleTheme();
      },
    },
    {
      id: 'global.theme-light',
      name: i18next.t('command_palette:commands.global.theme-light', 'Light Theme'),
      description: i18next.t('command_palette:descriptions.global.theme-light', 'Switch to light theme'),
      category: 'global',
      icon: Sun,
      keywords: kw('global.theme-light'),
      priority: 79,
      isEnabled: (deps) => deps.isDarkMode(),
      execute: (deps) => {
        if (deps.isDarkMode()) {
          deps.toggleTheme();
        }
      },
    },
    {
      id: 'global.theme-dark',
      name: i18next.t('command_palette:commands.global.theme-dark', 'Dark Theme'),
      description: i18next.t('command_palette:descriptions.global.theme-dark', 'Switch to dark theme'),
      category: 'global',
      icon: Moon,
      keywords: kw('global.theme-dark'),
      priority: 78,
      isEnabled: (deps) => !deps.isDarkMode(),
      execute: (deps) => {
        if (!deps.isDarkMode()) {
          deps.toggleTheme();
        }
      },
    },
    {
      id: 'global.theme-system',
      name: i18next.t('command_palette:commands.global.theme-system', 'System Theme'),
      description: i18next.t('command_palette:descriptions.global.theme-system', 'Use system default theme setting'),
      category: 'global',
      icon: Monitor,
      keywords: kw('global.theme-system'),
      priority: 77,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_THEME_SYSTEM'));
      },
    },

    // ==================== 通知控制 ====================
    {
      id: 'global.toggle-notifications',
      name: i18next.t('command_palette:commands.global.toggle-notifications', 'Toggle Notifications'),
      description: i18next.t('command_palette:descriptions.global.toggle-notifications', 'Enable/disable app notifications'),
      category: 'global',
      icon: Bell,
      keywords: kw('global.toggle-notifications'),
      priority: 60,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_TOGGLE_NOTIFICATIONS'));
      },
    },
    {
      id: 'global.mute-sounds',
      name: i18next.t('command_palette:commands.global.mute-sounds', 'Mute Sounds'),
      description: i18next.t('command_palette:descriptions.global.mute-sounds', 'Mute all sound alerts'),
      category: 'global',
      icon: VolumeX,
      keywords: kw('global.mute-sounds'),
      priority: 59,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_MUTE_SOUNDS'));
      },
    },

    // ==================== 网络与同步 ====================
    {
      id: 'global.check-connection',
      name: i18next.t('command_palette:commands.global.check-connection', 'Check Connection'),
      description: i18next.t('command_palette:descriptions.global.check-connection', 'Check API connection status'),
      category: 'global',
      icon: Wifi,
      keywords: kw('global.check-connection'),
      priority: 55,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_CHECK_CONNECTION'));
      },
    },
    {
      id: 'global.sync-now',
      name: i18next.t('command_palette:commands.global.sync-now', 'Sync Now'),
      description: i18next.t('command_palette:descriptions.global.sync-now', 'Manually trigger data sync'),
      category: 'global',
      icon: RefreshCw,
      keywords: kw('global.sync-now'),
      priority: 54,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_SYNC_NOW'));
      },
    },

    // ==================== 剪贴板操作 ====================
    {
      id: 'global.copy-current-url',
      name: i18next.t('command_palette:commands.global.copy-current-url', 'Copy Current URL'),
      description: i18next.t('command_palette:descriptions.global.copy-current-url', 'Copy current page URL'),
      category: 'global',
      icon: Copy,
      keywords: kw('global.copy-current-url'),
      priority: 40,
      execute: async (deps) => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          deps.showNotification('success', i18next.t('command_palette:notifications.link_copied', 'Link copied'));
        } catch {
          deps.showNotification('error', i18next.t('command_palette:notifications.copy_failed', 'Copy failed'));
        }
      },
    },
    {
      id: 'global.paste-from-clipboard',
      name: i18next.t('command_palette:commands.global.paste-from-clipboard', 'Paste from Clipboard'),
      description: i18next.t('command_palette:descriptions.global.paste-from-clipboard', 'Read clipboard content'),
      category: 'global',
      icon: Clipboard,
      keywords: kw('global.paste-from-clipboard'),
      priority: 39,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_PASTE_FROM_CLIPBOARD'));
      },
    },

    // ==================== 帮助与信息 ====================
    {
      id: 'global.show-help',
      name: i18next.t('command_palette:commands.global.show-help', 'Help Documentation'),
      description: i18next.t('command_palette:descriptions.global.show-help', 'Open help documentation'),
      category: 'global',
      shortcut: 'f1',
      icon: HelpCircle,
      keywords: kw('global.show-help'),
      priority: 30,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_SHOW_HELP'));
      },
    },
    {
      id: 'global.about',
      name: i18next.t('command_palette:commands.global.about', 'About App'),
      description: i18next.t('command_palette:descriptions.global.about', 'View app version and information'),
      category: 'global',
      icon: Info,
      keywords: kw('global.about'),
      priority: 29,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_SHOW_ABOUT'));
      },
    },
    {
      id: 'global.changelog',
      name: i18next.t('command_palette:commands.global.changelog', 'Changelog'),
      description: i18next.t('command_palette:descriptions.global.changelog', 'View version update log'),
      category: 'global',
      icon: Info,
      keywords: kw('global.changelog'),
      priority: 28,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_SHOW_CHANGELOG'));
      },
    },
    {
      id: 'global.report-bug',
      name: i18next.t('command_palette:commands.global.report-bug', 'Report Bug'),
      description: i18next.t('command_palette:descriptions.global.report-bug', 'Submit bug report'),
      category: 'global',
      icon: Bug,
      keywords: kw('global.report-bug'),
      priority: 27,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_REPORT_BUG'));
      },
    },

    // ==================== 数据操作 ====================
    {
      id: 'global.export-all',
      name: i18next.t('command_palette:commands.global.export-all', 'Export All Data'),
      description: i18next.t('command_palette:descriptions.global.export-all', 'Export all application data'),
      category: 'global',
      icon: Download,
      keywords: kw('global.export-all'),
      priority: 35,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_EXPORT_ALL'));
      },
    },
    {
      id: 'global.import-data',
      name: i18next.t('command_palette:commands.global.import-data', 'Import Data'),
      description: i18next.t('command_palette:descriptions.global.import-data', 'Import data from file'),
      category: 'global',
      icon: Upload,
      keywords: kw('global.import-data'),
      priority: 34,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_IMPORT_DATA'));
      },
    },

    // ==================== 锁定与安全 ====================
    {
      id: 'global.lock-app',
      name: i18next.t('command_palette:commands.global.lock-app', 'Lock App'),
      description: i18next.t('command_palette:descriptions.global.lock-app', 'Lock app, requires password to unlock'),
      category: 'global',
      shortcut: 'mod+l',
      icon: Lock,
      keywords: kw('global.lock-app'),
      priority: 20,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_LOCK_APP'));
      },
    },

    // ==================== 状态指示（仅显示用） ====================
    {
      id: 'global.show-loading',
      name: i18next.t('command_palette:commands.global.show-loading', 'Show Loading Status'),
      description: i18next.t('command_palette:descriptions.global.show-loading', 'Tasks currently being processed'),
      category: 'global',
      icon: Loader,
      keywords: kw('global.show-loading'),
      priority: 10,
      execute: () => {
        window.dispatchEvent(new CustomEvent('GLOBAL_SHOW_LOADING_STATUS'));
      },
    },
  ];
}

/**
 * 通过 capabilityRegistry 过滤后的命令列表。
 * hidden 命令保留定义但不在命令面板中显示。
 */
export function getGlobalCommands(): Command[] {
  return createRawGlobalCommands().map((command) => {
    const previousIsEnabled = command.isEnabled;
    return {
      ...command,
      isEnabled: (deps) => {
        if (!isGlobalCommandEnabled(command.id)) return false;
        return previousIsEnabled ? previousIsEnabled(deps) : true;
      },
    };
  });
}
