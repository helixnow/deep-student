import { describe, expect, it } from 'vitest';
import type { ShellBridge, WindowRef } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { NAVIGATION_BLOCKED_EVENT, PAGE_FINISHED_EVENT, ShellBrowserSurface, TITLE_CHANGED_EVENT } from '../src/surface-host.ts';

function shell(answer: (op: string, args: unknown) => unknown) {
  const requests: Array<{ op: string; args: unknown }> = [];
  const bridge = {
    request: async (op: string, args?: unknown) => {
      requests.push({ op, args });
      return answer(op, args);
    },
  } as unknown as ShellBridge;
  return { bridge, requests };
}

describe('ShellBrowserSurface agent network guard plumbing', () => {
  it('pushes the agent navigation policy to the shell', async () => {
    const { bridge, requests } = shell(() => null);
    const surface = new ShellBrowserSurface(bridge, 'darwin');
    await surface.setAgentNavigationPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    expect(requests).toEqual([{ op: 'browser.setAgentNavigationPolicy', args: { agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false } }]);
  });

  it('resolves agent hosts through the shell, keeping the shell reason verbatim on failure', async () => {
    const { bridge, requests } = shell((_op, args) => {
      const host = (args as { host: string }).host;
      if (host === 'example.com') return { addresses: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] };
      if (host === 'bogus.example') return { addresses: ['not-an-ip'] };
      if (host === 'down.example') throw new Error('unknown shell op: browser.resolveAgentHost');
      return { error: 'DNS resolution failed: net::ERR_NAME_NOT_RESOLVED' };
    });
    const surface = new ShellBrowserSurface(bridge, 'darwin');
    expect(await surface.resolveAgentHost('example.com', 443)).toEqual([
      { version: 4, octets: [93, 184, 216, 34] },
      { version: 6, segments: [0x2606, 0x2800, 0x220, 0x1, 0x248, 0x1893, 0x25c8, 0x1946] },
    ]);
    expect(requests[0]).toEqual({ op: 'browser.resolveAgentHost', args: { host: 'example.com', port: 443 } });
    expect(await surface.resolveAgentHost('missing.example', 443)).toBe('DNS resolution failed: net::ERR_NAME_NOT_RESOLVED');
    expect(await surface.resolveAgentHost('bogus.example', 443)).toBe('DNS resolution failed: unexpected address "not-an-ip"');
    expect(await surface.resolveAgentHost('down.example', 443)).toBe('DNS resolver unavailable: unknown shell op: browser.resolveAgentHost');
  });

  it('delivers navigations the shell blocked to the subscriber, only from browser-content and only while subscribed', () => {
    const listeners = new Map<string, (payload: unknown, source: WindowRef) => void>();
    const { bridge } = shell(() => null);
    const surface = new ShellBrowserSurface(bridge, 'darwin', {
      listen: (event, handler) => { listeners.set(event, handler); },
    });
    const blocked: Array<[string, string]> = [];
    const unsubscribe = surface.subscribe({
      pageFinished: () => undefined,
      titleChanged: () => undefined,
      navigationBlocked: (url, reason) => { blocked.push([url, reason]); },
    });
    const deliver = listeners.get(NAVIGATION_BLOCKED_EVENT)!;
    const content: WindowRef = { window: 'main', webview: 'browser-content', native: true };
    deliver({ url: 'http://internal.test/', reason: 'DNS resolved to private/internal address 10.0.0.5' }, content);
    deliver({ url: 'http://x/', reason: 'forged' }, { window: 'main', webview: 'main', native: true });
    deliver({ url: 'http://y/', reason: 'page emit' }, { window: 'main', webview: 'browser-content' });
    deliver({ url: 42 }, content);
    unsubscribe();
    deliver({ url: 'http://late/', reason: 'after unsubscribe' }, content);
    expect(blocked).toEqual([['http://internal.test/', 'DNS resolved to private/internal address 10.0.0.5']]);
  });

  it('delivers page-finished and title changes from browser-content (Rust on_page_finished / on_document_title_changed)', () => {
    const listeners = new Map<string, (payload: unknown, source: WindowRef) => void>();
    const { bridge } = shell(() => null);
    const surface = new ShellBrowserSurface(bridge, 'darwin', {
      listen: (event, handler) => { listeners.set(event, handler); },
    });
    const seen: unknown[] = [];
    const unsubscribe = surface.subscribe({
      pageFinished: (url) => { seen.push(['finished', url]); },
      titleChanged: (title, url) => { seen.push(['title', title, url]); },
      navigationBlocked: () => undefined,
    });
    expect(PAGE_FINISHED_EVENT).toBe('dstu-browser://page-finished');
    expect(TITLE_CHANGED_EVENT).toBe('dstu-browser://title-changed');
    const finished = listeners.get(PAGE_FINISHED_EVENT)!;
    const title = listeners.get(TITLE_CHANGED_EVENT)!;
    const content: WindowRef = { window: 'main', webview: 'browser-content', native: true };
    finished({ url: 'https://example.com/a' }, content);
    title({ title: 'Example', url: 'https://example.com/a#x' }, content);
    // Rust passes `webview.url().ok()`：读不到当前 URL 时为 None。
    title({ title: 'No url', url: null }, content);
    finished({ url: 'https://forged/' }, { window: 'main', webview: 'main', native: true });
    title({ title: 'forged', url: 'https://forged/' }, { window: 'main', webview: 'main', native: true });
    finished({ url: 'https://page-emit/' }, { window: 'main', webview: 'browser-content' });
    title({ title: 'page emit', url: null }, { window: 'main', webview: 'browser-content' });
    finished({ url: 7 }, content);
    title({ title: 7, url: 'https://example.com/' }, content);
    title({ title: 'bad url', url: 7 }, content);
    unsubscribe();
    finished({ url: 'https://late/' }, content);
    title({ title: 'late', url: null }, content);
    expect(seen).toEqual([
      ['finished', 'https://example.com/a'],
      ['title', 'Example', 'https://example.com/a#x'],
      ['title', 'No url', null],
    ]);
  });

  it('SEC-E05: through the kernel, only native browser-content callbacks reach the subscriber, not page emits', async () => {
    const host = await createTestHost({ contracts: { only: [] } });
    try {
      const surface = new ShellBrowserSurface(host.ctx.shell, 'darwin', host.ctx.backendEvents);
      const seen: unknown[] = [];
      surface.subscribe({
        pageFinished: (url) => { seen.push(['finished', url]); },
        titleChanged: (title, url) => { seen.push(['title', title, url]); },
        navigationBlocked: (url, reason) => { seen.push(['blocked', url, reason]); },
      });
      const content: WindowRef = { window: 'main', webview: 'browser-content' };
      host.emitFrontend(PAGE_FINISHED_EVENT, { url: 'https://page-emit/' }, content);
      host.emitFrontend(TITLE_CHANGED_EVENT, { title: 'page emit', url: null }, content, { kind: 'App' });
      host.emitFrontend(NAVIGATION_BLOCKED_EVENT, { url: 'http://10.0.0.5/', reason: 'forged' }, { ...content, native: true });
      host.emitNative(PAGE_FINISHED_EVENT, { url: 'https://example.com/' }, content);
      host.emitNative(TITLE_CHANGED_EVENT, { title: 'Example', url: 'https://example.com/' }, content);
      host.emitNative(NAVIGATION_BLOCKED_EVENT, { url: 'http://10.0.0.5/', reason: 'DNS resolved to private/internal address 10.0.0.5' }, content);
      host.emitNative(PAGE_FINISHED_EVENT, { url: 'https://main/' }, { window: 'main', webview: 'main' });
      expect(seen).toEqual([
        ['finished', 'https://example.com/'],
        ['title', 'Example', 'https://example.com/'],
        ['blocked', 'http://10.0.0.5/', 'DNS resolved to private/internal address 10.0.0.5'],
      ]);
    } finally {
      await host.dispose();
    }
  });
});
