import './polyfills/promiseWithResolvers';
import React from "react";
// 🚀 性能优化：KaTeX CSS 改为按需加载，见 src/utils/lazyStyles.ts
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TopLevelFallback } from './components/TopLevelFallback';
import { OverlayCoordinatorProvider } from './components/shared/OverlayCoordinator';
// 日志与错误上报初始化（跨平台）：结合 Tauri 日志插件与自定义上报
import { disposeGlobalCacheManager } from './utils/cacheConsistencyManager';
import { DialogControlProvider } from './contexts/DialogControlContext';
import { McpService, bootstrapMcpFromSettings } from './mcp/mcpService';
// ★ DSTU Logger 初始化（依赖注入模式）
import { setDstuLogger, createLoggerFromDebugPlugin } from './dstu';
import { dstuDebugLog } from './debug-panel/plugins/DstuDebugPlugin';
import { debugMasterSwitch, debugLog } from './debug-panel/debugMasterSwitch';
// ★ 平台检测初始化（为 Android WebView 兼容性添加 CSS 类）
import { initPlatformClasses } from './utils/platform';
// ★ 材质档位提前初始化：把 data-wb-material 写到 <html>，让应用壳（侧边栏毛玻璃、
// composer/菜单 blur、全屏遮罩）在不进入工作台时也能按档位降级。
// materialTier 模块只依赖 utils/platform，不会把 workbench 主体拖进首屏 chunk。
import { getMaterialTier } from './features/workbench/core/materialTier';
import { installChatV2DomainEventBridge } from './utils/chatV2DomainEventBridge';
import { OverlayScrollbars, ClickScrollPlugin } from 'overlayscrollbars';
import { getOrCreateReactRoot } from './reactRoot';
import { initializeFontSetting } from './hooks/useAppInitialization';
import {
  FRONTEND_ERROR_REPORTED_EVENT,
  installGlobalErrorReporter,
  reportFrontendError,
  serializeUnknown,
} from './logging/errorReporter';
import { getStartupRecoveryStatus } from './features/data-recovery/dataRecoveryApi';
import { RecoveryShell } from './features/data-recovery/RecoveryShell';
import { StartupPreflight } from './features/data-recovery/StartupPreflight';
import { ComponentRecoveryShell } from './features/data-recovery/ComponentRecoveryShell';
import {
  clearRecoveryDebugScenario,
  createCoreMigrationFailureDebugIssues,
  createStartupConflictDebugStatus,
  createStartupPreflightFailureDebugStatus,
  getRecoveryDebugScenario,
} from './features/data-recovery/debugRecoveryScenarios';
import { getMaintenanceStatus } from './api/dataGovernance';
import { useSystemStatusStore } from './stores/systemStatusStore';

// 尽早初始化平台检测类，确保 CSS 规则在渲染前生效
initPlatformClasses();
// 尽早写入材质档位属性（内部自带软件渲染/系统偏好检测），供全局 CSS 降级选择器使用
getMaterialTier();
void installChatV2DomainEventBridge();

// Dev-only：UI 自动化桥（本地 UI 审查用，生产构建不包含）。
// 快捷助手等辅助窗口不接桥：bridge 服务端只保留最后一条连接，辅助窗口会顶掉主窗口。
if (
  import.meta.env.DEV &&
  import.meta.env.VITE_DS_UI_BRIDGE === '1' &&
  new URLSearchParams(window.location.search).get('window') === null
) {
  void import('./dev/uiAutomationBridge');
}

// 注册 OverlayScrollbars ClickScrollPlugin — 点击轨道时平滑滚动到目标位置
OverlayScrollbars.plugin(ClickScrollPlugin);

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

registerCleanup(installGlobalErrorReporter());

// 过滤特定 Tauri 警告（调试开关关闭时）
const installConsoleWarningFilter = () => {
  const originalWarn = console.warn;
  const tauriCallbackWarn = "[TAURI] Couldn't find callback id";
  const filteredWarn = (...args: unknown[]) => {
    const first = args[0];
    const shouldSuppress =
      !debugMasterSwitch.isEnabled() &&
      typeof first === 'string' &&
      first.includes(tauriCallbackWarn);
    if (!shouldSuppress) {
      originalWarn.apply(console, args as any);
    }
  };
  console.warn = filteredWarn;
  registerCleanup(() => {
    if (console.warn === filteredWarn) {
      console.warn = originalWarn;
    }
  });
};

installConsoleWarningFilter();

const installTauriLabFrontendLogBridge = () => {
  if (typeof window === 'undefined') return;
  // F21: tauri-lab 前端日志桥仅服务于开发/测试 harness（后端 `tauri_lab_frontend_log`
  // 在没有 TAURI_LAB_* 环境变量时本就直接 no-op）。生产构建下跳过安装，消除每条
  // warn/error 触发的无谓 IPC（原先 prod 也启用）。
  if ((import.meta as any).env?.MODE === 'production') return;
  const key = '__TAURI_LAB_FRONTEND_LOG_BRIDGE__';
  if ((window as any)[key]) return;
  (window as any)[key] = true;

  let invokePromise: Promise<any> | null = null;
  const getInvoke = () => {
    invokePromise ||= import('@tauri-apps/api/core').then(module => module.invoke);
    return invokePromise;
  };

  const serializeArg = (arg: unknown): string => {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  };

  // F21: 去重节流——相同 (level+message) 在窗口期内只上报一次，避免高频 warn/error 刷爆 IPC。
  const recentSends = new Map<string, number>();
  const SEND_THROTTLE_MS = 5_000;
  const send = (level: 'warn' | 'error', args: unknown[], stack?: string) => {
    const message = args.map(serializeArg).filter(Boolean).join(' ');
    if (!message && !stack) return;
    const dedupeKey = `${level}:${message}`;
    const now = Date.now();
    for (const [storedKey, storedAt] of recentSends) {
      if (now - storedAt > SEND_THROTTLE_MS) recentSends.delete(storedKey);
    }
    const last = recentSends.get(dedupeKey);
    if (last && now - last < SEND_THROTTLE_MS) return;
    recentSends.set(dedupeKey, now);
    void getInvoke()
      .then(invoke => invoke('tauri_lab_frontend_log', { level, message, stack }))
      .catch(() => {});
  };

  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args as any);
    send('warn', args);
  };
  console.error = (...args: unknown[]) => {
    originalError.apply(console, args as any);
    const stack = args.find(arg => arg instanceof Error)?.stack;
    send('error', args, stack);
  };

  window.addEventListener('error', event => {
    send('error', [event.message], event.error instanceof Error ? event.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    send('error', [reason], reason instanceof Error ? reason.stack : undefined);
  });
};

installTauriLabFrontendLogBridge();
// 动态初始化 Sentry（仅当配置存在且用户已同意）
// 🆕 合规要求：Sentry 默认关闭，需用户在设置中主动开启
const SENTRY_CONSENT_KEY = 'sentry_error_reporting_enabled';
let __sentryInit = false as boolean;
let __sentryModule: any = null;
let sentryConsentRevision = 0;
let sentryDesiredConsent = false;
let sentryConsentKnown = false;
const pendingSentryErrors: any[] = [];

const captureFrontendPayloadInSentry = (Sentry: any, payload: any) => {
  const error = new Error(String(payload?.message || 'Frontend error'));
  if (typeof payload?.stack === 'string') error.stack = payload.stack;
  Sentry.captureException(error, {
    tags: {
      kind: payload?.kind,
      component: payload?.component,
    },
    extra: serializeUnknown({
      route: payload?.route,
      url: payload?.url,
      line: payload?.line,
      column: payload?.column,
      details: payload?.extra,
    }),
  });
};

async function applyFrontendSentryConsent(enabled: boolean) {
  const revision = ++sentryConsentRevision;
  sentryDesiredConsent = enabled;
  sentryConsentKnown = true;
  if (!enabled) {
    pendingSentryErrors.length = 0;
    if (__sentryInit) {
      const previousClient = __sentryModule?.getClient?.();
      __sentryInit = false;
      __sentryModule = null;
      try {
        await previousClient?.close?.(2000);
      } catch {
        // Consent has still been revoked locally; no new events are captured.
      }
    }
    return;
  }

  const dsn = (import.meta as any).env?.VITE_SENTRY_DSN;
  if (!dsn || __sentryInit) return;
  const Sentry: any = await import('@sentry/browser');
  if (revision !== sentryConsentRevision || !sentryDesiredConsent) return;
  const { VERSION_INFO: vi } = await import('./version');
  if (revision !== sentryConsentRevision || !sentryDesiredConsent) return;
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    integrations: (defaults: any[]) => [
      ...defaults.filter(integration =>
        !['GlobalHandlers', 'TryCatch', 'BrowserApiErrors'].includes(integration?.name),
      ),
      Sentry.browserTracingIntegration?.() || undefined,
    ].filter(Boolean),
    tracesSampleRate: Number((import.meta as any).env?.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    environment: (import.meta as any).env?.MODE || 'production',
    release: vi.SENTRY_RELEASE || (window as any).__APP_VERSION__ || '0.0.0',
    beforeSend(event: any) {
      if (typeof event.message === 'string') {
        event.message = serializeUnknown(event.message);
      }
      if (Array.isArray(event.exception?.values)) {
        event.exception.values = event.exception.values.map((value: any) => ({
          ...value,
          value: typeof value?.value === 'string' ? serializeUnknown(value.value) : value?.value,
          stacktrace: value?.stacktrace
            ? {
                ...value.stacktrace,
                frames: value.stacktrace.frames?.map((frame: any) => ({
                  ...frame,
                  filename: typeof frame.filename === 'string'
                    ? frame.filename.replace(/[?#].*$/, '')
                    : frame.filename,
                  abs_path: typeof frame.abs_path === 'string'
                    ? frame.abs_path.replace(/[?#].*$/, '')
                    : frame.abs_path,
                })),
              }
            : value?.stacktrace,
        }));
      }
      if (event.user) event.user = undefined;
      if (event.request) {
        if (typeof event.request.url === 'string') {
          event.request.url = event.request.url.replace(/[?#].*$/, '');
        }
        if (event.request.headers) {
          for (const key of Object.keys(event.request.headers)) {
            if (/authorization|cookie|token|api[-_]?key/i.test(key)) {
              delete event.request.headers[key];
            }
          }
        }
        event.request.data = serializeUnknown(event.request.data);
      }
      event.extra = serializeUnknown(event.extra);
      event.contexts = serializeUnknown(event.contexts);
      event.tags = serializeUnknown(event.tags);
      event.spans = serializeUnknown(event.spans);
      if (typeof event.transaction === 'string') {
        event.transaction = event.transaction.replace(/\?.*$/, '');
      }
      event.breadcrumbs = event.breadcrumbs?.map((breadcrumb: any) => ({
        ...breadcrumb,
        message: typeof breadcrumb.message === 'string'
          ? serializeUnknown(breadcrumb.message)
          : breadcrumb.message,
        data: serializeUnknown(breadcrumb.data),
      }));
      return event;
    },
  });
  __sentryModule = Sentry;
  __sentryInit = true;
  pendingSentryErrors.splice(0).forEach(payload => {
    captureFrontendPayloadInSentry(Sentry, payload);
  });
}

async function initSentryIfConfigured() {
  const revisionBeforeRead = sentryConsentRevision;
  try {
    // 检查用户是否同意了错误报告
    const { invoke } = await import('@tauri-apps/api/core');
    const consent = await invoke('get_setting', { key: SENTRY_CONSENT_KEY }) as string | null;
    if (revisionBeforeRead !== sentryConsentRevision) return;
    await applyFrontendSentryConsent(consent === 'true');
  } catch (error) {
    void reportFrontendError(error, {
      kind: 'PLUGIN_ERROR',
      component: 'sentry-initialization',
    }).catch(() => undefined);
  }
}

const handleFrontendErrorForSentry = (event: Event) => {
  const payload = (event as CustomEvent).detail;
  if (String(payload?.level || 'ERROR').toUpperCase() !== 'ERROR') return;
  if (__sentryInit && __sentryModule) {
    captureFrontendPayloadInSentry(__sentryModule, payload);
    return;
  }
  if (sentryConsentKnown && !sentryDesiredConsent) return;
  if (pendingSentryErrors.length >= 20) pendingSentryErrors.shift();
  pendingSentryErrors.push(payload);
};
window.addEventListener(FRONTEND_ERROR_REPORTED_EVENT, handleFrontendErrorForSentry);
registerCleanup(() => {
  window.removeEventListener(FRONTEND_ERROR_REPORTED_EVENT, handleFrontendErrorForSentry);
});

/*
 * HMR contract:
 * - Keep React component declarations out of this side-effectful entry module.
 * - Persist the root outside the module instance so re-evaluation can only render
 *   into the existing root, never append another live application tree.
 */
const rootContainer = document.getElementById('root');
if (!(rootContainer instanceof HTMLElement)) {
  throw new Error('[main] Missing #root container');
}
const root = getOrCreateReactRoot(rootContainer);

// ★ 3.2 番茄钟置顶小窗：独立轻量入口（不挂载完整 App）
const IS_POMODORO_MINI_WINDOW =
  new URLSearchParams(window.location.search).get('window') === 'pomodoro-mini';
const IS_QUICK_ASSISTANT_WINDOW =
  new URLSearchParams(window.location.search).get('window') === 'quick-assistant';
const IS_LIGHTWEIGHT_WINDOW = IS_POMODORO_MINI_WINDOW || IS_QUICK_ASSISTANT_WINDOW;

const appTree = (
  <ErrorBoundary name="TopLevel" fallback={(error, componentStack) => <TopLevelFallback error={error} componentStack={componentStack} />}>
    <OverlayCoordinatorProvider>
      <DialogControlProvider>
        <App />
      </DialogControlProvider>
    </OverlayCoordinatorProvider>
  </ErrorBoundary>
);

const recoveryTree = (
  status: Awaited<ReturnType<typeof getStartupRecoveryStatus>>,
  debugPreview = false,
  onDebugExit?: () => void,
) => (
  <ErrorBoundary name="RecoveryShell" fallback={(error, componentStack) => <TopLevelFallback error={error} componentStack={componentStack} />}>
    <OverlayCoordinatorProvider>
      <DialogControlProvider>
        <RecoveryShell
          status={status}
          debugPreview={debugPreview}
          onDebugExit={onDebugExit}
        />
      </DialogControlProvider>
    </OverlayCoordinatorProvider>
  </ErrorBoundary>
);

const getStartupRecoveryStatusWithTimeout = async () => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getStartupRecoveryStatus(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Startup recovery preflight timed out after 15 seconds')),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

// F22: React 18 的 StrictMode 双调用诊断仅在开发态生效，生产构建为 no-op——
// 因此原先「仅 prod 启用」等于全程没有 StrictMode 检查（注释意图与 React 行为相反）。
// 调整为：
//   - 开发态可通过 VITE_ENABLE_STRICT_MODE=true 显式开启，按需排查 effect/副作用幂等性；
//     默认关闭以保持现有开发体验（团队此前因二次执行噪声移除，需先清理后再常态化）。
//   - 生产构建仍包裹 StrictMode（运行时无副作用），保持渲染树一致。
const enableDevStrictMode =
  (import.meta as any).env?.MODE !== 'production' &&
  (import.meta as any).env?.VITE_ENABLE_STRICT_MODE === 'true';

if (IS_LIGHTWEIGHT_WINDOW) {
  // 轻量窗口跳过 useAppInitialization，需单独应用全局字体/字号设置，
  // 否则这两个窗口永远停留在默认字体与 100% 字号
  initializeFontSetting().catch(console.warn);
}

if (IS_POMODORO_MINI_WINDOW) {
  // 置顶小窗：只渲染番茄钟 UI，跳过 App 与全部重量级初始化
  import('./features/pomodoro/components/PomodoroMiniWindow').then(({ PomodoroMiniWindow }) => {
    root.render(<PomodoroMiniWindow />);
  });
} else if (IS_QUICK_ASSISTANT_WINDOW) {
  import('./quick-assistant/QuickAssistantWindow').then(({ QuickAssistantWindow }) => {
    root.render(<QuickAssistantWindow />);
  });
  void initSentryIfConfigured();
} else {
  const debugScenario = getRecoveryDebugScenario();
  const exitDebugPreview = () => {
    clearRecoveryDebugScenario();
    window.location.reload();
  };
  if (debugScenario === 'startup-conflict') {
    root.render(recoveryTree(createStartupConflictDebugStatus(), true, exitDebugPreview));
  } else if (debugScenario === 'startup-preflight-failure') {
    root.render(recoveryTree(
      createStartupPreflightFailureDebugStatus(),
      true,
      exitDebugPreview,
    ));
  } else if (debugScenario === 'core-migration-failure') {
    root.render(
      <ErrorBoundary name="DebugComponentRecoveryShell" fallback={(error, componentStack) => <TopLevelFallback error={error} componentStack={componentStack} />}>
        <ComponentRecoveryShell
          components={createCoreMigrationFailureDebugIssues()}
          debugPreview
          onDebugExit={exitDebugPreview}
        />
      </ErrorBoundary>,
    );
  } else {
  root.render(<StartupPreflight />);
  void getStartupRecoveryStatusWithTimeout()
    .then(async (status) => {
      if (status.recovery_required) {
        root.render(recoveryTree(status));
        return;
      }

      const maintenanceStatus = await getMaintenanceStatus().catch((error) => ({
        is_in_maintenance_mode: false,
        blocked_components: [],
        component_health: {
          components: [{
            component: 'vfs',
            status: 'blocked' as const,
            reason: `Startup component health unavailable: ${String(error)}`,
            dependency: null,
          }],
        },
        component_issues: [],
      }));
      const componentHealth = maintenanceStatus.component_health?.components ?? [];
      useSystemStatusStore.getState().setComponentHealth(componentHealth);
      const coreRecoveryRequired = componentHealth.some(
        (component) =>
          component.status === 'blocked'
          && (component.component === 'vfs' || component.component === 'mistakes'),
      );
      if (coreRecoveryRequired) {
        root.render(
          <ErrorBoundary name="ComponentRecoveryShell" fallback={(error, componentStack) => <TopLevelFallback error={error} componentStack={componentStack} />}>
            <ComponentRecoveryShell components={componentHealth} />
          </ErrorBoundary>,
        );
        return;
      }

      if ((import.meta as any).env?.MODE === 'production' || enableDevStrictMode) {
        root.render(<React.StrictMode>{appTree}</React.StrictMode>);
      } else {
        root.render(appTree);
      }
      startNormalFrontendRuntime();
    })
    .catch((error) => {
      // 纯 Web 预览没有 Tauri IPC，可继续渲染；桌面端不能把预检故障误判为安全启动，
      // 因为恢复专用后端不会创建普通 AppState。
      if ((window as any).__TAURI_INTERNALS__) {
        const unavailable = [{
          component: 'startup_preflight',
          status: 'blocked' as const,
          reason: `Startup recovery preflight unavailable: ${String(error)}`,
          dependency: null,
        }];
        useSystemStatusStore.getState().setComponentHealth(unavailable);
        root.render(
          <ErrorBoundary name="StartupPreflightFailure" fallback={(renderError, componentStack) => <TopLevelFallback error={renderError} componentStack={componentStack} />}>
            <ComponentRecoveryShell components={unavailable} />
          </ErrorBoundary>,
        );
        return;
      }
      console.warn('[main] Tauri startup preflight unavailable in web preview.', error);
      if ((import.meta as any).env?.MODE === 'production' || enableDevStrictMode) {
        root.render(<React.StrictMode>{appTree}</React.StrictMode>);
      } else {
        root.render(appTree);
      }
      startNormalFrontendRuntime();
    });
  }
}

// Respond to settings change to reload MCP servers from DB
const handleSystemSettingsChanged = async (event?: Event) => {
  const detail = (event as CustomEvent<any> | undefined)?.detail;
  if (typeof detail?.sentryConsent === 'boolean') {
    void applyFrontendSentryConsent(detail.sentryConsent).catch(error => {
      void reportFrontendError(error, {
        kind: 'PLUGIN_ERROR',
        component: 'sentry-consent-update',
      }).catch(() => undefined);
    });
  }
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

const initializeMcpDebugRuntime = () => {
  if (!(window as any).__TAURI_INTERNALS__) return;
  (async () => {
    try {
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
};

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

// 🆕 P1防闪退：移动端 visibilitychange 监听
// 当应用进入后台时触发保存（移动端常见场景）
const handleVisibilityChange = () => {
  if (document.visibilityState === 'hidden') {
    triggerChatV2EmergencySave();
  }
};

let normalFrontendRuntimeStarted = false;

function startNormalFrontendRuntime() {
  if (normalFrontendRuntimeStarted || IS_LIGHTWEIGHT_WINDOW) return;
  normalFrontendRuntimeStarted = true;

  void initSentryIfConfigured();
  bootstrapMcpFromSettings({ preheat: true }).catch((err) => {
    debugLog.warn('[MCP] Bootstrap failed:', err);
  });

  void import('./quick-assistant/window').then(async ({
    initializeQuickAssistantGlobalShortcut,
    initializeQuickAssistantMainBridge,
  }) => {
    const cleanups = await Promise.all([
      initializeQuickAssistantGlobalShortcut(),
      initializeQuickAssistantMainBridge(),
    ]);
    cleanups.forEach(registerCleanup);
  }).catch((error) => {
    console.warn('[QuickAssistant] initialization failed:', error);
  });

  window.addEventListener('systemSettingsChanged', handleSystemSettingsChanged);
  registerCleanup(() => window.removeEventListener('systemSettingsChanged', handleSystemSettingsChanged));
  window.addEventListener('beforeunload', handleBeforeUnload);
  registerCleanup(() => window.removeEventListener('beforeunload', handleBeforeUnload));
  document.addEventListener('visibilitychange', handleVisibilityChange);
  registerCleanup(() => document.removeEventListener('visibilitychange', handleVisibilityChange));
  initializeMcpDebugRuntime();
}

if ((import.meta as any)?.hot) {
  (import.meta as any).hot.dispose(() => {
    cleanupRegistry.forEach(fn => fn());
    cleanupRegistry.length = 0;
    if (typeof window !== 'undefined' && (window as any)[GLOBAL_MAIN_CLEANUP_KEY] === cleanupRegistry) {
      delete (window as any)[GLOBAL_MAIN_CLEANUP_KEY];
    }
    // Do not unmount the React root here. getOrCreateReactRoot keeps it alive
    // across module replacement and the next evaluation reuses the same handle.
  });
}
