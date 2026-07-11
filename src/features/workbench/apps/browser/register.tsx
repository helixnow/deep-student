/**
 * 内置浏览器 Workbench 应用注册（BROWSER · B2b）
 *
 * instanceMode=single：一期全局 0..1 session（design §1.1）。
 * 不钉 DEFAULT_DOCK_PINNED；发现走 AppsPanel / Agent launch。
 * chrome 壳约 720×280；真实页面在独立 WebviewWindow `browser-content`。
 */
import React from 'react';
import { Globe } from '@phosphor-icons/react';
import { BrowserApiError } from '@/features/browser/browserApi';
import { getBrowserSessionState } from '@/features/browser/sessionStore';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult } from '../../core/types';
import { BROWSER_FOCUS_ADDRESS_EVENT } from './browserChromeEvents';

export const BROWSER_APP_TYPE_ID = 'browser';
export { BROWSER_FOCUS_ADDRESS_EVENT };

function payloadUrl(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (payload && typeof payload === 'object') {
    const url = (payload as { url?: unknown }).url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return null;
}

function activationError(err: unknown): ActivationResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    handled: false,
    code: err instanceof BrowserApiError ? err.code : 'BROWSER_ACTION_FAILED',
    message,
    hint: message,
  };
}

/** onActivation：await navigate / focusAddress / takeOver / showContent 的真实结果 */
export async function handleBrowserActivation(ctx: ActivationContext): Promise<ActivationResult> {
  const api = getBrowserSessionState();
  try {
    switch (ctx.action) {
      case 'navigate': {
        const url = payloadUrl(ctx.payload);
        if (!url) {
          return {
            handled: false,
            code: 'INVALID_ARGS',
            message: 'browser navigate 缺少 url',
          };
        }
        // Agent app_command：不打 user_takeover 闩锁，同时必须保留来源供 Rust 私网硬拦。
        await api.navigate(url, { forceUserControl: false, fromAgent: true });
        return { handled: true };
      }
      case 'focusAddress': {
        if (typeof window === 'undefined') {
          return { handled: false, code: 'WINDOW_UNAVAILABLE' };
        }
        const emit = () => {
          if (typeof window === 'undefined') return;
          window.dispatchEvent(new CustomEvent(BROWSER_FOCUS_ADDRESS_EVENT));
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(emit);
        }
        window.setTimeout(emit, 120);
        return { handled: true };
      }
      case 'takeOver':
        await api.takeOver();
        return { handled: true };
      case 'showContent': {
        const shown = await api.showContent();
        return shown
          ? { handled: true }
          : {
              handled: false,
              code: 'CONTENT_WINDOW_NOT_FOUND',
              message: '浏览器页面窗口不存在',
            };
      }
      default:
        return {
          handled: false,
          code: 'UNKNOWN_ACTION',
          message: `未知 browser action: ${ctx.action}`,
        };
    }
  } catch (err) {
    console.warn(`[workbench:browser] ${ctx.action} failed:`, err);
    return activationError(err);
  }
}

/** 关 chrome 时销毁 session / content（design：禁止孤儿窗） */
async function canCloseBrowser(_instanceKey: string | null): Promise<boolean> {
  try {
    await getBrowserSessionState().closeSession();
  } catch (err) {
    console.warn('[workbench:browser] closeSession failed:', err);
    return false;
  }
  return true;
}

let registered = false;

/** 幂等注册内置浏览器应用（不钉 Dock） */
export function registerBrowserApp(): void {
  if (registered) return;
  registered = true;

  appRegistry.register({
    typeId: BROWSER_APP_TYPE_ID,
    nameKey: 'workbench:apps.browser',
    icon: <Globe size={26} weight="duotone" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 720, h: 280 },
    minSize: { w: 480, h: 200 },
    render: React.lazy(() => import('./BrowserAppWindow')),
    onActivation: handleBrowserActivation,
    canClose: canCloseBrowser,
  });
}
