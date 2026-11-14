/**
 * src-tauri/src/lib.rs:494-556, PageLoadEvent::Started bootstrap IIFE.
 * Serialized by executeInMainWorld: keep this function self-contained. The cleanup
 * must live in the same world as src/logging/errorReporter.ts, not the preload world.
 */
export function installBootDiagnostics(): void {
  // Like bridge.ts, these are page-world DOM objects (the Host tsconfig has no DOM lib).
  const window: any = globalThis;
  window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__?.();
  let active = true;
  const report = (kind: string, message: unknown, stack?: unknown, extra?: unknown) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!active || typeof invoke !== 'function') return;
    void invoke('report_frontend_log', {
      payload: {
        level: 'ERROR',
        kind,
        message: String(message || kind),
        stack: stack || null,
        route: window.location.hash || window.location.pathname,
        url: window.location.href,
        user_agent: window.navigator.userAgent,
        extra: extra || null,
      },
      // Rust's IIFE intentionally ignores rejected diagnostic invokes (including ACL denial).
    }).catch(() => undefined);
  };
  const onError = (event: any) => {
    const target = event.target;
    const resource = target && target !== window
      ? (target.src || target.href || target.tagName)
      : null;
    report(
      resource ? 'BOOT_RESOURCE_ERROR' : 'BOOT_WINDOW_ERROR',
      event.message || ('Failed to load resource: ' + (resource || 'unknown')),
      event.error?.stack,
      resource ? { resource } : null,
    );
  };
  const onRejection = (event: any) => {
    const reason = event.reason;
    report(
      'BOOT_UNHANDLED_REJECTION',
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : null,
    );
  };
  const onCsp = (event: any) => {
    report(
      'BOOT_CSP_VIOLATION',
      'CSP blocked ' + event.blockedURI + ' via ' + event.violatedDirective,
    );
  };
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection, true);
  window.addEventListener('securitypolicyviolation', onCsp, true);
  const blankTimer = window.setTimeout(() => {
    const root = window.document.getElementById('root');
    if (!root || root.childElementCount === 0) {
      report('BOOT_BLANK_SCREEN', 'Application root is empty after startup timeout');
    }
  }, 8000);
  window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__ = () => {
    active = false;
    window.clearTimeout(blankTimer);
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection, true);
    window.removeEventListener('securitypolicyviolation', onCsp, true);
    delete window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__;
  };
}
