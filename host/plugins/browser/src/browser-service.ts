// Port of dstu-browser/src/browser/service.rs runtime state machine.
// Native WebView creation/eval stays behind BrowserSurfaceHost (F2); every policy,
// session, history, download and event transition lives here.

import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import type {
  BrowserDownloadObservation, BrowserSessionState,
} from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import type { BrowserSurfaceHost, BrowserSurfaceCreateOptions } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { BrowserDatabase } from './database.ts';
import { BrowserFailure } from './error.ts';
import { bridgeErrorMessage, mapBrowserError, type BrowserError, type JsonValue } from './command-result.ts';
import {
  BrowserSession, BROWSER_CONTENT_LABEL, MAX_HISTORY, USER_TAKEOVER_BLOCK_SECS,
} from './session.ts';
import { formatTimestamp, nowTimestamp } from './time.ts';
import {
  maskSignatureFromBoundsAndOcclusions, maskSignaturesEqual,
  type LogicalRect, type MaskSignature,
} from './macos-surface-clip.ts';
import {
  NavigationPolicyHandle, defaultProfileDir, surfaceHostMode,
  DEFAULT_HEIGHT, DEFAULT_WIDTH, type AgentHostResolver,
} from './window-policy.ts';
import {
  FLAG_UI_WORKBENCH_BROWSER, SETTING_BROWSER_ENABLED, SETTING_BROWSER_NETWORK_MODE,
  SETTING_WORKBENCH_MODE, type SurfaceCssOcclusion,
  applyPendingNavigation, assertSettingsGatesOpen, contentLabel,
  isBrowserChildGateEnabled, physicalSurfaceBounds, physicalSurfaceOcclusions,
  PendingNavigation as NavigationAttempt, rollbackPendingNavigation, updateReusedDownloadOwner,
} from './service.ts';
import { DownloadRuntime } from './download-runtime.ts';
import { initScriptForSession } from './bridge.ts';
import { allowNavigationWithOptions, navigationDenyMessage } from './policy.ts';
import {
  closeSession as closeSessionRow, getSetting, pushHistory, updateCurrentHistory,
  upsertSession as upsertSessionRow,
} from '../repository/index.ts';
import { readSettingOrNone } from './settings.ts';

const DEFAULT_PROFILE_ID = 'default';

export type BrowserPlatform = 'darwin' | 'win32' | 'linux';

/** F3 `featureFlags` service, narrowed to the gate this lane needs. */
export interface BrowserFeatureFlagGate {
  isEnabled(featureName: string): boolean;
}

export interface BrowserServiceOptions {
  db: BrowserDatabase;
  settings: SettingsStore;
  surface: BrowserSurfaceHost | null;
  platform: BrowserPlatform;
  /** Published F3 feature-flag service; this lane must not build its own manager. */
  featureFlags: BrowserFeatureFlagGate;
  emit(event: string, payload: unknown): void;
  /** Rust `warn!`/`info!`; never alters command results. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  resolver?: AgentHostResolver | null;
  /** Artifact root resolver (chat runtime). Downloads stay user-owned while null. */
  artifactRoot?: ((chatSessionId: string) => Promise<string>) | null;
  now?: () => Date;
}

function asBrowserError(error: unknown): BrowserError {
  if (error instanceof BrowserFailure) return error.error;
  return { kind: 'Validation', message: error instanceof Error ? error.message : String(error) };
}

function surfaceErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** window.rs results surface as `.map_err(BrowserError::Validation)` (optionally with a context prefix). */
async function surfaceOp<T>(operation: () => Promise<T>, prefix = ''): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof BrowserFailure) throw error;
    throw validation(`${prefix}${surfaceErrorText(error)}`);
  }
}

/** Rust `let _ = window::...`: the result is discarded. */
async function ignoreSurfaceError(operation: () => Promise<unknown>): Promise<void> {
  // boundary-allow empty-catch: Rust discards this window result with `let _ =`
  try { await operation(); } catch { /* discarded like Rust `let _ =` */ }
}

function validation(message: string): BrowserFailure {
  return new BrowserFailure({ kind: 'Validation', message });
}

function notFound(message: string): BrowserFailure {
  return new BrowserFailure({ kind: 'NotFound', message });
}

function eventAt(now: () => Date): string {
  return formatTimestamp(now());
}

export class BrowserRuntimeService {
  private readonly db: BrowserDatabase;
  private readonly settings: SettingsStore;
  private readonly surface: BrowserSurfaceHost | null;
  private readonly platform: BrowserPlatform;
  private readonly featureFlags: BrowserFeatureFlagGate;
  private readonly emitRaw: (event: string, payload: unknown) => void;
  private readonly logLine: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly now: () => Date;
  private readonly policy: NavigationPolicyHandle;
  private session: BrowserSession | null = null;
  private trustedInput: { sessionId: string; nonce: Buffer } | null = null;
  private pending: NavigationAttempt | null = null;
  private navigationSequence = 0;
  private surfaceSequence: number | null = null;
  private surfaceMaskSignature: MaskSignature | null = null;
  private surfaceInputOcclusions: readonly LogicalRect[] | null = null;
  private readonly downloads: DownloadRuntime;
  private unsubscribe: (() => void) | null = null;

  constructor(options: BrowserServiceOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.surface = options.surface;
    this.platform = options.platform;
    this.featureFlags = options.featureFlags;
    this.emitRaw = options.emit;
    this.logLine = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.downloads = new DownloadRuntime({
      artifactRoot: options.artifactRoot ?? null,
      now: this.now,
      logWarn: message => { this.logWarn(message); },
      createDirAll: path => { mkdirSync(path, { recursive: true }); },
      removeFile: path => { unlinkSync(path); },
    });
    const surface = options.surface;
    const shellResolver = surface?.resolveAgentHost === undefined
      ? null
      : (host: string, port: number) => surface.resolveAgentHost!(host, port);
    this.policy = new NavigationPolicyHandle(options.resolver ?? shellResolver);
    if (surface?.setAgentNavigationPolicy !== undefined) {
      // Shell requests are posted in call order, so the native guard is updated before the navigation that follows.
      this.policy.observe((policy) => {
        void surface.setAgentNavigationPolicy!(policy).catch((error: unknown) => {
          this.logWarn(`[browser] failed to update the native agent navigation policy: ${String(error)}`);
        });
      });
    }
  }

  /** Subscribe native callbacks when the surface appears after construction. */
  attachSurface(surface: BrowserSurfaceHost): void {
    this.unsubscribe?.();
    this.unsubscribe = surface.subscribe({
      pageFinished: url => { void this.onPageFinished(url); },
      titleChanged: (title, url) => { void this.onTitleChanged(title, url); },
      navigationBlocked: (url, reason) => { void this.onNavigationBlocked(url, reason); },
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  syncNetworkModeValue(value: string): void {
    this.policy.setAgentAllowInsecureHttp(value.trim().toLowerCase() === 'full');
  }

  private gatesOpen(): boolean {
    return assertSettingsGatesOpen(
      readSettingOrNone(this.settings, SETTING_WORKBENCH_MODE),
      readSettingOrNone(this.settings, SETTING_BROWSER_ENABLED),
    ) === null && this.featureFlags.isEnabled(FLAG_UI_WORKBENCH_BROWSER);
  }

  async assertGatesOpen(): Promise<void> {
    const message = assertSettingsGatesOpen(
      readSettingOrNone(this.settings, SETTING_WORKBENCH_MODE),
      readSettingOrNone(this.settings, SETTING_BROWSER_ENABLED),
    );
    if (message !== null) await this.rejectClosedGate(message);
    if (!this.featureFlags.isEnabled(FLAG_UI_WORKBENCH_BROWSER)) {
      await this.rejectClosedGate('browser disabled: feature flag ui.workbench_browser is off');
    }
  }

  private async rejectClosedGate(message: string): Promise<never> {
    const surface = this.surface;
    if (surface !== null && surface.hasContentWindow()) {
      await ignoreSurfaceError(() => surface.setContentVisibility(false, false));
    }
    try { await this.closeSessionInner('gates_closed'); }
    catch (error) { this.logWarn(`[browser] gate-close cleanup failed: ${String(error)}`); }
    throw validation(message);
  }

  agentAutomationSupported(): boolean {
    return this.platform === 'darwin' || this.platform === 'win32';
  }

  private ensureAgentAutomationSupported(): void {
    if (!this.agentAutomationSupported()) {
      throw validation('browser agent automation unsupported: result bridge is available on Windows and macOS only');
    }
  }

  private allowInsecureHttp(): boolean {
    const raw = readSettingOrNone(this.settings, SETTING_BROWSER_NETWORK_MODE);
    const allow = raw !== null && raw.trim().toLowerCase() === 'full';
    this.syncNetworkModeValue(allow ? 'full' : 'local_whitelist');
    return allow;
  }

  activeDir(): string {
    return this.db.activeDir();
  }

  surfaceHostMode(): string {
    return surfaceHostMode(this.platform);
  }

  async openSession(options: {
    url: string; displayName?: string | null; chatSessionId?: string | null;
    width?: number | null; height?: number | null; focused?: boolean | null;
    reuseExisting?: boolean | null; fromAgent?: boolean | null;
  }): Promise<BrowserSessionState> {
    await this.assertGatesOpen();
    const allowHttp = this.allowInsecureHttp();
    const fromAgent = options.fromAgent ?? false;
    if (fromAgent) this.ensureAgentAutomationSupported();
    await this.checkNavigationUrl(options.url, allowHttp, fromAgent);
    this.db.ensureOpen();

    const reuse = options.reuseExisting ?? true;
    if (reuse && this.session !== null && this.session.alive && this.surface !== null
      && this.surface.hasContentWindow()) {
      const id = this.session.id;
      updateReusedDownloadOwner(this.session, fromAgent, options.chatSessionId ?? null);
      if (fromAgent) this.setAgentControl();
      else {
        this.policy.setAgentPrivateNetworkGuard(false);
        if (this.session.controlMode === 'agent') this.takeOverWithReason('user_navigation');
      }
      const state = await this.navigateInner(id, options.url, true);
      if (this.surfaceHostMode() === 'detached') await this.focus(id);
      return state;
    }

    if (this.session !== null) await ignoreSurfaceError(() => this.closeSessionInner('replaced'));
    const staleSurface = this.surface;
    if (staleSurface !== null && staleSurface.hasContentWindow()) {
      await ignoreSurfaceError(() => staleSurface.destroyContentWindow());
    }

    let parsed: URL;
    try { parsed = new URL(options.url); }
    catch (error) {
      throw validation(`invalid URL: ${error instanceof Error ? error.message : String(error)}`);
    }

    const profileDir = defaultProfileDir(this.db.activeDir());
    const sessionId = `bs_${randomUUID()}`;
    const nonce = Buffer.from(randomUUID().replace(/-/g, ''), 'hex').subarray(0, 16);
    const boundScript = initScriptForSession(sessionId, nonce.toString('hex'));
    if (!boundScript.ok) throw validation(bridgeErrorMessage(boundScript.error));
    const initializationScript = boundScript.value;
    const width = options.width ?? DEFAULT_WIDTH;
    const height = options.height ?? DEFAULT_HEIGHT;
    const focused = options.focused ?? true;
    const title = options.displayName ?? 'Browser';

    const session = new BrowserSession(
      sessionId, options.url, profileDir,
      fromAgent ? options.chatSessionId ?? null : null,
      options.displayName ?? null, this.now(),
    );

    try {
      upsertSessionRow(this.db, {
        id: sessionId,
        profileId: DEFAULT_PROFILE_ID,
        title,
        currentUrl: options.url,
        faviconUrl: null,
        userAgentOverride: null,
        historyIndex: -1,
        isActive: true,
        lastFocusedAt: nowTimestamp(this.now),
      });
    } catch (error) { this.logWarn(`[browser] upsert_session failed (non-fatal): ${String(error)}`); }
    try {
      pushHistory(this.db, sessionId, {
        url: options.url, title: null, transition: 'typed', typed: true,
      });
    } catch (error) { this.logWarn(`[browser] push_history failed (non-fatal): ${String(error)}`); }

    this.policy.setAgentPrivateNetworkGuard(fromAgent);
    if (this.surface === null) throw validation(`window ${BROWSER_CONTENT_LABEL} is unavailable`);
    const createOptions: BrowserSurfaceCreateOptions = {
      url: parsed.toString(), title, width, height, focused, profileDir,
      initializationScript,
    };
    const surface = this.surface;
    await surfaceOp(() => surface.createContentWindow(createOptions));
    if (surface.waitForReady !== undefined) await surfaceOp(() => surface.waitForReady!());
    this.attachSurface(this.surface);

    this.surfaceSequence = null;
    this.surfaceMaskSignature = null;
    this.surfaceInputOcclusions = null;
    this.trustedInput = { sessionId, nonce };
    this.session = session;

    const state = fromAgent ? this.setAgentControl() : this.snapshotOf(session);
    this.emitEvent('browser:navigated', {
      sessionId: state.id, label: state.label, url: state.url, title: state.title,
      canGoBack: state.canGoBack, canGoForward: state.canGoForward,
      loading: state.loading, at: eventAt(this.now),
    });
    return state;
  }

  async closeSession(): Promise<void> {
    await this.closeSessionInner('service');
  }

  private async closeSessionInner(reason: string): Promise<void> {
    this.policy.setAgentPrivateNetworkGuard(false);
    this.surfaceSequence = null;
    this.surfaceMaskSignature = null;
    this.surfaceInputOcclusions = null;
    this.pending = null;
    const session = this.session;
    this.trustedInput = null;
    this.session = null;
    const surface = this.surface;
    if (session === null) {
      if (surface !== null) await this.destroySurface(surface);
      return;
    }
    session.markClosed(this.now());
    if (this.db.isOpen()) {
      try { closeSessionRow(this.db, session.id); }
      catch (error) { this.logWarn(`[browser] close_session db: ${String(error)}`); }
    }
    let destroyError: BrowserFailure | null = null;
    if (surface !== null) {
      try { await this.destroySurface(surface); }
      catch (error) { destroyError = error instanceof BrowserFailure ? error : validation(surfaceErrorText(error)); }
    }
    this.emitEvent('browser:closed', {
      sessionId: session.id, label: BROWSER_CONTENT_LABEL, reason, at: eventAt(this.now),
    });
    if (destroyError !== null) throw destroyError;
  }

  private async destroySurface(surface: BrowserSurfaceHost): Promise<void> {
    const destroyed = await surfaceOp(() => surface.destroyContentWindow());
    if (!destroyed) throw validation('destroy content window failed');
  }

  async navigate(
    sessionId: string, url: string, replace: boolean, fromAgent: boolean,
  ): Promise<BrowserSessionState> {
    await this.assertGatesOpen();
    if (fromAgent) {
      this.ensureAgentAutomationSupported();
      await this.checkNavigationUrl(url, this.allowInsecureHttp(), true);
      this.setAgentControl();
    } else {
      this.policy.setAgentPrivateNetworkGuard(false);
      if (this.session !== null && this.session.controlMode === 'agent') {
        this.takeOverWithReason('user_navigation');
      }
      await this.checkNavigationUrl(url, this.allowInsecureHttp(), false);
    }
    return this.navigateInner(sessionId, url, replace);
  }

  private async navigateInner(
    sessionId: string, url: string, replace: boolean,
  ): Promise<BrowserSessionState> {
    try { new URL(url); }
    catch (error) {
      throw validation(`invalid URL: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.surface === null || !this.surface.hasContentWindow()) {
      throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    }
    this.cancelPendingNavigation(sessionId);
    const session = this.requireSession(sessionId);
    const attempt = new NavigationAttempt(
      this.nextNavigationId(), sessionId, session.clone(), replace ? 'replace' : 'push',
    );
    this.pending = attempt;
    try { await this.surface.navigate(url); }
    catch (error) {
      this.clearNavigation(attempt.id);
      throw validation(`navigate failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const applied = applyPendingNavigation(session, attempt, url, replace);
    if (!applied.ok) {
      throw validation(`navigation_blocked: ${applied.blocked.reason}`);
    }
    this.emitEvent('browser:navigated', {
      sessionId: applied.value.id, label: applied.value.label, url: applied.value.url,
      title: applied.value.title, canGoBack: applied.value.canGoBack,
      canGoForward: applied.value.canGoForward, loading: applied.value.loading,
      at: eventAt(this.now),
    });
    return applied.value;
  }

  async back(sessionId: string): Promise<BrowserSessionState> {
    await this.assertGatesOpen();
    this.cancelPendingNavigation(sessionId);
    const allowHttp = this.allowInsecureHttp();
    if (this.surface === null || !this.surface.hasContentWindow()) {
      throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    }
    const session = this.requireSession(sessionId);
    if (!session.canGoBack()) throw validation('cannot go back');
    const target = session.history[session.historyIndex - 1]!.url;
    await this.checkNavigationUrl(target, allowHttp, session.controlMode === 'agent');
    const surface = this.surface;
    await surfaceOp(() => surface.goBack(), 'navigate failed: ');
    const url = session.goBack(this.now());
    if (url === null) throw validation('cannot go back');
    return this.persistHistoryNavigation(url, this.snapshotOf(session));
  }

  async forward(sessionId: string): Promise<BrowserSessionState> {
    await this.assertGatesOpen();
    this.cancelPendingNavigation(sessionId);
    const allowHttp = this.allowInsecureHttp();
    if (this.surface === null || !this.surface.hasContentWindow()) {
      throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    }
    const session = this.requireSession(sessionId);
    if (!session.canGoForward()) throw validation('cannot go forward');
    const target = session.history[session.historyIndex + 1]!.url;
    await this.checkNavigationUrl(target, allowHttp, session.controlMode === 'agent');
    const surface = this.surface;
    await surfaceOp(() => surface.goForward(), 'navigate failed: ');
    const url = session.goForward(this.now());
    if (url === null) throw validation('cannot go forward');
    return this.persistHistoryNavigation(url, this.snapshotOf(session));
  }

  private persistHistoryNavigation(url: string, state: BrowserSessionState): BrowserSessionState {
    if (this.db.isOpen()) {
      try {
        upsertSessionRow(this.db, {
          id: state.id, profileId: null, title: state.title, currentUrl: url,
          faviconUrl: null, userAgentOverride: null, historyIndex: state.historyIndex,
          isActive: true, lastFocusedAt: null,
        });
      } catch (error) { this.logWarn(`[browser] persist history navigation failed: ${String(error)}`); }
    }
    this.emitEvent('browser:navigated', {
      sessionId: state.id, label: state.label, url: state.url, title: state.title,
      canGoBack: state.canGoBack, canGoForward: state.canGoForward,
      loading: state.loading, at: eventAt(this.now),
    });
    return state;
  }

  async reload(sessionId: string): Promise<BrowserSessionState> {
    await this.assertGatesOpen();
    this.cancelPendingNavigation(sessionId);
    const allowHttp = this.allowInsecureHttp();
    if (this.surface === null || !this.surface.hasContentWindow()) {
      throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    }
    const session = this.requireSession(sessionId);
    await this.checkNavigationUrl(session.url, allowHttp, session.controlMode === 'agent');
    const surface = this.surface;
    await surfaceOp(() => surface.reload(), 'reload failed: ');
    session.loading = true;
    session.updatedAt = this.now();
    const state = this.snapshotOf(session);
    this.emitEvent('browser:navigated', {
      sessionId: state.id, label: state.label, url: state.url, title: state.title,
      canGoBack: state.canGoBack, canGoForward: state.canGoForward,
      loading: true, at: eventAt(this.now),
    });
    return state;
  }

  async focus(sessionId: string): Promise<void> {
    this.requireLiveSurfaceSession(sessionId);
    const mode = this.surfaceHostMode();
    if (mode === 'detached') {
      if (this.surface === null) throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
      const surface = this.surface;
      await surfaceOp(() => surface.focusContentWindow());
      return;
    }
    if (mode === 'embedded') return;
    throw validation('browser content focus unsupported on this platform');
  }

  async releaseSurfaceFocus(sessionId: string): Promise<void> {
    this.requireLiveSurfaceSession(sessionId);
    const surface = this.surface;
    if (this.surfaceHostMode() === 'embedded' && surface !== null) {
      await surfaceOp(() => surface.releaseContentFocus());
    }
  }

  async setSurfaceBounds(
    sessionId: string, x: number, y: number, width: number, height: number,
    viewportWidth: number, viewportHeight: number,
    occlusions: SurfaceCssOcclusion[], inputOcclusions: SurfaceCssOcclusion[], sequence: number,
  ): Promise<string> {
    this.requireLiveSurfaceSession(sessionId);
    if (this.surfaceHostMode() === 'detached') return 'detached';
    if (this.surface === null) throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    const surface = this.surface;
    const inner = await surfaceOp(() => surface.mainViewportSize(), 'main window size failed: ');
    const bounds = physicalSurfaceBounds({
      x, y, width, height, viewportWidth, viewportHeight,
    }, inner);
    if (!bounds.ok) throw new BrowserFailure(bounds.error);
    const physical = physicalSurfaceOcclusions(occlusions, viewportWidth, viewportHeight, inner);
    if (!physical.ok) throw new BrowserFailure(physical.error);
    const inputPhysical = physicalSurfaceOcclusions(inputOcclusions, viewportWidth, viewportHeight, inner);
    if (!inputPhysical.ok) throw new BrowserFailure(inputPhysical.error);
    if (this.surfaceSequence !== null && sequence <= this.surfaceSequence) return 'embedded';
    await surfaceOp(() => surface.setContentBounds(bounds.value));
    const desiredMask = maskSignatureFromBoundsAndOcclusions(bounds.value, physical.value);
    const inputChanged = this.surfaceInputOcclusions === null
      || this.surfaceInputOcclusions.length !== inputPhysical.value.length
      || this.surfaceInputOcclusions.some((rect, index) => {
        const other = inputPhysical.value[index]!;
        return rect.x !== other.x || rect.y !== other.y
          || rect.width !== other.width || rect.height !== other.height;
      });
    if (this.surfaceMaskSignature === null
      || !maskSignaturesEqual(this.surfaceMaskSignature, desiredMask) || inputChanged) {
      await surfaceOp(() => surface.setContentOcclusions(physical.value, inputPhysical.value));
      this.surfaceMaskSignature = desiredMask;
      this.surfaceInputOcclusions = inputPhysical.value.map(rect => ({ ...rect }));
    }
    this.surfaceSequence = sequence;
    return 'embedded';
  }

  async setSurfaceVisibility(sessionId: string, visible: boolean, focus: boolean): Promise<string> {
    this.requireLiveSurfaceSession(sessionId);
    const surface = this.surface;
    if (surface !== null) await surfaceOp(() => surface.setContentVisibility(visible, focus));
    return this.surfaceHostMode();
  }

  getState(sessionId: string | null): BrowserSessionState | null {
    if (sessionId === null) return this.getActiveState();
    const session = this.requireSession(sessionId);
    return this.snapshotOf(session);
  }

  getHistory(sessionId: string): { url: string; title: string; visitedAt: string }[] {
    return this.getHistoryEntries(sessionId).map(entry => ({
      url: entry.url, title: entry.title, visitedAt: formatTimestamp(entry.visitedAt),
    }));
  }

  /** Session-shaped history for `cmd/browser.rs::state_result`. */
  getHistoryEntries(sessionId: string): import('./session.ts').HistoryEntry[] {
    return this.requireSession(sessionId).history.map(entry => ({
      url: entry.url, title: entry.title, visitedAt: new Date(entry.visitedAt),
    }));
  }

  getActiveState(): BrowserSessionState | null {
    return this.session !== null && this.session.alive ? this.snapshotOf(this.session) : null;
  }

  takeOver(): BrowserSessionState {
    return this.takeOverWithReason('user_takeover');
  }

  takeOverWithReason(reason: string): BrowserSessionState {
    const session = this.requireActiveSession();
    const state = this.takeOverLocked(session);
    this.emitControlMode(state, 'user', reason);
    return state;
  }

  contentUserInput(sessionId: string, nonce: string, kind: string): void {
    if (!['pointerdown', 'keydown', 'compositionstart', 'wheel'].includes(kind)) {
      throw validation('trusted_content_input: unsupported input kind');
    }
    const capability = this.trustedInput;
    if (capability === null || capability.sessionId !== sessionId
      || !/^[0-9a-fA-F]{32}$/.test(nonce)
      || !Buffer.from(nonce, 'hex').equals(capability.nonce)) {
      throw validation('trusted_content_input: invalid capability');
    }
    const session = this.session;
    if (session === null || !session.alive || session.id !== sessionId) {
      throw validation('trusted_content_input: invalid capability');
    }
    const payload = {
      sessionId: session.id, label: session.label, kind, at: eventAt(this.now),
    };
    if (session.controlMode === 'user') {
      this.policy.setAgentPrivateNetworkGuard(false);
      this.emitEvent('browser:content-user-input', payload);
      return;
    }
    const state = this.takeOverLocked(session);
    this.emitControlMode(state, 'user', 'trusted_content_input');
    this.emitEvent('browser:content-user-input', payload);
  }

  setAgentControl(): BrowserSessionState {
    this.ensureAgentAutomationSupported();
    this.allowInsecureHttp();
    const session = this.requireActiveSession();
    if (session.isBlockedByUserTakeover(this.now())) {
      throw validation('user_takeover: user recently took control of the browser');
    }
    this.policy.setAgentPrivateNetworkGuard(true);
    if (session.controlMode === 'agent') return this.snapshotOf(session);
    session.setControlMode('agent', this.now());
    const state = this.snapshotOf(session);
    this.emitControlMode(state, 'agent', 'agent_claim');
    return state;
  }

  consumeTakeoverNotice(sessionId: string): boolean {
    const session = this.session;
    if (session === null || !session.alive || session.id !== sessionId) return false;
    return session.consumeTakeoverNotice();
  }

  isBlockedByUserTakeover(): boolean {
    return this.session !== null && this.session.isBlockedByUserTakeover(this.now());
  }

  // ---------------------------------------------------------------- bridge

  private async bridgeState(sessionId: string): Promise<BrowserSessionState> {
    await this.assertGatesOpen();
    this.ensureAgentAutomationSupported();
    const session = this.requireSession(sessionId);
    return this.snapshotOf(session);
  }

  async snapshot(sessionId: string, maxChars: number | null, interactiveOnly = true): Promise<{
    sessionId: string; url: string; title: string; snapshot: string; epoch?: JsonValue;
  }> {
    const state = await this.bridgeState(sessionId);
    if (this.surface === null) throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    const options: { interactiveOnly: boolean; maxChars?: number } = { interactiveOnly };
    if (maxChars !== null) options.maxChars = maxChars;
    const value = await this.surface.snapshot(options);
    const text = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (typeof value.text === 'string' ? value.text
        : typeof value.snapshot === 'string' ? value.snapshot : JSON.stringify(value))
      : String(value);
    const epoch = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value.epoch
      : undefined;
    return {
      sessionId: state.id, url: state.url, title: state.title, snapshot: text,
      ...(epoch === undefined ? {} : { epoch }),
    };
  }

  async click(sessionId: string, ref: string): Promise<JsonValue> {
    await this.bridgeState(sessionId);
    if (this.surface === null) throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    return this.surface.click(ref);
  }

  async type(sessionId: string, ref: string, text: string, _submit: boolean): Promise<JsonValue> {
    await this.bridgeState(sessionId);
    if (this.surface === null) throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    return this.surface.typeText(ref, text);
  }

  async setInputFiles(sessionId: string, ref: string, files: JsonValue): Promise<JsonValue> {
    await this.bridgeState(sessionId);
    if (this.surface === null) throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    return this.surface.setInputFiles(ref, files);
  }

  async scroll(
    sessionId: string, direction: string | null, amount: number | null, ref: string | null,
  ): Promise<JsonValue> {
    await this.bridgeState(sessionId);
    if (this.surface === null) throw notFound(`window ${BROWSER_CONTENT_LABEL}`);
    return this.surface.scroll({ direction, amount, ref });
  }

  // ---------------------------------------------------------------- downloads

  listDownloads(sessionId: string): BrowserDownloadObservation[] {
    return this.downloads.list(sessionId);
  }

  listTaskDownloads(chatSessionId: string): BrowserDownloadObservation[] {
    return this.downloads.listForTask(chatSessionId);
  }

  onDownloadRequested(
    browserSessionId: string, url: string, originalName: string,
  ): Promise<{ allow: boolean; path: string | null }> {
    return this.downloads.requested(this.session, browserSessionId, url, originalName);
  }

  onDownloadFinished(url: string, path: string | null, success: boolean): void {
    this.downloads.finished(url, path, success);
  }

  // ---------------------------------------------------------------- native callbacks

  private async onPageFinished(url: string): Promise<void> {
    const session = this.session;
    if (session === null) return;
    const pending = this.pending !== null && this.pending.sessionId === session.id ? this.pending : null;
    if (pending !== null && pending.blocked !== null) {
      await this.onNavigationBlocked(pending.blocked.url, pending.blocked.reason);
      return;
    }
    if (pending !== null) this.clearNavigation(pending.id);
    const pageInitiated = !session.loading && session.url !== url;
    if (pageInitiated) {
      session.pushUrl(url, null, this.now());
      session.markLoaded(null, this.now());
    } else {
      session.markLoaded(url, this.now());
    }
    const state = this.snapshotOf(session);
    if (this.db.isOpen()) {
      try {
        if (pending !== null) {
          if (pending.kind === 'push') {
            pushHistory(this.db, state.id, {
              url: state.url, title: state.title, transition: 'link', typed: false,
            });
          } else {
            updateCurrentHistory(this.db, state.id, state.historyIndex, state.url, state.title);
          }
        } else if (pageInitiated) {
          pushHistory(this.db, state.id, {
            url: state.url, title: null, transition: 'link', typed: false,
          });
        } else {
          updateCurrentHistory(this.db, state.id, state.historyIndex, state.url, null);
        }
      } catch (error) { this.logWarn(`[browser] persist finished navigation failed: ${String(error)}`); }
    }
    this.emitEvent('browser:navigated', {
      sessionId: state.id, label: state.label, url: state.url, title: state.title,
      canGoBack: state.canGoBack, canGoForward: state.canGoForward,
      loading: false, at: eventAt(this.now),
    });
  }

  private async onTitleChanged(title: string, webviewUrl: string | null): Promise<void> {
    const session = this.session;
    if (session === null) return;
    const pageUrl = webviewUrl !== null && !session.loading && webviewUrl !== session.url
      ? webviewUrl : null;
    if (pageUrl !== null) session.pushUrl(pageUrl, null, this.now());
    session.setTitle(title, this.now());
    const state = this.snapshotOf(session);
    const navigationPending = this.pending !== null && this.pending.sessionId === state.id;
    if (this.db.isOpen() && !navigationPending) {
      try {
        if (pageUrl !== null) {
          pushHistory(this.db, state.id, {
            url: state.url, title: state.title, transition: 'link', typed: false,
          });
        } else {
          updateCurrentHistory(this.db, state.id, state.historyIndex, null, state.title);
        }
      } catch (error) { this.logWarn(`[browser] persist title failed: ${String(error)}`); }
    }
    if (pageUrl !== null) {
      this.emitEvent('browser:navigated', {
        sessionId: state.id, label: state.label, url: state.url, title: state.title,
        canGoBack: state.canGoBack, canGoForward: state.canGoForward,
        loading: state.loading, at: eventAt(this.now),
      });
    }
    this.emitEvent('browser:title-changed', {
      sessionId: state.id, label: state.label, title: state.title,
      url: state.url, at: eventAt(this.now),
    });
  }

  private async onNavigationBlocked(url: string, reason: string): Promise<void> {
    const pending = this.pending;
    if (pending !== null) {
      if (!this.clearNavigation(pending.id)) return;
      const session = this.session;
      if (session !== null && session.alive && session.id === pending.sessionId) {
        rollbackPendingNavigation(session, pending);
      }
    } else if (this.session !== null) {
      this.session.markLoaded(null, this.now());
    }
    const session = this.session;
    if (session === null) return;
    const state = this.snapshotOf(session);
    this.emitEvent('browser:navigation-blocked', {
      sessionId: session.id, label: BROWSER_CONTENT_LABEL, url, reason,
      currentUrl: state.url, title: state.title, canGoBack: state.canGoBack,
      canGoForward: state.canGoForward, historyIndex: state.historyIndex,
      at: eventAt(this.now),
    });
  }

  // ---------------------------------------------------------------- helpers

  private snapshotOf(session: BrowserSession): BrowserSessionState {
    return session.snapshot();
  }

  private requireSession(sessionId: string): BrowserSession {
    const session = this.session;
    if (session === null || session.id !== sessionId) throw notFound(`session ${sessionId}`);
    return session;
  }

  private requireActiveSession(): BrowserSession {
    if (this.session === null || !this.session.alive) {
      throw notFound('no active browser session');
    }
    return this.session;
  }

  private requireLiveSurfaceSession(sessionId: string): BrowserSession {
    const session = this.session;
    if (session === null || !session.alive || session.id !== sessionId) {
      throw notFound(`session ${sessionId}`);
    }
    return session;
  }

  private takeOverLocked(session: BrowserSession): BrowserSessionState {
    this.policy.setAgentPrivateNetworkGuard(false);
    session.takeOver(this.now());
    return this.snapshotOf(session);
  }

  private emitControlMode(
    state: BrowserSessionState, controlMode: 'user' | 'agent', reason: string,
  ): void {
    this.emitEvent('browser:control-mode-changed', {
      sessionId: state.id, label: state.label, controlMode, reason, at: eventAt(this.now),
    });
  }

  private async checkNavigationUrl(url: string, allowInsecureHttp: boolean, fromAgent: boolean): Promise<void> {
    const effectiveAllow = !fromAgent || allowInsecureHttp;
    const denial = allowNavigationWithOptions(url, effectiveAllow);
    if (denial !== null) throw validation(`navigation_blocked: ${navigationDenyMessage(denial)}`);
    if (fromAgent) {
      const reason = await this.policy.validateAgentTargetForAgent(url);
      if (reason !== null) throw validation(`navigation_blocked: ${reason}`);
    }
  }

  private nextNavigationId(): number {
    this.navigationSequence = (this.navigationSequence + 1) >>> 0;
    if (this.navigationSequence === 0) this.navigationSequence = 1;
    return this.navigationSequence;
  }

  private clearNavigation(id: number): boolean {
    if (this.pending !== null && this.pending.id === id) {
      this.pending = null;
      return true;
    }
    return false;
  }

  private cancelPendingNavigation(sessionId: string): void {
    const pending = this.pending;
    if (pending === null || pending.sessionId !== sessionId) return;
    if (!this.clearNavigation(pending.id)) return;
    const session = this.session;
    if (session !== null && session.alive && session.id === sessionId) {
      rollbackPendingNavigation(session, pending);
    }
  }

  /** `events.rs`: emit failures are logged, never propagated. */
  private emitEvent(event: string, payload: unknown): void {
    try { this.emitRaw(event, payload); }
    catch (error) { this.logWarn(`[browser] emit ${event} failed: ${String(error)}`); }
  }

  private logWarn(message: string): void {
    this.logLine('warn', message);
  }
}

export { MAX_HISTORY, USER_TAKEOVER_BLOCK_SECS, isBrowserChildGateEnabled, contentLabel, mapBrowserError };
