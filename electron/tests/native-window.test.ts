/**
 * 真机 FFI 测试（macOS）：用 objc runtime 创建离屏 NSWindow，再调用 native-window 的
 * NSWindow/NSVisualEffectView 调用序列。非 macOS 由 skipIf 跳过。
 */
import koffi from 'koffi';
import { describe, expect, it } from 'vitest';
import {
  setAlwaysOnBottom,
  setApplicationTheme,
  setDecorations,
  setTitleBarStyle,
  setWindowAppearance,
  setWindowEffects,
  syncTitlebarSidebarMaterial,
  type NativeWindowTarget,
} from '../shell/native-window.ts';

const darwin = process.platform === 'darwin';

interface WindowFixture {
  readonly target: NativeWindowTarget;
  readonly window: bigint;
  readonly view: bigint;
  close(): void;
}

function fixture(styleMask = 15): WindowFixture {
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cls = objc.func('objc_getClass', 'void *', ['str']);
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const msgPtr = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const msgVoid = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
  const init = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double', 'double', 'double', 'double', 'unsigned long', 'unsigned long', 'bool']);
  const window = init(msgPtr(cls('NSWindow'), sel('alloc')), sel('initWithContentRect:styleMask:backing:defer:'), 0, 0, 500, 400, styleMask, 2, false) as bigint;
  const view = msgPtr(window, sel('contentView')) as bigint;
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(view);
  return {
    target: { getNativeWindowHandle: () => Buffer.from(handle) },
    window,
    view,
    close() { msgVoid(window, sel('close')); },
  };
}

function send(window: bigint, name: string): bigint {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const call = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  return call(window, sel(name)) as bigint;
}

function ulong(window: bigint, name: string): number {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const call = objc.func('objc_msgSend', 'unsigned long', ['void *', 'void *']);
  return call(window, sel(name)) as number;
}

function long(window: bigint, name: string): number {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const call = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
  return call(window, sel(name)) as number;
}

function standardWindowButton(window: bigint): bigint | null {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const call = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'unsigned long']);
  return call(window, sel('standardWindowButton:'), 0) as bigint | null;
}

describe.skipIf(!darwin)('macOS native window effects (real NSWindow)', () => {
  it('set_window_appearance sets NSWindow appearance and reports missing window', () => {
    const f = fixture();
    try {
      setWindowAppearance(f.target, true);
      expect(send(f.window, 'appearance')).not.toBeNull();
      setWindowAppearance(f.target, false);
      expect(send(f.window, 'appearance')).not.toBeNull();
    } finally { f.close(); }
    expect(() => setWindowAppearance({ getNativeWindowHandle: () => Buffer.alloc(8) }, true)).toThrow('获取 NSWindow 失败');
  });

  it('sync_titlebar_sidebar_material creates and removes the identified titlebar view', () => {
    const f = fixture();
    try {
      const close = standardWindowButton(f.window);
      expect(close).not.toBeNull();
      const superview = send(close as bigint, 'superview');
      const container = send(superview, 'superview');
      const before = ulong(send(container, 'subviews'), 'count');
      syncTitlebarSidebarMaterial(f.target, true, 120);
      expect(ulong(send(container, 'subviews'), 'count')).toBe(before + 1);
      syncTitlebarSidebarMaterial(f.target, false, 120);
      expect(ulong(send(container, 'subviews'), 'count')).toBe(before);
    } finally { f.close(); }
    const borderless = fixture(0);
    try { expect(() => syncTitlebarSidebarMaterial(borderless.target, true, 100)).toThrow('找不到 macOS 标题栏关闭按钮'); }
    finally { borderless.close(); }
  });

  it('set_title_bar_style toggles FullSizeContentView and transparency', () => {
    const f = fixture();
    try {
      setTitleBarStyle(f.target, 'Overlay');
      expect(ulong(f.window, 'styleMask') & (1 << 15)).not.toBe(0);
      setTitleBarStyle(f.target, 'Transparent');
      expect(ulong(f.window, 'styleMask') & (1 << 15)).toBe(0);
      setTitleBarStyle(f.target, 'Visible');
      expect(ulong(f.window, 'styleMask') & (1 << 15)).not.toBe(0);
    } finally { f.close(); }
  });

  it('set_decorations and set_always_on_bottom mirror tao style mask and level', () => {
    const f = fixture();
    try {
      setDecorations(f.target, false, true);
      expect(ulong(f.window, 'styleMask')).toBe(8);
      setDecorations(f.target, true, true);
      expect(ulong(f.window, 'styleMask')).toBe(15);
      setAlwaysOnBottom(f.target, true);
      expect(long(f.window, 'level')).toBe(-1);
      setAlwaysOnBottom(f.target, false);
      expect(long(f.window, 'level')).toBe(0);
    } finally { f.close(); }
  });

  it('set_effects adds a visual effect view and null is a macOS no-op', () => {
    const f = fixture();
    try {
      const before = ulong(send(f.view, 'subviews'), 'count');
      setWindowEffects(f.target, { effects: ['sidebar'], state: 'active', radius: 8 });
      expect(ulong(send(f.view, 'subviews'), 'count')).toBe(before + 1);
      setWindowEffects(f.target, null);
      expect(ulong(send(f.view, 'subviews'), 'count')).toBe(before + 1);
      setWindowEffects(f.target, { effects: ['blur'] });
      expect(ulong(send(f.view, 'subviews'), 'count')).toBe(before + 1);
    } finally { f.close(); }
  });

  it('set_theme changes NSApplication appearance and null restores system', () => {
    try {
      const objc = koffi.load('/usr/lib/libobjc.A.dylib');
      const cls = objc.func('objc_getClass', 'void *', ['str']);
      const sel = objc.func('sel_registerName', 'void *', ['str']);
      const call = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
      const app = call(cls('NSApplication'), sel('sharedApplication'));
      setApplicationTheme('dark');
      expect(send(app, 'appearance')).not.toBeNull();
      setApplicationTheme('light');
      expect(send(app, 'appearance')).not.toBeNull();
      setApplicationTheme(null);
      expect(send(app, 'appearance')).toBeNull();
    } finally {
      setApplicationTheme(null);
    }
  });
});
