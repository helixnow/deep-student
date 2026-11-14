/** Supplement to the real-document test: exact cleanup bookkeeping and Rust fallback branches. */
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { beforeAll, expect, it } from 'vitest';

let script: string;
beforeAll(async () => {
  const bundle = await build({ entryPoints: [resolve('electron/preload/boot-diagnostics.ts')], bundle: true,
    write: false, format: 'iife', globalName: 'Boot', keepNames: false });
  script = bundle.outputFiles[0]!.text;
});

function page(root: null | { childElementCount: number }, invoke: unknown = () => Promise.resolve(null)) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const operations: unknown[] = [];
  let sequence = 0;
  const window: any = {
    document: { getElementById: () => root }, location: { hash: '', pathname: '/boot', href: 'tauri://localhost/boot' },
    navigator: { userAgent: 'test-agent' }, __TAURI_INTERNALS__: { invoke },
    addEventListener: (name: string, listener: (event: unknown) => void, capture: boolean) => {
      operations.push(['add', name, capture]);
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener: (name: string, listener: (event: unknown) => void, capture: boolean) => {
      operations.push(['remove', name, capture]);
      listeners.get(name)!.delete(listener);
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      operations.push(['timer', id, delay]);
      return id;
    },
    clearTimeout: (id: number) => { operations.push(['clear', id]); timers.delete(id); },
  };
  runInNewContext(script + '; Boot.installBootDiagnostics(); globalThis.installAgain = Boot.installBootDiagnostics;', window);
  const emit = (name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event); };
  return { window, emit, timers, listeners, operations };
}

it('runs the old main-world cleanup first, clears its timer and three capture listeners, and deactivates captured callbacks', () => {
  const calls: unknown[] = [];
  const p = page(null, (...args: unknown[]) => { calls.push(args); return Promise.resolve(); });
  const oldCallbacks = [...p.listeners.values()].flatMap(set => [...set]);
  const oldTimer = p.timers.get(1)!.callback;
  const cleanup = p.window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__;
  p.window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__ = () => { p.operations.push('old-cleanup'); cleanup(); };
  p.operations.length = 0;
  p.window.installAgain();
  expect(p.operations).toEqual(['old-cleanup', ['clear', 1],
    ['remove', 'error', true], ['remove', 'unhandledrejection', true], ['remove', 'securitypolicyviolation', true],
    ['add', 'error', true], ['add', 'unhandledrejection', true], ['add', 'securitypolicyviolation', true], ['timer', 2, 8000]]);
  for (const callback of oldCallbacks) callback({ message: 'old', reason: 'old', blockedURI: 'old', violatedDirective: 'old' });
  oldTimer();
  expect(calls).toEqual([]);
  expect(p.timers.size).toBe(1);
  p.window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__();
  expect(p.timers.size).toBe(0);
  expect([...p.listeners.values()].map(set => set.size)).toEqual([0, 0, 0]);
  expect(Object.hasOwn(p.window, '__DSTU_BOOT_DIAGNOSTICS_CLEANUP__')).toBe(false);
});

it('keeps absent/empty/populated root branches, exact 8000ms, pathname, nullable fields and resource fallback order', async () => {
  for (const root of [null, { childElementCount: 0 }, { childElementCount: 1 }]) {
    const calls: any[] = [];
    const p = page(root, (...args: unknown[]) => { calls.push(args); return Promise.resolve(); });
    expect(p.timers.get(1)!.delay).toBe(8000);
    p.timers.get(1)!.callback();
    expect(calls.length).toBe(root?.childElementCount ? 0 : 1);
    if (calls.length) expect(calls[0]).toEqual(['report_frontend_log', { payload: {
      level: 'ERROR', kind: 'BOOT_BLANK_SCREEN', message: 'Application root is empty after startup timeout',
      stack: null, route: '/boot', url: 'tauri://localhost/boot', user_agent: 'test-agent', extra: null,
    } }]);
    calls.length = 0;
    p.emit('error', {});
    p.emit('error', { target: { src: 'src', href: 'href', tagName: 'TAG' } });
    p.emit('error', { target: { href: 'href', tagName: 'TAG' } });
    p.emit('error', { target: { tagName: 'TAG' } });
    p.emit('unhandledrejection', { reason: '' });
    expect(calls.map(call => call[1].payload.message)).toEqual(['Failed to load resource: unknown',
      'Failed to load resource: src', 'Failed to load resource: href', 'Failed to load resource: TAG', 'BOOT_UNHANDLED_REJECTION']);
    expect(calls.map(call => call[1].payload.extra)).toEqual([null, { resource: 'src' }, { resource: 'href' }, { resource: 'TAG' }, null]);
  }
  const absent = page(null, null);
  expect(() => absent.emit('error', { message: 'no invoke' })).not.toThrow();
  delete absent.window.__TAURI_INTERNALS__;
  expect(() => absent.timers.get(1)!.callback()).not.toThrow();
  // Rust catches rejection, not synchronous throws. No replacement log or recursive rejection.
  const rejected = page(null, () => Promise.reject(new Error('log unavailable')));
  rejected.emit('error', { message: 'original error' });
  await new Promise(resolve => setImmediate(resolve));
});
