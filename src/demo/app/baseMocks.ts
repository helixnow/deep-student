/**
 * 单应用演示的通用 IPC mock：设置表、模型、几条各应用都会碰到的静默命令。
 * 每个剧本包的 handle 先跑，返回 undefined 才落到这里。
 *
 * 没 mock 的命令返回 null 并记进 window.__DEMO_UNMOCKED__（烟测据此报告），
 * 演示里一律不抛错——抛错会让应用弹「操作失败」提示。
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { DemoAppPack, DemoArgs } from './types';

const LOG = '[demo-app-ipc]';

declare global {
  interface Window {
    __DEMO_UNMOCKED__?: string[];
    __DEMO_MISSING_I18N__?: string[];
    __DEMO_READY__?: boolean;
  }
}

/** 演示用的两家模型（与对话演示同名，界面上的模型选择器显示这两个） */
export const DEMO_APP_MODEL_PROFILES = [
  { id: 'demo-deepseek-v4', label: 'DeepSeek V4', model: 'deepseek-v4' },
  { id: 'demo-kimi-k3', label: 'Kimi K3', model: 'kimi-k3' },
];

const BASE_SETTINGS: Record<string, unknown> = {
  app_initialized: 'true',
  user_agreement_accepted: '1.0.0',
  'desktop.workbenchMode': 'true',
};

/** 各应用启动都会查、但演示里没有内容的命令 */
const EMPTY_LIST_COMMANDS = new Set([
  'dstu_list',
  'skill_list_directories',
  'list_mcp_servers',
  'get_recent_items',
]);

const SILENT_COMMANDS = new Set([
  'dstu_watch',
  'dstu_unwatch',
  'plugin:event|listen',
  'plugin:event|unlisten',
  'track_event',
  'log_frontend_event',
]);

export function installDemoAppMocks(pack: DemoAppPack): void {
  const settings = new Map<string, unknown>(Object.entries({ ...BASE_SETTINGS, ...(pack.settings ?? {}) }));
  const unmocked = new Set<string>();
  window.__DEMO_UNMOCKED__ = [];
  mockWindows('main');

  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as DemoArgs;
      const handled = pack.handle?.(cmd, args);
      if (handled !== undefined) return handled;

      switch (cmd) {
        case 'get_setting': {
          const key = String(args.key ?? '');
          return settings.has(key) ? settings.get(key) : null;
        }
        case 'save_setting':
          settings.set(String(args.key ?? ''), args.value);
          return null;
        case 'get_model_profiles':
          return DEMO_APP_MODEL_PROFILES;
        case 'get_model_assignments':
          return { model2_config_id: 'demo-deepseek-v4' };
        case 'plugin:clipboard-manager|write_text':
          // 交给浏览器剪贴板回退路径
          throw new Error('Use browser clipboard');
        default:
          break;
      }
      if (EMPTY_LIST_COMMANDS.has(cmd)) return [];
      if (SILENT_COMMANDS.has(cmd)) return null;
      if (!unmocked.has(cmd)) {
        unmocked.add(cmd);
        window.__DEMO_UNMOCKED__ = [...unmocked];
        console.warn(`${LOG} unmocked cmd:`, cmd, args);
      }
      return null;
    },
    { shouldMockEvents: true },
  );
}
