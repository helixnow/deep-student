/**
 * 内置浏览器 Workbench 应用注册（BROWSER · B2b）
 *
 * instanceMode=single：一期全局 0..1 session（design §1.1）。
 * 不钉 DEFAULT_DOCK_PINNED；发现走 AppsPanel / Agent launch。
 * chrome 壳约 720×280；真实页面在独立 WebviewWindow `browser-content`。
 */
import React from 'react';
import { Globe } from '@phosphor-icons/react';
import { getBrowserSessionState } from '@/features/browser/sessionStore';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext } from '../../core/types';
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

/** onActivation：navigate / focusAddress / takeOver / showContent */
export function handleBrowserActivation(ctx: ActivationContext): void {
  const api = getBrowserSessionState();
  switch (ctx.action) {
    case 'navigate': {
      const url = payloadUrl(ctx.payload);
      if (!url) {
        console.warn('[workbench:browser] navigate ignored: missing url');
        return;
      }
      // Agent app_command：勿 forceUserControl，否则会误打接管冷却闩锁（R2-10）
      void api.navigate(url, { forceUserControl: false }).catch((err) =>
        console.warn('[workbench:browser] navigate failed:', err),
      );
      break;
    }
    case 'focusAddress': {
      if (typeof window === 'undefined') return;
      const emit = () => {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent(BROWSER_FOCUS_ADDRESS_EVENT));
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(emit);
      }
      window.setTimeout(emit, 120);
      break;
    }
    case 'takeOver': {
      void api.takeOver().catch((err) =>
        console.warn('[workbench:browser] takeOver failed:', err),
      );
      break;
    }
    case 'showContent': {
      void api.showContent().catch((err) =>
        console.warn('[workbench:browser] showContent failed:', err),
      );
      break;
    }
    default:
      console.warn(`[workbench:browser] unknown activation action: ${ctx.action}`);
  }
}

/** 关 chrome 时销毁 session / content（design：禁止孤儿窗） */
async function canCloseBrowser(_instanceKey: string | null): Promise<boolean> {
  try {
    await getBrowserSessionState().closeSession();
  } catch (err) {
    console.warn('[workbench:browser] closeSession failed:', err);
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
