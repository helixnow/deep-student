import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveShellTitlebarTopInset } from '../desktopShell';

const base = {
  isSmallScreen: false,
  isMacOS: false,
  manualTopMargin: 0,
  androidSafeAreaTop: null,
};

describe('resolveShellTitlebarTopInset (#472)', () => {
  it('avoids the Android status bar on tablets using the desktop shell', () => {
    // vivo pad：宽屏走桌面壳，此前只认手填边距（默认 0），顶栏与状态栏重叠
    expect(resolveShellTitlebarTopInset({ ...base, androidSafeAreaTop: 28 })).toBe(28);
  });

  it('lets the manual margin only enlarge the inset, never shrink below the native one', () => {
    expect(resolveShellTitlebarTopInset({ ...base, manualTopMargin: 40, androidSafeAreaTop: 28 })).toBe(40);
    expect(resolveShellTitlebarTopInset({ ...base, manualTopMargin: 10, androidSafeAreaTop: 28 })).toBe(28);
  });

  it('collapses to the manual margin when immersive mode hides the status bar', () => {
    expect(resolveShellTitlebarTopInset({ ...base, androidSafeAreaTop: 0 })).toBe(0);
    expect(resolveShellTitlebarTopInset({ ...base, manualTopMargin: 12, androidSafeAreaTop: 0 })).toBe(12);
  });

  it('keeps desktop behaviour unchanged', () => {
    expect(resolveShellTitlebarTopInset({ ...base, manualTopMargin: 16 })).toBe(16);
    expect(resolveShellTitlebarTopInset({ ...base, isMacOS: true, manualTopMargin: 16 })).toBe(0);
  });

  it('leaves small screens to the mobile shell safe-area contract', () => {
    expect(resolveShellTitlebarTopInset({ ...base, isSmallScreen: true, androidSafeAreaTop: 28 })).toBe(0);
  });

  it('sanitizes invalid values', () => {
    expect(resolveShellTitlebarTopInset({ ...base, manualTopMargin: Number.NaN, androidSafeAreaTop: 24.6 })).toBe(25);
    expect(resolveShellTitlebarTopInset({ ...base, manualTopMargin: -5, androidSafeAreaTop: -3 })).toBe(0);
    expect(resolveShellTitlebarTopInset({ ...base, androidSafeAreaTop: Number.NaN })).toBe(0);
  });
});

describe('Android system bar wiring (#472)', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('feeds the native safe area into the desktop shell titlebar', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('const androidSafeArea = useAndroidSafeArea();');
    expect(app).toContain('androidSafeAreaTop: androidSafeArea?.top ?? null');
    expect(app).toContain('syncAndroidImmersiveModeFromSettings()');
  });

  it('ships SystemBarsPlugin.kt in every Android build path', () => {
    expect(read('.github/workflows/reusable-build-android.yml')).toContain(
      'SRC="src-tauri/mobile/android/SystemBarsPlugin.kt"',
    );
    expect(read('scripts/build_android.sh')).toMatch(/for FILE in [^\n]*SystemBarsPlugin\.kt/);
    expect(read('src-tauri/src/system_bars.rs')).toContain('"SystemBarsPlugin"');
    expect(read('src-tauri/mobile/android/SystemBarsPlugin.kt')).toContain('mainActivity.setImmersiveMode(args.enabled)');
    expect(read('src-tauri/mobile/android/MainActivity.kt')).toContain('internal fun setImmersiveMode(enabled: Boolean)');
  });

  it('registers and allowlists the immersive command', () => {
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toContain('.plugin(crate::system_bars::init())');
    expect(lib).toContain('crate::system_bars::set_android_immersive_mode,');
    expect(read('src-tauri/permissions/application-commands.toml')).toContain('"set_android_immersive_mode",');
  });
});
