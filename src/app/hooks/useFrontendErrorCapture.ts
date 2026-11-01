import { useCallback } from 'react';
import { emitDebug } from '@/utils/emitDebug';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ★ debugLog 别名：与 App.tsx 相同，console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * App 壳层：window error / unhandledrejection 采集到调试事件（channel=error,
 * eventName=frontend_error）。从 App.tsx 原样搬出。
 */
export function useFrontendErrorCapture() {
  // 前端错误采集：记录到事件模式（channel='error', eventName='frontend_error'）
  // 原生 DOM 事件走 useEventRegistry（非 CustomEvent 域）
  const onFrontendError = useCallback((ev: Event) => {
    const dispatchFrontendErrorDebug = (payload: Record<string, unknown>) => {
      const meta = { path: window.location?.pathname, ua: navigator?.userAgent };
      const emitTask = () => {
        try {
          emitDebug({ channel: 'error', eventName: 'frontend_error', payload, meta });
        } catch (e) { debugLog.warn('[App] emitDebug frontend_error failed:', e); }
      };
      if (typeof queueMicrotask === 'function') {
        try {
          queueMicrotask(emitTask);
          return;
        } catch { /* non-critical: queueMicrotask unavailable, falls through to setTimeout */ }
      }
      setTimeout(emitTask, 0);
    };

    try {
      const errorEvent = ev as ErrorEvent & { target?: EventTarget | null };
      const target = errorEvent.target as (EventTarget & {
        currentSrc?: string;
        src?: string;
        href?: string;
        tagName?: string;
        baseURI?: string;
      }) | null;
      const isResourceError = Boolean(errorEvent && target && target !== window);
      if (isResourceError) {
        const src = target?.currentSrc || target?.src || target?.href || '';
        if (typeof src === 'string' && src.includes('/sse-proxy/')) {
          return;
        }
      }
      const payload = isResourceError
        ? {
          type: 'ResourceError',
          tagName: target?.tagName,
          src: target?.currentSrc || target?.src || target?.href,
          baseURI: target?.baseURI,
        }
        : {
          type: 'Error',
          message: errorEvent?.message || String((errorEvent as ErrorEvent)?.error || 'Unknown error'),
          stack: (errorEvent?.error && (errorEvent.error as Error)?.stack) || undefined,
          filename: errorEvent?.filename,
          lineno: errorEvent?.lineno,
          colno: errorEvent?.colno,
        };
      dispatchFrontendErrorDebug(payload);
      console.error('[DSTU][FRONTEND_ERROR]', payload);
    } catch (e) { debugLog.warn('[App] onError handler failed:', e); }
  }, []);

  const onUnhandledRejection = useCallback((ev: Event) => {
    try {
      const rejection = ev as PromiseRejectionEvent;
      const reason = rejection?.reason || 'Unknown rejection';
      const message = typeof reason === 'string' ? reason : (reason?.message || String(reason));

      if (message.includes('fetch_cancel_body') || message.includes('http.fetch_cancel_body')) {
        return;
      }

      emitDebug({
        channel: 'error',
        eventName: 'frontend_error',
        payload: {
          type: 'UnhandledRejection',
          message,
          stack: typeof reason === 'object' && reason ? reason.stack : undefined,
        },
        meta: { path: window.location?.pathname, ua: navigator?.userAgent },
      });
    } catch (e) { debugLog.warn('[App] onRejection handler failed:', e); }
  }, []);

  useEventRegistry([
    { target: 'window', type: 'error', listener: onFrontendError, options: true },
    { target: 'window', type: 'unhandledrejection', listener: onUnhandledRejection },
  ], [onFrontendError, onUnhandledRejection]);
}
