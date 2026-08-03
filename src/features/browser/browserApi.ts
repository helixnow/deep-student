/**
 * Browser Tauri command 封装（B2a）
 *
 * 历史权威在 Rust；本层只做 invoke + 载荷归一化。
 * 命令参数扁平 camelCase，与 `cmd/browser.rs` 对齐。
 */
import { invoke } from '@tauri-apps/api/core';

import { assertBrowserGatesOpen, BrowserGateClosedError } from './gates';
import type {
  BrowserCommandName,
  BrowserControlMode,
  BrowserDownloadObservation,
  BrowserHistoryEntry,
  BrowserSessionSnapshot,
  BrowserSurfaceBounds,
  BrowserSurfaceHostMode,
} from './types';

export class BrowserApiError extends Error {
  readonly code: string;
  readonly command: BrowserCommandName | string;

  constructor(command: BrowserCommandName | string, message: string, code = 'BROWSER_API_ERROR') {
    super(message);
    this.name = 'BrowserApiError';
    this.command = command;
    this.code = code;
  }
}

async function ensureGatesOpen(command: BrowserCommandName): Promise<void> {
  try {
    await assertBrowserGatesOpen();
  } catch (err) {
    if (err instanceof BrowserGateClosedError) {
      throw new BrowserApiError(command, err.message, err.code);
    }
    throw err;
  }
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 识别「命令未注册 / 未接线」类错误，给出可展示文案 */
export function isCommandMissingError(err: unknown): boolean {
  const msg = rawMessage(err).toLowerCase();
  return (
    msg.includes('command') &&
    (msg.includes('not found') ||
      msg.includes('not allowed') ||
      msg.includes('does not exist') ||
      msg.includes('unknown') ||
      msg.includes('未找到') ||
      msg.includes('不存在'))
  );
}

export function toBrowserApiError(
  command: BrowserCommandName | string,
  err: unknown,
): BrowserApiError {
  if (err instanceof BrowserApiError) return err;
  const msg = rawMessage(err);
  if (isCommandMissingError(err)) {
    return new BrowserApiError(
      command,
      `浏览器后端命令尚未就绪（${command}）。请确认 workbench 浏览器功能已启用并完成接线。`,
      'BROWSER_COMMAND_MISSING',
    );
  }
  const structuredCode = msg.match(/^([A-Z][A-Z0-9_]+):/)?.[1];
  return new BrowserApiError(
    command,
    msg || `浏览器命令失败：${command}`,
    structuredCode ?? 'BROWSER_API_ERROR',
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function pickBool(obj: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** 归一 ControlMode（Rust enum / camel / snake → 'user' | 'agent'） */
export function parseControlMode(raw: unknown): BrowserControlMode {
  if (typeof raw !== 'string') return 'user';
  const normalized = raw.toLowerCase();
  return normalized === 'agent' ? 'agent' : 'user';
}

/** Fail-safe to detached for older/unknown backend payloads. */
export function parseBrowserSurfaceHostMode(raw: unknown): BrowserSurfaceHostMode {
  if (typeof raw === 'string') {
    const normalized = raw.toLowerCase();
    if (normalized === 'embedded' || normalized === 'unsupported') return normalized;
    return 'detached';
  }
  const obj = asRecord(raw);
  const mode = obj ? pickString(obj, 'hostMode', 'host_mode', 'mode') : undefined;
  const normalized = mode?.toLowerCase();
  if (normalized === 'embedded' || normalized === 'unsupported') return normalized;
  return 'detached';
}

function parseHistoryEntry(raw: unknown): BrowserHistoryEntry | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const url = pickString(obj, 'url');
  if (!url) return null;
  return {
    url,
    title: pickString(obj, 'title') ?? null,
    visitedAt: pickString(obj, 'visitedAt', 'visited_at') ?? null,
    seq: pickNumber(obj, 'seq'),
  };
}

/**
 * 地址栏输入归一：裸域名 / 搜索词补 https://
 * 已有 scheme 的保持原样（由 Rust policy 最终裁决）。
 */
export function normalizeNavigationInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  // localhost / IP / 含点主机名 → https；其余当搜索词也先走 https 主机（一期不做搜索引擎）
  return `https://${trimmed}`;
}

/** 将 Rust DTO（camel / snake；id/url 别名）归一为前端快照 */
export function parseBrowserSessionSnapshot(
  raw: unknown,
  fallback?: Partial<BrowserSessionSnapshot>,
): BrowserSessionSnapshot {
  // get_state 可能返回 null（无活跃 session）
  if (raw == null) {
    return {
      sessionId: fallback?.sessionId ?? null,
      currentUrl: fallback?.currentUrl ?? '',
      title: fallback?.title ?? '',
      canGoBack: fallback?.canGoBack ?? false,
      canGoForward: fallback?.canGoForward ?? false,
      controlMode: fallback?.controlMode ?? 'user',
      loading: fallback?.loading ?? false,
      history: fallback?.history ?? [],
      historyIndex: fallback?.historyIndex ?? -1,
      agentAutomationSupported: fallback?.agentAutomationSupported ?? false,
      error: fallback?.error ?? null,
    };
  }

  const obj = asRecord(raw) ?? {};
  const historyRaw = obj.history;
  const history: BrowserHistoryEntry[] = Array.isArray(historyRaw)
    ? historyRaw.map(parseHistoryEntry).filter((e): e is BrowserHistoryEntry => !!e)
    : (fallback?.history ?? []);

  const sessionId =
    pickString(obj, 'sessionId', 'session_id', 'id') ?? fallback?.sessionId ?? null;

  const controlRaw =
    pickString(obj, 'controlMode', 'control_mode', 'controlOwner', 'control_owner') ??
    // Rust enum 默认 serde 可能是 "User"/"Agent"
    (typeof obj.controlMode === 'string' ? obj.controlMode : undefined) ??
    (typeof obj.control_mode === 'string' ? obj.control_mode : undefined);

  return {
    sessionId: sessionId && sessionId.length > 0 ? sessionId : null,
    currentUrl: pickString(obj, 'currentUrl', 'current_url', 'url') ?? fallback?.currentUrl ?? '',
    title: pickString(obj, 'title', 'currentTitle', 'current_title') ?? fallback?.title ?? '',
    canGoBack: pickBool(obj, 'canGoBack', 'can_go_back') ?? fallback?.canGoBack ?? false,
    canGoForward:
      pickBool(obj, 'canGoForward', 'can_go_forward') ?? fallback?.canGoForward ?? false,
    controlMode: parseControlMode(controlRaw ?? fallback?.controlMode),
    loading: pickBool(obj, 'loading', 'isLoading', 'is_loading') ?? fallback?.loading ?? false,
    history,
    historyIndex:
      pickNumber(obj, 'historyIndex', 'history_index') ?? fallback?.historyIndex ?? -1,
    agentAutomationSupported:
      pickBool(obj, 'agentAutomationSupported', 'agent_automation_supported') ??
      fallback?.agentAutomationSupported ??
      false,
    error: pickString(obj, 'error', 'lastError', 'last_error') ?? fallback?.error ?? null,
  };
}

async function invokeBrowser<T>(
  command: BrowserCommandName,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return args === undefined
      ? await invoke<T>(command)
      : await invoke<T>(command, args);
  } catch (err) {
    throw toBrowserApiError(command, err);
  }
}

async function invokeState(
  command: BrowserCommandName,
  args?: Record<string, unknown>,
): Promise<BrowserSessionSnapshot> {
  const raw = await invokeBrowser<unknown>(command, args);
  return parseBrowserSessionSnapshot(raw);
}

export async function openSession(
  url?: string,
  opts?: { fromAgent?: boolean },
): Promise<BrowserSessionSnapshot> {
  await ensureGatesOpen('browser_open_session');
  const normalized = url ? normalizeNavigationInput(url) : 'https://example.com';
  return invokeState('browser_open_session', {
    url: normalized,
    ...(opts?.fromAgent != null ? { fromAgent: opts.fromAgent } : {}),
  });
}

export async function closeSession(sessionId?: string | null): Promise<void> {
  const args: Record<string, unknown> = {};
  if (sessionId) args.sessionId = sessionId;
  await invokeBrowser('browser_close', args);
}

export async function navigate(
  url: string,
  sessionId: string,
  opts?: { replace?: boolean; fromAgent?: boolean },
): Promise<BrowserSessionSnapshot> {
  await ensureGatesOpen('browser_navigate');
  return invokeState('browser_navigate', {
    sessionId,
    url: normalizeNavigationInput(url),
    ...(opts?.replace != null ? { replace: opts.replace } : {}),
    ...(opts?.fromAgent != null ? { fromAgent: opts.fromAgent } : {}),
  });
}

export async function goBack(sessionId: string): Promise<BrowserSessionSnapshot> {
  return invokeState('browser_back', { sessionId });
}

export async function goForward(sessionId: string): Promise<BrowserSessionSnapshot> {
  return invokeState('browser_forward', { sessionId });
}

export async function reload(sessionId: string): Promise<BrowserSessionSnapshot> {
  return invokeState('browser_reload', { sessionId });
}

export async function getState(sessionId?: string | null): Promise<BrowserSessionSnapshot> {
  const args: Record<string, unknown> = {};
  if (sessionId) args.sessionId = sessionId;
  return invokeState('browser_get_state', args);
}

export async function focusContent(sessionId?: string | null): Promise<void> {
  const args: Record<string, unknown> = {};
  if (sessionId) args.sessionId = sessionId;
  await invokeBrowser('browser_focus', args);
}

/** Return keyboard focus from the embedded native page to the React shell. */
export async function releaseSurfaceFocus(sessionId: string): Promise<void> {
  await invokeBrowser('browser_release_surface_focus', { sessionId });
}

export async function setSurfaceBounds(
  sessionId: string,
  bounds: BrowserSurfaceBounds,
  sequence: number,
): Promise<BrowserSurfaceHostMode> {
  const raw = await invokeBrowser<unknown>('browser_set_surface_bounds', {
    sessionId,
    ...bounds,
    sequence,
  });
  return parseBrowserSurfaceHostMode(raw);
}

export async function setSurfaceVisibility(
  sessionId: string,
  visible: boolean,
  focus = false,
): Promise<BrowserSurfaceHostMode> {
  const raw = await invokeBrowser<unknown>('browser_set_surface_visibility', {
    sessionId,
    visible,
    focus,
  });
  return parseBrowserSurfaceHostMode(raw);
}

export async function getSurfaceHostMode(): Promise<BrowserSurfaceHostMode> {
  const raw = await invokeBrowser<unknown>('browser_get_surface_host_mode');
  return parseBrowserSurfaceHostMode(raw);
}

/** 用户接管：打断 agent 控制态 */
export async function takeOver(): Promise<BrowserSessionSnapshot> {
  return invokeState('browser_take_over');
}

export async function listDownloads(sessionId: string): Promise<BrowserDownloadObservation[]> {
  return invokeBrowser<BrowserDownloadObservation[]>('browser_list_downloads', { sessionId });
}

/** Internal byte bridge; Agent paths are authorized and materialized by Rust executor. */
export async function setInputFiles(
  sessionId: string,
  ref: string,
  files: Array<{ name: string; mimeType: string; base64: string }>,
): Promise<unknown> {
  return invokeBrowser('browser_set_input_files', { sessionId, ref, files });
}

export const browserApi = {
  openSession,
  closeSession,
  navigate,
  goBack,
  goForward,
  reload,
  getState,
  focusContent,
  releaseSurfaceFocus,
  setSurfaceBounds,
  setSurfaceVisibility,
  getSurfaceHostMode,
  takeOver,
  listDownloads,
  setInputFiles,
  normalizeNavigationInput,
  parseBrowserSessionSnapshot,
  parseBrowserSurfaceHostMode,
  isCommandMissingError,
  toBrowserApiError,
  BrowserApiError,
};
