// ★ 2026-02-04: 最早的全局错误过滤器
// 必须在任何其他代码之前运行，以便在 tauri-plugin-mcp-bridge 之前捕获错误
// 这是一个 IIFE，在模块加载时立即执行
(() => {
  if (typeof window === 'undefined') return;
  
  // 过滤 Tauri HTTP 插件的已知无害错误
  // 包括：fetch_cancel_body、fetch_read_body+streamChannel、resource id invalid
  // 这些错误在连接重建或 HMR 热重载时是正常现象，不影响功能
  const earlyFilter = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    let message = '';
    if (reason instanceof Error) {
      message = reason.message || '';
    } else if (typeof reason === 'string') {
      message = reason;
    } else if (reason && typeof reason === 'object' && 'message' in reason) {
      message = String((reason as any).message ?? '');
    }

    const lc = message.toLowerCase();
    if (
      lc.includes('fetch_cancel_body') ||
      lc.includes('http.fetch_cancel_body') ||
      (lc.includes('fetch_read_body') && lc.includes('streamchannel')) ||
      (lc.includes('resource id') && lc.includes('invalid')) ||
      (lc.includes('fetch_send') && lc.includes('streamchannel'))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  };

  // 使用 capture: true 确保在其他处理器之前运行
  window.addEventListener('unhandledrejection', earlyFilter, true);

  // 拦截 console.error 中的 Tauri HTTP 插件 stale resource 错误
  // 这些错误通过 Tauri IPC 同步触发 console.error，不经过 unhandledrejection
  const _origConsoleError = console.error;
  console.error = (...args: any[]) => {
    try {
      const first = typeof args[0] === 'string' ? args[0] : '';
      const lc = first.toLowerCase();
      if (
        (lc.includes('resource id') && lc.includes('invalid')) ||
        (lc.includes('fetch_read_body') && lc.includes('streamchannel')) ||
        lc.includes('ipc custom protocol') ||
        (lc.includes('fetch_send') && lc.includes('streamchannel'))
      ) {
        return; // 静默过滤已知无害错误
      }
    } catch { /* pass through on filter error */ }
    _origConsoleError.apply(console, args);
  };
})();

import React from "react";
import ReactDOM from "react-dom/client";
// 🚀 性能优化：KaTeX CSS 改为按需加载，见 src/utils/lazyStyles.ts
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
// 日志与错误上报初始化（跨平台）：结合 Tauri 日志插件与自定义上报
import { disposeGlobalCacheManager } from './utils/cacheConsistencyManager';
import { DialogControlProvider } from './contexts/DialogControlContext';
import i18n from './i18n';
import { McpService, bootstrapMcpFromSettings } from './mcp/mcpService';
// ★ DSTU Logger 初始化（依赖注入模式）
import { setDstuLogger, createLoggerFromDebugPlugin } from './dstu';
import { dstuDebugLog } from './debug-panel/plugins/DstuDebugPlugin';
import { debugMasterSwitch, debugLog } from './debug-panel/debugMasterSwitch';
// ★ 平台检测初始化（为 Android WebView 兼容性添加 CSS 类）
import { initPlatformClasses } from './utils/platform';

// 尽早初始化平台检测类，确保 CSS 规则在渲染前生效
initPlatformClasses();

const maybeInstallReactGrab = () => {
  try {
    const env = (import.meta as any).env ?? {};
    const isDev = env.MODE !== 'production';
    const enabled = env.VITE_ENABLE_REACT_GRAB === 'true';
    if (!isDev || !enabled) {
      return;
    }
    import('react-grab').catch((error) => {
      console.warn('[main] React Grab 加载失败', error);
    });
  } catch (error) {
    console.warn('[main] React Grab 初始化失败', error);
  }
};

maybeInstallReactGrab();

// ★ 注入 DSTU Logger（连接到调试面板）
setDstuLogger(createLoggerFromDebugPlugin(dstuDebugLog));

type CleanupFn = () => void;

const GLOBAL_MAIN_CLEANUP_KEY = '__DSTU_MAIN_EVENT_CLEANUPS__';
const cleanupRegistry: CleanupFn[] = [];

if (typeof window !== 'undefined') {
  const previousCleanups = (window as any)[GLOBAL_MAIN_CLEANUP_KEY] as CleanupFn[] | undefined;
  if (Array.isArray(previousCleanups)) {
    previousCleanups.forEach(fn => {
      try {
        fn();
      } catch (error) {
        console.warn('[main] 旧事件清理失败', error);
      }
    });
  }
  (window as any)[GLOBAL_MAIN_CLEANUP_KEY] = cleanupRegistry;
}

const registerCleanup = (fn: CleanupFn) => {
  cleanupRegistry.push(() => {
    try {
      fn();
    } catch (error) {
      console.warn('[main] 事件注销失败', error);
    }
  });
};

// 过滤特定 Tauri 警告（调试开关关闭时）
const installConsoleWarningFilter = () => {
  const originalWarn = console.warn;
  const tauriCallbackWarn = "[TAURI] Couldn't find callback id";
  console.warn = (...args: unknown[]) => {
    const first = args[0];
    const shouldSuppress =
      !debugMasterSwitch.isEnabled() &&
      typeof first === 'string' &&
      first.includes(tauriCallbackWarn);
    if (!shouldSuppress) {
      originalWarn.apply(console, args as any);
    }
  };
  registerCleanup(() => {
    console.warn = originalWarn;
  });
};

installConsoleWarningFilter();
// 动态初始化 Sentry（仅当配置存在且用户已同意）
// 🆕 合规要求：Sentry 默认关闭，需用户在设置中主动开启
const SENTRY_CONSENT_KEY = 'sentry_error_reporting_enabled';
let __sentryInit = false as boolean;
async function initSentryIfConfigured() {
  try {
    const dsn = (import.meta as any).env?.VITE_SENTRY_DSN;
    if (!dsn || __sentryInit) return;

    // 检查用户是否同意了错误报告
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const consent = await invoke('get_setting', { key: SENTRY_CONSENT_KEY }) as string | null;
      if (consent !== 'true') return; // 默认不开启
    } catch {
      return; // 数据库未就绪或读取失败，不初始化
    }

    const Sentry: any = await import('@sentry/browser');
    const { VERSION_INFO: vi } = await import('./version');
    Sentry.init({
      dsn,
      integrations: [
        Sentry.browserTracingIntegration?.() || undefined,
      ].filter(Boolean),
      tracesSampleRate: Number((import.meta as any).env?.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
      environment: (import.meta as any).env?.MODE || 'production',
      release: vi.SENTRY_RELEASE || (window as any).__APP_VERSION__ || '0.0.0',
    });
    __sentryInit = true;
  } catch {}
}

/** 导出 Sentry 同意 key，供设置页面使用 */
export { SENTRY_CONSENT_KEY };

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

/** Safe i18n accessor for contexts where hooks are unavailable (e.g. error boundary fallback).
 *  Falls back to the provided default string if i18n is not yet initialised or throws. */
const safeT = (key: string, fallback: string, options?: Record<string, unknown>): string => {
  try { return i18n.t(key, { defaultValue: fallback, ...options }) as string; } catch { return fallback; }
};

const TopLevelFallback = () => (
  <div style={{
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    width: '100vw',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#fafafa',
    color: '#1a1a1a',
  }}>
    <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
    <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
      {safeT('common:error_boundary.title', '应用遇到严重错误')}
    </h1>
    <p style={{ fontSize: 14, color: '#666', marginBottom: 24, maxWidth: 400, textAlign: 'center' }}>
      {safeT('common:error_boundary.description', '应用发生了无法恢复的错误。请尝试刷新页面，如果问题持续请联系支持。')}
    </p>
    <button
      onClick={() => window.location.reload()}
      style={{
        padding: '10px 24px',
        fontSize: 14,
        fontWeight: 500,
        color: '#fff',
        backgroundColor: '#2563eb',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
      }}
    >
      {safeT('common:error_boundary.refresh', '刷新页面')}
    </button>
  </div>
);

const appTree = (
  <ErrorBoundary name="TopLevel" fallback={<TopLevelFallback />}>
    <DialogControlProvider>
      <App />
    </DialogControlProvider>
  </ErrorBoundary>
);

// 在开发态移除 StrictMode，避免 effect/事件监听的二次执行造成噪声与性能影响；
// 生产环境仍保留 StrictMode 以捕获潜在问题。
if ((import.meta as any).env?.MODE === 'production') {
  initSentryIfConfigured().finally(() => {
    root.render(<React.StrictMode>{appTree}</React.StrictMode>);
  });
} else {
  initSentryIfConfigured().finally(() => {
    root.render(appTree);
  });
}


// Initialize Frontend MCP Service from saved settings (best-effort)
bootstrapMcpFromSettings({ preheat: true }).catch((err) => {
  debugLog.warn('[MCP] Bootstrap failed:', err);
});

// Respond to settings change to reload MCP servers from DB
const handleSystemSettingsChanged = async (event?: Event) => {
  const detail = (event as CustomEvent<any> | undefined)?.detail;
  const shouldReloadMcp = Boolean(
    detail?.mcpReloaded ||
    detail?.mcpChanged ||
    (typeof detail?.settingKey === 'string' && detail.settingKey.startsWith('mcp.'))
  );
  if (!shouldReloadMcp) return;
  bootstrapMcpFromSettings({ preheat: true }).catch((err) => {
    debugLog.warn('[MCP] Bootstrap (settings reload) failed:', err);
  });
};
window.addEventListener('systemSettingsChanged', handleSystemSettingsChanged);
registerCleanup(() => window.removeEventListener('systemSettingsChanged', handleSystemSettingsChanged));

if ((window as any).__TAURI_INTERNALS__) {
  (async () => {
    try {
      // 安全加载日志插件（可选）。使用 vite-ignore 避免 Vite 预打包时强制解析依赖。
      const safeLoadLogPlugin = async () => {
        try {
          const PKG = '@tauri-apps/plugin-log';
          const mod = await import(/* @vite-ignore */ PKG);
          return mod as any;
        } catch {
          return null;
        }
      };

      const logPlugin = await safeLoadLogPlugin();
      if (logPlugin && typeof logPlugin.attachConsole === 'function') {
        try { await logPlugin.attachConsole(); } catch {}
        const forwardConsole = (
          fnName: 'log' | 'debug' | 'info' | 'warn' | 'error',
          logger: (message: string) => Promise<void>
        ) => {
          const original = (console as any)[fnName]?.bind(console) as (...args: any[]) => void;
          (console as any)[fnName] = (...args: any[]) => {
            try { original?.(...args); } catch {}
            try {
              const msg = args.map(a => {
                if (a instanceof Error) return `${a.name}: ${a.message}`;
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch { return String(a); }
              }).join(' ');
              logger?.(msg).catch((err) => { console.warn('[Main] console forward failed:', err); });
            } catch {}
          };
        };
        forwardConsole('log', logPlugin.trace ?? logPlugin.info);
        forwardConsole('debug', logPlugin.debug ?? logPlugin.info);
        forwardConsole('info', logPlugin.info);
        forwardConsole('warn', logPlugin.warn ?? logPlugin.info);
        forwardConsole('error', logPlugin.error ?? logPlugin.info);
      }

      const { invoke } = await import('@tauri-apps/api/core');
      const recent = new Map<string, number>();
      const throttleMs = 10_000;

      const serializeUnknown = (value: unknown) => {
        if (value === undefined || value === null) {
          return null;
        }
        if (value instanceof Error) {
          return {
            message: value.message,
            name: value.name,
            stack: value.stack ?? null,
          };
        }
        const valueType = typeof value;
        if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
          return value;
        }
        try {
          return JSON.parse(JSON.stringify(value));
        } catch {
          return String(value);
        }
      };

      const emitLog = (payload: any) => {
        const key = JSON.stringify({
          message: payload?.message,
          stack: payload?.stack,
          kind: payload?.kind,
        });
        const now = Date.now();
        for (const [storedKey, storedAt] of recent) {
          if (now - storedAt > throttleMs) {
            recent.delete(storedKey);
          }
        }
        const last = recent.get(key);
        if (last && now - last < throttleMs) {
          return;
        }
        recent.set(key, now);
        invoke('report_frontend_log', { payload }).catch((err) => { console.warn('[Main] report_frontend_log failed:', err); });
      };

      const handleWindowError = (event: ErrorEvent) => {
        if (!event.message && !(event.error instanceof Error)) {
          return;
        }
        const stack = event.error instanceof Error ? event.error.stack ?? null : null;
        emitLog({
          level: 'ERROR',
          kind: 'WINDOW_ERROR',
          message: event.message || (event.error && String(event.error)) || safeT('common:frontend_errors.window_error', 'Window Error'),
          stack,
          url: event.filename || window.location.href,
          line: event.lineno ?? null,
          column: event.colno ?? null,
          route: window.location.hash || window.location.pathname,
          user_agent: navigator.userAgent,
          extra: serializeUnknown(event.error),
        });
        // 同步写入日志插件（若可用）
        (async () => {
          const lp = await safeLoadLogPlugin();
          try { await lp?.error?.(`[WINDOW_ERROR] ${event.message}`); } catch {}
        })();
      };
      window.addEventListener('error', handleWindowError);
      registerCleanup(() => window.removeEventListener('error', handleWindowError));

      const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        let message = safeT('common:frontend_errors.unhandled_promise_rejection', 'Unhandled Promise Rejection');
        let stack: string | null = null;
        if (reason instanceof Error) {
          message = reason.message || message;
          stack = reason.stack ?? null;
        } else if (typeof reason === 'string') {
          message = reason;
        } else if (reason && typeof reason === 'object' && 'message' in reason) {
          message = String((reason as { message?: unknown }).message ?? message);
        }

        // ★ 2026-02-04: 过滤 Tauri HTTP 插件的已知 bug
        // 当请求被取消时，插件内部会尝试调用 fetch_cancel_body 命令
        // 但该命令在某些情况下未正确注册，导致大量无害的错误日志
        // 参考: https://github.com/tauri-apps/plugins-workspace/issues/2557
        if (message.includes('fetch_cancel_body') || message.includes('http.fetch_cancel_body')) {
          event.preventDefault(); // 阻止默认的错误输出
          return; // 静默忽略此错误
        }

        emitLog({
          level: 'ERROR',
          kind: 'UNHANDLED_REJECTION',
          message,
          stack,
          url: window.location.href,
          route: window.location.hash || window.location.pathname,
          user_agent: navigator.userAgent,
          extra: serializeUnknown(reason),
        });
        (async () => {
          const lp = await safeLoadLogPlugin();
          try { await lp?.error?.(`[UNHANDLED_REJECTION] ${message}`); } catch {}
        })();
      };

      window.addEventListener('unhandledrejection', handleUnhandledRejection);
      registerCleanup(() => window.removeEventListener('unhandledrejection', handleUnhandledRejection));
      
      // 🔧 MCP Debug Enhancement Module - 全自动调试支持
      // 仅在开发模式 + 调试总开关开启时初始化（或通过 env 强制启用）
      const env = (import.meta as any).env ?? {};
      const isDev = env.MODE !== 'production';
      const forceEnableMcpDebug = env.VITE_ENABLE_MCP_DEBUG === 'true';
      let mcpDebugInitialized = false;
      let mcpDebugDestroy: (() => void) | null = null;

      const initMcpDebug = async () => {
        if (mcpDebugInitialized) return;
        try {
          const { initMCPDebug, registerAllStores, destroyMCPDebug } = await import('./mcp-debug');
          mcpDebugDestroy = destroyMCPDebug;
          await initMCPDebug({
            autoStartErrorCapture: true,
            autoStartNetworkMonitor: false, // 按需启动，避免性能开销
            autoStartPerformanceMonitor: false,
          });
          mcpDebugInitialized = true;
          console.log('[main] MCP Debug module initialized');
          // 延迟注册 stores，确保应用已完全加载
          setTimeout(() => {
            registerAllStores().catch((err) => {
              console.warn('[main] Store registration failed:', err);
            });
          }, 2000);
        } catch (err) {
          console.warn('[main] MCP Debug initialization failed:', err);
        }
      };

      const teardownMcpDebug = () => {
        if (!mcpDebugInitialized) return;
        try { mcpDebugDestroy?.(); } catch {}
        mcpDebugInitialized = false;
      };

      const shouldEnableMcpDebug = () => forceEnableMcpDebug || (isDev && debugMasterSwitch.isEnabled());

      if (shouldEnableMcpDebug()) {
        void initMcpDebug();
      }

      const unsubscribeDebugSwitch = debugMasterSwitch.addListener((enabled) => {
        if (forceEnableMcpDebug || !isDev) return;
        if (enabled) {
          void initMcpDebug();
        } else {
          teardownMcpDebug();
        }
      });
      registerCleanup(() => unsubscribeDebugSwitch());
    } catch {
      // ignore initialization errors
    }
  })();
}

// 🆕 P1防闪退：Chat V2 会话保存（应用生命周期）
// 动态导入避免循环依赖，使用同步方式触发保存
const triggerChatV2EmergencySave = () => {
  try {
    // 动态获取 sessionManager 和 autoSave（避免启动时循环依赖）
    const chatV2Module = (window as any).__CHAT_V2_EMERGENCY_SAVE__;
    if (chatV2Module && typeof chatV2Module.emergencySave === 'function') {
      chatV2Module.emergencySave();
    }
  } catch (e) {
    console.warn('[main] Chat V2 emergency save failed:', e);
  }
};

// 确保在页面关闭时保存MCP缓存和Chat V2会话
const handleBeforeUnload = () => {
  // 🆕 P1: 触发 Chat V2 紧急保存
  triggerChatV2EmergencySave();
  
  try {
    McpService.dispose();
  } catch {}
  // 🔧 清理全局缓存管理器（停止 cleanup 定时器、释放缓存）
  try {
    disposeGlobalCacheManager();
  } catch {}
};
window.addEventListener('beforeunload', handleBeforeUnload);
registerCleanup(() => window.removeEventListener('beforeunload', handleBeforeUnload));

// 🆕 P1防闪退：移动端 visibilitychange 监听
// 当应用进入后台时触发保存（移动端常见场景）
const handleVisibilityChange = () => {
  if (document.visibilityState === 'hidden') {
    triggerChatV2EmergencySave();
  }
};
document.addEventListener('visibilitychange', handleVisibilityChange);
registerCleanup(() => document.removeEventListener('visibilitychange', handleVisibilityChange));

if ((import.meta as any)?.hot) {
  (import.meta as any).hot.dispose(() => {
    cleanupRegistry.forEach(fn => fn());
    cleanupRegistry.length = 0;
    if (typeof window !== 'undefined' && (window as any)[GLOBAL_MAIN_CLEANUP_KEY] === cleanupRegistry) {
      delete (window as any)[GLOBAL_MAIN_CLEANUP_KEY];
    }
  });
}
