/**
 * Dev-only UI 自动化桥（Playwright-MCP 风格，供 scripts/dev/ui-drive.mjs 驱动）。
 *
 * 启用条件：dev 构建 + 环境变量 VITE_DS_UI_BRIDGE=1（见 src/main.tsx）。
 * 通信：连接本地 ws://127.0.0.1:17423/app，接收 { id, code }，执行后回传 JSON。
 * 能力：window.__DS_BRIDGE__ 暴露快照（带稳定 ref）、点击、输入、按键、滚动、
 *       滑动手势、返回键、控制台错误采集、Tauri invoke/window 句柄。
 *
 * 注意：执行任意代码依赖 CSP 'unsafe-eval'，审查会话通过
 *       `tauri dev --config <override>` 临时放开；仓库默认 CSP 不变。
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';

const BRIDGE_URL = 'ws://127.0.0.1:17423/app';

// ---------------------------------------------------------------------------
// 控制台/错误采集（环形缓冲）
// ---------------------------------------------------------------------------
interface LogEntry {
  ts: number;
  kind: 'error' | 'warn' | 'uncaught' | 'unhandledrejection';
  text: string;
}

const logBuffer: LogEntry[] = [];
const LOG_CAP = 300;

function pushLog(kind: LogEntry['kind'], text: string) {
  logBuffer.push({ ts: Date.now(), kind, text: text.slice(0, 800) });
  if (logBuffer.length > LOG_CAP) logBuffer.splice(0, logBuffer.length - LOG_CAP);
}

function installConsoleCapture() {
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    pushLog('error', args.map(String).join(' '));
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    pushLog('warn', args.map(String).join(' '));
    origWarn(...args);
  };
  window.addEventListener('error', (e) => {
    pushLog('uncaught', `${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    pushLog('unhandledrejection', String(e.reason));
  });
}

// ---------------------------------------------------------------------------
// 快照与 ref 定位
// ---------------------------------------------------------------------------
type RefMap = Map<string, WeakRef<Element>>;

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  rect: { x: number; y: number; w: number; h: number };
  region?: string;
}

const refs: RefMap = new Map();
let refCounter = 0;

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="link"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  'summary',
].join(',');

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  const style = getComputedStyle(he);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.01) {
    return false;
  }
  const rect = he.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
    return false;
  }
  return true;
}

function accessibleName(el: Element): string {
  const he = el as HTMLElement;
  const aria = he.getAttribute('aria-label');
  if (aria) return aria;
  const labelledBy = he.getAttribute('aria-labelledby');
  if (labelledBy) {
    const target = document.getElementById(labelledBy);
    if (target) return (target.textContent || '').trim().slice(0, 80);
  }
  if (he instanceof HTMLInputElement || he instanceof HTMLTextAreaElement) {
    return he.placeholder || he.name || '';
  }
  const title = he.getAttribute('title');
  const text = (he.textContent || '').replace(/\s+/g, ' ').trim();
  return (text || title || '').slice(0, 80);
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'range') return type;
    return 'textbox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'a') return 'link';
  if (el.getAttribute('contenteditable') === 'true') return 'textbox';
  return tag === 'button' ? 'button' : tag;
}

function regionOf(el: Element): string | undefined {
  const dialog = el.closest('[role="dialog"], [role="alertdialog"], [data-radix-portal], [class*="modal" i]');
  if (dialog) {
    const heading = dialog.querySelector('h1,h2,h3,[class*="title" i]');
    return `dialog:${(heading?.textContent || 'unnamed').trim().slice(0, 30)}`;
  }
  const drawer = el.closest('[class*="drawer" i], [class*="sheet" i], aside');
  if (drawer) return 'drawer';
  const header = el.closest('header, [class*="mobile-header" i], [class*="MobileHeader"]');
  if (header) return 'header';
  const nav = el.closest('nav');
  if (nav) return 'nav';
  return undefined;
}

function snapshot(opts?: { all?: boolean }) {
  refs.clear();
  refCounter = 0;
  const elements: SnapshotElement[] = [];
  const seen = new Set<Element>();

  for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!opts?.all && !isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const ref = `e${++refCounter}`;
    refs.set(ref, new WeakRef(el));
    const he = el as HTMLElement & { disabled?: boolean; checked?: boolean; value?: string };
    const entry: SnapshotElement = {
      ref,
      role: roleOf(el),
      name: accessibleName(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
    if (he.disabled !== undefined && he.disabled) entry.disabled = true;
    if (typeof he.checked === 'boolean') entry.checked = he.checked;
    if (
      (el instanceof HTMLInputElement && el.type !== 'password') ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      entry.value = String(el.value).slice(0, 120);
    }
    const region = regionOf(el);
    if (region) entry.region = region;
    elements.push(entry);
  }

  const headings = Array.from(document.querySelectorAll('h1,h2'))
    .filter((h) => isVisible(h))
    .map((h) => (h.textContent || '').trim().slice(0, 60))
    .slice(0, 6);

  const openDialogs = Array.from(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
  ).filter(isVisible).length;

  return {
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    headings,
    openDialogs,
    count: elements.length,
    elements,
  };
}

function resolveTarget(target: string): Element | null {
  if (/^e\d+$/.test(target)) {
    const el = refs.get(target)?.deref();
    if (el && el.isConnected) return el;
    return null;
  }
  if (target.startsWith('css=')) {
    return document.querySelector(target.slice(4));
  }
  // 文本匹配：优先精确、再前缀、再包含；只匹配可见元素
  const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const wanted = norm(target);
  return (
    candidates.find((el) => norm(accessibleName(el)) === wanted) ||
    candidates.find((el) => norm(accessibleName(el)).startsWith(wanted)) ||
    candidates.find((el) => norm(accessibleName(el)).includes(wanted)) ||
    null
  );
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------
function pointerSequence(el: Element, type: 'tap' | 'click') {
  const rect = el.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: type === 'tap' ? 'touch' : 'mouse',
    isPrimary: true,
  } as PointerEventInit & MouseEventInit;
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

function doClick(target: string, opts?: { tap?: boolean; scroll?: boolean }) {
  const el = resolveTarget(target);
  if (!el) return { ok: false, error: `target not found: ${target}` };
  if (opts?.scroll !== false) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  if (opts?.tap) {
    pointerSequence(el, 'tap');
  } else {
    (el as HTMLElement).click();
  }
  return { ok: true, role: roleOf(el), name: accessibleName(el) };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function doType(target: string, text: string, opts?: { clear?: boolean; enter?: boolean }) {
  const el = resolveTarget(target);
  if (!el) return { ok: false, error: `target not found: ${target}` };
  const he = el as HTMLElement;
  he.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const next = opts?.clear === false ? el.value + text : text;
    setNativeValue(el, next);
  } else if (he.isContentEditable) {
    if (opts?.clear !== false) he.textContent = '';
    he.textContent += text;
    he.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  } else {
    return { ok: false, error: 'target is not editable' };
  }
  if (opts?.enter) {
    dispatchKey(he, 'Enter');
  }
  return { ok: true, value: (el as HTMLInputElement).value ?? he.textContent };
}

function dispatchKey(el: Element, key: string, mods?: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) {
  const init: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    composed: true,
    metaKey: mods?.meta,
    ctrlKey: mods?.ctrl,
    altKey: mods?.alt,
    shiftKey: mods?.shift,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

function doKey(key: string, mods?: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) {
  dispatchKey(document.activeElement || document.body, key, mods);
  return { ok: true, key, active: (document.activeElement?.tagName || 'body').toLowerCase() };
}

function doScroll(target: string | null, dy: number, dx = 0) {
  let el: Element | null = null;
  if (target) {
    el = resolveTarget(target);
    if (!el) return { ok: false, error: `target not found: ${target}` };
  } else {
    // 找当前视口中心命中的可滚动容器
    const center = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    el = center;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (
        (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY)) ||
        (el.scrollWidth > el.clientWidth + 4 && /(auto|scroll)/.test(style.overflowX))
      ) {
        break;
      }
      el = el.parentElement;
    }
    if (!el) el = document.scrollingElement;
  }
  if (!el) return { ok: false, error: 'no scrollable element' };
  el.scrollBy({ top: dy, left: dx, behavior: 'instant' as ScrollBehavior });
  const se = el as HTMLElement;
  return {
    ok: true,
    tag: se.tagName.toLowerCase(),
    scrollTop: se.scrollTop,
    scrollHeight: se.scrollHeight,
    clientHeight: se.clientHeight,
    atBottom: se.scrollTop + se.clientHeight >= se.scrollHeight - 2,
  };
}

async function doSwipe(from: [number, number], to: [number, number], ms = 250, pointerType: 'touch' | 'mouse' = 'touch') {
  const steps = Math.max(4, Math.round(ms / 16));
  const startEl = document.elementFromPoint(from[0], from[1]) || document.body;
  const base = { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType, isPrimary: true };
  startEl.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: from[0], clientY: from[1] }));
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    const overEl = document.elementFromPoint(x, y) || document.body;
    overEl.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, ms / steps));
  }
  const endEl = document.elementFromPoint(to[0], to[1]) || document.body;
  endEl.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: to[0], clientY: to[1] }));
  return { ok: true, from, to, ms };
}

function doBack() {
  const handler = (window as unknown as { __DEEP_STUDENT_HANDLE_BACK__?: () => boolean }).__DEEP_STUDENT_HANDLE_BACK__;
  if (typeof handler === 'function') {
    const handled = handler();
    return { ok: true, mode: 'android-coordinator', handled };
  }
  history.back();
  return { ok: true, mode: 'history.back' };
}

function doReload() {
  window.location.reload();
  return { ok: true };
}

function doResetMobileView() {
  window.dispatchEvent(new CustomEvent('learning-hub:mobile-reset'));
  window.dispatchEvent(new CustomEvent('deep-student:mobile-view-reset'));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 暴露全局 API
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __DS_BRIDGE__: {
      snapshot: typeof snapshot;
      click: typeof doClick;
      type: typeof doType;
      key: typeof doKey;
      scroll: typeof doScroll;
      swipe: typeof doSwipe;
      back: typeof doBack;
      reload: typeof doReload;
      resetMobileView: typeof doResetMobileView;
      errors: (clear?: boolean) => LogEntry[];
      invoke: typeof invoke;
      win: ReturnType<typeof getCurrentWindow>;
      LogicalSize: typeof LogicalSize;
    };
  }
}

function installApi() {
  window.__DS_BRIDGE__ = {
    snapshot,
    click: doClick,
    type: doType,
    key: doKey,
    scroll: doScroll,
    swipe: doSwipe,
    back: doBack,
    reload: doReload,
    resetMobileView: doResetMobileView,
    errors: (clear?: boolean) => {
      const copy = [...logBuffer];
      if (clear) logBuffer.length = 0;
      return copy;
    },
    invoke,
    win: getCurrentWindow(),
    LogicalSize,
  };
}

// ---------------------------------------------------------------------------
// WebSocket 循环
// ---------------------------------------------------------------------------
function startBridge() {
  let ws: WebSocket | null = null;

  const connect = () => {
    try {
      ws = new WebSocket(BRIDGE_URL);
    } catch {
      setTimeout(connect, 2000);
      return;
    }

    ws.onopen = () => console.info('[ui-bridge] connected');

    ws.onmessage = async (ev) => {
      let msg: { id: number; code: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      try {
        const fn = new Function(
          `return (async () => { ${msg.code}\n })();`,
        ) as () => Promise<unknown>;
        const value = await fn();
        ws?.send(JSON.stringify({ id: msg.id, ok: true, value: value ?? null }));
      } catch (e) {
        ws?.send(
          JSON.stringify({
            id: msg.id,
            ok: false,
            error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          }),
        );
      }
    };

    ws.onclose = () => {
      ws = null;
      setTimeout(connect, 1500);
    };
    ws.onerror = () => ws?.close();
  };

  connect();
}

installConsoleCapture();
installApi();
startBridge();

export {};
