import { describe, expect, it } from 'vitest';
import {
  RemoteCdpBrowserSurface,
  type BrowserScreencastFrame,
  type RemoteCdpWebSocketLike,
} from '../src/remote-cdp-surface.ts';

type CdpHandler = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

class InMemoryCdpSocket implements RemoteCdpWebSocketLike {
  readyState = 0;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private readonly handler: CdpHandler;
  closed = false;

  constructor(handler: CdpHandler, autoOpen = true) {
    this.handler = handler;
    if (autoOpen) {
      queueMicrotask(() => {
        if (this.closed) return;
        this.readyState = 1;
        this.emit('open', {});
      });
    }
  }

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  pushServerEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const payload = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) });
    this.emit('message', { data: payload });
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as {
      id: number; method: string; params?: Record<string, unknown>; sessionId?: string;
    };
    this.sent.push(msg);
    queueMicrotask(async () => {
      if (this.closed) return;
      try {
        const result = await this.handler(msg.method, msg.params ?? {}, msg.sessionId);
        this.emit('message', { data: JSON.stringify({ id: msg.id, result }) });
      } catch (error) {
        this.emit('message', {
          data: JSON.stringify({
            id: msg.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }),
        });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', {});
  }
}

function createHarness(customHandler?: CdpHandler) {
  const sockets: InMemoryCdpSocket[] = [];
  const tabs: Array<{ targetId: string; type: string; url: string; title: string }> = [];
  let axVersion = 1;
  let tabCounter = 1;
  let describedAttrs: string[] = ['type', 'text', 'name', 'query'];
  let describedNodeName = 'INPUT';
  let waitCounter = 0;

  const defaultHandler: CdpHandler = async (method, params, sessionId) => {
    if (customHandler) {
      const override = await customHandler(method, params, sessionId);
      if (override !== undefined) return override;
    }
    switch (method) {
      case 'Target.createTarget': {
        const targetId = `target-${tabCounter++}`;
        tabs.push({ targetId, type: 'page', url: String(params.url ?? 'about:blank'), title: 'New Tab' });
        return { targetId };
      }
      case 'Target.attachToTarget':
        return { sessionId: `cdp-sess-${String(params.targetId)}` };
      case 'Target.activateTarget':
        return {};
      case 'Target.closeTarget': {
        const idx = tabs.findIndex(t => t.targetId === params.targetId);
        if (idx >= 0) tabs.splice(idx, 1);
        return { success: true };
      }
      case 'Target.getTargets':
        return { targetInfos: tabs.map(t => ({ ...t })) };
      case 'Page.enable':
      case 'DOM.enable':
      case 'Runtime.enable':
      case 'Accessibility.enable':
      case 'Network.enable':
      case 'Log.enable':
      case 'Emulation.setDeviceMetricsOverride':
      case 'Page.navigate':
      case 'Page.reload':
      case 'Page.bringToFront':
      case 'Page.startScreencast':
      case 'Page.stopScreencast':
      case 'Page.screencastFrameAck':
      case 'Fetch.enable':
      case 'Fetch.disable':
      case 'Fetch.continueRequest':
      case 'Fetch.failRequest':
      case 'DOM.focus':
      case 'DOM.scrollIntoViewIfNeeded':
      case 'DOM.setFileInputFiles':
      case 'Input.dispatchMouseEvent':
      case 'Input.dispatchKeyEvent':
      case 'Input.insertText':
        return {};
      case 'Page.getNavigationHistory':
        return {
          currentIndex: 1,
          entries: [
            { id: 10, url: 'https://example.com/1' },
            { id: 11, url: 'https://example.com/2' },
            { id: 12, url: 'https://example.com/3' },
          ],
        };
      case 'Page.navigateToHistoryEntry':
        return {};
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            {
              nodeId: 'root',
              role: { value: 'RootWebArea' },
              name: { value: 'Study Portal' },
              childIds: ['btn1', 'inp1', 'pwd1'],
            },
            {
              nodeId: 'btn1',
              parentId: 'root',
              role: { value: 'button' },
              name: { value: axVersion === 1 ? 'Search' : 'Search Now' },
              backendDOMNodeId: 101,
            },
            {
              nodeId: 'inp1',
              parentId: 'root',
              role: { value: 'textbox' },
              name: { value: 'Query' },
              value: { value: axVersion === 1 ? '' : 'linear algebra' },
              backendDOMNodeId: 102,
            },
            {
              nodeId: 'pwd1',
              parentId: 'root',
              role: { value: 'textbox' },
              name: { value: 'Password' },
              value: { value: 'super-secret' },
              backendDOMNodeId: 103,
            },
          ],
        };
      case 'DOMSnapshot.captureSnapshot':
        return {
          strings: ['type', 'password', 'text'],
          documents: [
            { nodes: { backendNodeId: [102, 103], attributes: [[0, 2], [0, 1]] } },
            { nodes: { backendNodeId: [], attributes: [] } },
          ],
        };
      case 'DOM.describeNode':
        if (params.backendNodeId === 103) {
          return { node: { nodeName: 'INPUT', attributes: ['type', 'password', 'name', 'pass'] } };
        }
        return { node: { nodeName: describedNodeName, attributes: describedAttrs } };
      case 'DOM.getBoxModel':
        return { model: { content: [100, 200, 200, 200, 200, 240, 100, 240] } };
      case 'DOM.resolveNode':
        return { object: { objectId: `obj-${String(params.backendNodeId)}` } };
      case 'Runtime.callFunctionOn':
        return { result: { value: { ok: true, selected: ['opt-b'] } } };
      case 'Runtime.evaluate': {
        const expr = String(params.expression ?? '');
        if (expr.includes('__dstu_som_overlay')) return { result: { value: true } };
        if (expr.includes("document.querySelector('main, article")) {
          return {
            result: {
              value: {
                url: 'https://example.com/article',
                title: 'Linear Algebra',
                markdown: '# Linear Algebra\n\nVectors and matrices.',
              },
            },
          };
        }
        if (expr.includes('document.readyState')) return { result: { value: 'complete' } };
        if (expr.includes('querySelector')) {
          waitCounter += 1;
          return { result: { value: waitCounter >= 1 } };
        }
        if (expr.includes('innerText')) return { result: { value: true } };
        return { result: { value: null } };
      }
      case 'Page.captureScreenshot':
        return { data: 'iVBORw0KGgo=' };
      case 'Page.getLayoutMetrics':
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      default:
        return {};
    }
  };

  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/json/version')) {
      return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }), {
        status: 200,
      });
    }
    if (url.endsWith('/json/list')) {
      return new Response(JSON.stringify([
        { id: 'page-1', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1' },
      ]), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  const surface = new RemoteCdpBrowserSurface({
    endpoint: 'http://127.0.0.1:9222',
    commandTimeoutMs: 500,
    webSocketFactory: () => {
      const socket = new InMemoryCdpSocket(defaultHandler);
      sockets.push(socket);
      return socket;
    },
    fetchImpl,
  });

  return {
    surface,
    sockets,
    setAxVersion: (v: number) => { axVersion = v; },
    setDescribedNode: (nodeName: string, attrs: string[]) => {
      describedNodeName = nodeName;
      describedAttrs = attrs;
    },
  };
}

const CREATE_OPTS = {
  url: 'https://example.com/',
  title: 'Example',
  width: 1280,
  height: 720,
  focused: true,
  profileDir: '/tmp/profile',
  initializationScript: '',
};

describe('RemoteCdpBrowserSurface', () => {
  it('connects via /json/version, reports remote mode, captures ax-cdp snapshots with redaction and line diffs', async () => {
    const { surface, sockets, setAxVersion } = createHarness();
    expect(surface.hostMode()).toBe('remote');
    expect(surface.hasContentWindow()).toBe(false);

    await surface.createContentWindow(CREATE_OPTS);
    expect(surface.hasContentWindow()).toBe(true);
    expect(sockets).toHaveLength(1);

    const first = await surface.snapshot({ interactiveOnly: true }) as Record<string, unknown>;
    expect(first.mode).toBe('ax-cdp');
    expect(first.diff).toBe(false);
    expect(String(first.text)).toContain('button "Search" [ref=e1]');
    expect(String(first.text)).toContain('textbox "Query" [ref=e2]');
    expect(String(first.text)).toContain('value="[REDACTED]"');
    expect(String(first.text)).not.toContain('super-secret');
    expect(String(first.text)).toContain('[frames/shadow_documents=1]');

    const unchangedDiff = await surface.snapshot({ interactiveOnly: true, diff: true }) as Record<string, unknown>;
    expect(unchangedDiff.diff).toBe(true);
    expect(unchangedDiff.text).toBe('(no changes)');

    setAxVersion(2);
    const changedDiff = await surface.snapshot({ interactiveOnly: true, diff: true }) as Record<string, unknown>;
    expect(changedDiff.diff).toBe(true);
    expect(String(changedDiff.text)).toContain('-   button "Search" [ref=e1]');
    expect(String(changedDiff.text)).toContain('+   button "Search Now" [ref=e1]');
    expect(String(changedDiff.text)).toContain('+   textbox "Query" value="linear algebra" [ref=e2]');

    await surface.destroyContentWindow();
    expect(surface.hasContentWindow()).toBe(false);
  });

  it('dispatches trusted mouse/key/select/upload input and strictly blocks password/OTP fields', async () => {
    const { surface, sockets, setDescribedNode } = createHarness();
    await surface.createContentWindow(CREATE_OPTS);
    await surface.snapshot({ interactiveOnly: true });

    const clickRes = await surface.click('e1', { doubleClick: true, button: 'left' });
    expect(clickRes).toEqual({ ok: true, ref: 'e1', x: 150, y: 220 });

    const typeRes = await surface.typeText('e2', 'hello', { clear: true, submit: true });
    expect(typeRes).toEqual({ ok: true, ref: 'e2', length: 5, cleared: true, submitted: true });
    const sentMethods = sockets[0]!.sent.map(m => m.method);
    expect(sentMethods).toContain('DOM.focus');
    expect(sentMethods).toContain('Input.insertText');
    expect(sentMethods).toContain('Input.dispatchKeyEvent');

    // Password ref e3 must throw structured Bridge BLOCKED password_field without typing.
    const beforeInsertCount = sockets[0]!.sent.filter(m => m.method === 'Input.insertText').length;
    await expect(surface.typeText('e3', 'secret')).rejects.toEqual({
      kind: 'Bridge',
      code: 'BLOCKED',
      message: 'password or OTP fields cannot be accessed by agent bridge',
      details: { reason: 'password_field', ref: 'e3' },
    });
    expect(sockets[0]!.sent.filter(m => m.method === 'Input.insertText')).toHaveLength(beforeInsertCount);

    // Dynamic OTP attribute check on e2 via DOM.describeNode must also block!
    setDescribedNode('INPUT', ['type', 'text', 'autocomplete', 'one-time-code']);
    await expect(surface.typeText('e2', '123456')).rejects.toMatchObject({
      kind: 'Bridge',
      code: 'BLOCKED',
      details: { reason: 'password_field', ref: 'e2' },
    });

    // Reset to normal input, refresh snapshot, and test selectOption, hover, pressKey, setInputFiles, scroll.
    setDescribedNode('INPUT', ['type', 'file']);
    await surface.snapshot({ interactiveOnly: true });
    expect(await surface.hover({ ref: 'e1' })).toEqual({ ok: true, x: 150, y: 220 });
    expect(await surface.pressKey('Escape', ['Shift'])).toEqual({ ok: true, key: 'Escape', modifiers: ['Shift'] });
    expect(await surface.selectOption('e1', ['opt-b'])).toEqual({ ok: true, selected: ['opt-b'] });
    expect(await surface.setInputFiles('e2', [{ path: '/tmp/a.pdf' }])).toEqual({ ok: true, ref: 'e2', count: 1 });
    expect(await surface.scroll({ direction: 'down', amount: 300, ref: null })).toEqual({
      ok: true, direction: 'down', amount: 300, ref: null,
    });
  });

  it('captures screenshots (with optional SoM overlay), waits, extracts content, manages tabs, and collects console/network logs', async () => {
    const { surface, sockets } = createHarness();
    await surface.createContentWindow(CREATE_OPTS);
    await surface.snapshot({ interactiveOnly: true });

    const shot = await surface.screenshot({ fullPage: true, annotate: true, quality: 80 });
    expect(shot).toEqual({
      available: true,
      capability: 'browser_visible_webview_screenshot',
      mimeType: 'image/jpeg',
      dataBase64: 'iVBORw0KGgo=',
      width: 1280,
      height: 720,
      annotated: true,
    });

    const waited = await surface.waitFor({ selector: '#app', text: 'Study', loadState: 'load', timeoutMs: 500 });
    expect(waited).toMatchObject({ ok: true, matched: true });

    const extracted = await surface.extractContent({ maxChars: 1000, startIndex: 0 }) as Record<string, unknown>;
    expect(extracted.title).toBe('Linear Algebra');
    expect(String(extracted.markdown)).toContain('# Linear Algebra');

    // Tabs lifecycle
    const tab2 = await surface.newTab('https://example.org/second');
    expect(tab2.url).toBe('https://example.org/second');
    const listed = await surface.listTabs();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const switched = await surface.switchTab(listed[0]!.tabId);
    expect(switched.tabId).toBe(listed[0]!.tabId);
    expect(await surface.closeTab(tab2.tabId)).toEqual({
      closed: true,
      tabId: tab2.tabId,
      activeTabId: switched.tabId,
      remainingCount: 1,
      activeTab: switched,
    });

    // Console & Network events
    sockets[0]!.pushServerEvent('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ value: 'Uncaught Boom' }],
    });
    sockets[0]!.pushServerEvent('Network.requestWillBeSent', {
      requestId: 'req-1',
      request: { url: 'https://api.example.com/data', method: 'GET' },
    });
    sockets[0]!.pushServerEvent('Network.responseReceived', {
      requestId: 'req-1',
      response: { status: 503, statusText: 'Service Unavailable', url: 'https://api.example.com/data' },
    });

    const errs = await surface.consoleLogs({ level: 'error', limit: 10 }) as Array<Record<string, unknown>>;
    expect(errs).toHaveLength(1);
    expect(errs[0]?.text).toBe('Uncaught Boom');

    const net = await surface.networkLogs({ statusMin: 500, limit: 10 }) as Array<Record<string, unknown>>;
    expect(net).toHaveLength(1);
    expect(net[0]?.status).toBe(503);
  });

  it('streams screencast frames with automatic Page.screencastFrameAck and forwards remoteInput', async () => {
    const { surface, sockets } = createHarness();
    await surface.createContentWindow(CREATE_OPTS);

    const frames: BrowserScreencastFrame[] = [];
    await surface.startScreencast(frame => { frames.push(frame); }, { format: 'jpeg', quality: 55 });

    sockets[0]!.pushServerEvent('Page.screencastFrame', {
      sessionId: 42,
      data: '/9j/4AAQ',
      metadata: { deviceWidth: 1024, deviceHeight: 600, timestamp: 1234.5 },
    });

    await new Promise<void>(resolve => { globalThis.setTimeout(resolve, 10); });
    expect(frames).toEqual([{
      dataBase64: '/9j/4AAQ',
      mimeType: 'image/jpeg',
      width: 1024,
      height: 600,
      sessionId: 42,
      timestamp: 1234.5,
    }]);
    expect(sockets[0]!.sent.some(m => m.method === 'Page.screencastFrameAck' && m.params?.sessionId === 42)).toBe(true);

    await surface.remoteInput({ kind: 'mouse', action: 'click', x: 50, y: 60, button: 'left' });
    await surface.remoteInput({ kind: 'wheel', x: 50, y: 60, deltaX: 0, deltaY: 120 });
    await surface.remoteInput({ kind: 'key', action: 'text', text: 'abc' });
    expect(sockets[0]!.sent.some(m => m.method === 'Input.dispatchMouseEvent' && m.params?.type === 'mouseWheel')).toBe(true);
    expect(sockets[0]!.sent.some(m => m.method === 'Input.insertText' && m.params?.text === 'abc')).toBe(true);

    await surface.stopScreencast();
    expect(sockets[0]!.sent.some(m => m.method === 'Page.stopScreencast')).toBe(true);
  });

  it('falls back to /json/list page target discovery when /json/version is unavailable', async () => {
    const surface = new RemoteCdpBrowserSurface({
      endpoint: 'http://127.0.0.1:9222',
      webSocketFactory: () => new InMemoryCdpSocket(() => ({})),
      fetchImpl: (async (input: string | URL) => {
        if (String(input).endsWith('/json/version')) return new Response('nope', { status: 404 });
        return new Response(JSON.stringify([
          { id: 'p-1', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p-1' },
        ]), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await surface.createContentWindow(CREATE_OPTS);
    expect(surface.hasContentWindow()).toBe(true);
    const tabs = await surface.listTabs();
    expect(tabs).toEqual([{ tabId: 'p-1', url: 'https://example.com/', title: 'Example', active: true }]);
  });

  it('enforces AgentNavigationPolicy via CDP Fetch interception on SSRF redirects and blocks private URLs', async () => {
    const { surface, sockets } = createHarness();
    const blocked: Array<[string, string]> = [];
    surface.subscribe({
      pageFinished: () => undefined,
      titleChanged: () => undefined,
      navigationBlocked: (url, reason) => { blocked.push([url, reason]); },
    });
    await surface.setAgentNavigationPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    await surface.createContentWindow(CREATE_OPTS);

    expect(sockets[0]!.sent.some(m => m.method === 'Fetch.enable')).toBe(true);
    await expect(surface.navigate('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/navigation_blocked/);

    // Simulate HTTP 302 redirect to private IP intercepted via Fetch.requestPaused
    sockets[0]!.pushServerEvent('Fetch.requestPaused', {
      requestId: 'fetch-req-ssrf',
      request: { url: 'http://127.0.0.1:8080/admin' },
    }, 'cdp-sess-target-1');
    sockets[0]!.pushServerEvent('Fetch.requestPaused', {
      requestId: 'fetch-req-ok',
      request: { url: 'https://example.org/docs' },
    }, 'cdp-sess-target-1');

    await new Promise<void>(resolve => { globalThis.setTimeout(resolve, 20); });
    expect(sockets[0]!.sent.some(
      m => m.method === 'Fetch.failRequest'
        && m.params?.requestId === 'fetch-req-ssrf'
        && m.params?.errorReason === 'BlockedByClient'
        && m.sessionId === 'cdp-sess-target-1',
    )).toBe(true);
    expect(sockets[0]!.sent.some(
      m => m.method === 'Fetch.continueRequest'
        && m.params?.requestId === 'fetch-req-ok'
        && m.sessionId === 'cdp-sess-target-1',
    )).toBe(true);
    expect(blocked.some(([url]) => url === 'http://127.0.0.1:8080/admin')).toBe(true);
  });

  it('isolates multi-tab events, migrates screencast on tab switch, and marks surface closed when last tab closes', async () => {
    const { surface, sockets } = createHarness();
    const frames: BrowserScreencastFrame[] = [];
    const finishedUrls: string[] = [];
    surface.subscribe({
      pageFinished: url => { finishedUrls.push(url); },
      titleChanged: () => undefined,
      navigationBlocked: () => undefined,
    });
    await surface.createContentWindow(CREATE_OPTS);
    await surface.startScreencast(frame => { frames.push(frame); }, { format: 'jpeg', quality: 65 });

    const tab2 = await surface.newTab('https://example.org/tab2');
    // Migrated screencast: stopped on target-1, started on target-2
    expect(sockets[0]!.sent.some(m => m.method === 'Page.stopScreencast' && m.sessionId === 'cdp-sess-target-1')).toBe(true);
    expect(sockets[0]!.sent.some(m => m.method === 'Page.startScreencast' && m.sessionId === 'cdp-sess-target-2')).toBe(true);

    // Events from inactive tab target-1 must be ignored, while screencastFrame still acks on target-1
    sockets[0]!.pushServerEvent('Page.frameNavigated', { frame: { url: 'https://inactive.example/' } }, 'cdp-sess-target-1');
    sockets[0]!.pushServerEvent('Page.screencastFrame', {
      sessionId: 77,
      data: 'stale-frame',
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    }, 'cdp-sess-target-1');
    sockets[0]!.pushServerEvent('Page.screencastFrame', {
      sessionId: 78,
      data: 'active-frame',
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    }, 'cdp-sess-target-2');

    await new Promise<void>(resolve => { globalThis.setTimeout(resolve, 20); });
    expect(finishedUrls).not.toContain('https://inactive.example/');
    expect(frames.map(f => f.dataBase64)).toEqual(['active-frame']);
    expect(sockets[0]!.sent.some(
      m => m.method === 'Page.screencastFrameAck' && m.params?.sessionId === 77 && m.sessionId === 'cdp-sess-target-1',
    )).toBe(true);

    // Close both tabs -> remainingCount === 0 sets hasContentWindow() to false
    await surface.closeTab(tab2.tabId);
    const tabs = await surface.listTabs();
    const closedLast = await surface.closeTab(tabs[0]!.tabId) as Record<string, unknown>;
    expect(closedLast.remainingCount).toBe(0);
    expect(closedLast.activeTabId).toBeNull();
    expect(surface.hasContentWindow()).toBe(false);
  });

  it('populates KEY_CODE_MAP fields on remoteInput Enter/Tab, supports scroll top/bottom, and rejects zero-area quads', async () => {
    const { surface, sockets } = createHarness(method => {
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [10, 10, 10, 10, 10, 10, 10, 10] } };
      }
      return undefined as unknown as Record<string, unknown>;
    });
    await surface.createContentWindow(CREATE_OPTS);
    await surface.snapshot({ interactiveOnly: true });

    await surface.remoteInput({ type: 'keyDown', key: 'Enter' });
    await surface.remoteInput({ kind: 'key', action: 'down', key: 'Tab' });
    const enterEvt = sockets[0]!.sent.find(m => m.method === 'Input.dispatchKeyEvent' && m.params?.key === 'Enter');
    expect(enterEvt?.params).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
    });
    const tabEvt = sockets[0]!.sent.find(m => m.method === 'Input.dispatchKeyEvent' && m.params?.key === 'Tab');
    expect(tabEvt?.params).toMatchObject({
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });

    const scrollTopRes = await surface.scroll({ direction: 'top', amount: null, ref: null });
    expect(scrollTopRes).toEqual({ ok: true, direction: 'top', amount: null, ref: null });
    expect(sockets[0]!.sent.some(
      m => m.method === 'Runtime.evaluate' && String(m.params?.expression).includes('window.scrollTo(0, 0)'),
    )).toBe(true);

    await expect(surface.click('e1')).rejects.toMatchObject({
      kind: 'Bridge',
      code: 'NOT_INTERACTABLE',
    });
  });
});
