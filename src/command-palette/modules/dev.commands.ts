/**
 * 开发者命令
 * 用于调试和开发
 */

import i18next from 'i18next';
import {
  Bug,
  Database,
  Terminal,
  FileJson,
  Cpu,
  RefreshCw,
  Trash2,
  Eye,
  Code,
} from 'lucide-react';
import type { Command } from '../registry/types';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

export const devCommands: Command[] = [
  {
    id: 'dev.toggle-debug-panel',
    get name() { return i18next.t('command_palette:commands.dev.toggle-debug-panel', 'Toggle Debug Panel'); },
    get description() { return i18next.t('command_palette:descriptions.dev.toggle-debug-panel', 'Show/hide debug panel'); },
    category: 'dev',
    shortcut: 'mod+shift+d',
    icon: Bug,
    get keywords() { return kw('dev.toggle-debug-panel'); },
    priority: 100,
    execute: () => {
      window.dispatchEvent(new CustomEvent('DEV_TOGGLE_DEBUG_PANEL'));
    },
  },
  {
    id: 'dev.open-devtools',
    get name() { return i18next.t('command_palette:commands.dev.open-devtools', 'Open DevTools'); },
    get description() { return i18next.t('command_palette:descriptions.dev.open-devtools', 'Open browser developer tools'); },
    category: 'dev',
    shortcut: 'f12',
    icon: Terminal,
    get keywords() { return kw('dev.open-devtools'); },
    priority: 99,
    execute: async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_devtools');
      } catch {
        // Web fallback - F12 会被浏览器捕获
        console.log(`[Dev] ${i18next.t('command_palette:notifications.dev_open_devtools_hint', 'Please press F12 to open DevTools in the browser')}`);
      }
    },
  },
  {
    id: 'dev.view-database',
    get name() { return i18next.t('command_palette:commands.dev.view-database', 'View Database'); },
    get description() { return i18next.t('command_palette:descriptions.dev.view-database', 'Open database debug panel'); },
    category: 'dev',
    icon: Database,
    get keywords() { return kw('dev.view-database'); },
    priority: 90,
    execute: () => {
      window.dispatchEvent(new CustomEvent('DEV_VIEW_DATABASE'));
    },
  },
  {
    id: 'dev.export-state',
    get name() { return i18next.t('command_palette:commands.dev.export-state', 'Export App State'); },
    get description() { return i18next.t('command_palette:descriptions.dev.export-state', 'Export current app state as JSON'); },
    category: 'dev',
    icon: FileJson,
    get keywords() { return kw('dev.export-state'); },
    priority: 80,
    execute: () => {
      window.dispatchEvent(new CustomEvent('DEV_EXPORT_STATE'));
    },
  },
  {
    id: 'dev.view-performance',
    get name() { return i18next.t('command_palette:commands.dev.view-performance', 'Performance Monitor'); },
    get description() { return i18next.t('command_palette:descriptions.dev.view-performance', 'Open performance monitoring'); },
    category: 'dev',
    icon: Cpu,
    get keywords() { return kw('dev.view-performance'); },
    priority: 70,
    execute: () => {
      window.dispatchEvent(new CustomEvent('DEV_VIEW_PERFORMANCE'));
    },
  },
  {
    id: 'dev.reload-app',
    get name() { return i18next.t('command_palette:commands.dev.reload-app', 'Force Reload App'); },
    get description() { return i18next.t('command_palette:descriptions.dev.reload-app', 'Force reload the application'); },
    category: 'dev',
    icon: RefreshCw,
    get keywords() { return kw('dev.reload-app'); },
    priority: 60,
    execute: () => {
      window.location.reload();
    },
  },
  {
    id: 'dev.clear-cache',
    get name() { return i18next.t('command_palette:commands.dev.clear-cache', 'Clear Cache'); },
    get description() { return i18next.t('command_palette:descriptions.dev.clear-cache', 'Clear localStorage and IndexedDB'); },
    category: 'dev',
    icon: Trash2,
    get keywords() { return kw('dev.clear-cache'); },
    priority: 50,
    execute: async () => {
      if (unifiedConfirm(i18next.t('command_palette:notifications.confirm_clear_cache', 'Are you sure you want to clear all cache data? This will reload the app.'))) {
        try {
          localStorage.clear();
          const databases = await indexedDB.databases();
          for (const db of databases) {
            if (db.name) {
              indexedDB.deleteDatabase(db.name);
            }
          }
          window.location.reload();
        } catch (e: unknown) {
          console.error(`[Dev] ${i18next.t('command_palette:notifications.dev_clear_cache_failed', 'Failed to clear cache')}`, e);
        }
      }
    },
  },
  {
    id: 'dev.view-logs',
    get name() { return i18next.t('command_palette:commands.dev.view-logs', 'View Logs'); },
    get description() { return i18next.t('command_palette:descriptions.dev.view-logs', 'View application logs'); },
    category: 'dev',
    icon: Eye,
    get keywords() { return kw('dev.view-logs'); },
    priority: 40,
    execute: () => {
      window.dispatchEvent(new CustomEvent('DEV_VIEW_LOGS'));
    },
  },
  {
    id: 'dev.crepe-demo',
    get name() { return i18next.t('command_palette:commands.dev.crepe-demo', 'Open Crepe Editor Demo'); },
    get description() { return i18next.t('command_palette:descriptions.dev.crepe-demo', 'Open Crepe editor demo page'); },
    category: 'dev',
    icon: Code,
    get keywords() { return kw('dev.crepe-demo'); },
    priority: 30,
    execute: (deps) => {
      deps.navigate('crepe-demo');
    },
  },
];
