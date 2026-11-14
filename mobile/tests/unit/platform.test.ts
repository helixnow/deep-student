/**
 * 页面桥的 `osName` 取 Capacitor 判断的真实平台（Tauri 为 `std::env::consts::OS`）：Android 为 `android`、
 * iOS 为 `ios`；Web 形态沿用之前写死的 `linux`，`convertFileSrc` 结果不变。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { installTauriBridge } from '../../../electron/preload/bridge.ts';
import { mobileBridgeInit, mobileOsName } from '../../src/shell/platform.ts';

const NATIVE_MARKERS = ['androidBridge', 'webkit'] as const;

afterEach(() => {
  for (const key of NATIVE_MARKERS) delete (globalThis as Record<string, unknown>)[key];
});

describe('mobile platform', () => {
  it('maps Capacitor platforms to Tauri os names', () => {
    expect(mobileOsName('android')).toBe('android');
    expect(mobileOsName('ios')).toBe('ios');
    expect(mobileOsName('web')).toBe('linux');
    expect(mobileOsName('electron')).toBe('linux');
  });

  it('reads the platform from the Capacitor native bridge markers', () => {
    expect(mobileOsName()).toBe('linux');
    (globalThis as Record<string, unknown>).androidBridge = {};
    expect(mobileOsName()).toBe('android');
    expect(mobileBridgeInit().osName).toBe('android');
    delete (globalThis as Record<string, unknown>).androidBridge;
    (globalThis as Record<string, unknown>).webkit = { messageHandlers: { bridge: {} } };
    expect(mobileOsName()).toBe('ios');
    expect(mobileBridgeInit().osName).toBe('ios');
  });

  it('the bridge init matches the shell labels; the web form keeps the asset://localhost file URLs', () => {
    expect(mobileBridgeInit('web')).toEqual({
      osName: 'linux',
      windowLabel: 'main',
      webviewLabel: 'main',
      protocolScheme: 'https',
      sep: '/',
      delimiter: ':',
      dragDropEnabled: false,
    });
    const page: Record<string, unknown> = { crypto: globalThis.crypto };
    installTauriBridge({ send: () => undefined, subscribe: () => undefined }, mobileBridgeInit('web'), page);
    const internals = page.__TAURI_INTERNALS__ as { convertFileSrc(path: string): string };
    expect(internals.convertFileSrc('/deep-student/a b.png')).toBe('asset://localhost/%2Fdeep-student%2Fa%20b.png');
  });

  it('on Android convertFileSrc uses <scheme>://<protocol>.localhost/ like Windows (Tauri core.js)', () => {
    const page: Record<string, unknown> = { crypto: globalThis.crypto };
    installTauriBridge({ send: () => undefined, subscribe: () => undefined }, mobileBridgeInit('android'), page);
    const internals = page.__TAURI_INTERNALS__ as { convertFileSrc(path: string): string };
    expect(internals.convertFileSrc('/a b.png')).toBe('https://asset.localhost/%2Fa%20b.png');
  });
});
