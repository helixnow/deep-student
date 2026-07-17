/**
 * 内置浏览器 Workbench 应用注册（BROWSER · B2b）
 *
 * instanceMode=single：一期全局 0..1 session（design §1.1）。
 * 不钉 DEFAULT_DOCK_PINNED；发现走 AppsPanel / Agent launch。
 * 默认提供 920×600 的 chrome + native page surface。
 */
import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import { BrowserApiError } from '@/features/browser/browserApi';
import { getBrowserSessionState } from '@/features/browser/sessionStore';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult } from '../../core/types';
import {
  BROWSER_FOCUS_ADDRESS_EVENT,
  type BrowserFocusAddressEventDetail,
} from './browserChromeEvents';
import { createBrowserAgentManifest } from './agentManifest';

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
        return { handled: true, acknowledged: true };
      }
      case 'goBack':
        await api.back();
        return { handled: true, acknowledged: true };
      case 'goForward':
        await api.forward();
        return { handled: true, acknowledged: true };
      case 'reload':
        await api.reload();
        return { handled: true, acknowledged: true };
      case 'focusAddress': {
        if (typeof window === 'undefined') {
          return { handled: false, code: 'WINDOW_UNAVAILABLE' };
        }
        const focused = await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            resolve(value);
          };
          const timeout = window.setTimeout(() => finish(false), 500);
          const detail: BrowserFocusAddressEventDetail = {
            windowId: ctx.windowId,
            acknowledge: finish,
          };
          window.dispatchEvent(new CustomEvent(BROWSER_FOCUS_ADDRESS_EVENT, { detail }));
        });
        return focused
          ? { handled: true, acknowledged: true }
          : {
              handled: false,
              code: 'ACTION_UNAVAILABLE',
              message: '浏览器地址栏未挂载或无法获得焦点',
            };
      }
      case 'takeOver':
        await api.takeOver();
        return { handled: true, acknowledged: true };
      case 'showContent': {
        const shown = await api.showContent();
        return shown
          ? { handled: true, acknowledged: true }
          : {
              handled: false,
              code: 'CONTENT_WINDOW_NOT_FOUND',
              message: '浏览器页面窗口不存在',
            };
      }
      case 'hideContent':
        await api.hideContent();
        return { handled: true, acknowledged: true };
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

/** Native content is closed after the shell's closing animation unmounts. */
async function canCloseBrowser(_instanceKey: string | null): Promise<boolean> {
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
    icon: <AppIconImage typeId="browser" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 2,
    keepAliveWhenOccluded: true,
    defaultFrame: { w: 920, h: 600 },
    minSize: { w: 640, h: 420 },
    render: React.lazy(() => import('./BrowserAppWindow')),
    onActivation: handleBrowserActivation,
    agentManifest: createBrowserAgentManifest(handleBrowserActivation),
    canClose: canCloseBrowser,
  });
}
