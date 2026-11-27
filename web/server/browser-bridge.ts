/**
 * WebUI Remote CDP Browser Bridge.
 *
 * Connects the self-hosted Node WebUI gateway's `browser.*` shell requests to a
 * `RemoteCdpBrowserSurface` backed by either an explicit `DS_BROWSER_CDP_URL`
 * endpoint or an optional auto-launched local headless Chromium process
 * (`DS_BROWSER_AUTO_LAUNCH=1`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  RemoteCdpBrowserSurface,
  type AgentNavigationPolicy,
  type BrowserRemoteInputEvent,
  type BrowserScreencastFrame,
  type BrowserScreenshotOptions,
  type BrowserSurfaceCreateOptions,
  type BrowserTarget,
  type BrowserWaitOptions,
  type RemoteCdpSurfaceOptions,
} from '../../host/plugins/browser/api.ts';

export const BROWSER_PAGE_FINISHED_EVENT = 'dstu-browser://page-finished';
export const BROWSER_TITLE_CHANGED_EVENT = 'dstu-browser://title-changed';
export const BROWSER_NAVIGATION_BLOCKED_EVENT = 'dstu-browser://navigation-blocked';

const DEFAULT_VIEWPORT_WIDTH = 1_280;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;

export interface WebScreencastPayload {
  data: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  timestamp: number;
}

export interface WebBrowserBridgeOptions {
  /** Configured CDP endpoint (`http://127.0.0.1:9222` or `ws://...`). Defaults to `DS_BROWSER_CDP_URL`. */
  cdpUrl?: string;
  /** Optional dynamic resolver for a persisted CDP endpoint setting (for example `desktop.workbenchBrowserCdpUrl`). */
  resolveConfiguredCdpUrl?: () => Promise<string | null> | string | null;
  /** Enable probing and spawning a local headless Chromium when `cdpUrl` is unset. Defaults to `DS_BROWSER_AUTO_LAUNCH=1`. */
  autoLaunch?: boolean;
  /** Explicit Chromium executable path override for auto-launch. */
  chromiumBinaryPath?: string;
  /** Isolated profile root directory for auto-launched Chromium. */
  profileRootDir?: string;
  /** Optional factory override for creating the underlying `RemoteCdpBrowserSurface`. */
  surfaceFactory?: (options: RemoteCdpSurfaceOptions) => RemoteCdpBrowserSurface;
  /** Callback invoked for each incoming CDP screencast frame. */
  onScreencastFrame?: (frame: WebScreencastPayload) => void;
  /** Callback invoked for `dstu-browser://*` native frontend events forwarded to Host. */
  onNativeEvent?: (event: string, payload: unknown) => void;
  /** Structured logger. */
  log?: (message: string) => void;
}

function unconfiguredCdpError(): Error {
  return new Error(
    'Remote CDP browser is not configured for WebUI mode. '
    + 'Set DS_BROWSER_CDP_URL (for example, http://127.0.0.1:9222), '
    + 'configure Remote CDP Endpoint in Workbench Browser settings (desktop.workbenchBrowserCdpUrl), '
    + 'or enable DS_BROWSER_AUTO_LAUNCH=1 with a local Chrome, Chromium, or Edge installation.',
  );
}

function candidateChromiumBinaries(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA ?? '';
    const candidates = [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    if (localAppData !== '') {
      candidates.unshift(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    return candidates;
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
}

export function findLocalChromiumBinary(
  overridePath?: string,
  exists: (filePath: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = overridePath?.trim() || env.DS_BROWSER_CHROMIUM_PATH?.trim() || '';
  if (explicit !== '') {
    return exists(explicit) ? explicit : null;
  }
  for (const candidate of candidateChromiumBinaries(platform, env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`browser shell op argument ${key} must be a string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`browser shell op argument ${key} must be a finite number`);
  }
  return value;
}

function parseMouseButton(value: unknown): 'left' | 'middle' | 'right' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'left' || value === 'middle' || value === 'right') return value;
  throw new Error('browser shell op argument button must be left, middle, or right');
}

function parseStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`browser shell op argument ${key} must be an array of strings`);
  }
  return value as string[];
}

function parseRect(value: unknown, key: string): { x: number; y: number; width: number; height: number } {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`browser shell op argument ${key} must be a rectangle`);
  }
  const rect = value as Record<string, unknown>;
  return {
    x: requireFiniteNumber(rect.x, `${key}.x`),
    y: requireFiniteNumber(rect.y, `${key}.y`),
    width: requireFiniteNumber(rect.width, `${key}.width`),
    height: requireFiniteNumber(rect.height, `${key}.height`),
  };
}

function parseRectList(value: unknown, key: string): Array<{ x: number; y: number; width: number; height: number }> {
  if (!Array.isArray(value)) {
    throw new Error(`browser shell op argument ${key} must be an array`);
  }
  return value.map((item, idx) => parseRect(item, `${key}[${idx}]`));
}

function parseRemoteInputEvent(args: Record<string, unknown>): BrowserRemoteInputEvent {
  const source =
    typeof args.event === 'object' && args.event !== null && !Array.isArray(args.event)
      ? (args.event as Record<string, unknown>)
      : args;

  if (typeof source.kind === 'string') {
    if (source.kind === 'mouse') {
      const action = source.action;
      if (action !== 'move' && action !== 'down' && action !== 'up' && action !== 'click' && action !== 'dblclick') {
        throw new Error(`invalid remote mouse action: ${String(action)}`);
      }
      return {
        kind: 'mouse',
        action,
        x: requireFiniteNumber(source.x, 'x'),
        y: requireFiniteNumber(source.y, 'y'),
        ...(parseMouseButton(source.button) ? { button: parseMouseButton(source.button) } : {}),
        ...(typeof source.modifiers === 'number' ? { modifiers: source.modifiers } : {}),
        ...(typeof source.clickCount === 'number' ? { clickCount: source.clickCount } : {}),
      };
    }
    if (source.kind === 'wheel') {
      return {
        kind: 'wheel',
        x: requireFiniteNumber(source.x, 'x'),
        y: requireFiniteNumber(source.y, 'y'),
        deltaX: requireFiniteNumber(source.deltaX, 'deltaX'),
        deltaY: requireFiniteNumber(source.deltaY, 'deltaY'),
        ...(typeof source.modifiers === 'number' ? { modifiers: source.modifiers } : {}),
      };
    }
    if (source.kind === 'key') {
      const action = source.action;
      if (action !== 'down' && action !== 'up' && action !== 'press' && action !== 'text') {
        throw new Error(`invalid remote key action: ${String(action)}`);
      }
      return {
        kind: 'key',
        action,
        ...(typeof source.key === 'string' ? { key: source.key } : {}),
        ...(typeof source.code === 'string' ? { code: source.code } : {}),
        ...(typeof source.text === 'string' ? { text: source.text } : {}),
        ...(typeof source.modifiers === 'number' ? { modifiers: source.modifiers } : {}),
      };
    }
  }

  const inputType = requireString(source, 'type');
  const allowedTypes = [
    'mouseMoved',
    'mousePressed',
    'mouseReleased',
    'mouseWheel',
    'keyDown',
    'keyUp',
    'insertText',
  ] as const;
  if (!(allowedTypes as readonly string[]).includes(inputType)) {
    throw new Error(`browser shell op argument type is invalid: ${inputType}`);
  }
  const event: Extract<BrowserRemoteInputEvent, { type: string }> = {
    type: inputType as Extract<BrowserRemoteInputEvent, { type: string }>['type'],
  };
  if (typeof source.x === 'number' && Number.isFinite(source.x)) event.x = source.x;
  if (typeof source.y === 'number' && Number.isFinite(source.y)) event.y = source.y;
  const button = parseMouseButton(source.button);
  if (button !== undefined) event.button = button;
  if (typeof source.clickCount === 'number' && Number.isFinite(source.clickCount)) {
    event.clickCount = source.clickCount;
  }
  if (typeof source.deltaX === 'number' && Number.isFinite(source.deltaX)) event.deltaX = source.deltaX;
  if (typeof source.deltaY === 'number' && Number.isFinite(source.deltaY)) event.deltaY = source.deltaY;
  if (typeof source.key === 'string') event.key = source.key;
  if (source.modifiers !== undefined) event.modifiers = parseStringArray(source.modifiers, 'modifiers');
  if (typeof source.text === 'string') event.text = source.text;
  return event;
}

export class WebBrowserBridge {
  private readonly configuredCdpUrl: string;
  private readonly resolveConfiguredCdpUrl?: () => Promise<string | null> | string | null;
  private readonly autoLaunch: boolean;
  private readonly chromiumBinaryPath?: string;
  private readonly profileRootDir?: string;
  private readonly surfaceFactory?: (options: RemoteCdpSurfaceOptions) => RemoteCdpBrowserSurface;
  private readonly onScreencastFrame?: (frame: WebScreencastPayload) => void;
  private readonly onNativeEvent?: (event: string, payload: unknown) => void;
  private readonly log: (message: string) => void;

  private surface: RemoteCdpBrowserSurface | null = null;
  private surfaceEndpoint: string | null = null;
  private unsubscribeSurface: (() => void) | null = null;
  private launchedProcess: ChildProcess | null = null;
  private launchedEndpoint: string | null = null;
  private agentNavigationPolicy: AgentNavigationPolicy | null = null;

  constructor(options: WebBrowserBridgeOptions = {}) {
    this.configuredCdpUrl = (options.cdpUrl ?? process.env.DS_BROWSER_CDP_URL ?? '').trim();
    this.resolveConfiguredCdpUrl = options.resolveConfiguredCdpUrl;
    const envAuto = (process.env.DS_BROWSER_AUTO_LAUNCH ?? '').trim().toLowerCase();
    this.autoLaunch = options.autoLaunch ?? (envAuto === '1' || envAuto === 'true');
    this.chromiumBinaryPath = options.chromiumBinaryPath;
    this.profileRootDir = options.profileRootDir;
    this.surfaceFactory = options.surfaceFactory;
    this.onScreencastFrame = options.onScreencastFrame;
    this.onNativeEvent = options.onNativeEvent;
    this.log = options.log ?? (() => undefined);
  }

  hostMode(): string {
    return 'remote';
  }

  hasActiveSurface(): boolean {
    return this.surface !== null && this.surface.hasContentWindow();
  }

  async handleShellRequest(op: string, rawArgs: unknown): Promise<unknown> {
    const args =
      rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

    switch (op) {
      case 'browser.hostMode': {
        return this.hostMode();
      }

      case 'browser.setDownloadPolicy': {
        return null;
      }

      case 'browser.createContentWindow': {
        const createOptions: BrowserSurfaceCreateOptions = {
          url: requireString(args, 'url'),
          title: typeof args.title === 'string' ? args.title : 'Browser',
          width: typeof args.width === 'number' && Number.isFinite(args.width) ? args.width : DEFAULT_VIEWPORT_WIDTH,
          height: typeof args.height === 'number' && Number.isFinite(args.height) ? args.height : DEFAULT_VIEWPORT_HEIGHT,
          focused: args.focused !== false,
          profileDir: typeof args.profileDir === 'string' ? args.profileDir : '',
          initializationScript: typeof args.initializationScript === 'string' ? args.initializationScript : '',
          ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
        };
        const surface = await this.ensureSurface(createOptions.profileDir);
        try {
          if (this.agentNavigationPolicy !== null) {
            await surface.setAgentNavigationPolicy(this.agentNavigationPolicy);
          }
          await surface.createContentWindow(createOptions);
          await this.startSurfaceScreencast(surface);
          return null;
        } catch (error) {
          this.unsubscribeSurface?.();
          this.unsubscribeSurface = null;
          this.surface = null;
          this.surfaceEndpoint = null;
          try {
            await surface.destroyContentWindow();
          } catch (destroyError) {
            this.log(
              `[web-browser] cleanup after createContentWindow failure ignored: ${destroyError instanceof Error ? destroyError.message : String(destroyError)}`,
            );
          }
          throw error;
        }
      }

      case 'browser.destroyContentWindow': {
        return this.destroySurface();
      }

      case 'browser.navigate': {
        await this.requireActiveSurface().navigate(requireString(args, 'url'));
        return null;
      }

      case 'browser.goBack': {
        await this.requireActiveSurface().goBack();
        return null;
      }

      case 'browser.goForward': {
        await this.requireActiveSurface().goForward();
        return null;
      }

      case 'browser.reload': {
        await this.requireActiveSurface().reload();
        return null;
      }

      case 'browser.snapshot': {
        const snapshotOptions: { interactiveOnly: boolean; maxChars?: number; diff?: boolean; selector?: string } = {
          interactiveOnly: args.interactiveOnly !== false,
        };
        if (typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)) {
          snapshotOptions.maxChars = args.maxChars;
        }
        if (typeof args.diff === 'boolean') {
          snapshotOptions.diff = args.diff;
        }
        if (typeof args.selector === 'string' && args.selector.trim() !== '') {
          snapshotOptions.selector = args.selector;
        }
        return this.requireActiveSurface().snapshot(snapshotOptions);
      }

      case 'browser.screenshot': {
        const shotOptions: BrowserScreenshotOptions = {};
        if (typeof args.fullPage === 'boolean') shotOptions.fullPage = args.fullPage;
        if (typeof args.annotate === 'boolean') shotOptions.annotate = args.annotate;
        if (typeof args.maxWidth === 'number' && Number.isFinite(args.maxWidth)) shotOptions.maxWidth = args.maxWidth;
        if (typeof args.quality === 'number' && Number.isFinite(args.quality)) shotOptions.quality = args.quality;
        return this.requireActiveSurface().screenshot(shotOptions);
      }

      case 'browser.click': {
        const surface = this.requireActiveSurface();
        const clickOptions: { doubleClick?: boolean; button?: 'left' | 'middle' | 'right' } = {};
        if (typeof args.doubleClick === 'boolean') clickOptions.doubleClick = args.doubleClick;
        const button = parseMouseButton(args.button);
        if (button !== undefined) clickOptions.button = button;
        if (typeof args.ref === 'string') {
          return surface.click(args.ref, clickOptions);
        }
        if (args.x !== undefined || args.y !== undefined) {
          return surface.clickAt(
            requireFiniteNumber(args.x, 'x'),
            requireFiniteNumber(args.y, 'y'),
            clickOptions,
          );
        }
        throw new Error('browser shell op argument ref must be a string or x/y must be finite numbers');
      }

      case 'browser.typeText': {
        const ref = requireString(args, 'ref');
        const text = requireString(args, 'text');
        const typeOptions: { clear?: boolean; submit?: boolean } = {};
        if (typeof args.clear === 'boolean') typeOptions.clear = args.clear;
        if (typeof args.submit === 'boolean') typeOptions.submit = args.submit;
        return this.requireActiveSurface().typeText(ref, text, typeOptions);
      }

      case 'browser.hover': {
        const target: BrowserTarget =
          typeof args.ref === 'string'
            ? { ref: args.ref }
            : { x: requireFiniteNumber(args.x, 'x'), y: requireFiniteNumber(args.y, 'y') };
        return this.requireActiveSurface().hover(target);
      }

      case 'browser.pressKey': {
        const key = requireString(args, 'key');
        const modifiers = args.modifiers !== undefined ? parseStringArray(args.modifiers, 'modifiers') : undefined;
        return this.requireActiveSurface().pressKey(key, modifiers);
      }

      case 'browser.selectOption': {
        const ref = requireString(args, 'ref');
        const values =
          args.values !== undefined
            ? parseStringArray(args.values, 'values')
            : typeof args.value === 'string'
              ? [args.value]
              : (() => {
                  throw new Error('browser shell op argument values must be an array of strings');
                })();
        return this.requireActiveSurface().selectOption(ref, values);
      }

      case 'browser.waitFor': {
        const waitOptions: BrowserWaitOptions = {};
        if (typeof args.text === 'string') waitOptions.text = args.text;
        if (typeof args.selector === 'string') waitOptions.selector = args.selector;
        if (args.loadState === 'load' || args.loadState === 'domcontentloaded' || args.loadState === 'networkidle') {
          waitOptions.loadState = args.loadState;
        } else if (args.loadState !== undefined) {
          throw new Error('browser shell op argument loadState must be load, domcontentloaded, or networkidle');
        }
        if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) {
          waitOptions.timeoutMs = args.timeoutMs;
        }
        return this.requireActiveSurface().waitFor(waitOptions);
      }

      case 'browser.extractContent': {
        const extractOptions: { maxChars?: number; startIndex?: number } = {};
        if (typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)) {
          extractOptions.maxChars = args.maxChars;
        }
        if (typeof args.startIndex === 'number' && Number.isFinite(args.startIndex)) {
          extractOptions.startIndex = args.startIndex;
        }
        return this.requireActiveSurface().extractContent(extractOptions);
      }

      case 'browser.setInputFiles': {
        return this.requireActiveSurface().setInputFiles(
          requireString(args, 'ref'),
          args.files as Parameters<RemoteCdpBrowserSurface['setInputFiles']>[1],
        );
      }

      case 'browser.scroll': {
        return this.requireActiveSurface().scroll({
          direction: typeof args.direction === 'string' ? args.direction : null,
          amount: typeof args.amount === 'number' && Number.isFinite(args.amount) ? args.amount : null,
          ref: typeof args.ref === 'string' ? args.ref : null,
        });
      }

      case 'browser.listTabs': {
        return this.requireActiveSurface().listTabs();
      }

      case 'browser.newTab': {
        const url = typeof args.url === 'string' && args.url.trim() !== '' ? args.url : 'about:blank';
        return this.requireActiveSurface().newTab(url);
      }

      case 'browser.switchTab': {
        return this.requireActiveSurface().switchTab(requireString(args, 'tabId'));
      }

      case 'browser.closeTab': {
        return this.requireActiveSurface().closeTab(requireString(args, 'tabId'));
      }

      case 'browser.consoleLogs': {
        const logOptions: { level?: string; limit?: number } = {};
        if (typeof args.level === 'string') logOptions.level = args.level;
        if (typeof args.limit === 'number' && Number.isFinite(args.limit)) logOptions.limit = args.limit;
        return this.requireActiveSurface().consoleLogs(logOptions);
      }

      case 'browser.networkLogs': {
        const logOptions: { statusMin?: number; limit?: number } = {};
        if (typeof args.statusMin === 'number' && Number.isFinite(args.statusMin)) logOptions.statusMin = args.statusMin;
        if (typeof args.limit === 'number' && Number.isFinite(args.limit)) logOptions.limit = args.limit;
        return this.requireActiveSurface().networkLogs(logOptions);
      }

      case 'browser.remoteInput': {
        const event = parseRemoteInputEvent(args);
        await this.requireActiveSurface().remoteInput(event);
        return null;
      }

      case 'browser.setAgentNavigationPolicy': {
        const policy: AgentNavigationPolicy = {
          agentPrivateNetworkGuard: args.agentPrivateNetworkGuard === true,
          agentAllowInsecureHttp: args.agentAllowInsecureHttp === true,
        };
        this.agentNavigationPolicy = policy;
        if (this.surface !== null) {
          await this.surface.setAgentNavigationPolicy(policy);
        }
        return null;
      }

      case 'browser.resolveAgentHost': {
        const host = requireString(args, 'host');
        return this.resolveHostAddresses(host);
      }

      case 'browser.setContentBounds': {
        const bounds = parseRect(args, 'bounds');
        if (this.surface !== null) {
          await this.surface.setContentBounds(bounds);
        }
        return null;
      }

      case 'browser.setContentOcclusions': {
        const occlusions = parseRectList(args.occlusions, 'occlusions');
        const inputOcclusions = parseRectList(args.inputOcclusions, 'inputOcclusions');
        if (this.surface !== null) {
          await this.surface.setContentOcclusions(occlusions, inputOcclusions);
        }
        return null;
      }

      case 'browser.setContentVisibility': {
        if (this.surface !== null) {
          await this.surface.setContentVisibility(args.visible === true, args.focus === true);
        }
        return null;
      }

      case 'browser.focusContentWindow': {
        if (this.surface !== null) {
          await this.surface.focusContentWindow();
        }
        return null;
      }

      case 'browser.releaseContentFocus': {
        if (this.surface !== null) {
          await this.surface.releaseContentFocus();
        }
        return null;
      }

      case 'browser.mainViewportSize': {
        if (this.surface !== null) {
          return this.surface.mainViewportSize();
        }
        return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
      }

      case 'browser.promoteToInteractive': {
        return { promoted: false, headless: this.launchedProcess !== null };
      }

      default:
        throw new Error(`unknown browser shell op in WebUI: ${op}`);
    }
  }

  async invalidateSurface(): Promise<void> {
    await this.destroySurface();
    await this.stopLaunchedProcess();
  }

  async dispose(): Promise<void> {
    await this.destroySurface();
    await this.stopLaunchedProcess();
  }

  private requireActiveSurface(): RemoteCdpBrowserSurface {
    if (this.surface === null) {
      throw new Error('Remote CDP browser session is not open');
    }
    return this.surface;
  }

  private async ensureSurface(requestedProfileDir: string): Promise<RemoteCdpBrowserSurface> {
    const endpoint = await this.resolveCdpEndpoint(requestedProfileDir);
    if (this.surface !== null) {
      if (this.surfaceEndpoint === endpoint && this.surface.hasContentWindow()) {
        return this.surface;
      }
      await this.destroySurface();
    }
    if (this.launchedProcess !== null && endpoint !== this.launchedEndpoint) {
      await this.stopLaunchedProcess();
    }
    const surfaceOptions: RemoteCdpSurfaceOptions = {
      endpoint,
      log: (level, message) => {
        if (level === 'warn' || level === 'error') {
          this.log(`[web-browser:${level}] ${message}`);
        }
      },
    };
    const surface = this.surfaceFactory
      ? this.surfaceFactory(surfaceOptions)
      : new RemoteCdpBrowserSurface(surfaceOptions);

    this.unsubscribeSurface?.();
    this.unsubscribeSurface = surface.subscribe({
      pageFinished: (url) => {
        this.onNativeEvent?.(BROWSER_PAGE_FINISHED_EVENT, { url });
      },
      titleChanged: (title, url) => {
        this.onNativeEvent?.(BROWSER_TITLE_CHANGED_EVENT, { title, url });
      },
      navigationBlocked: (url, reason) => {
        this.onNativeEvent?.(BROWSER_NAVIGATION_BLOCKED_EVENT, { url, reason });
      },
    });
    this.surface = surface;
    this.surfaceEndpoint = endpoint;
    return surface;
  }

  private async startSurfaceScreencast(surface: RemoteCdpBrowserSurface): Promise<void> {
    if (!this.onScreencastFrame) return;
    try {
      await surface.startScreencast((frame: BrowserScreencastFrame) => {
        this.onScreencastFrame?.({
          data: frame.dataBase64,
          mimeType: frame.mimeType,
          width: frame.width,
          height: frame.height,
          timestamp: frame.timestamp ?? Date.now(),
        });
      });
    } catch (error) {
      this.log(`[web-browser] screencast start skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async destroySurface(): Promise<boolean> {
    const surface = this.surface;
    this.surface = null;
    this.surfaceEndpoint = null;
    this.unsubscribeSurface?.();
    this.unsubscribeSurface = null;
    if (surface === null) return false;
    try {
      return await surface.destroyContentWindow();
    } catch (error) {
      this.log(`[web-browser] destroyContentWindow error: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async resolveCdpEndpoint(requestedProfileDir: string): Promise<string> {
    if (this.configuredCdpUrl !== '') {
      return this.configuredCdpUrl;
    }
    if (this.resolveConfiguredCdpUrl !== undefined) {
      try {
        const dynamicUrl = (await this.resolveConfiguredCdpUrl())?.trim() ?? '';
        if (dynamicUrl !== '') {
          return dynamicUrl;
        }
      } catch (error) {
        this.log(
          `[web-browser] failed to resolve configured CDP URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.launchedEndpoint !== null && this.launchedProcess !== null && this.launchedProcess.exitCode === null) {
      return this.launchedEndpoint;
    }
    if (!this.autoLaunch) {
      throw unconfiguredCdpError();
    }
    const binary = findLocalChromiumBinary(this.chromiumBinaryPath);
    if (binary === null) {
      throw unconfiguredCdpError();
    }
    return this.launchHeadlessChromium(binary, requestedProfileDir);
  }

  private launchHeadlessChromium(binary: string, requestedProfileDir: string): Promise<string> {
    const profileDir =
      requestedProfileDir.trim() !== ''
        ? requestedProfileDir.trim()
        : this.profileRootDir ?? join(process.cwd(), '.browser-remote-profile');
    mkdirSync(profileDir, { recursive: true });

    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-gpu',
      'about:blank',
    ];

    this.log(`[web-browser] auto-launching headless Chromium (${binary})`);
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.launchedProcess = child;

    return new Promise<string>((resolveEndpoint, rejectEndpoint) => {
      let settled = false;
      let stderrBuf = '';

      const cleanupListeners = () => {
        child.stderr?.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupListeners();
        void this.stopLaunchedProcess();
        rejectEndpoint(error);
      };

      const succeed = (wsUrl: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupListeners();
        this.launchedEndpoint = wsUrl;
        resolveEndpoint(wsUrl);
      };

      const onData = (chunk: Buffer | string) => {
        stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const match = /DevTools listening on (wss?:\/\/[^\s]+)/.exec(stderrBuf);
        if (match && match[1]) {
          succeed(match[1]);
        }
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(
          new Error(
            `Auto-launched Chromium exited before exposing a CDP endpoint (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      };

      const onError = (error: Error) => {
        fail(new Error(`Failed to auto-launch Chromium (${binary}): ${error.message}`));
      };

      const timer = setTimeout(() => {
        fail(new Error(`Timed out after ${CHROMIUM_LAUNCH_TIMEOUT_MS}ms waiting for Chromium CDP endpoint`));
      }, CHROMIUM_LAUNCH_TIMEOUT_MS);
      timer.unref?.();

      child.stderr?.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  private async stopLaunchedProcess(): Promise<void> {
    const child = this.launchedProcess;
    this.launchedProcess = null;
    this.launchedEndpoint = null;
    if (child === null || child.exitCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      this.log(`[web-browser] failed to terminate Chromium process: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          this.log(`[web-browser] SIGKILL Chromium ignored: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }, 2_000);
    forceTimer.unref?.();
  }

  private async resolveHostAddresses(host: string): Promise<{ addresses: string[] } | { error: string }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const records = await Promise.race([
        lookup(host, { all: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('DNS resolution timed out')), DNS_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      return { addresses: records.map((record) => record.address) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
