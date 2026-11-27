/**
 * `browser-protocol.ts` 纯逻辑测试：桥脚本、信封解析、CSS 遮挡路径、shell op 分派。
 * 真实 Electron 窗口行为见 `browser-surface-host.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_GLOBAL,
  buildCallScript,
  buildEvenOddClipPath,
  buildOcclusionScript,
  buildSetInputFilesScript,
  buildTypeScript,
  durationDebug,
  handleBrowserShellRequest,
  parseBridgeEnvelope,
  sanitizeDownloadFilename,
  translateAxLiteScrollOptions,
  type BrowserClickOptions,
  type BrowserCloseTabResult,
  type BrowserConsoleEntry,
  type BrowserCreateOptions,
  type BrowserDownloadPolicy,
  type BrowserExtractOptions,
  type BrowserHoverOptions,
  type BrowserNetworkEntry,
  type BrowserPressKeyOptions,
  type BrowserRemoteInputOptions,
  type BrowserScreenshotOptions,
  type BrowserScreenshotResult,
  type BrowserSelectOptionOptions,
  type BrowserSnapshotOptions,
  type BrowserSurfaceLike,
  type BrowserTabInfo,
  type BrowserTypeOptions,
  type BrowserWaitOptions,
  type LogicalRect,
  type PhysicalRect,
} from '../shell/browser-protocol.ts';

interface Calls {
  name: string;
  args: unknown[];
}

class RecordingSurface implements BrowserSurfaceLike {
  readonly calls: Calls[] = [];
  viewport = { width: 1600, height: 1200 };
  destroyed = false;
  mode = 'embedded';

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  hostMode(): string {
    this.record('hostMode');
    return this.mode;
  }

  async createContentWindow(options: BrowserCreateOptions): Promise<void> {
    this.record('createContentWindow', options);
  }
  async destroyContentWindow(): Promise<boolean> {
    this.record('destroyContentWindow');
    return this.destroyed;
  }
  async navigate(url: string): Promise<void> {
    this.record('navigate', url);
  }
  async goBack(): Promise<void> {
    this.record('goBack');
  }
  async goForward(): Promise<void> {
    this.record('goForward');
  }
  async reload(): Promise<void> {
    this.record('reload');
  }
  async focusContentWindow(): Promise<void> {
    this.record('focusContentWindow');
  }
  async releaseContentFocus(): Promise<void> {
    this.record('releaseContentFocus');
  }
  async mainViewportSize(): Promise<{ width: number; height: number }> {
    this.record('mainViewportSize');
    return this.viewport;
  }
  async setContentBounds(bounds: PhysicalRect): Promise<void> {
    this.record('setContentBounds', bounds);
  }
  async setContentOcclusions(
    occlusions: readonly PhysicalRect[],
    inputOcclusions: readonly PhysicalRect[],
  ): Promise<void> {
    this.record('setContentOcclusions', occlusions, inputOcclusions);
  }
  async setContentVisibility(visible: boolean, focus: boolean): Promise<void> {
    this.record('setContentVisibility', visible, focus);
  }
  async screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    if (options === undefined) this.record('screenshot');
    else this.record('screenshot', options);
    return {
      available: true,
      capability: 'browser_visible_webview_screenshot',
      mimeType: options?.quality === 80 ? 'image/jpeg' : 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      width: 320,
      height: 200,
      ...(options?.annotate ? { annotated: true } : {}),
    };
  }
  async snapshot(options: BrowserSnapshotOptions): Promise<unknown> {
    this.record('snapshot', options);
    return { text: `snapshot:${options.interactiveOnly}:${options.maxChars ?? 'none'}` };
  }
  async click(target: string | BrowserClickOptions): Promise<unknown> {
    this.record('click', target);
    return { clicked: target };
  }
  setAgentNavigationPolicy(policy: unknown): void {
    this.record('setAgentNavigationPolicy', policy);
  }
  async resolveAgentHost(host: string): Promise<{ addresses: string[] } | { error: string }> {
    this.record('resolveAgentHost', host);
    return host === 'missing.test' ? { error: 'DNS resolution failed: net::ERR_NAME_NOT_RESOLVED' } : { addresses: ['93.184.216.34'] };
  }
  async typeText(ref: string, text: string, options?: BrowserTypeOptions): Promise<unknown> {
    if (options === undefined) this.record('typeText', ref, text);
    else this.record('typeText', ref, text, options);
    return { typed: [ref, text, options ?? null] };
  }
  async setInputFiles(ref: string, files: unknown): Promise<unknown> {
    this.record('setInputFiles', ref, files);
    return { files: [ref, files] };
  }
  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<unknown> {
    this.record('scroll', options);
    return { scrolled: options };
  }
  async hover(options: BrowserHoverOptions): Promise<unknown> {
    this.record('hover', options);
    return { hovered: options };
  }
  async pressKey(options: BrowserPressKeyOptions): Promise<unknown> {
    this.record('pressKey', options);
    return { pressed: options };
  }
  async selectOption(options: BrowserSelectOptionOptions): Promise<unknown> {
    this.record('selectOption', options);
    return { selected: options };
  }
  async waitFor(options: BrowserWaitOptions): Promise<unknown> {
    this.record('waitFor', options);
    return { waited: options };
  }
  async extractContent(options: BrowserExtractOptions): Promise<unknown> {
    this.record('extractContent', options);
    return { extracted: options };
  }
  async listTabs(): Promise<BrowserTabInfo[]> {
    this.record('listTabs');
    return [{ tabId: 'tab-1', url: 'https://example.com/', title: 'Example', active: true }];
  }
  async newTab(options: { url?: string; active?: boolean }): Promise<BrowserTabInfo> {
    this.record('newTab', options);
    return { tabId: 'tab-2', url: options.url ?? 'about:blank', title: '', active: options.active !== false };
  }
  async switchTab(tabId: string): Promise<BrowserTabInfo> {
    this.record('switchTab', tabId);
    return { tabId, url: 'https://example.com/', title: 'Example', active: true };
  }
  async closeTab(tabId: string): Promise<BrowserCloseTabResult> {
    this.record('closeTab', tabId);
    const activeTab: BrowserTabInfo = { tabId: 'tab-1', url: 'https://example.com/', title: 'Example', active: true };
    return { closed: true, activeTabId: activeTab.tabId, remainingCount: 1, activeTab };
  }
  setDownloadPolicy(policy: BrowserDownloadPolicy): void {
    this.record('setDownloadPolicy', policy);
  }
  async consoleLogs(options: { level?: string; limit?: number }): Promise<BrowserConsoleEntry[]> {
    this.record('consoleLogs', options);
    return [{ level: options.level ?? 'log', text: 'ok', timestamp: 1 }];
  }
  async networkLogs(options: { statusMin?: number; limit?: number }): Promise<BrowserNetworkEntry[]> {
    this.record('networkLogs', options);
    return [{ requestId: 'r1', url: 'https://example.com', method: 'GET', status: 200, statusText: 'OK', resourceType: 'Document', failed: false, timestamp: 1 }];
  }
  async promoteToInteractive(): Promise<{ promoted: boolean; headless: boolean }> {
    this.record('promoteToInteractive');
    return { promoted: true, headless: false };
  }
  async remoteInput(options: BrowserRemoteInputOptions): Promise<unknown> {
    this.record('remoteInput', options);
    return { ok: true, type: options.type };
  }
}

function surface(): RecordingSurface {
  return new RecordingSurface();
}

describe('browser-protocol::durationDebug', () => {
  it('formats Rust Duration Debug for seconds and milliseconds', () => {
    expect(durationDebug(2_000)).toBe('2s');
    expect(durationDebug(1_500)).toBe('1.5s');
    expect(durationDebug(250)).toBe('250ms');
    expect(durationDebug(15_000)).toBe('15s');
  });
});

describe('browser-protocol::parseBridgeEnvelope', () => {
  it('unwraps a JSON string result and returns data', () => {
    const envelope = JSON.stringify({ ok: true, v: 1, epoch: 3, data: { text: 'hello' } });
    expect(parseBridgeEnvelope(envelope)).toEqual({ text: 'hello' });
  });

  it('unwraps a doubly encoded string result', () => {
    const inner = JSON.stringify({ ok: true, v: 1, epoch: 1, data: [1, 2] });
    expect(parseBridgeEnvelope(JSON.stringify(inner))).toEqual([1, 2]);
  });

  it('returns null for ok envelopes without data', () => {
    expect(parseBridgeEnvelope(JSON.stringify({ ok: true, v: 1, epoch: 1 }))).toBeNull();
  });

  it('throws the Rust bridge error text for ok=false', () => {
    expect(() => parseBridgeEnvelope(JSON.stringify({
      ok: false, v: 1, epoch: 1,
      error: { code: 'STALE_REF', message: 'ref not found' },
    }))).toThrow('bridge error STALE_REF: ref not found');
  });

  it('rejects empty, non-JSON, non-envelope, and malformed error results', () => {
    expect(() => parseBridgeEnvelope('   ')).toThrow('invalid JSON from bridge: empty script result');
    expect(() => parseBridgeEnvelope('{oops')).toThrow(/^invalid JSON from bridge: /);
    expect(() => parseBridgeEnvelope('42')).toThrow('invalid JSON from bridge: expected an envelope object');
    expect(() => parseBridgeEnvelope('{"ok":1}')).toThrow("invalid JSON from bridge: missing boolean field 'ok'");
    expect(() => parseBridgeEnvelope('{"ok":false}')).toThrow('bridge error UNKNOWN: bridge returned ok=false without error');
  });
});

describe('browser-protocol::bridge scripts', () => {
  it('builds a sync call script around the bridge global and method args', () => {
    const script = buildCallScript('snapshot', '{"interactiveOnly":true}');
    expect(script).toContain(`window.${BRIDGE_GLOBAL}`);
    expect(script).toContain('b.snapshot({"interactiveOnly":true})');
    expect(script).toContain("code:'NOT_READY'");
    expect(script).toContain('async bridge methods are not supported in sync eval path');
  });

  it('builds multi-argument type and setInputFiles scripts', () => {
    const typed = buildTypeScript('["ref-1","hello",{"clear":true}]');
    expect(typed).toContain('b.type(args[0], args[1], args[2] || {})');
    expect(typed).toContain('"ref-1"');
    const files = buildSetInputFilesScript('[["ref-2"],[{"name":"a.txt","base64":"YQ=="}]]');
    expect(files).toContain('b.setInputFiles(args[0], args[1])');
    expect(files).toContain('a.txt');
  });
});

describe('browser-protocol::CSS occlusion', () => {
  const rect: LogicalRect = { x: 10.25, y: 20, width: 100, height: 40 };

  it('builds an even-odd path with the view frame and each hole', () => {
    expect(buildEvenOddClipPath(320, 240, [rect])).toBe(
      "path(evenodd, 'M0 0 L320 0 L320 240 L0 240 Z M10.25 20 L110.25 20 L110.25 60 L10.25 60 Z')",
    );
    expect(buildEvenOddClipPath(320, 240, [])).toBe(
      "path(evenodd, 'M0 0 L320 0 L320 240 L0 240 Z')",
    );
  });

  it('rejects non-finite coordinates', () => {
    expect(() => buildEvenOddClipPath(Number.NaN, 10, [])).toThrow(
      'browser surface occlusion coordinate must be finite',
    );
    expect(() => buildEvenOddClipPath(10, 10, [{ ...rect, x: Number.POSITIVE_INFINITY }])).toThrow(
      'browser surface occlusion coordinate must be finite',
    );
  });

  it('embeds the rects, size, and clip path in the page script', () => {
    const script = buildOcclusionScript([rect], 320, 240);
    expect(script).toContain('__dsBrowserOcclusions');
    expect(script).toContain('data-ds-browser-occlusion-layer');
    expect(script).toContain('html.style.clipPath = clipPath;');
    expect(script).toContain('M10.25 20 L110.25 20');
    expect(script).toContain('([{"x":10.25,"y":20,"width":100,"height":40}], 320, 240, ');
  });

  it('uses restore mode for empty occlusion lists', () => {
    const script = buildOcclusionScript([], 320, 240);
    expect(script).toContain('if (rects.length === 0) return restore();');
    expect(script).toContain(', 320, 240, ""');
  });
});

describe('browser-protocol::handleBrowserShellRequest', () => {
  it('forwards create options and defaults', async () => {
    const s = surface();
    const result = await handleBrowserShellRequest(s, 'browser.createContentWindow', {
      url: 'https://example.com/',
      profileDir: '/tmp/browser-profile',
      initializationScript: 'window.__dsBrowserBridge = {};',
    });
    expect(result).toBeNull();
    expect(s.calls).toEqual([{
      name: 'createContentWindow',
      args: [{
        url: 'https://example.com/',
        title: 'Browser',
        width: 960,
        height: 720,
        focused: true,
        profileDir: '/tmp/browser-profile',
        initializationScript: 'window.__dsBrowserBridge = {};',
      }],
    }]);
  });

  it('dispatches the argument-less and simple ops', async () => {
    const s = surface();
    await handleBrowserShellRequest(s, 'browser.navigate', { url: 'https://example.com/a' });
    await handleBrowserShellRequest(s, 'browser.goBack', {});
    await handleBrowserShellRequest(s, 'browser.goForward', {});
    await handleBrowserShellRequest(s, 'browser.reload', {});
    await handleBrowserShellRequest(s, 'browser.focusContentWindow', {});
    await handleBrowserShellRequest(s, 'browser.releaseContentFocus', {});
    const viewport = await handleBrowserShellRequest(s, 'browser.mainViewportSize', {});
    expect(viewport).toEqual({ width: 1600, height: 1200 });
    await handleBrowserShellRequest(s, 'browser.destroyContentWindow', {});
    expect(s.calls.map((call) => call.name)).toEqual([
      'navigate', 'goBack', 'goForward', 'reload', 'focusContentWindow',
      'releaseContentFocus', 'mainViewportSize', 'destroyContentWindow',
    ]);
    expect(s.calls[0]?.args).toEqual(['https://example.com/a']);
  });

  it('treats the setContentBounds payload as the rectangle itself', async () => {
    const s = surface();
    const bounds = { x: 10, y: 20, width: 300, height: 200 };
    await handleBrowserShellRequest(s, 'browser.setContentBounds', bounds);
    expect(s.calls).toEqual([{ name: 'setContentBounds', args: [bounds] }]);
  });

  it('forwards occlusions, visibility, and bridge method payloads', async () => {
    const s = surface();
    const occlusions = [{ x: 1, y: 2, width: 3, height: 4 }];
    const input = [{ x: 5, y: 6, width: 7, height: 8 }];
    await handleBrowserShellRequest(s, 'browser.setContentOcclusions', { occlusions, inputOcclusions: input });
    await handleBrowserShellRequest(s, 'browser.setContentVisibility', { visible: true, focus: false });
    const screenshot = await handleBrowserShellRequest(s, 'browser.screenshot', {});
    expect(screenshot).toMatchObject({ available: true, capability: 'browser_visible_webview_screenshot' });
    await handleBrowserShellRequest(s, 'browser.snapshot', { interactiveOnly: true, maxChars: 900 });
    await handleBrowserShellRequest(s, 'browser.click', { ref: 'ref-1' });
    await handleBrowserShellRequest(s, 'browser.typeText', { ref: 'ref-2', text: 'hello' });
    await handleBrowserShellRequest(s, 'browser.setInputFiles', { ref: 'ref-3', files: [{ name: 'a.txt' }] });
    await handleBrowserShellRequest(s, 'browser.scroll', { direction: 'down', amount: 300, ref: null });
    expect(s.calls).toEqual([
      { name: 'setContentOcclusions', args: [occlusions, input] },
      { name: 'setContentVisibility', args: [true, false] },
      { name: 'screenshot', args: [] },
      { name: 'snapshot', args: [{ interactiveOnly: true, maxChars: 900 }] },
      { name: 'click', args: ['ref-1'] },
      { name: 'typeText', args: ['ref-2', 'hello', { clear: false }] },
      { name: 'setInputFiles', args: ['ref-3', [{ name: 'a.txt' }]] },
      { name: 'scroll', args: [{ direction: 'down', amount: 300, ref: null }] },
    ]);
  });

  it('forwards the agent navigation policy and answers agent DNS lookups for the browser plugin', async () => {
    const s = surface();
    const policy = { agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false };
    await expect(handleBrowserShellRequest(s, 'browser.setAgentNavigationPolicy', policy)).resolves.toBeNull();
    await expect(handleBrowserShellRequest(s, 'browser.resolveAgentHost', { host: 'example.com', port: 443 }))
      .resolves.toEqual({ addresses: ['93.184.216.34'] });
    await expect(handleBrowserShellRequest(s, 'browser.resolveAgentHost', { host: 'missing.test', port: 443 }))
      .resolves.toEqual({ error: 'DNS resolution failed: net::ERR_NAME_NOT_RESOLVED' });
    await expect(handleBrowserShellRequest(s, 'browser.resolveAgentHost', { port: 443 })).rejects.toThrow(
      'browser shell op argument host must be a string',
    );
    expect(s.calls).toEqual([
      { name: 'setAgentNavigationPolicy', args: [policy] },
      { name: 'resolveAgentHost', args: ['example.com'] },
      { name: 'resolveAgentHost', args: ['missing.test'] },
    ]);
  });

  it('rejects malformed arguments and unknown ops', async () => {
    const s = surface();
    await expect(handleBrowserShellRequest(s, 'browser.navigate', {})).rejects.toThrow(
      'browser shell op argument url must be a string',
    );
    await expect(handleBrowserShellRequest(s, 'browser.setContentBounds', { x: 1, y: 2, width: 3 })).rejects.toThrow(
      'browser shell op argument bounds.height must be a finite number',
    );
    await expect(handleBrowserShellRequest(s, 'browser.setContentOcclusions', { occlusions: [], inputOcclusions: {} })).rejects.toThrow(
      'browser shell op argument inputOcclusions must be an array',
    );
    await expect(handleBrowserShellRequest(s, 'browser.nope', {})).rejects.toThrow('unknown shell op: browser.nope');
    expect(s.calls).toEqual([]);
  });

  it('forwards upgraded CDP, multi-tab, headless, and observation ops', async () => {
    const s = surface();
    await handleBrowserShellRequest(s, 'browser.createContentWindow', {
      url: 'https://example.com/',
      profileDir: '/tmp/profile',
      headless: true,
    });
    await handleBrowserShellRequest(s, 'browser.snapshot', {
      interactiveOnly: false,
      maxChars: 2048,
      diff: true,
      selector: '#main',
    });
    const annotatedShot = await handleBrowserShellRequest(s, 'browser.screenshot', {
      fullPage: true,
      annotate: true,
      maxWidth: 1024,
      quality: 80,
    });
    expect(annotatedShot).toMatchObject({ available: true, mimeType: 'image/jpeg', annotated: true });
    await handleBrowserShellRequest(s, 'browser.click', { x: 120, y: 240, doubleClick: true, button: 'right' });
    await handleBrowserShellRequest(s, 'browser.typeText', { ref: 'e2', text: 'query', clear: false, submit: true });
    await handleBrowserShellRequest(s, 'browser.hover', { ref: 'e3' });
    await handleBrowserShellRequest(s, 'browser.pressKey', { key: 'Control+k', modifiers: ['Shift'] });
    await handleBrowserShellRequest(s, 'browser.selectOption', { ref: 'e4', values: ['a', 'b'] });
    await handleBrowserShellRequest(s, 'browser.waitFor', { text: 'Done', loadState: 'networkidle', timeoutMs: 5_000 });
    await handleBrowserShellRequest(s, 'browser.extractContent', { maxChars: 12_000, startIndex: 250 });
    expect(await handleBrowserShellRequest(s, 'browser.hostMode', {})).toBe('embedded');
    expect(await handleBrowserShellRequest(s, 'browser.setDownloadPolicy', { agentOwned: true, artifactDir: '/tmp/artifacts' })).toBeNull();
    expect(await handleBrowserShellRequest(s, 'browser.listTabs', {})).toHaveLength(1);
    expect(await handleBrowserShellRequest(s, 'browser.newTab', { url: 'https://example.org', active: true })).toMatchObject({ tabId: 'tab-2' });
    expect(await handleBrowserShellRequest(s, 'browser.switchTab', { tabId: 'tab-2' })).toMatchObject({ tabId: 'tab-2' });
    expect(await handleBrowserShellRequest(s, 'browser.closeTab', { tabId: 'tab-2' })).toEqual({
      closed: true,
      activeTabId: 'tab-1',
      remainingCount: 1,
      activeTab: { tabId: 'tab-1', url: 'https://example.com/', title: 'Example', active: true },
    });
    expect(await handleBrowserShellRequest(s, 'browser.consoleLogs', { level: 'error', limit: 10 })).toHaveLength(1);
    expect(await handleBrowserShellRequest(s, 'browser.networkLogs', { statusMin: 400, limit: 20 })).toHaveLength(1);
    expect(await handleBrowserShellRequest(s, 'browser.promoteToInteractive', {})).toEqual({ promoted: true, headless: false });
    await handleBrowserShellRequest(s, 'browser.remoteInput', { type: 'mousePressed', x: 50, y: 60, button: 'left', clickCount: 1 });

    expect(s.calls).toEqual([
      {
        name: 'createContentWindow',
        args: [{
          url: 'https://example.com/',
          title: 'Browser',
          width: 960,
          height: 720,
          focused: true,
          profileDir: '/tmp/profile',
          initializationScript: '',
          headless: true,
        }],
      },
      { name: 'snapshot', args: [{ interactiveOnly: false, maxChars: 2048, diff: true, selector: '#main' }] },
      { name: 'screenshot', args: [{ fullPage: true, annotate: true, maxWidth: 1024, quality: 80 }] },
      { name: 'click', args: [{ x: 120, y: 240, doubleClick: true, button: 'right' }] },
      { name: 'typeText', args: ['e2', 'query', { clear: false, submit: true }] },
      { name: 'hover', args: [{ ref: 'e3' }] },
      { name: 'pressKey', args: [{ key: 'Control+k', modifiers: ['Shift'] }] },
      { name: 'selectOption', args: [{ ref: 'e4', values: ['a', 'b'] }] },
      { name: 'waitFor', args: [{ text: 'Done', loadState: 'networkidle', timeoutMs: 5_000 }] },
      { name: 'extractContent', args: [{ maxChars: 12_000, startIndex: 250 }] },
      { name: 'hostMode', args: [] },
      { name: 'setDownloadPolicy', args: [{ agentOwned: true, artifactDir: '/tmp/artifacts' }] },
      { name: 'listTabs', args: [] },
      { name: 'newTab', args: [{ url: 'https://example.org', active: true }] },
      { name: 'switchTab', args: ['tab-2'] },
      { name: 'closeTab', args: ['tab-2'] },
      { name: 'consoleLogs', args: [{ level: 'error', limit: 10 }] },
      { name: 'networkLogs', args: [{ statusMin: 400, limit: 20 }] },
      { name: 'promoteToInteractive', args: [] },
      { name: 'remoteInput', args: [{ type: 'mousePressed', x: 50, y: 60, button: 'left', clickCount: 1 }] },
    ]);
  });

  it('validates new op arguments and rejects missing optional surface capabilities', async () => {
    const s = surface();
    await expect(handleBrowserShellRequest(s, 'browser.click', {})).rejects.toThrow(/ref must be a string or x\/y/);
    await expect(handleBrowserShellRequest(s, 'browser.click', { ref: 'e1', button: 'side' })).rejects.toThrow(/button must be/);
    await expect(handleBrowserShellRequest(s, 'browser.waitFor', { loadState: 'invalid' })).rejects.toThrow(/loadState must be/);
    await expect(handleBrowserShellRequest(s, 'browser.remoteInput', { type: 'bogus' })).rejects.toThrow(/argument type is invalid/);
    await expect(handleBrowserShellRequest(s, 'browser.setDownloadPolicy', { agentOwned: 'yes' })).rejects.toThrow(/agentOwned must be a boolean/);
    await expect(handleBrowserShellRequest(s, 'browser.setDownloadPolicy', { agentOwned: true, artifactDir: 42 })).rejects.toThrow(/artifactDir must be a string or null/);

    const minimal = { ...s, hover: undefined } as unknown as BrowserSurfaceLike;
    await expect(handleBrowserShellRequest(minimal, 'browser.hover', { ref: 'e1' })).rejects.toThrow(
      'browser surface does not support browser.hover',
    );
  });
});

describe('browser-protocol::ax-lite scroll translation & download sanitization', () => {
  it('translates { direction, amount, ref } into ax-lite { to | dx | dy, ref } payloads', () => {
    expect(translateAxLiteScrollOptions({ direction: 'down', amount: 300, ref: null })).toEqual({ dx: 0, dy: 300 });
    expect(translateAxLiteScrollOptions({ direction: 'up', amount: 150, ref: 'e4' })).toEqual({ dx: 0, dy: -150, ref: 'e4' });
    expect(translateAxLiteScrollOptions({ direction: 'left', amount: 200, ref: null })).toEqual({ dx: -200, dy: 0 });
    expect(translateAxLiteScrollOptions({ direction: 'right', amount: 100, ref: 'e2' })).toEqual({ dx: 100, dy: 0, ref: 'e2' });
    expect(translateAxLiteScrollOptions({ direction: 'top', amount: null, ref: null })).toEqual({ to: 'top' });
    expect(translateAxLiteScrollOptions({ direction: 'bottom', amount: 500, ref: 'e9' })).toEqual({ to: 'bottom', ref: 'e9' });
    expect(translateAxLiteScrollOptions({ direction: null, amount: null, ref: null })).toEqual({ dx: 0, dy: 480 });
  });

  it('sanitizes download filenames against path traversal, control chars, and Windows reserved names', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDownloadFilename('C:\\evil\\sub\\report.pdf')).toBe('report.pdf');
    expect(sanitizeDownloadFilename('...hidden')).toBe('hidden');
    expect(sanitizeDownloadFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeDownloadFilename('a:b*c?"d<e>f|g\x00.png')).toBe('a_b_c__d_e_f_g_.png');
    expect(sanitizeDownloadFilename('   ...  ')).toBe('download');
  });
});
