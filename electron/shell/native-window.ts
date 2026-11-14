/**
 * macOS NSWindow 效果的 objc runtime 绑定（koffi）。
 *
 * 逐行移植：
 * - `src-tauri/src/cmd/window_effects.rs`：`set_window_appearance`、
 *   `sync_titlebar_sidebar_material`（含 `DeepStudentTitlebarSidebarMaterialView` 的
 *   `isOpaque`/`hitTest:` 覆盖）；
 * - `tao-0.35.3/src/platform_impl/macos/window.rs`：`set_decorations`、`set_title_bar_style`、
 *   `set_theme`（`set_ns_theme`）、`set_always_on_bottom`；
 * - `tauri-2.11.5/src/vibrancy/macos.rs` + `window-vibrancy-0.6.0/src/macos`：`set_effects`。
 *
 * 只在 Electron main 进程调用（Cocoa 要求主线程）。`BrowserWindow.getNativeWindowHandle()` 在
 * macOS 返回 content view（`NSView*`），本模块先用 `[view window]` 取回 `NSWindow*`，与
 * Tauri `WebviewWindow::ns_window()` 的调用对象一致。
 */
import koffi, { type TypeObject } from 'koffi';

/** `getNativeWindowHandle()` 的最小目标（`BrowserWindow` 满足）。 */
export interface NativeWindowTarget {
  getNativeWindowHandle(): Buffer;
}

export type NativeTheme = 'light' | 'dark' | null;
export type NativeTitleBarStyle = 'Visible' | 'Transparent' | 'Overlay';

export type Pointer = bigint | null;
type ObjCValue = Pointer | number | boolean | RectValue;

/** koffi 把空指针返回为 `null`（回调返回值亦同），统一按 nil 判断。 */
export const isNil = (value: unknown): boolean => value === null || value === undefined || value === 0n;

export interface PointValue { x: number; y: number }
export interface SizeValue { width: number; height: number }
export interface RectValue { origin: PointValue; size: SizeValue }

const NS_WINDOW_BUTTON_CLOSE = 0;
const NS_VIEW_MAX_X_MARGIN = 4;
const NS_VIEW_HEIGHT_SIZABLE = 16;
const NS_VIEW_WIDTH_SIZABLE = 2;
const NS_WINDOW_BELOW = -1;
const NS_WINDOW_STYLE_TITLED = 1;
const NS_WINDOW_STYLE_CLOSABLE = 2;
const NS_WINDOW_STYLE_MINIATURIZABLE = 4;
const NS_WINDOW_STYLE_RESIZABLE = 8;
const NS_WINDOW_STYLE_BORDERLESS = 0;
const NS_WINDOW_STYLE_FULL_SIZE_CONTENT_VIEW = 1 << 15;
const NS_WINDOW_BELOW_NORMAL_LEVEL = -1;
const NS_WINDOW_NORMAL_LEVEL = 0;
const NS_VISUAL_EFFECT_BLENDING_BEHIND_WINDOW = 0;
const NS_VISUAL_EFFECT_STATE_FOLLOWS_WINDOW_ACTIVE_STATE = 0;
const UTF8_ENCODING = 4;

const NS_POINT = koffi.struct('DSTU_NSPoint', { x: 'double', y: 'double' });
const NS_SIZE = koffi.struct('DSTU_NSSize', { width: 'double', height: 'double' });
const NS_RECT = koffi.struct('DSTU_NSRect', { origin: NS_POINT, size: NS_SIZE });

/** `NSVisualEffectMaterial`（window-vibrancy-0.6.0/src/macos/mod.rs）。 */
const MATERIALS: Record<string, number> = {
  appearanceBased: 0,
  light: 1,
  dark: 2,
  mediumLight: 8,
  ultraDark: 9,
  titlebar: 3,
  selection: 4,
  menu: 5,
  popover: 6,
  sidebar: 7,
  headerView: 10,
  sheet: 11,
  windowBackground: 12,
  hudWindow: 13,
  fullScreenUi: 15,
  tooltip: 17,
  contentBackground: 18,
  underWindowBackground: 21,
  underPageBackground: 22,
};

/** `NSVisualEffectState`（EffectState::*）。 */
const EFFECT_STATES: Record<string, number> = {
  followsWindowActiveState: 0,
  active: 1,
  inactive: 2,
};

export interface ObjCApi {
  cls(name: string): Pointer;
  lookup(name: string): Pointer;
  sel(name: string): Pointer;
  send<R extends ObjCValue>(result: TypeObject | string, args: readonly (string | TypeObject)[]): (...values: unknown[]) => R;
}

let api: ObjCApi | null = null;
let titlebarCallbacks: bigint[] | null = null;

export function loadObjCApi(): ObjCApi {
  if (api) return api;
  if (process.platform !== 'darwin') {
    throw new Error('native window effects are only available on macOS');
  }
  // 先加载 AppKit，确保 NSWindow/NSVisualEffectView 等类已经注册到 objc runtime。
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const getClass = objc.func('objc_getClass', 'void *', ['str']);
  const registerName = objc.func('sel_registerName', 'void *', ['str']);
  const NSString = getClass('NSString') as Pointer;
  const createString = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
  const stringWithUtf8 = registerName('stringWithUTF8String:') as Pointer;
  const cache = new Map<string, (...values: unknown[]) => unknown>();
  const send = <R extends ObjCValue>(result: TypeObject | string, args: readonly (string | TypeObject)[]): ((...values: unknown[]) => R) => {
    const key = `${String(result)}|${args.map(String).join(',')}`;
    let fn = cache.get(key);
    if (!fn) {
      fn = objc.func('objc_msgSend', result, ['void *', 'void *', ...args]);
      cache.set(key, fn);
    }
    return fn as (...values: unknown[]) => R;
  };
  api = {
    cls: (name) => {
      const value = getClass(name) as Pointer;
      if (value === 0n) throw new Error(`找不到 Objective-C 类 ${name}`);
      return value;
    },
    lookup: (name) => getClass(name) as Pointer,
    sel: (name) => registerName(name) as Pointer,
    send,
  };
  return api;
}

function windowPointer(target: NativeWindowTarget): { window: Pointer; view: Pointer } {
  const raw = target.getNativeWindowHandle();
  if (raw.length < 8) throw new Error('获取 NSWindow 失败');
  const view = raw.readBigUInt64LE(0);
  if (isNil(view)) throw new Error('获取 NSWindow 失败');
  const a = loadObjCApi();
  const window = a.send<Pointer>('void *', [])(view, a.sel('window'));
  if (isNil(window)) throw new Error('获取 NSWindow 失败');
  return { window, view };
}

function send0(a: ObjCApi, object: Pointer, selector: string): Pointer {
  return a.send<Pointer>('void *', [])(object, a.sel(selector));
}

function send1p(a: ObjCApi, object: Pointer, selector: string, arg: Pointer): void {
  a.send('void', ['void *'])(object, a.sel(selector), arg);
}

function send1b(a: ObjCApi, object: Pointer, selector: string, arg: boolean): void {
  a.send('void', ['bool'])(object, a.sel(selector), arg);
}

function send1l(a: ObjCApi, object: Pointer, selector: string, arg: number): void {
  a.send('void', ['long'])(object, a.sel(selector), arg);
}

function send1ul(a: ObjCApi, object: Pointer, selector: string, arg: number): void {
  a.send('void', ['unsigned long'])(object, a.sel(selector), arg);
}

function send1d(a: ObjCApi, object: Pointer, selector: string, arg: number): void {
  a.send('void', ['double'])(object, a.sel(selector), arg);
}

function bool0(a: ObjCApi, object: Pointer, selector: string): boolean {
  return a.send<boolean>('bool', [])(object, a.sel(selector));
}

function bool1p(a: ObjCApi, object: Pointer, selector: string, arg: Pointer): boolean {
  return a.send<boolean>('bool', ['void *'])(object, a.sel(selector), arg);
}

function ulong0(a: ObjCApi, object: Pointer, selector: string): number {
  return a.send<number>('unsigned long', [])(object, a.sel(selector));
}

function long1ul(a: ObjCApi, object: Pointer, selector: string, arg: number): Pointer {
  return a.send<Pointer>('void *', ['unsigned long'])(object, a.sel(selector), arg);
}

function rect0(a: ObjCApi, object: Pointer, selector: string): RectValue {
  return a.send<RectValue>(NS_RECT, [])(object, a.sel(selector));
}

function alloc(a: ObjCApi, cls: Pointer): Pointer {
  return send0(a, cls, 'alloc');
}

/** `[NSString alloc] initWithBytes:length:encoding:`（Rust `NSString::init_str`）。 */
function allocatedString(a: ObjCApi, text: string): Pointer {
  const bytes = Buffer.from(text, 'utf8');
  const create = a.send<Pointer>('void *', ['void *', 'unsigned long', 'unsigned long']);
  return create(alloc(a, a.cls('NSString')), a.sel('initWithBytes:length:encoding:'), bytes, bytes.length, UTF8_ENCODING);
}

function release(a: ObjCApi, object: Pointer): void {
  send1p(a, object, 'release', 0n);
}

/** `DeepStudentTitlebarSidebarMaterialView`：`isOpaque` → NO，`hitTest:` → nil。 */
function titlebarMaterialClass(a: ObjCApi): Pointer {
  const name = 'DeepStudentTitlebarSidebarMaterialView';
  const existing = a.lookup(name);
  if (!isNil(existing)) return existing;

  const isOpaque = koffi.proto('DSTU_IsOpaque', 'bool', ['void *', 'void *']);
  const hitTest = koffi.proto('DSTU_HitTest', 'void *', ['void *', 'void *', 'double', 'double']);
  titlebarCallbacks = [
    koffi.register(() => false, koffi.pointer(isOpaque)),
    koffi.register(() => 0n, koffi.pointer(hitTest)),
  ];
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const allocate = objc.func('objc_allocateClassPair', 'void *', ['void *', 'str', 'unsigned long']);
  const addMethod = objc.func('class_addMethod', 'bool', ['void *', 'void *', 'void *', 'str']);
  const register = objc.func('objc_registerClassPair', 'void', ['void *']);
  const declared = allocate(a.cls('NSVisualEffectView'), name, 0) as Pointer;
  if (isNil(declared)) throw new Error('创建 NSVisualEffectView 失败');
  const [opaque, hit] = titlebarCallbacks;
  addMethod(declared, a.sel('isOpaque'), opaque, 'c@:');
  addMethod(declared, a.sel('hitTest:'), hit, '@@:{CGPoint=dd}');
  register(declared);
  return declared;
}

function identifiedSubview(a: ObjCApi, container: Pointer, identifier: Pointer): Pointer {
  const subviews = send0(a, container, 'subviews');
  if (isNil(subviews)) return null;
  const count = ulong0(a, subviews, 'count');
  for (let index = 0; index < count; index += 1) {
    const view = long1ul(a, subviews, 'objectAtIndex:', index);
    const viewIdentifier = send0(a, view, 'identifier');
    if (!isNil(viewIdentifier) && bool1p(a, viewIdentifier, 'isEqualToString:', identifier)) return view;
  }
  return null;
}

/**
 * `set_window_appearance`：`[NSAppearance appearanceNamed:]` + `[ns_window setAppearance:]`。
 * 失败文案与 `window_effects.rs:215-266` 一致。
 */
export function setWindowAppearance(target: NativeWindowTarget, dark: boolean): void {
  const a = loadObjCApi();
  const { window } = windowPointer(target);
  const name = allocatedString(a, dark ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua');
  const named = a.send<Pointer>('void *', ['void *'])(a.cls('NSAppearance'), a.sel('appearanceNamed:'), name);
  release(a, name);
  if (isNil(named)) throw new Error('获取 macOS 窗口外观失败');
  send1p(a, window, 'setAppearance:', named);
}

/**
 * `sync_titlebar_sidebar_material`：在标题栏容器（关闭按钮的二级 superview）中同步
 * `DeepStudentTitlebarSidebarMaterialView`。失败文案与 `window_effects.rs:91-170` 一致。
 */
export function syncTitlebarSidebarMaterial(target: NativeWindowTarget, enabled: boolean, width: number): void {
  const a = loadObjCApi();
  const { window } = windowPointer(target);

  const close = long1ul(a, window, 'standardWindowButton:', NS_WINDOW_BUTTON_CLOSE);
  if (isNil(close)) throw new Error('找不到 macOS 标题栏关闭按钮');
  const firstSuperview = send0(a, close, 'superview');
  if (isNil(firstSuperview)) throw new Error('关闭按钮缺少 superview');
  const titlebarContainer = send0(a, firstSuperview, 'superview');
  if (isNil(titlebarContainer)) throw new Error('标题栏容器 superview 缺失');

  const identifier = allocatedString(a, 'com.deepstudent.titlebar-sidebar-material');
  const existing = identifiedSubview(a, titlebarContainer, identifier);
  if (!isNil(existing)) send1p(a, existing, 'removeFromSuperview', null);

  if (!enabled || width <= 0) {
    release(a, identifier);
    return;
  }

  const bounds = rect0(a, titlebarContainer, 'bounds');
  const frame: RectValue = {
    origin: { x: 0, y: 0 },
    size: { width: Math.min(width, bounds.size.width), height: bounds.size.height },
  };
  const cls = titlebarMaterialClass(a);
  const init = a.send<Pointer>('void *', [NS_RECT]);
  const view = init(alloc(a, cls), a.sel('initWithFrame:'), frame);
  if (isNil(view)) {
    release(a, identifier);
    throw new Error('创建 NSVisualEffectView 失败');
  }

  send1p(a, view, 'setIdentifier:', identifier);
  send1ul(a, view, 'setAutoresizingMask:', NS_VIEW_HEIGHT_SIZABLE | NS_VIEW_MAX_X_MARGIN);
  send1b(a, view, 'setWantsLayer:', true);
  send1b(a, view, 'setHidden:', false);
  send1l(a, view, 'setMaterial:', MATERIALS.sidebar ?? 7);
  send1l(a, view, 'setBlendingMode:', NS_VISUAL_EFFECT_BLENDING_BEHIND_WINDOW);
  send1l(a, view, 'setState:', NS_VISUAL_EFFECT_STATE_FOLLOWS_WINDOW_ACTIVE_STATE);

  const addSubview = a.send('void', ['void *', 'long', 'void *']);
  addSubview(titlebarContainer, a.sel('addSubview:positioned:relativeTo:'), view, NS_WINDOW_BELOW, null);
  release(a, view);
  release(a, identifier);
}

/** `set_theme`（tao `set_ns_theme`）：NSApp 全局 appearance；`None` = 跟随系统。 */
export function setApplicationTheme(theme: NativeTheme): void {
  const a = loadObjCApi();
  const app = send0(a, a.cls('NSApplication'), 'sharedApplication');
  if (isNil(app)) return;
  if (!bool1p(a, app, 'respondsToSelector:', a.sel('effectiveAppearance'))) return;
  let appearance: Pointer = null;
  if (theme !== null) {
    const name = allocatedString(a, theme === 'dark' ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua');
    appearance = a.send<Pointer>('void *', ['void *'])(a.cls('NSAppearance'), a.sel('appearanceNamed:'), name);
    release(a, name);
  }
  send1p(a, app, 'setAppearance:', appearance);
}

/** tao `set_title_bar_style`：Visible / Transparent / Overlay（仅 macOS 有实际效果）。 */
export function setTitleBarStyle(target: NativeWindowTarget, style: NativeTitleBarStyle): void {
  const a = loadObjCApi();
  const { window } = windowPointer(target);
  const transparent = style !== 'Visible';
  const fullSize = style !== 'Transparent';
  send1b(a, window, 'setTitlebarAppearsTransparent:', transparent);
  let mask = ulong0(a, window, 'styleMask');
  if (fullSize) mask |= NS_WINDOW_STYLE_FULL_SIZE_CONTENT_VIEW;
  else mask &= ~NS_WINDOW_STYLE_FULL_SIZE_CONTENT_VIEW;
  sendStyleMask(a, target, window, mask);
}

function sendStyleMask(a: ObjCApi, target: NativeWindowTarget, window: Pointer, mask: number): void {
  send1ul(a, window, 'setStyleMask:', mask);
  const raw = target.getNativeWindowHandle();
  if (raw.length >= 8) {
    const view = raw.readBigUInt64LE(0);
    if (view !== 0n) send1p(a, window, 'makeFirstResponder:', view);
  }
}

/**
 * tao `set_decorations`：decorations=true → Closable|Miniaturizable|Resizable|Titled，
 * false → Borderless|Resizable；不可缩放时清掉 Resizable。调用方负责 fullscreen 时跳过。
 */
export function setDecorations(target: NativeWindowTarget, decorations: boolean, resizable: boolean): void {
  const a = loadObjCApi();
  const { window } = windowPointer(target);
  let mask = decorations
    ? NS_WINDOW_STYLE_CLOSABLE | NS_WINDOW_STYLE_MINIATURIZABLE | NS_WINDOW_STYLE_RESIZABLE | NS_WINDOW_STYLE_TITLED
    : NS_WINDOW_STYLE_BORDERLESS | NS_WINDOW_STYLE_RESIZABLE;
  if (!resizable) mask &= ~NS_WINDOW_STYLE_RESIZABLE;
  sendStyleMask(a, target, window, mask);
}

/** tao `set_always_on_bottom`：BelowNormalWindowLevel / NSNormalWindowLevel。 */
export function setAlwaysOnBottom(target: NativeWindowTarget, alwaysOnBottom: boolean): void {
  const a = loadObjCApi();
  const { window } = windowPointer(target);
  send1l(a, window, 'setLevel:', alwaysOnBottom ? NS_WINDOW_BELOW_NORMAL_LEVEL : NS_WINDOW_NORMAL_LEVEL);
}

export interface WindowEffectsConfig {
  effects?: unknown;
  state?: unknown;
  radius?: unknown;
}

function effectMaterial(effect: unknown): number | null {
  if (typeof effect !== 'string') return null;
  return MATERIALS[effect] ?? null;
}

function effectState(state: unknown): number {
  if (typeof state !== 'string') return NS_VISUAL_EFFECT_STATE_FOLLOWS_WINDOW_ACTIVE_STATE;
  return EFFECT_STATES[state] ?? NS_VISUAL_EFFECT_STATE_FOLLOWS_WINDOW_ACTIVE_STATE;
}

/**
 * tauri `vibrancy::macos::apply_effects`：取第一个 macOS 支持的 effect，按
 * window-vibrancy `apply_vibrancy` 的调用序列在 content view 上叠加 NSVisualEffectView。
 * 注意 Rust 在 macOS 上把 `set_effects(null)` 当作 no-op（清理由 Windows 分支负责），此处保持一致。
 */
export function setWindowEffects(target: NativeWindowTarget, config: WindowEffectsConfig | null): void {
  if (config === null) return;
  const effects = Array.isArray(config.effects) ? config.effects : [];
  const material = effects.map(effectMaterial).find((value): value is number => value !== null);
  if (material === undefined) return;

  const a = loadObjCApi();
  const raw = target.getNativeWindowHandle();
  if (raw.length < 8) throw new Error('获取 NSWindow 失败');
  const view = raw.readBigUInt64LE(0);
  if (view === 0n) throw new Error('获取 NSWindow 失败');
  const bounds = rect0(a, view, 'bounds');
  const cls = a.cls('NSVisualEffectView');
  const init = a.send<Pointer>('void *', [NS_RECT]);
  const effectView = init(alloc(a, cls), a.sel('initWithFrame:'), bounds);
  if (isNil(effectView)) throw new Error('创建 NSVisualEffectView 失败');
  send1l(a, effectView, 'setMaterial:', material);
  send1d(a, effectView, 'setCornerRadius:', typeof config.radius === 'number' ? config.radius : 0);
  send1l(a, effectView, 'setBlendingMode:', NS_VISUAL_EFFECT_BLENDING_BEHIND_WINDOW);
  send1l(a, effectView, 'setState:', effectState(config.state));
  send1ul(a, effectView, 'setAutoresizingMask:', NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE);
  const addSubview = a.send('void', ['void *', 'long', 'void *']);
  addSubview(view, a.sel('addSubview:positioned:relativeTo:'), effectView, NS_WINDOW_BELOW, null);
  release(a, effectView);
}
