// Port of the pure parts of dstu-browser/src/browser/service.rs: settings gates,
// surface geometry/occlusion math, trusted input, navigation rollback and downloads.
// BrowserService itself needs the native window/database stack and is not constructed.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { decodeDownloadHashResult, hashDownloadFileBoundedCore, type DownloadHashResult } from './download-hash.ts';
import type { BrowserError } from './command-result.ts';
import { BROWSER_CONTENT_LABEL, BrowserSession, type BrowserSessionState } from './session.ts';

export const SETTING_WORKBENCH_MODE = 'desktop.workbenchMode';
export const SETTING_BROWSER_ENABLED = 'desktop.workbenchBrowserEnabled';
export const SETTING_BROWSER_NETWORK_MODE = 'desktop.workbenchBrowserNetworkMode';
export const FLAG_UI_WORKBENCH_BROWSER = 'ui.workbench_browser';

export const TRUSTED_CONTENT_INPUT_KINDS: readonly string[] = [
  'pointerdown', 'keydown', 'compositionstart', 'wheel',
];
export const MAX_SURFACE_OCCLUSIONS = 64;
export const MAX_DOWNLOAD_OBSERVATIONS = 100;
export const MAX_BROWSER_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_BROWSER_TASK_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export type BrowserDownloadState = 'started' | 'processing' | 'completed' | 'failed';

export interface BrowserDownloadObservation {
  id: string;
  browserSessionId: string;
  chatSessionId: string;
  url: string;
  filename: string;
  state: BrowserDownloadState;
  rootId: string;
  relativePath: string;
  locator: string;
  sha256: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  objectHandle: unknown | null;
}

export function isTruthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Parent gate: missing/empty/invalid stays enabled; only a trimmed "false" closes. */
export function isWorkbenchModeEnabled(raw: string | null): boolean {
  return raw === null || raw.trim() !== 'false';
}

/** Child gate: explicit opt-in only. */
export function isBrowserChildGateEnabled(raw: string | null): boolean {
  return raw === null ? false : isTruthy(raw);
}

export function assertSettingsGatesOpen(
  workbenchRaw: string | null, browserRaw: string | null,
): string | null {
  if (!isWorkbenchModeEnabled(workbenchRaw)) return 'browser disabled: desktop.workbenchMode is off';
  if (!isBrowserChildGateEnabled(browserRaw)) return 'browser disabled: desktop.workbenchBrowserEnabled is off';
  return null;
}

export function effectiveAllowInsecureHttp(networkModeFull: boolean, agentControl: boolean): boolean {
  return !agentControl || networkModeFull;
}

export function contentLabel(): string {
  return BROWSER_CONTENT_LABEL;
}

export interface SurfaceCssBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}
export interface SurfaceCssOcclusion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PhysicalViewport {
  width: number;
  height: number;
}
export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SurfaceResult<T> = { ok: true; value: T } | { ok: false; error: BrowserError };

function validation(message: string): { ok: false; error: BrowserError } {
  return { ok: false, error: { kind: 'Validation', message } };
}
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/** `physical_surface_bounds`: CSS coordinates -> outward-rounded physical pixels. */
export function physicalSurfaceBounds(
  css: SurfaceCssBounds, physicalViewport: PhysicalViewport,
): SurfaceResult<PhysicalRect> {
  const values: [string, number][] = [
    ['x', css.x], ['y', css.y], ['width', css.width], ['height', css.height],
    ['viewportWidth', css.viewportWidth], ['viewportHeight', css.viewportHeight],
  ];
  for (const [name, value] of values) {
    if (!Number.isFinite(value)) return validation(`browser surface ${name} must be finite`);
  }
  if (css.width <= 0 || css.height <= 0 || css.viewportWidth <= 0 || css.viewportHeight <= 0) {
    return validation('browser surface and viewport dimensions must be positive');
  }
  if (physicalViewport.width === 0 || physicalViewport.height === 0) {
    return validation('main window has an empty physical viewport');
  }

  const rightCss = css.x + css.width;
  const bottomCss = css.y + css.height;
  if (!Number.isFinite(rightCss) || !Number.isFinite(bottomCss)) {
    return validation('browser surface rectangle overflowed');
  }
  if (rightCss <= 0 || css.x >= css.viewportWidth || bottomCss <= 0 || css.y >= css.viewportHeight) {
    return validation('browser surface rectangle must intersect the viewport');
  }

  const scaleX = physicalViewport.width / css.viewportWidth;
  const scaleY = physicalViewport.height / css.viewportHeight;
  const edges: [string, number][] = [
    ['left', Math.floor(css.x * scaleX)],
    ['top', Math.floor(css.y * scaleY)],
    ['right', Math.ceil(rightCss * scaleX)],
    ['bottom', Math.ceil(bottomCss * scaleY)],
  ];
  for (const [name, value] of edges) {
    if (!Number.isFinite(value) || value < I32_MIN || value > I32_MAX) {
      return validation(`browser surface physical ${name} edge is outside the supported range`);
    }
  }
  const left = edges[0]![1];
  const top = edges[1]![1];
  const right = edges[2]![1];
  const bottom = edges[3]![1];
  const physicalWidth = right - left;
  const physicalHeight = bottom - top;
  if (physicalWidth <= 0 || physicalHeight <= 0) {
    return validation('browser surface collapsed after physical scaling');
  }
  if (physicalWidth > I32_MAX || physicalHeight > I32_MAX) {
    return validation('browser surface physical dimensions are too large');
  }
  return { ok: true, value: { x: left, y: top, width: physicalWidth, height: physicalHeight } };
}

interface PhysicalOcclusionBounds { left: number; top: number; right: number; bottom: number }

function boundsFromRect(rect: PhysicalRect): SurfaceResult<PhysicalOcclusionBounds> {
  const left = rect.x;
  const top = rect.y;
  const right = left + rect.width;
  const bottom = top + rect.height;
  if (right <= left || bottom <= top) {
    return validation('browser surface occlusion collapsed after physical scaling');
  }
  return { ok: true, value: { left, top, right, bottom } };
}

function boundsIntoRect(bounds: PhysicalOcclusionBounds): SurfaceResult<PhysicalRect> {
  if (bounds.left < I32_MIN || bounds.left > I32_MAX) {
    return validation('browser surface occlusion x is too large');
  }
  if (bounds.top < I32_MIN || bounds.top > I32_MAX) {
    return validation('browser surface occlusion y is too large');
  }
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width < 0 || width > 4294967295) {
    return validation('browser surface occlusion width is too large');
  }
  if (height < 0 || height > 4294967295) {
    return validation('browser surface occlusion height is too large');
  }
  return { ok: true, value: { x: bounds.left, y: bounds.top, width, height } };
}

/** Merge rects after outward rounding (macOS uses an even-odd shape mask). */
export function unionPhysicalSurfaceOcclusions(rects: readonly PhysicalRect[]): SurfaceResult<PhysicalRect[]> {
  if (rects.length < 2) return { ok: true, value: rects.map(rect => ({ ...rect })) };
  const converted: PhysicalOcclusionBounds[] = [];
  for (const rect of rects) {
    const bounds = boundsFromRect(rect);
    if (!bounds.ok) return bounds;
    converted.push(bounds.value);
  }
  const yEdges = [...new Set(converted.flatMap(rect => [rect.top, rect.bottom]))].sort((a, b) => a - b);
  const rows: PhysicalOcclusionBounds[] = [];
  for (let index = 0; index + 1 < yEdges.length; index += 1) {
    const top = yEdges[index]!;
    const bottom = yEdges[index + 1]!;
    if (bottom <= top) continue;
    const intervals = converted
      .filter(rect => rect.top < bottom && rect.bottom > top)
      .map(rect => [rect.left, rect.right] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: [number, number][] = [];
    for (const [left, right] of intervals) {
      const previous = merged[merged.length - 1];
      if (previous !== undefined && left <= previous[1]) {
        previous[1] = Math.max(previous[1], right);
        continue;
      }
      merged.push([left, right]);
    }
    for (const [left, right] of merged) rows.push({ left, top, right, bottom });
  }

  const union: PhysicalOcclusionBounds[] = [];
  for (const row of rows) {
    const previous = union[union.length - 1];
    if (previous !== undefined && previous.left === row.left && previous.right === row.right
      && previous.bottom === row.top) {
      previous.bottom = row.bottom;
      continue;
    }
    union.push(row);
  }
  const output: PhysicalRect[] = [];
  for (const bounds of union) {
    const rect = boundsIntoRect(bounds);
    if (!rect.ok) return rect;
    output.push(rect.value);
  }
  return { ok: true, value: output };
}

/** `physical_surface_occlusions`: clip CSS rects to the viewport, then map and merge. */
export function physicalSurfaceOcclusions(
  occlusions: readonly SurfaceCssOcclusion[],
  viewportWidth: number, viewportHeight: number, physicalViewport: PhysicalViewport,
): SurfaceResult<PhysicalRect[]> {
  if (occlusions.length > MAX_SURFACE_OCCLUSIONS) {
    return validation(`browser surface has too many occlusion rectangles (maximum ${MAX_SURFACE_OCCLUSIONS})`);
  }
  const result: PhysicalRect[] = [];
  for (let index = 0; index < occlusions.length; index += 1) {
    const occlusion = occlusions[index]!;
    const values: [string, number][] = [
      ['x', occlusion.x], ['y', occlusion.y], ['width', occlusion.width], ['height', occlusion.height],
    ];
    for (const [name, value] of values) {
      if (!Number.isFinite(value)) {
        return validation(`browser surface occlusion ${index} ${name} must be finite`);
      }
    }
    if (occlusion.width <= 0 || occlusion.height <= 0) {
      return validation(`browser surface occlusion ${index} dimensions must be positive`);
    }
    const rightRaw = occlusion.x + occlusion.width;
    const bottomRaw = occlusion.y + occlusion.height;
    if (!Number.isFinite(rightRaw) || !Number.isFinite(bottomRaw)) {
      return validation(`browser surface occlusion ${index} overflowed`);
    }
    const left = Math.max(occlusion.x, 0);
    const top = Math.max(occlusion.y, 0);
    const right = Math.min(rightRaw, viewportWidth);
    const bottom = Math.min(bottomRaw, viewportHeight);
    if (right <= left || bottom <= top) continue;
    const mapped = physicalSurfaceBounds({
      x: left, y: top, width: right - left, height: bottom - top,
      viewportWidth, viewportHeight,
    }, physicalViewport);
    if (!mapped.ok) return mapped;
    result.push(mapped.value);
  }
  return unionPhysicalSurfaceOcclusions(result);
}

/** `require_live_surface_session`. */
export function requireLiveSurfaceSession(
  active: BrowserSession | null, sessionId: string,
): SurfaceResult<BrowserSession> {
  if (active === null || !active.alive || active.id !== sessionId) {
    return { ok: false, error: { kind: 'NotFound', message: `session ${sessionId}` } };
  }
  return { ok: true, value: active };
}

export class TrustedContentInputCapability {
  readonly sessionId: string;
  private readonly nonce: Buffer;

  constructor(sessionId: string, nonce: Buffer) {
    this.sessionId = sessionId;
    this.nonce = nonce;
  }

  static generate(sessionId: string): TrustedContentInputCapability {
    return new TrustedContentInputCapability(sessionId, randomBytes(16));
  }

  encodedNonce(): string {
    return this.nonce.toString('hex');
  }

  matches(sessionId: string, encodedNonce: string): boolean {
    if (this.sessionId !== sessionId) return false;
    if (!/^[0-9a-fA-F]{32}$/.test(encodedNonce)) return false;
    const candidate = Buffer.from(encodedNonce, 'hex');
    return candidate.length === 16 && timingSafeEqual(this.nonce, candidate);
  }
}

export interface BlockedNavigation { url: string; reason: string }
export type PendingNavigationKind = 'push' | 'replace';

export class PendingNavigation {
  readonly id: number;
  readonly sessionId: string;
  readonly rollback: BrowserSession;
  readonly kind: PendingNavigationKind;
  blocked: BlockedNavigation | null;

  constructor(
    id: number, sessionId: string, rollback: BrowserSession, kind: PendingNavigationKind,
    blocked: BlockedNavigation | null = null,
  ) {
    this.id = id;
    this.sessionId = sessionId;
    this.rollback = rollback;
    this.kind = kind;
    this.blocked = blocked;
  }

  markBlocked(url: string, reason: string): void {
    if (this.blocked === null) this.blocked = { url, reason };
  }
}

export type NavigationApplyResult =
  | { ok: true; value: BrowserSessionState }
  | { ok: false; blocked: BlockedNavigation };

export function applyPendingNavigation(
  session: BrowserSession, attempt: PendingNavigation, url: string, replace: boolean,
): NavigationApplyResult {
  if (attempt.blocked !== null) return { ok: false, blocked: attempt.blocked };
  if (replace) session.replaceUrl(url);
  else session.pushUrl(url);
  return { ok: true, value: session.snapshot() };
}

export function rollbackPendingNavigation(session: BrowserSession, attempt: PendingNavigation): void {
  session.restoreFrom(attempt.rollback);
  session.markLoaded();
}

export function sanitizeDownloadFilename(raw: string): string {
  const sanitized = [...raw].map(character => {
    if (character === '/' || character === '\\' || character === ':' || character === '\0') return '_';
    if (/\p{Cc}/u.test(character)) return '_';
    return character;
  }).slice(0, 180).join('');
  const trimmed = sanitized.replace(/^[.\p{White_Space}]+|[.\p{White_Space}]+$/gu, '');
  return trimmed === '' ? 'download.bin' : trimmed;
}

export function updateReusedDownloadOwner(
  session: BrowserSession, fromAgent: boolean, chatSessionId: string | null,
): void {
  session.chatSessionId = fromAgent ? chatSessionId : null;
  session.updatedAt = new Date();
}

export type DownloadOwnerResult = { ok: true; owner: string | null } | { ok: false };

export function downloadOwnerForSession(
  session: BrowserSession | null, browserSessionId: string,
): DownloadOwnerResult {
  if (session === null || !session.alive || session.id !== browserSessionId) return { ok: false };
  if (session.controlMode === 'agent') {
    return session.chatSessionId === null ? { ok: false } : { ok: true, owner: session.chatSessionId };
  }
  return { ok: true, owner: null };
}

export function taskDownloadBudgetAvailable(completedBytes: number, reservedBytes: number): boolean {
  return completedBytes + reservedBytes + MAX_BROWSER_DOWNLOAD_BYTES <= MAX_BROWSER_TASK_DOWNLOAD_BYTES;
}

export function releaseTaskDownloadReservation(reservations: Map<string, number>, taskId: string): void {
  const reserved = reservations.get(taskId);
  if (reserved === undefined) return;
  const next = Math.max(reserved - MAX_BROWSER_DOWNLOAD_BYTES, 0);
  if (next === 0) reservations.delete(taskId);
  else reservations.set(taskId, next);
}

export type { DownloadHashResult } from './download-hash.ts';

/** service.rs:1499-1510: dedicated thread, with the original explicit inline fallback. */
export function hashDownloadFileBounded(
  path: string, maxBytes: number, warn?: (message: string) => void,
): DownloadHashResult | Promise<DownloadHashResult> {
  const fallback = (error: unknown): DownloadHashResult => {
    warn?.(`[browser] download hash worker unavailable; hashing inline: ${error instanceof Error ? error.message : String(error)}`);
    return hashDownloadFileBoundedCore(path, maxBytes);
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL('./download-hash-worker.ts', import.meta.url), {
      name: 'browser-download-hash', workerData: { path, maxBytes },
    });
  } catch (error) { return fallback(error); }
  let result: DownloadHashResult | null = null;
  let failure: Error | undefined;
  return new Promise<DownloadHashResult>(resolve => {
    worker.once('message', (message: unknown) => { result = decodeDownloadHashResult(message); });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => {
      if (failure !== undefined || code !== 0 || result === null) {
        resolve(fallback(failure ?? new Error(`download hash worker exited with code ${code} without a result`)));
      } else resolve(result);
    });
  });
}
