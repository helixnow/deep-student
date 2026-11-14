/**
 * macOS 输入遮挡层（`window/macos_surface_clip.rs` 的 Electron 等价实现）。
 *
 * Rust 侧用一个反转的 NSView 包住子 WKWebView，整块视图用 CAShapeLayer 挖洞，
 * `hitTest:` 在输入遮挡矩形内返回 nil，让事件落到下面的 React WebView。
 *
 * Electron 的 `WebContentsViewCocoa` 由 Chromium 合成器直接绘制，父视图的 layer mask
 * 不影响其像素输出（实测），所以视觉遮挡改为在页面内注入 `clip-path`
 * （见 `browser-surface.ts`）。本模块只负责输入：在内容视图最上层放一个透明 NSView，
 * 命中输入遮挡矩形时把事件转给主 WebContentsView 的最深命中视图。
 *
 * 只在 Electron main（Cocoa 主线程）调用。
 */
import koffi from 'koffi';
import type { BrowserWindow } from 'electron';
import {
  isNil,
  loadObjCApi,
  type ObjCApi,
  type Pointer,
  type PointValue,
  type RectValue,
} from './native-window.ts';
import type { LogicalRect } from './browser-protocol.ts';

export type { LogicalRect } from './browser-protocol.ts';

interface OverlayState {
  contentView: Pointer;
  mainView: Pointer;
  inputOcclusions: readonly LogicalRect[];
}

const WIDTH_SIZABLE = 2;
const HEIGHT_SIZABLE = 16;
const WINDOW_ABOVE = 1;

const states = new Map<bigint, OverlayState>();
let hitTestCallback: bigint | null = null;
let isOpaqueCallback: bigint | null = null;
let overlayClass: Pointer = null;
let objectClassName: ((value: unknown) => string) | null = null;

const POINT = koffi.struct('DSTU_BrowserPoint', { x: 'double', y: 'double' });
const SIZE = koffi.struct('DSTU_BrowserSize', { width: 'double', height: 'double' });
const RECT = koffi.struct('DSTU_BrowserRect', { origin: POINT, size: SIZE });

function sendPointer(a: ObjCApi, object: Pointer, selector: string): Pointer {
  return a.send<Pointer>('void *', [])(object, a.sel(selector));
}

function sendPointerArg(a: ObjCApi, object: Pointer, selector: string, arg: Pointer): void {
  a.send('void', ['void *'])(object, a.sel(selector), arg);
}

function sendUnsignedLong(a: ObjCApi, object: Pointer, selector: string, value: number): void {
  a.send('void', ['unsigned long'])(object, a.sel(selector), value);
}

function readBool(a: ObjCApi, object: Pointer, selector: string): boolean {
  return a.send<boolean>('bool', [])(object, a.sel(selector));
}

function readUnsignedLong(a: ObjCApi, object: Pointer, selector: string): number {
  return a.send<number>('unsigned long', [])(object, a.sel(selector));
}

function readDouble(a: ObjCApi, object: Pointer, selector: string): number {
  return a.send<number>('double', [])(object, a.sel(selector));
}

function readRect(a: ObjCApi, object: Pointer, selector: string): RectValue {
  return a.send<RectValue>(RECT, [])(object, a.sel(selector));
}

function sendRectResult(a: ObjCApi, object: Pointer, selector: string, rect: RectValue): Pointer {
  return a.send<Pointer>('void *', [RECT])(object, a.sel(selector), rect);
}

function classNameOf(object: Pointer): string {
  if (objectClassName === null) {
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    objectClassName = objc.func('object_getClassName', 'str', ['void *']) as (value: unknown) => string;
  }
  const name = objectClassName(object);
  return typeof name === 'string' ? name : '';
}

function subviews(a: ObjCApi, view: Pointer): Pointer[] {
  const list = sendPointer(a, view, 'subviews');
  if (isNil(list)) return [];
  const count = readUnsignedLong(a, list, 'count');
  const output: Pointer[] = [];
  for (let index = 0; index < count; index += 1) {
    const child = a.send<Pointer>('void *', ['unsigned long'])(list, a.sel('objectAtIndex:'), index);
    if (!isNil(child)) output.push(child);
  }
  return output;
}

function contains(rect: LogicalRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function overlayHostClass(a: ObjCApi): Pointer {
  if (!isNil(overlayClass)) return overlayClass;
  const name = 'DeepStudentBrowserSurfaceInputHost';
  const existing = a.lookup(name);
  if (!isNil(existing)) {
    overlayClass = existing;
    return existing;
  }

  const hit = koffi.proto('DSTU_BrowserInputHitTest', 'void *', ['void *', 'void *', 'double', 'double']);
  const opaque = koffi.proto('DSTU_BrowserInputIsOpaque', 'bool', ['void *', 'void *']);
  hitTestCallback = koffi.register((self: bigint, _cmd: Pointer, x: number, y: number) => {
    const state = states.get(self);
    if (state === undefined) return 0n;
    const bounds = readRect(a, state.contentView, 'bounds');
    const flipped = readBool(a, state.contentView, 'isFlipped');
    const yTop = flipped ? y : bounds.size.height - (y - bounds.origin.y);
    if (!state.inputOcclusions.some((rect) => contains(rect, x, yTop))) return 0n;
    const point: PointValue = { x, y };
    const deep = a.send<Pointer>('void *', [POINT])(state.mainView, a.sel('hitTest:'), point);
    return isNil(deep) ? 0n : deep;
  }, koffi.pointer(hit));
  isOpaqueCallback = koffi.register(() => false, koffi.pointer(opaque));

  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const allocate = objc.func('objc_allocateClassPair', 'void *', ['void *', 'str', 'unsigned long']);
  const addMethod = objc.func('class_addMethod', 'bool', ['void *', 'void *', 'void *', 'str']);
  const register = objc.func('objc_registerClassPair', 'void', ['void *']);
  const declared = allocate(a.cls('NSView'), name, 0) as Pointer;
  if (isNil(declared)) throw new Error('failed to allocate browser input host');
  if (hitTestCallback === null || isOpaqueCallback === null) throw new Error('failed to allocate browser input callbacks');
  addMethod(declared, a.sel('hitTest:'), hitTestCallback, '@@:{CGPoint=dd}');
  addMethod(declared, a.sel('isOpaque'), isOpaqueCallback, 'c@:');
  register(declared);
  overlayClass = declared;
  return declared;
}

function backingScale(a: ObjCApi, contentView: Pointer): number {
  const window = sendPointer(a, contentView, 'window');
  if (isNil(window)) throw new Error('browser input host has no NSWindow');
  const scale = readDouble(a, window, 'backingScaleFactor');
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('browser input host has an invalid backing scale factor');
  }
  return scale;
}

function contentViewPointer(window: BrowserWindow): Pointer {
  const raw = window.getNativeWindowHandle();
  if (raw.length < 8) throw new Error('browser content view handle was null');
  const contentView = raw.readBigUInt64LE(0);
  if (isNil(contentView)) throw new Error('browser content view handle was null');
  return contentView;
}

function mainWebContentsView(a: ObjCApi, contentView: Pointer): Pointer {
  const bounds = readRect(a, contentView, 'bounds');
  const candidates = subviews(a, contentView).filter((view) => classNameOf(view) === 'WebContentsViewCocoa');
  const mainView = candidates.find((view) => {
    const frame = readRect(a, view, 'frame');
    return frame.size.width === bounds.size.width && frame.size.height === bounds.size.height;
  }) ?? candidates[0];
  if (mainView === undefined) throw new Error('browser content view has no main webview');
  return mainView;
}

export class MacInputOcclusionHost {
  private readonly contentView: Pointer;
  private readonly overlay: Pointer;
  private readonly mainView: Pointer;

  private constructor(contentView: Pointer, overlay: Pointer, mainView: Pointer) {
    this.contentView = contentView;
    this.overlay = overlay;
    this.mainView = mainView;
    states.set(overlay as bigint, { contentView, mainView, inputOcclusions: [] });
  }

  static install(window: BrowserWindow): MacInputOcclusionHost {
    const a = loadObjCApi();
    const contentView = contentViewPointer(window);
    const mainView = mainWebContentsView(a, contentView);
    const bounds = readRect(a, contentView, 'bounds');
    const hostClass = overlayHostClass(a);
    const overlay = sendRectResult(a, sendPointer(a, hostClass, 'alloc'), 'initWithFrame:', bounds);
    if (isNil(overlay)) throw new Error('failed to allocate browser input host');
    sendUnsignedLong(a, overlay, 'setAutoresizingMask:', WIDTH_SIZABLE | HEIGHT_SIZABLE);
    sendPointerArg(a, contentView, 'addSubview:', overlay);
    const host = new MacInputOcclusionHost(contentView, overlay, mainView);
    host.raise();
    return host;
  }

  scaleFactor(): number {
    return backingScale(loadObjCApi(), this.contentView);
  }

  setInputOcclusions(rects: readonly LogicalRect[]): void {
    const state = states.get(this.overlay as bigint);
    if (state === undefined) throw new Error('browser input host was not installed');
    states.set(this.overlay as bigint, { ...state, inputOcclusions: [...rects] });
  }

  raise(): void {
    const a = loadObjCApi();
    a.send('void', ['void *', 'long', 'void *'])(
      this.contentView,
      a.sel('addSubview:positioned:relativeTo:'),
      this.overlay,
      WINDOW_ABOVE,
      null,
    );
  }

  remove(): void {
    if (!isNil(this.overlay)) {
      const a = loadObjCApi();
      a.send('void', [])(this.overlay, a.sel('removeFromSuperview'));
    }
    states.delete(this.overlay as bigint);
  }
}
