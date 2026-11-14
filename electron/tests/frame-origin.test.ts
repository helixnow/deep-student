import { expect, it } from 'vitest';
import { frameOrigin, isLocalFrameUrl, trustedFrameUrl } from '../shell/frame-origin.ts';

const contents = { getURL: () => 'https://fallback.example/current' };

it('trustedFrameUrl prefers the invoking frame and falls back when it was disposed', () => {
  expect(trustedFrameUrl({ url: 'https://frame.example/page' }, contents)).toBe('https://frame.example/page');
  expect(trustedFrameUrl({ url: 'https://frame.example/page', detached: true }, contents)).toBe('https://fallback.example/current');
  expect(trustedFrameUrl(null, contents)).toBe('https://fallback.example/current');
  const disposed = {
    detached: false,
    get url(): string {
      throw new Error('Render frame was disposed');
    },
  };
  expect(trustedFrameUrl(disposed, contents)).toBe('https://fallback.example/current');
});

it('treats tauri, Windows localhost and devUrl pages as local', () => {
  expect(isLocalFrameUrl('tauri://localhost/index.html', 'tauri://localhost')).toBe(true);
  expect(isLocalFrameUrl('tauri://localhost.evil.example/index.html', 'tauri://localhost')).toBe(false);
  expect(isLocalFrameUrl('http://tauri.localhost/index.html', 'http://tauri.localhost')).toBe(true);
  expect(isLocalFrameUrl('https://tauri.localhost/index.html', 'http://tauri.localhost')).toBe(false);
  expect(isLocalFrameUrl('http://127.0.0.1:1422/settings', 'http://127.0.0.1:1422')).toBe(true);
  expect(isLocalFrameUrl('http://127.0.0.1:1423/settings', 'http://127.0.0.1:1422')).toBe(false);
  expect(isLocalFrameUrl('http://127.0.0.1:1422.evil.example/', 'http://127.0.0.1:1422')).toBe(false);
  expect(isLocalFrameUrl('not a url', 'http://127.0.0.1:1422')).toBe(false);
});

it('uses Origin-header semantics for remote frames and never local for opaque sources', () => {
  expect(frameOrigin('https://example.org/path?q=1', 'tauri://localhost')).toBe('https://example.org');
  expect(frameOrigin('https://example.org:8443/path', 'tauri://localhost')).toBe('https://example.org:8443');
  expect(frameOrigin('http://127.0.0.1:54321/a', 'tauri://localhost')).toBe('http://127.0.0.1:54321');
  expect(frameOrigin('blob:https://example.org/uuid', 'tauri://localhost')).toBe('https://example.org');
  expect(frameOrigin('about:blank', 'tauri://localhost')).toBe('null');
  expect(frameOrigin('file:///tmp/page.html', 'tauri://localhost')).toBe('null');
  expect(frameOrigin('data:text/html,hi', 'tauri://localhost')).toBe('null');
  expect(frameOrigin('tauri://evil.example/', 'tauri://localhost')).toBe('null');
  expect(frameOrigin('not a url', 'tauri://localhost')).toBe('null');
});

it('omits the origin only for the local app frame', () => {
  expect(frameOrigin('tauri://localhost/index.html', 'tauri://localhost')).toBeUndefined();
  expect(frameOrigin('http://tauri.localhost/index.html', 'http://tauri.localhost')).toBeUndefined();
  expect(frameOrigin('http://127.0.0.1:1422/settings', 'http://127.0.0.1:1422')).toBeUndefined();
  expect(frameOrigin('http://127.0.0.1:1423/settings', 'http://127.0.0.1:1422')).toBe('http://127.0.0.1:1423');
});
