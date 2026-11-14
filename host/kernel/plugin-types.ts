/**
 * Rust: src/plugins/types.rs. PluginState keeps the snake_case wire encoding from serde.
 */
/** Internal serde_json value; D3 keeps integers exact until the IPC boundary. */
export type PluginJsonValue = null | boolean | number | bigint | string | PluginJsonValue[] | { [key: string]: PluginJsonValue };
type JsonValue = PluginJsonValue;

export type PluginKind = 'channel';

export const PluginState = {
  Stopped: 'stopped',
  Starting: 'starting',
  WaitingLogin: 'waiting_login',
  Running: 'running',
  Stopping: 'stopping',
  Error: 'error',
} as const;
export type PluginState = (typeof PluginState)[keyof typeof PluginState];

/** `PluginState::default()` = Stopped. */
export const DEFAULT_PLUGIN_STATE: PluginState = PluginState.Stopped;

/** `PluginState::can_transition_to` (types.rs:36-61), same pairs and same self-transitions. */
export function canTransitionTo(current: PluginState, next: PluginState): boolean {
  switch (current) {
    case 'stopped':
      return next === 'starting' || next === 'stopped';
    case 'starting':
      return next === 'waiting_login' || next === 'running' || next === 'error' || next === 'stopping';
    case 'waiting_login':
      return next === 'running' || next === 'stopping' || next === 'stopped' || next === 'error' || next === 'starting';
    case 'running':
      return next === 'stopping' || next === 'error' || next === 'waiting_login';
    case 'stopping':
      return next === 'stopped' || next === 'error' || next === 'stopping';
    case 'error':
      return next === 'starting' || next === 'stopping' || next === 'stopped';
  }
}

export interface PluginDescriptor {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  readonly kind: PluginKind;
}

/** serde camelCase (types.rs:72-84). */
export interface PluginInfo {
  id: string;
  label: string;
  blurb: string;
  kind: PluginKind;
  state: PluginState;
  enabled: boolean;
  configured: boolean;
  bound: boolean;
  error: string | null;
}

/** serde camelCase (types.rs:86-100); all optional Rust fields serialize as null. */
export interface PluginStatusSnapshot {
  state: PluginState;
  enabled: boolean;
  configured: boolean;
  bound: boolean;
  loginStatus: string | null;
  accountId: string | null;
  userId: string | null;
  lastError: string | null;
  lastActivity: string | null;
  qrcodePngBase64: string | null;
  qrcodeStatus: string | null;
}

export function emptyStatusSnapshot(): PluginStatusSnapshot {
  return {
    state: DEFAULT_PLUGIN_STATE,
    enabled: false,
    configured: false,
    bound: false,
    loginStatus: null,
    accountId: null,
    userId: null,
    lastError: null,
    lastActivity: null,
    qrcodePngBase64: null,
    qrcodeStatus: null,
  };
}

/** The settings surface PluginManager and the iLink plugin need (F4 implements it on ctx.settings). */
export interface PluginSettings {
  get(key: string): string | null;
  save(key: string, value: string): void;
  delete(key: string): boolean;
  getSecret(key: string): Promise<string | null>;
  saveSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<boolean>;
}

/** Runtime context replacing Rust PluginRuntimeCtx (types.rs:102-126). */
export interface PluginRuntimeContext {
  readonly settings: PluginSettings;
  readonly signal: AbortSignal;
  readonly config: JsonValue;
  readonly desktop: boolean;
}

export interface ChannelPlugin {
  descriptor(): PluginDescriptor;
  isConfigured(config: JsonValue): boolean;
  isBound(settings: PluginSettings): Promise<boolean>;
  run(ctx: PluginRuntimeContext): Promise<void>;
  status(settings: PluginSettings): Promise<PluginStatusSnapshot>;
  getPublicConfig(settings: PluginSettings): Promise<JsonValue>;
  setConfig(settings: PluginSettings, patch: JsonValue): Promise<void>;
  beginLogin(ctx: PluginRuntimeContext): Promise<void>;
  cancelLogin(): Promise<void>;
  logout(settings: PluginSettings): Promise<void>;
}
