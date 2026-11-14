/**
 * `dstu-media/src/media/bilibili_transport/session.rs` transport settings and
 * request diagnostics behind `media_bilibili_transport_{status,configure}`.
 *
 * The bridge server itself (WebSocket pairing and media slots) is not migrated,
 * so `bridge` reports the shared `BridgeHub` state; diagnostics stay empty until
 * a TS transport records an attempt through `recordRequestDiagnostic`.
 */
import { BiliRequestError } from './bilibili-policy.ts';
import type { BridgeHub, BridgeStatus } from './bilibili-bridge-hub.ts';

export const TRANSPORT_SETTINGS_KEY = 'media.bilibili.transport.v1';
const DIAGNOSTIC_LIMIT = 32;

export type RouteMode = 'auto' | 'native' | 'browser_bridge' | 'proxy';
export type Route = 'native' | 'browser_bridge' | 'proxy';
export type RequestKind = 'short_link' | 'api' | 'subtitle' | 'media' | 'passport' | 'cover';

export interface TransportSettings {
  mode: RouteMode;
  proxyUrl: string | null;
  proxyInAuto: boolean;
}

export interface RequestDiagnostic {
  requestId: number;
  attemptId: string;
  route: Route;
  stage: RequestKind;
  host: string;
  elapsedMs: number;
  status: number | null;
  errorCode: string | null;
  bytes: number;
}

export interface TransportStatus {
  settings: TransportSettings;
  bridge: BridgeStatus;
  diagnostics: RequestDiagnostic[];
}

export interface TransportSettingsStore {
  get(key: string): string | null;
  save(key: string, value: string): void;
}

export const DEFAULT_TRANSPORT_SETTINGS: TransportSettings = {
  mode: 'auto',
  proxyUrl: null,
  proxyInAuto: false,
};

const ROUTE_MODES: RouteMode[] = ['auto', 'native', 'browser_bridge', 'proxy'];

export function decodeRouteMode(value: unknown): RouteMode | null {
  if (typeof value === 'string') {
    return (ROUTE_MODES as string[]).includes(value) ? value as RouteMode : null;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) return null;
    const key = keys[0]!;
    if (!(ROUTE_MODES as string[]).includes(key)) return null;
    return (value as Record<string, unknown>)[key] === null ? key as RouteMode : null;
  }
  return null;
}

function settingsError(message: string): BiliRequestError {
  return new BiliRequestError('proxy-config', message);
}

/** IPC `TransportSettings__De` → runtime settings (enum may be string or tagged object). */
export function decodeTransportSettings(input: unknown): TransportSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BiliRequestError('proxy-config', '代理配置无效');
  }
  const record = input as Record<string, unknown>;
  const mode = decodeRouteMode(record.mode);
  if (mode === null || typeof record.proxyInAuto !== 'boolean') {
    throw new BiliRequestError('proxy-config', '代理配置无效');
  }
  const proxyUrl = record.proxyUrl === undefined || record.proxyUrl === null
    ? null
    : typeof record.proxyUrl === 'string' ? record.proxyUrl : undefined;
  if (proxyUrl === undefined) throw new BiliRequestError('proxy-config', '代理配置无效');
  return { mode, proxyUrl, proxyInAuto: record.proxyInAuto };
}

/** `TransportSettings` serialized JSON → Rust serde defaults on any failure. */function parseSettings(raw: string | null): TransportSettings {
  if (raw === null) return { ...DEFAULT_TRANSPORT_SETTINGS };
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { ...DEFAULT_TRANSPORT_SETTINGS }; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_TRANSPORT_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  const mode = decodeRouteMode(record.mode);
  if (mode === null || typeof record.proxyInAuto !== 'boolean') {
    return { ...DEFAULT_TRANSPORT_SETTINGS };
  }
  let proxyUrl: string | null;
  if (record.proxyUrl === undefined || record.proxyUrl === null) proxyUrl = null;
  else if (typeof record.proxyUrl === 'string') proxyUrl = record.proxyUrl;
  else return { ...DEFAULT_TRANSPORT_SETTINGS };
  return { mode, proxyUrl, proxyInAuto: record.proxyInAuto };
}

/** `NativeTransport::new(None, Some(proxy))` proxy validation (native.rs:31-45). */
export function validateProxyUrl(proxy: string): void {
  let parsed: URL;
  try { parsed = new URL(proxy); }
  catch { throw settingsError('代理地址无效'); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname !== '/') {
    throw settingsError('代理需使用无内嵌凭据的 HTTP / HTTPS 地址');
  }
}

/** `session.rs:55-82` settings cache + generation + diagnostics ring. */
export class BiliTransportState {
  private settingsValue: TransportSettings | null = null;
  private generationValue = 1;
  private readonly diagnosticEntries: RequestDiagnostic[] = [];

  private readonly store: TransportSettingsStore;

  constructor(store: TransportSettingsStore) {
    this.store = store;
  }

  settings(): TransportSettings {
    if (this.settingsValue === null) {
      let raw: string | null;
      try { raw = this.store.get(TRANSPORT_SETTINGS_KEY); }
      catch { raw = null; }
      this.settingsValue = parseSettings(raw);
    }
    return { ...this.settingsValue };
  }

  generation(): number {
    return this.generationValue;
  }

  /** `update_settings`：先验证代理，再校验 proxy 模式，最后落盘并更新缓存。 */
  configure(value: TransportSettings): void {
    const proxy = value.proxyUrl !== null && value.proxyUrl !== '' ? value.proxyUrl : null;
    if (proxy !== null) validateProxyUrl(proxy);
    if (value.mode === 'proxy' && proxy === null) {
      throw settingsError('请先配置可信代理地址');
    }
    try {
      this.store.save(TRANSPORT_SETTINGS_KEY, JSON.stringify({
        mode: value.mode,
        proxyUrl: value.proxyUrl,
        proxyInAuto: value.proxyInAuto,
      }));
    } catch {
      throw new BiliRequestError('settings', '保存 B 站出口设置失败');
    }
    this.settingsValue = { ...value };
    this.generationValue += 1;
  }

  diagnostics(): RequestDiagnostic[] {
    return this.diagnosticEntries.map(entry => ({ ...entry }));
  }

  recordDiagnostic(entry: RequestDiagnostic): void {
    if (this.diagnosticEntries.length >= DIAGNOSTIC_LIMIT) this.diagnosticEntries.shift();
    this.diagnosticEntries.push({ ...entry });
  }
}

/** `media_bilibili_transport_status` (bridge_server.rs:486-492). */
export function transportStatus(state: BiliTransportState, hub: BridgeHub): TransportStatus {
  return {
    settings: state.settings(),
    bridge: hub.status(),
    diagnostics: state.diagnostics(),
  };
}
