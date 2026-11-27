// Default BrowserSurfaceHost backed by the published F2 shell bridge (`ctx.shell`).
// F2 may register a richer `browserSurface` service (including native event push);
// commands keep the same policy/state behaviour either way.

import { ShellError, type BackendEvents, type ShellBridge, type WindowRef } from '../../../kernel/api.ts';
import { parseIp, type IpAddress } from '../../../platform/net-policy/ip.ts';
import type {
  AgentNavigationPolicy, BrowserRemoteInputEvent, BrowserScreenshotOptions, BrowserScreenshotResult,
  BrowserSurfaceCreateOptions, BrowserSurfaceHost, BrowserTabInfo, BrowserTarget, BrowserWaitOptions,
  SurfaceEventCallbacks,
} from '../api.ts';
import type { BridgeError, JsonValue } from './command-result.ts';
import { BROWSER_CONTENT_LABEL } from './window-policy.ts';

/**
 * Electron main → Host: a top-level navigation of `browser-content` that the native agent guard refused
 * (`ContentWindowHooks::on_navigation_blocked`). Delivered as a frontend event whose source is the content webview.
 */
export const NAVIGATION_BLOCKED_EVENT = 'dstu-browser://navigation-blocked';
/** `{ url }`: the content page finished loading (`ContentWindowHooks::on_page_finished`). */
export const PAGE_FINISHED_EVENT = 'dstu-browser://page-finished';
/** `{ title, url | null }`: `document.title` changed (`ContentWindowHooks::on_title_changed`). */
export const TITLE_CHANGED_EVENT = 'dstu-browser://title-changed';
/** `{ url, filename, savePath? }`: Electron `will-download` started on the browser content session. */
export const DOWNLOAD_STARTED_EVENT = 'dstu-browser://download-started';
/** `{ url, path, success }`: Electron `will-download` reached a terminal state. */
export const DOWNLOAD_FINISHED_EVENT = 'dstu-browser://download-finished';

const OP = {
  hostMode: 'browser.hostMode',
  create: 'browser.createContentWindow',
  destroy: 'browser.destroyContentWindow',
  navigate: 'browser.navigate',
  back: 'browser.goBack',
  forward: 'browser.goForward',
  reload: 'browser.reload',
  focus: 'browser.focusContentWindow',
  releaseFocus: 'browser.releaseContentFocus',
  viewport: 'browser.mainViewportSize',
  bounds: 'browser.setContentBounds',
  occlusions: 'browser.setContentOcclusions',
  visibility: 'browser.setContentVisibility',
  screenshot: 'browser.screenshot',
  snapshot: 'browser.snapshot',
  click: 'browser.click',
  type: 'browser.typeText',
  hover: 'browser.hover',
  pressKey: 'browser.pressKey',
  selectOption: 'browser.selectOption',
  waitFor: 'browser.waitFor',
  extractContent: 'browser.extractContent',
  listTabs: 'browser.listTabs',
  newTab: 'browser.newTab',
  switchTab: 'browser.switchTab',
  closeTab: 'browser.closeTab',
  consoleLogs: 'browser.consoleLogs',
  networkLogs: 'browser.networkLogs',
  promoteToInteractive: 'browser.promoteToInteractive',
  remoteInput: 'browser.remoteInput',
  inputFiles: 'browser.setInputFiles',
  scroll: 'browser.scroll',
  agentPolicy: 'browser.setAgentNavigationPolicy',
  downloadPolicy: 'browser.setDownloadPolicy',
  resolveAgentHost: 'browser.resolveAgentHost',
} as const;

const VALID_HOST_MODES = new Set(['remote', 'headless', 'embedded', 'detached', 'unsupported']);

function extractShellErrorData(error: unknown): { code: string; message: string; details?: unknown } | null {
  if (error instanceof ShellError && error.data !== undefined) {
    if (typeof error.data.code === 'string' && typeof error.data.message === 'string') {
      return error.data;
    }
  }
  if (error !== null && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data !== null && typeof data === 'object'
      && typeof (data as { code?: unknown }).code === 'string'
      && typeof (data as { message?: unknown }).message === 'string') {
      return data as { code: string; message: string; details?: unknown };
    }
  }
  return null;
}

function parseTimeoutMilliseconds(message: string, details?: unknown): number {
  if (details !== null && typeof details === 'object' && 'milliseconds' in details) {
    const ms = (details as { milliseconds?: unknown }).milliseconds;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return ms;
  }
  const match = /(\d+)\s*ms/i.exec(message);
  return match !== null ? Number(match[1]) : 15_000;
}

async function runBridgeOp<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const data = extractShellErrorData(error);
    if (data !== null) {
      if (data.code === 'TIMEOUT') {
        const timeoutErr: BridgeError = {
          kind: 'Timeout',
          milliseconds: parseTimeoutMilliseconds(data.message, data.details),
        };
        throw timeoutErr;
      }
      const bridgeErr: BridgeError = {
        kind: 'Bridge',
        code: String(data.code),
        message: String(data.message),
        details: (data.details ?? null) as JsonValue,
      };
      throw bridgeErr;
    }
    if (error instanceof ShellError && /timed out|timeout/i.test(error.message)) {
      const timeoutErr: BridgeError = {
        kind: 'Timeout',
        milliseconds: parseTimeoutMilliseconds(error.message),
      };
      throw timeoutErr;
    }
    throw error;
  }
}

function modifierNamesFromMask(mask?: number): string[] | undefined {
  if (typeof mask !== 'number' || mask === 0) return undefined;
  const names: string[] = [];
  if ((mask & 1) !== 0) names.push('Alt');
  if ((mask & 2) !== 0) names.push('Control');
  if ((mask & 4) !== 0) names.push('Meta');
  if ((mask & 8) !== 0) names.push('Shift');
  return names.length > 0 ? names : undefined;
}

interface WindowPresence {
  exists: boolean;
}

export class ShellBrowserSurface implements BrowserSurfaceHost {
  private present = false;
  private cachedHostMode: string | null = null;

  private readonly shell: ShellBridge;
  private readonly platform: string;
  private readonly events: Pick<BackendEvents, 'listen'> | null;
  private subscriber: SurfaceEventCallbacks | null = null;
  private listening = false;

  constructor(shell: ShellBridge, platform: string, events: Pick<BackendEvents, 'listen'> | null = null) {
    this.shell = shell;
    this.platform = platform;
    this.events = events;
  }

  hostMode(): string {
    if (this.cachedHostMode !== null) return this.cachedHostMode;
    if (this.platform === 'darwin' || this.platform === 'win32') return 'embedded';
    if (this.platform === 'linux') return 'detached';
    return 'unsupported';
  }

  async syncHostMode(): Promise<string> {
    try {
      const mode = await this.shell.request<unknown>(OP.hostMode);
      if (typeof mode === 'string' && VALID_HOST_MODES.has(mode)) {
        this.cachedHostMode = mode;
      }
      return this.hostMode();
    } catch {
      return this.hostMode();
    }
  }

  hasContentWindow(): boolean {
    return this.present;
  }

  async createContentWindow(options: BrowserSurfaceCreateOptions): Promise<void> {
    await this.shell.request(OP.create, options);
    this.present = true;
  }

  async destroyContentWindow(): Promise<boolean> {
    const result = await this.shell.request<WindowPresence | boolean>(OP.destroy);
    this.present = false;
    return typeof result === 'boolean' ? result : true;
  }

  async navigate(url: string): Promise<void> {
    await this.shell.request(OP.navigate, { url });
  }

  async goBack(): Promise<void> {
    await this.shell.request(OP.back);
  }

  async goForward(): Promise<void> {
    await this.shell.request(OP.forward);
  }

  async reload(): Promise<void> {
    await this.shell.request(OP.reload);
  }

  async focusContentWindow(): Promise<void> {
    await this.shell.request(OP.focus);
  }

  async releaseContentFocus(): Promise<void> {
    await this.shell.request(OP.releaseFocus);
  }

  async mainViewportSize(): Promise<{ width: number; height: number }> {
    return this.shell.request<{ width: number; height: number }>(OP.viewport);
  }

  async setContentBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    await this.shell.request(OP.bounds, bounds);
  }

  async setContentOcclusions(
    occlusions: readonly { x: number; y: number; width: number; height: number }[],
    inputOcclusions: readonly { x: number; y: number; width: number; height: number }[],
  ): Promise<void> {
    await this.shell.request(OP.occlusions, { occlusions, inputOcclusions });
  }

  async setContentVisibility(visible: boolean, focus: boolean): Promise<void> {
    await this.shell.request(OP.visibility, { visible, focus });
  }

  async snapshot(options: {
    interactiveOnly: boolean; maxChars?: number; diff?: boolean; selector?: string;
  }): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.snapshot, options));
  }

  async click(
    ref: string,
    options?: { doubleClick?: boolean; button?: 'left' | 'middle' | 'right' },
  ): Promise<JsonValue> {
    const args: Record<string, unknown> = { ref };
    if (options?.doubleClick === true) args.doubleClick = true;
    if (options?.button !== undefined) args.button = options.button;
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.click, args));
  }

  async clickAt(
    x: number,
    y: number,
    options?: { doubleClick?: boolean; button?: 'left' | 'middle' | 'right' },
  ): Promise<JsonValue> {
    const args: Record<string, unknown> = { x, y };
    if (options?.doubleClick === true) args.doubleClick = true;
    if (options?.button !== undefined) args.button = options.button;
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.click, args));
  }

  async typeText(
    ref: string,
    text: string,
    options?: { clear?: boolean; submit?: boolean },
  ): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.type, {
      ref,
      text,
      clear: Boolean(options?.clear),
      submit: Boolean(options?.submit),
    }));
  }

  async setInputFiles(ref: string, files: JsonValue): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.inputFiles, { ref, files }));
  }

  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.scroll, options));
  }

  async screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    return this.shell.request<BrowserScreenshotResult>(OP.screenshot, options ?? {});
  }

  async hover(target: BrowserTarget): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.hover, target));
  }

  async pressKey(key: string, modifiers?: string[]): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.pressKey, { key, ...(modifiers ? { modifiers } : {}) }));
  }

  async selectOption(ref: string, values: string[]): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.selectOption, { ref, values }));
  }

  async waitFor(options: BrowserWaitOptions): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.waitFor, options));
  }

  async extractContent(options?: { maxChars?: number; startIndex?: number }): Promise<JsonValue> {
    return runBridgeOp(() => this.shell.request<JsonValue>(OP.extractContent, options ?? {}));
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    return this.shell.request<BrowserTabInfo[]>(OP.listTabs);
  }

  async newTab(url: string): Promise<BrowserTabInfo> {
    return this.shell.request<BrowserTabInfo>(OP.newTab, { url });
  }

  async switchTab(tabId: string): Promise<BrowserTabInfo> {
    return this.shell.request<BrowserTabInfo>(OP.switchTab, { tabId });
  }

  async closeTab(tabId: string): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.closeTab, { tabId });
  }

  async consoleLogs(options?: { level?: string; limit?: number }): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.consoleLogs, options ?? {});
  }

  async networkLogs(options?: { statusMin?: number; limit?: number }): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.networkLogs, options ?? {});
  }

  async promoteToInteractive(): Promise<void> {
    await this.shell.request(OP.promoteToInteractive);
  }

  async remoteInput(event: BrowserRemoteInputEvent): Promise<void> {
    if ('type' in event) {
      await this.shell.request(OP.remoteInput, event);
      return;
    }
    const modifiers = modifierNamesFromMask(event.modifiers);
    if (event.kind === 'mouse') {
      const button = event.button ?? 'left';
      if (event.action === 'move') {
        await this.shell.request(OP.remoteInput, {
          type: 'mouseMoved', x: event.x, y: event.y, ...(modifiers ? { modifiers } : {}),
        });
      } else if (event.action === 'down') {
        await this.shell.request(OP.remoteInput, {
          type: 'mousePressed', x: event.x, y: event.y, button, clickCount: event.clickCount ?? 1,
          ...(modifiers ? { modifiers } : {}),
        });
      } else if (event.action === 'up') {
        await this.shell.request(OP.remoteInput, {
          type: 'mouseReleased', x: event.x, y: event.y, button, clickCount: event.clickCount ?? 1,
          ...(modifiers ? { modifiers } : {}),
        });
      } else {
        const clicks = event.action === 'dblclick' ? 2 : 1;
        await this.shell.request(OP.remoteInput, {
          type: 'mouseMoved', x: event.x, y: event.y, ...(modifiers ? { modifiers } : {}),
        });
        for (let clickCount = 1; clickCount <= clicks; clickCount += 1) {
          await this.shell.request(OP.remoteInput, {
            type: 'mousePressed', x: event.x, y: event.y, button, clickCount,
            ...(modifiers ? { modifiers } : {}),
          });
          await this.shell.request(OP.remoteInput, {
            type: 'mouseReleased', x: event.x, y: event.y, button, clickCount,
            ...(modifiers ? { modifiers } : {}),
          });
        }
      }
      return;
    }
    if (event.kind === 'wheel') {
      await this.shell.request(OP.remoteInput, {
        type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY,
        ...(modifiers ? { modifiers } : {}),
      });
      return;
    }
    const keyExtra = {
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(event.text !== undefined ? { text: event.text } : {}),
      ...(modifiers ? { modifiers } : {}),
    };
    const keyUpExtra = {
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(modifiers ? { modifiers } : {}),
    };
    if (event.action === 'text') {
      await this.shell.request(OP.remoteInput, { type: 'insertText', text: event.text ?? '' });
    } else if (event.action === 'down') {
      await this.shell.request(OP.remoteInput, { type: 'keyDown', key: event.key ?? '', ...keyExtra });
    } else if (event.action === 'up') {
      await this.shell.request(OP.remoteInput, { type: 'keyUp', key: event.key ?? '', ...keyUpExtra });
    } else {
      await this.shell.request(OP.remoteInput, { type: 'keyDown', key: event.key ?? '', ...keyExtra });
      await this.shell.request(OP.remoteInput, { type: 'keyUp', key: event.key ?? '', ...keyUpExtra });
    }
  }

  async setAgentNavigationPolicy(policy: AgentNavigationPolicy): Promise<void> {
    await this.shell.request(OP.agentPolicy, {
      agentPrivateNetworkGuard: policy.agentPrivateNetworkGuard,
      agentAllowInsecureHttp: policy.agentAllowInsecureHttp,
    });
  }

  async setDownloadPolicy(policy: { agentOwned: boolean; artifactDir: string | null }): Promise<void> {
    await this.shell.request(OP.downloadPolicy, {
      agentOwned: policy.agentOwned,
      artifactDir: policy.artifactDir,
    });
  }

  async resolveAgentHost(host: string, port: number): Promise<IpAddress[] | string> {
    let answer: { addresses?: unknown; error?: unknown };
    try {
      answer = await this.shell.request<{ addresses?: unknown; error?: unknown }>(OP.resolveAgentHost, { host, port });
    } catch (error) {
      return `DNS resolver unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (typeof answer?.error === 'string') return answer.error;
    if (!Array.isArray(answer?.addresses)) return 'DNS resolution failed: malformed resolver answer';
    const addresses: IpAddress[] = [];
    for (const raw of answer.addresses) {
      const address = typeof raw === 'string' ? parseIp(raw) : null;
      if (address === null) return `DNS resolution failed: unexpected address ${JSON.stringify(raw)}`;
      addresses.push(address);
    }
    return addresses;
  }

  /**
   * The kernel shell bridge is request/response only. Main reports navigations its agent guard refused
   * as {@link NAVIGATION_BLOCKED_EVENT}; page/title callbacks still arrive only through a richer
   * `ctx.browserSurface` service when F2 registers one.
   */
  subscribe(callbacks: SurfaceEventCallbacks): () => void {
    this.subscriber = callbacks;
    if (this.events !== null && !this.listening) {
      this.listening = true;
      const fromContent = (event: string, handle: (payload: Record<string, unknown>) => void) => {
        this.events!.listen(event, (payload: unknown, source: WindowRef) => {
          // SEC-E05: only main's own callbacks (FrontendEvent.native) count; page emits never carry the marker.
          if (source?.native !== true || source.webview !== BROWSER_CONTENT_LABEL) return;
          handle((payload ?? {}) as Record<string, unknown>);
        });
      };
      fromContent(NAVIGATION_BLOCKED_EVENT, ({ url, reason }) => {
        if (typeof url !== 'string' || typeof reason !== 'string') return;
        this.subscriber?.navigationBlocked(url, reason);
      });
      fromContent(PAGE_FINISHED_EVENT, ({ url }) => {
        if (typeof url !== 'string') return;
        this.subscriber?.pageFinished(url);
      });
      fromContent(TITLE_CHANGED_EVENT, ({ title, url }) => {
        if (typeof title !== 'string' || (url !== null && typeof url !== 'string')) return;
        this.subscriber?.titleChanged(title, url);
      });
      fromContent(DOWNLOAD_STARTED_EVENT, ({ url, filename, savePath }) => {
        if (typeof url !== 'string' || typeof filename !== 'string') return;
        const resolvedSavePath = typeof savePath === 'string' ? savePath : null;
        this.subscriber?.downloadStarted?.(url, filename, resolvedSavePath);
      });
      fromContent(DOWNLOAD_FINISHED_EVENT, ({ url, path, success }) => {
        if (typeof url !== 'string' || typeof success !== 'boolean') return;
        const resolvedPath = typeof path === 'string' ? path : null;
        this.subscriber?.downloadFinished?.(url, resolvedPath, success);
      });
    }
    return () => {
      if (this.subscriber === callbacks) this.subscriber = null;
    };
  }
}
