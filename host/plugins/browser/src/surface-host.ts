// Default BrowserSurfaceHost backed by the published F2 shell bridge (`ctx.shell`).
// F2 may register a richer `browserSurface` service (including native event push);
// commands keep the same policy/state behaviour either way.

import type { BackendEvents, ShellBridge, WindowRef } from '../../../kernel/api.ts';
import { parseIp, type IpAddress } from '../../../platform/net-policy/ip.ts';
import type {
  AgentNavigationPolicy, BrowserSurfaceCreateOptions, BrowserSurfaceHost, SurfaceEventCallbacks,
} from '../api.ts';
import type { JsonValue } from './command-result.ts';
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

const OP = {
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
  snapshot: 'browser.snapshot',
  click: 'browser.click',
  type: 'browser.typeText',
  inputFiles: 'browser.setInputFiles',
  scroll: 'browser.scroll',
  agentPolicy: 'browser.setAgentNavigationPolicy',
  resolveAgentHost: 'browser.resolveAgentHost',
} as const;

interface WindowPresence {
  exists: boolean;
}

export class ShellBrowserSurface implements BrowserSurfaceHost {
  private present = false;

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
    if (this.platform === 'darwin' || this.platform === 'win32') return 'embedded';
    if (this.platform === 'linux') return 'detached';
    return 'unsupported';
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

  async snapshot(options: { interactiveOnly: boolean; maxChars?: number }): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.snapshot, options);
  }

  async click(ref: string): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.click, { ref });
  }

  async typeText(ref: string, text: string): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.type, { ref, text });
  }

  async setInputFiles(ref: string, files: JsonValue): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.inputFiles, { ref, files });
  }

  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<JsonValue> {
    return this.shell.request<JsonValue>(OP.scroll, options);
  }

  async setAgentNavigationPolicy(policy: AgentNavigationPolicy): Promise<void> {
    await this.shell.request(OP.agentPolicy, {
      agentPrivateNetworkGuard: policy.agentPrivateNetworkGuard,
      agentAllowInsecureHttp: policy.agentAllowInsecureHttp,
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
    }
    return () => {
      if (this.subscriber === callbacks) this.subscriber = null;
    };
  }
}
