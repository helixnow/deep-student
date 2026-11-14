/**
 * `dstu-media/src/media/bilibili_transport/session.rs`: route selection between
 * the app's native transport, a paired browser bridge and an explicit proxy.
 */
import type { Route, RouteMode } from '../api.ts';
import { BiliRequestError } from './bilibili-policy.ts';

/** `session.rs::next_request_id`：进程内单调递增，从 1 开始。 */
let requestId = 1;
export function nextRequestId(): number {
  return requestId++;
}

/**
 * Auto keeps the app account (native) first; a guest prefers a bridge that can
 * read media when one is ready. Explicit modes never silently switch.
 */
export function selectRoute(
  mode: RouteMode,
  bridgeReady: boolean,
  parsingOnly: boolean,
  nativeFirst: boolean,
): Route {
  if (mode === 'auto') {
    if (nativeFirst) return 'native';
    if (bridgeReady) return 'browser_bridge';
    return 'native';
  }
  if (mode === 'native') return 'native';
  if (mode === 'browser_bridge') {
    if (bridgeReady) return 'browser_bridge';
    throw new BiliRequestError('bridge-offline', parsingOnly
      ? '当前浏览器桥仅支持解析，不支持安全媒体读取'
      : '浏览器桥未就绪，请连接浏览器');
  }
  return 'proxy';
}
