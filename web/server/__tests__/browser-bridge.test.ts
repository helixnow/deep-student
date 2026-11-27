import { describe, expect, it, vi } from 'vitest';

import {
  RemoteCdpBrowserSurface,
  type RemoteCdpSurfaceOptions,
  type RemoteCdpWebSocketLike,
} from '../../../host/plugins/browser/api.ts';
import {
  BROWSER_PAGE_FINISHED_EVENT,
  WebBrowserBridge,
  type WebScreencastPayload,
} from '../browser-bridge.ts';
import { formatShellRequestError } from '../gateway.ts';

class TestCdpSocket implements RemoteCdpWebSocketLike {
  readyState = 1;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    this.sent.push(parsed);

    queueMicrotask(() => {
      if (parsed.method === 'Target.createTarget') {
        this.emitMessage({ id: parsed.id, result: { targetId: 'target-1' } });
        return;
      }
      if (parsed.method === 'Target.attachToTarget') {
        this.emitMessage({ id: parsed.id, result: { sessionId: 'cdp-sess-1' } });
        return;
      }
      if (parsed.method === 'Accessibility.getFullAXTree') {
        this.emitMessage({
          id: parsed.id,
          result: {
            nodes: [
              {
                nodeId: 'n1',
                role: { value: 'RootWebArea' },
                name: { value: 'Example Page' },
                childIds: ['n2'],
              },
              {
                nodeId: 'n2',
                parentId: 'n1',
                role: { value: 'button' },
                name: { value: 'Continue' },
                backendDOMNodeId: 101,
              },
            ],
          },
        });
        return;
      }
      if (parsed.method === 'Page.captureScreenshot') {
        this.emitMessage({ id: parsed.id, result: { data: 'iVBORw0KGgo=' } });
        return;
      }
      if (parsed.method === 'Page.getLayoutMetrics') {
        this.emitMessage({
          id: parsed.id,
          result: { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } },
        });
        return;
      }
      if (parsed.method === 'Target.getTargets') {
        this.emitMessage({
          id: parsed.id,
          result: {
            targetInfos: [
              { targetId: 'target-1', type: 'page', url: 'https://example.com', title: 'Example' },
              { targetId: 'target-2', type: 'page', url: 'https://docs.example.com', title: 'Docs' },
            ],
          },
        });
        return;
      }
      this.emitMessage({ id: parsed.id, result: {} });
    });
  }

  close(): void {
    this.readyState = 3;
  }

  emitMessage(payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: serialized });
    }
  }
}

describe('WebBrowserBridge', () => {
  it('returns an actionable error when neither DS_BROWSER_CDP_URL nor auto-launch is configured', async () => {
    const bridge = new WebBrowserBridge({ cdpUrl: '', autoLaunch: false });

    await expect(
      bridge.handleShellRequest('browser.createContentWindow', {
        url: 'https://example.com',
        profileDir: '/tmp/profile',
      }),
    ).rejects.toThrow(/DS_BROWSER_CDP_URL.*DS_BROWSER_AUTO_LAUNCH=1/);
  });

  it('delegates CDP lifecycle, snapshot, screenshot, tabs, remoteInput, and screencast frames', async () => {
    const socket = new TestCdpSocket();
    const frames: WebScreencastPayload[] = [];
    const nativeEvents: Array<{ event: string; payload: unknown }> = [];
    const createdOptions: RemoteCdpSurfaceOptions[] = [];

    const bridge = new WebBrowserBridge({
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
      surfaceFactory: (opts) => {
        createdOptions.push(opts);
        return new RemoteCdpBrowserSurface({
          ...opts,
          webSocketFactory: () => socket,
        });
      },
      onScreencastFrame: (frame) => frames.push(frame),
      onNativeEvent: (event, payload) => nativeEvents.push({ event, payload }),
    });

    await bridge.handleShellRequest('browser.createContentWindow', {
      url: 'https://example.com',
      title: 'Example',
      width: 1280,
      height: 720,
      focused: true,
      profileDir: '/tmp/profile',
      initializationScript: '',
    });

    expect(createdOptions[0]?.endpoint).toBe('ws://127.0.0.1:9222/devtools/browser/test');
    expect(bridge.hasActiveSurface()).toBe(true);
    expect(socket.sent.some((cmd) => cmd.method === 'Page.startScreencast')).toBe(true);

    // Screencast frame event from CDP is acknowledged and forwarded.
    socket.emitMessage({
      method: 'Page.screencastFrame',
      params: {
        sessionId: 7,
        data: '/9j/4AAQSkZJRg==',
        metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 1700000000 },
      },
    });
    expect(frames).toEqual([
      {
        data: '/9j/4AAQSkZJRg==',
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
        timestamp: 1700000000,
      },
    ]);

    // Native page-finished callback is forwarded.
    socket.emitMessage({
      method: 'Page.frameNavigated',
      params: { frame: { url: 'https://example.com/loaded' } },
    });
    expect(nativeEvents).toContainEqual({
      event: BROWSER_PAGE_FINISHED_EVENT,
      payload: { url: 'https://example.com/loaded' },
    });

    await bridge.handleShellRequest('browser.navigate', { url: 'https://example.com/next' });
    expect(
      socket.sent.some(
        (cmd) => cmd.method === 'Page.navigate' && cmd.params?.url === 'https://example.com/next',
      ),
    ).toBe(true);

    const snapshot = (await bridge.handleShellRequest('browser.snapshot', {
      interactiveOnly: true,
    })) as { text: string; mode: string };
    expect(snapshot.mode).toBe('ax-cdp');
    expect(snapshot.text).toContain('button "Continue" [ref=e1]');

    const screenshot = (await bridge.handleShellRequest('browser.screenshot', {})) as {
      available: boolean;
      dataBase64: string;
    };
    expect(screenshot.available).toBe(true);
    expect(screenshot.dataBase64).toBe('iVBORw0KGgo=');

    const tabs = (await bridge.handleShellRequest('browser.listTabs', {})) as Array<{
      tabId: string;
      active: boolean;
    }>;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.active).toBe(true);

    await bridge.handleShellRequest('browser.remoteInput', {
      type: 'mousePressed',
      x: 320,
      y: 240,
      button: 'left',
      clickCount: 1,
    });
    expect(
      socket.sent.some(
        (cmd) =>
          cmd.method === 'Input.dispatchMouseEvent' &&
          cmd.params?.type === 'mousePressed' &&
          cmd.params?.x === 320 &&
          cmd.params?.y === 240,
      ),
    ).toBe(true);

    const destroyed = await bridge.handleShellRequest('browser.destroyContentWindow', {});
    expect(destroyed).toBe(true);
    expect(bridge.hasActiveSurface()).toBe(false);
    await bridge.dispose();
  });

  it('rejects unknown browser shell operations cleanly', async () => {
    const log = vi.fn();
    const bridge = new WebBrowserBridge({ cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/test', log });
    await expect(bridge.handleShellRequest('browser.nonExistentOp', {})).rejects.toThrow(
      /unknown browser shell op/,
    );
  });

  describe('CDP endpoint resolution priority (env > setting > autoLaunch)', () => {
    it('prefers DS_BROWSER_CDP_URL env over resolveConfiguredCdpUrl and autoLaunch', async () => {
      const previousEnv = process.env.DS_BROWSER_CDP_URL;
      process.env.DS_BROWSER_CDP_URL = 'ws://127.0.0.1:9333/devtools/browser/from-env';
      try {
        const socket = new TestCdpSocket();
        const createdOptions: RemoteCdpSurfaceOptions[] = [];
        const resolveConfiguredCdpUrl = vi.fn(async () => 'ws://127.0.0.1:9444/devtools/browser/from-setting');

        const bridge = new WebBrowserBridge({
          resolveConfiguredCdpUrl,
          autoLaunch: true,
          surfaceFactory: (opts) => {
            createdOptions.push(opts);
            return new RemoteCdpBrowserSurface({
              ...opts,
              webSocketFactory: () => socket,
            });
          },
        });

        await bridge.handleShellRequest('browser.createContentWindow', {
          url: 'https://example.com',
          profileDir: '/tmp/profile',
        });

        expect(createdOptions[0]?.endpoint).toBe('ws://127.0.0.1:9333/devtools/browser/from-env');
        expect(resolveConfiguredCdpUrl).not.toHaveBeenCalled();
        await bridge.dispose();
      } finally {
        if (previousEnv === undefined) delete process.env.DS_BROWSER_CDP_URL;
        else process.env.DS_BROWSER_CDP_URL = previousEnv;
      }
    });

    it('uses resolveConfiguredCdpUrl when DS_BROWSER_CDP_URL is unset and beats autoLaunch', async () => {
      const previousEnv = process.env.DS_BROWSER_CDP_URL;
      delete process.env.DS_BROWSER_CDP_URL;
      try {
        const socket = new TestCdpSocket();
        const createdOptions: RemoteCdpSurfaceOptions[] = [];
        const resolveConfiguredCdpUrl = vi.fn(async () => '  ws://127.0.0.1:9444/devtools/browser/from-setting  ');

        const bridge = new WebBrowserBridge({
          resolveConfiguredCdpUrl,
          autoLaunch: true,
          chromiumBinaryPath: '/nonexistent/chromium',
          surfaceFactory: (opts) => {
            createdOptions.push(opts);
            return new RemoteCdpBrowserSurface({
              ...opts,
              webSocketFactory: () => socket,
            });
          },
        });

        await bridge.handleShellRequest('browser.createContentWindow', {
          url: 'https://example.com',
          profileDir: '/tmp/profile',
        });

        expect(resolveConfiguredCdpUrl).toHaveBeenCalledTimes(1);
        expect(createdOptions[0]?.endpoint).toBe('ws://127.0.0.1:9444/devtools/browser/from-setting');
        await bridge.dispose();
      } finally {
        if (previousEnv === undefined) delete process.env.DS_BROWSER_CDP_URL;
        else process.env.DS_BROWSER_CDP_URL = previousEnv;
      }
    });

    it('falls through to autoLaunch / unconfigured error when resolveConfiguredCdpUrl returns empty or throws', async () => {
      const log = vi.fn();
      const emptyBridge = new WebBrowserBridge({
        cdpUrl: '',
        resolveConfiguredCdpUrl: async () => '   ',
        autoLaunch: false,
        log,
      });

      await expect(
        emptyBridge.handleShellRequest('browser.createContentWindow', {
          url: 'https://example.com',
          profileDir: '/tmp/profile',
        }),
      ).rejects.toThrow(/DS_BROWSER_CDP_URL.*DS_BROWSER_AUTO_LAUNCH=1/);

      const throwingBridge = new WebBrowserBridge({
        cdpUrl: '',
        resolveConfiguredCdpUrl: async () => {
          throw new Error('settings store unavailable');
        },
        autoLaunch: true,
        chromiumBinaryPath: '/nonexistent/chromium-binary',
        log,
      });

      await expect(
        throwingBridge.handleShellRequest('browser.createContentWindow', {
          url: 'https://example.com',
          profileDir: '/tmp/profile',
        }),
      ).rejects.toThrow(/DS_BROWSER_CDP_URL.*DS_BROWSER_AUTO_LAUNCH=1/);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('settings store unavailable'));
    });
  });

  describe('hostMode, downloadPolicy, surface lifecycle recovery & BridgeError formatting', () => {
    it('handles browser.hostMode and browser.setDownloadPolicy shell ops', async () => {
      const bridge = new WebBrowserBridge({ cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/test' });

      await expect(bridge.handleShellRequest('browser.hostMode', {})).resolves.toBe('remote');
      await expect(
        bridge.handleShellRequest('browser.setDownloadPolicy', { allow: true }),
      ).resolves.toBeNull();
    });

    it('does not wedge subsequent retries after a failed createContentWindow', async () => {
      let currentEndpoint = 'ws://127.0.0.1:9999/devtools/browser/bad';
      let attempt = 0;
      const goodSocket = new TestCdpSocket();
      const createdEndpoints: string[] = [];

      const bridge = new WebBrowserBridge({
        cdpUrl: '',
        resolveConfiguredCdpUrl: async () => currentEndpoint,
        surfaceFactory: (opts) => {
          createdEndpoints.push(opts.endpoint);
          attempt += 1;
          if (attempt === 1) {
            const failingSurface = new RemoteCdpBrowserSurface({
              ...opts,
              webSocketFactory: () => new TestCdpSocket(),
            });
            vi.spyOn(failingSurface, 'createContentWindow').mockRejectedValueOnce(
              new Error('connect ECONNREFUSED 127.0.0.1:9999'),
            );
            return failingSurface;
          }
          return new RemoteCdpBrowserSurface({
            ...opts,
            webSocketFactory: () => goodSocket,
          });
        },
      });

      await expect(
        bridge.handleShellRequest('browser.createContentWindow', {
          url: 'https://example.com',
          profileDir: '/tmp/profile',
        }),
      ).rejects.toThrow(/ECONNREFUSED/);
      expect(bridge.hasActiveSurface()).toBe(false);

      // Update endpoint and retry: must construct a fresh surface instead of staying wedged.
      currentEndpoint = 'ws://127.0.0.1:9222/devtools/browser/good';
      await bridge.handleShellRequest('browser.createContentWindow', {
        url: 'https://example.com',
        profileDir: '/tmp/profile',
      });
      expect(bridge.hasActiveSurface()).toBe(true);
      expect(createdEndpoints).toEqual([
        'ws://127.0.0.1:9999/devtools/browser/bad',
        'ws://127.0.0.1:9222/devtools/browser/good',
      ]);
      await bridge.dispose();
    });

    it('tears down old surface when live CDP endpoint changes or invalidateSurface is called', async () => {
      let currentEndpoint = 'ws://127.0.0.1:9222/devtools/browser/first';
      const destroySpies: Array<ReturnType<typeof vi.spyOn>> = [];
      const createdEndpoints: string[] = [];

      const bridge = new WebBrowserBridge({
        cdpUrl: '',
        resolveConfiguredCdpUrl: async () => currentEndpoint,
        surfaceFactory: (opts) => {
          createdEndpoints.push(opts.endpoint);
          const surface = new RemoteCdpBrowserSurface({
            ...opts,
            webSocketFactory: () => new TestCdpSocket(),
          });
          destroySpies.push(vi.spyOn(surface, 'destroyContentWindow'));
          return surface;
        },
      });

      await bridge.handleShellRequest('browser.createContentWindow', {
        url: 'https://example.com',
        profileDir: '/tmp/profile',
      });
      expect(createdEndpoints).toEqual(['ws://127.0.0.1:9222/devtools/browser/first']);

      // Change configured CDP URL live -> must tear down first surface and create second.
      currentEndpoint = 'ws://127.0.0.1:9333/devtools/browser/second';
      await bridge.handleShellRequest('browser.createContentWindow', {
        url: 'https://example.org',
        profileDir: '/tmp/profile',
      });
      expect(destroySpies[0]).toHaveBeenCalledTimes(1);
      expect(createdEndpoints).toEqual([
        'ws://127.0.0.1:9222/devtools/browser/first',
        'ws://127.0.0.1:9333/devtools/browser/second',
      ]);

      // Explicit invalidation immediately tears down the active surface.
      await bridge.invalidateSurface();
      expect(destroySpies[1]).toHaveBeenCalledTimes(1);
      expect(bridge.hasActiveSurface()).toBe(false);
    });

    it('serializes structured BridgeError and Timeout objects without [object Object]', () => {
      const bridgeResult = formatShellRequestError({
        kind: 'Bridge',
        code: 'PASSWORD_FIELD',
        message: 'Refusing to type into password input',
        details: { ref: 'e4', reason: 'password_field' },
      });
      expect(bridgeResult.error).not.toContain('[object Object]');
      expect(bridgeResult.error).toContain('PASSWORD_FIELD');
      expect(bridgeResult.error).toContain('Refusing to type into password input');
      expect(bridgeResult.errorData).toEqual({
        code: 'PASSWORD_FIELD',
        message: 'Refusing to type into password input',
        details: { ref: 'e4', reason: 'password_field' },
      });

      const timeoutResult = formatShellRequestError({
        kind: 'Timeout',
        milliseconds: 5000,
      });
      expect(timeoutResult.error).toContain('5000ms');
      expect(timeoutResult.errorData).toEqual({
        code: 'TIMEOUT',
        message: 'bridge call timed out after 5000ms',
        details: { milliseconds: 5000 },
      });
    });
  });
});
