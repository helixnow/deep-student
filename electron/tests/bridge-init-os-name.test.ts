/**
 * `BridgeInit.osName` 对应 Tauri 注入脚本的 `__TEMPLATE_os_name__`，即 Rust `std::env::consts::OS`
 * （tauri-2.11.5 `src/manager/webview.rs:413`、`src/app.rs:1600`）。Deep Student 构建 macOS、Windows、Linux、Android、iOS
 * （src-tauri 有 `cfg(target_os = "android")` / `cfg(target_os = "ios")` 分支），移动端外壳要能传真实平台（V06-L7）。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BridgeInit } from '../shell/bridge-messages.ts';

const OS_NAMES = ['macos', 'windows', 'linux', 'android', 'ios'] as const;

describe('BridgeInit.osName', () => {
  it('is exactly the std::env::consts::OS value of each platform Deep Student builds for', () => {
    expectTypeOf<BridgeInit['osName']>().toEqualTypeOf<(typeof OS_NAMES)[number]>();
    const inits = OS_NAMES.map((osName): BridgeInit => ({
      osName,
      windowLabel: 'main',
      webviewLabel: 'main',
      protocolScheme: 'https',
      sep: '/',
      delimiter: ':',
      dragDropEnabled: false,
    }));
    expect(inits.map((init) => structuredClone(init).osName)).toEqual([...OS_NAMES]);
  });
});
