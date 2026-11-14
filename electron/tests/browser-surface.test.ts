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
  type BrowserCreateOptions,
  type BrowserScreenshotResult,
  type BrowserSurfaceLike,
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

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
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
  async screenshot(): Promise<BrowserScreenshotResult> {
    this.record('screenshot');
    return {
      available: true,
      capability: 'browser_visible_webview_screenshot',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      width: 320,
      height: 200,
    };
  }
  async snapshot(options: { interactiveOnly: boolean; maxChars?: number }): Promise<unknown> {
    this.record('snapshot', options);
    return { text: `snapshot:${options.interactiveOnly}:${options.maxChars ?? 'none'}` };
  }
  async click(ref: string): Promise<unknown> {
    this.record('click', ref);
    return { clicked: ref };
  }
  setAgentNavigationPolicy(policy: unknown): void {
    this.record('setAgentNavigationPolicy', policy);
  }
  async resolveAgentHost(host: string): Promise<{ addresses: string[] } | { error: string }> {
    this.record('resolveAgentHost', host);
    return host === 'missing.test' ? { error: 'DNS resolution failed: net::ERR_NAME_NOT_RESOLVED' } : { addresses: ['93.184.216.34'] };
  }
  async typeText(ref: string, text: string): Promise<unknown> {
    this.record('typeText', ref, text);
    return { typed: [ref, text] };
  }
  async setInputFiles(ref: string, files: unknown): Promise<unknown> {
    this.record('setInputFiles', ref, files);
    return { files: [ref, files] };
  }
  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<unknown> {
    this.record('scroll', options);
    return { scrolled: options };
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
      { name: 'typeText', args: ['ref-2', 'hello'] },
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
});
