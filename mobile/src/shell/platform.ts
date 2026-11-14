/**
 * 页面桥的初始化参数与平台标识。
 *
 * Tauri 注入页面的 `osName` 是 `std::env::consts::OS`（tauri-2.11.5 `src/manager/webview.rs:413`），移动端为
 * `android` / `ios`；`convertFileSrc` 在 Android 上与 Windows 一样用 `<scheme>://<protocol>.localhost/`（`scripts/core.js`）。
 * 平台取 Capacitor 的判断；Web 形态（开发服务器、Playwright 的 Chromium）没有对应的 Tauri 平台，沿用 `linux`。
 */
import { Capacitor } from '@capacitor/core';
import type { BridgeInit } from '../../../electron/shell/bridge-messages.ts';

export type MobileOsName = 'android' | 'ios' | 'linux';

/** `platform` 是 `Capacitor.getPlatform()` 的取值（`android` / `ios` / `web`）。 */
export function mobileOsName(platform: string = Capacitor.getPlatform()): MobileOsName {
  return platform === 'android' || platform === 'ios' ? platform : 'linux';
}

/**
 * 页面平台信息（与桌面 preload 的 `window.__DS_PLATFORM__` 同一全局，FE-A5，`src/ui-kernel/services/shell-platform.ts`）：
 * 移动端外壳给 `kind: 'mobile'`，`os` 与桥的 `osName` 相同。冻结、不可写、不可重定义，在前端脚本运行前安装。
 */
export function installPagePlatform(target: object = globalThis, platform?: string): void {
  Object.defineProperty(target, '__DS_PLATFORM__', {
    value: Object.freeze({ kind: 'mobile', os: mobileOsName(platform) }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

export function mobileBridgeInit(platform?: string): BridgeInit {
  return {
    osName: mobileOsName(platform),
    windowLabel: 'main',
    webviewLabel: 'main',
    protocolScheme: 'https',
    sep: '/',
    delimiter: ':',
    dragDropEnabled: false,
  };
}
