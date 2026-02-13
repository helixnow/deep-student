/**
 * 设置命令
 */

import i18next from 'i18next';
import {
  Settings,
  Moon,
  Sun,
  Languages,
  Database,
  Download,
  Upload,
  Cloud,
  Key,
} from 'lucide-react';
import type { Command } from '../registry/types';

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

export const settingsCommands: Command[] = [
  {
    id: 'settings.open',
    get name() { return i18next.t('command_palette:commands.settings.open', 'Open Settings'); },
    get description() { return i18next.t('command_palette:descriptions.settings.open', 'Open app settings and preferences'); },
    category: 'settings',
    // shortcut 已由 nav.goto.settings (mod+,) 提供
    icon: Settings,
    get keywords() { return kw('settings.open'); },
    priority: 100,
    execute: (deps) => {
      deps.navigate('settings');
    },
  },
  {
    id: 'settings.toggle-theme',
    get name() { return i18next.t('command_palette:commands.settings.toggle-theme', 'Toggle Theme'); },
    get description() { return i18next.t('command_palette:descriptions.settings.toggle-theme', 'Light/Dark toggle'); },
    category: 'settings',
    // shortcut 已由 global.toggle-theme (mod+shift+t) 提供
    icon: Moon,
    get keywords() { return kw('settings.toggle-theme'); },
    priority: 99,
    execute: (deps) => {
      // 先获取当前状态，然后切换，通知显示切换后的状态
      const wasDark = deps.isDarkMode();
      deps.toggleTheme();
      // 切换后状态与之前相反
      deps.showNotification(
        'info',
        i18next.t(
          wasDark
            ? 'command_palette:notifications.theme_light'
            : 'command_palette:notifications.theme_dark'
        )
      );
    },
  },
  {
    id: 'settings.switch-language',
    get name() { return i18next.t('command_palette:commands.settings.switch-language', 'Switch Language'); },
    get description() { return i18next.t('command_palette:descriptions.settings.switch-language', 'Switch between Chinese and English'); },
    category: 'settings',
    icon: Languages,
    get keywords() { return kw('settings.switch-language'); },
    priority: 98,
    execute: (deps) => {
      const currentLang = deps.getCurrentLanguage();
      const newLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';
      deps.switchLanguage(newLang);
      deps.showNotification(
        'info',
        i18next.t('command_palette:notifications.language_switched')
      );
    },
  },
  {
    id: 'settings.api-config',
    get name() { return i18next.t('command_palette:commands.settings.api-config', 'Configure API'); },
    get description() { return i18next.t('command_palette:descriptions.settings.api-config', 'Manage AI model API settings'); },
    category: 'settings',
    icon: Key,
    get keywords() { return kw('settings.api-config'); },
    priority: 90,
    execute: (deps) => {
      deps.navigate('settings');
      // 触发设置页面跳转到 API 配置 tab
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab: 'api' } }));
      }, 100);
    },
  },
  {
    id: 'settings.backup',
    get name() { return i18next.t('command_palette:commands.settings.backup', 'Backup Data'); },
    get description() { return i18next.t('command_palette:descriptions.settings.backup', 'Export all data locally'); },
    category: 'settings',
    icon: Download,
    get keywords() { return kw('settings.backup'); },
    priority: 80,
    execute: () => {
      window.dispatchEvent(new CustomEvent('COMMAND_PALETTE_BACKUP_DATA'));
    },
  },
  {
    id: 'settings.restore',
    get name() { return i18next.t('command_palette:commands.settings.restore', 'Restore Data'); },
    get description() { return i18next.t('command_palette:descriptions.settings.restore', 'Restore from backup file'); },
    category: 'settings',
    icon: Upload,
    get keywords() { return kw('settings.restore'); },
    priority: 79,
    execute: () => {
      window.dispatchEvent(new CustomEvent('COMMAND_PALETTE_RESTORE_DATA'));
    },
  },
  {
    id: 'settings.cloud-sync',
    get name() { return i18next.t('command_palette:commands.settings.cloud-sync', 'Cloud Sync'); },
    get description() { return i18next.t('command_palette:descriptions.settings.cloud-sync', 'Open cloud storage settings'); },
    category: 'settings',
    icon: Cloud,
    get keywords() { return kw('settings.cloud-sync'); },
    priority: 78,
    execute: () => {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_CLOUD_STORAGE_SETTINGS'));
    },
  },
];
