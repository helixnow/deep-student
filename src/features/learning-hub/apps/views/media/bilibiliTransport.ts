import { invoke } from '@tauri-apps/api/core';
import { useEffect, useSyncExternalStore } from 'react';
import { toMediaCommandError } from './mediaTranscriptApi';

export type BilibiliRouteMode = 'auto' | 'native' | 'browser_bridge' | 'proxy';
export interface BilibiliTransportSettings {
  mode: BilibiliRouteMode;
  proxyUrl: string | null;
  proxyInAuto: boolean;
}
export interface BilibiliTransportStatus {
  diagnostics?: Array<{ requestId: number; attemptId: string; route: string; stage: string; host: string; elapsedMs: number; status: number | null; errorCode: string | null; bytes: number }>;
  settings: BilibiliTransportSettings;
  bridge: {
    state: string;
    connectionId: string | null;
    scriptVersion: string | null;
    parsing: boolean;
    media: boolean;
    generation: number;
    lastError?: { code: string; message: string } | null;
    account: { loggedIn: boolean; mid: number | null; uname: string | null } | null;
  };
}

let current: BilibiliTransportStatus | null = null;
let pending: Promise<BilibiliTransportStatus> | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) timer = setInterval(() => void refreshBilibiliTransport().catch(() => undefined), 2000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = undefined; }
  };
}
export function refreshBilibiliTransport(): Promise<BilibiliTransportStatus> {
  if (!pending) pending = invoke<BilibiliTransportStatus>('media_bilibili_transport_status').then((next) => {
    if (next?.bridge && next?.settings) { current = next; listeners.forEach((listener) => listener()); }
    return next;
  }).finally(() => { pending = null; });
  return pending;
}
export function useBilibiliTransport(enabled = true) {
  const status = useSyncExternalStore(enabled ? subscribe : () => () => undefined, () => enabled ? current : null, () => null);
  useEffect(() => { if (enabled) void refreshBilibiliTransport().catch(() => undefined); }, [enabled]);
  return status;
}
async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(name, args); } catch (error) { throw toMediaCommandError(error); }
}
export const bilibiliTransportApi = {
  pair: () => command<{ url: string; scriptUrl: string }>('media_bilibili_bridge_pair'),
  approve: (connectionId: string) => command<void>('media_bilibili_bridge_approve', { connectionId }),
  disconnect: () => command<void>('media_bilibili_bridge_disconnect'),
  configure: (config: BilibiliTransportSettings) => command<void>('media_bilibili_transport_configure', { config }),
};
