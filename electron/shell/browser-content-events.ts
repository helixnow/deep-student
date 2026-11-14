/**
 * browser-content 页面生命周期 → Host browser 插件（Rust `ContentWindowHooks`，由 `BrowserService`
 * 转成前端的 `browser:navigated` / `browser:title-changed`）。
 *
 * - `on_page_load(PageLoadEvent::Finished)` → {@link PAGE_FINISHED_EVENT} `{ url }`。WKWebView 只在导航成功时
 *   回调 `didFinishNavigation`；Chromium 在失败后会提交错误页并照样触发 `did-finish-load`，这里跳过以失败结束的加载
 *   （否则被私网防护拦下的 URL 会被插件当作页面发起的导航写进历史）。
 * - `on_document_title_changed` → {@link TITLE_CHANGED_EVENT} `{ title, url }`，url 为当前 WebView 地址
 *   （Rust `webview.url().ok()`）。Chromium 在页面没有 `<title>` 时用 URL 合成标题（`explicitSet === false`），
 *   WKWebView 的 `title` 此时为空且不回调，这类合成标题不转发。
 */
import type { WebContents } from 'electron';
import type { WindowRef } from '../../host/kernel/protocol.ts';
import { nativeFrontendEvent, type NativeFrontendEvent } from './events.ts';

export const PAGE_FINISHED_EVENT = 'dstu-browser://page-finished';
export const TITLE_CHANGED_EVENT = 'dstu-browser://title-changed';

/**
 * main 自己产生的 browser-content 原生回调（页面加载、标题、导航被拦），带 `native: true`（{@link nativeFrontendEvent}）：
 * 页面经 `plugin:event|emit` 转给 Host 的 frontend-event（`plugins/event.ts`）从不带它，Host 侧可据此
 * 只接受原生事件，即使 ACL 之外还有别的途径让页面以 browser-content 的来源发出同名事件。
 */
export type NativeBrowserContentEvent = NativeFrontendEvent;

export function nativeBrowserContentEvent(source: WindowRef, event: string, payload: Record<string, unknown>): NativeBrowserContentEvent {
  return nativeFrontendEvent(source, event, payload);
}

/** `net::ERR_ABORTED`：被新的导航取代或被 `will-navigate` 拦下，原页面不变，不算失败的加载。 */
const ERR_ABORTED = -3;

export type BrowserContentEventSink = (event: string, payload: Record<string, unknown>) => void;

export function forwardBrowserContentEvents(contents: WebContents, emit: BrowserContentEventSink): void {
  let failed = false;
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) failed = false;
  });
  contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) failed = true;
  });
  contents.on('did-finish-load', () => {
    if (failed || contents.isDestroyed()) return;
    emit(PAGE_FINISHED_EVENT, { url: contents.getURL() });
  });
  contents.on('page-title-updated', (_event, title, explicitSet) => {
    if (!explicitSet || failed || contents.isDestroyed()) return;
    const url = contents.getURL();
    emit(TITLE_CHANGED_EVENT, { title, url: url === '' ? null : url });
  });
}
