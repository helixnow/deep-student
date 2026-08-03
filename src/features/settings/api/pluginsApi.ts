import { invoke } from '@tauri-apps/api/core';

export type PluginState =
  | 'stopped'
  | 'starting'
  | 'waiting_login'
  | 'running'
  | 'stopping'
  | 'error';

export interface PluginInfo {
  id: string;
  label: string;
  blurb: string;
  kind: 'channel';
  state: PluginState;
  enabled: boolean;
  configured: boolean;
  bound: boolean;
  error?: string | null;
}

export interface PluginStatusSnapshot {
  state: PluginState;
  enabled: boolean;
  configured: boolean;
  bound: boolean;
  loginStatus?: string | null;
  accountId?: string | null;
  userId?: string | null;
  lastError?: string | null;
  lastActivity?: string | null;
  qrcodePngBase64?: string | null;
  qrcodeStatus?: string | null;
}

export interface IlinkBotConfig {
  enabled: boolean;
  rateLimitPerMin: number;
  modelConfigId: string;
  systemPrompt: string;
  bound: boolean;
  hasToken: boolean;
  accountId: string;
  userId: string;
  baseUrl: string;
}

export const PLUGIN_EVENTS = {
  stateChanged: 'plugin-state-changed',
  qrcode: 'plugin-qrcode',
  activity: 'plugin-activity',
} as const;

export const pluginsApi = {
  list: () => invoke<PluginInfo[]>('plugin_list'),
  start: (id: string) => invoke<PluginState>('plugin_start', { id }),
  stop: (id: string) => invoke<PluginState>('plugin_stop', { id }),
  getStatus: (id: string) => invoke<PluginStatusSnapshot>('plugin_get_status', { id }),
  getConfig: (id: string) => invoke<IlinkBotConfig>('plugin_get_config', { id }),
  setConfig: (id: string, patch: Partial<IlinkBotConfig> & Record<string, unknown>) =>
    invoke<void>('plugin_set_config', { id, patch }),
  setEnabled: (id: string, enabled: boolean) =>
    invoke<void>('plugin_set_enabled', { id, enabled }),
  beginLogin: (id: string) => invoke<void>('plugin_begin_login', { id }),
  cancelLogin: (id: string) => invoke<void>('plugin_cancel_login', { id }),
  logout: (id: string) => invoke<void>('plugin_logout', { id }),
  unbind: (id: string) => invoke<void>('plugin_unbind', { id }),
};
