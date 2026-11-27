/**
 * Remote Chrome DevTools Protocol (CDP) BrowserSurfaceHost implementation.
 *
 * Connects to any CDP endpoint (`http://127.0.0.1:9222` or `ws://...`) using ONLY
 * Web-standard APIs (`globalThis.WebSocket`, `globalThis.fetch`, `URL`, `TextDecoder`,
 * `setTimeout`/`clearTimeout`) so this module is 100% portable with ZERO Node imports
 * or globals.
 */

import type { IpAddress } from '../../../platform/net-policy/api.ts';
import { isInternalIp, parseIp } from '../../../platform/net-policy/ip.ts';
import {
  allowNavigationWithOptions, isBlockedForAgent, navigationDenyMessage,
} from '../../../platform/net-policy/navigation.ts';
import type {
  AgentNavigationPolicy, BrowserSurfaceCreateOptions, BrowserSurfaceHost, SurfaceEventCallbacks,
} from '../api.ts';
import type { BridgeError, JsonValue } from './command-result.ts';

export interface BrowserScreencastFrame {
  dataBase64: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  sessionId: number;
  timestamp?: number;
}

export type BrowserRemoteInputEvent =
  | {
      kind: 'mouse';
      action: 'move' | 'down' | 'up' | 'click' | 'dblclick';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right';
      modifiers?: number;
      clickCount?: number;
    }
  | {
      kind: 'wheel';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      kind: 'key';
      action: 'down' | 'up' | 'press' | 'text';
      key?: string;
      code?: string;
      text?: string;
      modifiers?: number;
    }
  | {
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel' | 'keyDown' | 'keyUp' | 'insertText';
      x?: number;
      y?: number;
      button?: 'left' | 'middle' | 'right';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      key?: string;
      modifiers?: string[];
      text?: string;
    };

export interface BrowserTabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  isLoading?: boolean;
}

export interface BrowserScreenshotOptions {
  fullPage?: boolean;
  annotate?: boolean;
  maxWidth?: number;
  quality?: number;
}

export type BrowserScreenshotResult =
  | {
      available: true;
      capability: 'browser_visible_webview_screenshot';
      mimeType: 'image/png' | 'image/jpeg';
      dataBase64: string;
      width: number;
      height: number;
      annotated?: boolean;
    }
  | {
      available: false;
      capability: 'browser_visible_webview_screenshot';
      reasonCode: 'PLATFORM_API_UNAVAILABLE';
      reason: string;
    };

export type BrowserTarget =
  | { ref: string }
  | { x: number; y: number };

export interface BrowserWaitOptions {
  text?: string;
  selector?: string;
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
}

export interface RemoteCdpWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void;
  removeEventListener?(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void;
}

export interface RemoteCdpSurfaceOptions {
  /** HTTP endpoint (e.g. `http://127.0.0.1:9222`) or WebSocket URL (`ws://...`). */
  endpoint: string;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  webSocketFactory?: (url: string) => RemoteCdpWebSocketLike;
  fetchImpl?: typeof globalThis.fetch;
  resolveAgentHost?: (host: string, port: number) => Promise<IpAddress[] | string> | IpAddress[] | string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

interface PendingCommand {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

interface TrackedRef {
  backendDOMNodeId: number;
  role: string;
  name: string;
  isPassword: boolean;
}

interface CdpAXProperty {
  name?: string;
  value?: { value?: unknown };
}

interface CdpAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  properties?: CdpAXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
  url?: string;
}

interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status: number | null;
  statusText: string | null;
  failed: boolean;
  errorText: string | null;
  timestamp: string;
}

const WS_OPEN = 1;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_OBSERVE_BUFFER = 200;

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton',
  'listbox', 'treeitem', 'textarea',
]);

const STRUCTURAL_ROLES = new Set([
  'RootWebArea', 'WebArea', 'document', 'main', 'navigation', 'banner', 'contentinfo',
  'complementary', 'form', 'region', 'dialog', 'alertdialog', 'heading', 'list',
  'listitem', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'article', 'section',
  'Iframe', 'IframePresentational',
]);

const PASSWORD_PATTERN = /password|passwd|passcode|otp|one[-_ ]?time|totp|2fa|mfa|verification[-_ ]?code|验证码|密码/i;

const KEY_CODE_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};

function makeBridgeError(code: string, message: string, details: JsonValue | null = null): BridgeError {
  return { kind: 'Bridge', code, message, details };
}

function makeTimeoutError(milliseconds: number): BridgeError {
  return { kind: 'Timeout', milliseconds };
}

function modifierBitmask(modifiers?: readonly string[]): number {
  if (!modifiers || modifiers.length === 0) return 0;
  let mask = 0;
  for (const mod of modifiers) {
    switch (mod.toLowerCase()) {
      case 'alt': mask |= 1; break;
      case 'control':
      case 'ctrl': mask |= 2; break;
      case 'meta':
      case 'cmd':
      case 'command': mask |= 4; break;
      case 'shift': mask |= 8; break;
      default: break;
    }
  }
  return mask;
}

function parseAttributes(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(raw)) return map;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = raw[i];
    const value = raw[i + 1];
    if (typeof key === 'string') {
      map.set(key.toLowerCase(), typeof value === 'string' ? value : '');
    }
  }
  return map;
}

function isSensitiveNodeAttributes(nodeName: string, attrs: Map<string, string>): boolean {
  const type = (attrs.get('type') ?? '').trim().toLowerCase();
  if (type === 'password') return true;
  const autocomplete = (attrs.get('autocomplete') ?? '').trim().toLowerCase();
  if (autocomplete.includes('current-password')
    || autocomplete.includes('new-password')
    || autocomplete.includes('one-time-code')) {
    return true;
  }
  const tag = nodeName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const probes = [
      attrs.get('name') ?? '',
      attrs.get('id') ?? '',
      attrs.get('aria-label') ?? '',
      attrs.get('placeholder') ?? '',
    ];
    for (const probe of probes) {
      if (probe !== '' && PASSWORD_PATTERN.test(probe)) return true;
    }
  }
  return false;
}

function computeLineDiff(previous: string, current: string): string {
  if (previous === current) return '(no changes)';
  const prevLines = previous.split('\n');
  const nextLines = current.split('\n');
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const out: string[] = [];
  let unchangedStreak = 0;
  const flushUnchanged = (): void => {
    if (unchangedStreak > 0) {
      out.push(`  ... (${unchangedStreak} unchanged lines)`);
      unchangedStreak = 0;
    }
  };
  let i = 0;
  let j = 0;
  while (i < prevLines.length || j < nextLines.length) {
    const p = i < prevLines.length ? prevLines[i]! : null;
    const n = j < nextLines.length ? nextLines[j]! : null;
    if (p !== null && n !== null && p === n) {
      unchangedStreak += 1;
      i += 1;
      j += 1;
    } else if (p !== null && !nextSet.has(p)) {
      flushUnchanged();
      out.push(`- ${p}`);
      i += 1;
    } else if (n !== null && !prevSet.has(n)) {
      flushUnchanged();
      out.push(`+ ${n}`);
      j += 1;
    } else if (p !== null && n !== null) {
      flushUnchanged();
      out.push(`- ${p}`);
      out.push(`+ ${n}`);
      i += 1;
      j += 1;
    } else if (p !== null) {
      flushUnchanged();
      out.push(`- ${p}`);
      i += 1;
    } else if (n !== null) {
      flushUnchanged();
      out.push(`+ ${n}`);
      j += 1;
    }
  }
  flushUnchanged();
  return out.length === 0 ? '(no changes)' : out.join('\n');
}

function decodeWsMessage(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return null;
}

function defaultWebSocketFactory(url: string): RemoteCdpWebSocketLike {
  const Ctor = globalThis.WebSocket;
  if (typeof Ctor !== 'function') {
    throw new Error('globalThis.WebSocket is not available in this runtime');
  }
  return new Ctor(url) as unknown as RemoteCdpWebSocketLike;
}

export class RemoteCdpBrowserSurface implements BrowserSurfaceHost {
  private readonly endpoint: string;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly webSocketFactory: (url: string) => RemoteCdpWebSocketLike;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveAgentHostFn: ((host: string, port: number) => Promise<IpAddress[] | string> | IpAddress[] | string) | null;
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

  private ws: RemoteCdpWebSocketLike | null = null;
  private isBrowserLevelWs = false;
  private present = false;
  private activeTargetId: string | null = null;
  private activeSessionId: string | null = null;
  private readonly targetSessions = new Map<string, string>();
  private nextCommandId = 1;
  private readonly pending = new Map<number, PendingCommand>();

  private viewportWidth = 1_280;
  private viewportHeight = 720;
  private currentUrl = 'about:blank';
  private currentTitle = '';
  private snapshotEpoch = 0;
  private lastSnapshotText: string | null = null;
  private readonly refMap = new Map<string, TrackedRef>();

  private subscriber: SurfaceEventCallbacks | null = null;
  private screencastListener: ((frame: BrowserScreencastFrame) => void) | null = null;
  private screencastFormat: 'jpeg' | 'png' = 'jpeg';
  private screencastOptions: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number } | null = null;
  private navigationPolicy: AgentNavigationPolicy = {
    agentPrivateNetworkGuard: false,
    agentAllowInsecureHttp: false,
  };
  private readonly fetchEnabledSessions = new Set<string>();

  private readonly consoleBuffer: ConsoleEntry[] = [];
  private readonly networkBuffer: NetworkEntry[] = [];
  private readonly inflightRequests = new Set<string>();
  private lastNetworkActivityAt = 0;

  constructor(options: RemoteCdpSurfaceOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.resolveAgentHostFn = options.resolveAgentHost ?? null;
    this.log = options.log ?? (() => undefined);
  }

  hostMode(): string {
    return 'remote';
  }

  hasContentWindow(): boolean {
    return this.present;
  }

  async createContentWindow(options: BrowserSurfaceCreateOptions): Promise<void> {
    await this.assertUrlAllowed(options.url, true);
    this.viewportWidth = options.width;
    this.viewportHeight = options.height;
    await this.ensureConnected();

    if (this.isBrowserLevelWs) {
      const created = await this.sendCdp<{ targetId?: string }>('Target.createTarget', {
        url: options.url,
      });
      if (typeof created.targetId !== 'string' || created.targetId === '') {
        throw new Error('CDP Target.createTarget did not return a targetId');
      }
      this.activeTargetId = created.targetId;
      await this.attachTarget(created.targetId);
    } else {
      await this.enablePageDomains();
      await this.sendSessionCdp('Page.navigate', { url: options.url });
    }

    await this.applyViewportMetrics(this.viewportWidth, this.viewportHeight);
    this.currentUrl = options.url;
    this.currentTitle = options.title;
    this.lastSnapshotText = null;
    this.refMap.clear();
    this.inflightRequests.clear();
    this.lastNetworkActivityAt = Date.now();
    this.present = true;
  }

  async destroyContentWindow(): Promise<boolean> {
    await this.stopScreencast();
    if (this.ws !== null && this.isBrowserLevelWs && this.activeTargetId !== null) {
      const targetId = this.activeTargetId;
      try {
        await this.sendCdp('Target.closeTarget', { targetId });
      } catch (error) {
        this.log('warn', `[remote-cdp] closeTarget during destroy failed: ${String(error)}`);
      }
    }
    this.closeSocket('destroyContentWindow');
    this.present = false;
    this.activeTargetId = null;
    this.activeSessionId = null;
    this.targetSessions.clear();
    this.fetchEnabledSessions.clear();
    this.inflightRequests.clear();
    this.refMap.clear();
    this.lastSnapshotText = null;
    return true;
  }

  async navigate(url: string): Promise<void> {
    this.ensureSessionReady();
    await this.assertUrlAllowed(url, false);
    this.inflightRequests.clear();
    this.lastNetworkActivityAt = Date.now();
    await this.sendSessionCdp('Page.navigate', { url });
    this.currentUrl = url;
    this.refMap.clear();
    this.snapshotEpoch += 1;
  }

  async goBack(): Promise<void> {
    this.ensureSessionReady();
    const history = await this.sendSessionCdp<{
      currentIndex?: number;
      entries?: Array<{ id: number; url?: string }>;
    }>('Page.getNavigationHistory');
    const index = typeof history.currentIndex === 'number' ? history.currentIndex : 0;
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const target = entries[index - 1];
    if (target === undefined) throw new Error('cannot go back in remote CDP history');
    await this.sendSessionCdp('Page.navigateToHistoryEntry', { entryId: target.id });
    if (typeof target.url === 'string') this.currentUrl = target.url;
    this.refMap.clear();
    this.snapshotEpoch += 1;
  }

  async goForward(): Promise<void> {
    this.ensureSessionReady();
    const history = await this.sendSessionCdp<{
      currentIndex?: number;
      entries?: Array<{ id: number; url?: string }>;
    }>('Page.getNavigationHistory');
    const index = typeof history.currentIndex === 'number' ? history.currentIndex : 0;
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const target = entries[index + 1];
    if (target === undefined) throw new Error('cannot go forward in remote CDP history');
    await this.sendSessionCdp('Page.navigateToHistoryEntry', { entryId: target.id });
    if (typeof target.url === 'string') this.currentUrl = target.url;
    this.refMap.clear();
    this.snapshotEpoch += 1;
  }

  async reload(): Promise<void> {
    this.ensureSessionReady();
    await this.sendSessionCdp('Page.reload', {});
    this.refMap.clear();
    this.snapshotEpoch += 1;
  }

  async focusContentWindow(): Promise<void> {
    if (!this.present) return;
    try {
      await this.sendSessionCdp('Page.bringToFront', {});
    } catch (error) {
      this.log('debug', `[remote-cdp] bringToFront ignored: ${String(error)}`);
    }
  }

  async releaseContentFocus(): Promise<void> {
    // Remote CDP sessions have no local host focus to release.
  }

  async mainViewportSize(): Promise<{ width: number; height: number }> {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  async setContentBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    if (bounds.width > 0 && bounds.height > 0) {
      this.viewportWidth = Math.round(bounds.width);
      this.viewportHeight = Math.round(bounds.height);
      if (this.present) {
        await this.applyViewportMetrics(this.viewportWidth, this.viewportHeight);
      }
    }
  }

  async setContentOcclusions(
    _occlusions: readonly { x: number; y: number; width: number; height: number }[],
    _inputOcclusions: readonly { x: number; y: number; width: number; height: number }[],
  ): Promise<void> {
    // Remote CDP pages are rendered off-host; local CSS occlusions do not apply.
  }

  async setContentVisibility(_visible: boolean, _focus: boolean): Promise<void> {
    // Remote CDP pages remain live regardless of local pane visibility.
  }

  async setAgentNavigationPolicy(policy: AgentNavigationPolicy): Promise<void> {
    this.navigationPolicy = {
      agentPrivateNetworkGuard: policy.agentPrivateNetworkGuard,
      agentAllowInsecureHttp: policy.agentAllowInsecureHttp,
    };
    if (this.present && this.ws !== null && this.ws.readyState === WS_OPEN) {
      if (this.isBrowserLevelWs) {
        const sessionIds = new Set<string>(this.targetSessions.values());
        if (this.activeSessionId !== null) sessionIds.add(this.activeSessionId);
        for (const sid of sessionIds) {
          await this.syncFetchInterceptionForSession(sid);
        }
      } else {
        await this.syncFetchInterceptionForSession(undefined);
      }
    }
  }

  getAgentNavigationPolicy(): AgentNavigationPolicy {
    return { ...this.navigationPolicy };
  }

  subscribe(callbacks: SurfaceEventCallbacks): () => void {
    this.subscriber = callbacks;
    return () => {
      if (this.subscriber === callbacks) this.subscriber = null;
    };
  }

  // ---------------------------------------------------------------- ax-cdp snapshot

  async snapshot(options: {
    interactiveOnly: boolean;
    maxChars?: number;
    diff?: boolean;
    selector?: string;
  }): Promise<JsonValue> {
    this.ensureSessionReady();
    const axTree = await this.sendSessionCdp<{ nodes?: CdpAXNode[] }>('Accessibility.getFullAXTree', {});
    const nodes = Array.isArray(axTree.nodes) ? axTree.nodes : [];

    // Best-effort DOMSnapshot capture to detect shadow/iframe documents and password inputs.
    const passwordBackendIds = new Set<number>();
    let extraDocuments = 0;
    try {
      const domSnap = await this.sendSessionCdp<{
        documents?: Array<{
          nodes?: {
            backendNodeId?: number[];
            nodeName?: number[];
            attributes?: number[][];
          };
        }>;
        strings?: string[];
      }>('DOMSnapshot.captureSnapshot', { computedStyles: [] });
      const strings = Array.isArray(domSnap.strings) ? domSnap.strings : [];
      const documents = Array.isArray(domSnap.documents) ? domSnap.documents : [];
      if (documents.length > 1) extraDocuments = documents.length - 1;
      for (const doc of documents) {
        const backendIds = doc.nodes?.backendNodeId ?? [];
        const nodeNames = doc.nodes?.nodeName ?? [];
        const attrLists = doc.nodes?.attributes ?? [];
        for (let idx = 0; idx < backendIds.length; idx += 1) {
          const backendId = backendIds[idx];
          const pairs = attrLists[idx];
          if (typeof backendId !== 'number' || !Array.isArray(pairs)) continue;
          const attrMap = new Map<string, string>();
          for (let p = 0; p + 1 < pairs.length; p += 2) {
            const k = strings[pairs[p]!] ?? '';
            const v = strings[pairs[p + 1]!] ?? '';
            if (k !== '') attrMap.set(k.toLowerCase(), v);
          }
          const nameIdx = nodeNames[idx];
          const realNodeName = typeof nameIdx === 'number' ? (strings[nameIdx] ?? 'INPUT') : 'INPUT';
          if (isSensitiveNodeAttributes(realNodeName, attrMap)) {
            passwordBackendIds.add(backendId);
          }
        }
      }
    } catch (error) {
      this.log('debug', `[remote-cdp] DOMSnapshot.captureSnapshot optional step skipped: ${String(error)}`);
    }

    let scopedBackendId: number | null = null;
    if (typeof options.selector === 'string' && options.selector.trim() !== '') {
      try {
        const doc = await this.sendSessionCdp<{ root?: { nodeId?: number } }>('DOM.getDocument', { depth: 1 });
        const rootId = doc.root?.nodeId;
        if (typeof rootId === 'number') {
          const queried = await this.sendSessionCdp<{ nodeId?: number }>('DOM.querySelector', {
            nodeId: rootId,
            selector: options.selector.trim(),
          });
          if (typeof queried.nodeId === 'number' && queried.nodeId > 0) {
            const desc = await this.sendSessionCdp<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
              nodeId: queried.nodeId,
            });
            if (typeof desc.node?.backendNodeId === 'number') {
              scopedBackendId = desc.node.backendNodeId;
            }
          }
        }
      } catch (error) {
        this.log('debug', `[remote-cdp] selector scoping skipped: ${String(error)}`);
      }
    }

    const byId = new Map<string, CdpAXNode>();
    for (const node of nodes) byId.set(node.nodeId, node);

    let rootNodes = nodes.filter(node => !node.parentId || !byId.has(node.parentId));
    if (scopedBackendId !== null) {
      const matched = nodes.find(node => node.backendDOMNodeId === scopedBackendId);
      if (matched !== undefined) rootNodes = [matched];
    }

    this.refMap.clear();
    let refCounter = 0;
    const lines: string[] = [];
    const visited = new Set<string>();

    const visit = (node: CdpAXNode, depth: number): void => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      const role = typeof node.role?.value === 'string' ? node.role.value : '';
      const name = typeof node.name?.value === 'string' ? node.name.value.replace(/\s+/g, ' ').trim() : '';
      const rawValue = typeof node.value?.value === 'string' ? node.value.value : '';
      const isInteractive = INTERACTIVE_ROLES.has(role);
      const isStructural = STRUCTURAL_ROLES.has(role);
      const isText = role === 'StaticText' || role === 'InlineTextBox';

      let isPassword = typeof node.backendDOMNodeId === 'number'
        && passwordBackendIds.has(node.backendDOMNodeId);
      if (!isPassword && (role === 'textbox' || role === 'searchbox') && PASSWORD_PATTERN.test(name)) {
        isPassword = true;
      }

      const shouldEmit = !node.ignored && (
        isInteractive
        || (!options.interactiveOnly && (isStructural || (isText && name !== '')))
        || (options.interactiveOnly && isStructural && name !== '')
      );

      let nextDepth = depth;
      if (shouldEmit) {
        const parts: string[] = [role || 'node'];
        if (name !== '') parts.push(JSON.stringify(name));
        if (rawValue !== '') {
          parts.push(`value=${JSON.stringify(isPassword ? '[REDACTED]' : rawValue)}`);
        }
        if (node.properties) {
          for (const prop of node.properties) {
            if (prop.name === 'focused' && prop.value?.value === true) parts.push('focused');
            if (prop.name === 'disabled' && prop.value?.value === true) parts.push('disabled');
            if (prop.name === 'checked') {
              if (prop.value?.value === true || prop.value?.value === 'true') parts.push('checked');
              else if (prop.value?.value === 'mixed') parts.push('checked=mixed');
            }
            if (prop.name === 'expanded' && typeof prop.value?.value === 'boolean') {
              parts.push(`expanded=${String(prop.value.value)}`);
            }
          }
        }
        if (isInteractive && typeof node.backendDOMNodeId === 'number') {
          refCounter += 1;
          const ref = `e${refCounter}`;
          this.refMap.set(ref, {
            backendDOMNodeId: node.backendDOMNodeId,
            role,
            name,
            isPassword,
          });
          parts.push(`[ref=${ref}]`);
        }
        lines.push(`${'  '.repeat(Math.min(depth, 10))}${parts.join(' ')}`);
        nextDepth = depth + 1;
      }

      if (Array.isArray(node.childIds)) {
        for (const childId of node.childIds) {
          const child = byId.get(childId);
          if (child !== undefined) visit(child, nextDepth);
        }
      }
    };

    for (const root of rootNodes) visit(root, 0);
    if (extraDocuments > 0) {
      lines.push(`[frames/shadow_documents=${extraDocuments}]`);
    }

    const fullText = lines.join('\n');
    let outputText = fullText;
    const usedDiff = options.diff === true && this.lastSnapshotText !== null;
    if (usedDiff) {
      outputText = computeLineDiff(this.lastSnapshotText!, fullText);
    }
    this.lastSnapshotText = fullText;
    this.snapshotEpoch += 1;

    if (typeof options.maxChars === 'number' && options.maxChars > 0 && outputText.length > options.maxChars) {
      outputText = outputText.slice(0, options.maxChars);
    }

    return {
      text: outputText,
      epoch: this.snapshotEpoch,
      mode: 'ax-cdp',
      diff: usedDiff,
    };
  }

  // ---------------------------------------------------------------- trusted input

  async click(
    ref: string,
    options?: { doubleClick?: boolean; button?: 'left' | 'middle' | 'right' },
  ): Promise<JsonValue> {
    this.ensureSessionReady();
    const entry = this.requireRefEntry(ref);
    await this.assertNotPasswordOrOtp(ref, entry);
    const { x, y } = await this.resolveElementCenter(entry.backendDOMNodeId);
    await this.dispatchMouseClick(x, y, options);
    return { ok: true, ref, x, y };
  }

  async clickAt(
    x: number,
    y: number,
    options?: { doubleClick?: boolean; button?: 'left' | 'middle' | 'right' },
  ): Promise<JsonValue> {
    this.ensureSessionReady();
    await this.dispatchMouseClick(x, y, options);
    return { ok: true, x, y };
  }

  async typeText(
    ref: string,
    text: string,
    options?: { clear?: boolean; submit?: boolean },
  ): Promise<JsonValue> {
    this.ensureSessionReady();
    const entry = this.requireRefEntry(ref);
    await this.assertNotPasswordOrOtp(ref, entry);
    await this.scrollIntoViewBestEffort(entry.backendDOMNodeId);
    await this.sendSessionCdp('DOM.focus', { backendNodeId: entry.backendDOMNodeId });

    if (options?.clear === true) {
      await this.clearElementValue(entry.backendDOMNodeId);
    }
    await this.sendSessionCdp('Input.insertText', { text });
    if (options?.submit === true) {
      await this.dispatchKeySequence('Enter');
    }
    return {
      ok: true,
      ref,
      length: text.length,
      cleared: options?.clear === true,
      submitted: options?.submit === true,
    };
  }

  async hover(target: BrowserTarget): Promise<JsonValue> {
    this.ensureSessionReady();
    let x: number;
    let y: number;
    if ('ref' in target) {
      const entry = this.requireRefEntry(target.ref);
      const center = await this.resolveElementCenter(entry.backendDOMNodeId);
      x = center.x;
      y = center.y;
    } else {
      x = target.x;
      y = target.y;
    }
    await this.sendSessionCdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      modifiers: 0,
    });
    return { ok: true, x, y };
  }

  async pressKey(key: string, modifiers?: string[]): Promise<JsonValue> {
    this.ensureSessionReady();
    await this.dispatchKeySequence(key, modifiers);
    return { ok: true, key, modifiers: modifiers ?? [] };
  }

  async selectOption(ref: string, values: string[]): Promise<JsonValue> {
    this.ensureSessionReady();
    const entry = this.requireRefEntry(ref);
    const resolved = await this.sendSessionCdp<{ object?: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId: entry.backendDOMNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (typeof objectId !== 'string') {
      throw makeBridgeError('NOT_INTERACTABLE', `could not resolve DOM object for ${ref}`, { ref });
    }
    const callResult = await this.sendSessionCdp<{ result?: { value?: JsonValue } }>('Runtime.callFunctionOn', {
      objectId,
      arguments: [{ value: values }],
      returnByValue: true,
      functionDeclaration: `function(targetValues) {
        if (!this || this.tagName !== 'SELECT') {
          return { ok: false, code: 'NOT_INTERACTABLE', error: 'not a select element' };
        }
        const wanted = new Set(targetValues.map(String));
        const selected = [];
        for (const opt of Array.from(this.options)) {
          const match = wanted.has(opt.value) || wanted.has((opt.textContent || '').trim());
          if (match) {
            opt.selected = true;
            selected.push(opt.value);
            if (!this.multiple) break;
          } else if (this.multiple) {
            opt.selected = false;
          }
        }
        if (selected.length === 0) {
          return { ok: false, code: 'NOT_FOUND', error: 'no matching option found' };
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selected };
      }`,
    });
    const value = callResult.result?.value;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && value.ok === false) {
      const code = typeof value.code === 'string' ? value.code : 'NOT_INTERACTABLE';
      const message = typeof value.error === 'string' ? value.error : `selectOption failed for ${ref}`;
      throw makeBridgeError(code, message, { ref, values });
    }
    return value ?? { ok: true, ref, values };
  }

  async setInputFiles(ref: string, files: JsonValue): Promise<JsonValue> {
    this.ensureSessionReady();
    const entry = this.requireRefEntry(ref);
    await this.assertNotPasswordOrOtp(ref, entry);
    const paths: string[] = [];
    if (Array.isArray(files)) {
      for (const item of files) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.path === 'string') {
          paths.push(item.path);
        }
      }
    }
    if (paths.length === 0) {
      throw makeBridgeError('INVALID_ARGS', 'setInputFiles requires file entries with path for remote CDP', { ref });
    }
    await this.sendSessionCdp('DOM.setFileInputFiles', {
      backendNodeId: entry.backendDOMNodeId,
      files: paths,
    });
    return { ok: true, ref, count: paths.length };
  }

  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<JsonValue> {
    this.ensureSessionReady();
    const direction = (options.direction ?? 'down').toLowerCase();
    if (direction === 'top' || direction === 'bottom') {
      if (options.ref !== null && options.ref !== '') {
        const entry = this.requireRefEntry(options.ref);
        const resolved = await this.sendSessionCdp<{ object?: { objectId?: string } }>('DOM.resolveNode', {
          backendNodeId: entry.backendDOMNodeId,
        });
        const objectId = resolved.object?.objectId;
        if (typeof objectId !== 'string') {
          throw makeBridgeError('NOT_INTERACTABLE', `could not resolve DOM object for ${options.ref}`, { ref: options.ref });
        }
        await this.sendSessionCdp('Runtime.callFunctionOn', {
          objectId,
          arguments: [{ value: direction }],
          functionDeclaration: `function(dir) {
            this.scrollTop = dir === 'top' ? 0 : this.scrollHeight;
          }`,
        });
      } else {
        await this.evalValue(
          direction === 'top'
            ? 'window.scrollTo(0, 0)'
            : 'window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))',
        );
      }
      return { ok: true, direction, amount: null, ref: options.ref };
    }
    let x = Math.round(this.viewportWidth / 2);
    let y = Math.round(this.viewportHeight / 2);
    if (options.ref !== null && options.ref !== '') {
      const entry = this.requireRefEntry(options.ref);
      const center = await this.resolveElementCenter(entry.backendDOMNodeId);
      x = center.x;
      y = center.y;
    }
    const magnitude = typeof options.amount === 'number' && Number.isFinite(options.amount) && options.amount > 0
      ? options.amount
      : 480;
    let deltaX = 0;
    let deltaY = 0;
    switch (direction) {
      case 'up': deltaY = -magnitude; break;
      case 'left': deltaX = -magnitude; break;
      case 'right': deltaX = magnitude; break;
      case 'down':
      default: deltaY = magnitude; break;
    }
    await this.sendSessionCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
    return { ok: true, direction, amount: magnitude, ref: options.ref };
  }

  // ---------------------------------------------------------------- screenshot / wait / extract

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshotResult> {
    if (!this.present || this.ws === null || this.ws.readyState !== WS_OPEN) {
      return {
        available: false,
        capability: 'browser_visible_webview_screenshot',
        reasonCode: 'PLATFORM_API_UNAVAILABLE',
        reason: 'remote CDP browser session is not connected',
      };
    }

    const useJpeg = typeof options.quality === 'number' && options.quality < 100;
    const format: 'jpeg' | 'png' = useJpeg ? 'jpeg' : 'png';
    const quality = useJpeg ? Math.max(10, Math.min(99, Math.round(options.quality!))) : undefined;
    let overlayApplied = false;

    try {
      if (options.annotate === true && this.refMap.size > 0) {
        overlayApplied = await this.injectAnnotationOverlay();
      }
      const captureParams: Record<string, unknown> = {
        format,
        ...(quality === undefined ? {} : { quality }),
        ...(options.fullPage === true ? { captureBeyondViewport: true } : {}),
      };
      const shot = await this.sendSessionCdp<{ data?: string }>('Page.captureScreenshot', captureParams);
      if (typeof shot.data !== 'string' || shot.data === '') {
        return {
          available: false,
          capability: 'browser_visible_webview_screenshot',
          reasonCode: 'PLATFORM_API_UNAVAILABLE',
          reason: 'Page.captureScreenshot returned empty payload',
        };
      }
      let width = this.viewportWidth;
      let height = this.viewportHeight;
      try {
        const metrics = await this.sendSessionCdp<{
          cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
          cssContentSize?: { width?: number; height?: number };
        }>('Page.getLayoutMetrics');
        if (options.fullPage === true && metrics.cssContentSize) {
          width = Math.round(metrics.cssContentSize.width ?? width);
          height = Math.round(metrics.cssContentSize.height ?? height);
        } else if (metrics.cssLayoutViewport) {
          width = Math.round(metrics.cssLayoutViewport.clientWidth ?? width);
          height = Math.round(metrics.cssLayoutViewport.clientHeight ?? height);
        }
      } catch (error) {
        this.log('debug', `[remote-cdp] layout metrics fallback to cached viewport: ${String(error)}`);
      }
      return {
        available: true,
        capability: 'browser_visible_webview_screenshot',
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        dataBase64: shot.data,
        width,
        height,
        ...(overlayApplied ? { annotated: true } : {}),
      };
    } finally {
      if (overlayApplied) {
        await this.removeAnnotationOverlay();
      }
    }
  }

  async waitFor(options: BrowserWaitOptions): Promise<JsonValue> {
    this.ensureSessionReady();
    const timeoutMs = Math.max(100, Math.min(30_000, options.timeoutMs ?? 10_000));
    const started = Date.now();
    const deadline = started + timeoutMs;
    let quietSince: number | null = null;

    for (;;) {
      let matched = true;
      if (options.loadState !== undefined) {
        const ready = await this.evalValue<string>('document.readyState');
        if (options.loadState === 'networkidle') {
          const isQuietNow = ready === 'complete' && this.inflightRequests.size === 0;
          if (isQuietNow) {
            const nowMs = Date.now();
            if (quietSince === null) quietSince = nowMs;
            const quietMs = nowMs - Math.max(quietSince, this.lastNetworkActivityAt);
            matched = matched && quietMs >= 400;
          } else {
            quietSince = null;
            matched = false;
          }
        } else if (options.loadState === 'load') {
          matched = matched && ready === 'complete';
        } else {
          matched = matched && (ready === 'interactive' || ready === 'complete');
        }
      }
      if (matched && typeof options.selector === 'string' && options.selector !== '') {
        const found = await this.evalValue<boolean>(
          `Boolean(document.querySelector(${JSON.stringify(options.selector)}))`,
        );
        matched = matched && found === true;
      }
      if (matched && typeof options.text === 'string' && options.text !== '') {
        const found = await this.evalValue<boolean>(
          `Boolean(document.body && (document.body.innerText || '').includes(${JSON.stringify(options.text)}))`,
        );
        matched = matched && found === true;
      }
      if (matched) {
        return { ok: true, matched: true, elapsedMs: Date.now() - started };
      }
      if (Date.now() >= deadline) {
        throw makeTimeoutError(timeoutMs);
      }
      await new Promise<void>(resolve => { globalThis.setTimeout(resolve, 100); });
    }
  }

  async extractContent(options?: { maxChars?: number; startIndex?: number }): Promise<JsonValue> {
    this.ensureSessionReady();
    const extracted = await this.evalValue<{ url?: string; title?: string; markdown?: string }>(`(() => {
      const root = document.querySelector('main, article, [role="main"]') || document.body;
      if (!root) return { url: location.href, title: document.title || '', markdown: '' };
      const lines = [];
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
      const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 3) {
          const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
          if (text) lines.push(text);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName;
        if (skip.has(tag)) return;
        if (/^H[1-6]$/.test(tag)) {
          const text = (node.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text) lines.push('#'.repeat(Number(tag[1])) + ' ' + text);
          return;
        }
        if (tag === 'LI') {
          const text = (node.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text) lines.push('- ' + text);
          return;
        }
        if (tag === 'PRE') {
          const text = (node.innerText || '').trim();
          if (text) lines.push('\`\`\`\\n' + text + '\\n\`\`\`');
          return;
        }
        if (tag === 'A' && node.getAttribute('href')) {
          const text = (node.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text) lines.push('[' + text + '](' + node.href + ')');
          return;
        }
        for (const child of node.childNodes) walk(child);
      };
      walk(root);
      return { url: location.href, title: document.title || '', markdown: lines.join('\\n\\n') };
    })()`);

    const fullMarkdown = typeof extracted?.markdown === 'string' ? extracted.markdown : '';
    const startIndex = Math.max(0, options?.startIndex ?? 0);
    const maxChars = Math.max(500, Math.min(24_000, options?.maxChars ?? 8_000));
    const chars = [...fullMarkdown];
    const totalChars = chars.length;
    const slice = startIndex >= totalChars ? '' : chars.slice(startIndex, startIndex + maxChars).join('');
    const truncated = startIndex + slice.length < totalChars;
    return {
      url: typeof extracted?.url === 'string' ? extracted.url : this.currentUrl,
      title: typeof extracted?.title === 'string' ? extracted.title : this.currentTitle,
      markdown: slice,
      totalChars,
      truncated,
    };
  }

  // ---------------------------------------------------------------- tabs

  async listTabs(): Promise<BrowserTabInfo[]> {
    this.ensureSessionReady();
    if (!this.isBrowserLevelWs) {
      return [{
        tabId: this.activeTargetId ?? 'default',
        url: this.currentUrl,
        title: this.currentTitle,
        active: true,
      }];
    }
    const res = await this.sendCdp<{
      targetInfos?: Array<{ targetId: string; type: string; url?: string; title?: string }>;
    }>('Target.getTargets');
    const infos = Array.isArray(res.targetInfos) ? res.targetInfos : [];
    return infos
      .filter(info => info.type === 'page')
      .map(info => ({
        tabId: info.targetId,
        url: info.url ?? 'about:blank',
        title: info.title ?? '',
        active: info.targetId === this.activeTargetId,
      }));
  }

  async newTab(url: string): Promise<BrowserTabInfo> {
    this.ensureSessionReady();
    await this.assertUrlAllowed(url, true);
    if (!this.isBrowserLevelWs) {
      await this.navigate(url);
      return { tabId: this.activeTargetId ?? 'default', url, title: '', active: true };
    }
    const previousSessionId = this.activeSessionId;
    const created = await this.sendCdp<{ targetId?: string }>('Target.createTarget', { url });
    if (typeof created.targetId !== 'string' || created.targetId === '') {
      throw new Error('CDP Target.createTarget did not return a targetId');
    }
    await this.attachTarget(created.targetId);
    await this.sendCdp('Target.activateTarget', { targetId: created.targetId });
    this.activeTargetId = created.targetId;
    this.currentUrl = url;
    this.currentTitle = '';
    this.refMap.clear();
    this.lastSnapshotText = null;
    this.inflightRequests.clear();
    this.lastNetworkActivityAt = Date.now();
    this.snapshotEpoch += 1;
    await this.migrateScreencast(previousSessionId, this.activeSessionId);
    return { tabId: created.targetId, url, title: '', active: true };
  }

  async switchTab(tabId: string): Promise<BrowserTabInfo> {
    this.ensureSessionReady();
    if (!this.isBrowserLevelWs) {
      return { tabId: this.activeTargetId ?? tabId, url: this.currentUrl, title: this.currentTitle, active: true };
    }
    const previousSessionId = this.activeSessionId;
    await this.sendCdp('Target.activateTarget', { targetId: tabId });
    await this.attachTarget(tabId);
    this.activeTargetId = tabId;
    this.refMap.clear();
    this.lastSnapshotText = null;
    this.inflightRequests.clear();
    this.lastNetworkActivityAt = Date.now();
    this.snapshotEpoch += 1;
    await this.migrateScreencast(previousSessionId, this.activeSessionId);
    const tabs = await this.listTabs();
    const matched = tabs.find(tab => tab.tabId === tabId);
    if (matched) {
      this.currentUrl = matched.url;
      this.currentTitle = matched.title;
      return matched;
    }
    return { tabId, url: this.currentUrl, title: this.currentTitle, active: true };
  }

  async closeTab(tabId: string): Promise<JsonValue> {
    this.ensureSessionReady();
    if (!this.isBrowserLevelWs) {
      return {
        closed: false,
        tabId,
        activeTabId: this.activeTargetId ?? 'default',
        remainingCount: 1,
        activeTab: {
          tabId: this.activeTargetId ?? 'default',
          url: this.currentUrl,
          title: this.currentTitle,
          active: true,
        },
        reason: 'single page target mode',
      };
    }
    const closingSessionId = this.targetSessions.get(tabId) ?? null;
    const wasActive = this.activeTargetId === tabId;
    if (wasActive && this.screencastListener !== null && closingSessionId !== null) {
      try {
        await this.sendCdp('Page.stopScreencast', {}, closingSessionId);
      } catch (error) {
        this.log('debug', `[remote-cdp] stopScreencast before closeTab ignored: ${String(error)}`);
      }
    }
    await this.sendCdp('Target.closeTarget', { targetId: tabId });
    this.targetSessions.delete(tabId);
    if (closingSessionId !== null) {
      this.fetchEnabledSessions.delete(closingSessionId);
    }
    if (wasActive) {
      this.activeTargetId = null;
      this.activeSessionId = null;
    }
    const remaining = await this.listTabs();
    if (remaining.length === 0) {
      this.present = false;
      this.activeTargetId = null;
      this.activeSessionId = null;
      this.refMap.clear();
      this.lastSnapshotText = null;
      this.inflightRequests.clear();
      return {
        closed: true,
        tabId,
        activeTabId: null,
        remainingCount: 0,
        activeTab: null,
      };
    }
    let activeTab: BrowserTabInfo | null = null;
    if (wasActive) {
      const next = remaining[0]!;
      activeTab = await this.switchTab(next.tabId);
    } else {
      activeTab = remaining.find(tab => tab.tabId === this.activeTargetId) ?? remaining[0] ?? null;
    }
    return {
      closed: true,
      tabId,
      activeTabId: activeTab?.tabId ?? null,
      remainingCount: remaining.length,
      activeTab: activeTab as unknown as JsonValue,
    };
  }

  // ---------------------------------------------------------------- observe

  async consoleLogs(options?: { level?: string; limit?: number }): Promise<JsonValue> {
    const levelFilter = options?.level?.trim().toLowerCase() ?? '';
    const limit = Math.max(1, Math.min(MAX_OBSERVE_BUFFER, options?.limit ?? 50));
    const filtered = levelFilter === ''
      ? this.consoleBuffer
      : this.consoleBuffer.filter(entry => entry.level.toLowerCase() === levelFilter);
    return filtered.slice(-limit) as unknown as JsonValue;
  }

  async networkLogs(options?: { statusMin?: number; limit?: number }): Promise<JsonValue> {
    const statusMin = typeof options?.statusMin === 'number' ? options.statusMin : null;
    const limit = Math.max(1, Math.min(MAX_OBSERVE_BUFFER, options?.limit ?? 50));
    const filtered = statusMin === null
      ? this.networkBuffer
      : this.networkBuffer.filter(entry => (entry.status !== null && entry.status >= statusMin) || entry.failed);
    return filtered.slice(-limit) as unknown as JsonValue;
  }

  // ---------------------------------------------------------------- screencast & remote input

  async startScreencast(
    onFrame: (frame: BrowserScreencastFrame) => void,
    options?: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number },
  ): Promise<void> {
    this.ensureSessionReady();
    this.screencastListener = onFrame;
    this.screencastFormat = options?.format ?? 'jpeg';
    this.screencastOptions = options ? { ...options } : {};
    await this.sendSessionCdp('Page.startScreencast', {
      format: this.screencastFormat,
      quality: this.screencastOptions.quality ?? 60,
      maxWidth: this.screencastOptions.maxWidth ?? this.viewportWidth,
      maxHeight: this.screencastOptions.maxHeight ?? this.viewportHeight,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(): Promise<void> {
    this.screencastListener = null;
    this.screencastOptions = null;
    if (!this.present || this.ws === null || this.ws.readyState !== WS_OPEN) return;
    try {
      await this.sendSessionCdp('Page.stopScreencast', {});
    } catch (error) {
      this.log('debug', `[remote-cdp] stopScreencast ignored: ${String(error)}`);
    }
  }

  private async migrateScreencast(previousSessionId: string | null, nextSessionId: string | null): Promise<void> {
    if (this.screencastListener === null) return;
    if (previousSessionId !== null && previousSessionId !== nextSessionId) {
      try {
        await this.sendCdp('Page.stopScreencast', {}, previousSessionId);
      } catch (error) {
        this.log('debug', `[remote-cdp] stopScreencast on previous tab ignored: ${String(error)}`);
      }
    }
    if (nextSessionId !== null && nextSessionId !== previousSessionId) {
      try {
        await this.sendCdp('Page.startScreencast', {
          format: this.screencastFormat,
          quality: this.screencastOptions?.quality ?? 60,
          maxWidth: this.screencastOptions?.maxWidth ?? this.viewportWidth,
          maxHeight: this.screencastOptions?.maxHeight ?? this.viewportHeight,
          everyNthFrame: 1,
        }, nextSessionId);
      } catch (error) {
        this.log('debug', `[remote-cdp] startScreencast on switched tab failed: ${String(error)}`);
      }
    }
  }

  private buildKeyEventParams(
    type: 'keyDown' | 'keyUp',
    key: string,
    modifiers: number,
    explicitCode?: string,
    explicitText?: string,
  ): Record<string, unknown> {
    const mapped = KEY_CODE_MAP[key];
    const code = explicitCode !== undefined && explicitCode !== ''
      ? explicitCode
      : (mapped?.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key));
    const keyCode = mapped?.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const text = type === 'keyDown'
      ? (explicitText !== undefined
        ? explicitText
        : (mapped?.text ?? (key.length === 1 && modifiers === 0 ? key : undefined)))
      : undefined;
    return {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
    };
  }

  async remoteInput(event: BrowserRemoteInputEvent): Promise<void> {
    this.ensureSessionReady();
    if ('type' in event) {
      if (event.type === 'insertText') {
        await this.sendSessionCdp('Input.insertText', { text: event.text ?? '' });
      } else if (event.type === 'keyDown' || event.type === 'keyUp') {
        const mask = modifierBitmask(event.modifiers);
        await this.sendSessionCdp(
          'Input.dispatchKeyEvent',
          this.buildKeyEventParams(event.type, event.key ?? '', mask, undefined, event.text),
        );
      } else if (event.type === 'mouseWheel') {
        await this.sendSessionCdp('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: event.x ?? 0,
          y: event.y ?? 0,
          deltaX: event.deltaX ?? 0,
          deltaY: event.deltaY ?? 0,
          modifiers: modifierBitmask(event.modifiers),
        });
      } else {
        await this.sendSessionCdp('Input.dispatchMouseEvent', {
          type: event.type,
          x: event.x ?? 0,
          y: event.y ?? 0,
          button: event.type === 'mouseMoved' ? 'none' : (event.button ?? 'left'),
          clickCount: event.clickCount ?? 1,
          modifiers: modifierBitmask(event.modifiers),
        });
      }
      return;
    }
    if (event.kind === 'mouse') {
      const button = event.button ?? 'left';
      const modifiers = event.modifiers ?? 0;
      if (event.action === 'move') {
        await this.sendSessionCdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: event.x, y: event.y, button: 'none', modifiers,
        });
      } else if (event.action === 'down') {
        await this.sendSessionCdp('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: event.x, y: event.y, button, modifiers, clickCount: event.clickCount ?? 1,
        });
      } else if (event.action === 'up') {
        await this.sendSessionCdp('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: event.x, y: event.y, button, modifiers, clickCount: event.clickCount ?? 1,
        });
      } else {
        await this.dispatchMouseClick(event.x, event.y, {
          doubleClick: event.action === 'dblclick',
          button,
        });
      }
      return;
    }
    if (event.kind === 'wheel') {
      await this.sendSessionCdp('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: event.modifiers ?? 0,
      });
      return;
    }
    if (event.kind === 'key') {
      const modifiers = event.modifiers ?? 0;
      if (event.action === 'text') {
        await this.sendSessionCdp('Input.insertText', { text: event.text ?? '' });
      } else if (event.action === 'down') {
        await this.sendSessionCdp(
          'Input.dispatchKeyEvent',
          this.buildKeyEventParams('keyDown', event.key ?? '', modifiers, event.code, event.text),
        );
      } else if (event.action === 'up') {
        await this.sendSessionCdp(
          'Input.dispatchKeyEvent',
          this.buildKeyEventParams('keyUp', event.key ?? '', modifiers, event.code),
        );
      } else {
        await this.dispatchKeySequence(event.key ?? '', undefined, modifiers);
      }
    }
  }

  // ---------------------------------------------------------------- CDP transport internals

  private async ensureConnected(): Promise<void> {
    if (this.ws !== null && this.ws.readyState === WS_OPEN) return;
    const { wsUrl, browserLevel } = await this.resolveWebSocketUrl();
    await this.openSocket(wsUrl, browserLevel);
  }

  private async resolveWebSocketUrl(): Promise<{ wsUrl: string; browserLevel: boolean }> {
    if (this.endpoint.startsWith('ws://') || this.endpoint.startsWith('wss://')) {
      const isPage = this.endpoint.includes('/devtools/page/');
      return { wsUrl: this.endpoint, browserLevel: !isPage };
    }
    if (!this.endpoint.startsWith('http://') && !this.endpoint.startsWith('https://')) {
      throw new Error(`Unsupported CDP endpoint scheme: ${this.endpoint}`);
    }

    try {
      const versionResp = await this.fetchImpl(`${this.endpoint}/json/version`);
      if (versionResp.ok) {
        const versionJson = await versionResp.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof versionJson.webSocketDebuggerUrl === 'string' && versionJson.webSocketDebuggerUrl !== '') {
          return { wsUrl: versionJson.webSocketDebuggerUrl, browserLevel: true };
        }
      }
    } catch (error) {
      this.log('debug', `[remote-cdp] /json/version lookup fell back to /json/list: ${String(error)}`);
    }

    const listResp = await this.fetchImpl(`${this.endpoint}/json/list`);
    if (!listResp.ok) {
      throw new Error(`CDP target discovery failed: HTTP ${listResp.status}`);
    }
    const listJson = await listResp.json() as Array<{ type?: string; id?: string; webSocketDebuggerUrl?: string }>;
    const pageTarget = Array.isArray(listJson)
      ? listJson.find(item => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string')
      : undefined;
    if (pageTarget === undefined || typeof pageTarget.webSocketDebuggerUrl !== 'string') {
      throw new Error('CDP /json/list returned no attachable page target');
    }
    if (typeof pageTarget.id === 'string') this.activeTargetId = pageTarget.id;
    return { wsUrl: pageTarget.webSocketDebuggerUrl, browserLevel: false };
  }

  private openSocket(wsUrl: string, browserLevel: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.webSocketFactory(wsUrl);
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (error) { this.log('debug', `[remote-cdp] timed-out socket close ignored: ${String(error)}`); }
        reject(new Error(`CDP WebSocket connect timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      const onOpen = (): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        this.ws = socket;
        this.isBrowserLevelWs = browserLevel;
        resolve();
      };

      const onError = (event: unknown): void => {
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(timer);
          reject(new Error(`CDP WebSocket connection error: ${String(event)}`));
        }
      };

      const onClose = (): void => {
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(timer);
          reject(new Error('CDP WebSocket closed before opening'));
          return;
        }
        this.handleSocketClosed('remote peer closed');
      };

      const onMessage = (event: unknown): void => {
        const raw = event !== null && typeof event === 'object' && 'data' in event
          ? (event as { data: unknown }).data
          : event;
        const text = decodeWsMessage(raw);
        if (text !== null) this.handleMessage(text);
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      socket.addEventListener('message', onMessage);

      if (socket.readyState === WS_OPEN) {
        onOpen();
      }
    });
  }

  private closeSocket(reason: string): void {
    const socket = this.ws;
    this.ws = null;
    this.rejectAllPending(new Error(`CDP connection closed: ${reason}`));
    if (socket !== null) {
      try { socket.close(1000, reason); }
      catch (error) { this.log('debug', `[remote-cdp] socket close ignored: ${String(error)}`); }
    }
  }

  private handleSocketClosed(reason: string): void {
    this.ws = null;
    this.present = false;
    this.fetchEnabledSessions.clear();
    this.inflightRequests.clear();
    this.rejectAllPending(new Error(`CDP connection closed: ${reason}`));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      globalThis.clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      this.log('warn', `[remote-cdp] ignored malformed JSON frame: ${String(error)}`);
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (pending === undefined) return;
      this.pending.delete(msg.id);
      globalThis.clearTimeout(pending.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const errObj = msg.error as { message?: string; code?: number };
        pending.reject(new Error(`CDP ${pending.method} failed: ${errObj.message ?? JSON.stringify(msg.error)}`));
      } else {
        pending.resolve((msg.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    if (typeof msg.method === 'string') {
      const msgSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
      this.handleCdpEvent(msg.method, (msg.params ?? {}) as Record<string, unknown>, msgSessionId);
    }
  }

  private handleCdpEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (method === 'Fetch.requestPaused') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : '';
      const req = params.request as { url?: string } | undefined;
      const reqUrl = typeof req?.url === 'string' ? req.url : '';
      if (requestId !== '') {
        void this.handleFetchRequestPaused(requestId, reqUrl, sessionId);
      }
      return;
    }

    const isOtherTabSession = this.isBrowserLevelWs
      && this.activeSessionId !== null
      && sessionId !== undefined
      && sessionId !== this.activeSessionId;

    switch (method) {
      case 'Page.frameNavigated': {
        if (isOtherTabSession) break;
        const frame = params.frame as { parentId?: string; url?: string } | undefined;
        if (frame && !frame.parentId && typeof frame.url === 'string') {
          this.currentUrl = frame.url;
          this.refMap.clear();
          this.subscriber?.pageFinished(frame.url);
        }
        break;
      }
      case 'Page.loadEventFired': {
        if (isOtherTabSession) break;
        this.subscriber?.pageFinished(this.currentUrl);
        break;
      }
      case 'Page.screencastFrame': {
        const frameSessionId = typeof params.sessionId === 'number' ? params.sessionId : 0;
        const dataBase64 = typeof params.data === 'string' ? params.data : '';
        const meta = (params.metadata ?? {}) as {
          deviceWidth?: number; deviceHeight?: number; timestamp?: number;
        };
        const ackSessionId = sessionId ?? this.activeSessionId ?? undefined;
        // Immediately acknowledge frame on the emitting CDP session so Chrome keeps streaming.
        void this.sendCdp('Page.screencastFrameAck', { sessionId: frameSessionId }, ackSessionId)
          .catch((error: unknown) => {
            this.log('debug', `[remote-cdp] screencastFrameAck failed: ${String(error)}`);
          });
        if (!isOtherTabSession && this.screencastListener !== null && dataBase64 !== '') {
          this.screencastListener({
            dataBase64,
            mimeType: this.screencastFormat === 'png' ? 'image/png' : 'image/jpeg',
            width: Math.round(meta.deviceWidth ?? this.viewportWidth),
            height: Math.round(meta.deviceHeight ?? this.viewportHeight),
            sessionId: frameSessionId,
            ...(typeof meta.timestamp === 'number' ? { timestamp: meta.timestamp } : {}),
          });
        }
        break;
      }
      case 'Runtime.consoleAPICalled': {
        if (isOtherTabSession) break;
        const level = typeof params.type === 'string' ? params.type : 'log';
        const args = Array.isArray(params.args) ? params.args : [];
        const text = args
          .map(item => {
            if (item !== null && typeof item === 'object') {
              const obj = item as { value?: unknown; description?: string };
              if (obj.value !== undefined) return String(obj.value);
              if (typeof obj.description === 'string') return obj.description;
            }
            return String(item);
          })
          .join(' ');
        this.pushConsole({ level, text, timestamp: new Date().toISOString() });
        break;
      }
      case 'Log.entryAdded': {
        if (isOtherTabSession) break;
        const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
        if (entry) {
          this.pushConsole({
            level: entry.level ?? 'info',
            text: entry.text ?? '',
            timestamp: new Date().toISOString(),
            ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
          });
        }
        break;
      }
      case 'Network.requestWillBeSent': {
        if (isOtherTabSession) break;
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const req = params.request as { url?: string; method?: string } | undefined;
        if (requestId !== '') {
          this.inflightRequests.add(requestId);
          this.lastNetworkActivityAt = Date.now();
          this.pushNetwork({
            requestId,
            url: req?.url ?? '',
            method: req?.method ?? 'GET',
            status: null,
            statusText: null,
            failed: false,
            errorText: null,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }
      case 'Network.responseReceived': {
        if (isOtherTabSession) break;
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const resp = params.response as { status?: number; statusText?: string; url?: string } | undefined;
        const existing = this.networkBuffer.find(entry => entry.requestId === requestId);
        if (existing) {
          existing.status = typeof resp?.status === 'number' ? resp.status : existing.status;
          existing.statusText = typeof resp?.statusText === 'string' ? resp.statusText : existing.statusText;
        } else if (requestId !== '') {
          this.pushNetwork({
            requestId,
            url: resp?.url ?? '',
            method: 'GET',
            status: typeof resp?.status === 'number' ? resp.status : null,
            statusText: typeof resp?.statusText === 'string' ? resp.statusText : null,
            failed: false,
            errorText: null,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }
      case 'Network.loadingFinished': {
        if (isOtherTabSession) break;
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (requestId !== '') {
          this.inflightRequests.delete(requestId);
          this.lastNetworkActivityAt = Date.now();
        }
        break;
      }
      case 'Network.loadingFailed': {
        if (isOtherTabSession) break;
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        this.inflightRequests.delete(requestId);
        this.lastNetworkActivityAt = Date.now();
        const existing = this.networkBuffer.find(entry => entry.requestId === requestId);
        const errorText = typeof params.errorText === 'string' ? params.errorText : 'loading failed';
        if (existing) {
          existing.failed = true;
          existing.errorText = errorText;
        } else if (requestId !== '') {
          this.pushNetwork({
            requestId,
            url: '',
            method: 'GET',
            status: null,
            statusText: null,
            failed: true,
            errorText,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private async evaluateUrlPolicy(url: string, allowBlankForNonAgent: boolean): Promise<string | null> {
    if (allowBlankForNonAgent && !this.navigationPolicy.agentPrivateNetworkGuard && url === 'about:blank') {
      return null;
    }
    const effectiveAllowHttp = !this.navigationPolicy.agentPrivateNetworkGuard
      || this.navigationPolicy.agentAllowInsecureHttp;
    const denial = allowNavigationWithOptions(url, effectiveAllowHttp);
    if (denial !== null) {
      return navigationDenyMessage(denial);
    }
    if (this.navigationPolicy.agentPrivateNetworkGuard) {
      if (isBlockedForAgent(url)) {
        return 'private/internal address literal is blocked for agent navigation';
      }
      if (this.resolveAgentHostFn !== null) {
        let parsed: URL;
        try { parsed = new URL(url); }
        catch { return 'invalid URL'; }
        const host = parsed.hostname;
        const literal = host.startsWith('[') && host.endsWith(']')
          ? parseIp(host.slice(1, -1))
          : parseIp(host);
        if (literal === null && host !== '') {
          const port = parsed.port !== ''
            ? Number(parsed.port)
            : parsed.protocol === 'http:' ? 80 : 443;
          let resolved: IpAddress[] | string;
          try {
            resolved = await this.resolveAgentHostFn(host, port);
          } catch (error) {
            return `DNS resolver unavailable: ${error instanceof Error ? error.message : String(error)}`;
          }
          if (typeof resolved === 'string') return resolved;
          if (resolved.length === 0) return 'DNS resolution returned no addresses';
          if (resolved.some(addr => isInternalIp(addr))) {
            return 'DNS resolved to private/internal address';
          }
        }
      }
    }
    return null;
  }

  private async assertUrlAllowed(url: string, allowBlankForNonAgent: boolean): Promise<void> {
    const reason = await this.evaluateUrlPolicy(url, allowBlankForNonAgent);
    if (reason !== null) {
      this.subscriber?.navigationBlocked(url, reason);
      throw new Error(`navigation_blocked: ${reason}`);
    }
  }

  private async syncFetchInterceptionForSession(sessionId?: string): Promise<void> {
    if (this.ws === null || this.ws.readyState !== WS_OPEN) return;
    const key = sessionId ?? '__default__';
    if (this.navigationPolicy.agentPrivateNetworkGuard) {
      if (this.fetchEnabledSessions.has(key)) return;
      try {
        await this.sendCdp('Fetch.enable', {
          patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
        }, sessionId);
        this.fetchEnabledSessions.add(key);
      } catch (error) {
        this.log('debug', `[remote-cdp] Fetch.enable skipped: ${String(error)}`);
      }
      return;
    }
    if (this.fetchEnabledSessions.has(key)) {
      this.fetchEnabledSessions.delete(key);
      try {
        await this.sendCdp('Fetch.disable', {}, sessionId);
      } catch (error) {
        this.log('debug', `[remote-cdp] Fetch.disable skipped: ${String(error)}`);
      }
    }
  }

  private async handleFetchRequestPaused(
    requestId: string,
    url: string,
    sessionId?: string,
  ): Promise<void> {
    const reason = this.navigationPolicy.agentPrivateNetworkGuard
      ? await this.evaluateUrlPolicy(url, false)
      : null;
    if (reason !== null) {
      this.subscriber?.navigationBlocked(url, reason);
      try {
        await this.sendCdp('Fetch.failRequest', {
          requestId,
          errorReason: 'BlockedByClient',
        }, sessionId);
      } catch (error) {
        this.log('debug', `[remote-cdp] Fetch.failRequest failed: ${String(error)}`);
      }
      return;
    }
    try {
      await this.sendCdp('Fetch.continueRequest', { requestId }, sessionId);
    } catch (error) {
      this.log('debug', `[remote-cdp] Fetch.continueRequest failed: ${String(error)}`);
    }
  }

  private pushConsole(entry: ConsoleEntry): void {
    if (this.consoleBuffer.length >= MAX_OBSERVE_BUFFER) this.consoleBuffer.shift();
    this.consoleBuffer.push(entry);
  }

  private pushNetwork(entry: NetworkEntry): void {
    if (this.networkBuffer.length >= MAX_OBSERVE_BUFFER) this.networkBuffer.shift();
    this.networkBuffer.push(entry);
  }

  private async attachTarget(targetId: string): Promise<void> {
    const existing = this.targetSessions.get(targetId);
    if (existing !== undefined) {
      this.activeSessionId = existing;
      await this.syncFetchInterceptionForSession(existing);
      return;
    }
    const attached = await this.sendCdp<{ sessionId?: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== 'string' || attached.sessionId === '') {
      throw new Error(`CDP Target.attachToTarget did not return sessionId for ${targetId}`);
    }
    this.targetSessions.set(targetId, attached.sessionId);
    this.activeSessionId = attached.sessionId;
    await this.enablePageDomains();
  }

  private async enablePageDomains(): Promise<void> {
    const domains = ['Page.enable', 'DOM.enable', 'Runtime.enable', 'Accessibility.enable', 'Network.enable', 'Log.enable'];
    for (const method of domains) {
      try {
        await this.sendSessionCdp(method, {});
      } catch (error) {
        this.log('debug', `[remote-cdp] optional domain ${method} skipped: ${String(error)}`);
      }
    }
    await this.syncFetchInterceptionForSession(this.activeSessionId ?? undefined);
  }

  private async applyViewportMetrics(width: number, height: number): Promise<void> {
    try {
      await this.sendSessionCdp('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch (error) {
      this.log('debug', `[remote-cdp] setDeviceMetricsOverride skipped: ${String(error)}`);
    }
  }

  private ensureSessionReady(): void {
    if (!this.present || this.ws === null || this.ws.readyState !== WS_OPEN) {
      throw makeBridgeError('NOT_READY', 'remote CDP browser session is not open');
    }
  }

  private sendSessionCdp<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    return this.sendCdp<T>(method, params, this.activeSessionId ?? undefined, timeoutMs);
  }

  private sendCdp<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    const socket = this.ws;
    if (socket === null || socket.readyState !== WS_OPEN) {
      return Promise.reject(new Error(`CDP socket is not open for ${method}`));
    }
    const id = this.nextCommandId;
    this.nextCommandId += 1;
    const effectiveTimeout = timeoutMs ?? this.commandTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(makeTimeoutError(effectiveTimeout));
      }, effectiveTimeout);

      this.pending.set(id, {
        method,
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer,
      });

      const payload: Record<string, unknown> = { id, method };
      if (params !== undefined) payload.params = params;
      if (sessionId !== undefined) payload.sessionId = sessionId;
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        globalThis.clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private requireRefEntry(ref: string): TrackedRef {
    const entry = this.refMap.get(ref);
    if (entry === undefined) {
      throw makeBridgeError('REF_NOT_FOUND', `ref ${ref} was not found in the latest snapshot`, { ref });
    }
    return entry;
  }

  private async assertNotPasswordOrOtp(ref: string, entry: TrackedRef): Promise<void> {
    if (entry.isPassword) {
      throw makeBridgeError(
        'BLOCKED',
        'password or OTP fields cannot be accessed by agent bridge',
        { reason: 'password_field', ref },
      );
    }
    const described = await this.sendSessionCdp<{
      node?: { nodeName?: string; attributes?: unknown };
    }>('DOM.describeNode', { backendNodeId: entry.backendDOMNodeId });
    const nodeName = described.node?.nodeName ?? '';
    const attrs = parseAttributes(described.node?.attributes);
    if (isSensitiveNodeAttributes(nodeName, attrs)) {
      entry.isPassword = true;
      throw makeBridgeError(
        'BLOCKED',
        'password or OTP fields cannot be accessed by agent bridge',
        { reason: 'password_field', ref },
      );
    }
  }

  private async scrollIntoViewBestEffort(backendNodeId: number): Promise<void> {
    try {
      await this.sendSessionCdp('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch (error) {
      this.log('debug', `[remote-cdp] scrollIntoViewIfNeeded skipped: ${String(error)}`);
    }
  }

  private async resolveElementCenter(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.scrollIntoViewBestEffort(backendNodeId);
    const box = await this.sendSessionCdp<{
      model?: { content?: number[]; border?: number[] };
    }>('DOM.getBoxModel', { backendNodeId });
    const quad = box.model?.content ?? box.model?.border;
    if (!Array.isArray(quad) || quad.length < 8) {
      throw makeBridgeError('NOT_INTERACTABLE', 'target element has no layout box model', null);
    }
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    if (width <= 0 || height <= 0) {
      throw makeBridgeError('NOT_INTERACTABLE', 'target element has zero layout area', null);
    }
    const x = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
    const y = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
    return { x, y };
  }

  private async dispatchMouseClick(
    x: number,
    y: number,
    options?: { doubleClick?: boolean; button?: 'left' | 'middle' | 'right' },
  ): Promise<void> {
    const button = options?.button ?? 'left';
    const clicks = options?.doubleClick === true ? 2 : 1;
    await this.sendSessionCdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', modifiers: 0,
    });
    for (let clickCount = 1; clickCount <= clicks; clickCount += 1) {
      await this.sendSessionCdp('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, modifiers: 0, clickCount,
      });
      await this.sendSessionCdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, modifiers: 0, clickCount,
      });
    }
  }

  private async clearElementValue(backendNodeId: number): Promise<void> {
    try {
      const resolved = await this.sendSessionCdp<{ object?: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId,
      });
      if (typeof resolved.object?.objectId === 'string') {
        await this.sendSessionCdp('Runtime.callFunctionOn', {
          objectId: resolved.object.objectId,
          functionDeclaration: `function() {
            if ('value' in this) {
              this.value = '';
              this.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (this.isContentEditable) {
              this.textContent = '';
            }
          }`,
        });
        return;
      }
    } catch (error) {
      this.log('debug', `[remote-cdp] clear via callFunctionOn fell back to Backspace: ${String(error)}`);
    }
    await this.dispatchKeySequence('a', ['Control']);
    await this.dispatchKeySequence('Backspace');
  }

  private async dispatchKeySequence(key: string, modifiers?: string[], explicitMask?: number): Promise<void> {
    const mask = explicitMask ?? modifierBitmask(modifiers);
    const mapped = KEY_CODE_MAP[key];
    const code = mapped?.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
    const keyCode = mapped?.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const text = mapped?.text ?? (key.length === 1 && mask === 0 ? key : undefined);

    await this.sendSessionCdp('Input.dispatchKeyEvent', {
      type: text !== undefined ? 'keyDown' : 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: mask,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    });
    await this.sendSessionCdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: mask,
    });
  }

  private async evalValue<T>(expression: string): Promise<T | undefined> {
    const res = await this.sendSessionCdp<{ result?: { value?: T } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  private async injectAnnotationOverlay(): Promise<boolean> {
    const entries: Array<{ ref: string; x: number; y: number }> = [];
    for (const [ref, tracked] of this.refMap.entries()) {
      if (entries.length >= 60) break;
      try {
        const box = await this.sendSessionCdp<{ model?: { content?: number[] } }>('DOM.getBoxModel', {
          backendNodeId: tracked.backendDOMNodeId,
        });
        const quad = box.model?.content;
        if (Array.isArray(quad) && quad.length >= 2) {
          entries.push({ ref, x: Math.round(quad[0]!), y: Math.round(quad[1]!) });
        }
      } catch (error) {
        this.log('debug', `[remote-cdp] skip unmeasured node ${ref} in SoM overlay: ${String(error)}`);
      }
    }
    if (entries.length === 0) return false;
    try {
      await this.evalValue(`(() => {
        const old = document.getElementById('__dstu_som_overlay');
        if (old) old.remove();
        const root = document.createElement('div');
        root.id = '__dstu_som_overlay';
        root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
        for (const item of ${JSON.stringify(entries)}) {
          const badge = document.createElement('div');
          badge.textContent = item.ref;
          badge.style.cssText = 'position:fixed;left:' + item.x + 'px;top:' + item.y + 'px;background:#111;color:#fff;font:bold 11px monospace;padding:1px 4px;border-radius:3px;border:1px solid #fff;';
          root.appendChild(badge);
        }
        document.documentElement.appendChild(root);
        return true;
      })()`);
      return true;
    } catch (error) {
      this.log('debug', `[remote-cdp] SoM overlay injection skipped: ${String(error)}`);
      return false;
    }
  }

  private async removeAnnotationOverlay(): Promise<void> {
    try {
      await this.evalValue(`(() => { const el = document.getElementById('__dstu_som_overlay'); if (el) el.remove(); })()`);
    } catch (error) {
      this.log('debug', `[remote-cdp] SoM overlay cleanup skipped: ${String(error)}`);
    }
  }
}
